// Classifying a whole domain and recording the verdict. Shared by the proxy check (inline, when a
// device on a web rung hits a domain nobody has judged yet) and the background pre-classifier.
//
// Keyed by the REGISTRABLE DOMAIN (see domains.js): one fetch + one model call per domain, reused by
// every subdomain and every device, cached forever. The row is written scope='host' with hostname =
// the registrable domain, so it sits in the same table the operator overrides and the seed use.

import { classifySite } from './gemini.js';
import { sha256Hex } from './crypto.js';
import { registrableDomain } from './domains.js';
import { normalizeSiteLevel, NEVER_LEVEL } from './levels.js';

// Kept tight because this runs INLINE on a request the user is waiting on (first hit of a new
// domain). A slow origin should not hold the page for long — fail closed and let the retry re-judge.
const FETCH_TIMEOUT_MS = 6000;
const PAGE_TEXT_LIMIT = 4000;

export function extractPageInfo(html) {
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1]?.trim() || '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PAGE_TEXT_LIMIT);
  return { title, text };
}

// Classify a domain and cache the verdict. Returns { level, is_doorway, reason, hostname } — the
// same shape a url_verdicts row has, so callers can pass it straight to isVisibleAtLevel.
//
// Fails CLOSED: on any error (fetch failed, model down) it returns a NEVER verdict and records
// NOTHING, so a transient failure neither permanently blocks a fine domain nor caches a bad guess —
// the next hit re-judges. The caller decides what a NEVER means for its rung.
export async function classifyDomain(env, hostOrDomain, { source = 'gemini' } = {}) {
  const domain = registrableDomain(hostOrDomain);
  if (!domain || !domain.includes('.')) {
    return { level: NEVER_LEVEL, is_doorway: 0, reason: 'Unclassifiable host.', hostname: domain, transient: true };
  }

  try {
    const pageRes = await fetch(`https://${domain}/`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'shmira-filter-classifier/1.0' },
    });
    const html = await pageRes.text();
    const { title, text } = extractPageInfo(html);
    const result = await classifySite(env, { hostname: domain, title, text });
    const level = normalizeSiteLevel(result.level);

    const hash = await sha256Hex(domain);
    await env.DB.prepare(`
      INSERT INTO url_verdicts (url_hash, url, hostname, scope, verdict, reason, source, decided_at, level, is_doorway, site_mode)
      VALUES (?, ?, ?, 'host', ?, ?, ?, ?, ?, ?, 'filtered')
      ON CONFLICT(url_hash) DO UPDATE SET
        url = excluded.url, hostname = excluded.hostname, scope = 'host',
        verdict = excluded.verdict, reason = excluded.reason, source = excluded.source,
        decided_at = excluded.decided_at, level = excluded.level, is_doorway = excluded.is_doorway
    `).bind(
      hash, `https://${domain}/`, domain, level >= NEVER_LEVEL ? 'blocked' : 'clean',
      result.reason || null, source, Date.now(), level, result.isDoorway ? 1 : 0
    ).run().catch(() => {});

    return { level, is_doorway: result.isDoorway ? 1 : 0, reason: result.reason, hostname: domain };
  } catch {
    return { level: NEVER_LEVEL, is_doorway: 0, reason: 'Could not check this site right now.', hostname: domain, transient: true };
  }
}
