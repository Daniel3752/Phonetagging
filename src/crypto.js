// Small crypto helpers (Web Crypto, native to Workers — no dependencies).

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Cache key for url_verdicts — SHA-256 of the URL rather than the raw URL as the primary key, so an
// arbitrarily long URL (query strings, tracking params) never hits D1 key-size limits.
export async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return toHex(digest);
}

// Constant-time string compare for the operator API key — avoids leaking, via response timing, how
// many leading characters of the key were correct.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
