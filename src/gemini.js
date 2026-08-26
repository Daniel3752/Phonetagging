// Gemini proxy for SITE classification. The API key lives only as a wrangler secret
// (GEMINI_API_KEY), never shipped anywhere client-side. The prompt and response schema are fixed
// here, so this can only ever be used for this project's own site-appropriateness classification,
// not as a general LLM proxy.
//
// v1 judges a whole HOSTNAME, not a single page, because enforcement is DNS-level: Cloudflare
// Gateway can allow or deny example.com, but cannot see which path was requested. One decision per
// site rather than per page also collapses the classification volume — the cache actually hits, and
// the running cost converges toward zero as the allowlist saturates.
//
// Using Google's rolling "-latest" alias rather than a pinned version — pinned Flash-Lite versions
// have been retired server-side before and started 404ing. As of this writing the alias resolves
// to gemini-3.1-flash-lite.
import { NEVER_LEVEL } from './levels.js';

const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// TEMPORARY BRIDGE between the model's rating scale and the internal one, and the ONLY place the two
// scales meet. The prompts below still speak the old 1..5 ladder where 5 = "Never" (its wording is
// the deferred rubric rewrite — see BUILD-PLAN.md §0/§4). Internally the ladder is now five real
// device rungs 1..5 plus NEVER = 6, so a model "5" must NOT be read as "visible at rung 5" — that
// would show explicit content at the most open rung. Map it to NEVER instead; 1..4 pass through.
// When the rubric is rewritten to emit the 6-point scale directly, delete this and the mapping call.
function aiRatingToInternal(level) {
  const n = Number(level);
  if (!Number.isInteger(n) || n < 1 || n >= 5) return NEVER_LEVEL; // 5, out-of-range, malformed → NEVER
  return n; // 1..4 are already the internal min-rung
}

// Transient failures (rate limiting, momentary server issues) shouldn't fail a classification
// immediately — retry a couple times with backoff. Non-transient errors (bad key, malformed
// response) wouldn't benefit from a retry, so those throw on the first attempt.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [800, 2000];

const MAX_REASON_LENGTH = 160;
function trimReason(reason) {
  if (!reason) return null;
  const trimmed = String(reason).trim();
  return trimmed.length > MAX_REASON_LENGTH ? trimmed.slice(0, MAX_REASON_LENGTH - 1).trimEnd() + '…' : trimmed;
}

const SITE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'integer' },
    is_doorway: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['level', 'is_doorway'],
};

// Sites that are never rated by the model, because the model would rate them wrong.
//
// A search engine's homepage is a logo and a text box. Judged on its own content — which is all the
// classifier ever sees — it reads as harmless and earns the most permissive rating available. The
// moment it is allowed, the allowlist stops meaning anything: the search box reaches every piece of
// content the list exists to keep out, and image search is worse still because the results ARE the
// content and never touch the destination site at all.
//
// So these are decided before the model is asked, and the model's opinion is not consulted. Matched
// on the registrable-ish suffix so regional and country variants are covered — google.co.il has no
// forced-SafeSearch equivalent and is the first thing anyone tries.
const HARD_DOORWAYS = [
  'google.', 'bing.', 'duckduckgo.', 'yandex.', 'yahoo.', 'baidu.', 'ecosia.',
  'startpage.', 'searx.', 'brave.com', 'qwant.', 'ask.com', 'search.marcia.',
  'images.google.', 'tineye.com', 'pinterest.', 'imgur.', 'flickr.',
  'reddit.', 'tumblr.', 'x.com', 'twitter.', 'quora.', '4chan.', 'deviantart.',
];

// True when the hostname is a known doorway, judged before the classifier runs.
export function isHardDoorway(hostname) {
  const h = String(hostname || '').toLowerCase();
  return HARD_DOORWAYS.some((d) => h === d.replace(/\.$/, '') || h.startsWith(d) || h.includes(`.${d}`));
}

// Strict site-appropriateness filter for supervised phones in an Orthodox Jewish (Haredi) yeshiva
// context, mostly-male teenage/young-adult audience. Judges the SITE AS A WHOLE from its hostname
// plus its homepage title and text — this is NOT per-page and NOT per-image scanning. Favors
// strictness: a borderline site just stays blocked until the operator allows it by hand, so the
// cost of a false "block" is low, while a false "allow" opens the entire domain.
const SITE_INSTRUCTIONS = `You are a content filter for supervised phones in an Orthodox Jewish (Haredi) community, rating whole websites onto a strictness ladder. Subscribers pick a rung; a site is shown to everyone at or above the rung you assign.

You are judging the WHOLE SITE from its hostname and homepage, not one page. The rating you give applies to every page on that domain, so judge by what the site is FOR and what a user would predictably reach from it.

Assign "level":
1 - Essential. Torah and Jewish content, education, schools, government, banking, medical, utilities, transport, reference works. Nothing a person on the strictest setting should be denied.
2 - General. News, business, technology, dictionaries, non-clothing shopping, software, maps. Ordinary useful sites with no imagery concerns.
3 - Mainstream. Ordinary sites that routinely show people: sports, travel, general retail including modest clothing, recipes, hobbies.
4 - Permissive. Sites carrying immodest but non-explicit imagery: fashion and swimwear retail, entertainment and celebrity media, general-audience video, mainstream media with such photography.
5 - Never. Pornography, nudity or sexual content; dating and hookup services; gambling and betting; extreme violence or gore; drug, self-harm or hate promotion; anti-religious or heretical content aimed at Orthodox Jews; proxies, VPNs, Tor gateways, alternative DNS resolvers or anything else for circumventing filtering.

Set "is_doorway": true when the site's main function is reaching content it does not itself control - a search engine of any kind, image or video search, an open user-content platform, an image board, a link aggregator, a forum network, or a social feed. This is INDEPENDENT of the level: a doorway may look entirely clean and still be a doorway. When unsure whether something is a doorway, say true.

Rules:
- Being secular, boring or unrelated to Judaism is NOT a reason to rate a site higher.
- Rate by what the site is for, not by an unusual worst case buried inside it.
- When genuinely torn between two rungs, choose the higher (stricter) one. A site rated too strictly gets a short manual review; a site rated too loosely is open to everyone below.
- Anything you cannot confidently place from the hostname, title and text given is level 5.

The "reason" field must be a single short sentence, at most 15 words, stating only the final reason (e.g. "Mainstream sports news." or "Dating service.").`;

async function callGemini(env, requestBody) {
  if (!env.GEMINI_API_KEY) throw new Error('no-api-key');

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(requestBody),
    });

    if (response.ok) return response.json();

    const canRetry = RETRYABLE_STATUSES.has(response.status) && attempt < RETRY_DELAYS_MS.length;
    if (!canRetry) throw new Error(`Gemini API error: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }
}

// Judges a whole site by hostname. title/text come from fetching its homepage server-side (caller
// truncates text). Throws on any Gemini failure; the caller fails closed (keeps the site blocked)
// on error rather than auto-allowing an unjudged site.
export async function classifySite(env, { hostname, title, text }) {
  // Doorways are decided here, not by the model — see HARD_DOORWAYS. Rated 4 rather than 5 because
  // a search engine is not itself objectionable; it is simply only appropriate where doorways are
  // permitted, and levels.js keeps it out of every other rung.
  if (isHardDoorway(hostname)) {
    return { level: 4, isDoorway: true, reason: 'Search or open user-content platform.' };
  }

  const prompt = `${SITE_INSTRUCTIONS}\n\nWebsite: ${hostname}\nHomepage title: ${title || '(none)'}\nHomepage text (truncated): ${text || '(none)'}`;

  const data = await callGemini(env, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: SITE_RESPONSE_SCHEMA,
    },
  });

  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!responseText) throw new Error('Empty Gemini response');

  const parsed = JSON.parse(responseText);

  // Map onto the internal scale (1..4 pass, 5/malformed → NEVER). A malformed rating fails closed:
  // the alternative is an unjudged site silently entering a rung it was never cleared for.
  const level = aiRatingToInternal(parsed.level);
  return { level, isDoorway: parsed.is_doorway === true, reason: trimReason(parsed.reason) };
}

// --- Search queries -----------------------------------------------------------------------------

const QUERY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['level'],
};

// Rating what someone TYPED, rather than where they went.
//
// This is the check the DNS-era system could not make. At DNS the filter sees `www.google.com` and
// nothing more, so approving Google once approves every search anyone will ever run. Reading the
// query means judging intent — "volcano facts" and something deliberately sought are the same
// hostname and a world apart.
//
// Rated on the same 1-5 ladder as sites, so one device level governs both and the two checks cannot
// drift apart.
const QUERY_INSTRUCTIONS = `You are a content filter for supervised phones in an Orthodox Jewish (Haredi) community. You are rating a SEARCH QUERY — words someone typed into a search box — onto a strictness ladder. Subscribers pick a rung; a query is permitted for everyone at or above the rung you assign.

Assign "level":
1 - Essential. Torah and Jewish topics, schoolwork, health, government, banking, travel logistics, practical how-to.
2 - General. News, business, technology, reference, products, sport, recipes, ordinary curiosity.
3 - Mainstream. Entertainment, celebrities, music, films, general culture — nothing sought for its own suggestiveness.
4 - Permissive. Queries likely to surface immodest but non-explicit imagery: fashion, swimwear, beauty, "photos of <public figure>", modelling.
5 - Never. Anything seeking sexual or explicit material however phrased, including euphemism, slang, misspelling or another language; dating or hookups; gambling; graphic violence; drugs; self-harm; how to bypass or disable internet filters.

Rules:
- Judge the INTENT of the words, not whether they are individually innocent. Deliberately oblique phrasing for explicit material is level 5.
- An ordinary word that happens to have a suggestive secondary meaning is not level 5 unless the phrasing points that way.
- Shopping for ordinary clothing is level 3. Shopping for swimwear or lingerie is level 4.
- A query in any language gets the same treatment as its English equivalent.
- When genuinely torn between two rungs, choose the higher (stricter) one.

The "reason" field must be a single short sentence, at most 12 words (e.g. "Ordinary schoolwork topic." or "Seeking explicit material.").`;

// Judges a typed search query. Throws on any Gemini failure; the caller fails closed (blocks the
// search) rather than letting an unjudged query through.
export async function classifySearchQuery(env, { query, engine, isImageSearch }) {
  const context = [
    `Search engine: ${engine || 'unknown'}`,
    isImageSearch ? 'This is an IMAGE search — results are pictures shown directly, not links. Rate one rung stricter than you otherwise would.' : null,
    `Query: ${query}`,
  ].filter(Boolean).join('\n');

  const data = await callGemini(env, {
    contents: [{ parts: [{ text: `${QUERY_INSTRUCTIONS}\n\n${context}` }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: QUERY_RESPONSE_SCHEMA,
    },
  });

  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!responseText) throw new Error('Empty Gemini response');

  const parsed = JSON.parse(responseText);
  // Same bridge and fail-closed as sites: 1..4 pass, a model "5"/malformed → NEVER, so an unjudged
  // or explicit query blocks rather than slipping through at the most open rung.
  const level = aiRatingToInternal(parsed.level);
  return { level, reason: trimReason(parsed.reason) };
}
