// The endpoint the filtering proxy asks about every request.
//
// Squid runs an external ACL helper (scripts/squid-acl-helper.py) which calls this once per request
// and gets back allow or deny. The model is UNIFORM across every web rung (2..5): the AI judges each
// site and search, and it is allowed only if its rating is at or below the device's rung. There is
// no allowlist and no allow-by-default — one rating gate, the bar per rung.
//
// Decision order (first match wins):
//   1. Rung 1 (no web) → deny everything.
//   2. Search URL → judge the QUERY (keyword pre-filter, then model). Image search is off on rungs
//      without it. A query can come back "text OK, images shtus" → allowed but result images stripped.
//   3. Image strip → on a rung with images off (rung 2), deny image requests.
//   4. Search engine homepage → allow the empty box wherever search is on.
//   5. Site → look up a verdict by exact host, then by whole (registrable) domain; if still unknown,
//      classify the domain INLINE (one call, cached forever, covers every subdomain). Then gate by
//      rating <= rung. site_mode 'trusted'/'blocked' short-circuits.
//
// The explicit/social BLOCKLIST is applied earlier still, in the Squid helper, before this endpoint
// is even called — so a known-explicit host never reaches the inline classifier.

import { classifySearchQuery } from './gemini.js';
import { parseSearchUrl, searchCacheKey, isSearchEngineHost } from './search.js';
import { keywordRating } from './keywords.js';
import { classifyDomain } from './classify.js';
import { registrableDomain, normalizeHost } from './domains.js';
import { isVisibleAtLevel, levelDefinition, normalizeDeviceLevel, normalizeSiteLevel, MIN_LEVEL, NEVER_LEVEL } from './levels.js';
import { sha256Hex, timingSafeEqual } from './crypto.js';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function requireProxyKey(request, env) {
  // PROXY_KEY only — no OPERATOR_KEY fallback. The operator key unlocks /admin and must not double
  // as the proxy credential: the two have different holders (a human vs a server config file) and
  // different blast radii when leaked.
  const expected = String(env.PROXY_KEY || '').trim();
  if (!expected) return json({ error: 'proxy_not_configured' }, 503);
  const m = /^Bearer\s+(.+)$/i.exec((request.headers.get('Authorization') || '').trim());
  const provided = m ? m[1] : '';
  if (!provided || !timingSafeEqual(provided.trim(), expected)) return json({ error: 'unauthorized' }, 401);
  return null;
}

// The proxy username Squid authenticated → the device's rung and its definition. An unknown device
// degrades to the STRICTEST rung (which has no web), never to open: proxy auth already proved this is
// one of ours, and a missing row is a bookkeeping failure best answered by a locked-down phone.
async function resolveDevice(env, proxyUser) {
  const fallback = { level: MIN_LEVEL, def: levelDefinition(MIN_LEVEL), deviceId: null, known: false };
  if (!proxyUser) return fallback;
  const row = await env.DB.prepare(`SELECT id, level FROM devices WHERE proxy_user = ?`)
    .bind(String(proxyUser)).first().catch(() => null);
  if (!row) return fallback;
  const level = normalizeDeviceLevel(row.level);
  return { level, def: levelDefinition(level), deviceId: row.id, known: true };
}

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'avif', 'heic', 'heif',
]);
function isImageRequest(u) {
  const m = /\.([a-z0-9]+)$/i.exec(u.pathname);
  return m ? IMAGE_EXTENSIONS.has(m[1].toLowerCase()) : false;
}

// Rates a typed search: keyword pre-filter (instant, no model), then the cache, then the model.
// Returns { level, imagesOk, reason }.
async function rateSearch(env, search) {
  const normalized = searchCacheKey(search.query);
  if (!normalized) return { level: NEVER_LEVEL, imagesOk: true, reason: 'Empty query.' };

  const rules = await env.DB.prepare(`SELECT pattern, rating, note FROM keyword_rules WHERE scope = 'search'`)
    .all().then((r) => r.results || []).catch(() => []);
  const kw = keywordRating(search.query, rules);
  if (kw) return { level: kw.rating, imagesOk: true, reason: kw.note || 'Matched a keyword rule.' };

  const hash = await sha256Hex(normalized);
  const cached = await env.DB.prepare(`SELECT level, images_ok, reason FROM search_verdicts WHERE query_hash = ?`)
    .bind(hash).first().catch(() => null);
  if (cached) {
    env.DB.prepare(`UPDATE search_verdicts SET hit_count = hit_count + 1 WHERE query_hash = ?`)
      .bind(hash).run().catch(() => {});
    return { level: normalizeSiteLevel(cached.level), imagesOk: cached.images_ok !== 0, reason: cached.reason };
  }

  let rated;
  try {
    rated = await classifySearchQuery(env, search);
  } catch {
    return { level: NEVER_LEVEL, imagesOk: true, reason: 'Could not check this search right now.', transient: true };
  }

  await env.DB.prepare(`
    INSERT INTO search_verdicts (query_hash, query_sample, level, images_ok, reason, source, decided_at, hit_count)
    VALUES (?, ?, ?, ?, ?, 'gemini', ?, 1)
    ON CONFLICT(query_hash) DO UPDATE SET
      level = excluded.level, images_ok = excluded.images_ok, reason = excluded.reason, decided_at = excluded.decided_at
  `).bind(hash, search.query.slice(0, 200), rated.level, rated.imagesOk ? 1 : 0, rated.reason || null, Date.now())
    .run().catch(() => {});

  return { level: normalizeSiteLevel(rated.level), imagesOk: rated.imagesOk !== false, reason: rated.reason };
}

// Looks up a site verdict: an exact-host row (seed / operator override) first, then a whole-domain
// row (AI classifications and the domains that share it). Returns the row or null.
async function lookupVerdict(env, hostname) {
  const exact = await env.DB.prepare(
    `SELECT level, is_doorway, reason, site_mode FROM url_verdicts WHERE url_hash = ? AND scope = 'host'`
  ).bind(await sha256Hex(hostname)).first().catch(() => null);
  if (exact) return exact;

  const domain = registrableDomain(hostname);
  if (domain && domain !== hostname) {
    const byDomain = await env.DB.prepare(
      `SELECT level, is_doorway, reason, site_mode FROM url_verdicts WHERE url_hash = ? AND scope = 'host'`
    ).bind(await sha256Hex(domain)).first().catch(() => null);
    if (byDomain) return byDomain;
  }
  return null;
}

// POST /api/proxy/check  { user, url }  ->  { allow, reason, level, action, ... }
export async function handleProxyCheck(request, env) {
  const denied = requireProxyKey(request, env);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.url) return json({ error: 'url is required' }, 400);

  let u;
  try { u = new URL(body.url); } catch { return json({ error: 'invalid url' }, 400); }
  const hostname = normalizeHost(u.hostname);

  const { level, def, deviceId, known } = await resolveDevice(env, body.user);
  const base = { device_level: level, device: deviceId, known_device: known };

  // 1. Rung 1: no web at all.
  if (!def || def.webMode === 'none') {
    return json({ ...base, allow: false, action: 'no_web', hostname, reason: 'The web is turned off at this level.' });
  }

  // 2. Search: judge the words. (Ahead of everything else so a search is always query-filtered.)
  const search = parseSearchUrl(body.url);
  if (search) {
    if (search.isImageSearch && !def.imageSearch) {
      return json({ ...base, allow: false, action: 'image_search', engine: search.engine, image_search: true,
        reason: 'Image search is turned off at this level.' });
    }
    const rated = await rateSearch(env, search);
    const allow = rated.level <= level;
    const imagesOff = allow && rated.imagesOk === false; // text answer permitted, result images stripped
    return json({
      ...base, allow,
      action: allow ? (imagesOff ? 'allow_text_only' : 'allow') : 'search',
      images_off: imagesOff, level: rated.level, engine: search.engine,
      image_search: search.isImageSearch, reason: rated.reason,
    });
  }

  // 3. Image strip on a rung with images off (rung 2).
  if (!def.images && isImageRequest(u)) {
    return json({ ...base, allow: false, action: 'image_blocked', hostname, reason: 'Images are turned off at this level.' });
  }

  // 4. A search engine's bare homepage (no query) — let the box load wherever search is enabled.
  if (def.textSearch && isSearchEngineHost(hostname)) {
    return json({ ...base, allow: true, action: 'allow', hostname, reason: 'Search homepage.' });
  }

  // 5. Ordinary site: known verdict, else classify the whole domain inline.
  let verdict = await lookupVerdict(env, hostname);
  let action;
  if (verdict) {
    if (verdict.site_mode === 'blocked') {
      return json({ ...base, allow: false, action: 'blocked', hostname, level: normalizeSiteLevel(verdict.level), reason: verdict.reason });
    }
    if (verdict.site_mode === 'trusted') {
      return json({ ...base, allow: true, action: 'allow', hostname, level: normalizeSiteLevel(verdict.level), reason: verdict.reason });
    }
    action = 'blocked';
  } else {
    verdict = await classifyDomain(env, hostname);
    // A transient classification failure is retryable, not a real block — tell the proxy so.
    action = verdict.transient ? 'unknown' : 'blocked';
  }

  const allow = isVisibleAtLevel(verdict, level, def);
  return json({
    ...base, allow, action: allow ? 'allow' : action, hostname,
    level: normalizeSiteLevel(verdict.level), reason: verdict.reason,
  });
}
