// Gemini proxy for URL classification. The API key lives only as a wrangler secret (GEMINI_API_KEY),
// never shipped anywhere client-side. The prompt and response schema are fixed here, so this can
// only ever be used for this project's own site-appropriateness classification, not as a general
// LLM proxy.
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

// Gemini refusing to process a page is not an inconclusive result here — for a content filter it is
// the strongest available signal that the page is explicit. Raised as its own error type so the
// caller can record a real 'blocked' verdict instead of the retryable "couldn't check" it would
// otherwise show for exactly the worst sites.
export class SafetyBlockedError extends Error {
  constructor(detail) {
    super(`Gemini refused to classify the page: ${detail}`);
    this.name = 'SafetyBlockedError';
  }
}

// finishReason values that mean the model stopped because of content, not because it was done.
const SAFETY_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

const MAX_REASON_LENGTH = 160;
function trimReason(reason) {
  if (!reason) return null;
  const trimmed = String(reason).trim();
  return trimmed.length > MAX_REASON_LENGTH ? trimmed.slice(0, MAX_REASON_LENGTH - 1).trimEnd() + '…' : trimmed;
}

const URL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    safe: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['safe'],
};

// Strict site-appropriateness filter for supervised phones in an Orthodox Jewish (Haredi) yeshiva
// context, mostly-male teenage/young-adult audience. Judges the SITE from its URL + title + text —
// this is NOT per-image scanning. Favors strictness: a borderline site just stays blocked until
// the operator allows it by hand, so the cost of a false "block" is low.
const URL_INSTRUCTIONS = `You are a strict content filter deciding whether a website should be auto-allowed on a supervised phone at an Orthodox Jewish (Haredi) yeshiva, for a mostly-male teenage/young-adult audience. You are judging the SITE, not a single image — favor strictness on anything ambiguous, since the alternative for a borderline site is just a short manual review, not a permanent block.

Mark "safe": false (block) for:
- Pornography, nudity, or sexually explicit content of any kind
- Dating or hookup apps/sites
- Gambling or betting sites
- Extreme violence or gore
- Content promoting drug use, self-harm, or hate
- Anti-religious or explicitly anti-Orthodox/heretical content
- Sites primarily built around immodest imagery (lingerie, swimwear, fashion sites centered on that), even without explicit nudity
- Anything you cannot confidently classify from the URL, title, and text given — when genuinely unsure, prefer "safe": false

Mark "safe": true for ordinary sites: educational content, Torah/Jewish content, news, reference (Wikipedia, dictionaries), business/finance/banking, technology, shopping (non-immodest), sports, health, and similar everyday browsing. Being boring, secular, or unrelated to Judaism is NOT a reason to block.

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

// Judges a single URL. title/text come from fetching the page server-side (caller truncates text).
// Throws on any Gemini failure; the caller fails closed (keeps the site blocked) on error rather
// than auto-allowing an unjudged site.
export async function classifyUrl(env, { url, title, text }) {
  const prompt = `${URL_INSTRUCTIONS}\n\nURL: ${url}\nPage title: ${title || '(none)'}\nPage text (truncated): ${text || '(none)'}`;

  const data = await callGemini(env, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: URL_RESPONSE_SCHEMA,
    },
  });

  // The prompt itself was refused (the page text tripped Gemini's own filters).
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) throw new SafetyBlockedError(`prompt blocked (${blockReason})`);

  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && SAFETY_FINISH_REASONS.has(finishReason)) {
    throw new SafetyBlockedError(`generation stopped (${finishReason})`);
  }

  const responseText = candidate?.content?.parts?.[0]?.text;
  if (!responseText) throw new Error('Empty Gemini response');

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Structured output should make this impossible, but a malformed body must never read as
    // "safe" by accident — fail closed, and let the caller retry rather than caching it.
    throw new Error('Unparseable Gemini response');
  }
  return { safe: parsed.safe === true, reason: trimReason(parsed.reason) };
}
