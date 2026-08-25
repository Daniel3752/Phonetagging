# Phone parental-control system

Remote app control, time-window scheduling and AI-assisted web filtering for managed Android
phones. Free to run, no per-device licensing, unlimited devices.

## How it works

Three layers, each doing only what it is good at:

| Layer | Component | Role |
|---|---|---|
| **Enforcement** | [Headwind MDM](https://h-mdm.com) Community, self-hosted; the stock agent as Device Owner | App control, uninstall-proofing, locked settings |
| **Network** | A self-hosted Squid proxy with TLS interception — see [PROXY.md](PROXY.md) | Full-URL and search-query filtering |
| **Network (fallback)** | Cloudflare Gateway DNS, via Android's locked Private DNS | Hostname allow/deny |
| **Control plane** | This Cloudflare Worker + D1 | Policy store, AI classifier, scheduler, operator console |

The worker decides *what each phone should be running*; Headwind is what actually applies it.

### Levels, not allow/deny

Sites and search queries are rated 1–5 on a modesty ladder rather than judged appropriate or not,
and every device carries the rung it may see. Rating once and reusing it for everyone at or above
that rung is what keeps classification volume flat as the fleet grows. See `src/levels.js`.

A separate **doorway** flag covers sites whose function is reaching content they do not control —
search engines, image search, open user-content platforms. It overrides the rating, because such a
site's own homepage always looks harmless and allowing it allows everything behind it.

### App control

Policies are named sets of app rules, each mapped onto a Headwind configuration. A rule is one of:

- **allowed** — may be installed and used
- **blocked** — prevented from installing, removed if present
- **hidden** — stays installed but is concealed from the launcher; this is how apps the phone
  shipped with get disabled without uninstalling them

Schedules swap a device onto a different policy for a time window — "WhatsApp available 6–9pm".
Windows are expressed in **the phone's own local time**, so a fleet spread across time zones still
reads "blocked after 10pm" as each family's 10pm. A window whose end precedes its start crosses
midnight and belongs to the day it started, so a Friday-night rule is still Friday's rule at 01:00
on Saturday.

A cron trigger runs every five minutes, works out what each device should be running, and pushes
only the differences.

### Web filtering

Cloudflare Gateway default-denies DNS: only hostnames on the allowlist resolve. When someone needs a
new site they open the request page, which asks the worker; the worker fetches the site's homepage,
asks Gemini whether the **site** is appropriate, and if clean adds the hostname to the allowlist.
Decided once per site, cached forever, applied to every phone.

Filtering is at **hostname** granularity, not full-URL. That is deliberate: DNS filtering needs no
root certificate, no TLS decryption and no device supervision, and nothing breaks on
certificate-pinned apps. Full URLs are still recorded on every row and the URL-list code is kept
intact, so [turning on path blocking later](#path-blocking-deferred) is a configuration change
rather than a rewrite.

YouTube Restricted Mode and SafeSearch are enforced at DNS too. Unlike URL filtering, these work
inside the native apps.

## What this does not do

Worth knowing before promising anything to families:

- **It cannot separate YouTube Shorts, Instagram Reels, or WhatsApp Status/Channels from the rest of
  those apps.** No network filter can — in-app those are the same endpoints as ordinary content,
  behind certificate pinning. Feature-level control inside an app needs an on-device Accessibility
  service, which is not built. The app tier is all-or-nothing for these.
- **It does not enforce duration quotas** ("90 minutes of YouTube per day"). Time *windows* work;
  quotas need on-device usage accounting. See the plan's v1.5 note.
- **A factory reset removes everything.** Without an enterprise Google binding there is no
  factory-reset protection. This is a strong guardrail, not a cage.
- **A determined user can bypass DNS** via a VPN app, hardcoded resolvers, or third-party DoH. The
  app allowlist is what closes that, not the DNS layer.
- **iOS is not covered yet.** See `SETUP-PHONES.md`.

## Pieces

| Piece | What |
|---|---|
| `src/index.js` | Router, `/api/verdict`, `/admin`, cron entry point |
| `src/gemini.js` | Gemini site classifier (`classifySite`) |
| `src/gateway.js` | Cloudflare Gateway client — hostname and (dormant) URL allowlists |
| `src/policy.js` | Pure resolver: device + instant → effective policy |
| `src/scheduler.js` | Cron job that pushes policy changes to Headwind |
| `src/headwind.js` | Headwind MDM REST client (endpoints taken from the live server's Swagger spec) |
| `src/admin-api.js` | Operator API behind `/api/admin/*` |
| `src/admin-page.js` | Operator console (`/admin`) |
| `src/block-page.js` | Request-access page (`/blocked`) |
| `schema.sql`, `migrations/` | D1 schema |
| `scripts/setup-gateway.sh` | One-time Gateway config |
| `test/` | Offline test suite |

## Running it

```bash
npm install
npm test          # fully offline: no network, no credentials, no wrangler
npm run deploy
npm run db:init   # fresh database
npm run db:migrate
```

Gateway setup, once:

```bash
CF_ACCOUNT_ID=… CF_GATEWAY_API_TOKEN=… WORKER_HOST=… ./scripts/setup-gateway.sh
```

It prints `CF_GATEWAY_HOST_LIST_ID` to paste into `wrangler.toml`.

Phone setup is in **`SETUP-PHONES.md`**.

## Config

Non-secret vars are in `wrangler.toml`. Secrets are set with `wrangler secret put` and are **not** in
the repo:

- `GEMINI_API_KEY` — Google Gemini key (site classification)
- `CF_GATEWAY_API_TOKEN` — Cloudflare token, scope *Account → Zero Trust → Edit*
- `OPERATOR_KEY` — bearer token gating `/api/admin/*` and the console
- `HEADWIND_API_TOKEN` — or `HEADWIND_USER` + `HEADWIND_PASSWORD`

## Operating it

Everything is in the console at `/admin` — paste the operator key to unlock. For scripting:

```bash
curl -X POST "$WORKER/api/admin/allow" \
  -H "Authorization: Bearer $OPERATOR_KEY" -H "Content-Type: application/json" \
  -d '{"url":"example.com"}'

curl -X POST "$WORKER/api/admin/revoke" \
  -H "Authorization: Bearer $OPERATOR_KEY" -H "Content-Type: application/json" \
  -d '{"url":"example.com"}'
```

## Cost

No per-device or per-seat licensing anywhere.

| Item | Cost |
|---|---|
| Cloudflare Workers, D1, Gateway DNS | $0 |
| Gemini Flash-Lite | cents/month — one call per site, cached forever |
| Headwind MDM server (VPS) | $5–6/month, the only real line item |
| Domain | ~$12/year |

Roughly **$75–100/year for the whole fleet**. Two ceilings: Cloudflare's free DNS query allowance
works out to a few hundred devices, and a $6 VPS scales to hundreds of phones, not thousands.

## Path blocking (deferred)

Full-URL filtering — allowing `example.com/a` while blocking `example.com/b` — requires TLS
decryption, which means installing the Cloudflare root certificate on every phone and maintaining a
do-not-inspect list forever, since every certificate-pinned app breaks until exempted.

The code is kept ready for it: `url_verdicts` retains full URLs under `scope='url'`, the URL-list
functions in `src/gateway.js` are intact, and `scripts/setup-gateway.sh` will create the HTTP policy
under `ENABLE_PATH_BLOCKING=1`. Enabling it is an afternoon of configuration; the ongoing
maintenance is the real cost, which is why it is off by default.
