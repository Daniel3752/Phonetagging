// Background pre-classifier, against a real SQLite via the D1 shim with a mocked model. Run with:
// npm test. The behaviours that matter: it spends no model call on an already-judged domain, it
// records a fresh verdict for a new one, and a transient failure is retried then parked, never
// blocking the queue.

import { makeDB } from './d1-shim.mjs';
import { runPreClassifier } from '../src/preclassify.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

const DB = makeDB('./schema.sql');
const env = { DB, GEMINI_API_KEY: 'x', PRECLASSIFY_BATCH: 10 };

const sha = async (s) => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// Model + homepage fetch mock. Homepage fetch returns HTML; the gemini call returns a JSON verdict.
let modelLevel = 4;
let modelFails = false;
let modelCalls = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes('generativelanguage')) {
    modelCalls++;
    if (modelFails) return new Response('boom', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{
      text: JSON.stringify({ level: modelLevel, is_doorway: false, reason: 'Test.' }),
    }] } }] });
  }
  return new Response('<title>Site</title><body>hello</body>');
};

// Seed the queue: one domain already judged, one brand new.
const now = Date.now();
await DB.prepare(`INSERT INTO url_verdicts (url_hash, url, hostname, scope, verdict, reason, source, decided_at, level, is_doorway, site_mode)
  VALUES (?, 'https://known.com/', 'known.com', 'host', 'clean', 'seed', 'operator', ?, 2, 0, 'trusted')`)
  .bind(await sha('known.com'), now).run();
await DB.prepare(`INSERT INTO classify_queue (domain, added_at) VALUES ('known.com', ?)`).bind(now).run();
await DB.prepare(`INSERT INTO classify_queue (domain, added_at) VALUES ('fresh.com', ?)`).bind(now + 1).run();

console.log('\n1. an already-judged domain is retired without a model call');
let before = modelCalls;
let s = await runPreClassifier(env);
check('the known domain was skipped', s.skipped === 1, JSON.stringify(s));
check('the fresh domain was classified', s.classified === 1, JSON.stringify(s));
check('exactly one model call was spent (fresh only)', modelCalls - before === 1, `calls=${modelCalls - before}`);

const fresh = await DB.prepare(`SELECT level FROM url_verdicts WHERE hostname = 'fresh.com'`).first();
check('the fresh verdict was written at the model level', fresh && fresh.level === 4, JSON.stringify(fresh));

const q = await DB.prepare(`SELECT COUNT(*) AS n FROM classify_queue WHERE status = 'done'`).first();
check('both rows are marked done', q.n === 2, JSON.stringify(q));

console.log('\n2. a transient failure is retried, then parked');
await DB.prepare(`INSERT INTO classify_queue (domain, added_at) VALUES ('flaky.com', ?)`).bind(now + 2).run();
modelFails = true;
for (let i = 0; i < 3; i++) s = await runPreClassifier(env);
const flaky = await DB.prepare(`SELECT status, attempts FROM classify_queue WHERE domain = 'flaky.com'`).first();
check('parked as error after the attempt cap', flaky.status === 'error' && flaky.attempts === 3, JSON.stringify(flaky));
check('no verdict was cached for the failed domain',
  !(await DB.prepare(`SELECT 1 AS x FROM url_verdicts WHERE hostname = 'flaky.com'`).first()));

console.log(failures ? `\n${failures} FAILED\n` : '\nAll pre-classifier checks passed.\n');
process.exit(failures ? 1 : 0);
