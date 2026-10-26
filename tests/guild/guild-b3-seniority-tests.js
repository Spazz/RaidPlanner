/**
 * Raidsmith guild tracker - lane B3 of the user-hierarchy build: the Seniority guard (worker/seniority.js)
 * Run: node tests/guild/guild-b3-seniority-tests.js
 *
 * A junior can never delete, move, release, relink or rename a senior's person or characters (plan "Seniority guard", arch A9-18):
 *   - the rank matrix of the SQL helper itself (Owner seat seeded in owner_user_id, and the legacy case where the stored Guild Master is the Owner);
 *   - the plan's three named tests through the routes (Officer deletes the Owner's person: refused; Team Lead deletes a Raid Leader's person: refused;
 *     Officer deletes a Member's person: allowed), a person owned only by a Discord id, a person with no account, one's own person;
 *   - every guarded writer: delete person, remove character, rename and move a character, relink a Discord account, link and unlink an account,
 *     and the three routes that swap a person's Main (a new Main, Make Main, an Unmatched-names link as the Main), each also inside its batch;
 *   - linking a Raid-Helper sign-up gives the person a Discord ID: roster.edit on the person's team and the guard, in the pre-check and inside the batch;
 *   - a Battle.net-proven character, or a person holding one, is deleted only by a GM-tier actor;
 *   - the guard sits INSIDE the write: a promotion between the read and the write stops the write.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// Alpha-team people, one per account: the Owner seat (a plain Member by role), two Officers, two Team Leads of Alpha, two Members, and the Guild Master's own.
const ACCOUNTS = { own: 'Ownerseat', o1: 'Officerone', o2: 'Officertwo', tl: 'Leadone', tl2: 'Leadtwo', m1: 'Memberone', m2: 'Membertwo' };

async function world({ owner = true } = {}) {
  const s = await scenario();
  const [alpha] = s.tids;
  s.people = {};
  await s.member('own', 'Ownerseat');
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  await s.lead('tl', [alpha], 'Leadone');
  await s.lead('tl2', [alpha], 'Leadtwo');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  for (const [key, name] of Object.entries(ACCOUNTS)) {
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
  }
  s.people.gm = await s.person({ name: 'Gmperson' });
  await s.link(s.people.gm.pid, 'gm');
  s.people.free = await s.person({ name: 'Freeperson' }); // no account at all
  if (owner) await s.setOwner('own');
  return s;
}

async function guardOf(s, actor, target) {
  const { seniorityOk } = await load('worker/seniority.js');
  const guard = seniorityOk(s.gid, s.uids[actor], s.people[target].pid);
  return (await s.w.db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first()).ok === 1;
}

check('the rank matrix: the Owner passes everyone, a Guild Master everyone but the Owner, a stricter rank never an equal or senior one, anyone their own and an unlinked person', async () => {
  const s = await world();
  const expected = {
    own: { own: 1, o1: 1, o2: 1, tl: 1, tl2: 1, m1: 1, m2: 1, gm: 1, free: 1 },
    gm: { own: 0, o1: 1, o2: 1, tl: 1, tl2: 1, m1: 1, m2: 1, gm: 1, free: 1 },
    o1: { own: 0, o1: 1, o2: 0, tl: 1, tl2: 1, m1: 1, m2: 1, gm: 0, free: 1 },
    tl: { own: 0, o1: 0, o2: 0, tl: 1, tl2: 0, m1: 1, m2: 1, gm: 0, free: 1 },
    m1: { own: 0, o1: 0, o2: 0, tl: 0, tl2: 0, m1: 1, m2: 0, gm: 0, free: 1 },
  };
  for (const [actor, row] of Object.entries(expected)) {
    for (const [target, ok] of Object.entries(row)) {
      assert.equal(await guardOf(s, actor, target), ok === 1, `${actor} on the person of ${target}`);
    }
  }
});

check('legacy guild (owner_user_id NULL): the stored Guild Master is the Owner, so an Officer cannot touch the Guild Master\'s person', async () => {
  const s = await world({ owner: false });
  assert.equal(await guardOf(s, 'o1', 'gm'), false);
  assert.equal(await guardOf(s, 'gm', 'o1'), true);
  assert.equal(await guardOf(s, 'gm', 'gm'), true);
  assert.equal(await guardOf(s, 'o1', 'own'), true, 'with no Owner seat set, the seat account is a plain Member');
  // The seat once set protects its account and releases the Guild Master's person to a (strictly senior) Guild Master.
  await s.setOwner('own');
  assert.equal(await guardOf(s, 'o1', 'own'), false);
  assert.equal(await guardOf(s, 'gm', 'own'), false);
});

check('a person owned only by a Discord id counts as that account\'s: a Team Lead cannot delete the Discord-only Officer\'s person, nor an Officer the Discord-only Owner\'s', async () => {
  const s = await world();
  await s.officer('do1', 'Discordoff');
  await s.member('dow', 'Discordown');
  await s.member('dm', 'Discordmem');
  // POST /roster with a Discord link carries the member's Discord id only (players.user_id stays NULL).
  const officerPerson = await s.person({ name: 'Discordoff', linkUserId: s.uids.do1 });
  const ownerPerson = await s.person({ name: 'Discordown', linkUserId: s.uids.dow });
  const memberPerson = await s.person({ name: 'Discordmem', linkUserId: s.uids.dm });
  for (const p of [officerPerson, ownerPerson, memberPerson]) {
    const row = await s.one('SELECT user_id, discord_user_id FROM players WHERE id = ?', p.pid);
    assert.equal(row.user_id, null);
    assert(row.discord_user_id);
  }
  await s.setOwner('dow');
  await s.fail('tl', 'DELETE', `/roster/${officerPerson.pid}`, {}, 403, 'seniority');
  await s.fail('o2', 'DELETE', `/roster/${ownerPerson.pid}`, {}, 403, 'seniority');
  assert.equal((await s.one('SELECT COUNT(*) AS n FROM players WHERE id IN (?, ?)', officerPerson.pid, ownerPerson.pid)).n, 2);
  await s.ok('tl', 'DELETE', `/roster/${memberPerson.pid}`, {}, 200);
});

check('the plan\'s named tests: an Officer deletes the Owner\'s person (refused), a Team Lead deletes a Raid Leader\'s person (refused), an Officer deletes a Member\'s person (allowed)', async () => {
  const s = await world();
  const refused = await s.fail('o1', 'DELETE', `/roster/${s.people.own.pid}`, {}, 403, 'seniority');
  assert(/ranks the same as you or above/.test(refused.message));
  assert.equal((await s.one('SELECT COUNT(*) AS n FROM players WHERE id = ?', s.people.own.pid)).n, 1);
  // "Raid Leader" = an Officer-level account on the team: the Team Lead cannot delete it.
  await s.fail('tl', 'DELETE', `/roster/${s.people.o1.pid}`, {}, 403, 'seniority');
  assert.equal((await s.one('SELECT COUNT(*) AS n FROM players WHERE id = ?', s.people.o1.pid)).n, 1);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'person.delete'")).length, 0, 'a refused delete leaves no audit row');
  await s.ok('o1', 'DELETE', `/roster/${s.people.m1.pid}`, {}, 200);
  assert.equal((await s.one('SELECT COUNT(*) AS n FROM players WHERE id = ?', s.people.m1.pid)).n, 0);
  // Equal rank is refused, a Team Lead may delete a Member's and an unlinked person, and a Team Lead may delete their own.
  await s.fail('o1', 'DELETE', `/roster/${s.people.o2.pid}`, {}, 403, 'seniority');
  await s.fail('tl', 'DELETE', `/roster/${s.people.tl2.pid}`, {}, 403, 'seniority');
  await s.ok('tl', 'DELETE', `/roster/${s.people.m2.pid}`, {}, 200);
  await s.ok('tl', 'DELETE', `/roster/${s.people.free.pid}`, {}, 200);
  await s.ok('tl', 'DELETE', `/roster/${s.people.tl.pid}`, {}, 200);
  // The Guild Master deletes everyone but the Owner.
  await s.fail('gm', 'DELETE', `/roster/${s.people.own.pid}`, {}, 403, 'seniority');
  await s.ok('gm', 'DELETE', `/roster/${s.people.o1.pid}`, {}, 200);
});

check('the Owner seat passes everyone, the Guild Master\'s person included', async () => {
  const s = await world();
  await s.ok('gm', 'PUT', `/people/${s.uids.own}/roles`, { officer: true, teamLeadTeamIds: [] }, 200); // the Owner needs roster.edit to act at all
  await s.ok('own', 'DELETE', `/roster/${s.people.gm.pid}`, {}, 200);
  await s.ok('own', 'DELETE', `/roster/${s.people.o2.pid}`, {}, 200);
});

check('remove a character, rename it, move it, relink the Discord account, link and unlink the account: each is refused for a junior and works for a senior', async () => {
  const s = await world();
  const bravo = s.tids[1];
  // The Officer o1 has an alt; the Team Lead of Alpha (roster.edit on Alpha, and on the person through the home team) is the junior.
  const alt = await s.alt(s.people.o1.pid, 'Officeralt');
  await s.fail('tl', 'DELETE', `/roster/${s.people.o1.pid}/characters/${alt}`, {}, 403, 'seniority');
  await s.fail('tl', 'PATCH', `/roster/${s.people.o1.pid}/characters/${alt}`, { name: 'Renamedalt' }, 403, 'seniority');
  await s.fail('tl', 'PATCH', `/roster/${s.people.o1.pid}/characters/${s.people.o1.cid}`, { teamId: bravo }, 403);
  await s.fail('tl', 'PUT', `/roster/${s.people.o1.pid}/account`, { userId: null }, 403, 'seniority');
  const record = await s.ok('tl', 'GET', `/roster/${s.people.o1.pid}`);
  await s.fail('tl', 'PATCH', `/roster/${s.people.o1.pid}`, { expectedVersion: record.person.version, linkUserId: s.uids.o1 }, 403);
  assert.deepEqual((await s.rows('SELECT name FROM characters WHERE player_id = ? ORDER BY name', s.people.o1.pid)).map((r) => r.name), ['Officeralt', 'Officerone']);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', s.people.o1.pid)).user_id, s.uids.o1, 'still linked');
  // A class change is not an identity change: it stays with whoever edits the roster.
  await s.ok('tl', 'PATCH', `/roster/${s.people.o1.pid}/characters/${alt}`, { class: 'MAGE', mainSpec: 'Fire' }, 200);
  // The senior Guild Master may do all of it.
  await s.ok('gm', 'PATCH', `/roster/${s.people.o1.pid}/characters/${alt}`, { name: 'Renamedalt' }, 200);
  await s.ok('gm', 'DELETE', `/roster/${s.people.o1.pid}/characters/${alt}`, {}, 200);
  await s.ok('gm', 'PUT', `/roster/${s.people.o1.pid}/account`, { userId: null }, 200);
  // A Team Lead may relink a Member's person (the account is junior) and a person with no account.
  await s.ok('tl', 'PUT', `/roster/${s.people.m1.pid}/account`, { userId: null }, 200);
  await s.ok('tl', 'PUT', `/roster/${s.people.m1.pid}/account`, { userId: s.uids.m1 }, 200);
});

check('a Battle.net-proven character, or a person holding one, is deleted only by a GM-tier actor, whatever the rank of the person', async () => {
  const s = await world();
  const alt = await s.alt(s.people.m1.pid, 'Provenalt');
  s.exec(`UPDATE characters SET owner_proof = 'bnet' WHERE id = '${alt}'`);
  const refused = await s.fail('o1', 'DELETE', `/roster/${s.people.m1.pid}/characters/${alt}`, {}, 403, 'seniority');
  assert(/Battle\.net/.test(refused.message));
  const person = await s.fail('o1', 'DELETE', `/roster/${s.people.m1.pid}`, {}, 403, 'seniority');
  assert(/Battle\.net/.test(person.message));
  await s.fail('tl', 'DELETE', `/roster/${s.people.m1.pid}`, {}, 403, 'seniority');
  // An unproven alt of the same person goes as always, and the proven one is still there.
  const plain = await s.alt(s.people.m1.pid, 'Plainalt');
  await s.ok('o1', 'DELETE', `/roster/${s.people.m1.pid}/characters/${plain}`, {}, 200);
  assert.equal((await s.rows('SELECT id FROM characters WHERE id = ?', alt)).length, 1);
  await s.ok('gm', 'DELETE', `/roster/${s.people.m1.pid}/characters/${alt}`, {}, 200);
  s.exec(`UPDATE characters SET owner_proof = 'bnet' WHERE player_id = '${s.people.m2.pid}'`);
  await s.fail('o2', 'DELETE', `/roster/${s.people.m2.pid}`, {}, 403, 'seniority');
  await s.ok('gm', 'DELETE', `/roster/${s.people.m2.pid}`, {}, 200);
});

check('the guard sits inside the write: a target promoted after the read changes nothing (the DELETE matches no row)', async () => {
  const { seniorityDeleteOk } = await load('worker/seniority.js');
  const s = await world();
  const guard = seniorityDeleteOk(s.gid, s.uids.o1, s.people.m1.pid);
  const attempt = async () => s.w.db.batch([
    s.w.db.prepare(`DELETE FROM players WHERE id = ? AND guild_id = ? AND ${guard.sql} RETURNING id`).bind(s.people.m1.pid, s.gid, ...guard.params),
  ]);
  // Read: the Member's person is the Officer's to delete. Then the Member's account is made an Officer, as another request could do between the read and the write.
  await s.ok('gm', 'PUT', `/people/${s.uids.m1}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  const [result] = await attempt();
  assert.equal(result.results.length, 0, 'an equal rank now: nothing deleted');
  assert.equal((await s.rows('SELECT id FROM players WHERE id = ?', s.people.m1.pid)).length, 1);
  // And the actor demoted: an Officer who lost the role no longer outranks a Team Lead.
  await s.ok('gm', 'PUT', `/people/${s.uids.o1}/roles`, { officer: false, teamLeadTeamIds: [] }, 200);
  const lower = seniorityDeleteOk(s.gid, s.uids.o1, s.people.tl.pid);
  assert.equal((await s.w.db.prepare(`SELECT ${lower.sql} AS ok`).bind(...lower.params).first()).ok, 0);
});

check('a refused request names the reason in the body: error "seniority", status 403, and every other 403 keeps its own error name', async () => {
  const s = await world();
  const refused = await s.call('o1', 'DELETE', `/roster/${s.people.own.pid}`, {});
  assert.deepEqual([refused.status, refused.json.error], [403, 'seniority']);
  const noRight = await s.call('m1', 'DELETE', `/roster/${s.people.m2.pid}`, {});
  assert.deepEqual([noRight.status, noRight.json.error], [403, 'forbidden']);
});

check('a new Main on a person (makeMain: true) is refused for a junior and works for a senior, an equal-rank actor\'s own person included; a refusal changes nothing', async () => {
  const s = await world();
  const alpha = s.tids[0];
  const namesOf = async (pid) => (await s.rows('SELECT name, is_main, team_id FROM characters WHERE player_id = ? ORDER BY name', pid)).map((r) => [r.name, r.is_main, r.team_id]);
  const intruder = (name) => ({ name, class: 'ROGUE', mainSpec: 'Combat', makeMain: true, teamId: alpha });
  const gmBefore = await namesOf(s.people.gm.pid);
  // A Team Lead cannot put a new Main on the Guild Master's person, nor an Officer on the equal Officer's.
  await s.fail('tl', 'POST', `/roster/${s.people.gm.pid}/characters`, intruder('Gmintruder'), 403, 'seniority');
  await s.fail('o1', 'POST', `/roster/${s.people.o2.pid}/characters`, intruder('Intrudertwo'), 403, 'seniority');
  assert.deepEqual(await namesOf(s.people.gm.pid), gmBefore, 'the Guild Master\'s Main is where it was');
  assert.equal((await s.rows("SELECT id FROM characters WHERE name IN ('Gmintruder', 'Intrudertwo')")).length, 0);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action IN ('character.create', 'character.main') AND entity_id NOT IN (SELECT id FROM characters)")).length, 0);
  // An alt (no makeMain) is not a re-key: the Team Lead still adds one to the Guild Master's person.
  await s.ok('tl', 'POST', `/roster/${s.people.gm.pid}/characters`, { name: 'Gmplainalt', class: 'ROGUE', mainSpec: 'Combat' }, 201);
  // An Officer puts a new Main on a Member's person; the actor on their own person passes whatever their rank.
  const swapped = await s.ok('o1', 'POST', `/roster/${s.people.m1.pid}/characters`, intruder('Memnewmain'), 201);
  assert.equal(swapped.characters.find((c) => c.name === 'Memnewmain').isMain, true);
  await s.ok('tl', 'POST', `/roster/${s.people.tl.pid}/characters`, intruder('Leadnewmain'), 201);
  assert.equal((await s.one('SELECT is_main FROM characters WHERE name = ?', 'Leadnewmain')).is_main, 1);
});

check('Make Main is refused for a junior on a senior\'s person and works on a Member\'s and on the actor\'s own person; a refusal changes nothing', async () => {
  const s = await world();
  const mainOf = async (pid) => (await s.one('SELECT name FROM characters WHERE player_id = ? AND is_main = 1', pid)).name;
  const gmAlt = await s.alt(s.people.gm.pid, 'Gmalt');
  const memberAlt = await s.alt(s.people.m1.pid, 'Memberalt');
  const officerAlt = await s.alt(s.people.o1.pid, 'Officeralt');
  await s.fail('o1', 'POST', `/roster/${s.people.gm.pid}/characters/${gmAlt}/main`, {}, 403, 'seniority');
  // The alt is on no team, so a Team Lead is refused before the Seniority guard (R2: only a guild-wide editor makes a teamless character the Main).
  await s.fail('tl', 'POST', `/roster/${s.people.o1.pid}/characters/${officerAlt}/main`, {}, 403, 'forbidden');
  assert.deepEqual([await mainOf(s.people.gm.pid), await mainOf(s.people.o1.pid)], ['Gmperson', 'Officerone']);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'character.main'")).length, 0, 'a refused swap leaves no audit row');
  await s.ok('o1', 'POST', `/roster/${s.people.m1.pid}/characters/${memberAlt}/main`, {}, 200);
  assert.equal(await mainOf(s.people.m1.pid), 'Memberalt');
  await s.ok('o1', 'POST', `/roster/${s.people.o1.pid}/characters/${officerAlt}/main`, {}, 200);
  assert.equal(await mainOf(s.people.o1.pid), 'Officeralt');
  await s.ok('gm', 'POST', `/roster/${s.people.gm.pid}/characters/${gmAlt}/main`, {}, 200);
  assert.equal(await mainOf(s.people.gm.pid), 'Gmalt');
});

check('the Main swap sits inside the batch: a target promoted after the read changes nothing (the first UPDATE matches no row), and the builders refuse to run without the guard', async () => {
  const { makeMainStatements, newMainStatements } = await load('worker/routes/roster.js');
  const { seniorityOk } = await load('worker/seniority.js');
  const s = await world();
  const alt = await s.alt(s.people.m1.pid, 'Memberalt');
  assert.throws(() => makeMainStatements(s.w.db, s.people.m1.pid, alt, 1, { homeTeamId: s.tids[0], targetTeamId: null }), /Seniority guard is required/);
  assert.throws(() => newMainStatements(s.w.db, { playerId: s.people.m1.pid, characterId: alt, previousMain: { id: s.people.m1.cid, team_id: s.tids[0] }, teamId: null, now: 1 }), /Seniority guard is required/);
  const swap = () => makeMainStatements(s.w.db, s.people.m1.pid, alt, s.w.clock.now, {
    homeTeamId: s.tids[0], targetTeamId: null, senior: seniorityOk(s.gid, s.uids.o1, s.people.m1.pid),
  });
  // The Member's account is made an Officer after the route's read: an equal rank now.
  await s.ok('gm', 'PUT', `/people/${s.uids.m1}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  const refused = await s.w.db.batch(swap());
  assert.deepEqual(refused.map((r) => r.meta.changes), [0, 0], 'neither UPDATE happened');
  assert.equal((await s.one('SELECT is_main FROM characters WHERE id = ?', s.people.m1.cid)).is_main, 1);
  // The same swap for an actor who outranks the account goes through.
  await s.ok('gm', 'PUT', `/people/${s.uids.m1}/roles`, { officer: false, teamLeadTeamIds: [] }, 200);
  const done = await s.w.db.batch(swap());
  assert.deepEqual(done.map((r) => r.meta.changes), [1, 1]);
});

check('linking an unmatched raid name as a new Main (attendance) is guarded too: refused on a senior\'s person, allowed on a Member\'s', async () => {
  const s = await world();
  const alpha = s.tids[0];
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: alpha, raidOn: '2026-10-01', startTime: '20:00', zone: 'Karazhan' })).raid.id;
  const log = (name) => s.exec(`INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key) VALUES ('${raid}', '${s.gid}', '${name}', '${name.toLowerCase()}', 'Nightslayer', 'nightslayer')`);
  log('Gmnewmain');
  log('Memnewmain');
  const link = (who, name, pid) => s.call(who, 'POST', `/raids/${raid}/unmatched`, { key: `${name.toLowerCase()}|nightslayer`, action: 'alt', class: 'ROGUE', personId: pid, makeMain: true });
  const before = (await s.rows('SELECT name FROM characters WHERE is_main = 1 AND player_id = ?', s.people.gm.pid)).map((r) => r.name);
  const refused = await link('o1', 'Gmnewmain', s.people.gm.pid);
  assert.deepEqual([refused.status, refused.json && refused.json.error], [403, 'seniority'], refused.text);
  assert.deepEqual((await s.rows('SELECT name FROM characters WHERE is_main = 1 AND player_id = ?', s.people.gm.pid)).map((r) => r.name), before);
  assert.equal((await s.rows('SELECT id FROM characters WHERE name = ?', 'Gmnewmain')).length, 0);
  const allowed = await link('o1', 'Memnewmain', s.people.m1.pid);
  assert.equal(allowed.status, 200, allowed.text);
  assert.equal((await s.one('SELECT is_main FROM characters WHERE name = ?', 'Memnewmain')).is_main, 1);
});

check('linking a Raid-Helper sign-up gives the person its Discord ID: needs roster.edit on the PERSON\'s team, not only the raid\'s, and passes the Seniority guard; each refusal changes nothing', async () => {
  const s = await world();
  const [alpha, bravo] = s.tids;
  const raid = (await s.ok('tl', 'POST', '/raids', { teamId: alpha, raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan' })).raid.id;
  const signup = (id, discordId) => s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id)
    VALUES ('${raid}', 'raid_helper', ${id}, '${discordId}', 'Attacker${id}', 'signed', 'Mage', 'Fire', ${id}, '${s.gid}')`);
  const link = (who, id, pid) => s.call(who, 'POST', `/raids/${raid}/signups/link`, { signupId: id, personId: pid });
  const personRow = (pid) => s.one('SELECT discord_user_id, version FROM players WHERE id = ?', pid);
  const signupRow = (id) => s.one('SELECT player_id FROM raid_signups WHERE raid_id = ? AND signup_id = ?', raid, id);
  const linkAudits = async () => (await s.rows("SELECT id FROM audit_log WHERE action = 'signup.link'")).length;
  const bravoGuy = await s.person({ name: 'Bravoguy', teamId: bravo });
  signup(1, '555000555000555001');
  signup(2, '555000555000555002');
  signup(3, '555000555000555003');
  signup(4, '555000555000555004');
  // The raid is Alpha's and the Team Lead leads Alpha, but the Guild Master's person is senior: refused, whichever team it sits on.
  const gmBefore = await personRow(s.people.gm.pid);
  await s.fail('tl', 'POST', `/raids/${raid}/signups/link`, { signupId: 1, personId: s.people.gm.pid }, 403, 'seniority');
  assert.deepEqual(await personRow(s.people.gm.pid), gmBefore);
  assert.equal((await signupRow(1)).player_id, null);
  // A person on Bravo is not the Alpha lead's to relink, even for an Alpha raid.
  await s.fail('tl', 'POST', `/raids/${raid}/signups/link`, { signupId: 2, personId: bravoGuy.pid }, 403, 'forbidden');
  assert.equal((await personRow(bravoGuy.pid)).discord_user_id, null);
  assert.equal((await signupRow(2)).player_id, null);
  assert.equal(await linkAudits(), 0, 'a refused link leaves no audit row');
  // A Member's person on the lead's own team, and the lead's own person, link; so does an Officer onto a person of any team.
  assert.equal((await link('tl', 1, s.people.m1.pid)).status, 200);
  assert.deepEqual([(await personRow(s.people.m1.pid)).discord_user_id, (await signupRow(1)).player_id], ['555000555000555001', s.people.m1.pid]);
  assert.equal((await link('tl', 2, s.people.tl.pid)).status, 200);
  assert.equal((await personRow(s.people.tl.pid)).discord_user_id, '555000555000555002');
  assert.equal((await link('o1', 3, bravoGuy.pid)).status, 200);
  assert.deepEqual([(await personRow(bravoGuy.pid)).discord_user_id, (await signupRow(3)).player_id], ['555000555000555003', bravoGuy.pid]);
  assert.equal(await linkAudits(), 3);
  // An Officer is refused on an equal Officer's person; the Guild Master links anyone.
  await s.fail('o1', 'POST', `/raids/${raid}/signups/link`, { signupId: 4, personId: s.people.o2.pid }, 403, 'seniority');
  assert.equal((await link('gm', 4, s.people.o2.pid)).status, 200);
  // A person who already carries that Discord ID relinks nothing, so the person-level rules do not apply: the raid's team alone decides.
  signup(5, '555000555000555001');
  assert.equal((await link('tl', 5, s.people.m1.pid)).status, 200);
});

check('linking a sign-up sits inside the batch: the Discord ID and the sign-up rows follow the person only while the Seniority guard holds', async () => {
  const { linkSignupsStatement } = await load('worker/attendance-store.js');
  const { seniorityOk } = await load('worker/seniority.js');
  const s = await world();
  const raid = (await s.ok('tl', 'POST', '/raids', { teamId: s.tids[0], raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan' })).raid.id;
  for (const id of [1, 2]) {
    s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id)
      VALUES ('${raid}', 'raid_helper', ${id}, '555000555000555009', 'Attacker${id}', 'signed', 'Mage', 'Fire', ${id}, '${s.gid}')`);
  }
  const attempt = (actor) => s.w.db.batch([linkSignupsStatement(s.w.db, s.gid, s.people.gm.pid, '555000555000555009', raid, 1, seniorityOk(s.gid, s.uids[actor], s.people.gm.pid))]);
  assert.equal((await attempt('tl'))[0].meta.changes, 0, 'a Team Lead links nothing onto the Guild Master\'s person');
  assert.equal((await s.rows('SELECT player_id FROM raid_signups WHERE player_id IS NOT NULL')).length, 0);
  assert.equal((await attempt('gm'))[0].meta.changes, 2, 'the Guild Master\'s own person takes both rows with that Discord ID');
  // Without a guard the statement is the one it always was.
  s.exec('UPDATE raid_signups SET player_id = NULL');
  assert.equal((await s.w.db.batch([linkSignupsStatement(s.w.db, s.gid, s.people.m1.pid, '555000555000555009', raid, 1)]))[0].meta.changes, 2);
});

runChecks(checks);


