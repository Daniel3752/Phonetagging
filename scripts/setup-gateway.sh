#!/usr/bin/env bash
# One-time Cloudflare Gateway setup for the phone URL filter.
#
# Creates the account-side config the worker depends on:
#   1. Enables TLS decryption (required to see full URLs — the domain is visible without it, the
#      path is not). The Cloudflare root cert must then be installed on each phone via ManageEngine.
#   2. Creates a default-deny HTTP policy: block everything whose full URL is NOT in the allowlist
#      (and isn't the worker's own host), redirecting blocked requests to the worker's /blocked page
#      with policy context (cf_site_uri) so the block page can offer the AI check.
#
# The URL allowlist itself is created separately (it already exists — see CF_GATEWAY_LIST_ID) and is
# mutated at runtime by the worker (src/gateway.js). This script is idempotent-ish: re-running skips
# the rule if one with the same name already exists.
#
# Requires: CF_ACCOUNT_ID, CF_GATEWAY_LIST_ID, CF_GATEWAY_API_TOKEN (Zero Trust: Edit), WORKER_HOST.
set -euo pipefail

: "${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}"
: "${CF_GATEWAY_LIST_ID:?set CF_GATEWAY_LIST_ID}"
: "${CF_GATEWAY_API_TOKEN:?set CF_GATEWAY_API_TOKEN}"
: "${WORKER_HOST:?set WORKER_HOST (e.g. phone-url-filter.daniel08-madar.workers.dev)}"

API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}"
AUTH="Authorization: Bearer ${CF_GATEWAY_API_TOKEN}"

echo "1/2 Enabling TLS decryption…"
# Fetch current settings, flip tls_decrypt.enabled, patch the whole settings object back (merge-safe).
# Bail if the GET failed: an error response has no `result`, and patching the empty object it would
# produce would blank out every other Gateway setting on the account.
SETTINGS=$(curl -s "${API}/gateway/configuration" -H "${AUTH}" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('success'):
    sys.exit('   FAILED to read Gateway configuration: %s' % (d.get('errors') or d))
s = (d.get('result') or {}).get('settings') or {}
s['tls_decrypt'] = {'enabled': True}
print(json.dumps({'settings': s}))
")
curl -s -X PATCH "${API}/gateway/configuration" -H "${AUTH}" -H "Content-Type: application/json" \
  -d "${SETTINGS}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('   tls_decrypt ->', (d.get('result') or {}).get('settings',{}).get('tls_decrypt'))"

echo "2/2 Creating default-deny HTTP policy…"
RULE_NAME="Phone filter: default-deny (allowlist only)"
# Pass the rule name through the environment rather than interpolating it into the Python source —
# any quote or backslash someone adds to RULE_NAME would otherwise break the script.
EXISTS=$(RULE_NAME="${RULE_NAME}" curl -s "${API}/gateway/rules" -H "${AUTH}" \
  | RULE_NAME="${RULE_NAME}" python3 -c "
import sys, json, os
d = json.load(sys.stdin)
if not d.get('success'):
    sys.exit('   FAILED to list Gateway rules: %s' % (d.get('errors') or d))
print(any(r.get('name') == os.environ['RULE_NAME'] for r in (d.get('result') or [])))
")
if [ "${EXISTS}" = "True" ]; then
  echo "   rule already exists — skipping."
else
  # Block anything whose full URL is not in the allowlist and isn't the worker host itself (so the
  # block page + /api/verdict stay reachable even under default-deny).
  # List reference is a $-prefixed list id (hyphens kept); the `in list("…")` form the API docs
  # show does NOT parse. Set literals use {"…"}.
  export TRAFFIC="not (http.request.uri in \$${CF_GATEWAY_LIST_ID} or http.request.host in {\"${WORKER_HOST}\"})"
  export RULE_NAME WORKER_HOST
  BODY=$(python3 -c "import json,os; print(json.dumps({
    'name': os.environ['RULE_NAME'],
    'description': 'Phone URL filter: allow only URLs the AI/operator approved into the allowlist; block everything else and send it to the block page.',
    'action': 'block',
    'filters': ['http'],
    'enabled': True,
    'precedence': 1000,
    'traffic': os.environ['TRAFFIC'],
    'rule_settings': {'block_page': {'target_uri': 'https://'+os.environ['WORKER_HOST']+'/blocked', 'include_context': True}}
  }))")
  curl -s -X POST "${API}/gateway/rules" -H "${AUTH}" -H "Content-Type: application/json" \
    -d "${BODY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('   created:', d['success'], '|', (d.get('result') or {}).get('name') or d.get('errors'))"
fi

echo "Done. Next: install the Cloudflare root cert on phones via ManageEngine, then enroll them in WARP."
