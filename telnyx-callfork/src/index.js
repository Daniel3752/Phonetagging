/**
 * Telnyx TeXML call-fork + callback worker.
 *
 * ---------------------------------------------------------------------------
 * THE ECONOMICS (read this before changing anything)
 * ---------------------------------------------------------------------------
 * Every design decision below exists to avoid exactly one line item:
 *
 *   Telnyx inbound to the US DID .............. $0.005/min
 *   Telnyx Voice API, per leg ................. $0.002/min
 *   Telnyx outbound to a SIP client ........... $0      (termination is free)
 *   Telnyx outbound to an Israeli mobile ...... $0.1096/min, 60/60 billing  <-- the enemy
 *   Me dialing out from HOT ................... included plan minutes (free to me)
 *
 * Billing starts on ANSWER. A leg that rings and is never answered costs $0.
 * So the flip phone is allowed to *ring* for free, but every path here is
 * arranged so it ideally never *answers*: a 12-second chat answered on the flip
 * still bills a full 60 seconds at $0.1096 because of the 60/60 minimum.
 *
 * The cheap path is: fork -> nobody answers -> caller parks in a Telnyx queue
 * -> I dial back IN from the flip on my own plan minutes -> Telnyx only bills
 * the $0.005/min inbound leg. Target spend: ~$1/month (DID rental) + pennies.
 *
 * ---------------------------------------------------------------------------
 * NO STATE. NONE.
 * ---------------------------------------------------------------------------
 * There is no KV, no D1, and above all no Durable Objects — DOs require the
 * Workers paid plan ($5/mo), which is 5x the entire budget of this system.
 * Single user, at most one parked call in practice, and Telnyx's own queue is
 * the state store (FIFO if more than one ever piles up). If a future edit
 * reaches for storage, the answer is almost certainly "use the queue instead".
 *
 * ---------------------------------------------------------------------------
 * TeXML notes (verified against Telnyx docs, not assumed from TwiML)
 * ---------------------------------------------------------------------------
 *   <Dial>     action, method, callerId, timeout (5-120, default 30),
 *              answerOnBridge, sequential
 *   <Number>   statusCallback, statusCallbackEvent, machineDetection
 *              (Enable | DetectMessageEnd | Disable), detectionMode,
 *              machineDetectionTimeout (500-60000, default 3500)
 *   <Sip>      same attribute set as <Number>
 *   <Enqueue>  action, method, waitUrl, waitUrlMethod, maxWaitTimeSecs
 *              (min 1, default 14400); queue name is the element body
 *   <Queue>    (inside <Dial>) url, method
 *   <Play>     loop, mediaStorage, digits, failoverUrl, continueOnError, ringTone
 *
 * Webhooks arrive as POST application/x-www-form-urlencoded (CallSid, From, To,
 * CallStatus, DialCallStatus, QueueResult, ...). Responses are text/xml.
 */

// ---------------------------------------------------------------------------
// Configuration — all values come from wrangler.toml [vars] / wrangler secrets.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  RING_TIMEOUT: 15, // seconds the fork rings before we park the caller
  MAX_HOLD_SECONDS: 60, // how long a parked caller waits for my callback
  QUEUE_NAME: 'parked',
  HOLD_MUSIC_URL: '', // empty -> spoken reassurance instead of music
  GREETING_TEXT: 'One moment please, connecting you.',
  VOICEMAIL_TEXT:
    'Sorry, no one is available right now. Please try again later. Goodbye.',
  HOLD_TEXT: 'Please hold, connecting you now.',
  NO_CALL_WAITING_TEXT: 'There is no call waiting. Goodbye.',
  VOICE: 'female',
  LANGUAGE: 'en-US',
};

function config(env) {
  const num = (v, d) => {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : d;
  };
  return {
    telnyxUsDid: normalizeE164(env.TELNYX_US_DID) || '',
    sipUri: (env.SIP_URI || '').trim(),
    flipNumber: normalizeE164(env.FLIP_NUMBER) || '',
    iphoneHotNumber: normalizeE164(env.IPHONE_HOT_NUMBER) || '',
    // <Dial timeout> is clamped by Telnyx to 5-120; clamp here so a bad var
    // doesn't silently produce XML Telnyx rejects mid-call.
    ringTimeout: clamp(num(env.RING_TIMEOUT, DEFAULTS.RING_TIMEOUT), 5, 120),
    maxHoldSeconds: clamp(
      num(env.MAX_HOLD_SECONDS, DEFAULTS.MAX_HOLD_SECONDS),
      1,
      14400,
    ),
    queueName: (env.QUEUE_NAME || DEFAULTS.QUEUE_NAME).trim(),
    holdMusicUrl: (env.HOLD_MUSIC_URL || DEFAULTS.HOLD_MUSIC_URL).trim(),
    greetingText: env.GREETING_TEXT || DEFAULTS.GREETING_TEXT,
    voicemailText: env.VOICEMAIL_TEXT || DEFAULTS.VOICEMAIL_TEXT,
    holdText: env.HOLD_TEXT || DEFAULTS.HOLD_TEXT,
    noCallWaitingText:
      env.NO_CALL_WAITING_TEXT || DEFAULTS.NO_CALL_WAITING_TEXT,
    voice: env.VOICE || DEFAULTS.VOICE,
    language: env.LANGUAGE || DEFAULTS.LANGUAGE,
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, ''),
    telnyxPublicKey: (env.TELNYX_PUBLIC_KEY || '').trim(),
    allowDryRun: env.ALLOW_DRY_RUN !== 'false',
  };
}

/** Numbers allowed to dequeue a parked caller: my own two Israeli handsets. */
function whitelist(cfg) {
  return [cfg.flipNumber, cfg.iphoneHotNumber].filter(Boolean);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------------------------------------------------------------------------
// Phone number normalization
// ---------------------------------------------------------------------------

/**
 * Best-effort E.164 normalization. Telnyx normally sends E.164, but the
 * whitelist gates the dequeue path, so never trust the wire format: a caller
 * whose ANI merely *looks* like mine must not be able to grab a parked call.
 */
function normalizeE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  // Strip a SIP/tel URI wrapper: sip:+972541234567@sip.telnyx.com, tel:+1...
  const uri = s.match(/^(?:sips?|tel):([^@;?]+)/i);
  if (uri) s = uri[1];

  s = s.replace(/[\s\-().]/g, '');

  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) {
    const d = digits.slice(2);
    return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
  }
  // Israeli national format: 0541234567 -> +972541234567
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 10) {
    return `+972${digits.slice(1)}`;
  }
  // North American 10-digit, and 11-digit starting with 1
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

const sameNumber = (a, b) => {
  const na = normalizeE164(a);
  const nb = normalizeE164(b);
  return Boolean(na && nb && na === nb);
};

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attrs(map) {
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${xmlEscape(v)}"`)
    .join('');
}

const doc = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;

const say = (cfg, text, indent = '  ') =>
  `${indent}<Say${attrs({ voice: cfg.voice, language: cfg.language })}>${xmlEscape(
    text,
  )}</Say>`;

function texmlResponse(xml) {
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'text/xml; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// TeXML documents — one function per branch, all pure so ?dry=1 can render them
// ---------------------------------------------------------------------------

/**
 * BRANCH 1: a stranger calls the US DID (forwarded there by T-Mobile).
 *
 * Fork to both handsets at once with answerOnBridge="true" so the caller hears
 * ringback and the inbound leg is not answered — and therefore not billed —
 * until somebody actually picks up.
 *
 * Leg ordering is deliberate: the <Sip> leg is the leg I *want* answered
 * because SIP termination is $0. The <Number> leg to the flip is the free-to-
 * ring / expensive-to-answer leg ($0.1096/min, 60/60). It is here purely as an
 * alerting mechanism, so I know to reject it and call back on plan minutes.
 *
 * machineDetection on the flip leg is the guard against HOT's carrier
 * voicemail answering the fork: voicemail picking up is a billed answer, and a
 * 3-second "leave a message" prompt costs the full 60-second minimum. Note this
 * is a backstop, not the fix — voicemail must also be disabled on the line
 * itself (see README), because detection takes a moment and that moment is
 * already inside a billed leg.
 */
function forkTexml(cfg, urls) {
  const legs = [];
  if (cfg.sipUri) {
    legs.push(
      `    <Sip>${xmlEscape(cfg.sipUri)}</Sip>`,
    );
  }
  if (cfg.flipNumber) {
    legs.push(
      `    <Number${attrs({
        machineDetection: 'Enable',
        detectionMode: 'Regular',
        machineDetectionTimeout: 3500,
      })}>${xmlEscape(cfg.flipNumber)}</Number>`,
    );
  }
  if (!legs.length) return parkTexml(cfg, urls); // misconfigured: park rather than drop

  return doc(
    `  <Dial${attrs({
      action: urls.dialStatus,
      method: 'POST',
      // Short timeout on purpose: rejecting on the flip does NOT tear down the
      // SIP leg, so the caller waits out the remainder of this timer before
      // being parked. Every second here is dead air the caller hears.
      timeout: cfg.ringTimeout,
      // Israeli carriers reject caller ID you don't own, and I own no Israeli
      // DID — so both outbound legs present the US DID.
      callerId: cfg.telnyxUsDid,
      answerOnBridge: 'true',
    })}>
${legs.join('\n')}
  </Dial>`,
  );
}

/**
 * BRANCH 2: the fork went unanswered (I rejected on the flip, or was
 * unreachable). Park the caller in the fixed-name queue and let them hold.
 *
 * Parking is what makes the callback path possible, and the callback path is
 * what keeps an Israeli-mobile answer off the bill entirely.
 */
function parkTexml(cfg, urls) {
  return doc(
    `${say(cfg, cfg.greetingText)}
  <Enqueue${attrs({
    action: urls.queueAction,
    method: 'POST',
    waitUrl: urls.queueWait,
    waitUrlMethod: 'POST',
    // Cap the hold. An abandoned caller sitting in the queue keeps the $0.005/min
    // inbound leg alive; it's cheap, but there's no reason to pay for silence.
    maxWaitTimeSecs: cfg.maxHoldSeconds,
  })}>${xmlEscape(cfg.queueName)}</Enqueue>`,
  );
}

/**
 * Hold experience. Telnyx re-requests waitUrl once the document finishes, so
 * this loops on its own — no need to guess a repeat count.
 */
function queueWaitTexml(cfg) {
  const body = cfg.holdMusicUrl
    ? `  <Play${attrs({ loop: 1, continueOnError: 'true' })}>${xmlEscape(
        cfg.holdMusicUrl,
      )}</Play>`
    : `${say(cfg, cfg.holdText)}\n  <Pause length="5"/>`;
  return doc(body);
}

/** Hold timer expired (or the caller left the queue un-bridged). */
function holdExpiredTexml(cfg) {
  return doc(`${say(cfg, cfg.voicemailText)}\n  <Hangup/>`);
}

/** The bridged conversation ended — nothing left to do, release the leg. */
function hangupTexml() {
  return doc('  <Hangup/>');
}

/**
 * BRANCH 3: I dial the US DID back from a whitelisted handset.
 *
 * <Dial><Queue> bridges me straight into the parked caller. This is the whole
 * point of the system: my outbound leg came out of HOT plan minutes (free to
 * me), so Telnyx bills only the $0.005/min inbound leg instead of $0.1096/min
 * with a 60-second minimum for terminating to an Israeli mobile.
 *
 * callerId is still the US DID — I own no Israeli number to present.
 */
function dequeueTexml(cfg, urls) {
  return doc(
    `  <Dial${attrs({
      action: urls.dequeueStatus,
      method: 'POST',
      callerId: cfg.telnyxUsDid,
      answerOnBridge: 'true',
    })}>
    <Queue>${xmlEscape(cfg.queueName)}</Queue>
  </Dial>`,
  );
}

/** I called in but nobody was parked. */
function emptyQueueTexml(cfg) {
  return doc(`${say(cfg, cfg.noCallWaitingText)}\n  <Hangup/>`);
}

// ---------------------------------------------------------------------------
// Routing decisions — pure functions of (params, cfg) so they are dry-runnable
// ---------------------------------------------------------------------------

/** Telnyx <Dial> statuses that mean a human actually bridged. */
const ANSWERED_DIAL_STATUSES = new Set(['completed', 'answered']);

function handleInbound(cfg, params, urls) {
  const from = normalizeE164(params.From);
  const allowed = whitelist(cfg);
  const isMine = allowed.some((n) => sameNumber(n, from));
  if (isMine) {
    return { branch: 'callback-dequeue', xml: dequeueTexml(cfg, urls) };
  }
  return { branch: 'fork', xml: forkTexml(cfg, urls) };
}

function handleDialStatus(cfg, params, urls) {
  const status = String(params.DialCallStatus || '').toLowerCase();
  if (ANSWERED_DIAL_STATUSES.has(status)) {
    // Somebody picked up and the conversation is over. Do not re-dial, do not
    // park: an accidental re-dial here would ring the Israeli mobile again.
    return { branch: 'answered-hangup', xml: hangupTexml() };
  }
  // busy | no-answer | failed | canceled -> park the caller for the callback.
  return { branch: 'park', xml: parkTexml(cfg, urls) };
}

function handleQueueAction(cfg, params) {
  const result = String(params.QueueResult || '').toLowerCase();
  // "bridged" (and Telnyx's variants) mean I already got connected and the
  // call is done; anything else means the caller aged out of the queue.
  if (result.includes('bridge') || result === 'completed') {
    return { branch: 'queue-bridged', xml: hangupTexml() };
  }
  return { branch: 'hold-expired', xml: holdExpiredTexml(cfg) };
}

function handleDequeueStatus(cfg, params) {
  const status = String(params.DialCallStatus || '').toLowerCase();
  if (ANSWERED_DIAL_STATUSES.has(status)) {
    return { branch: 'dequeue-completed', xml: hangupTexml() };
  }
  // Empty queue: the <Dial><Queue> returns immediately with a non-answered
  // status. Tell me so, and hang up.
  return { branch: 'queue-empty', xml: emptyQueueTexml(cfg) };
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

const ROUTES = {
  '/voice/inbound': handleInbound,
  '/voice/dial-status': handleDialStatus,
  '/voice/queue-wait': null, // static document, handled inline
  '/voice/queue-action': handleQueueAction,
  '/voice/dequeue-status': handleDequeueStatus,
};

function buildUrls(cfg, request) {
  const base = cfg.publicBaseUrl || new URL(request.url).origin;
  return {
    inbound: `${base}/voice/inbound`,
    dialStatus: `${base}/voice/dial-status`,
    queueWait: `${base}/voice/queue-wait`,
    queueAction: `${base}/voice/queue-action`,
    dequeueStatus: `${base}/voice/dequeue-status`,
  };
}

/** Read webhook params from a form-encoded body, falling back to the query string. */
async function readParams(request, rawBody) {
  const params = {};
  const url = new URL(request.url);
  for (const [k, v] of url.searchParams) params[k] = v;
  const ct = request.headers.get('content-type') || '';
  if (rawBody && ct.includes('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(rawBody)) params[k] = v;
  } else if (rawBody && ct.includes('application/json')) {
    try {
      Object.assign(params, JSON.parse(rawBody));
    } catch {
      /* ignore malformed JSON — treated as no params */
    }
  }
  return params;
}

/**
 * Telnyx signs webhooks with Ed25519: the signed message is
 * `${telnyx-timestamp}|${rawBody}` and the signature arrives base64 in
 * `telnyx-signature-ed25519`. The public key is in the portal under
 * Account Settings > Keys & Credentials > Public Key.
 *
 * If TELNYX_PUBLIC_KEY is unset we fail open (so you can get a first call
 * working), but the dequeue path is separately gated by the ANI whitelist, so
 * an arbitrary caller still cannot grab a parked call.
 */
async function verifySignature(request, rawBody, cfg) {
  if (!cfg.telnyxPublicKey) return { ok: true, checked: false };

  const signature = request.headers.get('telnyx-signature-ed25519');
  const timestamp = request.headers.get('telnyx-timestamp');
  if (!signature || !timestamp) {
    return { ok: false, checked: true, reason: 'missing signature headers' };
  }

  // Reject stale signatures (replay window: 5 minutes).
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) {
    return { ok: false, checked: true, reason: 'stale timestamp' };
  }

  const keyBytes = base64ToBytes(cfg.telnyxPublicKey);
  const sigBytes = base64ToBytes(signature);
  const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);

  // Older Workers compatibility dates expose Ed25519 as "NODE-ED25519"; newer
  // ones use the standard "Ed25519". Try both so the deploy isn't hostage to
  // the compatibility_date in wrangler.toml.
  for (const algorithm of [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }]) {
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, algorithm, false, ['verify']);
      const ok = await crypto.subtle.verify(algorithm, key, sigBytes, message);
      return { ok, checked: true, reason: ok ? undefined : 'bad signature' };
    } catch {
      /* try the next algorithm spelling */
    }
  }
  return { ok: false, checked: true, reason: 'ed25519 unavailable in runtime' };
}

function base64ToBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default {
  async fetch(request, env) {
    const cfg = config(env);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const urls = buildUrls(cfg, request);

    if (path === '/' || path === '/health') {
      return Response.json({
        ok: true,
        service: 'telnyx-callfork',
        queue: cfg.queueName,
        ringTimeout: cfg.ringTimeout,
        maxHoldSeconds: cfg.maxHoldSeconds,
        signatureVerification: cfg.telnyxPublicKey ? 'enabled' : 'disabled',
        configured: {
          did: Boolean(cfg.telnyxUsDid),
          sip: Boolean(cfg.sipUri),
          flip: Boolean(cfg.flipNumber),
          iphone: Boolean(cfg.iphoneHotNumber),
        },
        routes: Object.keys(ROUTES),
      });
    }

    // ---- Dry run -----------------------------------------------------------
    // Renders the exact TeXML a branch would return, with no signature check
    // and no call in flight, so every branch can be eyeballed before a live
    // number is ever pointed at this worker. Zero minutes burned.
    const dry = url.searchParams.get('dry') === '1';
    if (dry) {
      if (!cfg.allowDryRun) return new Response('dry run disabled', { status: 403 });
      const rawBody = request.method === 'POST' ? await request.text() : '';
      const params = await readParams(request, rawBody);
      const result = renderBranch(path, cfg, params, urls);
      if (!result) return new Response('unknown route', { status: 404 });
      const wantsJson = url.searchParams.get('format') === 'json';
      return wantsJson
        ? Response.json({ route: path, branch: result.branch, params, xml: result.xml })
        : new Response(result.xml, {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'x-branch': result.branch,
            },
          });
    }

    if (!(path in ROUTES)) return new Response('not found', { status: 404 });
    if (request.method !== 'POST' && request.method !== 'GET') {
      return new Response('method not allowed', { status: 405 });
    }

    const rawBody = request.method === 'POST' ? await request.text() : '';
    const sig = await verifySignature(request, rawBody, cfg);
    if (!sig.ok) {
      console.warn(`rejected ${path}: ${sig.reason}`);
      return new Response('invalid signature', { status: 403 });
    }

    const params = await readParams(request, rawBody);
    const result = renderBranch(path, cfg, params, urls);
    if (!result) return new Response('not found', { status: 404 });

    console.log(
      JSON.stringify({
        route: path,
        branch: result.branch,
        callSid: params.CallSid,
        from: normalizeE164(params.From),
        dialCallStatus: params.DialCallStatus,
        queueResult: params.QueueResult,
        signatureChecked: sig.checked,
      }),
    );
    return texmlResponse(result.xml);
  },
};

function renderBranch(path, cfg, params, urls) {
  if (path === '/voice/queue-wait') {
    return { branch: 'queue-wait', xml: queueWaitTexml(cfg) };
  }
  const handler = ROUTES[path];
  if (!handler) return null;
  return handler(cfg, params, urls);
}

// Exported for local reasoning/tests; unused by the Worker runtime itself.
export {
  normalizeE164,
  forkTexml,
  parkTexml,
  queueWaitTexml,
  dequeueTexml,
  handleInbound,
  handleDialStatus,
  handleQueueAction,
  handleDequeueStatus,
  config,
};
