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

// The prompts emit the internal ladder directly: 2..5 is the lowest rung that may see the
// site/query, and 6 is NEVER (blocked at every rung, including the most open). Anything outside 2..6
// — or a malformed response — fails CLOSED to NEVER, so an unjudged item never slips through.
function clampRating(level) {
  const n = Number(level);
  return Number.isInteger(n) && n >= 2 && n <= NEVER_LEVEL ? n : NEVER_LEVEL;
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
const SITE_INSTRUCTIONS = `You are a content filter for supervised phones in an Orthodox Jewish (Haredi) community, rating whole websites onto a strictness ladder. A device is set to a rung 2-5; a site is shown to everyone whose rung is at or above the rating you assign. So the rating is the LOWEST rung allowed to see the site.

You are judging the WHOLE SITE from its hostname and homepage, not one page. The rating applies to every page on that domain, so judge by what the site is FOR and what a user would predictably reach from it.

Assign "level" (2 to 6):
2 - Essential and clean-general. Torah and Jewish content, education, schools, government, banking, medical, utilities, transport, reference works, dictionaries, maps, weather, software docs, and plainly clean general-interest sites with no imagery concerns.
3 - Broader general / informational. Ordinary informational sites a notch beyond the essentials: general knowledge, science, history, hobbies, DIY, non-clothing shopping, business and technology news - useful and clean, just not core.
4 - General, non-shtus. Mainstream sites including entertainment, celebrity and culture media, sports, travel, general retail, recipes - anything a broad audience uses that is NOT immodest and NOT explicit. Ordinary photos of clothed people are fine here.
5 - Immodest / shtus (non-explicit). Sites whose predictable content is immodest though not explicit: fashion and swimwear retail, beauty and modelling, celebrity/paparazzi imagery, general media that leans on such photography.
6 - NEVER. Pornography, nudity or sexual content; dating and hookup services; gambling and betting; extreme violence or gore; drug, self-harm or hate promotion; anti-religious or heretical content aimed at Orthodox Jews; proxies, VPNs, Tor gateways, alternative DNS resolvers or anything else for circumventing filtering.

Set "is_doorway": true when the site's main function is reaching content it does not itself control - a search engine, image/video search, an open user-content platform, an image board, a link aggregator, a forum network, or a social feed. Record it regardless of the level.

Rules:
- Being secular, boring or unrelated to Judaism is NOT a reason to rate a site higher.
- Rate by what the site is FOR, not by an unusual worst case buried inside it.
- The ladder never starts below 2 - there is no rung 1 web. A truly essential clean site is 2.
- When genuinely torn between two rungs, choose the higher (stricter) one. Too strict gets a short manual review; too loose opens the site to everyone below.
- Anything you cannot confidently place from the hostname, title and text given is 6.

The "reason" field must be a single short sentence, at most 15 words (e.g. "Mainstream sports news." or "Fashion retail with immodest imagery.").`;

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
  // Open-content platforms (image boards, UGC, social, aggregators) predictably reach shtus, so
  // they land on the most-open rung only. Recognised search ENGINES are allowed to load their
  // search box at every web rung by isSearchEngineHost in proxy-api.js before this rating is ever
  // consulted, so rating them here as rung-5 costs nothing and keeps the image boards out of 2-4.
  if (isHardDoorway(hostname)) {
    return { level: 5, isDoorway: true, reason: 'Search or open user-content platform.' };
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

  // 2..6 pass through; malformed fails closed to NEVER rather than letting an unjudged site enter a
  // rung it was never cleared for.
  const level = clampRating(parsed.level);
  return { level, isDoorway: parsed.is_doorway === true, reason: trimReason(parsed.reason) };
}

// --- Search queries -----------------------------------------------------------------------------

const QUERY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'integer' },
    images_ok: { type: 'boolean' },
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
const QUERY_INSTRUCTIONS = `You are a content filter for supervised phones in an Orthodox Jewish (Haredi) community. You are rating a SEARCH QUERY — words someone typed into a search box — onto a strictness ladder. A device is set to a rung 2-5; a query is permitted for everyone whose rung is at or above the rating you assign. So the rating is the LOWEST rung allowed to run it.

Assign "level" (2 to 6):
2 - Essential and clean-general. Torah and Jewish topics, schoolwork, health, government, banking, travel logistics, practical how-to, and plainly clean general knowledge (facts, weather, "how X works", definitions).
3 - Broader general / informational. Open-ended curiosity, science, history, hobbies, DIY, product research, ordinary questions that are clean but less essential.
4 - Entertainment and culture (non-shtus). Celebrities, music, films, TV, sports, gaming, general and mainstream shopping — sought for interest, not for suggestive imagery.
5 - Immodest / shtus (non-explicit). Queries whose likely results are immodest though not explicit: fashion, swimwear, lingerie, beauty and modelling, "photos of <woman/public figure>", or seeking women by appearance.
6 - NEVER. Anything seeking sexual or explicit material however phrased — euphemism, slang, misspelling or another language; dating or hookups; gambling; graphic violence; drugs; self-harm; how to bypass or disable internet filters.

Also set "images_ok" (boolean): true normally. Set it FALSE when the query's TEXT answer is legitimate but its IMAGE results could be immodest/shtus — e.g. a medical or anatomical question, "what does <person/thing> look like", appearance-related questions. When false the reader is shown the text results with images stripped, so a useful answer is still delivered without the risky pictures. For a plainly clean query (no image concern) leave it true; for a query rated 5 or 6 it does not matter.

Rules:
- Judge the INTENT of the words, not whether they are individually innocent. Deliberately oblique phrasing for explicit material is 6.
- An ordinary word with a suggestive secondary meaning is not 6 unless the phrasing points that way.
- Shopping for ordinary (modest) clothing is 4. Swimwear, lingerie or immodest clothing is 5.
- A query in any language gets the same treatment as its English equivalent.
- The ladder never starts below 2 — there is no rung 1 search.
- When genuinely torn between two rungs, choose the higher (stricter) one.

The "reason" field must be a single short sentence, at most 12 words (e.g. "Ordinary schoolwork topic." or "Seeking explicit material.").`;

// Judges a typed search query. Returns { level, imagesOk, reason }. Throws on any Gemini failure;
// the caller fails closed (blocks the search) rather than letting an unjudged query through.
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
  // Fail-closed clamp: 2..6 pass through, anything malformed becomes NEVER so an unjudged query
  // blocks rather than slipping through. images_ok defaults to true unless the model set it false.
  const level = clampRating(parsed.level);
  return { level, imagesOk: parsed.images_ok !== false, reason: trimReason(parsed.reason) };
}
