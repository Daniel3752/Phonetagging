// The APP half of the per-device override: the scheduler must actually put the overridden phone on
// the other policy's Headwind configuration, and leave every other phone on the same rung alone.
import { runScheduler } from '../src/scheduler.js';
import { makeDB } from './d1-shim.mjs';

let failures = 0;
const check = (n, c, x='') => { console.log((c?'  PASS  ':'  FAIL  ')+n+(c?'':'  '+x)); if(!c) failures++; };

const DB = makeDB('./schema.sql');
const pushed = [];
const env = { DB, HEADWIND_BASE_URL: 'https://mdm.test', HEADWIND_API_TOKEN: 't' };

// Stateful, so a device that was moved STAYS moved. Without that the scheduler correctly declines
// to push a phone back (Headwind already reports the target configuration) and the test misreads
// that as a missing push.
const hwConfig = { isaac: 5, other: 5 };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.endsWith('/rest/private/devices/search')) {
    return Response.json({ status:'OK', data:{ devices:{ items:[
      { id: 1, number: 'isaac',  configurationId: hwConfig.isaac, groups: [] },
      { id: 2, number: 'other',  configurationId: hwConfig.other, groups: [] },
    ], totalItemsCount: 2 } } });
  }
  if (u.endsWith('/rest/private/devices') && opts?.method === 'PUT') {
    const b = JSON.parse(opts.body);
    hwConfig[b.number] = b.configurationId;
    pushed.push({ number: b.number, configurationId: b.configurationId });
    return Response.json({ status: 'OK' });
  }
  return Response.json({ status: 'OK', data: {} });
};

await DB.prepare(`INSERT INTO policies (id,name,headwind_configuration_id,app_default,web_mode,created_at)
                  VALUES ('yeshiva_rung_3_test','Rung 3 TEST','99','allowed',NULL,0)`).run();
// The rung's own policy needs its real configuration mapped, as it is on the live panel.
await DB.prepare(`UPDATE policies SET headwind_configuration_id='5' WHERE id='yeshiva_rung_3'`).run();
for (const id of ['isaac','other']) {
  await DB.prepare(`INSERT INTO devices (id,headwind_device_id,label,policy_id,timezone,enrolled_at,level,tag,proxy_user,last_applied_policy_id)
                    VALUES (?,?,?,'yeshiva_rung_3','Asia/Jerusalem',0,3,'yeshiva',?, 'yeshiva_rung_3')`)
    .bind(id, id, id, '10.0.0.'+(id==='isaac'?3:5)).run();
}

// Friday 16:00 Israel: no shiur window.
const FRIDAY = new Date('2026-09-11T13:00:00Z');

console.log('\n1. no override: nobody moves');
let s = await runScheduler(env, FRIDAY);
check('no pushes', pushed.length === 0, JSON.stringify(pushed));

console.log('\n2. override one phone onto the test policy');
await DB.prepare(`INSERT INTO device_overrides (device_id, policy_id, note, set_at) VALUES ('isaac','yeshiva_rung_3_test','companion 0.1.2 test',0)`).run();
pushed.length = 0;
s = await runScheduler(env, FRIDAY);
check('exactly one phone was moved', pushed.length === 1, JSON.stringify(pushed));
check('and it was Isaac, onto configuration 99', pushed[0]?.number === 'isaac' && String(pushed[0]?.configurationId) === '99', JSON.stringify(pushed));
check('the other phone on the same rung never moved', !pushed.some(p => p.number === 'other'), JSON.stringify(pushed));
check('no failures', s.failed === 0, JSON.stringify(s.errors));

console.log('\n3. it is idempotent');
pushed.length = 0;
s = await runScheduler(env, FRIDAY);
check('a second run pushes nothing', pushed.length === 0 && s.unchanged === 2, JSON.stringify(s));

console.log('\n4. an override naming a policy that no longer exists is ignored, not fatal');
await DB.prepare(`UPDATE device_overrides SET policy_id='deleted_policy' WHERE device_id='isaac'`).run();
pushed.length = 0;
s = await runScheduler(env, FRIDAY);
check('the phone falls back to its rung rather than erroring', s.failed === 0, JSON.stringify(s.errors));
check('and is put back on its rung configuration', pushed.length === 1 && pushed[0].number === 'isaac' && String(pushed[0].configurationId) === '5', JSON.stringify(pushed));

console.log('\n5. clearing the override returns it to the rung');
await DB.prepare(`DELETE FROM device_overrides WHERE device_id='isaac'`).run();
pushed.length = 0;
s = await runScheduler(env, FRIDAY);
check('no further move needed (already back)', s.failed === 0, JSON.stringify(s.errors));

console.log(failures ? `\n${failures} FAILED` : '\nAll scheduler-override checks passed.');
process.exit(failures ? 1 : 0);
