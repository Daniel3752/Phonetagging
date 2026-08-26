# Build Plan — Five-Rung Levels, Search/Image Filtering, Blocklists, App Policies

Status: **BUILT (offline), not deployed.** The mechanism below is implemented and unit-tested; the
live D1 is migrated. The Worker is NOT redeployed and the phone is untouched — deployment waits on
the two deferred content pieces. Read `PROXY.md` first for the architecture this builds on.

## Build status

**Done (offline-tested, live D1 migrated):**
- `levels.js` — five mode-based rungs, `NEVER=6`; `keywords.js` — pure search pre-filter; `proxy-api.js` — new decision order; `search.js` — `isSearchEngineHost`; `gemini.js` — temporary AI-rating bridge (prompt wording untouched).
- Schema + `migrations/0006` (five rungs, `site_mode`, `keyword_rules`, `app_image_blocklist`, NEVER 5→6) and `0007` (five app policies + rung→policy map) — **applied to live D1**. Seed regenerated with `site_mode` and reseeded live (48 trusted / 41 filtered).
- Squid helper — L1/L2 blocklist suffix-match + `sync-blocklists.sh` + installer/cron wiring.
- `policy.js` — `appPolicyIdForLevel`; five empty per-rung app policies.
- All suites green: `npm test` (levels 29, keywords 8, search 25, proxy 24, policy, smoke, control-plane, admin-levels).

**Deferred — the two the operator asked to hold for a longer discussion:**
- **AI instruction / rubric content.** The `gemini.js` prompts still speak the old 1..5 ladder; the bridge keeps it safe, but the rubric must be rewritten to the 6-point scale (and the bridge removed) **before deploy**. Same bucket: the **keyword term lists** (`keyword_rules` is empty).
- **App allow-lists.** The five app policies are empty; which apps per rung, how the scheduler feeds Headwind, and `app_image_blocklist` enforcement (Spotify) are unbuilt.

**Not yet done (needed before the Worker is deployed):**
- Redeploy the Worker (`wrangler deploy`) — only after the rubric rewrite.
- **Reconsider `dev_vortex`'s rung**: level 2 now means *Text-only* (was *General*). The live device is still level 2 — decide its real rung before deploy or the phone tightens unexpectedly.

**Deviations from the original plan below, all deliberate:**
- Search is judged **before** the per-site mode (not after), so a `trusted` search engine can't skip query filtering.
- An unknown device degrades to **rung 1 = no web** (the new strictest), not to a minimal allowlist.
- Search-engine *homepages* are allowed in `proxy-api.js` (where search is on), not via `isVisibleAtLevel`.

---

Original plan follows. Read `PROXY.md` first for the architecture this builds on.

Companion repo: **`Daniel3752/shmiras-blocklists`** — the auto-updated domain blocklists this plan
consumes (see §5).

---

## 0. Two interpretations to confirm before coding

I resolved two ambiguities while writing this. Both are consequential; correct me if either is wrong.

1. **Rung 2 shares rung 3's allowlist, minus images.** Rung 2 ("text-only") is the same Essential
   allowlist as rung 3, with images stripped and stricter search — not a smaller site set. Its
   defining feature is *no images*, not *fewer sites*.
2. **The deny/allow line sits between rung 3 and rung 4.** Rungs 1–3 are **deny-by-default**
   (allowlist; unknown site → blocked). Rungs 4–5 are **allow-by-default** (blocklist; unknown site →
   allowed unless it's on a blocklist). This follows directly from your blocklist mapping (rungs 1–4
   apply L1+L2, rung 5 applies L1 only) plus "rung 4 = basically everything besides social/explicit."
   It means rung 4 is *permissive*, not a big allowlist. This is the single biggest safety property
   of the system — the jump from 3 to 4 is where "nothing unless approved" becomes "everything unless
   blocked."

---

## 1. The locked model

Rungs, 1 = strictest → 5 = most open. The device carries one `level`; it drives web tier **and** app
policy together.

| # | Name | Web enforcement | Text search | Image search | Images shown | Blocklists | Apps |
|---|------|-----------------|-------------|--------------|--------------|------------|------|
| 1 | No browser | none (no web at all) | — | — | — | — | apps only, no browser |
| 2 | Text-only | allowlist (Essential) | strict | off | **no** | L1+L2 | + basic productivity |
| 3 | Essential | allowlist (Essential) | strict | AI query + SafeSearch | yes | L1+L2 | + Torah/essential |
| 4 | General | **permissive** (allow-by-default) | filter immodest+explicit | AI query + SafeSearch | yes | L1+L2 | productivity, no social |
| 5 | Open | **permissive** (allow-by-default) | filter explicit only | AI query + SafeSearch | yes | **L1 only** | all but explicit/dating |

Shared machinery: per-site modes, keyword pre-filter, forced SafeSearch, suffix-matched blocklist
sync, five app policies. Detailed below.

**Rating ladder change.** Today `levels.js` has device levels 1–4 and `NEVER_LEVEL = 5`. The device
can now be on rung 5, so "blocked at every rung including 5" needs a sentinel **above** 5. Plan:
device levels 1–5; site/search ratings stay 1–5 meaning "minimum rung that may see this"; **NEVER
becomes 6** (or, equivalently, `verdict='blocked'` regardless of `level`). Explicit content is NEVER
at every rung — enforced primarily by the L1 blocklist, with the rating as the cache record.

---

## 2. Decision order (the request path)

Every request through `/api/proxy/check` (and its local fast-path in the Squid helper) resolves in
this order. First match wins.

1. **Rung 1?** → deny all web (there is no browser anyway; belt-and-suspenders).
2. **Blocklist (suffix match).** Hostname or any parent domain in L1 → deny (all rungs). In L2 →
   deny on rungs ≤ 4. This is the cheap local check; see §5.
3. **Per-site mode** (if the host has a `url_verdicts` row):
   - `blocked` → deny.
   - `trusted` → allow the whole host, no further judging.
   - `filtered` → fall through to search/path judging below.
4. **Search URL?** (`parseSearchUrl`)
   - **Image search** and rung ∈ {1,2} → deny (no images at these rungs).
   - Otherwise rate the **query** (keyword pre-filter → AI, §4). Allow if `rating ≤ rung`.
   - Image search additionally relies on **forced SafeSearch** (§6) for the pixels the query check
     can't see.
5. **Ordinary site:**
   - Deny-by-default rungs (2,3): allow only if an allowlist row rates the host `≤ rung`; else
     `action:'unknown'` (block page offers to request it).
   - Allow-by-default rungs (4,5): allow (blocklist already cleared it above). Unknown hosts are
     allowed; the classifier may still rate them async for the console.

---

## 3. Schema (migration `0006_five_rungs.sql`, then follow-ups)

`0005_seed_allowlist.sql` already exists (the seed). Next migrations:

- **`level_definitions` — redefine as 5 rungs with mode columns.** Add: `web_mode TEXT`
  ('none' | 'allowlist' | 'permissive'), `images_allowed INTEGER`, `image_search TEXT`
  ('off' | 'filtered'), `apply_social_blocklist INTEGER` (L2 on/off), `search_reason TEXT`.
  Replace the current 4 rows with 5. `levels.js` stays the semantic source of truth (§4).
- **`devices.level`** — widen the clamp to 1–5 (`MAX_DEVICE_LEVEL = 5`).
- **`url_verdicts` — add `site_mode TEXT DEFAULT 'filtered'`** ('trusted' | 'filtered' | 'blocked').
  Backfill: existing seed rows → 'trusted' for infra + obvious whole-site allows; leave mixed
  retail/UGC as 'filtered'. Extend the seed generator (`scripts/build-allowlist-seed.mjs`) to emit
  `site_mode` per entry.
- **`keyword_rules`** — new table: `(id, scope TEXT['search'|'site'], lang TEXT['en'|'he'|'yi'],
  pattern TEXT, action TEXT['block'|'allow'], min_rung INTEGER, note TEXT)`. Drives the pre-filter.
- **`app_rules`** already exists — no schema change; we add data (§7).
- **`app_image_blocklist`** — new table: `(package_name TEXT, image_host TEXT)` for the per-app
  image-host stripping (§8). Code now, data/testing after enrolment.
- **NEVER sentinel** — bump `NEVER_LEVEL` to 6 in `levels.js`; migration backfills nothing (ratings
  ≤5 unchanged; explicit stays `verdict='blocked'`).

Blocklist domains do **not** go in D1 as 35k rows (exact-match can't do suffix). They live where
suffix matching is cheap — see §5.

---

## 4. `levels.js` + `gemini.js`/`search.js` — the logic

- **`levels.js`**: replace the monotonic `LEVELS` array with 5 rung definitions carrying the mode
  fields from §3. Rewrite `isVisibleAtLevel` to branch on `web_mode`: 'none' → false; 'allowlist' →
  `rating ≤ rung`; 'permissive' → true (blocklist handled upstream). Keep it pure/testable (its whole
  point). `normalizeDeviceLevel` clamps to 1–5.
- **Keyword pre-filter** (new, pure module `keywords.js`): given a query + rung, return
  `block` / `allow` / `unknown` from `keyword_rules`. Block-list → instant deny (rating = NEVER).
  Allow-list → instant allow (rating = 1). `unknown` → fall through to AI. Multilingual (EN/HE/YI)
  from day one — the audience types in all three. Keywords are a fast pre-filter, **not** the whole
  judgment; AI remains the backstop and false positives are expected (document them).
- **`classifySearchQuery`** (`gemini.js`): call the keyword pre-filter first; only hit the model on
  `unknown`. Cache as today in `search_verdicts`. Prompt already returns a 1–5 rating — good, that
  gives per-rung strictness for free (a query rated 4 passes at rungs 4–5, fails ≤3).
- **Image search**: `parseSearchUrl` already flags `isImageSearch` (via `udm=2` etc.). Route
  image-search queries through the same rating; enforce the rung {1,2} → off rule in `proxy-api.js`.

---

## 5. Blocklist integration (from `shmiras-blocklists`)

The repo already ships: `blocklists/level1.json` (~35.8k explicit domains, **daily** auto-update via
GitHub Actions) and `blocklists/level2.json` (~30 social domains, manual). Served from
`raw.githubusercontent.com`.

- **Enforce in the Squid ACL helper** (`scripts/squid-acl-helper.py`), *before* it calls the Worker.
  Load both lists into in-memory `set`s on start; **suffix-match** the request hostname and every
  parent domain (block if any suffix hits). Sub-millisecond, offline, zero D1/AI cost. L1 applies at
  all rungs; L2 applies at rungs ≤ 4 (helper knows the rung from the proxy user → device level).
- **Daily sync on the server**: a cron `curl` of the two raw URLs into `/etc/squid/blocklists/`,
  then reload the helper (or the helper stats-and-reloads the file each N minutes). Keep the 24h
  cadence the repo already runs on.
- **Do not** mirror 35k rows into D1. If the Worker ever needs the check itself, use a KV namespace
  keyed by domain and probe hostname + parents (≤4 reads) — but the helper-local set is the primary.
- **Honest limitation** (document in the console): the list is built by keyword-matching *domain
  names*, so it has false positives (`essex`, `middlesex`) and misses randomly-named porn domains
  until a public feed flags them (1–7 days). It's a **backstop for the permissive rungs**, not an
  airtight wall — which is exactly why rungs 1–3 stay allowlist-based.

---

## 6. Proxy rules: images + SafeSearch (mostly `squid.conf` + Headwind)

- **Text-only (rung 2) image blocking** — two layers, we have Headwind so use both:
  - Chrome managed config `DefaultImagesSetting = 2` pushed via Headwind (clean, Chrome-native).
  - Proxy: deny image content-types / image extensions for rung-2 users (browser-agnostic backstop).
  - Caveat to document: won't strip inline `data:` images or CSS backgrounds; may blank icon buttons.
- **Forced SafeSearch (rungs 3–5)** — map Google/Bing to their SafeSearch VIPs
  (`forcesafesearch.google.com`, `strict.bing.com`) at the proxy, so explicit **image results** are
  filtered server-side. This is what makes image search acceptable; the AI query check can't see
  pixels. Apply as a baseline wherever images are on.
- **QUIC off** — push `QuicAllowed:false` via Headwind so app/image traffic can't bypass Squid over
  UDP/HTTP3. Required for both rung-2 image blocking and app image stripping (§8) to be reliable.

Residual gap to state plainly: SafeSearch filters *explicit*, not *immodest-but-not-explicit*. A
clean query ("summer dresses") returns images SafeSearch won't strip. Accepted at rungs 3–5; the AI
query filter is stricter at rung 3 than rung 5.

---

## 7. App policies (five, via existing `app_rules` + Headwind)

- Create five policies (`policies` rows), one per rung; the device's `level` selects both its web
  tier and its app policy. Wire the level→policy mapping into the scheduler/`policy.js` (today it
  resolves a policy per device; extend so the baseline policy follows the rung).
- Populate `app_rules` per rung (allowed/blocked/hidden). Rung 1: hide **every** browser and webview
  browser (Chrome, Samsung Internet, Firefox, …) **and** block installing new apps — otherwise it's a
  30-second workaround. Managed launcher shows only permitted apps.
- **Blocked on re-enrolment**: none of this pushes until Headwind is reinstalled and
  `dpm set-device-owner com.hmdm.launcher/.AdminReceiver` is re-run on the Vortex (only works before
  any account is added). The *code/data* is buildable now; enforcement waits.

---

## 8. Per-app image stripping (code now, test after enrolment)

- Build the `app_image_blocklist` table + proxy rule: for a device on a rung with images allowed, if
  a request is to a listed app's image host, deny it (audio/API hosts pass). Gated behind QUIC-off.
- **Spotify is candidate #1** — album/artist art is `i.scdn.co` (+ related image CDNs); audio is
  separate hosts. In principle: block the image CDNs, keep audio.
- **Cannot be validated from here.** Requires the enrolled phone: confirm (a) Spotify's traffic
  actually traverses the proxy, (b) the image hosts TLS-bump instead of certificate-pinning,
  (c) audio still plays with images blocked, (d) the app doesn't hard-error. Spotify pins its certs;
  this may not work. **Fallback**: if it pins, the only control is the app policy — allow or don't.
- Deferred phone task (§10). Ship the mechanism; prove it on-device later.

---

## 9. Build sequence

Phase A and B need **no phone** and can land now; C needs the re-enrolled Vortex.

**Phase A — data model + pure logic (offline, fully testable):**
1. `0006_five_rungs.sql` + `levels.js` rewrite (5 rungs, modes, NEVER=6) + tests.
2. `keywords.js` pre-filter + `keyword_rules` seed (EN/HE/YI starter lists) + tests.
3. `site_mode` on `url_verdicts` + seed-generator update + re-apply seed.

**Phase B — request path + blocklist + proxy (offline-testable, then server):**
4. `proxy-api.js` decision order (§2); image-search rung gate; permissive vs allowlist branch.
5. `classifySearchQuery` → keyword-first.
6. Squid helper: blocklist load + suffix match + daily sync; `squid.conf` image rule + SafeSearch VIP
   mapping. Verify on the server with the `curl -x` checks in `COMMANDS.md`.
7. `app_image_blocklist` table + proxy rule (mechanism only).

**Phase C — on the phone (after Headwind re-enrolment):** §10.

Each phase: run `npm test` (levels, search, proxy-api, admin-levels, control-plane, smoke) before
commit. Add tests alongside each new pure module.

---

## 10. Deferred phone tasks (need Headwind + Device Owner on the Vortex)

- Reinstall Headwind, re-run `dpm set-device-owner …` (the gate for everything below).
- Push the five app policies (allow/hide/block per rung); rung 1 hides all browsers + blocks installs.
- Rung 2: Chrome `DefaultImagesSetting=2`; force QUIC off.
- Force SafeSearch VIPs (rungs 3–5) — confirm on-device.
- **Try Spotify in-app image blocking** (§8): QUIC off, block `i.scdn.co`/image CDNs, verify bump (no
  pin), audio still plays, no hard error. If it pins → fall back to app policy.

---

## 11. Open risks / things to watch

- **Permissive rungs invert the safety model.** Rungs 4–5 are only as good as the blocklist, which is
  necessarily incomplete. If the operator wants rung 4 stricter, the fallback is to make rung 4
  allowlist-based (deny-by-default) like rung 3 — a one-line mode flip in `level_definitions`.
- **Keyword false positives** will block innocent queries; keep them reviewable in the console and
  lean on AI for the ambiguous middle.
- **Certificate pinning** caps what app filtering (§8) can ever do; treat in-app image stripping as
  best-effort per app, never guaranteed.
- **Exact vs suffix matching** is a real split: allowlist stays exact-host (precise), blocklist must
  be suffix (catches subdomains). Don't unify them.
- **`site_mode='trusted'` is powerful** — a trusted whole-site allow skips all per-request judging, so
  reserve it for sites with no user-reachable bad content (TorahAnytime, Sefaria, gov, infra), never
  for mixed retail/UGC.
