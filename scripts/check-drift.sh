#!/usr/bin/env bash
#
# Is the server running what the repo says it runs?
#
# Compares each installed file against its copy in a repo clone and names the ones that differ.
# This exists because it happened: squid.conf and the helper were changed on the server by hand and
# by two sessions on two branches, the repo's copy drifted so far that install-squid.sh would have
# wiped the live setup, and nobody noticed for days. Run daily from cron (see below) and the day a
# file drifts, the log says so.
#
# Exit 0 = everything matches. Exit 1 = drift, listed on stdout. Fix drift by committing the live
# file to the repo (if the server is right) or reinstalling from the repo (if the repo is right) —
# never by leaving them different.
#
# Install (assumes the clone is /opt/Phonetagging on the branch that is deployed):
#   install -m 755 scripts/check-drift.sh /usr/local/bin/shmira-check-drift.sh
#   echo '30 6 * * * root /usr/local/bin/shmira-check-drift.sh >> /var/log/shmira-drift.log 2>&1' \
#     > /etc/cron.d/shmira-drift && chmod 644 /etc/cron.d/shmira-drift
set -u

REPO=${SHMIRA_REPO:-/opt/Phonetagging}
[[ -d "$REPO/scripts" ]] || { echo "no repo clone at $REPO (set SHMIRA_REPO)"; exit 2; }

# installed path : repo path
PAIRS=(
  "/etc/squid/squid.conf:scripts/squid.conf"
  "/usr/local/bin/squid-acl-helper.py:scripts/squid-acl-helper.py"
  "/usr/local/bin/sync-blocklists.sh:scripts/sync-blocklists.sh"
  "/usr/local/bin/shmira-health-check.sh:scripts/health-check.sh"
  "/usr/local/bin/shmira-check-drift.sh:scripts/check-drift.sh"
)

drift=0
for pair in "${PAIRS[@]}"; do
  live=${pair%%:*}; src=$REPO/${pair#*:}
  [[ -f "$live" ]] || continue               # not installed here — nothing to compare
  [[ -f "$src" ]]  || { echo "DRIFT  $live  (no repo copy at $src)"; drift=1; continue; }
  if ! cmp -s "$live" "$src"; then
    echo "DRIFT  $live  differs from  $src"
    diff -u "$src" "$live" | head -40 | sed 's/^/    /'
    drift=1
  fi
done

branch=$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')
if (( drift )); then
  echo "$(date -u +%FT%TZ)  drift against $REPO ($branch) — see above"
  exit 1
fi
echo "$(date -u +%FT%TZ)  ok: server matches $REPO ($branch)"
