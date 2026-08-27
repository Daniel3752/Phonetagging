// Phone URL filter — standalone Cloudflare Worker.
//
// The blocking itself is done by Cloudflare Gateway (default-deny HTTP policy + a URL allowlist).
// This worker is the "doorman": when a phone hits a not-yet-approved site, Gateway blocks it and
// redirects to the block page (GET /blocked) served here. The page calls POST /api/verdict, which
// fetches the page, asks Gemini if it's appropriate, and — if clean — adds the full URL to the
// Gateway allowlist so it loads on reload. Anything Gemini won't clear stays blocked; if someone
// needs it, the operator allows it by hand (POST /api/admin/allow).
//
// Single-operator model: no per-phone accounts, no guardians, no notifications. One shared
// allowlist for every managed phone; every verdict is decided once per URL and cached forever.

import { classifyUrl, SafetyBlockedError } from './gemini.js';
import { addUrlToAllowlist } from './gateway.js';
import { sha256Hex, timingSafeEqual } from './crypto.js';
import { renderBlockPage } from './block-page.js';

const FETCH_TIMEOUT_MS = 8000;
const PAGE_TEXT_LIMIT = 4000;
// Hard cap on how much of a target page we read. A page that is mostly video/binary would
// otherwise blow the Worker's 128 MB memory limit on `.text()` and turn into an error verdict.
const PAGE_BYTE_LIMIT = 512 * 1024;

// /api/verdict is reachable from the whole internet (it is on a workers.dev host, and it has to
// stay reachable for the phones). Each miss costs a Gemini call and can add a URL to the shared
// allowlist, so cap how often one IP can drive that.
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function extractPageInfo(html) {
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1]?.trim() || '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PAGE_TEXT_LIMIT);
  return { title, text };
}

// Hostnames the worker must never be talked into fetching. /api/verdict takes an arbitrary URL from
// an unauthenticated caller and fetches it server-side, so without this it is an open SSRF proxy
// into loopback, private ranges, and cloud metadata.
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./, // link-local, incl. 169.254.169.254 cloud metadata
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique-local IPv6
  /^\[?fe80:/i, // link-local IPv6
  /^\[?::ffff:/i, // IPv4-mapped IPv6 — ::ffff:127.0.0.1 is still loopback
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64/10 CGNAT
  /^\d+$/, // decimal IP: http://2130706433/ resolves to 127.0.0.1
  /^0[xX]/, // hex IP: http://0x7f000001/
  /\.internal$/i,
  /\.local$/i,
];

function isFetchableHost(hostname) {
  if (!hostname) return false;
  return !BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname));
}

// Number of redirect hops to follow by hand. Following them ourselves is the point: with
// `redirect: 'follow'` the runtime chases the chain internally, so a public URL that 302s to
// http://169.254.169.254/ would sail straight past isFetchableHost().
const MAX_REDIRECTS = 5;

// Parses + normalizes a URL, rejecting anything that isn't a public http(s) address. The fragment
// is dropped: it is never sent to the server, so it is not part of the identity of the page and
// keeping it would fragment the cache and the Gateway allowlist. Returns null on invalid.
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!isFetchableHost(parsed.hostname)) return null;
  parsed.hash = '';
  return parsed.toString();
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      // Never let an unhandled throw surface Cloudflare's 1101 page — the block page parses JSON.
      console.error('unhandled error', err?.stack || String(err));
      return json({ error: 'internal_error' }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);

  if (url.pathname === '/' && request.method === 'GET') {
    return json({ status: 'ok', service: 'phone-url-filter' });
  }

  if (url.pathname === '/blocked' && request.method === 'GET') {
    return new Response(renderBlockPage(), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (url.pathname === '/api/verdict' && request.method === 'POST') {
    return handleVerdict(request, env);
  }

  if (url.pathname === '/api/admin/allow' && request.method === 'POST') {
    return handleAdminAllow(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

// Fixed-window per-IP counter in D1. Deliberately fails OPEN: if the table is missing (schema not
// re-applied yet) or D1 hiccups, phones keep working — the limiter is cost protection, not part of
// the filtering guarantee.
async function overRateLimit(env, request) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return false;
  const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO verdict_rate_limit (ip, window_start, hits) VALUES (?, ?, 1)
       ON CONFLICT(ip, window_start) DO UPDATE SET hits = hits + 1
       RETURNING hits`
    ).bind(ip, windowStart).first();
    return Number(row?.hits || 0) > RATE_LIMIT_MAX;
  } catch (err) {
    console.warn('rate limit unavailable:', String(err));
    return false;
  }
}

// Fetches the target page for classification. Reads at most PAGE_BYTE_LIMIT bytes and only treats
// HTML/text as page content — a PDF or a video gets classified on its URL alone rather than
// erroring out, which is what used to happen when `.text()` met a large binary body.
async function fetchPageInfo(targetUrl) {
  let current = targetUrl;
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(current, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
      headers: { 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1' },
    });
    if (res.status < 300 || res.status > 399) break;
    const location = res.headers.get('location');
    if (!location) break;
    await res.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    // Re-run the full check on every hop, resolving relative Locations against the current URL.
    const next = normalizeUrl(new URL(location, current).toString());
    if (!next) throw new Error('redirect to a disallowed address');
    current = next;
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const isTextual = contentType.includes('text/html') || contentType.includes('application/xhtml') ||
    contentType.includes('text/plain') || contentType === '';
  if (!isTextual || !res.body) {
    await res.body?.cancel();
    return { title: '', text: '', finalUrl: current };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < PAGE_BYTE_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }
  const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  // finalUrl is where the redirect chain actually landed. The phone's browser follows the same
  // chain, so allowlisting only what the user typed leaves it blocked one hop later.
  return { ...extractPageInfo(html), finalUrl: current };
}

// Insert-if-absent. Two phones hitting the same new site at once both reach this; without the
// conflict clause the loser threw a UNIQUE constraint error and the caller got a 500.
function cacheVerdict(env, { urlHash, url, verdict, reason, now }) {
  return env.DB.prepare(
    `INSERT INTO url_verdicts (url_hash, url, verdict, reason, source, decided_at)
     VALUES (?, ?, ?, ?, 'gemini', ?)
     ON CONFLICT(url_hash) DO NOTHING`
  ).bind(urlHash, url, verdict, reason || null, now).run();
}

// Called by the block page. Cache hit → instant answer. Cache miss → fetch the page, have Gemini
// judge it, and auto-allow (write a Gateway allowlist rule) if clean. Anything not clean stays
// blocked with no notification — the operator allows it by hand if asked.
//
// Fails CLOSED: on any error (bad fetch, Gemini down) the site stays blocked, and the error is NOT
// cached — so a transient failure doesn't permanently block an otherwise-fine site; the next
// attempt re-judges it.
async function handleVerdict(request, env) {
  const body = await request.json().catch(() => null);
  const targetUrl = body?.url;
  if (!targetUrl) return json({ error: 'url is required' }, 400);

  const normalizedUrl = normalizeUrl(targetUrl);
  if (!normalizedUrl) return json({ error: 'invalid url' }, 400);
  const urlHash = await sha256Hex(normalizedUrl);

  if (await overRateLimit(env, request)) {
    return json({ verdict: 'error', reason: 'Too many checks from this connection. Try again in a few minutes.' }, 429);
  }

  const cached = await env.DB.prepare('SELECT verdict, reason FROM url_verdicts WHERE url_hash = ?')
    .bind(urlHash).first();
  if (cached) {
    // A URL can be 'clean' in D1 but missing from the Gateway list — the allowlist write is allowed
    // to fail (see below), and the phone then reloads into the block page forever while this
    // endpoint keeps answering "approved". Re-assert the allowlist entry on every cached clean hit;
    // Cloudflare dedupes identical values, so this is a no-op in the normal case.
    if (cached.verdict === 'clean') {
      try {
        await addUrlToAllowlist(env, normalizedUrl);
      } catch (err) {
        console.warn('allowlist re-assert failed:', String(err));
      }
    }
    return json({ verdict: cached.verdict, reason: cached.reason, cached: true });
  }

  let safe;
  let reason;
  // Where the fetch actually landed. `https://example.com` 301s to `https://www.example.com/` on a
  // large share of the web; allowlisting only the typed URL means the phone reloads straight into
  // the block page again, on a URL nothing has approved.
  let finalUrl = normalizedUrl;
  try {
    const page = await fetchPageInfo(normalizedUrl);
    finalUrl = page.finalUrl || normalizedUrl;

    // Nothing readable came back: a binary response (image, video, PDF, a download), or an empty
    // body. There is no page to judge, so a verdict here would rest on the URL string alone —
    // `https://cdn.example/img/84021.jpg` says nothing about what it contains. Auto-allowing on
    // that basis is the one failure mode this filter cannot have, so refuse without calling Gemini.
    //
    // Deliberately NOT cached: an empty body can be a transient upstream hiccup, and a permanent
    // block for that would need the operator to undo it. A real media URL simply lands here again.
    if (!page.title && !page.text) {
      return json({
        verdict: 'blocked',
        reason: "This isn't a readable web page, so it can't be checked automatically. Ask the operator to allow it.",
      });
    }

    const result = await classifyUrl(env, { url: normalizedUrl, title: page.title, text: page.text });
    safe = result.safe;
    reason = result.reason;
  } catch (err) {
    if (err instanceof SafetyBlockedError) {
      // Gemini refused to process the page at all. For this filter that is not an inconclusive
      // result — it is the strongest possible signal that the page is explicit. Treat it as a real
      // 'blocked' verdict and cache it, instead of returning the retryable error the caller used to
      // get for exactly the worst sites.
      safe = false;
      reason = 'Blocked by content safety filter.';
    } else {
      // Fail closed, but don't cache — let a later retry re-judge once the transient issue clears.
      console.warn('verdict failed:', String(err));
      return json({ verdict: 'error', reason: 'Could not check this site right now.' });
    }
  }

  const now = Date.now();

  if (safe) {
    await cacheVerdict(env, { urlHash, url: normalizedUrl, verdict: 'clean', reason, now });
    try {
      await addUrlToAllowlist(env, normalizedUrl);
      if (finalUrl !== normalizedUrl) await addUrlToAllowlist(env, finalUrl);
    } catch (err) {
      // Verdict is cached either way — a Gateway write failure just means the phone reloads once
      // more; the classification isn't lost, and the cached-clean branch above re-asserts it.
      console.warn('allowlist write failed:', String(err));
    }
    return json({ verdict: 'clean', reason });
  }

  // Not clean: cache the block so repeat hits don't re-call Gemini, and leave the wall up.
  await cacheVerdict(env, { urlHash, url: normalizedUrl, verdict: 'blocked', reason, now });
  return json({ verdict: 'blocked', reason });
}

// Operator-only manual allow — the "someone asks me for a site, I allow it" path. Adds the URL to
// the Gateway allowlist and records it as an operator decision (overriding any prior 'blocked'
// cache entry). Gated by the OPERATOR_KEY secret via an Authorization: Bearer header.
async function handleAdminAllow(request, env) {
  if (!env.OPERATOR_KEY) return json({ error: 'operator_not_configured' }, 503);
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') || '').trim());
  const provided = m ? m[1] : '';
  if (!provided || !timingSafeEqual(provided, env.OPERATOR_KEY)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await request.json().catch(() => null);
  const targetUrl = body?.url;
  if (!targetUrl) return json({ error: 'url is required' }, 400);

  const normalizedUrl = normalizeUrl(targetUrl);
  if (!normalizedUrl) return json({ error: 'invalid url' }, 400);
  const urlHash = await sha256Hex(normalizedUrl);

  // Write the Gateway list first: if that fails there is nothing to record, and reporting success
  // for a URL the phones still can't reach is worse than a plain error.
  try {
    await addUrlToAllowlist(env, normalizedUrl);
  } catch (err) {
    console.error('operator allow failed:', String(err));
    return json({ error: 'gateway_write_failed', detail: String(err) }, 502);
  }

  await env.DB.prepare(`
    INSERT INTO url_verdicts (url_hash, url, verdict, reason, source, decided_at)
    VALUES (?, ?, 'clean', 'Allowed by operator', 'operator', ?)
    ON CONFLICT(url_hash) DO UPDATE SET verdict = 'clean', reason = 'Allowed by operator', source = 'operator', decided_at = excluded.decided_at
  `).bind(urlHash, normalizedUrl, Date.now()).run();

  return json({ ok: true, url: normalizedUrl });
}
