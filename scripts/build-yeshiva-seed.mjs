// Generates migrations/0016_yeshiva_tag.sql — the yeshiva temp tag: its four app policies, the
// shiur lock policy, their app rules, and the Sunday–Thursday shiur windows. See YESHIVA.md.
//
// RECORDS INTENT for the app side: Headwind enforces app rules, and it only will once the yeshiva
// policies carry a headwind_configuration_id (set in /admin → Policies after the configurations
// are created in the panel). The WEB side and the shiur lock's web part are enforced by the proxy
// the moment a device is put on the tag. Package names for the stock phone apps are listed for the
// three flavours in the fleet (Google/AOSP, Samsung); a wrong one is harmless on an allowlist
// (nothing to allow) and should be reconciled against Headwind's installed-apps list.
//
// Run:  node scripts/build-yeshiva-seed.mjs

import { writeFileSync } from 'node:fs';

// --- buckets ---------------------------------------------------------------------------------

// What must keep working in shiur: reachability and the management apps. This is the whole
// yeshiva_shiur allowlist, and the core of rung 1's.
const ESSENTIALS = {
  'com.whatsapp': 'WhatsApp',
  'com.whatsapp.w4b': 'WhatsApp Business',
  'com.google.android.dialer': 'Phone (Google)',
  'com.android.dialer': 'Phone (AOSP)',
  'com.samsung.android.dialer': 'Phone (Samsung)',
  'com.google.android.contacts': 'Contacts (Google)',
  'com.android.contacts': 'Contacts (AOSP)',
  'com.samsung.android.app.contacts': 'Contacts (Samsung)',
  'com.google.android.apps.messaging': 'Messages (Google)',
  'com.android.mms': 'Messages (AOSP)',
  'com.samsung.android.messaging': 'Messages (Samsung)',
  'com.google.android.deskclock': 'Clock (Google)',
  'com.android.deskclock': 'Clock (AOSP)',
  'com.sec.android.app.clockpackage': 'Clock (Samsung)',
  'com.android.settings': 'Settings',
  // Never block these: the agent is what enforces everything, the tunnel is what filters.
  'com.hmdm.launcher': 'Headwind agent (management — never block)',
  'com.wireguard.android': 'WireGuard (the filter tunnel — never block)',
};

// Rung 1 adds the everyday necessities: the same bucket the standard ladder allows at every rung
// (Torah, transit, banking, maps, mail), plus camera and calculator.
const NECESSITIES = {
  'com.google.android.calculator': 'Calculator (Google)',
  'com.sec.android.app.calculator': 'Calculator (Samsung)',
  'com.google.android.calendar': 'Calendar',
  'com.google.android.GoogleCamera': 'Camera (Google)',
  'com.android.camera2': 'Camera (AOSP)',
  'com.sec.android.app.camera': 'Camera (Samsung)',
  'com.google.android.apps.photos': 'Google Photos',
  'com.sec.android.gallery3d': 'Gallery (Samsung)',
  'org.sefaria.sefaria': 'Sefaria',
  'com.chabad.app': 'Chabad.org (CONFIRM package)',
  'org.chabad.chabadapp': 'Chabad.org (alternate package)',
  'com.twentyfoursix.app': '24Six (CONFIRM package)',
  'com.twentyfoursix.android': '24Six (alternate package)',
  'com.rustybrick.siddur': 'Siddur (RustyBrick)',
  'com.rustybrick.zmanim': 'Zmanim (RustyBrick)',
  'com.tehillim': 'Tehillim (CONFIRM package)',
  'com.artscroll.digitallibrary': 'ArtScroll Digital Library',
  'com.alhatorah.dicta': 'Dicta (CONFIRM package)',
  'com.google.android.apps.translate': 'Google Translate',
  'com.google.android.apps.docs': 'Google Drive',
  'com.google.android.keep': 'Google Keep',
  'com.google.android.gm': 'Gmail',
  'com.google.android.apps.maps': 'Google Maps',
  'com.waze': 'Waze',
  'com.tranzmate': 'Moovit',
  'com.gettaxi.android': 'Gett (CONFIRM package)',
  'com.ubercab': 'Uber',
  'com.lyft.android': 'Lyft',
  'com.wolt.android': 'Wolt (CONFIRM package)',
  'com.mysimpleweb.paybox': 'PayBox (CONFIRM package)',
  'com.payboxapp': 'PayBox (alternate package)',
  'com.bank.bit': 'Bit (CONFIRM package)',
  'com.bnhp.payments.paymentsapp': 'Bit by Hapoalim (alternate package)',
  'com.ideomobile.hapoalim': 'Bank Hapoalim',
  'com.ideomobile.leumi': 'Bank Leumi (CONFIRM package)',
  'com.leumi.leumiwallet': 'Leumi (alternate package)',
  'com.discountbank.mobile': 'Israel Discount Bank (CONFIRM package)',
  'com.ideomobile.discount': 'Discount (alternate package)',
  'com.mizrahitefahot.mobile': 'Mizrahi-Tefahot Bank (CONFIRM package)',
  'com.ideomobile.mizrahi': 'Mizrahi (alternate package)',
  'com.fibi.bank': 'FIBI (CONFIRM package)',
  'com.fibi.nativeapp': 'FIBI (alternate package)',
  'com.pepper.app': 'Pepper (CONFIRM package)',
  'com.isracard.app': 'Isracard (CONFIRM package)',
  'com.onezero.app': 'One Zero (CONFIRM package)',
  'com.cal.mobile': 'Cal (CONFIRM package)',
  'com.max.mobile': 'Max (CONFIRM package)',
  'com.rav_kav': 'Rav-Kav (CONFIRM package)',
  'il.co.hopon': 'HopOn (CONFIRM package)',
  'com.pango.pango': 'Pango (CONFIRM package)',
  'com.cellopark.android': 'Cellopark (CONFIRM package)',
  'com.google.android.apps.walletnfcrel': 'Google Wallet',
};

// The one browser. "One type": every other browser is on the blocklist at every rung, because a
// browser that does not trust the filter's certificate (Firefox, Samsung Internet) shows errors
// on every decrypted site and confuses the boy into thinking the phone is broken.
const BROWSER = { 'com.android.chrome': 'Chrome' };

const SOCIAL = {
  'com.instagram.android': 'Instagram',
  'com.instagram.barcelona': 'Threads',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.zhiliaoapp.musically.go': 'TikTok Lite',
  'com.ss.android.ugc.trill': 'TikTok (Asia build)',
  'com.instagram.lite': 'Instagram Lite',
  'com.facebook.lite': 'Facebook Lite',
  'com.facebook.mlite': 'Messenger Lite',
  'com.bereal.ft': 'BeReal',
  'com.linkedin.android': 'LinkedIn',
  'com.vkontakte.android': 'VK',
  'com.google.android.youtube.tv': 'YouTube (TV build)',
  'com.google.android.apps.youtube.kids': 'YouTube Kids',
  'app.revanced.android.youtube': 'YouTube (ReVanced)',
  'com.vanced.android.youtube': 'YouTube (Vanced)',
  'com.snapchat.android': 'Snapchat',
  'com.facebook.katana': 'Facebook',
  'com.facebook.orca': 'Messenger',
  'com.reddit.frontpage': 'Reddit',
  'com.pinterest': 'Pinterest',
  'com.tumblr': 'Tumblr',
  'com.discord': 'Discord',
  'com.google.android.youtube': 'YouTube',
  'tv.twitch.android.app': 'Twitch',
};

// Blocked at every yeshiva rung: explicit-capable and dating apps, plus X and Telegram (both can
// surface explicit content, so they follow this bucket rather than the social one).
const EXPLICIT = {
  'com.twitter.android': 'X',
  'org.telegram.messenger': 'Telegram',
  'com.tinder': 'Tinder',
  'com.bumble.app': 'Bumble',
  'co.hinge.app': 'Hinge',
  'com.okcupid.okcupid': 'OkCupid',
  'com.grindrapp.android': 'Grindr',
  'com.badoo.mobile': 'Badoo',
  'com.jaumo': 'Jaumo',
  'com.coffeemeetsbagel': 'Coffee Meets Bagel',
  'com.pof.android': 'Plenty of Fish',
  'com.match.android.matchmobile': 'Match',
  'org.thunderdog.challegram': 'Telegram X',
  'org.telegram.plus': 'Plus Messenger (Telegram fork)',
  'nekox.messenger': 'Nekogram (Telegram fork)',
  'com.omgs.omegle': 'Omegle-style chat (CONFIRM package)',
  'com.reddit.frontpage.beta': 'Reddit (beta)',
};

const OTHER_BROWSERS = {
  'com.sec.android.app.sbrowser': 'Samsung Internet',
  'org.mozilla.firefox': 'Firefox',
  'org.mozilla.focus': 'Firefox Focus',
  'com.opera.browser': 'Opera',
  'com.opera.mini.native': 'Opera Mini',
  'com.brave.browser': 'Brave',
  'com.microsoft.emmx': 'Edge',
  'com.duckduckgo.mobile.android': 'DuckDuckGo',
  'com.UCMobile.intl': 'UC Browser',
  'com.kiwibrowser.browser': 'Kiwi',
  'com.vivaldi.browser': 'Vivaldi',
  'com.android.browser': 'AOSP Browser',
  'com.mi.globalbrowser': 'Mi Browser',
  'com.huawei.browser': 'Huawei Browser',
  'com.chrome.beta': 'Chrome Beta (no managed proxy — bypasses the browser port)',
  'com.chrome.dev': 'Chrome Dev (no managed proxy)',
  'com.chrome.canary': 'Chrome Canary (no managed proxy)',
  'com.google.android.googlequicksearchbox': 'Google app (Discover/Lens ride the googleapis exemption)',
  'com.microsoft.bing': 'Bing',
  'com.yandex.browser': 'Yandex Browser',
  'com.sec.android.app.sbrowser.beta': 'Samsung Internet Beta',
  'com.cloudmosa.puffinFree': 'Puffin',
  'com.aloha.browser': 'Aloha',
  'acr.browser.lightning': 'Lightning',
  'mark.via.gp': 'Via',
  'com.ecosia.android': 'Ecosia',
  'org.chromium.chrome': 'Chromium',
  'com.android.htmlviewer': 'HTML Viewer (system; harmless but listed for completeness)',
};

// VPNs and other ways round the tunnel. no_config_vpn is the real defence; this is belt and braces.
const CIRCUMVENTION = {
  'com.nordvpn.android': 'NordVPN',
  'com.expressvpn.vpn': 'ExpressVPN',
  'com.surfshark.vpnclient.android': 'Surfshark',
  'ch.protonvpn.android': 'Proton VPN',
  'hotspotshield.android.vpn': 'Hotspot Shield',
  'com.psiphon3': 'Psiphon',
  'org.torproject.torbrowser': 'Tor Browser',
  'org.torproject.android': 'Orbot',
  'free.vpn.unblock.proxy.turbovpn': 'Turbo VPN',
  'com.cloudflare.onedotonedotonedotone': '1.1.1.1 (WARP)',
  'com.tunnelbear.android': 'TunnelBear',
  'com.privateinternetaccess.android': 'Private Internet Access',
  'com.windscribe.vpn': 'Windscribe',
  'net.openvpn.openvpn': 'OpenVPN Connect',
  'de.blinkt.openvpn': 'OpenVPN for Android',
  'com.v2ray.ang': 'v2rayNG',
  'com.github.shadowsocks': 'Shadowsocks',
  'org.outline.android.client': 'Outline',
  'com.kaspersky.secure.connection': 'Kaspersky VPN',
  'com.avast.android.vpn': 'Avast SecureLine',
  'com.zenmate.android': 'ZenMate',
  'com.cyberghost.android': 'CyberGhost',
  'com.ivpn.client': 'IVPN',
  'com.mullvad.mullvadvpn': 'Mullvad',
  'com.frostnerd.dnschanger': 'DNS Changer',
  'app.intra': 'Intra (DNS-over-HTTPS)',
  'com.nextdns.nextdns': 'NextDNS',
  'org.adaway': 'AdAway (hosts editor)',
  'com.jrummyapps.android.hosts.editor': 'Hosts Editor',
  'com.termux': 'Termux (shell)',
};

// --- policies ----------------------------------------------------------------------------------

// app_default is what the policy says about an app it has NO row for: 'blocked' makes it an
// allowlist, 'allowed' a blocklist. web_mode 'none' on a policy switches the browser off while it
// is the one in force — the shiur lock — whatever the phone's rung says.
const POLICIES = [
  { id: 'yeshiva_rung_1', name: 'Yeshiva — Rung 1 (Apps only)',            app_default: 'blocked', web_mode: null,
    allowed: { ...ESSENTIALS, ...NECESSITIES }, blocked: {} },
  { id: 'yeshiva_rung_2', name: 'Yeshiva — Rung 2 (Apps + browser)',       app_default: 'blocked', web_mode: null,
    allowed: { ...ESSENTIALS, ...NECESSITIES, ...BROWSER }, blocked: {} },
  { id: 'yeshiva_rung_3', name: 'Yeshiva — Rung 3 (Blocklist, no social)', app_default: 'allowed', web_mode: null,
    allowed: {}, blocked: { ...SOCIAL, ...EXPLICIT, ...OTHER_BROWSERS, ...CIRCUMVENTION } },
  { id: 'yeshiva_rung_4', name: 'Yeshiva — Rung 4 (Blocklist)',            app_default: 'allowed', web_mode: null,
    allowed: {}, blocked: { ...EXPLICIT, ...OTHER_BROWSERS, ...CIRCUMVENTION } },
  // In shiur: only what is needed to be reachable. No browser (web_mode none), no Torah apps
  // either — the point is the phone is not a thing to look at during seder.
  { id: 'yeshiva_shiur',  name: 'Yeshiva — Shiur (locked to essentials)',   app_default: 'blocked', web_mode: 'none',
    allowed: ESSENTIALS, blocked: {} },
];

// --- the shiur windows (Sunday–Thursday) ----------------------------------------------------
//
// Derived from the yeshiva timetable; breaks (breakfast, lunch, dinner) are the gaps. Each window
// takes the EARLIER of a "9:15/9:30"-style start and runs through consecutive sedarim/tefillos —
// a phone locked fifteen minutes early is a non-event, a phone unlocked fifteen minutes into seder
// is the thing this exists to stop. Selichos (12:45–13:30) is seasonal and folded into the second
// window; shorten that window to 13:45 → 12:45 + a 13:30–13:45 mincha window when the season ends,
// or leave it — it only spans lunch's first minutes either way.
//
//   07:30–08:35  Shachris (korbanos)                              → breakfast
//   09:15–13:45  First seder (hachana, then shiur), selichos, mincha → lunch
//   15:35–19:15  Second seder (daf 15:35 / amud 16:15), bekius review, halacha + mussar → dinner
//   20:15–22:00  Maariv, night seder
//
// A boy in the amud class (second seder from 16:15) gets a device-specific window 15:35–16:15
// back to his own rung's policy at a higher priority — see YESHIVA.md.
const SUN_TO_THU = 1 | 2 | 4 | 8 | 16;
const min = (h, m) => h * 60 + m;
const WINDOWS = [
  { id: 'shiur_shachris',  start: min(7, 30),  end: min(8, 35),  note: 'Shachris' },
  { id: 'shiur_morning',   start: min(9, 15),  end: min(13, 45), note: 'First seder, selichos, mincha' },
  { id: 'shiur_afternoon', start: min(15, 35), end: min(19, 15), note: 'Second seder, bekius, halacha + mussar' },
  { id: 'shiur_night',     start: min(20, 15), end: min(22, 0),  note: 'Maariv, night seder' },
];
const SHIUR_PRIORITY = 100;

// --- emit --------------------------------------------------------------------------------------

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ruleRows = [];
for (const p of POLICIES) {
  for (const pkg of Object.keys(p.allowed)) ruleRows.push(`  (${q(p.id)}, ${q(pkg)}, 'allowed')`);
  for (const pkg of Object.keys(p.blocked)) ruleRows.push(`  (${q(p.id)}, ${q(pkg)}, 'blocked')`);
}
const policyRows = POLICIES.map((p) =>
  `  (${q(p.id)}, ${q(p.name)}, NULL, ${q(p.app_default)}, ${p.web_mode ? q(p.web_mode) : 'NULL'}, unixepoch() * 1000)`);
const scheduleRows = WINDOWS.map((w) =>
  `  (${q(w.id)}, NULL, 'tag:yeshiva', 'yeshiva_shiur', ${SUN_TO_THU}, ${w.start}, ${w.end}, ${SHIUR_PRIORITY}, unixepoch() * 1000)`);

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const windowDoc = WINDOWS.map((w) => `--   ${fmt(w.start)}–${fmt(w.end)}  ${w.note}`).join('\n');

const sql = `-- The yeshiva temp tag. GENERATED by scripts/build-yeshiva-seed.mjs — edit that, not this.
-- See YESHIVA.md for what the tag is and how it is meant to be used.
--
-- Three schema additions (NOT re-runnable — SQLite has no ADD COLUMN IF NOT EXISTS; apply once
-- through \`npm run db:migrate\`, never by hand):
--   devices.tag          which ladder the phone is on: 'standard' (the five rungs) or 'yeshiva'.
--   policies.app_default what the policy says about an app it has no rule for — 'blocked' makes
--                        the policy an ALLOWLIST, 'allowed' a BLOCKLIST. Set for the existing
--                        standard policies too, matching their documented intent (rungs 1-3
--                        allowlist, 4-5 blocklist).
--   policies.web_mode    NULL = the phone's rung decides the browser; 'none' = no web while this
--                        policy is the one in force. The shiur lock is a policy with web_mode
--                        'none' that the schedules below swap in.
--
-- Then the seed: the four yeshiva app policies + the shiur policy (${ruleRows.length} app rules) and the
-- Sunday–Thursday shiur windows. The windows' base is the TAG (\`tag:yeshiva\`), so four rows cover
-- every yeshiva rung and the timetable is edited in one place:
${windowDoc}
--
-- The seed part is re-runnable (policies are INSERT OR IGNORE, rules are cleared and reinserted for
-- these policies only, schedules are INSERT OR IGNORE by id).

ALTER TABLE devices ADD COLUMN tag TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE policies ADD COLUMN app_default TEXT NOT NULL DEFAULT 'allowed';
ALTER TABLE policies ADD COLUMN web_mode TEXT;

UPDATE policies SET app_default = 'blocked' WHERE id IN ('apps_rung_1', 'apps_rung_2', 'apps_rung_3');

INSERT OR IGNORE INTO policies (id, name, headwind_configuration_id, app_default, web_mode, created_at) VALUES
${policyRows.join(',\n')};

DELETE FROM app_rules WHERE policy_id IN (${POLICIES.map((p) => q(p.id)).join(', ')});

INSERT INTO app_rules (policy_id, package_name, state)
VALUES
${ruleRows.join(',\n')};

INSERT OR IGNORE INTO schedules (id, device_id, base_policy_id, active_policy_id, day_mask, start_min, end_min, priority, created_at) VALUES
${scheduleRows.join(',\n')};
`;

writeFileSync(new URL('../migrations/0016_yeshiva_tag.sql', import.meta.url), sql);
console.log(`Wrote migrations/0016_yeshiva_tag.sql: ${POLICIES.length} policies, ${ruleRows.length} app rules, ${WINDOWS.length} shiur windows.`);
