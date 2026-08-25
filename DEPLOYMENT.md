# Deployment state

What is actually running, as of 2026-08-25. Identifiers only — no secrets. Update this when
infrastructure changes; a future session starts blind without it.

## Cloudflare

| | |
|---|---|
| Account ID | `905456397f790c63aafc1cb42c400cb3` |
| Zero Trust team | `wandering-sky-cada` (Free plan) |
| Worker | `phone-url-filter` → https://phone-url-filter.daniel08-madar.workers.dev |
| Cron | `*/5 * * * *` (scheduler) |
| D1 database | `phone-url-filter-db` · `9e5b0576-7a7c-4af0-8d13-495fb9e30718` |
| Hostname allowlist (DOMAIN list) | `128c36f6-5345-4361-887e-998f1eeb6365` |
| URL allowlist (dormant, path blocking) | `ca654a6f-6899-48d6-afa7-51e187a37451` |
| DNS location | `Phones` — DoT `l7eeo6k7lt.cloudflare-gateway.com` |

Worker secrets (set via `wrangler secret put`, not in the repo): `GEMINI_API_KEY`,
`CF_GATEWAY_API_TOKEN`, `OPERATOR_KEY`, `HEADWIND_USER`, `HEADWIND_PASSWORD`.

### Gateway rules

| Precedence | Filter | Action | Name | State |
|---|---|---|---|---|
| 0 | http | off | Do Not Inspect | on |
| 900 | dns | ytrestricted | Phone filter: YouTube Restricted Mode | on |
| 901 | dns | safesearch | Phone filter: SafeSearch | on |
| 1000 | http | block | Phone filter: default-deny (allowlist only) | **should be OFF** — dormant path-blocking rule |
| ~1001 | dns | block | Phone filter: default-deny DNS (allowlist only) | on — this is what enforces v1 |

## Headwind MDM

| | |
|---|---|
| Panel | https://mdm.getshmira.com (Ubuntu 22.04, Hetzner CPX12, 2GB) |
| Stack | Tomcat 9 (8080/8443), PostgreSQL, Let's Encrypt |
| DB | database `hmdm`, user `hmdm` |
| API spec | `GET /rest/swagger.json` — the source of truth for `src/headwind.js` |
| Configurations | `Background (Agent) Mode`, `Managed Launcher`, `MIUI (Xiaomi Redmi)` |

Tomcat's SSL connector lives in `/var/lib/tomcat9/conf/server.xml`; the keystore is
`/var/lib/tomcat9/ssl/mdm.getshmira.com.jks`. Port 443 is redirected to 8443 by iptables. Logs are
in `/var/log/tomcat9/catalina.out`.

**Do not run `do-release-upgrade`** on that server. The installer requires Tomcat 9, which Ubuntu
dropped after 22.04.

## Test device

| | |
|---|---|
| Model | Vortex V23, Android 12 (Go edition) |
| Serial / Headwind number | `4908545443` |
| Device Owner | **confirmed** — `com.hmdm.launcher/.AdminReceiver,DeviceOwner,Affiliated` |
| Configuration | Managed Launcher |
| Private DNS | set via adb to `l7eeo6k7lt.cloudflare-gateway.com` |

The phone had no carrier device-owner preinstalled (`dpm list-owners` was empty before enrollment),
and `com.android.managedprovisioning` is present — both worth re-checking on any new model before
buying a batch.

## Verified working

- Default-deny DNS: unapproved hostnames return `0.0.0.0`; the Worker's own host is exempt.
- AI classification: `en.wikipedia.org` → clean, `pornhub.com` → blocked, both cached in D1 with
  `scope='host'`.
- Approval propagates to the Gateway list and starts resolving within ~30 seconds.
- Device Owner, Managed Launcher replacing the home screen, remote app control.

## Not yet working

The test phone resolves nothing on the building wifi — **including with Private DNS switched off**,
which means it is probably not a DoT/port-853 problem. `ping 1.1.1.1` succeeds, so the network is
up. Suspected captive portal or a network that withholds DNS. Unresolved; see the handoff notes.
