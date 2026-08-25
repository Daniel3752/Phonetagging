// Offline tests for the strictness-level rules. No network, no D1, no Gateway — levels.js is pure
// on purpose. Run with: npm test
//
// The doorway checks are the ones that matter. A search engine's homepage is a logo and a text box:
// judged on its own content it rates as harmless and would be allowed everywhere, and the moment it
// is, the allowlist stops meaning anything — the search box reaches all the content the list exists
// to keep out. These checks pin the rule that the doorway flag overrides the rating.

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

console.log('\n1. a site is visible at its own rung and every looser one');
check('rated 2 hidden from a level-1 device', () => {
  assert.equal(isVisibleAtLevel(site(2), 1), false);
});
check('rated 2 visible at level 2', () => {
  assert.equal(isVisibleAtLevel(site(2), 2), true);
});
check('rated 2 visible at level 4', () => {
  assert.equal(isVisibleAtLevel(site(2), 4), true);
});
check('rated 1 visible at every rung', () => {
  for (let l = MIN_LEVEL; l <= MAX_DEVICE_LEVEL; l++) {
    assert.equal(isVisibleAtLevel(site(1), l), true, `level ${l}`);
  }
});

console.log('\n2. the never-rating is visible to nobody');
check('rated 5 hidden at the most permissive rung', () => {
  assert.equal(isVisibleAtLevel(site(NEVER_LEVEL), MAX_DEVICE_LEVEL), false);
});
check('rated 5 produces no list memberships', () => {
  assert.deepEqual(levelsThatAllow(site(NEVER_LEVEL)), []);
});

console.log('\n3. doorways are gated separately from the rating');
check('a doorway rated 1 is still hidden at level 1', () => {
  assert.equal(isVisibleAtLevel(site(1, true), 1), false);
});
check('a doorway rated 1 is still hidden at level 3', () => {
  assert.equal(isVisibleAtLevel(site(1, true), 3), false);
});
check('a doorway is visible only where doorways are permitted', () => {
  assert.equal(levelDefinition(4).allowDoorways, true);
  assert.equal(isVisibleAtLevel(site(1, true), 4), true);
});
check('a doorway lands only in doorway-permitting lists', () => {
  assert.deepEqual(levelsThatAllow(site(1, true)), [4]);
});
check('a doorway rated 5 is still nowhere', () => {
  assert.deepEqual(levelsThatAllow(site(NEVER_LEVEL, true)), []);
});

console.log('\n4. list membership is cumulative upward');
check('rated 2 belongs to rungs 2, 3 and 4', () => {
  assert.deepEqual(levelsThatAllow(site(2)), [2, 3, 4]);
});
check('rated 4 belongs to rung 4 only', () => {
  assert.deepEqual(levelsThatAllow(site(4)), [4]);
});
check('rated 1 belongs to every rung', () => {
  assert.deepEqual(levelsThatAllow(site(1)), [1, 2, 3, 4]);
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
  assert.equal(normalizeDeviceLevel(2.5), MIN_LEVEL);
});
check('a device level of 5 is not a real rung', () => {
  assert.equal(normalizeDeviceLevel(NEVER_LEVEL), MIN_LEVEL);
});
check('a corrupt site rating clamps to never', () => {
  assert.equal(normalizeSiteLevel('banana'), NEVER_LEVEL);
  assert.equal(normalizeSiteLevel(0), NEVER_LEVEL);
  assert.equal(normalizeSiteLevel(99), NEVER_LEVEL);
});
check('a device level of 5 cannot smuggle a never-rated site through', () => {
  assert.equal(isVisibleAtLevel(site(NEVER_LEVEL), 5), false);
});

console.log('\n6. the ladder itself is well formed');
check('rungs are contiguous from 1 to the maximum device level', () => {
  assert.deepEqual(LEVELS.map((l) => l.level), [1, 2, 3, 4]);
  assert.equal(LEVELS[LEVELS.length - 1].level, MAX_DEVICE_LEVEL);
});
check('only the most permissive rung allows doorways', () => {
  const permitting = LEVELS.filter((l) => l.allowDoorways).map((l) => l.level);
  assert.deepEqual(permitting, [MAX_DEVICE_LEVEL]);
});
check('an unknown rung has no definition', () => {
  assert.equal(levelDefinition(9), null);
});

console.log(`\nAll ${passed} level checks passed.\n`);
