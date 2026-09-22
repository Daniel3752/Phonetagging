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
};

// Never blocked on any rung, and always written as an explicit 'allowed' row rather than left
// unlisted. On an allowlist rung an unlisted app is hidden, which would take away the very things
// that enforce the policy. On a BLOCKLIST rung an unlisted app is permitted anyway — but an
// 'allowed' row plus an APK in Headwind is what marks the app INSTALL on the configuration
// (headwind.js pushPolicyApps), so the agent puts it back if a phone ever loses it. That is worth
// having on every rung, so this bucket goes into every policy's allowed map below.
//
// The companion is here because migration 0021 added it to every policy, and the refresh below
// clears rules BY POLICY: without it in the generator, regenerating would silently drop it.
const MANAGEMENT = {
  'com.hmdm.launcher': 'Headwind agent (management — never block)',
  'com.wireguard.android': 'WireGuard (the filter tunnel — never block)',
  'com.getshmira.companion': 'Shmira companion (install watchdog + WhatsApp Updates guard — never block)',
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

// Video streaming. Follows the SOCIAL bucket by the operator's decision — blocked on the rungs
// that block social, permitted on rung 4, the most open rung, where the social apps are permitted
// too. MUSIC streaming is deliberately absent: Spotify is allowed here and its artwork is refused
// at the network layer instead (src/app-media.js, PROXY.md). Rungs 1-2 are allowlists, so an app
// missing from this list is already absent there; these names exist for the blocklist rungs.
//
// Every Israeli entry is a best guess. On a BLOCKLIST rung a wrong package name is a silent hole —
// the app simply stays allowed — so unlike the allowlist buckets above, these must be reconciled
// against Headwind's installed-apps list for a real handset before they are trusted.
const VIDEO = {
  'com.netflix.mediaclient': 'Netflix',
  'com.netflix.NGPClient': 'Netflix (preinstalled partner stub)',
  'com.disney.disneyplus': 'Disney+',
  'com.amazon.avod.thirdpartyclient': 'Prime Video',
  'com.google.android.videos': 'Google TV / Play Movies (preinstalled)',
  'com.google.android.apps.youtube.music': 'YouTube Music (preinstalled; plays music video)',
  'com.samsung.android.tvplus': 'Samsung TV Plus (preinstalled free live TV)',
  'com.hulu.plus': 'Hulu',
  'com.plexapp.android': 'Plex',
  'com.mxtech.videoplayer.ad': 'MX Player',
  'com.mxtech.videoplayer.pro': 'MX Player Pro',
  'org.videolan.vlc': 'VLC (plays network streams)',
  'com.wbd.stream': 'Max / HBO (CONFIRM package)',
  'com.apple.atve.android.appletv': 'Apple TV (CONFIRM package)',
  'com.peacocktv.peacockandroid': 'Peacock (CONFIRM package)',
  'com.paramount.android.pplus': 'Paramount+ (CONFIRM package)',
  'com.crunchyroll.crunchyroid': 'Crunchyroll (CONFIRM package)',
  'com.viki.android': 'Viki (CONFIRM package)',
  'com.rakuten.tv.android': 'Rakuten TV (CONFIRM package)',
  'il.co.mako.mako': 'Mako / Keshet 12 (CONFIRM package)',
  'com.reshet.tv': 'Reshet 13 (CONFIRM package)',
  'com.kan.kanapp': 'Kan 11 (CONFIRM package)',
  'com.hot.hotplus': 'HOT (CONFIRM package)',
  'com.partner.tv': 'Partner TV (CONFIRM package)',
  'com.sting.tv': 'STINGTV (CONFIRM package)',
  'com.yes.yesplus': 'Yes+ (CONFIRM package)',
  'com.cellcom.tv': 'Cellcom TV (CONFIRM package)',
};

// A way AROUND the app policy rather than content in its own right: a second app store, a
// sideloader, a device-transfer tool, an assistant that opens the web by itself. Blocked on BOTH
// blocklist rungs, rung 4 included — the most open rung is exactly where a second store matters,
// because it installs the handful of things that rung still refuses. The Play Store is deliberately
// absent: rungs 3 and 4 need it (see YESHIVA.md).
const APP_SOURCES = {
  'com.sec.android.app.samsungapps': 'Galaxy Store (a SECOND app store — installs what the policy refused)',
  'org.fdroid.fdroid': 'F-Droid (alternative store)',
  'com.amazon.venezia': 'Amazon Appstore',
  'com.huawei.appmarket': 'Huawei AppGallery',
  'com.xiaomi.market': 'Xiaomi GetApps (CONFIRM package)',
  'com.aurora.store': 'Aurora Store (anonymous Play client, CONFIRM package)',
  'com.apkpure.aegon': 'APKPure (CONFIRM package)',
  'cm.aptoide.pt': 'Aptoide (CONFIRM package)',
  'com.sec.android.easyMover': 'Smart Switch (copies apps from another phone)',
  'com.samsung.android.smartswitchassistant': 'Smart Switch Assistant',
  'com.samsung.android.bixby.agent': 'Bixby (assistant — opens the web on its own)',
  'com.samsung.android.visionintelligence': 'Bixby Vision',
  'com.samsung.android.bixby.wakeup': 'Bixby wakeup',
  'com.samsung.android.app.settings.bixby': 'Bixby settings',
  'com.google.android.apps.searchlite': 'Google Go (CONFIRM package)',
  // Preinstalled Facebook stubs on Samsung: dormant, but they can pull the full app down.
  'com.facebook.system': 'Facebook App Installer (preinstalled stub)',
  'com.facebook.appmanager': 'Facebook App Manager (preinstalled stub)',
  'com.facebook.services': 'Facebook Services (preinstalled stub)',
};

// Preinstalled content and extras: the vendor's feed, games hub, news and podcast readers. These
// are SYSTEM apps — Headwind cannot uninstall them, it hides them from the launcher — and they are
// content doorways rather than a way round the policy, so they follow the social shape and come
// back at rung 4.
const BLOAT = {
  'com.samsung.android.app.spage': 'Samsung Free / Daily (content feed)',
  'com.samsung.android.game.gamehome': 'Game Launcher',
  'com.samsung.android.game.gametools': 'Game Booster',
  'com.google.android.play.games': 'Play Games',
  'com.google.android.apps.magazines': 'Google News',
  'com.google.android.apps.podcasts': 'Google Podcasts',
  'com.samsung.android.voc': 'Samsung Members',
  'com.samsung.android.arzone': 'AR Zone',
  'com.samsung.android.app.tips': 'Samsung Tips',
  'com.samsung.android.themestore': 'Galaxy Themes (CONFIRM package)',
};

// --- policies ----------------------------------------------------------------------------------

// app_default is what the policy says about an app it has NO row for: 'blocked' makes it an
// allowlist, 'allowed' a blocklist. web_mode 'none' on a policy switches the browser off while it
// is the one in force — the shiur lock — whatever the phone's rung says.
const POLICIES = [
  { id: 'yeshiva_rung_1', name: 'Yeshiva — Rung 1 (Apps only)',            app_default: 'blocked', web_mode: null,
    allowed: { ...MANAGEMENT, ...ESSENTIALS, ...NECESSITIES }, blocked: {} },
  { id: 'yeshiva_rung_2', name: 'Yeshiva — Rung 2 (Apps + browser)',       app_default: 'blocked', web_mode: null,
    allowed: { ...MANAGEMENT, ...ESSENTIALS, ...NECESSITIES, ...BROWSER }, blocked: {} },
  // VIDEO and BLOAT ride with SOCIAL: off here, back on at rung 4. APP_SOURCES rides with the
  // browsers and VPNs: off on BOTH blocklist rungs, because a second app store undoes whichever
  // blocklist is in force.
  { id: 'yeshiva_rung_3', name: 'Yeshiva — Rung 3 (Blocklist, no social)', app_default: 'allowed', web_mode: null,
    allowed: { ...MANAGEMENT }, blocked: { ...SOCIAL, ...VIDEO, ...BLOAT, ...EXPLICIT, ...OTHER_BROWSERS, ...CIRCUMVENTION, ...APP_SOURCES } },
  { id: 'yeshiva_rung_4', name: 'Yeshiva — Rung 4 (Blocklist)',            app_default: 'allowed', web_mode: null,
    allowed: { ...MANAGEMENT }, blocked: { ...EXPLICIT, ...OTHER_BROWSERS, ...CIRCUMVENTION, ...APP_SOURCES } },
  // In shiur: only what is needed to be reachable. No browser (web_mode none), no Torah apps
  // either — the point is the phone is not a thing to look at during seder.
  { id: 'yeshiva_shiur',  name: 'Yeshiva — Shiur (locked to essentials)',   app_default: 'blocked', web_mode: 'none',
    allowed: { ...MANAGEMENT, ...ESSENTIALS }, blocked: {} },
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

// 0016 is already applied on the live database and a migration never runs twice, so regenerating it
// above keeps the file honest but changes nothing on the fleet. The rules block is written again
// here as its own re-runnable migration — the step the 0019 header describes as a hand-copy, done
// by the same run so the two cannot drift.
//
// yeshiva_rung_3_yt is rebuilt from rung 3 the way 0020 built it (everything rung 3 blocks, minus
// the official YouTube app). Without this the YouTube-option phones would keep the OLD rung-3
// blocklist and quietly miss every addition below.
const refresh = `-- Yeshiva app rules, refreshed: video streaming and the preinstalled sweep.
-- GENERATED by scripts/build-yeshiva-seed.mjs — edit that, not this. 0016 and 0019 carry the same
-- rows but are already applied, so the additions travel in this migration instead.
--
-- What is new (2026-09-22), all of it on the BLOCKLIST rungs, since rungs 1-2 are allowlists and an
-- app missing from them is already absent:
--   * VIDEO STREAMING on rung 3 — Netflix, Disney+, Prime Video, Google TV, YouTube Music, Samsung
--     TV Plus, Hulu, Plex, MX Player, VLC and the Israeli services. Rides with the social bucket,
--     so rung 4 permits them as it permits social. Music streaming is NOT included: Spotify stays
--     allowed and its artwork is refused at the network layer instead.
--   * APP SOURCES on rungs 3 AND 4 — Galaxy Store, F-Droid, Amazon Appstore, Aurora, APKPure,
--     Aptoide, Smart Switch, Bixby, Google Go, and Samsung's dormant Facebook installer stubs. A
--     second app store undoes whichever blocklist is in force, so it is refused on the open rung
--     too. The Play Store is deliberately absent — rungs 3 and 4 need it.
--   * PREINSTALLED CONTENT on rung 3 — Samsung Free/Daily, Game Launcher, Play Games, Google News
--     and Podcasts, Samsung Members, AR Zone, Tips, Galaxy Themes. System apps: Headwind hides
--     them rather than uninstalling them.
--
-- A package name that is wrong is NOT harmless on a blocklist rung — it is a silent hole, the app
-- simply stays allowed. Every entry labelled CONFIRM in the generator must be reconciled against
-- Headwind's installed-apps list for a real handset before this is trusted.
--
-- Re-runnable: rules for these policies are cleared and reinserted, then rung_3_yt is rebuilt.

DELETE FROM app_rules WHERE policy_id IN (${POLICIES.map((p) => q(p.id)).join(', ')});

INSERT INTO app_rules (policy_id, package_name, state)
VALUES
${ruleRows.join(',\n')};

DELETE FROM app_rules WHERE policy_id = 'yeshiva_rung_3_yt';
INSERT INTO app_rules (policy_id, package_name, state)
  SELECT 'yeshiva_rung_3_yt', package_name, state
    FROM app_rules
   WHERE policy_id = 'yeshiva_rung_3'
     AND package_name <> 'com.google.android.youtube';
`;
writeFileSync(new URL('../migrations/0023_yeshiva_streaming_and_preinstalled.sql', import.meta.url), refresh);

console.log(`Wrote migrations/0016_yeshiva_tag.sql and migrations/0023_yeshiva_streaming_and_preinstalled.sql: ${POLICIES.length} policies, ${ruleRows.length} app rules, ${WINDOWS.length} shiur windows.`);
