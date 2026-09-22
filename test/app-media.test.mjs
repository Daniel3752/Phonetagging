// The in-app media rule lives in two places that must agree: src/app-media.js (the Worker's
// answer for Chrome's decrypted requests, and the readable statement of what counts as in-app
// media) and the ssl::server_name_regex in scripts/squid.conf (what squid actually terminates at
// the TLS handshake, without asking anyone). apply-yeshiva-squid.sh carries a third copy of the
// regex for patching a live server. This test pins all three to each other and to a corpus of real
// Spotify hosts, so a role added to one and forgotten in another fails here rather than on a phone.
//
// Pure, no deps. Run with: npm test
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { appMediaHost, APP_MEDIA_EXAMPLES, SPOTIFY_KEEP_EXAMPLES, APP_MEDIA_DNS_HOSTS, SQUID_APP_MEDIA_REGEX, SQUID_APP_KEEP_REGEX } from '../src/app-media.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

const conf = readFileSync(new URL('../scripts/squid.conf', import.meta.url), 'utf8');
const apply = readFileSync(new URL('../scripts/apply-yeshiva-squid.sh', import.meta.url), 'utf8');

function regexFrom(text, label) {
  const m = /^acl app_media_hosts ssl::server_name_regex -i (\S+)$/m.exec(text)
    || /^export APP_MEDIA_RX='([^']+)'$/m.exec(text);
  assert.ok(m, `${label}: no app_media_hosts regex found`);
  return m[1];
}
function keepRegexFrom(text, label) {
  const m = /^acl app_keep_hosts ssl::server_name_regex -i (\S+)$/m.exec(text)
    || /^export APP_KEEP_RX='([^']+)'$/m.exec(text);
  assert.ok(m, `${label}: no app_keep_hosts regex found`);
  return m[1];
}

console.log('\n1. squid.conf and the live-server patch script carry the generated regexes');
const confRx = regexFrom(conf, 'squid.conf');
const applyRx = regexFrom(apply, 'apply-yeshiva-squid.sh');
const confKeep = keepRegexFrom(conf, 'squid.conf');
const applyKeep = keepRegexFrom(apply, 'apply-yeshiva-squid.sh');
const paste = (name, want) => `\n  ${name} must be exactly:\n  ${want}\n`;
check('app_media_hosts in squid.conf is the one src/app-media.js builds', () =>
  assert.equal(confRx, SQUID_APP_MEDIA_REGEX, paste('acl app_media_hosts ssl::server_name_regex -i', SQUID_APP_MEDIA_REGEX)));
check('and in apply-yeshiva-squid.sh (APP_MEDIA_RX)', () =>
  assert.equal(applyRx, SQUID_APP_MEDIA_REGEX, paste('APP_MEDIA_RX', SQUID_APP_MEDIA_REGEX)));
check('app_keep_hosts in squid.conf is the one src/app-media.js builds', () =>
  assert.equal(confKeep, SQUID_APP_KEEP_REGEX, paste('acl app_keep_hosts ssl::server_name_regex -i', SQUID_APP_KEEP_REGEX)));
check('and in apply-yeshiva-squid.sh (APP_KEEP_RX)', () =>
  assert.equal(applyKeep, SQUID_APP_KEEP_REGEX, paste('APP_KEEP_RX', SQUID_APP_KEEP_REGEX)));
check('the terminate rule negates the keep guard, in both', () => {
  const rule = 'ssl_bump terminate app_media_hosts !app_keep_hosts wg_phones !app_media_on';
  assert.ok(conf.includes(`\n${rule}\n`), 'squid.conf');
  assert.ok(apply.includes(`APP_MEDIA_RULE='${rule}'`), 'apply-yeshiva-squid.sh');
});
check('the regexes are plain POSIX ERE (no lookahead, no \\d, no non-greedy)', () => {
  for (const rx of [SQUID_APP_MEDIA_REGEX, SQUID_APP_KEEP_REGEX]) {
    assert.ok(!/\(\?|\\d|\\w|\\s|\*\?|\+\?/.test(rx), rx);
  }
});

// squid's -i regex is POSIX extended; everything used here is also valid JS.
const media = new RegExp(confRx, 'i');
const keep = new RegExp(confKeep, 'i');
// What squid does for a host on a phone whose rung has in-app pictures off.
const squidTerminates = (h) => media.test(h) && !keep.test(h);

console.log('\n2. squid terminates exactly the hosts the Worker refuses');
const refused = Object.values(APP_MEDIA_EXAMPLES).flat();
check('every example media host is matched by both', () => {
  for (const h of refused) {
    assert.ok(appMediaHost(h), `${h}: the Worker does not refuse it`);
    assert.ok(squidTerminates(h), `${h}: squid does not terminate it`);
  }
});
check('every example keep host is spared by both', () => {
  for (const h of SPOTIFY_KEEP_EXAMPLES) {
    assert.equal(appMediaHost(h), null, `${h}: the Worker refuses it`);
    assert.ok(!squidTerminates(h), `${h}: squid terminates it`);
  }
});

console.log('\n2b. every host the strict resolver refuses is media to both');
check('APP_MEDIA_DNS_HOSTS are all matched, and none is a keep host', () => {
  for (const [app, hosts] of Object.entries(APP_MEDIA_DNS_HOSTS)) {
    for (const h of hosts) {
      assert.equal(appMediaHost(h), app, `Worker: ${h}`);
      assert.ok(squidTerminates(h), `squid: ${h}`);
      assert.ok(!keep.test(h), `keep: ${h}`);
    }
  }
});

console.log('\n2c. the strict resolver seed file is current');
check('scripts/app-media.dnsmasq lists exactly APP_MEDIA_DNS_HOSTS (run node scripts/build-squid-media-acls.mjs)', () => {
  const seed = readFileSync(new URL('../scripts/app-media.dnsmasq', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.startsWith('local=')).map((l) => l.slice(7, -1));
  const want = [...new Set(Object.values(APP_MEDIA_DNS_HOSTS).flat())].sort();
  assert.deepEqual(seed, want);
});

console.log('\n3. a corpus of hosts, both ways');
const corpus = [
  // Seen on live phones or in Spotify's published lists: pictures and video.
  ['i.scdn.co', 'spotify'], ['o.scdn.co', 'spotify'], ['t.scdn.co', 'spotify'], ['pl.scdn.co', null],   // pl no longer exists
  ['mosaic.scdn.co', 'spotify'], ['image-cdn-ak.spotifycdn.com', 'spotify'], ['image-cdn-fa.spotifycdn.com', 'spotify'],
  ['image-cdn-cf.spotifycdn.com', 'spotify'], ['images-ak.spotifycdn.com', 'spotify'], ['video-fa.scdn.co', 'spotify'],
  ['video-cf.spotifycdn.com', 'spotify'], ['video-akpcw-cdn-spotify-com.akamaized.net', 'spotify'],
  ['canvaz.scdn.co', 'spotify'], ['pickasso.spotifycdn.com', 'spotify'], ['seed-mix-image.spotifycdn.com', 'spotify'],
  ['thisis-images.scdn.co', 'spotify'], ['dailymix-images.scdn.co', 'spotify'], ['daily-mix.scdn.co', 'spotify'],
  ['lineup-images.scdn.co', 'spotify'], ['newjams-images.scdn.co', 'spotify'], ['wrapped-images.spotifycdn.com', 'spotify'],
  ['charts-images.scdn.co', 'spotify'], ['merch-img.scdn.co', 'spotify'], ['profile-images.scdn.co', 'spotify'],
  ['seeded-session-images.scdn.co', 'spotify'], ['mixed-media-images.spotifycdn.com', 'spotify'],
  ['misc.scdn.co', 'spotify'], ['misc.spotifycdn.com', 'spotify'], ['daylist.spotifycdn.com', 'spotify'],
  ['concerts.spotifycdn.com', 'spotify'], ['fex.spotifycdn.com', 'spotify'], ['lexicon-assets.spotifycdn.com', 'spotify'],
  ['podz-content.spotifycdn.com', 'spotify'], ['artist-images.spotifycdn.com', 'spotify'], ['thumbnails.spotifycdn.com', 'spotify'],
  ['cover-images.scdn.co', 'spotify'], ['image-upload.spotify.com', 'spotify'], ['blend-playlist-covers.spotifycdn.com', 'spotify'],
  ['adstudio-video-preview-image.spotifycdn.com', 'spotify'], ['video-akpcw.spotifycdn.com', 'spotify'], ['video-ak-cdn-spotify-com.akamaized.net', 'spotify'],
  ['canvaz.spotifycdn.com', 'spotify'], ['misc.spotifycdn.com', 'spotify'],
  ['play-lh.googleusercontent.com', 'play'],
  // The music, the API, sign-in, access points, DJ, podcasts, previews and audio heads: never.
  ['audio-fa.scdn.co', null], ['audio4-fa.scdn.co', null], ['audio-ak.spotifycdn.com', null],
  ['audio-akp-quic-control.spotifycdn.com', null], ['audio-ak-spotify-com.akamaized.net', null],
  ['audio4-ak-spotify-com.akamaized.net', null], ['audio-sp-ams.pscdn.co', null],
  ['heads-fa.scdn.co', null], ['heads-fa-tls13.scdn.co', null], ['heads4-ak-spotify-com.akamaized.net', null],
  ['heads-ak.spotifycdn.com', null], ['p.scdn.co', null], ['anon-podcast.scdn.co', null],
  ['spclient.wg.spotify.com', null], ['gew1-spclient.spotify.com', null], ['guc3-spclient.spotify.com', null],
  ['gae2-spclient.spotify.com', null], ['apresolve.spotify.com', null], ['ap-gew1.spotify.com', null],
  ['gew1.ap.spotify.com', null], ['dealer.spotify.com', null], ['gew1-dealer.spotify.com', null],
  ['login5.spotify.com', null], ['clienttoken.spotify.com', null], ['accounts.spotify.com', null],
  ['api.spotify.com', null], ['api-partner.spotify.com', null], ['exp.wg.spotify.com', null],
  ['dj-earcons.spotifycdn.com', null], ['encore.scdn.co', null], ['open.spotify.com', null],
  ['www.spotify.com', null], ['open.spotifycdn.com', null], ['sdk.scdn.co', null], ['download.scdn.co', null],
  ['lh3.googleusercontent.com', null], ['photos.googleusercontent.com', null],
  ['audio-video-mix.scdn.co', null],   // a KEEP prefix wins over a media word further in
  ['image-cdn-ak.spotifycdn.com.evil.example', null], ['notscdn.co', null], ['i.scdn.co.example', null],
];
check(`${corpus.length} hosts agree between the Worker and squid`, () => {
  for (const [h, app] of corpus) {
    assert.equal(appMediaHost(h), app, `Worker: ${h}`);
    assert.equal(squidTerminates(h), app !== null, `squid: ${h}`);
  }
});

console.log(`\nAll ${passed} app-media checks passed.\n`);
