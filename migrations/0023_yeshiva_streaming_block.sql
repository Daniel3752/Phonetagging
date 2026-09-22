-- Video streaming services, blocked on every yeshiva rung. GENERATED from the STREAMING bucket in
-- scripts/build-yeshiva-seed.mjs (which also writes 0016) — edit the generator, not this file.
--
-- WHY THIS EXISTS. A phone on yeshiva rung 3 was watching Netflix, and both halves of the filter
-- let it:
--
--   The APP half. The yeshiva blocklist rungs (3, 4) named the social apps, the dating and
--   explicit-capable apps, the other browsers and the VPNs — and no streaming service at all, so
--   Headwind never removed one. Rungs 1 and 2 are ALLOWLISTS, which sounds stricter and is not:
--   pushPolicyApps (src/headwind.js) only ever issues a REMOVE for a package with an explicit
--   'blocked' row, and never removes an app merely for being absent from an allow list. Enforcing
--   an allowlist properly needs the no_install_apps restriction, which is deliberately NOT applied
--   because it would stop the boys installing anything at all. So on rungs 1 and 2 — the two
--   strictest rungs — an installed Netflix stayed installed and working.
--
--   The WEB half. The yeshiva browser is allow-by-default with no model in the request path: only
--   the explicit list, the social list, a keyword hit on a search or a NEVER already on file
--   refuse a site. Netflix is none of those, so netflix.com loaded in Chrome, and the same answer
--   at the TLS handshake is what spliced the app's own traffic through untouched. That half is
--   fixed in src/streaming.js + `streaming: false` in levels.js, and the two must be kept in step:
--   the app is only gone until someone installs it again, and the site was always reachable.
--
-- Rung 4 is included on purpose. It is the rung that permits the social apps, so the obvious home
-- for these would have been the social bucket next to YouTube and Twitch; they are a different
-- thing, in that a streaming service's entire product is filmed drama rather than a feed that can
-- carry it. To let streaming back in at rung 4, delete its rows here, drop STREAMING from the
-- rung-4 bucket in the generator, and set `streaming: true` on rung 4 in levels.js.
--
-- Several package names are best-guess PLACEHOLDERS (marked CONFIRM in the generator), especially
-- the Israeli broadcasters. A wrong one is harmless — there is nothing to remove — and should be
-- reconciled against Headwind's installed-apps list on a real phone.
--
-- Re-runnable: these rows are cleared for the four yeshiva rungs, then reinserted. Nothing else in
-- app_rules is touched, so the 99-package blocklist each rung already carries survives.

DELETE FROM app_rules
 WHERE policy_id IN ('yeshiva_rung_1', 'yeshiva_rung_2', 'yeshiva_rung_3', 'yeshiva_rung_4')
   AND package_name IN (
     'com.netflix.mediaclient',
     'com.netflix.NGPClient',
     'com.disney.disneyplus',
     'com.amazon.avod.thirdpartyclient',
     'com.amazon.amazonvideo.livingroom',
     'com.hulu.plus',
     'com.wbd.stream',
     'com.hbo.hbonow',
     'com.cbs.app',
     'com.peacocktv.peacockandroid',
     'com.apple.atve.android.appletv',
     'com.google.android.videos',
     'com.plexapp.android',
     'com.crunchyroll.crunchyroid',
     'tv.fubo.mobile',
     'com.mubi',
     'com.vudu.android.app',
     'com.mxtech.videoplayer.ad',
     'com.sting.tv',
     'com.yes.yesplus',
     'il.co.hot.hotplus',
     'com.partner.tv',
     'com.cellcom.cellcomtv',
     'il.co.mako.mako',
     'com.reshet.tv',
     'il.org.kan.kan'
   );

INSERT INTO app_rules (policy_id, package_name, state)
VALUES
  ('yeshiva_rung_1', 'com.netflix.mediaclient', 'blocked'),
  ('yeshiva_rung_1', 'com.netflix.NGPClient', 'blocked'),
  ('yeshiva_rung_1', 'com.disney.disneyplus', 'blocked'),
  ('yeshiva_rung_1', 'com.amazon.avod.thirdpartyclient', 'blocked'),
  ('yeshiva_rung_1', 'com.amazon.amazonvideo.livingroom', 'blocked'),
  ('yeshiva_rung_1', 'com.hulu.plus', 'blocked'),
  ('yeshiva_rung_1', 'com.wbd.stream', 'blocked'),
  ('yeshiva_rung_1', 'com.hbo.hbonow', 'blocked'),
  ('yeshiva_rung_1', 'com.cbs.app', 'blocked'),
  ('yeshiva_rung_1', 'com.peacocktv.peacockandroid', 'blocked'),
  ('yeshiva_rung_1', 'com.apple.atve.android.appletv', 'blocked'),
  ('yeshiva_rung_1', 'com.google.android.videos', 'blocked'),
  ('yeshiva_rung_1', 'com.plexapp.android', 'blocked'),
  ('yeshiva_rung_1', 'com.crunchyroll.crunchyroid', 'blocked'),
  ('yeshiva_rung_1', 'tv.fubo.mobile', 'blocked'),
  ('yeshiva_rung_1', 'com.mubi', 'blocked'),
  ('yeshiva_rung_1', 'com.vudu.android.app', 'blocked'),
  ('yeshiva_rung_1', 'com.mxtech.videoplayer.ad', 'blocked'),
  ('yeshiva_rung_1', 'com.sting.tv', 'blocked'),
  ('yeshiva_rung_1', 'com.yes.yesplus', 'blocked'),
  ('yeshiva_rung_1', 'il.co.hot.hotplus', 'blocked'),
  ('yeshiva_rung_1', 'com.partner.tv', 'blocked'),
  ('yeshiva_rung_1', 'com.cellcom.cellcomtv', 'blocked'),
  ('yeshiva_rung_1', 'il.co.mako.mako', 'blocked'),
  ('yeshiva_rung_1', 'com.reshet.tv', 'blocked'),
  ('yeshiva_rung_1', 'il.org.kan.kan', 'blocked'),
  ('yeshiva_rung_2', 'com.netflix.mediaclient', 'blocked'),
  ('yeshiva_rung_2', 'com.netflix.NGPClient', 'blocked'),
  ('yeshiva_rung_2', 'com.disney.disneyplus', 'blocked'),
  ('yeshiva_rung_2', 'com.amazon.avod.thirdpartyclient', 'blocked'),
  ('yeshiva_rung_2', 'com.amazon.amazonvideo.livingroom', 'blocked'),
  ('yeshiva_rung_2', 'com.hulu.plus', 'blocked'),
  ('yeshiva_rung_2', 'com.wbd.stream', 'blocked'),
  ('yeshiva_rung_2', 'com.hbo.hbonow', 'blocked'),
  ('yeshiva_rung_2', 'com.cbs.app', 'blocked'),
  ('yeshiva_rung_2', 'com.peacocktv.peacockandroid', 'blocked'),
  ('yeshiva_rung_2', 'com.apple.atve.android.appletv', 'blocked'),
  ('yeshiva_rung_2', 'com.google.android.videos', 'blocked'),
  ('yeshiva_rung_2', 'com.plexapp.android', 'blocked'),
  ('yeshiva_rung_2', 'com.crunchyroll.crunchyroid', 'blocked'),
  ('yeshiva_rung_2', 'tv.fubo.mobile', 'blocked'),
  ('yeshiva_rung_2', 'com.mubi', 'blocked'),
  ('yeshiva_rung_2', 'com.vudu.android.app', 'blocked'),
  ('yeshiva_rung_2', 'com.mxtech.videoplayer.ad', 'blocked'),
  ('yeshiva_rung_2', 'com.sting.tv', 'blocked'),
  ('yeshiva_rung_2', 'com.yes.yesplus', 'blocked'),
  ('yeshiva_rung_2', 'il.co.hot.hotplus', 'blocked'),
  ('yeshiva_rung_2', 'com.partner.tv', 'blocked'),
  ('yeshiva_rung_2', 'com.cellcom.cellcomtv', 'blocked'),
  ('yeshiva_rung_2', 'il.co.mako.mako', 'blocked'),
  ('yeshiva_rung_2', 'com.reshet.tv', 'blocked'),
  ('yeshiva_rung_2', 'il.org.kan.kan', 'blocked'),
  ('yeshiva_rung_3', 'com.netflix.mediaclient', 'blocked'),
  ('yeshiva_rung_3', 'com.netflix.NGPClient', 'blocked'),
  ('yeshiva_rung_3', 'com.disney.disneyplus', 'blocked'),
  ('yeshiva_rung_3', 'com.amazon.avod.thirdpartyclient', 'blocked'),
  ('yeshiva_rung_3', 'com.amazon.amazonvideo.livingroom', 'blocked'),
  ('yeshiva_rung_3', 'com.hulu.plus', 'blocked'),
  ('yeshiva_rung_3', 'com.wbd.stream', 'blocked'),
  ('yeshiva_rung_3', 'com.hbo.hbonow', 'blocked'),
  ('yeshiva_rung_3', 'com.cbs.app', 'blocked'),
  ('yeshiva_rung_3', 'com.peacocktv.peacockandroid', 'blocked'),
  ('yeshiva_rung_3', 'com.apple.atve.android.appletv', 'blocked'),
  ('yeshiva_rung_3', 'com.google.android.videos', 'blocked'),
  ('yeshiva_rung_3', 'com.plexapp.android', 'blocked'),
  ('yeshiva_rung_3', 'com.crunchyroll.crunchyroid', 'blocked'),
  ('yeshiva_rung_3', 'tv.fubo.mobile', 'blocked'),
  ('yeshiva_rung_3', 'com.mubi', 'blocked'),
  ('yeshiva_rung_3', 'com.vudu.android.app', 'blocked'),
  ('yeshiva_rung_3', 'com.mxtech.videoplayer.ad', 'blocked'),
  ('yeshiva_rung_3', 'com.sting.tv', 'blocked'),
  ('yeshiva_rung_3', 'com.yes.yesplus', 'blocked'),
  ('yeshiva_rung_3', 'il.co.hot.hotplus', 'blocked'),
  ('yeshiva_rung_3', 'com.partner.tv', 'blocked'),
  ('yeshiva_rung_3', 'com.cellcom.cellcomtv', 'blocked'),
  ('yeshiva_rung_3', 'il.co.mako.mako', 'blocked'),
  ('yeshiva_rung_3', 'com.reshet.tv', 'blocked'),
  ('yeshiva_rung_3', 'il.org.kan.kan', 'blocked'),
  ('yeshiva_rung_4', 'com.netflix.mediaclient', 'blocked'),
  ('yeshiva_rung_4', 'com.netflix.NGPClient', 'blocked'),
  ('yeshiva_rung_4', 'com.disney.disneyplus', 'blocked'),
  ('yeshiva_rung_4', 'com.amazon.avod.thirdpartyclient', 'blocked'),
  ('yeshiva_rung_4', 'com.amazon.amazonvideo.livingroom', 'blocked'),
  ('yeshiva_rung_4', 'com.hulu.plus', 'blocked'),
  ('yeshiva_rung_4', 'com.wbd.stream', 'blocked'),
  ('yeshiva_rung_4', 'com.hbo.hbonow', 'blocked'),
  ('yeshiva_rung_4', 'com.cbs.app', 'blocked'),
  ('yeshiva_rung_4', 'com.peacocktv.peacockandroid', 'blocked'),
  ('yeshiva_rung_4', 'com.apple.atve.android.appletv', 'blocked'),
  ('yeshiva_rung_4', 'com.google.android.videos', 'blocked'),
  ('yeshiva_rung_4', 'com.plexapp.android', 'blocked'),
  ('yeshiva_rung_4', 'com.crunchyroll.crunchyroid', 'blocked'),
  ('yeshiva_rung_4', 'tv.fubo.mobile', 'blocked'),
  ('yeshiva_rung_4', 'com.mubi', 'blocked'),
  ('yeshiva_rung_4', 'com.vudu.android.app', 'blocked'),
  ('yeshiva_rung_4', 'com.mxtech.videoplayer.ad', 'blocked'),
  ('yeshiva_rung_4', 'com.sting.tv', 'blocked'),
  ('yeshiva_rung_4', 'com.yes.yesplus', 'blocked'),
  ('yeshiva_rung_4', 'il.co.hot.hotplus', 'blocked'),
  ('yeshiva_rung_4', 'com.partner.tv', 'blocked'),
  ('yeshiva_rung_4', 'com.cellcom.cellcomtv', 'blocked'),
  ('yeshiva_rung_4', 'il.co.mako.mako', 'blocked'),
  ('yeshiva_rung_4', 'com.reshet.tv', 'blocked'),
  ('yeshiva_rung_4', 'il.org.kan.kan', 'blocked');
