# First phone — the runbook

> **Stage 0 is done and proven** (27 Aug 2026). Verified end-to-end through squid on the server:
> allowed sites `200`, blocked sites and blocked *searches* `302` to the block page. Blocklists
> synced (35,825 explicit domains), `PROXY_KEY` rotated, D1 migration ledger reconciled.
>
> **One thing is unproven and gates everything:** Android's `settings put global http_proxy` takes
> `host:port` only — there is no field for the proxy credentials `squid.conf` requires. Until a real
> phone is seen authenticating, do not factory-reset anyone's device. See "The open question" below.

**This document is authoritative for setting up a phone.** `SETUP-PHONES.md` describes the earlier
DNS-only architecture and says "there is no certificate to install"; that stopped being true on
25 Aug 2026 when the proxy replaced DNS as the enforcement layer. Where the two disagree, this one
wins. `PROXY.md` explains *why* the proxy exists — read it once, then work from here.

DNS filtering is still deployed and still works. It is the fallback, not the mechanism.

---

## What has to be true before a phone is worth touching

| | Where it lives | State |
|---|---|---|
| Worker on the current code | `phone-url-filter.daniel08-madar.workers.dev` | ✅ `/api/proxy/check` answers |
| D1 schema + seed data | `phone-url-filter-db` | ✅ 5 levels, app rules, 49 keyword rules |
| Headwind server | `mdm.getshmira.com` | ✅ panel reachable |
| Squid proxy | same box, port 3128 | ✅ active, listening, CA generated |
| `SHMIRA_PROXY_KEY` set server-side | `/etc/squid/filter.env` | ✅ set — **still to prove it matches the Worker** |
| **A proxy login per phone** | `/etc/squid/passwd` + `devices.proxy_user` | 1 exists — **one more per new phone** |

---

## Stage 0 — the server

Do all of this before the phone is in your hand. Nothing here touches a device.

### 0.1 Install or re-install Squid

`install-squid.sh` is idempotent, so if you are unsure whether it ever ran, just run it. It installs
`squid-openssl` (the stock `squid` package cannot decrypt anything), generates the CA, initialises
the certificate spool, and drops in the ACL helper and blocklist sync.

```bash
cd /path/to/repo && sudo ./scripts/install-squid.sh
```

### 0.2 Set the shared key on both sides

The script leaves `SHMIRA_PROXY_KEY` deliberately blank. If it stays blank **every request is
denied** — the correct failure direction, and an opaque one to debug.

```bash
# generate once
openssl rand -hex 32

# worker side
npx wrangler secret put PROXY_KEY          # paste it

# server side — same value
sudo sed -i 's|^SHMIRA_PROXY_KEY=.*|SHMIRA_PROXY_KEY=<the value>|' /etc/squid/filter.env
sudo grep SHMIRA_ /etc/squid/filter.env    # confirm URL + key
```

`SHMIRA_WORKER_URL` should already read `https://phone-url-filter.daniel08-madar.workers.dev`.

### 0.3 One proxy login per phone

This is what gives each phone its identity, and therefore its level.

```bash
sudo htpasswd -B /etc/squid/passwd <device-name>     # omit -c; -c overwrites the file
```

Then set the same name as `proxy_user` on that device's row in D1 (`/admin` → Devices, or SQL). A
device the proxy cannot identify degrades to the **strictest** level rather than being cut off.

### 0.4 Start it and confirm

```bash
sudo systemctl enable --now squid
systemctl is-active squid
ss -lntp | grep 3128
```

### 0.5 Prove the chain before any phone depends on it

From the server, with a login you just created:

```bash
curl -x http://<device-name>:<password>@127.0.0.1:3128 -I https://en.wikipedia.org
curl -x http://<device-name>:<password>@127.0.0.1:3128 -I https://pornhub.com
```

curl will not trust the interception CA by default, so pass it explicitly:

```bash
openssl x509 -inform der -in /etc/squid/ssl/filter-ca.der -out /tmp/ca.pem
curl --cacert /tmp/ca.pem -x http://<name>:<pass>@127.0.0.1:3128 -o /dev/null -w '%{http_code}\n' https://en.wikipedia.org
```

**A block is `302`, not `403`.** `squid.conf` sets `deny_info` to the worker's `/blocked` page, so a
refused request redirects there rather than erroring. Reading a 302 as failure is the easy mistake.

Expected across a set: allowed `200`/`301`, blocked `302`. If everything is `302` the key does not
match; if nothing is, the external ACL is not being consulted — check `/var/log/squid/cache.log`.

Verified on 27 Aug: wikipedia `301`, example.com `200`, pornhub `302`, search "weather" `200`,
search "swimsuit models" `302`. Per-search rating works.

---

## Stage 1 — prove it on the Vortex first

The Vortex is already enrolled, already Device Owner, already has `proxy_user=vortex` in D1. It
needs only Stage 2's adb steps.

This is worth twenty minutes because **the proxy has never run on a real Android phone**. What was
actually verified (`PROXY.md`) was: Chrome honours a system proxy, it works with DNS broken, and
QUIC falls back to TCP — that last one on *desktop* Chromium, not Android. The question "what breaks
under interception?" is answered *"Nothing yet — no third-party apps installed."*

Your splice list starts empty. On a phone with banking apps, Play Services and WhatsApp, things will
break, and every one of them has to be added to `/etc/squid/splice.txt`. Discover that on the test
phone, not on a phone someone is waiting to get back.

---

## Stage 2 — the phone

### ⚠ The phone is erased

Device Owner can only be established during initial setup, so the phone **must be factory reset**.
Photos, messages, app logins — all of it. Back it up and make sure the owner understands, before
they hand it over. There is no way to do this on a phone in use.

### 2.1 Enroll

1. Factory reset.
2. On the welcome screen, tap the same spot 6 times → QR scanner.
3. Scan the enrollment QR from Headwind. Let it provision; the agent becomes Device Owner.

Use the **stock** `com.hmdm.launcher` agent. Play Protect has been blocking custom-built DPCs during
QR provisioning since 2026.

### 2.2 Point it at the proxy (adb, cable)

Headwind cannot do either of these — verified against the live Swagger spec, 121 endpoints, zero
mentions of certificates or proxy settings. Both are per-device, over adb.

```bash
adb shell settings put global http_proxy mdm.getshmira.com:3128
```

Then install the CA so Chrome trusts the interception. Copy `/etc/squid/ssl/filter-ca.der` off the
server, push it, and install it through Settings → Security → Encryption & credentials → Install a
certificate → **CA certificate**:

```bash
adb push filter-ca.der /sdcard/Download/filter-ca.der
```

Android shows a scary warning. That is expected and correct — you are installing an interception CA.

### 2.3 Lock it down

Headwind configuration → MDM Settings → `restrictions`, comma separated:

```
no_config_private_dns,no_config_vpn,no_install_apps,no_install_unknown_sources,no_safe_boot,no_add_user
```

Plus `setUninstallBlocked` on the agent. **`no_config_vpn` matters more than anything else here** —
a VPN app routes around a system proxy completely.

Deliberately *not* set: `DISALLOW_FACTORY_RESET`. It blocks the Settings path but not recovery mode,
so it buys little while making a stuck phone much harder to recover.

### 2.4 Register it

`/admin` → **Devices**: label, Headwind device id, baseline policy, `proxy_user` matching the
htpasswd entry, level, and **the family's time zone** — schedules run in the phone's local time.

---

## Stage 3 — verify on the actual phone

Every one of these has failed silently for somebody.

```bash
adb shell dpm list-owners                  # names the Headwind agent
adb shell settings get global http_proxy   # your server:3128
```

- [ ] An unapproved site is refused
- [ ] An approved site loads
- [ ] A search the level forbids is refused; an ordinary one goes through
- [ ] The agent cannot be uninstalled
- [ ] Blocking an app in `/admin` removes it within a sync cycle (5 min, or **Apply now**)
- [ ] The request page reaches the worker and can get a site approved
- [ ] Every app the owner actually needs still works — banking especially
- [ ] The operator password removes management (test before you need it in anger)

---

## Known sharp edges

- **The D1 migration ledger was out of sync and is now fixed** (28 Aug). It recorded only
  `0001`–`0004` while `0005`–`0014` were applied by hand, so `npm run db:migrate` would have failed
  on `0006` (bare `ALTER TABLE ADD COLUMN` on existing columns) and, past that, `0010` would have
  duplicated all 49 keyword rules into an AUTOINCREMENT table. Every migration's effects were
  verified present before the ledger was reconciled. `db:migrate` is safe again — keep it that way
  by applying migrations *through* it rather than with `d1 execute --file`.
- **Blocklist files must be world-readable.** `mktemp` makes them `0600` root-owned and the ACL
  helper runs as `proxy`; an unreadable list is indistinguishable from a missing one, so the sync
  reports success while the explicit list silently never fires. `sync-blocklists.sh` now chmods
  them — verify with `sudo -u proxy head -c 40 /etc/squid/blocklists/level1.json`.
- **Port 3128 should become 443 before this is real.** Networks routinely block odd ports, and a
  filter that dies on someone else's wifi is a filter that gets removed. 443 on that box currently
  serves the Headwind panel, so this needs a second IP or a split.
- **A spliced host is completely unfiltered.** Splice only what you trust; block the rest at the app
  layer.
- **The CA private key is the crown jewel** — it can impersonate any site to every enrolled phone,
  banks included. It stays on the proxy, readable only by `proxy`, and is not backed up. Leaking it
  exposes everyone; losing it means re-enrolling every phone.
- **The CA expires in ten years** and every phone stops at once, with no remote fix. Record the date
  somewhere that outlives this repo.
- **The access log is off by design.** Turn it on to debug, then off.
- **A factory reset removes everything.** No factory-reset protection without an enterprise Google
  binding. Strong guardrail, not a cage.

---

## The open question — proxy auth on Android

`squid.conf` requires `proxy_auth REQUIRED` and passes `%LOGIN` to the ACL helper as the device's
identity. That login is the whole basis of per-device levels.

But Android's global proxy setting is `host:port` and nothing else:

```
adb shell settings put global http_proxy mdm.getshmira.com:3128
```

There is nowhere to put a username or password. Chrome may prompt for them and remember, which would
be workable if fragile; anything that cannot show a dialog simply fails. This has never been observed
on a real phone.

**If it does not work, the fix is per-device ports rather than per-device passwords.** Squid can
listen on several ports and identify the device by which one the request arrived on:

```
http_port 3128 ssl-bump ...      # phone A
http_port 3129 ssl-bump ...      # phone B
acl phone_a myportname 3128
```

The port becomes the identity, `http_access deny !authenticated` goes away, and the phone needs only
what Android can already express. The cost is that it collides with moving to 443 — one port per
device means one 443 per device, so that route needs an IPv4 per phone (~€1/month each) or one IPv6
per phone. Fine for tens of devices; a few hundred needs client certificates instead.
