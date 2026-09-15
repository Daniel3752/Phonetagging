-- Per-phone shiur lock switch. 1 (default) = the shiur windows and the fleet toggle apply to this
-- phone; 0 = exempt from both. Apply once (ALTER is not re-runnable). See policy.js.
ALTER TABLE devices ADD COLUMN shiur_lock INTEGER NOT NULL DEFAULT 1;
