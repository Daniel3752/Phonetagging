// Generates migrations/0012_app_rules_update.sql — the per-rung app matrix.
//
// RECORDS INTENT ONLY. App control is enforced by Headwind, which is not on the phone yet, and the
// per-rung policies (apps_rung_1..5) carry no headwind_configuration_id until re-enrolment. Exact
// package names should be reconciled against the device's installed-apps list in Headwind then —
// several below are best-guess PLACEHOLDERS, marked in their label.
//
// This is the SPECIFIC apps discussed, not a complete launcher allowlist. The full set of permitted
// apps per rung is still to be decided; here we lock the ones talked through so far.
//
// Rung shape, per the operator (this revision):
//   - Rung 3 stays on the ALLOWLIST model: unlisted apps are simply not on the launcher. Its rows
//     below are unchanged from the prior seed.
//   - Rung 4 additionally BLOCKS explicit-content apps AND social-media apps.
//   - Rung 5 BLOCKS explicit-content apps only — social media is allowed there as an app. This
//     reverses the earlier "X blocked on every rung" call: X now follows the same rule as the rest
//     of the social bucket (blocked <=4, allowed at 5).
//
// Run:  node scripts/build-app-rules-seed.mjs

import { writeFileSync } from 'node:fs';

const BLOCKED_ALL = { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'blocked' };
const ALLOWED_ALL = { 1: 'allowed', 2: 'allowed', 3: 'allowed', 4: 'allowed', 5: 'allowed' };
// Social: off through the strict/clean-web rungs, off again at 4 (explicit AND social blocked there),
// back on at 5 (5 blocks explicit only).
const SOCIAL = { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' };
// Explicit/dating: never a native app, at any rung.
const EXPLICIT = BLOCKED_ALL;

// package -> { label, states }. 'allowed' shows on that rung's launcher; 'blocked' is denied there.
const APPS = {
  // --- carried over unchanged from the prior seed ---
  'com.whatsapp':                 { label: 'WhatsApp',  states: { 1: 'blocked', 2: 'allowed', 3: 'allowed', 4: 'allowed', 5: 'allowed' } },
  'com.twentyfoursix.app':        { label: '24Six (CONFIRM package)', states: ALLOWED_ALL },
  'com.spotify.music':            { label: 'Spotify',   states: { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'allowed', 5: 'allowed' } },
  'com.openai.chatgpt':           { label: 'ChatGPT',   states: { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' } },
  'com.anthropic.claude':         { label: 'Claude',    states: { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' } },
  'com.google.android.apps.bard': { label: 'Gemini',    states: { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' } },

  // --- social media: blocked through rung 4, allowed at rung 5 ---
  'com.twitter.android':   { label: 'X (was hard-blocked; now follows the social rule)', states: SOCIAL },
  'com.instagram.android': { label: 'Instagram', states: SOCIAL },
  'com.zhiliaoapp.musically': { label: 'TikTok',   states: SOCIAL },
  'com.snapchat.android':  { label: 'Snapchat',  states: SOCIAL },
  'com.facebook.katana':   { label: 'Facebook',  states: SOCIAL },
  'com.facebook.orca':     { label: 'Messenger', states: SOCIAL },
  'com.reddit.frontpage':  { label: 'Reddit',    states: SOCIAL },
  'com.pinterest':         { label: 'Pinterest', states: SOCIAL },
  'com.tumblr':            { label: 'Tumblr',    states: SOCIAL },
  'com.discord':           { label: 'Discord',   states: SOCIAL },

  // --- explicit-content / dating: blocked at every rung, including 5 ---
  'com.tinder':               { label: 'Tinder (CONFIRM package)',  states: EXPLICIT },
  'com.bumble.app':           { label: 'Bumble (CONFIRM package)',  states: EXPLICIT },
  'co.hinge.app':              { label: 'Hinge (CONFIRM package)',   states: EXPLICIT },
  'com.okcupid.okcupid':      { label: 'OkCupid (CONFIRM package)', states: EXPLICIT },
  'com.grindrapp.android':    { label: 'Grindr (CONFIRM package)',  states: EXPLICIT },

  // --- Israeli / transit / utility apps: allowed everywhere, incl. rung 1 (no-browser) ---
  'com.tranzmate':            { label: 'Moovit',                      states: ALLOWED_ALL },
  'com.waze':                 { label: 'Waze',                        states: ALLOWED_ALL },
  'com.gettaxi.android':      { label: 'Gett (CONFIRM package)',      states: ALLOWED_ALL },
  'com.wolt.android':         { label: 'Wolt (CONFIRM package)',      states: ALLOWED_ALL },
  'com.mysimpleweb.paybox':   { label: 'PayBox (CONFIRM package)',    states: ALLOWED_ALL },
  'com.bank.bit':             { label: 'Bit (CONFIRM package)',       states: ALLOWED_ALL },

  // --- requested one-off ---
  'com.onesecondeveryday.app': { label: '1 Second Everyday (CONFIRM package)', states: ALLOWED_ALL },
};

const rows = [];
for (const [pkg, { states }] of Object.entries(APPS)) {
  for (const rung of [1, 2, 3, 4, 5]) {
    rows.push({ policy: `apps_rung_${rung}`, pkg, state: states[rung] });
  }
}

const values = rows.map((r) => `  ('${r.policy}', '${r.pkg}', '${r.state}')`).join(',\n');
const packages = Object.keys(APPS).map((p) => `'${p}'`).join(',');

const sql = `-- Per-rung app matrix update (intent only; enforced by Headwind after re-enrolment). GENERATED
-- by scripts/build-app-rules-seed.mjs. ${rows.length} rows across the five app policies.
--
-- Rung 3 stays on the allowlist model (unchanged). Rung 4 blocks explicit-content AND social-media
-- apps. Rung 5 blocks explicit-content apps only (social allowed there) — this REVERSES the prior
-- "X blocked on every rung" row: X now follows the same social rule as the rest of that bucket.
-- Several package names are best-guess PLACEHOLDERS (see labels in the generator) and must be
-- reconciled against Headwind's installed-apps list once the device is re-enrolled.
--
-- Re-runnable: clears every row for the packages this seed manages, then reinserts. Does not touch
-- any package this seed does not know about.

DELETE FROM app_rules WHERE package_name IN (${packages});

INSERT INTO app_rules (policy_id, package_name, state)
VALUES
${values};
`;

writeFileSync(new URL('../migrations/0012_app_rules_update.sql', import.meta.url), sql);
console.log(`Wrote migrations/0012_app_rules_update.sql with ${rows.length} rows across ${Object.keys(APPS).length} packages.`);
