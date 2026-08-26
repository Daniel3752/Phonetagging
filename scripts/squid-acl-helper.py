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
import time
import urllib.error
import urllib.parse
import urllib.request

WORKER_URL = os.environ.get('SHMIRA_WORKER_URL', 'https://phone-url-filter.daniel08-madar.workers.dev')
PROXY_KEY = os.environ.get('SHMIRA_PROXY_KEY', '')
TIMEOUT = float(os.environ.get('SHMIRA_TIMEOUT', '4.0'))

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
    """Returns (allow: bool, reason: str). Raises nothing — failure means blocked."""
    payload = json.dumps({'user': user, 'url': url}).encode()
    req = urllib.request.Request(
        f'{WORKER_URL}/api/proxy/check',
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {PROXY_KEY}',
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
        return False, f'filter error HTTP {exc.code} {detail}'.strip()
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError) as exc:
        return False, f'filter unreachable ({type(exc).__name__})'

    return bool(body.get('allow')), body.get('reason') or body.get('action') or 'blocked'


def main():
    # Unbuffered both ways: Squid waits on each answer, so anything sitting in a buffer is a stalled
    # page rather than a delayed log line.
    for raw in sys.stdin:
        line = raw.rstrip('\n')
        if not line:
            continue

        parts = line.split(' ')
        # With concurrency on, the first field is the channel id and must be echoed back verbatim.
        if parts and parts[0].isdigit():
            channel, fields = parts[0], parts[1:]
        else:
            channel, fields = None, parts

        if len(fields) < 2:
            out = 'ERR message="malformed helper request"'
        else:
            user = urllib.parse.unquote(fields[0])
            url = urllib.parse.unquote(fields[1])
            # On an HTTPS CONNECT, Squid passes the target as "host:port" with no scheme — there is
            # no URL yet, the tunnel hasn't been opened. Treat it as a request to that host so the
            # site check can run at the CONNECT gate. After ssl-bump the decrypted GET arrives with
            # the full "https://host/path?query", which is re-checked here — that is where a search
            # query actually gets judged, so nothing is lost by coarse-checking the CONNECT.
            if '://' not in url:
                host = url.rsplit(':', 1)[0] if ':' in url else url
                url = 'https://' + host + '/'
            # Squid sends "-" for an unauthenticated login; the Worker treats an unknown user as the
            # strictest rung rather than denying outright, so pass it through as-is.
            if user == '-':
                user = ''

            key = (user, url)
            cached = _cache_get(key)
            if cached is None:
                allow, reason = ask_worker(user, url)
                _cache_put(key, allow)
            else:
                allow, reason = cached, 'cached'

            out = 'OK' if allow else f'ERR message={json.dumps(reason)}'

        sys.stdout.write(f'{channel} {out}\n' if channel else f'{out}\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
