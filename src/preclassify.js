// Background pre-classifier. Walks the classify_queue a few domains at a time on the cron tick, so
// the common web is already judged before anyone visits and the inline path (proxy-api.js) stays a
// rare fallback. Paced small to sit comfortably inside the model's free tier — a handful per tick,
// not a flood.
//
// Idempotent and self-throttling: a domain already in url_verdicts is marked done without spending a
// call; a transient failure bumps attempts and is retried next tick until MAX_ATTEMPTS, then parked
// as 'error' so it never blocks the queue.

import { classifyDomain } from './classify.js';
import { sha256Hex } from './crypto.js';
import { registrableDomain } from './domains.js';

const DEFAULT_BATCH = 3;
const MAX_ATTEMPTS = 3;

export async function runPreClassifier(env, limit) {
  const batch = Number(env.PRECLASSIFY_BATCH) || limit || DEFAULT_BATCH;
  const summary = { picked: 0, classified: 0, skipped: 0, failed: 0 };

  const rows = await env.DB.prepare(
    `SELECT domain, attempts FROM classify_queue WHERE status = 'pending' AND attempts < ?
     ORDER BY added_at LIMIT ?`
  ).bind(MAX_ATTEMPTS, batch).all().then((r) => r.results || []).catch(() => []);

  for (const row of rows) {
    summary.picked++;
    const domain = registrableDomain(row.domain);

    // Already judged (seed, operator, or an earlier inline hit)? Retire it without a model call.
    const existing = await env.DB.prepare(
      `SELECT 1 FROM url_verdicts WHERE url_hash = ? AND scope = 'host'`
    ).bind(await sha256Hex(domain)).first().catch(() => null);
    if (existing) {
      await markDone(env, row.domain);
      summary.skipped++;
      continue;
    }

    const verdict = await classifyDomain(env, domain, { source: 'preclassify' });
    if (verdict.transient) {
      const attempts = (row.attempts || 0) + 1;
      await env.DB.prepare(
        `UPDATE classify_queue SET attempts = ?, status = ? WHERE domain = ?`
      ).bind(attempts, attempts >= MAX_ATTEMPTS ? 'error' : 'pending', row.domain).run().catch(() => {});
      summary.failed++;
    } else {
      await markDone(env, row.domain);
      summary.classified++;
    }
  }

  return summary;
}

function markDone(env, domain) {
  return env.DB.prepare(
    `UPDATE classify_queue SET status = 'done', done_at = ? WHERE domain = ?`
  ).bind(Date.now(), domain).run().catch(() => {});
}
