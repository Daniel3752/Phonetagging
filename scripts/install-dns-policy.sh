#!/usr/bin/env bash
#
# Installs the per-phone DNS layer on the proxy box. Idempotent — safe to re-run; --uninstall puts
# the single-resolver layout back.
#
# WHY. Two things the proxy cannot do at the TLS handshake:
#   * Refuse a picture the app fetches over a connection it already holds. Spotify's spotifycdn.com
#     hosts — image-cdn-fa, pickasso, seed-mix-image, daylist … — share one Fastly address and one
#     *.spotifycdn.com certificate with heads-fa (audio prefetch) and audio-fa-quic, and negotiate
#     HTTP/2. An HTTP/2 client may send a request for host B down an open connection to host A when
#     the certificate covers B and B resolves to A's address (OkHttp, Cronet), and such a request
#     carries no handshake and no SNI: squid sees one spliced connection to heads-fa and the
#     artwork inside it. A name that does not RESOLVE cannot be coalesced — the client needs B's
#     address to match — so the picture hosts are refused at DNS for the phones whose rung has
#     in-app pictures off.
#   * Block an ad an app fetches over QUIC, over a port the proxy does not intercept, or by a
#     resolver of its own. In-app ads come from a few hundred ad-network hosts; refusing them at DNS
#     stops the SDK before it opens a connection, for every app, every protocol. (First-party ads
#     inside YouTube, Spotify's free tier and Meta's apps ride the same hosts as the content and are
#     NOT touched by this; see docs.)
#
# HOW. Two dnsmasq instances, one cache:
#   * STRICT   — a second instance, on the tunnel address every phone already has as its DNS
#                (10.66.0.1). It answers NXDOMAIN for the in-app picture hosts and forwards
#                everything else, uncached, to OPEN. Config: /etc/shmira/dnsmasq-strict.conf, the
#                picture list in /etc/shmira/dnsmasq-strict.d/app-media.conf (sync-media-on.sh).
#   * OPEN     — the packaged instance, moved to 127.0.0.1 (squid) and 10.66.1.1 (a second address
#                on wg0). Upstream 1.1.1.1, the cache, the ad blocklist (sync-adblock.sh into
#                /etc/dnsmasq.d/shmira-adblock.conf). Phones whose rung allows in-app pictures reach
#                it through a DNAT rule keyed on an ipset that sync-media-on.sh keeps in step with
#                /api/proxy/media-on — the same allowlist squid's terminate rule reads.
#   Because STRICT caches nothing and forwards to OPEN, every phone and squid draw the same answer
#   from one cache — the property squid's intercept host check depends on (install-wireguard.sh).
#   The only names the two disagree on are the picture hosts, which a strict phone never connects
#   to, and the ad hosts, which nobody resolves.
#
# FAILURE DIRECTIONS. STRICT down = phones have no DNS (visible at once; Restart=always). OPEN down
# = phones have no DNS either (STRICT forwards to it), and squid falls over to 1.1.1.1 (its
# dns_nameservers failover) — resolving, but no longer from the same cache as the phones and no
# longer refusing the ad hosts. The address file and the ipset are ALLOWLISTS: a sync that has not
# run means pictures off, never on. The picture HOST list is a refusal list — empty refuses
# nothing — so it is seeded from the repository below before the strict instance first starts.
# bind-dynamic on both instances so an address that appears late (wg0 after boot) is picked up
# rather than fatal.
#
# Usage:  sudo scripts/install-dns-policy.sh              # from a clone of the deployed branch
#         sudo scripts/install-dns-policy.sh --uninstall
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STRICT_IP=10.66.0.1
OPEN_IP=10.66.1.1
ETC=/etc/shmira
STRICT_CONF=$ETC/dnsmasq-strict.conf
STRICT_DIR=$ETC/dnsmasq-strict.d
OPEN_CONF=/etc/dnsmasq.d/shmira.conf
ADBLOCK_CONF=/etc/dnsmasq.d/shmira-adblock.conf
# The pre-change backup MUST live outside /etc/dnsmasq.d: the packaged dnsmasq's conf-dir reads
# every file in that directory that does not end in .dpkg-*, so a backup left beside shmira.conf is
# loaded as a second config and collides with it ("illegal repeated keyword"). Keep it under /etc/shmira.
BACKUP=$ETC/shmira.conf.pre-dns-policy
LEGACY_BACKUP=$OPEN_CONF.pre-dns-policy   # where older installs wrongly put it; cleaned up below
UNIT_STRICT=/etc/systemd/system/shmira-dnsmasq-strict.service
UNIT_POLICY=/etc/systemd/system/shmira-dns-policy.service

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
command -v dnsmasq >/dev/null || { echo "dnsmasq is not installed (install-wireguard.sh installs it)" >&2; exit 1; }

# dnsmasq gained --filter-rr in 2.90; on an older one the HTTPS-record stripping is simply not
# available (install-wireguard.sh already relies on it, so a box that got this far has it).
FILTER_RR=''
if dnsmasq --test --conf-file=/dev/null --filter-rr=HTTPS >/dev/null 2>&1; then FILTER_RR='filter-rr=HTTPS'; fi

uninstall() {
  systemctl disable --now shmira-dnsmasq-strict.service 2>/dev/null || true
  systemctl disable --now shmira-dns-policy.service 2>/dev/null || true
  rm -f "$UNIT_STRICT" "$UNIT_POLICY"
  systemctl daemon-reload
  # A stray backup a broken older install left inside the scanned directory would keep the packaged
  # dnsmasq from starting; remove it first.
  rm -f "$LEGACY_BACKUP"
  # The packaged instance goes back to the phone-facing address: the config from before this
  # script ran, if it is still there, else the listen-address line rewritten.
  restore="$BACKUP"; [[ -f "$restore" ]] || restore="$LEGACY_BACKUP"
  if [[ -f "$restore" ]]; then
    install -m 0644 "$restore" "$OPEN_CONF"
  else
    sed -i "s|^listen-address=127.0.0.1,$OPEN_IP\$|listen-address=127.0.0.1,$STRICT_IP|" "$OPEN_CONF"
  fi
  rm -f /etc/cron.d/shmira-adblock
  dnsmasq --test --conf-file=/etc/dnsmasq.conf --conf-dir=/etc/dnsmasq.d,.dpkg-dist,.dpkg-old,.dpkg-new
  systemctl restart dnsmasq
  echo "uninstalled: one resolver again on $STRICT_IP (ad blocklist file left in place: $ADBLOCK_CONF)"
}
if [[ "${1:-}" == "--uninstall" ]]; then uninstall; exit 0; fi

apt-get install -y -qq ipset dnsutils >/dev/null    # dnsutils: dig, for the checks below and health-check.sh

echo "==> $ETC"
mkdir -p "$ETC" "$STRICT_DIR"
chmod 755 "$ETC" "$STRICT_DIR"
# The picture list is a REFUSAL list — an empty one refuses nothing — so it is seeded from the
# repository (scripts/app-media.dnsmasq, generated from src/app-media.js) before the strict
# instance ever starts; sync-media-on.sh then keeps it current from the Worker.
if ! grep -q '^local=' "$STRICT_DIR/app-media.conf" 2>/dev/null; then
  install -m 0644 "$HERE/app-media.dnsmasq" "$STRICT_DIR/app-media.conf"
  echo "    seeded $STRICT_DIR/app-media.conf from the repository ($(grep -c '^local=' "$STRICT_DIR/app-media.conf") hosts)"
fi
[[ -f "$ADBLOCK_CONF" ]] || printf '# Ad-network hosts refused for every phone. Written by sync-adblock.sh.\n' > "$ADBLOCK_CONF"

# Everything below is written to staging files and VALIDATED before a single live file changes;
# then the live switch is one short sequence under a rollback trap, so a failure at any point
# puts the previous single-resolver layout back rather than leaving the packaged dnsmasq
# configured to move off $STRICT_IP at its next restart (which the nightly ad-list sync does).
stage="$(mktemp -d)"
open_stage="$stage/shmira.conf"; strict_stage="$stage/dnsmasq-strict.conf"
backup="$BACKUP"
# A broken earlier run may have left its backup inside the scanned directory, where the packaged
# dnsmasq would parse it and refuse to start. Remove it before we restart anything.
rm -f "$LEGACY_BACKUP"
switched=0
rollback() {
  local rc=$?
  rm -rf "$stage"
  if (( switched )); then
    echo "!! failed (exit $rc) — restoring the single-resolver layout" >&2
    systemctl disable --now shmira-dnsmasq-strict.service 2>/dev/null || true
    systemctl disable --now shmira-dns-policy.service 2>/dev/null || true
    [[ -f "$backup" ]] && install -m 0644 "$backup" "$OPEN_CONF"
    systemctl restart dnsmasq || true
    echo "!! restored $OPEN_CONF from $backup and restarted dnsmasq; the units are disabled. Fix and re-run." >&2
  fi
  exit "$rc"
}
trap rollback ERR

echo "==> OPEN resolver (the packaged dnsmasq): 127.0.0.1 + $OPEN_IP (staged)"
cat > "$open_stage" <<DNSMASQ
# The OPEN resolver (install-dns-policy.sh). squid resolves here (127.0.0.1), and so do the phones
# whose rung allows in-app pictures, via the DNAT rule of shmira-dns-policy.service ($OPEN_IP). The
# STRICT instance (shmira-dnsmasq-strict, $STRICT_IP) forwards everything it does not refuse here,
# so there is one cache for everyone. The ad blocklist lives beside this file
# (shmira-adblock.conf, from sync-adblock.sh) and applies to every phone through that forwarding.
listen-address=127.0.0.1,$OPEN_IP
# The tunnel address exists only once wg0 is up; bind it when it appears instead of failing.
bind-dynamic
no-resolv
server=1.1.1.1
server=1.0.0.1
cache-size=10000
# Strip DNS HTTPS records (type 65): they carry Encrypted Client Hello keys, and with ECH the
# phone's TLS handshake hides the real hostname behind a decoy SNI (cloudflare-ech.com) — the
# filter can neither read nor verify it, and every Cloudflare-fronted site dies with a 409.
# Without HTTPS records browsers fall back to a plain-SNI handshake.
$FILTER_RR
DNSMASQ

echo "==> STRICT resolver: $STRICT_IP (staged)"
cat > "$strict_stage" <<DNSMASQ
# The STRICT resolver (install-dns-policy.sh): what every phone's tunnel config names as its DNS.
# Refuses the in-app picture hosts ($STRICT_DIR/app-media.conf, from sync-media-on.sh) and
# forwards everything else, UNCACHED, to the open instance on 127.0.0.1 — one cache for phones and
# squid alike. Phones whose rung allows the pictures never reach this instance (DNAT, ipset).
port=53
listen-address=$STRICT_IP
bind-dynamic
no-resolv
no-hosts
server=127.0.0.1
cache-size=0
dns-forward-max=1000
$FILTER_RR
conf-dir=$STRICT_DIR,*.conf
DNSMASQ

cat > "$UNIT_STRICT" <<UNIT
[Unit]
Description=Shmira strict DNS resolver for the phones (refuses in-app picture hosts)
After=network-online.target wg-quick@wg0.service dnsmasq.service
Wants=wg-quick@wg0.service dnsmasq.service
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStartPre=/usr/sbin/dnsmasq --test --conf-file=$STRICT_CONF
ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=$STRICT_CONF --pid-file=/run/shmira-dnsmasq-strict.pid
ExecReload=/bin/kill -HUP \$MAINPID
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Policy plumbing (address, ipset, DNAT, 853)"
install -m 755 "$HERE/dns-policy-up.sh" /usr/local/bin/shmira-dns-policy.sh
cat > "$UNIT_POLICY" <<UNIT
[Unit]
Description=Shmira DNS policy: open-resolver address, media-on ipset and DNAT
After=wg-quick@wg0.service
BindsTo=wg-quick@wg0.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/shmira-dns-policy.sh up
ExecStop=/usr/local/bin/shmira-dns-policy.sh down

[Install]
WantedBy=wg-quick@wg0.service
UNIT

echo "==> Sync scripts"
install -m 755 "$HERE/sync-media-on.sh" /usr/local/bin/sync-media-on.sh
install -m 755 "$HERE/sync-adblock.sh" /usr/local/bin/sync-adblock.sh
cat > /etc/cron.d/shmira-adblock <<'CRON'
41 3 * * * root /usr/local/bin/sync-adblock.sh >> /var/log/shmira-adblock.log 2>&1
CRON
chmod 644 /etc/cron.d/shmira-adblock

echo "==> Parse both configs before touching anything live"
dnsmasq --test --conf-file="$strict_stage"
# The open instance's config as the packaged unit will read it: /etc/dnsmasq.conf plus the
# conf-dir with the staged shmira.conf standing in for the live one. Mirror the packaged unit's
# conf-dir semantics exactly — every file NOT ending .dpkg-{dist,old,new}, not just *.conf — so a
# stray file (e.g. an old backup) that would break the live start also breaks this test.
stage_d="$stage/dnsmasq.d"; mkdir -p "$stage_d"
find /etc/dnsmasq.d -maxdepth 1 -type f \
  ! -name '*.dpkg-dist' ! -name '*.dpkg-old' ! -name '*.dpkg-new' ! -name 'shmira.conf' \
  -exec cp {} "$stage_d/" \; 2>/dev/null || true
cp "$open_stage" "$stage_d/shmira.conf"
dnsmasq --test --conf-file=/etc/dnsmasq.conf --conf-dir="$stage_d,.dpkg-dist,.dpkg-old,.dpkg-new"

echo "==> Switch (rolled back on any failure)"
[[ -f "$backup" ]] || cp "$OPEN_CONF" "$backup"
systemctl daemon-reload
switched=1
install -m 0644 "$strict_stage" "$STRICT_CONF"
systemctl enable --now shmira-dns-policy.service      # the $OPEN_IP address, the ipset, the DNAT rules
install -m 0644 "$open_stage" "$OPEN_CONF"
systemctl restart dnsmasq                             # now on 127.0.0.1 + $OPEN_IP
systemctl enable --now shmira-dnsmasq-strict.service  # now on $STRICT_IP
sleep 1
dig +short +time=3 +tries=1 @127.0.0.1 example.com | grep -q .     || { echo "!! OPEN resolver (127.0.0.1) does not answer" >&2; false; }
dig +short +time=3 +tries=1 @"$STRICT_IP" example.com | grep -q . || { echo "!! STRICT resolver ($STRICT_IP) does not answer" >&2; false; }
trap - ERR
rm -rf "$stage"

echo "==> First syncs (failures here are not fatal: cron retries, and the seed list is in place)"
/usr/local/bin/sync-media-on.sh || echo "    !! media-on sync failed — the picture list and ipset stay as they were" >&2
/usr/local/bin/sync-adblock.sh || echo "    !! ad blocklist sync failed — cron retries nightly" >&2

echo "==> Verify"
ok=1
dig +short +time=3 @127.0.0.1 example.com | grep -q . || { echo "!! OPEN resolver (127.0.0.1) does not answer" >&2; ok=0; }
dig +short +time=3 @"$STRICT_IP" example.com | grep -q . || { echo "!! STRICT resolver ($STRICT_IP) does not answer" >&2; ok=0; }
if grep -q '^local=/i.scdn.co/' "$STRICT_DIR/app-media.conf"; then
  st=$(dig +time=3 @"$STRICT_IP" i.scdn.co | awk '/status:/ {print $6}' | tr -d ',')
  [[ "$st" == "NXDOMAIN" ]] || { echo "!! STRICT should answer NXDOMAIN for i.scdn.co, got ${st:-nothing}" >&2; ok=0; }
  dig +short +time=3 @127.0.0.1 i.scdn.co | grep -q . || { echo "!! OPEN should resolve i.scdn.co" >&2; ok=0; }
fi
/usr/local/bin/shmira-dns-policy.sh status
if (( ok )); then
  echo "done. Phones: strict on $STRICT_IP; allowed phones DNAT'd to $OPEN_IP; squid on 127.0.0.1."
  echo "The previous resolver config is kept at $backup; $0 --uninstall puts it back."
else
  echo "!! a check above failed but both resolvers answer. To fall back to one resolver: $0 --uninstall" >&2; exit 1
fi
