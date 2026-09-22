# New phone — setup checklist (WireGuard era)

The current runbook for adding a phone, superseding the proxy-password flow in
`FIRST-PHONE.md` (that document remains the reference for the 3128 password path and the
server-side Stage 0; a fresh server build is `install-squid.sh` + `install-wireguard.sh`).
Architecture background is in `WIREGUARD.md`. Verified on the live S22, 2026-08-31.

Legend: **[server]** = SSH to the MDM box · **[panel]** = https://mdm.getshmira.com ·
**[PC]** = Windows prompt in the repo clone (wrangler/adb) · **[phone]** = in hand.

## A. Prep — before the phone is in your hand

1. ☐ Decide the rung (1–5), the label, and get the **family's timezone**.
2. ☐ **[server]** Create the tunnel peer — one per phone, the name lowercase-with-hyphens:
   `sudo bash scripts/new-wg-phone.sh <device-name>`
   Note the **tunnel IP** it prints and keep the QR on screen (the private key exists only
   in that output — closing it means deleting the peer block from `wg0.conf` and re-running).
3. ☐ **[PC]** Register the device in D1 (`/admin` → Devices, or wrangler): label, tag, level,
   timezone, and **`proxy_user` = the tunnel IP** — that IP *is* the phone's identity; a phone
   the Worker can't match browses at rung 1. The app policy is not chosen: it follows the tag
   and rung (`apps_rung_<level>` / `yeshiva_rung_<level>`), and the console shows which one.

## B. Device Owner enrollment

**Existing phone (no factory reset — the default for phones already in use):**

4. ☐ **[phone]** Remove ALL accounts (Settings → Accounts — Google, Samsung, everything).
   Apps, photos and chats stay; only sync pauses.
5. ☐ **[phone]** Enable Developer options + USB debugging; connect the cable.
6. ☐ **[PC]** Install the stock agent APK **first** (it is easy to skip and causes an
   "Invalid component" refusal later — see §H), then:
   `adb shell dpm set-device-owner com.hmdm.launcher/.AdminReceiver`
   If it refuses, **§H** walks the refusal chain in order (secondary users / Secure Folder →
   accounts, orphaned and WhatsApp included → agent-not-installed). `adb shell dpm list-owners`
   also shows a carrier-preinstalled owner. A refusal on a new model = fall back to reset path.
7. ☐ **[phone]** Re-add the owner's accounts.

**New / reset phone:** factory reset → tap welcome screen 6× → scan the Headwind
enrollment QR (STOCK `com.hmdm.launcher` only — Google's DPC allowlist blocks custom builds).

8. ☐ **[panel]** Confirm the device appears and syncs; assign its configuration
   (**Background (Agent) Mode** for rungs 4–5, **Managed Launcher** for rungs 1–3) and set
   the Headwind device id on the D1 row.

## C. Filter plumbing

9. ☐ **[PC]** Install the interception CA (still required — search engines are decrypted).
   **Before this step the phone must NOT be on a configuration whose restrictions include
   `no_config_credentials`** — that restriction is exactly "no certificate installs" and the
   Vortex hit it. Either assign the locked configuration only after step 9, or keep an
   "Enrolling" configuration (a copy without restrictions) for phones mid-setup.
   `adb push filter-ca.der /sdcard/Download/` → **[phone]** Settings → search "certificate"
   → Install a certificate → CA certificate. (Samsung: Biometrics and security → Other
   security settings.) The scary warning is expected.
10. ☐ **[phone]** Install the **WireGuard** app (Play Store, or adb-install the APK on
    rungs where Play is hidden).
11. ☐ **[phone]** WireGuard → + → Scan from QR code → scan step 2's QR → toggle **on** →
    accept the VPN prompt. NOTE: the config's DNS must be `10.66.0.1` (new-wg-phone.sh
    emits this) — 1.1.1.1 resurrects ECH and host-forgery breakage.
12. ☐ **[phone]** Quick smoke test in Chrome BEFORE locking anything: an ordinary site
    loads with **no password prompt**; a search works; an explicit site is refused.
13. ☐ **[phone]** Lock the tunnel: WireGuard tunnel → Always-on VPN, and Settings → VPN →
    gear → **Block connections without VPN**. From here, tunnel down = no internet, by design.
14. ☐ **[PC]** `adb shell settings put global captive_portal_mode 0` (kills the bogus
    "no internet" warning; the phone then won't auto-detect real captive portals).
15. ☐ Do **NOT** set `http_proxy` — that's the legacy password path only.

## D. Close the bypasses (adb, while the cable is in)

16. ☐ Disable the preinstalled OEM browser(s), e.g. Samsung:
    `adb shell pm disable-user --user 0 com.sec.android.app.sbrowser`
    (Headwind Delete removes Play-installed apps but NOT system apps — adb is the tool here.)
17. ☐ Rungs 1–4: disable the Google app (Discover/Lens ride the unfilterable googleapis
    exemption): `adb shell pm disable-user --user 0 com.google.android.googlequicksearchbox`
18. ☐ Rungs 4–5: set the **Play Store maturity-rating PIN** on-device (the only
    rating-based Play filter that exists).
18b. ☐ **ALWAYS-ON VPN WITH LOCKDOWN — do not skip this one.** On the phone (not adb):
    Settings → Network & internet → VPN → gear next to WireGuard → enable **Always-on VPN**
    AND **Block connections without VPN**.
    This is the single most valuable lockdown on the device, because it closes three bypasses
    at once: another VPN app cannot become the active VPN (Android allows exactly one), the
    boy cannot turn the filter off and browse openly, and a tunnel that drops by itself takes
    the internet with it instead of failing open. Without it, one toggle in the WireGuard app
    leaves the phone completely unfiltered, and no app blocklist can help — there are hundreds
    of VPN apps and the blocklist names about twenty.
    **adb cannot set this** (tried 2026-09-16: `settings put global always_on_vpn_app` reads
    back but is inert, and `always_on_vpn_lockdown` stays null — the keys the system actually
    consults are not writable by the shell user). It is a manual UI step per phone.
    Verify by behaviour, not by the setting: item 28 below. Confirmed working on the Vortex.

## E. Headwind lockdown

19. ☐ **[panel]** MDM Settings → uncheck Permissive mode → restrictions
    (allowlist rungs — standard 1–3, yeshiva 1–2 — add `no_install_apps` too: nothing can be
    installed from Play or sideloaded; the agent can still install what the configuration says):
    `no_install_unknown_sources,no_safe_boot,no_config_credentials,no_config_private_dns,no_add_user`
    - `no_config_vpn`: **do not use it.** Verified on both the S22 and the Vortex: it disables
      the WireGuard tunnel as well, because our own tunnel is a user-configured VPN and sits on
      the same side of that restriction as the ones we want to stop. A phone whose tunnel is off
      is a phone with no filter at all, so this restriction makes things worse, not better.
      Step 18b (always-on + lockdown) is what blocks other VPN apps, and it does it better:
      Android runs exactly one VPN, so nothing else can take over whether or not it is on the
      blocklist. Headwind has no always-on VPN setting of its own — checked against the live
      API spec, there are no VPN fields or endpoints anywhere in it.
    - `no_debugging_features`: add LAST, only when all adb work on this phone is done.
    - `no_config_mobile_networks`: deliberately NOT used (locks the SIM manager; APN edits
      can't bypass the global tunnel anyway).
20. ☐ **[panel]** Confirm agent uninstall is blocked; sync (reboot forces it).

## F. Verification battery — every line, every phone

21. ☐ Allowed site loads, no prompt — **including after a reboot** (tunnel auto-reconnects).
22. ☐ Clean search passes; a forbidden search hits the block page.
23. ☐ Explicit site (try pornhub.com) → block page (L1 hosts are bumped for exactly this).
24. ☐ A blocked-by-rating/unknown HTTPS site shows a browser connection error — expected
    under splice-by-default, not a bug.
25. ☐ A pinned app works (Spotify/banking) — no splice entry should be needed.
26. ☐ Google sign-in, Play Store download, Google Photos thumbnails all work.
27. ☐ VPN add refused; APK sideload refused; safe-boot blocked.
28. ☐ Toggle the tunnel off inside the WG app → NO internet at all (lockdown proof) → on.
29. ☐ Wifi ↔ cellular switch: tunnel re-establishes by itself.
30. ☐ Every app the owner actually needs still works — banking especially.
31. ☐ Rungs 4–5: block a throwaway Play app in the config (action **Delete**, then the
    config's own Save) → gone within a sync. Proves app control on this phone.

## G. Finish

32. ☐ Optional: hide the WireGuard + Headwind apps from the launcher (Samsung: home-screen
    settings → Hide apps). Cosmetic only — lockdown and restrictions do the real guarding.
    Never `pm disable` them.
33. ☐ **[phone]** Turn USB debugging back off (or apply `no_debugging_features`).
34. ☐ **[panel/D1]** Double-check the row: level, timezone, tunnel IP, Headwind id. Done.

## H. Troubleshooting — set-device-owner refusals (live, Ray Cohen S24, 2026-09-22)

`dpm set-device-owner` refuses for one reason at a time and reports only the first it hits, so
you fix, re-run, and get the next message. The order we saw, and the fix for each:

1. **"already several users on the device"** — a secondary Android *user* exists (not an account).
   `adb shell pm list users`; remove every entry whose id is **not 0** with
   `adb shell pm remove-user <id>`. On Samsung the usual culprit is **Secure Folder** (id ~150).
   An empty, not-signed-in Secure Folder is safe to remove. **If it holds anything, empty it
   first** (open it → Move out of Secure Folder) — `pm remove-user` deletes its contents. The
   owner's normal photos/files live under user 0 and are untouched.

2. **"already some accounts on the device"** — AccountManager accounts block it.
   `adb shell dumpsys account | findstr "name="` — the LIVE ones are the `Account {name=…}`
   lines at the top (Session/history lines below just contain the word `name=`, ignore them).
   - The blockers are app-created accounts whose authenticator does not declare itself
     device-owner-allowed. Real ones we hit: OneDrive (`com.microsoft.skydrive`), Google Meet
     (`com.google.android.apps.tachyon`), SoundCloud. **WhatsApp declared itself allowed but was
     still the final blocker** — it had to go too.
   - Remove an app account with `adb shell pm clear <pkg>` (or `pm uninstall --user 0 <pkg>` if
     clear does not stick because the app re-adds it).
   - **Orphaned account** (its app reports "not installed for 0", so it is not in Settings →
     Accounts and cannot be cleared): reattach the app, wipe it, and the account goes:
     `adb shell cmd package install-existing <pkg>` then `adb shell pm clear <pkg>`. This is how
     the stuck OneDrive account cleared.
   - **WhatsApp:** back up chats first (Settings → Chats → Chat backup — the local backup under
     `/sdcard/WhatsApp` survives `pm clear`), then `adb shell pm clear com.whatsapp`, and after
     device owner is set, re-register with the SMS code and tap Restore.
   - **After a reboot the account list is not reliable until the phone is UNLOCKED.** Do not run
     set-device-owner from the lock screen — it reads stale state and re-throws "some accounts".

3. **"Invalid component … for device owner"** — the accounts are clear but **the agent is not
   actually installed** (or only a stale admin record remains). `adb shell pm list packages |
   findstr hmdm` — if it prints nothing, install the stock agent and retry. The server keeps it
   at `/var/cache/tomcat9/files/hmdm-6.38-os.apk`, served at
   `https://mdm.getshmira.com/files/hmdm-6.38-os.apk` (or F-Droid `com.hmdm.launcher`):
   `adb install "%USERPROFILE%\Downloads\hmdm-6.38-os.apk"`. Then set-device-owner.
   NOTE: the shell prints `… was already an admin for user 0. No need to set it again.` as a
   separate line — that is **not** success. Success is `Success: Device owner set to …`; if the
   exception prints under the "already an admin" line, it did not take.

**Not blockers, but they show up:** KnoxGuard (`com.samsung.android.kgclient`) and third-party
admins like AppBlock (`cz.mobilesoft.appblock`) appear under `dumpsys device_policy` as active
device admins. They do **not** block the adb device-owner path. KnoxGuard being active can mean the
phone is under a carrier financing/lock program — worth noting, not a blocker here.

### Agent will not connect through the tunnel — enroll with the tunnel OFF

The server-built `-os` APK has the server URL baked in, but the agent (an app) does **not** trust
the user-installed filter CA, so once the tunnel is up and Squid bumps `mdm.getshmira.com`, the
agent gets "error connecting" while **Chrome loads the panel fine** (Chrome trusts user CAs, apps
do not). Enroll with **WireGuard off**, let it register and sync, then make it survive the tunnel:
confirm `mdm.getshmira.com` is in `/etc/squid/splice.txt` — `install-squid.sh` only seeds that line
when the file does not yet exist, so a box upgraded in place can be missing it —
`grep mdm.getshmira.com /etc/squid/splice.txt || echo mdm.getshmira.com >> /etc/squid/splice.txt`
then `squid -k parse && squid -k reconfigure`. Splicing the MDM host lets the agent see the real
certificate and stay online with the tunnel on.

### "Private DNS server can't be connected" every time the tunnel comes up

Leftover from the DNS-only era: Android Private DNS is still on Automatic or a DoT hostname, which
is unreachable once DNS goes through the tunnel to `10.66.0.1`. Set **Private DNS → Off** (Settings
→ Connections → More connection settings). Do this **before** `no_config_private_dns` locks it, so
it locks at Off. The proxy does the filtering; Private DNS is not used in the WireGuard era.

### Re-adding accounts with no recovery phone

Removing then re-adding a Google account with 2-Step on, and no recovery phone, risks a lockout.
Bootstrap the fallback **while the account is still on the phone** (the phone approves the login):
sign the account into a computer in an incognito window first (grab backup codes, or simply turn
2-Step off for the re-add), THEN remove it. WhatsApp/SoundCloud/in-app logins are not in Settings →
Accounts and are not touched by the removal.

### The always-on VPN seam (known, not closable in this stack)

Turning off **Always-on VPN** or **Block connections without VPN** in Settings does not unfilter
immediately (the tunnel keeps carrying traffic), but it makes the phone **fail open** — the moment
the tunnel drops or is toggled off, traffic goes direct and unfiltered. **Deleting WireGuard** is
worse: uninstalling the always-on app clears always-on + lockdown, so on most builds it leaves
plain unfiltered internet, not "no internet". This stack cannot hard-lock that toggle:
`no_config_vpn` would, but it disables our own tunnel, and a device-owner
`setAlwaysOnVpnPackage(..., lockdown=true)` (the real fix) is exposed by neither adb nor Headwind.
Mitigate with both: **hide WireGuard** AND **block its uninstall**. There is no per-app uninstall
block in Headwind Community, so it is the global `no_uninstall_apps` restriction (the user can no
longer uninstall any app — the agent still removes blocklisted ones, and installs still work) or
nothing.
