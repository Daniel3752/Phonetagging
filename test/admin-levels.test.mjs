// Operator routes for strictness: assigning a phone its rung and proxy login, and overriding what
// the classifier decided. Runs against a real SQLite database via the D1 shim, so the constraints
// being relied on are the real ones. No network, no credentials.
//
// The last section is the one worth having. An operator override on a search is only useful if the
// filter LOOKS IT UP under the same key — the two hash independently, and a mismatch would leave
// overrides sitting silently beside the real entries, never consulted.

import worker from '../src/index.js';
import { handleProxyCheck } from '../src/proxy-api.js';
import { makeDB } from './d1-shim.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

const DB = makeDB('./schema.sql');
const env = { DB, OPERATOR_KEY: 'op-key', PROXY_KEY: 'proxy-key', GEMINI_API_KEY: 'x' };

const admin = (path, body, method = 'POST') => worker.fetch(new Request(`https://w${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer op-key' },
  ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
}), env);

const proxyCheck = (user, url) => handleProxyCheck(new Request('https://w/api/proxy/check', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proxy-key' },
  body: JSON.stringify({ user, url }),
}), env);

console.log('\n1. a phone carries a rung and a proxy login');
await admin('/api/admin/policies', { id: 'pol1', name: 'default' });

let res = await admin('/api/admin/devices', {
  id: 'dev1', label: 'Dovid', policy_id: 'pol1', level: 3, proxy_user: 'dovid-phone',
});
let body = await res.json();
check('device saved with its rung', body.ok === true && body.level === 3, JSON.stringify(body));

let row = await DB.prepare('SELECT level, proxy_user FROM devices WHERE id = ?').bind('dev1').first();
check('rung and login persisted', row.level === 3 && row.proxy_user === 'dovid-phone', JSON.stringify(row));

res = await admin('/api/admin/devices', {
  id: 'dev2', label: 'Sara', policy_id: 'pol1', level: 2, proxy_user: 'dovid-phone',
});
check('a login cannot be shared by two phones', res.status === 409,
  'sharing a login would silently share a rung');

res = await admin('/api/admin/devices', { id: 'dev3', label: 'Bad', policy_id: 'pol1', proxy_user: 'has spaces!' });
check('a malformed login is refused', res.status === 400);

res = await admin('/api/admin/devices', { id: 'dev4', label: 'Typo', policy_id: 'pol1', level: 99 });
body = await res.json();
check('a nonsensical rung clamps to the strictest, not the loosest', body.level === 1,
  'a typo in a form must never open a phone up');

console.log('\n2. moving a phone between rungs');
res = await admin('/api/admin/devices/level', { id: 'dev1', level: 1 });
body = await res.json();
row = await DB.prepare('SELECT level FROM devices WHERE id = ?').bind('dev1').first();
check('rung changed', body.ok === true && row.level === 1);

res = await admin('/api/admin/devices/level', { id: 'nope', level: 2 });
check('an unknown phone is a 404, not a silent success', res.status === 404);

console.log('\n3. overriding the classifier on a site');
await admin('/api/admin/sites/level', { hostname: 'news.example.com', level: 2, reason: 'Fine.' });
row = await DB.prepare(`SELECT level, source, verdict FROM url_verdicts WHERE hostname = ?`)
  .bind('news.example.com').first();
check('site rated and marked as an operator decision',
  row.level === 2 && row.source === 'operator' && row.verdict === 'clean', JSON.stringify(row));

await admin('/api/admin/sites/level', { hostname: 'https://Bad.Example.COM/some/path', level: 6 });
row = await DB.prepare(`SELECT hostname, verdict FROM url_verdicts WHERE hostname = ?`)
  .bind('bad.example.com').first();
check('a pasted URL is reduced to its hostname and lowercased, NEVER is blocked',
  !!row && row.verdict === 'blocked', JSON.stringify(row));

console.log('\n4. an override on a site is what the proxy then enforces');
await admin('/api/admin/devices/level', { id: 'dev1', level: 2 });
let out = await (await proxyCheck('dovid-phone', 'https://news.example.com/story')).json();
check('the overridden site resolves for that phone', out.allow === true, JSON.stringify(out));
out = await (await proxyCheck('dovid-phone', 'https://bad.example.com/')).json();
check('the never-rated site does not', out.allow === false);

console.log('\n5. an override on a search is found under the key the filter uses');
await admin('/api/admin/searches/level', { query: 'Volcano Facts', level: 1 });

// Different case, different word order, extra punctuation: the filter must still find the override,
// or operator decisions would sit beside the real entries and never be consulted.
out = await (await proxyCheck('dovid-phone', 'https://www.google.com/search?q=facts%2C+volcano')).json();
check('a reworded search hits the operator override', out.allow === true && out.level === 1,
  JSON.stringify(out));

await admin('/api/admin/searches/level', { query: 'something else', level: 5 });
out = await (await proxyCheck('dovid-phone', 'https://www.google.com/search?q=SOMETHING+ELSE')).json();
check('a never-rated search is refused', out.allow === false && out.action === 'search');

console.log('\n6. deleting a phone takes its schedules with it');
await admin('/api/admin/schedules', {
  id: 'sch1', device_id: 'dev1', base_policy_id: 'pol1', active_policy_id: 'pol1',
  day_mask: 127, start: '22:00', end: '06:00',
});
await admin('/api/admin/devices/delete', { id: 'dev1' });
const left = await DB.prepare('SELECT COUNT(*) AS n FROM schedules WHERE device_id = ?').bind('dev1').first();
check('schedules removed with the device', left.n === 0,
  'a later device reusing the id would inherit a strangerticket of time windows');

console.log('\n7. the ladder is served, not hard-coded in the page');
const state = await (await admin('/api/admin/state', null, 'GET')).json();
check('state carries the level definitions', Array.isArray(state.levels) && state.levels.length === 5);

console.log(failures ? `\n${failures} FAILED\n` : '\nAll admin-level checks passed.\n');
process.exit(failures ? 1 : 0);
