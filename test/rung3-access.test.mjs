import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { makeDB } from './d1-shim.mjs';
import { handleProxyCheck } from '../src/proxy-api.js';
import { sha256Hex } from '../src/crypto.js';

const DB = makeDB('./schema.sql');
DB._db.exec(readFileSync('migrations/0019_yeshiva_app_rules_refresh.sql', 'utf8'));
const before = DB._db.prepare("SELECT * FROM app_rules WHERE policy_id <> 'yeshiva_rung_3' ORDER BY policy_id, package_name").all();
const migration = readFileSync('migrations/0022_yeshiva_rung3_temporary_vpn.sql', 'utf8');
DB._db.exec(migration);
DB._db.exec(migration); // safe to reapply
assert.deepEqual(DB._db.prepare("SELECT * FROM app_rules WHERE policy_id NOT IN ('yeshiva_rung_3', 'yeshiva_rung_3_yt') ORDER BY policy_id, package_name").all(), before);
for (const policy of ['yeshiva_rung_3', 'yeshiva_rung_3_yt']) {
  assert.equal(DB._db.prepare("SELECT state FROM app_rules WHERE policy_id = ? AND package_name = 'com.nordvpn.android'").get(policy).state, 'allowed');
  assert.equal(DB._db.prepare("SELECT state FROM app_rules WHERE policy_id = ? AND package_name = 'net.openvpn.openvpn'").get(policy).state, 'allowed');
}
assert.equal(DB._db.prepare("SELECT state FROM app_rules WHERE policy_id = 'yeshiva_rung_3' AND package_name = 'org.torproject.torbrowser'").get().state, 'blocked');
assert.equal(DB._db.prepare("SELECT state FROM app_rules WHERE policy_id = 'yeshiva_rung_3' AND package_name = 'com.frostnerd.dnschanger'").get().state, 'blocked');

// A stored block on NFL must be overridden ONLY for Yeshiva rung 3.
for (const host of ['nfl.com', 'notnfl.com', 'nfl.com.example']) {
  await DB.prepare(`INSERT INTO url_verdicts (url_hash, url, scope, verdict, level, site_mode, source, decided_at)
    VALUES (?, ?, 'host', 'blocked', 6, 'blocked', 'operator', 0)`).bind(await sha256Hex(host), host).run();
}
await DB.prepare(`INSERT INTO devices (id, label, policy_id, timezone, level, tag, proxy_user, enrolled_at)
  VALUES ('test', 'test', 'yeshiva_rung_3', 'Asia/Jerusalem', 3, 'yeshiva', 'test', 0)`).run();
const env = { DB, PROXY_KEY: 'test' };
const check = async (host, now = '2026-09-11T13:00:00Z', extra = {}) => (await handleProxyCheck(new Request('https://worker/api/proxy/check', {
  method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'test', url: `https://${host}/`, ...extra }),
}), env, new Date(now))).json();
assert.equal((await check('nfl.com')).allow, true);
assert.equal((await check('www.nfl.com')).allow, true);
assert.equal((await check('notnfl.com')).allow, false);
assert.equal((await check('nfl.com.example')).allow, false);
assert.equal((await check('nfl.com', undefined, { dest: 'image' })).allow, false);
assert.equal((await check('nfl.com', '2026-09-06T13:00:00Z')).action, 'locked');
for (const [tag, level, policy] of [['yeshiva', 2, 'yeshiva_rung_2'], ['yeshiva', 4, 'yeshiva_rung_4'], ['standard', 3, 'apps_rung_3']]) {
  await DB.prepare('UPDATE devices SET tag = ?, level = ?, policy_id = ?').bind(tag, level, policy).run();
  assert.equal((await check('nfl.com')).allow, false, `${tag} ${level}`);
}
console.log('Rung 3 NFL scope, image/shiur rules, and VPN migration checks passed.');
