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
  -- The minimum device rung allowed to see this site, 1 (strictest) .. 5, or 6 (NEVER — blocked at
  -- every rung, including the most open one; explicit content). See levels.js and
  -- migrations/0006_five_rungs.sql for what each rung means.
  level INTEGER,
  -- Does this site reach arbitrary other content — a search engine, an image search, an open
  -- user-content platform? Gated separately from the rating, because such a site's own homepage
  -- always looks harmless and allowing it allows everything behind it.
  is_doorway INTEGER NOT NULL DEFAULT 0,
  -- Per-site enforcement mode (see proxy-api.js):
  --   'filtered' (default) — allowed subject to the rung's allowlist/permissive rating test.
  --   'trusted'            — the whole hostname is allowed with no per-request judging (infra, a
  --                          site with no user-reachable objectionable content).
  --   'blocked'            — the whole hostname is denied outright.
  site_mode TEXT NOT NULL DEFAULT 'filtered'
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
  -- Website strictness rung, 1..5 (see levels.js). Defaults to 2 so a new phone starts usefully
  -- strict and is loosened deliberately rather than tightened after the fact.
  level INTEGER NOT NULL DEFAULT 2,
  -- The phone's own Cloudflare Gateway DNS location and the DoT hostname it was issued. DNS-over-
  -- TLS carries no identity, so a fleet sharing one resolver hostname can only share one policy;
  -- a location per phone makes the hostname itself the identity, and a level change becomes an API
  -- call rather than an adb visit. Set once at enrolment, then immutable.
  gateway_location_id TEXT,
  dns_hostname TEXT,
  -- The proxy username Squid authenticates, mapped to this device. Identity on the wire for free —
  -- the DNS architecture needed a Cloudflare location per phone to achieve the same thing.
  proxy_user TEXT,
  -- Its generated password, stored in plain text on purpose. This credential is an identity, not a
  -- key: it buys filtered browsing at this phone's own rung and nothing else, and whoever holds the
  -- phone necessarily learns it because Chrome prompts them for it. What it has to support is being
  -- read back later — after a reset, or when Chrome forgets it — which a hash could not do. Squid's
  -- own /etc/squid/passwd stores the bcrypt hash; this is the operator's copy.
  proxy_password TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_proxy_user ON devices (proxy_user);

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

-- One row per strictness rung. levels.js is the source of truth for the SEMANTICS (its LEVELS
-- array); this table mirrors them and holds any enforcement ids a rung needs. See
-- migrations/0006_five_rungs.sql. web_mode: 'none' | 'allowlist' | 'permissive'. The boolean columns
-- gate the proxy's image and search behaviour and whether the L2 social blocklist applies.
CREATE TABLE IF NOT EXISTS level_definitions (
  level INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  web_mode TEXT NOT NULL DEFAULT 'allowlist',
  images_allowed INTEGER NOT NULL DEFAULT 1,
  text_search INTEGER NOT NULL DEFAULT 1,
  image_search INTEGER NOT NULL DEFAULT 0,
  apply_social_blocklist INTEGER NOT NULL DEFAULT 1,  -- does the L2 social blocklist apply at this rung
  app_policy_id TEXT,          -- the app policy that pairs with this rung (see policy.js)
  gateway_list_id TEXT,        -- optional per-rung allowlist id (DNS-era; unused by the proxy path)
  gateway_policy_id TEXT
);

INSERT OR IGNORE INTO level_definitions
  (level, name, description, web_mode, images_allowed, text_search, image_search, apply_social_blocklist, app_policy_id) VALUES
  (1, 'No browser', 'No web at all. Apps only.',                                       'none', 0, 0, 0, 1, 'apps_rung_1'),
  (2, 'Text-only',  'AI-judged web at the strictest bar, images stripped.',            'web',  0, 1, 0, 1, 'apps_rung_2'),
  (3, 'Essential',  'AI-judged clean web (essential + broad general), images on.',     'web',  1, 1, 1, 1, 'apps_rung_3'),
  (4, 'General',    'AI-judged full clean web: no shtus, no social, no explicit.',     'web',  1, 1, 1, 1, 'apps_rung_4'),
  (5, 'Open',       'Everything except explicit; shtus and social permitted.',         'web',  1, 1, 1, 0, 'apps_rung_5');

-- Five app policies, one per rung (empty until the app-control discussion — see BUILD-PLAN.md §7).
INSERT OR IGNORE INTO policies (id, name, headwind_configuration_id, created_at) VALUES
  ('apps_rung_1', 'Apps — Rung 1 (No browser)', NULL, 0),
  ('apps_rung_2', 'Apps — Rung 2 (Text-only)',  NULL, 0),
  ('apps_rung_3', 'Apps — Rung 3 (Essential)',  NULL, 0),
  ('apps_rung_4', 'Apps — Rung 4 (General)',    NULL, 0),
  ('apps_rung_5', 'Apps — Rung 5 (Open)',       NULL, 0);

-- Keyword pre-filter rules for search queries. RATING is on the same 1..6 ladder (6 = NEVER). The
-- proxy consults this before the model; a match short-circuits with no model call. Intentionally
-- empty at first — the term lists are populated later (see BUILD-PLAN.md §0).
CREATE TABLE IF NOT EXISTS keyword_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'search',   -- 'search' (only scope used today)
  lang TEXT NOT NULL DEFAULT 'en',        -- 'en' | 'he' | 'yi'
  pattern TEXT NOT NULL,                  -- one or more words; all must appear in the query
  rating INTEGER NOT NULL,                -- 1..6 on the shared ladder
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_keyword_rules_scope ON keyword_rules (scope);

-- Per-app image-host blocklist: hosts whose IMAGE requests are denied for a named app, so an app can
-- keep working with its pictures stripped (see BUILD-PLAN.md §8). Enforced by the proxy; only
-- effective where the app's traffic is proxied and not certificate-pinned. Populated/tested after
-- device enrolment.
CREATE TABLE IF NOT EXISTS app_image_blocklist (
  package_name TEXT NOT NULL,
  image_host TEXT NOT NULL,
  note TEXT,
  PRIMARY KEY (package_name, image_host)
);

CREATE INDEX IF NOT EXISTS idx_url_verdicts_level ON url_verdicts (level, scope);

-- Search-query verdicts. See migrations/0004_search_verdicts.sql for why the key is normalised.
CREATE TABLE IF NOT EXISTS search_verdicts (
  query_hash TEXT PRIMARY KEY,
  query_sample TEXT,
  level INTEGER NOT NULL,
  -- 0 = the query's TEXT answer is fine but its IMAGE results could be shtus, so the proxy shows the
  -- text results with images stripped. 1 = images fine. See gemini.js and proxy-api.js.
  images_ok INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'gemini',
  decided_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1
);

-- The background pre-classifier's worklist: common domains to judge ahead of anyone visiting, so the
-- inline path stays a rare fallback. A cron walks a small batch per tick (free-tier paced). See
-- src/scheduler.js. status: 'pending' | 'done' | 'error'.
CREATE TABLE IF NOT EXISTS classify_queue (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  done_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_classify_queue_status ON classify_queue (status, attempts);

CREATE INDEX IF NOT EXISTS idx_search_verdicts_level ON search_verdicts (level, decided_at DESC);
