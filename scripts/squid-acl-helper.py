#!/usr/bin/env python3
"""
Squid external ACL helper — asks the Worker about every request.

Squid speaks a line protocol on stdin/stdout. With concurrency=N each line arrives as

    <channel-id> <login> <url>

and must be answered with

    <channel-id> OK
    <channel-id> ERR message="..."

Everything here is shaped by one fact: a person is waiting on a page. A single page load fans out
into dozens of requests, most of them to hosts already decided moments ago, so the local cache below
is not an optimisation — without it every image on a page would cost a round trip to the Worker and
browsing would feel broken.

Fails CLOSED. If the Worker is unreachable the answer is ERR, not OK. A filter that opens up when its
brain is unavailable is indistinguishable from no filter, and the failure mode of being too strict
(a page does not load) is recoverable in a way that the other direction is not.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

WORKER_URL = os.environ.get('SHMIRA_WORKER_URL', 'https://phone-url-filter.daniel08-madar.workers.dev')
PROXY_KEY = os.environ.get('SHMIRA_PROXY_KEY', '')
# Generous, because the Worker may classify a brand-new domain INLINE (fetch its homepage + a model
# call) on the first hit — several seconds. A slow answer holds one page; a too-short timeout would
# deny every genuinely-new site. Cached hits still return in milliseconds.
TIMEOUT = float(os.environ.get('SHMIRA_TIMEOUT', '12.0'))

# --- Blocklists ----------------------------------------------------------------------------------
#
# Two domain lists synced from the shmiras-blocklists repo (scripts/sync-blocklists.sh, daily):
#   level1.json — explicit. Blocked at EVERY rung, so it is checked here BEFORE the Worker is even
#                 asked. This is what keeps the permissive rungs (4, 5) safe: the Worker allows an
#                 unknown host by default there, so an explicit site must be caught first.
#   level2.json — social. Blocked at rungs 1-4 and allowed at rung 5, so its check needs the rung,
#                 which the Worker returns as device_level; a tiny (~30-domain) list, applied after.
#
# Matching is by SUFFIX (a domain and all its subdomains), unlike the exact-host allowlist — a
# blocklist that only matched the apex would miss www. and every CDN subdomain. Loaded into sets and
# reloaded when the files change, so a daily sync is picked up without restarting the helper.
BLOCKLIST_DIR = os.environ.get('SHMIRA_BLOCKLIST_DIR', '/etc/squid/blocklists')
BLOCKLIST_RELOAD_SECS = float(os.environ.get('SHMIRA_BLOCKLIST_RELOAD', '300'))

_blocklists = {'level1': set(), 'level2': set()}
_blocklist_mtimes = {'level1': 0.0, 'level2': 0.0}
_blocklist_checked_at = 0.0


def _extract_domains(obj):
    """The repo nests domains under category keys (level1.video, level2.social, ...). Flatten every
    list of strings found, whatever the categories are called, so a new category needs no code change."""
    out = set()
    if isinstance(obj, dict):
        for value in obj.values():
            out |= _extract_domains(value)
    elif isinstance(obj, list):
        for item in obj:
            if isinstance(item, str) and item.strip():
                out.add(item.strip().lower().rstrip('.'))
            else:
                out |= _extract_domains(item)
    return out


def _load_one(name):
    path = os.path.join(BLOCKLIST_DIR, f'{name}.json')
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return  # no file yet — an empty set means this list simply does not fire
    if mtime == _blocklist_mtimes[name]:
        return
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            data = json.load(fh)
        _blocklists[name] = _extract_domains(data)
        _blocklist_mtimes[name] = mtime
    except (OSError, ValueError):
        pass  # keep the previously loaded set rather than blanking the blocklist on a bad write


def _refresh_blocklists():
    global _blocklist_checked_at
    now = time.time()
    if now - _blocklist_checked_at < BLOCKLIST_RELOAD_SECS:
        return
    _blocklist_checked_at = now
    _load_one('level1')
    _load_one('level2')


def _domain_blocked(host, blockset):
    """True if host, or any parent domain of it, is in blockset. a.b.example.com matches an entry for
    example.com. Stops at two labels — a TLD alone is never a blocklist entry."""
    if not blockset:
        return False
    labels = host.split('.')
    for i in range(len(labels) - 1):
        if '.'.join(labels[i:]) in blockset:
            return True
    return False

# A page load hits the same host dozens of times. Short TTL so an operator's decision reaches the
# phones quickly — a minute of staleness is invisible to a person, and the alternative is a filter
# where "I've allowed it" means "in an hour".
CACHE_TTL = float(os.environ.get('SHMIRA_CACHE_TTL', '60'))
CACHE_MAX = 5000

_cache: "dict[tuple[str, str], tuple[float, bool]]" = {}


def _cache_get(key):
    hit = _cache.get(key)
    if not hit:
        return None
    expires, allow = hit
    if expires < time.time():
        _cache.pop(key, None)
        return None
    return allow


def _cache_put(key, allow):
    # Crude eviction: when full, drop the whole thing rather than track recency. This cache is a
    # latency shim, not a store — a cold start costs one round trip per host and nothing else.
    if len(_cache) >= CACHE_MAX:
        _cache.clear()
    _cache[key] = (time.time() + CACHE_TTL, allow)


def ask_worker(user, url):
    """Returns (allow: bool, reason: str, level: int|None). Raises nothing — failure means blocked."""
    payload = json.dumps({'user': user, 'url': url}).encode()
    req = urllib.request.Request(
        f'{WORKER_URL}/api/proxy/check',
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {PROXY_KEY}',
            # Cloudflare blocks Python's default urllib agent outright with error 1010 (a bot
            # signature block), which surfaces as an unexplained 403 and denies every request while
            # the key and the route are both perfectly fine. Identify as this project instead.
            'User-Agent': 'shmira-filter-proxy/1.0',
            'Accept': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        # Name the status and echo what the Worker said. "filter unavailable" alone sends you hunting
        # through Squid internals when the answer is usually one of two things: 401 (the proxy key
        # here does not match PROXY_KEY on the Worker) or 404 (the Worker predates /api/proxy/check
        # and needs deploying).
        detail = ''
        try:
            detail = exc.read().decode()[:120]
        except Exception:
            pass
        return False, f'filter error HTTP {exc.code} {detail}'.strip(), None, False, False
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
        return False, f'filter unreachable ({type(exc).__name__})', None, False, False

    level = body.get('device_level')
    level = level if isinstance(level, int) else None
    return (
        bool(body.get('allow')),
        body.get('reason') or body.get('action') or 'blocked',
        level,
        body.get('images_off') is True,
        body.get('cache_scope') == 'host',
    )


def _host_of(url):
    try:
        return (urllib.parse.urlsplit(url).hostname or '').lower().rstrip('.')
    except ValueError:
        return ''


# When a search comes back "text OK, images shtus" (images_off), the search engine's own result
# THUMBNAIL hosts are suppressed for that user for a short window, so the results render as text with
# no pictures. Only the thumbnail hosts are touched — ordinary site images are unaffected.
THUMB_SUPPRESS_SECS = 45.0
_thumb_suppress: "dict[str, float]" = {}  # user -> expiry time


def _sweep_thumb_suppress():
    """Drop expired entries so the dict stays bounded by active users, not by every login ever seen."""
    now = time.time()
    for user in [u for u, exp in _thumb_suppress.items() if exp <= now]:
        _thumb_suppress.pop(user, None)


def _is_search_thumb_host(host):
    return (
        host.startswith('encrypted-tbn') or          # Google image/result thumbnails
        host == 'th.bing.com' or                      # Bing thumbnails
        (host.startswith('tse') and host.endswith('.mm.bing.net'))
    )


# Request paths answered locally, instantly, without the Worker. Search AUTOCOMPLETE fires one
# request per keystroke, each a unique URL — rating those would cost a model call per letter typed
# and stall the helper behind a wall of lookups (the /search request then overflows squid's queue
# and gets denied out of hand, which looked exactly like "all searches blocked"). Denying them is
# invisible: Chrome just shows no suggestions while typing. gen_204/client_204 are telemetry pings.
_FAST_DENY_PREFIXES = ('/complete/', '/gen_204', '/client_204', '/async/')


def _fast_local_path(url):
    try:
        path = urllib.parse.urlsplit(url).path or '/'
    except ValueError:
        return None
    if any(path.startswith(p) for p in _FAST_DENY_PREFIXES):
        return False, 'suggestions/telemetry disabled', False
    return None


def decide(user, url):
    """The full local decision: fast local paths → search-thumbnail suppression → L1 blocklist (all
    rungs) → Worker → L2 blocklist (rungs 1-4). Returns (allow, reason, host_scoped).

    L1 is checked locally and first so an explicit host is denied without a Worker round trip and can
    never slip through the Worker's default-allow on a permissive rung. L2 is rung-dependent, so it is
    applied after the Worker answers with device_level.

    host_scoped is True when the answer depended on the hostname alone (the Worker says so, and the
    local lists are hostname-based anyway), so the caller may reuse it for every URL on that host."""
    fast = _fast_local_path(url)
    if fast is not None:
        return fast

    host = _host_of(url)

    # A result thumbnail while this user's last search asked for images-off. Per URL, per moment.
    if host and _is_search_thumb_host(host) and _thumb_suppress.get(user, 0) > time.time():
        return False, 'search images stripped', False

    if host and _domain_blocked(host, _blocklists['level1']):
        return False, 'blocklist: explicit', True

    allow, reason, level, images_off, host_scoped = ask_worker(user, url)

    # Arm thumbnail suppression for this user when a search was allowed text-only.
    if allow and images_off:
        _sweep_thumb_suppress()
        _thumb_suppress[user] = time.time() + THUMB_SUPPRESS_SECS

    # Social is blocked on every rung except the most open (5).
    if allow and host and level is not None and level <= 4 and _domain_blocked(host, _blocklists['level2']):
        return False, 'blocklist: social', True

    return allow, reason, host_scoped


def main():
    # Unbuffered both ways: Squid waits on each answer, so anything sitting in a buffer is a stalled
    # page rather than a delayed log line.
    for raw in sys.stdin:
        _refresh_blocklists()
        line = raw.rstrip('\n')
        if not line:
            continue

        parts = line.split(' ')
        # With concurrency on, the first field is the channel id and must be echoed back verbatim.
        if parts and parts[0].isdigit():
            channel, fields = parts[0], parts[1:]
        else:
            channel, fields = None, parts

        if channel is not None:
            # Concurrent mode: one blocking Worker round-trip must never stall the line. A page
            # load — a Google results page especially — bursts dozens of lookups at once, and a
            # helper that answers them one at a time overflows squid's lookup queue, which squid
            # fails CLOSED (instant deny). Channels exist precisely so answers can return out of
            # order; use them.
            _pool.submit(_answer, channel, fields)
        else:
            _answer(channel, fields)


def _answer(channel, fields):
    if len(fields) < 2:
        out = 'ERR message="malformed helper request"'
    else:
        # squid.conf sends "%LOGIN %SRC %URI". A password-path phone has a login; a WireGuard
        # phone has none ("-"), so its tunnel IP (%SRC) is its identity — the Worker looks both
        # up in the same devices.proxy_user column. The 2-field form is accepted so an old
        # squid.conf keeps working against a new helper during an upgrade.
        user = urllib.parse.unquote(fields[0])
        if len(fields) >= 3:
            src = urllib.parse.unquote(fields[1])
            url = urllib.parse.unquote(fields[2])
            if user == '-' or not user:
                user = src
        else:
            url = urllib.parse.unquote(fields[1])
        # On an HTTPS CONNECT — and at the TLS handshake, where squid.conf decides whether to splice
        # or bump — Squid passes the target as "host:port" with no scheme. Treat it as a request to
        # that host so the site check runs on the hostname. For a bumped host the decrypted GET
        # arrives later with the full "https://host/path?query" and is checked again — that is
        # where a search query is judged, so nothing is lost by coarse-checking the handshake.
        if '://' not in url:
            host = url.rsplit(':', 1)[0] if ':' in url else url
            url = 'https://' + host + '/'
        # Squid sends "-" for an unauthenticated login; the Worker treats an unknown user as the
        # strictest rung rather than denying outright, so pass it through as-is.
        if user == '-':
            user = ''

        # Two cache keys. A page load fans out into dozens of URLs on one host, and for an ordinary
        # site the answer is the same for all of them — so when the Worker says its decision was
        # per-host (cache_scope: 'host'), it is cached under the host and every other URL on that
        # host is answered locally. Searches and per-URL image decisions stay keyed by full URL.
        host_key = (user, 'host:' + _host_of(url))
        cached = _cache_get(host_key)
        if cached is None:
            cached = _cache_get((user, url))

        # A page load is a BURST: its dozens of requests arrive before the first answer is back, so
        # a cache alone still sends every one of them to the Worker. The first request for a host
        # leads; the rest wait for it, then read the cache it just filled. If the leader's answer
        # turns out to be per-URL (a search), the followers simply do their own lookup.
        leader = False
        if cached is None:
            with _inflight_lock:
                done = _inflight.get(host_key)
                if done is None:
                    done = _inflight[host_key] = threading.Event()
                    leader = True
            if not leader:
                done.wait(TIMEOUT + 1)
                cached = _cache_get(host_key)
                if cached is None:
                    cached = _cache_get((user, url))

        if cached is None:
            try:
                allow, reason, host_scoped = decide(user, url)
            except Exception as exc:  # a crashed lookup must still answer, and must fail closed
                allow, reason, host_scoped = False, f'helper exception {type(exc).__name__}', False
            _cache_put(host_key if host_scoped else (user, url), allow)
        else:
            allow, reason = cached, 'cached'

        if leader:
            with _inflight_lock:
                _inflight.pop(host_key, None)
            done.set()

        out = 'OK' if allow else f'ERR message={json.dumps(reason)}'

    # One writer at a time: an interleaved line desynchronizes every channel after it.
    with _stdout_lock:
        sys.stdout.write(f'{channel} {out}\n' if channel else f'{out}\n')
        sys.stdout.flush()


_stdout_lock = threading.Lock()
_inflight_lock = threading.Lock()
_inflight: "dict[tuple[str, str], threading.Event]" = {}
# Sized well above squid's per-helper concurrency (64 in squid.conf). Threads spend their time
# blocked on the Worker call or waiting for a leader's answer, so they are cheap — and running out
# of them is not: squid's lookup queue then overflows and squid FAILS CLOSED, denying everything.
_pool = ThreadPoolExecutor(max_workers=128)


if __name__ == '__main__':
    main()
