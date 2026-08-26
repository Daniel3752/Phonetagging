// Offline tests for the strictness-level rules. No network, no D1, no Gateway — levels.js is pure
// on purpose. Run with: npm test
//
// The model is five rungs (1 strictest .. 5 most open) where each rung is a MODE. Two properties
// matter most and these checks pin them: the deny-by-default / allow-by-default line between rungs 3
// and 4, and the NEVER rating that stays hidden even at the most open rung (explicit is never
// visible, "everything but explicit" and all).

import assert from 'node:assert';
import {
  LEVELS, MIN_LEVEL, MAX_DEVICE_LEVEL, NEVER_LEVEL,
  levelDefinition, normalizeDeviceLevel, normalizeSiteLevel,
  isVisibleAtLevel, levelsThatAllow,
} from '../src/levels.js';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

const site = (level, doorway = false) => ({ level, is_doorway: doorway ? 1 : 0 });

console.log('\n1. rung 1 has no web at all');
check('nothing is visible at rung 1, whatever its rating', () => {
  assert.equal(isVisibleAtLevel(site(1), 1), false);
  assert.equal(isVisibleAtLevel(site(3), 1), false);
});

console.log('\n2. allowlist rungs (2, 3) are deny-by-default, gated by rating');
check('rated 3 hidden from a rung-2 device', () => {
  assert.equal(isVisibleAtLevel(site(3), 2), false);
});
check('rated 2 visible at rung 2', () => {
  assert.equal(isVisibleAtLevel(site(2), 2), true);
});
check('rated 3 visible at rung 3', () => {
  assert.equal(isVisibleAtLevel(site(3), 3), true);
});
check('rated 4 hidden at rung 3 (above the allowlist bar)', () => {
  assert.equal(isVisibleAtLevel(site(4), 3), false);
});

console.log('\n3. permissive rungs (4, 5) are allow-by-default');
check('an ordinary unrated-high site is visible at rung 4', () => {
  assert.equal(isVisibleAtLevel(site(4), 4), true);
});
check('the same site is visible at rung 5', () => {
  assert.equal(isVisibleAtLevel(site(4), 5), true);
});
check('rung 3 -> 4 is the deny/allow line', () => {
  assert.equal(isVisibleAtLevel(site(4), 3), false); // deny-by-default hides it
  assert.equal(isVisibleAtLevel(site(4), 4), true);  // allow-by-default shows it
});

console.log('\n4. the never-rating is visible to nobody, even at the most open rung');
check('rated NEVER hidden at rung 5', () => {
  assert.equal(isVisibleAtLevel(site(NEVER_LEVEL), 5), false);
});
check('rated NEVER produces no allowlist memberships', () => {
  assert.deepEqual(levelsThatAllow(site(NEVER_LEVEL)), []);
});

console.log('\n5. doorways need an explicit allow on strict rungs; search engines are separate');
check('a doorway (open-content platform) is hidden at rung 1', () => {
  assert.equal(isVisibleAtLevel(site(1, true), 1), false);
});
check('a doorway is hidden at an allowlist rung even when well-rated', () => {
  assert.equal(isVisibleAtLevel(site(1, true), 2), false);
  assert.equal(isVisibleAtLevel(site(1, true), 3), false);
});
check('a doorway is visible at a permissive rung (blocklist handles social upstream)', () => {
  assert.equal(isVisibleAtLevel(site(1, true), 5), true);
});
check('a doorway never lands in an allowlist by rating', () => {
  assert.deepEqual(levelsThatAllow(site(1, true)), []);
  assert.deepEqual(levelsThatAllow(site(NEVER_LEVEL, true)), []);
});

console.log('\n6. allowlist membership covers only the allowlist rungs (2, 3)');
check('rated 1 belongs to rungs 2 and 3', () => {
  assert.deepEqual(levelsThatAllow(site(1)), [2, 3]);
});
check('rated 2 belongs to rungs 2 and 3', () => {
  assert.deepEqual(levelsThatAllow(site(2)), [2, 3]);
});
check('rated 3 belongs to rung 3 only', () => {
  assert.deepEqual(levelsThatAllow(site(3)), [3]);
});
check('rated 4 belongs to no allowlist rung (permissive rungs keep no list)', () => {
  assert.deepEqual(levelsThatAllow(site(4)), []);
});

console.log('\n7. bad input fails strict, never loose, and never throws');
check('an unrated verdict is treated as never-visible', () => {
  assert.equal(isVisibleAtLevel({ level: null }, MAX_DEVICE_LEVEL), false);
});
check('a missing verdict is treated as never-visible', () => {
  assert.equal(isVisibleAtLevel(undefined, MAX_DEVICE_LEVEL), false);
});
check('a corrupt device level clamps to the strictest rung', () => {
  assert.equal(normalizeDeviceLevel('banana'), MIN_LEVEL);
  assert.equal(normalizeDeviceLevel(0), MIN_LEVEL);
  assert.equal(normalizeDeviceLevel(99), MIN_LEVEL);
  assert.equal(normalizeDeviceLevel(2.5), MIN_LEVEL);
});
check('the NEVER rating is not a real device rung', () => {
  assert.equal(normalizeDeviceLevel(NEVER_LEVEL), MIN_LEVEL);
});
check('a corrupt site rating clamps to never', () => {
  assert.equal(normalizeSiteLevel('banana'), NEVER_LEVEL);
  assert.equal(normalizeSiteLevel(0), NEVER_LEVEL);
  assert.equal(normalizeSiteLevel(99), NEVER_LEVEL);
});

console.log('\n8. the ladder itself is well formed');
check('rungs are contiguous from 1 to the maximum device level', () => {
  assert.deepEqual(LEVELS.map((l) => l.level), [1, 2, 3, 4, 5]);
  assert.equal(LEVELS[LEVELS.length - 1].level, MAX_DEVICE_LEVEL);
});
check('exactly rungs 4 and 5 are allow-by-default', () => {
  const permissive = LEVELS.filter((l) => l.webMode === 'permissive').map((l) => l.level);
  assert.deepEqual(permissive, [4, 5]);
});
check('only rung 1 has no web', () => {
  const none = LEVELS.filter((l) => l.webMode === 'none').map((l) => l.level);
  assert.deepEqual(none, [1]);
});
check('images are off below rung 3', () => {
  assert.equal(levelDefinition(2).images, false);
  assert.equal(levelDefinition(3).images, true);
});
check('social is blocked everywhere except the most open rung', () => {
  const social = LEVELS.filter((l) => l.blockSocial).map((l) => l.level);
  assert.deepEqual(social, [1, 2, 3, 4]);
});
check('an unknown rung has no definition', () => {
  assert.equal(levelDefinition(9), null);
});

console.log(`\nAll ${passed} level checks passed.\n`);
