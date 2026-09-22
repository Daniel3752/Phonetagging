// Generates migrations/0014_app_rules_bank_apps.sql — the per-rung app matrix.
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
//     below are unchanged from the prior seed, plus the new necessities bucket (see below).
//   - Rung 4 additionally BLOCKS explicit-content apps AND social-media apps.
//   - Rung 5 BLOCKS explicit-content apps only — social media is allowed there as an app, EXCEPT X,
//     which stays blocked at every rung including 5: unlike the rest of the social bucket, X can
//     surface explicit content, so it's grouped with the explicit-content bucket instead.
//   - Rungs 1-3 additionally ALLOW a "necessities" bucket: Torah apps + everyday utility apps
//     (mail, maps, rideshare, banking). No shtus in this bucket by definition — it's the plain
//     necessities, allowed at every rung including rung 1.
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
// Video streaming (Netflix, Disney+, Prime Video, the preinstalled TV apps …) follows the SOCIAL
// shape by the operator's decision: off on every rung until the most open one, where social is
// already permitted. It is a separate constant rather than a reuse of SOCIAL so the two can be
// moved apart later without hunting through the table. MUSIC streaming is deliberately NOT here —
// Spotify keeps its own per-rung states above, and its artwork is refused at the network layer
// instead (src/app-media.js, PROXY.md).
const VIDEO = { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' };
// Music streaming. One rung looser than video: permitted from rung 4, where Spotify already was.
// Spotify and YouTube Music share this constant by the operator's decision ("treat YouTube Music as
// Spotify"), so the two cannot drift apart. NOTE for whoever revisits this: YouTube Music is a
// YouTube client and will play music VIDEO, and its artwork is NOT covered by the Spotify picture
// rules in src/app-media.js — those are anchored to scdn.co / spotifycdn.com.
const MUSIC = { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'allowed', 5: 'allowed' };
// Preinstalled content and extras the phone shipped with: the vendor's feed, games hub, news and
// podcast readers. Same shape as social — clutter and content doorways, not a way round the policy.
// These are SYSTEM apps: Headwind cannot uninstall them, it hides them from the launcher (the
// 'hidden' state in the schema). 'blocked' here is the intent; the agent does the strongest thing
// it can.
const BLOAT = { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' };
// A way AROUND the app policy: a second app store, a sideloader, a device-transfer tool, or an
// assistant that opens the web on its own. Blocked at EVERY rung including the most open one,
// because these do not deliver content — they deliver whatever the policy just refused. The Play
// Store itself is deliberately absent: the blocklist rungs need it (YESHIVA.md).
const BYPASS = BLOCKED_ALL;

// package -> { label, states }. 'allowed' shows on that rung's launcher; 'blocked' is denied there.
const APPS = {
  // --- never blocked, on any rung: the things that enforce the policy ---
  // Rungs 1-3 are ALLOWLIST policies, so an app with no 'allowed' row is hidden — which would take
  // away the agent that applies the rules and the tunnel that filters. These were missing here
  // while the standard policies carry no headwind_configuration_id; they are listed now so the
  // first re-enrolment cannot hide them. The companion also has a row from migration 0021.
  'com.hmdm.launcher':        { label: 'Headwind agent (management — never block)', states: ALLOWED_ALL },
  'com.wireguard.android':    { label: 'WireGuard (the filter tunnel — never block)', states: ALLOWED_ALL },
  'com.getshmira.companion':  { label: 'Shmira companion (install watchdog + WhatsApp Updates guard — never block)', states: ALLOWED_ALL },

  // --- carried over unchanged from the prior seed ---
  'com.whatsapp':                 { label: 'WhatsApp',  states: { 1: 'blocked', 2: 'allowed', 3: 'allowed', 4: 'allowed', 5: 'allowed' } },
  'com.twentyfoursix.app':        { label: '24Six (CONFIRM package)', states: ALLOWED_ALL },
  'com.spotify.music':            { label: 'Spotify',   states: MUSIC },
  'com.google.android.apps.youtube.music': { label: 'YouTube Music (preinstalled) — treated as Spotify', states: MUSIC },
  'com.openai.chatgpt':           { label: 'ChatGPT',   states: { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' } },
  'com.anthropic.claude':         { label: 'Claude',    states: { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' } },
  'com.google.android.apps.bard': { label: 'Gemini',    states: { 1: 'blocked', 2: 'blocked', 3: 'blocked', 4: 'blocked', 5: 'allowed' } },

  // --- social media: blocked through rung 4, allowed at rung 5 ---
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
  // X can surface explicit content even though it reads as "social" — blocked everywhere, not
  // following the social bucket's rung-5 opening.
  'com.twitter.android':      { label: 'X (blocked every rung, incl. 5 — can show explicit content)', states: EXPLICIT },
  'com.tinder':               { label: 'Tinder (CONFIRM package)',  states: EXPLICIT },
  'com.bumble.app':           { label: 'Bumble (CONFIRM package)',  states: EXPLICIT },
  'co.hinge.app':              { label: 'Hinge (CONFIRM package)',   states: EXPLICIT },
  'com.okcupid.okcupid':      { label: 'OkCupid (CONFIRM package)', states: EXPLICIT },
  'com.grindrapp.android':    { label: 'Grindr (CONFIRM package)',  states: EXPLICIT },

  // --- video streaming: blocked through rung 4, allowed at rung 5 (the SOCIAL shape) ---
  // Rungs 1-3 are allowlist policies, so an unlisted app is already absent there; these rows exist
  // for rung 4, which is allow-by-default and would otherwise let every one of them install.
  'com.netflix.mediaclient':              { label: 'Netflix',                         states: VIDEO },
  'com.netflix.NGPClient':                { label: 'Netflix (preinstalled partner stub)', states: VIDEO },
  'com.disney.disneyplus':                { label: 'Disney+',                         states: VIDEO },
  'com.amazon.avod.thirdpartyclient':     { label: 'Prime Video',                     states: VIDEO },
  'com.google.android.videos':            { label: 'Google TV / Play Movies (preinstalled)', states: VIDEO },
  'com.samsung.android.tvplus':           { label: 'Samsung TV Plus (preinstalled free live TV)', states: VIDEO },
  'tv.twitch.android.app':                { label: 'Twitch',                          states: VIDEO },
  'com.hulu.plus':                        { label: 'Hulu',                            states: VIDEO },
  'com.plexapp.android':                  { label: 'Plex',                            states: VIDEO },
  'com.mxtech.videoplayer.ad':            { label: 'MX Player',                       states: VIDEO },
  'com.mxtech.videoplayer.pro':           { label: 'MX Player Pro',                   states: VIDEO },
  'org.videolan.vlc':                     { label: 'VLC (plays network streams)',     states: VIDEO },
  'com.wbd.stream':                       { label: 'Max / HBO (CONFIRM package)',     states: VIDEO },
  'com.apple.atve.android.appletv':       { label: 'Apple TV (CONFIRM package)',      states: VIDEO },
  'com.peacocktv.peacockandroid':         { label: 'Peacock (CONFIRM package)',       states: VIDEO },
  'com.paramount.android.pplus':          { label: 'Paramount+ (CONFIRM package)',    states: VIDEO },
  'com.crunchyroll.crunchyroid':          { label: 'Crunchyroll (CONFIRM package)',   states: VIDEO },
  'com.viki.android':                     { label: 'Viki (CONFIRM package)',          states: VIDEO },
  'com.rakuten.tv.android':               { label: 'Rakuten TV (CONFIRM package)',    states: VIDEO },
  // Israeli services. Every package here is a best guess and MUST be reconciled against Headwind's
  // installed-apps list — on a blocklist rung a wrong name is a silent hole, not a harmless no-op.
  'il.co.mako.mako':                      { label: 'Mako / Keshet 12 (CONFIRM package)', states: VIDEO },
  'com.reshet.tv':                        { label: 'Reshet 13 (CONFIRM package)',     states: VIDEO },
  'com.kan.kanapp':                       { label: 'Kan 11 (CONFIRM package)',        states: VIDEO },
  'com.hot.hotplus':                      { label: 'HOT (CONFIRM package)',           states: VIDEO },
  'com.partner.tv':                       { label: 'Partner TV (CONFIRM package)',    states: VIDEO },
  'com.sting.tv':                         { label: 'STINGTV (CONFIRM package)',       states: VIDEO },
  'com.yes.yesplus':                      { label: 'Yes+ (CONFIRM package)',          states: VIDEO },
  'com.cellcom.tv':                       { label: 'Cellcom TV (CONFIRM package)',    states: VIDEO },

  // --- a way round the app policy: blocked at EVERY rung, including 5 ---
  'com.sec.android.app.samsungapps':      { label: 'Galaxy Store (a SECOND app store — installs what the policy refused)', states: BYPASS },
  'org.fdroid.fdroid':                    { label: 'F-Droid (alternative store)',     states: BYPASS },
  'com.amazon.venezia':                   { label: 'Amazon Appstore',                 states: BYPASS },
  'com.huawei.appmarket':                 { label: 'Huawei AppGallery',               states: BYPASS },
  'com.xiaomi.market':                    { label: 'Xiaomi GetApps (CONFIRM package)', states: BYPASS },
  'com.aurora.store':                     { label: 'Aurora Store (anonymous Play client, CONFIRM package)', states: BYPASS },
  'com.apkpure.aegon':                    { label: 'APKPure (CONFIRM package)',       states: BYPASS },
  'cm.aptoide.pt':                        { label: 'Aptoide (CONFIRM package)',       states: BYPASS },
  'com.sec.android.easyMover':            { label: 'Smart Switch (copies apps from another phone)', states: BYPASS },
  'com.samsung.android.smartswitchassistant': { label: 'Smart Switch Assistant',      states: BYPASS },
  'com.samsung.android.bixby.agent':      { label: 'Bixby (assistant — opens the web on its own)', states: BYPASS },
  'com.samsung.android.visionintelligence':{ label: 'Bixby Vision',                   states: BYPASS },
  'com.samsung.android.bixby.wakeup':     { label: 'Bixby wakeup',                    states: BYPASS },
  'com.samsung.android.app.settings.bixby':{ label: 'Bixby settings',                 states: BYPASS },
  'com.google.android.googlequicksearchbox':{ label: 'Google app (Discover/Lens ride the googleapis exemption)', states: BYPASS },
  'com.google.android.apps.searchlite':   { label: 'Google Go (CONFIRM package)',     states: BYPASS },
  // Preinstalled Facebook stubs on Samsung: dormant, but they can pull the full app down.
  'com.facebook.system':                  { label: 'Facebook App Installer (preinstalled stub)', states: BYPASS },
  'com.facebook.appmanager':              { label: 'Facebook App Manager (preinstalled stub)',   states: BYPASS },
  'com.facebook.services':                { label: 'Facebook Services (preinstalled stub)',      states: BYPASS },

  // --- preinstalled content and extras: the SOCIAL shape (system apps, so hidden not removed) ---
  'com.samsung.android.app.spage':        { label: 'Samsung Free / Daily (content feed)', states: BLOAT },
  'com.samsung.android.game.gamehome':    { label: 'Game Launcher',                   states: BLOAT },
  'com.samsung.android.game.gametools':   { label: 'Game Booster',                    states: BLOAT },
  'com.google.android.play.games':        { label: 'Play Games',                      states: BLOAT },
  'com.google.android.apps.magazines':    { label: 'Google News',                     states: BLOAT },
  'com.google.android.apps.podcasts':     { label: 'Google Podcasts',                 states: BLOAT },
  'com.samsung.android.voc':              { label: 'Samsung Members',                 states: BLOAT },
  'com.samsung.android.arzone':           { label: 'AR Zone',                         states: BLOAT },
  'com.samsung.android.app.tips':         { label: 'Samsung Tips',                    states: BLOAT },
  'com.samsung.android.themestore':       { label: 'Galaxy Themes (CONFIRM package)', states: BLOAT },

  // --- Israeli / transit / utility apps: allowed everywhere, incl. rung 1 (no-browser) ---
  'com.tranzmate':            { label: 'Moovit',                      states: ALLOWED_ALL },
  'com.waze':                 { label: 'Waze',                        states: ALLOWED_ALL },
  'com.gettaxi.android':      { label: 'Gett (CONFIRM package)',      states: ALLOWED_ALL },
  'com.wolt.android':         { label: 'Wolt (CONFIRM package)',      states: ALLOWED_ALL },
  'com.mysimpleweb.paybox':   { label: 'PayBox (CONFIRM package)',    states: ALLOWED_ALL },
  'com.bank.bit':             { label: 'Bit (CONFIRM package)',       states: ALLOWED_ALL },

  // --- requested one-off ---
  'com.onesecondeveryday.app': { label: '1 Second Everyday (CONFIRM package)', states: ALLOWED_ALL },

  // --- necessities: Torah apps + everyday utilities, allowed at every rung incl. rung 1. Package
  // names are best-guess PLACEHOLDERS — confirm against the device's real installed-apps list. ---
  'org.sefaria.sefaria':         { label: 'Sefaria (Torah study, CONFIRM package)', states: ALLOWED_ALL },
  'com.chabad.app':              { label: 'Chabad.org (Torah content, CONFIRM package)', states: ALLOWED_ALL },
  'com.google.android.gm':       { label: 'Gmail (CONFIRM package)', states: ALLOWED_ALL },
  'com.google.android.apps.maps':{ label: 'Google Maps (CONFIRM package)', states: ALLOWED_ALL },
  'com.ubercab':                 { label: 'Uber (CONFIRM package)', states: ALLOWED_ALL },
  'com.lyft.android':            { label: 'Lyft (CONFIRM package)', states: ALLOWED_ALL },

  // --- bank apps: allowed at every rung incl. rung 1. Major Israeli retail banks; package names
  // are best-guess PLACEHOLDERS — confirm against the device's real installed-apps list. ---
  'com.ideomobile.hapoalim':      { label: 'Bank Hapoalim (CONFIRM package)', states: ALLOWED_ALL },
  'com.ideomobile.leumi':         { label: 'Bank Leumi (CONFIRM package)', states: ALLOWED_ALL },
  'com.discountbank.mobile':      { label: 'Israel Discount Bank (CONFIRM package)', states: ALLOWED_ALL },
  'com.mizrahitefahot.mobile':    { label: 'Mizrahi-Tefahot Bank (CONFIRM package)', states: ALLOWED_ALL },
  'com.fibi.bank':                { label: 'FIBI / Bank Hapoalim intl (CONFIRM package)', states: ALLOWED_ALL },
};

const rows = [];
for (const [pkg, { states }] of Object.entries(APPS)) {
  for (const rung of [1, 2, 3, 4, 5]) {
    rows.push({ policy: `apps_rung_${rung}`, pkg, state: states[rung] });
  }
}

const values = rows.map((r) => `  ('${r.policy}', '${r.pkg}', '${r.state}')`).join(',\n');
const packages = Object.keys(APPS).map((p) => `'${p}'`).join(',');
// The five standard policies. The refresh below must scope its DELETE to these: several of
// these packages (WhatsApp, the banks, the social and explicit buckets, and now the streaming
// and preinstalled ones) ALSO carry rows on the yeshiva policies, and an unscoped
// `DELETE ... WHERE package_name IN (...)` would strip them there and never put them back.
const standardPolicies = [1, 2, 3, 4, 5].map((r) => `'apps_rung_${r}'`).join(', ');

const sql = `-- Per-rung app matrix update (intent only; enforced by Headwind after re-enrolment). GENERATED
-- by scripts/build-app-rules-seed.mjs. ${rows.length} rows across the five app policies.
--
-- Rung 3 stays on the allowlist model (unchanged), plus the new necessities bucket. Rung 4 blocks
-- explicit-content AND social-media apps. Rung 5 blocks explicit-content apps only (social allowed
-- there) EXCEPT X, which stays blocked at every rung including 5 since it can surface explicit
-- content. Rungs 1-3 additionally allow a necessities bucket: Torah apps + everyday utilities
-- (mail, maps, rideshare), allowed at every rung including 1.
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

writeFileSync(new URL('../migrations/0014_app_rules_bank_apps.sql', import.meta.url), sql);

// 0014 is already applied on the live database, and a migration never runs twice — so regenerating
// it above keeps the file honest but changes nothing on the fleet. The SAME rules block is written
// again here, as its own re-runnable migration, so an addition actually reaches the phones. This
// replaces the hand-copy step the 0019 header describes; the two files cannot drift because one
// run writes both.
const refresh = `-- Standard-ladder app rules, refreshed: video streaming and the preinstalled sweep.
-- GENERATED by scripts/build-app-rules-seed.mjs — edit that, not this. 0014 carries the same rows
-- but is already applied, so the additions travel in this migration instead.
--
-- What is new (2026-09-22):
--   * VIDEO STREAMING — Netflix, Disney+, Prime Video, Google TV, YouTube Music, Samsung TV Plus,
--     Twitch, Plex, MX Player, VLC and the Israeli services. Blocked on rungs 1-4, allowed at rung
--     5, the same shape as the social bucket. Music streaming is NOT included: Spotify keeps its
--     own per-rung states and its artwork is refused at the network layer instead.
--   * BYPASS — a second app store or sideloader (Galaxy Store, F-Droid, Amazon Appstore, Aurora,
--     APKPure, Aptoide), Smart Switch, Bixby, the Google app, and Samsung's dormant Facebook
--     installer stubs. Blocked at EVERY rung including 5: these deliver whatever the policy just
--     refused, so the most open rung is exactly where they matter most. The Play Store is
--     deliberately not here — the blocklist rungs need it.
--   * PREINSTALLED CONTENT — Samsung Free/Daily, Game Launcher, Play Games, Google News and
--     Podcasts, Samsung Members, AR Zone, Tips, Galaxy Themes. Social shape.
--
-- These matter because rungs 4 and 5 are BLOCKLIST policies (app_default 'allowed'): anything with
-- no row here installs and runs. Rungs 1-3 are allowlists and were already covered by omission.
--
-- A package name that is wrong is NOT harmless on a blocklist rung — it is a silent hole, the app
-- simply stays allowed. Every entry labelled CONFIRM in the generator must be reconciled against
-- Headwind's installed-apps list for a real handset before this is trusted.
--
-- Re-runnable: clears every row for the packages this seed manages, then reinserts.

DELETE FROM app_rules
 WHERE policy_id IN (${standardPolicies})
   AND package_name IN (${packages});

INSERT INTO app_rules (policy_id, package_name, state)
VALUES
${values};
`;
writeFileSync(new URL('../migrations/0022_streaming_and_preinstalled.sql', import.meta.url), refresh);

console.log(`Wrote migrations/0014_app_rules_bank_apps.sql and migrations/0022_streaming_and_preinstalled.sql with ${rows.length} rows across ${Object.keys(APPS).length} packages.`);
