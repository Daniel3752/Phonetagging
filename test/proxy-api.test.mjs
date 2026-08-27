// Offline tests for the endpoint the filtering proxy asks about every request. D1 and Gemini are
// faked, so this runs with no network and no credentials. Run with: npm test
//
// The cases that matter are the failure directions. Every unknown — an unrecognised device, an
// unclassified site, a model outage, a malformed rating — must resolve to DENY, because this
// endpoint sits in the request path and a permissive default is indistinguishable from no filter
// at all.

import assert from 'node:assert';
import { handleProxyCheck } from '../src/proxy-api.js';

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`  PASS  ${name}`); }

// --- Fakes ---------------------------------------------------------------------------------------
let devices, siteVerdicts, searchVerdicts, geminiLevel, geminiFails, geminiCalls;

function reset() {
  // phone-a is a deny-by-default allowlist rung (2); phone-open is the most open, permissive rung (5).
  devices = new Map([['phone-a', { id: 'dev1', level: 2 }], ['phone-open', { id: 'dev2', level: 5 }]]);
  siteVerdicts = new Map();
  searchVerdicts = new Map();
  geminiLevel = 2;
  geminiFails = false;
  geminiCalls = 0;
}

const DB = {
  prepare(sql) {
    const q = { sql, args: [] };
    q.bind = (...a) => { q.args = a; return q; };
    q.first = async () => {
      if (/FROM devices/.test(sql)) return devices.get(q.args[0]) || null;
      if (/FROM search_verdicts/.test(sql)) return searchVerdicts.get(q.args[0]) || null;
      if (/FROM url_verdicts/.test(sql)) return siteVerdicts.get(q.args[0]) || null;
      return null;
    };
    // keyword_rules is the only .all() query on this path; empty means every query falls through to
    // the cache and the model, exactly as before the pre-filter existed.
    q.all = async () => ({ results: /FROM keyword_rules/.test(sql) ? [] : [] });
    q.run = async () => {
      if (/INSERT INTO search_verdicts/.test(sql)) {
        // columns: query_hash, query_sample, level, images_ok, reason, ...
        searchVerdicts.set(q.args[0], { level: q.args[2], images_ok: q.args[3], reason: q.args[4] });
      }
      // url_verdicts writes from inline classification are not stored by this fake — a re-hit simply
      // re-classifies, which no test depends on.
      return { success: true };
    };
    return q;
  },
};

const env = { DB, PROXY_KEY: 'proxy-secret', GEMINI_API_KEY: 'fake' };

globalThis.fetch = async () => {
  geminiCalls++;
  if (geminiFails) return new Response('boom', { status: 500 });
  return Response.json({ candidates: [{ content: { parts: [{
    text: JSON.stringify({ level: geminiLevel, reason: 'Test verdict.' }),
  }] } }] });
};

const ask = (body, key = 'proxy-secret') => handleProxyCheck(new Request('https://w/api/proxy/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify(body),
}), env);

const sha = async (s) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// --- Tests ---------------------------------------------------------------------------------------
console.log('\n1. the endpoint is not open');
reset();
await check('no key is rejected', async () => {
  assert.equal((await ask({ url: 'https://x.com/' }, null)).status, 401);
});
await check('a wrong key is rejected', async () => {
  assert.equal((await ask({ url: 'https://x.com/' }, 'nope')).status, 401);
});
await check('no key configured fails closed rather than open', async () => {
  const res = await handleProxyCheck(new Request('https://w/', { method: 'POST', body: '{}' }), { DB });
  assert.equal(res.status, 503);
});

console.log('\n2. searches are judged on the words typed');
reset();
await check('a clean search is allowed at the device rung', async () => {
  geminiLevel = 2;
  const r = await (await ask({ user: 'phone-a', url: 'https://www.google.com/search?q=volcano+facts' })).json();
  assert.equal(r.allow, true);
  assert.equal(r.engine, 'google');
});
await check('a search rated above the rung is refused', async () => {
  geminiLevel = 4;
  const r = await (await ask({ user: 'phone-a', url: 'https://www.google.com/search?q=swimwear' })).json();
  assert.equal(r.allow, false);
  assert.equal(r.action, 'search');
});
await check('the same search is allowed on a looser device', async () => {
  const r = await (await ask({ user: 'phone-open', url: 'https://www.google.com/search?q=swimwear' })).json();
  assert.equal(r.allow, true);
});
await check('the second identical search costs no model call', async () => {
  reset(); geminiLevel = 2;
  await ask({ user: 'phone-a', url: 'https://www.google.com/search?q=volcano+facts' });
  const before = geminiCalls;
  const r = await (await ask({ user: 'phone-a', url: 'https://www.google.com/search?q=Volcano+FACTS' })).json();
  assert.equal(geminiCalls, before, 'reworded query should hit the cache');
  assert.equal(r.allow, true);
});
await check('a model outage blocks the search and caches nothing', async () => {
  reset(); geminiFails = true;
  const r = await (await ask({ user: 'phone-open', url: 'https://www.google.com/search?q=anything' })).json();
  assert.equal(r.allow, false);
  assert.equal(searchVerdicts.size, 0, 'a transient failure must not become a cached verdict');
});

console.log('\n3. sites are judged by rating; unknown domains are classified inline');
reset();
await check('a pre-rated clean site is allowed at its rung', async () => {
  siteVerdicts.set(await sha('news.example.com'), { level: 2, is_doorway: 0, reason: 'News.' });
  const r = await (await ask({ user: 'phone-a', url: 'https://news.example.com/story/1' })).json();
  assert.equal(r.allow, true);
});
await check('a pre-rated shtus site is blocked below rung 5 but allowed at rung 5', async () => {
  siteVerdicts.set(await sha('fashion.example.com'), { level: 5, is_doorway: 0, reason: 'Fashion.' });
  const strict = await (await ask({ user: 'phone-a', url: 'https://fashion.example.com/' })).json();
  const open = await (await ask({ user: 'phone-open', url: 'https://fashion.example.com/' })).json();
  assert.equal(strict.allow, false, 'shtus is hidden below rung 5');
  assert.equal(open.allow, true, 'shtus shows at rung 5');
});
await check('a NEVER-rated site is blocked even on the most open rung', async () => {
  siteVerdicts.set(await sha('bad.example.com'), { level: 6, is_doorway: 0, reason: 'Explicit.' });
  const r = await (await ask({ user: 'phone-open', url: 'https://bad.example.com/' })).json();
  assert.equal(r.allow, false);
});
await check('an unknown clean domain is classified inline and allowed', async () => {
  reset(); geminiLevel = 2; // the classifier judges it essential/clean
  const before = geminiCalls;
  const r = await (await ask({ user: 'phone-a', url: 'https://brand-new.example/page' })).json();
  assert.equal(r.allow, true);
  assert.ok(geminiCalls > before, 'an unknown domain costs a classification');
});
await check('an unknown shtus domain is classified inline and gated by rung', async () => {
  reset(); geminiLevel = 5; // the classifier judges it shtus
  const strict = await (await ask({ user: 'phone-a', url: 'https://shtus-new.example/' })).json();
  const open = await (await ask({ user: 'phone-open', url: 'https://shtus-new.example/' })).json();
  assert.equal(strict.allow, false, 'shtus blocked below rung 5');
  assert.equal(open.allow, true, 'shtus allowed at rung 5');
});
await check('subdomains share the whole-domain verdict', async () => {
  reset();
  siteVerdicts.set(await sha('example.org'), { level: 2, is_doorway: 0, reason: 'Reference.' });
  const before = geminiCalls;
  const r = await (await ask({ user: 'phone-a', url: 'https://static.cdn.example.org/asset' })).json();
  assert.equal(r.allow, true, 'a subdomain inherits the registrable-domain verdict');
  assert.equal(geminiCalls, before, 'no new classification for a known domain');
});

console.log('\n4. unknown devices degrade to the strictest rung (rung 1 = no web)');
reset();
await check('an unregistered proxy user gets rung 1 and no web', async () => {
  siteVerdicts.set(await sha('news.example.com'), { level: 2, is_doorway: 0, reason: 'News.' });
  const r = await (await ask({ user: 'who-is-this', url: 'https://news.example.com/' })).json();
  assert.equal(r.device_level, 1);
  assert.equal(r.allow, false);
  assert.equal(r.action, 'no_web');
  assert.equal(r.known_device, false);
});
await check('a missing user is also rung 1', async () => {
  const r = await (await ask({ url: 'https://news.example.com/' })).json();
  assert.equal(r.device_level, 1);
  assert.equal(r.allow, false);
});
await check('even a level-1 site is unreachable at rung 1 — there is no browser', async () => {
  siteVerdicts.set(await sha('torah.example.com'), { level: 1, is_doorway: 0, reason: 'Torah.' });
  const r = await (await ask({ user: 'who-is-this', url: 'https://torah.example.com/' })).json();
  assert.equal(r.allow, false);
  assert.equal(r.action, 'no_web');
});

console.log('\n6. images and search-engine landings follow the rung');
reset();
await check('an image request is stripped on the text-only rung', async () => {
  const r = await (await ask({ user: 'phone-a', url: 'https://news.example.com/pic.jpg' })).json();
  assert.equal(r.allow, false);
  assert.equal(r.action, 'image_blocked');
});
await check('an image request loads on a rung with images on', async () => {
  const r = await (await ask({ user: 'phone-open', url: 'https://news.example.com/pic.jpg' })).json();
  assert.equal(r.allow, true);
});
await check('image search is refused where the rung does not permit it', async () => {
  const r = await (await ask({ user: 'phone-a', url: 'https://www.google.com/search?q=cats&udm=2' })).json();
  assert.equal(r.allow, false);
  assert.equal(r.action, 'image_search');
});
await check('image search is judged (not blocked outright) where the rung permits it', async () => {
  geminiLevel = 2;
  const r = await (await ask({ user: 'phone-open', url: 'https://www.google.com/search?q=cats&udm=2' })).json();
  assert.equal(r.allow, true);
  assert.equal(r.image_search, true);
});
await check('a search engine homepage loads so the box is reachable', async () => {
  const r = await (await ask({ user: 'phone-a', url: 'https://www.google.com/' })).json();
  assert.equal(r.allow, true);
  assert.equal(r.action, 'allow');
});

console.log('\n5. malformed input');
reset();
await check('a missing url is a 400', async () => {
  assert.equal((await ask({ user: 'phone-a' })).status, 400);
});
await check('a non-url is a 400', async () => {
  assert.equal((await ask({ user: 'phone-a', url: 'not a url' })).status, 400);
});

console.log(`\nAll ${passed} proxy-check tests passed.\n`);
