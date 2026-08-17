# Telnyx Call Fork + Callback

A Cloudflare Worker that serves TeXML to Telnyx so one **US DID** rings **two Israeli phones**,
and — when neither answers — parks the caller in a queue so I can dial back in on **free HOT plan
minutes** instead of paying Israeli mobile termination.

> This directory is self-contained and unrelated to the `phone-url-filter` project at the repo root.
> Deploy it from inside `telnyx-callfork/`.

## Why it's shaped like this (the cost model)

| Path | Cost |
|---|---|
| Telnyx inbound to the US DID | $0.005/min |
| Telnyx Voice API, per leg | $0.002/min |
| Telnyx outbound to a SIP client | **$0** |
| Telnyx outbound to an Israeli mobile | **$0.1096/min, 60/60 billing** |
| Me dialing out from HOT | included plan minutes (free to me) |

Two facts drive everything:

1. **Billing starts on answer.** A leg that rings and is rejected costs nothing.
2. **Israeli mobile termination is the only expensive thing here**, and it bills in 60-second
   blocks. A 12-second chat answered on the flip costs $0.11.

So the flip phone is allowed to *ring* (free) but should not *answer*. I reject it, the caller lands
in a Telnyx queue, and I call the DID back from HOT — my outbound leg is free to me and Telnyx only
bills the $0.005/min inbound leg.

**Target spend: ~$1/month** (DID rental) plus pennies of usage. Everything runs on the Cloudflare
Workers **free tier**.

## No state, by design

There is no KV, no D1, and **no Durable Objects**. DOs require the Workers paid plan ($5/mo) — five
times this project's entire budget — and KV's eventual consistency is useless for sub-second call
state anyway. A single fixed queue name (`parked`) holds all the state there is; Telnyx handles FIFO
if more than one caller ever piles up. If a future edit reaches for storage, the answer is almost
certainly "use the queue".

## Call flow

```
  Stranger --> T-Mobile US number --(unconditional forward)--> Telnyx US DID
                                                                    |
                                                          POST /voice/inbound
                                                                    |
                                         ANI on whitelist? ---yes---+--> <Dial><Queue>parked</Queue>
                                                | no                        (bridge me to the caller)
                                                v
                    <Dial answerOnBridge timeout=15> <Sip> + <Number w/ AMD>
                                                |
                                    somebody answered? ---yes---> bridged, done
                                                | no
                                     POST /voice/dial-status
                                                v
                              "one moment" + <Enqueue maxWaitTimeSecs=60>parked
                                                |
                       I press-and-hold speed dial on the flip --> back to /voice/inbound
```

### Routes

| Route | Fires when | Returns |
|---|---|---|
| `POST /voice/inbound` | Any inbound call to the DID | Fork, or dequeue if the ANI is whitelisted |
| `POST /voice/dial-status` | `<Dial>` action, fork ended | Park the caller, or hang up if it was answered |
| `POST /voice/queue-wait` | `waitUrl`, while parked | Hold music / hold line (Telnyx re-requests it in a loop) |
| `POST /voice/queue-action` | Caller leaves the queue | Hang up if bridged, else voicemail prompt |
| `POST /voice/dequeue-status` | `<Dial><Queue>` ended | Hang up, or "no call waiting" if the queue was empty |
| `GET /health` | — | JSON config summary |

## Configuration

> **⚠️ This repository is public. The four identity values are secrets, not `[vars]`.**
> Writing your real DID, SIP URI, or Israeli numbers into `wrangler.toml` publishes them
> permanently — git history preserves them even after an edit. An exposed SIP URI in particular is a
> standing target for toll-fraud scanners. Set them with `wrangler secret put`; the Worker reads
> secrets and vars identically.

**Secrets** — never committed:

| Secret | Meaning |
|---|---|
| `TELNYX_US_DID` | Inbound DID, callback target, and `callerId` on every outbound leg |
| `SIP_URI` | `sip:credential@sip.telnyx.com` — the softphone leg |
| `FLIP_NUMBER` | Israeli flip phone, `+9725…` — also on the callback whitelist |
| `IPHONE_HOT_NUMBER` | Israeli iPhone SIM, `+9725…` — also on the callback whitelist |
| `TELNYX_PUBLIC_KEY` | Telnyx portal → *Account Settings → Keys & Credentials → Public Key* |

```bash
npx wrangler secret put TELNYX_US_DID
npx wrangler secret put SIP_URI
npx wrangler secret put FLIP_NUMBER
npx wrangler secret put IPHONE_HOT_NUMBER
npx wrangler secret put TELNYX_PUBLIC_KEY
```

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill it in there.

**Non-sensitive vars** — safe to commit, in `wrangler.toml` `[vars]`:

| Var | Meaning | Default |
|---|---|---|
| `RING_TIMEOUT` | Fork ring seconds (Telnyx clamps 5–120) | `15` |
| `MAX_HOLD_SECONDS` | Max park time | `60` |
| `QUEUE_NAME` | Fixed queue name | `parked` |
| `HOLD_MUSIC_URL` | MP3/WAV URL; empty → spoken hold line | empty |
| `PUBLIC_BASE_URL` | Force absolute callback URLs; unset → derived from the request origin | unset |
| `ALLOW_DRY_RUN` | Set `"false"` to disable `?dry=1` in production | `"true"` |

With `TELNYX_PUBLIC_KEY` set, every webhook is verified as an Ed25519 signature over `{telnyx-timestamp}|{raw body}`
from the `telnyx-signature-ed25519` header, with a 5-minute replay window. Without it the worker
fails open — but the dequeue path is separately gated by the ANI whitelist
(`[FLIP_NUMBER, IPHONE_HOT_NUMBER]`, compared after E.164 normalization), so a stranger still can't
grab a parked call.

Deploy:

```bash
cd telnyx-callfork
npm install
npx wrangler deploy
```

## Testing without burning minutes

Every branch is renderable with no call in flight.

**Offline, no wrangler, no account:**

```bash
node scripts/dry-run.mjs      # prints the TeXML for all nine branches
```

**Against a running worker** (`npx wrangler dev`, or the deployed URL) — add `?dry=1` and pass the
webhook params in the query string. No signature check, no call:

```bash
# stranger calls -> should fork
curl 'http://localhost:8787/voice/inbound?dry=1&From=%2B14155550123'

# I call from the flip -> should dequeue
curl 'http://localhost:8787/voice/inbound?dry=1&From=%2B972500000000'

# fork went unanswered -> should park
curl 'http://localhost:8787/voice/dial-status?dry=1&DialCallStatus=no-answer'

# fork was answered -> should hang up, NOT re-dial
curl 'http://localhost:8787/voice/dial-status?dry=1&DialCallStatus=completed'

# hold loop, queue timeout, empty-queue callback
curl 'http://localhost:8787/voice/queue-wait?dry=1'
curl 'http://localhost:8787/voice/queue-action?dry=1&QueueResult=hangup'
curl 'http://localhost:8787/voice/dequeue-status?dry=1&DialCallStatus=no-answer'

# machine-readable, with the chosen branch name
curl 'http://localhost:8787/voice/inbound?dry=1&format=json&From=%2B14155550123'
```

Set `ALLOW_DRY_RUN = "false"` once you're satisfied.

---

# Setup

## 1. Telnyx console

1. **Buy the DID.** *Numbers → Search & Buy Numbers* → a US local number. ~$1/month. Under
   *My Numbers*, make sure it's set to **Voice**.

2. **Create the TeXML Application.** *Voice → TeXML Applications → Create*.
   - **Voice URL / Webhook URL**: `https://<your-worker>.workers.dev/voice/inbound`, method **POST**
   - Leave the failover URL blank or point it at the same route.
   - Assign the DID to this application (*My Numbers → the number → Connection/Application*).

3. **Create the SIP credential** for the iPhone softphone.
   *Voice → SIP Connections → Create → Credentials* connection. Note the username, password, and
   the realm (`sip.telnyx.com`). `SIP_URI` is then `sip:<username>@sip.telnyx.com`. Register the
   softphone (Groundwire, Zoiper, Linphone…) against it with **push/background registration on**,
   otherwise the SIP leg won't ring when the phone is asleep and you'll fall through to the
   expensive path more often than necessary.

4. **⚠️ Enable Israel on the Outbound Voice Profile.** This is the single most common reason "the
   flip never rings", and it has **two** gates, one of which is a human approval that can take a
   day or more — do it first, not last.

   By default **every** Outbound Voice Profile allows traffic to the **US and Canada only**. A call
   to `+972` is rejected with:

   ```
   SIP 403 — Dialed Number is not included in whitelisted countries D13
   ```

   1. **Level 2 verification.** Most international destinations require it before they can be
      activated. Request it in the portal (you'll be prompted when you try to add a restricted
      region, or via *Account Settings → Verification*). This is a manual review — expect a wait,
      and expect to supply business/identity details.
   2. **Whitelist the region.** *Voice → Outbound Voice Profiles →* your profile *→ Destinations*,
      then click the **`+`** next to the region containing Israel (you can add individual countries,
      whole continents, or everything). Approval at step 1 does **not** whitelist anything by
      itself — this step is always manual.

   Then attach that profile to the TeXML Application, and set a **daily spend limit** on it while
   you're here — it's the cheapest insurance against a loop dialing Israel at $0.1096/min.

5. Grab the **public key** (*Account Settings → Keys & Credentials → Public Key*) and set it as the
   `TELNYX_PUBLIC_KEY` secret.

## 2. T-Mobile unconditional call forwarding

From the US handset, dial:

```
**21*<TELNYX_US_DID>#      then press call     (enable)
##21#                      then press call     (disable)
##002#                     then press call     (clear all forwarding rules)
*#21#                      then press call     (check current status)
```

Use the full `+1XXXXXXXXXX` form. Unconditional (`**21*`) is what you want — not busy/no-answer
conditional forwarding — so the T-Mobile SIM never rings and never involves its own voicemail.
Confirm with `*#21#` before relying on it. The SIM stays a normal line; nothing is ported.

## 3. Flip phone speed dial

On most feature phones: **Contacts → the DID entry → Options → Assign speed dial → key 2–9**
(key 1 is usually reserved for voicemail). Then press-and-hold that key to call back into the
parked caller.

Save the DID in **full international form** (`+1XXXXXXXXXX`) so it dials correctly from Israel.
Place it on a key you can find without looking — you'll be pressing it seconds after rejecting a
call.

If `+1…` doesn't connect from the flip, save it with HOT's international access prefix instead:
**`017`** + country code + number, i.e. `0171XXXXXXXXXX`. Some Israeli international bundles are
priced per *carrier prefix* (`012`, `013`, `014`, `015`, `017`…), so the prefix you dial can decide
whether the call comes out of your bundle or is billed à la carte — see below.

## 3b. HOT plan international minutes

**Working assumption: the HOT plan includes outgoing minutes to the US**, so the callback leg is
free and the cost model in this README holds as written.

That assumption is the load-bearing one for the whole design — if it's ever wrong, the callback path
stops being free and the economics invert (see *Known tradeoffs*). Steps to re-check it, should the
plan change:

- **HOT Mobile app / self-service** on [hotmobile.co.il](https://www.hotmobile.co.il): look for
  שיחות לחו״ל ("calls abroad") in your plan details, and specifically whether the **US** is in the
  included-destinations list and how many minutes.
- **Call `*053`** and ask directly: *"Does my plan include outgoing minutes to the United States,
  how many per month, and which dialing prefix do I have to use to get the bundle rate?"* That last
  part matters — see the `017` note above.
- **Empirical check:** call the DID from the flip once, let the worker answer, hang up, then look at
  your next HOT itemized bill (פירוט שיחות) for that call. Bundle minutes show as included; anything
  else shows a charge.

If the US ever **isn't** included, the callback path still works — it just isn't free, and you should
compare HOT's per-minute international rate against the $0.1096/min + 60-second minimum you'd pay by
answering on the flip instead.

## 4. ⚠️ Disable HOT Mobile voicemail on **both** Israeli lines

This is not optional. **A voicemail pickup is an answered leg**: Telnyx bills it at $0.1096/min
with a 60-second minimum, so HOT's voicemail greeting costs eleven cents every time it catches a
forked call — the exact charge this whole system exists to avoid. Worse, it happens silently.

- HOT Mobile customer service: **`*053`** (or `*0053`) from a HOT line, `053-500-3000` /
  `1-800-800-053` otherwise, `+972-53-500-3000` from abroad. Ask to **cancel the voicemail service
  (תא קולי)** on both numbers — "cancel the service", not "turn off the greeting". You can also do
  it in the HOT Mobile app / self-service area on
  [hotmobile.co.il](https://www.hotmobile.co.il) if it's exposed there for your plan.
- The `##002#` and `##61#` / `##62#` / `##67#` GSM codes clear the network-side no-answer, busy, and
  unreachable diversions that route to voicemail. Dial them from each Israeli handset. Note HOT may
  re-provision voicemail on a SIM swap or plan change — recheck after either.
- Verify: call each Israeli number from another phone and let it ring out. You should get the
  network's "not answering" treatment, **not** a voicemail greeting.

The `machineDetection="Enable"` attribute on the `<Number>` leg is a backstop for the case where
voicemail sneaks back — but detection takes a few hundred milliseconds *inside an already-answered,
already-billed leg*. Disabling voicemail at the carrier is the actual fix.

---

# Known tradeoffs

These are accepted, not bugs. Don't "fix" them without redoing the cost math.

- **Rejecting on the flip doesn't instantly end the fork.** The `<Sip>` leg keeps ringing until
  `RING_TIMEOUT` expires, so the park is delayed by the remainder of that timer. A short
  `RING_TIMEOUT` (15s) mitigates it; shortening it further starts costing you legitimate answers on
  the free SIP leg.
- **The caller hears roughly 15–25 seconds** of ringing plus the "one moment" prompt before I'm
  bridged in. That's the price of the callback pattern.
- **The callback leg is free only because the HOT plan includes international minutes to the US.**
  That is the assumption this system is built on (§3b). If the plan ever changes, dialing the US DID
  from HOT costs HOT's international rate instead of nothing — potentially worse than just answering
  on the flip, at which point the callback path is no longer the cheap option and the design should
  be revisited rather than patched. Watch the dialing prefix too: bundle rates can be tied to
  HOT's `017` prefix.
- `machineDetection` reduces but does not eliminate voicemail-answer billing (see above).
- One fixed queue means one parked caller at a time in practice. A second simultaneous caller queues
  behind the first and gets bridged on a second callback. Fine for a single-user system; there is no
  way to choose *which* parked caller you reach.
