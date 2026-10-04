// Try something on ONE phone, without moving a rung that other people's phones are on.
//
// WHY THIS EXISTS. Everything in this system is keyed to a RUNG, and a rung is shared. levels.js
// turns (tag, rung) into what the browser may do; policy.js turns it into one Headwind
// configuration. So "put the new companion build on a phone and see whether it survives the night"
// could only be asked of every phone on that rung at once — which, on a fleet of real people's
// handsets, means it never actually got asked.
//
// A device_overrides row (migrations/0022) answers for one device and names only the fields it
// changes. This is the front door to it.
//
// WHY NODE AND NOT BASH, unlike the other scripts in here. Those run on the filter box, which is
// Linux. This one runs on the operator's PC, which is Windows, from cmd — where a bash script needs
// Git Bash and a JSON body needs quote gymnastics that go wrong silently. Node is already installed
// (it is what runs wrangler), it behaves the same in cmd, PowerShell and a terminal, and it can
// build the JSON itself so a note containing quotes cannot break anything.
//
// THE TWO HALVES, because they behave differently:
//   --policy    the APP half. Names another policy, whose Headwind configuration this phone alone is
//               put on at the scheduler's next run (within five minutes), then the phone's next
//               Headwind sync. This is how a new app rule, or a new build of the companion, reaches
//               one handset. The policy must already exist AND carry a headwind_configuration_id —
//               make the configuration in the panel first, then the policy in /admin, or the
//               scheduler reports this device as failed on every run.
//   the flags   the WEB half — images, streaming, in-app pictures, the browser mode. The proxy reads
//               them on every request, so they take effect in about a minute with no sync at all.
//
// WHAT IT DOES NOT CHANGE. The phone's rung and tag stay as they are, and so do the shiur windows:
// those are written against `tag:yeshiva`, so a phone under test is still locked for seder. A
// schedule keyed to the phone's ORIGINAL policy stops covering it while --policy is in force, which
// only matters if you ever write a per-policy schedule.
//
// ALWAYS CLEAR UP. An override is a test, and a test nobody remembers is just an undocumented
// exception on somebody's phone. `clear` puts it back on its rung, and `status` lists every phone
// currently off its rung — run that when you think you have finished.
//
// THE KEY. Set it once per terminal:
//     cmd         set OPERATOR_KEY=...
//     PowerShell  $env:OPERATOR_KEY="..."
//     bash        export OPERATOR_KEY=...
// Or, to stop retyping it, put a line `OPERATOR_KEY=...` in the repo's .dev.vars file, which is
// already git-ignored and is where wrangler keeps local secrets. This script reads it from there.
//
// USAGE
//     node scripts/test-on-phone.mjs devices
//     node scripts/test-on-phone.mjs status
//     node scripts/test-on-phone.mjs set dev_1a2b --policy yeshiva_rung_3_test --note "companion 0.1.2"
//     node scripts/test-on-phone.mjs set dev_1a2b --images on --note "why are pictures showing"
//     node scripts/test-on-phone.mjs clear dev_1a2b

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER = 'https://phone-url-filter.daniel08-madar.workers.dev';

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

// The key from the environment, or from .dev.vars so it does not have to be retyped per terminal.
function operatorKey() {
  if (process.env.OPERATOR_KEY) return process.env.OPERATOR_KEY.trim();
  try {
    const text = readFileSync(join(HERE, '..', '.dev.vars'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*OPERATOR_KEY\s*=\s*(.+?)\s*$/.exec(line);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .dev.vars, which is normal */ }
  return '';
}

const WORKER = (process.env.SHMIRA_WORKER_URL || DEFAULT_WORKER).replace(/\/+$/, '');

async function api(method, path, body) {
  const key = operatorKey();
  if (!key) {
    die('OPERATOR_KEY is not set. In cmd:  set OPERATOR_KEY=...\n' +
        '       or put a line OPERATOR_KEY=... in the repo\'s .dev.vars file.');
  }
  let res;
  try {
    res = await fetch(WORKER + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    die(`could not reach ${WORKER}: ${err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) {
    const detail = data?.error ? data.error : text.slice(0, 300);
    if (res.status === 401) die(`the Worker refused the key (401). Is OPERATOR_KEY right?`);
    die(`${method} ${path} returned ${res.status}: ${detail}`);
  }
  if (data === null) die(`${method} ${path} did not return JSON: ${text.slice(0, 200)}`);
  return data;
}

function pad(value, width) {
  const s = String(value ?? '');
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

// 'on'/'off' and the usual synonyms. Anything else is refused rather than guessed: an override that
// silently did not apply is the worst outcome for a test.
function readSwitch(name, raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'false', 'no', '0'].includes(v)) return false;
  die(`--${name} must be on or off, not ${JSON.stringify(raw)}`);
}

const FLAGS = {
  '--images': 'images',
  '--streaming': 'streaming',
  '--app-media': 'app_media',
  '--block-social': 'block_social',
};
const WEB_MODES = ['none', 'web', 'blocklist'];

async function cmdDevices() {
  const state = await api('GET', '/api/admin/state');
  const overridden = new Set((state.overrides || []).map((o) => o.device_id));
  console.log(`${pad('id', 18)} ${pad('label', 20)} ${pad('tag', 10)} ${pad('rung', 5)} policy`);
  for (const d of state.devices || []) {
    const mark = overridden.has(d.id) ? ' *' : '';
    console.log(`${pad(d.id, 18)} ${pad(d.label, 20)} ${pad(d.tag, 10)} ${pad(d.level, 5)} ${d.policy_id}${mark}`);
  }
  if (overridden.size) console.log('\n* = has a per-device override in force; see `status`.');
}

async function cmdStatus() {
  const state = await api('GET', '/api/admin/state');
  const labels = new Map((state.devices || []).map((d) => [d.id, d.label]));
  const rows = state.overrides || [];
  if (!rows.length) {
    console.log('No phone is currently off its rung. Nothing to clean up.');
    return;
  }
  console.log(`${rows.length} phone(s) under test:\n`);
  for (const o of rows) {
    console.log(`  ${o.device_id} (${labels.get(o.device_id) ?? '?'})`);
    for (const [k, v] of Object.entries(o)) {
      if (k === 'device_id' || k === 'note' || k === 'set_at' || v === null) continue;
      console.log(`      ${k} = ${v}`);
    }
    if (o.note) console.log(`      note: ${o.note}`);
    console.log();
  }
  console.log('Clear one with:  node scripts/test-on-phone.mjs clear <device_id>');
}

async function cmdSet(args) {
  const device = args.shift();
  if (!device || device.startsWith('--')) {
    die('usage: set <device_id> [--policy ID] [--images on|off] [--streaming on|off]\n' +
        '            [--app-media on|off] [--block-social on|off] [--web-mode none|web|blocklist]\n' +
        '            [--note TEXT]');
  }

  const body = { device_id: device };
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (value === undefined) die(`${flag} needs a value`);
    if (FLAGS[flag]) {
      body[FLAGS[flag]] = readSwitch(flag.replace(/^--/, ''), value);
    } else if (flag === '--policy') {
      body.policy_id = value;
    } else if (flag === '--web-mode') {
      if (!WEB_MODES.includes(value)) die(`--web-mode must be one of ${WEB_MODES.join(', ')}`);
      body.web_mode = value;
    } else if (flag === '--note') {
      body.note = value;
    } else {
      die(`unknown option: ${flag}`);
    }
  }

  if (Object.keys(body).length === 1) {
    die('nothing to set. Name at least one field, or use `clear`.');
  }

  console.log('Sending:', JSON.stringify(body));
  // Said out loud because the endpoint REPLACES the row: "images yesterday, streaming today" would
  // otherwise quietly drop the images override.
  console.log('(this replaces the phone\'s whole override row — fields you do not name stop being overridden)\n');
  const out = await api('POST', '/api/admin/device-overrides', body);
  console.log(JSON.stringify(out, null, 2));
  console.log('\nWeb flags apply in about a minute. A --policy change waits for the scheduler\'s next');
  console.log('run (every five minutes), then the phone\'s next Headwind sync — a reboot forces it.');
}

async function cmdClear(args) {
  const device = args.shift();
  if (!device) die('usage: clear <device_id>');
  const out = await api('POST', '/api/admin/device-overrides', { device_id: device, clear: true });
  console.log(JSON.stringify(out, null, 2));
  console.log('\nBack on its rung. A --policy override is undone at the scheduler\'s next run.');
}

function usage() {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const header = source.split('\n').filter((l) => l.startsWith('//'));
  console.log(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'devices': await cmdDevices(); break;
  case 'status':  await cmdStatus(); break;
  case 'set':     await cmdSet(rest); break;
  case 'clear':   await cmdClear(rest); break;
  case 'help': case '-h': case '--help': usage(); break;
  default:
    usage();
    process.exit(command ? 1 : 0);
}
