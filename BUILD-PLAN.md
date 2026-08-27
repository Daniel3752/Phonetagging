# Build Plan — Five-Rung Unified Filter

Status: **BUILT (offline), not deployed.** The whole model below is implemented and unit-tested; the
live D1 is migrated and seeded. The **Worker is not redeployed** and the phone is untouched —
deployment waits on the items in "Before deploy". Read `PROXY.md` for the proxy architecture this
builds on.

## The model

Five rungs, 1 = strictest → 5 = most open. The device carries one `level`; it sets the web tier and
(via `apps_rung_N`) the app policy. **Every web rung works the same way:** the AI judges each site
and each search, and it is allowed only if its rating is **at or below the rung**. One uniform gate,
the bar sliding up per rung — no manual allowlist, no allow-by-default.

| Rung | Web (rating ≤ rung) | Images | Search | Apps added |
|---|---|---|---|---|
| 1 No browser | none | — | — | 24Six |
| 2 Text-only | ratings ≤2 (essential + clean general), AI-judged | **off** | strict; image search off | + WhatsApp |
| 3 Essential | ratings ≤3 (adds broad general) | on | + image search | — |
| 4 General | ratings ≤4 (full clean web: **no shtus, no social, no explicit**) | on | + entertainment | + Spotify |
| 5 Open | ratings ≤5 (adds shtus + social) | on | explicit-only filter | + ChatGPT/Claude/Gemini |

**Rating ladder (sites and searches, 2..6):** 2 essential + clean-general · 3 broad general ·
4 entertainment/general (non-shtus) · 5 immodest/shtus (non-explicit) · **6 NEVER** (explicit,
dating, gambling, circumvention — blocked at every rung).

## How enforcement works (all built)

- **AI judges every domain**, keyed by **registrable domain** (`domains.js`) so one call covers all
  subdomains. Unknown domain on a request → classified **inline** (`classify.js`, no first-visit
  leak), cached forever. A **background pre-classifier** (`preclassify.js`, cron, ~3/tick, free-tier
  paced) walks a 109-domain common-site queue so inline stays rare.
- **Rating gate** (`levels.js` `isVisibleAtLevel`): `rating ≤ rung`, uniform. NEVER (6) blocked
  everywhere. `site_mode` `trusted`/`blocked` short-circuits (seed infra = trusted).
- **Explicit + social blocklists** (`shmiras-blocklists`, suffix-matched in the Squid helper): L1
  explicit at every rung, checked before the Worker; L2 social at rungs 1-4.
- **Keyword pre-filter** (`keywords.js`, 49 seeded rules EN+HE): instant allow/block, strictest match
  wins, model is the backstop for the rest and all languages.
- **Images:** stripped at rung 2 (proxy denies image requests); image search gated per rung.
- **Text-only search results:** a query rated "text fine, images shtus" (`images_ok=false`) returns
  `images_off`; the helper suppresses the search engine's **result-thumbnail hosts** briefly so the
  answer shows without the pictures.
- **Apps:** five per-rung policies with the matrix seeded (intent only — Headwind enforces later).

## Live D1 state (migrated + seeded)

Migrations 0006–0011 applied. `url_verdicts`: 48 trusted essential + 41 general + explicit blocks.
`level_definitions`: 5 rungs, `web_mode='web'` for 2-5. `keyword_rules`: 49. `classify_queue`: 109
pending. `app_rules`: 35 (the matrix). `search_verdicts.images_ok` added.

## Before deploy (required)

1. **Redeploy the Worker** (`wrangler deploy`) — the live Worker still runs the pre-unified code.
2. **Reconsider `dev_vortex`'s rung** — it's level 2, which now means *Text-only* (was *General*).
3. **Rewrite is done** — the AI rubric now emits the 2..6 ladder directly; no bridge remains.

## App matrix (revised again, intent only — `migrations/0013_app_rules_x_and_necessities.sql`)

34 packages seeded across the five policies (170 rows), superseding `0012`. Rung 3 stays on the
allowlist model. Rung 4 blocks explicit-content AND social-media apps. Rung 5 blocks
explicit-content apps only — social is allowed there as a native app, **except X**: unlike the rest
of the social bucket, X can surface explicit content, so it stays blocked at every rung including 5
(this reverses the `0012` call that had X following the social bucket). Added Moovit, Waze, Gett,
Wolt, PayBox, Bit (Israeli/transit/payment utilities) and 1 Second Everyday — allowed at every rung
including 1. Added a **necessities bucket** for rungs 1-3 (also allowed at 4-5): Torah apps
(Sefaria, Chabad.org) + everyday utilities (Gmail, Google Maps, Uber, Lyft) — "the necessities +
Torah apps and stuff, no shtus," allowed at every rung including 1. Several package names are
**best-guess placeholders** (24Six, Gett, Wolt, PayBox, Bit, 1 Second Everyday, all the dating apps,
and the whole necessities bucket) and must be confirmed against Headwind's real installed-apps list
at re-enrolment — the operator has no fixed opinion on exact packages for these yet.

## Deferred (needs the phone / a reviewer)

- **Headwind re-enrolment** (`dpm set-device-owner`) — gates all app enforcement.
- **App package names** — reconcile every placeholder above against the device's installed-apps list.
- **Bank app** — not yet added to the necessities bucket; no bank named yet.
- **Spotify + AI-app image stripping** — block the app image hosts; test on-device (pinning/QUIC).
  AI apps are rung-5 only; web-only on 2-4 with image-gen blocking is the honest ceiling, untested.
- **Forced SafeSearch** (rungs 3-5) — DNS VIP mapping on the phone, not a proxy rule.
- **Hebrew/Yiddish keyword block lists** — extend with a native reviewer (model covers them meanwhile).
- **QUIC off** via Headwind — needed for image stripping to be reliable.

## Deliberate deviations from the first draft of this plan

- The allowlist/permissive split was replaced by one uniform rating gate (this is the current model).
- Every web rung classifies unknown domains inline; there is no walled-garden deny.
- Search-engine homepages are allowed in `proxy-api.js` where search is on.
- `HARD_DOORWAYS` (open-content platforms) default to rung-5 (shtus) so they stay out of rungs 2-4.
