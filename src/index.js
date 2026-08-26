// Phone content filter — standalone Cloudflare Worker.
//
// The blocking itself is done by Cloudflare Gateway (a default-deny DNS policy + a hostname
// allowlist). This worker is the "doorman": when a phone needs a site that isn't approved yet,
// the request-access page (GET /blocked) calls POST /api/verdict, which fetches the site's
// homepage, asks Gemini whether the SITE is appropriate, and — if clean — adds the hostname to the
// Gateway allowlist so it resolves from then on. Anything Gemini won't clear stays blocked; if
// someone needs it, the operator allows it by hand (POST /api/admin/allow) or reverses a bad call
// (POST /api/admin/revoke).
//
// v1 filters at HOSTNAME granularity because DNS filtering cannot see the path of an HTTPS request.
// That is a deliberate trade: no certificate, no TLS decryption, no supervision, and nothing breaks
// on certificate-pinned apps. Full URLs are still recorded on every row so that turning on
// path blocking later is a configuration change rather than a migration.
//
// Single-operator model: no per-phone accounts, no guardians, no notifications. One shared
// allowlist for every managed phone; every verdict is decided once per site and cached forever.

import { classifySite } from './gemini.js';
import { MAX_DEVICE_LEVEL, NEVER_LEVEL, normalizeSiteLevel } from './levels.js';
import { handleAdmin } from './admin-api.js';
import { handleProxyCheck } from './proxy-api.js';
import { runScheduler } from './scheduler.js';
import { renderAdminPage } from './admin-page.js';
import { addHostToAllowlist, removeHostFromAllowlist } from './gateway.js';
import { sha256Hex, timingSafeEqual } from './crypto.js';
import { renderBlockPage } from './block-page.js';
import { parseSearchUrl } from './search.js';

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

// Parses a submitted URL and returns both the full normalized URL (retained for audit and for a
// future path-blocking rollout) and the bare hostname (what actually gets enforced at DNS).
// Returns null for anything that isn't http(s) or has no hostname.
//
// A bare "example.com" is accepted as a convenience — the operator API and the request page are
// both places a human types a site name rather than a URL.
function parseTarget(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;

  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // URL already lowercases and punycodes the host. Strip the root-label trailing dot, which is
  // valid in DNS but which Gateway rejects in a domain-type list.
  const hostname = parsed.hostname.replace(/\.$/, '');
  if (!hostname || !hostname.includes('.')) return null;

  return { url: parsed.toString(), hostname };
}

function requireOperator(request, env) {
  if (!env.OPERATOR_KEY) return json({ error: 'operator_not_configured' }, 503);
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') || '').trim());
  const provided = m ? m[1] : '';
  if (!provided || !timingSafeEqual(provided, env.OPERATOR_KEY)) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return json({ status: 'ok', service: 'phone-url-filter' });
    }

    if (url.pathname === '/blocked' && request.method === 'GET') {
      // Squid passes the denied URL through deny_info. A refused SEARCH gets a different page from a
      // blocked site: there is nothing to request, and a button that cannot help is worse than none.
      const blockedUrl = url.searchParams.get('url') || url.searchParams.get('cf_site_uri') || '';
      const kind = blockedUrl && parseSearchUrl(blockedUrl) ? 'search' : 'site';
      return new Response(renderBlockPage({ blockedUrl, kind }), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // Asked once per request by the filtering proxy's ACL helper. Authenticated with PROXY_KEY,
    // not the operator key, so the proxy holds a credential that cannot administer anything.
    if (url.pathname === '/api/proxy/check' && request.method === 'POST') {
      return handleProxyCheck(request, env);
    }

    if (url.pathname === '/api/verdict' && request.method === 'POST') {
      return handleVerdict(request, env);
    }

    if (url.pathname === '/api/admin/allow' && request.method === 'POST') {
      return handleAdminAllow(request, env);
    }

    if (url.pathname === '/api/admin/revoke' && request.method === 'POST') {
      return handleAdminRevoke(request, env);
    }

    // The operator console. The page itself is public HTML — it holds no secrets and renders
    // nothing until the operator supplies the key, which every /api/admin/* call then requires.
    if (url.pathname === '/admin' && request.method === 'GET') {
      return new Response(renderAdminPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      const denied = requireOperator(request, env);
      if (denied) return denied;
      return handleAdmin(request, env, url.pathname);
    }

    return json({ error: 'Not found' }, 404);
  },

  // Cron Trigger. Cloudflare retries a scheduled invocation that throws, so failures are collected
  // per device inside runScheduler and reported rather than thrown — one unreachable phone must not
  // cause the whole fleet's run to be retried.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduler(env).then((summary) => {
        console.log('scheduler run', JSON.stringify(summary));
      }).catch((err) => {
        console.error('scheduler run failed outright:', err.message);
      })
    );
  },
};

// Called by the request-access page. Cache hit → instant answer. Cache miss → fetch the site's
// homepage, have Gemini judge the site, and auto-allow (write to the Gateway hostname allowlist) if
// clean. Anything not clean stays blocked with no notification — the operator allows it by hand if
// asked.
//
// Fails CLOSED: on any error (bad fetch, Gemini down, Gateway write rejected) the site stays
// blocked and NOTHING is cached, so a transient failure never permanently blocks an otherwise-fine
// site and never permanently "approves" a site that was never actually allowlisted. The next
// attempt re-judges from scratch.
async function handleVerdict(request, env) {
  const body = await request.json().catch(() => null);
  if (!body?.url) return json({ error: 'url is required' }, 400);

  const target = parseTarget(body.url);
  if (!target) return json({ error: 'invalid url' }, 400);

  const hostHash = await sha256Hex(target.hostname);

  const cached = await env.DB.prepare(
    `SELECT verdict, reason FROM url_verdicts WHERE url_hash = ? AND scope = 'host'`
  ).bind(hostHash).first();
  if (cached) {
    return json({ verdict: cached.verdict, reason: cached.reason, hostname: target.hostname, cached: true });
  }

  // Judge the homepage, not the submitted URL — the decision applies to the whole domain, so the
  // homepage is the fairest single sample of what the site is for.
  let safe;
  let reason;
  let level = NEVER_LEVEL;
  let isDoorway = false;
  try {
    const pageRes = await fetch(`https://${target.hostname}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const html = await pageRes.text();
    const { title, text } = extractPageInfo(html);
    const result = await classifySite(env, { hostname: target.hostname, title, text });
    level = normalizeSiteLevel(result.level);
    isDoorway = result.isDoorway === true;
    reason = result.reason;
    // Until the per-level enforcement lists exist, a single shared allowlist still backs the
    // default-deny policy, so "allowed at all" means "reachable from the most permissive rung".
    // The rating and the doorway flag are recorded regardless, so switching enforcement over is a
    // read of columns that are already populated rather than a re-classification of the corpus.
    safe = level <= MAX_DEVICE_LEVEL && !isDoorway;
  } catch {
    return json({ verdict: 'error', reason: 'Could not check this site right now.' });
  }

  if (safe) {
    // Gateway FIRST, cache second. If the allowlist write fails, the phone is still blocked, so
    // caching "clean" here would strand the site permanently: every retry would hit the cache,
    // report "Approved", and never re-attempt the write. Order matters more than it looks.
    try {
      await addHostToAllowlist(env, target.hostname);
    } catch {
      return json({ verdict: 'error', reason: 'Could not update the filter right now.' });
    }
    await recordVerdict(env, { hostHash, target, verdict: 'clean', reason, source: 'gemini', level, isDoorway });
    return json({ verdict: 'clean', reason, hostname: target.hostname, level });
  }

  // Not clean: cache the block so repeat hits don't re-call Gemini, and leave the wall up.
  await recordVerdict(env, { hostHash, target, verdict: 'blocked', reason, source: 'gemini', level, isDoorway });
  return json({ verdict: 'blocked', reason, hostname: target.hostname, level });
}

function recordVerdict(env, { hostHash, target, verdict, reason, source, level, isDoorway }) {
  return env.DB.prepare(`
    INSERT INTO url_verdicts (url_hash, url, hostname, scope, verdict, reason, source, decided_at, level, is_doorway)
    VALUES (?, ?, ?, 'host', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url_hash) DO UPDATE SET
      url = excluded.url, hostname = excluded.hostname, scope = 'host',
      verdict = excluded.verdict, reason = excluded.reason,
      source = excluded.source, decided_at = excluded.decided_at,
      level = excluded.level, is_doorway = excluded.is_doorway
  `).bind(
    hostHash, target.url, target.hostname, verdict, reason || null, source, Date.now(),
    normalizeSiteLevel(level), isDoorway ? 1 : 0
  ).run();
}

// Operator-only manual allow — the "someone asks me for a site, I allow it" path. Adds the hostname
// to the Gateway allowlist and records it as an operator decision, overriding any prior 'blocked'
// cache entry.
async function handleAdminAllow(request, env) {
  const denied = requireOperator(request, env);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.url) return json({ error: 'url is required' }, 400);

  const target = parseTarget(body.url);
  if (!target) return json({ error: 'invalid url' }, 400);
  const hostHash = await sha256Hex(target.hostname);

  await addHostToAllowlist(env, target.hostname);
  await recordVerdict(env, {
    hostHash, target, verdict: 'clean', reason: 'Allowed by operator', source: 'operator',
    // An operator allow lands on the ordinary rung rather than the most permissive one: the point
    // of allowing by hand is usually that a site is fine for everyone, not that it is borderline.
    level: body.level ?? 2, isDoorway: body.is_doorway === true,
  });

  return json({ ok: true, hostname: target.hostname });
}

// Operator-only revoke — reverses a bad allow. Removes the hostname from the Gateway list and
// records it as an operator block, so the classifier can't silently re-approve it later.
//
// Gateway first again: if the list write fails we must not record a block the fleet isn't actually
// enforcing.
async function handleAdminRevoke(request, env) {
  const denied = requireOperator(request, env);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.url) return json({ error: 'url is required' }, 400);

  const target = parseTarget(body.url);
  if (!target) return json({ error: 'invalid url' }, 400);
  const hostHash = await sha256Hex(target.hostname);

  await removeHostFromAllowlist(env, target.hostname);
  await recordVerdict(env, {
    hostHash, target, verdict: 'blocked', reason: 'Revoked by operator', source: 'operator',
    level: NEVER_LEVEL, isDoorway: false,
  });

  return json({ ok: true, hostname: target.hostname });
}
