// Streaming services and the per-phone test bench, against a real SQLite database through the D1
// shim. Two things are pinned here:
//
//   1. A video streaming service is refused on the yeshiva ladder. That ladder is allow-by-default
//      with no model in the request path, so before src/streaming.js netflix.com was simply allowed
//      on every rung — which is how a phone on rung 3 was watching Netflix. The check must hold at
//      the TLS HANDSHAKE too (the helper asks with "host:443"), because that is the only moment the
//      proxy ever sees of the app's own traffic.
//
//   2. A device_overrides row changes ONE phone and no other. The whole point of the table is
//      trying something on a handset without moving a rung that other people's phones are on, so
//      "the other phone is unaffected" is the assertion that matters most.
//
// No network and no model: a blocklist rung must never call the model, and that is counted.

import { handleProxyCheck, handleMediaOnList } from '../src/proxy-api.js';
import { isStreamingHost, isYoutubeHost } from '../src/streaming.js';
import { applyDeviceOverrides, levelDefinition } from '../src/levels.js';
import { makeDB } from './d1-shim.mjs';

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

const DB = makeDB('./schema.sql');
const env = { DB, OPERATOR_KEY: 'op-key', PROXY_KEY: 'proxy-key', GEMINI_API_KEY: 'x' };

let modelCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('generativelanguage')) {
    modelCalls++;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ level: 2, reason: 'x' }) }] } }] });
  }
  return new Response('<title>x</title>');
};

const proxyCheck = (user, url, extra = {}) =>
  handleProxyCheck(new Request('https://w/api/proxy/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer proxy-key' },
    body: JSON.stringify({ user, url, ...extra }),
  }), env, new Date('2026-09-11T13:00:00Z')); // Friday: no shiur window, so nothing is locked

const mediaOn = () => handleMediaOnList(new Request('https://w/api/proxy/media-on', {
  headers: { Authorization: 'Bearer proxy-key' },
}), env);

// Two yeshiva phones on the SAME rung. That is the shape the override has to survive.
for (const [id, user] of [['isaac', '10.66.0.3'], ['other', '10.66.0.5']]) {
  await DB.prepare(`INSERT INTO devices (id, headwind_device_id, label, policy_id, timezone, enrolled_at, level, tag, proxy_user)
                    VALUES (?, ?, ?, 'yeshiva_rung_3', 'Asia/Jerusalem', 0, 3, 'yeshiva', ?)`)
    .bind(id, id, id, user).run();
}

console.log('\n1. the host matcher');
check('netflix.com', isStreamingHost('netflix.com') && isStreamingHost('www.netflix.com'));
check('the video CDN on its own domain', isStreamingHost('ipv4-c001-tlv001-ix.1.oca.nflxvideo.net'));
check('Disney+ and Prime Video', isStreamingHost('disneyplus.com') && isStreamingHost('aiv-cdn.net'));
check('Apple TV by exact host', isStreamingHost('tv.apple.com'));
check('but NOT apple.com itself — the phone needs it', !isStreamingHost('apple.com') && !isStreamingHost('www.apple.com'));
check('and NOT play.google.com', !isStreamingHost('play.google.com'));
check('an ordinary site is not streaming', !isStreamingHost('wikipedia.org') && !isStreamingHost('sefaria.org'));
check('junk is not streaming', !isStreamingHost('') && !isStreamingHost(null));

console.log('\n2. yeshiva rung 3: the whole reason this exists');
modelCalls = 0;
let out = await (await proxyCheck('10.66.0.3', 'https://www.netflix.com/browse')).json();
check('netflix.com is refused', out.allow === false && out.action === 'blocked', JSON.stringify(out));
check('and no model was asked — this ladder has none', modelCalls === 0);
out = await (await proxyCheck('10.66.0.3', 'https://ipv4-c001.1.oca.nflxvideo.net/range/0-100')).json();
check('so is the video CDN', out.allow === false, JSON.stringify(out));
// The handshake is how the APP is judged: squid asks with "host:443" and the helper turns that
// into https://host/. If this allowed, squid would splice and the app would work untouched.
out = await (await proxyCheck('10.66.0.3', 'https://www.netflix.com/')).json();
check('the answer is host-scoped, so it holds at the TLS handshake', out.allow === false && out.cache_scope === 'host', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.3', 'https://en.wikipedia.org/wiki/Volcano')).json();
check('an ordinary site is still allowed', out.allow === true, JSON.stringify(out));

console.log('\n3. the standard ladder is left to its model, not to this list');
await DB.prepare(`INSERT INTO devices (id, headwind_device_id, label, policy_id, timezone, enrolled_at, level, tag, proxy_user)
                  VALUES ('std', 'std', 'std', 'apps_rung_5', 'UTC', 0, 5, 'standard', '10.66.0.9')`).run();
out = await (await proxyCheck('10.66.0.9', 'https://www.netflix.com/')).json();
check('a standard rung-5 phone is not refused by the streaming list', out.action !== 'blocked' || out.reason !== 'Streaming services are turned off on this phone.', JSON.stringify(out));

console.log('\n4. the per-phone override: one handset, not the rung');
check('no row means the rung is unchanged', applyDeviceOverrides(levelDefinition(3, 'yeshiva'), null) === levelDefinition(3, 'yeshiva'));
check('an all-null row is also unchanged', applyDeviceOverrides(levelDefinition(3, 'yeshiva'), { images: null, streaming: null }) === levelDefinition(3, 'yeshiva'));
check('a corrupt value falls back to the rung, never to open',
  applyDeviceOverrides(levelDefinition(3, 'yeshiva'), { streaming: 'yes-please' }).streaming === false);
check('snake_case from the row is accepted',
  applyDeviceOverrides(levelDefinition(3, 'yeshiva'), { app_media: 1 }).appMedia === true);
check('the shared rung object is never mutated', levelDefinition(3, 'yeshiva').appMedia === false);

// Let Isaac's phone have streaming, and leave the other rung-3 phone alone.
await DB.prepare(`INSERT INTO device_overrides (device_id, streaming, note, set_at) VALUES ('isaac', 1, 'testing', 0)`).run();
out = await (await proxyCheck('10.66.0.3', 'https://www.netflix.com/')).json();
check('the overridden phone is let through', out.allow === true, JSON.stringify(out));
out = await (await proxyCheck('10.66.0.5', 'https://www.netflix.com/')).json();
check('THE OTHER PHONE ON THE SAME RUNG IS UNAFFECTED', out.allow === false, JSON.stringify(out));

console.log('\n5. the override reaches the in-app picture list squid reads');
let list = await (await mediaOn()).json();
check('rung 3 gets no in-app pictures, so neither phone is listed',
  !list.addresses.includes('10.66.0.3') && !list.addresses.includes('10.66.0.5'), JSON.stringify(list));
await DB.prepare(`UPDATE device_overrides SET app_media = 1 WHERE device_id = 'isaac'`).run();
list = await (await mediaOn()).json();
check('turning it on for one phone lists only that phone',
  list.addresses.includes('10.66.0.3') && !list.addresses.includes('10.66.0.5'), JSON.stringify(list));

console.log('\n6. an override can tighten as well as loosen');
await DB.prepare(`UPDATE device_overrides SET web_mode = 'none' WHERE device_id = 'isaac'`).run();
out = await (await proxyCheck('10.66.0.3', 'https://en.wikipedia.org/')).json();
check('web_mode none takes the browser away from that phone alone', out.allow === false && out.action === 'no_web', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.5', 'https://en.wikipedia.org/')).json();
check('and the other phone still browses', out.allow === true, JSON.stringify(out));

console.log('\n6b. YouTube, which the rungs disagree about');
check('youtube.com and youtu.be', isYoutubeHost('www.youtube.com') && isYoutubeHost('youtu.be'));
check('the video CDN, which is what actually plays', isYoutubeHost('r1---sn-abc.googlevideo.com'));
check('but NOT google.com or the account media', !isYoutubeHost('google.com') && !isYoutubeHost('lh3.googleusercontent.com'));
check('YouTube is NOT in the streaming list (it has its own flag)', !isStreamingHost('youtube.com'));

// Isaac's row still carries web_mode none from section 6; clear the whole override first.
await DB.prepare(`DELETE FROM device_overrides WHERE device_id = 'isaac'`).run();
out = await (await proxyCheck('10.66.0.3', 'https://www.youtube.com/watch?v=x')).json();
check('yeshiva rung 3 refuses youtube.com', out.allow === false && out.action === 'blocked', JSON.stringify(out));
out = await (await proxyCheck('10.66.0.3', 'https://r1---sn-abc.googlevideo.com/videoplayback')).json();
check('and the video CDN, so nothing plays', out.allow === false, JSON.stringify(out));

// The per-phone exception must reach the WEB too, or the site is refused on the very phone that
// was granted the app.
await DB.prepare(`UPDATE devices SET allow_youtube = 1 WHERE id = 'isaac'`).run();
out = await (await proxyCheck('10.66.0.3', 'https://www.youtube.com/')).json();
check('allow_youtube lets that phone reach youtube.com', out.allow === true, JSON.stringify(out));
out = await (await proxyCheck('10.66.0.5', 'https://www.youtube.com/')).json();
check('while the other rung-3 phone is still refused', out.allow === false, JSON.stringify(out));
out = await (await proxyCheck('10.66.0.3', 'https://www.netflix.com/')).json();
check('and allow_youtube does NOT open Netflix', out.allow === false, JSON.stringify(out));

// Scoped to rung 3: the flag is remembered on other rungs but must not act there.
await DB.prepare(`UPDATE devices SET level = 2 WHERE id = 'isaac'`).run();
out = await (await proxyCheck('10.66.0.3', 'https://www.youtube.com/')).json();
check('the flag is inert on rung 2', out.allow === false, JSON.stringify(out));
await DB.prepare(`UPDATE devices SET level = 3, allow_youtube = 0 WHERE id = 'isaac'`).run();

// Rung 4 permits the social apps, YouTube among them, so the site follows.
await DB.prepare(`UPDATE devices SET level = 4, policy_id = 'yeshiva_rung_4' WHERE id = 'other'`).run();
out = await (await proxyCheck('10.66.0.5', 'https://www.youtube.com/')).json();
check('yeshiva rung 4 allows youtube.com, matching its app blocklist', out.allow === true, JSON.stringify(out));
out = await (await proxyCheck('10.66.0.5', 'https://www.netflix.com/')).json();
check('but rung 4 still refuses Netflix', out.allow === false, JSON.stringify(out));
await DB.prepare(`UPDATE devices SET level = 3, policy_id = 'yeshiva_rung_3' WHERE id = 'other'`).run();

console.log('\n7. the operator endpoint, so none of this is hand-written SQL');
const worker = (await import('../src/index.js')).default;
const admin = (path, b) => worker.fetch(new Request(`https://w${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer op-key' },
  body: JSON.stringify(b),
}), env);

let r = await admin('/api/admin/device-overrides', { device_id: 'nobody', streaming: true });
check('an unknown phone is a 404', r.status === 404);
r = await admin('/api/admin/device-overrides', { device_id: 'isaac', streaming: 'maybe' });
check('a value that is neither yes nor no is refused, not guessed', r.status === 400);
r = await admin('/api/admin/device-overrides', { device_id: 'isaac', policy_id: 'no_such_policy' });
check('a policy that does not exist is refused before the scheduler can strand on it', r.status === 400);

r = await admin('/api/admin/device-overrides', { device_id: 'isaac', images: true, note: 'picture test' });
check('setting one field works', r.status === 200, JSON.stringify(await r.clone().json()));
out = await (await proxyCheck('10.66.0.3', 'https://en.wikipedia.org/x.jpg', { dest: 'image' })).json();
check('images back on for that phone', out.allow === true, JSON.stringify(out));
out = await (await proxyCheck('10.66.0.5', 'https://en.wikipedia.org/x.jpg', { dest: 'image' })).json();
check('and still stripped on the other one', out.allow === false, JSON.stringify(out));
check('a re-save drops the fields it does not mention', (await (await proxyCheck('10.66.0.3', 'https://www.netflix.com/')).json()).allow === false);

r = await admin('/api/admin/device-overrides', { device_id: 'isaac', clear: true });
check('clearing puts the phone back on its rung', r.status === 200);
out = await (await proxyCheck('10.66.0.3', 'https://en.wikipedia.org/x.jpg', { dest: 'image' })).json();
check('images stripped again', out.allow === false, JSON.stringify(out));
const st = await (await worker.fetch(new Request('https://w/api/admin/state', { headers: { Authorization: 'Bearer op-key' } }), env)).json();
check('the console can see overrides at all', Array.isArray(st.overrides));

console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll streaming / override checks passed.');
process.exit(failures ? 1 : 0);
