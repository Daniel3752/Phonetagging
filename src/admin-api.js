// Operator API behind /api/admin/*. Every route requires the OPERATOR_KEY bearer token (checked by
// the caller in src/index.js) and every mutation writes an audit_log row — if a family's phone
// changed, the log says who changed it and when.
//
// Deliberately CRUD-shaped and boring. The interesting logic lives in src/policy.js (what a device
// should be running) and src/scheduler.js (making that true); this is just the surface the admin
// page talks to.

import { audit } from './scheduler.js';
import { runScheduler } from './scheduler.js';
import { parseTimeOfDay } from './policy.js';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

const all = (env, sql, ...args) =>
  env.DB.prepare(sql).bind(...args).all().then((r) => r.results || []);

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

const APP_STATES = new Set(['allowed', 'blocked', 'hidden']);

// Android package names: dot-separated segments, each starting with a letter. Validated because
// these strings are pushed to phones — a typo silently fails to block the app the operator meant.
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

export async function handleAdmin(request, env, path) {
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  switch (`${request.method} ${path}`) {
    // --- read-only views the admin page renders ------------------------------------------------
    case 'GET /api/admin/state': {
      const [devices, policies, appRules, schedules] = await Promise.all([
        all(env, 'SELECT * FROM devices ORDER BY label'),
        all(env, 'SELECT * FROM policies ORDER BY name'),
        all(env, 'SELECT * FROM app_rules ORDER BY policy_id, package_name'),
        all(env, 'SELECT * FROM schedules ORDER BY priority DESC, created_at DESC'),
      ]);
      return json({ devices, policies, appRules, schedules });
    }

    case 'GET /api/admin/verdicts':
      return json({
        verdicts: await all(env,
          `SELECT hostname, verdict, reason, source, decided_at FROM url_verdicts
           WHERE scope = 'host' ORDER BY decided_at DESC LIMIT 200`),
      });

    case 'GET /api/admin/audit':
      return json({ entries: await all(env, 'SELECT * FROM audit_log ORDER BY at DESC LIMIT 200') });

    // --- policies -------------------------------------------------------------------------------
    case 'POST /api/admin/policies': {
      const name = String(body.name || '').trim();
      if (!name) return json({ error: 'name is required' }, 400);

      const id = body.id || newId('pol');
      await env.DB.prepare(`
        INSERT INTO policies (id, name, headwind_configuration_id, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name,
          headwind_configuration_id = excluded.headwind_configuration_id
      `).bind(id, name, body.headwind_configuration_id || null, Date.now()).run();

      await audit(env, 'operator', 'policy_saved', id, name);
      return json({ ok: true, id });
    }

    // --- app rules ------------------------------------------------------------------------------
    case 'POST /api/admin/apps': {
      const { policy_id: policyId, package_name: pkg, state } = body;
      if (!policyId || !pkg) return json({ error: 'policy_id and package_name are required' }, 400);
      if (!PACKAGE_RE.test(pkg)) return json({ error: 'package_name is not a valid Android package name' }, 400);

      // An explicit 'remove' drops the rule entirely, which is different from setting 'allowed':
      // no rule means the policy says nothing about that app.
      if (state === 'remove') {
        await env.DB.prepare('DELETE FROM app_rules WHERE policy_id = ? AND package_name = ?')
          .bind(policyId, pkg).run();
        await audit(env, 'operator', 'app_rule_removed', policyId, pkg);
        return json({ ok: true });
      }

      if (!APP_STATES.has(state)) return json({ error: 'state must be allowed, blocked, hidden or remove' }, 400);

      await env.DB.prepare(`
        INSERT INTO app_rules (policy_id, package_name, state) VALUES (?, ?, ?)
        ON CONFLICT(policy_id, package_name) DO UPDATE SET state = excluded.state
      `).bind(policyId, pkg, state).run();

      await audit(env, 'operator', 'app_rule_set', policyId, `${pkg} -> ${state}`);
      return json({ ok: true });
    }

    // --- devices --------------------------------------------------------------------------------
    case 'POST /api/admin/devices': {
      const label = String(body.label || '').trim();
      if (!label) return json({ error: 'label is required' }, 400);
      if (!body.policy_id) return json({ error: 'policy_id is required' }, 400);

      const id = body.id || newId('dev');
      await env.DB.prepare(`
        INSERT INTO devices (id, headwind_device_id, label, policy_id, timezone, enrolled_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          headwind_device_id = excluded.headwind_device_id, label = excluded.label,
          policy_id = excluded.policy_id, timezone = excluded.timezone
      `).bind(id, body.headwind_device_id || null, label, body.policy_id, body.timezone || 'UTC', Date.now()).run();

      await audit(env, 'operator', 'device_saved', id, `${label} -> policy ${body.policy_id}`);
      return json({ ok: true, id });
    }

    // --- schedules ------------------------------------------------------------------------------
    case 'POST /api/admin/schedules': {
      const start = parseTimeOfDay(body.start);
      const end = parseTimeOfDay(body.end);
      if (start === null || end === null) return json({ error: 'start and end must be HH:MM' }, 400);
      if (start === end) return json({ error: 'start and end cannot be the same time' }, 400);
      if (!body.base_policy_id || !body.active_policy_id) {
        return json({ error: 'base_policy_id and active_policy_id are required' }, 400);
      }

      const dayMask = Number(body.day_mask);
      if (!Number.isInteger(dayMask) || dayMask < 1 || dayMask > 127) {
        return json({ error: 'day_mask must be an integer 1-127 (bit 0 = Sunday)' }, 400);
      }

      const id = body.id || newId('sch');
      await env.DB.prepare(`
        INSERT INTO schedules (id, device_id, base_policy_id, active_policy_id, day_mask, start_min, end_min, priority, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          device_id = excluded.device_id, base_policy_id = excluded.base_policy_id,
          active_policy_id = excluded.active_policy_id, day_mask = excluded.day_mask,
          start_min = excluded.start_min, end_min = excluded.end_min, priority = excluded.priority
      `).bind(id, body.device_id || null, body.base_policy_id, body.active_policy_id,
              dayMask, start, end, Number(body.priority) || 0, Date.now()).run();

      await audit(env, 'operator', 'schedule_saved', id, `${body.start}-${body.end} -> ${body.active_policy_id}`);
      return json({ ok: true, id });
    }

    case 'POST /api/admin/schedules/delete': {
      if (!body.id) return json({ error: 'id is required' }, 400);
      await env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(body.id).run();
      await audit(env, 'operator', 'schedule_deleted', body.id, null);
      return json({ ok: true });
    }

    // --- manual scheduler run, so the operator doesn't wait for the next cron tick ---------------
    case 'POST /api/admin/apply':
      return json(await runScheduler(env));

    default:
      return json({ error: 'Not found' }, 404);
  }
}
