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
//   'none'  no web at all (rung 1)
//   'web'   the AI judges every site and search, and it is allowed only if its rating is at or
//           below the rung. There is no manual allowlist and no allow-by-default — one uniform
//           rating gate, with the bar sliding up per rung (rung 2 = ratings <=2 .. rung 5 = <=5).
//
// textSearch / imageSearch gate the search path (proxy-api.js); images gates whether the proxy
// strips image content; blockSocial says the L2 social blocklist applies at this rung. Mirrors
// level_definitions in the schema — the DB rows are the source of truth for enforcement ids, this is
// the source of truth for the semantics, and the two are kept in step.
export const LEVELS = [
  { level: 1, name: 'No browser', webMode: 'none', images: false, textSearch: false, imageSearch: false, blockSocial: true  },
  { level: 2, name: 'Text-only',  webMode: 'web',  images: false, textSearch: true,  imageSearch: false, blockSocial: true  },
  { level: 3, name: 'Essential',  webMode: 'web',  images: true,  textSearch: true,  imageSearch: true,  blockSocial: true  },
  { level: 4, name: 'General',    webMode: 'web',  images: true,  textSearch: true,  imageSearch: true,  blockSocial: true  },
  { level: 5, name: 'Open',       webMode: 'web',  images: true,  textSearch: true,  imageSearch: true,  blockSocial: false },
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

// The core rule, uniform across every web rung: a site (or a search) is visible only if its rating
// is at or below the device's rung. NEVER (6) exceeds every rung, so explicit stays blocked even at
// the most open one. Rung 1 has no web, so nothing is visible there.
//
// Blocklist denials (explicit, social) are applied earlier in proxy-api.js / the Squid helper and
// never reach here; an UNKNOWN site (no verdict row) is classified inline before this is called, so
// by the time we get here there is always a rating to test.
export function isVisibleAtLevel(verdict, deviceLevel, definition) {
  const level = normalizeDeviceLevel(deviceLevel);
  const def = definition || levelDefinition(level);
  if (!def || def.webMode === 'none') return false;
  return normalizeSiteLevel(verdict?.level) <= level;
}

// Every ALLOWLIST rung whose devices should resolve a site with this rating — i.e. which per-level
// allowlist the hostname belongs in. Permissive rungs (4, 5) keep no allowlist (they are
// allow-by-default), so they never appear here; a site is reachable there by default, not by list
// membership.
//
// Every web rung whose devices may see a site with this rating — i.e. every rung at or above the
// rating. Returns [] for a NEVER rating. Used where a per-rung expansion of a verdict is handy.
export function levelsThatAllow(verdict) {
  const rating = normalizeSiteLevel(verdict?.level);
  if (rating === NEVER_LEVEL) return [];
  return LEVELS.filter((l) => l.webMode === 'web' && l.level >= rating).map((l) => l.level);
}
