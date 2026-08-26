// Keyword pre-filter for search queries — the cheap fast path that keeps most queries from ever
// reaching the model. Deliberately pure: the rules come in as an argument, so the matching logic is
// testable without D1 and the caller (proxy-api.js) owns the one query that loads them.
//
// A rule carries a RATING on the same 1..NEVER ladder as everything else, so a keyword decision and
// a model decision are directly comparable and one device rung governs both. This is not a separate
// allow/block switch: a term that should be blocked below rung 4 but permitted at 4-5 (immodest but
// not explicit) is simply rated 4; a term that is never acceptable is rated NEVER; an obviously
// benign term is rated 1. The proxy then applies the same `rating <= rung` test it uses everywhere.
//
// IMPORTANT: the RULES ARE DATA and are intentionally empty for now — the actual term lists (English,
// Hebrew, Yiddish) are the deferred "AI instructions" content (see BUILD-PLAN.md §0). With no rules,
// every query returns null → "unknown" → the model is asked, exactly as before. Populating the table
// only shifts load off the model; it never changes the ladder's meaning.
//
// Keywords are a fast pre-filter, NOT the whole judgment. They are brittle by nature — evadable, and
// prone to false positives ("essex", "scunthorpe") — so the model remains the backstop for anything
// they do not match, and matches should stay reviewable in the operator console.

import { NEVER_LEVEL, normalizeSiteLevel } from './levels.js';

// Same normalisation the search cache key uses: lowercase, strip anything that is not a letter or
// number to spaces, split on whitespace. Returned as a Set for order-independent membership — a
// multi-word pattern matches however the words were ordered or punctuated in the query.
export function queryTokens(query) {
  return new Set(
    String(query || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
}

// Does every token of `pattern` appear in the query's token set? A single-word rule ("swimwear")
// matches whenever that word is present; a multi-word rule ("beach photos") matches only when all of
// its words are present, in any order. This is deliberately conservative about multi-word rules
// (all-of, not any-of) so a broad rule does not fire on an incidental single word.
function patternMatches(pattern, tokens) {
  const parts = [...queryTokens(pattern)];
  return parts.length > 0 && parts.every((p) => tokens.has(p));
}

// Rate a query from the keyword rules, or null if none match (→ ask the model).
//
// rules: [{ pattern, rating, note? }]. When several match, the STRICTEST (highest rating) wins —
// the same fail-stricter discipline used everywhere else, so an ambiguous query that trips both a
// benign and a strict rule is treated as strict.
export function keywordRating(query, rules) {
  const tokens = queryTokens(query);
  if (tokens.size === 0) return null;

  let best = null;
  for (const rule of rules || []) {
    if (!rule || !rule.pattern) continue;
    if (!patternMatches(rule.pattern, tokens)) continue;
    const rating = normalizeSiteLevel(rule.rating);
    if (best === null || rating > best.rating) {
      best = { rating, note: rule.note || null, pattern: rule.pattern };
    }
  }
  return best;
}

// Convenience the caller can read without importing NEVER separately.
export const KEYWORD_NEVER = NEVER_LEVEL;
