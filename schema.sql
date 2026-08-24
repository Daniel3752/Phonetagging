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
  decided_at INTEGER NOT NULL
);

-- Lookups are always (scope, hostname) on the hot path.
CREATE INDEX IF NOT EXISTS idx_url_verdicts_scope_hostname ON url_verdicts (scope, hostname);
