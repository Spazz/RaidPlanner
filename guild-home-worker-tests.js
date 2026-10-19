/**
 * Raidsmith guild tracker - officer Home redesign (round 2), lane H1: Worker and data tests.
 * Run: node guild-home-worker-tests.js [name-filter]
 *
 * Pure: buildAttention with shared dismissals (dismiss, snooze, fingerprints, the watch return rule), readiness facts outside `total`, the `week` block and rights per team.
 * Routes: POST /attention/dismissals and DELETE /attention/dismissals/:itemid over the node:sqlite D1 stand-in (the server decides mode, `until` and fingerprint), the
 * audit rows and their sentences, View-as Member, and the Attendance team payload's watch entries (latestMissedRaidId, itemId, reviewed).
 */
const assert = require('node:assert/strict');
const { load, adminOf, memberOf, makeWorld, signIn } = require('./tests/guild-world');

const SERVER = '900000000000000041';
const LOCAL = 'http://127.0.0.1:8790';
const COOKIE = '__Host-rs_viewas';
const person = (n, name) => ({ id: `1100000000000002${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(1, 'Gmhome'), off: person(2, 'Officerhome'), lead: person(3, 'Leadhome'), m1: person(4, 'Memberhome') };
const DAY = 86400000;
const TZ = 'America/New_York';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ===========================================================================
// PURE: worker/attention.js

const NOW = Date.parse('2027-01-15T15:00:00Z');   // 10:00 on Fri 2027-01-15 in New York
const TODAY = '2027-01-15';
const TEAMS = [{ id: 't_a', name: 'Alpha', size: 25, archived: 0 }, { id: 't_b', name: 'Bravo', size: 10, archived: 0 }, { id: 't_old', name: 'Old', size: 25, archived: 1 }];
const raidRow = (id, team, on, extra = {}) => ({ id, team_id: team, raid_on: on, zone: 'Karazhan', title: null, event_title: null, ...extra });
const baseInput = (over = {}) => ({
  today: TODAY, now: NOW, teams: TEAMS, allowsTeam: () => true, granted: () => true,
  flaggedRaids: [], lootUnmatched: [], signupUnmatched: [], claims: 0, trials: [], noLoot: [], upcoming: [], watch: [], ...over,
});
const dismissal = (itemId, kind, mode, fingerprint, extra = {}) => ({ item_id: itemId, kind, team_id: 't_a', mode, until: null, fingerprint, dismissed_by: 'u_x', created_at: NOW - 1000, by_name: 'Bob', ...extra });
const watchEntry = (pct, latestMissedRaidId, over = {}) => ({ playerId: 'p_w', name: 'Kaelith', class: 'ROGUE', pct, previousPct: null, drop: null, reasons: ['below'], latestMissedRaidId, ...over });

check('pure: a shared dismiss hides the item for every officer, with who and when in `hidden`, and leaves the total', async () => {
  const { buildAttention } = await load('worker/attention.js');
  const input = baseInput({ noLoot: [raidRow('r1', 't_a', '2027-01-10'), raidRow('r2', 't_a', '2027-01-11')] });
  assert.equal(buildAttention(input).total, 2);
  const hiddenBy = [dismissal('no_loot:r1', 'no_loot', 'dismiss', 'r1')];
  for (const officer of [{ allowsTeam: () => true }, { allowsTeam: (action, teamId) => teamId === 't_a' }]) {
    const built = buildAttention({ ...input, ...officer, dismissals: hiddenBy });
    assert.deepEqual(built.items.map((i) => i.id), ['no_loot:r2']);
    assert.equal(built.total, 1);
    assert.deepEqual(built.hidden.map((h) => [h.item.id, h.mode, h.until, h.by, h.at]), [['no_loot:r1', 'dismiss', null, { name: 'Bob' }, NOW - 1000]]);
  }
  // A dismissal of another kind under the same id, or for an item that is gone, hides nothing.
  assert.equal(buildAttention({ ...input, dismissals: [dismissal('no_loot:r1', 'log_missing', 'dismiss', 'r1')] }).items.length, 2);
  assert.equal(buildAttention({ ...input, dismissals: [dismissal('no_loot:r9', 'no_loot', 'dismiss', 'r9')] }).hidden.length, 0);
  // A permanent per-raid kind keeps its fingerprint: the raid id.
  const built = buildAttention({ ...input, dismissals: [dismissal('no_loot:r1', 'no_loot', 'dismiss', 'something else')] });
  assert.equal(built.items.length, 2, 'a fingerprint that no longer matches brings the item back');
});

check('pure: a snooze comes back when it ends; a trial end date change brings it back early', async () => {
  const { buildAttention, DISMISS_RULES, dismissalUntil } = await load('worker/attention.js');
  const trial = (end) => ({ id: 'p_t1', trial_end: end, name: 'Thoren', class: 'PALADIN', team_id: 't_a' });
  const snooze = (until, fingerprint = '2027-01-18') => dismissal('trial:p_t1', 'trial', 'snooze', fingerprint, { until });
  assert.equal(buildAttention(baseInput({ trials: [trial('2027-01-18')], dismissals: [snooze(NOW + 1)] })).total, 0, 'still snoozed');
  const back = buildAttention(baseInput({ trials: [trial('2027-01-18')], dismissals: [snooze(NOW)] }));
  assert.deepEqual([back.total, back.hidden.length], [1, 0], 'the snooze ran out');
  const moved = buildAttention(baseInput({ trials: [trial('2027-01-20')], dismissals: [snooze(NOW + DAY)] }));
  assert.deepEqual([moved.total, moved.hidden.length], [1, 0], 'the end date changed: back before the snooze ends');
  const webhook = (status) => baseInput({ webhooksOff: [{ team_id: 't_a', disabled_status: status }], dismissals: [dismissal('webhook_off:t_a', 'webhook_off', 'snooze', '404', { until: NOW + DAY })] });
  assert.equal(buildAttention(webhook(404)).total, 0);
  assert.equal(buildAttention(webhook(401)).total, 1, "Discord's status changed");
  // The fixed lengths.
  assert.deepEqual([DISMISS_RULES.trial.days, DISMISS_RULES.webhook_off.days, DISMISS_RULES.trial.mode, DISMISS_RULES.watch.mode], [3, 7, 'snooze', 'reviewed']);
  assert.equal(dismissalUntil('trial', NOW), NOW + 3 * DAY);
  assert.equal(dismissalUntil('webhook_off', NOW), NOW + 7 * DAY);
  assert.equal(dismissalUntil('no_loot', NOW), null);
  assert.equal(dismissalUntil('watch', NOW), null);
});

check('pure: loot_unmatched, signup_unmatched and event_moved come back when what was dismissed changes', async () => {
  const { buildAttention } = await load('worker/attention.js');
  const loot = (keys, names) => baseInput({ lootUnmatched: [{ raid_id: 'r1', team_id: 't_a', raid_on: '2027-01-14', zone: null, title: null, event_title: null, names, keys }] });
  const lootRow = dismissal('loot_unmatched:r1', 'loot_unmatched', 'dismiss', 'ann|nightslayer,bob|nightslayer');
  assert.equal(buildAttention({ ...loot('bob|nightslayer,ann|nightslayer', 2), dismissals: [lootRow] }).total, 0, 'the order of the names does not matter');
  assert.equal(buildAttention({ ...loot('ann|nightslayer,cy|nightslayer', 2), dismissals: [lootRow] }).total, 1, 'same count, other names: back');
  assert.equal(buildAttention({ ...loot(undefined, 2), dismissals: [dismissal('loot_unmatched:r1', 'loot_unmatched', 'dismiss', '2')] }).total, 0, 'without the keys the count is the fingerprint');
  const signups = (n) => baseInput({ signupUnmatched: [{ raid_id: 'r9', team_id: 't_a', raid_on: TODAY, zone: null, title: null, event_title: null, n }] });
  const signupRow = dismissal('signup_unmatched:r9', 'signup_unmatched', 'dismiss', '3');
  assert.equal(buildAttention({ ...signups(3), dismissals: [signupRow] }).total, 0);
  assert.equal(buildAttention({ ...signups(4), dismissals: [signupRow] }).total, 1);
  const moved = (day) => baseInput({ eventMoved: [{ ...raidRow('r5', 't_a', '2027-01-16'), starts_at: NOW + DAY, event_moved_on: day }] });
  const movedRow = dismissal('event_moved:r5', 'event_moved', 'dismiss', '2027-01-18');
  assert.equal(buildAttention({ ...moved('2027-01-18'), dismissals: [movedRow] }).total, 0);
  assert.equal(buildAttention({ ...moved('2027-01-19'), dismissals: [movedRow] }).total, 1);
});

check('pure: a Reviewed watch entry stays hidden until a 5-point drop or a newer missed raid; watch is never a Home item', async () => {
  const { buildAttention, findAttentionItem, watchFingerprint } = await load('worker/attention.js');
  const input = (pct, raidId) => baseInput({ watch: [{ teamId: 't_a', entries: [watchEntry(pct, raidId)] }], dismissals: [dismissal('watch:t_a:p_w', 'watch', 'reviewed', watchFingerprint(60, 'r1'))] });
  const open = (pct, raidId) => buildAttention(input(pct, raidId)).counts.t_a.watchOpen;
  assert.equal(open(60, 'r1'), 0);
  assert.equal(open(55.1, 'r1'), 0, 'down 4.9 points: still reviewed');
  assert.equal(open(70, 'r1'), 0, 'better: still reviewed');
  assert.equal(open(55, 'r1'), 1, 'down 5 points: back');
  assert.equal(open(60, 'r2'), 1, 'a newer missed raid: back');
  assert.equal(open(60, null), 1, 'no missed raid any more is a change too');
  const built = buildAttention(input(40, 'r1'));
  assert.deepEqual(built.items, [], 'the watch list is not on Home');
  assert.deepEqual(built.hidden, []);
  assert.equal(built.total, 0);
  // The dismissal routes still find it.
  const found = findAttentionItem(input(60, 'r1'), 'watch:t_a:p_w');
  assert.equal(found.entry.item.kind, 'watch');
  assert.equal(found.rule.mode, 'reviewed');
  assert.equal(found.entry.fingerprint, watchFingerprint(60, 'r1'));
  // Rank suggestions are counted, not listed.
  const ranks = buildAttention(baseInput({ ranks: [{ teamId: 't_a', entries: [{ playerId: 'p_r', name: 'Aria', class: 'MAGE', kind: 'promote', from: { id: 'a', name: 'A' }, to: { id: 'b', name: 'B' }, reasons: [] }] }] }));
  assert.deepEqual([ranks.items.length, ranks.total, ranks.counts.t_a.rankOpen], [0, 0, 1]);
});

check('pure: the readiness facts stay in the payload, marked, and are not counted in `total`', async () => {
  const { buildAttention, READINESS_KINDS } = await load('worker/attention.js');
  assert.deepEqual(READINESS_KINDS, ['low_signups', 'roster_declined', 'roster_pending', 'unlocked']);
  const raid = (id) => ({ ...raidRow(id, 't_a', '2027-01-16'), starts_at: NOW + 30 * 60000, n: 2 });
  const built = buildAttention(baseInput({
    upcoming: [{ ...raid('u1'), signups_locked: 0, n_in: 3 }],
    rosterDeclined: [raid('u1')], rosterPending: [raid('u1')],
    noLoot: [raidRow('r5', 't_a', '2027-01-10')],
  }));
  assert.deepEqual(built.items.map((i) => [i.kind, !!i.readiness]), [['no_loot', false], ['low_signups', true], ['roster_declined', true], ['roster_pending', true], ['unlocked', true]]);
  assert.equal(built.total, 1);
  assert.deepEqual(built.more, {});
});

check('pure: the week block runs from yesterday to today + 5, per team the viewer can see, with the status words', async () => {
  const { buildAttention, ATTENTION_VIEW_ACTIONS } = await load('worker/attention.js');
  assert.deepEqual(ATTENTION_VIEW_ACTIONS, ['attendance.review', 'roster.edit', 'raids.edit', 'loot.edit']);
  const at = (hours) => NOW + hours * 3600000;
  const week = (id, team, on, hours, extra = {}) => ({
    id, team_id: team, raid_on: on, starts_at: at(hours), zone: 'Karazhan', size: 10, title: null, event_title: 'Night', signups_locked: 0, roster_published_at: null,
    close_hours: 2, n_in: 0, confirmed: 0, declined: 0, pending: 0, event_moved_on: null, ...extra,
  });
  const weekRaids = [
    week('r_m3', 't_a', '2027-01-12', -72),                       // out: three days back
    week('r_m2', 't_a', '2027-01-13', -48),                       // out: the day before yesterday
    week('r_m1', 't_a', '2027-01-14', -20),                       // yesterday, over, nothing left: done
    week('r_m1b', 't_a', '2027-01-14', -22),                      // yesterday, over, a to-do is tied to it: todo
    week('r_t', 't_a', '2027-01-15', 6, { n_in: 4 }),             // today: short (4 of 10)
    week('r_p5', 't_a', '2027-01-20', 120, { n_in: 10, roster_published_at: NOW }),   // today + 5: ready
    week('r_p6', 't_a', '2027-01-21', 144),                       // out: today + 6
    week('r_open', 't_a', '2027-01-17', 48, { n_in: 12, confirmed: 3, declined: 1, pending: 2, signups_locked: 1, event_moved_on: '2027-01-19' }),   // full, no line-up: open
    week('r_b', 't_b', '2027-01-16', 30, { n_in: 10, size: 10 }),
    week('r_old', 't_old', '2027-01-16', 30),                     // an archived team
  ];
  const built = buildAttention(baseInput({ weekRaids, noLoot: [raidRow('r_m1b', 't_a', '2027-01-14')] }));
  assert.deepEqual(built.week.map((r) => [r.raidId, r.status]), [
    ['r_m1b', 'todo'], ['r_m1', 'done'], ['r_t', 'short'], ['r_b', 'open'], ['r_open', 'open'], ['r_p5', 'ready'],
  ]);
  assert.deepEqual(Object.keys(built.week[0]).sort(), [
    'cantCome', 'confirmed', 'date', 'eventMovedOn', 'lineupPublished', 'noAnswer', 'raidId', 'signed', 'signupsCloseAt', 'signupsLocked', 'size', 'startsAt', 'status', 'teamId',
    'teamName', 'title', 'zone',
  ]);
  const open = built.week.find((r) => r.raidId === 'r_open');
  assert.deepEqual(
    [open.teamId, open.teamName, open.date, open.startsAt, open.zone, open.title, open.size, open.signed, open.lineupPublished, open.confirmed, open.cantCome, open.noAnswer, open.signupsCloseAt, open.signupsLocked, open.eventMovedOn],
    ['t_a', 'Alpha', '2027-01-17', at(48), 'Karazhan', 'Night', 10, 12, false, 3, 1, 2, at(48) - 2 * 3600000, true, '2027-01-19'],
  );
  // A hidden to-do does not keep a past raid at "todo".
  const hidden = buildAttention(baseInput({ weekRaids, noLoot: [raidRow('r_m1b', 't_a', '2027-01-14')], dismissals: [dismissal('no_loot:r_m1b', 'no_loot', 'dismiss', 'r_m1b')] }));
  assert.equal(hidden.week.find((r) => r.raidId === 'r_m1b').status, 'done');
  // Rights per team: Alpha only, and a viewer holding none of the four rights for a team sees none of its raids.
  const alpha = buildAttention(baseInput({ weekRaids, allowsTeam: (action, teamId) => teamId === 't_a' && action === 'loot.edit' }));
  assert.deepEqual([...new Set(alpha.week.map((r) => r.teamId))], ['t_a']);
  assert.deepEqual(buildAttention(baseInput({ weekRaids, allowsTeam: (action) => action === 'raids.view' })).week, []);
  assert.deepEqual(buildAttention(baseInput({})).week, [], 'the input is optional');
});

check('pure: rights per team decide what a viewer can dismiss (findAttentionItem), watch counts and hidden entries', async () => {
  const { buildAttention, findAttentionItem } = await load('worker/attention.js');
  const input = baseInput({
    noLoot: [raidRow('r1', 't_a', '2027-01-10'), raidRow('r2', 't_b', '2027-01-10')], claims: 2,
    watch: [{ teamId: 't_a', entries: [watchEntry(60, 'r1')] }, { teamId: 't_b', entries: [watchEntry(50, 'r2', { playerId: 'p_v' })] }],
    dismissals: [dismissal('no_loot:r2', 'no_loot', 'dismiss', 'r2', { team_id: 't_b' })],
  });
  const lead = { ...input, allowsTeam: (action, teamId) => teamId === 't_a' && ['loot.edit', 'attendance.review'].includes(action), granted: () => false };
  const built = buildAttention(lead);
  assert.deepEqual(built.items.map((i) => i.id), ['no_loot:r1']);
  assert.deepEqual(built.hidden, [], "Bravo's hidden item is not the Alpha lead's business");
  assert.deepEqual(Object.keys(built.counts), ['t_a']);
  assert.equal(findAttentionItem(lead, 'no_loot:r2'), null, 'an item of another team is not found');
  assert.equal(findAttentionItem(lead, 'watch:t_b:p_v'), null);
  assert.ok(findAttentionItem(lead, 'watch:t_a:p_w'));
  const claims = findAttentionItem(input, 'claims');
  assert.equal(claims.rule, undefined, 'claims clear when handled: no dismiss');
  assert.equal(findAttentionItem(input, 'nope:1'), null);
  assert.equal(buildAttention(input).hidden.length, 1);
});

// ===========================================================================
// ROUTES

async function scenario({ dev = false } = {}) {
  const w = await makeWorld({ env: dev ? { DEV_VIEW_AS: '1' } : {} });
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Home Four', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: TZ, multipleTeams: true, teamNames: ['Alpha', 'Bravo'],
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const [A, B] = made.json.teams.map((team) => team.id);
  const uids = {};
  for (const key of ['off', 'lead', 'm1']) {
    jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  const s = {
    w, gid, A, B, jars, uids, base: `/api/guild/${gid}`, p: {},
    call(who, method, tail, body, init) { return w.call(jars[who], method, `${s.base}${tail}`, body, init); },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    sql: (sql, ...values) => w.db.sqlite.prepare(sql).run(...values),
    rows: (sql, ...values) => w.rows(sql, ...values),
    attention: (who = 'gm') => s.ok(who, 'GET', '/attention'),
    dismiss: (who, body) => s.call(who, 'POST', '/attention/dismissals', body),
    restore: (who, itemId) => s.call(who, 'DELETE', `/attention/dismissals/${encodeURIComponent(itemId)}`),
    async raid(team, raidOn, startTime = '20:00') {
      const res = await s.ok('gm', 'POST', '/raids', { teamId: team, raidOn, startTime, zone: "Gruul's Lair" });
      return res.raid.id;
    },
    async addPerson(name, team, extra = {}) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId: team, name, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider', joinedOn: '2026-09-01', ...extra });
      s.p[name] = res.person.id;
      return res.person.id;
    },
  };
  await s.ok('gm', 'PUT', `/people/${uids.off}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  await s.ok('gm', 'PUT', `/people/${uids.lead}/roles`, { officer: false, teamLeadTeamIds: [A] }, 200);
  return s;
}

// An upcoming Alpha raid whose Raid-Helper event moved to another day (the event_moved to-do).
async function movedRaid(s, team = s.A, raidOn = '2027-01-16') {
  const rid = await s.raid(team, raidOn);
  s.sql('UPDATE raids SET event_moved_on = ? WHERE id = ?', '2027-01-18', rid);
  return rid;
}

check('route: dismiss, then restore -- shared by every officer, with who and when, an audit row each and a sentence in the Activity log', async () => {
  const s = await scenario();
  const rid = await movedRaid(s);
  const id = `event_moved:${rid}`;
  assert.ok((await s.attention('off')).items.some((i) => i.id === id));
  const total = (await s.attention('off')).total;
  const done = await s.dismiss('off', { itemId: id });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual([done.json.ok, done.json.itemId, done.json.mode, done.json.until], [true, id, 'dismiss', null]);
  for (const who of ['gm', 'lead', 'off']) {
    const seen = await s.attention(who);
    assert.ok(!seen.items.some((i) => i.id === id), `${who}: gone`);
    assert.equal(seen.total, total - 1);
    assert.equal(seen.hidden.length, 1);
    assert.deepEqual([seen.hidden[0].item.id, seen.hidden[0].mode, seen.hidden[0].until, seen.hidden[0].by.name, seen.hidden[0].at], [id, 'dismiss', null, 'Officerhome', s.w.clock.now]);
  }
  const stored = (await s.rows('SELECT * FROM attention_dismissals'))[0];
  assert.deepEqual([stored.kind, stored.team_id, stored.mode, stored.until, stored.fingerprint, stored.dismissed_by], ['event_moved', s.A, 'dismiss', null, '2027-01-18', s.uids.off]);
  // The same item dismissed again by another officer keeps one row and changes who did it.
  assert.equal((await s.dismiss('gm', { itemId: id })).status, 200);
  assert.equal((await s.rows('SELECT dismissed_by FROM attention_dismissals')).length, 1);
  assert.equal((await s.attention('lead')).hidden[0].by.name, 'Gmhome');
  // Restore (the colons arrive encoded, as encodeURIComponent writes them).
  const back = await s.restore('lead', id);
  assert.equal(back.status, 200, back.text);
  assert.ok((await s.attention('gm')).items.some((i) => i.id === id));
  assert.equal((await s.attention('gm')).hidden.length, 0);
  assert.equal((await s.rows('SELECT * FROM attention_dismissals')).length, 0);
  assert.equal((await s.restore('lead', id)).status, 404, 'nothing left to restore');
  // Audit.
  const audits = await s.rows("SELECT action, entity_type, entity_id, actor_user_id, after, before FROM audit_log WHERE action LIKE 'attention.%' ORDER BY created_at, id");
  assert.deepEqual(audits.map((a) => [a.action, a.entity_type, a.entity_id]), [['attention.dismiss', 'attention', id], ['attention.dismiss', 'attention', id], ['attention.restore', 'attention', id]]);
  assert.equal(audits[0].actor_user_id, s.uids.off);
  assert.equal(audits[2].actor_user_id, s.uids.lead);
  assert.deepEqual(JSON.parse(audits[0].after), { itemId: id, kind: 'event_moved', teamId: s.A, raidId: rid, mode: 'dismiss', until: null });
  assert.deepEqual(JSON.parse(audits[2].before), { itemId: id, kind: 'event_moved', teamId: s.A, raidId: rid, mode: 'dismiss', until: null });
  const log = (await s.ok('gm', 'GET', '/audit')).rows || (await s.ok('gm', 'GET', '/audit')).items || [];
  const texts = log.map((row) => row.text);
  assert.ok(texts.some((t) => /^Dismissed the to-do "moved Raid-Helper event" for the raid on /.test(t)), texts.join(' | '));
  assert.ok(texts.some((t) => /^Restored the to-do "moved Raid-Helper event" for the raid on /.test(t)), texts.join(' | '));
});

check('route: a spoofed or unknown item id is a 404, a missing one a 400, a kind that clears when handled a 400 not_dismissable, and rights decide what is found', async () => {
  const s = await scenario();
  const rid = await movedRaid(s);
  const bravo = await movedRaid(s, s.B, '2027-01-17');
  for (const itemId of ['event_moved:r_AAAAAAAAAAAAAAAAAAAAAA', 'no_loot:' + rid, 'trial:p_AAAAAAAAAAAAAAAAAAAAAA', 'mystery:1', `event_moved:${rid}:x`, '../../etc']) {
    const res = await s.dismiss('gm', { itemId });
    assert.equal(res.status, 404, `${itemId}: ${res.text}`);
  }
  for (const body of [{}, { itemId: 5 }, { itemId: '' }, { itemId: 'x'.repeat(200) }]) assert.equal((await s.dismiss('gm', body)).status, 400, JSON.stringify(body).slice(0, 40));
  // The Alpha lead cannot see Bravo's moved event: it is a 404 (not a 403 that would confirm it exists).
  assert.equal((await s.dismiss('lead', { itemId: `event_moved:${bravo}` })).status, 404);
  assert.equal((await s.dismiss('lead', { itemId: `event_moved:${rid}` })).status, 200);
  // Claims clear when handled: 400 not_dismissable (the item exists, so it is not a 404).
  s.sql(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
         VALUES ('cl_${'z'.repeat(22)}', ?, ?, 'Mirabel', 'mirabel', 'Nightslayer', 'nightslayer', 'HUNTER', 70, 'pending', 1)`, s.gid, s.uids.m1);
  const claim = await s.dismiss('gm', { itemId: 'claims' });
  assert.equal(claim.status, 400);
  assert.equal(claim.json.error, 'not_dismissable');
  // A readiness fact is not dismissable either.
  const readiness = (await s.attention('gm')).items.find((i) => i.readiness);
  if (readiness) assert.equal((await s.dismiss('gm', { itemId: readiness.id })).status, 400);
  assert.equal((await s.rows('SELECT * FROM attention_dismissals')).length, 1, 'only the lead\'s dismissal was written');
  // No session, a member and the signed-out are refused before anything is read.
  assert.equal((await s.dismiss('m1', { itemId: `event_moved:${rid}` })).status, 403);
  assert.equal((await s.restore('m1', `event_moved:${rid}`)).status, 403);
});

check('route: the client sends the item id only -- a sent until, mode or fingerprint is ignored; the server applies the kind\'s rule (a trial snoozes for 3 days)', async () => {
  const s = await scenario();
  const rid = await movedRaid(s);
  const sent = await s.dismiss('gm', { itemId: `event_moved:${rid}`, until: 1, mode: 'snooze', fingerprint: 'x', days: 99 });
  assert.equal(sent.status, 200);
  const moved = (await s.rows('SELECT mode, until, fingerprint FROM attention_dismissals'))[0];
  assert.deepEqual([moved.mode, moved.until, moved.fingerprint], ['dismiss', null, '2027-01-18']);
  // A trial ending in 2 days.
  const trial = await s.addPerson('Veyla', s.A, { status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-17' });
  const id = `trial:${trial}`;
  const t0 = s.w.clock.now;
  const snoozed = await s.dismiss('off', { itemId: id, until: 5, mode: 'dismiss', fingerprint: 'evil' });
  assert.equal(snoozed.status, 200, snoozed.text);
  assert.deepEqual([snoozed.json.mode, snoozed.json.until], ['snooze', t0 + 3 * DAY]);
  const row = (await s.rows('SELECT mode, until, fingerprint FROM attention_dismissals WHERE item_id = ?', id))[0];
  assert.deepEqual([row.mode, row.until, row.fingerprint], ['snooze', t0 + 3 * DAY, '2027-01-17']);
  let seen = await s.attention('gm');
  assert.ok(!seen.items.some((i) => i.id === id));
  assert.deepEqual(seen.hidden.filter((h) => h.item.id === id).map((h) => [h.mode, h.until, h.by.name]), [['snooze', t0 + 3 * DAY, 'Officerhome']]);
  // The trial end moves: the item is back before the 3 days are up.
  s.sql('UPDATE players SET trial_end = ? WHERE id = ?', '2027-01-19', trial);
  seen = await s.attention('gm');
  assert.ok(seen.items.some((i) => i.id === id), 'a changed end date brings it back early');
  // ... and with the date back where it was, the snooze applies again until it runs out.
  s.sql('UPDATE players SET trial_end = ? WHERE id = ?', '2027-01-17', trial);
  assert.ok(!(await s.attention('gm')).items.some((i) => i.id === id));
  s.w.clock.now = t0 + 3 * DAY + 1;
  s.sql('UPDATE players SET trial_end = ? WHERE id = ?', '2027-01-17', trial);
  assert.ok((await s.attention('gm')).items.some((i) => i.id === id), 'a snooze that ran out comes back');
});

check('route: restoring needs the kind\'s rights for the row\'s team', async () => {
  const s = await scenario();
  const bravoTrial = await s.addPerson('Tanis', s.B, { status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-17' });
  const alphaTrial = await s.addPerson('Veyla', s.A, { status: 'trial', joinedOn: '2027-01-10', trialEnd: '2027-01-17' });
  assert.equal((await s.dismiss('gm', { itemId: `trial:${bravoTrial}` })).status, 200);
  assert.equal((await s.dismiss('gm', { itemId: `trial:${alphaTrial}` })).status, 200);
  assert.equal((await s.restore('lead', `trial:${bravoTrial}`)).status, 403, "the Alpha lead may not restore Bravo's row");
  assert.equal((await s.rows('SELECT * FROM attention_dismissals')).length, 2);
  assert.equal((await s.restore('lead', `trial:${alphaTrial}`)).status, 200);
  assert.equal((await s.restore('off', `trial:${bravoTrial}`)).status, 200);
  // A webhook row needs guild.teams: the lead has none for Alpha.
  s.sql("INSERT INTO team_notifications (team_id, guild_id, noreply_hours, webhook_state, webhook_url, disabled_status, updated_at) VALUES (?, ?, 24, 'disabled', 'https://discord.com/api/webhooks/1/x', 404, 1)", s.A, s.gid);
  assert.equal((await s.dismiss('lead', { itemId: `webhook_off:${s.A}` })).status, 404, 'the lead does not see the webhook item');
  const hook = await s.dismiss('gm', { itemId: `webhook_off:${s.A}` });
  assert.equal(hook.status, 200, hook.text);
  assert.equal(hook.json.until, s.w.clock.now + 7 * DAY);
  assert.equal((await s.restore('lead', `webhook_off:${s.A}`)).status, 403);
  assert.equal((await s.restore('gm', `webhook_off:${s.A}`)).status, 200);
});

check('route: View as Member (DEV_VIEW_AS) gets 403 on the dismissal routes, and the real Guild Master does not', async () => {
  const s = await scenario({ dev: true });
  const rid = await movedRaid(s);
  const local = (jar, method, path, body) => s.w.call(jar, method, `${s.base}${path}`, body, { origin: LOCAL });
  const asMember = { ...s.jars.gm, [COOKIE]: `${s.gid}:member` };
  const post = await local(asMember, 'POST', '/attention/dismissals', { itemId: `event_moved:${rid}` });
  assert.equal(post.status, 403, post.text);
  assert.equal((await local(asMember, 'GET', '/attention')).status, 403);
  assert.equal((await local(asMember, 'DELETE', `/attention/dismissals/${encodeURIComponent(`event_moved:${rid}`)}`)).status, 403);
  assert.equal((await s.rows('SELECT * FROM attention_dismissals')).length, 0);
  assert.equal((await local(s.jars.gm, 'POST', '/attention/dismissals', { itemId: `event_moved:${rid}` })).status, 200);
});

// A team whose person Kaelith is on the watch list: eight weekly Tuesdays she missed, two earlier ones she attended.
async function watchWorld() {
  const s = await scenario();
  await s.addPerson('Thoren', s.A);
  await s.addPerson('Kaelith', s.A);
  const dates = ['2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29', '2027-01-05', '2027-01-12'];
  s.raids = [];
  for (const date of dates) s.raids.push(await s.raid(s.A, date));
  s.raids.forEach((raidId, i) => {
    for (const [name, outcome, credit] of [['Thoren', 'present', 1], ['Kaelith', i < 2 ? 'present' : 'missed', i < 2 ? 1 : 0]]) {
      s.sql(`INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, ?, ?)`, raidId, s.gid, s.A, s.p[name], outcome, credit, credit);
    }
  });
  s.itemId = `watch:${s.A}:${s.p.Kaelith}`;
  s.team = (who = 'gm') => s.ok(who, 'GET', `/attendance/team?team=${s.A}`);
  s.kael = async (who = 'gm') => (await s.team(who)).watch.entries.find((e) => e.name === 'Kaelith');
  return s;
}

check('route: the watch list leaves Home and is marked Reviewed on the Attendance page -- the team payload carries latestMissedRaidId, itemId and reviewed', async () => {
  const s = await watchWorld();
  const home = await s.attention('gm');
  assert.ok(!home.items.some((i) => i.kind === 'watch'));
  assert.equal(home.counts[s.A].watchOpen, 1);
  let kael = await s.kael();
  assert.equal(kael.latestMissedRaidId, s.raids[7], 'the newest missed raid');
  assert.equal(kael.itemId, s.itemId);
  assert.equal(kael.reviewed, null);
  assert.ok(kael.pct < 75);
  // Reviewed by the officer: mode reviewed, no end date, the fingerprint holds the % and the raid.
  const done = await s.dismiss('off', { itemId: s.itemId, until: 5, fingerprint: 'x' });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual([done.json.mode, done.json.until], ['reviewed', null]);
  const row = (await s.rows('SELECT mode, until, fingerprint, kind, team_id FROM attention_dismissals'))[0];
  assert.deepEqual([row.mode, row.until, row.kind, row.team_id, JSON.parse(row.fingerprint)], ['reviewed', null, 'watch', s.A, { pct: kael.pct, raidId: s.raids[7] }]);
  for (const who of ['gm', 'lead']) {
    kael = await s.kael(who);
    assert.deepEqual(kael.reviewed, { by: { name: 'Officerhome' }, at: s.w.clock.now }, who);
  }
  assert.equal((await s.attention('gm')).counts[s.A].watchOpen, 0);
  assert.equal((await s.attention('gm')).hidden.length, 0, 'Hidden on Home lists Home items only');
  // A newly missed raid brings her back.
  const newer = await s.raid(s.A, '2027-01-14');
  s.sql('INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, ?, 0, 0)', newer, s.gid, s.A, s.p.Kaelith, 'missed');
  kael = await s.kael();
  assert.equal(kael.latestMissedRaidId, newer);
  assert.equal(kael.reviewed, null, 'a newer missed raid: open again');
  assert.equal((await s.attention('gm')).counts[s.A].watchOpen, 1);
  // Reviewed again, then undone from the Attendance page (the same DELETE).
  assert.equal((await s.dismiss('gm', { itemId: s.itemId })).status, 200);
  assert.deepEqual((await s.kael()).reviewed.by, { name: 'Gmhome' });
  assert.equal((await s.restore('lead', s.itemId)).status, 200);
  assert.equal((await s.kael()).reviewed, null);
  // The audit sentence.
  const log = await s.ok('gm', 'GET', '/audit');
  const texts = (log.rows || log.items || []).map((r) => r.text);
  assert.ok(texts.some((t) => t === 'Marked Kaelith as reviewed on the attendance watch list'), texts.join(' | '));
  assert.ok(texts.some((t) => t === 'Took Kaelith off Reviewed on the attendance watch list'), texts.join(' | '));
  // A viewer without attendance.review gets no watch list, so no reviewed state, and cannot review.
  assert.equal((await s.dismiss('m1', { itemId: s.itemId })).status, 403);
});

check('route: the week block -- yesterday to today + 5 in the guild\'s zone, readiness facts and the status words from the real rows', async () => {
  const s = await scenario();
  // The clock is 2027-01-15 08:00 UTC = 03:00 on Fri 2027-01-15 in New York. A 20:00 raid on 2027-01-20 starts at 01:00 UTC on the 21st: its UTC date is out of
  // the window, its guild date (today + 5) is in.
  const ids = {
    m3: await s.raid(s.A, '2027-01-12'), m2: await s.raid(s.A, '2027-01-13'), y: await s.raid(s.A, '2027-01-14'),
    today: await s.raid(s.A, '2027-01-15'), p3: await s.raid(s.A, '2027-01-18'), p4: await s.raid(s.A, '2027-01-19'),
    edge: await s.raid(s.A, '2027-01-20'), out: await s.raid(s.A, '2027-01-21'), bravo: await s.raid(s.B, '2027-01-17'),
  };
  const week = (await s.attention('gm')).week;
  assert.deepEqual(week.map((r) => r.raidId), [ids.y, ids.today, ids.bravo, ids.p3, ids.p4, ids.edge], 'by start time; the day before yesterday and today + 6 are out');
  assert.deepEqual(week.map((r) => r.date), ['2027-01-14', '2027-01-15', '2027-01-17', '2027-01-18', '2027-01-19', '2027-01-20']);
  assert.equal(week.find((r) => r.raidId === ids.edge).startsAt, Date.parse('2027-01-21T01:00:00Z'));
  assert.deepEqual(week.map((r) => r.status), ['done', 'short', 'short', 'short', 'short', 'short']);
  // Sign-ups, size, line-up and the answers.
  s.sql('UPDATE raids SET size = 10 WHERE id IN (?, ?, ?)', ids.p3, ids.p4, ids.today);
  const signup = (raidId, n) => s.sql("INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES (?, 'raid_helper', ?, 'signed', ?, ?, NULL)", raidId, n, n, s.gid);
  for (let n = 1; n <= 10; n++) { signup(ids.p3, n); signup(ids.p4, n); }
  s.sql('UPDATE raids SET roster_published_at = ? WHERE id = ?', s.w.clock.now, ids.p4);
  const seat = (raidId, key, status) => s.sql("INSERT INTO raid_roster (raid_id, guild_id, name_key, name, group_number, status) VALUES (?, ?, ?, ?, 1, ?)", raidId, s.gid, key, key, status);
  seat(ids.p4, 'a', 'confirmed'); seat(ids.p4, 'b', 'declined'); seat(ids.p4, 'c', 'pending'); seat(ids.p4, 'd', 'pending');
  s.sql('UPDATE teams SET signup_close_hours = 3 WHERE id = ?', s.A);
  const now = (await s.attention('gm')).week;
  const by = Object.fromEntries(now.map((r) => [r.raidId, r]));
  assert.deepEqual([by[ids.p3].status, by[ids.p3].signed, by[ids.p3].size, by[ids.p3].lineupPublished], ['open', 10, 10, false]);
  assert.deepEqual([by[ids.p4].status, by[ids.p4].lineupPublished, by[ids.p4].confirmed, by[ids.p4].cantCome, by[ids.p4].noAnswer], ['ready', true, 1, 1, 2]);
  assert.equal(by[ids.today].status, 'short');
  const startsAt = by[ids.p4].startsAt;
  assert.equal(by[ids.p4].signupsCloseAt, startsAt - 3 * 3600000);
  assert.deepEqual([by[ids.p4].teamName, by[ids.p4].zone, by[ids.p4].signupsLocked, by[ids.p4].eventMovedOn], ['Alpha', "Gruul's Lair", false, null]);
  // A team lead sees only Alpha's raids; the yesterday raid becomes "todo" while it has an open to-do, and "done" once that is dismissed.
  s.sql("INSERT INTO raid_signups (raid_id, source, signup_id, kind, position, guild_id, player_id) VALUES (?, 'raid_helper', 9, 'signed', 9, ?, NULL)", ids.y, s.gid);
  const lead = (await s.attention('lead')).week;
  assert.ok(lead.every((r) => r.teamId === s.A) && !lead.some((r) => r.raidId === ids.bravo));
  assert.equal(lead.find((r) => r.raidId === ids.y).status, 'todo');
  assert.equal((await s.dismiss('lead', { itemId: `signup_unmatched:${ids.y}` })).status, 200);
  assert.equal((await s.attention('gm')).week.find((r) => r.raidId === ids.y).status, 'done');
  // Members get no week at all.
  assert.equal((await s.call('m1', 'GET', '/attention')).status, 403);
});

(async () => {
  const filter = process.argv[2] || '';
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
