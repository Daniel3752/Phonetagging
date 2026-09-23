// Video streaming services — the hosts that carry film and television.
//
// WHY THIS EXISTS AT ALL. The yeshiva tag's browser is a 'blocklist' rung (levels.js
// YESHIVA_LEVELS): allow-by-default, with NO model in the request path. Only the explicit list, the
// social list, a keyword hit on a search, and anything already on file as NEVER refuse a site.
// Netflix is none of those — it is not explicit, it is not social, and nothing rates it — so
// netflix.com was simply allowed on every yeshiva rung, in Chrome and at the TLS handshake that
// decides whether the app is spliced. That is how a phone on rung 3 was watching Netflix.
//
// Removing the APP (the app_rules blocklist, enforced by Headwind) is the other half and the more
// important one, but it cannot be the whole answer: the app is only gone until someone installs it
// again, and it never touched netflix.com in the browser. This module is the network half.
//
// SHAPE. Deliberately the same shape as app-media.js: a pure hostname matcher with no D1, no
// network and no model, so it answers at the TLS handshake — the only moment the proxy ever sees of
// a spliced connection — as well as on Chrome's decrypted requests. Chrome is the reliable case:
// it is pointed at the proxy's browser port, where everything is bumped, so the answer is always
// applied there. At the handshake it is best-effort for the same reason app-media.js moved its
// enforcement into squid (see the app_media_hosts comment in scripts/squid.conf); with the app
// itself removed by Headwind there is normally nothing left to splice.
//
// MATCHED BY WHOLE DOMAIN, not by role. Unlike Spotify's artwork hosts, a streaming service keeps
// nothing worth reaching on these domains — there is no "the music still plays" case to protect —
// so the whole registrable domain goes, including its video CDNs, which live on domains of their
// own (nflxvideo.net, aiv-cdn.net) and would otherwise keep serving after the front door closed.
//
// WHAT IS DELIBERATELY NOT HERE. An ISP that also sells television (Partner, Cellcom, HOT as a
// company) keeps its billing and account pages on the same registrable domain as its TV product.
// Blocking those would take the phone bill with it, so only TV-specific hosts are listed and the
// ISP domains are left alone. Likewise apple.com and play.google.com: the store and the account
// live there and the phone needs them, so only the exact TV hostnames are refused.

import { normalizeHost } from './domains.js';

// Whole registrable domains: the service and every subdomain, including its video CDNs.
const STREAMING_DOMAINS = new Set([
  // Netflix — the front door, the image hosts and the Open Connect video CDN.
  'netflix.com', 'nflxvideo.net', 'nflximg.net', 'nflximg.com', 'nflxso.net', 'nflxext.com',
  // Disney+ — bamgrid and dssott are its streaming and delivery backends.
  'disneyplus.com', 'disney-plus.net', 'bamgrid.com', 'dssott.com', 'starplus.com',
  // Prime Video — aiv-* are the Amazon Instant Video CDNs.
  'primevideo.com', 'amazonvideo.com', 'aiv-cdn.net', 'aiv-delivery.net',
  // Hulu.
  'hulu.com', 'hulustream.com',
  // Max / HBO.
  'max.com', 'hbomax.com', 'hbo.com', 'hbomaxcdn.com', 'discoveryplus.com',
  // Paramount+ / CBS.
  'paramountplus.com', 'cbsivideo.com', 'cbsaavideo.com',
  // Peacock / NBC.
  'peacocktv.com',
  // Plex, Crunchyroll, Mubi, and the other subscription libraries.
  'plex.tv', 'crunchyroll.com', 'mubi.com', 'curiositystream.com', 'vudu.com', 'fubo.tv',
  // Twitch — already an app-level block in the social bucket; the site needs blocking too.
  'twitch.tv', 'ttvnw.net',
  // Israeli television. TV-specific domains only — see the note above about ISP billing pages.
  'sting.tv', 'stingtv.co.il', '13tv.co.il', 'mako.co.il', 'kan.org.il', 'yes.co.il',
]);

// Exact hostnames, where the registrable domain itself must keep working. tv.apple.com is Apple TV+
// while apple.com is the account and the phone's own services.
const STREAMING_HOSTS = new Set([
  'tv.apple.com',
]);

// --- YouTube, which is its own question ----------------------------------------------------------
//
// YouTube is a streaming service, but it is NOT in the lists above, because the rungs disagree about
// it in a way they do not about Netflix. The yeshiva app blocklist puts YouTube in the SOCIAL bucket:
// blocked on rungs 1-3, permitted on rung 4 (the rung that allows the social apps). And rung 3 has a
// per-phone exception, `devices.allow_youtube`, which puts one boy on `yeshiva_rung_3_yt` — rung 3
// with the official app left installed. A flat block would override both of those decisions.
//
// So it gets its own flag (`youtube` in levels.js) and its own matcher, and the proxy consults the
// per-phone exception before applying it.
//
// googlevideo.com is where the video bytes actually come from, so it matters more than youtube.com:
// without it the page loads and nothing plays. It is effectively YouTube-only — Google's other media
// lives on googleusercontent.com — but it is the one entry here worth re-checking if something
// unrelated breaks.
const YOUTUBE_DOMAINS = new Set([
  'youtube.com', 'youtu.be', 'youtube-nocookie.com',
  'ytimg.com',        // thumbnails and page assets
  'googlevideo.com',  // the video CDN: the actual playback bytes
]);

// Exact hosts on domains that must otherwise keep working. Reachable from Chrome, which is bumped on
// the browser port; an APP's call to googleapis is pre-auth exempt and spliced (see squid.conf), so
// this line holds for the browser and is best-effort for the app.
const YOUTUBE_HOSTS = new Set([
  'youtubei.googleapis.com',
]);

// True when this hostname belongs to YouTube.
export function isYoutubeHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return false;
  if (YOUTUBE_HOSTS.has(h)) return true;
  for (const domain of YOUTUBE_DOMAINS) {
    if (h === domain || h.endsWith(`.${domain}`)) return true;
  }
  return false;
}

// True when this hostname belongs to a video streaming service.
export function isStreamingHost(hostname) {
  const h = normalizeHost(hostname);
  if (!h) return false;
  if (STREAMING_HOSTS.has(h)) return true;
  for (const domain of STREAMING_DOMAINS) {
    if (h === domain || h.endsWith(`.${domain}`)) return true;
  }
  return false;
}

// Every host shape this module refuses, for the docs and for a human check. Not used at runtime.
export const STREAMING_EXAMPLES = [
  'netflix.com', 'www.netflix.com', 'ipv4-c001-tlv001-ix.1.oca.nflxvideo.net',
  'disneyplus.com', 'primevideo.com', 'tv.apple.com', 'twitch.tv',
];
