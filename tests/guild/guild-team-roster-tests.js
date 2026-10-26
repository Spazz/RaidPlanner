/**
 * Raidsmith guild tracker - the team-roster predicate (user-hierarchy build, lane B1a-2; U R6-Q2 and U R8-Q2)
 * Run: node tests/guild/guild-team-roster-tests.js
 *
 * A character is on a TEAM ROSTER when it is placed (team_id), still here (left_on NULL) and a raiding rank (raider / trial / reserve). Social and Former
 * characters are never on one, so they must not appear in any output that lists a team's people or its attendance rows:
 *   the Roster read, the public page, a guest link, the API-key feeds (roster, attendance) - and the public roster and attendance sections;
 * and ownTeamIds applies the same rule to team ACCESS (U R8-Q2): a teamless, a placed Social and a placed Former character each grant no team scope, another
 * visible character of the same person on that team still does.
 * LOOT is not a roster view: the public page and the API loot feed show every award, whoever won it (an alt with no team, a Social or a Former character).
 * The Roster page's Inactive filter (GET /roster?team=&status=inactive) keeps returning the team's placed Social / Former people until the Users page ships.
 * The predicate itself (one definition in SQL and in JS) is pinned over every combination first.
 */
const assert = require('node:assert/strict');
const { createD1Fake } = require('../d1-fake');
const { load, adminOf, memberOf, makeWorld, signIn, newJar } = require('../guild-world');

const SERVER = '900000000000000091';
const person = (n, name) => ({ id: `1100000000000009${String(n).padStart(2, '0')}`, username: name.toLowerCase(), globalName: name });
const P = { gm: person(91, 'Gmroster'), m1: person(92, 'Memberone'), m2: person(93, 'Membertwo'), m3: person(94, 'Memberthree'), m4: person(95, 'Memberfour'), m5: person(96, 'Memberfive') };
const NOW = 1_800_000_000_000; // 2027-01-15T08:00Z
const STEP = 2000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function scenario(members = []) {
  const w = await makeWorld({});
  w.clock.now = NOW;
  // These checks put several characters of one person on one team: the shape the data has until migration 0032's unique (team, person) index is applied (B2
  // ships first). The predicate must still be right for it, so the index is left out of this world.
  w.db.sqlite.exec('DROP INDEX IF EXISTS characters_team_person');
  const jars = { gm: (await signIn(w, P.gm, [adminOf(SERVER)])).jar };
  const made = await w.call(jars.gm, 'POST', '/api/guild', {
    serverId: SERVER, name: 'Roster Predicate', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York',
    multipleTeams: true, teamNames: ['Alpha', 'Bravo'],
  });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const [alpha, bravo] = made.json.teams.map((team) => team.id);
  const uids = {};
  for (const key of members) {
    jars[key] = (await signIn(w, P[key], [memberOf(SERVER)])).jar;
    uids[key] = (await w.call(jars[key], 'GET', '/auth/me')).json.user.id;
  }
  const s = {
    w, gid, alpha, bravo, jars, uids, base: `/api/guild/${gid}`,
    async call(who, method, tail, body) { w.advance(STEP); return w.call(jars[who], method, tail.startsWith('/api/') ? tail : `${s.base}${tail}`, body); },
    async ok(who, method, tail, body, status) {
      const res = await s.call(who, method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${who} ${method} ${tail}: ${res.text}`);
      return res.json;
    },
    exec: (sql, ...values) => w.db.prepare(sql).bind(...values).run(),
    rows: (sql, ...values) => w.rows(sql, ...values),
    async person(name, { team = alpha, status = 'raider', link = null, cls = 'MAGE', spec = 'Fire' } = {}) {
      const res = await s.ok('gm', 'POST', '/roster', { teamId: team, name, class: cls, mainSpec: spec, offSpec: null, status, joinedOn: '2026-09-01', ...(link ? { linkUserId: uids[link] } : {}) });
      return { pid: res.person.id, cid: res.characters[0].id, version: res.person.version };
    },
    // A new alt starts on no team (B2); the team routes that place it come with B3, so the test places it with the column itself.
    async alt(pid, name, { team = alpha } = {}) {
      const res = await s.ok('gm', 'POST', `/roster/${pid}/characters`, { teamId: team, name, class: 'ROGUE', mainSpec: 'Combat', offSpec: null });
      const id = res.characters.find((c) => c.name === name).id;
      await s.exec('UPDATE characters SET team_id = ? WHERE id = ?', team, id);
      return id;
    },
    // The person goes Inactive through the API (the dual write makes every character Social); leftOn makes them Former.
    async inactive(p, extra = {}) { return s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.version, status: 'inactive', ...extra }); },
    async me(who) { return (await s.ok(who, 'GET', '')).me; },
  };
  return s;
}

// ---------------------------------------------------------------------------
// The predicate: one definition in SQL and JS

check('the predicate over every combination: SQL fragment, row test and character test agree; only placed, still-here raider / trial / reserve pass', async () => {
  const roster = await load('worker/team-roster.js');
  const rank = await load('worker/person-rank.js');
  const db = createD1Fake();
  db.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                  VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1)`);
  db.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1)");
  let n = 0;
  const sources = [];
  for (const team of [null, 't1']) for (const left of [null, '2026-01-01']) for (const core of ['raider', 'trial', 'reserve', 'social']) {
    n++;
    db.sqlite.exec(`INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('p${n}', 'g1', 'raider', 1, 1)`); // one person each: one character per person per team
    db.sqlite.exec(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at, core_rank, left_on)
                    VALUES ('c${n}', 'g1', 'p${n}', ${team ? `'${team}'` : 'NULL'}, 'N${n}', 'n${n}', 'MAGE', 0, 1, 1, '${core}', ${left ? `'${left}'` : 'NULL'})`);
    sources.push({ id: `c${n}`, team, left, core });
  }
  const sql = await db.prepare(`SELECT c.id, ${roster.teamRosterSql('c')} AS on_roster, ${roster.onTeamRosterSql('c', "'t1'")} AS on_t1, ${roster.onTeamRosterSql('c', "'t2'")} AS on_t2
                                  FROM characters c ORDER BY c.id`).all();
  assert.equal(sql.results.length, 16);
  let onRoster = 0;
  for (const result of sql.results) {
    const source = sources.find((row) => row.id === result.id);
    const row = await db.prepare('SELECT * FROM characters WHERE id = ?').bind(result.id).first();
    const expected = source.team !== null && source.left === null && ['raider', 'trial', 'reserve'].includes(source.core);
    assert.equal(result.on_roster === 1, expected, `${JSON.stringify(source)}: SQL`);
    assert.equal(roster.isTeamRosterRow(row), expected, `${JSON.stringify(source)}: row test`);
    assert.equal(roster.isTeamRosterCharacter(rank.characterOfRow(row)), expected, `${JSON.stringify(source)}: character test`);
    assert.equal(result.on_t1 === 1, expected, 'on the roster of the team it is placed on');
    assert.equal(result.on_t2, 0, 'never on another team');
    if (expected) onRoster++;
  }
  assert.equal(onRoster, 3);
});

// ---------------------------------------------------------------------------
// Outputs: Social and Former never appear

// A guild with a visible raid group and the people the predicate must keep out. Returns the names by kind.
async function populated() {
  const s = await scenario();
  const names = {
    visible: ['Rmain', 'Ralt', 'Tlmain'],
    hidden: ['Socmain', 'Formmain', 'Socalt', 'Tlalt'],
  };
  const rmain = await s.person('Rmain');
  await s.alt(rmain.pid, 'Ralt');                                                    // a visible second character of the same person on Alpha
  const socalt = await s.alt(rmain.pid, 'Socalt');                                   // placed on Alpha, but Social
  await s.exec("UPDATE characters SET core_rank = 'social' WHERE id = ?", socalt);
  const tl = await s.person('Tlmain');
  const tlalt = await s.alt(tl.pid, 'Tlalt');                                        // a Raider alt with no team
  await s.exec('UPDATE characters SET team_id = NULL WHERE id = ?', tlalt);
  const soc = await s.person('Socmain');
  await s.inactive(soc);                                                             // inactive = Social (the dual write)
  const former = await s.person('Formmain');
  await s.inactive(former, { leftOn: '2027-01-02', leftReason: 'left' });            // left the guild = Former
  const ranks = await s.rows('SELECT name, core_rank, left_on, team_id IS NULL AS teamless FROM characters ORDER BY name');
  assert.deepEqual(ranks.map((row) => [row.name, row.core_rank, row.left_on, row.teamless]), [
    ['Formmain', 'social', '2027-01-02', 0], ['Ralt', 'raider', null, 0], ['Rmain', 'raider', null, 0], ['Socalt', 'social', null, 0],
    ['Socmain', 'social', null, 0], ['Tlalt', 'raider', null, 1], ['Tlmain', 'raider', null, 0],
  ], 'the seed: the dual write made Socmain Social and Formmain Former');

  // A past raid with attendance for every person, and a loot award to every character (plus a stranger and a disenchant).
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2027-01-14', startTime: '20:00', zone: "Gruul's Lair" })).raid.id;
  for (const row of await s.rows('SELECT id FROM players ORDER BY id')) {
    await s.exec("INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, attended) VALUES (?, ?, ?, ?, 'present', 1, 1)", raid, s.gid, s.alpha, row.id);
  }
  let item = 0;
  for (const name of [...names.visible, ...names.hidden, 'Stranger']) {
    item++;
    await s.exec(
      `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key,
                                winner_class, tag, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 4, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', 'MS', 1, 1)`,
      `la_${item}`, s.gid, raid, s.alpha, `checksum-${item}-aaaaaaaa`, 1000 + item, `Item ${item}`, NOW - 1000 * item, name, name.toLowerCase(),
    );
  }
  await s.exec(
    `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key,
                              winner_class, tag, created_at, updated_at)
     VALUES ('la_de', ?, ?, ?, 'checksum-de-aaaaaaaa', 2000, 'Disenchanted item', 4, ?, NULL, NULL, NULL, '', NULL, 'DE', 1, 1)`,
    s.gid, raid, s.alpha, NOW - 5000,
  );
  return { s, names, raid };
}

// Every character that won an award in populated(), plus a name no character carries.
const ALL_WINNERS = ['Rmain', 'Ralt', 'Tlmain', 'Socmain', 'Formmain', 'Socalt', 'Tlalt', 'Stranger'];

const text = (json) => JSON.stringify(json);
function assertNoHidden(output, names, where) {
  const blob = text(output);
  for (const name of names.hidden) assert.equal(blob.includes(name), false, `${where}: ${name} (Social, Former or off-roster) must not appear`);
}
function assertVisible(output, names, where) {
  const blob = text(output);
  for (const name of names.visible) assert.equal(blob.includes(name), true, `${where}: ${name} stays`);
}

check('the Roster read lists only people on the team roster: a Social and a Former person are gone, a person\'s alts that are Social or teamless are not on the team', async () => {
  const { s, names } = await populated();
  const alpha = await s.ok('gm', 'GET', `/roster?team=${s.alpha}`);
  assertNoHidden(alpha.people.map((p) => ({ shown: p.shown, names: p.names, main: p.main.name })), names, 'roster');
  assert.deepEqual(alpha.people.map((p) => p.shown.name), ['Rmain', 'Tlmain']);
  const rmain = alpha.people.find((p) => p.shown.name === 'Rmain');
  assert.deepEqual(rmain.names, ['Ralt', 'Rmain'], 'the visible second character stays, the Social one is not on the team');
  assert.equal(rmain.altCount, 2, 'but both alts still count as the person\'s alts');
  const tl = alpha.people.find((p) => p.shown.name === 'Tlmain');
  assert.deepEqual([tl.names, tl.altCount], [['Tlmain'], 1], 'the teamless alt is an alt, not on the team');
  assert.deepEqual((await s.ok('gm', 'GET', `/roster?team=${s.bravo}`)).people, [], 'nobody is on Bravo');
});

check('the Inactive filter (GET /roster?team=&status=inactive) still returns the team\'s placed Social / Former people, for whoever may view the roster; retired when Users ships', async () => {
  const { s, names } = await populated();
  const inactive = await s.ok('gm', 'GET', `/roster?team=${s.alpha}&status=inactive`);
  assert.equal(inactive.filter, 'inactive');
  assert.deepEqual(inactive.people.map((p) => [p.shown.name, p.status]), [['Formmain', 'inactive'], ['Socmain', 'inactive']], 'the two inactive people of Alpha, as the page listed them before');
  const former = inactive.people.find((p) => p.shown.name === 'Formmain');
  assert.deepEqual([former.leftOn, former.leftReason, former.main.name, former.altCount, former.names], ['2027-01-02', 'left', 'Formmain', 0, ['Formmain']], 'the same row fields as the default list');
  assert.deepEqual(Object.keys(former).sort(), Object.keys((await s.ok('gm', 'GET', `/roster?team=${s.alpha}`)).people[0]).sort(), 'the same row shape');
  // Nobody of the default list is in it, and nobody of it is in the default list: Social / Former are not mixed in.
  const roster = await s.ok('gm', 'GET', `/roster?team=${s.alpha}`);
  assert.equal(roster.filter, undefined, 'the default answer is unchanged');
  assert.deepEqual(roster.people.map((p) => p.shown.name).filter((name) => ['Socmain', 'Formmain'].includes(name)), []);
  assert.deepEqual(inactive.people.map((p) => p.shown.name).filter((name) => names.visible.includes(name) || name === 'Rmain'), [], 'a person with a roster character is on the default list only (Rmain\'s Social alt does not make Rmain inactive)');
  assert.deepEqual((await s.ok('gm', 'GET', `/roster?team=${s.bravo}&status=inactive`)).people, [], 'another team has none');
  // Reaching and reactivating an inactive person between R1 and R4.
  const socmain = inactive.people.find((p) => p.shown.name === 'Socmain');
  await s.ok('gm', 'PATCH', `/roster/${socmain.id}`, { expectedVersion: socmain.version, status: 'raider' });
  assert.deepEqual((await s.ok('gm', 'GET', `/roster?team=${s.alpha}&status=inactive`)).people.map((p) => p.shown.name), ['Formmain']);
  assert.deepEqual((await s.ok('gm', 'GET', `/roster?team=${s.alpha}`)).people.map((p) => p.shown.name), ['Rmain', 'Socmain', 'Tlmain']);
  // Only the one filter exists.
  for (const bad of ['active', 'everyone', '']) {
    const res = await s.call('gm', 'GET', `/roster?team=${s.alpha}&status=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.json.field, 'status');
  }
});

check('the Inactive filter has the audience of the roster list: a Member who may view the roster gets the same answer as the default list does', async () => {
  const s = await scenario(['m1']);
  const sleeper = await s.person('Sleeper');
  await s.person('Awake');
  await s.inactive(sleeper);
  const asMember = await s.call('m1', 'GET', `/roster?team=${s.alpha}&status=inactive`);
  const defaultList = await s.call('m1', 'GET', `/roster?team=${s.alpha}`);
  assert.equal(asMember.status, defaultList.status, 'the same permission (roster.view) as the default list');
  assert.equal(asMember.status, 200, asMember.text);
  assert.deepEqual(asMember.json.people.map((p) => p.shown.name), ['Sleeper']);
  assert.deepEqual(defaultList.json.people.map((p) => p.shown.name), ['Awake']);
});

check('the public page: the roster and attendance sections never show a Social, Former or teamless character; the loot section shows every award', async () => {
  const { s, names } = await populated();
  await s.ok('gm', 'PUT', '/public', { enabled: true, sections: ['roster', 'attendance', 'loot'] }, 200);
  const page = await s.w.call({}, 'GET', `/api/public/${s.gid}`);
  assert.equal(page.status, 200, page.text);
  const sections = page.json.sections;
  assert.deepEqual(sections.roster[0].people.map((p) => p.name), ['Rmain', 'Tlmain']);
  assertNoHidden(sections.roster, names, 'public roster');
  assert.deepEqual(sections.attendance[0].people.map((p) => p.name), ['Rmain', 'Tlmain'], 'attendance lists the people on the roster');
  assertNoHidden(sections.attendance, names, 'public attendance');
  // Loot history is not a roster view: the awards of a Social character, a Former one and an alt with no team show like any other.
  const winners = sections.loot[0].awards.map((a) => a.winner);
  assert.deepEqual(winners.filter((winner) => winner !== null).sort(), [...ALL_WINNERS].sort(), 'every winner shows, including the teamless alt and the Former character');
  assert.equal(winners.filter((winner) => winner === null).length, 1, 'and the disenchant');
  assertVisible(sections, names, 'public page');
});

check('a guest link shows the same: nobody off the roster', async () => {
  const { s, names } = await populated();
  const made = await s.ok('gm', 'POST', '/guest-links', { roleId: 'guest', expiresIn: '7d' });
  const jar = newJar();
  const redeemed = await s.w.call(jar, 'POST', '/auth/guest', { token: made.created.token });
  assert.equal(redeemed.status, 200, redeemed.text);
  const view = await s.w.call(jar, 'GET', '/api/guest');
  assert.equal(view.status, 200, view.text);
  assert.deepEqual(Object.keys(view.json.sections).sort(), ['attendance', 'raids', 'roster'], 'what the Guest role can see');
  assertNoHidden(view.json.sections, names, 'guest view');
  assert.deepEqual(view.json.sections.roster[0].people.map((p) => p.name), ['Rmain', 'Tlmain']);
  assert.deepEqual(view.json.sections.attendance[0].people.map((p) => p.name), ['Rmain', 'Tlmain']);
});

check('the API-key feeds: roster (status is the core rank) and attendance leave Social, Former and teamless characters out; loot lists every award', async () => {
  const { s, names } = await populated();
  const made = await s.ok('gm', 'POST', '/api-keys', { name: 'Sheet', datasets: ['roster', 'attendance', 'loot'], expiresIn: '30d' });
  const key = made.created.token;
  const get = async (dataset) => {
    const res = await s.w.call({}, 'GET', `/api/v1/${dataset}.json`, undefined, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(res.status, 200, `${dataset}: ${res.text}`);
    return res.json;
  };
  const roster = await get('roster');
  assert.deepEqual(roster.rows.map((row) => [row.character, row.status, row.main]), [['Rmain', 'raider', true], ['Tlmain', 'raider', true], ['Ralt', 'raider', false]]);
  assertNoHidden(roster, names, 'API roster');
  const attendance = await get('attendance');
  assert.deepEqual(attendance.rows.map((row) => [row.name, row.status]), [['Rmain', 'raider'], ['Tlmain', 'raider']]);
  assertNoHidden(attendance, names, 'API attendance');
  const loot = await get('loot');
  assert.deepEqual(loot.rows.map((row) => row.winner).filter((winner) => winner !== null).sort(), [...ALL_WINNERS].sort(), 'every winner, including the teamless alt and the Former character');
  assert.equal(loot.rows.filter((row) => row.winner === null).length, 1, 'and the disenchant');
});

check('a person who turns Trial or Reserve stays on the roster with that rank as the API status; Raider again after Inactive comes back', async () => {
  const s = await scenario();
  const a = await s.person('Aldric');
  const b = await s.person('Brindle');
  const key = (await s.ok('gm', 'POST', '/api-keys', { name: 'Sheet', datasets: ['roster'], expiresIn: '30d' })).created.token;
  const read = async () => (await s.w.call({}, 'GET', '/api/v1/roster.json', undefined, { headers: { Authorization: `Bearer ${key}` } })).json.rows.map((row) => [row.character, row.status]);
  await s.ok('gm', 'PATCH', `/roster/${a.pid}`, { expectedVersion: a.version, status: 'reserve' });
  await s.ok('gm', 'PATCH', `/roster/${b.pid}`, { expectedVersion: b.version, status: 'trial', trialEnd: '2027-02-01' });
  assert.deepEqual(await read(), [['Aldric', 'reserve'], ['Brindle', 'trial']]);
  const gone = await s.ok('gm', 'PATCH', `/roster/${a.pid}`, { expectedVersion: 2, status: 'inactive' });
  assert.deepEqual(await read(), [['Brindle', 'trial']], 'Inactive = Social: off the feed');
  await s.ok('gm', 'PATCH', `/roster/${a.pid}`, { expectedVersion: gone.person.version, status: 'raider' });
  assert.deepEqual(await read(), [['Aldric', 'raider'], ['Brindle', 'trial']], 'back on the roster');
});

// ---------------------------------------------------------------------------
// ownTeamIds: team access follows the predicate (U R8-Q2)

check('ownTeamIds: a teamless, a placed Social and a placed Former character each grant no team scope; a visible character on the team still does', async () => {
  const s = await scenario(['m1', 'm2', 'm3', 'm4', 'm5']);
  const scope = async (who) => {
    const me = await s.me(who);
    return { attendance: me.can['attendance.view'], loot: me.can['loot.view'], signups: me.can['signups.self'], teamIds: me.teamIds, mainTeamId: me.mainTeamId };
  };
  const none = (value) => !value || (Array.isArray(value) && !value.length);

  // m1: the only character is teamless.
  const teamless = await s.person('Teamlessone', { link: 'm1' });
  assert.deepEqual((await scope('m1')).attendance, [s.alpha], 'placed Raider: has the scope (control)');
  await s.exec('UPDATE characters SET team_id = NULL WHERE id = ?', teamless.cid);
  let got = await scope('m1');
  assert.deepEqual([none(got.attendance), none(got.loot), none(got.signups), got.teamIds, got.mainTeamId], [true, true, true, [], null], 'teamless');

  // m2: placed, but Social (inactive).
  const social = await s.person('Socialone', { link: 'm2' });
  assert.deepEqual((await scope('m2')).signups, [s.alpha], 'control');
  await s.inactive(social);
  got = await scope('m2');
  assert.deepEqual([none(got.attendance), none(got.loot), none(got.signups), got.teamIds, got.mainTeamId], [true, true, true, [], null], 'placed Social');

  // m3: placed, but Former (left).
  const former = await s.person('Formerone', { link: 'm3' });
  await s.inactive(former, { leftOn: '2027-01-03', leftReason: 'kicked' });
  got = await scope('m3');
  assert.deepEqual([none(got.attendance), none(got.loot), none(got.signups), got.teamIds, got.mainTeamId], [true, true, true, [], null], 'placed Former');

  // m4: a Social character AND a Raider one on Alpha: the visible one still grants the scope.
  const mixed = await s.person('Mixedone', { link: 'm4' });
  const visible = await s.alt(mixed.pid, 'Mixedalt');
  await s.exec("UPDATE characters SET core_rank = 'social' WHERE id = ?", mixed.cid);
  got = await scope('m4');
  assert.deepEqual([got.attendance, got.loot, got.signups, got.teamIds], [[s.alpha], [s.alpha], [s.alpha], [s.alpha]], 'the second character on the team keeps the scope');
  assert.equal(got.mainTeamId, null, 'the Main is Social: the Home does not take its team from it');
  // ... and when that one turns Social too, the scope goes.
  await s.exec("UPDATE characters SET core_rank = 'social' WHERE id = ?", visible);
  got = await scope('m4');
  assert.deepEqual([none(got.attendance), got.teamIds], [true, []]);

  // m5: Social on Alpha, Raider on Bravo: only Bravo.
  const split = await s.person('Splitone', { link: 'm5' });
  await s.alt(split.pid, 'Splitalt', { team: s.bravo });
  await s.exec("UPDATE characters SET core_rank = 'social' WHERE id = ?", split.cid);
  got = await scope('m5');
  assert.deepEqual([got.attendance, got.teamIds], [[s.bravo], [s.bravo]]);
});

check('ownTeamIds in the pure resolver: own_teams scope merges the ids it is given; a person who is nobody gets none', async () => {
  const { resolvePermissions, allows } = await load('worker/permissions.js');
  const rows = [{ role_id: 'member', action: 'loot.view', scope: 'own_teams' }];
  assert.deepEqual(resolvePermissions([], rows, ['t_a']).can, { 'loot.view': ['t_a'] });
  assert.equal(allows(resolvePermissions([], rows, []).can, 'loot.view', 't_a'), false);
});

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
