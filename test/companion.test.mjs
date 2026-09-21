// The companion app's policy endpoint, offline: a real SQLite database through the D1 shim, the
// admin API to put phones on rungs, and the endpoint the phone reads. What is pinned: the answer
// follows the rung's whatsappUpdates flag on both ladders, an unknown phone is answered with the
// strictest policy, and the served rules carry a version the app can compare.
//
// Run with: node --experimental-sqlite test/companion.test.mjs (npm test does).
import worker from '../src/index.js';
import { COMPANION_RULES_VERSION } from '../src/companion-rules.js';
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
const policy = (user) => worker.fetch(new Request('https://w/api/companion/policy' + (user === undefined ? '' : `?user=${encodeURIComponent(user)}`)), env)
  .then((r) => r.json());

console.log('\n1. phones on the books');
await admin('/api/admin/devices', { id: 'isaac', label: 'Isaac', policy_id: 'yeshiva_rung_3', timezone: 'Asia/Jerusalem', tag: 'yeshiva', level: 3, proxy_user: '10.66.0.3' });
await admin('/api/admin/devices', { id: 'vortex', label: 'Vortex', policy_id: 'yeshiva_rung_2', timezone: 'Asia/Jerusalem', tag: 'yeshiva', level: 2, proxy_user: '10.66.0.4' });
await admin('/api/admin/devices', { id: 'open', label: 'Open', policy_id: 'apps_rung_5', timezone: 'Asia/Jerusalem', tag: 'standard', level: 5, proxy_user: '10.66.0.9' });

let p = await policy('10.66.0.3');
check('a yeshiva rung-3 phone blocks the Updates tab', p.known_device === true && p.whatsapp.block_updates === true && p.tag === 'yeshiva' && p.level === 3, JSON.stringify(p));
p = await policy('10.66.0.4');
check('a yeshiva rung-2 phone blocks it too', p.whatsapp.block_updates === true, JSON.stringify(p));
p = await policy('10.66.0.9');
check('a standard rung-5 phone does not', p.known_device === true && p.whatsapp.block_updates === false, JSON.stringify(p));

console.log('\n2. the rung decides, and a rung change is reflected at once');
await admin('/api/admin/devices/level', { id: 'isaac', tag: 'yeshiva', level: 4 });
p = await policy('10.66.0.3');
check('yeshiva rung 4 (social apps permitted) permits the feed', p.whatsapp.block_updates === false, JSON.stringify(p));
await admin('/api/admin/devices/level', { id: 'isaac', tag: 'standard', level: 4 });
p = await policy('10.66.0.3');
check('standard rung 4 blocks it (social is blocked there)', p.whatsapp.block_updates === true, JSON.stringify(p));
await admin('/api/admin/devices/level', { id: 'isaac', tag: 'yeshiva', level: 3 });

console.log('\n3. fails closed');
p = await policy('10.66.0.250');
check('an address nobody has blocks', p.known_device === false && p.whatsapp.block_updates === true, JSON.stringify(p));
p = await policy(undefined);
check('no address at all blocks', p.known_device === false && p.whatsapp.block_updates === true, JSON.stringify(p));
p = await policy("' OR 1=1 --");
check('junk blocks', p.known_device === false && p.whatsapp.block_updates === true, JSON.stringify(p));

console.log('\n4. the rules ride along');
p = await policy('10.66.0.3');
check('with a version the app can compare', p.rules_version === COMPANION_RULES_VERSION && Number.isInteger(p.rules_version));
check('and the WhatsApp packages', Array.isArray(p.rules.packages) && p.rules.packages.includes('com.whatsapp'));
check('every rule pattern compiles as a Java-compatible regex', (() => {
  for (const key of ['channel_activities', 'updates_view_ids', 'updates_texts', 'home_texts', 'conversation_texts']) {
    for (const r of p.rules[key]) {
      if (r.regex) new RegExp(r.regex, 'iu');
      if (!r.regex && !r.contains) throw new Error(`${key}: a rule with neither regex nor contains`);
    }
  }
  return true;
})());
const res = await worker.fetch(new Request('https://w/api/companion/policy?user=10.66.0.3'), env);
check('the answer is never cached', res.headers.get('Cache-Control') === 'no-store');

console.log('\n5. the APK carries the same rules');
{
  // scripts/build-companion-rules.mjs writes the built-in copy from the same constant; a stale
  // copy means a phone that never reached the Worker guards with old rules.
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(new URL('../companion/app/src/main/res/raw/guard_rules.json', import.meta.url), 'utf8'));
  check('res/raw/guard_rules.json matches src/companion-rules.js (run node scripts/build-companion-rules.mjs)',
    raw.rules_version === COMPANION_RULES_VERSION && JSON.stringify(raw.rules) === JSON.stringify(p.rules));
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll companion checks passed.\n');
process.exit(failures ? 1 : 0);
