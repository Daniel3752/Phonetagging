#!/usr/bin/env bash
#
# Proves the whole filtering chain is alive: squid up, Worker up, proxy auth + helper answering.
# Run from cron on the proxy box. Silent when healthy; logs and (optionally) alerts when not.
#
# Every phone fails CLOSED when this chain breaks — the fleet just loses the internet with no error
# message anyone can read. This check exists so the operator hears about it before the users do.
#
# Config, in /etc/squid/monitor.env (chmod 600):
#   MONITOR_USER / MONITOR_PASS  a real htpasswd login (make one: htpasswd -B /etc/squid/passwd monitor)
#                                with a matching D1 device row (any level; rung 1 is fine — a 302 to
#                                the block page still proves squid+helper+Worker end to end).
#   ALERT_URL                    optional. Any URL that accepts a POST body — an ntfy.sh topic
#                                (https://ntfy.sh/<your-secret-topic>) is a zero-setup choice that
#                                reaches a phone. Unset = log only.
#
# Install:
#   install -m 755 scripts/health-check.sh /usr/local/bin/shmira-health-check.sh
#   echo '*/5 * * * * root /usr/local/bin/shmira-health-check.sh >> /var/log/shmira-health.log 2>&1' \
#     > /etc/cron.d/shmira-health && chmod 644 /etc/cron.d/shmira-health
set -u

ENV_FILE=/etc/squid/monitor.env
[[ -f "$ENV_FILE" ]] && . "$ENV_FILE"

WORKER_URL=${SHMIRA_WORKER_URL:-https://phone-url-filter.daniel08-madar.workers.dev}
PROXY=127.0.0.1:3128
PROBE_URL=https://en.wikipedia.org
FAILURES=()

# 1. squid process.
if ! systemctl is-active --quiet squid; then
  FAILURES+=("squid is not active")
fi

# 2. Worker up and failing closed: /api/proxy/check with no key must answer 401.
#    (Anything else — 000, 5xx, or a 200 — is wrong and means the filter brain is broken or open.)
worker_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 10 -X POST \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' \
  "$WORKER_URL/api/proxy/check" 2>/dev/null)
if [[ "$worker_code" != "401" ]]; then
  FAILURES+=("Worker check returned ${worker_code:-nothing} (expected 401)")
fi

# 3. The full chain: an authenticated request through the proxy. 200/301 (allowed) or 302 (block
#    page) all prove auth + helper + Worker are answering; 407 means auth is broken; 000/5xx means
#    squid or the helper is. -k because curl does not trust the interception CA, and trust is not
#    what this probe is measuring.
if [[ -n "${MONITOR_USER:-}" && -n "${MONITOR_PASS:-}" ]]; then
  chain_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -k \
    -x "http://${MONITOR_USER}:${MONITOR_PASS}@${PROXY}" "$PROBE_URL" 2>/dev/null)
  case "$chain_code" in
    200|301|302) ;;
    *) FAILURES+=("proxy chain returned ${chain_code:-nothing} for $PROBE_URL (expected 200/301/302)") ;;
  esac
else
  FAILURES+=("MONITOR_USER/MONITOR_PASS not set in $ENV_FILE — chain probe skipped")
fi

# 4. The DNS layer, where install-dns-policy.sh has set it up: both resolvers answer, the strict
#    one refuses a picture host, the open one resolves it, and the plumbing is in place.
if systemctl is-enabled --quiet shmira-dnsmasq-strict.service 2>/dev/null; then
  STRICT_IP=${SHMIRA_STRICT_DNS_IP:-10.66.0.1}
  command -v dig >/dev/null 2>&1 || FAILURES+=("dig is missing (apt-get install dnsutils) — the resolver probes cannot run")
  n_hosts=$(grep -c '^local=' /etc/shmira/dnsmasq-strict.d/app-media.conf 2>/dev/null || echo 0)
  (( n_hosts >= 10 )) || FAILURES+=("the strict resolver's picture host list has only $n_hosts entries (sync-media-on.sh failing?)")
  dig +short +time=3 +tries=1 @127.0.0.1 example.com 2>/dev/null | grep -q . \
    || FAILURES+=("open resolver (127.0.0.1) not answering")
  dig +short +time=3 +tries=1 @"$STRICT_IP" example.com 2>/dev/null | grep -q . \
    || FAILURES+=("strict resolver ($STRICT_IP) not answering — the phones have no DNS")
  if grep -q '^local=/i.scdn.co/' /etc/shmira/dnsmasq-strict.d/app-media.conf 2>/dev/null; then
    st=$(dig +time=3 +tries=1 @"$STRICT_IP" i.scdn.co 2>/dev/null | awk '/status:/ {print $6}' | tr -d ',')
    [[ "$st" == "NXDOMAIN" ]] || FAILURES+=("strict resolver answers ${st:-nothing} for i.scdn.co (expected NXDOMAIN)")
  fi
  systemctl is-active --quiet shmira-dns-policy.service || FAILURES+=("shmira-dns-policy.service is not active (no DNAT for picture-allowed phones)")
  ipset list -n 2>/dev/null | grep -qx "${SHMIRA_MEDIA_ON_IPSET:-shmira_media_on}" || FAILURES+=("media-on ipset missing")
fi

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  exit 0
fi

msg="shmira filter UNHEALTHY on $(hostname) at $(date -Is):"
for f in "${FAILURES[@]}"; do msg+=$'\n  - '"$f"; done
echo "$msg"

if [[ -n "${ALERT_URL:-}" ]]; then
  curl -sS -m 10 -o /dev/null -d "$msg" "$ALERT_URL" || echo "  (alert POST to ALERT_URL also failed)"
fi
exit 1
