# WireGuard: the tunnel that replaces proxy passwords

Target architecture, decided 2026-08-29 (see NEXT-SESSION.md). Each phone holds an always-on
WireGuard tunnel to the filter box. What it buys, all at once:

- **No credentials.** Identity is the tunnel IP. Chrome's per-reboot proxy sign-in — unfixable
  under Basic auth — simply stops existing.
- **Enforced, not cooperative.** With Android's lockdown ("Block connections without VPN", set
  while Device Owner holds `no_config_vpn` over it) *every* app's traffic enters the tunnel. The
  raw-socket bypass class — apps that ignore the system proxy — is closed.
- **No credential sharing across rungs.** A tunnel key is not a typeable secret.
- **No port problems.** Networks see only udp/443 (QUIC's port shape). And UDP 443 does not clash
  with the panel on TCP 443 — no second IP needed.

The password path on 3128 keeps running beside it; phones migrate one at a time.

## How it fits together

```
phone (WG app, always-on+lockdown)
  └─ udp/443 ─→ wg0 on the box (10.66.0.0/24, one IP per phone)
                  ├─ tcp 80  ─ iptables REDIRECT ─→ squid :3129 (intercept)
                  ├─ tcp 443 ─ iptables REDIRECT ─→ squid :3130 (intercept ssl-bump, same CA)
                  ├─ udp 443 ─ REJECT (kills QUIC → browsers fall back to filtered TCP)
                  └─ the rest ─ NAT out (DNS, push, app APIs; TLS still transits squid → splice.txt applies)
```

Squid passes `%LOGIN %SRC %URI` to the helper; the helper uses the login when present and the
source IP otherwise. The Worker looks either up in `devices.proxy_user` — so a WG phone's row
stores its tunnel IP there, and **no Worker code changes at all**.

Pieces: `scripts/install-wireguard.sh` (server, idempotent), `scripts/new-wg-phone.sh` (one per
phone: keys, IP, QR), the intercept ports + `wg_phones` ACL in `scripts/squid.conf`.

## PoC runbook (Vortex first — NOT Isaac's phone)

**Server:**

1. `sudo ./scripts/install-wireguard.sh`
2. Install the updated squid pieces:
   `install -m 644 scripts/squid.conf /etc/squid/squid.conf`
   `install -m 755 scripts/squid-acl-helper.py /usr/local/bin/squid-acl-helper.py`
   `squid -k parse && systemctl restart squid` (restart, not reload — the helper binary changed)
3. Confirm the password path still works (Isaac's phone browses; or the health check passes).
4. `sudo ./scripts/new-wg-phone.sh vortex` → note the tunnel IP (first peer: `10.66.0.2`).
5. Set that IP as the Vortex's identity:
   `npx wrangler d1 execute phone-url-filter-db --remote --command "UPDATE devices SET proxy_user='10.66.0.2' WHERE id='dev_vortex';"`
   (This retires its old `vortex` htpasswd identity; revert the column to go back.)
6. If ufw or a Hetzner cloud firewall is active, open udp/443.

**Phone (Vortex):**

1. Clear the old proxy setting: `adb shell settings put global http_proxy :0`
2. The interception CA must be installed (Settings → Security → Install a certificate → CA). It
   was installed for the proxy tests; verify, don't assume.
3. Install the WireGuard app (Play Store; or download the F-Droid APK on the PC and `adb install`).
4. Scan the QR from `new-wg-phone.sh`. Toggle the tunnel on.
5. Test BEFORE lockdown (below). Then: Settings → Network → VPN → gear on WireGuard →
   **Always-on VPN** + **Block connections without VPN**.
6. Only after lockdown works: put `no_config_vpn` in the Vortex's Headwind config so the user
   can't touch any of it.

**The test battery:**

- Allowed site loads in Chrome, no sign-in prompt, after a reboot too.
- Blocked site → 302 to the block page. Blocked search → block page.
- `curl ifconfig.me`-style check in Chrome shows the server's IP (traffic is really tunnelling).
- Toggle wifi off/on, switch wifi ↔ cellular: tunnel re-establishes itself.
- With lockdown on: disable the tunnel inside the WG app → NO internet at all (that's the point).
- Reboot with lockdown: internet comes back by itself (always-on restarts the tunnel).
- A captive-portal network (phone hotspot with a login page is hard to fake — test on a real one
  when available; Android 10+ carves portals out of lockdown, verify).
- Watch `wg show wg0` on the server: handshakes tick, transfer counters move.

## Rollback

Phone: turn off always-on/lockdown, disable the tunnel, restore
`adb shell settings put global http_proxy mdm.getshmira.com:3128`, restore `proxy_user` in D1.
Server: `systemctl disable --now wg-quick@wg0` removes the interface AND its iptables rules
(PostDown). The intercept ports in squid.conf are inert with no traffic redirected into them.

## Known limits / open questions

- **Server down = tunnelled phones fully offline** (lockdown is absolute). The health check is
  mandatory, and a warm-standby plan matters before the fleet migrates.
- **All-UDP-blocked networks** kill the tunnel (fail closed, no bypass — but no internet). If it
  ever happens in practice: a TCP fallback (wstunnel/udp2raw) is the known fix; don't build it
  before it's needed.
- **Battery**: WG is kernel-side and cheap, but verify on the Vortex over a few days anyway.
- The `wg_phones` subnet in squid.conf and `WG_SUBNET`/`SUBNET_PREFIX` in the two scripts must
  stay in agreement (all `10.66.0.0/24` today).
