-- Five rungs. Redefines the level ladder from the old monotonic allowlist (device levels 1..4,
-- NEVER = 5) to five MODE-based rungs (1..5, NEVER = 6). See levels.js and BUILD-PLAN.md.
--
-- NOT re-runnable — SQLite has no "ADD COLUMN IF NOT EXISTS". Apply exactly once to an existing
-- database. schema.sql carries the same shape for a database created from scratch.

-- --- url_verdicts: per-site mode, and the NEVER rating moves 5 -> 6 -----------------------------

ALTER TABLE url_verdicts ADD COLUMN site_mode TEXT NOT NULL DEFAULT 'filtered';

-- The old ladder's 5 meant "Never" (explicit, blocked everywhere). The new ladder has a real device
-- rung 5, so that meaning moves up to 6. A stored 5 that was "explicit" must become 6 or it would
-- suddenly be visible at the new, permissive rung 5.
UPDATE url_verdicts SET level = 6 WHERE level = 5;
UPDATE search_verdicts SET level = 6 WHERE level = 5;

-- --- level_definitions: add the mode columns, rewrite the five rungs -----------------------------

ALTER TABLE level_definitions ADD COLUMN web_mode TEXT NOT NULL DEFAULT 'allowlist';
ALTER TABLE level_definitions ADD COLUMN images_allowed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE level_definitions ADD COLUMN text_search INTEGER NOT NULL DEFAULT 1;
ALTER TABLE level_definitions ADD COLUMN image_search INTEGER NOT NULL DEFAULT 0;
ALTER TABLE level_definitions ADD COLUMN apply_social_blocklist INTEGER NOT NULL DEFAULT 1;

UPDATE level_definitions SET
  name = 'No browser', description = 'No web at all. Apps only.',
  web_mode = 'none', images_allowed = 0, text_search = 0, image_search = 0, apply_social_blocklist = 1
  WHERE level = 1;
UPDATE level_definitions SET
  name = 'Text-only', description = 'Essential allowlist, images stripped, text search only.',
  web_mode = 'allowlist', images_allowed = 0, text_search = 1, image_search = 0, apply_social_blocklist = 1
  WHERE level = 2;
UPDATE level_definitions SET
  name = 'Essential', description = 'Essential allowlist, images and filtered image search.',
  web_mode = 'allowlist', images_allowed = 1, text_search = 1, image_search = 1, apply_social_blocklist = 1
  WHERE level = 3;
UPDATE level_definitions SET
  name = 'General', description = 'Everything except social media and explicit; searches filtered.',
  web_mode = 'permissive', images_allowed = 1, text_search = 1, image_search = 1, apply_social_blocklist = 1
  WHERE level = 4;

INSERT OR IGNORE INTO level_definitions
  (level, name, description, web_mode, images_allowed, text_search, image_search, apply_social_blocklist) VALUES
  (5, 'Open', 'Everything except explicit; searches filtered for explicit only.', 'permissive', 1, 1, 1, 0);

-- --- keyword pre-filter + per-app image blocklist (both start empty) -----------------------------

CREATE TABLE IF NOT EXISTS keyword_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'search',
  lang TEXT NOT NULL DEFAULT 'en',
  pattern TEXT NOT NULL,
  rating INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_keyword_rules_scope ON keyword_rules (scope);

CREATE TABLE IF NOT EXISTS app_image_blocklist (
  package_name TEXT NOT NULL,
  image_host TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (package_name, image_host)
);
