// The endpoint the filtering proxy asks about every request.
//
// Squid runs an external ACL helper (scripts/squid-acl-helper.py) which calls this once per request
// and gets back allow or deny. On the STANDARD ladder the model is UNIFORM across every web rung
// (2..5): the AI judges each site and search, and it is allowed only if its rating is at or below
// the device's rung. There is no allowlist and no allow-by-default — one rating gate, the bar per
// rung. On the YESHIVA tag (levels.js YESHIVA_LEVELS) the browser is a 'blocklist' rung instead:
// allow-by-default, no model in the request path, only the blocklists and what is already on file
// as NEVER refuse a site — and every image is blanked.
//
// Decision order (first match wins):
//   0. The phone's EFFECTIVE policy right now (its schedules, resolved the same way the scheduler
//      does) has web_mode 'none' → deny everything: the phone is locked (the shiur lock).
//   1. Rung with no web (rung 1 on either ladder) → deny everything.
//   2. Search URL → judge the QUERY (keyword pre-filter, then model on the standard ladder; keyword
//      pre-filter and anything on file, NO model, on a blocklist rung). Image search is off on
//      rungs without it. A query can come back "text OK, images shtus" → allowed but result images
//      stripped.
//   3. Image strip → on a rung with images off, deny image requests (by extension, or by the
//      Sec-Fetch-Dest the helper forwards). The block page serves a blank placeholder for these.
//   4. Search engine homepage → allow the empty box wherever search is on.
//   5. Site → look up a verdict by exact host, then by whole (registrable) domain. Standard ladder:
//      if still unknown, classify the domain INLINE (one call, cached forever, covers every
//      subdomain), then gate by rating <= rung. Blocklist rung: unknown is fine; only site_mode
//      'blocked' or a NEVER rating refuses. site_mode 'trusted'/'blocked' short-circuits.
//
// The explicit/social BLOCKLIST is applied earlier still, in the Squid helper, before this endpoint
// is even called — so a known-explicit host never reaches the inline classifier. This endpoint
// tells the helper whether the social list applies (block_social), whether the phone's approved
// hosts must be decrypted rather than spliced (decrypt), and whether images are to be stripped on
// a host-scoped answer (strip_images).

import { classifySearchQuery } from './gemini.js';
import { parseSearchUrl, searchCacheKey, isSearchEngineHost } from './search.js';
import { keywordRating } from './keywords.js';
import { classifyDomain } from './classify.js';
import { registrableDomain, normalizeHost } from './domains.js';
import { isVisibleAtLevel, levelDefinition, normalizeDeviceLevel, normalizeSiteLevel, normalizeTag, MIN_LEVEL, NEVER_LEVEL, DEFAULT_TAG } from './levels.js';
import { resolveEffectivePolicy } from './policy.js';
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

// The proxy username Squid authenticated → the device's tag, rung and definition, and whether the
// policy in force right now locks the web. An unknown device degrades to the STRICTEST rung (which
// has no web), never to open: proxy auth already proved this is one of ours, and a missing row is a
// bookkeeping failure best answered by a locked-down phone.
//
// One round trip: the device row is joined to every schedule that could cover it (its baseline
// policy, or its whole tag) and to the policies those schedules switch to, so the effective policy
// can be resolved here without a second query. D1's primary is an ocean away from where this
// Worker runs for the phones, and a person is waiting on every round trip.
async function resolveDevice(env, proxyUser, now) {
  const fallback = { level: MIN_LEVEL, tag: DEFAULT_TAG, def: levelDefinition(MIN_LEVEL), deviceId: null, known: false, locked: false, policyId: null };
  if (!proxyUser) return fallback;

  const rows = await env.DB.prepare(`
    SELECT d.id, d.level, d.tag, d.timezone, d.policy_id, bp.web_mode AS base_web_mode,
           s.id AS s_id, s.device_id AS s_device_id, s.base_policy_id AS s_base_policy_id,
           s.active_policy_id AS s_active_policy_id, s.day_mask AS s_day_mask, s.start_min AS s_start_min,
           s.end_min AS s_end_min, s.priority AS s_priority, s.created_at AS s_created_at,
           ap.web_mode AS s_web_mode
    FROM devices d
    LEFT JOIN policies bp ON bp.id = d.policy_id
    LEFT JOIN schedules s ON (s.base_policy_id = d.policy_id OR s.base_policy_id = 'tag:' || d.tag)
                         AND (s.device_id IS NULL OR s.device_id = d.id)
    LEFT JOIN policies ap ON ap.id = s.active_policy_id
    WHERE d.proxy_user = ?
  `).bind(String(proxyUser)).all().then((r) => r.results || []).catch(() => []);
  if (!rows.length) return fallback;

  const row = rows[0];
  const tag = normalizeTag(row.tag);
  const level = normalizeDeviceLevel(row.level, tag);
  const device = { id: row.id, policy_id: row.policy_id, timezone: row.timezone, tag };
  const webModeByPolicy = new Map([[row.policy_id, row.base_web_mode]]);
  const schedules = [];
  for (const r of rows) {
    if (!r.s_id) continue;
    schedules.push({
      id: r.s_id, device_id: r.s_device_id, base_policy_id: r.s_base_policy_id,
      active_policy_id: r.s_active_policy_id, day_mask: r.s_day_mask, start_min: r.s_start_min,
      end_min: r.s_end_min, priority: r.s_priority, created_at: r.s_created_at,
    });
    webModeByPolicy.set(r.s_active_policy_id, r.s_web_mode);
  }

  const { policyId } = resolveEffectivePolicy(device, schedules, now);
  return {
    level, tag, def: levelDefinition(level, tag), deviceId: row.id, known: true,
    policyId, locked: webModeByPolicy.get(policyId) === 'none',
  };
}

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'avif', 'heic', 'heif',
]);
// By extension, or by what the browser said it was fetching: Chrome sends Sec-Fetch-Dest: image on
// every <img>, <picture> and CSS background fetch, extension or not — and most images on the modern
// web have no extension (CDN hashes, thumbnail services). The helper forwards that header as `dest`.
function isImageRequest(u, dest) {
  if (dest === 'image') return true;
  const m = /\.([a-z0-9]+)$/i.exec(u.pathname);
  return m ? IMAGE_EXTENSIONS.has(m[1].toLowerCase()) : false;
}

// Rates a typed search: keyword pre-filter (instant, no model), then the cache, then the model.
// Returns { level, imagesOk, reason }. With noModel (a blocklist rung) an unmatched, uncached query
// is simply allowed — the tag's browser has no AI in the request path — so the answer is NEVER only
// when the keyword list or something already on file says so.
async function rateSearch(env, search, { noModel = false } = {}) {
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

  if (noModel) return { level: MIN_LEVEL, imagesOk: true, reason: 'Not on any list.' };

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

// Looks up a site verdict: an exact-host row (seed / operator override) wins over a whole-domain
// row (AI classifications and the domains that share it). Returns the row or null.
//
// One query for both candidates, not two in sequence. D1's primary is an ocean away from where
// this Worker runs for the phones, so every round trip is ~100ms and a person is waiting on each.
async function lookupVerdict(env, hostname) {
  const domain = registrableDomain(hostname);
  const hashes = [await sha256Hex(hostname)];
  if (domain && domain !== hostname) hashes.push(await sha256Hex(domain));

  const rows = await env.DB.prepare(
    `SELECT url_hash, level, is_doorway, reason, site_mode FROM url_verdicts
     WHERE scope = 'host' AND url_hash IN (${hashes.map(() => '?').join(', ')})`
  ).bind(...hashes).all().then((r) => r.results || []).catch(() => []);

  // Exact host first, then the domain — the order of `hashes`.
  for (const h of hashes) {
    const row = rows.find((r) => r.url_hash === h);
    if (row) return row;
  }
  return null;
}

// POST /api/proxy/check  { user, url, dest?, features? }  ->  { allow, reason, level, action, ... }
//
// dest is the request's Sec-Fetch-Dest when the helper has it ('image', 'document', ...).
// features lists what the calling helper understands, so a newer Worker never hands an older
// helper an answer it would misapply: 'strip_images' means the helper will deny image URLs itself
// on a host-scoped answer carrying strip_images, so such answers may be host-scoped.
export async function handleProxyCheck(request, env, now = new Date()) {
  const denied = requireProxyKey(request, env);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.url) return json({ error: 'url is required' }, 400);

  let u;
  try { u = new URL(body.url); } catch { return json({ error: 'invalid url' }, 400); }
  const hostname = normalizeHost(u.hostname);
  const dest = typeof body.dest === 'string' ? body.dest.toLowerCase() : '';
  const features = new Set(Array.isArray(body.features) ? body.features.map(String) : []);

  // The device row and the site verdict do not depend on each other, so they are fetched at the
  // same time. The verdict is only needed on the site path (step 5), but starting it here costs
  // nothing on the other paths and saves a full round trip on the common one.
  const search = parseSearchUrl(body.url);
  const verdictPromise = search ? null : lookupVerdict(env, hostname);
  const { level, tag, def, deviceId, known, locked } = await resolveDevice(env, body.user, now);

  // cache_scope tells the helper how widely it may reuse this answer: 'host' when the decision
  // depended on the hostname alone (an ordinary site — one answer covers every URL on it, so a page
  // load is one round trip rather than dozens), 'url' when the words or the path mattered.
  // A rung with images off decides per URL (step 3) unless the helper can strip images itself
  // (features: strip_images), in which case a site answer stays host-scoped and carries the flag.
  const stripImages = !!def && def.webMode !== 'none' && !def.images;
  const helperStrips = stripImages && features.has('strip_images');
  const base = {
    device_level: level, tag, device: deviceId, known_device: known,
    cache_scope: def && (def.images || helperStrips) ? 'host' : 'url',
    // The helper applies the social list only where the rung says so (it used to infer this from
    // the rung number, which only the standard ladder has).
    block_social: !!def?.blockSocial,
    // Whether approved hosts must be decrypted rather than spliced for this phone — images can only
    // be blanked on a connection the proxy can see inside. See levels.js YESHIVA_LEVELS.
    decrypt: !!def?.decrypt,
    strip_images: helperStrips,
  };

  // 0. Locked by the policy in force right now (a shiur window): nothing at all.
  if (locked) {
    return json({ ...base, cache_scope: 'host', allow: false, action: 'locked', hostname, reason: 'This phone is locked for shiur right now.' });
  }

  // 1. Rung 1: no web at all.
  if (!def || def.webMode === 'none') {
    return json({ ...base, allow: false, action: 'no_web', hostname, reason: 'The web is turned off at this level.' });
  }

  const blocklistMode = def.webMode === 'blocklist';

  // 2. Search: judge the words. (Ahead of everything else so a search is always query-filtered.)
  if (search) {
    if (search.isImageSearch && !def.imageSearch) {
      return json({ ...base, cache_scope: 'url', allow: false, action: 'image_search', engine: search.engine, image_search: true,
        reason: 'Image search is turned off at this level.' });
    }
    const rated = await rateSearch(env, search, { noModel: blocklistMode });
    // A blocklist rung has no bar to clear — only NEVER refuses. The standard ladder gates by rung.
    const allow = blocklistMode ? rated.level < NEVER_LEVEL : rated.level <= level;
    // Text answer permitted, result images stripped: the model said so, or the rung has no images.
    const imagesOff = allow && (rated.imagesOk === false || !def.images);
    return json({
      ...base, cache_scope: 'url', allow,
      action: allow ? (imagesOff ? 'allow_text_only' : 'allow') : 'search',
      images_off: imagesOff, level: rated.level, engine: search.engine,
      image_search: search.isImageSearch, reason: rated.reason,
    });
  }

  // 3. Image strip on a rung with images off.
  if (stripImages && isImageRequest(u, dest)) {
    return json({ ...base, cache_scope: 'url', allow: false, action: 'image_blocked', hostname, reason: 'Images are turned off at this level.' });
  }

  // 4. A search engine's bare homepage (no query) — let the box load wherever search is enabled.
  if (def.textSearch && isSearchEngineHost(hostname)) {
    return json({ ...base, allow: true, action: 'allow', hostname, reason: 'Search homepage.' });
  }

  // 5. Ordinary site: known verdict, else classify the whole domain inline (standard ladder) or
  //    allow it (blocklist rung — the explicit and social lists were already applied by the helper).
  let verdict = await verdictPromise;
  let action;
  if (verdict) {
    if (verdict.site_mode === 'blocked') {
      return json({ ...base, allow: false, action: 'blocked', hostname, level: normalizeSiteLevel(verdict.level), reason: verdict.reason });
    }
    if (verdict.site_mode === 'trusted') {
      return json({ ...base, allow: true, action: 'allow', hostname, level: normalizeSiteLevel(verdict.level), reason: verdict.reason });
    }
    action = 'blocked';
  } else if (blocklistMode) {
    return json({ ...base, allow: true, action: 'allow', hostname, reason: 'Not on any list.' });
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
