// Control-plane tests: the admin API and the scheduler, against a real SQLite database and a faked
// Headwind server. No network, no credentials, no wrangler.
//
// The scheduler assertions are the point of this file. A cron that fires every five minutes over
// every family's phone must be idempotent — a run with nothing to change must make zero Headwind
// calls — and must isolate failures, so one broken device cannot stop the fleet being updated.
import worker from '../src/index.js';
import { runScheduler } from '../src/scheduler.js';
import { makeDB } from './d1-shim.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

// --- fake Headwind -------------------------------------------------------------------------------
let hwDevices = [];
let hwCalls = [];
let hwFailOn = null;

const realFetch = globalThis.fetch;
// Response shapes mirror the live server's Swagger spec (GET /rest/swagger.json): device search
// returns a paginated DeviceListView, the configuration list returns bare LookupItems, and login
// returns id_token — not the shapes the client originally guessed at.
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('/rest/public/jwt/login')) {
    return Response.json({ id_token: 'fake-jwt' });
  }
  if (u.includes('/rest/private/configurations/list')) {
    hwCalls.push('configurations');
    return Response.json({ status: 'OK', data: [{ id: 10, name: 'day' }, { id: 20, name: 'evening' }] });
  }
  if (u.includes('/rest/private/devices/search')) {
    hwCalls.push('search');
    return Response.json({
      status: 'OK',
      data: { configurations: {}, devices: { items: hwDevices, totalItemsCount: hwDevices.length } },
    });
  }
  if (u.includes('/rest/private/devices')) {
    const body = JSON.parse(opts.body);
    hwCalls.push(`update:${body.id}->${body.configurationId}`);
    if (typeof body.configurationId !== 'number') {
      return new Response('configurationId must be an integer', { status: 400 });
    }
    if (hwFailOn === String(body.id)) return new Response('boom', { status: 400 });
    // The PUT must carry the writable Device fields, not a bare id/configurationId pair — a
    // partial object would wipe the operator's data in the real server.
    if (!('number' in body) || !('groups' in body)) {
      return new Response('incomplete Device object', { status: 400 });
    }
    hwDevices = hwDevices.map((d) => (String(d.id) === String(body.id) ? { ...d, configurationId: body.configurationId } : d));
    return Response.json({ status: 'OK' });
  }
  return new Response('{}');
};

const env = {
  DB: makeDB('schema.sql'),
  OPERATOR_KEY: 'opkey',
  HEADWIND_BASE_URL: 'https://mdm.test',
  HEADWIND_API_TOKEN: 'tok',
};

const admin = (path, body) => worker.fetch(new Request('https://w.dev' + path, {
  method: body ? 'POST' : 'GET',
  headers: { 'Authorization': 'Bearer opkey', 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
}), env);
const adminJson = async (p, b) => (await admin(p, b)).json();

// --- setup ---------------------------------------------------------------------------------------
console.log('\n1. admin API creates policies, apps, devices');
const day = await adminJson('/api/admin/policies', { name: 'day', headwind_configuration_id: '10' });
const night = await adminJson('/api/admin/policies', { name: 'night', headwind_configuration_id: '20' });
check('policies created', !!day.id && !!night.id, JSON.stringify({ day, night }));

let r = await admin('/api/admin/apps', { policy_id: night.id, package_name: 'com.instagram.android', state: 'blocked' });
check('valid app rule accepted', r.status === 200);
r = await admin('/api/admin/apps', { policy_id: night.id, package_name: 'not a package', state: 'blocked' });
check('invalid package name rejected', r.status === 400);
r = await admin('/api/admin/apps', { policy_id: night.id, package_name: 'com.foo.bar', state: 'nonsense' });
check('invalid state rejected', r.status === 400);

hwDevices = [
  { id: 7, number: 'phone-a', configurationId: '10', groups: [], mdmMode: true, serial: 'AAA111' },
  { id: 8, number: 'phone-b', configurationId: '10', groups: [], mdmMode: true, serial: 'BBB222' },
];
const devA = await adminJson('/api/admin/devices', { label: 'Phone A', headwind_device_id: '7', policy_id: day.id, timezone: 'UTC' });
const devB = await adminJson('/api/admin/devices', { label: 'Phone B', headwind_device_id: '8', policy_id: day.id, timezone: 'UTC' });
check('devices created', !!devA.id && !!devB.id);

console.log('\n2. schedule validation');
r = await admin('/api/admin/schedules', { base_policy_id: day.id, active_policy_id: night.id, day_mask: 127, start: '25:00', end: '06:00' });
check('bad time rejected', r.status === 400);
r = await admin('/api/admin/schedules', { base_policy_id: day.id, active_policy_id: night.id, day_mask: 0, start: '22:00', end: '06:00' });
check('empty day_mask rejected', r.status === 400);
r = await admin('/api/admin/schedules', { base_policy_id: day.id, active_policy_id: night.id, day_mask: 127, start: '22:00', end: '22:00' });
check('zero-length window rejected', r.status === 400);
const sch = await adminJson('/api/admin/schedules', { base_policy_id: day.id, active_policy_id: night.id, day_mask: 127, start: '22:00', end: '06:00' });
check('valid window accepted', !!sch.id, JSON.stringify(sch));

// --- scheduler ------------------------------------------------------------------------------------
console.log('\n3. scheduler applies the night policy inside the window');
hwCalls = [];
let s = await runScheduler(env, new Date('2026-08-24T23:00:00Z'));
check('both devices changed', s.changed === 2 && s.failed === 0, JSON.stringify(s));
check('headwind got both updates', hwCalls.filter((c) => c.startsWith('update:')).length === 2, hwCalls.join());
check('device 7 moved to config 20', Number(hwDevices.find((d) => d.id === 7).configurationId) === 20,
  String(hwDevices.find((d) => d.id === 7).configurationId));

console.log('\n4. IDEMPOTENCE: a second run in the same window changes nothing');
hwCalls = [];
s = await runScheduler(env, new Date('2026-08-24T23:30:00Z'));
check('nothing changed', s.changed === 0 && s.unchanged === 2, JSON.stringify(s));
check('zero Headwind calls made', hwCalls.length === 0, hwCalls.join());

console.log('\n5. leaving the window reverts to baseline');
s = await runScheduler(env, new Date('2026-08-25T12:00:00Z'));
check('both reverted', s.changed === 2, JSON.stringify(s));
check('device 7 back to config 10', Number(hwDevices.find((d) => d.id === 7).configurationId) === 10,
  String(hwDevices.find((d) => d.id === 7).configurationId));

console.log('\n6. FAILURE ISOLATION: one broken device must not stop the others');
hwFailOn = '7';
s = await runScheduler(env, new Date('2026-08-25T23:00:00Z'));
check('one failed, one succeeded', s.failed === 1 && s.changed === 1, JSON.stringify(s));
check('healthy device still updated', Number(hwDevices.find((d) => d.id === 8).configurationId) === 20,
  String(hwDevices.find((d) => d.id === 8).configurationId));
check('failed device NOT recorded as applied',
  env.DB._db.prepare('SELECT last_applied_policy_id FROM devices WHERE headwind_device_id = ?').get('7').last_applied_policy_id !== night.id);
hwFailOn = null;
s = await runScheduler(env, new Date('2026-08-25T23:05:00Z'));
check('retried and recovered on the next run', s.changed === 1 && s.failed === 0, JSON.stringify(s));

console.log('\n7. a device with no Headwind link fails cleanly');
await adminJson('/api/admin/devices', { label: 'Unlinked', policy_id: day.id, timezone: 'UTC' });
s = await runScheduler(env, new Date('2026-08-26T23:00:00Z'));
check('reported as failed, not thrown', s.failed === 1, JSON.stringify(s));
check('other devices unaffected', s.errors.length === 1 && /not linked/.test(s.errors[0]), JSON.stringify(s.errors));

console.log('\n8. audit log records both operator and scheduler actions');
const audit = await adminJson('/api/admin/audit');
check('operator actions logged', audit.entries.some((e) => e.actor === 'operator' && e.action === 'policy_saved'));
check('scheduler actions logged', audit.entries.some((e) => e.actor === 'scheduler' && e.action === 'policy_applied'));
check('failures logged', audit.entries.some((e) => e.action === 'policy_apply_failed'));

console.log('\n9. auth is enforced on every admin route');
for (const p of ['/api/admin/state', '/api/admin/audit', '/api/admin/verdicts']) {
  const res = await worker.fetch(new Request('https://w.dev' + p), env);
  check(`${p} requires the key`, res.status === 401, String(res.status));
}

console.log('\n10. Headwind client speaks the real API shapes');
const { listConfigurations, listDevices, __resetAuthCache } = await import('../src/headwind.js');
const cfgs = await listConfigurations(env);
check('configuration list unwrapped', cfgs.length === 2 && cfgs[0].name === 'day', JSON.stringify(cfgs));
const devs = await listDevices(env);
check('paginated device list unwrapped', devs.length === 2 && devs[0].number === 'phone-a', JSON.stringify(devs));
check('mdmMode is visible (Device Owner confirmation without adb)', devs[0].mdmMode === true);

__resetAuthCache();
const pwEnv = { ...env, HEADWIND_API_TOKEN: undefined, HEADWIND_USER: 'admin', HEADWIND_PASSWORD: 'pw' };
check('username/password login works and reads id_token', (await listConfigurations(pwEnv)).length === 2);

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
