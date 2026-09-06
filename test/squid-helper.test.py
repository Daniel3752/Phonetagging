#!/usr/bin/env python3
"""Offline tests for the Squid ACL helper's line protocol and local rules. The Worker is faked, so
this runs with no network. Run with: npm run test:helper (or python3 test/squid-helper.test.py).

What is pinned here is the part squid.conf relies on and nobody can see in a browser: that the
helper refuses the splice at the TLS handshake for a phone whose images must be stripped, that it
then allows the decrypted requests on that host from the same cache entry except image fetches,
that a locked phone's message reaches the block page, and that the old 3-field line still works."""

import importlib.util
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('helper', os.path.join(HERE, '..', 'scripts', 'squid-acl-helper.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

failures = 0
def check(name, cond, extra=''):
    global failures
    print(('  PASS  ' if cond else '  FAIL  ') + name + ('' if cond else '  ' + str(extra)))
    if not cond:
        failures += 1

# --- a fake Worker ---------------------------------------------------------------------------------
calls = []
answers = {}

def fake_ask(user, url, dest=''):
    calls.append((user, url, dest))
    a = dict(helper._worker_failure('no fake answer'))
    a.update(answers.get(user, {}))
    return a

helper.ask_worker = fake_ask
helper._blocklists['level1'] = {'pornhub.com'}
helper._blocklists['level2'] = {'instagram.com'}
helper._blocklist_checked_at = float('inf')  # never touch the disk

def answer(line):
    """Feed one line through _answer and return what squid would read."""
    out = io.StringIO()
    real = sys.stdout
    sys.stdout = out
    try:
        parts = line.split(' ')
        helper._answer(parts[0], parts[1:])
    finally:
        sys.stdout = real
    return out.getvalue().strip()

def reset():
    helper._cache.clear()
    calls.clear()

# --- tests ---------------------------------------------------------------------------------------
print('\n1. a yeshiva (decrypt, strip) phone')
reset()
answers['10.66.0.4'] = {'allow': True, 'reason': 'Not on any list.', 'action': 'allow',
                        'host_scoped': True, 'strip': True, 'decrypt': True, 'block_social': True, 'level': 2}
r = answer('1 - 10.66.0.4 en.wikipedia.org:443 -')
check('the handshake is refused so squid bumps the connection', r.startswith('1 ERR') and 'decrypt' in r, r)
check('the tunnel IP was the identity', calls and calls[0][0] == '10.66.0.4', calls)
r = answer('2 - 10.66.0.4 https://en.wikipedia.org/wiki/Cat document')
check('the decrypted page is allowed from the cached host answer', r == '2 OK', r)
check('no second Worker call for the same host', len(calls) == 1, calls)
r = answer('3 - 10.66.0.4 https://en.wikipedia.org/static/logo.png image')
check('an image on that host is stripped locally', r.startswith('3 ERR') and 'image_blocked' in r, r)
r = answer('4 - 10.66.0.4 https://upload.wikimedia.org/thumbnail/abc image')
check('an image with no extension is stripped by Sec-Fetch-Dest', r.startswith('4 ERR') and 'image_blocked' in r, r)
r = answer('5 - 10.66.0.4 https://upload.wikimedia.org/api/data.json empty')
check('a non-image fetch on the same host is allowed', r == '5 OK', r)
check('still one Worker call per host', len(calls) == 2, calls)

print('\n2. a standard phone keeps splice-by-default')
reset()
answers['10.66.0.3'] = {'allow': True, 'reason': 'Rated 2.', 'action': 'allow',
                        'host_scoped': True, 'strip': False, 'decrypt': False, 'block_social': True, 'level': 4}
r = answer('1 - 10.66.0.3 en.wikipedia.org:443 -')
check('the handshake is allowed (spliced)', r == '1 OK', r)
r = answer('2 - 10.66.0.3 https://en.wikipedia.org/logo.png image')
check('images are not touched', r == '2 OK', r)

print('\n3. the lists')
reset()
r = answer('1 - 10.66.0.4 pornhub.com:443 -')
check('explicit is refused before the Worker is asked', r.startswith('1 ERR') and 'explicit' in r and not calls, r)
r = answer('2 - 10.66.0.4 https://www.instagram.com/ document')
check('social is refused where the Worker says the rung blocks it', r.startswith('2 ERR') and 'social' in r, r)
answers['10.66.0.9'] = {'allow': True, 'reason': 'ok', 'action': 'allow', 'host_scoped': True,
                        'strip': False, 'decrypt': False, 'block_social': False, 'level': 5}
r = answer('3 - 10.66.0.9 https://www.instagram.com/ document')
check('social is allowed where the Worker says it is not blocked', r == '3 OK', r)
answers['old-worker'] = {'allow': True, 'reason': 'ok', 'action': 'allow', 'host_scoped': True,
                         'strip': False, 'decrypt': False, 'block_social': None, 'level': 4}
r = answer('4 old-worker 10.66.0.1 https://www.instagram.com/ document')
check('an older Worker with no block_social: inferred from the rung', r.startswith('4 ERR') and 'social' in r, r)

print('\n4. a locked phone')
reset()
answers['10.66.0.4'] = {'allow': False, 'reason': 'This phone is locked for shiur right now.', 'action': 'locked',
                        'host_scoped': True, 'strip': False, 'decrypt': True, 'block_social': True, 'level': 2}
r = answer('1 - 10.66.0.4 https://en.wikipedia.org/ document')
check('the message starts with the action so the block page can say "locked"', r.startswith('1 ERR message="locked: '), r)

print('\n5. older squid.conf line shapes')
reset()
answers['dovid'] = {'allow': True, 'reason': 'ok', 'action': 'allow', 'host_scoped': True,
                    'strip': False, 'decrypt': False, 'block_social': True, 'level': 3}
r = answer('1 dovid 1.2.3.4 https://example.org/')
check('three fields (no dest) still work', r == '1 OK', r)
r = answer('2 dovid https://example.org/a')
check('two fields still work', r == '2 OK', r)
check('the login wins over the source address', calls and calls[0][0] == 'dovid', calls)

print('\n6. fast local paths never reach the Worker')
reset()
r = answer('1 - 10.66.0.4 https://www.google.com/complete/search?q=x empty')
check('autocomplete is refused locally', r.startswith('1 ERR') and not calls, r)

print(('\n%d FAILURE(S)' % failures) if failures else '\nAll helper checks passed.')
sys.exit(1 if failures else 0)
