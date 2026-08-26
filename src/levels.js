// Strictness levels — the rules deciding whether a rated site is visible to a device on a given
// rung. Deliberately pure: no D1, no network, no Gateway. The caller passes rows in, so the awkward
// parts (the mode branch, the never-level sentinel, out-of-range input) are testable without
// standing up any infrastructure. Same shape as policy.js. See test/levels.test.mjs.
//
// The model is FIVE rungs, 1 = strictest .. 5 = most open, and each rung is a filtering MODE, not
// just a bigger allowlist than the one below it:
//
//   1  No browser  — no web at all (apps only). webMode 'none'.
//   2  Text-only   — Essential allowlist, images stripped, text search only. webMode 'allowlist'.
//   3  Essential   — Essential allowlist, images + filtered image search.    webMode 'allowlist'.
//   4  General     — allow-by-default; social + explicit blocked upstream.    webMode 'permissive'.
//   5  Open         — allow-by-default; explicit blocked upstream.            webMode 'permissive'.
//
// The load-bearing line is between rung 3 and rung 4: rungs 1-3 are DENY-by-default (a site is
// hidden unless an allowlist row rates it at or below the rung), rungs 4-5 are ALLOW-by-default (a
// site is shown unless a blocklist denies it upstream in proxy-api.js). This function only decides
// the allowlist/permissive question; the blocklist, the search path and the image rules live in
// proxy-api.js.

// The rungs a device can actually be on.
export const MIN_LEVEL = 1;
export const MAX_DEVICE_LEVEL = 5;

// The sentinel rating for "no device may see this", one above the top rung. Explicit content is
// rated NEVER so it is blocked at every rung INCLUDING the most open one — "everything but explicit"
// means explicit is never visible, even at rung 5. Kept as a real rating rather than a missing row
// so a permanent block still records why and never gets re-judged on every request.
export const NEVER_LEVEL = 6;

// webMode:
//   'none'       no web at all
//   'allowlist'  deny-by-default; a site is visible only if rated at or below the rung
//   'permissive' allow-by-default; every non-NEVER site is visible (blocklist handled upstream)
//
// textSearch / imageSearch gate the search path (proxy-api.js); images gates whether the proxy
// strips image content; blockSocial says the L2 social blocklist applies at this rung. Mirrors
// level_definitions in the schema — the DB rows are the source of truth for enforcement ids, this is
// the source of truth for the semantics, and the two are kept in step.
export const LEVELS = [
  { level: 1, name: 'No browser', webMode: 'none',       images: false, textSearch: false, imageSearch: false, blockSocial: true  },
  { level: 2, name: 'Text-only',  webMode: 'allowlist',  images: false, textSearch: true,  imageSearch: false, blockSocial: true  },
  { level: 3, name: 'Essential',  webMode: 'allowlist',  images: true,  textSearch: true,  imageSearch: true,  blockSocial: true  },
  { level: 4, name: 'General',    webMode: 'permissive', images: true,  textSearch: true,  imageSearch: true,  blockSocial: true  },
  { level: 5, name: 'Open',       webMode: 'permissive', images: true,  textSearch: true,  imageSearch: true,  blockSocial: false },
];

export function levelDefinition(level) {
  return LEVELS.find((l) => l.level === level) || null;
}

// Clamps anything that reaches us from a form, an API body or an old row into a usable device rung.
// Never throws: a device with a corrupt level must not take down a scheduler run for the fleet, and
// the safe direction to fail is STRICTER, so anything unusable becomes MIN_LEVEL.
export function normalizeDeviceLevel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_LEVEL || n > MAX_DEVICE_LEVEL) return MIN_LEVEL;
  return n;
}

// Same clamp for a site/search rating, which may legitimately be NEVER_LEVEL. Anything unusable
// becomes NEVER_LEVEL — an unrated or corrupt verdict must never resolve into "visible".
export function normalizeSiteLevel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_LEVEL || n > NEVER_LEVEL) return NEVER_LEVEL;
  return n;
}

// The core rule: may a device on `deviceLevel` see this site, considering ONLY the allowlist/rating
// question? Blocklist denials (explicit, social) are applied earlier in proxy-api.js and never reach
// here.
//
// Gates, in order:
//   1. webMode 'none'  → nothing is visible.
//   2. NEVER rating    → nothing on any rung; explicit stays blocked even at the most open rung.
//   3. webMode 'permissive' → every remaining site is visible (allow-by-default). Open user-content
//                        platforms and social are kept out here by the L2 blocklist upstream, not by
//                        this function.
//   4. webMode 'allowlist' → a DOORWAY (open user-content platform, image board) needs an explicit
//                        allow and is never resolved by rating alone on a strict rung. A search
//                        ENGINE is different: its homepage is reached via the search path in
//                        proxy-api.js, not here, so this staying false does not block search.
//                        Everything else is visible only if rated at or below the rung.
export function isVisibleAtLevel(verdict, deviceLevel, definition) {
  const level = normalizeDeviceLevel(deviceLevel);
  const rating = normalizeSiteLevel(verdict?.level);
  const def = definition || levelDefinition(level);

  if (!def || def.webMode === 'none') return false;
  if (rating === NEVER_LEVEL) return false;
  if (def.webMode === 'permissive') return true;
  if (verdict?.is_doorway) return false;
  return rating <= level;
}

// Every ALLOWLIST rung whose devices should resolve a site with this rating — i.e. which per-level
// allowlist the hostname belongs in. Permissive rungs (4, 5) keep no allowlist (they are
// allow-by-default), so they never appear here; a site is reachable there by default, not by list
// membership.
//
// Returns [] for a NEVER rating and for a doorway — a doorway needs an explicit per-rung allow and
// never lands in an allowlist by rating. The caller uses this to populate the per-rung allowlists.
export function levelsThatAllow(verdict) {
  const rating = normalizeSiteLevel(verdict?.level);
  if (rating === NEVER_LEVEL || verdict?.is_doorway) return [];
  return LEVELS
    .filter((l) => l.webMode === 'allowlist' && l.level >= rating)
    .map((l) => l.level);
}
