-- Per-phone overrides — the test bench.
--
-- WHY. Everything that decides what a phone may see is keyed to its RUNG, and a rung is shared by
-- every phone on it. levels.js turns (tag, rung) into a definition (images, appMedia, webMode …),
-- and policy.js turns (tag, rung) into one Headwind configuration. So "turn Spotify's pictures off
-- and see what breaks" could only be asked of a whole rung, on real phones belonging to real
-- people. The one exception was `devices.allow_youtube`, a single hard-coded boolean that swaps
-- yeshiva rung 3 onto a second policy — the right idea, built once, for one app.
--
-- This generalizes it. A row here belongs to ONE device and overrides only the fields it names;
-- every field is nullable and NULL means "use the rung's answer". A phone with no row behaves
-- exactly as before, which is what makes this safe to deploy to a live fleet: the table is empty
-- on arrival and changes nothing until someone writes a row.
--
-- The fields mirror levels.js LEVELS / YESHIVA_LEVELS. They are stored as 0/1 rather than booleans
-- because D1 has no boolean type, and read back through a normalizer that treats anything
-- unrecognised as "no override" — a corrupt row must fall back to the rung, never to "open".
--
-- policy_id is the APP half: name another policy and the scheduler puts this phone on that
-- policy's Headwind configuration instead of its rung's. That is how an app rule (a blocked
-- Netflix, an ad blocker, a new allowlist) is tried on one handset. NOTE: a schedule whose
-- base_policy_id names the phone's ORIGINAL policy stops matching once this is set; the yeshiva
-- shiur windows are written as `tag:yeshiva` and are unaffected, which is the common case.
--
-- note and set_at are for the operator: a test nobody can explain six weeks later is a bug in
-- waiting, and the console shows both so an override is never anonymous.
CREATE TABLE IF NOT EXISTS device_overrides (
  device_id TEXT PRIMARY KEY,
  images INTEGER,        -- 0/1: strip pictures in the browser
  app_media INTEGER,     -- 0/1: may a pinned app (Spotify, Play) show its own pictures
  block_social INTEGER,  -- 0/1: does the L2 social blocklist apply
  streaming INTEGER,     -- 0/1: may this phone reach a video streaming service (src/streaming.js)
  web_mode TEXT,         -- 'none' | 'web' | 'blocklist'
  policy_id TEXT,        -- another policy's Headwind configuration for this phone only
  note TEXT,             -- why this override exists
  set_at INTEGER
);
