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
import { normalizeDeviceLevel, normalizeSiteLevel, LEVELS, NEVER_LEVEL, MIN_LEVEL, MAX_DEVICE_LEVEL } from './levels.js';
import { searchCacheKey } from './search.js';
import { sha256Hex , generateProxyPassword, proxyUserFromLabel } from './crypto.js';

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
      // The ladder ships with the state so the page never hard-codes rung names — they live in
      // levels.js, and a page that duplicated them would drift from what is actually enforced.
      return json({ devices, policies, appRules, schedules, levels: LEVELS });
    }

    case 'GET /api/admin/verdicts':
      return json({
        verdicts: await all(env,
          `SELECT hostname, verdict, level, is_doorway, reason, source, decided_at FROM url_verdicts
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

      // A MISSING level clamps to the strictest rung, never the loosest: getting that backwards
      // would mean a typo in a form silently opening a phone up.
      //
      // A level that was SUPPLIED but is not a rung is refused instead of clamped. Clamping is the
      // right answer for a corrupt row the scheduler stumbles over at 3am; it is the wrong answer
      // for an operator standing at the form, because the clamp lands on rung 1 — no web at all —
      // and the console then reads as though they had chosen the strictest filtering. A live phone
      // spent days unable to load anything or run a single search that way. Say no instead.
      if (body.level !== undefined && body.level !== null && body.level !== ''
          && normalizeDeviceLevel(body.level) !== Number(body.level)) {
        return json({
          error: `level must be a rung between ${MIN_LEVEL} and ${MAX_DEVICE_LEVEL}; ` +
            `${JSON.stringify(body.level)} is not one (6/"Never" is a site rating, not a phone rung)`,
        }, 400);
      }
      const level = normalizeDeviceLevel(body.level ?? 2);

      // The proxy login is how the filter tells one phone from another. It must match an account in
      // /etc/squid/passwd; without it the device falls back to the strictest rung on every request.
      // Left blank, it is derived from the label so no phone is accidentally saved without identity.
      const proxyUser = String(body.proxy_user || '').trim() || proxyUserFromLabel(label);
      if (!/^[a-zA-Z0-9._-]{2,64}$/.test(proxyUser)) {
        return json({ error: 'proxy_user must be 2-64 chars: letters, digits, dot, dash, underscore' }, 400);
      }

      const id = body.id || newId('dev');

      // Generate a password per phone rather than letting the operator pick one — a chosen password
      // gets reused across phones, and reuse is the only way one leaked login becomes a fleet-wide
      // one. Kept if the device already has one, so re-saving a phone to change its level does not
      // silently invalidate the credential already typed into its Chrome.
      const existing = await env.DB.prepare('SELECT proxy_password FROM devices WHERE id = ?')
        .bind(id).first();
      const proxyPassword = String(body.proxy_password || '').trim()
        || existing?.proxy_password
        || generateProxyPassword();
      try {
        await env.DB.prepare(`
          INSERT INTO devices (id, headwind_device_id, label, policy_id, timezone, enrolled_at, level, proxy_user, proxy_password)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            headwind_device_id = excluded.headwind_device_id, label = excluded.label,
            policy_id = excluded.policy_id, timezone = excluded.timezone,
            level = excluded.level, proxy_user = excluded.proxy_user,
            proxy_password = excluded.proxy_password
        `).bind(id, body.headwind_device_id || null, label, body.policy_id,
                body.timezone || 'UTC', Date.now(), level, proxyUser, proxyPassword).run();
      } catch (err) {
        // proxy_user is uniquely indexed: two phones sharing a login would silently share a rung,
        // and whichever was loosest would win for both.
        if (/UNIQUE|constraint/i.test(err.message || '')) {
          return json({ error: 'that proxy login is already used by another phone' }, 409);
        }
        throw err;
      }

      await audit(env, 'operator', 'device_saved', id, `${label} -> level ${level}, policy ${body.policy_id}`);
      // The htpasswd line is returned ready to paste: the worker cannot reach /etc/squid/passwd, so
      // creating the squid account stays a manual step and this is the part people get wrong.
      return json({
        ok: true, id, level,
        proxy_user: proxyUser,
        proxy_password: proxyPassword,
        htpasswd: `htpasswd -B -b /etc/squid/passwd ${proxyUser} '${proxyPassword}'`,
      });
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

    case 'POST /api/admin/devices/delete': {
      if (!body.id) return json({ error: 'id is required' }, 400);
      // Schedules naming this device go too. Leaving them behind would mean a later device reusing
      // the id silently inheriting a stranger's time windows.
      await env.DB.prepare('DELETE FROM schedules WHERE device_id = ?').bind(body.id).run();
      await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(body.id).run();
      await audit(env, 'operator', 'device_deleted', body.id, null);
      return json({ ok: true });
    }

    // Move a phone between rungs. Separate from the full device save so the common operation — "make
    // this stricter, now" — is one call that cannot accidentally blank another field.
    case 'POST /api/admin/devices/level': {
      if (!body.id) return json({ error: 'id is required' }, 400);
      // Same as the save route: a rung the operator did not ask for is worse than an error. 6 is
      // the one people reach for by mistake — it is a site rating meaning "blocked everywhere", and
      // clamped onto a phone it becomes rung 1, no web.
      if (normalizeDeviceLevel(body.level) !== Number(body.level)) {
        return json({
          error: `level must be a rung between ${MIN_LEVEL} and ${MAX_DEVICE_LEVEL}; ` +
            `${JSON.stringify(body.level)} is not one`,
        }, 400);
      }
      const level = normalizeDeviceLevel(body.level);
      const res = await env.DB.prepare('UPDATE devices SET level = ? WHERE id = ?')
        .bind(level, body.id).run();
      if (!res.meta?.changes) return json({ error: 'no such device' }, 404);
      await audit(env, 'operator', 'device_level_set', body.id, `level ${level}`);
      return json({ ok: true, level });
    }

    // --- overriding the classifier ----------------------------------------------------------------

    // Re-rate a site by hand. This is the correction path for a model that judged something wrong,
    // and it is recorded as an operator decision so the classifier cannot quietly overturn it later.
    case 'POST /api/admin/sites/level': {
      const hostname = String(body.hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
      if (!hostname || !hostname.includes('.')) return json({ error: 'hostname is required' }, 400);
      const level = normalizeSiteLevel(body.level);
      const isDoorway = body.is_doorway === true || body.is_doorway === 1 ? 1 : 0;
      const hash = await sha256Hex(hostname);

      await env.DB.prepare(`
        INSERT INTO url_verdicts (url_hash, url, hostname, scope, verdict, reason, source, decided_at, level, is_doorway)
        VALUES (?, ?, ?, 'host', ?, ?, 'operator', ?, ?, ?)
        ON CONFLICT(url_hash) DO UPDATE SET
          verdict = excluded.verdict, reason = excluded.reason, source = 'operator',
          decided_at = excluded.decided_at, level = excluded.level, is_doorway = excluded.is_doorway
      `).bind(hash, `https://${hostname}/`, hostname,
              level >= NEVER_LEVEL ? 'blocked' : 'clean',
              String(body.reason || 'Set by operator').slice(0, 160), Date.now(), level, isDoorway).run();

      await audit(env, 'operator', 'site_level_set', hostname, `level ${level}${isDoorway ? ' (doorway)' : ''}`);
      return json({ ok: true, hostname, level });
    }

    // What is being searched for, most-tried first. The single most useful view in this console —
    // it shows what people are actually trying to reach, which no list of approved sites ever will.
    case 'GET /api/admin/searches':
      return json({
        searches: await all(env,
          `SELECT query_sample, level, reason, source, hit_count, decided_at
           FROM search_verdicts ORDER BY hit_count DESC, decided_at DESC LIMIT 200`),
      });

    // Re-rate a typed query by hand, same correction path as sites.
    case 'POST /api/admin/searches/level': {
      const query = String(body.query || '').trim();
      if (!query) return json({ error: 'query is required' }, 400);
      const level = normalizeSiteLevel(body.level);
      // Hashed on the same normalised key the filter uses, or the override would sit beside the
      // real entry rather than replacing it and would never be consulted.
      const hash = await sha256Hex(searchCacheKey(query));

      await env.DB.prepare(`
        INSERT INTO search_verdicts (query_hash, query_sample, level, reason, source, decided_at, hit_count)
        VALUES (?, ?, ?, ?, 'operator', ?, 1)
        ON CONFLICT(query_hash) DO UPDATE SET
          level = excluded.level, reason = excluded.reason, source = 'operator',
          decided_at = excluded.decided_at
      `).bind(hash, query.slice(0, 200), level,
              String(body.reason || 'Set by operator').slice(0, 160), Date.now()).run();

      await audit(env, 'operator', 'search_level_set', query.slice(0, 60), `level ${level}`);
      return json({ ok: true, level });
    }

    // --- manual scheduler run, so the operator doesn't wait for the next cron tick ---------------
    case 'POST /api/admin/apply':
      return json(await runScheduler(env));

    default:
      return json({ error: 'Not found' }, 404);
  }
}
