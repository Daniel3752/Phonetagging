// Pushing a policy's app rules into a Headwind configuration, against a fake Headwind that speaks
// the shapes in the live server's Swagger spec. What is pinned: the whole configuration is read and
// written back with only `applications` changed; blocked rules become Remove; allowed Play apps
// (no APK) become icon-only, not Install; packages missing from the catalogue are created; entries
// already in the configuration for other apps survive untouched.

import assert from 'node:assert/strict';
import { pushPolicyApps, __resetAuthCache } from '../src/headwind.js';

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
}

// --- a fake Headwind -----------------------------------------------------------------------------
let catalogue, configuration, calls;
function reset() {
  catalogue = [
    { id: 11, pkg: 'com.android.chrome', name: 'Chrome', url: 'https://mdm/chrome.apk' },
    { id: 12, pkg: 'com.zhiliaoapp.musically', name: 'TikTok' },          // Play app, no APK
    { id: 13, pkg: 'com.whatsapp', name: 'WhatsApp' },                    // Play app, no APK
  ];
  configuration = {
    id: 4, name: 'Background agent Yeshiva Temp', kioskMode: false, restrictions: 'no_safe_boot',
    applications: [
      { id: 11, pkg: 'com.android.chrome', name: 'Chrome', action: 1, showIcon: true },
      { id: 99, pkg: 'com.hmdm.launcher', name: 'Headwind agent', action: 1, showIcon: false }, // untouched
    ],
    applicationSettings: [{ id: 1, applicationId: 11, name: 'ProxyMode', value: 'fixed_servers' }],
  };
  calls = [];
  __resetAuthCache();
}
let nextId = 100;
globalThis.fetch = async (url, opts = {}) => {
  const path = new URL(url).pathname;
  const method = opts.method || 'GET';
  calls.push(`${method} ${path}`);
  const ok = (data) => Response.json({ status: 'OK', data });
  if (path === '/rest/public/jwt/login') return ok({ id_token: 'jwt' });
  if (path === '/rest/private/applications/search') return ok(catalogue);
  if (path === '/rest/private/applications/android' && method === 'PUT') {
    const body = JSON.parse(opts.body);
    const app = { id: nextId++, pkg: body.pkg, name: body.name };
    catalogue.push(app);
    return ok(app);
  }
  if (path === '/rest/private/configurations/4' && method === 'GET') return ok(JSON.parse(JSON.stringify(configuration)));
  if (path === '/rest/private/configurations' && method === 'PUT') {
    configuration = JSON.parse(opts.body);
    return ok(null);
  }
  return new Response('not found', { status: 404 });
};
const env = { HEADWIND_BASE_URL: 'https://mdm.test', HEADWIND_USER: 'u', HEADWIND_PASSWORD: 'p' };

console.log('\n1. a rung-2 style push: allowlist apps shown, social removed, the rest of the configuration kept');
reset();
const result = await pushPolicyApps(env, 4, [
  { package_name: 'com.whatsapp', state: 'allowed' },
  { package_name: 'com.android.chrome', state: 'allowed' },
  { package_name: 'com.zhiliaoapp.musically', state: 'blocked' },
  { package_name: 'com.instagram.android', state: 'blocked' },   // not in the catalogue yet
]);
const byPkg = Object.fromEntries(configuration.applications.map((a) => [a.pkg, a]));
await check('TikTok is set to Remove', async () => { assert.equal(byPkg['com.zhiliaoapp.musically'].action, 2); assert.equal(byPkg['com.zhiliaoapp.musically'].remove, true); });
await check('Instagram was created in the catalogue, then set to Remove', async () => {
  assert.ok(result.created.includes('com.instagram.android'));
  assert.equal(byPkg['com.instagram.android'].action, 2);
});
await check('WhatsApp (Play app, no APK) is icon-only, not Install', async () => {
  assert.equal(byPkg['com.whatsapp'].action, 0); assert.equal(byPkg['com.whatsapp'].showIcon, true);
});
await check('Chrome (has an APK) is Install with its icon', async () => {
  assert.equal(byPkg['com.android.chrome'].action, 1); assert.equal(byPkg['com.android.chrome'].showIcon, true);
});
await check('the agent entry the operator had is untouched', async () => {
  assert.deepEqual(byPkg['com.hmdm.launcher'], { id: 99, pkg: 'com.hmdm.launcher', name: 'Headwind agent', action: 1, showIcon: false });
});
await check('every other configuration field survived the round trip', async () => {
  assert.equal(configuration.kioskMode, false);
  assert.equal(configuration.restrictions, 'no_safe_boot');
  assert.equal(configuration.applicationSettings[0].value, 'fixed_servers');
});
await check('the summary counts what happened', async () => {
  assert.equal(result.remove, 2); assert.equal(result.install, 1); assert.equal(result.icon, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries, 5);
});
await check('the configuration was read before it was written', async () => {
  assert.ok(calls.indexOf('GET /rest/private/configurations/4') < calls.indexOf('PUT /rest/private/configurations'));
});

console.log('\n2. a second push is idempotent');
const before = JSON.stringify(configuration.applications);
await pushPolicyApps(env, 4, [
  { package_name: 'com.whatsapp', state: 'allowed' }, { package_name: 'com.android.chrome', state: 'allowed' },
  { package_name: 'com.zhiliaoapp.musically', state: 'blocked' }, { package_name: 'com.instagram.android', state: 'blocked' },
]);
await check('same list, nothing created twice', async () => {
  assert.equal(JSON.stringify(configuration.applications), before);
  assert.equal(catalogue.filter((a) => a.pkg === 'com.instagram.android').length, 1);
});

console.log('\n3. failure isolation');
reset();
globalThis.fetch = ((real) => async (url, opts) => {
  if (new URL(url).pathname === '/rest/private/applications/android') return new Response('validation failed', { status: 400 });
  return real(url, opts);
})(globalThis.fetch);
const r3 = await pushPolicyApps(env, 4, [
  { package_name: 'com.zhiliaoapp.musically', state: 'blocked' },
  { package_name: 'com.unknown.app', state: 'blocked' },
]);
await check('a package the catalogue refuses is reported, the rest still pushed', async () => {
  assert.equal(r3.errors.length, 1); assert.match(r3.errors[0], /com.unknown.app/);
  assert.equal(r3.remove, 1);
  assert.equal(configuration.applications.find((a) => a.pkg === 'com.zhiliaoapp.musically').action, 2);
});

console.log(`\nAll ${passed} Headwind-push checks passed.\n`);
