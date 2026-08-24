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
const GEMINI_MODEL = 'gemini-flash-lite-latest';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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
    safe: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['safe'],
};

// Strict site-appropriateness filter for supervised phones in an Orthodox Jewish (Haredi) yeshiva
// context, mostly-male teenage/young-adult audience. Judges the SITE AS A WHOLE from its hostname
// plus its homepage title and text — this is NOT per-page and NOT per-image scanning. Favors
// strictness: a borderline site just stays blocked until the operator allows it by hand, so the
// cost of a false "block" is low, while a false "allow" opens the entire domain.
const SITE_INSTRUCTIONS = `You are a strict content filter deciding whether an entire website should be auto-allowed on a supervised phone at an Orthodox Jewish (Haredi) yeshiva, for a mostly-male teenage/young-adult audience.

You are judging the WHOLE SITE from its hostname and homepage, not a single page. Allowing it allows every page on that domain, so judge it by what the site is FOR and what a user would predictably reach from it. Favor strictness on anything ambiguous — the alternative for a borderline site is a short manual review, not a permanent block.

Mark "safe": false (block) for:
- Pornography, nudity, or sexually explicit content of any kind
- Dating or hookup apps/sites
- Gambling or betting sites
- Extreme violence or gore
- Content promoting drug use, self-harm, or hate
- Anti-religious or explicitly anti-Orthodox/heretical content
- Sites primarily built around immodest imagery (lingerie, swimwear, fashion sites centered on that), even without explicit nudity
- Sites whose main purpose is hosting unmoderated user-generated media, image boards, or adult-adjacent communities, even if the homepage itself looks harmless
- Proxies, VPNs, Tor gateways, alternative DNS resolvers, or anything else whose purpose is circumventing web filtering
- Anything you cannot confidently classify from the hostname, title, and text given — when genuinely unsure, prefer "safe": false

Mark "safe": true for ordinary sites: educational content, Torah/Jewish content, news, reference (Wikipedia, dictionaries), business/finance/banking, technology, shopping (non-immodest), sports, health, government services, and similar everyday browsing. Being boring, secular, or unrelated to Judaism is NOT a reason to block.

The "reason" field must be a single short sentence, at most 15 words, stating only the final reason (e.g. "News site, no concerning content." or "Dating app.").`;

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
  return { safe: parsed.safe === true, reason: trimReason(parsed.reason) };
}
