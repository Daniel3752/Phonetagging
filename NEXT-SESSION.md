# Next session — start here

> **Update 2026-09-03 (session on branch `claude/gifted-ramanujan-nld0wy`).** Isaac's rung was
> found at 1 — that was the deliberate overnight hold described below, never restored. It is back
> at 4, identity `10.66.0.3`. Squid now asks the filter per HOSTNAME at the TLS handshake and
> splices approved hosts / bumps denied ones (`ssl_bump splice filter_allows` — see `PROXY.md`
> "Decrypt or pass through"); the old `splice wg_phones` let Instagram and TikTok through unjudged.
> The helper caches per host and dedups a page load's burst; the Worker does its lookups
> concurrently and judges an unreachable homepage by name. The console can edit/delete phones and
> no longer offers "Never" as a phone rung. Two clones exist on the server (`/root/Phonetagging`,
> `/opt/Phonetagging`) — keep them on one branch, and never run `install-squid.sh` from a stale one.
> `scripts/check-drift.sh` compares the installed files against the clone; run it before
> touching the server and after, and commit whatever it flags.
>
> **State as of 2026-09-04:** the splice-if-approved rule blocked EVERYTHING on Isaac's phone
> in live use even though the helper answered OK by hand (cause not yet found — suspected: the
> handshake lookups overflowing squid's helper queue, which fails closed). So, on the server:
> Isaac's phone (`10.66.0.3`) BYPASSES squid entirely via
> `iptables -t nat -I PREROUTING -i wg0 -s 10.66.0.3 -j RETURN` (unfiltered; the rule does not
> survive a reboot — remove with `-D` to re-enable filtering), and `squid.conf` is back on
> `ssl_bump splice wg_phones` (Tuesday's working state). The rule in this repo's `squid.conf`
> is to be proven on the **Vortex** first (`NEW-PHONE.md`, peer `vortex-b`), with the access log
> on and `grep -iE "queue|too many" cache.log`. Do not re-enable it for Isaac until then.

You are picking up a phone content-filter project mid-deployment. The **first real
phone was set up two sessions ago** and is in a user's hands. Read this whole file
before touching anything, then read the docs it points to. Do not change production
or the live phone without understanding the current state.

## Session 2026-08-29 — decisions made and what changed

A review session: code audited, live state verified, strategy settled. **Repo changes
below are committed but NOT deployed/applied** — see the runbook that follows.

**Decisions (settled with the operator; do not re-litigate):**

- **Stay on Headwind.** AMAPI direct is effectively closed to non-EMMs since Dec 2024
  (default device quota 0, partner validation, 500-device cap; usage restricted to
  commercial EMM providers). Google's new DPC allowlist (Dec 2025) blocks non-approved
  agents at enrollment — the stock `com.hmdm.launcher` currently passes; niche agents
  (Entgra, OpenMDM) are riskier, not safer. The ONE trigger to re-evaluate: if the
  Headwind "Block" test (open item 2) fails, bolt a cheap AMAPI-based EMM (TinyMDM /
  ManageEngine, ~$1.3–2/device/mo) onto the app layer only; the Squid/Worker stack
  stays regardless.
- **iOS later ≠ Entgra now.** Supervised iOS takes a global HTTP proxy **with
  credentials embedded in the profile** plus a trusted CA — the existing architecture
  ports cleanly. Start with Apple Configurator (no server) or NanoMDM beside Headwind.
  Begin Apple Business Manager / D-U-N-S paperwork early; it is slow.
- **Target architecture: per-device WireGuard, not proxy passwords.** WG server on the
  MDM box at **udp/443 — no conflict with Tomcat's tcp/443, so no second IP is needed
  and the port-3128 problem dissolves**. Device Owner sets always-on VPN + lockdown
  (configure VPN first, THEN `no_config_vpn`). Squid moves to transparent intercept;
  identity becomes the tunnel IP (`%SRC` instead of `%LOGIN`, ~dozens of lines across
  squid.conf/helper/`resolveDevice`). This kills: Chrome's per-reboot credential
  prompt (unfixable under Basic auth — Chrome never persists proxy creds), the
  raw-socket app bypass (the #1 structural hole on rungs 4–5), cross-rung credential
  sharing, and wifi port blocking. Costs: box is a full VPN concentrator (2 vCPU fine
  to ~50 phones; 20TB egress ≈ 400+ phones), server-down = phones fully offline (health
  check below becomes mandatory), WG is UDP-only (rare all-UDP-blocked networks fail
  closed). **Prove on the Vortex before touching Isaac's phone.**
- **Isaac's phone gets rebuilt ONCE, onto the final architecture** (owner has approved
  a reset) — after the Vortex proves WG + lockdown + captive portal + Block semantics.
- **No-factory-reset enrollment path to verify on the Vortex:** remove all accounts
  (data stays) → `adb shell dpm set-device-owner com.hmdm.launcher/.AdminReceiver` →
  re-add accounts. Works on most models; prove per model. Default flow for existing
  phones if it holds.
- **Spotify images are blockable at SNI** (distinct hostnames: `i.scdn.co`,
  `mosaic.scdn.co`, `image-cdn-*.spotifycdn.com`, `canvaz.scdn.co` — deny those,
  splice the audio/API hosts; verify the current list with the access log on for ten
  minutes, then off). **WhatsApp Channels are NOT blockable at the network layer**
  (client UI + channel media shares `mmg.whatsapp.net` etc. with ordinary chats,
  cert-pinned). Only real path: an on-device Accessibility watchdog app — a future
  build, high value in this market (same pattern covers Shorts/Reels).

**Repo changes this session (deploy/apply per runbook):**

1. `src/proxy-api.js` — `requireProxyKey` no longer falls back to `OPERATOR_KEY`.
   Needs a Worker deploy; `PROXY_KEY` secret is set, live Worker verified answering 401.
2. `scripts/squid.conf` — `.gstatic.com` wholesale exemption narrowed to the four
   subdomains sign-in/Play/connectivity need. This puts `encrypted-tbn*.gstatic.com`
   (Google result thumbnails) back behind auth + filter and revives the helper's
   images-off thumbnail suppression, which the blanket exemption had made dead code.
   Also: pre-auth exemptions (`google_system_hosts`, `mdm_host`) now constrained to
   ports 80/443 — they had made the box an open relay to those hosts.
3. `scripts/install-squid.sh` — splice.txt seed matches the narrowed gstatic list.
   NOTE: the installer never overwrites an existing splice.txt; the live server's copy
   must be edited by hand (runbook step 4).
4. `scripts/squid-acl-helper.py` — expired thumbnail-suppression entries are swept.
5. `scripts/health-check.sh` — NEW: cron probe proving squid + Worker + auth + helper
   end to end, with optional ntfy.sh-style webhook alerting. Install per its header.
6. `DEPLOYMENT.md` — server spec corrected (CX23, 4GB — not CPX12/2GB).

**2026-08-29, later: runbook executed with the operator. VERIFIED FACTS — do not re-test:**

- **Open item 2 ANSWERED. Headwind app removal works.** In a configuration's
  Applications tab the action set is Allow / Block / **Delete**; Delete persists as
  `action=2, remove=t` in `configurationapplications` and — proven on Isaac's live
  phone — actually UNINSTALLS a user-installed app after a sync (flashlight test app
  removed on reboot). This is the encoding the scheduler wiring must write.
  Caveats: the dialog only persists after the CONFIG's own Save button; Delete does
  NOT remove preinstalled SYSTEM apps (agent can't) — those are disabled at setup
  time over adb: `adb shell pm disable-user --user 0 <pkg>`.
- **Open item 3 ANSWERED, better than feared.** Samsung Internet does NOT bypass the
  proxy — it honours it and prompts for proxy credentials (so even live it was
  behind the filter). It is now DISABLED on Isaac's phone via `pm disable-user`
  (Headwind Delete couldn't remove it — system app).
- **Google app (`com.google.android.googlequicksearchbox`) disabled on Isaac's phone**
  via `pm disable-user`: its Discover/Assistant/Lens surfaces ride the exempted
  `.googleapis.com` hosts unfiltered, while its search function is redundant with
  filtered Chrome. Blocking it is the standing policy for rungs 1–4.
- **`no_config_vpn` verified live** on Isaac's phone (VPN add refused).
- **Steps 1, 2, 4 of the runbook are DONE**: Worker deployed (PROXY_KEY-only,
  answers 401 unauthenticated), duplicate device row deleted (2 rows remain:
  dev_vortex, dev_b73af724), new squid.conf + narrowed splice.txt applied and
  reloaded on the server. Step 3 (password rotation) deliberately SKIPPED by the
  operator (accepted risk). Step 5 (health check): installed without alerting
  (ntfy skipped). Stray `phonetagging` Worker deletion + D1/htpasswd backups:
  check with the operator before assuming done.
- **CA expiry: Aug 23 2036** (`notAfter=Aug 23 08:10:30 2036 GMT`). Operator was told
  to set a calendar reminder for early 2036.
- **Isaac's phone verification COMPLETE (2026-08-29):** sideload install refused
  (`no_install_unknown_sources` live), VPN add refused, Samsung Internet + Google app
  disabled, captive-portal probe silenced (`captive_portal_mode 0` — the phone will
  no longer auto-detect real captive portals; browser visit triggers them instead).
  `no_config_mobile_networks` was DROPPED from the restrictions by decision: it
  locked Samsung's SIM manager, and APN edits cannot bypass the global proxy anyway.
  Standing restrictions: `no_config_vpn,no_install_unknown_sources,no_safe_boot,
  no_config_credentials,no_config_private_dns,no_add_user` (+`no_debugging_features`
  only after all adb work on a phone is finished).
- Still to do: Vortex no-reset `dpm set-device-owner` test; then the scheduler wiring.

## Session 2026-08-31 — WireGuard IS LIVE on Isaac's phone (unfinished; read before touching)

The WG architecture was built AND deployed, debugged live on Isaac's S22 (owner approved).
Current phone state at session end: tunnel ON (peer `isaac-s22` = 10.66.0.3, identity via
`devices.proxy_user`), global proxy CLEARED, `no_config_vpn` REMOVED (it force-kills the tunnel
on this phone — re-adding it while the proxy is cleared = UNFILTERED internet; the lockdown/
always-on step was NOT yet done). Samsung Internet + Google app are disabled (from 08-29);
Chrome is STILL ENABLED — the phone was not physically available at session end. The
overnight hold is SERVER-SIDE: the operator was instructed to run the fail-open curl below
and then either set Isaac's device to level=1 in D1 (filter healthy: denies all web,
WhatsApp/calls unaffected) or stop squid (fail-open: kills all tunnel traffic). The operator
chose the level=1 route (`UPDATE devices SET level=1 WHERE id='dev_b73af724';` via wrangler
from the PC). Verify it took (`SELECT id, level FROM devices;`) and RESTORE `level=4` on
dev_b73af724 when resuming.

**FIRST ACTION NEXT SESSION — verify the filter is not failing open** (operator reported
"nothing being blocked" at session end, untriaged):
`curl -sk -x http://<isaac-login>:<pw>@127.0.0.1:3128 -o /dev/null -w '%{http_code}\n' https://pornhub.com`
→ 302 = fine; 200 = fail-open, drop everything and fix. Note that under splice-by-default an
on-phone "blocked site" now looks like a browser connection error, NOT the block page — the
operator's "nothing being blocked" report may have been exactly this misread, with allowed
sites loading and blocked ones erroring. Judge by the curl and by whether a blocked site
actually renders content, not by which error screen appears.

What was built/fixed today (all on the branch, all applied live):
- Shared DNS (dnsmasq on 127.0.0.1 + 10.66.0.1, phones use 10.66.0.1) — fixes intercept-mode
  host-forgery 409s (Google/Play/Gemini "no connection").
- `filter-rr=HTTPS` in dnsmasq — Chrome's ECH decoy SNI (cloudflare-ech.com) broke every
  Cloudflare site; stripping DNS HTTPS records forces plain SNI. Load-bearing.
- Splice-by-default for tunnel phones; only search engines (+ encrypted-tbn*) and
  L1-blocklist hosts are bumped (L1 bumped solely to show the block page). Pinned apps
  (Spotify etc.) now work with zero per-app splice maintenance. `.googleusercontent.com`
  spliced (Google Photos). Blocked-but-unknown HTTPS sites now surface as a browser
  connection error, not the block page — known tradeoff.
- level1.domains flattener DEDUPES shadowed subdomains — squid FATALs on overlap (this
  took squid down for ~2h tonight; symptom was "site can't be reached" everywhere).
- Helper is now THREADED (squid channel protocol, out-of-order answers) and fast-denies
  `/complete/ /gen_204 /client_204 /async/` locally — the single-threaded helper + a
  Gemini-call-per-autocomplete-keystroke overflowed squid's lookup queue, which fails
  CLOSED and presented as "all searches blocked" for two days.
- GEMINI_API_KEY secret was DEAD (old key invalidated; new-format key worked from
  operator's PC). Re-put via wrangler; verified classifying again. NOTE: the working key
  was pasted in the session chat — rotate it once stable.

Remaining to finish the migration: fail-open triage → on-phone test battery (sites,
searches, blocked site, Spotify, Photos, Play) → lockdown (Always-on + Block connections
without VPN) → decide `no_config_vpn` (verify whether it kills the tunnel even as
always-on; if yes, leave off and rely on lockdown + hidden app) → re-enable/hide apps →
health-check script should also probe the intercept path and dnsmasq (not yet done) →
rotate Gemini key + proxy password → clean up: THREE repo clones on the server
(/opt/Phonetagging is canonical; delete /opt/phonetagging and /root/Phonetagging).

**Runbook — manual steps, in order (status per the block above):**

1. Deploy the Worker: local clone → `npx wrangler deploy` (picks up change 1).
2. D1 (was permission-blocked from the session): Isaac's phone has a DUPLICATE device
   row. Delete it: `DELETE FROM devices WHERE id='dev_6f1731f5' AND proxy_user IS NULL;`
   (that row: IES22 / apps_rung_4 / Asia/Jerusalem / no proxy_user / never seen — the
   real row `dev_b73af724` stays). Must be gone before any scheduler wiring.
3. Rotate the leaked proxy password `bec-339-wwx` (open item 5): `/admin` regenerate →
   new htpasswd line on the server → re-enter on Isaac's phone.
4. Server: `install -m 644 scripts/squid.conf /etc/squid/squid.conf`; hand-edit
   `/etc/squid/splice.txt` replacing the `.gstatic.com` line with `ssl.gstatic.com`,
   `www.gstatic.com`, `fonts.gstatic.com`, `connectivitycheck.gstatic.com` (use nano —
   remember the paste-corruption gotcha); `squid -k parse`; reload. Then ON A PHONE
   test: Google sign-in, Play Store, and that image-search thumbnails now get filtered.
   A broken sign-in step = add the one subdomain cache.log names, never `.gstatic.com`.
5. Install the health check (script header has the 3 steps: monitor login + env file +
   cron). Under the future lockdown-VPN this stops being optional.
6. Isaac's phone, over adb on the Windows PC (open items 3, 4): verify Samsung
   Internet is actually blocked, and the restrictions are actually set (add
   `no_debugging_features` and `no_config_mobile_networks` to the intended list —
   Developer Options + a PC can undo the proxy; APN edits can too).
7. Vortex test battery (gates everything): Headwind "Block" semantics (open item 2) →
   `dpm set-device-owner` no-reset path → WireGuard + lockdown PoC (incl. captive
   portal behaviour) → Spotify image-host block.
8. Cloudflare dashboard: delete the stray `phonetagging` Worker (build artifact of old
   main; `phone-url-filter` is the live one).
9. Put the CA expiry date (~2036, check `openssl x509 -enddate -in
   /etc/squid/ssl/filter-ca.crt`) in a calendar that outlives this repo.
10. Backups on cron: `wrangler d1 export` of `phone-url-filter-db`, plus
    `/etc/squid/passwd`. (The CA key stays deliberately un-backed-up.)

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
