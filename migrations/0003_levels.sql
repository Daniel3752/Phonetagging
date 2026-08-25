-- Strictness levels: the site verdict stops being a boolean and becomes a RATING, and every device
-- carries the level it is allowed to see.
--
-- Modelled on how the established filters in this market (Rimon, NetFree) actually grade content:
-- not "appropriate / inappropriate" but a ladder of modesty, where each subscriber picks a rung.
-- The rating is decided ONCE per site and reused by every device at or above that rung, which is
-- what keeps classification volume flat as the fleet grows.
--
-- NOTE: unlike 0001 and 0002 this migration is NOT re-runnable — SQLite has no
-- "ALTER TABLE ... ADD COLUMN IF NOT EXISTS". Apply it exactly once to an existing database.
-- schema.sql carries the same columns for a database created from scratch.

-- --- Verdicts: rating instead of boolean -------------------------------------------------------

-- level is the MINIMUM device level that may see this site, 1 (most restricted) .. 5:
--   1  Essential      Torah/education, banking, government, school, utilities
--   2  General        news, reference, business, technology, non-clothing shopping
--   3  Mainstream     ordinary sites showing people: sports, travel, general retail
--   4  Permissive     contains immodest but non-explicit imagery: fashion, entertainment
--   5  Never          explicit, dating, gambling, gore, circumvention tools
--
-- A device at level N resolves every site rated <= N. Level 5 is the sentinel for "no device may
-- see this" — nothing is ever assigned device level 5, so a rating of 5 is a permanent block that
-- still records WHY, rather than a missing row that would be re-judged on every request.
ALTER TABLE url_verdicts ADD COLUMN level INTEGER;

-- Orthogonal to the rating: does this site take you somewhere else?
--
-- A search engine's homepage is a logo and a text box — it rates as harmless on its own content and
-- would sail through any judgement of the page itself. But allowing it allows everything reachable
-- through it, which defeats the entire model. Image search is worse still: the results ARE the
-- content, rendered from the engine's own servers, so the site filter never gets a second turn.
--
-- Doorways are therefore gated by a separate switch per level (see level_definitions), never by the
-- rating alone. Search engines, open user-content platforms and image boards all set this.
ALTER TABLE url_verdicts ADD COLUMN is_doorway INTEGER NOT NULL DEFAULT 0;

-- Backfill the existing boolean rows so nothing is stranded un-rated:
--   clean   -> 2 (General). Deliberately conservative: these were judged by a prompt that had no
--              notion of modesty tiers, so they earn the ordinary tier, not a permissive one.
--   blocked -> 5 (Never).
UPDATE url_verdicts SET level = 2 WHERE level IS NULL AND verdict = 'clean';
UPDATE url_verdicts SET level = 5 WHERE level IS NULL AND verdict = 'blocked';

CREATE INDEX IF NOT EXISTS idx_url_verdicts_level ON url_verdicts (level, scope);

-- --- Devices: which rung, and which resolver ---------------------------------------------------

-- The device's strictness rung. Defaults to 2 (General) — a new phone starts usefully strict, and
-- is loosened deliberately rather than tightened after the fact.
ALTER TABLE devices ADD COLUMN level INTEGER NOT NULL DEFAULT 2;

-- The phone's own Cloudflare Gateway DNS location, and the DoT hostname that location was issued.
--
-- This is the whole trick behind remote strictness changes. DNS-over-TLS carries no identity, so a
-- fleet sharing one resolver hostname can only ever share one policy. Giving each phone its own
-- location makes the hostname itself the identity: the level policies match on location id, so
-- moving a phone between levels is an API call against two policies and never touches the phone.
--
-- Set once at enrolment, then immutable — changing it would mean an adb visit to the handset.
ALTER TABLE devices ADD COLUMN gateway_location_id TEXT;
ALTER TABLE devices ADD COLUMN dns_hostname TEXT;

-- --- Level definitions -------------------------------------------------------------------------

-- One row per rung. Holds the Gateway objects that enforce it, so the Worker can resolve
-- "level 3" to the list it appends approved hostnames to and the policy whose location set decides
-- who is on that rung.
--
-- allow_doorways is the switch described above. Only the most permissive rung sets it; on every
-- other rung a search engine stays blocked no matter how clean its homepage looks.
CREATE TABLE IF NOT EXISTS level_definitions (
  level INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  gateway_list_id TEXT,        -- DOMAIN list holding hostnames rated exactly this level
  gateway_policy_id TEXT,      -- default-deny DNS policy whose location set = devices on this rung
  allow_doorways INTEGER NOT NULL DEFAULT 0,
  allow_categories INTEGER NOT NULL DEFAULT 0  -- permissive rungs filter by category, not allowlist
);

INSERT OR IGNORE INTO level_definitions (level, name, description, allow_doorways, allow_categories) VALUES
  (1, 'Essential',  'Torah and education, banking, government, school and utilities only.', 0, 0),
  (2, 'General',    'Adds news, reference, business, technology and non-clothing shopping.', 0, 0),
  (3, 'Mainstream', 'Adds ordinary sites showing people: sports, travel, general retail.',   0, 0),
  (4, 'Permissive', 'Adds sites with immodest but non-explicit imagery. Search permitted.',  1, 1);
