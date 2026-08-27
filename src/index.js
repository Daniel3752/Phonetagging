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

import { classifyUrl } from './gemini.js';
import { addUrlToAllowlist } from './gateway.js';
import { sha256Hex, timingSafeEqual } from './crypto.js';
import { renderBlockPage } from './block-page.js';

const FETCH_TIMEOUT_MS = 8000;
const PAGE_TEXT_LIMIT = 4000;

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

// Parses + normalizes a URL, rejecting anything that isn't http(s). Returns null on invalid.
function normalizeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.toString();
}

export default {
  async fetch(request, env) {
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
  },
};

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

  const cached = await env.DB.prepare('SELECT verdict, reason FROM url_verdicts WHERE url_hash = ?')
    .bind(urlHash).first();
  if (cached) {
    return json({ verdict: cached.verdict, reason: cached.reason, cached: true });
  }

  let safe;
  let reason;
  try {
    const pageRes = await fetch(normalizedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const html = await pageRes.text();
    const { title, text } = extractPageInfo(html);
    const result = await classifyUrl(env, { url: normalizedUrl, title, text });
    safe = result.safe;
    reason = result.reason;
  } catch (err) {
    // Fail closed, but don't cache — let a later retry re-judge once the transient issue clears.
    return json({ verdict: 'error', reason: 'Could not check this site right now.' });
  }

  const now = Date.now();

  if (safe) {
    await env.DB.prepare(
      `INSERT INTO url_verdicts (url_hash, url, verdict, reason, source, decided_at) VALUES (?, ?, 'clean', ?, 'gemini', ?)`
    ).bind(urlHash, normalizedUrl, reason || null, now).run();
    try {
      await addUrlToAllowlist(env, normalizedUrl);
    } catch (err) {
      // Verdict is cached either way — a Gateway write failure just means the phone reloads once
      // more; the classification isn't lost.
    }
    return json({ verdict: 'clean', reason });
  }

  // Not clean: cache the block so repeat hits don't re-call Gemini, and leave the wall up.
  await env.DB.prepare(
    `INSERT INTO url_verdicts (url_hash, url, verdict, reason, source, decided_at) VALUES (?, ?, 'blocked', ?, 'gemini', ?)`
  ).bind(urlHash, normalizedUrl, reason || null, now).run();
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

  await addUrlToAllowlist(env, normalizedUrl);
  await env.DB.prepare(`
    INSERT INTO url_verdicts (url_hash, url, verdict, reason, source, decided_at)
    VALUES (?, ?, 'clean', 'Allowed by operator', 'operator', ?)
    ON CONFLICT(url_hash) DO UPDATE SET verdict = 'clean', reason = 'Allowed by operator', source = 'operator', decided_at = excluded.decided_at
  `).bind(urlHash, normalizedUrl, Date.now()).run();

  return json({ ok: true, url: normalizedUrl });
}
