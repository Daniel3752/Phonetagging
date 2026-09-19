#!/usr/bin/env bash
#
# Applies the yeshiva-tag changes to a LIVE /etc/squid/squid.conf in place, and installs the
# matching helper. For a server whose squid.conf carries hand edits that must survive (the scoped
# test_phones rule, the access log) — install-squid.sh would overwrite those. Idempotent: run it
# twice and the second run changes nothing.
#
# The edits (see scripts/squid.conf for the reasoning next to each):
#   1. external_acl_type format gains %>ha{Sec-Fetch-Dest}   (images with no file extension)
#   2. deny_info URL gains &why=%o                             (the block page learns "locked")
#   3. http_port 3128 gains name=browser                       (the browser's own door)
#   4. acl browser_port myportname browser + ssl_bump bump browser_port (decrypt only that door)
#   5. the google_system_hosts pre-filter allow excludes the browser port (else Chrome's requests
#      to www.gstatic.com / lh3.googleusercontent.com skip the filter and images leak)
#   6. acl app_media_hosts (a ROLE regex) + acl app_media_exempt + `ssl_bump terminate app_media_hosts
#      wg_phones !app_media_exempt` right after the browser-port bump: in-app pictures (Spotify
#      artwork and Canvas, Play Store icons) are closed outright, by name, without asking the helper.
#      An earlier version asked the helper here and squid spliced hosts the helper had refused.
#
# Usage:  sudo scripts/apply-yeshiva-squid.sh            (from a clone on the deployed branch)
#         SQUID_CONF=/tmp/x.conf scripts/apply-yeshiva-squid.sh --dry-run
set -euo pipefail

CONF=${SQUID_CONF:-/etc/squid/squid.conf}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1

[[ -f "$CONF" ]] || { echo "no $CONF" >&2; exit 1; }
if (( ! DRY )) && [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi

work="$(mktemp)"; cp "$CONF" "$work"
changed=0
note() { echo "  $1"; }

# 1. helper format
if grep -qE '^\s*%un %SRC %URI \\$' "$work"; then
  sed -i -E 's/^(\s*)%un %SRC %URI \\$/\1%un %SRC %URI %>ha{Sec-Fetch-Dest} \\/' "$work"; changed=1
  note "1. helper format: added %>ha{Sec-Fetch-Dest}"
elif grep -q 'Sec-Fetch-Dest' "$work"; then note "1. helper format: already has Sec-Fetch-Dest"
else echo "!! 1. could not find the '%un %SRC %URI \\' line — is the %LOGIN fix applied? Not touching it." >&2; fi

# 2. deny_info why
if grep -qE '^deny_info https://[^ ]*/blocked\?url=%s filter_allows' "$work"; then
  sed -i -E 's#^(deny_info https://[^ ]*/blocked\?url=%s) filter_allows#\1\&why=%o filter_allows#' "$work"; changed=1
  note "2. deny_info: added &why=%o"
elif grep -q 'why=%o' "$work"; then note "2. deny_info: already has why=%o"
else echo "!! 2. could not find the deny_info line. Not touching it." >&2; fi

# 3. name the browser port
if grep -qE '^http_port 3128 ssl-bump' "$work"; then
  sed -i -E 's/^http_port 3128 ssl-bump/http_port 3128 name=browser ssl-bump/' "$work"; changed=1
  note "3. http_port 3128: named 'browser'"
elif grep -qE '^http_port 3128 name=browser' "$work"; then note "3. http_port 3128: already named"
else echo "!! 3. could not find 'http_port 3128 ssl-bump'. Not touching it." >&2; fi

# 4. the acl + the bump rule. The acl goes right before `acl google_system_hosts` — it must be
#    declared before the http_access line that excludes it (step 5) and before the ssl_bump
#    block. An acl already present lower down (an earlier run of this script) is moved up.
if grep -q '^acl google_system_hosts dstdomain' "$work"; then
  if ! grep -B1 '^acl google_system_hosts dstdomain' "$work" | grep -q '^acl browser_port myportname browser$'; then
    sed -i '/^acl browser_port myportname browser$/d; /^acl google_system_hosts dstdomain/i acl browser_port myportname browser' "$work"; changed=1
    note "4a. placed acl browser_port before google_system_hosts"
  else note "4a. acl browser_port already in place"; fi
else echo "!! 4a. no 'acl google_system_hosts' line to anchor on. Not touching it." >&2; fi
#    The rule goes straight after the peek, ahead of EVERY splice (splice.txt included — Chrome
#    trusts the certificate, and Google serves thumbnails from a splice.txt host). A rule already
#    present lower down (an earlier run of this script) is moved up.
if grep -q '^ssl_bump peek step1' "$work"; then
  if ! sed -n '/^ssl_bump peek step1/{n;p}' "$work" | grep -q '^ssl_bump bump browser_port$'; then
    sed -i '/^ssl_bump bump browser_port$/d; /^ssl_bump peek step1/a ssl_bump bump browser_port' "$work"; changed=1
    note "4b. placed ssl_bump bump browser_port right after the peek"
  else note "4b. ssl_bump bump browser_port already in place"; fi
else echo "!! 4b. no 'ssl_bump peek step1' line to anchor on. Not touching it." >&2; fi

# 6. in-app pictures (Spotify artwork/Canvas, Play Store icons): matched by role in squid itself and
#    terminated, with no helper in the path — see the long comment in scripts/squid.conf. Replaces
#    any earlier play-lh-only acl and its `bump ... !filter_allows` rule.
#
#    Inserted with awk reading the pattern from the environment, NOT sed and NOT `awk -v`: both
#    process backslash escapes, and this regex is nothing but backslash escapes. Idempotence is
#    checked by looking for the exact line anywhere in the file, not at a fixed position, so a
#    comment moving around cannot make the script rewrite the file on every run.
export APP_MEDIA_RX='^(((i|o|t|p|pl|misc|mosaic|canvaz|pickasso|daylist|concerts|fex|charts-images|daily-mix|dailymix-images|lineup-images|merch-img|newjams-images|profile-images|seeded-session-images|seed-mix-image|thisis-images|wrapped-images|lexicon-assets|mixed-media-images|podz-content|image[a-z0-9-]*|video[a-z0-9-]*)\.(scdn\.co|spotifycdn\.com))|(video[a-z0-9-]*\.(cdn\.)?spotify\.com)|play-lh\.googleusercontent\.com)$'
APP_MEDIA_ACL="acl app_media_hosts ssl::server_name_regex -i $APP_MEDIA_RX"
APP_MEDIA_RULE='ssl_bump terminate app_media_hosts wg_phones !app_media_exempt'

if grep -q '^acl google_system_hosts dstdomain' "$work"; then
  if ! grep -qxF "$APP_MEDIA_ACL" "$work"; then
    sed -i '/^acl app_media_hosts /d; /^acl app_media_exempt /d' "$work"
    awk '/^acl google_system_hosts dstdomain/ && !placed {
           print "acl app_media_hosts ssl::server_name_regex -i " ENVIRON["APP_MEDIA_RX"]
           print "acl app_media_exempt src 10.66.0.255"
           placed = 1
         } { print }' "$work" > "$work.tmp" && mv "$work.tmp" "$work"
    changed=1
    note "6a. placed the app_media_hosts role regex + app_media_exempt"
  else note "6a. app_media_hosts regex already in place"; fi
else echo "!! 6a. no 'acl google_system_hosts' line to anchor on. Not touching it." >&2; fi

if grep -q '^ssl_bump bump browser_port$' "$work"; then
  if ! grep -qxF "$APP_MEDIA_RULE" "$work"; then
    sed -i '/^ssl_bump bump app_media_hosts !filter_allows$/d' "$work"
    sed -i "/^ssl_bump bump browser_port$/a $APP_MEDIA_RULE" "$work"
    changed=1
    note "6b. placed the terminate rule right after the browser-port bump"
  else note "6b. terminate rule already in place"; fi
else echo "!! 6b. no 'ssl_bump bump browser_port' line to anchor on. Not touching it." >&2; fi

# 5. keep the Google exemption off the browser port
if grep -q '^http_access allow google_system_hosts web_ports$' "$work"; then
  sed -i 's/^http_access allow google_system_hosts web_ports$/http_access allow google_system_hosts web_ports !browser_port/' "$work"; changed=1
  note "5. google_system_hosts exemption now excludes the browser port"
elif grep -q '^http_access allow google_system_hosts web_ports !browser_port' "$work"; then note "5. exemption already excludes the browser port"
else echo "!! 5. could not find 'http_access allow google_system_hosts web_ports'. Not touching it." >&2; fi

echo
if (( DRY )); then
  echo "--- dry run: diff against $CONF ---"; diff -u "$CONF" "$work" || true; rm -f "$work"; exit 0
fi

if (( changed )); then
  cp "$CONF" "$CONF.pre-yeshiva.$(date +%Y%m%d%H%M%S)"
  install -m 644 "$work" "$CONF"
  echo "squid.conf updated (backup beside it)."
else
  echo "squid.conf already up to date."
fi
rm -f "$work"

echo "==> Helper"
install -m 755 "$HERE/squid-acl-helper.py" /usr/local/bin/squid-acl-helper.py

echo "==> Parse + reconfigure"
squid -k parse && squid -k reconfigure && echo "done — helpers restarted with the new format."
echo
echo "Live check in 10 s:  tail -20 /var/log/squid/cache.log"
echo "Drift (expected: only your scoped test rule / access log):  $HERE/check-drift.sh"
