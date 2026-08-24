// Headwind MDM REST client — the enforcement layer.
//
// Division of labour: this worker decides WHICH policy a device should be running (src/policy.js,
// src/scheduler.js); Headwind is what actually applies it to the phone. A policy here maps onto a
// Headwind "configuration", which is the unit Headwind assigns to a device.
//
// ⚠ ENDPOINT SHAPES ARE UNVERIFIED. Every path and payload assumption lives in ENDPOINTS below,
// deliberately in one block, because they were written from documentation rather than against a
// running server. Task 2.1 of the plan is to stand up Headwind and correct these against the real
// API before any phone depends on them. Nothing else in the codebase encodes Headwind's wire
// format, so fixing them is a single-file change.
//
// Requires env.HEADWIND_BASE_URL (e.g. https://mdm.example.com), plus either
// env.HEADWIND_API_TOKEN or the env.HEADWIND_USER / env.HEADWIND_PASSWORD pair.

const ENDPOINTS = {
  login: '/rest/public/jwt/login',                                  // POST {login, password} -> {token}
  devices: '/rest/private/devices/search',                          // POST search -> device list
  updateDevice: '/rest/private/devices',                            // PUT a device object
  configurations: '/rest/private/configurations/search',            // POST search -> configuration list
};

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

function requireConfig(env) {
  if (!env.HEADWIND_BASE_URL) throw new Error('Headwind is not configured (HEADWIND_BASE_URL)');
  return env.HEADWIND_BASE_URL.replace(/\/+$/, '');
}

// A static API token is preferred; username/password login is the fallback, and the resulting JWT
// is cached per-isolate so a scheduler run over many devices does not re-authenticate each time.
let cachedToken = null;
let cachedTokenAt = 0;
const TOKEN_TTL_MS = 10 * 60 * 1000;

async function authHeader(env) {
  if (env.HEADWIND_API_TOKEN) return `Bearer ${env.HEADWIND_API_TOKEN}`;
  if (!env.HEADWIND_USER || !env.HEADWIND_PASSWORD) {
    throw new Error('Headwind credentials missing (HEADWIND_API_TOKEN, or HEADWIND_USER + HEADWIND_PASSWORD)');
  }

  if (cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return `Bearer ${cachedToken}`;

  const base = requireConfig(env);
  const res = await fetch(base + ENDPOINTS.login, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: env.HEADWIND_USER, password: env.HEADWIND_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Headwind login failed: ${res.status}`);

  const data = await res.json();
  const token = data?.data?.token || data?.token;
  if (!token) throw new Error('Headwind login returned no token');

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

function unwrap(payload) {
  // Headwind wraps successful responses as {status:'OK', data:[...]}; tolerate a bare array too.
  if (Array.isArray(payload)) return payload;
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

export async function listConfigurations(env) {
  return unwrap(await call(env, ENDPOINTS.configurations, { method: 'POST', body: JSON.stringify({}) }));
}

export async function listDevices(env) {
  return unwrap(await call(env, ENDPOINTS.devices, { method: 'POST', body: JSON.stringify({}) }));
}

// Assigns a configuration to one device — the single write the scheduler performs.
//
// Headwind's device update is a whole-object PUT rather than a patch, so the current object is
// read first and only configurationId changed. Blind-writing a partial object here would silently
// clear fields the operator set in the Headwind UI.
export async function setDeviceConfiguration(env, headwindDeviceId, configurationId) {
  const devices = await listDevices(env);
  const current = devices.find((d) => String(d.id) === String(headwindDeviceId));
  if (!current) throw new Error(`Headwind device ${headwindDeviceId} not found`);

  if (String(current.configurationId) === String(configurationId)) {
    return { changed: false };
  }

  await call(env, ENDPOINTS.updateDevice, {
    method: 'PUT',
    body: JSON.stringify({ ...current, configurationId }),
  });
  return { changed: true, from: current.configurationId, to: configurationId };
}

// Test hook — lets a test reset the module-level JWT cache between cases.
export function __resetAuthCache() {
  cachedToken = null;
  cachedTokenAt = 0;
}
