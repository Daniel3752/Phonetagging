// What the Shmira companion app (companion/) asks the Worker: "what should I enforce on this phone?"
//
// The companion is the on-device half of the filter — the part that acts INSIDE an app the network
// cannot see into. Today that is WhatsApp's Updates tab (Status and Channels): the same pinned
// socket carries the chats and the feed, so no proxy rule can separate them, and the companion's
// accessibility guard closes the tab on the phone instead. Which phones it does that on is a rung
// property (levels.js whatsappUpdates), and this endpoint is how the rung reaches the phone. The
// shiur lock reaches it the same way: while the policy in force locks the phone (a shiur window,
// or "Locked now"), the feed is closed on every rung — the same resolution the proxy uses.
//
// Identity is the tunnel address, exactly as on the proxy path: the companion reads its own
// WireGuard address (10.66.0.x) off the VPN interface and sends it as `user`, and the Worker looks
// it up in devices.proxy_user like every helper lookup. There is no credential, so the answer
// carries nothing worth reading: two booleans and the detection rules, which are also in the APK.
// It does NOT name the phone, its tag or its rung — the route is world-reachable, and a walk of
// 10.66.0.1-254 must not be a fleet inventory. The request itself cannot be tampered with short of
// rooting the phone: it goes through the tunnel, where squid splices .workers.dev.
//
// Fails CLOSED. An unknown address, a missing parameter, a database error, anything thrown — all
// answer with the strictest policy: block. The companion for its part blocks until its first
// answer, and stops honouring a cached "allowed" that it has not been able to refresh for a few
// hours (PolicyClient.ALLOW_MAX_AGE_MS), so a phone moved to a stricter rung while the Worker was
// unreachable closes the feed by itself.

import { resolveDevice } from './proxy-api.js';
import { COMPANION_RULES, COMPANION_RULES_VERSION } from './companion-rules.js';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

const STRICTEST = { known_device: false, whatsapp: { block_updates: true } };

// The policy for a resolved device (proxy-api.js resolveDevice), or the strictest one.
export function companionPolicyFor(device) {
  if (!device || !device.known || !device.def) return { ...STRICTEST };
  return {
    known_device: true,
    whatsapp: { block_updates: !!device.locked || !device.def.whatsappUpdates },
  };
}

// GET /api/companion/policy?user=10.66.0.3
export async function handleCompanionPolicy(request, env, now = new Date()) {
  let policy;
  try {
    const url = new URL(request.url);
    const user = String(url.searchParams.get('user') || '').trim();
    policy = companionPolicyFor(user ? await resolveDevice(env, user, now) : null);
  } catch {
    policy = { ...STRICTEST };
  }
  return json({ ...policy, rules_version: COMPANION_RULES_VERSION, rules: COMPANION_RULES });
}
