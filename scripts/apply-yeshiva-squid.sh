#!/usr/bin/env bash
#
# Applies the yeshiva-tag changes to a LIVE /etc/squid/squid.conf in place, and installs the
# matching helper. For a server whose squid.conf carries hand edits that must survive (the scoped
# test_phones rule, the access log) — install-squid.sh would overwrite those. Idempotent: run it
# twice and the second run changes nothing.
#
# The edits (see scripts/squid.conf for the reasoning next to each):
#   1. external_acl_type format gains %>ha{Sec-Fetch-Dest}   (images with no file extension)
#      and %ssl::>sni (1b: the hostname at an intercepted handshake — %URI is the address there)
#   2. deny_info URL gains &why=%o                             (the block page learns "locked")
#   3. http_port 3128 gains name=browser                       (the browser's own door)
#   4. acl browser_port myportname browser + ssl_bump bump browser_port (decrypt only that door)
#   5. the google_system_hosts pre-filter allow excludes the browser port (else Chrome's requests
#      to www.gstatic.com / lh3.googleusercontent.com skip the filter and images leak)
#   6. acl app_media_hosts (a ROLE regex) + acl app_keep_hosts (the music/API roles, never
#      terminated) + acl app_media_on (a src ACL read from /etc/squid/app-media-on.txt) +
#      `ssl_bump terminate app_media_hosts !app_keep_hosts wg_phones !app_media_on` right after
#      the browser-port bump: in-app pictures (Spotify artwork and Canvas, Play Store icons) are
#      closed by name, without asking the helper — an earlier version asked the helper here and
#      squid spliced hosts the helper had refused. Which phones are exempt stays per-rung:
#      sync-media-on.sh rewrites that file from the Worker every five minutes, and it is an
#      allowlist, so a phone missing from it has pictures blocked rather than open. The two
#      regexes are generated from src/app-media.js by scripts/build-squid-media-acls.mjs; a
#      server carrying an older pattern gets the current one on the next run.
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
elif grep -qE '^\s*%un %SRC %URI.*Sec-Fetch-Dest' "$work"; then note "1. helper format: already has Sec-Fetch-Dest"
else echo "!! 1. could not find the '%un %SRC %URI \\' line — is the %LOGIN fix applied? Not touching it." >&2; fi
# 1b. the SNI: at ssl_bump step 2 %URI is the destination ADDRESS for an intercepted connection,
#     so the hostname the phone asked for reaches the helper only as %ssl::>sni (see squid.conf).
if grep -qE '^\s*%un %SRC %URI %>ha\{Sec-Fetch-Dest\} \\$' "$work"; then
  sed -i -E 's/^(\s*)%un %SRC %URI %>ha\{Sec-Fetch-Dest\} \\$/\1%un %SRC %URI %>ha{Sec-Fetch-Dest} %ssl::>sni \\/' "$work"; changed=1
  note "1b. helper format: added %ssl::>sni"
elif grep -qE '^\s*%un %SRC %URI.*%ssl::>sni' "$work"; then note "1b. helper format: already has %ssl::>sni"
else echo "!! 1b. could not find the helper format line to add %ssl::>sni to. Not touching it." >&2; fi

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
export APP_MEDIA_RX='^(((i|o|t|misc|mosaic|canvaz|pickasso|daylist|concerts|fex|daily-mix|lexicon-assets|podz-content|([a-z0-9]+-)*(image|images|img|video[0-9]*|videos|canvas|canvaz|thumb|thumbs|thumbnail|thumbnails|cover|covers|artwork|mosaic|pickasso|picasso)(-[a-z0-9]+)*)\.(scdn\.co|spotifycdn\.com|spotify\.com|pscdn\.co))|(([a-z0-9]+-)*(image|images|img|video[0-9]*|videos|canvas|canvaz|thumb|thumbs|thumbnail|thumbnails|cover|covers|artwork|mosaic|pickasso|picasso)(-[a-z0-9]+)*-spotify-com\.akamaized\.net)|play-lh\.googleusercontent\.com)\.?$'
export APP_MEDIA_ACL="acl app_media_hosts ssl::server_name_regex -i $APP_MEDIA_RX"
# The hosts that carry the music and the API, negated on the terminate rule (see squid.conf).
export APP_KEEP_RX='^((p)\.|(audio|heads|seektables|spclient|apresolve|dealer|login|clienttoken|accounts|api|exp|ap-|ap\.|mobile-ap|dj-|anon-podcast|podcast|encore|open|www|sdk|download|upgrade|episode|tts|sharing|gew|guc|gae|gue|connect|partner|pathfinder|quic|wg)[a-z0-9-]*\.)'
export APP_KEEP_ACL="acl app_keep_hosts ssl::server_name_regex -i $APP_KEEP_RX"
export APP_MEDIA_ON_ACL='acl app_media_on src "/etc/squid/app-media-on.txt"'
APP_MEDIA_RULE='ssl_bump terminate app_media_hosts !app_keep_hosts wg_phones !app_media_on'
APP_MEDIA_ON_FILE=/etc/squid/app-media-on.txt
# squid refuses to start on a missing ACL file, so the file must exist before the acl line does.
# Placeholder-only until sync-media-on.sh runs, which means pictures off everywhere — the safe way
# round. (--dry-run must not touch the real filesystem.)
if (( ! DRY )) && [[ ! -f $APP_MEDIA_ON_FILE ]]; then
  if [[ -d ${APP_MEDIA_ON_FILE%/*} ]]; then
    printf '# Phones whose rung may see in-app pictures. Generated by sync-media-on.sh.\n10.66.0.255\n' > "$APP_MEDIA_ON_FILE"
    chmod 0644 "$APP_MEDIA_ON_FILE"
    note "6c. created $APP_MEDIA_ON_FILE (placeholder only until the sync runs)"
  else
    echo "!! 6c. ${APP_MEDIA_ON_FILE%/*} does not exist — create $APP_MEDIA_ON_FILE before squid starts," >&2
    echo "        or squid will refuse to start on the missing acl file." >&2
  fi
fi

if grep -q '^acl google_system_hosts dstdomain' "$work"; then
  # BOTH lines, not just the regex: a server patched by an earlier version of this script has the
  # regex already but names the companion ACL app_media_exempt, and would otherwise keep it.
  if ! grep -qxF "$APP_MEDIA_ACL" "$work" || ! grep -qxF "$APP_KEEP_ACL" "$work" || ! grep -qxF "$APP_MEDIA_ON_ACL" "$work"; then
    sed -i '/^acl app_media_hosts /d; /^acl app_keep_hosts /d; /^acl app_media_exempt /d; /^acl app_media_on /d' "$work"
    # ABOVE acl browser_port, not directly above google_system_hosts: step 4a checks that
    # browser_port is the line immediately before google_system_hosts, and inserting between the
    # two would make 4a move it back on every future run — a script that never settles.
    export APP_MEDIA_ANCHOR='^acl browser_port myportname browser$'
    grep -q "$APP_MEDIA_ANCHOR" "$work" || export APP_MEDIA_ANCHOR='^acl google_system_hosts dstdomain'
    # Whole lines out of the environment: nothing to escape, in a regex that is all escapes.
    awk '$0 ~ ENVIRON["APP_MEDIA_ANCHOR"] && !placed {
           print ENVIRON["APP_MEDIA_ACL"]
           print ENVIRON["APP_KEEP_ACL"]
           print ENVIRON["APP_MEDIA_ON_ACL"]
           placed = 1
         } { print }' "$work" > "$work.tmp"
    mv "$work.tmp" "$work"
    grep -qxF "$APP_MEDIA_ACL" "$work" && grep -qxF "$APP_KEEP_ACL" "$work" || { echo "!! 6a. insert failed — not writing a broken config" >&2; exit 1; }
    changed=1
    note "6a. placed the app_media_hosts + app_keep_hosts regexes + app_media_on"
  else note "6a. app_media_hosts / app_keep_hosts regexes already in place"; fi
else echo "!! 6a. no 'acl google_system_hosts' line to anchor on. Not touching it." >&2; fi

# 6d. The live file may still carry the paragraph saying this is "no longer per-rung" and naming
#     app_media_exempt, an ACL that no longer exists. Rewrite it so the file keeps explaining
#     itself. Only touched when BOTH its first and last lines are present, and the result is
#     checked, so a paragraph that has been edited by hand is left alone rather than half-eaten.
export APP_MEDIA_NOTE='# It stays PER-RUNG all the same: app_media_on is a src ACL read from /etc/squid/app-media-on.txt,
# which /usr/local/bin/sync-media-on.sh rewrites from the Worker (/api/proxy/media-on) every five
# minutes, listing the tunnel addresses whose rung may see these pictures. A file ACL is read from
# disk and evaluated synchronously, so there is nothing to race. The list is an ALLOWLIST: a phone
# missing from it, or a sync that has not run, means pictures blocked rather than open.'
if grep -q '^# The cost: this is no longer per-rung' "$work" && grep -q 'app_media_exempt below\.$' "$work"; then
  awk -v note="$APP_MEDIA_NOTE" '
    /^# The cost: this is no longer per-rung/ && !done { skip = 1; print note; next }
    skip && /app_media_exempt below\.$/     { skip = 0; done = 1; next }
    skip                                    { next }
                                            { print }' "$work" > "$work.tmp"
  mv "$work.tmp" "$work"
  if ! grep -q '^# It stays PER-RUNG' "$work" || ! grep -qxF 'ssl_bump bump all' "$work"; then
    echo "!! 6d. comment rewrite went wrong — not writing a broken config" >&2; exit 1
  fi
  changed=1
  note "6d. rewrote the stale 'no longer per-rung' comment"
fi

#    Position matters here, unlike the acl lines: the rule is only sound ahead of every splice, so
#    it is checked as THE line right after the browser-port bump (as step 4b checks its own line),
#    and a copy anywhere else — an older form, or one someone moved below the splices — is removed.
if grep -q '^ssl_bump bump browser_port$' "$work"; then
  if ! sed -n '/^ssl_bump bump browser_port$/{n;p}' "$work" | grep -qxF "$APP_MEDIA_RULE"; then
    sed -i '/^ssl_bump bump app_media_hosts !filter_allows$/d; /^ssl_bump terminate app_media_hosts /d' "$work"
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

echo "==> In-app picture allowlist (app_media_on)"
install -m 755 "$HERE/sync-media-on.sh" /usr/local/bin/sync-media-on.sh
# /etc/cron.d, like the blocklist sync — no dependency on a crontab binary.
cat > /etc/cron.d/shmira-media-on <<'CRON'
*/5 * * * * root /usr/local/bin/sync-media-on.sh >> /var/log/shmira-media-on.log 2>&1
CRON
chmod 644 /etc/cron.d/shmira-media-on
/usr/local/bin/sync-media-on.sh || echo "    !! first sync failed — the file stays placeholder-only (pictures off everywhere)" >&2

echo "==> Parse + reconfigure"
squid -k parse && squid -k reconfigure && echo "done — helpers restarted with the new format."
echo
echo "Live check in 10 s:  tail -20 /var/log/squid/cache.log"
echo "Drift (expected: only your scoped test rule / access log):  $HERE/check-drift.sh"
