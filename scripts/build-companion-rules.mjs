// Writes the companion app's built-in copy of the guard rules from the Worker's constant, so the two
// cannot drift: the APK ships companion/app/src/main/res/raw/guard_rules.json, the Worker serves the
// same object from /api/companion/policy, and test/companion.test.mjs fails if the file is stale.
//
//   node scripts/build-companion-rules.mjs        (then rebuild the APK)
import { writeFileSync } from 'node:fs';
import { COMPANION_RULES, COMPANION_RULES_VERSION } from '../src/companion-rules.js';

const out = new URL('../companion/app/src/main/res/raw/guard_rules.json', import.meta.url);
writeFileSync(out, JSON.stringify({ rules_version: COMPANION_RULES_VERSION, rules: COMPANION_RULES }, null, 2) + '\n');
console.log(`wrote ${out.pathname} (rules_version ${COMPANION_RULES_VERSION})`);
