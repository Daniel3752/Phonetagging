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
  devices = new Map([['phone-a', { id: 'dev1', level: 2 }], ['phone-open', { id: 'dev2', level: 4 }]]);
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
    q.run = async () => {
      if (/INSERT INTO search_verdicts/.test(sql)) {
        searchVerdicts.set(q.args[0], { level: q.args[2], reason: q.args[3] });
      }
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

console.log('\n3. ordinary requests are judged on the site');
reset();
await check('an unclassified site is denied, and marked requestable', async () => {
  const r = await (await ask({ user: 'phone-a', url: 'https://brand-new-site.com/page' })).json();
  assert.equal(r.allow, false);
  assert.equal(r.action, 'unknown');
});
await check('a site at the rung is allowed', async () => {
  siteVerdicts.set(await sha('news.example.com'), { level: 2, is_doorway: 0, reason: 'News.' });
  const r = await (await ask({ user: 'phone-a', url: 'https://news.example.com/story/1' })).json();
  assert.equal(r.allow, true);
});
await check('a site above the rung is blocked, not requestable', async () => {
  siteVerdicts.set(await sha('fashion.example.com'), { level: 4, is_doorway: 0, reason: 'Fashion.' });
  const r = await (await ask({ user: 'phone-a', url: 'https://fashion.example.com/' })).json();
  assert.equal(r.allow, false);
  assert.equal(r.action, 'blocked');
});
await check('a never-rated site is blocked even on the loosest rung', async () => {
  siteVerdicts.set(await sha('bad.example.com'), { level: 5, is_doorway: 0, reason: 'Explicit.' });
  const r = await (await ask({ user: 'phone-open', url: 'https://bad.example.com/' })).json();
  assert.equal(r.allow, false);
});
await check('a doorway is blocked below the rung that permits doorways', async () => {
  siteVerdicts.set(await sha('portal.example.com'), { level: 1, is_doorway: 1, reason: 'Search.' });
  const strict = await (await ask({ user: 'phone-a', url: 'https://portal.example.com/' })).json();
  const open = await (await ask({ user: 'phone-open', url: 'https://portal.example.com/' })).json();
  assert.equal(strict.allow, false, 'clean rating must not smuggle a doorway through');
  assert.equal(open.allow, true);
});

console.log('\n4. unknown devices degrade to the strictest rung, not to open');
reset();
await check('an unregistered proxy user gets the strictest rung', async () => {
  siteVerdicts.set(await sha('news.example.com'), { level: 2, is_doorway: 0, reason: 'News.' });
  const r = await (await ask({ user: 'who-is-this', url: 'https://news.example.com/' })).json();
  assert.equal(r.device_level, 1);
  assert.equal(r.allow, false);
  assert.equal(r.known_device, false);
});
await check('a missing user is also strictest', async () => {
  const r = await (await ask({ url: 'https://news.example.com/' })).json();
  assert.equal(r.device_level, 1);
});
await check('a level-1 site still resolves for an unknown device', async () => {
  siteVerdicts.set(await sha('torah.example.com'), { level: 1, is_doorway: 0, reason: 'Torah.' });
  const r = await (await ask({ user: 'who-is-this', url: 'https://torah.example.com/' })).json();
  assert.equal(r.allow, true);
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
