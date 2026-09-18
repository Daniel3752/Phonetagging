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
// Sources for the Spotify list: techlockdown.com "block images and videos on Spotify" and
// cameronpak.com "block image and video CDN domains for Spotify", cross-checked. Deliberately NOT
// a wildcard on scdn.co or spotifycdn.com: audio-fa.scdn.co and friends carry the music itself.

import { normalizeHost } from './domains.js';

export const APP_MEDIA_HOSTS = {
  spotify: [
    // Artwork, avatars, playlist covers, generated playlist art.
    'i.scdn.co', 'mosaic.scdn.co', 'o.scdn.co', 't.scdn.co', 'p.scdn.co', 'pl.scdn.co', 'misc.scdn.co',
    'charts-images.scdn.co', 'daily-mix.scdn.co', 'dailymix-images.scdn.co', 'lineup-images.scdn.co',
    'merch-img.scdn.co', 'newjams-images.scdn.co', 'profile-images.scdn.co', 'seeded-session-images.scdn.co',
    'image-cdn-ak.spotifycdn.com', 'image-cdn-fa.spotifycdn.com', 'seed-mix-image.spotifycdn.com',
    'thisis-images.spotifycdn.com', 'pickasso.spotifycdn.com', 'mixed-media-images.spotifycdn.com',
    'wrapped-images.spotifycdn.com', 'daylist.spotifycdn.com', 'lexicon-assets.spotifycdn.com',
    'concerts.spotifycdn.com', 'misc.spotifycdn.com', 'fex.spotifycdn.com', 'heads-fa-tls13.spotifycdn.com',
    // Canvas (the looping video behind a track) and video podcasts. If music playback ever breaks
    // after this list is applied, these are the ones to suspect first.
    'canvaz.scdn.co', 'video-fa.scdn.co', 'video-akpcw.spotifycdn.com', 'video-akpcw-cdn-spotify-com.akamaized.net',
    'video-fa.cdn.spotify.com', 'video-fa-b.cdn.spotify.com', 'video4-ak.spotify.com', 'podz-content.spotifycdn.com',
  ],
  play: [
    // Icons, screenshots and promo images in the Play Store app. Nothing else lives here.
    'play-lh.googleusercontent.com',
  ],
};

// One flat lookup: host -> app. Built once at module load.
const HOST_TO_APP = new Map();
for (const [app, hosts] of Object.entries(APP_MEDIA_HOSTS)) {
  for (const h of hosts) HOST_TO_APP.set(normalizeHost(h), app);
}

// The app whose media host this is, or null. A listed host matches itself and any subdomain of
// itself (x.i.scdn.co), never a sibling (audio-fa.scdn.co is not under i.scdn.co).
export function appMediaHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return null;
  const labels = h.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const app = HOST_TO_APP.get(labels.slice(i).join('.'));
    if (app) return app;
  }
  return null;
}
