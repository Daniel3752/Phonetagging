// Offline end-to-end test of the worker's routes: D1, Cloudflare Gateway and Gemini are all faked,
// so this runs with no network, no credentials and no wrangler. Run with: npm test
//
// The section-2 checks exist to pin down a specific past bug — a 'clean' verdict was written to D1
// BEFORE the Gateway allowlist write, and the Gateway failure was swallowed, so a failed write left
// the site cached as approved but never actually allowlisted, and the cache-hit path meant it was
// never retried. Order of operations is load-bearing here; these checks keep it that way.

import worker from '../src/index.js';

// --- Fakes ---------------------------------------------------------------
const rows = new Map();
const gatewayList = new Set();
let gatewayFails = false;
let geminiSafe = true;  // drives the fake's rating: 2 (General) when safe, 5 (Never) when not

const DB = {
  prepare(sql) {
    const q = { sql, args: [] };
    q.bind = (...a) => { q.args = a; return q; };
    q.first = async () => {
      if (/SELECT verdict/.test(sql)) return rows.get(q.args[0]) || null;
      return null;
    };
    q.run = async () => {
      const [hash, url, hostname, verdict, reason, source] = q.args;
      rows.set(hash, { verdict, reason, url, hostname, source });
      return { success: true };
    };
    return q;
  },
};

const env = {
  DB,
  CF_ACCOUNT_ID: 'acct',
  CF_GATEWAY_API_TOKEN: 'tok',
  CF_GATEWAY_HOST_LIST_ID: 'hostlist',
  GEMINI_API_KEY: 'k',
  OPERATOR_KEY: 'secret-operator-key',
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.cloudflare.com')) {
    if (gatewayFails) return new Response('nope', { status: 400 });
    const body = JSON.parse(opts.body);
    for (const it of body.append) gatewayList.add(it.value);
    for (const v of body.remove) gatewayList.delete(v);
    return Response.json({ success: true });
  }
  if (u.includes('generativelanguage')) {
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      level: geminiSafe ? 2 : 5, is_doorway: false,
      reason: geminiSafe ? 'Ordinary site.' : 'Dating app.',
    }) }] } }] });
  }
  return new Response('<html><head><title>Example</title></head><body>hello world</body></html>');
};

// --- Helpers -------------------------------------------------------------
const post = (path, body, headers = {}) => worker.fetch(new Request('https://w.dev' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
}), env);

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

// --- Tests ---------------------------------------------------------------
console.log('\n1. clean site is allowlisted then cached');
let r = await (await post('/api/verdict', { url: 'https://en.wikipedia.org/wiki/Cat' })).json();
check('verdict clean', r.verdict === 'clean', JSON.stringify(r));
check('hostname returned', r.hostname === 'en.wikipedia.org', JSON.stringify(r));
check('hostname in gateway list', gatewayList.has('en.wikipedia.org'), [...gatewayList].join());
check('not full URL in list', !gatewayList.has('https://en.wikipedia.org/wiki/Cat'));

r = await (await post('/api/verdict', { url: 'https://en.wikipedia.org/wiki/Dog' })).json();
check('different path hits same host cache', r.cached === true, JSON.stringify(r));

console.log('\n2. THE BUG FIX: gateway failure must not cache a "clean" verdict');
gatewayFails = true;
r = await (await post('/api/verdict', { url: 'https://newsite.example/' })).json();
check('returns error not clean', r.verdict === 'error', JSON.stringify(r));
check('nothing cached', rows.size === 1, 'rows=' + rows.size);
check('nothing allowlisted', !gatewayList.has('newsite.example'));
gatewayFails = false;
r = await (await post('/api/verdict', { url: 'https://newsite.example/' })).json();
check('retry after recovery succeeds', r.verdict === 'clean' && gatewayList.has('newsite.example'), JSON.stringify(r));

console.log('\n3. unsafe site blocked, never allowlisted');
geminiSafe = false;
r = await (await post('/api/verdict', { url: 'https://bad.example/' })).json();
check('verdict blocked', r.verdict === 'blocked', JSON.stringify(r));
check('not allowlisted', !gatewayList.has('bad.example'));
geminiSafe = true;

console.log('\n4. operator allow + revoke');
r = await post('/api/admin/allow', { url: 'bad.example' });
check('unauthorized without key', r.status === 401);
r = await (await post('/api/admin/allow', { url: 'bad.example' }, { Authorization: 'Bearer secret-operator-key' })).json();
check('operator override allows', gatewayList.has('bad.example'), JSON.stringify(r));
r = await (await post('/api/admin/revoke', { url: 'bad.example' }, { Authorization: 'Bearer secret-operator-key' })).json();
check('revoke removes from list', !gatewayList.has('bad.example'), JSON.stringify(r));
r = await (await post('/api/verdict', { url: 'https://bad.example/x' })).json();
check('revoked site reads as blocked', r.verdict === 'blocked' && r.cached === true, JSON.stringify(r));

console.log('\n5. input validation');
check('bare domain accepted', (await (await post('/api/verdict', { url: 'example.org' })).json()).verdict === 'clean');
check('ftp rejected', (await post('/api/verdict', { url: 'ftp://x.com' })).status === 400);
check('missing url rejected', (await post('/api/verdict', {})).status === 400);

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
