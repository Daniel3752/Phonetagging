// Strictness levels — the rules deciding whether a rated site is visible to a device on a given
// rung. Deliberately pure: no D1, no network, no Gateway. The caller passes rows in, so the awkward
// parts (the doorway override, the never-level sentinel, out-of-range input) are testable without
// standing up any infrastructure. Same shape as policy.js. See test/levels.test.mjs.

// The rungs a device can actually be on. Level 5 exists only as a rating — see NEVER_LEVEL.
export const MIN_LEVEL = 1;
export const MAX_DEVICE_LEVEL = 4;

// The sentinel rating for "no device may see this". Kept as a real rating rather than a missing row
// so a permanent block still records why it was blocked and never gets re-judged on every request.
export const NEVER_LEVEL = 5;

// Mirrors level_definitions in the schema. Duplicated here so the pure logic and its tests do not
// need a database; the DB rows are the source of truth for the Gateway ids, this is the source of
// truth for the semantics.
export const LEVELS = [
  { level: 1, name: 'Essential',  allowDoorways: false, allowCategories: false },
  { level: 2, name: 'General',    allowDoorways: false, allowCategories: false },
  { level: 3, name: 'Mainstream', allowDoorways: false, allowCategories: false },
  { level: 4, name: 'Permissive', allowDoorways: true,  allowCategories: true  },
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

// Same clamp for a site rating, which may legitimately be NEVER_LEVEL. Anything unusable becomes
// NEVER_LEVEL — an unrated or corrupt verdict must never resolve into "visible".
export function normalizeSiteLevel(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < MIN_LEVEL || n > NEVER_LEVEL) return NEVER_LEVEL;
  return n;
}

// The core rule: may a device on `deviceLevel` see this site?
//
// Two independent gates, and the site must clear BOTH:
//
//   1. Rating. The site's rating must be at or below the device's rung. A rating of NEVER_LEVEL
//      fails for every device, because no device is ever on rung 5.
//
//   2. Doorway. A site that is itself a way to reach arbitrary other content — a search engine, an
//      image search, an open user-content platform — is blocked on every rung that does not
//      explicitly permit doorways, REGARDLESS of its rating.
//
// The second gate is the one that matters. Google's homepage is a logo and a text box; judged on
// its own content it rates as Essential and would be allowed at every level, and the moment it is,
// the whole model is decoration — the search box reaches everything the allowlist was built to keep
// out. So the doorway flag overrides the rating rather than being folded into it.
export function isVisibleAtLevel(verdict, deviceLevel, definition) {
  const level = normalizeDeviceLevel(deviceLevel);
  const rating = normalizeSiteLevel(verdict?.level);
  const def = definition || levelDefinition(level);

  if (rating > level) return false;
  if (verdict?.is_doorway && !def?.allowDoorways) return false;
  return true;
}

// Every rung whose devices should resolve a site with this rating — i.e. which per-level Gateway
// lists the hostname belongs in. A site rated 2 goes in the lists for rungs 2, 3 and 4.
//
// Returns [] for a doorway or a NEVER_LEVEL rating, which is what keeps both out of every list
// without the caller needing to special-case them.
export function levelsThatAllow(verdict) {
  const rating = normalizeSiteLevel(verdict?.level);
  if (rating === NEVER_LEVEL) return [];
  return LEVELS
    .filter((l) => l.level >= rating && (!verdict?.is_doorway || l.allowDoorways))
    .map((l) => l.level);
}
