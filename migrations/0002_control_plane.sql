-- Adds the control-plane tables to a database that already has url_verdicts.
-- Identical to the corresponding section of schema.sql; every statement is IF NOT EXISTS, so this
-- is safe to re-run and safe to apply to a fresh database too.
-- Control plane: devices, the policies applied to them, and the schedules that swap those
-- policies by time of day. The worker owns this state; Headwind is the thing that enforces it.
-- ---------------------------------------------------------------------------------------------

-- A named set of app rules. Maps 1:1 onto a Headwind "configuration", which is the unit Headwind
-- actually applies to a device — headwind_configuration_id is that mapping.
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  headwind_configuration_id TEXT,
  created_at INTEGER NOT NULL
);

-- Per-policy app control. 'allowed' apps may be installed and used; 'blocked' apps are removed or
-- prevented from installing; 'hidden' apps stay installed but are concealed from the launcher —
-- which is how apps the phone shipped with get disabled without uninstalling them.
CREATE TABLE IF NOT EXISTS app_rules (
  policy_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  state TEXT NOT NULL,  -- 'allowed' | 'blocked' | 'hidden'
  PRIMARY KEY (policy_id, package_name)
);

-- An enrolled phone. timezone matters: schedules are expressed in the phone's local time, so a
-- fleet spread across zones still gets "blocked after 10pm" meaning the family's 10pm.
--
-- last_applied_policy_id is what the scheduler last successfully pushed to Headwind. It is the
-- device's known state, and is what makes the scheduler idempotent — a run that computes the same
-- policy pushes nothing.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  headwind_device_id TEXT,
  label TEXT NOT NULL,
  policy_id TEXT NOT NULL,             -- the baseline policy, in force outside any schedule window
  timezone TEXT NOT NULL DEFAULT 'UTC',
  last_applied_policy_id TEXT,
  last_seen_at INTEGER,
  enrolled_at INTEGER NOT NULL
);

-- A recurring time window that swaps in a different policy. device_id NULL means the schedule
-- applies to every device whose baseline policy is base_policy_id, so a rule can be written once
-- for the whole fleet and overridden per device.
--
-- day_mask is a 7-bit field, bit 0 = Sunday through bit 6 = Saturday, matched against the day the
-- window STARTS. start_min/end_min are minutes from local midnight; end <= start means the window
-- wraps past midnight (e.g. 22:00–06:00). Highest priority wins when windows overlap.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  base_policy_id TEXT NOT NULL,
  active_policy_id TEXT NOT NULL,
  day_mask INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_lookup ON schedules (base_policy_id, device_id);

-- Every operator action and every automated policy flip. Non-negotiable for a system that reaches
-- into other families' phones: if a phone's apps changed, this says what changed it and when.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,   -- 'operator' | 'scheduler'
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);
