-- The Shmira companion app (companion/ in this repo) is allowed on every policy, standard and
-- yeshiva, shiur included. It is not a phone feature; it is the thing that closes the gap between
-- an app being installed and the Headwind agent noticing: the agent only re-applies its app rules
-- when it fetches its configuration (boot, push, or a forced update), so a blocklisted app
-- installed from Play stayed usable until the next sync. The companion sees the install the moment
-- it completes and makes the agent re-apply now.
--
-- 'allowed' is what makes Push apps mark it INSTALL on every configuration once Headwind holds its
-- APK (headwind.js pushPolicyApps: allowed + APK = install), so the agent puts it back at the next
-- sync if a phone ever loses it. It is deliberately on the shiur policy too: a shiur window must
-- not be the moment the watchdog goes away.
--
-- Re-runnable: one row per policy, ignored where it already exists.
INSERT OR IGNORE INTO app_rules (policy_id, package_name, state)
  SELECT id, 'com.getshmira.companion', 'allowed' FROM policies;
