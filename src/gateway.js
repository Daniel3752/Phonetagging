// Cloudflare Gateway API client — mutates the shared allowlists that the default-deny policies read
// from. One list per granularity for the whole fleet: a verdict is decided once (see the
// url_verdicts table) and applies to every managed phone at once.
//
// Two lists exist deliberately:
//   * a DOMAIN-type list (CF_GATEWAY_HOST_LIST_ID) read by the default-deny DNS policy. This is what
//     v1 enforces — DNS filtering matches hostnames, needs no certificate and no TLS decryption.
//   * a URL-type list (CF_GATEWAY_LIST_ID) read by the default-deny HTTP policy. Dormant in v1 and
//     kept intact so enabling path blocking later is a config change, not a rewrite. Do not delete
//     these functions because they look unused — that is the point.
//
// The lists and the policies referencing them are created by scripts/setup-gateway.sh via this same
// API. This client, at runtime, only appends/removes items.
//
// Requires env.CF_ACCOUNT_ID and env.CF_GATEWAY_API_TOKEN (wrangler secret; a token with
// "Zero Trust: Edit" on the account), plus whichever list id the called function needs.

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

async function cfFetch(env, path, options = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_GATEWAY_API_TOKEN) {
    throw new Error('Cloudflare Gateway is not configured (CF_ACCOUNT_ID / CF_GATEWAY_API_TOKEN)');
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}${path}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${env.CF_GATEWAY_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    if (res.ok) return res.json();

    const canRetry = RETRYABLE_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length;
    if (!canRetry) {
      const body = await res.text().catch(() => '');
      throw new Error(`Cloudflare Gateway API ${res.status}: ${body.slice(0, 500)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

function patchList(env, listId, { append = [], remove = [] }) {
  if (!listId) throw new Error('Cloudflare Gateway list id is not configured');
  return cfFetch(env, `/gateway/lists/${listId}`, {
    method: 'PATCH',
    body: JSON.stringify({ append: append.map((value) => ({ value })), remove }),
  });
}

// --- Hostname list (DOMAIN type) — what v1 enforces, via the default-deny DNS policy. ------------

// Cloudflare dedupes identical item values server-side, so calling this twice for the same hostname
// (two phones hitting the same new site at once) is harmless. Values are bare hostnames with no
// scheme and no trailing dot — Gateway rejects anything else in a domain-type list.
export async function addHostToAllowlist(env, hostname) {
  return patchList(env, env.CF_GATEWAY_HOST_LIST_ID, { append: [hostname] });
}

export async function removeHostFromAllowlist(env, hostname) {
  return patchList(env, env.CF_GATEWAY_HOST_LIST_ID, { remove: [hostname] });
}

// --- URL list (URL type) — dormant in v1; the path-blocking upgrade path. ------------------------

// URLs must include the scheme (https://…) — Gateway rejects bare domains in a URL-type list.
export async function addUrlToAllowlist(env, url) {
  return patchList(env, env.CF_GATEWAY_LIST_ID, { append: [url] });
}

export async function removeUrlFromAllowlist(env, url) {
  return patchList(env, env.CF_GATEWAY_LIST_ID, { remove: [url] });
}
