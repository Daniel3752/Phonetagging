-- Migration for a database created before hostname scoping existed.
--
-- Pre-existing rows are full-URL verdicts, so they keep scope='url' (the column default) and become
-- dormant: v1 reads only scope='host' rows. They are NOT converted to host scope, because "this
-- exact page was fine" does not imply "this whole site is fine" — re-judging at hostname
-- granularity is the correct, conservative behaviour.
--
-- hostname is backfilled for the old rows anyway, so they remain useful for auditing and for a
-- future path-blocking rollout.
ALTER TABLE url_verdicts ADD COLUMN hostname TEXT;
ALTER TABLE url_verdicts ADD COLUMN scope TEXT NOT NULL DEFAULT 'url';

-- Crude but correct for the http(s) URLs normalizeUrl() admits: strip scheme, then cut at the first
-- '/', ':' or '?'. SQLite has no URL parser and no regex, hence the nesting.
UPDATE url_verdicts
SET hostname = lower(
  substr(
    rtrim(
      substr(
        replace(replace(url, 'https://', ''), 'http://', ''),
        1,
        CASE
          WHEN instr(replace(replace(url, 'https://', ''), 'http://', ''), '/') > 0
          THEN instr(replace(replace(url, 'https://', ''), 'http://', ''), '/') - 1
          ELSE length(replace(replace(url, 'https://', ''), 'http://', ''))
        END
      ),
      '.'
    ),
    1,
    9999
  )
)
WHERE hostname IS NULL;

CREATE INDEX IF NOT EXISTS idx_url_verdicts_scope_hostname ON url_verdicts (scope, hostname);
