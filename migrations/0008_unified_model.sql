-- The unified rating-gate model: every web rung AI-judges sites and searches and allows them only if
-- rated at or below the rung. Replaces the allowlist/permissive split. See levels.js, proxy-api.js,
-- classify.js and BUILD-PLAN.md. Apply once (the ALTERs are not re-runnable).

-- Rungs 2-5 all become plain 'web' (the mode difference is gone; the rating bar is the difference).
UPDATE level_definitions SET web_mode = 'web' WHERE level BETWEEN 2 AND 5;
UPDATE level_definitions SET
  name = 'Text-only', description = 'AI-judged web at the strictest bar, images stripped.' WHERE level = 2;
UPDATE level_definitions SET
  name = 'Essential', description = 'AI-judged clean web (essential + broad general), images on.' WHERE level = 3;
UPDATE level_definitions SET
  name = 'General', description = 'AI-judged full clean web: no shtus, no social, no explicit.' WHERE level = 4;
UPDATE level_definitions SET
  name = 'Open', description = 'Everything except explicit; shtus and social permitted.' WHERE level = 5;

-- Search verdicts gain the images_ok flag (text answer fine, image results shtus → strip images).
ALTER TABLE search_verdicts ADD COLUMN images_ok INTEGER NOT NULL DEFAULT 1;

-- The old ladder rated immodest sites 4 and never-4 was the top; the new rubric rates immodest 5 and
-- NEVER 6. Existing AI rows on the OLD scale can't be perfectly remapped, so re-judging is correct —
-- but nothing here forces it: seeded operator rows (levels 1-2, now meaning essential) are already
-- right, and the handful of old gemini rows will be re-rated the next time they're hit. No data
-- change needed; this comment records the reasoning.

-- The background pre-classifier's worklist.
CREATE TABLE IF NOT EXISTS classify_queue (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_classify_queue_status ON classify_queue (status, attempts);
