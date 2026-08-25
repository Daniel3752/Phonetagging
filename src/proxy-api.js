// The endpoint the filtering proxy asks about every request.
//
// Squid runs an external ACL helper (scripts/squid-acl-helper.py) which calls this once per request
// and gets back allow or deny. That is the whole reason the proxy architecture is worth its cost:
// Cloudflare Gateway decides from static lists and cannot call out mid-request, so the classifier
// could only ever run out of band. Here it is IN the path, and can judge the full URL — including
// the words typed into a search box.
//
// Two checks, in this order:
//
//   1. If the URL is a search, the QUERY is rated. This is the check DNS could never make: at DNS
//      the filter sees `www.google.com` and nothing more, so approving Google once approves every
//      search anyone will ever run.
//   2. Otherwise the SITE is rated, from the cache written by /api/verdict.
//
// Latency budget matters — a person is waiting on a page. A cached answer is one D1 read. Only a
// genuinely new search pays for a model call, and unknown SITES are never classified inline: they
// are denied immediately and the block page drives classification, because holding a page load open
// for several seconds to fetch and judge a homepage is not a trade worth making.

import { classifySearchQuery } from './gemini.js';
import { parseSearchUrl, searchCacheKey } from './search.js';
import { isVisibleAtLevel, normalizeDeviceLevel, MIN_LEVEL, NEVER_LEVEL } from './levels.js';
import { sha256Hex, timingSafeEqual } from './crypto.js';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

// The helper authenticates with PROXY_KEY, falling back to OPERATOR_KEY so an existing deployment
// keeps working before the new secret is set. A missing key is a 503, never an open door.
function requireProxyKey(request, env) {
  const expected = env.PROXY_KEY || env.OPERATOR_KEY;
  if (!expected) return json({ error: 'proxy_not_configured' }, 503);
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') || '').trim());
  const provided = m ? m[1] : '';
  if (!provided || !timingSafeEqual(provided, expected)) return json({ error: 'unauthorized' }, 401);
  return null;
}

// Resolves the proxy username Squid authenticated into the device's strictness rung.
//
// An unknown device degrades to the STRICTEST rung rather than being denied outright. Proxy auth has
// already established that this is one of ours; a row missing from D1 is a bookkeeping failure, and
// the useful response to that is a phone that still works but is locked down, not a phone that is
// bricked until someone notices.
async function resolveDeviceLevel(env, proxyUser) {
  if (!proxyUser) return { level: MIN_LEVEL, deviceId: null, known: false };
  const row = await env.DB.prepare(
    `SELECT id, level FROM devices WHERE proxy_user = ?`
  ).bind(String(proxyUser)).first().catch(() => null);

  if (!row) return { level: MIN_LEVEL, deviceId: null, known: false };
  return { level: normalizeDeviceLevel(row.level), deviceId: row.id, known: true };
}

// Rates a typed search, using the cache when it can.
//
// The cache key is the NORMALISED query (see searchCacheKey): lowercased, punctuation stripped,
// words sorted. Without that the cache never hits — nobody types a phrase the same way twice — and
// anyone gets a fresh unjudged query just by adding a comma.
async function rateSearch(env, search) {
  const key = searchCacheKey(search.query);
  if (!key) return { level: NEVER_LEVEL, reason: 'Empty query.', cached: false };

  const hash = await sha256Hex(key);

  const cached = await env.DB.prepare(
    `SELECT level, reason FROM search_verdicts WHERE query_hash = ?`
  ).bind(hash).first().catch(() => null);

  if (cached) {
    // Fire-and-forget: the count is telemetry for the operator console ("what is being tried"), and
    // a failed increment must never turn into a failed page load.
    env.DB.prepare(`UPDATE search_verdicts SET hit_count = hit_count + 1 WHERE query_hash = ?`)
      .bind(hash).run().catch(() => {});
    return { level: normalizeDeviceLevel1to5(cached.level), reason: cached.reason, cached: true };
  }

  let rated;
  try {
    rated = await classifySearchQuery(env, search);
  } catch {
    // Fail closed. An unjudged query is not a permitted one, and nothing is cached, so the next
    // attempt re-judges rather than inheriting a verdict born of a transient outage.
    return { level: NEVER_LEVEL, reason: 'Could not check this search right now.', cached: false, transient: true };
  }

  await env.DB.prepare(`
    INSERT INTO search_verdicts (query_hash, query_sample, level, reason, source, decided_at, hit_count)
    VALUES (?, ?, ?, ?, 'gemini', ?, 1)
    ON CONFLICT(query_hash) DO UPDATE SET
      level = excluded.level, reason = excluded.reason, decided_at = excluded.decided_at
  `).bind(hash, search.query.slice(0, 200), rated.level, rated.reason || null, Date.now())
    .run().catch(() => {});

  return { level: rated.level, reason: rated.reason, cached: false };
}

// Ratings share the 1..5 ladder with sites but are not device rungs, so they need the wider clamp.
function normalizeDeviceLevel1to5(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= NEVER_LEVEL ? n : NEVER_LEVEL;
}

// POST /api/proxy/check  { user, url }  ->  { allow, reason, level, action }
//
// `action` tells the proxy WHY a denial happened, so it can respond usefully rather than showing one
// undifferentiated wall:
//   'blocked'  - rated above this device's rung; there is nothing to request
//   'unknown'  - never classified; the block page should offer to request it
//   'search'   - the typed query was refused
export async function handleProxyCheck(request, env) {
  const denied = requireProxyKey(request, env);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.url) return json({ error: 'url is required' }, 400);

  const { level, deviceId, known } = await resolveDeviceLevel(env, body.user);

  // --- Search: judge the words, not the destination ---------------------------------------------
  const search = parseSearchUrl(body.url);
  if (search) {
    const rated = await rateSearch(env, search);
    const allow = rated.level <= level;
    return json({
      allow,
      action: allow ? 'allow' : 'search',
      level: rated.level,
      device_level: level,
      device: deviceId,
      engine: search.engine,
      image_search: search.isImageSearch,
      reason: rated.reason,
      known_device: known,
    });
  }

  // --- Ordinary request: judge the site ----------------------------------------------------------
  let hostname;
  try {
    hostname = new URL(body.url).hostname.replace(/\.$/, '').toLowerCase();
  } catch {
    return json({ error: 'invalid url' }, 400);
  }

  const verdict = await env.DB.prepare(
    `SELECT level, is_doorway, reason FROM url_verdicts WHERE url_hash = ? AND scope = 'host'`
  ).bind(await sha256Hex(hostname)).first().catch(() => null);

  if (!verdict) {
    return json({
      allow: false, action: 'unknown', device_level: level, device: deviceId,
      hostname, reason: 'This site has not been reviewed yet.', known_device: known,
    });
  }

  const allow = isVisibleAtLevel(verdict, level);
  return json({
    allow,
    action: allow ? 'allow' : 'blocked',
    level: normalizeDeviceLevel1to5(verdict.level),
    device_level: level,
    device: deviceId,
    hostname,
    reason: verdict.reason,
    known_device: known,
  });
}
