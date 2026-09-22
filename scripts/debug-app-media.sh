#!/usr/bin/env bash
#
# Watches what squid does with a pinned app's media hosts for a short while, then says which hosts
# were terminated, which were spliced, and which unknown hosts on the app's domains got through —
# the census NEXT-SESSION.md asks for, made runnable. Privacy: it logs ONLY handshakes to the
# listed app domains (Spotify, Google Play's picture host), for the given number of seconds, and
# deletes the log when it is done. The access log proper stays off.
#
# Usage:  sudo scripts/debug-app-media.sh [seconds] [phone-tunnel-ip]
#         sudo scripts/debug-app-media.sh 120 10.66.0.3
#
# While it runs, on the phone: force-stop Spotify, clear its storage, open it, wait for the home
# page, open a playlist, play a song. Then read the census it prints:
#   terminate  = squid closed the handshake: the picture never arrived (what we want on rungs 1-3)
#   splice     = squid passed the connection through untouched
#   bump       = squid decrypted it (an app rejects the certificate: the request failed)
# Any host on scdn.co / spotifycdn.com / spotify.com that shows as "splice" but carries pictures
# is a host the app_media_hosts regex (scripts/squid.conf, src/app-media.js) does not know yet.
set -euo pipefail

CONF=${SQUID_CONF:-/etc/squid/squid.conf}
LOG=/var/log/squid/app-media-debug.log
MARK='# shmira-debug-app-media'
SECS=${1:-90}
PHONE=${2:-}

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
[[ "$SECS" =~ ^[0-9]+$ ]] || { echo "seconds must be a number" >&2; exit 1; }
grep -qE '^access_log ' "$CONF" || { echo "no 'access_log' line in $CONF to anchor on" >&2; exit 1; }

cleanup() {
  sed -i "/$MARK\$/d" "$CONF"
  squid -f "$CONF" -k reconfigure 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

# Remove a previous run's lines first (a killed run may have left them), then splice ours in BEFORE
# the FIRST access_log line — whatever it targets. The sandbox had `access_log none` (all logging
# off); the live box logs to a file. Either way our debug log has a restrictive host ACL, so only
# handshakes to the app media domains land in it; the box's normal logging is left as it is.
sed -i "/$MARK\$/d" "$CONF"
src_acl=''
[[ -n "$PHONE" ]] && src_acl=" shmira_debug_phone"

# Build the block in shell (single quotes keep the regex backslashes literal) and splice it with
# awk via the environment, so no sed/regex layer mangles the escapes. %ts (epoch seconds), not
# %tl: %tl is "date time zone", two tokens, and the census reads the log by field number.
block=''
[[ -n "$PHONE" ]] && block+="acl shmira_debug_phone src $PHONE $MARK"$'\n'
block+="logformat shmira_media %ts %>a %ssl::>sni %ssl::bump_mode %Ss/%03>Hs %<st %rm %ru $MARK"$'\n'
block+='acl shmira_debug_hosts ssl::server_name_regex -i (^|\.)(scdn\.co|spotifycdn\.com|spotify\.com|pscdn\.co|akamaized\.net)$|^play-lh\.googleusercontent\.com$ '"$MARK"$'\n'
block+="access_log $LOG shmira_media shmira_debug_hosts$src_acl $MARK"
SHMIRA_BLOCK="$block" awk '
  /^access_log / && !spliced { print ENVIRON["SHMIRA_BLOCK"]; spliced=1 }
  { print }
' "$CONF" > "$CONF.shmira-tmp" && cat "$CONF.shmira-tmp" > "$CONF" && rm -f "$CONF.shmira-tmp"

if ! squid -f "$CONF" -k parse >/dev/null 2>&1; then
  echo "!! $CONF does not parse with the debug lines; removing them:" >&2
  squid -f "$CONF" -k parse 2>&1 | grep -i -A2 'fatal\|error' | head -20 >&2 || true
  exit 1
fi
: > "$LOG"; chown proxy:proxy "$LOG" 2>/dev/null || true
squid -f "$CONF" -k reconfigure
echo "Logging handshakes to the app media domains for ${SECS}s${PHONE:+ from $PHONE} ..."
echo "  (phone: force-stop Spotify, clear its storage, open it, open a playlist, play a song)"
sleep "$SECS"

echo
echo "=== census: count  bytes  sni  action  status  (from $LOG)"
awk '{ n[$3" "$4" "$5]++; b[$3" "$4" "$5]+=$6 } END { for (k in n) printf "%6d %10d  %s\n", n[k], b[k], k }' "$LOG" \
  | sort -k3,3 -k1,1nr
echo
echo "=== hosts on the app domains that were SPLICED (passed through). If pictures showed on the"
echo "    phone, they came over one of these — an image host the regex does not match, or a"
echo "    connection to an allowed host (audio-*, heads-*) that the app reused for pictures:"
awk '$4 == "splice" { print $3 }' "$LOG" | sort | uniq -c | sort -rn
echo
echo "=== hosts TERMINATED (pictures refused):"
awk '$4 == "terminate" { print $3 }' "$LOG" | sort | uniq -c | sort -rn
echo
echo "=== anything BUMPED or refused with a 409 (a host the app needs that got decrypted or"
echo "    failed the DNS check — an app breaks on these):"
awk '$4 == "bump" || $5 ~ /\/409/ { print $3, $4, $5 }' "$LOG" | sort | uniq -c | sort -rn
echo
echo "Done. The debug lines are removed from squid.conf and the log is deleted."
