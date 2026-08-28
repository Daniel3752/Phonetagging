// Per-phone proxy credentials: generated, not chosen, and readable back afterwards.
//
// The properties worth pinning down are the ones a person would otherwise get wrong by hand:
// a password is never reused between phones, re-saving a phone to change its rung does not
// invalidate the credential already typed into its Chrome, and a phone saved without a login still
// gets one rather than silently falling back to the strictest rung forever.

import worker from '../src/index.js';
import { generateProxyPassword, proxyUserFromLabel } from '../src/crypto.js';
import { makeDB } from './d1-shim.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

const DB = makeDB('./schema.sql');
const env = { DB, OPERATOR_KEY: 'op-key', PROXY_KEY: 'proxy-key', GEMINI_API_KEY: 'x' };

const admin = (path, body) => worker.fetch(new Request(`https://w${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer op-key' },
  body: JSON.stringify(body || {}),
}), env);

console.log('\n1. the generator');
const many = Array.from({ length: 500 }, () => generateProxyPassword());
check('shape is three readable groups', many.every((p) => /^[a-z2-9]{3}-[a-z2-9]{3}-[a-z2-9]{3}$/.test(p)));
check('no glyphs that get misread (i l 1 o 0)', !/[il1o0]/.test(many.join('')));
check('no collisions across 500', new Set(many).size === 500);

console.log('\n2. a login is derived from the label when none is given');
check('spaces and punctuation become a slug', proxyUserFromLabel('Cohen family — Dovid') === 'cohen-family-dovid');
check('a too-short label falls back rather than producing an invalid login', proxyUserFromLabel('X') === 'phone');

console.log('\n3. saving a phone mints credentials and the command to install them');
await admin('/api/admin/policies', { id: 'pol1', name: 'default' });
let body = await (await admin('/api/admin/devices', { id: 'dev1', label: 'Dovid', policy_id: 'pol1', level: 3 })).json();
const first = body.proxy_password;
check('a password came back', typeof first === 'string' && first.length === 11, JSON.stringify(body));
check('a login was derived from the label', body.proxy_user === 'dovid');
check('the htpasswd line is ready to paste', body.htpasswd === `htpasswd -B -b /etc/squid/passwd dovid '${first}'`, body.htpasswd);

let row = await DB.prepare('SELECT proxy_user, proxy_password FROM devices WHERE id = ?').bind('dev1').first();
check('stored so it can be read back later', row.proxy_password === first && row.proxy_user === 'dovid');

console.log('\n4. re-saving to change the rung keeps the credential the phone already has');
body = await (await admin('/api/admin/devices', { id: 'dev1', label: 'Dovid', policy_id: 'pol1', level: 5 })).json();
check('same password after a level change', body.proxy_password === first, `${first} -> ${body.proxy_password}`);
row = await DB.prepare('SELECT level, proxy_password FROM devices WHERE id = ?').bind('dev1').first();
check('the level did change', row.level === 5);
check('the password did not', row.proxy_password === first);

console.log('\n5. a second phone never shares the first one\'s credential');
body = await (await admin('/api/admin/devices', { id: 'dev2', label: 'Rivka', policy_id: 'pol1', level: 2 })).json();
check('different password', body.proxy_password !== first, body.proxy_password);
check('different login', body.proxy_user === 'rivka');

console.log('\n6. two phones cannot be given the same login');
const clash = await admin('/api/admin/devices', { id: 'dev3', label: 'Someone', policy_id: 'pol1', proxy_user: 'rivka' });
check('the duplicate is refused', clash.status === 409, String(clash.status));

console.log(failures ? `\n${failures} FAILURES` : '\nAll proxy-credential checks passed.');
process.exit(failures ? 1 : 0);
