#!/usr/bin/env bash
#
# Installs the filtering proxy on the Headwind server. Idempotent — safe to re-run.
#
# Ubuntu's stock squid package is NOT built with --enable-ssl-crtd, so it cannot decrypt anything.
# This script installs squid-openssl instead, which is the same Squid with TLS interception compiled
# in. Installing plain `squid` and wondering why ssl_bump is rejected is the classic first hour lost
# to this setup.
#
# Usage:  sudo ./install-squid.sh
set -euo pipefail

SSL_DIR=/etc/squid/ssl
SPOOL=/var/spool/squid/ssl_db
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi

echo "==> Installing squid-openssl"
apt-get update -qq
apt-get install -y squid-openssl ssl-cert apache2-utils python3

echo "==> Root CA"
if [[ -f "$SSL_DIR/filter-ca.key" ]]; then
  echo "    already present, leaving it alone"
else
  "$HERE/make-ca.sh" "$SSL_DIR"
fi

echo "==> Certificate cache"
# security_file_certgen holds the certificates Squid mints per site. It must be initialised once and
# must be owned by the proxy user, which drops privileges before touching it.
if [[ ! -d "$SPOOL" ]]; then
  /usr/lib/squid/security_file_certgen -c -s "$SPOOL" -M 8MB
fi
chown -R proxy:proxy "$SPOOL" "$SSL_DIR"

echo "==> Helper"
install -m 755 "$HERE/squid-acl-helper.py" /usr/local/bin/squid-acl-helper.py

echo "==> Blocklists (explicit + social, from shmiras-blocklists)"
install -m 755 "$HERE/sync-blocklists.sh" /usr/local/bin/sync-blocklists.sh
mkdir -p /etc/squid/blocklists
# One sync now so the helper has lists on first start; then daily, after the repo's 02:00 rebuild.
/usr/local/bin/sync-blocklists.sh || echo "    initial blocklist sync failed — cron will retry"
cat > /etc/cron.d/shmira-blocklists <<'CRON'
17 3 * * * root /usr/local/bin/sync-blocklists.sh >> /var/log/shmira-blocklists.log 2>&1
CRON
chmod 644 /etc/cron.d/shmira-blocklists

# The helper needs the Worker key. Squid does not pass its own environment to helpers reliably, so
# it goes in a systemd drop-in that both squid and the helper inherit.
if [[ ! -f /etc/squid/filter.env ]]; then
  cat > /etc/squid/filter.env <<'ENV'
# Filled in by hand. SHMIRA_PROXY_KEY must match the PROXY_KEY secret set on the Worker with
# `wrangler secret put PROXY_KEY`. Without it every request is denied, which is the correct
# failure direction but an opaque one to debug.
SHMIRA_WORKER_URL=https://phone-url-filter.daniel08-madar.workers.dev
SHMIRA_PROXY_KEY=
ENV
  chmod 600 /etc/squid/filter.env
  echo "    !! /etc/squid/filter.env created — set SHMIRA_PROXY_KEY before starting"
fi

mkdir -p /etc/systemd/system/squid.service.d
cat > /etc/systemd/system/squid.service.d/filter.conf <<'UNIT'
[Service]
EnvironmentFile=/etc/squid/filter.env
UNIT

echo "==> Config"
[[ -f /etc/squid/squid.conf && ! -f /etc/squid/squid.conf.orig ]] && \
  cp /etc/squid/squid.conf /etc/squid/squid.conf.orig
install -m 644 "$HERE/squid.conf" /etc/squid/squid.conf

# Hosts tunnelled without interception, so apps that reject an installed certificate keep working.
# Starts deliberately small: on a locked-down phone there is very little installed, so the list is
# short and mostly static. It grows only when you permit another app.
#
# The .googleapis.com / .gstatic.com / accounts.google.com / android.clients.google.com /
# play.google.com / google-ohttp-relay-safebrowsing.fastly-edge.com entries exist for one reason:
# Google account sign-in and Play Store run as background system processes that cannot answer an
# interactive proxy auth prompt, so squid.conf's google_system_hosts ACL already exempts them from
# authentication — but that only decides whether a login is required, not whether ssl_bump
# intercepts the connection. Several of these (signaler-pa.googleapis.com in particular, Play
# Services' push-signaling channel) pin their certificate, so a request that no longer needs a
# login still fails if it gets bumped. Both lists have to name the same hosts, or account setup /
# Play Store breaks on one endpoint at a time as new subdomains get exercised.
if [[ ! -f /etc/squid/splice.txt ]]; then
  cat > /etc/squid/splice.txt <<'SPLICE'
# One hostname per line. A leading dot matches subdomains.
# Everything listed here is COMPLETELY unfiltered — splice only what you trust.
.whatsapp.net
.whatsapp.com
.gvt1.com
.googleapis.com
.gstatic.com
accounts.google.com
android.clients.google.com
play.google.com
google-ohttp-relay-safebrowsing.fastly-edge.com
SPLICE
fi

echo "==> Accounts"
if [[ ! -f /etc/squid/passwd ]]; then
  touch /etc/squid/passwd
  chown proxy:proxy /etc/squid/passwd
  chmod 640 /etc/squid/passwd
  echo "    no accounts yet — add one per phone:"
  echo "      htpasswd -B /etc/squid/passwd <device-name>"
  echo "    then set that name as proxy_user on the device row in D1."
fi

echo "==> Checking the config parses"
squid -k parse

systemctl daemon-reload
echo
echo "Done. Before starting:"
echo "  1. wrangler secret put PROXY_KEY        (on the Worker)"
echo "  2. put the same value in /etc/squid/filter.env"
echo "  3. htpasswd -B /etc/squid/passwd <device-name>   (one per phone)"
echo "  4. systemctl enable --now squid"
echo
echo "Then on the phone:"
echo "  adb shell settings put global http_proxy <server>:3128"
echo "  and install $SSL_DIR/filter-ca.der as a CA certificate."
echo
echo "Watch it work:  tail -f /var/log/squid/cache.log"
echo "NOTE: the access log is off by design — see the privacy section of squid.conf."
