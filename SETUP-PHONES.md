# Setting up phones (Headwind MDM + Cloudflare Gateway DNS)

> **⚠ Superseded for setup. Use [`FIRST-PHONE.md`](FIRST-PHONE.md).**
>
> This page describes the DNS-only architecture and states below that there is **no certificate to
> install**. That was true until 25 Aug 2026, when the filtering proxy replaced DNS as the
> enforcement layer — a CA certificate and a system proxy are now required per-device adb steps
> (see [`PROXY.md`](PROXY.md)). Following this page during a real setup gives you contradictory
> instructions at the point where the phone is already wiped.
>
> Still accurate and not repeated elsewhere: the Play Protect pre-flight checklist, the user
> restrictions table and their rationale, the escape hatch, "what this can't do", and the iPhone
> appendix. The DNS layer itself remains deployed as a fallback.

Per-phone setup for Android. iOS is at the end and is not ready yet.

Two things go onto each phone, once:

1. **Headwind MDM agent as Device Owner** — controls which apps exist and cannot be uninstalled.
2. **Private DNS locked to Cloudflare Gateway** — hostname filtering, enforced by the agent.

There is **no certificate to install**, no VPN app, and no supervision step. That is the direct
benefit of filtering by hostname instead of by full URL: nothing breaks on certificate-pinned apps
and there is no do-not-inspect list to maintain.

---

## Before you start: verify the assumption this all rests on

> ⚠ **Do this first, on one throwaway phone, before enrolling anybody.**

Since 2026 Google Play Protect has been **blocking custom-built Device Policy Controllers** during
QR provisioning. The mitigation is to use the **stock, published** Headwind agent
(`com.hmdm.launcher` from F-Droid or Play) rather than a custom build — the stock binary is what
Play Protect recognises.

Confirm all four of these before going further:

- [ ] The stock agent provisions as Device Owner via QR without a Play Protect block
- [ ] It can push a CA certificate (`installCaCert`) — you don't need this now, but it is the one
      capability you cannot retrofit later without touching every phone again
- [x] ~~It can pin Private DNS~~ — **it cannot.** Verified against the live server's API: Headwind's
      Configuration object has 73 fields and none of them touch DNS. Android exposes the capability
      (`setGlobalPrivateDnsModeSpecifiedHost`, API 29+) but Headwind does not implement it, so
      Private DNS is set once per device over adb — see Part 3. Everything else about the filter
      stays remotely changeable.
- [ ] It can set `DISALLOW_*` user restrictions via the configuration's `restrictions` field
- [ ] Its REST API can change a device's configuration remotely

**If the first one fails, stop.** The whole design rests on it, and the fallback is a different
enforcement layer, not a workaround.

---

## Part 1 — Cloudflare, once for the whole fleet

1. Run the Gateway setup script from the repo root:

   ```bash
   CF_ACCOUNT_ID=… CF_GATEWAY_API_TOKEN=… WORKER_HOST=… ./scripts/setup-gateway.sh
   ```

   It creates the hostname allowlist, the default-deny DNS policy, and YouTube Restricted Mode +
   SafeSearch. It prints `CF_GATEWAY_HOST_LIST_ID` — paste that into `wrangler.toml` and redeploy.

2. In **Zero Trust → DNS locations**, note the location's **DoT hostname**. It looks like
   `abc123.cloudflare-gateway.com`. That single string is what every phone points at.

   The free plan allows 3 DNS locations, so you get at most 3 network policy tiers. Per-family
   variation lives in the app layer instead — that is a deliberate trade for unlimited free devices.

3. **Allowlist the worker's own host before enrolling anyone.** Under default-deny, if the worker
   doesn't resolve, nobody can request a site — including you. The script's rule already exempts
   `WORKER_HOST`; confirm it actually took effect.

> A default-deny policy that silently fails open looks exactly like one that works. Verify from a
> test device that a random site is genuinely blocked before you trust it.

---

## Part 2 — Headwind server, once

Stand up Headwind MDM Community on a small VPS (~$5–6/month, unlimited devices, no licensing).
Follow the upstream install docs at <https://h-mdm.com/download/>.

Then, in the Headwind panel, create one **configuration per policy** you intend to use — at minimum
a baseline (e.g. `day`) and any scheduled variants (e.g. `evening`). Note each configuration's id.

In the worker console at `/admin` → **Policies & apps**, create a matching policy for each one and
paste its Headwind configuration id. That mapping is what lets the scheduler swap a phone between
them.

Set `HEADWIND_BASE_URL` in `wrangler.toml` and `HEADWIND_API_TOKEN` (or `HEADWIND_USER` +
`HEADWIND_PASSWORD`) via `wrangler secret put`.

---

## Part 3 — Per phone

The phone must be **factory reset** — Device Owner can only be established during initial setup.

1. On the welcome screen, tap the same spot 6 times to bring up the QR scanner.
2. Scan the enrollment QR from your Headwind server.
3. Let it provision. The agent installs and becomes Device Owner.

Then apply, via the device's Headwind configuration:

**Private DNS — set over adb, once, with the phone plugged in**

Headwind cannot do this (see the pre-flight checklist), so it is a per-device step at enrollment:

```
adb shell settings put global private_dns_mode hostname
adb shell settings put global private_dns_specifier <YOUR-DOT-HOSTNAME>
```

It persists across reboots. The `no_config_private_dns` restriction below is what stops the user
changing it back — without that restriction this setting is one Settings screen away from being
switched off, so the two go together or not at all.

Note what this does and does not pin down. The phone stores only *which resolver to ask*; every
filtering rule — the allowlist, the AI's decisions, revocations, SafeSearch — lives at Cloudflare
and stays changeable remotely and instantly. The only thing that needs a cable again is moving a
phone to a *different* resolver, i.e. a different policy tier.

**User restrictions** — Headwind configuration → MDM Settings → `restrictions`, comma separated:

```
no_config_private_dns,no_config_vpn,no_install_apps,no_install_unknown_sources,no_safe_boot,no_add_user
```

| Restriction | Why |
|---|---|
| `DISALLOW_INSTALL_APPS` | app control means nothing if they can install anything |
| `DISALLOW_INSTALL_UNKNOWN_SOURCES` | sideloading is the obvious bypass |
| `DISALLOW_CONFIG_PRIVATE_DNS` | otherwise the filter is one Settings screen away |
| `DISALLOW_CONFIG_VPN` | a VPN app routes around DNS entirely |
| `DISALLOW_SAFE_BOOT` | safe mode disables device admin apps |
| `DISALLOW_ADD_USER` | a second user profile is an unfiltered phone |

Plus `setUninstallBlocked` on the agent itself.

**Deliberately not set: `DISALLOW_FACTORY_RESET`.** It blocks the Settings path but not a
recovery-mode reset, so it buys very little while making a legitimately stuck phone much harder to
recover. See "What this can't do" below.

Finally, register the phone in the worker console at `/admin` → **Devices**: give it a label, its
Headwind device id, a baseline policy, and **the family's time zone** — schedules are evaluated in
the phone's local time.

---

## Part 4 — Verify, on the actual phone

Don't skip this. Every check has failed silently for somebody.

```bash
adb shell dpm list-owners          # should name the Headwind agent
```

- [ ] A random unapproved site fails to load
- [ ] An approved site loads
- [ ] Settings → Private DNS shows the Gateway hostname and **cannot be changed**
- [ ] The agent cannot be uninstalled
- [ ] Blocking an app in `/admin` makes it disappear from the phone within a sync cycle
- [ ] The request page reaches the worker and can get a site approved
- [ ] The operator password removes management (test this before you need it in anger)

---

## Part 5 — Day to day

**Approve a site.** The user opens the request page and types the site; ordinary sites clear in a
few seconds. Anything the classifier won't clear stays blocked until you allow it by hand in
`/admin` → **Sites**.

There is no injected block page — a DNS-blocked site just fails in the browser. Put the request page
on the home screen or as a bookmark so it is somewhere obvious.

**Change apps or schedules.** All in `/admin`. Changes reach phones on the next scheduler run (five
minutes), or immediately via **Apply now**.

---

## The escape hatch

The operator password fully removes management from a phone.

**It is an operator recovery tool. Do not ship it to families with the phone.** Anyone holding it
can lift every restriction on that device, which makes it the single point of failure for the whole
arrangement.

---

## Why there is one website policy for the whole fleet

Per-person *website* rules would need the phone's identity to travel with each DNS query, and it
cannot: Android's Private DNS speaks DoT, which carries only the question and the server hostname.
There is no header, path or field to put an identifier in.

Cloudflare does support identity-based DNS policies, but they require a `CF-Authorization` header,
which means DoH, which means a DoH client app on every phone and a seat per device. The other route
is one DNS location per tier (three on the free plan), which trades the seat cost for a cable visit
whenever someone changes tier.

Both were considered and rejected for v1. Per-person variation lives in the **app layer** instead —
which apps exist, when they are available, the whole launcher — and that is free, unlimited, and
fully remote through Headwind. In practice that is where the real difference between two users
lies anyway.

## What this can't do

Be straight with families about all of these up front:

- **A factory reset removes everything.** There is no factory-reset protection without an enterprise
  Google binding. This is a strong guardrail, not a cage.
- **YouTube Shorts, Instagram Reels and WhatsApp Status/Channels cannot be separated** from the rest
  of those apps. In-app they are the same endpoints as ordinary content, behind certificate pinning.
  No network filter reaches them. Those apps are all-or-nothing.
- **No duration quotas.** Time windows work; "90 minutes a day" needs on-device usage accounting
  that isn't built.
- **DNS is bypassable** by a VPN app, hardcoded resolvers, or third-party DoH. The app allowlist is
  what actually closes those doors.

---

## Turning a phone off the filter

Delete the device in the Headwind panel and remove it in `/admin` → **Devices**. There is no
server-side state to clean beyond that; the audit log deliberately keeps its history.

---

## Appendix — iPhone (not ready)

**Not deployable yet.** Recorded here so the sequence is clear.

The **network layer ports over for free**: iOS supports a managed DNS payload, so the same Gateway
allowlist, worker and classifier apply unchanged. A DNS profile can even be installed on an
unmanaged iPhone today — but without supervision the user can delete it in Settings, so it filters
the cooperative, not the determined.

The **enforcement layer is the wall**. iOS has no equivalent of Device Owner available to an
individual:

- App control and non-removable profiles require **supervision**, which requires an MDM server.
- A self-hosted Apple MDM server (**NanoMDM**/**MicroMDM**, both free) needs an **APNs certificate**,
  and Apple issues those only to organizations in **Apple Business Manager** or **Apple School
  Manager**. There is no hobbyist route. ABM is free but needs a legal entity and a D-U-N-S number;
  ASM needs a recognized educational institution — plausibly available here, and the cheapest route
  to the strong version.
- **Enrollment doesn't scale to families.** Automated Device Enrollment — the version that survives
  a factory reset — only covers devices purchased through Apple under the organization's account. A
  phone a family already owns must be prepped individually with **Apple Configurator on a Mac**,
  which erases it, and carries a 30-day window in which the user can release it.

**Sequence:**

1. **Now, free** — push the Cloudflare DNS profile. Immediate hostname filtering, no infrastructure.
   Removable; say so.
2. **Now, with a Mac** — Apple Configurator alone can supervise a phone and install a
   **non-removable** profile that locks DNS, restricts apps by bundle ID, disables App Store
   installs and hides built-in apps. No ABM, no APNs, no server, no recurring cost. The limitation
   is that it **cannot be changed remotely** — every policy edit means reconnecting the cable.
3. **Paperwork, start early** — determine ABM or ASM eligibility. This gates remote control and has
   lead time, so do it in parallel with the Android rollout, not after.
4. **Only if 3 clears** — NanoMDM + SCEP + TLS, obtain the APNs certificate, add `src/apple-mdm.js`
   beside `src/headwind.js`. The whole control plane is reused unchanged.

Step 3 is the go/no-go. If ABM/ASM proves unavailable, iPhones top out at step 2: locked, but only
adjustable with a cable.
