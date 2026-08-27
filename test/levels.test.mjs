// Offline tests for the strictness-level rules. No network, no D1 — levels.js is pure on purpose.
// Run with: npm test
//
// The model is now UNIFORM: every web rung (2..5) allows a site or search only if its rating is at
// or below the rung. There is no allowlist/permissive split and no doorway special-case — one gate,
// the bar sliding up per rung. These checks pin that, plus the two invariants that matter: rung 1
// has no web, and NEVER (6) is blocked even at the most open rung.

import assert from 'node:assert';
import {
  LEVELS, MIN_LEVEL, MAX_DEVICE_LEVEL, NEVER_LEVEL,
  levelDefinition, normalizeDeviceLevel, normalizeSiteLevel,
  isVisibleAtLevel, levelsThatAllow,
} from '../src/levels.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

const site = (level) => ({ level });

console.log('\n1. rung 1 has no web at all');
check('nothing is visible at rung 1, whatever its rating', () => {
  assert.equal(isVisibleAtLevel(site(2), 1), false);
  assert.equal(isVisibleAtLevel(site(1), 1), false);
});

console.log('\n2. the uniform gate: rating <= rung');
check('a site is visible exactly at and above its rating', () => {
  assert.equal(isVisibleAtLevel(site(3), 2), false);
  assert.equal(isVisibleAtLevel(site(3), 3), true);
  assert.equal(isVisibleAtLevel(site(3), 4), true);
  assert.equal(isVisibleAtLevel(site(3), 5), true);
});
check('rating 2 (essential/clean-general) shows from rung 2 up', () => {
  assert.equal(isVisibleAtLevel(site(2), 2), true);
  assert.equal(isVisibleAtLevel(site(2), 5), true);
});
check('rating 4 (general, non-shtus) is hidden below rung 4', () => {
  assert.equal(isVisibleAtLevel(site(4), 3), false);
  assert.equal(isVisibleAtLevel(site(4), 4), true);
});
check('rating 5 (immodest/shtus) shows only at rung 5', () => {
  assert.equal(isVisibleAtLevel(site(5), 4), false);
  assert.equal(isVisibleAtLevel(site(5), 5), true);
});

console.log('\n3. NEVER is blocked even at the most open rung');
check('rated NEVER hidden at rung 5', () => {
  assert.equal(isVisibleAtLevel(site(NEVER_LEVEL), 5), false);
});
check('rated NEVER produces no rung memberships', () => {
  assert.deepEqual(levelsThatAllow(site(NEVER_LEVEL)), []);
});

console.log('\n4. rung membership is every web rung at or above the rating');
check('rated 2 belongs to rungs 2..5', () => {
  assert.deepEqual(levelsThatAllow(site(2)), [2, 3, 4, 5]);
});
check('rated 4 belongs to rungs 4 and 5', () => {
  assert.deepEqual(levelsThatAllow(site(4)), [4, 5]);
});
check('rated 5 belongs to rung 5 only', () => {
  assert.deepEqual(levelsThatAllow(site(5)), [5]);
});

console.log('\n5. bad input fails strict, never loose, and never throws');
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
});
check('a corrupt site rating clamps to never', () => {
  assert.equal(normalizeSiteLevel('banana'), NEVER_LEVEL);
  assert.equal(normalizeSiteLevel(99), NEVER_LEVEL);
});

console.log('\n6. the ladder itself is well formed');
check('rungs are contiguous from 1 to the maximum device level', () => {
  assert.deepEqual(LEVELS.map((l) => l.level), [1, 2, 3, 4, 5]);
  assert.equal(LEVELS[LEVELS.length - 1].level, MAX_DEVICE_LEVEL);
});
check('only rung 1 has no web', () => {
  assert.deepEqual(LEVELS.filter((l) => l.webMode === 'none').map((l) => l.level), [1]);
});
check('images are off below rung 3', () => {
  assert.equal(levelDefinition(2).images, false);
  assert.equal(levelDefinition(3).images, true);
});
check('social is blocked everywhere except the most open rung', () => {
  assert.deepEqual(LEVELS.filter((l) => l.blockSocial).map((l) => l.level), [1, 2, 3, 4]);
});
check('an unknown rung has no definition', () => {
  assert.equal(levelDefinition(9), null);
});

console.log(`\nAll ${passed} level checks passed.\n`);
