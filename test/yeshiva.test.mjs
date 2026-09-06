// The yeshiva temp tag, end to end and offline: a real SQLite database through the D1 shim (so the
// seeded shiur windows and policies are the real ones), the admin API, the proxy check, and the
// block page. No network, no model — a blocklist rung must never call the model, and that is one of
// the things pinned here.
//
// The shiur windows are the part worth being careful about: they are written in phone-local time
// (Asia/Jerusalem), so the instants below are chosen in UTC and converted by hand in the comments.

import worker from '../src/index.js';
import { handleProxyCheck } from '../src/proxy-api.js';
import { makeDB } from './d1-shim.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

const DB = makeDB('./schema.sql');
const env = { DB, OPERATOR_KEY: 'op-key', PROXY_KEY: 'proxy-key', GEMINI_API_KEY: 'x' };

// Any model call is a failure of the blocklist rung's promise; count them.
let modelCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).includes('generativelanguage')) {
    modelCalls++;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ level: 2, reason: 'x' }) }] } }] });
  }
  return new Response('<title>x</title>');
};

const admin = (path, body, method = 'POST', headers = {}) => worker.fetch(new Request(`https://w${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer op-key', ...headers },
  ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
}), env);

const proxyCheck = (user, url, extra = {}, now = new Date('2026-09-06T12:00:00Z')) =>
  handleProxyCheck(new Request('https://w/api/proxy/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proxy-key' },
    body: JSON.stringify({ user, url, ...extra }),
  }), env, now);

const sha = async (s) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// Sunday 2026-09-06, 15:00 Israel time (UTC+3 in September) = 12:00Z: the lunch break.
const LUNCH = new Date('2026-09-06T12:00:00Z');
// Sunday 16:00 Israel = 13:00Z: second seder.
const SEDER = new Date('2026-09-06T13:00:00Z');
// Sunday 21:00 Israel = 18:00Z: night seder.
const NIGHT = new Date('2026-09-06T18:00:00Z');
// Friday 2026-09-11 16:00 Israel = 13:00Z: no shiur.
const FRIDAY = new Date('2026-09-11T13:00:00Z');

console.log('\n1. the seed: policies and shiur windows come with the schema');
const state = await (await admin('/api/admin/state', null, 'GET')).json();
check('the tags are served with their ladders', Array.isArray(state.tags) && state.tags.some((t) => t.id === 'yeshiva' && t.levels.length === 4), JSON.stringify(state.tags?.map((t) => t.id)));
check('the shiur policy locks the web', state.policies.some((p) => p.id === 'yeshiva_shiur' && p.web_mode === 'none' && p.app_default === 'blocked'));
check('the rung policies carry their app model', state.policies.find((p) => p.id === 'yeshiva_rung_1')?.app_default === 'blocked' && state.policies.find((p) => p.id === 'yeshiva_rung_3')?.app_default === 'allowed');
check('four tag-wide shiur windows', state.schedules.filter((s) => s.base_policy_id === 'tag:yeshiva' && s.active_policy_id === 'yeshiva_shiur').length === 4);

console.log('\n2. putting a phone on the tag');
let res = await admin('/api/admin/devices', {
  id: 'vortex', label: 'Vortex', policy_id: 'yeshiva_rung_2', timezone: 'Asia/Jerusalem',
  tag: 'yeshiva', level: 2, proxy_user: '10.66.0.4',
});
let body = await res.json();
check('saved with the tag and rung', body.ok === true && body.tag === 'yeshiva' && body.level === 2, JSON.stringify(body));
res = await admin('/api/admin/devices', { id: 'bad', label: 'Bad', policy_id: 'yeshiva_rung_2', tag: 'yeshiva', level: 5 });
check('rung 5 does not exist on the yeshiva ladder and is refused', res.status === 400);
res = await admin('/api/admin/devices', { id: 'bad', label: 'Bad', policy_id: 'yeshiva_rung_2', tag: 'kollel', level: 2 });
check('an unknown tag is refused, not defaulted', res.status === 400);
await admin('/api/admin/devices', {
  id: 'isaac', label: 'Isaac', policy_id: 'apps_rung_4', timezone: 'Asia/Jerusalem', level: 4, proxy_user: '10.66.0.3',
});

console.log('\n3. the yeshiva browser: blocklists only, no model, images blanked');
modelCalls = 0;
let out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/page', {}, LUNCH)).json();
check('an unknown site is allowed without asking the model', out.allow === true && modelCalls === 0, JSON.stringify(out));
check('the answer tells the helper to block social and not to force a bump (the browser port does that)', out.decrypt === false && out.block_social === true && out.tag === 'yeshiva', JSON.stringify(out));
check('without the helper feature the answer is per URL', out.cache_scope === 'url');
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/page', { features: ['strip_images'] }, LUNCH)).json();
check('with the helper feature it is per host and flags strip_images', out.cache_scope === 'host' && out.strip_images === true, JSON.stringify(out));
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/pic.jpg', {}, LUNCH)).json();
check('an image by extension is blocked', out.allow === false && out.action === 'image_blocked', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.4', 'https://cdn.example/abc123', { dest: 'image' }, LUNCH)).json();
check('an image by Sec-Fetch-Dest is blocked', out.allow === false && out.action === 'image_blocked', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.4', 'https://cdn.example/abc123', { dest: 'document' }, LUNCH)).json();
check('the same URL as a document is allowed', out.allow === true);

await admin('/api/admin/sites/level', { hostname: 'bad-site.example', level: 6, reason: 'Explicit.' });
out = await (await proxyCheck('10.66.0.4', 'https://www.bad-site.example/', {}, LUNCH)).json();
check('a site on file as NEVER is blocked', out.allow === false && out.action === 'blocked', JSON.stringify(out));
await DB.prepare(`INSERT INTO url_verdicts (url_hash, url, hostname, scope, verdict, source, decided_at, level, site_mode)
  VALUES (?, 'https://shut.example/', 'shut.example', 'host', 'blocked', 'operator', 0, 3, 'blocked')`).bind(await sha('shut.example')).run();
out = await (await proxyCheck('10.66.0.4', 'https://shut.example/', {}, LUNCH)).json();
check('an operator-blocked site is blocked whatever its rating', out.allow === false);
await admin('/api/admin/sites/level', { hostname: 'shtus.example', level: 5, reason: 'Fashion.' });
out = await (await proxyCheck('10.66.0.4', 'https://shtus.example/', {}, LUNCH)).json();
check('a rated-5 site is allowed — there is no rating gate on this tag', out.allow === true, JSON.stringify(out));
check('still no model call', modelCalls === 0, String(modelCalls));

console.log('\n4. the yeshiva search: keyword list and what is on file, no model');
await DB.prepare(`INSERT INTO keyword_rules (scope, lang, pattern, rating, note) VALUES ('search', 'en', 'porn', 6, 'explicit')`).run();
out = await (await proxyCheck('10.66.0.4', 'https://www.google.com/search?q=free+porn', {}, LUNCH)).json();
check('an explicit keyword refuses the search', out.allow === false && out.action === 'search', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.4', 'https://www.google.com/search?q=volcano+facts', {}, LUNCH)).json();
check('an ordinary search is allowed with images off', out.allow === true && out.images_off === true && out.action === 'allow_text_only', JSON.stringify(out));
check('no model call for the search', modelCalls === 0, String(modelCalls));
await admin('/api/admin/searches/level', { query: 'something awful', level: 6 });
out = await (await proxyCheck('10.66.0.4', 'https://www.google.com/search?q=awful+something', {}, LUNCH)).json();
check('a search on file as NEVER is refused', out.allow === false);
out = await (await proxyCheck('10.66.0.4', 'https://www.google.com/search?q=cats&udm=2', {}, LUNCH)).json();
check('image search is off', out.allow === false && out.action === 'image_search');
out = await (await proxyCheck('10.66.0.4', 'https://www.google.com/', {}, LUNCH)).json();
check('the search box itself loads', out.allow === true);

console.log('\n5. the shiur lock');
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, SEDER)).json();
check('locked during second seder (Sunday 16:00 Israel)', out.allow === false && out.action === 'locked', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, NIGHT)).json();
check('locked during night seder', out.allow === false && out.action === 'locked');
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, LUNCH)).json();
check('open in the lunch break', out.allow === true);
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, FRIDAY)).json();
check('open on Friday', out.allow === true);
out = await (await proxyCheck('10.66.0.3', 'https://en.wikipedia.org/', {}, SEDER)).json();
check('a standard-ladder phone is not locked by the yeshiva windows', out.action !== 'locked', JSON.stringify(out));

// A boy in the amud class: second seder starts at 16:15 for him. A window of his own, higher
// priority, back to his rung's policy, and he is open at 16:00 while everyone else is locked.
await admin('/api/admin/schedules', {
  id: 'amud_vortex', device_id: 'vortex', base_policy_id: 'tag:yeshiva', active_policy_id: 'yeshiva_rung_2',
  day_mask: 31, start: '15:35', end: '16:15', priority: 200,
});
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, SEDER)).json();
check('a per-phone exemption window wins', out.allow === true, JSON.stringify(out));
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, new Date('2026-09-06T13:20:00Z'))).json();
check('and the lock resumes when his window ends (16:20 Israel)', out.action === 'locked');
await admin('/api/admin/schedules/delete', { id: 'amud_vortex' });

res = await admin('/api/admin/schedules', { base_policy_id: 'tag:kollel', active_policy_id: 'yeshiva_shiur', day_mask: 31, start: '10:00', end: '11:00' });
check('a window on an unknown tag is refused', res.status === 400);

console.log('\n5b. the shiur toggle');
check('the toggle is served with the state, defaulting to the timetable', (await (await admin('/api/admin/state', null, 'GET')).json()).settings?.shiur_lock_mode === 'schedule');
res = await admin('/api/admin/settings', { key: 'shiur_lock_mode', value: 'on' });
check('switched on', res.status === 200);
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, LUNCH)).json();
check('"locked now" locks a yeshiva phone in the lunch break', out.action === 'locked', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.3', 'https://en.wikipedia.org/', {}, LUNCH)).json();
check('but not a standard-ladder phone', out.action !== 'locked', JSON.stringify(out));
await admin('/api/admin/settings', { key: 'shiur_lock_mode', value: 'off' });
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, SEDER)).json();
check('"off" opens a yeshiva phone during seder', out.allow === true, JSON.stringify(out));
res = await admin('/api/admin/settings', { key: 'shiur_lock_mode', value: 'maybe' });
check('a nonsense value is refused', res.status === 400);
res = await admin('/api/admin/settings', { key: 'anything_else', value: 'on' });
check('an unknown setting is refused', res.status === 400);
await admin('/api/admin/settings', { key: 'shiur_lock_mode', value: 'schedule' });
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, SEDER)).json();
check('back on the timetable, seder locks again', out.action === 'locked');

console.log('\n5c. the per-phone switch');
check('a phone starts with the lock on', Number((await DB.prepare('SELECT shiur_lock FROM devices WHERE id = ?').bind('vortex').first()).shiur_lock) === 1);
res = await admin('/api/admin/devices/shiur', { id: 'vortex', on: false });
check('switched off for one phone', res.status === 200);
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, SEDER)).json();
check('exempt: open during seder', out.allow === true, JSON.stringify(out));
await admin('/api/admin/settings', { key: 'shiur_lock_mode', value: 'on' });
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, LUNCH)).json();
check('exempt: "Locked now" skips it too', out.allow === true, JSON.stringify(out));
await admin('/api/admin/settings', { key: 'shiur_lock_mode', value: 'schedule' });
// Re-saving the phone from the form without the field keeps the switch as it was.
await admin('/api/admin/devices', { id: 'vortex', label: 'Vortex', policy_id: 'yeshiva_rung_2', timezone: 'Asia/Jerusalem', tag: 'yeshiva', level: 2, proxy_user: '10.66.0.4' });
check('a re-save without the field keeps it off', Number((await DB.prepare('SELECT shiur_lock FROM devices WHERE id = ?').bind('vortex').first()).shiur_lock) === 0);
res = await admin('/api/admin/devices/shiur', { id: 'nope', on: true });
check('an unknown phone is a 404', res.status === 404);
await admin('/api/admin/devices/shiur', { id: 'vortex', on: true });
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, SEDER)).json();
check('switched back on, seder locks', out.action === 'locked');

console.log('\n6. rung 1 has no browser; the block page knows a locked phone and a stripped image');
await admin('/api/admin/devices/level', { id: 'vortex', level: 1 });
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, LUNCH)).json();
check('rung 1: no web', out.allow === false && out.action === 'no_web');

let page = await worker.fetch(new Request('https://w/blocked?url=https%3A%2F%2Fx.example%2F&why=locked%3A%20This%20phone%20is%20locked'), env);
let html = await page.text();
check('the block page says the phone is locked', /locked right now/i.test(html) && !/This site is blocked/.test(html));
page = await worker.fetch(new Request('https://w/blocked?url=https%3A%2F%2Fx.example%2Fabc', { headers: { 'Sec-Fetch-Dest': 'image' } }), env);
check('an image fetch gets a placeholder image', page.headers.get('Content-Type').startsWith('image/svg+xml') && /<svg/.test(await page.text()));
page = await worker.fetch(new Request('https://w/blocked?url=https%3A%2F%2Fx.example%2Fphoto.png'), env);
check('an image URL with no fetch metadata gets one too', page.headers.get('Content-Type').startsWith('image/svg+xml'));
page = await worker.fetch(new Request('https://w/blocked?url=https%3A%2F%2Fx.example%2F'), env);
check('an ordinary denial is still the block page', (await page.text()).includes('This site is blocked'));

console.log('\n7. migrating off the tag');
res = await admin('/api/admin/devices/level', { id: 'vortex', tag: 'standard', level: 4 });
body = await res.json();
const row = await DB.prepare('SELECT tag, level FROM devices WHERE id = ?').bind('vortex').first();
check('tag and rung change together', body.ok === true && row.tag === 'standard' && row.level === 4, JSON.stringify(row));
res = await admin('/api/admin/devices/level', { id: 'vortex', tag: 'yeshiva', level: 5 });
check('a rung the target ladder lacks is refused', res.status === 400);
out = await (await proxyCheck('10.66.0.4', 'https://brand-new-site.example/', {}, SEDER)).json();
check('off the tag, the shiur windows no longer apply', out.action !== 'locked', JSON.stringify(out));

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} FAILED\n` : '\nAll yeshiva checks passed.\n');
process.exit(failures ? 1 : 0);
