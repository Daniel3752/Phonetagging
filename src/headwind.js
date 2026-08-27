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

const ENDPOINTS = {
  login: '/rest/public/jwt/login',                    // POST {login,password} -> {id_token}
  deviceSearch: '/rest/private/devices/search',       // POST DeviceSearchRequest -> DeviceListView
  deviceUpdate: '/rest/private/devices',              // PUT Device -> Response
  configurationList: '/rest/private/configurations/list', // GET -> [LookupItem]
};

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
    body: JSON.stringify({ login: env.HEADWIND_USER, password: env.HEADWIND_PASSWORD }),
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

// Test hook — lets a test reset the module-level JWT cache between cases.
export function __resetAuthCache() {
  cachedToken = null;
  cachedTokenAt = 0;
}
