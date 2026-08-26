// Offline tests for the keyword pre-filter. Pure logic, no D1 — the rules are passed in. Run with:
// npm test
//
// The point of this module is to shed load from the model without changing the ladder's meaning, so
// the checks pin: an empty ruleset never decides (everything falls through to the model), the
// strictest matching rule wins, and multi-word rules are all-of rather than any-of.

import assert from 'node:assert';
import { keywordRating, queryTokens, KEYWORD_NEVER } from '../src/keywords.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

console.log('\n1. no rules means no decision — the model is always asked');
check('empty ruleset returns null for any query', () => {
  assert.equal(keywordRating('anything at all', []), null);
  assert.equal(keywordRating('swimwear', undefined), null);
});

console.log('\n2. a matching rule rates the query');
const rules = [
  { pattern: 'recipe', rating: 1, note: 'benign' },
  { pattern: 'swimwear', rating: 4, note: 'immodest' },
  { pattern: 'explicit term', rating: KEYWORD_NEVER, note: 'never' },
];
check('a benign term rates low', () => {
  assert.equal(keywordRating('chicken recipe', rules).rating, 1);
});
check('an immodest term rates 4', () => {
  assert.equal(keywordRating('womens swimwear sale', rules).rating, 4);
});
check('order and punctuation do not matter', () => {
  assert.equal(keywordRating('SALE, Swimwear!', rules).rating, 4);
});

console.log('\n3. the strictest matching rule wins');
check('a query tripping benign and strict rules is treated as strict', () => {
  assert.equal(keywordRating('recipe swimwear', rules).rating, 4);
});

console.log('\n4. multi-word rules are all-of, not any-of');
check('a multi-word rule does not fire on one incidental word', () => {
  assert.equal(keywordRating('explicit', rules), null); // needs both "explicit" AND "term"
});
check('a multi-word rule fires when all words are present', () => {
  assert.equal(keywordRating('some explicit term here', rules).rating, KEYWORD_NEVER);
});

console.log('\n5. tokenisation');
check('an empty query has no tokens and never matches', () => {
  assert.equal(queryTokens('   ').size, 0);
  assert.equal(keywordRating('   ', rules), null);
});

console.log(`\nAll ${passed} keyword checks passed.\n`);
