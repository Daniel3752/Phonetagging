# Next session — start here

## START HERE — finish the yeshiva temp tag (branch `claude/yeshiva-temp-tag-shiur-0kgp2f`, 2026-09-10)

Read this block first. The two older blocks below it are still true where this one is silent
(the Vortex tunnel notes, Isaac's bypass, the wiring history); where they disagree, this wins.

### What the tag is (one paragraph)

`devices.tag` ('standard' | 'yeshiva') picks the ladder. The yeshiva ladder is four rungs that
differ in their APP model (1 allowlist without Chrome, 2 allowlist with Chrome, 3 blocklist incl.
social apps, 4 blocklist) and share ONE browser: explicit + social blocklists only, no AI, every
image replaced by a grey placeholder, search keyword-screened, Google only in its text-only
"Web" mode. A `yeshiva_shiur` policy (essentials allowlist, web off) is swapped in by four
tag-wide windows Sun–Thu (07:30–08:35, 09:15–13:45, 15:35–19:15, 20:15–22:00, Asia/Jerusalem),
with a fleet toggle (Timetable / Off / Locked now) and a per-phone on/off. Full design and runbook:
`YESHIVA.md`. Console: https://phone-url-filter.daniel08-madar.workers.dev/admin → **Yeshiva** tab.

### What is DEPLOYED and PROVEN on the Vortex (10.66.0.4, tag yeshiva, rung 2)

- D1 migrations 0016, 0017, 0018 applied through the ledger. Worker deployed up to commit
  "Yeshiva tag: Google results only in text-only Web mode" — **verify** with `git log -1` on the
  Windows clone vs `npx wrangler deployments list`; if the deploy of that commit was not done,
  do it (`git pull && npx wrangler deploy`). It carries the udm=14 rule (below).
- Live `/etc/squid/squid.conf` patched IN PLACE, keeping its hand edits: helper format with
  `%>ha{Sec-Fetch-Dest}`, `deny_info …&why=%o`, `http_port 3128 name=browser`,
  `acl browser_port` right before `acl google_system_hosts`, `http_access allow
  google_system_hosts web_ports !browser_port`, `ssl_bump bump browser_port` as the second
  ssl_bump line (right after the peek). Backups beside it: `squid.conf.pre-yeshiva.*`,
  `squid.conf.bak-*`. `scripts/apply-yeshiva-squid.sh` reproduces all of it idempotently.
- Helper installed from this branch (incl. the "keep the reason on cache hits" fix).
- Headwind: configuration **"Background agent Yeshiva Temp"** (id **4**), a copy of Background
  mode, with Chrome application settings `ProxyMode=fixed_servers`,
  `ProxyServer=10.66.0.1:3128`, `DefaultSearchProviderEnabled=true`,
  `DefaultSearchProviderName=Google`, `DefaultSearchProviderKeyword=google.com`,
  `DefaultSearchProviderSearchURL=https://www.google.com/search?q={searchTerms}&hl=en&gl=il`
  — the URL must gain `&udm=14&safe=active` (step 1 below). The Vortex is on this configuration.
- Seen working on the phone: tunnel (on a borrowed hotspot; it dropped once for ~5 min and came
  back by itself), Chrome on the browser port (`chrome://policy` shows the settings), searches,
  social + explicit lists, pictures grey on Wikipedia, the Google logo grey after the
  google_system_hosts fix, the shiur lock firing on the timetable with the locked page, the fleet
  toggle Off releasing it, WhatsApp untested (never set up on this phone).
- Known and accepted: Google embeds result thumbnails in the results page itself (no image
  requests — confirmed in access.log), so image stripping cannot remove them; the udm=14 Web
  mode is the answer. Squid exits from Germany, so Google without `hl=en` answers in German with
  an EU consent page; incognito shows the consent page every time.

### What is NOT done — the finishing list, in order (updated 2026-09-10 evening)

Done today: DefaultSearchProviderEnabled row fixed in config 4 (it was mis-entered as attribute
`com.android.chrome`, so Chrome ignored the whole search-provider policy → every address-bar
search went out WITHOUT udm=14 → refused as "text-only"; the offline reproduction of the Worker's
decisions is in this session's notes and matches); social blocklist expanded 30 → 89 hosts (the
apps' API/CDN names — TikTok's feed stopped loading once synced); yeshiva app lists refreshed to
331 rules (migration **0019** — run `npm run db:migrate`); **Push apps** button on the Policies
tab writes a policy's rules into its Headwind configuration (see YESHIVA.md "Getting the app
lists onto the phones"); fleet toggle was set to **Off** for testing — put it back to Timetable.

0. **Deploy**: Windows `git pull && npm run db:migrate && npx wrangler deploy` (0019 + the push
   button are not live until this runs).
1. **Verify the search on the Vortex** after a reboot: `chrome://policy` must show
   `DefaultSearchProviderEnabled` true and the URL ending `udm=14&safe=active`; an address-bar
   search then returns text results. An `ERR_TIMED_OUT` was reported once at the end of the
   session, untraced: put the helper trace back (the python patch in the older block below),
   reproduce, and read access.log + `shmira-decision` lines.
2. **Push apps** for `Yeshiva — Rung 2` (config 4), reboot the Vortex: TikTok (installed there)
   should be uninstalled — this IS the Remove test. Then add `no_install_apps` to config 4's
   restrictions and try installing something from Play: it should refuse. Record both results.
3. **Shiur without kiosk** (operator's decision): copy config 4 → `Yeshiva Shiur`, map it in the
   Shiur row, Push apps. Read YESHIVA.md's warning first: if Remove UNINSTALLS Play apps (step 2
   tells you), the shiur policy must not Remove Play apps or they never come back.
4. Rungs 1, 3, 4: create their configurations (copies of config 4 with the restrictions the rung
   needs), map them in the Yeshiva tab, Push apps.
5. **Fleet toggle → Timetable**; watch a window boundary on the Vortex.
6. **Server housekeeping** (only once 1–5 hold): remove Isaac's nat bypass, unscope the ssl_bump
   block to the repo's, `access_log none`, reinstall the helper from the repo (drops the trace),
   `scripts/check-drift.sh` clean. Then decide when Isaac moves to the tag.
7. **Migration later**: a boy leaves the tag via Yeshiva tab → "standard 4".

### Useful commands (server)

    wg show wg0 latest-handshakes                       # 10.66.0.4's peer must move when the tunnel toggles
    tail -f /var/log/squid/access.log | grep 10.66.0.4  # HIER_DIRECT = browser port, ORIGINAL_DST = intercept (apps)
    grep -E ' (GET|POST) ' /var/log/squid/access.log | tail -30
    grep -n 'browser_port\|Sec-Fetch-Dest\|why=%o' /etc/squid/squid.conf
    scripts/apply-yeshiva-squid.sh --dry-run            # what the repo would still change

Ask the Worker what Squid asks (from the server, `source /etc/squid/filter.env` first):

    curl -sS -X POST "$SHMIRA_WORKER_URL/api/proxy/check" -H "Authorization: Bearer $SHMIRA_PROXY_KEY" \
      -H 'Content-Type: application/json' -H 'User-Agent: shmira-filter-proxy/1.0' \
      -d '{"user":"10.66.0.4","url":"https://en.wikipedia.org/","dest":"document","features":["strip_images"]}'

Tests: `npm test` (adds `test/yeshiva.test.mjs`), `npm run test:helper` (Python, the helper's
line protocol). Both green at this commit. PR #2 (`claude/gifted-ramanujan-nld0wy` → main) is
still the one to merge first; this branch contains it and merges cleanly after.

---

## START HERE — handoff from the 2026-09-01 → 09-06 session (branch `claude/gifted-ramanujan-nld0wy`)

Read this block before anything else. The rest of this file (from "What this project is" on)
is older layers of history; where they disagree with this block, this block wins.

### The one bug that explains almost everything

`external_acl_type shmira_filter` used `%LOGIN`. In Squid that token means *the authenticated
login* and makes Squid **require proxy authentication before it will call the helper**.
Intercepted (WireGuard) requests can never authenticate, so Squid denied every tunnel lookup
itself, in 0 ms, without running the helper. cache.log, with `debug_options ALL,1 82,4`:

```
aclMatchExternal: shmira_filter check user authenticated.
NOTICE: Authentication not applicable on intercepted requests.
aclMatchExternal: shmira_filter user not authenticated (DENIED)
```

Consequences, all observed: every decrypted request (searches) hit the block page; every
spliced site loaded unfiltered (Instagram, TikTok); the helper answered OK whenever run by hand;
no helper decision was ever logged. This was the Tuesday complaint ("searches blocked, sites
load"), and it is why `ssl_bump splice filter_allows` looked like it "blocked everything".

**Fix: `%un %SRC %URI`** (`%un` = a user name from any source, forces nothing, is `-` for a
tunnel phone; the helper already falls back to `%SRC`). Committed in `scripts/squid.conf` and
applied on the live server by sed (09-04 ~09:45 UTC). **NOT YET TESTED on a phone** — the Vortex
test stalled on the tunnel (below). See PROXY.md "The bug that blocked every search".

### Live server state RIGHT NOW (mdm.getshmira.com) — verify, don't assume

- **Isaac's phone (10.66.0.3) BYPASSES squid entirely**: `iptables -t nat -I PREROUTING -i wg0
  -s 10.66.0.3 -j RETURN`. Unfiltered. Remove with the same command and `-D` when the Vortex
  passes. The rule does not survive a reboot.
- `/etc/squid/squid.conf` differs from the repo in one intended way: the ssl_bump block is
  SCOPED — `acl test_phones src 10.66.0.4` (the Vortex); `splice test_phones filter_allows` /
  `bump test_phones` for it; `splice wg_phones` (old splice-by-default) for everyone else. When
  the Vortex passes, replace with the repo's unscoped block (`splice filter_allows` for all).
  Also has `%un %SRC %URI`, `concurrency=64 … queue-size=1024`, `acl worker_sni` + splice.
- **`access_log` is ON** (`/var/log/squid/access.log`) for debugging. Turn it OFF when done:
  `sed -i 's|^access_log /var/log/squid/access.log|access_log none|' /etc/squid/squid.conf && squid -k reconfigure`
- `debug_options` line was added and removed again (verify: `grep debug_options /etc/squid/squid.conf` → nothing).
- The live helper is the repo helper PLUS a one-line debug patch that writes
  `shmira-decision user=… url=… -> OK/ERR` to cache.log on every decision. Useful; remove by
  reinstalling from the repo when done. `scripts/check-drift.sh` will flag it.
- Two clones: `/opt/Phonetagging` (used by the previous session; `new-wg-phone.sh` lives there)
  and `/root/Phonetagging`. Both were pointed at this branch on 09-03. `git pull` before use.
  NEVER run `install-squid.sh` from a stale clone — it overwrites the live config.

### The Vortex test phone (Vortex V23, Android 12 Go, Headwind number 4908545443)

Done: factory reset; Device Owner set by adb (`dpm set-device-owner`) after installing
`/var/cache/tomcat9/files/hmdm-6.38-os.apk`; enrolled in the panel (device id typed into the
agent), configuration Background (Agent) Mode; CA cert installed (needed
`no_config_credentials` temporarily REMOVED from the config's restrictions — put it back, and see
"Enrolling config" below); WireGuard peer `vortex-b` = **10.66.0.4** (QR was scanned into the
app); D1 row `dev_3458aa4e` Vortex, rung 4, proxy_user `10.66.0.4`.

**Where it stalled:** the tunnel handshaked ONCE (09-04 09:39:14 UTC) and never again. The app
shows the tunnel on; `wg show wg0 latest-handshakes` shows the vortex-b key stuck at that time;
`tcpdump -ni eth0 udp port 443` (excluding Isaac's IP) saw NOTHING arriving. The phone was on a
hotspot the whole time (the building wifi's DNS is broken for this phone — old known issue). The
operator had edited the tunnel's Endpoint in the app to `2.28.63.95:443` around then.
Unresolved hypotheses, in order: (1) the hotspot is Isaac's phone, so the Vortex's packets travel
inside Isaac's tunnel and arrive from 10.66.0.3 — the tcpdump filter hid that; run
`timeout 30 tcpdump -ni any udp port 443 | head` while toggling; (2) the Endpoint edit was
mistyped / not saved; (3) phone-side key no longer matches the peer (QR from an earlier run) —
tcpdump would show packets arriving but no handshake; fix = delete tunnel in app, rescan.
First thing: ask which phone is the hotspot; get a screenshot of the tunnel screen.

**Then the actual test** (never yet run with `%un` in place): Chrome → `https://en.wikipedia.org`
(loads), search "volcano" (results), `https://www.instagram.com` (block page with a
"Rated … / Not allowed on any phone" line), Play Store / a pinned app works with no splice entry.
Then `grep shmira-decision /var/log/squid/cache.log | tail -30` shows the real decisions.
Then the full battery in `NEW-PHONE.md` §F, the Headwind lockdown (§E — this phone is where to
test `no_config_vpn`), and only then un-bypass Isaac and unscope the rule.

### Other things learned / decided this session

- Isaac's rung 1 (09-01) was the deliberate overnight hold (below), never restored. Restored to 4.
- The console (`/admin`) now edits/deletes phones and no longer offers "Never" as a phone rung;
  the API refuses an invalid device level instead of clamping to 1.
- Block page is static: "This site is blocked", host, "Rated N of 5 — note" / "Not allowed on any
  phone — note". No request button (sites are judged automatically on first visit).
- Worker: device + verdict lookups concurrent, one query for both hashes, `cache_scope` hint;
  helper caches per host + dedups a page-load burst (pool 128). Inline classification: 3 s
  fetch, 64 KB, judges by domain name if the homepage won't load. Deployed.
- Android apps do not trust a user CA → "bump all + splice exceptions" breaks every app forever.
  The intended model is `ssl_bump splice filter_allows` (ask the filter per hostname at the
  handshake: approved → splice, denied → bump so Chrome gets the block page; search engines
  and the explicit list always bumped). PROXY.md "Decrypt or pass through". UNPROVEN on a phone.
- The "Host header forgery" alerts are noise (phone DNS = 10.66.0.1 = the server's resolver).
- The "Location can be accessed" notice on managed phones = Headwind agent's location permission.
  Decide once in the configuration's location setting.
- A second Claude session was working on branch `claude/phone-filter-deployment-review-b9witi`
  (WireGuard work, NEW-PHONE.md). MERGED into this branch on 09-03. After PR #2 merges, that
  session must pull `main`; any further commits on its branch need merging by hand.
- **PR #2** (this branch → main) is open: https://github.com/Daniel3752/Phonetagging/pull/2.
  Merge when the Vortex passes. Then `cd /opt/Phonetagging && git checkout main && git pull`.
- Ideas not yet done: an "Enrolling" Headwind configuration without restrictions for phones
  mid-setup (the cert can't be installed under `no_config_credentials`); `new-wg-phone.sh`
  emitting the server IP as Endpoint (a phone whose wifi DNS is broken can't resolve the name
  before the tunnel exists); `scripts/check-drift.sh` installed via cron (not yet installed).
- Rules to stop drift: `main` is the truth; one session drives the server at a time; run
  `check-drift.sh` before and after touching the server and commit what it flags.

---

## What this project is

Remote app-control + AI web-filtering for managed Android phones, on a 1–5 "rung"
strictness ladder. Three layers:

- **Enforcement:** a self-hosted **Squid proxy with TLS interception** on the MDM box.
  It authenticates each phone by a per-device proxy login, asks the Worker for a
  verdict per request, and blocks/allows. This is the real filter. (`PROXY.md`)
- **App control + uninstall-proofing:** **Headwind MDM** (self-hosted), stock agent as
  Device Owner. (`SETUP-PHONES.md`, `FIRST-PHONE.md`)
- **Control plane:** this **Cloudflare Worker + D1** — policy store, AI classifier
  (Gemini), scheduler, `/admin` console. (`README.md`)

## Where everything is

| Thing | Location |
|---|---|
| This repo (phone tag) | `Daniel3752/Phonetagging`, branch `main` |
| Computer-tag sibling (unrelated code, same family) | `Daniel3752/Shmiras` |
| Blocklists (public) | `Daniel3752/shmiras-blocklists` — level1 = explicit (~36k), level2 = social |
| Telnyx call-fork (unrelated, split out this session) | `Daniel3752/telnyx-callfork` |
| Worker (LIVE, serves the phones) | `phone-url-filter` → https://phone-url-filter.daniel08-madar.workers.dev |
| Stray worker (auto-built from old main; NOT the live one) | `phonetagging` — ignore/clean up |
| D1 database | `phone-url-filter-db` · id `9e5b0576-7a7c-4af0-8d13-495fb9e30718` |
| Headwind MDM panel | https://mdm.getshmira.com (Ubuntu 22.04, Hetzner) |
| Squid proxy | same box, port **3128** |
| Deploy: `cd` into a local clone → `npx wrangler deploy` | main does NOT auto-deploy phone-url-filter; deploy by hand |

Secrets live as `wrangler secret` (OPERATOR_KEY, PROXY_KEY, GEMINI_API_KEY,
CF_GATEWAY_API_TOKEN, HEADWIND_USER/PASSWORD) and in `/etc/squid/filter.env` on the
server (SHMIRA_PROXY_KEY must match the Worker's PROXY_KEY). None are in the repo.

Read, in order: `README.md`, `FIRST-PHONE.md` (the authoritative phone runbook),
`PROXY.md`, `DEPLOYMENT.md` (identifiers + live state), `SETUP-PHONES.md` (older,
DNS-era — superseded by FIRST-PHONE for setup).

## State as of end of previous session

**Working and proven on a real phone (Samsung S22 Ultra, "Isaac", Headwind id IES22,
rung 4, proxy login `isaac-elbaz-samsung-phone-s22-ultra`):**
- Proxy auth, TLS interception, per-URL + per-search AI filtering, block-page redirect.
- Google account sign-in + Play Store (after exempting Google/Play/WhatsApp hosts from
  auth AND interception — see `scripts/squid.conf` `google_system_hosts` + `splice.txt`).
- Phone switched from Managed Launcher to **Background (Agent) Mode** (normal Samsung
  launcher) because rung 4 is a blocklist model, not allowlist.
- The Headwind MDM host itself is exempted from the proxy (`mdm_host` ACL) — without
  this the agent can't sync and the device goes unmanageable once the proxy is on.

**D1 facts:**
- Migration ledger reconciled: 0001–0015 all recorded. `npm run db:migrate` is safe.
- `devices` has `proxy_password` (generated per phone; `/admin` shows it + the htpasswd line).
- `app_rules`: browser/VPN/Telegram blocklist was written into rungs 2–5 this session.

## Unfinished / open items (verify each — do not assume)

1. **Worker → Headwind is NOT wired.** Every `policies.headwind_configuration_id` is
   NULL, so the scheduler cannot push app policies; app control is 100% manual in the
   Headwind panel today. The DB app_rules are aspirational until this is built. This was
   the big deferred task — see "The wiring" below.
2. **Headwind's "Block" semantics are unconfirmed.** DB inspection showed `action=1`
   (=install/allow) but a "Block" attempt did NOT produce a clean `action=2`; the UI hint
   says Block "unlinks" the app. It is UNVERIFIED whether Headwind's Block actually
   prevents a Play Store install or just stops managing the app. Confirm empirically on a
   TEST phone (block an app, see if it's actually gone/uninstallable) before trusting it
   or building sync code on it.
3. **Samsung Internet (`com.sec.android.app.sbrowser`) block was not confirmed** taking
   effect on Isaac's phone. It's a preinstalled working browser that bypasses the proxy —
   the #1 live hole. Verify it's actually blocked on the device.
4. **Restrictions** (`no_config_vpn,no_install_unknown_sources,no_safe_boot,
   no_config_credentials`) — intended for the Background config's MDM Settings (uncheck
   "Permissive mode" to enable the field). Confirm they're set. `no_config_vpn` is the
   real VPN defense; `no_install_unknown_sources` stops sideload bypass.
5. **Proxy password `bec-339-wwx` was typed in plaintext in chat** — rotate it
   (`/admin` regenerate → new htpasswd line on server → re-enter on phone).
6. **Chrome re-prompts for proxy creds after reboot/squid reload.** One re-entry is
   normal; if it's every few minutes, investigate (credentialsttl is 24h in squid.conf).
7. **Port 3128 should move to 443** before wide rollout (odd ports get blocked on some
   wifi). 443 on that box currently serves the Headwind panel — needs a 2nd IP or split.
8. **Play Store maturity-rating PIN** is the only real "block explicit apps by rating"
   control and it's on-device, not MDM (Headwind can't filter Play by rating). Decide
   whether to use it.

## The wiring (the deferred big task) — approach carefully

Goal: `/admin` sets a phone's rung; the scheduler pushes the matching Headwind
configuration AND that config's app blocklist, so new phones auto-configure.

- `src/scheduler.js` already assigns a config to a device via
  `setDeviceConfiguration(headwind_device_id, headwind_configuration_id)` — but every
  policy's config id is NULL, so it's inert.
- `src/headwind.js` can list configs + set a device's config, but has **NO** function to
  push app blocklists into a config. That must be written against the Headwind REST API
  (`/rest/private/...`; spec at `GET https://mdm.getshmira.com/rest/swagger.json`, 121
  endpoints). The app `action` enum is `[0,1,2]`; `1`=install/allow confirmed, block
  value UNCONFIRMED (see open item #2).
- **Danger:** the scheduler runs every 5 min. The moment you map a rung to a config id,
  it will act on Isaac's live phone. To activate safely, first map his rung to the
  config he is ALREADY on (a no-op re-apply), test on a THROWAWAY device/config, and only
  then expand. Do NOT do live-fire config archaeology against the one working phone.
- Recommendation from last session: build this as reviewed code with offline tests, on a
  branch, deployed inert (no config mapping), and activate deliberately with a test
  device — not against Isaac's phone.

## Hard-won gotchas (do not rediscover these)

- **Terminal paste corrupts bare `www.`/domain lines into markdown links** in this user's
  setup. When editing server files with domains, use `base64 -d | python3 -` patches or
  `nano`, never pasted heredocs of raw domains. Verify with `grep -c '\[' <file>` == 0.
- **`sudo -u postgres psql` / server commands are LINUX** — they must run in the
  `ssh root@mdm.getshmira.com` window, not the Windows `C:\` prompt. `adb` is the
  opposite — Windows PC only, where the phone is plugged in.
- Squid `access_log` is `none` by design (privacy). Turn on briefly to debug, off after.
- A Headwind config change only reaches the phone after the agent syncs; a reboot forces
  it. Launcher change (Managed→Background) also needs the phone's default Home app set to
  One UI Home (Settings → Apps → Default apps → Home).

## First actions for this session

1. Read the docs listed above.
2. Verify the live phone's actual state (open items 3, 4) rather than trusting notes.
3. Ask the user what they want to tackle: finish/verify Isaac's phone lockdown, build the
   worker→Headwind wiring properly (with a test device), or set up the next phone.
