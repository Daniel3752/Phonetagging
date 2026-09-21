// What the Shmira companion app (companion/) asks the Worker: "what should I enforce on this phone?"
//
// The companion is the on-device half of the filter — the part that acts INSIDE an app the network
// cannot see into. Today that is WhatsApp's Updates tab (Status and Channels): the same pinned
// socket carries the chats and the feed, so no proxy rule can separate them, and the companion's
// accessibility guard closes the tab on the phone instead. Which phones it does that on is a rung
// property (levels.js whatsappUpdates), and this endpoint is how the rung reaches the phone.
//
// Identity is the tunnel address, exactly as on the proxy path: the companion reads its own
// WireGuard address (10.66.0.x) off the VPN interface and sends it as `user`, and the Worker looks
// it up in devices.proxy_user like every helper lookup. There is no credential: the answer holds
// nothing secret (a few booleans and the detection rules the guard uses, which are also in the
// APK), and the phone reaches this host through the tunnel, where squid splices .workers.dev, so
// the request cannot be tampered with short of rooting the phone.
//
// Fails CLOSED. An unknown address, a missing parameter or a database error all answer with the
// strictest policy: block. The companion also treats "could not fetch" as block. A phone that is
// not on the books must not be the one phone with the feed open.

import { levelDefinition, normalizeDeviceLevel, normalizeTag } from './levels.js';
import { COMPANION_RULES, COMPANION_RULES_VERSION } from './companion-rules.js';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

// The policy for a device row, or the strictest one when there is no row.
export function companionPolicyFor(row) {
  if (!row) {
    return { known_device: false, tag: null, level: null, whatsapp: { block_updates: true } };
  }
  const tag = normalizeTag(row.tag);
  const level = normalizeDeviceLevel(row.level, tag);
  const def = levelDefinition(level, tag);
  return {
    known_device: true, device: row.id, tag, level,
    whatsapp: { block_updates: !(def && def.whatsappUpdates) },
  };
}

// GET /api/companion/policy?user=10.66.0.3
export async function handleCompanionPolicy(request, env) {
  const url = new URL(request.url);
  const user = String(url.searchParams.get('user') || '').trim();
  let row = null;
  if (user) {
    row = await env.DB.prepare('SELECT id, level, tag FROM devices WHERE proxy_user = ?')
      .bind(user).first().catch(() => null);
  }
  return json({
    ...companionPolicyFor(row),
    rules_version: COMPANION_RULES_VERSION,
    rules: COMPANION_RULES,
  });
}
