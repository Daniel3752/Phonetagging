#!/usr/bin/env bash
#
# Pulls the explicit (level1) and social (level2) blocklists from the shmiras-blocklists repo into
# the directory the Squid ACL helper reads. The helper notices the changed file within its reload
# interval, so a fresh sync takes effect without a restart.
#
# Run daily from cron (install-squid.sh sets this up):
#   17 3 * * *  /usr/local/bin/sync-blocklists.sh >> /var/log/shmira-blocklists.log 2>&1
# 03:17 is deliberately after the repo's own 02:00 UTC rebuild, so a sync gets that day's additions.
#
# Fails SAFE: a failed download or a malformed file leaves the previously synced list in place rather
# than blanking the blocklist. An empty/missing list simply means that tier does not fire.
set -euo pipefail

DIR="${SHMIRA_BLOCKLIST_DIR:-/etc/squid/blocklists}"
BASE="${SHMIRA_BLOCKLIST_BASE:-https://raw.githubusercontent.com/Daniel3752/shmiras-blocklists/main/blocklists}"

mkdir -p "$DIR"

for name in level1 level2; do
  tmp="$(mktemp)"
  if curl -fsS --max-time 90 "$BASE/$name.json" -o "$tmp"; then
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$tmp" 2>/dev/null; then
      mv "$tmp" "$DIR/$name.json"
      echo "$(date -u +%FT%TZ) updated $name.json ($(wc -c < "$DIR/$name.json") bytes)"
    else
      echo "$(date -u +%FT%TZ) WARN $name.json was not valid JSON — keeping existing" >&2
      rm -f "$tmp"
    fi
  else
    echo "$(date -u +%FT%TZ) WARN fetch failed for $name.json — keeping existing" >&2
    rm -f "$tmp"
  fi
done
