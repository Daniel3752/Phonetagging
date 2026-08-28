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

// Proxy passwords are typed by hand — by the operator at setup, and by whoever is holding the phone
// if Chrome ever forgets them. So they are short and unambiguous rather than maximally strong:
// three groups of three from an alphabet with no i/l/1 or o/0 to misread, hyphenated to be readable
// aloud over the phone.
//
// ~45 bits of entropy. That is weak for a key and ample for this: the credential only buys filtered
// browsing at one device's rung, squid stores it bcrypt-hashed, and a remote guessing attack against
// a proxy is neither cheap nor rewarding.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 31 chars, no ambiguous glyphs

export function generateProxyPassword(groups = 3, groupSize = 3) {
  const n = groups * groupSize;
  const out = [];
  // Rejection sampling: 256 is not a multiple of 31, so plain modulo would bias the first few
  // letters. Cheap to do correctly, so do it correctly.
  const limit = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;
  while (out.length < n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    for (const b of bytes) {
      if (b >= limit) continue;
      out.push(PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]);
      if (out.length === n) break;
    }
  }
  return Array.from({ length: groups }, (_, i) => out.slice(i * groupSize, (i + 1) * groupSize).join('')).join('-');
}

// A login derived from the phone's label: "Cohen family — Dovid" -> "cohen-family-dovid".
// Squid's passwd file and our own validation both want a narrow character set.
export function proxyUserFromLabel(label, fallback = 'phone') {
  const slug = String(label || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug.length >= 2 ? slug : fallback;
}
