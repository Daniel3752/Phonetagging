-- Two things, both about YouTube, found when YouTube turned out to be working on yeshiva rung 3.
--
-- ===== 1. A `youtube` column on device_overrides =====
--
-- So the per-phone test bench can toggle YouTube on one handset like anything else. NOT re-runnable
-- (SQLite has no ADD COLUMN IF NOT EXISTS); apply once through `npm run db:migrate`.
--
-- ===== 2. THE REAL BUG: yeshiva_rung_3_yt never got the streaming block =====
--
-- migrations/0020 builds `yeshiva_rung_3_yt` — rung 3 with the official YouTube app left installed,
-- for the one boy granted it — by COPYING rung 3's rules at the moment 0020 runs:
--
--     INSERT INTO app_rules (policy_id, package_name, state)
--       SELECT 'yeshiva_rung_3_yt', package_name, state FROM app_rules
--        WHERE policy_id = 'yeshiva_rung_3' AND package_name <> 'com.google.android.youtube';
--
-- A copy, not a view. So every rule added to rung 3 AFTER 0020 ran is missing from it, and
-- migrations/0023 added 26 streaming packages to rung 3 and never touched _yt. A phone on the
-- YouTube option was therefore left with Netflix, Disney+ and the rest still installed — the exact
-- bug 0023 was written to fix, on the one policy it forgot.
--
-- Fixed here by re-syncing _yt from rung 3 wholesale rather than by naming the streaming packages
-- again: that way this also picks up anything else rung 3 has gained since 0020, and it stays
-- correct if run again. The one difference between the two policies is still the official YouTube
-- app, and the modded forks (Vanced, ReVanced) stay blocked in both — they exist to strip the
-- controls the official app has, so allowing YouTube must not mean allowing those.
--
-- THE LESSON, worth writing down: any future rule added to yeshiva rung 3 must be copied to
-- yeshiva_rung_3_yt in the same migration, or repeat the re-sync below. A copied policy silently
-- goes stale, and nothing warns you.

ALTER TABLE device_overrides ADD COLUMN youtube INTEGER;

-- Re-sync the YouTube-option policy from rung 3. Re-runnable: cleared, then rebuilt from rung 3.
DELETE FROM app_rules WHERE policy_id = 'yeshiva_rung_3_yt';
INSERT INTO app_rules (policy_id, package_name, state)
  SELECT 'yeshiva_rung_3_yt', package_name, state
    FROM app_rules
   WHERE policy_id = 'yeshiva_rung_3'
     AND package_name <> 'com.google.android.youtube';
