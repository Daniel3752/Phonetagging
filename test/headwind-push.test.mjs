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

console.log('\n4. the login sends what the panel sends: uppercase MD5');
{
  const { headwindPasswordHash } = await import('../src/headwind.js');
  await check('a plain password is hashed the way the panel hashes it', async () => {
    assert.equal(headwindPasswordHash('abc'), '900150983CD24FB0D6963F7D28E17F72');
  });
  await check('a hash copied from the users table passes through, uppercased', async () => {
    assert.equal(headwindPasswordHash('900150983cd24fb0d6963f7d28e17f72'), '900150983CD24FB0D6963F7D28E17F72');
  });
  reset();
  let sent = null;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (new URL(url).pathname === '/rest/public/jwt/login') sent = JSON.parse(opts.body);
    return real(url, opts);
  };
  await pushPolicyApps({ ...env, HEADWIND_PASSWORD: 'abc' }, 4, [{ package_name: 'com.whatsapp', state: 'allowed' }]);
  await check('the login request carries the hash, never the password', async () => {
    assert.equal(sent.password, '900150983CD24FB0D6963F7D28E17F72');
    assert.equal(sent.login, 'u');
  });
  globalThis.fetch = real;
}

// Sections 3 and 4 left globalThis.fetch wrapped (create returns 400); restore a clean fake.
const baseFetch = async (url, opts = {}) => {
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
  if (path === '/rest/private/configurations' && method === 'PUT') { configuration = JSON.parse(opts.body); return ok(null); }
  return new Response('not found', { status: 404 });
};

console.log('\n5. a package new to the catalogue keeps its exact case (Android package names are case-sensitive)');
reset();
globalThis.fetch = baseFetch;
await pushPolicyApps(env, 4, [{ package_name: 'com.google.android.GoogleCamera', state: 'allowed' }]);
await check('the created entry is the original case, not lowercased', async () => {
  assert.ok(catalogue.some((a) => a.pkg === 'com.google.android.GoogleCamera'), 'catalogue keeps case');
  assert.ok(configuration.applications.some((a) => a.pkg === 'com.google.android.GoogleCamera'), 'config keeps case');
  assert.ok(!catalogue.some((a) => a.pkg === 'com.google.android.googlecamera'), 'no lowercased duplicate');
});

console.log('\n6. no catalogue Application is spread wholesale into the configuration (no nested configurations/passwords echoed back)');
reset();
globalThis.fetch = baseFetch;
// The catalogue entry for a blocked Play app carries a `configurations` array in the real server;
// the pushed configuration entry must not carry it back.
catalogue.push({ id: 21, pkg: 'com.sideload.thing', name: 'Thing', configurations: [{ id: 4, password: 'SECRETHASH' }] });
await pushPolicyApps(env, 4, [{ package_name: 'com.sideload.thing', state: 'blocked' }]);
await check('the linked entry has only link fields, no nested configurations', async () => {
  const e = configuration.applications.find((a) => a.pkg === 'com.sideload.thing');
  assert.equal(e.action, 2);
  assert.equal(e.remove, true);
  assert.equal(e.configurations, undefined, 'must not echo the catalogue app\'s configurations array');
  assert.ok(!JSON.stringify(configuration).includes('SECRETHASH'), 'no other config\'s password leaks into the PUT');
});

console.log('\n7. a create response with no id is recovered by searching the catalogue');
reset();
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const method = opts.method || 'GET';
    calls.push(`${method} ${path}`);
    if (path === '/rest/public/jwt/login') return Response.json({ status: 'OK', data: { id_token: 'jwt' } });
    if (path === '/rest/private/applications/search') return Response.json({ status: 'OK', data: catalogue });
    if (path === '/rest/private/applications/android' && method === 'PUT') {
      // The server accepted the create but returns an opaque envelope with no id (a real build does this).
      const body = JSON.parse(opts.body);
      catalogue.push({ id: 555, pkg: body.pkg, name: body.name });
      return Response.json({ status: 'OK', data: {} });
    }
    if (path.startsWith('/rest/private/applications/search/')) {
      const value = decodeURIComponent(path.split('/').pop());
      return Response.json({ status: 'OK', data: catalogue.filter((a) => a.pkg === value) });
    }
    if (path === '/rest/private/configurations/4' && method === 'GET') return Response.json({ status: 'OK', data: JSON.parse(JSON.stringify(configuration)) });
    if (path === '/rest/private/configurations' && method === 'PUT') { configuration = JSON.parse(opts.body); return Response.json({ status: 'OK', data: null }); }
    return new Response('not found', { status: 404 });
  };
  const r7 = await pushPolicyApps(env, 4, [{ package_name: 'com.brand.new', state: 'blocked' }]);
  await check('the app is linked with the id found by search, not dropped as an error', async () => {
    assert.deepEqual(r7.errors, []);
    const e = configuration.applications.find((a) => a.pkg === 'com.brand.new');
    assert.ok(e && e.id === 555, 'linked with the searched id');
    assert.equal(e.action, 2);
  });
  globalThis.fetch = real;
}

console.log('\n8. a 200 response carrying status ERROR is treated as a failure, not a success');
reset();
{
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    const method = opts.method || 'GET';
    if (path === '/rest/public/jwt/login') return Response.json({ status: 'OK', data: { id_token: 'jwt' } });
    if (path === '/rest/private/applications/search') return Response.json({ status: 'OK', data: catalogue });
    if (path === '/rest/private/configurations/4' && method === 'GET') return Response.json({ status: 'OK', data: JSON.parse(JSON.stringify(configuration)) });
    if (path === '/rest/private/configurations' && method === 'PUT') return Response.json({ status: 'ERROR', message: 'configuration is locked' });
    return new Response('not found', { status: 404 });
  };
  let threw = null;
  try { await pushPolicyApps(env, 4, [{ package_name: 'com.android.chrome', state: 'allowed' }]); }
  catch (e) { threw = e; }
  await check('the ERROR envelope surfaces as a thrown error', async () => {
    assert.ok(threw, 'must throw');
    assert.match(threw.message, /ERROR|locked/i);
  });
  globalThis.fetch = real;
}

console.log('\n9. findDevice matches by numeric id OR textual number');
reset();
{
  const { findDevice } = await import('../src/headwind.js');
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === '/rest/public/jwt/login') return Response.json({ status: 'OK', data: { id_token: 'jwt' } });
    return Response.json({ status: 'OK', data: { devices: { items: [
      { id: 7, number: '4908545443', configurationId: 4 },
      { id: 8, number: 'phone-b', configurationId: 4 },
    ], totalItemsCount: 2 } } });
  };
  await check('a device is found by its large textual number (not an int32 id)', async () => {
    const d = await findDevice(env, '4908545443');
    assert.ok(d && d.id === 7, 'matched by number');
  });
  await check('a device is still found by its numeric id', async () => {
    const d = await findDevice(env, '8');
    assert.ok(d && d.number === 'phone-b', 'matched by id');
  });
  await check('an unknown identifier returns null', async () => {
    assert.equal(await findDevice(env, 'nope'), null);
  });
  globalThis.fetch = real;
}

console.log('\nAll Headwind-push checks passed.\n');
