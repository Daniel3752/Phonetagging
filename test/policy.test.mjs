// Boundary tests for the policy resolver. No network, no D1 — resolveEffectivePolicy is pure, and
// the awkward cases (midnight-crossing windows, per-device time zones, overlapping schedules,
// DST transitions) are exactly the ones worth pinning down before any of this reaches a phone.
import { resolveEffectivePolicy, windowContains, localTime, parseTimeOfDay, formatTimeOfDay, DAY_BITS } from '../src/policy.js';

let failures = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  ' + extra));
  if (!cond) failures++;
}

const ALL_DAYS = 127;
const sched = (o) => ({
  id: 's', device_id: null, base_policy_id: 'base', active_policy_id: 'evening',
  day_mask: ALL_DAYS, start_min: 0, end_min: 0, priority: 0, created_at: 0, ...o,
});
const device = { id: 'd1', policy_id: 'base', timezone: 'UTC' };

console.log('\n1. ordinary window 09:00-17:00');
const day = sched({ start_min: 540, end_min: 1020 });
check('before start excluded', !windowContains(day, 1, 539));
check('at start included', windowContains(day, 1, 540));
check('midpoint included', windowContains(day, 1, 700));
check('at end excluded (half-open)', !windowContains(day, 1, 1020));
check('after end excluded', !windowContains(day, 1, 1021));

console.log('\n2. window wrapping midnight 22:00-06:00');
const night = sched({ start_min: 1320, end_min: 360 });
check('21:59 excluded', !windowContains(night, 3, 1319));
check('22:00 included', windowContains(night, 3, 1320));
check('23:59 included', windowContains(night, 3, 1439));
check('00:00 next day included', windowContains(night, 4, 0));
check('05:59 included', windowContains(night, 4, 359));
check('06:00 excluded', !windowContains(night, 4, 360));

console.log('\n3. wrapped window respects the START day, not the end day');
// Friday night only: bit 5. Saturday 01:00 must match (it is Friday's window continuing).
const friNight = sched({ day_mask: DAY_BITS.fri, start_min: 1320, end_min: 360 });
check('Fri 23:00 matches', windowContains(friNight, 5, 1380));
check('Sat 01:00 matches (Friday window continuing)', windowContains(friNight, 6, 60));
check('Sat 23:00 does NOT match', !windowContains(friNight, 6, 1380));
check('Sun 01:00 does NOT match', !windowContains(friNight, 0, 60));

console.log('\n4. degenerate windows');
check('zero-length matches nothing', !windowContains(sched({ start_min: 600, end_min: 600 }), 1, 600));
check('full day 00:00-23:59 covers 23:58', windowContains(sched({ start_min: 0, end_min: 1439 }), 1, 1438));

console.log('\n5. baseline when nothing matches');
let r = resolveEffectivePolicy(device, [sched({ start_min: 540, end_min: 1020 })], new Date('2026-08-24T02:00:00Z'));
check('falls back to baseline', r.policyId === 'base' && r.scheduleId === null, JSON.stringify(r));

console.log('\n6. overlap resolution');
const lo = sched({ id: 'lo', active_policy_id: 'low', priority: 1, start_min: 0, end_min: 1439, created_at: 1 });
const hi = sched({ id: 'hi', active_policy_id: 'high', priority: 5, start_min: 0, end_min: 1439, created_at: 1 });
r = resolveEffectivePolicy(device, [lo, hi], new Date('2026-08-24T10:00:00Z'));
check('higher priority wins', r.policyId === 'high', JSON.stringify(r));

const fleet = sched({ id: 'fleet', active_policy_id: 'fleet', device_id: null, start_min: 0, end_min: 1439, created_at: 5 });
const mine = sched({ id: 'mine', active_policy_id: 'mine', device_id: 'd1', start_min: 0, end_min: 1439, created_at: 1 });
r = resolveEffectivePolicy(device, [fleet, mine], new Date('2026-08-24T10:00:00Z'));
check('device-specific beats fleet-wide at equal priority', r.policyId === 'mine', JSON.stringify(r));

const older = sched({ id: 'o', active_policy_id: 'older', start_min: 0, end_min: 1439, created_at: 100 });
const newer = sched({ id: 'n', active_policy_id: 'newer', start_min: 0, end_min: 1439, created_at: 200 });
r = resolveEffectivePolicy(device, [older, newer], new Date('2026-08-24T10:00:00Z'));
check('newest breaks remaining tie', r.policyId === 'newer', JSON.stringify(r));

console.log('\n7. schedules for a different baseline are ignored');
r = resolveEffectivePolicy(device, [sched({ base_policy_id: 'other', start_min: 0, end_min: 1439 })], new Date('2026-08-24T10:00:00Z'));
check('ignored', r.policyId === 'base', JSON.stringify(r));

console.log('\n8. time zones');
// 2026-08-24T02:00:00Z is 22:00 on Aug 23 in New York (EDT, UTC-4).
const ny = { id: 'd1', policy_id: 'base', timezone: 'America/New_York' };
const t = localTime(new Date('2026-08-24T02:00:00Z'), 'America/New_York');
check('NY local time is 22:00', t.minute === 22 * 60, JSON.stringify(t));
check('NY local day is Sunday(0)', t.day === 0, JSON.stringify(t));
// A non-wrapping 22:00-23:00 window isolates the zone effect: the same instant is 22:00 in New
// York (inside) but 02:00 in UTC (outside).
const evening = sched({ start_min: 1320, end_min: 1380, active_policy_id: 'night' });
r = resolveEffectivePolicy(ny, [evening], new Date('2026-08-24T02:00:00Z'));
check('window matches in the device local zone', r.policyId === 'night', JSON.stringify(r));
r = resolveEffectivePolicy(device, [evening], new Date('2026-08-24T02:00:00Z'));
check('same instant does NOT match for a UTC device', r.policyId === 'base', JSON.stringify(r));
check('midnight normalizes to minute 0', localTime(new Date('2026-08-24T00:00:00Z'), 'UTC').minute === 0);
check('unknown timezone falls back to UTC instead of throwing',
  localTime(new Date('2026-08-24T02:00:00Z'), 'Not/AZone').minute === 120);

console.log('\n9. DST transition (US spring forward, 2026-03-08)');
// 06:30Z is 01:30 EST; 07:30Z is 03:30 EDT — 02:xx local never occurs that day.
check('before jump is 01:30', localTime(new Date('2026-03-08T06:30:00Z'), 'America/New_York').minute === 90);
check('after jump is 03:30', localTime(new Date('2026-03-08T07:30:00Z'), 'America/New_York').minute === 210);

console.log('\n10. time-of-day formatting');
check('parse 18:30', parseTimeOfDay('18:30') === 1110);
check('parse 00:00', parseTimeOfDay('00:00') === 0);
check('reject 24:00', parseTimeOfDay('24:00') === null);
check('reject 12:60', parseTimeOfDay('12:60') === null);
check('reject garbage', parseTimeOfDay('nope') === null);
check('format round-trips', formatTimeOfDay(1110) === '18:30' && formatTimeOfDay(0) === '00:00');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
