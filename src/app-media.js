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
// this way; that needs an on-device service (see companion/ for WhatsApp's Updates tab).
//
// The Play Store is the other clean case: every icon, screenshot and promo picture in the store comes
// from play-lh.googleusercontent.com, while installs, updates and sign-in use other hosts entirely
// (android.clients.google.com, play.googleapis.com, the gvt1 download CDN). With that one host refused
// the store still searches, installs and updates; it just shows blank tiles.
//
// ONE SOURCE OF TRUTH FOR THREE ENFORCERS. squid terminates these hosts at the handshake with a
// regex (`app_media_hosts` in scripts/squid.conf, also carried by apply-yeshiva-squid.sh for
// patching a live server); the strict resolver refuses to resolve the exact hosts (dnsmasq, see
// scripts/install-dns-policy.sh — DNS is what stops the app riding an already-open audio
// connection to fetch pictures, which no SNI rule can see); and this module answers the Worker's
// own checks. The squid regex strings are BUILT HERE and exported, the Worker matches with the
// same regexes, and test/app-media.test.mjs fails if squid.conf or the patch script carries a
// different string. Edit the lists below, run the test, paste the printed regex where it says.
//
// WHY ROLES AND WORDS, NOT A FIXED HOST LIST. Spotify names these hosts by ROLE and then by
// provider — image-cdn-ak (Akamai), image-cdn-fa (Fastly), and a live phone fetched Canvas video
// from video-cf.spotifycdn.com, the same role behind Cloudflare, a suffix nobody had written down.
// The role is the stable part. So a host is media when its first label is a known role (i, mosaic,
// canvaz, pickasso …) OR carries a media word between hyphens (image, images, img, video, canvas,
// thumb, cover, artwork …): seed-mix-image, dailymix-images, video4-ak, mixed-media-images all
// match without being listed. And a host is NEVER media when its first label starts with a role
// that carries the music or the API — audio*, heads* (the first seconds of a track, prefetched),
// spclient*, apresolve, dealer, login5, clienttoken, the access points, DJ, previews (p.scdn.co),
// podcasts (anon-podcast). That KEEP list is checked first, here and in squid (`app_keep_hosts`,
// negated on the terminate rule), so widening the media words can never cost the user their music.
//
// Also known and deliberately NOT here: Spotify's own ads and the podcast/audiobook catalogue ride
// spclient; nothing about them is a hostname decision.

import { normalizeHost } from './domains.js';

// Domains whose subdomains are named by role this way. A host outside these is never media.
export const SPOTIFY_DOMAINS = ['scdn.co', 'spotifycdn.com', 'spotify.com', 'pscdn.co'];

// Exact first labels that carry pictures or video but have no media word in their name.
// (i = album/artist/show art, the client's image-url template; mosaic = playlist collages;
// misc = static covers such as Liked Songs, on both domains; o and t = older image hosts, role
// attested by community lists only; daylist/concerts/fex/lexicon-assets sit under Spotify's own
// image GSLB; canvaz = Canvas loops, both domains; podz-content = podcast clips/previews.)
export const SPOTIFY_MEDIA_LABELS = [
  'i', 'o', 't', 'misc', 'mosaic', 'canvaz', 'pickasso', 'daylist', 'concerts', 'fex',
  'daily-mix', 'lexicon-assets', 'podz-content',
];

// Words that mark a label as media when they stand between hyphens (or at either end).
export const SPOTIFY_MEDIA_WORDS = [
  'image', 'images', 'img', 'video[0-9]*', 'videos', 'canvas', 'canvaz', 'thumb', 'thumbs',
  'thumbnail', 'thumbnails', 'cover', 'covers', 'artwork', 'mosaic', 'pickasso', 'picasso',
];

// Role PREFIXES that must never be refused whatever else matches. Checked first.
// (audio* = the tracks, chosen per track among Fastly/Akamai/Cloudflare/GCP hosts; heads* = the
// first 128 kB of a track, prefetched, heads-fa-tls13.spotifycdn.com on Android — NOT artwork,
// whatever some lists say; seektables = seek tables for playback; spclient/apresolve/dealer/
// login5/clienttoken/accounts/api/exp = the API, sign-in and access points, regional ones as
// gew4-/guc3-/gae2-/gue1-spclient and -dealer; ap-* = the access points themselves; dj-* = DJ
// audio; upgrade = client updates; episode-transcripts, tts, sharing-config = other non-picture
// services.)
export const SPOTIFY_KEEP_PREFIXES = [
  'audio', 'heads', 'seektables', 'spclient', 'apresolve', 'dealer', 'login', 'clienttoken',
  'accounts', 'api', 'exp', 'ap-', 'ap\\.', 'mobile-ap', 'dj-', 'anon-podcast', 'podcast', 'encore',
  'open', 'www', 'sdk', 'download', 'upgrade', 'episode', 'tts', 'sharing', 'gew', 'guc', 'gae',
  'gue', 'connect', 'partner', 'pathfinder', 'quic', 'wg',
];
// Exact first labels that must never be refused: p.scdn.co is the 30-second MP3 previews (the
// client's audio-preview-url-template), not pictures.
export const SPOTIFY_KEEP_LABELS = ['p'];

// --- The regexes, built once, shared with squid --------------------------------------------------

const alt = (xs) => xs.join('|');
const dom = alt(SPOTIFY_DOMAINS.map((d) => d.replace(/\./g, '\\.')));
const words = alt(SPOTIFY_MEDIA_WORDS);
// A label: known role, or hyphen-separated words with a media word among them.
const mediaLabel = `(${alt(SPOTIFY_MEDIA_LABELS)}|([a-z0-9]+-)*(${words})(-[a-z0-9]+)*)`;
// Spotify's Akamai hosts carry the whole name in one label: video-akpcw-cdn-spotify-com.akamaized.net.
const akamai = `(([a-z0-9]+-)*(${words})(-[a-z0-9]+)*-spotify-com\\.akamaized\\.net)`;

// POSIX ERE, case-insensitive, anchored: what squid's ssl::server_name_regex gets, verbatim.
// The optional trailing dot: normalizeHost strips one for the Worker, and squid must agree with
// the Worker on an SNI written as an FQDN (RFC 6066 forbids it, clients do it anyway).
export const SQUID_APP_MEDIA_REGEX =
  `^((${mediaLabel}\\.(${dom}))|${akamai}|play-lh\\.googleusercontent\\.com)\\.?$`;
export const SQUID_APP_KEEP_REGEX =
  `^((${alt(SPOTIFY_KEEP_LABELS)})\\.|(${alt(SPOTIFY_KEEP_PREFIXES)})[a-z0-9-]*\\.)`;

const MEDIA_RE = new RegExp(SQUID_APP_MEDIA_REGEX, 'i');
const KEEP_RE = new RegExp(SQUID_APP_KEEP_REGEX, 'i');

function isSpotifyMedia(host) {
  if (KEEP_RE.test(host)) return false;
  return MEDIA_RE.test(host) && host !== 'play-lh.googleusercontent.com';
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

// The exact media hosts seen on live phones and in Spotify's published lists — what the strict
// resolver refuses (scripts/sync-media-on.sh writes them for dnsmasq). DNS has no regex, so this
// list is what it can do; the squid regex above covers the shapes nobody has seen yet. Keep a
// host here once it has been seen with pictures on it.
// Every one of these resolved on 2026-09-21; names that no longer exist (pl, profile-images,
// image-cdn-cf, video-ak.scdn.co, the video*.cdn.spotify.com family) were dropped, not because
// they would hurt in a resolver but so this list stays a list of facts.
export const APP_MEDIA_DNS_HOSTS = {
  spotify: [
    // scdn.co — the Fastly pool that also carries audio-fa (http/1.1 only, so each of these
    // opens its own handshake and the squid rule sees it; DNS is belt and braces here).
    'i.scdn.co', 'o.scdn.co', 't.scdn.co', 'misc.scdn.co', 'mosaic.scdn.co', 'canvaz.scdn.co',
    'video-fa.scdn.co', 'charts-images.scdn.co', 'daily-mix.scdn.co', 'dailymix-images.scdn.co',
    'lineup-images.scdn.co', 'merch-img.scdn.co', 'newjams-images.scdn.co',
    'seeded-session-images.scdn.co', 'thisis-images.scdn.co',
    // spotifycdn.com — the Fastly pool that negotiates h2 and shares its address and its
    // *.spotifycdn.com certificate with heads-fa / audio-fa-quic / misc-fa: the pool where a
    // picture request can ride an open connection to an allowed host with no handshake of its
    // own. DNS is what stops that; the squid rule cannot see it.
    'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com', 'misc.spotifycdn.com',
    'canvaz.spotifycdn.com', 'pickasso.spotifycdn.com', 'daylist.spotifycdn.com',
    'concerts.spotifycdn.com', 'fex.spotifycdn.com', 'seed-mix-image.spotifycdn.com',
    'thisis-images.spotifycdn.com', 'wrapped-images.spotifycdn.com', 'lexicon-assets.spotifycdn.com',
    'mixed-media-images.spotifycdn.com', 'blend-playlist-covers.spotifycdn.com',
    'adstudio-video-preview-image.spotifycdn.com', 'podz-content.spotifycdn.com',
    'video-cf.spotifycdn.com', 'video-akpcw.spotifycdn.com',
    // Akamai, one label carrying the whole name.
    'video-akpcw-cdn-spotify-com.akamaized.net', 'video-ak-cdn-spotify-com.akamaized.net',
  ],
  play: ['play-lh.googleusercontent.com'],
};

// Every host shape this module refuses, for the docs and for a human check. Not used at runtime.
export const APP_MEDIA_EXAMPLES = {
  spotify: ['i.scdn.co', 'mosaic.scdn.co', 'image-cdn-ak.spotifycdn.com', 'image-cdn-cf.spotifycdn.com',
    'video-fa.scdn.co', 'video-cf.spotifycdn.com', 'canvaz.scdn.co', 'pickasso.spotifycdn.com',
    'seed-mix-image.spotifycdn.com', 'blend-playlist-covers.spotifycdn.com',
    'video-akpcw-cdn-spotify-com.akamaized.net', 'video-ak-cdn-spotify-com.akamaized.net'],
  play: ['play-lh.googleusercontent.com'],
};
// And the shapes it must never refuse.
export const SPOTIFY_KEEP_EXAMPLES = ['audio-fa.scdn.co', 'audio4-fa.scdn.co', 'audio-fa-tls13.spotifycdn.com',
  'audio-akp-quic-control.spotifycdn.com', 'audio-fa-quic.spotifycdn.com', 'audio-gm.spotifycdn.com',
  'heads-fa.scdn.co', 'heads-fa-tls13.spotifycdn.com', 'heads4-ak-spotify-com.akamaized.net', 'seektables.scdn.co',
  'p.scdn.co', 'anon-podcast.scdn.co', 'spclient.wg.spotify.com', 'gew1-spclient.spotify.com', 'guc3-spclient.spotify.com',
  'apresolve.spotify.com', 'ap-gew4.spotify.com', 'ap.spotify.com', 'mobile-ap.spotify.com', 'dealer.spotify.com',
  'gue1-dealer.spotify.com', 'login5.spotify.com', 'clienttoken.spotify.com', 'dj-earcons.spotifycdn.com',
  'audio-ak-spotify-com.akamaized.net', 'audio-sp-ams.pscdn.co', 'upgrade.scdn.co', 'misc-fa.spotifycdn.com',
  'episode-transcripts.spotifycdn.com', 'tts.spotifycdn.com'];
