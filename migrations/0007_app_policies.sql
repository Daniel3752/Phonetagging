-- Five app policies, one per web rung, and the mapping from a rung to its policy. The rung is the
-- single control: it selects the web tier and the app policy together. See policy.js
-- (appPolicyIdForLevel) for the deterministic id convention.
--
-- The policies ship EMPTY (no app_rules rows) and with no Headwind configuration mapped — the actual
-- per-rung app allow/hide/block lists, and how the scheduler feeds them to Headwind, are the deferred
-- app-control work (BUILD-PLAN.md §7). This migration only lays the structure.
--
-- Re-runnable: the policy inserts are IF-NOT-EXISTS by unique id, but the ALTER is not (SQLite has no
-- ADD COLUMN IF NOT EXISTS), so apply once.

ALTER TABLE level_definitions ADD COLUMN app_policy_id TEXT;

INSERT OR IGNORE INTO policies (id, name, headwind_configuration_id, created_at) VALUES
  ('apps_rung_1', 'Apps — Rung 1 (No browser)', NULL, unixepoch() * 1000),
  ('apps_rung_2', 'Apps — Rung 2 (Text-only)',  NULL, unixepoch() * 1000),
  ('apps_rung_3', 'Apps — Rung 3 (Essential)',  NULL, unixepoch() * 1000),
  ('apps_rung_4', 'Apps — Rung 4 (General)',    NULL, unixepoch() * 1000),
  ('apps_rung_5', 'Apps — Rung 5 (Open)',       NULL, unixepoch() * 1000);

UPDATE level_definitions SET app_policy_id = 'apps_rung_' || level WHERE level BETWEEN 1 AND 5;
