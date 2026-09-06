# The filtering proxy

The enforcement layer. Replaces DNS filtering as the primary mechanism; read this before changing
anything in `scripts/squid*` or `src/proxy-api.js`.

## Why this instead of DNS

DNS filtering sees a hostname and nothing else. That is enough to decide *where* someone went, and
useless for deciding *what they were looking for* — the words typed into a search box live in the
query string, which DNS never sees. So approving `google.com` once silently approves every search
anyone will ever run, and no amount of list-tending fixes it.

The established filters in this market (NetFree, Rimon, Netspark, Etrog) all solve this the same
way: run a proxy, install your own root certificate, read the full URL. This does that, with the
classifier in the request path rather than a staffed review desk beside it.

Two further things fell out of the change, neither of them planned:

- **No DNS needed on the phone.** The proxy resolves on the device's behalf. The broken-DNS problem
  that blocked two sessions of testing simply does not arise.
- **Identity for free.** Each phone gets its own proxy login, which is what makes per-person
  strictness work. The DNS design needed a separate Cloudflare DNS location per device to achieve
  the same thing.

## What was actually verified

Tested 25 Aug 2026 on the Vortex against a throwaway mitmproxy, and separately against headless
Chromium here. Distinguish these from the parts that are still assumption.

| Question | Result | How |
|---|---|---|
| Does Chrome on Android honour a system proxy? | **Yes** | `mitm.it` loaded and Wikipedia raised a certificate warning — both only happen through the proxy |
| Does it work with DNS broken? | **Yes** | Pages loaded while the phone had no working resolver |
| Does QUIC bypass the proxy? | **No** | Chromium with QUIC enabled sent `CONNECT www.google.com:443` to the proxy. QUIC is UDP; an HTTP proxy is TCP, so Chrome falls back |
| What breaks under interception? | **Nothing yet** | No third-party apps installed on the test device |

Still unproven: QUIC behaviour on Android specifically (the test above was desktop Chromium, same
engine, different build). If it ever misbehaves, `QuicAllowed: false` is pushable as a Chrome managed
setting — Headwind's API supports per-app settings, confirmed against the live spec at
`/private/devices/{id}/applicationSettings`.

## How a request is decided

Squid asks the Worker once per request, via `scripts/squid-acl-helper.py` →
`POST /api/proxy/check`. `src/proxy-api.js` then:

1. **Is it a search?** (`src/search.js`) If so the *typed query* is rated 1–5 and compared to the
   device's level. Cached on a normalised key — lowercased, punctuation stripped, words sorted — so
   the same question asked differently is judged once, and nobody gets a fresh unjudged query by
   adding a comma.
2. **Otherwise, rate the site.** Read the cached verdict for the hostname and apply `levels.js`. An
   unclassified site is denied with `action: "unknown"`, and the block page offers to request it.
   Sites are never classified inline — holding a page load open for several seconds to fetch and
   judge a homepage is not a trade worth making.

Everything fails closed. An unreachable Worker, a model outage, a malformed rating, an unknown
device: all resolve to denied. An unregistered device degrades to the *strictest* level rather than
being cut off, since proxy auth already established it is one of ours.

## Bumped vs spliced

Apps do not trust a certificate you installed yourself. Chrome does; almost nothing else does. So:

- **Bumped** — decrypted and filtered. Chrome, and anything else that trusts the CA.
- **Spliced** — tunnelled blind, so the app sees the real certificate and keeps working.
  `/etc/squid/splice.txt`.

A spliced host is **completely unfiltered**. Splice only what you trust; block what you don't at the
app level instead. This list is the ongoing maintenance cost of the architecture, and it is bounded
by how many apps you permit — on a locked-down phone that is a handful, not the endless treadmill a
consumer product would face.

## Decrypt or pass through — decided per hostname (2026-09-03)

The fact that shapes this: **on Android 7 and later, apps do not trust a user-installed
certificate.** Only browsers do. So decrypting a connection only ever helps when a browser made it,
and breaks any app that made it — and Squid cannot see which app opened a connection, only the
hostname it asked for.

The first live phone showed both failure modes in one afternoon. With `ssl_bump splice wg_phones`
in place, every app worked and nothing was filtered: Instagram and TikTok loaded through blind
tunnels the filter never saw. With that line removed, Instagram was blocked and Moovit broke, and
every further app would have needed a line in `splice.txt` forever.

So the decision is made per hostname, at the TLS handshake, by asking the filter:

| Hostname is… | Squid does | Why |
|---|---|---|
| approved for this phone's rung | **splice** — tunnel untouched | apps work, nothing needs a certificate |
| denied | **bump** — decrypt | Chrome gets the block page instead of a dead connection; an app just fails, which is a block either way |
| a search engine (`bump_hosts`) | always bump | the typed query is in the URL; judging it is the point |
| on the explicit blocklist | always bump | so the block page can explain itself |
| in `splice.txt` | splice, never judged | Google account/Play infrastructure, WhatsApp, the MDM host |

In `squid.conf` this is one rule, `ssl_bump splice filter_allows`, placed before `ssl_bump bump all`.
The helper already turns the handshake's `host:443` into `https://host/` and runs the site check
with the phone's rung, so no helper or Worker change is needed.

What it gives up: on an approved site Chrome is filtered by **hostname**, not full path, and the
rung-2 image stripping cannot see inside a spliced tunnel. That is the granularity the DNS design
had, and path filtering is already deferred in the README. What it removes: the per-app splice
treadmill. `splice.txt` is now only for hosts that must never be judged at all.

Identity for WireGuard phones is the tunnel address (`10.66.0.x`), stored in `devices.proxy_user`.
The helper is fed `%LOGIN %SRC %URI` and uses `%SRC` when there is no login. The Worker never
knows the difference.

## WireGuard — how phones reach the proxy

Design and install steps are in `WIREGUARD.md`; the server side is generated by `scripts/install-wireguard.sh`. Phones get a
config with `AllowedIPs = 0.0.0.0/0`, so everything transits the box: iptables on `wg0` sends
tcp/80 and tcp/443 into Squid's intercept ports, rejects udp/443 so QUIC cannot bypass the TCP
path, and NATs the rest. The tunnel address is the phone's identity. Peers are added by
`scripts/new-wg-phone.sh`; the per-phone checklist is `NEW-PHONE.md`.

## The bug that blocked every search (found 2026-09-04)

`external_acl_type` used `%LOGIN`. That token means *the authenticated login* and makes Squid
require proxy authentication before it consults the helper. Intercepted tunnel requests cannot
authenticate, so Squid denied every tunnel lookup itself, in 0 ms, without running the helper:

```
aclMatchExternal: shmira_filter check user authenticated.
NOTICE: Authentication not applicable on intercepted requests.
aclMatchExternal: shmira_filter user not authenticated (DENIED)
```

Symptoms: decrypted requests (searches) always hit the block page; spliced sites loaded
unfiltered; the helper answered OK whenever run by hand; no helper decision was ever logged. The
fix is `%un`, which forces nothing and is `-` for a tunnel phone. To see this class of problem in
future: `debug_options ALL,1 82,4` for one page load, then `tail cache.log`, then remove it.

## Deploying

```
sudo ./scripts/install-squid.sh
```

Then, in order:

1. `wrangler secret put PROXY_KEY` on the Worker
2. The same value into `SHMIRA_PROXY_KEY` in `/etc/squid/filter.env`
3. `htpasswd -B /etc/squid/passwd <device-name>` — one login per phone
4. Set that name as `proxy_user` on the device's row in D1
5. `systemctl enable --now squid`

On each phone:

```
adb shell settings put global http_proxy <server>:3128
```

and install `/etc/squid/ssl/filter-ca.der` as a CA certificate.

**Move off port 3128 before this is real.** Networks routinely block unusual ports, and a filter that
stops working on someone else's wifi is a filter people remove. 443 is the port nothing blocks.

## Things that will bite

- **Install `squid-openssl`, not `squid`.** Ubuntu's stock package has no TLS interception compiled
  in and rejects `ssl_bump` outright. `install-squid.sh` handles this; a manual install probably
  won't.
- **Port 8080 on that server is Tomcat** — the Headwind panel. Don't take it.
- **The root CA private key is the crown jewel.** Whoever holds it can impersonate any site to every
  enrolled phone, banks included. It stays on the proxy, is readable only by `proxy`, and is not
  backed up anywhere. Losing it means re-enrolling phones; leaking it means everyone is exposed.
- **The CA expires in ten years.** When it does, every phone stops at once with no remote fix — each
  needs the replacement installed by hand. Record the date somewhere that will outlive this repo.
- **The access log is off by design.** This proxy sees every address every phone visits; keeping that
  record on a box not hardened for it is a liability, not a feature. Turn it on to debug, then off.

## Still to build

- Per-level enforcement is not wired to the proxy yet — `/api/verdict` still writes one shared
  Gateway list. The ratings and doorway flags are recorded, so switching over is a read of columns
  already populated.
- The block page doesn't yet distinguish `blocked` from `unknown` from `search`, though the endpoint
  returns all three.
- No admin UI for assigning a device its level or proxy login.
- Nothing tunes Squid for the box's size. It also runs Headwind on 2 GB.
