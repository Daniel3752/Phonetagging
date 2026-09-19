// Offline parity test for the in-app media hosts. No network, no D1.
// Run with: npm test
//
// The rule that refuses Spotify's artwork hosts exists THREE times: as the squid regex in
// scripts/squid.conf (what the TLS handshake enforces), as APP_MEDIA_RX in
// scripts/apply-yeshiva-squid.sh (what actually reaches the live box), and as src/app-media.js
// (what the Worker answers for Chrome's decrypted requests, and the readable statement of the
// rule). They drifted once — the JS refused a host the regex passed and vice versa — so this pins
// all three to one corpus. Two invariants matter more than the rest and get their own checks: the
// hosts that carry the music, the API and the login are refused by NONE of the copies, and the
// regex's short labels (i, o, t, p, pl) match those exact labels only, never as prefixes.

import assert from 'node:assert';
import fs from 'node:fs';
import { appMediaHost } from '../src/app-media.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

const conf = fs.readFileSync(new URL('../scripts/squid.conf', import.meta.url), 'utf8');
const aclLine = conf.split('\n').find((l) => l.startsWith('acl app_media_hosts ssl::server_name_regex -i '));
assert.ok(aclLine, 'squid.conf has the app_media_hosts regex acl');
const confRx = aclLine.split(/\s+/).pop();

const apply = fs.readFileSync(new URL('../scripts/apply-yeshiva-squid.sh', import.meta.url), 'utf8');
const rxLine = apply.split('\n').find((l) => l.startsWith("export APP_MEDIA_RX='"));
assert.ok(rxLine, 'apply-yeshiva-squid.sh exports APP_MEDIA_RX');
const applyRx = rxLine.slice("export APP_MEDIA_RX='".length, -1);

// The regex uses nothing beyond POSIX ERE (groups, alternation, a bracket class, anchors), so
// JavaScript's engine reads it the way squid's does; -i is the i flag.
const re = new RegExp(confRx, 'i');

// Hosts Spotify's own apps have been seen using, or that its CDN naming makes plausible. Media
// hosts first, then everything that must keep working.
const MEDIA = [
  'i.scdn.co', 'o.scdn.co', 't.scdn.co', 'p.scdn.co', 'pl.scdn.co', 'misc.scdn.co', 'mosaic.scdn.co',
  'canvaz.scdn.co', 'daily-mix.scdn.co', 'lineup-images.scdn.co', 'thisis-images.scdn.co',
  'newjams-images.scdn.co', 'charts-images.scdn.co', 'dailymix-images.scdn.co', 'merch-img.scdn.co',
  'profile-images.scdn.co', 'seeded-session-images.scdn.co', 'wrapped-images.spotifycdn.com',
  'seed-mix-image.spotifycdn.com', 'pickasso.spotifycdn.com', 'daylist.spotifycdn.com',
  'concerts.spotifycdn.com', 'fex.spotifycdn.com', 'lexicon-assets.spotifycdn.com',
  'mixed-media-images.spotifycdn.com', 'podz-content.spotifycdn.com',
  'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com', 'image-cdn-cf.spotifycdn.com',
  'images.scdn.co', 'image-upload.scdn.co',
  'video-fa.scdn.co', 'video-cf.spotifycdn.com', 'video-akpcw.spotifycdn.com', 'video4-ak.scdn.co',
  'video-ak.cdn.spotify.com', 'video-fa.spotify.com',
  'play-lh.googleusercontent.com',
];
const KEEP = [
  // The music itself, on every provider, and the track heads that make playback start instantly.
  'audio-fa.scdn.co', 'audio4-ak.spotifycdn.com', 'audio-fa.spotifycdn.com',
  'audio-ak-spotify-com.akamaized.net', 'audio4-ak-spotify-com.akamaized.net',
  'heads-fa.spotifycdn.com', 'heads4-ak.spotifycdn.com', 'heads-fa-tls13.spotifycdn.com',
  // The API, the access points, login, the web player.
  'spclient.wg.spotify.com', 'gew1-spclient.spotify.com', 'gae2-spclient.spotify.com',
  'guc3-spclient.spotify.com', 'gew4-spclient.spotify.com', 'apresolve.spotify.com',
  'dealer.spotify.com', 'gew1-dealer.spotify.com', 'login5.spotify.com', 'clienttoken.spotify.com',
  'api.spotify.com', 'api-partner.spotify.com', 'exp.wg.spotify.com', 'open.spotify.com',
  'accounts.spotify.com', 'www.spotify.com', 'ap-gew1.spotify.com', 'ap-guc3.spotify.com',
  'ap.spotify.com', 'dj-earcons.spotifycdn.com', 'encore.scdn.co',
  // Apexes, and hosts that merely START with a short label — never matched as prefixes.
  'cdn.spotify.com', 'spotify.com', 'scdn.co', 'spotifycdn.com',
  'i.spotify.com', 'p.spotify.com', 'pl.spotify.com', 'info.scdn.co', 'tracking.scdn.co',
  'player.scdn.co', 'open-cdn.spotifycdn.com', 'partner.spotifycdn.com',
  // The rest of googleusercontent carries the account's own photos and mail attachments.
  'lh3.googleusercontent.com', 'play-lh.googleusercontent.com.evil.example',
];

console.log('\n1. the three copies of the rule are one rule');
check('apply-yeshiva-squid.sh carries the same regex squid.conf does', () => {
  assert.equal(applyRx, confRx);
});
check('the regex is anchored at both ends, so a label is never matched as a prefix or a suffix', () => {
  assert.ok(confRx.startsWith('^') && confRx.endsWith('$'), confRx);
});
check('src/app-media.js and the regex agree on every host in the corpus', () => {
  const disagreements = [...MEDIA, ...KEEP].filter((h) => re.test(h) !== (appMediaHost(h) !== null));
  assert.deepEqual(disagreements, []);
});

console.log('\n2. what is refused and what must keep working');
check('every documented media host is refused by both', () => {
  for (const h of MEDIA) {
    assert.ok(re.test(h), `${h} should match the regex`);
    assert.ok(appMediaHost(h) !== null, `${h} should be refused by app-media.js`);
  }
});
check('the music, the API, login and the access points are refused by neither', () => {
  for (const h of KEEP) {
    assert.ok(!re.test(h), `${h} must not match the regex`);
    assert.equal(appMediaHost(h), null, `${h} must not be refused by app-media.js`);
  }
});
check('the short labels are exact: i.scdn.co is refused, info.scdn.co and i.spotify.com are not', () => {
  assert.ok(re.test('i.scdn.co') && re.test('I.SCDN.CO'));
  assert.ok(!re.test('info.scdn.co') && !re.test('i.spotify.com') && !re.test('ai.scdn.co'));
});

console.log(`\nAll ${passed} app-media checks passed.\n`);
