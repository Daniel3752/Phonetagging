# The yeshiva temp tag

A temporary, deliberately simple profile for getting the yeshiva boys' phones started before they
are migrated onto the standard five-rung ladder. Everything about it is one switch away from the
standard model: a phone carries `tag = 'yeshiva'` and a rung 1–4; give it `tag = 'standard'` and a
rung 1–5 and it is migrated. It lives in the same console — https://phone-url-filter.daniel08-madar.workers.dev/admin, **Yeshiva** tab.

## The rungs

| Rung | Apps (Headwind) | Browser (proxy) |
|---|---|---|
| 1 Apps only | **allowlist** — essentials + necessities; Chrome not on it | none |
| 2 Apps + browser | the same allowlist, **with Chrome** | the yeshiva browser |
| 3 Blocklist, no social | everything except **social, explicit/dating, other browsers, VPNs** | the yeshiva browser |
| 4 Blocklist | everything except **explicit/dating, other browsers, VPNs** (social apps allowed) | the yeshiva browser |

The app lists are `migrations/0016_yeshiva_tag.sql`, generated from `scripts/build-yeshiva-seed.mjs`
(edit the buckets there, re-run it, commit both). Package names for the stock apps are listed in
their Google/AOSP/Samsung flavours; reconcile against Headwind's installed-apps list.

**The browser is one profile at every rung that has one**, exactly as specified: "one type, no
images, no explicit sites, no social media". So rung 4's browser still blocks the social *sites*
even though the social *apps* are allowed there. If that was not the intent, flip `blockSocial` on
rung 4 in `YESHIVA_LEVELS` (`src/levels.js`) — one word.

## The yeshiva browser

- **Blocklists only, no AI in the request path.** The explicit list (level1, 36k domains) and the
  social list (level2) from `shmiras-blocklists`, applied in the Squid helper as today. On top: any
  site an operator blocked by hand or that is already on file as NEVER (a rating of 6 from any
  source) is refused. Everything else loads. No inline classification, no model call, ever.
- **Images blanked, shape kept.** Every image fetch is refused and redirected to the block page,
  which answers an image fetch (Chrome's `Sec-Fetch-Dest: image`, or an image extension) with a
  flat light-grey SVG that stretches to whatever box the page gave the picture. Layout survives;
  the picture is a grey rectangle. This works for images with no file extension too, because the
  helper forwards `Sec-Fetch-Dest` (squid.conf now passes `%>ha{Sec-Fetch-Dest}`).
- **Search:** allowed, screened by the keyword list (`keyword_rules`, e.g. `porn` → refused) and by
  anything already on file as NEVER from the standard phones; image search off; result thumbnails
  are images and get blanked like everything else. Not model-judged. Known gap: a text search for
  explicit material that dodges the keyword list returns text results (the sites themselves are
  then on the explicit list). If that matters before migration, the one-line fix is to pass
  `noModel: false` for blocklist rungs in `proxy-api.js` `rateSearch` — the model then rates every
  search and NEVER refuses it, at a model call per new query.
- **Only the browser is decrypted; no app is touched.** To blank an image the proxy has to see
  inside the connection, and Squid cannot tell an app's connection from Chrome's by hostname. So
  Chrome gets its own door: Headwind pushes Chrome a managed proxy setting pointing at Squid's
  explicit port through the tunnel (`10.66.0.1:3128`, named `browser` in squid.conf), and
  everything on that port is bumped. Apps never use it — their traffic takes the intercept path,
  where approved hosts are spliced exactly as on the standard ladder. **Nothing needs a splice
  entry.** Setup is one Chrome managed configuration in Headwind (below). If the setting is not
  applied, Chrome falls back to the intercept path: still filtered by hostname (both lists, the
  shiur lock), but images load — so verify it on the phone (chrome://policy shows the values).

## The shiur lock

"The entire phone besides essential items doesn't work during shiur." Two halves:

- **Apps:** a policy `yeshiva_shiur` — an allowlist of the essentials (phone, contacts, messages,
  WhatsApp, clock, settings, the agent and WireGuard). The scheduler swaps every yeshiva phone onto
  it inside the windows and back to its rung's policy outside them. This is the existing
  scheduler; it needs the policy mapped to a Headwind configuration (below).
- **Web:** the policy has `web_mode = 'none'`. The proxy resolves each phone's effective policy on
  every request, the same way the scheduler does, and refuses everything while the shiur policy is
  in force. The block page says "The phone is locked right now — it's shiur time". This half needs
  no Headwind and applies within a minute of the window starting (the helper's cache TTL).

**The toggle** (Yeshiva tab → Shiur lock): **Timetable** (default), **Off** (bein hazmanim, a
trip — the windows are ignored), **Locked now** (every yeshiva phone locked immediately until you
switch back). It is one setting read by both halves; changing it runs the scheduler.

The windows, Sunday–Thursday, in the phone's local time (set every yeshiva phone's zone to
`Asia/Jerusalem` — the form does this when you pick the tag):

| Window | Covers |
|---|---|
| 07:30–08:35 | Shachris (korbanos) |
| 09:15–13:45 | First seder (hachana until 11:40, then shiur), selichos, mincha |
| 15:35–19:15 | Second seder (daf 15:35 / amud 16:15), bekius review, halacha + mussar |
| 20:15–22:00 | Maariv, night seder |

Breakfast, lunch and dinner are the gaps. Each window takes the *earlier* of a "9:15/9:30"-style
start. Selichos is seasonal and folded into the second window; when the season ends either leave it
or split that window. Edit them on the Yeshiva tab; they are four ordinary schedule rows whose base
is the whole tag (`tag:yeshiva`), so one row covers every rung.

**Amud-class boys** (second seder from 16:15): on the Schedules tab add a window for *his phone
only*, "applies to" `every phone on Yeshiva`, "switch to" his rung's policy (e.g. `Yeshiva — Rung
2`), 15:35–16:15, priority 200. Device-specific and higher priority, so it wins over the tag-wide
lock for those forty minutes; the lock resumes at 16:15. `test/yeshiva.test.mjs` pins exactly this.

## Deploying it

Order matters only in that the Worker must be deployed before the migration is useful and the
server files should go together.

1. **D1:** `npm run db:migrate` (applies `0016_yeshiva_tag.sql`: three new columns, the policies,
   175 app rules, four windows). Through the ledger, never `d1 execute --file`.
2. **Worker:** `npx wrangler deploy` from a clone of this branch.
3. **Server** (`ssh root@mdm.getshmira.com`), from `/opt/Phonetagging`:
   ```
   git fetch origin && git checkout claude/yeshiva-temp-tag-shiur-0kgp2f && git pull
   sudo scripts/apply-yeshiva-squid.sh
   ```
   That script patches the LIVE `/etc/squid/squid.conf` in place (the four changed lines: helper
   format, deny_info, `name=browser`, the browser_port acl + bump rule), keeps everything else —
   the scoped `test_phones` rule and the access log included — backs the file up beside itself,
   installs the helper, parses and reconfigures. Idempotent; `--dry-run` shows the diff first.
   Do NOT run `install-squid.sh` — it would overwrite the hand edits.
4. **The phone's row** (Devices tab, Edit): Tag = Yeshiva, Rung = 2, Baseline policy follows
   (`Yeshiva — Rung 2`), Time zone `Asia/Jerusalem`, proxy login = its tunnel IP. Save.
5. **Chrome's proxy setting**, in Headwind: the phone's configuration → Applications → Chrome →
   application settings (managed configuration), add:
   ```
   ProxyMode     string   fixed_servers
   ProxyServer   string   10.66.0.1:3128
   ```
   (`10.66.0.1` is the server's address inside the tunnel, reachable only through it.) Sync the
   phone; `chrome://policy` on the phone lists both values when it took. This is per
   configuration, so put it on every configuration a yeshiva phone can be switched to (rungs and
   Shiur alike). Without it Chrome is still filtered, but images show.

From here the WEB side of the tag and the shiur lock are live for that phone. The APP side needs:

6. **Headwind configurations**, in the panel, one per yeshiva policy:
   - `Yeshiva — Rung 1..4`: copy of **Background (Agent) Mode** with the restrictions from
     NEW-PHONE.md §E; app list per the policy (Install the allowed ones; for the allowlist rungs
     Delete/hide Chrome on rung 1 and the rest of what the phone ships with that is not listed —
     Headwind's exact Block semantics are still the open item in NEXT-SESSION.md).
   - `Yeshiva — Shiur`: **kiosk mode** with the essentials as the kiosk apps (Phone, Contacts,
     Messages, WhatsApp, Clock). Kiosk is the one Headwind mechanism that reliably confines a
     phone to a list of apps as Device Owner.
   Paste each configuration's id on the Yeshiva tab (Headwind configurations card). Until then the
   scheduler reports "no Headwind configuration mapped" for yeshiva phones every five minutes —
   noisy in the audit log, harmless.
7. **Apply now** and watch the phone: inside a window the agent should sync into kiosk with the
   essentials; outside it, back to the rung's configuration. The agent polls; a reboot forces it.

## Testing on the Vortex

Prerequisite: the tunnel actually handshaking (NEXT-SESSION.md START HERE — hotspot, endpoint,
key). Then, with the Vortex on rung 2 of the tag, on the hotspot, in Chrome:

1. `https://en.wikipedia.org` — loads, **every picture a grey box of the right shape**, layout intact.
   If pictures are missing entirely (collapsed) rather than grey: the redirect to `/blocked` is
   not reaching the Worker (check the `deny_info` line). If pictures LOAD: Chrome is not on the
   browser port — `chrome://policy` on the phone should show ProxyMode/ProxyServer; on the server
   `ss -tn | grep :3128` should show the phone's tunnel IP connected.
1b. Open WhatsApp, Waze, a bank app — all work, untouched (they are on the intercept path).
2. Search "volcano" — text results, thumbnails grey. Search "porn" — the refused-search page.
3. `https://www.instagram.com` — block page (social list). `https://pornhub.com` — block page.
4. `https://www.ynet.co.il` or any never-seen site — loads (no rating, no model call; the Worker's
   logs show no classification).
5. Yeshiva tab → Shiur lock → **Locked now**: any site → "The phone is locked right now"; WhatsApp
   still works. Back to **Timetable**.
6. Move the phone to rung 1 (Yeshiva tab, "1" button): Chrome shows the block page for everything;
   move it back.
7. `scripts/check-drift.sh` clean, then the app side per step 5 above.

## Migrating a phone off the tag

Yeshiva tab → the phone's row → **standard 4** (or Devices → Edit → Tag = Standard, pick the rung).
The baseline policy switches to `apps_rung_N`, the shiur windows stop applying, and the browser
becomes the AI-judged one at that rung. Its Headwind configuration follows on the next scheduler
run if `apps_rung_N` is mapped, otherwise change it in the panel.

## What is and is not built

Built and tested offline: the tag, the ladder, the blocklist browser, image blanking, the shiur
lock on the web side, the tag-wide windows with per-phone exemptions, the console tab, the helper
and squid.conf changes, the migration.

Depends on the phone: Chrome honouring the pushed ProxyMode/ProxyServer (a documented Chrome
managed policy on Android, pushed through Headwind's per-app settings — unproven here), image
blanking on Android Chrome (deny_info → `/blocked` → SVG; unproven on a device), kiosk-mode
switching by the scheduler (the scheduler's
configuration swap is tested against a fake Headwind; kiosk entry/exit on the agent is not),
which stock package names the Vortex actually has, and which apps on rungs 3–4 need splice
entries.
