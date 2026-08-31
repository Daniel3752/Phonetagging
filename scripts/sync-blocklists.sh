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
REPO="${SHMIRA_BLOCKLIST_REPO:-Daniel3752/shmiras-blocklists}"
BRANCH="${SHMIRA_BLOCKLIST_BRANCH:-main}"
BASE="${SHMIRA_BLOCKLIST_BASE:-https://raw.githubusercontent.com/$REPO/$BRANCH/blocklists}"

# The blocklist repo is private, and raw.githubusercontent.com answers 404 — not 401 — for a private
# path with no credentials. That looks exactly like a wrong URL, which is how this failed silently:
# the sync appeared to run, nothing was written, and the explicit list simply never fired.
#
# With a token, fetch through the API's contents endpoint instead, which is the documented way to
# read a private file. Without one, fall back to the raw URL so a public repo still works unchanged.
#   echo 'SHMIRA_BLOCKLIST_TOKEN=ghp_...' >> /etc/squid/filter.env
# A fine-grained token needs only Contents: read on that one repository.
TOKEN="${SHMIRA_BLOCKLIST_TOKEN:-}"

fetch_list() {
  local name="$1" dest="$2"
  if [[ -n "$TOKEN" ]]; then
    curl -fsS --max-time 90 \
      -H "Authorization: Bearer $TOKEN" \
      -H "Accept: application/vnd.github.raw" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "https://api.github.com/repos/$REPO/contents/blocklists/$name.json?ref=$BRANCH" -o "$dest"
  else
    curl -fsS --max-time 90 "$BASE/$name.json" -o "$dest"
  fi
}

mkdir -p "$DIR"
chmod 0755 "$DIR"

for name in level1 level2; do
  tmp="$(mktemp)"
  if fetch_list "$name" "$tmp"; then
    if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$tmp" 2>/dev/null; then
      mv "$tmp" "$DIR/$name.json"
      # mktemp creates 0600 root-owned files and mv preserves that. Squid's ACL helper runs as the
      # unprivileged proxy user, so a 0600 list is unreadable to the only thing that reads it — and
      # the helper treats an unreadable file exactly like a missing one, keeping an empty set. The
      # sync then reports success while the explicit blocklist silently never fires.
      chmod 0644 "$DIR/$name.json"
      echo "$(date -u +%FT%TZ) updated $name.json ($(wc -c < "$DIR/$name.json") bytes)"
    else
      echo "$(date -u +%FT%TZ) WARN $name.json was not valid JSON — keeping existing" >&2
      rm -f "$tmp"
    fi
  else
    echo "$(date -u +%FT%TZ) WARN fetch failed for $name.json — keeping existing" >&2
    if [[ -z "$TOKEN" ]]; then
      echo "$(date -u +%FT%TZ) HINT the repo is private; set SHMIRA_BLOCKLIST_TOKEN in /etc/squid/filter.env" >&2
    fi
    rm -f "$tmp"
  fi
done

# Flatten level1 into a plain domain list for squid's l1_hosts ssl::server_name ACL: on the
# splice-by-default tunnel path, known-explicit hosts are BUMPED so a visit gets the block page
# instead of a bare connection error. Leading dot = the domain and every subdomain. The file must
# always exist (squid refuses to start on a missing ACL file), and squid only rereads file ACLs on
# reconfigure, so nudge it when the content changed.
DOMAINS="$DIR/level1.domains"
if [[ -f "$DIR/level1.json" ]]; then
  tmp="$(mktemp)"
  python3 - "$DIR/level1.json" > "$tmp" <<'PY'
import json, sys
def walk(o):
    if isinstance(o, dict):
        for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
    elif isinstance(o, str) and o.strip():
        yield o.strip().lower().rstrip('.')
for d in sorted(set(walk(json.load(open(sys.argv[1]))))):
    print('.' + d)
PY
  if [[ -s "$tmp" ]] && ! cmp -s "$tmp" "$DOMAINS" 2>/dev/null; then
    mv "$tmp" "$DOMAINS"
    chmod 0644 "$DOMAINS"
    squid -k reconfigure 2>/dev/null || true
    echo "$(date -u +%FT%TZ) updated level1.domains ($(wc -l < "$DOMAINS") domains), squid reconfigured"
  else
    rm -f "$tmp"
  fi
fi
touch "$DOMAINS"; chmod 0644 "$DOMAINS"
