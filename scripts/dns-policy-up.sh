#!/usr/bin/env bash
#
# The per-phone DNS policy plumbing, brought up and down by shmira-dns-policy.service (installed by
# install-dns-policy.sh; see the design there). Everything is idempotent — `up` twice changes
# nothing the second time — so a restart of the unit, or of wg0, can never double a rule.
#
#   up:   add 10.66.1.1/32 to wg0 (the OPEN resolver's tunnel address), create the ipset of phones
#         allowed in-app pictures, and DNAT their DNS from 10.66.0.1 (the STRICT resolver) to
#         10.66.1.1; reject DNS-over-TLS/QUIC (tcp+udp 853) inside the tunnel so a phone's Private
#         DNS setting cannot route around either resolver.
#   down: remove all of it (the ipset stays: sync-media-on.sh keeps it current and squid does not
#         read it, so an empty set costs nothing).
set -euo pipefail

WG_IF=${WG_IF:-wg0}
STRICT_IP=${SHMIRA_STRICT_DNS_IP:-10.66.0.1}     # what every phone's tunnel config names as its DNS
OPEN_IP=${SHMIRA_OPEN_DNS_IP:-10.66.1.1}         # the resolver that also answers the picture hosts
IPSET=${SHMIRA_MEDIA_ON_IPSET:-shmira_media_on}

rule() { # rule <table> <chain> <args...>  — add once (or delete, with DEL=1)
  local table=$1 chain=$2; shift 2
  if [[ "${DEL:-0}" == 1 ]]; then
    while iptables -t "$table" -C "$chain" "$@" 2>/dev/null; do iptables -t "$table" -D "$chain" "$@"; done
  else
    iptables -t "$table" -C "$chain" "$@" 2>/dev/null || iptables -t "$table" -I "$chain" 1 "$@"
  fi
}

case "${1:-}" in
  up)
    ip -4 addr show dev "$WG_IF" | grep -q " $OPEN_IP/32 " || ip addr add "$OPEN_IP/32" dev "$WG_IF"
    ipset create "$IPSET" hash:ip -exist
    for proto in udp tcp; do
      rule nat PREROUTING -i "$WG_IF" -d "$STRICT_IP" -p "$proto" --dport 53 \
        -m set --match-set "$IPSET" src -j DNAT --to-destination "$OPEN_IP"
      # DNS-over-TLS / DNS-over-QUIC to anyone outside: REJECT so Android's "Automatic" Private DNS
      # falls back to plain DNS at once instead of waiting on a timeout.
      rule filter FORWARD -i "$WG_IF" -p "$proto" --dport 853 -j REJECT
    done
    echo "dns policy up: $OPEN_IP on $WG_IF, ipset $IPSET, DNAT 53 for its members, 853 rejected"
    ;;
  down)
    for proto in udp tcp; do
      DEL=1 rule nat PREROUTING -i "$WG_IF" -d "$STRICT_IP" -p "$proto" --dport 53 \
        -m set --match-set "$IPSET" src -j DNAT --to-destination "$OPEN_IP"
      DEL=1 rule filter FORWARD -i "$WG_IF" -p "$proto" --dport 853 -j REJECT
    done
    ip -4 addr show dev "$WG_IF" 2>/dev/null | grep -q " $OPEN_IP/32 " && ip addr del "$OPEN_IP/32" dev "$WG_IF" || true
    echo "dns policy down"
    ;;
  status)
    echo "address:"; ip -4 addr show dev "$WG_IF" | grep " $OPEN_IP/32 " || echo "  (missing)"
    echo "ipset $IPSET:"; ipset list "$IPSET" 2>/dev/null | sed -n '/^Members/,$p' | sed 's/^/  /' || echo "  (missing)"
    echo "nat rules:"; iptables -t nat -S PREROUTING | grep -- "--dport 53" | sed 's/^/  /' || true
    echo "853 rejects:"; iptables -S FORWARD | grep -- "--dport 853" | sed 's/^/  /' || true
    ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
