// Strictness levels — the rules deciding whether a rated site is visible to a device on a given
// rung. Deliberately pure: no D1, no network, no Gateway. The caller passes rows in, so the awkward
// parts (the mode branch, the never-level sentinel, out-of-range input) are testable without
// standing up any infrastructure. Same shape as policy.js. See test/levels.test.mjs.
//
// There are now TWO ladders ("tags"), and every device carries which one it is on (devices.tag):
//
//   'standard' — the five-rung AI-judged ladder this system was built around (below).
//   'yeshiva'  — the TEMPORARY four-rung tag for getting the yeshiva phones started before they are
//                migrated onto the standard ladder. One browser profile (blocklists only, images
//                blanked, no AI rating), and the rungs differ in their APP model. See YESHIVA.md.
//
// The standard model is FIVE rungs, 1 = strictest .. 5 = most open, and each rung is a filtering
// MODE, not just a bigger allowlist than the one below it:
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

// The rungs a device can actually be on (the standard ladder; the yeshiva ladder has four).
export const MIN_LEVEL = 1;
export const MAX_DEVICE_LEVEL = 5;

// The sentinel rating for "no device may see this", one above the top rung. Explicit content is
// rated NEVER so it is blocked at every rung INCLUDING the most open one — "everything but explicit"
// means explicit is never visible, even at rung 5. Kept as a real rating rather than a missing row
// so a permanent block still records why and never gets re-judged on every request.
export const NEVER_LEVEL = 6;

// webMode:
//   'none'      no web at all (rung 1)
//   'web'       the AI judges every site and search, and it is allowed only if its rating is at or
//               below the rung. There is no manual allowlist and no allow-by-default — one uniform
//               rating gate, with the bar sliding up per rung (rung 2 = ratings <=2 .. rung 5 = <=5).
//   'blocklist' allow-by-default with NO AI rating: only the explicit and social blocklists, sites an
//               operator blocked by hand, and anything already on file as NEVER are refused. This is
//               the yeshiva tag's one browser profile.
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

// The yeshiva temp tag. The BROWSER is the same on every rung that has one: blocklist-only (the
// explicit list at every rung, the social list too), images blanked, image search off, searches
// screened by the keyword list and anything already on file as NEVER — no model in the request
// path. What changes between rungs is the APP model, which Headwind enforces:
//
//   1  Apps only            — an ALLOWLIST of apps; the browser is not on it.
//   2  Apps + browser       — the same allowlist, with Chrome on it.
//   3  Blocklist, no social — everything except a BLOCKLIST: social, explicit/dating, other
//                             browsers, VPNs.
//   4  Blocklist            — the same blocklist minus the social apps.
//
// appModel is what policies.app_default mirrors for the policy that pairs with the rung.
// decrypt: true means the proxy BUMPS every approved host for these phones rather than splicing
// it (see PROXY.md "Decrypt or pass through"): an image can only be blanked on a connection the
// proxy can see inside. The cost is that an app which does not trust the filter's certificate
// breaks unless its hosts are in splice.txt — bounded on rungs 1-2 by the short app allowlist.
export const YESHIVA_LEVELS = [
  { level: 1, name: 'Apps only',            webMode: 'none',      images: false, textSearch: false, imageSearch: false, blockSocial: true, appModel: 'allowlist', decrypt: true },
  { level: 2, name: 'Apps + browser',       webMode: 'blocklist', images: false, textSearch: true,  imageSearch: false, blockSocial: true, appModel: 'allowlist', decrypt: true },
  { level: 3, name: 'Blocklist, no social', webMode: 'blocklist', images: false, textSearch: true,  imageSearch: false, blockSocial: true, appModel: 'blocklist', decrypt: true },
  { level: 4, name: 'Blocklist',            webMode: 'blocklist', images: false, textSearch: true,  imageSearch: false, blockSocial: true, appModel: 'blocklist', decrypt: true },
];

// The tags a device can carry, with the ladder each one uses and the app-policy id convention
// (policy.js turns a tag + rung into `${policyPrefix}_${rung}`).
export const TAGS = {
  standard: { id: 'standard', name: 'Standard (5 rungs)',        levels: LEVELS,         policyPrefix: 'apps_rung' },
  yeshiva:  { id: 'yeshiva',  name: 'Yeshiva temp tag (4 rungs)', levels: YESHIVA_LEVELS, policyPrefix: 'yeshiva_rung' },
};
export const DEFAULT_TAG = 'standard';

// Anything that is not a known tag is the standard ladder: an old row has no tag column, and a
// typo must not land a phone on a ladder the operator never chose.
export function normalizeTag(value) {
  const t = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TAGS, t) ? t : DEFAULT_TAG;
}

export function ladderFor(tag) {
  return TAGS[normalizeTag(tag)].levels;
}

export function maxLevelFor(tag) {
  const ladder = ladderFor(tag);
  return ladder[ladder.length - 1].level;
}

export function levelDefinition(level, tag = DEFAULT_TAG) {
  return ladderFor(tag).find((l) => l.level === level) || null;
}

// Clamps anything that reaches us from a form, an API body or an old row into a usable device rung.
// Never throws: a device with a corrupt level must not take down a scheduler run for the fleet, and
// the safe direction to fail is STRICTER, so anything unusable becomes MIN_LEVEL.
export function normalizeDeviceLevel(value, tag = DEFAULT_TAG) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_LEVEL || n > maxLevelFor(tag)) return MIN_LEVEL;
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
//
// A 'blocklist' rung (the yeshiva browser) has no rating gate at all: everything not on file as
// NEVER is visible. That branch is here so one function answers "visible?" for every ladder.
export function isVisibleAtLevel(verdict, deviceLevel, definition) {
  const def = definition || levelDefinition(normalizeDeviceLevel(deviceLevel));
  if (!def || def.webMode === 'none') return false;
  const rating = normalizeSiteLevel(verdict?.level);
  if (def.webMode === 'blocklist') return rating < NEVER_LEVEL;
  return rating <= normalizeDeviceLevel(deviceLevel);
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
