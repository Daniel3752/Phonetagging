# Commands

Everything routinely needed to run this system. Real values filled in, not placeholders — the
`SERVER_IP` habit has cost an evening already.

| | |
|---|---|
| Server | `2.28.63.95` — `mdm.getshmira.com` (Hetzner CPX12, Nuremberg) |
| Worker | `https://phone-url-filter.daniel08-madar.workers.dev` |
| D1 database | `phone-url-filter-db` |
| Gateway DoT host | `l7eeo6k7lt.cloudflare-gateway.com` |
| Test phone | Vortex V23, serial `4908545443` |

---

## Server

```bash
ssh root@mdm.getshmira.com
```

No password? Hetzner web console: [console.hetzner.cloud](https://console.hetzner.cloud) → project →
server → the `>_` **Console** button. Reset the root password under **Rescue**.

### tmux — so a dropped connection doesn't kill what's running

```bash
tmux new -s work          # start
tmux attach -t work       # come back
tmux ls                   # what's running
# Ctrl+B then D           # leave it running
```

Anything long-running goes inside tmux. Losing SSH otherwise kills the process with it.

---

## Squid (the filtering proxy)

```bash
sudo ./scripts/install-squid.sh      # first time; idempotent

systemctl enable --now squid          # start at boot + now
systemctl restart squid
systemctl status squid
squid -k parse                        # check config before restarting
squid -k reconfigure                  # apply config without dropping connections

tail -f /var/log/squid/cache.log      # what it's doing
```

The access log is **off by design** — see the privacy section of `scripts/squid.conf`.

### Add a phone

```bash
htpasswd -B /etc/squid/passwd yossi-phone     # prompts for a password
```

Then set that name as `proxy_user` on the device's row in D1 (see below), and give the phone the
proxy setting.

### Files

| Path | What |
|---|---|
| `/etc/squid/squid.conf` | Config |
| `/etc/squid/passwd` | One login per phone |
| `/etc/squid/splice.txt` | Hosts passed through **unfiltered** so apps don't break |
| `/etc/squid/filter.env` | `SHMIRA_PROXY_KEY` — must match the Worker's `PROXY_KEY` |
| `/etc/squid/ssl/filter-ca.der` | The certificate to install on phones |

### Is it listening?

```bash
ss -tlnp | grep squid
```

**Port 8080 is Tomcat** (the Headwind panel). Don't take it.

---

## Phone (adb)

On Windows, `cd C:\platform-tools` first, or use `.\adb.exe`.

```bash
adb devices                                   # is it connected?
adb shell dpm list-owners                     # confirm Device Owner
```

### Proxy

```bash
adb shell settings put global http_proxy 2.28.63.95:3128
adb shell settings get global http_proxy
adb shell settings put global http_proxy :0        # clear it
```

Toggle wifi off and on after changing it. Android often won't apply it until the network reconnects.

### Private DNS (the Cloudflare fallback path)

```bash
adb shell settings get global private_dns_mode
adb shell settings get global private_dns_specifier

adb shell settings put global private_dns_mode hostname
adb shell settings put global private_dns_specifier l7eeo6k7lt.cloudflare-gateway.com

adb shell settings put global private_dns_mode off
```

Hostname mode is **strict**: if the resolver can't be reached on port 853, *every* lookup fails and
the phone looks like it has no internet at all.

### Does the filter work?

```bash
adb shell ping -c 2 en.wikipedia.org     # should resolve (approved)
adb shell ping -c 2 google.com           # should fail (not approved)
```

### Certificate

Install `/etc/squid/ssl/filter-ca.der` via **Settings → Security → Encryption & credentials →
Install a certificate → CA certificate**.

Remove one: **Settings → Security → Encryption & credentials → Trusted credentials → User**.

---

## Worker

```bash
npm test                          # everything, offline, no credentials needed
npx wrangler deploy
npx wrangler tail                 # live logs

npx wrangler secret put PROXY_KEY
npx wrangler secret list
```

Secrets in use: `GEMINI_API_KEY`, `CF_GATEWAY_API_TOKEN`, `OPERATOR_KEY`, `PROXY_KEY`,
`HEADWIND_USER`, `HEADWIND_PASSWORD`. They're write-only — you can list names, never read values.

### Is it up?

```bash
curl -s https://phone-url-filter.daniel08-madar.workers.dev/
```

### Ask it about a site (as the operator)

```bash
curl -s -X POST https://phone-url-filter.daniel08-madar.workers.dev/api/verdict \
  -H 'Content-Type: application/json' \
  -d '{"url":"example.org"}'
```

### Ask it what the proxy would ask

```bash
curl -s -X POST https://phone-url-filter.daniel08-madar.workers.dev/api/proxy/check \
  -H "Authorization: Bearer $PROXY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"user":"yossi-phone","url":"https://www.google.com/search?q=volcano+facts"}'
```

---

## Database

```bash
npx wrangler d1 migrations apply phone-url-filter-db --remote
npx wrangler d1 execute phone-url-filter-db --remote --command "SELECT ..."
```

Add `--local` to hit a local copy instead of production.

### Useful queries

```sql
-- Every phone and its strictness rung
SELECT id, label, level, proxy_user, last_seen_at FROM devices;

-- Put a phone on a different rung
UPDATE devices SET level = 3 WHERE label = 'Yossi';

-- Link a phone to its proxy login
UPDATE devices SET proxy_user = 'yossi-phone' WHERE label = 'Yossi';

-- What's been rated recently
SELECT hostname, level, is_doorway, reason FROM url_verdicts
ORDER BY decided_at DESC LIMIT 20;

-- What's being searched for, most-tried first
SELECT query_sample, level, hit_count FROM search_verdicts
ORDER BY hit_count DESC LIMIT 20;

-- Everything blocked outright
SELECT hostname, reason FROM url_verdicts WHERE level = 5;

-- What changed and who changed it
SELECT at, actor, action, target FROM audit_log ORDER BY at DESC LIMIT 20;
```

---

## Cloudflare Gateway (the DNS fallback)

Check the resolver is behaving — no credentials needed:

```bash
curl -s -H 'accept: application/dns-json' \
  'https://l7eeo6k7lt.cloudflare-gateway.com/dns-query?name=en.wikipedia.org&type=A'
# expect a real IP

curl -s -H 'accept: application/dns-json' \
  'https://l7eeo6k7lt.cloudflare-gateway.com/dns-query?name=google.com&type=A'
# expect 0.0.0.0
```

Dashboard: [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → Networks → Resolvers &
Proxies → DNS locations.

---

## Headwind MDM

Panel: <https://mdm.getshmira.com>

```bash
curl -s https://mdm.getshmira.com/rest/swagger.json | python3 -m json.tool | less
```

That spec is the source of truth for `src/headwind.js`. Re-read it if the server is ever upgraded.

```bash
systemctl status tomcat9
tail -f /var/log/tomcat9/catalina.out
```

**Never run `do-release-upgrade`** on that box. The installer needs Tomcat 9, which Ubuntu dropped
after 22.04.

---

## Git

```bash
npm test
git add -A
git commit -m "..."
git push -u origin claude/parental-control-handoff-lh2h2s
```

---

## Debugging, in order

**Phone can't load anything**

1. `adb shell settings get global http_proxy` — right address and port?
2. Toggle wifi off and on
3. `tail -f /var/log/squid/cache.log` — are requests arriving?
4. `ss -tlnp | grep squid` — is it running?
5. Is `SHMIRA_PROXY_KEY` in `/etc/squid/filter.env` the same as the Worker's `PROXY_KEY`? A
   mismatch denies everything — correct direction, opaque symptom.

**Certificate warnings on every site** — the CA isn't installed on the phone, or it landed
somewhere other than the user trust store.

**One app broken, everything else fine** — it rejects the certificate. Add its hostname to
`/etc/squid/splice.txt` and `squid -k reconfigure`. Remember a spliced host is entirely unfiltered.

**Nothing resolves with Private DNS on** — strict mode with an unreachable resolver. Set
`private_dns_mode off` to confirm that's what it is.
