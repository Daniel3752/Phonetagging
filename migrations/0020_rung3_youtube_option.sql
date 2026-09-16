-- The YouTube option on yeshiva rung 3.
--
-- App enforcement is per Headwind CONFIGURATION, and a configuration belongs to a policy — so "this
-- boy may have YouTube, that one may not" cannot be a property of the phone alone. It is expressed
-- as a second rung-3 policy, identical to the first except that the official YouTube app is not
-- removed, plus a per-phone flag that chooses between them.
--
-- devices.allow_youtube: 0 (default) = no, the answer for every phone unless someone says otherwise.
--
-- The modded YouTube forks stay blocked in BOTH policies. Vanced and ReVanced exist to strip the
-- controls the official app has, so allowing YouTube must not mean allowing those.

ALTER TABLE devices ADD COLUMN allow_youtube INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO policies (id, name, headwind_configuration_id, app_default, web_mode, created_at) VALUES
  ('yeshiva_rung_3_yt', 'Yeshiva — Rung 3 + YouTube', NULL, 'allowed', NULL, 0);

-- Everything rung 3 blocks, minus the official YouTube app. Copied from the rung-3 rules rather
-- than restated, so the two policies cannot drift apart as the blocklist grows.
DELETE FROM app_rules WHERE policy_id = 'yeshiva_rung_3_yt';
INSERT INTO app_rules (policy_id, package_name, state)
  SELECT 'yeshiva_rung_3_yt', package_name, state
    FROM app_rules
   WHERE policy_id = 'yeshiva_rung_3'
     AND package_name <> 'com.google.android.youtube';
