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
3. ☐ **[PC]** Register the device in D1 (`/admin` → Devices, or wrangler): label, level,
   `policy_id` (= `apps_rung_<level>`), timezone, and **`proxy_user` = the tunnel IP** —
   that IP *is* the phone's identity; a phone the Worker can't match browses at rung 1.

## B. Device Owner enrollment

**Existing phone (no factory reset — the default for phones already in use):**

4. ☐ **[phone]** Remove ALL accounts (Settings → Accounts — Google, Samsung, everything).
   Apps, photos and chats stay; only sync pauses.
5. ☐ **[phone]** Enable Developer options + USB debugging; connect the cable.
6. ☐ **[PC]** Install the stock agent APK, then:
   `adb shell dpm set-device-owner com.hmdm.launcher/.AdminReceiver`
   If it refuses, check `adb shell dpm list-owners` for a carrier-preinstalled owner and
   look for stray non-removable accounts. A refusal on a new model = fall back to reset path.
7. ☐ **[phone]** Re-add the owner's accounts.

**New / reset phone:** factory reset → tap welcome screen 6× → scan the Headwind
enrollment QR (STOCK `com.hmdm.launcher` only — Google's DPC allowlist blocks custom builds).

8. ☐ **[panel]** Confirm the device appears and syncs; assign its configuration
   (**Background (Agent) Mode** for rungs 4–5, **Managed Launcher** for rungs 1–3) and set
   the Headwind device id on the D1 row.

## C. Filter plumbing

9. ☐ **[PC]** Install the interception CA (still required — search engines are decrypted):
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

## E. Headwind lockdown

19. ☐ **[panel]** MDM Settings → uncheck Permissive mode → restrictions:
    `no_install_unknown_sources,no_safe_boot,no_config_credentials,no_config_private_dns,no_add_user`
    - `no_config_vpn`: add ONLY after verifying on this model that it doesn't kill an
      always-on tunnel (on the S22 it forced the tunnel off — with the proxy unset that
      means UNFILTERED internet; per-model test before trusting it).
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
