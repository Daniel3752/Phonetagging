// Recognising a search from a URL, and pulling the query out of it.
//
// This is what a proxy buys that DNS never could. At DNS the filter sees `www.google.com` and
// nothing else: the words typed into the box live in the query string, so a single approval of
// google.com silently approves every search anyone will ever run. With the full URL in hand the
// words become visible, and the classifier can judge intent rather than destination.
//
// Deliberately pure: no network, no D1, no Gemini. Parsing is the part with all the awkward cases
// (engine-specific parameter names, image-search variants, regional domains), so it is testable on
// its own. See test/search.test.mjs.

// Per-engine: the registrable label(s) it serves from, which path prefixes carry a search, and which
// query parameter holds the words.
//
// `hosts` are LABELS, not suffixes, and are matched against the hostname's label sequence with only
// a top-level-domain tail permitted after them. That gets regional variants for free — google.co.il,
// google.de and www.google.com are all Google, and a filter knowing only .com is sidestepped by
// typing a different country — WITHOUT also matching google.evil.com, which a naive prefix or
// substring test happily accepts.
const ENGINES = [
  { name: 'google',     hosts: ['google'],        paths: ['/search', '/imghp'], params: ['q', 'query'] },
  { name: 'bing',       hosts: ['bing'],          paths: ['/search', '/images'], params: ['q'] },
  { name: 'duckduckgo', hosts: ['duckduckgo'],    paths: ['/'],                 params: ['q'] },
  { name: 'yahoo',      hosts: ['yahoo'],         paths: ['/search'],           params: ['p', 'q'] },
  { name: 'yandex',     hosts: ['yandex'],        paths: ['/search', '/images'], params: ['text', 'q'] },
  { name: 'ecosia',     hosts: ['ecosia'],        paths: ['/search', '/images'], params: ['q'] },
  { name: 'startpage',  hosts: ['startpage'],     paths: ['/search', '/sp/search'], params: ['query', 'q'] },
  { name: 'brave',      hosts: ['search.brave'],  paths: ['/search', '/images'], params: ['q'] },
  { name: 'youtube',    hosts: ['youtube'],       paths: ['/results'],          params: ['search_query', 'q'] },
  { name: 'pinterest',  hosts: ['pinterest'],     paths: ['/search'],           params: ['q'] },
  { name: 'reddit',     hosts: ['reddit'],        paths: ['/search'],           params: ['q'] },
];

// Enough of a public-suffix approximation for this job. A full PSL would be more correct, but the
// consequence of being slightly wrong here is bounded: over-matching means a query gets classified
// that needn't have been, and under-matching means a hostname is judged by site rating alone. It is
// the ATTACKER-CONTROLLED direction that matters, and requiring a genuine TLD tail closes it.
const GTLDS = new Set(['com', 'org', 'net', 'info', 'io', 'app', 'dev', 'me', 'tv', 'ai', 'xyz']);
const SLDS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or']);

const isCcTld = (label) => /^[a-z]{2}$/.test(label);

// Is everything after the engine's own label just a top-level domain? `com` yes, `co.il` yes,
// `evil.com` no — `evil` is neither a country code nor one of the second-level labels that precede
// one.
function isTldTail(tail) {
  if (tail.length === 1) return isCcTld(tail[0]) || GTLDS.has(tail[0]);
  if (tail.length === 2) return SLDS.has(tail[0]) && isCcTld(tail[1]);
  return false;
}

// Image search is called out separately because it is a different risk, not a stricter one. Ordinary
// search returns links, and following one puts the destination back in front of the site filter.
// Image search returns the pictures themselves, rendered inline from the engine's own servers — the
// destination is never visited, so the site filter never gets its turn. It is the one case where
// the results ARE the content.
const IMAGE_MARKERS = [
  { param: 'tbm', value: 'isch' },     // Google
  { param: 'udm', value: '2' },        // Google's newer image mode
];
const IMAGE_PATHS = ['/images', '/imghp', '/imgres'];

// The engine's labels must appear as a contiguous run, with nothing but a TLD tail after them.
// Anything may precede them (www., search., a regional subdomain) — that part is the engine's own
// namespace and is safe.
function hostMatches(hostname, bases) {
  const labels = hostname.toLowerCase().split('.');
  return bases.some((base) => {
    const baseLabels = base.split('.');
    for (let i = 0; i + baseLabels.length <= labels.length; i++) {
      if (baseLabels.every((b, j) => labels[i + j] === b) && isTldTail(labels.slice(i + baseLabels.length))) {
        return true;
      }
    }
    return false;
  });
}

function pathMatches(pathname, paths) {
  return paths.some((p) => (p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(`${p}/`)));
}

// Parses a full URL and returns the search it represents, or null if it isn't one.
//
// Returns { engine, query, isImageSearch }. A recognised search page with an EMPTY query is not a
// search — it is the engine's landing page, and treating it as a search would mean classifying the
// empty string on every visit.
export function parseSearchUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const hostname = u.hostname.replace(/\.$/, '').toLowerCase();

  for (const engine of ENGINES) {
    if (!hostMatches(hostname, engine.hosts)) continue;
    if (!pathMatches(u.pathname, engine.paths)) continue;

    let query = null;
    for (const param of engine.params) {
      const value = u.searchParams.get(param);
      if (value && value.trim()) { query = value.trim(); break; }
    }
    if (!query) return null;

    const isImageSearch =
      IMAGE_PATHS.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`)) ||
      IMAGE_MARKERS.some((m) => u.searchParams.get(m.param) === m.value);

    return { engine: engine.name, query, isImageSearch };
  }

  return null;
}

// True when the URL is a search on ANY recognised engine. Used to decide whether a request needs the
// query classified before it is answered, rather than only the hostname checked.
export function isSearchUrl(rawUrl) {
  return parseSearchUrl(rawUrl) !== null;
}

// True when the hostname belongs to a recognised search engine, regardless of path or query. The
// proxy uses this to let a search engine's HOMEPAGE (the empty search box, which parseSearchUrl
// rejects because it has no query) load wherever the rung permits search — otherwise the box the
// user is about to type a filtered query into would itself be blocked as an ordinary unlisted site.
// The queries themselves still go through parseSearchUrl and the query filter; only the bare landing
// is granted here.
export function isSearchEngineHost(hostname) {
  const h = String(hostname || '').replace(/\.$/, '').toLowerCase();
  if (!h) return false;
  return ENGINES.some((engine) => hostMatches(h, engine.hosts));
}

// A stable cache key for a query, so the same words asked twice are judged once.
//
// Normalised hard: lowercased, punctuation stripped, whitespace collapsed, words sorted. "Volcano
// Facts", "facts volcano" and "volcano   facts!!" collapse to one key. That is deliberate — the
// alternative is a cache that never hits, because nobody types a phrase the same way twice, and an
// attacker gets a fresh unjudged query by adding a comma.
export function searchCacheKey(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}
