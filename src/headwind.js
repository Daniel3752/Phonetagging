// Headwind MDM REST client — the enforcement layer.
//
// Division of labour: this worker decides WHICH policy a device should be running (src/policy.js,
// src/scheduler.js); Headwind is what applies it to the phone. A policy here maps onto a Headwind
// "configuration", which is the unit Headwind assigns to a device.
//
// Endpoints and payload shapes below are taken from a live server's Swagger spec
// (GET /rest/swagger.json on the Headwind host), not from documentation. If the server is upgraded,
// re-read that spec before assuming these still hold.
//
// Requires env.HEADWIND_BASE_URL (e.g. https://mdm.getshmira.com), plus either
// env.HEADWIND_API_TOKEN or the env.HEADWIND_USER / env.HEADWIND_PASSWORD pair.

import { md5Hex } from './md5.js';

// Headwind never sees a plain password. Its own login page sends md5(password).toUpperCase() and
// the JWT endpoint checks that against the hash it stores — a plain password is a 401 every time,
// which is what the first push produced. HEADWIND_PASSWORD may be given either way: the plain
// password (hashed here, the same way the page does it) or the 32-hex-digit hash copied straight
// out of Headwind's users table.
export function headwindPasswordHash(secret) {
  const s = String(secret || '').trim();
  if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toUpperCase();
  return md5Hex(s).toUpperCase();
}

const ENDPOINTS = {
  login: '/rest/public/jwt/login',                    // POST {login,password} -> {id_token}
  deviceSearch: '/rest/private/devices/search',       // POST DeviceSearchRequest -> DeviceListView
  deviceUpdate: '/rest/private/devices',              // PUT Device -> Response
  configurationList: '/rest/private/configurations/list', // GET -> [LookupItem]
  configurationGet: (id) => `/rest/private/configurations/${id}`, // GET -> Configuration (with applications)
  configurationUpdate: '/rest/private/configurations',    // PUT Configuration -> Response
  applicationSearch: '/rest/private/applications/search', // GET -> [Application] (the whole catalogue)
  applicationCreate: '/rest/private/applications/android', // PUT Application -> Response{data: Application}
};

// Headwind's per-configuration app action (Application.action / ApplicationConfigurationLink.action
// in the spec, enum [0,1,2]). 1 = Install is confirmed against the live database; 2 = Remove is
// what the panel's "Remove" writes; 0 = the app is linked to the configuration but neither
// installed nor removed ("Do not install"), which is how an allowlisted Play app is expressed —
// Headwind has no APK for it, so there is nothing to install, only an icon to show.
export const HW_ACTION = { NONE: 0, INSTALL: 1, REMOVE: 2 };

// Headwind paginates device search. One page this size covers any fleet this system is designed
// for; a larger deployment would need to walk pages, which is why totalItemsCount is checked.
const DEVICE_PAGE_SIZE = 1000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

function requireConfig(env) {
  if (!env.HEADWIND_BASE_URL) throw new Error('Headwind is not configured (HEADWIND_BASE_URL)');
  return env.HEADWIND_BASE_URL.replace(/\/+$/, '');
}

// A static API token is preferred; username/password login is the fallback, and the resulting JWT
// is cached per-isolate so a scheduler run over many devices doesn't re-authenticate each time.
let cachedToken = null;
let cachedTokenAt = 0;
const TOKEN_TTL_MS = 10 * 60 * 1000;

async function authHeader(env) {
  if (env.HEADWIND_API_TOKEN) return `Bearer ${env.HEADWIND_API_TOKEN}`;
  if (!env.HEADWIND_USER || !env.HEADWIND_PASSWORD) {
    throw new Error('Headwind credentials missing (HEADWIND_API_TOKEN, or HEADWIND_USER + HEADWIND_PASSWORD)');
  }

  if (cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return `Bearer ${cachedToken}`;

  const res = await fetch(requireConfig(env) + ENDPOINTS.login, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: env.HEADWIND_USER, password: headwindPasswordHash(env.HEADWIND_PASSWORD) }),
  });
  if (!res.ok) throw new Error(`Headwind login failed: ${res.status}`);

  // The spec calls the field id_token. Some builds wrap responses in {status, data}, so check both.
  const body = await res.json();
  const token = body?.id_token || body?.data?.id_token;
  if (!token) throw new Error('Headwind login returned no id_token');

  cachedToken = token;
  cachedTokenAt = Date.now();
  return `Bearer ${token}`;
}

async function call(env, path, options = {}) {
  const base = requireConfig(env);
  const auth = await authHeader(env);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(base + path, {
      ...options,
      headers: { 'Authorization': auth, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });

    if (res.ok) return res.json();

    // A stale cached JWT looks like a 401; drop it so the next attempt re-authenticates.
    if (res.status === 401) cachedToken = null;

    const canRetry = RETRYABLE_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length;
    if (!canRetry) {
      const body = await res.text().catch(() => '');
      throw new Error(`Headwind API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

// Successful responses may arrive bare or wrapped as {status:'OK', data:…}. Unwrap either.
function payload(body) {
  if (body && typeof body === 'object' && 'data' in body && 'status' in body) return body.data;
  return body;
}

// Configuration names and ids — used to map a policy's headwind_configuration_id onto something
// real, and to populate the operator UI.
export async function listConfigurations(env) {
  const data = payload(await call(env, ENDPOINTS.configurationList, { method: 'GET' }));
  return Array.isArray(data) ? data : [];
}

// One page of devices. DeviceView carries mdmMode/kioskMode, which is how we can confirm the agent
// actually holds Device Owner without plugging the phone into a computer.
export async function listDevices(env) {
  const data = payload(await call(env, ENDPOINTS.deviceSearch, {
    method: 'POST',
    body: JSON.stringify({ pageNum: 1, pageSize: DEVICE_PAGE_SIZE }),
  }));

  const page = data?.devices || {};
  const items = Array.isArray(page.items) ? page.items : [];

  if (typeof page.totalItemsCount === 'number' && page.totalItemsCount > items.length) {
    console.warn(`Headwind reports ${page.totalItemsCount} devices but one page returned ${items.length}; pagination needed.`);
  }
  return items;
}

export async function findDevice(env, headwindDeviceId) {
  const devices = await listDevices(env);
  return devices.find((d) => String(d.id) === String(headwindDeviceId)) || null;
}

// The single write the scheduler performs: point one device at a different configuration.
//
// PUT /private/devices takes a whole Device object, not a patch, so the current record is read
// first and only configurationId changed. Blind-writing a partial object would silently clear
// fields the operator set in the Headwind UI.
//
// DeviceView (what search returns) is a superset of Device (what the PUT accepts), so the writable
// fields are copied across explicitly rather than passing the read object straight back — sending
// read-only fields like statusCode or serial risks the server rejecting or misinterpreting them.
export async function setDeviceConfiguration(env, headwindDeviceId, configurationId) {
  const current = await findDevice(env, headwindDeviceId);
  if (!current) throw new Error(`Headwind device ${headwindDeviceId} not found`);

  if (String(current.configurationId) === String(configurationId)) {
    return { changed: false };
  }

  await call(env, ENDPOINTS.deviceUpdate, {
    method: 'PUT',
    body: JSON.stringify({
      id: current.id,
      number: current.number,
      description: current.description ?? null,
      configurationId: Number(configurationId),
      imei: current.imei ?? null,
      phone: current.phone ?? null,
      custom1: current.custom1 ?? null,
      custom2: current.custom2 ?? null,
      custom3: current.custom3 ?? null,
      groups: current.groups || [],
    }),
  });

  return { changed: true, from: current.configurationId, to: configurationId };
}

// The whole application catalogue, keyed by package name. Headwind only acts on apps it knows,
// so a rule for a package the catalogue lacks needs an entry created first (below).
export async function listApplications(env) {
  const data = payload(await call(env, ENDPOINTS.applicationSearch, { method: 'GET' }));
  return Array.isArray(data) ? data : [];
}

// Creates a catalogue entry for a package Headwind has no APK for (a Play app). Enough for the
// agent to remove it by package name, or to show its icon; nothing to install.
export async function createApplication(env, { pkg, name }) {
  const data = payload(await call(env, ENDPOINTS.applicationCreate, {
    method: 'PUT',
    body: JSON.stringify({
      name: name || pkg, pkg, version: '0', type: 'app',
      showIcon: true, useKiosk: false, system: false, split: false,
      runAfterInstall: false, runAtBoot: false, skipVersion: false,
    }),
  }));
  return data && typeof data === 'object' ? data : { pkg, name: name || pkg };
}

export async function getConfiguration(env, configurationId) {
  return payload(await call(env, ENDPOINTS.configurationGet(configurationId), { method: 'GET' }));
}

// Writes a policy's app rules into a Headwind configuration.
//
// rules: [{ package_name, state }] with state 'allowed' | 'blocked' | 'hidden'. Every rule becomes
// an entry in the configuration's application list:
//   blocked / hidden -> action REMOVE (the agent uninstalls a user app; a system app is hidden)
//   allowed          -> action INSTALL when Headwind holds an APK for it, else NONE, icon shown
// Entries already in the configuration for other packages are left exactly as they are, so the
// operator's hand-made list survives a push. Packages missing from the catalogue are created.
//
// PUT /private/configurations takes the WHOLE configuration, so the current record is read first
// and only `applications` is changed — a partial write would blank every other setting.
export async function pushPolicyApps(env, configurationId, rules) {
  const config = await getConfiguration(env, configurationId);
  if (!config || typeof config !== 'object') throw new Error(`Headwind configuration ${configurationId} not found`);

  const catalogue = new Map((await listApplications(env)).map((a) => [String(a.pkg || '').toLowerCase(), a]));
  const created = [];
  const errors = [];

  const byId = new Map((Array.isArray(config.applications) ? config.applications : []).map((a) => [a.id, a]));
  const summary = { remove: 0, install: 0, icon: 0 };

  for (const rule of rules) {
    const pkg = String(rule.package_name || '').trim().toLowerCase();
    if (!pkg) continue;
    let app = catalogue.get(pkg);
    if (!app) {
      try {
        app = await createApplication(env, { pkg, name: rule.label || pkg });
        if (!app.id) throw new Error('create returned no id');
        catalogue.set(pkg, app);
        created.push(pkg);
      } catch (err) {
        errors.push(`${pkg}: ${err.message}`);
        continue;
      }
    }
    const remove = rule.state === 'blocked' || rule.state === 'hidden';
    const hasApk = Boolean(app.url || app.urlArm64 || app.urlArmeabi);
    const action = remove ? HW_ACTION.REMOVE : (hasApk ? HW_ACTION.INSTALL : HW_ACTION.NONE);
    if (remove) summary.remove++; else if (action === HW_ACTION.INSTALL) summary.install++; else summary.icon++;
    byId.set(app.id, { ...(byId.get(app.id) || {}), ...app, action, showIcon: !remove, remove });
  }

  config.applications = [...byId.values()];
  await call(env, ENDPOINTS.configurationUpdate, { method: 'PUT', body: JSON.stringify(config) });

  return { configurationId, entries: config.applications.length, created, errors, ...summary };
}

// Test hook — lets a test reset the module-level JWT cache between cases.
export function __resetAuthCache() {
  cachedToken = null;
  cachedTokenAt = 0;
}
