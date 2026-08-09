# Phone URL Filter

AI-assisted web filtering for managed phones, built on **Cloudflare Gateway + a Cloudflare Worker**.
Standalone — not connected to Shmira.

## How it works

1. Phones run **Cloudflare WARP** (pushed via ManageEngine), routing all web traffic through
   **Cloudflare Gateway**.
2. Gateway **default-denies** everything: only URLs on the shared allowlist load. Everything else is
   blocked and the phone is redirected to this worker's block page.
3. The block page offers **"Check this site."** That calls the worker, which fetches the page and
   asks **Gemini** whether it's appropriate.
   - **Clean** → the full URL is added to the Gateway allowlist automatically; the user reloads and
     it works (~2–5s). Decided once per URL, cached forever, applies to every phone.
   - **Not clean** → stays blocked. No notifications, no queue. If someone needs it, the operator
     allows it by hand.
4. **Turning it off** for a phone = unenroll it in ManageEngine. No code involved.

Single-operator model: **you** are the only administrator. No per-phone accounts, guardians, SMS, or
email anywhere.

Filtering is at the **full-URL** level (each page path is judged separately), which is why TLS
decryption + the cert on each phone are required.

## Pieces

| Piece | What |
|---|---|
| `src/index.js` | Worker router: `/api/verdict`, `/api/admin/allow`, `/blocked`, health |
| `src/gemini.js` | Gemini page classifier (`classifyUrl`) |
| `src/gateway.js` | Cloudflare Gateway API client — writes the allowlist |
| `src/block-page.js` | Self-contained HTML block page |
| `schema.sql` | D1 `url_verdicts` cache table |
| `scripts/setup-gateway.sh` | One-time Gateway config (TLS decryption + default-deny policy) |

Deployed worker: `https://phone-url-filter.daniel08-madar.workers.dev`

## Operator: allow a site someone asked for

```bash
curl -X POST https://phone-url-filter.daniel08-madar.workers.dev/api/admin/allow \
  -H "Authorization: Bearer $OPERATOR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/page"}'
```

(Or add the URL directly to the Gateway allowlist in the Cloudflare Zero Trust dashboard.)

## Config

Non-secret vars live in `wrangler.toml` (`CF_ACCOUNT_ID`, `CF_GATEWAY_LIST_ID`). Secrets are set with
`wrangler secret put` and are **not** in the repo:

- `GEMINI_API_KEY` — Google Gemini key (page classification)
- `CF_GATEWAY_API_TOKEN` — Cloudflare token, scope *Account → Zero Trust → Edit*
- `OPERATOR_KEY` — bearer token gating `/api/admin/allow`

Deploy: `npm run deploy` · Apply schema: `npm run db:init`

## Remaining setup (per phone, via ManageEngine)

The worker and Gateway are live. What's left is phone-side and done once per device:

1. Install the **Cloudflare root certificate** (required for TLS decryption / full-URL visibility).
2. Install + lock **WARP** so it can't be disabled.
3. **Do-Not-Inspect list** — add banking / Apple / Google service domains so certificate pinning
   doesn't break those apps. Iterative: tune as you find apps that break.
