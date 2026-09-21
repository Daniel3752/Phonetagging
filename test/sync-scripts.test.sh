#!/usr/bin/env bash
# Offline checks for the server-side sync scripts: the ad-list normaliser accepts every list format
# and keeps what must be kept; the media-on sync writes squid's address file and the strict
# resolver's host list from a mocked Worker. No network, no root: everything goes to a temp dir and
# the systemd/squid/ipset calls fail harmlessly. Run with: npm run test:scripts
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"; kill "${HTTP_PID:-0}" 2>/dev/null' EXIT
fail=0
check() { if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }

echo; echo "1. sync-adblock.sh normalises every list format"
cat > "$T/list.txt" <<'LIST'
# comment
! other comment
local=/ads.example.com/
local=/sub.ads.example.com/
address=/track.example.net/
server=/old.example.org/#
||adblock.example^
0.0.0.0 hosts.example
127.0.0.1 hosts2.example
plaindomain.example
*.wild.example
graph.facebook.com
accounts.google.com
phone-url-filter.daniel08-madar.workers.dev
not a domain
LIST
SHMIRA_ENV_FILE=/nonexistent SHMIRA_ADBLOCK_URLS="file://$T/list.txt" SHMIRA_ADBLOCK_FILE="$T/adblock.conf" SHMIRA_ADBLOCK_MIN=3 \
  bash "$HERE/../scripts/sync-adblock.sh" >/dev/null 2>&1
check "the file was written"                      "[[ -f $T/adblock.conf ]]"
check "dnsmasq lines become local= lines"        "grep -qx 'local=/ads.example.com/' $T/adblock.conf"
check "a shadowed subdomain is dropped"           "! grep -q 'sub.ads.example.com' $T/adblock.conf"
check "address= and server= forms are taken"     "grep -qx 'local=/track.example.net/' $T/adblock.conf && grep -qx 'local=/old.example.org/' $T/adblock.conf"
check "adblock ||host^ form is taken"             "grep -qx 'local=/adblock.example/' $T/adblock.conf"
check "hosts-file forms are taken"                "grep -qx 'local=/hosts.example/' $T/adblock.conf && grep -qx 'local=/hosts2.example/' $T/adblock.conf"
check "plain domains and *. wildcards are taken"  "grep -qx 'local=/plaindomain.example/' $T/adblock.conf && grep -qx 'local=/wild.example/' $T/adblock.conf"
check "junk is dropped"                           "! grep -q 'not a domain' $T/adblock.conf"
check "the filter's own hosts are never refused"  "! grep -q 'workers.dev' $T/adblock.conf && ! grep -q 'accounts.google.com' $T/adblock.conf"
check "sign-in hosts apps need are never refused" "! grep -q 'graph.facebook.com' $T/adblock.conf"
check "a too-short list is refused, the old file kept" \
  "printf 'x.example\n' > $T/short.txt && SHMIRA_ENV_FILE=/nonexistent SHMIRA_ADBLOCK_URLS=file://$T/short.txt SHMIRA_ADBLOCK_FILE=$T/adblock.conf SHMIRA_ADBLOCK_MIN=3 bash $HERE/../scripts/sync-adblock.sh >/dev/null 2>&1; grep -qx 'local=/ads.example.com/' $T/adblock.conf"
if command -v dnsmasq >/dev/null; then
  check "dnsmasq parses the result" "dnsmasq --test --conf-file=$T/adblock.conf >/dev/null 2>&1"
fi

echo; echo "2. sync-media-on.sh writes squid's list, the ipset (skipped here) and the strict resolver's hosts"
mkdir -p "$T/mock/api/proxy" "$T/strict.d"
printf '{"addresses":["10.66.0.3","10.66.0.9","junk"]}' > "$T/mock/api/proxy/media-on"
printf '{"hosts":["i.scdn.co","MOSAIC.scdn.co","play-lh.googleusercontent.com","bad host","x"]}' > "$T/mock/api/proxy/media-hosts"
port=$((20000 + RANDOM % 20000))
(cd "$T/mock" && python3 -m http.server "$port" >/dev/null 2>&1) & HTTP_PID=$!
for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:$port/api/proxy/media-on" >/dev/null 2>&1 && break; sleep 0.2; done
SHMIRA_ENV_FILE=/nonexistent SHMIRA_PROXY_KEY=x SHMIRA_WORKER_URL="http://127.0.0.1:$port" SHMIRA_MEDIA_ON_FILE="$T/media-on.txt" SHMIRA_STRICT_DNS_DIR="$T/strict.d" \
  bash "$HERE/../scripts/sync-media-on.sh" >/dev/null 2>&1
check "the squid address file carries the placeholder and the phones"   "grep -qx '10.66.0.255' $T/media-on.txt && grep -qx '10.66.0.3' $T/media-on.txt && grep -qx '10.66.0.9' $T/media-on.txt"
check "junk addresses are dropped"                                     "! grep -q junk $T/media-on.txt"
check "the strict resolver gets local= lines for the picture hosts"    "grep -qx 'local=/i.scdn.co/' $T/strict.d/app-media.conf && grep -qx 'local=/mosaic.scdn.co/' $T/strict.d/app-media.conf"
check "malformed hosts are dropped"                                    "! grep -q 'bad host' $T/strict.d/app-media.conf && ! grep -qx 'local=/x/' $T/strict.d/app-media.conf"
if command -v dnsmasq >/dev/null; then
  check "dnsmasq parses the strict list" "dnsmasq --test --conf-file=$T/strict.d/app-media.conf >/dev/null 2>&1"
fi
kill "$HTTP_PID" 2>/dev/null; HTTP_PID=0
printf '{"addresses":"nope"}' > "$T/mock/api/proxy/media-on"
(cd "$T/mock" && python3 -m http.server "$port" >/dev/null 2>&1) & HTTP_PID=$!
for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:$port/api/proxy/media-on" >/dev/null 2>&1 && break; sleep 0.2; done
SHMIRA_ENV_FILE=/nonexistent SHMIRA_PROXY_KEY=x SHMIRA_WORKER_URL="http://127.0.0.1:$port" SHMIRA_MEDIA_ON_FILE="$T/media-on.txt" SHMIRA_STRICT_DNS_DIR="$T/strict.d" \
  bash "$HERE/../scripts/sync-media-on.sh" >/dev/null 2>&1
check "a malformed answer leaves the previous files in place"          "grep -qx '10.66.0.3' $T/media-on.txt && grep -qx 'local=/i.scdn.co/' $T/strict.d/app-media.conf"

echo; echo "3. every server script parses"
for f in "$HERE"/../scripts/*.sh; do
  check "bash -n $(basename "$f")" "bash -n $f"
done

echo
if (( fail )); then echo "SCRIPT CHECKS FAILED"; exit 1; else echo "All script checks passed."; fi
