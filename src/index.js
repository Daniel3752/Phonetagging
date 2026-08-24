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
import { addHostToAllowlist, removeHostFromAllowlist } from './gateway.js';
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

    if (url.pathname === '/api/admin/revoke' && request.method === 'POST') {
      return handleAdminRevoke(request, env);
    }

    return json({ error: 'Not found' }, 404);
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
  try {
    const pageRes = await fetch(`https://${target.hostname}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const html = await pageRes.text();
    const { title, text } = extractPageInfo(html);
    const result = await classifySite(env, { hostname: target.hostname, title, text });
    safe = result.safe;
    reason = result.reason;
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
    await recordVerdict(env, { hostHash, target, verdict: 'clean', reason, source: 'gemini' });
    return json({ verdict: 'clean', reason, hostname: target.hostname });
  }

  // Not clean: cache the block so repeat hits don't re-call Gemini, and leave the wall up.
  await recordVerdict(env, { hostHash, target, verdict: 'blocked', reason, source: 'gemini' });
  return json({ verdict: 'blocked', reason, hostname: target.hostname });
}

function recordVerdict(env, { hostHash, target, verdict, reason, source }) {
  return env.DB.prepare(`
    INSERT INTO url_verdicts (url_hash, url, hostname, scope, verdict, reason, source, decided_at)
    VALUES (?, ?, ?, 'host', ?, ?, ?, ?)
    ON CONFLICT(url_hash) DO UPDATE SET
      url = excluded.url, hostname = excluded.hostname, scope = 'host',
      verdict = excluded.verdict, reason = excluded.reason,
      source = excluded.source, decided_at = excluded.decided_at
  `).bind(hostHash, target.url, target.hostname, verdict, reason || null, source, Date.now()).run();
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
  });

  return json({ ok: true, hostname: target.hostname });
}
