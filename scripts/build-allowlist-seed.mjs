// Generates migrations/0005_seed_allowlist.sql — the starter allowlist for url_verdicts.
//
// WHY a generator and not hand-written SQL: host rows are keyed on url_hash = sha256(hostname)
// (see recordVerdict in src/index.js and the host lookup in src/proxy-api.js). SQLite/D1 has no
// sha256() function, so the hash must be precomputed. This script owns the curated lists, computes
// the hashes exactly the way the Worker does, and emits idempotent upserts that match the shape the
// operator path (POST /api/admin/sites/level) writes, so a seeded row is indistinguishable from one
// an operator added by hand and is overwritten cleanly if the operator later re-rates it.
//
// Run:  node scripts/build-allowlist-seed.mjs  > migrations/0005_seed_allowlist.sql
//   (it writes the file itself; stdout just echoes a summary.)

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const NEVER_LEVEL = 6; // mirror of levels.js: a rating >= this is a block-everywhere verdict

// The 1..5 ladder (migrations/0003_levels.sql):
//   1 Essential  2 General  3 Mainstream  4 Permissive  5 Never
// Everything seeded here is an ALLOW, so nothing is level 5 and nothing is a doorway — search
// engines, social feeds and open-UGC platforms are deliberately left UNSEEDED so they stay
// default-denied until an operator makes a considered decision.

// --- Group A: infrastructure ---------------------------------------------------------------------
// Font, script, CSS and asset hosts that other pages pull in. Rated level 1 so they resolve for a
// device on ANY rung — otherwise an approved page at level 1 loads with no fonts, no layout, no JS.
// Only STABLE, single-purpose asset hostnames belong here. Deliberately EXCLUDED as bypass risks:
//   - googleusercontent.com / lh3.googleusercontent.com (arbitrary user uploads + cached pages)
//   - translate.googleapis.com (a general-purpose proxy)
//   - polyfill.io (supply-chain-compromised in 2024)
// Per-site CDN subdomains (static.example.com, *.cloudfront.net, *.akamaihd.net, *.fastly.net) are
// NOT global infra — they are seeded next to the site that needs them, or added by the operator.
const INFRA = [
  // Google Fonts + Google static/hosted libraries
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
  'www.gstatic.com',
  'ssl.gstatic.com',
  'gstatic.com',
  // Open script / CSS CDNs
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'code.jquery.com',
  'stackpath.bootstrapcdn.com',
  'maxcdn.bootstrapcdn.com',
  'netdna.bootstrapcdn.com',
  // Icon / font services
  'use.fontawesome.com',
  'kit.fontawesome.com',
  'ka-f.fontawesome.com',
  'use.typekit.net',
  'p.typekit.net',
  'fonts.bunny.net',
];

// --- Group B: starter sites ----------------------------------------------------------------------
// Curated conservatively for a Haredi supervised context. Each entry lists EVERY hostname the site
// actually loads from (apex, www, and known image/asset subdomains), because the filter matches
// exact hosts — a missing image host means a page that half-renders. Kept small and obviously-safe
// on purpose: this is a starter the operator/classifier grows, not a definitive list.
const SITES = [
  // -- Level 1: Essential — Torah/education, banking, government, utilities ----------------------
  { level: 1, reason: 'Torah study library', hosts: ['sefaria.org', 'www.sefaria.org', 'developers.sefaria.org'] },
  { level: 1, reason: 'Jewish calendar and zmanim', hosts: ['hebcal.com', 'www.hebcal.com', 'download.hebcal.com'] },
  { level: 1, reason: 'Torah audio and text library', hosts: ['torah.org', 'www.torah.org', 'outorah.org', 'www.outorah.org'] },
  { level: 1, reason: 'Kosher certification lookup', hosts: ['ok.org', 'www.ok.org', 'star-k.org', 'www.star-k.org', 'crcweb.org', 'www.crcweb.org'] },
  { level: 1, reason: 'Free education', hosts: ['khanacademy.org', 'www.khanacademy.org', 'cdn.kastatic.org', 'cdn.kastatic.com'] },
  { level: 1, reason: 'US government portal', hosts: ['usa.gov', 'www.usa.gov'] },
  { level: 1, reason: 'US tax authority', hosts: ['irs.gov', 'www.irs.gov'] },
  { level: 1, reason: 'US social security', hosts: ['ssa.gov', 'www.ssa.gov'] },
  { level: 1, reason: 'National weather service', hosts: ['weather.gov', 'www.weather.gov', 'forecast.weather.gov'] },

  // -- Level 2: General — news wire, reference, technology, non-clothing shopping ----------------
  { level: 2, reason: 'Programming Q&A', hosts: ['stackoverflow.com', 'stackexchange.com', 'cdn.sstatic.net', 'i.sstatic.net'] },
  { level: 2, reason: 'Code hosting', hosts: ['github.com', 'www.github.com', 'raw.githubusercontent.com', 'gist.github.com', 'objects.githubusercontent.com', 'avatars.githubusercontent.com'] },
  { level: 2, reason: 'Web development reference', hosts: ['developer.mozilla.org', 'mozilla.org', 'www.mozilla.org'] },
  { level: 2, reason: 'Programming tutorials', hosts: ['w3schools.com', 'www.w3schools.com'] },
  { level: 2, reason: 'Dictionary', hosts: ['merriam-webster.com', 'www.merriam-webster.com', 'dictionary.com', 'www.dictionary.com'] },
  { level: 2, reason: 'Computational knowledge engine', hosts: ['wolframalpha.com', 'www.wolframalpha.com'] },
  { level: 2, reason: 'Digital library and archive', hosts: ['archive.org', 'web.archive.org'] },
  { level: 2, reason: 'Wikimedia image and media host', hosts: ['upload.wikimedia.org', 'commons.wikimedia.org', 'wikimedia.org', 'www.wikipedia.org', 'wikipedia.org'] },
  { level: 2, reason: 'Weather forecast', hosts: ['weather.com', 'www.weather.com', 'accuweather.com', 'www.accuweather.com'] },
  { level: 2, reason: 'Open map data', hosts: ['openstreetmap.org', 'www.openstreetmap.org', 'tile.openstreetmap.org'] },
  { level: 2, reason: 'Public radio news', hosts: ['npr.org', 'www.npr.org', 'text.npr.org'] },
  { level: 2, reason: 'News wire service', hosts: ['apnews.com', 'www.apnews.com'] },
];

// --- Emit ----------------------------------------------------------------------------------------
const now = Date.now();
const rows = [];

// site_mode (see proxy-api.js): 'trusted' allows the whole host with no per-request judging;
// 'filtered' leaves it subject to the rung's rating test (and to future per-path judging). Reserve
// 'trusted' for hosts with no user-reachable objectionable content — infrastructure and the
// Essential (level 1) sites here. Level 2 sites stay 'filtered'.
for (const host of INFRA) {
  rows.push({ hostname: host, level: 1, reason: 'Infrastructure: fonts/scripts/assets', isDoorway: 0, siteMode: 'trusted' });
}
for (const site of SITES) {
  const siteMode = site.mode || (site.level === 1 ? 'trusted' : 'filtered');
  for (const host of site.hosts) {
    rows.push({ hostname: host.toLowerCase(), level: site.level, reason: site.reason, isDoorway: 0, siteMode });
  }
}

// De-dupe on hostname, keeping the strictest (lowest) level if a host appears twice.
const byHost = new Map();
for (const r of rows) {
  const prev = byHost.get(r.hostname);
  if (!prev || r.level < prev.level) byHost.set(r.hostname, r);
}
const finalRows = [...byHost.values()].sort((a, b) => a.level - b.level || a.hostname.localeCompare(b.hostname));

const esc = (s) => String(s).replace(/'/g, "''");
const values = finalRows.map((r) => {
  const hash = sha256Hex(r.hostname);
  const verdict = r.level >= NEVER_LEVEL ? 'blocked' : 'clean';
  return `  ('${hash}', 'https://${esc(r.hostname)}/', '${esc(r.hostname)}', 'host', '${verdict}', '${esc(r.reason)}', 'operator', ${now}, ${r.level}, ${r.isDoorway}, '${r.siteMode}')`;
}).join(',\n');

const sql = `-- Starter allowlist seed. GENERATED by scripts/build-allowlist-seed.mjs — do not hand-edit; edit
-- the generator's curated lists and re-run. ${finalRows.length} host rows.
--
-- Every row is an operator-sourced ALLOW written to match POST /api/admin/sites/level exactly:
-- scope='host', url_hash = sha256(hostname), url = https://<hostname>/. Idempotent — the upsert
-- overwrites a prior row for the same host, so re-running is safe and an operator re-rating later
-- still wins. Infrastructure and Essential (level 1) hosts are 'trusted' (whole-host allow);
-- level 2 hosts stay 'filtered'. Requires migrations/0006 (the site_mode column).

INSERT INTO url_verdicts (url_hash, url, hostname, scope, verdict, reason, source, decided_at, level, is_doorway, site_mode)
VALUES
${values}
ON CONFLICT(url_hash) DO UPDATE SET
  url = excluded.url, hostname = excluded.hostname, scope = 'host',
  verdict = excluded.verdict, reason = excluded.reason, source = excluded.source,
  decided_at = excluded.decided_at, level = excluded.level, is_doorway = excluded.is_doorway,
  site_mode = excluded.site_mode;
`;

const outPath = new URL('../migrations/0005_seed_allowlist.sql', import.meta.url);
writeFileSync(outPath, sql);

// Summary to stdout
const byLevel = {};
for (const r of finalRows) byLevel[r.level] = (byLevel[r.level] || 0) + 1;
console.log(`Wrote migrations/0005_seed_allowlist.sql`);
console.log(`Total host rows: ${finalRows.length}`);
console.log(`By level:`, byLevel);
console.log(`Infra hosts: ${INFRA.length}, site groups: ${SITES.length}`);
