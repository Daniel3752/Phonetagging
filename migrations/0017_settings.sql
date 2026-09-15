-- Operator-wide switches, starting with the shiur lock toggle (/admin → Yeshiva): shiur_lock_mode
-- is 'schedule' (the timetable decides, the default when the row is absent), 'off' (ignore the
-- shiur windows) or 'on' (lock every yeshiva phone now). See src/policy.js SHIUR_MODES.
-- Re-runnable.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
