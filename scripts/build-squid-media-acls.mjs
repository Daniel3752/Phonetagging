// Writes the two generated squid regexes (in-app media hosts, and the music/API hosts that must
// never be terminated) from src/app-media.js into scripts/squid.conf and
// scripts/apply-yeshiva-squid.sh, so the Worker and squid can never disagree about what a
// Spotify host is. test/app-media.test.mjs fails until this has been run after a list change.
//
//   node scripts/build-squid-media-acls.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { SQUID_APP_MEDIA_REGEX, SQUID_APP_KEEP_REGEX, APP_MEDIA_DNS_HOSTS } from '../src/app-media.js';

for (const rx of [SQUID_APP_MEDIA_REGEX, SQUID_APP_KEEP_REGEX]) {
  if (/[\s'"`]/.test(rx)) throw new Error(`regex contains a character squid.conf or the shell cannot carry: ${rx}`);
}

const edits = [
  ['scripts/squid.conf', [
    [/^acl app_media_hosts ssl::server_name_regex -i \S+$/m, `acl app_media_hosts ssl::server_name_regex -i ${SQUID_APP_MEDIA_REGEX}`],
    [/^acl app_keep_hosts ssl::server_name_regex -i \S+$/m, `acl app_keep_hosts ssl::server_name_regex -i ${SQUID_APP_KEEP_REGEX}`],
  ]],
  ['scripts/apply-yeshiva-squid.sh', [
    [/^export APP_MEDIA_RX='[^']*'$/m, `export APP_MEDIA_RX='${SQUID_APP_MEDIA_REGEX}'`],
    [/^export APP_KEEP_RX='[^']*'$/m, `export APP_KEEP_RX='${SQUID_APP_KEEP_REGEX}'`],
  ]],
];
// The strict resolver's seed list (scripts/app-media.dnsmasq): install-dns-policy.sh installs it
// as the first /etc/shmira/dnsmasq-strict.d/app-media.conf, so the DNS layer refuses the picture
// hosts from its first start rather than only after the first successful sync.
const hosts = [...new Set(Object.values(APP_MEDIA_DNS_HOSTS).flat())].sort();
writeFileSync(new URL('../scripts/app-media.dnsmasq', import.meta.url),
  '# In-app picture hosts refused for phones on the strict resolver. Seed written by\n'
  + '# scripts/build-squid-media-acls.mjs from src/app-media.js; sync-media-on.sh replaces it from the Worker.\n'
  + hosts.map((h) => `local=/${h}/`).join('\n') + '\n');
console.log(`updated scripts/app-media.dnsmasq (${hosts.length} hosts)`);

for (const [file, subs] of edits) {
  const path = new URL(`../${file}`, import.meta.url);
  let text = readFileSync(path, 'utf8');
  for (const [re, line] of subs) {
    if (!re.test(text)) throw new Error(`${file}: no line matches ${re}`);
    text = text.replace(re, () => line);   // a function: "$'" in the pattern is not a backreference
  }
  writeFileSync(path, text);
  console.log(`updated ${file}`);
}
