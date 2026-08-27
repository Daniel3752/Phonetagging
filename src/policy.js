// Resolving a device + an instant into the policy that should be in force.
//
// Deliberately pure: no D1, no network, no Date.now(). The caller passes the rows and the instant,
// which is what makes the awkward parts — midnight-crossing windows, per-device time zones,
// overlapping schedules — testable without standing up any infrastructure. See test/policy.test.mjs.

import { normalizeDeviceLevel } from './levels.js';

// The app policy that pairs with a web rung. There are five app policies, one per rung, with the
// deterministic ids the migration seeds (apps_rung_1 .. apps_rung_5), so a rung resolves to its
// policy with no lookup. The rung is the single control: it picks the web tier AND the app policy.
//
// This is only the id convention. HOW that policy is fed to the scheduler/Headwind (baseline vs a
// time-window override, and what apps each policy actually lists) is the app-control work that is
// intentionally deferred — the policies ship EMPTY and are populated during that discussion.
export function appPolicyIdForLevel(level) {
  return `apps_rung_${normalizeDeviceLevel(level)}`;
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
// Schedules whose device_id is null apply to every device sharing that baseline policy; a schedule
// naming the device wins over a fleet-wide one at equal priority. Highest priority wins overall,
// with the most recently created schedule breaking a remaining tie — so the newest instruction the
// operator gave is the one that takes effect.
//
// With no matching window, the device's baseline policy stands.
export function resolveEffectivePolicy(device, schedules, instant) {
  const { day, minute } = localTime(instant, device.timezone || 'UTC');

  const matches = schedules.filter((s) =>
    s.base_policy_id === device.policy_id &&
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
