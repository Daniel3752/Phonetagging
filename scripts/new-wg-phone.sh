#!/usr/bin/env bash
#
# Adds one phone to the WireGuard filter tunnel: generates its keypair, assigns the next free
# tunnel IP, appends the peer to wg0.conf, hot-loads it, and prints the client config as a QR code
# to scan from the WireGuard app.
#
# The tunnel IP it prints is the phone's IDENTITY: set it as that device's proxy_user in D1
# (/admin -> Devices), or the Worker will treat the phone as unknown and lock it to the strictest
# rung. That is the whole registration — no htpasswd entry, no password.
#
# Usage:  sudo ./new-wg-phone.sh <device-name>     e.g.  sudo ./new-wg-phone.sh vortex
set -euo pipefail

WG_IF=wg0
WG_DIR=/etc/wireguard
WG_CONF="$WG_DIR/$WG_IF.conf"
WG_PORT=443
SUBNET_PREFIX=10.66.0            # must match WG_SUBNET in install-wireguard.sh
ENDPOINT_HOST=mdm.getshmira.com  # where phones reach the tunnel

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
if [[ $# -ne 1 || ! "$1" =~ ^[a-z0-9-]+$ ]]; then
  echo "Usage: sudo $0 <device-name>   (lowercase letters, digits, hyphens)" >&2; exit 1
fi
NAME=$1
[[ -f "$WG_CONF" ]] || { echo "$WG_CONF missing — run install-wireguard.sh first." >&2; exit 1; }

if grep -q "# phone: $NAME\$" "$WG_CONF"; then
  echo "A peer named '$NAME' already exists in $WG_CONF. Pick another name or remove it first." >&2
  exit 1
fi

# Next free host address: .1 is the server; peers start at .2. The `|| true` matters: with zero
# peers grep finds nothing and exits 1, which under set -e would kill the script silently.
LAST=$(grep -oE "AllowedIPs = $SUBNET_PREFIX\.[0-9]+/32" "$WG_CONF" | grep -oE '[0-9]+/32' | cut -d/ -f1 | sort -n | tail -1 || true)
NEXT=$(( ${LAST:-1} + 1 ))
if (( NEXT > 254 )); then echo "Subnet $SUBNET_PREFIX.0/24 is full." >&2; exit 1; fi
PHONE_IP="$SUBNET_PREFIX.$NEXT"

umask 077
PRIV=$(wg genkey)
PUB=$(wg pubkey <<< "$PRIV")
SERVER_PUB=$(cat "$WG_DIR/server.pub")

cat >> "$WG_CONF" <<PEER

# phone: $NAME
[Peer]
PublicKey = $PUB
AllowedIPs = $PHONE_IP/32
PEER

# Load the new peer without dropping the tunnels of every other phone.
wg syncconf "$WG_IF" <(wg-quick strip "$WG_IF")

# The client config. AllowedIPs 0.0.0.0/0 = ALL the phone's traffic enters the tunnel; that is the
# enforcement. The phone's private key exists only in this output — it is not stored on the server.
CLIENT_CONF="[Interface]
PrivateKey = $PRIV
Address = $PHONE_IP/32
DNS = 1.1.1.1

[Peer]
PublicKey = $SERVER_PUB
Endpoint = $ENDPOINT_HOST:$WG_PORT
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25"

echo
echo "=== $NAME -> $PHONE_IP ==============================================="
echo
echo "$CLIENT_CONF" | qrencode -t ansiutf8
echo
echo "Scan from the WireGuard app: + -> Scan from QR code. Or copy the config:"
echo
echo "$CLIENT_CONF"
echo
echo "======================================================================="
echo "REQUIRED: set proxy_user = '$PHONE_IP' on the '$NAME' device row in D1 (/admin -> Devices)."
echo "Then on the phone: enable the tunnel, then Settings -> VPN -> gear -> Always-on + Block"
echo "connections without VPN, and only after that apply the no_config_vpn restriction."
