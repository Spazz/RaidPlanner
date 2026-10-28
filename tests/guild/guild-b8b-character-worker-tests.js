/**
 * Raidsmith guild tracker - lane B8b "character": the Character page's Worker routes
 * Run: node tests/guild/guild-b8b-character-worker-tests.js
 *
 *   GET    /api/me/characters/:cid   the owner's read: facts, team + core rank, in-game rank, level, waiting request, loot it won, raids it was in, the three flags
 *   PATCH  /api/me/characters/:cid   the owner changes Main spec and Off spec without roster.edit
 *   DELETE /api/me/characters/:cid   the owner removes their own ALT (never a Main, and in an in-game guild no character at all: user rule 2026-10-28)
 *   - 404 for everyone who is not the owner (another member, an officer, a stranger, an unknown or malformed id); officers keep roster.js's own paths unchanged;
 *   - raids: logged presence + typed names of a manual raid, bosses killed with it present out of the kills that night, none for a manual raid, rename aliases;
 *   - D1 limits (tests/d1-fake.js): every statement is one the fake accepts.
 */
const assert = require('node:assert/strict');
const { runChecks, scenario } = require('../guild-b3-world');
const { ingameize, makeProven } = require('../guild-ingame');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const idOf = (prefix, n) => `${prefix}_${String(n).padStart(22, '0')}`;
let serial = 0;

async function world(extra = {}) {
  const s = await scenario({ teams: ['Alpha', 'Bravo'], ...extra });
  const [alpha, bravo] = s.tids;
  Object.assign(s, { alpha, bravo });
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  await s.outsider('x1', 'Stranger');
  s.m1 = await s.person({ name: 'Mainone', class: 'DRUID', mainSpec: 'Restoration', offSpec: 'Feral (Tank)' });
  await s.link(s.m1.pid, 'm1');
  s.altId = await s.alt(s.m1.pid, 'Altone', { class: 'MAGE', mainSpec: 'Fire', offSpec: null });
  s.m2 = await s.person({ name: 'Maintwo' });
  await s.link(s.m2.pid, 'm2');
  s.other = await s.alt(s.m2.pid, 'Othertwo');
  return s;
}

const get = (s, who, cid) => s.call(who, 'GET', `/api/me/characters/${cid}`);
const page = async (s, who, cid) => { const res = await get(s, who, cid); assert.equal(res.status, 200, res.text); return res.json; };

// A raid of `teamId` on `raidOn`, as the attendance tables hold it (the raids table needs no more than this).
function addRaid(s, { zone = 'Karazhan', raidOn, teamId, mode = 'log', title = null }) {
  const id = idOf('ra', ++serial);
  const startsAt = Date.parse(`${raidOn}T20:00:00Z`);
  s.w.db.sqlite.prepare(
    `INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, title, log_mode, manual_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  ).run(id, s.gid, teamId, raidOn, startsAt, zone, title, mode, mode === 'manual' ? 'No log that night' : null);
  return { id, startsAt };
}

// pulls: [{ encounter, kill, present: ['Name', ...] }], one report; presence rows carry the name and the guild's realm key.
function addPulls(s, raid, pulls) {
  const sqlite = s.w.db.sqlite;
  const code = `CODE${String(++serial).padStart(12, '0')}`;
  sqlite.prepare("INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES (?, ?, ?, 'www', 1, 1)").run(raid.id, s.gid, code);
  pulls.forEach((pull, i) => {
    const info = sqlite.prepare('INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(raid.id, code, i + 1, pull.encounter, `Boss ${pull.encounter}`, pull.kill ? 1 : 0, raid.startsAt + i * 1000, raid.startsAt + i * 1000 + 500);
    for (const name of pull.present) {
      sqlite.prepare('INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(info.lastInsertRowid, raid.id, s.gid, name, name.toLowerCase(), 'Nightslayer', 'nightslayer');
    }
  });
}

function addLoot(s, raid, name, { tag = 'MS', itemId = 28000, at = null } = {}) {
  s.w.db.sqlite.prepare(
    `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, winner_class, tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nightslayer', 'MAGE', ?, 1, 1)`,
  ).run(idOf('lo', ++serial), s.gid, raid.id, s.alpha, `chk-${serial}-${name}`, itemId, `Item ${itemId}`, at === null ? raid.startsAt + 1000 : at, name, name.toLowerCase(), tag);
}

check('the owner reads the page: facts, team, core rank, no request, siblings, empty loot and raids, the three flags', async () => {
  const s = await world();
  const main = await page(s, 'm1', s.m1.cid);
  assert.equal(main.guild.id, s.gid);
  assert.equal(main.guild.gameVersion, 'tbc');
  assert.equal(main.guild.rankSource, null);
  assert.deepEqual({ ...main.character, id: undefined, addedOn: typeof main.character.addedOn }, {
    id: undefined, name: 'Mainone', realm: 'Nightslayer', class: 'DRUID', mainSpec: 'Restoration', offSpec: 'Feral (Tank)', isMain: true, level: null, inGameRank: null,
    coreRank: 'raider', coreRankLabel: 'Raider', addedOn: 'string',
  });
  assert.match(main.character.addedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(main.team, { id: s.alpha, name: 'Alpha' });
  assert.equal(main.request, null);
  assert.deepEqual(main.siblings.map((one) => [one.name, one.isMain, one.team.id]), [['Altone', false, null]]);
  assert.deepEqual(main.loot, { awards: [], totals: { MS: 0, OS: 0, DE: 0, BANK: 0 } });
  assert.deepEqual(main.raids, []);
  assert.deepEqual(main.can, { remove: false, requestTeam: false, editSpecs: true }, 'a Main: no Remove; it is on a team: nothing to request');
  const alt = await page(s, 'm1', s.altId);
  assert.equal(alt.team, null);
  assert.equal(alt.character.isMain, false);
  assert.deepEqual(alt.siblings.map((one) => one.name), ['Mainone']);
  assert.deepEqual(alt.can, { remove: true, requestTeam: true, editSpecs: true }, 'a teamless Alt in a guild with two free teams');
});

check('only the owner: another member, an officer, a stranger, an unknown id and a malformed id all get 404; signed out gets 401', async () => {
  const s = await world();
  for (const who of ['m2', 'o1', 'gm', 'x1']) {
    const res = await get(s, who, s.m1.cid);
    assert.equal(res.status, 404, `${who}: ${res.text}`);
    assert.equal(res.json.error, 'not_found');
  }
  assert.equal((await get(s, 'm1', idOf('c', 999))).status, 404);
  assert.equal((await get(s, 'm1', 'not-an-id')).status, 404);
  assert.equal((await s.w.call(null, 'GET', `/api/me/characters/${s.m1.cid}`)).status, 401);
  assert.equal((await s.call('m1', 'PATCH', `/api/me/characters/${s.other}`, { mainSpec: 'Fire' })).status, 404, 'a write on somebody else\'s character');
  assert.equal((await s.call('m1', 'DELETE', `/api/me/characters/${s.other}`, {})).status, 404);
  assert.equal(await s.one('SELECT COUNT(*) AS n FROM characters WHERE id = ?', s.other).then((r) => r.n), 1);
});

check('a retired placeholder is 404 even for its person; a Discord-only link is not ownership', async () => {
  const s = await world();
  s.exec(`UPDATE characters SET name_key = '~ph:' || id WHERE id = '${s.altId}'`);
  assert.equal((await get(s, 'm1', s.altId)).status, 404);
  const t = await world();
  // the person carries the Discord ID of m2 but players.user_id is NULL: not owned
  const m3 = await t.person({ name: 'Mainthree' });
  t.exec(`UPDATE players SET discord_user_id = (SELECT discord_id FROM users WHERE id = '${t.uids.m2}'), user_id = NULL WHERE id = '${m3.pid}'`);
  assert.equal((await get(t, 'm2', m3.cid)).status, 404);
});

check('loot: only the awards this character won, newest first, with the totals per tag; the loot policy never hides your own', async () => {
  const s = await world();
  const r1 = addRaid(s, { raidOn: '2026-10-01', teamId: s.alpha });
  const r2 = addRaid(s, { raidOn: '2026-10-08', teamId: s.alpha, zone: 'Gruul\'s Lair' });
  addLoot(s, r1, 'Mainone', { tag: 'MS', itemId: 28001 });
  addLoot(s, r2, 'Mainone', { tag: 'OS', itemId: 28002 });
  addLoot(s, r2, 'Altone', { tag: 'MS', itemId: 28003 });
  addLoot(s, r2, 'Maintwo', { tag: 'MS', itemId: 28004 });
  const main = await page(s, 'm1', s.m1.cid);
  assert.deepEqual(main.loot.awards.map((award) => award.itemId), [28002, 28001]);
  assert.deepEqual(main.loot.totals, { MS: 1, OS: 1, DE: 0, BANK: 0 });
  const first = main.loot.awards[0];
  assert.equal(first.match.kind, 'character');
  assert.equal(first.match.characterId, s.m1.cid);
  assert.equal(first.raidId, r2.id);
  assert.equal(first.raidOn, '2026-10-08');
  const alt = await page(s, 'm1', s.altId);
  assert.deepEqual(alt.loot.awards.map((award) => award.itemId), [28003]);
  // loot hidden from members by policy (visibility 'own' is the least; set ownTeams without a grant): your own character's loot still shows
  s.exec(`INSERT INTO loot_policies (id, guild_id, team_id, policy, version, updated_at) VALUES ('${idOf('lp', 1)}', '${s.gid}', NULL, '{"visibility":{"members":"ownTeams"}}', 1, 1)`);
  assert.equal((await page(s, 'm1', s.m1.cid)).loot.awards.length, 2);
});

check('raids: logged presence and typed names, bosses killed with it present out of the kills that night, none for a manual raid, newest first, team and zone named', async () => {
  const s = await world();
  const full = addRaid(s, { raidOn: '2026-10-01', teamId: s.alpha, zone: 'Karazhan' });
  addPulls(s, full, [
    { encounter: 1, kill: false, present: ['Mainone', 'Maintwo'] },
    { encounter: 1, kill: true, present: ['Mainone', 'Maintwo'] },
    { encounter: 2, kill: true, present: ['Maintwo'] },
    { encounter: 3, kill: true, present: ['Mainone', 'Maintwo'] },
    { encounter: 4, kill: false, present: ['Mainone'] },
  ]);
  const wipes = addRaid(s, { raidOn: '2026-10-08', teamId: s.alpha, zone: 'Gruul\'s Lair', title: 'Team Alpha Thursday' });
  addPulls(s, wipes, [{ encounter: 9, kill: false, present: ['Mainone'] }]);
  const manual = addRaid(s, { raidOn: '2026-10-15', teamId: s.bravo, zone: 'Magtheridon\'s Lair', mode: 'manual' });
  s.exec(`INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key) VALUES ('${manual.id}', '${s.gid}', 'Mainone', 'mainone', 'Nightslayer', 'nightslayer')`);
  const notHere = addRaid(s, { raidOn: '2026-10-22', teamId: s.alpha });
  addPulls(s, notHere, [{ encounter: 1, kill: true, present: ['Maintwo'] }]);
  const res = await page(s, 'm1', s.m1.cid);
  assert.deepEqual(res.raids.map((raid) => [raid.raidOn, raid.zone, raid.team.name, raid.bosses]), [
    ['2026-10-15', 'Magtheridon\'s Lair', 'Bravo', null],
    ['2026-10-08', 'Gruul\'s Lair', 'Alpha', { killed: 0, kills: 0 }],
    ['2026-10-01', 'Karazhan', 'Alpha', { killed: 2, kills: 3 }],
  ]);
  assert.equal(res.raids[1].title, 'Team Alpha Thursday');
  assert.equal(res.raids[0].raidId, manual.id);
  assert.deepEqual((await page(s, 'm1', s.altId)).raids, [], 'the Alt was in none of them');
});

check('raids follow a rename: evidence dated before the rename resolves to the character through its alias, a new carrier of the old name does not inherit it', async () => {
  const s = await world();
  const before = addRaid(s, { raidOn: '2026-10-01', teamId: s.alpha });
  addPulls(s, before, [{ encounter: 1, kill: true, present: ['Oldname'] }]);
  const after = addRaid(s, { raidOn: '2026-10-08', teamId: s.alpha });
  addPulls(s, after, [{ encounter: 1, kill: true, present: ['Oldname'] }]);
  // Altone was called Oldname until between the two raids; afterwards somebody else (Othertwo, renamed here) carries the name
  s.exec(`UPDATE characters SET name = 'Oldname', name_key = 'oldname' WHERE id = '${s.other}'`);
  s.exec(`INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('${idOf('na', 1)}', '${s.gid}', '${s.altId}', 'oldname', 'nightslayer', ${Date.parse('2026-10-04T00:00:00Z')})`);
  const alt = await page(s, 'm1', s.altId);
  assert.deepEqual(alt.raids.map((raid) => raid.raidOn), ['2026-10-01']);
  const other = await page(s, 'm2', s.other);
  assert.deepEqual(other.raids.map((raid) => raid.raidOn), ['2026-10-08']);
});

check('team request: a waiting request shows with its team, closes Request team, and is gone once decided; a person on every team has nothing to ask for', async () => {
  const s = await world();
  const asked = await s.ok('m1', 'POST', '/team-requests', { characterId: s.altId, teamId: s.bravo }, 201);
  const waiting = await page(s, 'm1', s.altId);
  assert.equal(waiting.request.id, asked.request.id);
  assert.deepEqual(waiting.request.team, { id: s.bravo, name: 'Bravo' });
  assert.equal(typeof waiting.request.createdAt, 'number');
  assert.equal(waiting.can.requestTeam, false);
  await s.ok('m1', 'DELETE', `/team-requests/${asked.request.id}`, {}, 200);
  const again = await page(s, 'm1', s.altId);
  assert.equal(again.request, null);
  assert.equal(again.can.requestTeam, true);
  // Mainone is on Alpha; give the person Bravo through the Alt: no team left to ask for
  s.setTeam(s.altId, s.bravo);
  const third = await s.alt(s.m1.pid, 'Altthree');
  const none = await page(s, 'm1', third);
  assert.equal(none.can.requestTeam, false, 'a character with no team but every team already held');
  // an archived team is not on offer either: the Main holds Alpha, Bravo is archived, nothing is left to ask for
  const t = await world();
  assert.equal((await page(t, 'm1', t.altId)).can.requestTeam, true);
  t.exec(`UPDATE teams SET archived = 1 WHERE id = '${t.bravo}'`);
  assert.equal((await page(t, 'm1', t.altId)).can.requestTeam, false);
});

check('H-Q17: a guild whose ranks set the team (a rank map row that carries a team; reserved, no writer yet) has no Request team', async () => {
  const s = await world();
  assert.equal((await page(s, 'm1', s.altId)).can.requestTeam, true);
  s.exec(`INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id, team_id) VALUES ('${s.gid}', 'ingame', '3', 'KJ Raider', 'raider', NULL, '${s.bravo}')`);
  assert.equal((await page(s, 'm1', s.altId)).can.requestTeam, false);
});

check('level and in-game rank: the stored roster row gives both; the Battle.net snapshot is the level where there is no roster row', async () => {
  const s = await world();
  ingameize(s, { owner: 'gm', people: { m1: s.m1, m2: s.m2 } });
  makeProven(s, 'm1', { pid: s.m1.pid, cid: s.altId }, { rank: 3, proof: 'officer', link: false });
  const alt = await page(s, 'm1', s.altId);
  assert.equal(alt.character.level, 70);
  assert.equal(alt.character.inGameRank, 'Core');
  assert.equal(alt.guild.rankSource, 'ingame');
  const main = await page(s, 'm1', s.m1.cid);
  assert.equal(main.character.inGameRank, 'Social', 'the Main sits on in-game rank 5');
  s.exec(`UPDATE characters SET core_rank = 'trial' WHERE id = '${s.m1.cid}'`);
  const trial = (await page(s, 'm1', s.m1.cid)).character;
  assert.deepEqual([trial.coreRank, trial.coreRankLabel], ['trial', 'Trial'], 'the stored core rank, named');
  // no roster row: the snapshot of the account's Battle.net link
  const t = await world();
  assert.equal((await page(t, 'm1', t.altId)).character.level, null);
  t.exec(`INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES ('${t.uids.m1}', '4242', 'Tag#1', 1,
    '{"profile-us":{"fetchedAt":1,"characters":[{"name":"Altone","realm":"Nightslayer","realmSlug":"nightslayer","class":"MAGE","level":64}]}}', 1)`);
  assert.equal((await page(t, 'm1', t.altId)).character.level, 64);
});

check('PATCH: the owner changes the specs without roster.edit; the answer is the page; an audit row says who and what; bad specs are 400', async () => {
  const s = await world();
  const res = await s.ok('m1', 'PATCH', `/api/me/characters/${s.altId}`, { mainSpec: 'Arcane', offSpec: 'Frost' }, 200);
  assert.equal(res.character.mainSpec, 'Arcane');
  assert.equal(res.character.offSpec, 'Frost');
  assert.deepEqual(await s.one('SELECT main_spec, off_spec FROM characters WHERE id = ?', s.altId), { main_spec: 'Arcane', off_spec: 'Frost' });
  const audit = await s.one("SELECT actor_user_id, action, entity_id, before, after FROM audit_log WHERE entity_id = ? AND action = 'character.update' ORDER BY rowid DESC", s.altId);
  assert.equal(audit.actor_user_id, s.uids.m1);
  assert.equal(JSON.parse(audit.after).self, true);
  assert.deepEqual(JSON.parse(audit.after).changed, ['mainSpec', 'offSpec']);
  assert.equal(JSON.parse(audit.before).mainSpec, 'Fire');
  // one spec alone, and clearing the off spec
  const off = await s.ok('m1', 'PATCH', `/api/me/characters/${s.altId}`, { offSpec: null }, 200);
  assert.equal(off.character.offSpec, null);
  assert.equal(off.character.mainSpec, 'Arcane');
  // nothing changed: no new audit row
  const rows = (await s.rows("SELECT id FROM audit_log WHERE entity_id = ? AND action = 'character.update'", s.altId)).length;
  await s.ok('m1', 'PATCH', `/api/me/characters/${s.altId}`, { mainSpec: 'Arcane' }, 200);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE entity_id = ? AND action = 'character.update'", s.altId)).length, rows);
  // refusals
  assert.equal((await s.call('m1', 'PATCH', `/api/me/characters/${s.altId}`, { mainSpec: 'Restoration' })).status, 400, 'a spec of another class');
  assert.equal((await s.call('m1', 'PATCH', `/api/me/characters/${s.altId}`, { offSpec: 'Arcane' })).status, 400, 'off spec equal to the main spec');
  assert.equal((await s.call('m1', 'PATCH', `/api/me/characters/${s.altId}`, {})).status, 400, 'nothing to change');
  assert.equal((await s.call('m1', 'PATCH', `/api/me/characters/${s.altId}`, { name: 'Renamed', mainSpec: 'Fire' })).json.character.name, 'Altone', 'the name is not the owner\'s to change here');
  assert.equal((await s.call('m2', 'PATCH', `/api/me/characters/${s.altId}`, { mainSpec: 'Fire' })).status, 404);
  assert.equal((await s.call('o1', 'PATCH', `/api/me/characters/${s.altId}`, { mainSpec: 'Fire' })).status, 404, 'officers use the roster route');
});

check('PATCH works for a Battle.net-proven character too (only the name and class are the game\'s)', async () => {
  const s = await world();
  s.exec(`UPDATE characters SET owner_proof = 'bnet' WHERE id = '${s.altId}'`);
  const res = await s.ok('m1', 'PATCH', `/api/me/characters/${s.altId}`, { mainSpec: 'Frost' }, 200);
  assert.equal(res.character.mainSpec, 'Frost');
});

check('DELETE: the owner removes their own Alt in a guild that is not in-game: gone, audited, its request and team with it; a Main is refused', async () => {
  const s = await world();
  const asked = await s.ok('m1', 'POST', '/team-requests', { characterId: s.altId, teamId: s.bravo }, 201);
  const res = await s.ok('m1', 'DELETE', `/api/me/characters/${s.altId}`, {}, 200);
  assert.deepEqual(res, { removed: true, characterId: s.altId });
  assert.equal(await s.one('SELECT COUNT(*) AS n FROM characters WHERE id = ?', s.altId).then((r) => r.n), 0);
  assert.equal(await s.one('SELECT COUNT(*) AS n FROM team_requests WHERE id = ?', asked.request.id).then((r) => r.n), 0, 'the request went with it');
  const audit = await s.one("SELECT actor_user_id, before FROM audit_log WHERE entity_id = ? AND action = 'character.delete'", s.altId);
  assert.equal(audit.actor_user_id, s.uids.m1);
  assert.equal(JSON.parse(audit.before).self, true);
  assert.equal(JSON.parse(audit.before).personId, s.m1.pid);
  assert.equal((await get(s, 'm1', s.altId)).status, 404, 'the page is gone');
  const main = await s.call('m1', 'DELETE', `/api/me/characters/${s.m1.cid}`, {});
  assert.equal(main.status, 409);
  assert.equal(main.json.error, 'main_character');
  assert.equal(await s.one('SELECT COUNT(*) AS n FROM characters WHERE id = ?', s.m1.cid).then((r) => r.n), 1);
  // nobody else
  assert.equal((await s.call('m2', 'DELETE', `/api/me/characters/${s.other}`, {})).status, 200, 'm2 owns it');
  assert.equal((await s.call('o1', 'DELETE', `/api/me/characters/${s.m2.cid}`, {})).status, 404);
});

check('DELETE in an in-game guild: the owner removes NO character, whatever its proof (403 battlenet_only), and the page says can.remove false; elsewhere a Battle.net-proven Alt may go', async () => {
  const s = await world();
  const second = await s.alt(s.m1.pid, 'Alttwo');
  ingameize(s, { owner: 'gm', people: { m1: s.m1, m2: s.m2 } });
  s.exec(`UPDATE characters SET owner_proof = 'bnet' WHERE id = '${s.altId}'`);
  const message = 'In this guild your characters come from Battle.net, so you cannot remove them yourself.';
  for (const [cid, label] of [[s.altId, 'Battle.net-proven'], [second, 'officer-proven']]) {
    assert.equal((await page(s, 'm1', cid)).can.remove, false, label);
    const refused = await s.call('m1', 'DELETE', `/api/me/characters/${cid}`, {});
    assert.deepEqual([refused.status, refused.json.error, refused.json.message], [403, 'battlenet_only', message], label);
    assert.equal(await s.one('SELECT COUNT(*) AS n FROM characters WHERE id = ?', cid).then((r) => r.n), 1, label);
  }
  const main = await s.call('m1', 'DELETE', `/api/me/characters/${s.m1.cid}`, {});
  assert.deepEqual([main.status, main.json.error], [403, 'battlenet_only'], 'a Main too: the in-game rule is checked first');
  assert.equal(await s.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'character.delete'").then((r) => r.n), 0);
  // the guild switching to the in-game roster between the checks and the write changes nothing (the guard is inside the statement)
  const sneaky = await world();
  const real = sneaky.w.db.prepare.bind(sneaky.w.db);
  let flipped = false;
  sneaky.w.db.prepare = (sql) => {
    if (!flipped && /DELETE FROM characters/.test(sql)) {
      flipped = true;
      sneaky.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${sneaky.gid}'`);
    }
    return real(sql);
  };
  const raced = await sneaky.call('m1', 'DELETE', `/api/me/characters/${sneaky.altId}`, {});
  assert.equal(flipped, true);
  assert.deepEqual([raced.status, raced.json.error], [403, 'battlenet_only']);
  assert.equal(await sneaky.one('SELECT COUNT(*) AS n FROM characters WHERE id = ?', sneaky.altId).then((r) => r.n), 1);
  // the same bnet proof in a guild that is not in-game may go
  const t = await world();
  t.exec(`UPDATE characters SET owner_proof = 'bnet' WHERE id = '${t.altId}'`);
  assert.equal((await page(t, 'm1', t.altId)).can.remove, true);
  await t.ok('m1', 'DELETE', `/api/me/characters/${t.altId}`, {}, 200);
});

check('officers keep their paths: roster.edit still edits and removes any character; a member without it is still refused; nothing of the roster routes changed', async () => {
  const s = await world();
  const base = `/roster/${s.m1.pid}/characters`;
  await s.ok('o1', 'PATCH', `${base}/${s.altId}`, { mainSpec: 'Frost' }, 200);
  assert.equal((await s.call('m1', 'PATCH', `${base}/${s.altId}`, { mainSpec: 'Fire' })).status, 403, 'the member needs the owner route');
  assert.equal((await s.call('m1', 'DELETE', `${base}/${s.altId}`, {})).status, 403);
  await s.ok('o1', 'DELETE', `${base}/${s.altId}`, {}, 200);
  assert.equal((await get(s, 'm1', s.altId)).status, 404);
});

runChecks(checks);
