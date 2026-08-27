// Cron entry point: keeps every phone running the policy its schedule says it should be running.
//
// Runs on a Cloudflare Cron Trigger (see [triggers] in wrangler.toml). Each run reads the devices
// and schedules from D1, resolves what each device SHOULD have (src/policy.js), and pushes to
// Headwind only where that differs from what was last successfully applied.
//
// Two properties matter more than speed here:
//
//   * Idempotent. last_applied_policy_id records the device's known state, so a run that computes
//     no change makes no API calls and writes no audit rows. A cron that fires every few minutes
//     must be free when nothing has changed.
//   * Isolated failures. One unreachable device, one bad timezone string, one Headwind 500 must
//     not stop the rest of the fleet from being updated. Every device is handled in its own
//     try/catch and failures are recorded, not thrown.

import { resolveEffectivePolicy } from './policy.js';
import { setDeviceConfiguration } from './headwind.js';

export async function runScheduler(env, now = new Date()) {
  const [devices, schedules, policies] = await Promise.all([
    env.DB.prepare('SELECT * FROM devices').all().then((r) => r.results || []),
    env.DB.prepare('SELECT * FROM schedules').all().then((r) => r.results || []),
    env.DB.prepare('SELECT * FROM policies').all().then((r) => r.results || []),
  ]);

  const policyById = new Map(policies.map((p) => [p.id, p]));
  const summary = { checked: devices.length, changed: 0, unchanged: 0, failed: 0, errors: [] };

  for (const device of devices) {
    try {
      const { policyId, scheduleId } = resolveEffectivePolicy(device, schedules, now);

      if (policyId === device.last_applied_policy_id) {
        summary.unchanged++;
        continue;
      }

      const policy = policyById.get(policyId);
      if (!policy) throw new Error(`policy ${policyId} does not exist`);
      if (!policy.headwind_configuration_id) {
        throw new Error(`policy ${policyId} has no Headwind configuration mapped`);
      }
      if (!device.headwind_device_id) {
        throw new Error('device is not linked to a Headwind device');
      }

      await setDeviceConfiguration(env, device.headwind_device_id, policy.headwind_configuration_id);

      // Only record the new state after Headwind has accepted it. If the push half-fails we would
      // rather retry next run than believe a change landed that did not — the same ordering
      // discipline the verdict path uses.
      await env.DB.prepare('UPDATE devices SET last_applied_policy_id = ? WHERE id = ?')
        .bind(policyId, device.id).run();

      await audit(env, 'scheduler', 'policy_applied', device.id,
        `${device.last_applied_policy_id || '(none)'} -> ${policyId}${scheduleId ? ` via schedule ${scheduleId}` : ' (baseline)'}`);

      summary.changed++;
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${device.id}: ${err.message}`);
      await audit(env, 'scheduler', 'policy_apply_failed', device.id, err.message).catch(() => {});
    }
  }

  return summary;
}

export function audit(env, actor, action, target, detail) {
  return env.DB.prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), actor, action, target || null, detail || null).run();
}
