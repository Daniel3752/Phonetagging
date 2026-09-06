// Resolving a device + an instant into the policy that should be in force.
//
// Deliberately pure: no D1, no network, no Date.now(). The caller passes the rows and the instant,
// which is what makes the awkward parts — midnight-crossing windows, per-device time zones,
// overlapping schedules — testable without standing up any infrastructure. See test/policy.test.mjs.

import { normalizeDeviceLevel, normalizeTag, TAGS } from './levels.js';

// The app policy that pairs with a rung. Each ladder has one app policy per rung with a
// deterministic id the migrations seed (apps_rung_1 .. apps_rung_5 on the standard ladder,
// yeshiva_rung_1 .. yeshiva_rung_4 on the yeshiva tag), so a rung resolves to its policy with no
// lookup. The rung is the single control: it picks the web tier AND the app policy.
//
// This is only the id convention. HOW that policy is fed to the scheduler/Headwind (baseline vs a
// time-window override, and what apps each policy actually lists) is the app-control work that is
// intentionally deferred — the policies ship EMPTY and are populated during that discussion.
export function appPolicyIdForLevel(level, tag = 'standard') {
  const t = normalizeTag(tag);
  return `${TAGS[t].policyPrefix}_${normalizeDeviceLevel(level, t)}`;
}

// A schedule's base_policy_id normally names the baseline policy of the phones it applies to. It may
// instead name a whole TAG — `tag:yeshiva` — meaning every phone on that ladder whatever its rung.
// That is what lets one set of shiur windows cover all four yeshiva rungs as four rows rather than
// sixteen, and be edited in one place.
export const TAG_BASE_PREFIX = 'tag:';

export function tagBaseId(tag) {
  return `${TAG_BASE_PREFIX}${normalizeTag(tag)}`;
}

// Does this schedule's base cover this device — its baseline policy, or its whole tag?
export function scheduleCoversDevice(schedule, device) {
  if (schedule.base_policy_id === device.policy_id) return true;
  if (typeof schedule.base_policy_id === 'string' && schedule.base_policy_id.startsWith(TAG_BASE_PREFIX)) {
    return schedule.base_policy_id === tagBaseId(device.tag);
  }
  return false;
}

// The shiur lock toggle (/admin → Yeshiva). Stored in the settings table as shiur_lock_mode:
//   'schedule' — the timetable decides (default)
//   'off'      — the shiur windows are ignored; phones stay on their rung's policy
//   'on'       — every yeshiva phone is locked now, whatever the clock says
// Applied identically by the scheduler (apps) and the proxy (web), via resolveEffectivePolicy.
export const SHIUR_POLICY_ID = 'yeshiva_shiur';
export const SHIUR_MODES = ['schedule', 'off', 'on'];

export function normalizeShiurMode(value) {
  const v = String(value || '').trim().toLowerCase();
  return SHIUR_MODES.includes(v) ? v : 'schedule';
}

// A schedule's day_mask is a 7-bit field, bit 0 = Sunday. Matched against the day the window
// STARTS, which is what makes a wrapped window like Fri 22:00–06:00 land on Friday night rather
// than Saturday morning.
export const DAY_BITS = { sun: 1, mon: 2, tue: 4, wed: 8, thu: 16, fri: 32, sat: 64 };

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Wall-clock day-of-week and minutes-since-midnight for an instant, in a named IANA zone.
// Schedules are written in the phone's local time, so a fleet spread across zones still reads
// "blocked after 10pm" as the family's 10pm.
//
// Falls back to UTC on an unknown zone rather than throwing — a bad timezone string on one device
// must not take down a scheduler run for the whole fleet.
export function localTime(instant, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(instant);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(instant);
  }

  const get = (type) => parts.find((p) => p.type === type)?.value;
  // Intl renders midnight as "24" in some ICU versions under hour12:false; normalize it.
  const hour = Number(get('hour')) % 24;
  return {
    day: WEEKDAY_INDEX[get('weekday')] ?? 0,
    minute: hour * 60 + Number(get('minute')),
  };
}

// Does this window contain the given local day/minute?
//
// end <= start means the window wraps past midnight (22:00–06:00). The post-midnight portion
// belongs to the PREVIOUS day's mask, so a Friday-night window is still Friday's window at 01:00
// on Saturday.
export function windowContains(schedule, day, minute) {
  const { day_mask: mask, start_min: start, end_min: end } = schedule;
  const dayIsSet = (d) => (mask & (1 << d)) !== 0;

  if (start === end) return false;              // zero-length window matches nothing
  if (end > start) return dayIsSet(day) && minute >= start && minute < end;

  // Wrapped: either the tail of today, or the head that started yesterday.
  const yesterday = (day + 6) % 7;
  return (dayIsSet(day) && minute >= start) || (dayIsSet(yesterday) && minute < end);
}

// The policy a device should be running right now.
//
// Schedules whose device_id is null apply to every device sharing that baseline policy (or, for a
// `tag:` base, every device on that tag); a schedule naming the device wins over a fleet-wide one
// at equal priority. Highest priority wins overall,
// with the most recently created schedule breaking a remaining tie — so the newest instruction the
// operator gave is the one that takes effect.
//
// With no matching window, the device's baseline policy stands.
//
// options.shiurMode is the operator's toggle (see SHIUR_MODES): 'on' forces the shiur policy on
// every yeshiva-tag phone, 'off' drops the shiur windows before resolving.
export function resolveEffectivePolicy(device, schedules, instant, options = {}) {
  const shiurMode = normalizeShiurMode(options.shiurMode);
  if (shiurMode === 'on' && normalizeTag(device.tag) === 'yeshiva') {
    return { policyId: SHIUR_POLICY_ID, scheduleId: null, forced: true };
  }
  if (shiurMode === 'off') {
    schedules = schedules.filter((s) => s.active_policy_id !== SHIUR_POLICY_ID);
  }

  const { day, minute } = localTime(instant, device.timezone || 'UTC');

  const matches = schedules.filter((s) =>
    scheduleCoversDevice(s, device) &&
    (s.device_id === null || s.device_id === undefined || s.device_id === device.id) &&
    windowContains(s, day, minute)
  );

  if (matches.length === 0) return { policyId: device.policy_id, scheduleId: null };

  matches.sort((a, b) =>
    (b.priority - a.priority) ||
    (specificity(b, device) - specificity(a, device)) ||
    (b.created_at - a.created_at)
  );

  return { policyId: matches[0].active_policy_id, scheduleId: matches[0].id };
}

function specificity(schedule, device) {
  return schedule.device_id === device.id ? 1 : 0;
}

// Convenience for the admin UI: "18:30" <-> 1110.
export function parseTimeOfDay(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatTimeOfDay(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
