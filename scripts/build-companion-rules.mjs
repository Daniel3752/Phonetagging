// Writes the companion app's built-in copy of the guard rules from the Worker's constant, so the two
// cannot drift: the APK ships companion/app/src/main/res/raw/guard_rules.json, the Worker serves the
// same object from /api/companion/policy, and test/companion.test.mjs fails if the file is stale.
//
//   node scripts/build-companion-rules.mjs        (then rebuild the APK)
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { COMPANION_RULES, COMPANION_RULES_VERSION } from '../src/companion-rules.js';

const out = new URL('../companion/app/src/main/res/raw/guard_rules.json', import.meta.url);
// A phone replaces its cached rules only for a HIGHER rules_version, so changed rules with the
// same version would never reach a phone that already holds the old set. Refuse to write that.
if (existsSync(out)) {
  const prev = JSON.parse(readFileSync(out, 'utf8'));
  const changed = JSON.stringify(prev.rules) !== JSON.stringify(COMPANION_RULES);
  if (changed && !(COMPANION_RULES_VERSION > prev.rules_version)) {
    throw new Error(`the rules changed but COMPANION_RULES_VERSION (${COMPANION_RULES_VERSION}) is not above the committed ${prev.rules_version}; bump it in src/companion-rules.js`);
  }
}
writeFileSync(out, JSON.stringify({ rules_version: COMPANION_RULES_VERSION, rules: COMPANION_RULES }, null, 2) + '\n');
console.log(`wrote ${out.pathname} (rules_version ${COMPANION_RULES_VERSION})`);
