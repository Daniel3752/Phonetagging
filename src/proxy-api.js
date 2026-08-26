// The endpoint the filtering proxy asks about every request.
//
// Squid runs an external ACL helper (scripts/squid-acl-helper.py) which calls this once per request
// and gets back allow or deny. That is the whole reason the proxy architecture is worth its cost:
// the classifier is IN the path and can judge the full URL — including the words typed into a search
// box — instead of only a hostname.
//
// The decision order (first match wins), matching BUILD-PLAN.md §2 with search moved ahead of the
// per-site mode so a "trusted" search engine can never bypass query filtering:
//
//   1. Rung 1 (no web) → deny everything.
//   2. Image strip → on a rung with images off (rung 2), deny image requests.
//   3. Search URL → judge the QUERY (keyword pre-filter, then model); image search is off on rungs
//      without it.
//   4. Search engine homepage → allow the empty search box wherever search is enabled.
//   5. Per-site mode → blocked/trusted short-circuit; otherwise the allowlist/permissive rating test.
//
// The explicit/social BLOCKLIST is applied earlier still, in the Squid helper, before this endpoint
// is even called (see §5) — so on the permissive rungs an unknown host that reached here has already
// cleared the blocklist and is allowed by default.
//
// Latency budget matters — a person is waiting on a page. A cached or keyword answer is one D1 read
// or none. Only a genuinely new search pays for a model call; unknown SITES are never classified
// inline (that would hold the page open for seconds), so on a deny-by-default rung they are denied
// and the block page drives classification.

import { classifySearchQuery } from './gemini.js';
import { parseSearchUrl, searchCacheKey, isSearchEngineHost } from './search.js';
import { keywordRating } from './keywords.js';
import {
  isVisibleAtLevel, levelDefinition, normalizeDeviceLevel, normalizeSiteLevel,
  MIN_LEVEL, NEVER_LEVEL,
} from './levels.js';
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

// Resolves the proxy username Squid authenticated into the device's rung and its definition.
//
// An unknown device degrades to the STRICTEST rung rather than being denied outright. Proxy auth has
// already established that this is one of ours; a row missing from D1 is a bookkeeping failure, and
// the useful response is a phone that still works but is locked down, not one that is bricked.
async function resolveDevice(env, proxyUser) {
  const fallback = { level: MIN_LEVEL, def: levelDefinition(MIN_LEVEL), deviceId: null, known: false };
  if (!proxyUser) return fallback;
  const row = await env.DB.prepare(
    `SELECT id, level FROM devices WHERE proxy_user = ?`
  ).bind(String(proxyUser)).first().catch(() => null);
  if (!row) return fallback;
  const level = normalizeDeviceLevel(row.level);
  return { level, def: levelDefinition(level), deviceId: row.id, known: true };
}

// Extensions the proxy treats as an image request, for the text-only rung's image strip. Matched on
// the URL path only — the response content-type is not available when the ACL helper asks. That is
// a deliberate, documented limit: images baked into a page as data: URIs or CSS backgrounds carry no
// such request and cannot be stripped this way (see BUILD-PLAN.md §6).
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'avif', 'heic', 'heif',
]);

function isImageRequest(u) {
  const m = /\.([a-z0-9]+)$/i.exec(u.pathname);
  return m ? IMAGE_EXTENSIONS.has(m[1].toLowerCase()) : false;
}

// Rates a typed search, using the keyword pre-filter and then the cache before paying for a model
// call.
//
//   1. Keyword rules (keyword_rules) → an instant rating, no model call, not cached (kept live so an
//      operator edit takes effect at once). Empty table today → always falls through.
//   2. search_verdicts cache → one D1 read.
//   3. The model → cached on success; a transient failure caches nothing and fails closed.
async function rateSearch(env, search) {
  const normalized = searchCacheKey(search.query);
  if (!normalized) return { level: NEVER_LEVEL, reason: 'Empty query.', cached: false };

  // 1. Keyword pre-filter.
  const rules = await env.DB.prepare(
    `SELECT pattern, rating, note FROM keyword_rules WHERE scope = 'search'`
  ).all().then((r) => r.results || []).catch(() => []);
  const kw = keywordRating(search.query, rules);
  if (kw) return { level: kw.rating, reason: kw.note || 'Matched a keyword rule.', cached: false, keyword: true };

  const hash = await sha256Hex(normalized);

  // 2. Cache.
  const cached = await env.DB.prepare(
    `SELECT level, reason FROM search_verdicts WHERE query_hash = ?`
  ).bind(hash).first().catch(() => null);
  if (cached) {
    env.DB.prepare(`UPDATE search_verdicts SET hit_count = hit_count + 1 WHERE query_hash = ?`)
      .bind(hash).run().catch(() => {});
    return { level: normalizeSiteLevel(cached.level), reason: cached.reason, cached: true };
  }

  // 3. Model.
  let rated;
  try {
    rated = await classifySearchQuery(env, search);
  } catch {
    return { level: NEVER_LEVEL, reason: 'Could not check this search right now.', cached: false, transient: true };
  }

  await env.DB.prepare(`
    INSERT INTO search_verdicts (query_hash, query_sample, level, reason, source, decided_at, hit_count)
    VALUES (?, ?, ?, ?, 'gemini', ?, 1)
    ON CONFLICT(query_hash) DO UPDATE SET
      level = excluded.level, reason = excluded.reason, decided_at = excluded.decided_at
  `).bind(hash, search.query.slice(0, 200), rated.level, rated.reason || null, Date.now())
    .run().catch(() => {});

  return { level: normalizeSiteLevel(rated.level), reason: rated.reason, cached: false };
}

// POST /api/proxy/check  { user, url }  ->  { allow, reason, level, action }
//
// `action` tells the proxy WHY, so it can respond usefully rather than showing one undifferentiated
// wall:
//   'allow'         - permitted
//   'no_web'        - rung 1: the browser is off entirely
//   'image_blocked' - an image request on the text-only rung
//   'image_search'  - image search on a rung that does not permit it
//   'search'        - the typed query was refused
//   'blocked'       - a rated site above this rung, or a NEVER/blocked site
//   'unknown'       - never classified on a deny-by-default rung; the block page can offer to request it
export async function handleProxyCheck(request, env) {
  const denied = requireProxyKey(request, env);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.url) return json({ error: 'url is required' }, 400);

  let u;
  try {
    u = new URL(body.url);
  } catch {
    return json({ error: 'invalid url' }, 400);
  }
  const hostname = u.hostname.replace(/\.$/, '').toLowerCase();

  const { level, def, deviceId, known } = await resolveDevice(env, body.user);
  const base = { device_level: level, device: deviceId, known_device: known };

  // 1. Rung 1: no web at all.
  if (!def || def.webMode === 'none') {
    return json({ ...base, allow: false, action: 'no_web', hostname, reason: 'The web is turned off at this level.' });
  }

  // 3. Search: judge the words, not the destination. (Ahead of image strip so an image-search URL is
  //    answered as a search, and ahead of per-site mode so no trusted engine skips query filtering.)
  const search = parseSearchUrl(body.url);
  if (search) {
    if (search.isImageSearch && !def.imageSearch) {
      return json({
        ...base, allow: false, action: 'image_search', engine: search.engine, image_search: true,
        reason: 'Image search is turned off at this level.',
      });
    }
    const rated = await rateSearch(env, search);
    const allow = rated.level <= level;
    return json({
      ...base, allow, action: allow ? 'allow' : 'search',
      level: rated.level, engine: search.engine, image_search: search.isImageSearch, reason: rated.reason,
    });
  }

  // 2. Image strip on a rung with images off (rung 2). After the search path so an image-search URL
  //    is reported as such, not as a generic blocked image.
  if (!def.images && isImageRequest(u)) {
    return json({ ...base, allow: false, action: 'image_blocked', hostname, reason: 'Images are turned off at this level.' });
  }

  // 4. A search engine's bare homepage (no query) — let the box load wherever search is enabled.
  if (def.textSearch && isSearchEngineHost(hostname)) {
    return json({ ...base, allow: true, action: 'allow', hostname, reason: 'Search homepage.' });
  }

  // 5. Ordinary site.
  const verdict = await env.DB.prepare(
    `SELECT level, is_doorway, reason, site_mode FROM url_verdicts WHERE url_hash = ? AND scope = 'host'`
  ).bind(await sha256Hex(hostname)).first().catch(() => null);

  if (verdict) {
    if (verdict.site_mode === 'blocked') {
      return json({ ...base, allow: false, action: 'blocked', hostname, level: normalizeSiteLevel(verdict.level), reason: verdict.reason });
    }
    if (verdict.site_mode === 'trusted') {
      return json({ ...base, allow: true, action: 'allow', hostname, level: normalizeSiteLevel(verdict.level), reason: verdict.reason });
    }
    const allow = isVisibleAtLevel(verdict, level, def);
    return json({ ...base, allow, action: allow ? 'allow' : 'blocked', hostname, level: normalizeSiteLevel(verdict.level), reason: verdict.reason });
  }

  // No row. On a permissive rung the blocklist upstream has already had its say, so an unknown host
  // is allowed by default. On a deny-by-default rung it is blocked and marked requestable.
  if (def.webMode === 'permissive') {
    return json({ ...base, allow: true, action: 'allow', hostname, reason: 'Allowed by default at this level.' });
  }
  return json({ ...base, allow: false, action: 'unknown', hostname, reason: 'This site has not been reviewed yet.' });
}
