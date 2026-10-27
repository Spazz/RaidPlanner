/**
 * Raidsmith guild tracker - lane B3 of the user-hierarchy build: team requests (D6)
 * Run: node tests/guild/guild-b3-requests-tests.js
 *
 *   - the owner of a character (on no team) asks for a team; nobody else may; one open request per character; one character per person per team;
 *   - GET lists the viewer's own requests and, for roster.edit on the request's team, the pending ones of that team only;
 *   - the requester withdraws; the team's Team Leads and officers approve (the character is placed through the same guarded statement as the team routes)
 *     or reject; a lead of another team learns nothing (404); a decided request is final (409);
 *   - approving refuses (409 request_changed) when the asker no longer owns the character or is blocked, before the write and inside it;
 *   - the D6 to-do (attention kind team_requests) and the nav badge (teamRequestFlags) count PENDING requests only, per team, for those who can decide;
 *   - Delete my data removes the pending requests of the account.
 */
const assert = require('node:assert/strict');
const { runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, bravo, charlie] = s.tids;
  Object.assign(s, { alpha, bravo, charlie });
  await s.officer('o1', 'Officerone');
  await s.lead('tla', [alpha], 'Leadalpha');
  await s.lead('tlb', [bravo], 'Leadbravo');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  s.m1 = await s.person({ name: 'Mainone' });
  await s.link(s.m1.pid, 'm1');
  s.alt1 = await s.alt(s.m1.pid, 'Altone');
  s.alt2 = await s.alt(s.m1.pid, 'Alttwo');
  s.m2 = await s.person({ name: 'Maintwo' });
  await s.link(s.m2.pid, 'm2');
  s.other = await s.alt(s.m2.pid, 'Otheralt');
  return s;
}
const ask = (s, who, characterId, teamId, extra = {}) => s.call(who, 'POST', '/team-requests', { characterId, teamId, ...extra });
const rowOf = (s, id) => s.one('SELECT * FROM team_requests WHERE id = ?', id);

check('the owner asks for a team for a character on no team: 201, pending, audited; the note is trimmed; nobody else\'s character, no team, a bad team are refused', async () => {
  const s = await world();
  const made = await ask(s, 'm1', s.alt1, s.bravo, { note: '  I play  tanks on Thursdays  ' });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.json.request.status, made.json.request.team.name, made.json.request.character.name, made.json.request.note], ['pending', 'Bravo', 'Altone', 'I play tanks on Thursdays']);
  const stored = await rowOf(s, made.json.request.id);
  assert.deepEqual([stored.guild_id, stored.team_id, stored.character_id, stored.requested_by, stored.status], [s.gid, s.bravo, s.alt1, s.uids.m1, 'pending']);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'team_request.create'")).length, 1);
  // Not their character (404, whatever its team), a character of nobody, no team / unknown team / a note too long / not text.
  assert.equal((await ask(s, 'm1', s.other, s.bravo)).status, 404);
  assert.equal((await ask(s, 'm1', 'c_AAAAAAAAAAAAAAAAAAAAAA', s.bravo)).status, 404);
  assert.equal((await ask(s, 'o1', s.alt2, s.bravo)).status, 404, 'an officer without a person of their own asks for nobody else\'s character');
  assert.equal((await ask(s, 'm1', s.alt2, undefined)).json.field, 'teamId');
  assert.equal((await ask(s, 'm1', s.alt2, 't_AAAAAAAAAAAAAAAAAAAAAA')).json.field, 'teamId');
  assert.equal((await ask(s, 'm1', s.alt2, s.bravo, { note: 'x'.repeat(201) })).json.field, 'note');
  assert.equal((await ask(s, 'm1', s.alt2, s.bravo, { note: 7 })).json.field, 'note');
  assert.equal((await ask(s, 'm1', undefined, s.bravo)).json.field, 'characterId');
  await s.ok('gm', 'PATCH', `/teams/${s.charlie}`, { archived: true }, 200);
  assert.equal((await ask(s, 'm1', s.alt2, s.charlie)).json.field, 'teamId', 'an archived team');
  assert.equal((await s.rows('SELECT id FROM team_requests')).length, 1);
});

check('one open request per character, one character per person per team, and a character on a team asks for nothing', async () => {
  const s = await world();
  assert.equal((await ask(s, 'm1', s.alt1, s.bravo)).status, 201);
  const again = await ask(s, 'm1', s.alt1, s.charlie);
  assert.deepEqual([again.status, again.json.error], [409, 'request_pending']);
  // The Main sits on Alpha: no other character of the person can ask for Alpha.
  const taken = await ask(s, 'm1', s.alt2, s.alpha);
  assert.deepEqual([taken.status, taken.json.error, taken.json.field], [409, 'team_taken', 'teamId']);
  // The Main is on a team already.
  const placed = await ask(s, 'm1', s.m1.cid, s.bravo);
  assert.deepEqual([placed.status, placed.json.error], [409, 'on_team']);
  // Another character of the same person may ask for the same team (one request per CHARACTER); approving the first makes the second fail later.
  assert.equal((await ask(s, 'm1', s.alt2, s.bravo)).status, 201);
  // The cap of open requests per account: twenty waiting requests of this account, then the next one is refused.
  s.exec('DELETE FROM team_requests');
  for (let i = 0; i < 20; i++) {
    const tag = String.fromCharCode(97 + i);
    s.exec(`INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p_cap${tag}', '${s.gid}', 'raider', 1, 1);
      INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at, core_rank)
        VALUES ('c_cap${tag}', '${s.gid}', 'p_cap${tag}', NULL, 'Cap${tag}', 'cap${tag}', 'MAGE', 1, 1, 1, 'raider');
      INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, created_at)
        VALUES ('tq_cap${tag}', '${s.gid}', '${s.bravo}', 'c_cap${tag}', '${s.uids.m1}', ${i + 1});`);
  }
  const capped = await ask(s, 'm1', s.alt1, s.bravo);
  assert.deepEqual([capped.status, capped.json.error], [409, 'request_limit']);
  assert.equal((await ask(s, 'm2', s.other, s.bravo)).status, 201, 'the cap is per account');
});

check('GET lists the viewer\'s own requests, and the pending ones of the teams the viewer decides - a lead of another team and a plain member see none of them', async () => {
  const s = await world();
  const toBravo = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  const toCharlie = (await ask(s, 'm1', s.alt2, s.charlie)).json.request.id;
  const other = (await ask(s, 'm2', s.other, s.bravo)).json.request.id;
  const mine = await s.ok('m1', 'GET', '/team-requests');
  assert.deepEqual(mine.mine.map((r) => r.id).sort(), [toBravo, toCharlie].sort());
  assert.deepEqual([mine.pending, mine.can.decide], [[], false]);
  const lead = await s.ok('tlb', 'GET', '/team-requests');
  assert.deepEqual(lead.pending.map((r) => r.id).sort(), [toBravo, other].sort(), 'only the requests for Bravo');
  assert.deepEqual([lead.mine, lead.can.decide], [[], true]);
  const entry = lead.pending.find((r) => r.id === toBravo);
  assert.deepEqual([entry.character.name, entry.person.name, entry.requestedBy.displayName, entry.team.name], ['Altone', 'Mainone', 'Memberone', 'Bravo']);
  assert(!/avatar/i.test(JSON.stringify(lead.pending.map((r) => r.requestedBy.avatar || null).filter(Boolean))));
  assert.equal((await s.ok('tla', 'GET', '/team-requests')).pending.length, 0, 'the lead of Alpha decides nothing for Bravo');
  assert.deepEqual((await s.ok('o1', 'GET', '/team-requests')).pending.map((r) => r.id).sort(), [toBravo, toCharlie, other].sort());
});

check('withdraw: only the requester, only while pending', async () => {
  const s = await world();
  const id = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  await s.fail('m2', 'DELETE', `/team-requests/${id}`, {}, 404, 'not_found');
  await s.fail('tlb', 'DELETE', `/team-requests/${id}`, {}, 404, 'not_found');
  assert.equal((await rowOf(s, id)).status, 'pending');
  const done = await s.ok('m1', 'DELETE', `/team-requests/${id}`, {}, 200);
  assert.deepEqual(done.request, { id, status: 'withdrawn' });
  const stored = await rowOf(s, id);
  assert.deepEqual([stored.status, stored.decided_by, typeof stored.decided_at], ['withdrawn', s.uids.m1, 'number']);
  await s.fail('m1', 'DELETE', `/team-requests/${id}`, {}, 409, 'request_decided');
  await s.fail('tlb', 'POST', `/team-requests/${id}/approve`, {}, 409, 'request_decided');
  // The character can ask again.
  assert.equal((await ask(s, 'm1', s.alt1, s.charlie)).status, 201);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'team_request.withdraw'")).length, 1);
});

check('approve: the lead of THAT team (or an officer) places the character; the lead of another team gets a 404; the roster follows; decided is final', async () => {
  const s = await world();
  const id = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  await s.fail('tla', 'POST', `/team-requests/${id}/approve`, {}, 404, 'not_found');
  await s.fail('m1', 'POST', `/team-requests/${id}/approve`, {}, 404, 'not_found');
  await s.fail('m2', 'POST', `/team-requests/${id}/approve`, {}, 404, 'not_found');
  assert.equal(await s.teamOf(s.alt1), null);
  const approved = await s.ok('tlb', 'POST', `/team-requests/${id}/approve`, {}, 200);
  assert.deepEqual(approved.request, { id, status: 'approved' });
  assert.equal(approved.personId, s.m1.pid);
  assert.deepEqual(approved.teamRequestFlags, { [s.bravo]: 0 });
  assert.equal(await s.teamOf(s.alt1), s.bravo);
  const stored = await rowOf(s, id);
  assert.deepEqual([stored.status, stored.decided_by], ['approved', s.uids.tlb]);
  assert.deepEqual((await s.ok('tlb', 'GET', `/roster?team=${s.bravo}`)).people.map((p) => p.names).flat(), ['Altone']);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'team_request.approve'")).length, 1);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'character.place'")).length, 1);
  await s.fail('tlb', 'POST', `/team-requests/${id}/approve`, {}, 409, 'request_decided');
  await s.fail('tlb', 'POST', `/team-requests/${id}/reject`, {}, 409, 'request_decided');
  // An officer decides for any team.
  const second = (await ask(s, 'm1', s.alt2, s.charlie)).json.request.id;
  await s.ok('o1', 'POST', `/team-requests/${second}/approve`, {}, 200);
  assert.equal(await s.teamOf(s.alt2), s.charlie);
});

check('approve refuses when the world moved: the character got a team, the person got the team, the team was archived - the request stays pending, nothing is placed', async () => {
  const s = await world();
  const a = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  const b = (await ask(s, 'm1', s.alt2, s.bravo)).json.request.id;
  // alt1 was put on Charlie by an officer meanwhile.
  await s.ok('o1', 'PUT', `/roster/${s.m1.pid}/characters/${s.alt1}/team`, { teamId: s.charlie }, 200);
  await s.fail('tlb', 'POST', `/team-requests/${a}/approve`, {}, 409, 'on_team');
  assert.equal((await rowOf(s, a)).status, 'pending');
  // alt2 asks for Bravo; another character of the person takes Bravo first.
  s.exec(`UPDATE characters SET team_id = '${s.bravo}' WHERE id = '${s.alt1}'`);
  await s.fail('tlb', 'POST', `/team-requests/${b}/approve`, {}, 409, 'team_taken');
  assert.equal(await s.teamOf(s.alt2), null);
  // The team is archived: reject is the way out.
  s.exec(`UPDATE characters SET team_id = NULL WHERE id = '${s.alt1}'`);
  await s.ok('gm', 'PATCH', `/teams/${s.bravo}`, { archived: true }, 200);
  await s.fail('o1', 'POST', `/team-requests/${b}/approve`, {}, 409, 'team_archived');
  assert.equal((await rowOf(s, b)).status, 'pending');
  await s.ok('o1', 'POST', `/team-requests/${b}/reject`, {}, 200);
  assert.equal((await rowOf(s, b)).status, 'rejected');
});

check('the approval is one guarded batch: a request decided between the read and the write places nothing', async () => {
  const { placeStatement } = await import('../../worker/team-place.js');
  const s = await world();
  const id = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  s.exec(`UPDATE team_requests SET status = 'withdrawn', decided_at = 5 WHERE id = '${id}'`);
  const statement = placeStatement(s.w.db, {
    guildId: s.gid, personId: s.m1.pid, characterId: s.alt1, teamId: s.bravo, from: null, now: 1,
    extra: { sql: "EXISTS (SELECT 1 FROM team_requests WHERE id = ? AND status = 'pending')", params: [id] },
  });
  assert.equal((await s.w.db.batch([statement]))[0].meta.changes, 0);
  assert.equal(await s.teamOf(s.alt1), null);
});

check('reject: the lead of the team or an officer; the requester may ask again afterwards', async () => {
  const s = await world();
  const id = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  await s.fail('tla', 'POST', `/team-requests/${id}/reject`, {}, 404, 'not_found');
  const rejected = await s.ok('tlb', 'POST', `/team-requests/${id}/reject`, {}, 200);
  assert.deepEqual(rejected.request, { id, status: 'rejected' });
  assert.equal(await s.teamOf(s.alt1), null);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'team_request.reject'")).length, 1);
  assert.equal((await s.ok('m1', 'GET', '/team-requests')).mine[0].status, 'rejected');
  assert.equal((await ask(s, 'm1', s.alt1, s.bravo)).status, 201);
});

check('D6: the to-do and the nav badge count PENDING requests per team, for the people who decide them, and nothing else', async () => {
  const s = await world();
  // Characters on no team are a list, not a to-do: nothing yet.
  const empty = await s.ok('tlb', 'GET', '/attention');
  assert.equal(empty.items.filter((i) => i.kind === 'team_requests').length, 0);
  const a = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  await ask(s, 'm2', s.other, s.bravo);
  await ask(s, 'm1', s.alt2, s.charlie);
  const lead = await s.ok('tlb', 'GET', '/attention');
  const item = lead.items.find((i) => i.kind === 'team_requests');
  assert.deepEqual([item.count, item.teamId, item.id], [2, s.bravo, `team_requests:${s.bravo}`]);
  assert.equal(lead.items.filter((i) => i.kind === 'team_requests').length, 1, 'the lead of Bravo sees Bravo only');
  assert(lead.total >= 1);
  const officer = await s.ok('o1', 'GET', '/attention');
  assert.deepEqual(officer.items.filter((i) => i.kind === 'team_requests').map((i) => [i.teamId, i.count]).sort(), [[s.bravo, 2], [s.charlie, 1]].sort());
  await s.fail('m1', 'GET', '/attention', undefined, 403, 'forbidden');
  const dismiss = await s.call('o1', 'POST', '/attention/dismissals', { itemId: `team_requests:${s.bravo}` });
  assert.equal(dismiss.status, 400, 'a request clears when it is decided, not when it is hidden');
  // The badge: GET /api/guild/:gid.
  assert.deepEqual((await s.ok('tlb', 'GET', '')).teamRequestFlags, { [s.bravo]: 2 });
  assert.deepEqual((await s.ok('o1', 'GET', '')).teamRequestFlags, { [s.alpha]: 0, [s.bravo]: 2, [s.charlie]: 1 });
  assert.deepEqual((await s.ok('m1', 'GET', '')).teamRequestFlags, {});
  // Decided or withdrawn requests stop counting.
  await s.ok('tlb', 'POST', `/team-requests/${a}/approve`, {}, 200);
  assert.deepEqual((await s.ok('tlb', 'GET', '')).teamRequestFlags, { [s.bravo]: 1 });
  assert.equal((await s.ok('tlb', 'GET', '/attention')).items.find((i) => i.kind === 'team_requests').count, 1);
});

check('Delete my data removes the pending requests of the account and keeps the decided ones, unlinked', async () => {
  const s = await world();
  const pending = (await ask(s, 'm2', s.other, s.bravo)).json.request.id;
  const decided = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  await s.ok('tlb', 'POST', `/team-requests/${decided}/reject`, {}, 200);
  await s.ok('m2', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  assert(!(await rowOf(s, pending)), 'the pending request went with the account');
  await s.ok('m1', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  const kept = await rowOf(s, decided);
  assert.deepEqual([kept.status, kept.requested_by, kept.decided_by], ['rejected', null, s.uids.tlb]);
});

check('the new audit actions read in the Activity log, with the character and the team named', async () => {
  const s = await world();
  const id = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  await s.ok('tlb', 'POST', `/team-requests/${id}/approve`, {}, 200);
  const withdrawn = (await ask(s, 'm1', s.alt2, s.charlie)).json.request.id;
  await s.ok('m1', 'DELETE', `/team-requests/${withdrawn}`, {}, 200);
  const log = (await s.ok('gm', 'GET', '/audit?type=roster')).rows.map((row) => row.text).join('\n');
  assert(/Asked for Altone to be put on Bravo/.test(log), log);
  assert(/Approved the request to put Altone on Bravo/.test(log));
  assert(/Withdrew the request to put Alttwo on Charlie/.test(log));
});

check('approve refuses (409 request_changed) when the asker no longer owns the character - the person was unlinked or relinked to another account - or the asker is blocked; the request stays pending', async () => {
  const s = await world();
  await s.member('m3', 'Memberthree');
  const a = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  const approve = (who = 'tlb') => s.call(who, 'POST', `/team-requests/${a}/approve`, {});
  const refused = async () => {
    const res = await approve();
    assert.deepEqual([res.status, res.json.error], [409, 'request_changed'], res.text);
    assert.equal(await s.teamOf(s.alt1), null, 'nothing was placed');
    assert.equal((await rowOf(s, a)).status, 'pending');
    assert.equal((await s.rows("SELECT id FROM audit_log WHERE action IN ('team_request.approve', 'character.place')")).length, 0);
  };
  // The person is unlinked from the asker's account, then linked to a different one.
  await s.ok('gm', 'PUT', `/roster/${s.m1.pid}/account`, { userId: null }, 200);
  await refused();
  await s.link(s.m1.pid, 'm3');
  await refused();
  // Linked to the asker again: the request is theirs once more.
  await s.ok('gm', 'PUT', `/roster/${s.m1.pid}/account`, { userId: null }, 200);
  await s.link(s.m1.pid, 'm1');
  // A block on the asker's account stops it, and lifting the block brings it back.
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${s.uids.m1}', '${s.uids.gm}', 'spam', 1)`);
  await refused();
  s.exec(`DELETE FROM guild_blocks WHERE user_id = '${s.uids.m1}'`);
  await s.ok('o1', 'POST', `/team-requests/${a}/approve`, {}, 200);
  assert.equal(await s.teamOf(s.alt1), s.bravo);
  // Reject is still the way out for a request nobody can approve any more.
  const b = (await ask(s, 'm1', s.alt2, s.charlie)).json.request.id;
  await s.ok('gm', 'PUT', `/roster/${s.m1.pid}/account`, { userId: null }, 200);
  await s.fail('o1', 'POST', `/team-requests/${b}/approve`, {}, 409, 'request_changed');
  await s.ok('o1', 'POST', `/team-requests/${b}/reject`, {}, 200);
  assert.equal((await rowOf(s, b)).status, 'rejected');
});

check('the approval re-checks the asker inside the placing statement: an account relinked or blocked between the read and the write places nothing', async () => {
  const { placeStatement } = await import('../../worker/team-place.js');
  const { askerStillOwns } = await import('../../worker/routes/team-requests.js');
  const s = await world();
  const id = (await ask(s, 'm1', s.alt1, s.bravo)).json.request.id;
  const row = { player_id: s.m1.pid, requested_by: s.uids.m1 };
  // The own rows of the placing statement (SQL changes()): meta.changes also counts the trigger rows of migration 0040 (worker/d1-changes.js).
  const { directRows, directRowsStatement } = await import('../../worker/d1-changes.js');
  const place = async () => directRows((await s.w.db.batch([placeStatement(s.w.db, {
    guildId: s.gid, personId: s.m1.pid, characterId: s.alt1, teamId: s.bravo, from: null, now: 1, extra: askerStillOwns(s.gid, row),
  }), directRowsStatement(s.w.db)]))[1]);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${s.uids.m1}', '${s.uids.gm}', 'x', 1)`);
  assert.equal(await place(), 0, 'blocked');
  s.exec(`DELETE FROM guild_blocks WHERE user_id = '${s.uids.m1}'`);
  s.exec(`UPDATE players SET user_id = NULL WHERE id = '${s.m1.pid}'`);
  assert.equal(await place(), 0, 'no longer the person\'s account');
  s.exec(`UPDATE players SET user_id = '${s.uids.m1}' WHERE id = '${s.m1.pid}'`);
  assert.equal(await place(), 1, 'the asker, not blocked, owns the person');
  assert.equal(await s.teamOf(s.alt1), s.bravo);
  assert.equal((await rowOf(s, id)).status, 'pending', 'the statement places only; the route closes the request in the same batch');
});

runChecks(checks);
