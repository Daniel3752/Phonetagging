#!/usr/bin/env bash
#
# Applies the yeshiva-tag changes to a LIVE /etc/squid/squid.conf in place, and installs the
# matching helper. For a server whose squid.conf carries hand edits that must survive (the scoped
# test_phones rule, the access log) — install-squid.sh would overwrite those. Idempotent: run it
# twice and the second run changes nothing.
#
# The four edits (see scripts/squid.conf for the reasoning next to each):
#   1. external_acl_type format gains %>ha{Sec-Fetch-Dest}   (images with no file extension)
#   2. deny_info URL gains &why=%o                             (the block page learns "locked")
#   3. http_port 3128 gains name=browser                       (the browser's own door)
#   4. acl browser_port myportname browser + ssl_bump bump browser_port (decrypt only that door)
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

# 4. the acl + the bump rule. The acl goes before the ssl_bump block (squid needs it declared
#    first); the rule goes right after `ssl_bump splice worker_sni`, ahead of any splice of
#    filter_allows — scoped (test_phones) or not.
if ! grep -q '^acl browser_port myportname browser' "$work"; then
  if grep -q '^acl step1 at_step SslBump1' "$work"; then
    sed -i '/^acl step1 at_step SslBump1/i acl browser_port myportname browser' "$work"; changed=1
    note "4a. added acl browser_port"
  else echo "!! 4a. no 'acl step1 at_step SslBump1' line to anchor on. Not touching it." >&2; fi
else note "4a. acl browser_port already present"; fi
#    The rule goes straight after the peek, ahead of EVERY splice (splice.txt included — Chrome
#    trusts the certificate, and Google serves thumbnails from a splice.txt host). A rule already
#    present lower down (an earlier run of this script) is moved up.
if grep -q '^ssl_bump peek step1' "$work"; then
  if ! sed -n '/^ssl_bump peek step1/{n;p}' "$work" | grep -q '^ssl_bump bump browser_port$'; then
    sed -i '/^ssl_bump bump browser_port$/d; /^ssl_bump peek step1/a ssl_bump bump browser_port' "$work"; changed=1
    note "4b. placed ssl_bump bump browser_port right after the peek"
  else note "4b. ssl_bump bump browser_port already in place"; fi
else echo "!! 4b. no 'ssl_bump peek step1' line to anchor on. Not touching it." >&2; fi

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
