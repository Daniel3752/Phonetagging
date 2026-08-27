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
