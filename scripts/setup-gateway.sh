#!/usr/bin/env bash
# One-time Cloudflare Gateway setup for the phone content filter.
#
# v1 enforces at the DNS layer: a DOMAIN-type allowlist plus a default-deny DNS policy. DNS
# filtering matches hostnames only — it cannot see the path of an HTTPS request — which is exactly
# why it needs no certificate, no TLS decryption and no device supervision, and why nothing breaks
# on certificate-pinned apps.
#
# What this creates:
#   1. A domain-type allowlist (if absent) and prints its id for wrangler.toml.
#   2. A default-deny DNS policy: block every lookup whose domain is not in the allowlist and isn't
#      the worker's own host (which must stay reachable so the request-access page works).
#   3. YouTube Restricted Mode + SafeSearch. Free, no certificate, and — unlike URL filtering —
#      these work inside the native apps as well as the browser.
#
# Setting ENABLE_PATH_BLOCKING=1 additionally enables TLS decryption and the full-URL HTTP policy.
# That is the deferred upgrade path, not the default: it requires installing the Cloudflare root
# certificate on every phone and maintaining a do-not-inspect list forever. See the plan.
#
# Requires: CF_ACCOUNT_ID, CF_GATEWAY_API_TOKEN (Zero Trust: Edit), WORKER_HOST.
# Optional: CF_GATEWAY_HOST_LIST_ID (reuse an existing list), CF_GATEWAY_LIST_ID (path blocking).
set -euo pipefail

: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_GATEWAY_API_TOKEN:?set CF_GATEWAY_API_TOKEN}"
: "${WORKER_HOST:?set WORKER_HOST (e.g. phone-url-filter.daniel08-madar.workers.dev)}"

API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}"
AUTH="Authorization: Bearer ${CF_GATEWAY_API_TOKEN}"
PY=python3

# Creates a Gateway rule unless one with the same name already exists. Body arrives on stdin.
create_rule_if_absent() {
  local name="$1" body
  body=$(cat)
  local exists
  exists=$(curl -s "${API}/gateway/rules" -H "${AUTH}" \
    | RULE_NAME="${name}" ${PY} -c "import sys,json,os; d=json.load(sys.stdin); print(any(r.get('name')==os.environ['RULE_NAME'] for r in (d.get('result') or [])))")
  if [ "${exists}" = "True" ]; then
    echo "   rule '${name}' already exists — skipping."
    return
  fi
  curl -s -X POST "${API}/gateway/rules" -H "${AUTH}" -H "Content-Type: application/json" -d "${body}" \
    | ${PY} -c "import sys,json; d=json.load(sys.stdin); print('   created:', d['success'], '|', (d.get('result') or {}).get('name') or d.get('errors'))"
}

echo "1/4 Ensuring the hostname allowlist exists…"
HOST_LIST_ID="${CF_GATEWAY_HOST_LIST_ID:-}"
if [ -z "${HOST_LIST_ID}" ]; then
  HOST_LIST_ID=$(curl -s "${API}/gateway/lists" -H "${AUTH}" \
    | ${PY} -c "import sys,json; d=json.load(sys.stdin); print(next((l['id'] for l in (d.get('result') or []) if l.get('name')=='Phone filter: hostname allowlist'), ''))")
fi
if [ -z "${HOST_LIST_ID}" ]; then
  HOST_LIST_ID=$(curl -s -X POST "${API}/gateway/lists" -H "${AUTH}" -H "Content-Type: application/json" \
    -d '{"name":"Phone filter: hostname allowlist","description":"Hostnames the AI or the operator approved. Mutated at runtime by src/gateway.js.","type":"DOMAIN","items":[]}' \
    | ${PY} -c "import sys,json; d=json.load(sys.stdin); print((d.get('result') or {}).get('id') or '')")
  echo "   created list."
else
  echo "   reusing existing list."
fi
[ -n "${HOST_LIST_ID}" ] || { echo "   FAILED to create or find the hostname list." >&2; exit 1; }
echo "   CF_GATEWAY_HOST_LIST_ID = ${HOST_LIST_ID}   <- paste into wrangler.toml"

echo "2/4 Creating default-deny DNS policy…"
# dns.domains holds the queried name AND each of its parent domains, so allowlisting example.com
# also admits www.example.com — which is what we want, and what a bare `dns.fqdn` match would miss.
# List references are $-prefixed list ids; the `in list("…")` form in some docs does NOT parse.
#
# VERIFY on first run: confirm the selector name and the rule is actually enforcing before handing
# out phones. A default-deny policy that silently fails open looks identical to one that works.
export TRAFFIC="not (any(dns.domains[*] in \$${HOST_LIST_ID}) or dns.fqdn == \"${WORKER_HOST}\")"
export WORKER_HOST
${PY} -c "import json,os; print(json.dumps({
  'name': 'Phone filter: default-deny DNS (allowlist only)',
  'description': 'Allow only hostnames the AI or operator approved; block every other lookup.',
  'action': 'block',
  'filters': ['dns'],
  'enabled': True,
  'precedence': 1000,
  'traffic': os.environ['TRAFFIC'],
}))" | create_rule_if_absent 'Phone filter: default-deny DNS (allowlist only)'

echo "3/4 Enabling YouTube Restricted Mode + SafeSearch…"
# Both work inside the native apps, not just browsers, and need no certificate. They do NOT remove
# YouTube Shorts or Instagram Reels — no network-layer control can. See the plan.
#
# VERIFY: action names for these two are 'ytrestricted' and 'safesearch' in the API; if the call is
# rejected, set them from the Zero Trust dashboard instead and leave this step out.
${PY} -c "print(__import__('json').dumps({
  'name': 'Phone filter: YouTube Restricted Mode',
  'action': 'ytrestricted', 'filters': ['dns'], 'enabled': True, 'precedence': 900,
  'traffic': 'any(dns.domains[*] in {\"youtube.com\" \"youtu.be\" \"googlevideo.com\"})',
}))" | create_rule_if_absent 'Phone filter: YouTube Restricted Mode'
${PY} -c "print(__import__('json').dumps({
  'name': 'Phone filter: SafeSearch',
  'action': 'safesearch', 'filters': ['dns'], 'enabled': True, 'precedence': 901,
  'traffic': 'any(dns.domains[*] in {\"google.com\" \"bing.com\" \"duckduckgo.com\" \"yandex.com\"})',
}))" | create_rule_if_absent 'Phone filter: SafeSearch'

echo "4/4 Path blocking (full-URL HTTP policy)…"
if [ "${ENABLE_PATH_BLOCKING:-0}" != "1" ]; then
  echo "   skipped (ENABLE_PATH_BLOCKING != 1) — v1 filters by hostname at DNS."
else
  : "${CF_GATEWAY_LIST_ID:?set CF_GATEWAY_LIST_ID to enable path blocking}"
  echo "   enabling TLS decryption…"
  SETTINGS=$(curl -s "${API}/gateway/configuration" -H "${AUTH}" \
    | ${PY} -c "import sys,json; d=json.load(sys.stdin); s=(d.get('result') or {}).get('settings') or {}; s['tls_decrypt']={'enabled':True}; print(json.dumps({'settings':s}))")
  curl -s -X PATCH "${API}/gateway/configuration" -H "${AUTH}" -H "Content-Type: application/json" \
    -d "${SETTINGS}" | ${PY} -c "import sys,json; d=json.load(sys.stdin); print('   tls_decrypt ->', (d.get('result') or {}).get('settings',{}).get('tls_decrypt'))"

  export TRAFFIC="not (http.request.uri in \$${CF_GATEWAY_LIST_ID} or http.request.host in {\"${WORKER_HOST}\"})"
  ${PY} -c "import json,os; print(json.dumps({
    'name': 'Phone filter: default-deny (allowlist only)',
    'description': 'Allow only URLs the AI/operator approved; block everything else and send it to the block page.',
    'action': 'block', 'filters': ['http'], 'enabled': True, 'precedence': 1000,
    'traffic': os.environ['TRAFFIC'],
    'rule_settings': {'block_page': {'target_uri': 'https://'+os.environ['WORKER_HOST']+'/blocked', 'include_context': True}}
  }))" | create_rule_if_absent 'Phone filter: default-deny (allowlist only)'
  echo "   NOTE: every phone must now trust the Cloudflare root certificate, and you own a"
  echo "   do-not-inspect list from here on."
fi

echo
echo "Done. Next:"
echo "  1. Paste CF_GATEWAY_HOST_LIST_ID into wrangler.toml and redeploy the worker."
echo "  2. Point phones at this account's DoT hostname via Private DNS (see SETUP-PHONES.md)."
