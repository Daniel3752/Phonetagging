#!/usr/bin/env bash
# One-shot diagnostic for "search denied through the tunnel while the Worker allows it".
# Turns the access log on (with full query strings), waits for one live denial from the phone,
# replays the exact denied URL through the helper (as root and as the proxy user), shows the
# relevant cache.log lines (helper crashes land there), then reverts everything.
#
# Usage: sudo bash scripts/debug-search.sh
set -u
CONF=/etc/squid/squid.conf
LOG=/var/log/squid/access.log

cp "$CONF" "$CONF.debugbak"
sed -i 's|^access_log none|access_log /var/log/squid/access.log\nstrip_query_terms off|' "$CONF"
systemctl reload squid
echo ">>> On the phone: search 'volcanoes' in Chrome until you hit the block page. Then press Enter here."
read -r

DENIED=$(grep -a TCP_DENIED "$LOG" | grep -ao 'GET [^ ]*' | awk '{print $2}' | tail -1)
echo
echo "=== Denied URL captured from the live log:"
echo "${DENIED:-<none captured - did the block page appear?>}"

if [[ -n "${DENIED:-}" ]]; then
  set -a; source /etc/squid/filter.env; set +a
  echo
  echo "=== Helper replay as root (same URL, same identity 10.66.0.3):"
  printf '0 - 10.66.0.3 %s\n' "$DENIED" | timeout 30 /usr/local/bin/squid-acl-helper.py
  echo
  echo "=== Helper replay as the proxy user (how squid actually runs it):"
  printf '0 - 10.66.0.3 %s\n' "$DENIED" | timeout 30 sudo -u proxy env \
    SHMIRA_WORKER_URL="$SHMIRA_WORKER_URL" SHMIRA_PROXY_KEY="$SHMIRA_PROXY_KEY" \
    /usr/local/bin/squid-acl-helper.py
fi

echo
echo "=== Last 20 access.log lines:"
tail -20 "$LOG"
echo
echo "=== cache.log lines mentioning the helper or errors (crashes show here):"
grep -aE "helper|Traceback|Error|WARNING" /var/log/squid/cache.log | tail -20

mv "$CONF.debugbak" "$CONF"
systemctl reload squid
rm -f "$LOG"
echo
echo "=== Log turned back off, config reverted. Paste ALL of the above output."
