/**
 * Raidsmith guild tracker - attendance rules tests (Phase 3, pure modules)
 * Run: node guild-attendance-rules-tests.js
 *
 * worker/attendance-calendar.js, -policy.js, -consolidate.js, -metrics.js against synthetic evidence and against the
 * anonymized goldens in tests/fixtures/attendance (built by tools/build-attendance-fixtures.js from the guild's own
 * Raid-Helper events and Warcraft Logs reports). No D1, no network, no clock.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'attendance');

let passed = 0;
let failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// Helpers

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
};

async function modules() {
  const [calendar, policy, consolidate, metrics] = await Promise.all([
    load('worker/attendance-calendar.js'), load('worker/attendance-policy.js'),
    load('worker/attendance-consolidate.js'), load('worker/attendance-metrics.js'),
  ]);
  return { calendar, policy, consolidate, metrics };
}

// Synthetic evidence: persons are named by id, a character key is "<id>|".
const key = (id) => `${id}|`;
const person = (id, { status = 'raider', joinedOn = '2026-08-01', team = 'T1', extra = [] } = {}) => ({
  playerId: id, status, joinedOn, characters: [{ key: key(id), teamId: team }, ...extra],
});
const pull = (startedAt, ...ids) => ({ startedAt, kill: false, keys: ids.map(key) });
const evidence = (over = {}) => ({
  raid: { id: 'r1', teamId: 'T1', raidOn: '2026-10-10', hasLog: true, manual: false },
  people: [], signups: [], pulls: [], manualPresent: [], guests: [], decisions: {}, ...over,
});
const signup = (playerId, kind, source = 'raid_helper') => ({ playerId, kind, source });
const rowOf = (result, id) => result.rows.find((row) => row.playerId === id);

// A stored-style row for the fill-in pass.
const mkRow = (playerId, outcome, over = {}) => ({
  playerId, outcome, credit: null, autoOutcome: outcome, autoCredit: null, signupKind: null, attended: 0, presenceSource: 'log',
  viaRaidId: null, pullsPresent: 0, pullsTotal: 0, missedFirst: 0, missedLast: 0, flags: [], creditTeamId: null, needsReview: 0,
  decisionValid: false, decisionStale: false, ...over,
});

// ---------------------------------------------------------------------------
// Calendar

check('calendar: localDate follows the guild time zone around midnight and DST (Chicago, Berlin)', async () => {
  const { calendar } = await modules();
  const at = (iso) => Date.parse(iso);
  // The 10/10 raid: the second report starts 2026-10-11T02:21Z, which is still 10/10 in Chicago.
  assert.equal(calendar.localDate(at('2026-10-11T02:21:35.920Z'), 'America/Chicago'), '2026-10-10');
  assert.equal(calendar.localDate(at('2026-10-11T04:59:59Z'), 'America/Chicago'), '2026-10-10');
  assert.equal(calendar.localDate(at('2026-10-11T05:00:00Z'), 'America/Chicago'), '2026-10-11');
  // Fall back (2026-11-01, 02:00 CDT -> 01:00 CST): the 25-hour day keeps one date.
  assert.equal(calendar.localDate(at('2026-11-01T05:00:00Z'), 'America/Chicago'), '2026-11-01');
  assert.equal(calendar.localDate(at('2026-11-01T07:30:00Z'), 'America/Chicago'), '2026-11-01');
  assert.equal(calendar.localDate(at('2026-11-02T05:59:59Z'), 'America/Chicago'), '2026-11-01');
  assert.equal(calendar.localDate(at('2026-11-02T06:00:00Z'), 'America/Chicago'), '2026-11-02');
  // Spring forward (2026-03-08).
  assert.equal(calendar.localDate(at('2026-03-08T07:59:00Z'), 'America/Chicago'), '2026-03-08');
  assert.equal(calendar.localDate(at('2026-03-09T04:59:59Z'), 'America/Chicago'), '2026-03-08');
  assert.equal(calendar.localDate(at('2026-03-09T05:00:00Z'), 'America/Chicago'), '2026-03-09');
  // Berlin: CEST until 2026-10-25, then CET.
  assert.equal(calendar.localDate(at('2026-10-10T21:59:59Z'), 'Europe/Berlin'), '2026-10-10');
  assert.equal(calendar.localDate(at('2026-10-10T22:00:00Z'), 'Europe/Berlin'), '2026-10-11');
  assert.equal(calendar.localDate(at('2026-10-25T22:59:59Z'), 'Europe/Berlin'), '2026-10-25');
  assert.equal(calendar.localDate(at('2026-10-25T23:00:00Z'), 'Europe/Berlin'), '2026-10-26');
  assert.throws(() => calendar.localDate(NaN, 'UTC'), RangeError);
});

check('calendar: addDays and daysBetween cross month, year and leap-day edges and reject bad dates', async () => {
  const { calendar } = await modules();
  assert.equal(calendar.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(calendar.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(calendar.addDays('2027-01-01', -1), '2026-12-31');
  assert.equal(calendar.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(calendar.addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(calendar.addDays('2026-10-10', -49), '2026-08-22');
  assert.equal(calendar.daysBetween('2026-10-10', '2026-10-10'), 0);
  assert.equal(calendar.daysBetween('2026-10-03', '2026-10-10'), 7);
  assert.equal(calendar.daysBetween('2026-10-10', '2026-10-03'), -7);
  assert.equal(calendar.daysBetween('2026-12-31', '2027-01-02'), 2);
  for (const bad of ['2026-02-30', '2026-13-01', 'tomorrow', '2026-1-1', null, 20261010]) assert.throws(() => calendar.addDays(bad, 1), RangeError, String(bad));
});

check('calendar: weekStart is the reset day on or before the date, for reset days 0 to 6', async () => {
  const { calendar } = await modules();
  // 2026-10-10 is a Saturday; the reset weekday is named by 0 = Sunday.
  assert.equal(calendar.weekdayOf('2026-10-10'), 6);
  assert.equal(calendar.weekdayOf('2026-10-06'), 2);
  const expected = { 0: '2026-10-04', 1: '2026-10-05', 2: '2026-10-06', 3: '2026-10-07', 4: '2026-10-08', 5: '2026-10-09', 6: '2026-10-10' };
  for (const [resetDay, start] of Object.entries(expected)) assert.equal(calendar.weekStart('2026-10-10', Number(resetDay)), start, `reset ${resetDay}`);
  // The reset day itself starts its own week; the day before belongs to the previous week.
  assert.equal(calendar.weekStart('2026-10-06', 2), '2026-10-06');
  assert.equal(calendar.weekStart('2026-10-05', 2), '2026-09-29');
  // US Tuesday: 10/09 and 10/10 share the week of 10/06, 10/02 and 10/03 the week of 09/29. EU Wednesday likewise.
  assert.equal(calendar.weekStart('2026-10-09', 2), '2026-10-06');
  assert.equal(calendar.weekStart('2026-10-02', 2), '2026-09-29');
  assert.equal(calendar.weekStart('2026-10-03', 2), '2026-09-29');
  assert.equal(calendar.weekStart('2026-10-02', 3), '2026-09-30');
  // Month and year edges.
  assert.equal(calendar.weekStart('2027-01-01', 1), '2026-12-28');
  assert.equal(calendar.weekStart('2028-03-01', 2), '2028-02-29');
  for (const bad of [-1, 7, 1.5, null, '2']) assert.throws(() => calendar.weekStart('2026-10-10', bad), RangeError);
});

// ---------------------------------------------------------------------------
// Policy

check('policy: DEFAULT_POLICY holds the kickoff answers and is frozen', async () => {
  const { policy } = await modules();
  const d = policy.DEFAULT_POLICY;
  assert.deepEqual(d.expected, { mode: 'signedUp', statuses: ['raider', 'trial'] });
  assert.deepEqual([d.noSignup, d.tentative, d.absence, d.bench, d.lateSignup, d.fillIn, d.effectiveStart], ['shown', 'asNoSignup', 'missedWithNotice', 'full', 'fullCreditNoFlag', 'always', 'laterOfJoinAndFirst']);
  assert.deepEqual(d.detection, { mode: 'pulls' });
  assert.deepEqual(d.credit.values, [{ id: 'full', label: 'Full', value: 1 }, { id: 'half', label: 'Half', value: 0.5 }, { id: 'none', label: 'None', value: 0 }]);
  assert.deepEqual(d.window, { defaultWeeks: 8, switchWeeks: [8, 12] });
  assert.equal(d.streakFlagAt, 4);
  assert.equal(d.resetDay, null);
  assert(Object.isFrozen(d) && Object.isFrozen(d.expected) && Object.isFrozen(d.credit.values[0]));
  assert.deepEqual(policy.REGION_RESET_DAY, { US: 2, EU: 3, KR: 4, TW: 4 });
  assert.deepEqual(policy.validateOverride({}, 'guild'), { ok: true, errors: [] });
  assert.equal(policy.validateOverride(JSON.parse(JSON.stringify(d)), 'guild').ok, true, 'the defaults are themselves a valid override');
});

check('policy: resolvePolicy merges defaults <- guild <- team per key, arrays replace, resetDay comes from the region', async () => {
  const { policy } = await modules();
  const base = policy.resolvePolicy(null, null, 'US');
  assert.equal(base.resetDay, 2);
  assert.equal(policy.resolvePolicy(null, null, 'EU').resetDay, 3);
  assert.equal(policy.resolvePolicy(null, null, 'KR').resetDay, 4);
  assert.equal(policy.resolvePolicy(null, null, 'ZZ').resetDay, 2, 'an unknown region falls back to the US day');
  assert.equal(policy.resolvePolicy({ resetDay: 5 }, null, 'EU').resetDay, 5, 'the guild override beats the region');
  assert.equal(policy.resolvePolicy({ resetDay: 0 }, null, 'EU').resetDay, 0, 'Sunday is a real value, not a missing one');
  const guild = { tentative: 'asSignedUp', expected: { mode: 'statuses' }, window: { defaultWeeks: 12 } };
  const team = { tentative: 'asNoSignup', expected: { statuses: ['raider'] }, credit: { values: [{ id: 'aa', label: 'A', value: 1 }, { id: 'bb', label: 'B', value: 0 }] } };
  const resolved = policy.resolvePolicy(guild, team, 'US');
  assert.equal(resolved.tentative, 'asNoSignup', 'team beats guild');
  assert.deepEqual(resolved.expected, { mode: 'statuses', statuses: ['raider'] }, 'sections merge per key');
  assert.deepEqual(resolved.window, { defaultWeeks: 12, switchWeeks: [8, 12] });
  assert.equal(resolved.credit.values.length, 2, 'arrays replace');
  assert.equal(resolved.noSignup, 'shown');
  assert.equal(policy.resolvePolicy(guild, null, 'US').tentative, 'asSignedUp');
  assert.equal(policy.resolvePolicy(null, { resetDay: 6 }, 'US').resetDay, 2, 'a team override never moves the reset day');
  // Fresh objects: changing a result never changes the defaults or the overrides.
  resolved.expected.statuses.push('trial');
  resolved.credit.values[0].label = 'X';
  assert.deepEqual(policy.DEFAULT_POLICY.expected.statuses, ['raider', 'trial']);
  assert.equal(policy.DEFAULT_POLICY.credit.values[0].label, 'Full');
  assert.deepEqual(team.expected.statuses, ['raider']);
});

check('policy: validateOverride rejects unknown keys at every depth, wrong types and out-of-range numbers with a path', async () => {
  const { policy } = await modules();
  const bad = (override, path, scope = 'guild') => {
    const result = policy.validateOverride(override, scope);
    assert.equal(result.ok, false, JSON.stringify(override));
    assert.equal(result.errors[0].path, path, JSON.stringify(override));
    assert(typeof result.errors[0].message === 'string' && result.errors[0].message.length > 0);
  };
  bad({ nope: 1 }, 'nope');
  bad({ expected: { nope: 1 } }, 'expected.nope');
  bad({ detection: { mode: 'pulls', nope: 1 } }, 'detection.nope');
  bad({ window: { nope: 1 } }, 'window.nope');
  bad({ credit: { nope: 1 } }, 'credit.nope');
  bad({ credit: { values: [{ id: 'aa', label: 'A', value: 1, nope: 1 }, { id: 'bb', label: 'B', value: 0 }] } }, 'credit.values');
  bad({ expected: 'signedUp' }, 'expected');
  bad({ expected: { mode: 'everyone' } }, 'expected.mode');
  bad({ expected: { mode: 5 } }, 'expected.mode');
  bad({ expected: { statuses: ['raider', 'wizard'] } }, 'expected.statuses');
  bad({ expected: { statuses: ['raider', 'raider'] } }, 'expected.statuses');
  bad({ expected: { statuses: 'raider' } }, 'expected.statuses');
  bad({ noSignup: 'maybe' }, 'noSignup');
  bad({ tentative: true }, 'tentative');
  bad({ absence: 'ignored' }, 'absence');
  bad({ bench: 'half' }, 'bench');
  bad({ lateSignup: 'x' }, 'lateSignup');
  bad({ fillIn: 'sometimes' }, 'fillIn');
  bad({ effectiveStart: 'never' }, 'effectiveStart');
  bad({ window: { defaultWeeks: 0 } }, 'window.defaultWeeks');
  bad({ window: { defaultWeeks: 53 } }, 'window.defaultWeeks');
  bad({ window: { defaultWeeks: 8.5 } }, 'window.defaultWeeks');
  bad({ window: { defaultWeeks: '8' } }, 'window.defaultWeeks');
  bad({ streakFlagAt: 21 }, 'streakFlagAt');
  bad({ streakFlagAt: -1 }, 'streakFlagAt');
  bad({ resetDay: 7 }, 'resetDay');
  bad({ resetDay: 'Tuesday' }, 'resetDay');
  bad('nope', '');
  bad([], '');
  bad(null, '');
  assert.equal(policy.validateOverride({ streakFlagAt: 0 }).ok, true, '0 turns the streak flag off');
  assert.equal(policy.validateOverride({ resetDay: null }).ok, true);
  assert.equal(policy.validateOverride({ resetDay: 0 }).ok, true);
  assert.equal(policy.validateOverride({ expected: { statuses: [] } }).ok, true);
  assert.equal(policy.validateOverride({}, 'region').ok, false, 'an unknown scope is refused');
});

check('policy: reserved detection modes, the window rule, resetDay scope and the credit list limits', async () => {
  const { policy } = await modules();
  for (const mode of ['kills', 'share', 'minutes']) {
    const result = policy.validateOverride({ detection: { mode } });
    assert.equal(result.errors[0].path, 'detection.mode');
    assert(/reserved/.test(result.errors[0].message), mode);
  }
  assert.equal(policy.validateOverride({ detection: { mode: 'other' } }).errors[0].path, 'detection.mode');
  assert.equal(policy.validateOverride({ detection: { mode: 'pulls' } }).ok, true);
  // switchWeeks must include defaultWeeks, against the override itself and against the inherited base.
  assert.equal(policy.validateOverride({ window: { defaultWeeks: 10 } }).errors[0].path, 'window.defaultWeeks');
  assert.equal(policy.validateOverride({ window: { switchWeeks: [4, 6] } }).errors[0].path, 'window.switchWeeks');
  assert.equal(policy.validateOverride({ window: { defaultWeeks: 10, switchWeeks: [8, 10] } }).ok, true);
  const base = policy.resolvePolicy({ window: { defaultWeeks: 12 } }, null, 'US');
  assert.equal(policy.validateOverride({ window: { switchWeeks: [8, 12] } }, 'team', base).ok, true);
  assert.equal(policy.validateOverride({ window: { switchWeeks: [4, 8] } }, 'team', base).errors[0].path, 'window.switchWeeks');
  for (const weeks of [[], [1, 2, 3, 4], [8, 8], [0, 8], [8, 60], ['8']]) assert.equal(policy.validateOverride({ window: { switchWeeks: weeks } }).errors[0].path, 'window.switchWeeks', JSON.stringify(weeks));
  // resetDay is guild-level only.
  assert.equal(policy.validateOverride({ resetDay: 2 }, 'team').errors[0].path, 'resetDay');
  assert.equal(policy.validateOverride({ resetDay: null }, 'team').errors[0].path, 'resetDay');
  assert.equal(policy.validateOverride({ resetDay: 2 }, 'guild').ok, true);
  // Credit values: 2 to 5 entries, unique ids [a-z]{2,12}, labels 1-12 characters, value 0..1.
  const v = (id, label = 'L', value = 0.5) => ({ id, label, value });
  const ok = (values) => policy.validateOverride({ credit: { values } }).ok;
  assert.equal(ok([v('aa'), v('bb')]), true);
  assert.equal(ok([v('aa'), v('bb'), v('cc'), v('dd'), v('ee')]), true);
  assert.equal(ok([v('aa')]), false);
  assert.equal(ok([v('aa'), v('bb'), v('cc'), v('dd'), v('ee'), v('ff')]), false);
  assert.equal(ok([v('aa'), v('aa')]), false, 'ids unique');
  assert.equal(ok([v('a'), v('bb')]), false, 'id too short');
  assert.equal(ok([v('abcdefghijklm'), v('bb')]), false, 'id too long');
  assert.equal(ok([v('Aa'), v('bb')]), false, 'id lower case only');
  assert.equal(ok([v('a1'), v('bb')]), false, 'id letters only');
  assert.equal(ok([v('aa', ''), v('bb')]), false, 'label too short');
  assert.equal(ok([v('aa', 'x'.repeat(13)), v('bb')]), false, 'label too long');
  assert.equal(ok([v('aa', 'x'.repeat(12)), v('bb')]), true);
  assert.equal(ok([v('aa', 'L', -0.1), v('bb')]), false);
  assert.equal(ok([v('aa', 'L', 1.1), v('bb')]), false);
  assert.equal(ok([v('aa', 'L', 0), v('bb', 'L', 1)]), true);
  assert.equal(ok([v('aa', 'L', '1'), v('bb')]), false);
  assert.equal(ok('full'), false);
});

check('policy: the fingerprint changes only for the keys that change stored results', async () => {
  const { policy } = await modules();
  const base = policy.resolvePolicy(null, null, 'US');
  const fp = (guild, team = null, region = 'US') => policy.consolidationFingerprint(policy.resolvePolicy(guild, team, region));
  assert.match(fp(null), /^[0-9a-f]{8}$/);
  assert.equal(fp(null), policy.consolidationFingerprint(base), 'deterministic');
  assert.equal(fp({}), fp(null));
  assert.equal(fp({ expected: { mode: 'signedUp' } }), fp(null), 'an override equal to the default changes nothing');
  const changes = [
    { expected: { mode: 'statuses' } }, { expected: { statuses: ['raider'] } }, { noSignup: 'hidden' }, { tentative: 'asSignedUp' },
    { absence: 'excused' }, { bench: 'excluded' }, { lateSignup: 'flagLikeOthers' }, { fillIn: 'recordOnly' }, { fillIn: 'homeIfNoRaid' },
    { resetDay: 5 }, { credit: { values: [{ id: 'full', label: 'Full', value: 1 }, { id: 'none', label: 'None', value: 0 }] } },
    { credit: { values: [{ id: 'full', label: 'Whole', value: 1 }, { id: 'half', label: 'Half', value: 0.5 }, { id: 'none', label: 'None', value: 0 }] } },
  ];
  const seen = new Set([fp(null)]);
  for (const change of changes) {
    const value = fp(change);
    assert(!seen.has(value), `${JSON.stringify(change)} must change the fingerprint (and differ from the others)`);
    seen.add(value);
  }
  assert.notEqual(fp(null, null, 'US'), fp(null, null, 'EU'), 'the region reset day is part of the fingerprint');
  assert.equal(fp({ resetDay: 2 }, null, 'EU'), fp(null, null, 'US'), 'the same resolved reset day gives the same fingerprint');
  assert.notEqual(fp(null, { fillIn: 'recordOnly' }), fp(null), 'a team override counts');
  for (const live of [{ window: { defaultWeeks: 12 } }, { window: { switchWeeks: [4, 8, 12], defaultWeeks: 4 } }, { effectiveStart: 'joinDate' }, { streakFlagAt: 0 }, { streakFlagAt: 9 }]) {
    assert.equal(fp(live), fp(null), `${JSON.stringify(live)} is read live and never makes a raid stale`);
  }
});

check('policy: the outcome, letter and flag tables, and the outcomes a decision may pick', async () => {
  const { policy } = await modules();
  assert.deepEqual(Object.fromEntries(Object.entries(policy.OUTCOMES).map(([id, entry]) => [id, entry.letter])), {
    present: 'P', bench: 'B', missed: 'M', missed_notice: 'N', late: 'L', left_early: 'E', late_left: 'LE', fill_in: 'F', tentative: 'T', no_signup: '-',
  });
  assert.equal(policy.OUTCOMES.fill_in.label, 'Other team');
  assert.deepEqual(policy.LETTERS, Object.fromEntries(Object.entries(policy.OUTCOMES).map(([id, entry]) => [id, entry.letter])));
  assert.equal(new Set(Object.values(policy.LETTERS)).size, Object.keys(policy.LETTERS).length, 'letters are distinct');
  assert.deepEqual(policy.FLAG_TYPES, ['no_show', 'late', 'left_early', 'unmatched']);
  assert.deepEqual(policy.decisionOutcomesFor(['no_show']), ['missed', 'missed_notice', 'bench', 'present']);
  assert.deepEqual(policy.decisionOutcomesFor(['late']), ['late', 'present']);
  assert.deepEqual(policy.decisionOutcomesFor(['left_early']), ['left_early', 'present']);
  assert.deepEqual(policy.decisionOutcomesFor(['late', 'left_early']), ['late_left', 'present']);
  assert.deepEqual(policy.decisionOutcomesFor([]), ['present', 'bench', 'missed', 'missed_notice']);
  for (const id of policy.CREDIT_PICK_OUTCOMES) assert.equal(policy.OUTCOMES[id].fixedCredit, null);
});

// ---------------------------------------------------------------------------
// Consolidation: precedence rows

check('consolidation row 3: in the log without a late / left pull is Present, signed up or not', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const result = consolidate.consolidateRaid(evidence({
    people: [person('a'), person('b'), person('c')],
    signups: [signup('a', 'signed'), signup('b', 'tentative')],
    pulls: [pull(100, 'a', 'b', 'c'), pull(200, 'a', 'b', 'c')],
  }), p);
  assert.equal(result.rows.length, 3);
  for (const id of ['a', 'b', 'c']) {
    const row = rowOf(result, id);
    assert.deepEqual([row.outcome, row.credit, row.attended, row.presenceSource, row.pullsPresent, row.pullsTotal, row.needsReview], ['present', 1, 1, 'log', 2, 2, 0], id);
    assert.deepEqual(row.flags, []);
  }
  assert.equal(rowOf(result, 'c').signupKind, null);
  assert.equal(result.openFlags, 0);
  assert.deepEqual(result.unmatched, []);
});

check('consolidation row 5: late, left early, and late and left early are flagged with no credit until decided', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const result = consolidate.consolidateRaid(evidence({
    people: [person('a'), person('late'), person('left'), person('both')],
    signups: [signup('a', 'signed'), signup('late', 'signed'), signup('left', 'signed'), signup('both', 'signed')],
    pulls: [pull(100, 'a', 'left'), pull(200, 'a', 'late', 'left', 'both'), pull(300, 'a', 'late')],
  }), p);
  assert.deepEqual([rowOf(result, 'a').outcome, rowOf(result, 'a').credit], ['present', 1]);
  const late = rowOf(result, 'late');
  assert.deepEqual([late.outcome, late.credit, late.flags, late.needsReview, late.missedFirst, late.missedLast, late.pullsPresent, late.pullsTotal], ['late', null, ['late'], 1, 1, 0, 2, 3]);
  const left = rowOf(result, 'left');
  assert.deepEqual([left.outcome, left.credit, left.flags, left.needsReview, left.missedFirst, left.missedLast], ['left_early', null, ['left_early'], 1, 0, 1]);
  const both = rowOf(result, 'both');
  assert.deepEqual([both.outcome, both.credit, both.flags, both.missedFirst, both.missedLast], ['late_left', null, ['late', 'left_early'], 1, 1]);
  assert.equal(result.openFlags, 3);
});

check('consolidation row 4: a Late sign-up arriving late is Present with no flag, but leaving early is still flagged', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const run = (pol, signupKind) => consolidate.consolidateRaid(evidence({
    people: [person('a'), person('onlylate'), person('lateleft'), person('onlyleft')],
    signups: [signup('onlylate', signupKind), signup('lateleft', signupKind), signup('onlyleft', signupKind)],
    pulls: [pull(100, 'a', 'onlyleft'), pull(200, 'a', 'onlylate', 'lateleft', 'onlyleft'), pull(300, 'a', 'onlylate')],
  }), pol);
  const result = run(p, 'late');
  assert.deepEqual([rowOf(result, 'onlylate').outcome, rowOf(result, 'onlylate').credit, rowOf(result, 'onlylate').flags], ['present', 1, []]);
  // Late sign-up, missed the first pull and the last: the late part is forgiven, the early leave is not.
  assert.deepEqual([rowOf(result, 'lateleft').outcome, rowOf(result, 'lateleft').flags, rowOf(result, 'lateleft').credit], ['left_early', ['left_early'], null]);
  assert.deepEqual([rowOf(result, 'onlyleft').outcome, rowOf(result, 'onlyleft').flags], ['left_early', ['left_early']]);
  // The same people with an ordinary sign-up are flagged like anyone else.
  const signed = run(p, 'signed');
  assert.equal(rowOf(signed, 'onlylate').outcome, 'late');
  assert.equal(rowOf(signed, 'lateleft').outcome, 'late_left');
  // lateSignup: flagLikeOthers switches the exemption off.
  const strict = run(policy.resolvePolicy({ lateSignup: 'flagLikeOthers' }, null, 'US'), 'late');
  assert.equal(rowOf(strict, 'onlylate').outcome, 'late');
  assert.equal(rowOf(strict, 'lateleft').outcome, 'late_left');
});

check('consolidation rows 6 and 7: Bench is full credit, Absence is Missed with notice; the policy can leave either out of the %', async () => {
  const { policy, consolidate } = await modules();
  const ev = evidence({
    people: [person('a'), person('bench'), person('away')],
    signups: [signup('bench', 'bench'), signup('away', 'absence')],
    pulls: [pull(100, 'a'), pull(200, 'a')],
  });
  const result = consolidate.consolidateRaid(ev, policy.resolvePolicy(null, null, 'US'));
  assert.deepEqual([rowOf(result, 'bench').outcome, rowOf(result, 'bench').credit, rowOf(result, 'bench').flags, rowOf(result, 'bench').attended], ['bench', 1, [], 0]);
  assert.deepEqual([rowOf(result, 'away').outcome, rowOf(result, 'away').credit, rowOf(result, 'away').flags, rowOf(result, 'away').needsReview], ['missed_notice', 0, [], 0]);
  const other = consolidate.consolidateRaid(ev, policy.resolvePolicy({ bench: 'excluded', absence: 'excused' }, null, 'US'));
  assert.deepEqual([rowOf(other, 'bench').outcome, rowOf(other, 'bench').credit], ['bench', null]);
  assert.deepEqual([rowOf(other, 'away').outcome, rowOf(other, 'away').credit], ['missed_notice', null]);
  // A benched player who then plays is in the log: Present (or flagged), not Bench.
  const played = consolidate.consolidateRaid(evidence({ people: [person('bench')], signups: [signup('bench', 'bench')], pulls: [pull(100, 'bench'), pull(200, 'bench')] }), policy.resolvePolicy(null, null, 'US'));
  assert.equal(rowOf(played, 'bench').outcome, 'present');
});

check('consolidation row 8: expected and not in the log is Missed with a no_show flag (signed up, Late, or on the roster in status mode)', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const result = consolidate.consolidateRaid(evidence({
    people: [person('a'), person('signed'), person('late')],
    signups: [signup('signed', 'signed'), signup('late', 'late')],
    pulls: [pull(100, 'a'), pull(200, 'a')],
  }), p);
  for (const id of ['signed', 'late']) {
    const row = rowOf(result, id);
    assert.deepEqual([row.outcome, row.credit, row.flags, row.needsReview, row.attended], ['missed', 0, ['no_show'], 1, 0], id);
  }
  assert.equal(result.openFlags, 2);
  // Status mode: Raider and Trial are expected without a sign-up; a Reserve who signs up is expected, one who does not is not.
  const statuses = policy.resolvePolicy({ expected: { mode: 'statuses' } }, null, 'US');
  const ev = evidence({
    people: [person('a'), person('raider'), person('trial', { status: 'trial' }), person('resSigned', { status: 'reserve' }), person('resQuiet', { status: 'reserve' })],
    signups: [signup('resSigned', 'signed')],
    pulls: [pull(100, 'a'), pull(200, 'a')],
  });
  const byStatus = consolidate.consolidateRaid(ev, statuses);
  for (const id of ['raider', 'trial', 'resSigned']) assert.deepEqual([rowOf(byStatus, id).outcome, rowOf(byStatus, id).flags], ['missed', ['no_show']], id);
  assert.deepEqual([rowOf(byStatus, 'resQuiet').outcome, rowOf(byStatus, 'resQuiet').credit], ['no_signup', null]);
  // Signed-up mode: the same raider is just "No sign-up".
  const bySignup = consolidate.consolidateRaid(ev, p);
  assert.equal(rowOf(bySignup, 'raider').outcome, 'no_signup');
  // With Reserve in the list the quiet Reserve is expected too.
  const withReserve = consolidate.consolidateRaid(ev, policy.resolvePolicy({ expected: { mode: 'statuses', statuses: ['raider', 'trial', 'reserve'] } }, null, 'US'));
  assert.equal(rowOf(withReserve, 'resQuiet').outcome, 'missed');
  // An Absence or Bench sign-up still wins over "expected by status" (rows 6 and 7 come first).
  const away = consolidate.consolidateRaid(evidence({ people: [person('a'), person('raider')], signups: [signup('raider', 'absence')], pulls: [pull(100, 'a')] }), statuses);
  assert.equal(rowOf(away, 'raider').outcome, 'missed_notice');
});

check('consolidation row 9: Tentative who is not in the log is Tentative and not counted; asSignedUp makes it a no-show', async () => {
  const { policy, consolidate } = await modules();
  const ev = evidence({ people: [person('a'), person('t')], signups: [signup('t', 'tentative')], pulls: [pull(100, 'a'), pull(200, 'a')] });
  const asNoSignup = consolidate.consolidateRaid(ev, policy.resolvePolicy(null, null, 'US'));
  assert.deepEqual([rowOf(asNoSignup, 't').outcome, rowOf(asNoSignup, 't').credit, rowOf(asNoSignup, 't').flags], ['tentative', null, []]);
  const asSigned = consolidate.consolidateRaid(ev, policy.resolvePolicy({ tentative: 'asSignedUp' }, null, 'US'));
  assert.deepEqual([rowOf(asSigned, 't').outcome, rowOf(asSigned, 't').credit, rowOf(asSigned, 't').flags], ['missed', 0, ['no_show']]);
  // In status mode a Tentative raider is expected anyway (the sign-up kind does not shield them).
  const byStatus = consolidate.consolidateRaid(ev, policy.resolvePolicy({ expected: { mode: 'statuses' } }, null, 'US'));
  assert.equal(rowOf(byStatus, 't').outcome, 'missed');
  // Tentative who shows up is Present either way.
  const showed = consolidate.consolidateRaid(evidence({ people: [person('t')], signups: [signup('t', 'tentative')], pulls: [pull(100, 't'), pull(200, 't')] }), policy.resolvePolicy(null, null, 'US'));
  assert.equal(rowOf(showed, 't').outcome, 'present');
});

check('consolidation rows 10 and 11: No sign-up is shown (or hidden); inactive people and strangers get no row', async () => {
  const { policy, consolidate } = await modules();
  const ev = evidence({
    people: [person('a'), person('quiet'), person('gone', { status: 'inactive' }), person('goneSigned', { status: 'inactive' }), person('away', { team: 'T2' })],
    signups: [signup('goneSigned', 'absence')],
    pulls: [pull(100, 'a'), pull(200, 'a')],
  });
  const shown = consolidate.consolidateRaid(ev, policy.resolvePolicy(null, null, 'US'));
  assert.deepEqual([rowOf(shown, 'quiet').outcome, rowOf(shown, 'quiet').credit, rowOf(shown, 'quiet').flags], ['no_signup', null, []]);
  assert.equal(rowOf(shown, 'gone'), undefined, 'inactive without sign-up or log: no row');
  assert.equal(rowOf(shown, 'goneSigned').outcome, 'missed_notice', 'inactive with a sign-up still gets a row');
  assert.equal(rowOf(shown, 'away'), undefined, 'a person with no character on this team and no evidence: no row');
  const hidden = consolidate.consolidateRaid(ev, policy.resolvePolicy({ noSignup: 'hidden' }, null, 'US'));
  assert.equal(rowOf(hidden, 'quiet'), undefined);
  // An inactive person who raids anyway is in the log and gets a row.
  const raided = consolidate.consolidateRaid(evidence({ people: [person('gone', { status: 'inactive' })], pulls: [pull(100, 'gone'), pull(200, 'gone')] }), policy.resolvePolicy(null, null, 'US'));
  assert.equal(rowOf(raided, 'gone').outcome, 'present');
});

check('consolidation: no log and not manual gives no rows (Awaiting log); a log with no match flags every name', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const awaiting = consolidate.consolidateRaid(evidence({ raid: { id: 'r1', teamId: 'T1', raidOn: '2026-10-10', hasLog: false, manual: false }, people: [person('a')], signups: [signup('a', 'signed')] }), p);
  assert.deepEqual(awaiting, { rows: [], unmatched: [], openFlags: 0 });
});

check('consolidation: unmatched log names are flagged once per name, guests are ignored, raid-level flags count in openFlags', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const result = consolidate.consolidateRaid(evidence({
    people: [person('a')],
    pulls: [{ startedAt: 100, kill: false, keys: [key('a'), 'stranger|', 'guestone|', 'zed|realm'] }, { startedAt: 200, kill: true, keys: [key('a'), 'stranger|', 'guestone|'] }],
    guests: ['guestone|'],
    logPlayers: { 'stranger|': { name: 'Stranger', realm: null, class: 'MAGE' } },
  }), p);
  assert.deepEqual(result.unmatched, [
    { key: 'stranger|', name: 'Stranger', realm: null, class: 'MAGE', pullsPresent: 2 },
    { key: 'zed|realm', name: 'zed', realm: 'realm', class: null, pullsPresent: 1 },
  ]);
  assert.equal(result.openFlags, 2);
  assert.equal(result.rows.length, 1);
});

check('consolidation: a person in the log with no character on the raid team is an Other-team host row (no flag, credit left to pass 2)', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const visitor = person('v', { team: 'T2', extra: [{ key: 'v2|', teamId: 'T3' }] });
  const result = consolidate.consolidateRaid(evidence({
    people: [person('a'), visitor],
    pulls: [pull(100, 'a', 'v'), pull(200, 'a', 'v'), { startedAt: 300, kill: false, keys: [key('a'), 'v2|'] }, { startedAt: 400, kill: false, keys: [key('a'), 'v2|'] }],
  }), p);
  const row = rowOf(result, 'v');
  assert.deepEqual([row.outcome, row.credit, row.flags, row.needsReview, row.attended, row.creditTeamId], ['fill_in', null, [], 0, 1, 'T2'], 'two pulls on a T2 character, two on a T3 one: the tie goes to the lower team id');
  const third = consolidate.consolidateRaid(evidence({
    people: [person('a'), visitor],
    pulls: [pull(100, 'a', 'v'), { startedAt: 200, kill: false, keys: [key('a'), 'v2|'] }, { startedAt: 300, kill: false, keys: [key('a'), 'v2|'] }],
  }), p);
  assert.equal(rowOf(third, 'v').creditTeamId, 'T3', 'the character that played most decides the credited team');
  assert.equal(third.openFlags, 0);
});

// ---------------------------------------------------------------------------
// Consolidation: sign-ups, manual, decisions, purity

check('consolidation: the strongest sign-up wins across sources, and the source never changes the output', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const people = [person('a'), person('b'), person('c'), person('d'), person('e')];
  const pulls = [pull(100, 'a'), pull(200, 'a')];
  const run = (source, signups) => consolidate.consolidateRaid(evidence({ people, pulls, signups: signups.map(([id, kind]) => signup(id, kind, source)) }), p);
  const set = [['b', 'signed'], ['c', 'bench'], ['d', 'absence'], ['e', 'tentative']];
  const a = run('raid_helper', set);
  assert.deepEqual(run('plan', set), a);
  assert.deepEqual(run('raidsmith', set), a);
  assert.deepEqual([rowOf(a, 'b').outcome, rowOf(a, 'c').outcome, rowOf(a, 'd').outcome, rowOf(a, 'e').outcome], ['missed', 'bench', 'missed_notice', 'tentative']);
  // Strongest wins: signed > late > bench > tentative > absence, whatever the source or order.
  const mixed = (list) => consolidate.consolidateRaid(evidence({ people, pulls, signups: list }), p);
  assert.equal(rowOf(mixed([signup('b', 'absence', 'raid_helper'), signup('b', 'signed', 'plan')]), 'b').outcome, 'missed', 'a plan placement beats a Raid-Helper Absence');
  assert.equal(rowOf(mixed([signup('b', 'signed', 'plan'), signup('b', 'absence', 'raid_helper')]), 'b').signupKind, 'signed');
  assert.equal(rowOf(mixed([signup('b', 'bench', 'plan'), signup('b', 'tentative', 'raid_helper')]), 'b').outcome, 'bench');
  assert.equal(rowOf(mixed([signup('b', 'tentative', 'plan'), signup('b', 'absence', 'raid_helper')]), 'b').outcome, 'tentative');
  assert.equal(rowOf(mixed([signup('b', 'late', 'raid_helper'), signup('b', 'bench', 'plan')]), 'b').signupKind, 'late');
  assert.equal(rowOf(mixed([signup('b', 'absence', 'raid_helper'), signup('b', 'bench', 'plan')]), 'b').outcome, 'bench');
  // Sign-ups with no person (null / unknown) and unknown kinds are ignored.
  const stray = mixed([signup(null, 'signed'), signup('zzz', 'signed'), signup('b', 'wizard')]);
  assert.deepEqual(stray.rows.map((row) => row.outcome), ['present', 'no_signup', 'no_signup', 'no_signup', 'no_signup'], 'stray sign-ups create no rows and change none');
});

check('consolidation: a plan placement in groups 1-5 counts as a sign-up (no-show = Missed + no_show), group 0 is Bench', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const result = consolidate.consolidateRaid(evidence({
    people: [person('a'), person('grouped'), person('benched')],
    signups: [signup('grouped', 'signed', 'plan'), signup('benched', 'bench', 'plan')],
    pulls: [pull(100, 'a'), pull(200, 'a')],
  }), p);
  assert.deepEqual([rowOf(result, 'grouped').outcome, rowOf(result, 'grouped').flags, rowOf(result, 'grouped').credit], ['missed', ['no_show'], 0]);
  assert.deepEqual([rowOf(result, 'benched').outcome, rowOf(result, 'benched').credit], ['bench', 1]);
});

check('consolidation: a manual raid uses the ticks as the log (no late / left), source officer; the rest follow the policy', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const result = consolidate.consolidateRaid(evidence({
    raid: { id: 'r1', teamId: 'T1', raidOn: '2026-10-10', hasLog: false, manual: true },
    people: [person('ticked'), person('signedNot'), person('bench'), person('away'), person('quiet'), person('tent'), person('visitor', { team: 'T2' }), person('gone', { status: 'inactive' })],
    signups: [signup('signedNot', 'signed'), signup('bench', 'bench'), signup('away', 'absence'), signup('tent', 'tentative'), signup('ticked', 'late')],
    manualPresent: ['ticked', 'visitor', 'nobody'],
  }), p);
  const ticked = rowOf(result, 'ticked');
  assert.deepEqual([ticked.outcome, ticked.credit, ticked.flags, ticked.attended, ticked.presenceSource, ticked.pullsTotal, ticked.missedFirst, ticked.missedLast], ['present', 1, [], 1, 'officer', 0, 0, 0]);
  assert.deepEqual([rowOf(result, 'signedNot').outcome, rowOf(result, 'signedNot').flags, rowOf(result, 'signedNot').credit], ['missed', ['no_show'], 0]);
  assert.equal(rowOf(result, 'bench').outcome, 'bench');
  assert.equal(rowOf(result, 'away').outcome, 'missed_notice');
  assert.equal(rowOf(result, 'tent').outcome, 'tentative');
  assert.equal(rowOf(result, 'quiet').outcome, 'no_signup', 'an unticked unsigned roster person');
  const visitor = rowOf(result, 'visitor');
  assert.deepEqual([visitor.outcome, visitor.creditTeamId, visitor.presenceSource, visitor.needsReview], ['fill_in', 'T2', 'officer', 0], 'a ticked person from another team is an Other-team row');
  assert.equal(rowOf(result, 'gone'), undefined);
  assert.equal(rowOf(result, 'nobody'), undefined, 'a tick for someone not in people is ignored');
  assert.equal(result.rows.every((row) => row.presenceSource === 'officer'), true);
  assert.equal(result.openFlags, 1, 'only the signed-up person who was not ticked');
  // Nobody ticked: everyone follows the policy as if absent from a log.
  const none = consolidate.consolidateRaid(evidence({ raid: { id: 'r1', teamId: 'T1', raidOn: '2026-10-10', hasLog: false, manual: true }, people: [person('x')], signups: [signup('x', 'signed')] }), p);
  assert.equal(rowOf(none, 'x').outcome, 'missed');
  // A visitor with a home team on the person overrides the character guess.
  const home = consolidate.consolidateRaid(evidence({
    raid: { id: 'r1', teamId: 'T1', raidOn: '2026-10-10', hasLog: false, manual: true },
    people: [{ ...person('v', { team: 'T3', extra: [{ key: 'v2|', teamId: 'T2' }] }), homeTeamId: 'T2' }], manualPresent: ['v'],
  }), p);
  assert.equal(rowOf(home, 'v').creditTeamId, 'T2');
});

check('consolidation decisions: a decision whose flags equal the current flags wins; a changed flag set reopens the row', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const base = {
    people: [person('a'), person('late'), person('miss')],
    signups: [signup('late', 'signed'), signup('miss', 'signed')],
    pulls: [pull(100, 'a'), pull(200, 'a', 'late')],
  };
  const decide = (decisions) => consolidate.consolidateRaid(evidence({ ...base, decisions }), p);
  const open = decide({});
  assert.equal(open.openFlags, 2);
  const decided = decide({
    late: { outcome: 'late', credit: 0.5, creditId: 'half', reason: 'Traffic', flags: ['late'] },
    miss: { outcome: 'bench', credit: 1, creditId: null, reason: 'Told us on Discord', flags: ['no_show'] },
  });
  const late = rowOf(decided, 'late');
  assert.deepEqual([late.outcome, late.credit, late.needsReview, late.decisionValid, late.autoOutcome, late.autoCredit, late.flags], ['late', 0.5, 0, true, 'late', null, ['late']]);
  const miss = rowOf(decided, 'miss');
  assert.deepEqual([miss.outcome, miss.credit, miss.needsReview, miss.autoOutcome, miss.autoCredit], ['bench', 1, 0, 'missed', 0]);
  assert.equal(decided.openFlags, 0);
  // The flag set changed since the decision (the player now also missed the last pull): reopened, the old decision stays visible.
  const reopened = decide({ late: { outcome: 'present', credit: 1, reason: 'Traffic', flags: ['late', 'left_early'] } });
  const row = rowOf(reopened, 'late');
  assert.deepEqual([row.outcome, row.credit, row.needsReview, row.decisionValid, row.decisionStale], ['late', null, 1, false, true]);
  // A decision answered flags that are gone: the auto result applies and nothing is open.
  const gone = decide({ a: { outcome: 'missed', credit: 0, reason: 'old', flags: ['no_show'] } });
  assert.deepEqual([rowOf(gone, 'a').outcome, rowOf(gone, 'a').needsReview, rowOf(gone, 'a').decisionStale], ['present', 0, true]);
  // An override on a row with no flags (decision flags []) is valid and replaces the auto result.
  const override = decide({ a: { outcome: 'bench', credit: 1, reason: 'Set on an old raid', flags: [] } });
  assert.deepEqual([rowOf(override, 'a').outcome, rowOf(override, 'a').credit, rowOf(override, 'a').decisionValid], ['bench', 1, true]);
  // Flag order in the stored decision does not matter.
  const order = consolidate.consolidateRaid(evidence({
    people: [person('a'), person('both')], signups: [signup('both', 'signed')],
    pulls: [pull(100, 'a'), pull(200, 'a', 'both'), pull(300, 'a')],
    decisions: { both: { outcome: 'late_left', credit: 0.5, reason: 'ok ok', flags: ['left_early', 'late'] } },
  }), p);
  assert.equal(rowOf(order, 'both').decisionValid, true);
});

check('consolidation: pulls from merged reports are ordered by absolute time, whatever the input order', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  // The "first" pull is the one with the smallest startedAt, the "last" the largest; ties do not break determinism.
  const pulls = [pull(3000, 'a', 'c'), pull(1000, 'a', 'b'), pull(2000, 'a', 'b', 'c')];
  const result = consolidate.consolidateRaid(evidence({ people: [person('a'), person('b'), person('c')], pulls }), p);
  assert.equal(rowOf(result, 'a').outcome, 'present');
  assert.deepEqual([rowOf(result, 'b').outcome, rowOf(result, 'b').missedFirst, rowOf(result, 'b').missedLast], ['left_early', 0, 1]);
  assert.deepEqual([rowOf(result, 'c').outcome, rowOf(result, 'c').missedFirst, rowOf(result, 'c').missedLast], ['late', 1, 0]);
  const reversed = consolidate.consolidateRaid(evidence({ people: [person('c'), person('b'), person('a')], pulls: [...pulls].reverse() }), p);
  assert.deepEqual(reversed, result);
});

check('consolidation: the input is never mutated, and shuffled input gives identical output sorted by player id', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy({ tentative: 'asSignedUp' }, null, 'US');
  const ids = ['m', 'c', 'x', 'a', 'q', 'e', 'z'];
  const kinds = ['signed', 'bench', 'absence', 'tentative', 'late', 'signed', 'bench'];
  const make = (order, pulls) => evidence({
    people: order.map((id) => person(id)),
    signups: order.map((id) => signup(id, kinds[ids.indexOf(id)], ids.indexOf(id) % 2 ? 'plan' : 'raid_helper')),
    pulls,
    guests: ['zz|'],
    decisions: { x: { outcome: 'left_early', credit: 0.5, reason: 'abc', flags: ['left_early'] } },
  });
  const pulls = [pull(100, 'm', 'c', 'x', 'a', 'q'), pull(200, 'a', 'm', 'c', 'x', 'q'), pull(300, 'a', 'c', 'q', 'zz')];
  const frozen = deepFreeze(make(ids, pulls));
  const first = consolidate.consolidateRaid(frozen, p);
  const reordered = consolidate.consolidateRaid(make([...ids].reverse(), [...pulls].reverse()), p);
  assert.deepEqual(JSON.parse(JSON.stringify(reordered)), JSON.parse(JSON.stringify(first)), 'reordered people, sign-ups and pulls give the same output');
  const playerIds = first.rows.map((row) => row.playerId);
  assert.deepEqual(playerIds, [...playerIds].sort());
  assert(first.rows.length >= 5 && first.rows.some((row) => row.decisionValid));
});

// ---------------------------------------------------------------------------
// Fill-ins (pass 2)

check('fill-ins: with no home raid that date the Other-team cell is an extra counted cell (credit 1)', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const day = { raidOn: '2026-10-10', raids: [{ raidId: 'rH', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1', attended: 1 }), mkRow('own', 'present', { credit: 1 })] }] };
  const out = consolidate.resolveFillIns(day, () => p);
  const rows = out.raids[0].rows;
  assert.deepEqual([rows[0].outcome, rows[0].credit, rows[0].viaRaidId], ['fill_in', 1, null]);
  assert.equal(rows[1].credit, 1);
  assert.equal(out.raids[0].openFlags, 0);
  assert.equal(day.raids[0].rows[0].credit, null, 'the input is untouched');
});

check('fill-ins: a home raid the same date with a missed / no_signup / tentative cell has it replaced by the Other-team cell', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  for (const outcome of ['missed', 'no_signup', 'tentative']) {
    const home = mkRow('v', outcome, { credit: outcome === 'missed' ? 0 : null, flags: outcome === 'missed' ? ['no_show'] : [], needsReview: outcome === 'missed' ? 1 : 0, signupKind: 'signed' });
    const day = { raidOn: '2026-10-10', raids: [
      { raidId: 'rHome', teamId: 'T1', unmatchedCount: 1, rows: [home] },
      { raidId: 'rHost', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1', attended: 1 })] },
    ] };
    const out = consolidate.resolveFillIns(day, () => p);
    const [homeRaid, hostRaid] = out.raids;
    const replaced = homeRaid.rows[0];
    assert.deepEqual([replaced.outcome, replaced.credit, replaced.flags, replaced.needsReview, replaced.viaRaidId], ['fill_in', 1, [], 0, 'rHost'], outcome);
    assert.equal(hostRaid.rows[0].credit, null, 'the replaced cell is the one that counts');
    const counting = [...homeRaid.rows, ...hostRaid.rows].filter((row) => row.credit === 1);
    assert.equal(counting.length, 1, 'exactly one counted cell');
    assert.equal(homeRaid.openFlags, 1, 'the no-show flag is gone; only the unmatched name is left');
    assert.equal(home.outcome, outcome, 'the input is untouched');
  }
});

check('fill-ins: a home cell that is present / bench / missed_notice / late / left early / decided stays, the host cell is not counted', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const homes = [
    mkRow('v', 'present', { credit: 1, attended: 1 }), mkRow('v', 'bench', { credit: 1 }), mkRow('v', 'missed_notice', { credit: 0 }),
    mkRow('v', 'late', { flags: ['late'], needsReview: 1 }), mkRow('v', 'left_early', { flags: ['left_early'], needsReview: 1 }),
    mkRow('v', 'missed', { credit: 0, flags: ['no_show'], decisionValid: true, needsReview: 0 }),
  ];
  for (const home of homes) {
    const day = { raidOn: '2026-10-10', raids: [
      { raidId: 'rHome', teamId: 'T1', rows: [home] },
      { raidId: 'rHost', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1', attended: 1, credit: 1 })] },
    ] };
    const out = consolidate.resolveFillIns(day, () => p);
    assert.deepEqual(out.raids[0].rows[0], home, home.outcome);
    assert.equal(out.raids[1].rows[0].credit, null, `${home.outcome}: never counted twice`);
  }
  // A home raid that has no row for the person at all (hidden No sign-up) leaves the host cell uncounted too.
  const absent = consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [
    { raidId: 'rHome', teamId: 'T1', rows: [mkRow('someoneElse', 'present', { credit: 1 })] },
    { raidId: 'rHost', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1' })] },
  ] }, () => p);
  assert.equal(absent.raids[1].rows[0].credit, null);
  assert.equal(absent.raids[0].rows.length, 1);
});

check('fill-ins: when the home row stops being missed-type, the replacement is gone on the next pass', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const host = () => ({ raidId: 'rHost', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1', attended: 1 })] });
  const run = (homeRow) => consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [{ raidId: 'rHome', teamId: 'T1', rows: [homeRow] }, host()] }, () => p);
  const before = run(mkRow('v', 'missed', { credit: 0, flags: ['no_show'], needsReview: 1 }));
  assert.equal(before.raids[0].rows[0].outcome, 'fill_in');
  const after = run(mkRow('v', 'bench', { credit: 1 }));
  assert.equal(after.raids[0].rows[0].outcome, 'bench');
  assert.equal(after.raids[1].rows[0].credit, null);
  // Re-running over a home row an earlier pass already replaced keeps it and counts it once.
  const again = consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [{ raidId: 'rHome', teamId: 'T1', rows: before.raids[0].rows }, host()] }, () => p);
  assert.deepEqual(again.raids[0].rows, before.raids[0].rows);
  assert.equal(again.raids[1].rows[0].credit, null);
});

check('fill-ins: a home raid on another date (same week) does not replace anything, the cell is an extra counted cell', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  // The caller passes one date at a time: the home raid is on 10/09, the host on 10/10.
  const out = consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [{ raidId: 'rHost', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1', attended: 1 })] }] }, () => p);
  assert.equal(out.raids[0].rows[0].credit, 1);
});

check('fill-ins: homeIfNoRaid never replaces and counts only with no home raid; recordOnly never counts', async () => {
  const { policy, consolidate } = await modules();
  const ifNoRaid = policy.resolvePolicy({ fillIn: 'homeIfNoRaid' }, null, 'US');
  const recordOnly = policy.resolvePolicy({ fillIn: 'recordOnly' }, null, 'US');
  const host = () => ({ raidId: 'rHost', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1', attended: 1 })] });
  const withHome = (pol) => consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [{ raidId: 'rHome', teamId: 'T1', rows: [mkRow('v', 'missed', { credit: 0, flags: ['no_show'], needsReview: 1 })] }, host()] }, () => pol);
  const noHome = (pol) => consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [host()] }, () => pol);
  assert.equal(withHome(ifNoRaid).raids[0].rows[0].outcome, 'missed', 'homeIfNoRaid never replaces');
  assert.equal(withHome(ifNoRaid).raids[1].rows[0].credit, null);
  assert.equal(noHome(ifNoRaid).raids[0].rows[0].credit, 1);
  assert.equal(withHome(recordOnly).raids[0].rows[0].outcome, 'missed');
  assert.equal(withHome(recordOnly).raids[1].rows[0].credit, null);
  assert.equal(noHome(recordOnly).raids[0].rows[0].credit, null);
  assert.equal(noHome(recordOnly).raids[0].rows[0].outcome, 'fill_in', 'recordOnly still shows the cell');
});

check('fill-ins: the HOME team\'s policy decides, so two teams with different policies behave differently on one date', async () => {
  const { policy, consolidate } = await modules();
  const always = policy.resolvePolicy(null, null, 'US');
  const recordOnly = policy.resolvePolicy(null, { fillIn: 'recordOnly' }, 'US');
  const policyFor = (teamId) => (teamId === 'T1' ? always : recordOnly);
  const out = consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [
    { raidId: 'rHost', teamId: 'T3', rows: [mkRow('x', 'fill_in', { creditTeamId: 'T1' }), mkRow('y', 'fill_in', { creditTeamId: 'T2' })] },
  ] }, policyFor);
  assert.deepEqual(out.raids[0].rows.map((row) => row.credit), [1, null]);
});

check('fill-ins: one cell counts per person per date, even with two host raids', async () => {
  const { policy, consolidate } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const out = consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [
    { raidId: 'rB', teamId: 'T3', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1' })] },
    { raidId: 'rA', teamId: 'T2', rows: [mkRow('v', 'fill_in', { creditTeamId: 'T1' })] },
  ] }, () => p);
  assert.deepEqual([out.raids[0].rows[0].credit, out.raids[1].rows[0].credit], [null, 1], 'the lower raid id counts');
  // A real consolidated host row passes straight through.
  const host = consolidate.consolidateRaid(evidence({ raid: { id: 'rH', teamId: 'T2', raidOn: '2026-10-10', hasLog: true, manual: false }, people: [person('v', { team: 'T1' })], pulls: [pull(100, 'v'), pull(200, 'v')] }), p);
  const settled = consolidate.resolveFillIns({ raidOn: '2026-10-10', raids: [{ raidId: 'rH', teamId: 'T2', rows: host.rows }] }, () => p);
  assert.deepEqual([settled.raids[0].rows[0].outcome, settled.raids[0].rows[0].credit], ['fill_in', 1]);
});

// ---------------------------------------------------------------------------
// Metrics (synthetic)

function metricsInput(over = {}) {
  return { people: [{ id: 'a', joinedOn: '2026-01-01' }], raids: [], rows: [], borrowed: [], today: '2026-10-10', resetDay: 2, ...over };
}
const mRow = (raidId, playerId, outcome, credit, over = {}) => ({ raidId, playerId, outcome, credit, signupKind: null, attended: ['present', 'late', 'left_early', 'late_left'].includes(outcome) ? 1 : 0, viaRaidId: null, ...over });
const raidsOn = (...dates) => dates.map((date) => ({ id: `r${date}`, raidOn: date, hasSignups: true }));

check('metrics: the window is the last N FULL reset weeks including the current one (US Tuesday, EU Wednesday, Sunday reset)', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const run = (today, resetDay, windowWeeks, dates) => {
    const raids = raidsOn(...dates);
    return metrics.teamMetrics(metricsInput({ today, resetDay, windowWeeks, policy: p, raids, rows: raids.map((raid) => mRow(raid.id, 'a', 'present', 1)) }));
  };
  // today Saturday 2026-10-10, reset Tuesday: this week starts 10-06; N = 8 goes back 49 days to 08-18.
  let result = run('2026-10-10', 2, 8, ['2026-08-17', '2026-08-18', '2026-10-10']);
  assert.equal(result.windowStart, '2026-08-18');
  assert.equal(result.people.a.counted, 2, '08-17 is out, 08-18 and today are in');
  assert.equal(result.people.a.cells.length, 3, 'cells keep the whole history');
  // N = 1 is just this reset week.
  result = run('2026-10-10', 2, 1, ['2026-10-05', '2026-10-06', '2026-10-10']);
  assert.equal(result.windowStart, '2026-10-06');
  assert.equal(result.people.a.counted, 2);
  // EU Wednesday: the week of Saturday 10-10 starts 10-07; N = 2 starts 09-30.
  result = run('2026-10-10', 3, 2, ['2026-09-29', '2026-09-30', '2026-10-07']);
  assert.equal(result.windowStart, '2026-09-30');
  assert.equal(result.people.a.counted, 2);
  // Sunday reset: this week starts 10-04.
  result = run('2026-10-10', 0, 1, ['2026-10-03', '2026-10-04']);
  assert.equal(result.windowStart, '2026-10-04');
  assert.equal(result.people.a.counted, 1);
  // A reset day with no raid yet: Tuesday 10-13 opens a new, empty week, so N = 1 holds nothing and N = 2 reaches 10-06.
  result = run('2026-10-13', 2, 1, ['2026-10-09', '2026-10-10']);
  assert.equal(result.windowStart, '2026-10-13');
  assert.equal(result.people.a.counted, 0);
  assert.equal(result.people.a.pct, null);
  assert.equal(result.people.a.pctAll, 100);
  result = run('2026-10-13', 2, 2, ['2026-10-05', '2026-10-06', '2026-10-10']);
  assert.equal(result.people.a.counted, 2);
  // The default window comes from the policy; 'all' has no start.
  assert.equal(run('2026-10-10', 2, undefined, ['2026-10-10']).windowWeeks, 8);
  result = run('2026-10-10', 2, 'all', ['2026-01-10', '2026-10-10']);
  assert.deepEqual([result.windowStart, result.people.a.counted, result.windowWeeks], [null, 2, 'all']);
  // A raid dated after `today` is never inside a window.
  assert.equal(run('2026-10-10', 2, 8, ['2026-10-11']).people.a.counted, 0);
});

check('metrics: % is credit over counted cells; uncounted outcomes stay out; null when nothing counts', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const dates = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06', '2026-10-07', '2026-10-08'];
  const raids = raidsOn(...dates);
  const outcomes = [['present', 1], ['missed', 0], ['bench', 1], ['missed_notice', 0], ['tentative', null], ['no_signup', null], ['late', 0.5], ['left_early', null]];
  const rows = raids.map((raid, i) => mRow(raid.id, 'a', outcomes[i][0], outcomes[i][1]));
  const result = metrics.teamMetrics(metricsInput({ policy: p, raids, rows, windowWeeks: 'all' })).people.a;
  // counted: present 1, missed 0, bench 1, missed_notice 0, late 0.5 = 5 cells, 2.5 credit; the pending left_early is not counted.
  assert.deepEqual([result.pct, result.pctAll, result.counted, result.pending], [50, 50, 5, 1]);
  const letters = result.cells.map((cell) => cell.letter);
  assert.deepEqual(letters, ['P', 'M', 'B', 'N', 'T', '-', 'L', 'E?']);
  assert.deepEqual(result.cells.map((cell) => cell.pending), [false, false, false, false, false, false, false, true]);
  // absence: excused and bench: excluded take those cells out of the % (credit and denominator).
  const excluded = metrics.teamMetrics(metricsInput({ policy: policy.resolvePolicy({ absence: 'excused', bench: 'excluded' }, null, 'US'), raids, rows, windowWeeks: 'all' })).people.a;
  assert.deepEqual([excluded.pct, excluded.counted], [(1.5 / 3) * 100, 3].map((n, i) => (i === 0 ? Math.round(n * 10) / 10 : n)));
  // Nothing counts: null, not 0.
  const quiet = metrics.teamMetrics(metricsInput({ policy: p, raids: raids.slice(4, 6), rows: rows.slice(4, 6), windowWeeks: 'all' })).people.a;
  assert.deepEqual([quiet.pct, quiet.pctAll, quiet.counted, quiet.streak, quiet.lastAttended], [null, null, 0, 0, null]);
  // A person with no rows at all.
  const empty = metrics.teamMetrics(metricsInput({ policy: p, raids, rows: [] })).people.a;
  assert.deepEqual([empty.pct, empty.pctAll, empty.signupRate, empty.cells.length, empty.lastAttended], [null, null, 0, 0, null]);
  // 1/3 rounds to one decimal.
  const third = metrics.teamMetrics(metricsInput({ policy: p, raids: raids.slice(0, 3), rows: [mRow(raids[0].id, 'a', 'present', 1), mRow(raids[1].id, 'a', 'missed', 0), mRow(raids[2].id, 'a', 'missed', 0)], windowWeeks: 'all' })).people.a;
  assert.equal(third.pct, 33.3);
});

check('metrics: effective start (later of join and first attended raid, or join date only), pre-start cells are dimmed and never counted', async () => {
  const { policy, metrics } = await modules();
  const dates = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22'];
  const raids = raidsOn(...dates);
  const rows = [mRow(raids[0].id, 'a', 'missed', 0), mRow(raids[1].id, 'a', 'missed', 0), mRow(raids[2].id, 'a', 'present', 1), mRow(raids[3].id, 'a', 'missed', 0)];
  const run = (over, polOver = null) => metrics.teamMetrics(metricsInput({ policy: policy.resolvePolicy(polOver, null, 'US'), raids, rows, windowWeeks: 'all', ...over })).people.a;
  // joined 08-01, first attended 09-15: the start is 09-15, so the two earlier misses are pre_start.
  let result = run({ people: [{ id: 'a', joinedOn: '2026-08-01' }] });
  assert.equal(result.start, '2026-09-15');
  assert.deepEqual(result.cells.map((cell) => cell.preStart), [true, true, false, false]);
  assert.deepEqual(result.cells.map((cell) => cell.letter), ['', '', 'P', 'M']);
  assert.deepEqual([result.pct, result.counted], [50, 2]);
  // joinDate only: nothing is pre-start.
  result = run({ people: [{ id: 'a', joinedOn: '2026-08-01' }] }, { effectiveStart: 'joinDate' });
  assert.equal(result.start, '2026-08-01');
  assert.deepEqual([result.pct, result.counted], [25, 4]);
  // Joined after the first attended raid: the join date is later.
  result = run({ people: [{ id: 'a', joinedOn: '2026-09-20' }] });
  assert.equal(result.start, '2026-09-20');
  assert.deepEqual(result.cells.map((cell) => cell.preStart), [true, true, true, false]);
  assert.deepEqual([result.pct, result.counted], [0, 1]);
  // Never attended: the join date; no join date: no lower bound at all.
  const never = rows.filter((row) => row.credit === 0);
  const m = (people) => metrics.teamMetrics(metricsInput({ policy: policy.resolvePolicy(null, null, 'US'), raids, rows: never, windowWeeks: 'all', people })).people.a;
  assert.equal(m([{ id: 'a', joinedOn: '2026-09-10' }]).start, '2026-09-10');
  assert.equal(m([{ id: 'a', joinedOn: '2026-09-10' }]).counted, 1);
  assert.equal(m([{ id: 'a' }]).start, null);
  assert.equal(m([{ id: 'a' }]).counted, 3);
  // A bench cell and an Other-team cell count as attended for the start.
  const benchFirst = metrics.teamMetrics(metricsInput({
    policy: policy.resolvePolicy(null, null, 'US'), raids, windowWeeks: 'all', people: [{ id: 'a', joinedOn: '2026-08-01' }],
    rows: [mRow(raids[0].id, 'a', 'missed', 0), mRow(raids[1].id, 'a', 'bench', 1), mRow(raids[2].id, 'a', 'missed', 0)],
  })).people.a;
  assert.equal(benchFirst.start, '2026-09-08');
  const viaBorrowed = metrics.teamMetrics(metricsInput({
    policy: policy.resolvePolicy(null, null, 'US'), raids, windowWeeks: 'all', people: [{ id: 'a', joinedOn: '2026-08-01' }],
    rows: [mRow(raids[0].id, 'a', 'missed', 0)], borrowed: [{ playerId: 'a', raidId: 'hostRaid', raidOn: '2026-09-05', teamId: 'T2' }],
  })).people.a;
  assert.equal(viaBorrowed.start, '2026-09-05');
  assert.deepEqual(viaBorrowed.cells.map((cell) => [cell.date, cell.preStart]), [['2026-09-01', true], ['2026-09-05', false]]);
});

check('metrics: pending cells are left out of the % and counted separately; awaitingReview counts raids', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const raids = raidsOn('2026-10-02', '2026-10-03', '2026-10-09');
  const people = [{ id: 'a', joinedOn: '2026-01-01' }, { id: 'b', joinedOn: '2026-01-01' }];
  const rows = [
    mRow(raids[0].id, 'a', 'present', 1), mRow(raids[1].id, 'a', 'late', null), mRow(raids[2].id, 'a', 'late_left', null),
    mRow(raids[1].id, 'b', 'left_early', null), mRow(raids[2].id, 'b', 'late', 0.5),
  ];
  const result = metrics.teamMetrics(metricsInput({ policy: p, raids, rows, people, windowWeeks: 8 }));
  assert.deepEqual([result.people.a.pct, result.people.a.counted, result.people.a.pending], [100, 1, 2]);
  assert.deepEqual([result.people.b.pct, result.people.b.counted, result.people.b.pending], [50, 1, 1]);
  assert.deepEqual(result.people.a.cells.map((cell) => cell.letter), ['P', 'L?', 'LE?']);
  assert.equal(result.awaitingReview, 2, 'the 10-03 and 10-09 raids each have a pending cell');
});

check('metrics: sign-up rate counts signed / late / bench sign-ups over raids that have a sign-up source, after the start', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const raids = [
    { id: 'r1', raidOn: '2026-09-29', hasSignups: true }, { id: 'r2', raidOn: '2026-10-02', hasSignups: true },
    { id: 'r3', raidOn: '2026-10-03', hasSignups: false }, { id: 'r4', raidOn: '2026-10-09', hasSignups: true }, { id: 'r5', raidOn: '2026-10-10', hasSignups: true },
  ];
  const rows = [
    mRow('r1', 'a', 'present', 1, { signupKind: 'signed' }), mRow('r2', 'a', 'bench', 1, { signupKind: 'bench' }), mRow('r3', 'a', 'present', 1),
    mRow('r4', 'a', 'missed_notice', 0, { signupKind: 'absence' }), mRow('r5', 'a', 'tentative', null, { signupKind: 'tentative' }),
  ];
  const result = metrics.teamMetrics(metricsInput({ policy: p, raids, rows, windowWeeks: 'all' })).people.a;
  assert.equal(result.signupRate, 50, '2 of the 4 raids with a sign-up source (r3 has none and is not in the denominator)');
  // Before the effective start a raid is not in the range: join 10-02 and first attended 09-29 -> start 10-02, r1 drops out.
  const joined = metrics.teamMetrics(metricsInput({ policy: p, raids, rows, people: [{ id: 'a', joinedOn: '2026-10-02' }], windowWeeks: 'all' })).people.a;
  assert.equal(joined.signupRate, 33.3);
  // No raid with a source: null.
  const none = metrics.teamMetrics(metricsInput({ policy: p, raids: [{ id: 'r3', raidOn: '2026-10-03', hasSignups: false }], rows: [mRow('r3', 'a', 'present', 1)], windowWeeks: 'all' })).people.a;
  assert.equal(none.signupRate, null);
  // The window limits the range: 1 week from Saturday 10-10 is the week of 10-06.
  const week = metrics.teamMetrics(metricsInput({ policy: p, raids, rows, windowWeeks: 1 })).people.a;
  assert.equal(week.signupRate, 0, 'r4 absence and r5 tentative: 0 of 2');
});

check('metrics: streak skips uncounted cells and ends at any counted cell with credit; last attended includes Other-team and bench cells', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const dates = ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29', '2026-10-06'];
  const raids = raidsOn(...dates);
  const make = (list) => metrics.teamMetrics(metricsInput({ policy: p, raids, rows: list.map(([i, outcome, credit]) => mRow(raids[i].id, 'a', outcome, credit)), windowWeeks: 'all' })).people.a;
  let result = make([[0, 'present', 1], [1, 'missed', 0], [2, 'tentative', null], [3, 'missed_notice', 0], [4, 'no_signup', null], [5, 'missed', 0]]);
  assert.deepEqual([result.streak, result.streakFlag, result.lastAttended], [3, false, '2026-09-01']);
  result = make([[0, 'present', 1], [1, 'missed', 0], [2, 'missed', 0], [3, 'missed_notice', 0], [4, 'late', null], [5, 'missed', 0]]);
  assert.deepEqual([result.streak, result.streakFlag], [4, true], 'a pending late cell is skipped; four misses reach the flag');
  result = make([[0, 'missed', 0], [1, 'missed', 0], [2, 'present', 1], [3, 'missed', 0]]);
  assert.equal(result.streak, 1);
  result = make([[0, 'missed', 0], [1, 'bench', 1], [2, 'missed', 0], [3, 'fill_in', 1]]);
  assert.deepEqual([result.streak, result.lastAttended], [0, '2026-09-22'], 'Other-team and bench credit end a streak and count as attended');
  result = make([[0, 'present', 1], [1, 'bench', 1], [4, 'missed', 0]]);
  assert.equal(result.lastAttended, '2026-09-08');
  // streakFlagAt 0 turns the highlight off, other values move it.
  const off = metrics.teamMetrics(metricsInput({ policy: policy.resolvePolicy({ streakFlagAt: 0 }, null, 'US'), raids, rows: raids.map((raid) => mRow(raid.id, 'a', 'missed', 0)), windowWeeks: 'all' })).people.a;
  assert.deepEqual([off.streak, off.streakFlag], [6, false]);
  const two = metrics.teamMetrics(metricsInput({ policy: policy.resolvePolicy({ streakFlagAt: 2 }, null, 'US'), raids, rows: raids.slice(0, 2).map((raid) => mRow(raid.id, 'a', 'missed', 0)), windowWeeks: 'all' })).people.a;
  assert.equal(two.streakFlag, true);
  // The streak is not cut by the window.
  const cut = metrics.teamMetrics(metricsInput({ policy: p, raids, rows: raids.map((raid) => mRow(raid.id, 'a', 'missed', 0)), windowWeeks: 1 })).people.a;
  assert.equal(cut.streak, 6);
});

check('metrics: borrowed fill-ins are extra counted cells on the host date; a replaced home cell is an ordinary Other-team cell', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const raids = raidsOn('2026-09-25', '2026-10-02', '2026-10-09');
  const result = metrics.teamMetrics(metricsInput({
    policy: p, raids, windowWeeks: 8,
    rows: [mRow(raids[0].id, 'a', 'present', 1), mRow(raids[1].id, 'a', 'missed', 0), mRow(raids[2].id, 'a', 'fill_in', 1, { viaRaidId: 'hostR', viaTeamId: 'T2' })],
    borrowed: [{ playerId: 'a', raidId: 'hostR2', raidOn: '2026-10-03', teamId: 'T3' }],
  })).people.a;
  assert.deepEqual(result.cells.map((cell) => [cell.date, cell.outcome, cell.letter, cell.via, cell.credit]), [
    ['2026-09-25', 'present', 'P', null, 1], ['2026-10-02', 'missed', 'M', null, 0], ['2026-10-03', 'fill_in', 'F', 'T3', 1], ['2026-10-09', 'fill_in', 'F', 'T2', 1],
  ]);
  assert.deepEqual([result.pct, result.counted, result.lastAttended], [75, 4, '2026-10-09']);
  assert.equal(result.cells[2].weekStart, '2026-09-29');
  // A row of a raid that is not in the team's raids is ignored.
  const stray = metrics.teamMetrics(metricsInput({ policy: p, raids, rows: [mRow('other', 'a', 'present', 1)], windowWeeks: 8 })).people.a;
  assert.equal(stray.cells.length, 0);
});

check('metrics: week groups, personHistory, determinism and the input is not mutated', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const raids = raidsOn('2026-10-10', '2026-09-18', '2026-10-02', '2026-09-19', '2026-10-03', '2026-10-09');
  const rows = raids.map((raid, i) => mRow(raid.id, 'a', i % 2 ? 'missed' : 'present', i % 2 ? 0 : 1));
  const input = deepFreeze(metricsInput({ policy: p, raids, rows, windowWeeks: 8, people: [{ id: 'a', joinedOn: '2026-01-01' }] }));
  const result = metrics.teamMetrics(input);
  assert.deepEqual(result.weeks.map((week) => [week.weekStart, week.raids.map((raid) => raid.raidOn)]), [
    ['2026-09-15', ['2026-09-18', '2026-09-19']], ['2026-09-29', ['2026-10-02', '2026-10-03']], ['2026-10-06', ['2026-10-09', '2026-10-10']],
  ]);
  assert.deepEqual(result.people.a.cells.map((cell) => cell.date), [...result.people.a.cells.map((cell) => cell.date)].sort());
  const eu = metrics.teamMetrics(metricsInput({ policy: p, raids, rows, windowWeeks: 8, resetDay: 3, people: [{ id: 'a', joinedOn: '2026-01-01' }] }));
  assert.deepEqual(eu.weeks.map((week) => week.weekStart), ['2026-09-16', '2026-09-30', '2026-10-07']);
  const reversed = metrics.teamMetrics(metricsInput({ policy: p, raids: [...raids].reverse(), rows: [...rows].reverse(), windowWeeks: 8, people: [{ id: 'a', joinedOn: '2026-01-01' }] }));
  assert.deepEqual(JSON.parse(JSON.stringify(reversed)), JSON.parse(JSON.stringify(result)));
  // personHistory: one block per team, newest first, each team with its own policy.
  const history = metrics.personHistory({
    person: { id: 'a', joinedOn: '2026-01-01' }, today: '2026-10-10', windowWeeks: 'all',
    teams: [
      { teamId: 'T1', raids, rows, borrowed: [], policy: p, resetDay: 2 },
      { teamId: 'T2', raids: raidsOn('2026-10-06'), rows: [mRow('r2026-10-06', 'a', 'bench', 1)], borrowed: [], policy: policy.resolvePolicy({ bench: 'excluded' }, null, 'US'), resetDay: 2 },
    ],
  });
  assert.deepEqual(history.teams.map((team) => team.teamId), ['T1', 'T2']);
  assert.equal(history.teams[0].cells[0].date, '2026-10-10');
  assert.equal(history.teams[0].cells.at(-1).date, '2026-09-18');
  assert.equal(history.teams[0].metrics.pctAll, 75, 'the two raids before the first attended one are pre-start');
  assert.equal(history.teams[1].metrics.pctAll, null, 'the second team excludes bench from the %');
});

check('metrics: a 40-person, 200-raid team computes well inside a generous bound (catches accidental quadratic code)', async () => {
  const { policy, metrics } = await modules();
  const p = policy.resolvePolicy(null, null, 'US');
  const people = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, joinedOn: '2024-01-01' }));
  const raids = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, raidOn: new Date(Date.UTC(2023, 0, 1) + i * 3 * 86400000).toISOString().slice(0, 10), hasSignups: true }));
  const outcomes = [['present', 1], ['missed', 0], ['bench', 1], ['late', null], ['tentative', null]];
  const rows = [];
  for (const person of people) raids.forEach((raid, i) => { const [outcome, credit] = outcomes[(i + person.id.length * i) % 5]; rows.push(mRow(raid.id, person.id, outcome, credit, { signupKind: 'signed' })); });
  assert.equal(rows.length, 8000);
  const started = process.hrtime.bigint();
  const result = metrics.teamMetrics({ people, raids, rows, borrowed: [], policy: p, today: '2025-01-01', resetDay: 2, windowWeeks: 'all' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(Object.keys(result.people).length, 40);
  assert(ms < 200, `took ${ms.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------
// Fixtures: anonymization and goldens

const readFixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const eventFiles = () => fs.readdirSync(FIXTURES).filter((name) => /^event-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const FAKE_PREFIX = '99000000000000';

check('fixtures leak test: no real-looking Discord ID, no nickname, no report code or title in any fixture', () => {
  const names = fs.readdirSync(FIXTURES).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 9, '8 events and roster.json');
  assert.deepEqual(fs.readdirSync(FIXTURES).filter((name) => !name.endsWith('.json')), [], 'only JSON files are committed');
  const roster = readFixture('roster.json');
  const allowedLabels = /^Signup\d{2}$/;
  for (const name of names) {
    const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    for (const run of text.match(/\d{17,20}/g) || []) assert(run.startsWith(FAKE_PREFIX), `${name}: ${run} looks like a Discord ID`);
    assert(!/nickname/i.test(text), `${name}: a nickname key`);
    assert(!/"title"|"owner"|"zone"|"avatar"|"username"/.test(text), `${name}: report or Discord profile fields`);
    for (const code of text.match(/"code": "([^"]*)"/g) || []) assert(/"FIXTURE\d{9}"/.test(code), `${name}: ${code}`);
  }
  for (const name of eventFiles()) {
    const fixture = readFixture(name);
    assert.equal(fixture.event.serverId, '990000000000009001');
    assert.deepEqual(Object.keys(fixture.event), ['startTime', 'serverId']);
    for (const signup of fixture.signups) {
      assert(signup.userId.startsWith(FAKE_PREFIX) && signup.userId.length === 18, `${name}: ${signup.userId}`);
      assert(allowedLabels.test(signup.name), `${name}: sign-up name ${signup.name} is not an invented label`);
      assert.deepEqual(Object.keys(signup).sort(), ['className', 'id', 'name', 'personId', 'position', 'specName', 'status', 'userId']);
    }
    for (const report of fixture.reports) {
      assert.match(report.code, /^FIXTURE\d{9}$/);
      assert.equal(report.code.length, 16);
    }
  }
  for (const rosterPerson of roster.persons) {
    if (rosterPerson.discordUserId) assert(rosterPerson.discordUserId.startsWith(FAKE_PREFIX) && rosterPerson.discordUserId.length === 18);
    assert(rosterPerson.label === null || allowedLabels.test(rosterPerson.label));
    for (const character of rosterPerson.characters) if (character.invented) assert(allowedLabels.test(character.name), character.name);
  }
  // Every fixture Discord id is unique per person and consistent across events.
  const owners = new Map();
  for (const name of eventFiles()) for (const signup of readFixture(name).signups) {
    if (owners.has(signup.userId)) assert.equal(owners.get(signup.userId), signup.personId);
    owners.set(signup.userId, signup.personId);
  }
});

const KIND_OF = { Absence: 'absence', Bench: 'bench', Tentative: 'tentative', Late: 'late' };
const kindOfClass = (className) => KIND_OF[className] || 'signed';

// Evidence for one fixture event. people = everyone with a sign-up or in the log (the raid's own people), or the whole roster.
function fixtureEvidence(fixture, roster, { wholeRoster = false, teamId = 'team1', raidId } = {}) {
  const pulls = fixture.reports.flatMap((report) => report.pulls).map((p) => ({ startedAt: p.startedAt, kill: p.kill, keys: p.players.map((name) => `${name.normalize('NFC').toLowerCase()}|`) }));
  const inLog = new Set(pulls.flatMap((p) => p.keys));
  const signed = new Set(fixture.signups.map((s) => s.personId));
  const people = roster.persons
    .filter((p) => wholeRoster || signed.has(p.id) || p.characters.some((c) => inLog.has(c.key)))
    .map((p) => ({ playerId: p.id, status: p.status, joinedOn: p.joinedOn, characters: p.characters.map((c) => ({ key: c.key, teamId: c.teamId })) }));
  return {
    raid: { id: raidId || fixture.raidOn, teamId, raidOn: fixture.raidOn, hasLog: true, manual: false },
    people,
    signups: fixture.signups.map((s) => ({ playerId: s.personId, kind: kindOfClass(s.className), source: 'raid_helper' })),
    pulls, manualPresent: [], guests: [], decisions: {},
  };
}
const tally = (rows) => rows.reduce((acc, row) => { acc[row.outcome] = (acc[row.outcome] || 0) + 1; return acc; }, {});

check('golden 2026-10-10: two reports merged by absolute time, 17 pulls (1 kill / 16 wipes), the guild-local date, and the row counts', async () => {
  const { calendar, policy, consolidate } = await modules();
  const roster = readFixture('roster.json');
  const fixture = readFixture('event-2026-10-10.json');
  const p = policy.resolvePolicy(null, null, 'US');
  // Date: the event starts 2026-10-11T00:00Z = 19:00 on 10/10 in Chicago; the later report starts 02:21Z, still 10/10.
  assert.equal(calendar.localDate(fixture.event.startTime, fixture.guildTimeZone), '2026-10-10');
  assert.equal(fixture.reports.length, 2);
  const byStart = [...fixture.reports].sort((a, b) => a.startTime - b.startTime);
  assert.equal(new Date(byStart[0].startTime).toISOString(), '2026-10-10T23:59:21.047Z');
  assert.equal(new Date(byStart[1].startTime).toISOString(), '2026-10-11T02:21:35.920Z');
  assert.equal(calendar.localDate(byStart[1].startTime, fixture.guildTimeZone), '2026-10-10');
  const allPulls = fixture.reports.flatMap((report) => report.pulls.map((x) => ({ ...x, code: report.code }))).sort((a, b) => a.startedAt - b.startedAt);
  assert.equal(allPulls.length, 17);
  assert.deepEqual([allPulls.filter((x) => x.kill).length, allPulls.filter((x) => !x.kill).length], [1, 16]);
  assert.equal(allPulls[0].code, byStart[0].code, 'the first pull belongs to the earlier-started report');
  assert.equal(allPulls.at(-1).code, byStart[1].code, 'the last pull belongs to the later report');
  assert.equal(allPulls.at(-1).name, 'Illidan Stormrage');
  assert.equal(allPulls.at(-1).kill, false);
  // Sign-ups: 28 = 2 Absence, 1 Bench, 2 Tentative, 23 signed; 26 distinct log players.
  assert.equal(fixture.signups.length, 28);
  const kinds = fixture.signups.map((s) => kindOfClass(s.className)).reduce((acc, k) => ({ ...acc, [k]: (acc[k] || 0) + 1 }), {});
  assert.deepEqual(kinds, { signed: 23, absence: 2, bench: 1, tentative: 2 });
  assert.equal(new Set(allPulls.flatMap((x) => x.players.map((n) => n.toLowerCase()))).size, 26);

  const evid = fixtureEvidence(fixture, roster);
  const result = consolidate.consolidateRaid(evid, p);
  assert.equal(result.rows.length, 32);
  assert.deepEqual(tally(result.rows), { present: 24, late: 1, left_early: 1, missed: 3, missed_notice: 2, tentative: 1 });
  assert.equal(result.openFlags, 5);
  assert.deepEqual(result.unmatched, []);
  // Present = 20 signed + 4 in the log with no sign-up.
  const present = result.rows.filter((row) => row.outcome === 'present');
  assert.deepEqual([present.filter((row) => row.signupKind === 'signed').length, present.filter((row) => row.signupKind === null).length], [20, 4]);
  // The Late one is a Tentative sign-up present 8 of 17 who missed pull 1; the Left-early one a Bench sign-up present 9 of 17 who missed the last.
  const late = result.rows.find((row) => row.outcome === 'late');
  assert.deepEqual([late.signupKind, late.pullsPresent, late.pullsTotal, late.missedFirst, late.missedLast, late.credit, late.flags], ['tentative', 8, 17, 1, 0, null, ['late']]);
  const left = result.rows.find((row) => row.outcome === 'left_early');
  assert.deepEqual([left.signupKind, left.pullsPresent, left.pullsTotal, left.missedFirst, left.missedLast, left.flags], ['bench', 9, 17, 0, 1, ['left_early']]);
  for (const row of result.rows.filter((r) => r.outcome === 'missed')) assert.deepEqual([row.signupKind, row.flags, row.credit], ['signed', ['no_show'], 0]);
  assert.equal(result.rows.filter((row) => row.needsReview).length, 5);
  assert.deepEqual(result.rows.map((row) => row.playerId), [...result.rows.map((row) => row.playerId)].sort(), 'sorted by player id');

  // Variants.
  const asSigned = consolidate.consolidateRaid(evid, policy.resolvePolicy({ tentative: 'asSignedUp' }, null, 'US'));
  assert.deepEqual(tally(asSigned.rows), { present: 24, late: 1, left_early: 1, missed: 4, missed_notice: 2 });
  assert.equal(asSigned.openFlags, 6);
  const excused = consolidate.consolidateRaid(evid, policy.resolvePolicy({ absence: 'excused' }, null, 'US'));
  assert.deepEqual(tally(excused.rows), tally(result.rows), 'absence: excused leaves the rows alone');
  assert.deepEqual(excused.rows.filter((row) => row.outcome === 'missed_notice').map((row) => row.credit), [null, null]);
  const lateSignup = consolidate.consolidateRaid(evid, policy.resolvePolicy({ lateSignup: 'flagLikeOthers' }, null, 'US'));
  assert.deepEqual(tally(lateSignup.rows), tally(result.rows), 'lateSignup is irrelevant here');
  // The whole roster as people: everyone else on it shows as No sign-up (not counted).
  const whole = consolidate.consolidateRaid(fixtureEvidence(fixture, roster, { wholeRoster: true }), p);
  assert.equal(whole.rows.length, roster.persons.length);
  assert.equal(whole.rows.filter((row) => row.outcome === 'no_signup').length, roster.persons.length - 32);
  assert.equal(whole.openFlags, 5);
  const hidden = consolidate.consolidateRaid(fixtureEvidence(fixture, roster, { wholeRoster: true }), policy.resolvePolicy({ noSignup: 'hidden' }, null, 'US'));
  assert.equal(hidden.rows.length, 32);
});

check('golden 2026-10-02: two reports, 31 sign-ups, one person with no sign-up misses the last pull and is flagged left early', async () => {
  const { policy, consolidate } = await modules();
  const roster = readFixture('roster.json');
  const fixture = readFixture('event-2026-10-02.json');
  assert.equal(fixture.signups.length, 31);
  assert.equal(fixture.reports.length, 2);
  const evid = fixtureEvidence(fixture, roster);
  const result = consolidate.consolidateRaid(evid, policy.resolvePolicy(null, null, 'US'));
  assert.equal(evid.pulls.length, 10);
  const flagged = result.rows.filter((row) => row.flags.includes('left_early'));
  assert.equal(flagged.length, 1);
  assert.deepEqual([flagged[0].outcome, flagged[0].signupKind, flagged[0].pullsPresent, flagged[0].pullsTotal, flagged[0].missedLast], ['left_early', null, 9, 10, 1]);
  assert.deepEqual(tally(result.rows), { present: 24, left_early: 1, missed: 2, missed_notice: 6, bench: 1, tentative: 1 });
  assert.equal(result.openFlags, 3);
});

check('golden 2026-10-03: two reports, 16 pulls, every log player in both the first and last pull -> no late / left flags', async () => {
  const { policy, consolidate } = await modules();
  const roster = readFixture('roster.json');
  const fixture = readFixture('event-2026-10-03.json');
  const evid = fixtureEvidence(fixture, roster);
  assert.equal(evid.pulls.length, 16);
  assert.equal(fixture.reports.length, 2);
  const sorted = [...evid.pulls].sort((a, b) => a.startedAt - b.startedAt);
  const everyone = new Set(evid.pulls.flatMap((x) => x.keys));
  for (const k of everyone) assert(sorted[0].keys.includes(k) && sorted.at(-1).keys.includes(k), `${k} in first and last pull`);
  const result = consolidate.consolidateRaid(evid, policy.resolvePolicy(null, null, 'US'));
  assert.equal(result.rows.filter((row) => row.flags.some((f) => f === 'late' || f === 'left_early')).length, 0);
  assert.equal(result.rows.filter((row) => ['late', 'left_early', 'late_left'].includes(row.outcome)).length, 0);
  assert.deepEqual(tally(result.rows), { present: 25, tentative: 1, missed: 1, missed_notice: 6 });
});

check('goldens: the other five events match the builder\'s independent tally (default policy, signed-up mode)', async () => {
  const { policy, consolidate } = await modules();
  const roster = readFixture('roster.json');
  const expected = {
    '2026-09-18': { rows: 33, outcomes: { present: 25, bench: 2, missed_notice: 2, missed: 4 }, openFlags: 4, pulls: 10, kills: 5 },
    '2026-09-19': { rows: 36, outcomes: { present: 25, tentative: 2, bench: 1, missed_notice: 3, missed: 5 }, openFlags: 5, pulls: 10, kills: 7 },
    '2026-09-25': { rows: 36, outcomes: { present: 25, tentative: 2, bench: 1, missed_notice: 4, missed: 4 }, openFlags: 4, pulls: 12, kills: 7 },
    '2026-09-26': { rows: 39, outcomes: { present: 24, missed_notice: 5, bench: 1, missed: 7, late: 1, left_early: 1 }, openFlags: 9, pulls: 6, kills: 5 },
    '2026-10-09': { rows: 31, outcomes: { present: 25, missed_notice: 3, missed: 3 }, openFlags: 3, pulls: 13, kills: 7 },
  };
  for (const [date, want] of Object.entries(expected)) {
    const fixture = readFixture(`event-${date}.json`);
    const result = consolidate.consolidateRaid(fixtureEvidence(fixture, roster), policy.resolvePolicy(null, null, 'US'));
    const pulls = fixture.reports.flatMap((report) => report.pulls);
    assert.deepEqual([pulls.length, pulls.filter((x) => x.kill).length], [want.pulls, want.kills], date);
    assert.equal(result.rows.length, want.rows, date);
    assert.deepEqual(tally(result.rows), want.outcomes, date);
    assert.equal(result.openFlags, want.openFlags, date);
    assert.deepEqual(result.unmatched, [], date);
  }
  // 09-26: the Left-early one is a signed-up player present 5 of 6, the Late one an unsigned player present 1 of 6.
  const result = consolidate.consolidateRaid(fixtureEvidence(readFixture('event-2026-09-26.json'), roster), policy.resolvePolicy(null, null, 'US'));
  const late = result.rows.find((row) => row.outcome === 'late');
  const left = result.rows.find((row) => row.outcome === 'left_early');
  assert.deepEqual([late.signupKind, late.pullsPresent, late.pullsTotal], [null, 1, 6]);
  assert.deepEqual([left.signupKind, left.pullsPresent, left.pullsTotal], ['signed', 5, 6]);
});

// Metrics over the 8 events: one team, join dates 2026-08-01.
async function fixtureMetrics({ today, resetDay, windowWeeks, policyOver = null, region = 'US' }) {
  const { policy, consolidate, metrics } = await modules();
  const roster = readFixture('roster.json');
  const p = policy.resolvePolicy(policyOver, null, region);
  const raids = [];
  const rows = [];
  for (const name of eventFiles()) {
    const fixture = readFixture(name);
    const result = consolidate.consolidateRaid(fixtureEvidence(fixture, roster, { wholeRoster: true }), p);
    raids.push({ id: fixture.raidOn, raidOn: fixture.raidOn, hasSignups: true });
    for (const row of result.rows) rows.push({ ...row, raidId: fixture.raidOn });
  }
  const people = roster.persons.map((x) => ({ id: x.id, joinedOn: x.joinedOn }));
  const nameOf = new Map(roster.persons.map((x) => [x.characters[0].name, x.id]));
  return { result: metrics.teamMetrics({ people, raids, rows, borrowed: [], policy: p, today, resetDay: resetDay === undefined ? p.resetDay : resetDay, windowWeeks }), nameOf, p };
}

check('metrics goldens over the 8 events: week bucketing for US Tuesday and EU Wednesday', async () => {
  const us = await fixtureMetrics({ today: '2026-11-10' });
  assert.deepEqual(us.result.weeks.map((week) => [week.weekStart, week.raids.map((raid) => raid.raidOn)]), [
    ['2026-09-15', ['2026-09-18', '2026-09-19']], ['2026-09-22', ['2026-09-25', '2026-09-26']],
    ['2026-09-29', ['2026-10-02', '2026-10-03']], ['2026-10-06', ['2026-10-09', '2026-10-10']],
  ]);
  const eu = await fixtureMetrics({ today: '2026-11-10', region: 'EU' });
  assert.deepEqual(eu.result.weeks.map((week) => week.weekStart), ['2026-09-16', '2026-09-23', '2026-09-30', '2026-10-07']);
  assert.equal(eu.p.resetDay, 3);
});

check('metrics goldens over the 8 events: the window switch 8 / 12 / all-time changes who is counted, for the same people', async () => {
  // today = Tuesday 2026-11-10: 8 weeks start 09-22 (the 09-18 / 09-19 raids fall out), 12 weeks start 08-25 (all eight), all-time keeps all.
  const w8 = await fixtureMetrics({ today: '2026-11-10', windowWeeks: 8 });
  const w12 = await fixtureMetrics({ today: '2026-11-10', windowWeeks: 12 });
  const all = await fixtureMetrics({ today: '2026-11-10', windowWeeks: 'all' });
  assert.equal(w8.result.windowStart, '2026-09-22');
  assert.equal(w12.result.windowStart, '2026-08-25');
  assert.equal(all.result.windowStart, null);
  const id = (r, name) => r.result.people[r.nameOf.get(name)];
  // Daolith: present in all six of the last six raids.
  assert.deepEqual([id(w8, 'Daolith').pct, id(w8, 'Daolith').counted, id(w8, 'Daolith').pctAll], [100, 6, 100]);
  // Bearnnaked: 1 present in 6 counted raids in the 8-week window (16.7), 3 of 8 all-time (37.5), a 5-raid miss streak.
  const bearn = [id(w8, 'Bearnnaked'), id(w12, 'Bearnnaked'), id(all, 'Bearnnaked')];
  assert.deepEqual(bearn.map((x) => x.pct), [16.7, 37.5, 37.5]);
  assert.deepEqual(bearn.map((x) => x.counted), [6, 8, 8]);
  assert.deepEqual([bearn[0].streak, bearn[0].streakFlag, bearn[0].lastAttended], [5, true, '2026-09-25']);
  // Apocalypse: 33.3% all-time (2 present of her 6 counted cells), none present in the 8-week window, a streak of 4 (flagged).
  const apoc = id(w8, 'Apocálypse');
  assert.deepEqual([apoc.pct, apoc.pctAll, apoc.streak, apoc.streakFlag, apoc.lastAttended], [0, 33.3, 4, true, '2026-09-19']);
  // Daxxter: 5 counted in the window (3 present of 5), 71.4 over 7 all-time.
  const dax = id(w8, 'Daxxter');
  assert.deepEqual([dax.pct, dax.pctAll, dax.counted], [60, 71.4, 5]);
  // A log-only player has no sign-ups: sign-up rate null; one who signed up every time is 100.
  assert.equal(id(w8, 'Daolith').signupRate, 100);
  assert.equal(id(w8, 'Aimersmay').signupRate, 0, 'Aimersmay raids but never signed up');
  // Pending late / left-early cells are awaiting review: 09-26, 10-02 and 10-10 are the raids with open late / left flags.
  assert.equal(w8.result.awaitingReview, 3);
  assert.equal(w12.result.awaitingReview, 3);
  assert.equal(id(w8, 'Terani').pending, 1);
  assert.equal(id(w8, 'Terani').pct, 60, 'the pending cell is not in the %');
  // The wider window adds the two earliest raids (09-18 / 09-19) to everyone who has cells there.
  assert.deepEqual([id(w8, 'Daolith').counted, id(w12, 'Daolith').counted, id(all, 'Daolith').counted], [6, 8, 8]);
});

check('metrics goldens: absence: excused takes the two 10/10 missed_notice cells out of the counts', async () => {
  const { policy, consolidate, metrics } = await modules();
  const roster = readFixture('roster.json');
  const fixture = readFixture('event-2026-10-10.json');
  const run = (over) => {
    const p = policy.resolvePolicy(over, null, 'US');
    const result = consolidate.consolidateRaid(fixtureEvidence(fixture, roster), p);
    const raids = [{ id: 'r10', raidOn: '2026-10-10', hasSignups: true }];
    const rows = result.rows.map((row) => ({ ...row, raidId: 'r10' }));
    return { result, out: metrics.teamMetrics({ people: roster.persons.map((x) => ({ id: x.id, joinedOn: x.joinedOn })), raids, rows, borrowed: [], policy: p, today: '2026-10-10', resetDay: 2, windowWeeks: 'all' }) };
  };
  const notice = run(null);
  const excused = run({ absence: 'excused' });
  const noticeIds = notice.result.rows.filter((row) => row.outcome === 'missed_notice').map((row) => row.playerId);
  assert.equal(noticeIds.length, 2);
  for (const id of noticeIds) {
    assert.deepEqual([notice.out.people[id].counted, notice.out.people[id].pctAll], [1, 0], 'with notice: a counted miss');
    assert.deepEqual([excused.out.people[id].counted, excused.out.people[id].pctAll], [0, null], 'excused: not counted');
    assert.equal(excused.out.people[id].cells[0].outcome, 'missed_notice');
  }
});

async function main() {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String(error && error.stack || error).split('\n').slice(0, 10).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
