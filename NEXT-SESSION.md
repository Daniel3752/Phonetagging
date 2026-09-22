# Next session — start here

## AUDIT (2026-09-22): where each open item actually lives, and what was fixed

Asked to trace six things through the filter (yeshiva ladder only — the operator confirmed this
mid-session), plus a per-phone test bench and the always-on-VPN lockdown. Findings first, then what
this session changed.

**STATUS: the streaming fix is DEPLOYED AND CONFIRMED ON A PHONE (2026-09-22).** The Worker was
deployed, 0022 and 0023 were applied, the yeshiva rung-3 apps were pushed, and **the Netflix app is
blocked on the handset** — verified by the operator. The squid box was not touched and needed no
change. Everything else in this section is still findings, not fixes.

### 1. Netflix on rung 3 — FIXED (both halves), and the cause was structural

Not a bug in a rule; a gap where a rule had never existed. Both halves of the filter let it through:

**The web half.** The yeshiva browser is `webMode: 'blocklist'` — **allow-by-default with no model
in the request path**. Only four things refuse a site there: the explicit list (level1), the social
list (level2), a keyword hit on a *search*, and a NEVER already on file. Netflix is none of them, so
`netflix.com` was simply allowed on every yeshiva rung. This is worth sitting with, because it is
not only Netflix: **on the yeshiva ladder every site that is not explicit and not social is open.**
That is the tag's design (it is a blocklist filter, by choice), but it means "rung 3" says far less
about the web than the rung numbers suggest.

The same answer is what squid asks at the **TLS handshake**, which is the only moment it ever sees
of a spliced connection — so `ssl_bump splice filter_allows` spliced the Netflix *app's* traffic
through untouched too. The app worked for the same reason the website did.

**The app half.** `yeshiva_rung_3`'s blocklist is 99 packages — social, dating, explicit-capable,
other browsers, VPNs, YouTube, Twitch — and **not one streaming service**. No Netflix, Disney+,
Prime Video, Hulu, Max. Headwind therefore never removed it.

Rungs 1 and 2 are worse, and counter-intuitively so: they are **allowlists**, which sounds stricter
and is not. `pushPolicyApps` (`src/headwind.js`) only ever issues a REMOVE for a package with an
explicit `'blocked'` row, and **never removes an app merely for being absent from an allow list**.
Enforcing an allowlist properly needs `no_install_apps`, which is deliberately not applied. So on
the two strictest rungs an installed Netflix stayed installed and working. This is the same
inversion recorded further down for rungs 1-2 in September; it was fixed for the social apps then
and streaming was never in any bucket.

**Fixed in this session, both halves — they must stay in step, because the app is only gone until
someone reinstalls it, and the site was always reachable in Chrome regardless. The APP half is
confirmed working on a live phone; the BROWSER half (netflix.com refused in Chrome) had not been
eyeballed on the handset at the time of writing, so check it once:**

- `src/streaming.js` — a pure hostname matcher, same shape as `app-media.js`. Whole registrable
  domains (the video CDNs live on domains of their own: `nflxvideo.net`, `aiv-cdn.net`), plus exact
  hosts where the domain must keep working (`tv.apple.com`, never `apple.com`). ISP domains that
  also sell television (Partner, Cellcom, HOT) are deliberately **not** listed — that would take the
  phone bill with it. Only their TV-specific hosts.
- `streaming: false` on all four yeshiva rungs in `src/levels.js`; `streaming: true` on every
  standard rung, which is left to its model as before (it rates a streaming service ~4 and so
  already keeps it out of standard rungs 2-3).
- Step 0c in `src/proxy-api.js`, ahead of the no-web check because it is an app decision as much as
  a browser one, and host-scoped so it holds at the handshake.
- `migrations/0023_yeshiva_streaming_block.sql` — 26 packages × 4 rungs, additive and re-runnable,
  leaving each rung's existing 99 rules alone. The bucket is in `scripts/build-yeshiva-seed.mjs`
  (which also regenerates 0016), so the generator stays the source of truth.

**Rung 4 is included on purpose** and is the debatable call. It is the rung that permits the social
apps, so the obvious home for these was the social bucket next to YouTube; they are a different
thing in that a streaming service's entire product is filmed drama rather than a feed that can
carry it. To reverse: delete its rows in 0023, drop `STREAMING` from the rung-4 bucket in the
generator, and set `streaming: true` on rung 4 in `levels.js`.

**Several Israeli package names are guesses** (marked CONFIRM). A wrong one is harmless — nothing to
remove — but reconcile them against Headwind's installed-apps list on a real phone.

### 2. Testing on one phone — BUILT

There was no way to do this, and one near-miss that shows the shape of the problem:
`devices.allow_youtube`, a single hard-coded boolean that swaps yeshiva rung 3 onto a second policy.
The right idea, built once, for one app. Everything else is keyed to a **rung**, which is shared, and
`POST /api/admin/devices` actively **refuses** a `policy_id` that does not match the one derived from
(tag, rung) — so a phone could not be pointed anywhere of its own.

Generalized into `device_overrides` (`migrations/0022`): one row per phone, every field nullable,
NULL meaning "use the rung's answer". A phone with no row behaves exactly as before, so the table is
empty on arrival and changes nothing until someone writes to it.

```
curl -X POST .../api/admin/device-overrides -H "Authorization: Bearer $OPERATOR_KEY" \
  -d '{"device_id":"isaac","app_media":false,"note":"spotify artwork test"}'
curl ... -d '{"device_id":"isaac","clear":true}'      # back on the rung
```

Overridable: `images`, `app_media`, `block_social`, `streaming`, `web_mode`, and `policy_id` (the app
half — another policy's Headwind configuration for this handset only). A corrupt or unrecognised
value falls back to the rung, never to "open". Overrides ride along in `GET /api/admin/state`, so a
phone under test is never a silent exception. **Caveat:** setting `policy_id` means a schedule whose
`base_policy_id` names the phone's original policy stops matching it; the shiur windows are written
as `tag:yeshiva` and are unaffected, which is the common case.

### 3. Chrome images still visible — most likely cause identified, NOT fixed (needs the panel)

Every yeshiva rung has `images: false`, and the mechanism is: Chrome is pointed at squid's **browser
port 3128**, where everything is bumped, and the helper then denies image requests
(`strip_images`). Stripping only ever happens on a **decrypted** request —
`allow and not handshake and entry['strip']` in `squid-acl-helper.py`. If Chrome is not on 3128 its
traffic takes the intercept path, approved hosts are **spliced**, nothing is decrypted, and **no
image is ever stripped**.

Chrome is put on 3128 by a Headwind *managed app setting* (`ProxyMode=fixed_servers`,
`ProxyServer=10.66.0.1:3128`) that is set **by hand in the panel** — there is no code in this repo
that pushes it. It is recorded as set on **configuration 4 only** (`yeshiva_rung_2`, the Vortex),
where pictures were confirmed grey on Wikipedia. Configurations 5/6/7/8 were created later as copies.

**So: open configuration 5 (`yeshiva_rung_3`) in Headwind and check whether those two Chrome
settings are present.** If they are missing, that is the whole answer. Confirm from the phone with
`chrome://policy`, and from the server with
`tail -f /var/log/squid/access.log | grep <tunnel-ip>` — `HIER_DIRECT` is the browser port,
`ORIGINAL_DST` is the intercept path. Seeing `ORIGINAL_DST` for Chrome traffic confirms it.

Separately and already known: Google embeds result thumbnails **in the results page itself**, so no
image stripping can touch them. `udm=14` is the answer and is already enforced.

### 4. Ads in apps — NOT BUILT, nothing exists

There is no ad blocking anywhere in the system. `sync-blocklists.sh` pulls exactly two lists,
level1 (explicit) and level2 (social), from the private `shmiras-blocklists` repo.

The good news is that the mechanism is already proven: **a hostname is visible at the TLS handshake
even for a pinned, spliced app**, which is exactly how Spotify's artwork is refused. An ad-domain
list can be blocked the same way, for apps as well as the browser, with nothing installed on the
phone. Cheapest route: add a `level3.json` (ads) to the blocklist repo, load it in the helper beside
the other two, and gate it on a per-rung flag the way `streaming` now is. Expect breakage in
ad-funded apps, so put it behind a `device_overrides` row on one phone first — which is now possible.

### 5. WhatsApp Channels/Status — CONFIRMED IMPOSSIBLE at the network layer

Worth closing rather than re-investigating. WhatsApp serves Channels, Status and ordinary chat from
the **same endpoints behind certificate pinning**, and `.whatsapp.net`/`.whatsapp.com` are both
pre-auth exempt and spliced precisely so the app keeps working. The proxy cannot see inside, so it
cannot tell a Status view from a message. The only mechanisms that could are an on-device
**Accessibility service** (large piece of work; the companion app is a watchdog with no such powers)
or dropping WhatsApp. `README.md` already recorded this; this session re-confirmed it in the code.

### 6. Spotify / in-app images — built, per-rung, and now per-phone

`appMedia: false` on yeshiva rungs 1-3 (rung 4 keeps artwork on purpose). Enforced in squid by the
`app_media_hosts` SNI regex plus the `app_media_on` src ACL, which `sync-media-on.sh` rewrites from
`/api/proxy/media-on` — an **allowlist**, so a missing phone or a stale sync means pictures off. That
endpoint now honours per-device overrides too, so artwork can be toggled on one handset. The open
empty-playlists bug below is unchanged and is still the first thing to fix.

### 7. Always-on VPN and the WireGuard tunnel — the answer, without blocking installs

The operator's constraint: **must not stop the boys installing apps**, which rules out
`no_install_apps`. Nothing below needs it.

What is true today: always-on + lockdown is set **by hand in the phone's Settings** (step 18b), and
whoever holds the phone can walk back into Settings and switch it off. `adb` cannot set it — the
keys are not writable by the shell user. Headwind has no always-on VPN setting of its own.

The real fix is an Android **Device Owner** API, not a restriction:

```java
DevicePolicyManager.setAlwaysOnVpnPackage(admin, "com.wireguard.android", /* lockdown */ true);
```

Set by a Device Owner, the user **cannot** turn it off in Settings — the toggle is greyed out. The
Device Owner here is the Headwind agent (`com.hmdm.launcher`), and the companion app cannot do it:
it binds to the agent's plugin API to force a config refresh and holds no device-policy powers, and
there is only ever one Device Owner. So this needs the agent to make the call — Headwind Community
is open source, and a patched agent APK is within reach of a project that already builds its own
companion APK. That is the one durable answer.

Two cheaper things to try first, in this order:

1. **Re-test `no_config_vpn` in the other order.** The test that concluded it kills our own tunnel
   was run *without* always-on already configured. Set always-on + lockdown first, sync, then apply
   `no_config_vpn`, and see whether the running tunnel survives while the setting becomes
   unchangeable. If it does, that is the whole answer for free. (Still open from September.)
2. **`setUninstallBlocked` on `com.wireguard.android`**, so the app cannot be removed.

On "turning off or deleting the tunnel in WireGuard": with lockdown on, **breaking the tunnel yields
no internet, not open internet** — confirmed on the Vortex. So it is self-defeating rather than a
bypass, and the only real hole is turning always-on off in Settings first, which is exactly what the
Device Owner call closes. WireGuard for Android has no config lock of its own.

**Also still open and load-bearing:** Isaac's phone may still carry
`iptables -t nat -I PREROUTING -i wg0 -s 10.66.0.3 -j RETURN`, which bypasses squid **entirely** and
leaves the handset unfiltered no matter what any rung says. Check this before concluding anything
from a test on that phone — it would mask every fix above. It does not survive a reboot.

### Tests

`npm test` and `npm run test:helper` both green. New: `test/streaming.test.mjs` (30 checks) covering
the matcher, the rung-3 refusal, that the handshake answer is host-scoped, that the standard ladder
is untouched, and that an override moves **one** phone while the other on the same rung does not.

---

## OPEN BUG (2026-09-19): Spotify's catalogue went empty on Isaac's phone

**Symptom, on 10.66.0.3 (Isaac's S22, yeshiva rung 3), right after the proxy was brought up to date
and Spotify's storage was cleared:** the top ~6 tiles on the home page still show pictures, the
shelves below them (Audiobooks, "Listen before you watch") do not — and **every playlist and podcast
is empty of songs**. Empty libraries are far worse than pictures, so this is the first thing to fix.

**What had just changed.** That box was three PRs behind: its squid.conf still had the original
`acl app_media_hosts ssl::server_name play-lh.googleusercontent.com` and
`ssl_bump bump app_media_hosts !filter_allows`. Running `scripts/apply-yeshiva-squid.sh` from `main`
applied steps 1-6 in one go — the role regex, `app_media_on`, the terminate rule, AND (for the first
time on this server) the `Sec-Fetch-Dest` helper format, `deny_info &why=%o`, the named browser port,
`ssl_bump bump browser_port`, the google_system_hosts exemption change, and a reinstall of
`squid-acl-helper.py`. So the terminate rule is the obvious suspect but NOT the only change in
flight; do not assume.

**Evidence so far, and why it is thin.** A census of the access log over the reproduction found
**zero** lines matching `scdn|spotifycdn|play-lh`, while the same log held 773 lines from
10.66.0.3. Terminated connections may not log the SNI (they can appear as `NONE_NONE/409` against a
bare IP), so the host filter probably hid exactly the lines that matter. Capture without a host
filter next time:

```bash
: > /var/log/squid/access.log
# phone: force stop Spotify, clear its storage, open it, wait for the home page
grep -a 10.66.0.3 /var/log/squid/access.log | awk '{print $4, $7}' | sort | uniq -c | sort -rn | head -40
tail -40 /var/log/squid/cache.log
```

**The one-step isolation.** Comment the rule out, reconfigure, clear Spotify's storage again:

```bash
sed -i 's/^ssl_bump terminate app_media_hosts/#&/' /etc/squid/squid.conf
squid -k parse && squid -k reconfigure
```

Songs come back → the terminate rule is the cause, and the regex is refusing something Spotify needs
(a role label doing double duty, or a shelf whose data rides an image host). Songs still missing →
it is one of the other step 1-5 changes or the reinstalled helper, and the log capture above says
which. Re-enable by deleting the `#`.

**Hypotheses worth testing in that order:** (1) the regex's short labels (`i`, `o`, `t`, `p`, `pl`)
are broader than intended and catch something structural; (2) the app fails a whole shelf when its
image prefetch is refused rather than rendering it blank, which would mean host-level refusal can
never be safe inside Spotify and the setting must become Spotify-artwork-off = accept-empty-shelves
or nothing; (3) the newly installed helper answers differently for `spclient`/`apresolve` and the
catalogue never syncs. Note that the top few tiles DO have pictures, so at least one media host is
not matched by the regex — that host is worth finding either way.

**Rollback for a phone that must work today:** move it to yeshiva rung 4 in `/admin` and run
`/usr/local/bin/sync-media-on.sh`; its address lands in `/etc/squid/app-media-on.txt` and the
terminate rule stops applying to it within seconds.


## The companion app (2026-09-18) — built, not yet on a phone

`companion/` is a small Android app, the **Shmira companion** (`com.getshmira.companion`), that
closes the gap between an app being installed and the Headwind agent noticing. The stock agent only
re-applies its app rules when it fetches its configuration (boot, MQTT push, or a forced update), so
a blocklisted app installed from Play stayed usable until the next sync. The companion runs as a
foreground service, sees `PACKAGE_ADDED` the moment an install completes, and calls the agent's own
plugin API (`com.hmdm.action.Connect`, `forceConfigUpdate`) to re-apply now. Blocklisted app gone in
seconds. No agent fork, no Knox. `companion/README.md` has the design, the build, the Headwind steps
and the known limits; the signed APK is `companion/releases/shmira-companion-0.1.2.apk`.

**NOT YET UPLOADED TO HEADWIND (as of 2026-09-22) — and the version on the phones is broken.**
0.1.1 is what the fleet is running, and on it every nudge threw SecurityException out of a Handler
callback and killed the process about two minutes after each start (the manifest was missing
ACCESS_NETWORK_STATE, which the offline gate needs). So the companion is effectively dead on the
phones: nothing is watching for installs, and a blocklisted app survives until the agent's next
scheduled configuration fetch instead of going in seconds. That undercuts the streaming block
shipped the same day — a reinstalled Netflix lingers rather than disappearing. 0.1.2 fixes the
permission and makes every callback swallow RuntimeException rather than die. It is built, signed
with the same key (so it upgrades in place) and committed; it only needs uploading via the
Applications tab and adding to each configuration. See companion/README.md.

Reviewed by four lenses (Android platform rules, the agent API, robustness, build) and the real
findings applied: the binding to the agent is persistent (unbinding mid-update would strand the
agent's install chain), no nudge is sent without a validated network (the agent releases its user
restrictions before fetching), the launcher activity waits over the lock screen when Android
refuses a foreground-service start on a locked phone, and a force-stopped app does NOT come back at
boot (Android's stopped state), so `no_control_apps` is the restriction that protects it.

Live findings from the first phone (Isaac, S22, Android 16), all fixed in 0.1.2: the app needs
`ACCESS_NETWORK_STATE` for the offline-nudge guard, and without it the first nudge threw
SecurityException and killed the process two minutes after every start, silently; nothing posted to
the main thread may throw now. And it does NOT start itself when Headwind installs it while the
phone is locked — Android refuses the foreground-service start — so **reboot a phone after the
companion is installed** and confirm with
`adb shell dumpsys activity services com.getshmira.companion`.

To put it on a phone: `npm run db:migrate` (0021 allows the package on every policy), upload the APK
in Headwind (Applications → Add; tick Run after install and Run at boot), add it to the phone's
configuration as Install with the icon hidden (or Push apps from the console, which marks it Install
because Headwind now holds its APK), sync, then `adb logcat -s ShmiraCompanion` and install a
blocklisted app to watch it vanish. Signing key: `companion/signing/` is git-ignored on purpose;
the operator holds the keystore. Every future build must be signed with it or phones refuse the
update.


## Branch state (2026-09-16): `main` is the truth

Everything below was merged into `main` on 2026-09-16 (PR #3, which also carried PR #2). `main`
now matches what is deployed and there is no other branch to look for. Start every session from
`main`; `claude/dreamy-newton-8rlo23` and the older `claude/*` branches are history only.

## START HERE — audit + fixes (merged to `main`, 2026-09-15)

This session audited the whole temp tag against the live system and fixed what it found. Nothing
was deployed and nothing on the server or the phones was touched — **every fix below is code on
this branch, inert until someone runs `npx wrangler deploy`.** The block under this one is still
the design and runbook; where the two disagree, this one wins.

### Two live faults found and fixed on the evening of 2026-09-15

1. **The tunnel had no MTU**, so it ran at WireGuard's 1420 default with every byte of the phone's
   traffic inside it. Big packets (a TLS handshake carrying a certificate chain) were silently
   dropped while small ones passed: Chrome `ERR_TIMED_OUT` on some sites and not others, the same
   site flipping, and the MDM agent showing "isn't responding" on every reboot because its sync is
   one of the big exchanges. Fixed at 1280 on both ends plus MSS clamping — see `WIREGUARD.md`.
   Applied live on the server and on the Vortex; **Isaac's phone still needs `MTU 1280` set in its
   WireGuard app.**
2. **Every Google search was refused because the phone's Chrome was version 105.** Google will not
   serve `udm=14` to a browser older than the feature and redirects the search with `udm` stripped,
   which the proxy then correctly refuses. Not a bug in this system — see the new section in
   `YESHIVA.md`. **Update Chrome as part of phone setup.**

### The Remove question is ANSWERED (2026-09-16)

**Headwind's Remove uninstalls a Play app, permanently.** Proven on the Vortex: TikTok was marked
Remove on rung 2, the phone synced, TikTok was gone from the device. Headwind has no APK for a Play
app, so it cannot reinstall it.

Right for a rung. Fatal for anything temporary: a Shiur configuration listing WhatsApp as Remove
would uninstall it at 09:15 and never restore it. **The app half of the shiur lock cannot be built
on configuration swaps**, and neither can a screen-time feature. The web half works today and is
unaffected. Options and their trade-offs are in `YESHIVA.md`; kiosk is the only mechanism Headwind
actually provides for this, which reopens a decision that was closed on comfort grounds.

Also settled the same day: the first successful Push apps ever (config 4, 1 remove / 1 install /
69 icon-only), after three server-side rejections that turned out to be the client writing app
links through the wrong endpoint entirely.

### NEXT SESSION — the operator's agenda, in order

**1. Harden the lockdowns against being undone.** Everything we set is currently reversible by
whoever holds the phone. Worth attacking in this order:

- **Always-on VPN / lockdown (step 18b)** is the big one, and today a boy can just switch it back
  off in Settings. The obvious guard, `no_config_vpn`, kills our own tunnel — BUT the test that
  established that was run *without* always-on already configured. **Re-test in the other order**:
  set always-on + lockdown first, sync, then apply `no_config_vpn`, and see whether the running
  tunnel survives while the setting becomes unchangeable. If it does, that is the whole answer.
  If it does not, the fallback is locking Settings access itself.
- **The CA certificate** — `no_config_credentials` stops it being removed, and is already in the
  restriction list. Note it also blocks *installing* the CA, so it must go on AFTER step 9 (see the
  "Enrolling configuration" note in NEW-PHONE.md).
- **adb** — `no_debugging_features`, already documented as the LAST restriction to add. Confirm it
  actually prevents re-enabling USB debugging rather than only hiding the toggle.
- Also worth checking: whether Settings itself can be restricted, and whether the Headwind agent
  survives a Settings → Apps → force stop.

**2. WhatsApp Channels and Status — read this before spending time on it.** `README.md` already
records that no network filter can separate these from ordinary WhatsApp: in-app they are the same
endpoints behind certificate pinning, and WhatsApp is spliced (never decrypted) precisely so the
app keeps working. So the proxy cannot see, let alone block, a Status view. The only mechanisms
that could are an on-device **Accessibility service** (not built, and a large piece of work) or
dropping WhatsApp entirely. Confirm that conclusion cheaply before designing anything.

**3. Turning off images in Spotify — BUILT (2026-09-17), needs a phone test.** The earlier note
said the proxy could not touch a pinned app; that was half right. It cannot see inside Spotify,
but Spotify fetches artwork, playlist mosaics and Canvas videos from hostnames of its own,
separate from the audio hosts, and a hostname is visible at the TLS handshake. **Matched by ROLE,
not by exact host** (`src/app-media.js`): the published lists name `image-cdn-ak` (Akamai) and
`image-cdn-fa` (Fastly), and Isaac's phone was seen pulling Canvas video from
`video-cf.spotifycdn.com` — the same role behind Cloudflare, a suffix nobody had written down. The
first label is what decides, with `audio*`, `spclient*`, `dj-*` and friends never refused. Those
hosts are refused on every rung with `appMedia: false` in `levels.js` — yeshiva rungs 1–3 (rung 4
keeps Spotify's artwork on purpose) and standard rungs 1–2 — so the app plays against blank
artwork. The refusal happens in squid (`app_media_hosts` in `scripts/squid.conf`), not in the
filter helper, and stays per-rung through the `app_media_on` src ACL that `scripts/sync-media-on.sh`
rewrites from `/api/proxy/media-on` every five minutes; `src/app-media.js` still answers for
Chrome's decrypted requests and the two must be kept in step. To verify on the Vortex: deploy, clear
Spotify's storage once (it caches artwork), play something. If playback itself breaks, the video
hosts at the end of the list are the suspects; drop them and retest. Instagram and WhatsApp cannot
be done this way — their pictures share hosts with everything else.

**4. Isaac's phone: migrate, then test the browser.** Before anything else on that handset:
set **MTU 1280** in its WireGuard app, check whether the iptables bypass
(`-i wg0 -s 10.66.0.3 -j RETURN`) is still in place leaving it unfiltered, confirm its Chrome is
recent enough for `udm=14`, and add always-on + lockdown. Then migrate and run the NEW-PHONE.md §F
battery.

A theme worth naming: items 2 and 3 are both requests to control behaviour *inside* a pinned app.
The network can do it only when the app keeps that content on hosts of its own (Spotify does;
WhatsApp and Instagram do not). Everything else needs an on-device service.

### Where the app tier stands (2026-09-16, all deployed and live)

The app half works end to end for the first time. Every yeshiva rung is mapped to a Headwind
configuration and carries a real blocklist:

| Policy | Config | Notes |
|---|---|---|
| `yeshiva_rung_1` | 6 | + Chrome blocked (no browser) |
| `yeshiva_rung_2` | 4 | the Vortex is here |
| `yeshiva_rung_3` | 5 | |
| `yeshiva_rung_3_yt` | 8 | the per-phone YouTube option |
| `yeshiva_rung_4` | 7 | social apps permitted |
| `yeshiva_shiur` | none | deliberately unmapped — Remove would uninstall Play apps |

Rungs 1 and 2 previously blocked nothing (0 and 1 rules) while rung 4 blocked 75 — the two
strictest rungs enforced least. They were written as allowlists to be enforced by
`no_install_apps`, which the operator has deliberately NOT applied, and Push apps never removes an
app merely for being absent from an allow list. They now carry rung 3's ~99-package blocklist.

Only the Vortex is enrolled, and it is on rung 2, so pushing the other rungs touches no phone.

### Still open

- **Chrome on the Vortex is version 105** and must be updated from the Play Store; until then every
  Google search is refused (see `YESHIVA.md`). This is why the browser side is still unverified.
- **VPN bypass: SOLVED, and not with `no_config_vpn`.** That restriction disables our own tunnel
  too (verified on the S22 and the Vortex) — our tunnel is a user-configured VPN like any other, and
  a phone whose tunnel is off has no filter at all. The answer is **always-on VPN with lockdown**
  pointed at WireGuard, set in the phone's Settings (adb cannot do it — the keys the system reads
  are not writable by the shell user; `always_on_vpn_lockdown` stays null). It closes three
  bypasses at once: no other VPN app can become the active VPN, the tunnel cannot be switched off
  to browse openly, and a tunnel that drops takes the internet with it instead of failing open.
  Confirmed on the Vortex: tunnel off = no internet. **This is now step 18b of `NEW-PHONE.md` and
  belongs on every phone, Isaac's included.**
- **Isaac's phone still needs `MTU 1280`** in its WireGuard app, and may still carry the iptables
  bypass that leaves it unfiltered.
- The shiur app half needs a mechanism that is not Remove (see `YESHIVA.md`); the web half works.

### Decisions recorded (from the operator, this session)

- The Vortex stays a **test phone**, so the fleet shiur toggle stays **Off**. Do not put it on
  Timetable until the app side is proven.
- **Shiur will not use kiosk mode.** It is an ordinary configuration swap. `YESHIVA.md` is updated.
- **Isaac's `apps_rung_4` mapping is deferred** until the yeshiva side is finished.

### The one thing to do before anything else

**The live Worker is running code that is in no git branch.** Production's `findDevice` matches a
Headwind device by id OR number; every branch matched by id only. D1 stores the *number*
(`4908545443`, too large to be an int32 id), so the repo version cannot find the phone and the
scheduler reports "Headwind device 4908545443 not found" every run. Somebody fixed this live and
never committed it — look for an uncommitted change in the Windows clone.

`main` now contains that fix with a test, so deploying `main` is safe. (Before the 2026-09-16
merge, `main` lacked it and deploying `main` would have regressed the live Worker.)

### What was fixed here (all with tests; `npm test` and `npm run test:helper` green)

Filtering holes, worst first:

1. **Searches went unjudged for 60 s at a time.** The search-engine "homepage" answer was
   host-scoped; the helper checks its host cache before the URL cache, so a Google results page's
   own same-host subresources primed that entry and every search on the engine for the next minute
   — keyword-blocked ones included — was answered OK with no Worker call. Engine hosts now answer
   per URL.
2. **"Locked now" did not lock the web.** `locked` was read from a map holding only the baseline
   policy and the policies of *joined* schedules, so the forced shiur policy (no schedule points at
   it, and none exist at all once the windows are deleted for bein hazmanim) read as unlocked. The
   console said locked while every phone browsed freely.
3. **Immodest keywords did not refuse on the tag** — only NEVER did, leaving the yeshiva browser
   looser than standard rung 4. Now rating 5 and above refuses.
4. **Video and news searches were never screened** (`bing /videos/search` and friends were not
   recognised as searches at all).
5. **An operator's block on a search-engine host was ignored** for its non-search URLs.
6. **`/api/verdict` was unauthenticated** — anyone could make the Worker fetch sites and call
   Gemini. It is behind the operator key now.

Things that quietly rewrote state the caller never mentioned (each landed on the permissive side):

7. **Mapping a configuration from a terminal wiped the policy's model.** The upsert treated an
   omitted `app_default` as "allowed" and an omitted `web_mode` as NULL — so the documented way to
   map `yeshiva_shiur` would have turned it into a blocklist with its web lock **off**. Omitted
   fields are now kept. `headwind_configuration_id` is validated as digits (`cfg 4` became
   `configurationId: null` on a live phone).
8. **Re-saving a phone without a tag took it off the ladder** (every curl example predating tags
   omits it), out of the shiur windows, while leaving its yeshiva policy behind.
9. **The per-phone shiur switch failed open**: any value it could not read — a missing field, the
   string `"true"` — meant OFF, exempting the phone from everything.
10. **The rung change did not move the app baseline**, so the scheduler kept pushing the old
    ladder's configuration. The console hid it behind a second save; an API caller did not get one.
11. **The console's Baseline dropdown reset to the first policy** (`Apps — Rung 1`) on every
    re-render, so editing a phone and touching another tab saved it onto a policy nobody chose.

Headwind push (it has never once succeeded — every attempt was a 401, now fixed):

12. Package names were **lowercased** before the catalogue entry was created; Android package names
    are case-sensitive and `com.google.android.GoogleCamera` is on the rung-1 allowlist.
13. The push **spread the whole catalogue app object** into the configuration save, echoing back a
    `configurations` array carrying every other configuration's admin password hash.
14. A **200 response carrying `status: "ERROR"`** was treated as success, so a rejected update was
    logged as applied.
15. A created app whose response omitted its id was **silently dropped**; it is looked up now.

Noise: the scheduler wrote an identical `policy_apply_failed` row every five minutes (~9,950 of
them for Isaac). It now logs a repeat only when the message changes or the device recovers.

### Deploy checklist (from the Windows PC, where wrangler is logged in)

```
git fetch origin && git checkout main && git pull
git status                  # if findDevice is uncommitted here, main already has it
npm test && npm run test:helper
npx wrangler deploy
```
No migration is needed — nothing here changes the schema.

### Still to do — needs the panel, the server or a phone

- **Rotate Isaac's proxy password.** `bec-339-wwx` was typed in chat and is still in D1. It is
  cosmetic in the WireGuard model (identity is the tunnel IP, `proxy_user`; `proxy_password` is
  never read by the verdict path) but it should not sit there. Generate and apply without the value
  passing through a chat window:
  ```
  npx wrangler d1 execute phone-url-filter-db --remote --command \
    "UPDATE devices SET proxy_password = '$(openssl rand -hex 4 | fold -w3 | head -3 | paste -sd-)' WHERE id = 'dev_b73af724'"
  ```
- **Push apps for `Yeshiva — Rung 2` (config 4) and reboot the Vortex.** TikTok is installed there:
  this is the Remove test, and its answer decides what the Shiur configuration may list (see
  YESHIVA.md). Nothing else should list a Play app as Remove until it is answered.
- **Create and map the Shiur configuration** (not kiosk), then rungs 1, 3, 4.
- **Verify on the phone**: `chrome://policy` shows the search URL ending `udm=14&safe=active`; a
  grey-image check on Wikipedia; then two searches within a minute — "volcano" then "porn" — which
  is the regression test for fix 1 above and would have failed before this branch.
- **Server housekeeping**: `scripts/check-drift.sh`, remove Isaac's nat bypass, unscope the
  ssl_bump block, `access_log none`, reinstall the helper from the repo.
- **Merge**: `main` is far behind production. PR #2 is still open; this branch contains it.

### Known and NOT fixed (deliberate — read before trusting the filter)

- **Image blanking is defeated by a document navigation.** Blanking keys off `Sec-Fetch-Dest:
  image` or a file extension, so opening a grey box in a new tab, a `fetch()`-loaded image, or any
  image on an `http://` page (Chrome sends no fetch metadata there) renders. The real fix is on the
  server, filtering by *response* type, which the Worker cannot see:
  `acl image_reply rep_mime_type ^image/` + `http_reply_access deny image_reply browser_port`.
- A **spliced host is completely unfiltered**, as ever.
- DuckDuckGo and Yahoo **image search** are judged as text searches (their results still blank).
- The stored fleet-toggle words are `schedule` / `off` / `on`, not the UI's Timetable / Off /
  Locked now. A hand-written `'timetable'` or `'locked'` in D1 does **not** do what it looks like.
- `POST /api/admin/settings` does not itself run the scheduler; only the console's button does, so
  a curl toggle leaves the app side waiting for the next cron tick.
- A device-specific exemption window saved at the form's **default priority 0** loses to the
  tag-wide lock at 100 and silently does nothing; and one saved with the phone field blank applies
  to the whole tag.

### About the audit

Eight subsystem readers were planned; a usage limit stopped it after three (browser path, scheduler
and policy, console), and the adversarial verification pass never ran. Every finding acted on above
was re-checked by hand against the code before it was touched. **The Headwind client was separately
reconciled against the live Swagger spec** (121 endpoints) — that is where fixes 12–15 come from.
Not yet audited at all: the migrations, the block page, the squid config and helper, and the docs.

---

## Finishing the yeshiva temp tag (branch `claude/yeshiva-temp-tag-shiur-0kgp2f`, 2026-09-10)

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

0. **Direct access — do it from the operator's Windows PC, not the cloud.** Anthropic-hosted
   cloud sessions egress only through an HTTP/HTTPS proxy (docs: "Security proxy"), so SSH to the
   server can never work from one, whatever the environment's network level. The working setup:
   `npm install -g @anthropic-ai/claude-code` on the PC, then from `C:\Users\danie\Phonetagging`
   run `claude --teleport <session-id>` to pull the cloud session into the PC's terminal, where
   Claude has ssh (to 2.28.63.95, key in `%USERPROFILE%\.ssh\id_ed25519`, public key appended to
   the server's `/root/.ssh/authorized_keys`), adb (the phone), wrangler (already logged in) and
   the repo. Everything below was written for copy-paste; from the PC, just do it.
0b. **Deploy**: `git pull && npm run db:migrate && npx wrangler deploy` (0019, the push button
   and the Headwind login fix are not live until this runs).
0c. **Headwind login**: the first Push apps failed 401 because the Worker sent a plain password;
   Headwind wants md5(password).toUpperCase() (its login page does exactly that). Fixed in the
   Worker (`src/md5.js`, `headwindPasswordHash`). If it still 401s: `sudo -u postgres psql hmdm
   -c "select id, login, password from users;"` shows the real login and the stored hash; set
   HEADWIND_USER to that login and HEADWIND_PASSWORD to the hash itself (accepted as-is).
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
  **DECIDED 2026-09-22: location tracking is NOT wanted. Turn it off.** Nothing in this system uses
  it — the companion app declares no location permission at all (check its manifest), WireGuard
  does not report position, and squid keeps no access log by design. It is purely a Headwind agent
  feature. Turn it off in the Headwind configuration's location setting, and if the notice survives
  a sync, revoke Location from the agent on the phone (Settings → Apps → Headwind → Permissions).
  Worth doing rather than ignoring: the boys can see that notice, and a filter that also reports
  location is a different proposition from one that does not.
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
