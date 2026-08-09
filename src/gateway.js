// Cloudflare Gateway API client — mutates the shared URL allowlist that the default-deny HTTP
// policy reads from. One list for the whole fleet: a verdict is decided once per URL (see the
// url_verdicts table) and applies to every managed phone at once.
//
// The list and the HTTP policies that reference it are created by scripts/setup-gateway.sh via
// this same API. This client, at runtime, only appends/removes items from the list.
//
// Requires env.CF_ACCOUNT_ID, env.CF_GATEWAY_LIST_ID (plain vars) and env.CF_GATEWAY_API_TOKEN
// (wrangler secret; a token with "Zero Trust: Edit" on the account).

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

async function cfFetch(env, path, options = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_GATEWAY_LIST_ID || !env.CF_GATEWAY_API_TOKEN) {
    throw new Error('Cloudflare Gateway is not configured (CF_ACCOUNT_ID / CF_GATEWAY_LIST_ID / CF_GATEWAY_API_TOKEN)');
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

// Adds a single full URL to the allowlist. Cloudflare dedupes identical item values server-side,
// so calling this twice for the same URL (a race between two phones hitting the same new site at
// once) is harmless. URLs must include the scheme (https://…) — Gateway rejects bare domains.
export async function addUrlToAllowlist(env, url) {
  return cfFetch(env, `/gateway/lists/${env.CF_GATEWAY_LIST_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ append: [{ value: url }], remove: [] }),
  });
}

export async function removeUrlFromAllowlist(env, url) {
  return cfFetch(env, `/gateway/lists/${env.CF_GATEWAY_LIST_ID}`, {
    method: 'PATCH',
    body: JSON.stringify({ append: [], remove: [url] }),
  });
}
