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
The helper turns the handshake's target into `https://host/` and runs the site check with the
phone's rung.

**Corrected 2026-09-21, from squid's source.** At ssl_bump step 2 squid evaluates the rules against
the fake CONNECT it built at step 1, before it had read the client hello, and for an INTERCEPTED
connection that request's host is the destination IP address — so `%URI` handed the helper
`199.232.214.250:443`, not `image-cdn-fa.spotifycdn.com:443`, and the Worker judged an address:
on no list, allowed, spliced. Every hostname decision this section describes for the tunnel path
was hollow from 2026-09-03 until now. The client hello's server name is available only as
`%ssl::>sni`; the helper format carries it now and the helper prefers it whenever the target is
an address. (The browser port's explicit `CONNECT host:443` always carried the name, so Chrome
was filtered as described.) Two further facts from the same reading: an ERR from the helper is
only a *non-match* of `filter_allows` — the later rules decide, and the last one is `bump all`;
and a lookup squid cannot complete (helper queue full, a reconfigure restarting the helpers) ends
the whole evaluation with no match, whose default at step 2 is **splice**. That is why the in-app
picture rule is matched by squid itself, from the SNI, with fast ACLs only (YESHIVA.md).

What it gives up: on an approved site Chrome is filtered by **hostname**, not full path, and the
rung-2 image stripping cannot see inside a spliced tunnel. That is the granularity the DNS design
had, and path filtering is already deferred in the README. What it removes: the per-app splice
treadmill. `splice.txt` is now only for hosts that must never be judged at all.

**The browser's own door (2026-09-06).** Image stripping needs a decrypted connection, and Squid
cannot tell an app's connection from Chrome's by hostname — but it can tell them apart by PORT.
Port 3128 is now the browser port (`http_port 3128 name=browser`, `ssl_bump bump browser_port`):
Chrome is given it as an explicit proxy through the tunnel (Headwind pushes the Chrome managed
policy `ProxyMode=fixed_servers`, `ProxyServer=10.66.0.1:3128`), and everything arriving there is
bumped. App traffic never comes that way; it takes the intercept ports and the per-hostname
splice decision above, so no app ever needs a splice entry for the browser's sake. The helper
forwards what the browser said it was fetching (`%>ha{Sec-Fetch-Dest}`) so an image with no file
extension is still caught, and the block page answers an image fetch with a blank placeholder so
the layout keeps its shape. (`YESHIVA.md` is the first user; it applies to any images-off rung.)
The helper can still force a bump of every approved host for one phone — `decrypt: true` from the
Worker makes it answer ERR at the handshake — kept as a fallback, off on every ladder.

Identity for WireGuard phones is the tunnel address (`10.66.0.x`), stored in `devices.proxy_user`.
The helper is fed `%LOGIN %SRC %URI` and uses `%SRC` when there is no login. The Worker never
knows the difference.

## WireGuard — how phones reach the proxy

Design and install steps are in `WIREGUARD.md`; the server side is generated by `scripts/install-wireguard.sh`. Phones get a
config with `AllowedIPs = 0.0.0.0/0`, so everything transits the box: iptables on `wg0` sends
tcp/80 and tcp/443 into Squid's intercept ports, rejects udp/443 so QUIC cannot bypass the TCP
path, and NATs the rest. The tunnel address is the phone's identity. Peers are added by
`scripts/new-wg-phone.sh`; the per-phone checklist is `NEW-PHONE.md`.

## The DNS layer: two resolvers, one cache (2026-09-21)

The proxy decides by SNI, and two things never present one: an ad an app fetches over a protocol
or port the proxy does not intercept, and a picture an app sends down a connection it already
holds to another host on the same CDN (HTTP/2 connection coalescing — same address, a wildcard
certificate that covers both names, no new handshake). Both are refused where a name is turned
into an address instead: the phones' resolver. `scripts/install-dns-policy.sh` sets it up.

```
phone ──DNS──▶ 10.66.0.1  STRICT  (shmira-dnsmasq-strict): NXDOMAIN for the in-app picture hosts
                  │                 (/etc/shmira/dnsmasq-strict.d/app-media.conf, sync-media-on.sh),
                  │                 no cache, forwards everything else to ──┐
                  │                                                         ▼
phone in the  ──DNS──▶ 10.66.1.1 ─┐                                   127.0.0.1  OPEN (the packaged
media-on ipset (DNAT)             ├──▶ OPEN: the cache, upstream 1.1.1.1, the ad blocklist
squid ─────────────▶ 127.0.0.1 ───┘         (/etc/dnsmasq.d/shmira-adblock.conf, sync-adblock.sh)
```

- **One cache for everyone.** The strict instance caches nothing and forwards to the open one, so
  every phone and squid draw the same answer — the property squid's intercept host check depends
  on (`WIREGUARD.md`). The only names the two disagree on are the picture hosts, which a strict
  phone never connects to, and the ad hosts, which nobody resolves.
- **The ad list applies to every phone** through that forwarding: in-app ads (AdMob, Meta
  Audience Network, AppLovin, Unity, ironSource, Vungle, Chartboost, InMobi, Pangle, Mintegral,
  Amazon …) get no address and the SDK shows nothing. `sync-adblock.sh` pulls hagezi's Pro list
  nightly (228k names, `local=/host/` lines; dnsmasq loads them in 0.1 s and 20 MB — checked
  2026-09-22: Pro is the first tier covering all eleven SDK families and the last that leaves
  Meta's, Google's, Samsung's and WhatsApp's own hosts alone) plus its encrypted-DNS and
  VPN/proxy-bypass lists (16k names: DoH resolvers, web proxies, "school bypass" sites), adds
  Firefox's DoH canary by hand, pins the hosts apps need (`graph.facebook.com`, the filter's own)
  with `server=` lines that win over any parent entry, normalises any list format, refuses a
  truncated download, and rolls back a list that leaves the resolver dead. Android does not
  cache these NXDOMAINs (they carry no SOA) and re-asks every couple of seconds, so an allowlist
  change takes effect at once. It does NOT touch first-party ads that ride the content's own
  hosts — YouTube's in-app ads, Spotify's free-tier audio ads, Instagram/Facebook feed ads.
- **squid enforces the DNS list as a side effect.** An app that reaches an ad host by a hard-coded
  address still presents the name as SNI; squid resolves it through the open resolver, gets
  NXDOMAIN, and its intercept host check answers 409. No second ACL is needed.
- **No resolver but ours.** `shmira-dns-policy.service` DNATs every port-53 packet from the
  tunnel — whatever resolver it was addressed to, 8.8.8.8 included — to the strict resolver (or
  the open one for a picture-allowed phone), rejects tcp/udp 853 (DNS-over-TLS/QUIC; Android's
  "Automatic" Private DNS uses plain DNS meanwhile and backs off), the bypass list makes DoH
  resolver names unresolvable, Chrome's DoH auto-upgrade never fires for a private resolver
  address, and `no_config_private_dns` locks the setting.
- **Failure directions.** Strict down = the phones have no DNS (visible at once; the unit
  restarts itself). Open down = squid has no DNS (the dependency that already existed). Both lists
  and the ipset are allowlists or refusals that a missed sync leaves as they were. `--uninstall`
  puts the single resolver back. `health-check.sh` probes both instances and the plumbing.

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
