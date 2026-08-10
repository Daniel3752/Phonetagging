# Setting up phones (ManageEngine + Cloudflare WARP)

Step-by-step for getting a phone filtered. You already know how to **enroll a device in ManageEngine
by scanning a QR code** — this guide covers everything that has to happen *around* that.

> **Sensitive values** (team name, service token, operator key) are **not** in this file. They're
> kept separately (ask Claude / see your saved `phone-setup-secrets.txt`). Where this guide says
> `<AUTH_CLIENT_ID>` etc., paste the real value from there.

---

## The idea in one picture

```
Phone ──(WARP app)──► Cloudflare Gateway ──► the internet
                          │
                          ├─ blocks every site not on the allowlist
                          ├─ shows your block page for blocked sites
                          └─ the block page asks the AI; clean sites get allowed
```

Three things must be true on every phone, or filtering silently doesn't happen:

1. **WARP is installed** and routing traffic to Cloudflare.
2. **WARP is connected to *your* organization** (`wandering-sky-cada`) — not the free public WARP.
   This is the part people miss.
3. **Cloudflare's certificate is installed and trusted**, so Gateway can read HTTPS addresses.

Plus: WARP must be **locked on** so the phone's user can't switch it off.

---

## Part 1 — Cloudflare dashboard (do ONCE, not per phone)

Most of this is already done for you. You only need to do steps **1A** and **1B**.

**Already done** (for reference): TLS decryption is ON, the default-deny policy is created, the URL
allowlist exists, and the AI worker is live. You don't need to touch those.

### 1A. Allow the enrollment token to enroll devices

This lets phones join your org automatically with no login.

1. Go to **one.dash.cloudflare.com** → your account → **Settings** (left sidebar) → **WARP Client**.
2. Find **Device enrollment permissions** → click **Manage**.
3. Click **Add a rule** (or **Create a policy**).
4. Name it `MDM phones`. Under the rule, choose include type **Service Auth**, and select the token
   named **phone-warp-enrollment**.
5. Save. (This is what makes the service token in Part 2 actually work.)

### 1B. Download the Cloudflare certificate

1. Still in **Settings** → **Resources** (or **Settings → Network → Certificates**).
2. Find the **Cloudflare certificate** for in-line inspection → **Download** the `.pem` (also grab
   `.crt`/`.der` if offered — some MDM cert uploads want a specific format).
3. Keep this file; you'll upload it to ManageEngine in Part 2A.

> If you see an option to **generate** a certificate first, do that, make it **active**, then
> download it.

---

## Part 2 — ManageEngine (do ONCE; applies to every enrolled phone)

You'll create a few **profiles/policies** in ManageEngine and assign them to the group your phones
are in. Exact menu names vary slightly by ManageEngine version, so this describes the *thing* to
create; look for that wording.

### 2A. Push the Cloudflare certificate

1. In ManageEngine: **Device Mgmt → Profiles → Create Profile** (pick **iOS** or **Android**).
2. Add a **Certificate** payload/section.
3. Upload the `.pem`/`.crt` from step 1B.
4. Save, and **assign the profile** to your phone group.

This installs Cloudflare's cert in the phone's trust store so decrypted HTTPS doesn't throw
certificate warnings.

> **iOS extra step:** a pushed cert via MDM is trusted automatically on **supervised** devices. If a
> phone isn't supervised, someone has to manually flip *Settings → General → About → Certificate
> Trust Settings*. Supervision avoids that — another reason iOS phones should be supervised.

### 2B. Add the WARP app as a managed app

The app is **Cloudflare One Agent**.

- **iOS:** App Repository / App Management → **Add App → Apple App Store** → search *Cloudflare One
  Agent* (App Store ID **6443476555**). Add it, mark it **managed**, assign to the group.
- **Android:** App Management → **Managed Google Play** → search *Cloudflare One Agent* (package
  **`com.cloudflare.cloudflareoneagent`**). Approve it, assign to the group.

Set it to **install automatically** (mandatory app) so it lands without the user doing anything.

### 2C. Configure the WARP app (THE important part)

This is the **App Configuration** (a.k.a. *Managed App Config* / *App Settings*) for the Cloudflare
One Agent app you just added. It's a set of key/value pairs. In ManageEngine, open the app → **App
Configuration** → add these keys:

| Key | Value | Why |
|---|---|---|
| `organization` | `wandering-sky-cada` | Joins **your** org, not public WARP |
| `auth_client_id` | `<AUTH_CLIENT_ID>` | Zero-touch enroll (from secrets file) |
| `auth_client_secret` | `<AUTH_CLIENT_SECRET>` | Zero-touch enroll (from secrets file) |
| `service_mode` | `warp` | Full Gateway filtering (not DNS-only) |
| `auto_connect` | `0` | Connect immediately and stay connected |
| `switch_locked` | `true` | User can't turn WARP off |
| `onboarding` | `false` | Skip the app's welcome screens |

- **Android:** these go in as **Managed Configuration** key/values for the app.
- **iOS:** these go in as the app's **Configuration** dictionary (key/value; ManageEngine may accept
  a plist/XML — same keys). If ManageEngine wants types: `switch_locked`/`onboarding` are booleans,
  the rest are strings, `auto_connect` is a number.

### 2D. Force WARP always-on (belt and suspenders)

`switch_locked` already stops the user disabling WARP, but also set OS-level always-on VPN:

- **Android:** in the phone's restrictions profile, set **Always-on VPN** → app
  `com.cloudflare.cloudflareoneagent`, and enable **Lockdown** (block traffic when VPN is down).
- **iOS (supervised):** add a **VPN** payload set to **Always-on / Per-app** for Cloudflare One
  Agent. (Supervised-only — another reason to supervise iPhones.)

---

## Part 3 — Enroll a phone (per phone)

1. Enroll via **QR code** the way you already do.
2. Everything from Part 2 auto-applies: the cert installs, WARP installs, connects to
   `wandering-sky-cada`, and locks on. No login, no taps.
3. Give it a minute; watch the phone show a VPN/WARP indicator.

---

## Part 4 — Check it actually works

On the enrolled phone:

1. Open the browser, go to a random site you haven't approved → you should get **your block page**.
2. Tap **Check this site**. A clean site (e.g. a news site) should approve in a few seconds; reload
   and it loads.
3. Try an obviously bad site → stays blocked.
4. Confirm WARP can't be turned off (the toggle should be greyed/locked).
5. Confirm a normal app (banking, App Store) still works — if one breaks, see Part 5.

---

## Part 5 — Ongoing: two things you'll do

### Allow a site someone asks for
Either add the URL in the Cloudflare dashboard (**Gateway → Lists → Shmira Mobile Allowlist**), or
run the operator command (see README — needs your operator key).

### Fix an app that breaks (Do-Not-Inspect)
Some apps (banking especially) refuse a decrypted connection ("certificate pinning"). When one
breaks, exempt its domain from inspection:

1. **one.dash.cloudflare.com → Gateway → Firewall Policies → HTTP → Add a policy** (or edit a
   "Do Not Inspect" policy).
2. Action: **Do Not Inspect**. Selector: **Host** (or **Domain**) → the app's domain.
3. Put it **above** the default-deny policy in order.

Starter domains worth exempting up front (banking varies — add yours as needed):
`apple.com`, `icloud.com`, `mzstatic.com`, `push.apple.com`, `googleapis.com`, `gstatic.com`,
`play.google.com`. This both un-breaks those apps **and** lets them through unfiltered — so only add
domains you trust.

---

## Turning a phone off the filter
Unenroll / retire the device in ManageEngine (removes the profiles, app, and lock). Nothing else to
do — there's no server-side per-phone record to clean up.
