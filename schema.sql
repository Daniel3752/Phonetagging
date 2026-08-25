-- Verdict cache. One row per decided target, reused forever for every managed phone — Gemini cost
-- is per new site, not per visit.
--
-- scope distinguishes the two granularities the system supports:
--   'host' — a bare hostname (example.com). This is what v1 enforces: Cloudflare Gateway DNS
--            filtering matches hostnames, needs no certificate and no TLS decryption.
--   'url'  — a full URL including path. Dormant in v1; these rows are what a future TLS-decrypting
--            HTTP policy would read. Kept so enabling path blocking later is a config change
--            rather than a schema migration. See the plan's "Forward-compatibility" section.
--
-- verdict is 'clean' (allowed, and also written to the Gateway list) or 'blocked'.
-- source is 'gemini' (auto) or 'operator' (manually allowed/revoked).
CREATE TABLE IF NOT EXISTS url_verdicts (
  url_hash TEXT PRIMARY KEY,   -- sha256 of the cache key: the hostname when scope='host', the full URL when scope='url'
  url TEXT NOT NULL,           -- the full URL as submitted, retained even for host-scope rows (audit + future path blocking)
  hostname TEXT,               -- the bare hostname; the value written to the Gateway domain list
  scope TEXT NOT NULL DEFAULT 'url',  -- 'host' | 'url'
  verdict TEXT NOT NULL,       -- 'clean' | 'blocked'
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'gemini', -- 'gemini' | 'operator'
  decided_at INTEGER NOT NULL,
  -- The minimum device level allowed to see this site, 1 (strictest) .. 5 (never). See levels.js
  -- and migrations/0003_levels.sql for what each rung means.
  level INTEGER,
  -- Does this site reach arbitrary other content — a search engine, an image search, an open
  -- user-content platform? Gated separately from the rating, because such a site's own homepage
  -- always looks harmless and allowing it allows everything behind it.
  is_doorway INTEGER NOT NULL DEFAULT 0
);

-- Lookups are always (scope, hostname) on the hot path.
CREATE INDEX IF NOT EXISTS idx_url_verdicts_scope_hostname ON url_verdicts (scope, hostname);

-- ---------------------------------------------------------------------------------------------
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
  enrolled_at INTEGER NOT NULL,
  -- Website strictness rung, 1..4. Defaults to 2 so a new phone starts usefully strict and is
  -- loosened deliberately rather than tightened after the fact.
  level INTEGER NOT NULL DEFAULT 2,
  -- The phone's own Cloudflare Gateway DNS location and the DoT hostname it was issued. DNS-over-
  -- TLS carries no identity, so a fleet sharing one resolver hostname can only share one policy;
  -- a location per phone makes the hostname itself the identity, and a level change becomes an API
  -- call rather than an adb visit. Set once at enrolment, then immutable.
  gateway_location_id TEXT,
  dns_hostname TEXT
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

-- One row per strictness rung, holding the Gateway objects that enforce it. See levels.js for the
-- semantics and migrations/0003_levels.sql for the rung descriptions.
CREATE TABLE IF NOT EXISTS level_definitions (
  level INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  gateway_list_id TEXT,        -- DOMAIN list holding hostnames rated exactly this level
  gateway_policy_id TEXT,      -- default-deny DNS policy whose location set = devices on this rung
  allow_doorways INTEGER NOT NULL DEFAULT 0,
  allow_categories INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO level_definitions (level, name, description, allow_doorways, allow_categories) VALUES
  (1, 'Essential',  'Torah and education, banking, government, school and utilities only.', 0, 0),
  (2, 'General',    'Adds news, reference, business, technology and non-clothing shopping.', 0, 0),
  (3, 'Mainstream', 'Adds ordinary sites showing people: sports, travel, general retail.',   0, 0),
  (4, 'Permissive', 'Adds sites with immodest but non-explicit imagery. Search permitted.',  1, 1);

CREATE INDEX IF NOT EXISTS idx_url_verdicts_level ON url_verdicts (level, scope);
