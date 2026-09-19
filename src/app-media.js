// In-app media hosts: the image and video CDNs that a pinned, spliced app fetches its pictures from.
//
// The proxy cannot see inside Spotify (it pins its certificate and is spliced so it keeps working),
// so nothing can be stripped from a page the way the browser's images are. But Spotify serves its
// artwork, playlist mosaics and Canvas videos from hostnames of their own, separate from the audio
// and API hosts, and a hostname is visible at the TLS handshake before anything is encrypted. Refuse
// those hosts and the app plays music against blank artwork — images off inside the app, at the
// network, with nothing installed on the phone.
//
// This is a whole-hostname decision, so it only works for apps that keep media on dedicated hosts.
// Instagram and WhatsApp serve pictures and everything else from the same CDNs and cannot be handled
// this way; that needs an on-device service (see NEXT-SESSION.md).
//
// The Play Store is the other clean case: every icon, screenshot and promo picture in the store comes
// from play-lh.googleusercontent.com, while installs, updates and sign-in use other hosts entirely
// (android.clients.google.com, play.googleapis.com, the gvt1 download CDN). With that one host refused
// the store still searches, installs and updates; it just shows blank tiles. NOTE: the proxy splices
// all of googleusercontent.com for Google account media, so the Worker's answer here only takes
// effect once squid asks about this host before splicing it — see the app_media_hosts ACL in
// scripts/squid.conf.
//
// WHY THIS IS NOT A FIXED HOST LIST. It was, and Spotify walked straight around it: the published
// lists name image-cdn-ak (Akamai) and image-cdn-fa (Fastly), and a live phone fetched its Canvas
// videos from video-cf.spotifycdn.com — the same CDN role behind Cloudflare, a suffix nobody had
// written down. Spotify names these hosts by ROLE and then by provider, so the role is the stable
// part and the provider is not. Matching the role survives the next provider; matching the exact
// host does not. The rule below is deliberately an allowlist of roles rather than a denylist, so a
// host whose role is unknown keeps working rather than silently breaking the app.

// NOTE ON ENFORCEMENT. Squid no longer asks this module at the TLS handshake: it matches the same
// roles itself (`app_media_hosts` in scripts/squid.conf) and BUMPS the connection, because an
// external-ACL answer proved unreliable at that moment — see the comment there. The bumped
// request then reaches this module through the helper, and the image_blocked answer below is the
// refusal (a pinned client never gets that far: it rejects the certificate first). Which PHONES that
// applies to is still per-rung, and still the Worker's answer: squid reads the allowed tunnel
// addresses from a file that scripts/sync-media-on.sh rewrites from /api/proxy/media-on. This
// module still answers for Chrome's decrypted requests and is the readable statement of what
// counts as in-app media, so the two must be kept in step.

import { normalizeHost } from './domains.js';

// Domains whose subdomains are split by role this way. A host outside these is never matched here.
const SPOTIFY_DOMAINS = ['scdn.co', 'spotifycdn.com', 'cdn.spotify.com', 'spotify.com'];

// Role labels that carry pictures or video. Matched against the host's FIRST label, exactly.
// 'p' is deliberately absent: p.scdn.co serves the 30-second MP3 previews (p.scdn.co/mp3-preview/…),
// and a preview is music, not a picture.
const SPOTIFY_MEDIA_LABELS = new Set([
  // Artwork, avatars, playlist covers, generated playlist art.
  'i', 'o', 't', 'pl', 'misc', 'mosaic', 'fex', 'daylist', 'concerts', 'pickasso',
  'charts-images', 'daily-mix', 'dailymix-images', 'lineup-images', 'merch-img', 'newjams-images',
  'profile-images', 'seeded-session-images', 'seed-mix-image', 'thisis-images', 'wrapped-images',
  'lexicon-assets', 'mixed-media-images', 'heads-fa-tls13',
  // Canvas (the looping video behind a track) and video podcasts.
  'canvaz', 'podz-content',
]);

// Role PREFIXES, matched against the first label. This is what catches a provider suffix nobody has
// seen yet: image-cdn-ak, image-cdn-fa, image-cdn-cf, video-fa, video-cf, video-akpcw, video4-ak …
const SPOTIFY_MEDIA_PREFIXES = ['image-cdn', 'image-', 'video-', 'video4', 'mosaic-'];

// Roles that must NEVER be refused whatever else matches: the music itself, the API, DJ audio.
// Checked first, so a future 'audio-video-…' oddity cannot cost the user their music.
const SPOTIFY_KEEP_PREFIXES = ['audio', 'spclient', 'apresolve', 'dealer', 'gew', 'guc', 'dj-'];

function endsWithDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isSpotifyMedia(host) {
  if (!SPOTIFY_DOMAINS.some((d) => endsWithDomain(host, d))) return false;
  const first = host.split('.')[0];
  if (SPOTIFY_KEEP_PREFIXES.some((p) => first.startsWith(p))) return false;
  if (SPOTIFY_MEDIA_LABELS.has(first)) return true;
  return SPOTIFY_MEDIA_PREFIXES.some((p) => first.startsWith(p));
}

// The Play Store's pictures, all of them, on one host. Exact: the rest of googleusercontent carries
// the account's own photos and mail attachments and must keep working.
function isPlayMedia(host) {
  return host === 'play-lh.googleusercontent.com';
}

const MATCHERS = [
  ['spotify', isSpotifyMedia],
  ['play', isPlayMedia],
];

// The app whose media host this is, or null.
export function appMediaHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return null;
  for (const [app, matches] of MATCHERS) {
    if (matches(h)) return app;
  }
  return null;
}

// Every host shape this module refuses, for the docs and for a human check. Not used at runtime.
export const APP_MEDIA_EXAMPLES = {
  spotify: ['i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com', 'image-cdn-cf.spotifycdn.com',
    'video-fa.scdn.co', 'video-cf.spotifycdn.com', 'canvaz.scdn.co', 'pickasso.spotifycdn.com'],
  play: ['play-lh.googleusercontent.com'],
};
