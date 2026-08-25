-- Search-query verdicts.
--
-- The proxy architecture makes the full URL visible, which means the words typed into a search box
-- are visible too. That is the check DNS could never make: at DNS the filter sees `www.google.com`
-- and nothing more, so approving Google once approves every search anyone will ever run.
--
-- Keyed on a NORMALISED form of the query (see searchCacheKey in src/search.js): lowercased,
-- punctuation stripped, words sorted. Without that the cache never hits, because nobody types a
-- phrase the same way twice — and worse, anyone gets a fresh unjudged query by adding a comma.
--
-- The rating shares the 1-5 ladder with url_verdicts, so one device level governs both checks and
-- the two cannot drift apart.
CREATE TABLE IF NOT EXISTS search_verdicts (
  query_hash TEXT PRIMARY KEY,   -- sha256 of the normalised cache key
  query_sample TEXT,             -- one representative raw phrasing, for the operator console
  level INTEGER NOT NULL,        -- 1..5, same ladder as url_verdicts
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'gemini',  -- 'gemini' | 'operator'
  decided_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1    -- how often it has been asked; surfaces what is being tried
);

CREATE INDEX IF NOT EXISTS idx_search_verdicts_level ON search_verdicts (level, decided_at DESC);

-- The proxy username Squid authenticates, mapped to the device it belongs to.
--
-- This is how per-person strictness works on the proxy architecture, and it is markedly simpler than
-- the DNS equivalent: DNS-over-TLS carries no identity at all, so telling one phone from another
-- needed a whole Cloudflare DNS location per device. A proxy login is identity on the wire for free.
ALTER TABLE devices ADD COLUMN proxy_user TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_proxy_user ON devices (proxy_user);
