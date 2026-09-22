// The app matrix: which packages each rung allows, and which it refuses. The rules live in two
// generators (scripts/build-app-rules-seed.mjs for the standard ladder, scripts/build-yeshiva-seed.mjs
// for the yeshiva tag) and are emitted twice each: into the migration that first carried them, and
// into a re-runnable refresh migration that actually reaches the live database. This test pins the
// checked-in migrations to their generators and the rung SEMANTICS to the operator's decisions, so
// a bucket edited in one place and forgotten in another fails here rather than on a phone.
//
// Why this matters more than it looks: rungs 4-5 (standard) and 3-4 (yeshiva) are BLOCKLIST
// policies — app_default 'allowed' — so a package with no row installs and runs. A missing entry is
// not a stricter default, it is an open door.
//
// Pure, no deps. Run with: npm test
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const STANDARD_REFRESH = 'migrations/0022_streaming_and_preinstalled.sql';
const YESHIVA_REFRESH = 'migrations/0023_yeshiva_streaming_and_preinstalled.sql';
const STANDARD_RUNGS = [1, 2, 3, 4, 5].map((r) => `apps_rung_${r}`);

// (policy, package) -> state, parsed out of an INSERT ... VALUES block.
function rules(sql) {
  const map = new Map();
  const re = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'(allowed|blocked|hidden)'\s*\)/g;
  let m;
  while ((m = re.exec(sql))) map.set(`${m[1]}|${m[2]}`, m[3]);
  return map;
}
const stateOf = (map, policy, pkg) => map.get(`${policy}|${pkg}`) || null;

console.log('\n1. the checked-in migrations are what the generators produce');
for (const [gen, files] of [
  ['scripts/build-app-rules-seed.mjs', ['migrations/0014_app_rules_bank_apps.sql', STANDARD_REFRESH]],
  ['scripts/build-yeshiva-seed.mjs', ['migrations/0016_yeshiva_tag.sql', YESHIVA_REFRESH]],
]) {
  const before = files.map(read);
  execFileSync(process.execPath, [new URL(gen, root).pathname], { stdio: 'pipe' });
  const after = files.map(read);
  check(`${gen} — regenerating changes nothing`, () => {
    files.forEach((f, i) => assert.equal(after[i], before[i], `${f} is stale: run \`node ${gen}\` and commit`));
  });
}

const std = rules(read(STANDARD_REFRESH));
const yesh = rules(read(YESHIVA_REFRESH));

console.log('\n2. the things that enforce the policy are never blocked');
// An allowlist rung hides whatever has no 'allowed' row — including, without these, the agent that
// applies the rules, the tunnel that filters, and the companion that guards WhatsApp's Updates tab.
const MANAGEMENT = ['com.hmdm.launcher', 'com.wireguard.android', 'com.getshmira.companion'];
check('allowed on every standard rung', () => {
  for (const pkg of MANAGEMENT) {
    for (const p of STANDARD_RUNGS) assert.equal(stateOf(std, p, pkg), 'allowed', `${p} / ${pkg}`);
  }
});
check('allowed on every yeshiva policy, shiur included', () => {
  const policies = ['yeshiva_rung_1', 'yeshiva_rung_2', 'yeshiva_rung_3', 'yeshiva_rung_4', 'yeshiva_shiur'];
  for (const pkg of MANAGEMENT) {
    for (const p of policies) assert.equal(stateOf(yesh, p, pkg), 'allowed', `${p} / ${pkg}`);
  }
});

console.log('\n3. video streaming rides with social: off until the most open rung of each ladder');
const VIDEO = [
  'com.netflix.mediaclient', 'com.disney.disneyplus', 'com.amazon.avod.thirdpartyclient',
  'com.google.android.videos', 'com.samsung.android.tvplus', 'com.hulu.plus', 'com.plexapp.android',
];
check('standard: blocked on rungs 1-4, allowed at rung 5', () => {
  for (const pkg of VIDEO) {
    for (const r of [1, 2, 3, 4]) assert.equal(stateOf(std, `apps_rung_${r}`, pkg), 'blocked', `rung ${r} / ${pkg}`);
    assert.equal(stateOf(std, 'apps_rung_5', pkg), 'allowed', `rung 5 / ${pkg}`);
  }
});
check('yeshiva: blocked on rung 3, permitted on rung 4 as social is', () => {
  for (const pkg of VIDEO) {
    assert.equal(stateOf(yesh, 'yeshiva_rung_3', pkg), 'blocked', `rung 3 / ${pkg}`);
    // Rung 4 is a blocklist: no row IS the permission. A 'blocked' row there would contradict the
    // decision that video follows social, which rung 4 allows.
    assert.notEqual(stateOf(yesh, 'yeshiva_rung_4', pkg), 'blocked', `rung 4 / ${pkg} should not be blocked`);
  }
});
check('music streaming was NOT swept up with video', () => {
  // Spotify keeps the states it had; its artwork is refused at the network layer instead.
  assert.equal(stateOf(std, 'apps_rung_3', 'com.spotify.music'), 'blocked');
  assert.equal(stateOf(std, 'apps_rung_4', 'com.spotify.music'), 'allowed');
  assert.equal(stateOf(std, 'apps_rung_5', 'com.spotify.music'), 'allowed');
  assert.notEqual(stateOf(yesh, 'yeshiva_rung_4', 'com.spotify.music'), 'blocked');
});
check('YouTube Music is treated exactly as Spotify, on both ladders', () => {
  // The operator's decision. They share one constant in the generator; this pins the result, so a
  // later edit to one that misses the other fails here.
  const YTM = 'com.google.android.apps.youtube.music';
  for (const p of STANDARD_RUNGS) {
    assert.equal(stateOf(std, p, YTM), stateOf(std, p, 'com.spotify.music'), `${p}: YouTube Music != Spotify`);
  }
  for (const p of ['yeshiva_rung_3', 'yeshiva_rung_4']) {
    assert.equal(stateOf(yesh, p, YTM), stateOf(yesh, p, 'com.spotify.music'), `${p}: YouTube Music != Spotify`);
  }
});

console.log('\n4. a second app store is refused on EVERY rung, the open one included');
// These do not deliver content, they deliver whatever the policy just refused — so unlike the
// content buckets they never come back at the top rung.
const SOURCES = ['com.sec.android.app.samsungapps', 'org.fdroid.fdroid', 'com.amazon.venezia', 'com.sec.android.easyMover'];
check('standard: blocked on all five rungs', () => {
  for (const pkg of SOURCES) {
    for (const p of STANDARD_RUNGS) assert.equal(stateOf(std, p, pkg), 'blocked', `${p} / ${pkg}`);
  }
});
check('yeshiva: blocked on BOTH blocklist rungs', () => {
  for (const pkg of SOURCES) {
    for (const p of ['yeshiva_rung_3', 'yeshiva_rung_4']) assert.equal(stateOf(yesh, p, pkg), 'blocked', `${p} / ${pkg}`);
  }
});
check('the Play Store itself is never blocked — the blocklist rungs need it', () => {
  for (const [map, policies] of [[std, STANDARD_RUNGS], [yesh, ['yeshiva_rung_3', 'yeshiva_rung_4']]]) {
    for (const p of policies) assert.notEqual(stateOf(map, p, 'com.android.vending'), 'blocked', `${p}`);
  }
});

console.log('\n5. the refreshes cannot damage the other ladder');
check('the standard refresh scopes its DELETE to the standard policies', () => {
  const sql = read(STANDARD_REFRESH);
  const del = /DELETE FROM app_rules\s+WHERE policy_id IN \(([^)]*)\)\s+AND package_name IN/m.exec(sql);
  assert.ok(del, 'the DELETE must be scoped by policy_id: many of these packages also carry yeshiva rows');
  for (const p of STANDARD_RUNGS) assert.ok(del[1].includes(`'${p}'`), `${p} missing from the DELETE scope`);
});
check('the yeshiva refresh clears only yeshiva policies', () => {
  const del = /DELETE FROM app_rules WHERE policy_id IN \(([^)]*)\);/m.exec(read(YESHIVA_REFRESH));
  assert.ok(del, 'no policy-scoped DELETE found');
  assert.ok(!/apps_rung_/.test(del[1]), 'the yeshiva refresh must not touch the standard policies');
});
check('the yeshiva refresh rebuilds the rung-3 + YouTube policy', () => {
  // 0020 derived it from rung 3's rows. Without rebuilding it here, those phones would keep the old
  // blocklist and quietly miss every addition.
  const sql = read(YESHIVA_REFRESH);
  assert.ok(/DELETE FROM app_rules WHERE policy_id = 'yeshiva_rung_3_yt';/.test(sql), 'no rung_3_yt reset');
  assert.ok(/SELECT 'yeshiva_rung_3_yt', package_name, state/.test(sql), 'no rung_3_yt rebuild');
  assert.ok(/package_name <> 'com\.google\.android\.youtube'/.test(sql), 'the rebuild must still exclude YouTube');
});

console.log('\n6. no package is both allowed and blocked on one policy');
check('every (policy, package) pair has one state', () => {
  for (const [label, sql] of [['standard', read(STANDARD_REFRESH)], ['yeshiva', read(YESHIVA_REFRESH)]]) {
    const seen = new Map();
    const re = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'(allowed|blocked|hidden)'\s*\)/g;
    let m;
    while ((m = re.exec(sql))) {
      const key = `${m[1]}|${m[2]}`;
      if (seen.has(key)) assert.equal(seen.get(key), m[3], `${label}: ${key} appears as both ${seen.get(key)} and ${m[3]}`);
      seen.set(key, m[3]);
    }
  }
});

console.log(`\nAll ${passed} app-rule checks passed.\n`);
