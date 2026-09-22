#!/usr/bin/env bash
#
# Pulls the ad-network blocklist into the OPEN resolver (install-dns-policy.sh), so every phone —
# the strict resolver forwards to it — gets NXDOMAIN for the hosts that in-app ads come from:
# AdMob, Meta Audience Network, AppLovin, Unity, ironSource, Vungle, Chartboost, InMobi, Pangle,
# Mintegral, Amazon … The ad SDK gets no address, opens nothing, shows nothing. Works for every
# app and every protocol, because it happens before a connection exists.
#
# What it does NOT touch, and cannot: ads served from the same hosts as the content — YouTube's
# in-app ads (googlevideo.com), Spotify's free-tier audio ads (spclient.wg.spotify.com/ads/…),
# Instagram/Facebook feed ads. Those are the app's own traffic.
#
# Lists (SHMIRA_ADBLOCK_URLS, space-separated, in /etc/squid/filter.env to override). Any of the
# usual formats is accepted and normalised here to `local=/host/` lines: dnsmasq (local=/x/ or
# address=/x/…), hosts files (0.0.0.0 x), plain domain lists, and AdGuard/ABP-style ||x^ lines.
# The default is hagezi's "Pro" list — checked 2026-09-22 against the eleven mobile ad-SDK families
# (AdMob, Meta Audience Network, AppLovin, Unity, ironSource, Vungle, Chartboost, InMobi, Pangle,
# Mintegral, Amazon): Pro is the first tier that covers all of them (Light and Multi have no
# Vungle and no Chartboost at all) and the last that keeps graph.facebook.com, the Play, YouTube,
# Instagram, WhatsApp and Samsung hosts intact (Pro++ breaks Instagram, Ultimate breaks Meta) —
# plus hagezi's encrypted-DNS + VPN/proxy-bypass list (a superset of its plain DoH list: the DoH
# resolvers an app might carry, and the web proxies and "school bypass" sites a kid would look
# for; audited clean of CDN wildcards and of the usual school services), so nothing routes around
# the resolver. Pro does block Firebase Crashlytics/analytics and app-measurement.com on purpose;
# FCM push and Firebase's function hosts are untouched.
#
# Two things are added by hand: use-application-dns.net (Firefox's canary — an NXDOMAIN here is
# Mozilla's own signal for the browser to keep DNS-over-HTTPS off; neither hagezi list has it),
# and a `server=/host/<upstream>` line for every KEEP host, which dnsmasq honours over any
# `local=` parent because the most specific rule wins — the robust form of an allowlist.
#
# Fails SAFE: a failed download, an empty result or a config that does not parse leaves the
# previous list in place; a restart that leaves the resolver dead is rolled back to the previous
# file. dnsmasq only reads `local=` lines at start, so a changed list means a restart of the open
# instance (its cache empties; the cron runs at night).
#
# Cron (install-dns-policy.sh):  41 3 * * *  /usr/local/bin/sync-adblock.sh
set -euo pipefail

ENV_FILE="${SHMIRA_ENV_FILE:-/etc/squid/filter.env}"
if [[ -r "$ENV_FILE" ]]; then set -a; . "$ENV_FILE"; set +a; fi

URLS="${SHMIRA_ADBLOCK_URLS:-https://raw.githubusercontent.com/hagezi/dns-blocklists/main/dnsmasq/pro.txt https://raw.githubusercontent.com/hagezi/dns-blocklists/main/dnsmasq/doh-vpn-proxy-bypass.txt https://raw.githubusercontent.com/hagezi/dns-blocklists/main/dnsmasq/doh.txt}"
# Refused by hand, whatever the lists say (space-separated; SHMIRA_ADBLOCK_EXTRA adds more).
EXTRA="use-application-dns.net ${SHMIRA_ADBLOCK_EXTRA:-}"
# Where an allowlisted name is resolved: the open resolver's own upstreams.
UPSTREAM="${SHMIRA_ADBLOCK_UPSTREAM:-1.1.1.1}"
DEST="${SHMIRA_ADBLOCK_FILE:-/etc/dnsmasq.d/shmira-adblock.conf}"
# Never refuse these whatever a list says: the filter's own plumbing, and hosts apps need to work
# (sign-in, push). One per line, suffix match. Override/extend with SHMIRA_ADBLOCK_KEEP (space-separated).
KEEP="workers.dev cloudflare.com getshmira.com googleapis.com gstatic.com google.com googleusercontent.com whatsapp.net whatsapp.com android.com gvt1.com gvt2.com spotify.com scdn.co spotifycdn.com graph.facebook.com b-graph.facebook.com ${SHMIRA_ADBLOCK_KEEP:-}"
# A list far smaller than this is a truncated download, not a blocklist.
MIN_LINES=${SHMIRA_ADBLOCK_MIN:-5000}

stamp() { date -u +%FT%TZ; }
raw="$(mktemp)"; out="$(mktemp)"; prev="$(mktemp)"
trap 'rm -f "$raw" "$out" "$prev"' EXIT

: > "$raw"
for u in $URLS; do
  if ! curl -fsSL --max-time 120 "$u" >> "$raw"; then
    echo "$(stamp) WARN fetch failed for $u — keeping $DEST as is" >&2
    exit 0
  fi
  echo >> "$raw"
done

python3 - "$raw" "$KEEP" "$EXTRA" "$UPSTREAM" > "$out" <<'PY'
import re, sys
keep = [k.strip().lower().lstrip('.') for k in sys.argv[2].split() if k.strip()]
extra = [k.strip().lower().lstrip('.') for k in sys.argv[3].split() if k.strip()]
upstream = sys.argv[4]
def kept(d):
    return any(d == k or d.endswith('.' + k) for k in keep)
label = re.compile(r'^[a-z0-9_](?:[a-z0-9_-]{0,62}[a-z0-9_])?$')
doms = set()
for line in open(sys.argv[1], encoding='utf-8', errors='replace'):
    s = line.strip().lower()
    if not s or s[0] in '#!':
        continue
    m = re.match(r'^(?:local|address|server)=/([^/]+)/', s)          # dnsmasq
    if m:
        d = m.group(1)
    elif s.startswith('||'):                                           # adblock: ||host^
        d = s[2:].split('^', 1)[0]
    elif re.match(r'^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+', s):        # hosts file
        d = s.split()[1]
    else:                                                              # plain domain
        d = s.split()[0]
    d = d.strip('.').lstrip('*.')
    if not d or '/' in d or ':' in d or '.' not in d:
        continue
    if not all(label.match(l) for l in d.split('.')):
        continue
    if kept(d):
        continue
    doms.add(d)
for d in extra:
    if not kept(d) and all(label.match(l) for l in d.split('.')):
        doms.add(d)
# A `local=/example.com/` already covers every subdomain: drop shadowed entries so the file is
# as small as it can be (dnsmasq would take them either way).
def shadowed(d):
    parts = d.split('.')
    return any('.'.join(parts[i:]) in doms for i in range(1, len(parts) - 1))
print('# Ad-network and encrypted-DNS hosts refused for every phone. Written by sync-adblock.sh — do not edit.')
print('# Allowlist: the most specific rule wins in dnsmasq, so these resolve whatever a local= line above them says.')
for k in sorted(set(keep)):
    print('server=/%s/%s' % (k, upstream))
for d in sorted(x for x in doms if not shadowed(x)):
    print('local=/%s/' % d)
PY

n=$(grep -c '^local=' "$out" || true)
if (( n < MIN_LINES )); then
  echo "$(stamp) WARN only $n entries after normalising (min $MIN_LINES) — keeping $DEST as is" >&2
  exit 0
fi
if [[ -f "$DEST" ]] && cmp -s "$out" "$DEST"; then
  exit 0
fi

# Prove the new file parses in the open instance's configuration before it goes live.
[[ -f "$DEST" ]] && cp "$DEST" "$prev"
install -m 0644 "$out" "$DEST"
if ! dnsmasq --test --conf-file=/etc/dnsmasq.conf --conf-dir=/etc/dnsmasq.d,.dpkg-dist,.dpkg-old,.dpkg-new >/dev/null 2>&1; then
  echo "$(stamp) WARN the new list does not parse — restoring the previous one" >&2
  if [[ -s "$prev" ]]; then install -m 0644 "$prev" "$DEST"; else rm -f "$DEST"; fi
  exit 0
fi
echo "$(stamp) updated $DEST ($n entries)"
if systemctl is-active --quiet dnsmasq; then
  systemctl restart dnsmasq
  sleep 1
  if ! dig +short +time=3 +tries=1 @127.0.0.1 example.com | grep -q .; then
    echo "$(stamp) ERROR resolver not answering after restart — rolling back" >&2
    if [[ -s "$prev" ]]; then install -m 0644 "$prev" "$DEST"; else rm -f "$DEST"; fi
    systemctl restart dnsmasq
    exit 1
  fi
  echo "$(stamp) dnsmasq restarted with the new list"
fi
