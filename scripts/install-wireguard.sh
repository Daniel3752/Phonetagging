#!/usr/bin/env bash
#
# Installs the WireGuard side of the filter on the proxy box. Idempotent — safe to re-run.
#
# The architecture (see WIREGUARD.md): each phone gets an always-on WireGuard tunnel to this box.
# Its tunnel IP is its identity — no proxy setting, no password, no per-reboot credential prompt —
# and iptables redirects the tunnel's web traffic into Squid's intercept ports, where the same CA,
# helper and Worker filter it exactly like the password path. QUIC is rejected inside the tunnel so
# browsers fall back to filtered TCP. Everything else NATs out so ordinary apps keep working.
#
# Listens on udp/443: UDP and TCP port spaces are separate, so this does NOT clash with the
# Headwind panel on tcp/443 — and udp/443 is the port shape (QUIC's) that guest networks block
# least. The password path on 3128 is untouched; both run side by side.
#
# Usage:  sudo ./install-wireguard.sh
set -euo pipefail

WG_IF=wg0
WG_PORT=443
WG_SUBNET=10.66.0.0/24          # must match `acl wg_phones` in squid.conf
WG_SERVER_IP=10.66.0.1
WG_DIR=/etc/wireguard
HTTP_REDIR_PORT=3129            # squid.conf http_port ... intercept
TLS_REDIR_PORT=3130             # squid.conf https_port ... intercept ssl-bump

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi

echo "==> Installing wireguard + qrencode + dnsmasq"
apt-get update -qq
apt-get install -y wireguard qrencode dnsmasq

# Shared DNS: phones and Squid must resolve hostnames IDENTICALLY, or Squid's host-forgery
# check in intercept mode kills connections whenever a CDN rotates IPs (Google/Fastly do this
# constantly -> NONE_NONE/409 in the log, "no connection" in Google apps). One dnsmasq, bound to
# loopback and the tunnel only (never the public interface -- no open resolver), serves both:
# phones get 10.66.0.1 as their tunnel DNS, squid.conf points at 127.0.0.1. Same cache, same
# answers, no mismatch.
echo "==> dnsmasq (shared resolver for phones + squid)"
cat > /etc/dnsmasq.d/shmira.conf <<'DNSMASQ'
listen-address=127.0.0.1,10.66.0.1
bind-interfaces
no-resolv
server=1.1.1.1
server=1.0.0.1
cache-size=10000
DNSMASQ
mkdir -p /etc/systemd/system/dnsmasq.service.d
cat > /etc/systemd/system/dnsmasq.service.d/after-wg.conf <<'UNIT'
[Unit]
# 10.66.0.1 only exists once wg0 is up; without this ordering dnsmasq loses the bind at boot.
After=wg-quick@wg0.service
Wants=wg-quick@wg0.service
UNIT
systemctl daemon-reload

echo "==> IP forwarding"
cat > /etc/sysctl.d/99-shmira-wireguard.conf <<'SYSCTL'
net.ipv4.ip_forward=1
SYSCTL
sysctl -p /etc/sysctl.d/99-shmira-wireguard.conf >/dev/null

echo "==> Server keys"
umask 077
if [[ ! -f "$WG_DIR/server.key" ]]; then
  wg genkey > "$WG_DIR/server.key"
  wg pubkey < "$WG_DIR/server.key" > "$WG_DIR/server.pub"
fi

# The interface NATs out of whatever carries the default route.
EXT_IF=$(ip route show default | awk '{print $5; exit}')
if [[ -z "$EXT_IF" ]]; then echo "Could not determine the external interface." >&2; exit 1; fi
echo "    external interface: $EXT_IF"

# The box's own public IP: tunnel traffic addressed to the panel (same box, tcp/443) must reach
# Tomcat directly, not be swallowed by the generic redirect into Squid — and Squid's own local
# connections to the panel need the OUTPUT redirect, since PREROUTING never sees local packets.
SERVER_IP=$(ip -4 -o addr show "$EXT_IF" | awk '{print $4}' | cut -d/ -f1 | head -1)
echo "    server public IP: $SERVER_IP"

# A pre-existing UNSCOPED tcp/443 -> 8443 redirect (the panel's) sits ahead of the wg0 rules and
# would swallow every tunneled HTTPS request. It must be scoped to the external interface:
#   iptables -t nat -R PREROUTING <num> -i $EXT_IF -p tcp --dport 443 -j REDIRECT --to-ports 8443
if iptables -t nat -S PREROUTING | grep -q -- '--dport 443 .*-j REDIRECT --to-ports 8443' && \
   ! iptables -t nat -S PREROUTING | grep -q -- "-i $EXT_IF .*--dport 443 .*8443"; then
  echo "    !! WARNING: an unscoped tcp/443->8443 redirect exists in nat PREROUTING."
  echo "       Scope it to $EXT_IF or it will swallow all tunneled HTTPS (see WIREGUARD.md)."
fi

echo "==> $WG_DIR/$WG_IF.conf"
if [[ -f "$WG_DIR/$WG_IF.conf" ]]; then
  echo "    already present, leaving it alone (peers live in it — see new-wg-phone.sh)"
else
  cat > "$WG_DIR/$WG_IF.conf" <<CONF
# The filter tunnel. Peers are appended by new-wg-phone.sh — one block per phone, the phone's
# tunnel IP doubling as its identity in the Worker (devices.proxy_user).
[Interface]
Address = $WG_SERVER_IP/24
ListenPort = $WG_PORT
PrivateKey = $(cat "$WG_DIR/server.key")

# All rules are scoped to the tunnel interface so the rest of the box (panel, 3128 path) is
# untouched. PostUp/PostDown keep them exactly as alive as the tunnel itself.
#
#  * tcp 80/443 from phones -> squid intercept ports = the filter.
#  * udp 443 rejected = no QUIC, browsers fall back to filtered TCP. REJECT, not DROP, so the
#    fallback is instant instead of waiting on a timeout.
#  * everything else NATs out, so DNS, push notifications and pinned apps just work (their TLS
#    still transits squid via the redirect and gets spliced per splice.txt).
# The panel's own public redirect (tcp/443 -> Tomcat 8443, scoped to the external interface so it
# can never swallow tunnel traffic). It lives here because nothing else on this box persists
# iptables rules across reboots — wg0 comes up at boot and recreates the whole set.
PostUp = iptables -t nat -A PREROUTING -i $EXT_IF -p tcp --dport 443 -j REDIRECT --to-ports 8443
PostDown = iptables -t nat -D PREROUTING -i $EXT_IF -p tcp --dport 443 -j REDIRECT --to-ports 8443
# Panel traffic first: requests from the tunnel to this box's own tcp/443 go straight to Tomcat
# (the Headwind agent syncing), everything else into the filter. Order matters — the specific
# rule must be appended before the generic one. The OUTPUT rule covers Squid's own locally
# generated connections to the panel, which PREROUTING never sees.
PostUp = iptables -t nat -A PREROUTING -i $WG_IF -p tcp -d $SERVER_IP --dport 443 -j REDIRECT --to-ports 8443
PostUp = iptables -t nat -A OUTPUT -p tcp -d $SERVER_IP --dport 443 -j REDIRECT --to-ports 8443
PostUp = iptables -t nat -A PREROUTING -i $WG_IF -p tcp --dport 80 -j REDIRECT --to-port $HTTP_REDIR_PORT
PostUp = iptables -t nat -A PREROUTING -i $WG_IF -p tcp --dport 443 -j REDIRECT --to-port $TLS_REDIR_PORT
PostUp = iptables -A FORWARD -i $WG_IF -p udp --dport 443 -j REJECT
PostUp = iptables -A FORWARD -i $WG_IF -j ACCEPT
PostUp = iptables -A FORWARD -o $WG_IF -m state --state ESTABLISHED,RELATED -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -s $WG_SUBNET -o $EXT_IF -j MASQUERADE
PostDown = iptables -t nat -D PREROUTING -i $WG_IF -p tcp -d $SERVER_IP --dport 443 -j REDIRECT --to-ports 8443
PostDown = iptables -t nat -D OUTPUT -p tcp -d $SERVER_IP --dport 443 -j REDIRECT --to-ports 8443
PostDown = iptables -t nat -D PREROUTING -i $WG_IF -p tcp --dport 80 -j REDIRECT --to-port $HTTP_REDIR_PORT
PostDown = iptables -t nat -D PREROUTING -i $WG_IF -p tcp --dport 443 -j REDIRECT --to-port $TLS_REDIR_PORT
PostDown = iptables -D FORWARD -i $WG_IF -p udp --dport 443 -j REJECT
PostDown = iptables -D FORWARD -i $WG_IF -j ACCEPT
PostDown = iptables -D FORWARD -o $WG_IF -m state --state ESTABLISHED,RELATED -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -s $WG_SUBNET -o $EXT_IF -j MASQUERADE
CONF
fi

echo "==> Starting"
systemctl enable --now wg-quick@$WG_IF
systemctl enable dnsmasq
systemctl restart dnsmasq
wg show $WG_IF
echo "==> dnsmasq answers:"
dig @127.0.0.1 +short google.com | head -2 || echo "    !! dnsmasq not answering — check systemctl status dnsmasq"

echo
echo "Done. Next:"
echo "  1. Make sure the new squid.conf (intercept ports + wg_phones ACL) and the updated helper"
echo "     are installed, then: squid -k parse && systemctl reload squid"
echo "  2. Add a phone: sudo ./new-wg-phone.sh <device-name>"
echo "  3. If a firewall (ufw/Hetzner cloud firewall) is active, open udp/$WG_PORT."
