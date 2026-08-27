> **Note:** this repo now holds two independent projects.
> `telnyx-callfork/` is a separate Cloudflare Worker (Telnyx call fork + callback) with its own
> `wrangler.toml` and README — see [`telnyx-callfork/README.md`](telnyx-callfork/README.md).
> Everything below describes the **Phone URL Filter** project at the repo root.

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
     it works (~2–5s). Decided once per URL, cached forever, applies to every phone. If the URL
     redirected, the destination is allowlisted too, so the reload doesn't land back on the wall.
   - **Not clean** → stays blocked. No notifications, no queue. If someone needs it, the operator
     allows it by hand.
   - **Nothing readable to judge** (an image, a video, a PDF, an empty body) → stays blocked, and is
     *not* cached. There is no page text, so a verdict would rest on the URL string alone;
     auto-allowing on that basis is the one mistake this filter must not make. The operator route
     is the only way through.
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
| `src/crypto.js` | SHA-256 cache keys + constant-time operator-key compare |
| `schema.sql` | D1 `url_verdicts` cache table and the `/api/verdict` rate-limit table |
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

`db:init` is idempotent (`CREATE TABLE IF NOT EXISTS`) — re-run it after pulling, so the
`verdict_rate_limit` table exists. The worker still runs without it, just unthrottled.

## Notes on the two open endpoints

`/blocked` and `/api/verdict` have to be reachable without authentication — a phone hits them before
anything has approved anything. Two consequences are handled in the worker rather than in Gateway:

- **`/api/verdict` fetches a URL you hand it.** URLs are rejected unless they are public `http(s)`:
  loopback, RFC1918, link-local (including `169.254.169.254`), unique-local IPv6, and `.local` /
  `.internal` names are all refused, so the endpoint can't be used as a proxy into anything private.
- **Each miss costs a Gemini call and a Gateway list write.** Checks are capped per source IP
  (60 per 10 minutes) via the `verdict_rate_limit` table. Cached verdicts are counted too, since a
  cached *clean* answer re-asserts the Gateway allowlist entry. The limiter fails open.

## Remaining setup (per phone, via ManageEngine)

The worker and Gateway are live. What's left is phone-side and done once per device:

1. Install the **Cloudflare root certificate** (required for TLS decryption / full-URL visibility).
2. Install + lock **WARP** so it can't be disabled.
3. **Do-Not-Inspect list** — add banking / Apple / Google service domains so certificate pinning
   doesn't break those apps. Iterative: tune as you find apps that break.
