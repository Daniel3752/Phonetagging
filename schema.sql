-- URL verdict cache. One row per URL, decided once and reused forever for every managed phone —
-- Gemini cost is per new site, not per visit. verdict is 'clean' (allowed, also written to the
-- Gateway allowlist) or 'blocked'. source is 'gemini' (auto) or 'operator' (manually allowed).
CREATE TABLE IF NOT EXISTS url_verdicts (
  url_hash TEXT PRIMARY KEY,   -- sha256 of the normalized URL
  url TEXT NOT NULL,
  verdict TEXT NOT NULL,       -- 'clean' | 'blocked'
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'gemini', -- 'gemini' | 'operator'
  decided_at INTEGER NOT NULL
);

-- Per-IP fixed-window counter for POST /api/verdict. The endpoint is reachable from the whole
-- internet (the phones need it) and each miss costs a Gemini call plus a Gateway list write, so it
-- is capped. The worker fails OPEN if this table is missing, so filtering never depends on it.
CREATE TABLE IF NOT EXISTS verdict_rate_limit (
  ip TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, window_start)
);
