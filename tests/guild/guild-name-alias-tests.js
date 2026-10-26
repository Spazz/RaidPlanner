/**
 * Raidsmith guild tracker - the alias read helper (user-hierarchy build, lane B1a-2; worker/name-alias.js)
 * Run: node tests/guild/guild-name-alias-tests.js
 *
 * A paid rename keeps the character and changes its name: the old name_key goes to character_name_aliases with renamed_at. Evidence stored under the old name
 * (a boss-pull log line, a pasted roster, a plan seat, a loot award) must keep crediting the same character, while a NEW character that later takes the old name
 * must not inherit it:   evidence dated on or before renamed_at -> the ALIAS wins;   after it -> the LIVE name_key wins.
 * ONE helper (resolvedNameKeySql) is read by every name join: attendance recompute and stale marking, the raid page and the review queue, the loot matcher, the
 * person loot list, the trial card and the pasted roster. With no alias rows every result is exactly what it was.
 */
const assert = require('node:assert/strict');
const { createD1Fake } = require('../d1-fake');
const { load, adminOf, memberOf, makeWorld, signIn } = require('../guild-world');

const SERVER = '900000000000000092';
const GM = { id: '110000000000009201', username: 'gmalias', globalName: 'Gmalias' };
const NOW = 1_800_000_000_000; // 2027-01-15T08:00Z
const DAY = 86_400_000;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// The rule, in SQL

function aliasDb() {
  const db = createD1Fake();
  db.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                  VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1)`);
  db.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1)");
  for (const id of ['p1', 'p2']) db.sqlite.exec(`INSERT INTO players (id, guild_id, status, created_at, updated_at) VALUES ('${id}', 'g1', 'raider', 1, 1)`);
  return db;
}
const addCharacter = (db, id, player, name, realm = '') => db.sqlite.exec(
  `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm_key, class, is_main, created_at, updated_at)
   VALUES ('${id}', 'g1', '${player}', 't1', '${name}', '${name.toLowerCase()}', '${realm}', 'MAGE', 1, 1, 1)`,
);
const addAlias = (db, id, character, nameKey, renamedAt, realm = '') => db.sqlite.exec(
  `INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('${id}', 'g1', '${character}', '${nameKey}', '${realm}', ${renamedAt})`,
);
// The expression over a table of (name_key, realm_key, at) probes.
async function resolve(db, probes, { realm = true } = {}) {
  const { resolvedNameKeySql } = await load('worker/name-alias.js');
  const expr = resolvedNameKeySql({ guild: "'g1'", nameKey: 'probe.value', realmKey: realm ? 'probe.realm' : null, at: 'probe.at' });
  const rows = await db.prepare(
    `SELECT probe.i AS i, ${expr} AS resolved
       FROM (SELECT json_extract(value, '$.i') AS i, json_extract(value, '$.value') AS value, json_extract(value, '$.realm') AS realm, json_extract(value, '$.at') AS at FROM json_each(?)) probe
      ORDER BY probe.i`,
  ).bind(JSON.stringify(probes.map((probe, i) => ({ i, realm: '', ...probe })))).all();
  return rows.results.map((row) => row.resolved);
}

check('with no alias rows the expression is the stored name_key, whatever the date or realm: results identical to before aliases', async () => {
  const db = aliasDb();
  addCharacter(db, 'c1', 'p1', 'Bar');
  const probes = [{ value: 'foo', at: 1 }, { value: 'bar', at: 1e15 }, { value: 'zed', at: 0 }, { value: 'foo', realm: 'x', at: 5 }];
  assert.deepEqual(await resolve(db, probes), ['foo', 'bar', 'zed', 'foo']);
  assert.deepEqual(await resolve(db, probes, { realm: false }), ['foo', 'bar', 'zed', 'foo']);
});

check('on or before renamed_at the alias wins (the aliased character\'s live key); after it the stored key stays', async () => {
  const db = aliasDb();
  addCharacter(db, 'c1', 'p1', 'Bar');
  addAlias(db, 'a1', 'c1', 'foo', 1000);
  const at = (value) => ({ value: 'foo', at: value });
  assert.deepEqual(await resolve(db, [at(0), at(999), at(1000), at(1001), at(2000)]), ['bar', 'bar', 'bar', 'foo', 'foo'], 'the day of the rename is still the old name');
  assert.deepEqual(await resolve(db, [{ value: 'bar', at: 500 }, { value: 'other', at: 500 }]), ['bar', 'other'], 'other names are untouched');
});

check('the realm is part of the alias: another realm\'s Foo is not Bar; a probe with no realm (a plan seat) matches the name alone', async () => {
  const db = aliasDb();
  addCharacter(db, 'c1', 'p1', 'Bar', 'nightslayer');
  addAlias(db, 'a1', 'c1', 'foo', 1000, 'nightslayer');
  assert.deepEqual(await resolve(db, [{ value: 'foo', realm: 'nightslayer', at: 10 }, { value: 'foo', realm: 'otherrealm', at: 10 }]), ['bar', 'foo']);
  assert.deepEqual(await resolve(db, [{ value: 'foo', realm: 'otherrealm', at: 10 }], { realm: false }), ['bar']);
});

check('two characters carried the name at different times: the earliest alias at or after the evidence is the one that carried it then', async () => {
  const db = aliasDb();
  addCharacter(db, 'c1', 'p1', 'Bar');
  addCharacter(db, 'c2', 'p2', 'Baz');
  addAlias(db, 'a1', 'c1', 'foo', 1000);   // c1 was Foo until 1000
  addAlias(db, 'a2', 'c2', 'foo', 3000);   // c2 was Foo from some time after 1000 until 3000
  assert.deepEqual(await resolve(db, [{ value: 'foo', at: 900 }, { value: 'foo', at: 1000 }, { value: 'foo', at: 1500 }, { value: 'foo', at: 3000 }, { value: 'foo', at: 3001 }]),
    ['bar', 'bar', 'baz', 'baz', 'foo']);
});

check('an alias row whose character is gone resolves nothing (the foreign key cascades the row with the character)', async () => {
  const db = aliasDb();
  addCharacter(db, 'c1', 'p1', 'Bar');
  addAlias(db, 'a1', 'c1', 'foo', 1000);
  db.sqlite.exec("DELETE FROM characters WHERE id = 'c1'");
  assert.equal((db.sqlite.prepare('SELECT COUNT(*) AS n FROM character_name_aliases').get()).n, 0);
  assert.deepEqual(await resolve(db, [{ value: 'foo', at: 10 }]), ['foo']);
});

// ---------------------------------------------------------------------------
// The joins, over HTTP

// A guild with a team and the story: Foo (Aldric's character) is renamed Bar at RENAMED; a new, different Foo joins afterwards.
const RENAMED = NOW + 5 * DAY;
async function story() {
  const w = await makeWorld({});
  w.clock.now = NOW;
  const gm = (await signIn(w, GM, [adminOf(SERVER)])).jar;
  const made = await w.call(gm, 'POST', '/api/guild', { serverId: SERVER, name: 'Alias Story', gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: false });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const team = made.json.teams[0].id;
  const s = {
    w, gid, team, base: `/api/guild/${gid}`,
    async call(method, tail, body) { w.advance(2000); return w.call(gm, method, `${s.base}${tail}`, body); },
    async ok(method, tail, body, status) {
      const res = await s.call(method, tail, body);
      assert.equal(res.status, status || (method === 'POST' ? 201 : 200), `${method} ${tail}: ${res.text}`);
      return res.json;
    },
    exec: (sql, ...values) => w.db.prepare(sql).bind(...values).run(),
    rows: (sql, ...values) => w.rows(sql, ...values),
    async person(name) {
      const res = await s.ok('POST', '/roster', { teamId: team, name, class: 'MAGE', mainSpec: 'Fire', offSpec: null, status: 'raider', joinedOn: '2026-09-01' });
      return { pid: res.person.id, cid: res.characters[0].id };
    },
    async raid(raidOn) { return (await s.ok('POST', '/raids', { teamId: team, raidOn, startTime: '20:00', zone: "Gruul's Lair" })).raid.id; },
    // A two-pull log on the raid with these names present in both.
    async log(raidId, names) {
      const raid = (await s.rows('SELECT starts_at FROM raids WHERE id = ?', raidId))[0];
      const code = `${raidId.slice(2, 10)}${'0'.repeat(8)}`.slice(0, 16).replace(/[^A-Za-z0-9]/g, 'x');
      await s.exec("INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES (?, ?, ?, 'www', ?, 1)", raidId, gid, code, raid.starts_at);
      let fight = 0;
      for (const offset of [0, 600000]) {
        fight++;
        const pull = (await s.exec(
          "INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, 1, 'Boss', 0, ?, ?)",
          raidId, code, fight, raid.starts_at + offset, raid.starts_at + offset + 1000,
        )).meta.last_row_id;
        for (const name of names) {
          await s.exec("INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE')",
            pull, raidId, gid, name, name.toLowerCase());
        }
      }
    },
    async award(raidId, name, awardedAt, item) {
      await s.exec(
        `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key,
                                  winner_class, tag, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 4, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', 'MS', 1, 1)`,
        `la_${item}`, gid, raidId, team, `checksum-${item}-aaaaaaaa`, 3000 + item, `Item ${item}`, awardedAt, name, name.toLowerCase(),
      );
    },
    attendance: async (raidId) => Object.fromEntries((await s.rows('SELECT player_id, outcome, attended FROM attendance WHERE raid_id = ?', raidId)).map((row) => [row.player_id, [row.outcome, row.attended]])),
  };
  // Aldric's character is Foo; it is renamed Bar on RENAMED. Before that, the OLD raid and its loot name Foo.
  const aldric = await s.person('Foo');
  const oldRaid = await s.raid('2027-01-14');
  await s.log(oldRaid, ['Foo']);
  await s.award(oldRaid, 'Foo', NOW - DAY, 1);
  await s.exec("UPDATE characters SET name = 'Bar', name_key = 'bar' WHERE id = ?", aldric.cid);
  await s.exec("INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at) VALUES ('alias1', ?, ?, 'foo', 'nightslayer', ?)", gid, aldric.cid, RENAMED);
  // Later: another player makes a new character called Foo; a later raid (after the rename) names Foo.
  w.clock.now = RENAMED + 10 * DAY;
  const newcomer = await s.person('Foo');
  const newRaid = await s.raid('2027-01-28');
  await s.log(newRaid, ['Foo']);
  await s.award(newRaid, 'Foo', RENAMED + 2 * DAY, 2);
  return { s, aldric, newcomer, oldRaid, newRaid };
}

check('attendance: an old raid keeps crediting the renamed character; a new Foo in a later raid is not credited to Bar', async () => {
  const { s, aldric, newcomer, oldRaid, newRaid } = await story();
  await s.ok('POST', `/raids/${oldRaid}/recompute`, {}, 200);
  await s.ok('POST', `/raids/${newRaid}/recompute`, {}, 200);
  const old = await s.attendance(oldRaid);
  assert.deepEqual(old[aldric.pid], ['present', 1], 'the old raid\'s Foo is Aldric\'s (now Bar)');
  assert.notEqual(old[newcomer.pid] && old[newcomer.pid][0], 'present', 'the new Foo was not in the old raid');
  const later = await s.attendance(newRaid);
  assert.deepEqual(later[newcomer.pid], ['present', 1], 'the later raid\'s Foo is the new Foo');
  assert.notEqual(later[aldric.pid] && later[aldric.pid][0], 'present', 'and not Bar');
  // The raid pages say the same, and neither has an unmatched name.
  const oldPage = await s.ok('GET', `/raids/${oldRaid}`);
  assert.deepEqual([oldPage.people.filter((p) => p.outcome === 'present').map((p) => p.name), oldPage.unmatched], [['Bar'], []]);
  const newPage = await s.ok('GET', `/raids/${newRaid}`);
  assert.deepEqual([newPage.people.filter((p) => p.outcome === 'present').map((p) => p.name), newPage.unmatched], [['Foo'], []]);
});

check('attendance: a name with no character and no alias is still unmatched (an alias for another name changes nothing)', async () => {
  const { s, oldRaid } = await story();
  await s.exec("INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) SELECT pull_id, raid_id, guild_id, 'Ghost', 'ghost', 'Nightslayer', 'nightslayer', 'MAGE' FROM raid_presence WHERE raid_id = ? AND name_key = 'foo'", oldRaid);
  await s.ok('POST', `/raids/${oldRaid}/recompute`, {}, 200);
  const page = await s.ok('GET', `/raids/${oldRaid}`);
  assert.deepEqual(page.unmatched.map((u) => u.name), ['Ghost']);
  assert.deepEqual(page.people.filter((p) => p.outcome === 'present').map((p) => p.name), ['Bar']);
});

check('stale marking: a rename marks the raids logged under the old name and under the new one; the person\'s raids too', async () => {
  const { s, aldric, oldRaid, newRaid } = await story();
  const { markRaidsStale, markPersonRaidsStale } = await load('worker/attendance-store.js');
  await s.ok('POST', `/raids/${oldRaid}/recompute`, {}, 200);
  await s.ok('POST', `/raids/${newRaid}/recompute`, {}, 200);
  const fps = async () => Object.fromEntries((await s.rows('SELECT id, policy_fp FROM raids')).map((row) => [row.id, row.policy_fp !== '']));
  assert.deepEqual(await fps(), { [oldRaid]: true, [newRaid]: true }, 'both fresh');
  // The characters of the person carry the new key: a caller that passes only 'bar' still reaches the old raid, logged as 'foo'.
  await s.w.db.batch([markRaidsStale(s.w.db, s.gid, ['bar'])]);
  assert.deepEqual(await fps(), { [oldRaid]: false, [newRaid]: true }, 'the old raid resolves to Bar; the later Foo is another character');
  await s.ok('POST', `/raids/${oldRaid}/recompute`, {}, 200);
  await s.w.db.batch([markPersonRaidsStale(s.w.db, s.gid, aldric.pid)]);
  assert.equal((await fps())[oldRaid], false, 'the person\'s raids include the old one, logged as Foo');
  await s.ok('POST', `/raids/${oldRaid}/recompute`, {}, 200);
  await s.w.db.batch([markRaidsStale(s.w.db, s.gid, ['foo'])]);
  assert.deepEqual(await fps(), { [oldRaid]: false, [newRaid]: false }, 'the stored key still matches as before: the caller\'s old key marks both logs');
});

check('stale marking never scans the whole log: raid_presence is read through its name index (EXPLAIN QUERY PLAN), with aliases or without', async () => {
  const { s, aldric } = await story();
  const { markRaidsStale, markPersonRaidsStale } = await load('worker/attendance-store.js');
  for (const statement of [markRaidsStale(s.w.db, s.gid, ['bar'], null, [s.team]), markPersonRaidsStale(s.w.db, s.gid, aldric.pid)]) {
    const plan = (await s.w.db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.values).all()).results.map((row) => row.detail);
    assert(plan.some((line) => /SEARCH rp USING INDEX raid_presence_name/.test(line)), plan.join('\n'));
    assert(!plan.some((line) => /SCAN (rp|raid_presence)\b/.test(line)), `no scan of raid_presence:\n${plan.join('\n')}`);
  }
});

check('loot: old awards still resolve to the renamed character, a later award to the new Foo; the person lists and the matcher agree', async () => {
  const { s, aldric, newcomer, oldRaid, newRaid } = await story();
  const aldricLoot = await s.ok('GET', `/loot/person/${aldric.pid}`);
  const newcomerLoot = await s.ok('GET', `/loot/person/${newcomer.pid}`);
  const itemsOf = (loot) => (loot.awards || loot.items || []).map((a) => a.itemName).sort();
  assert.deepEqual(itemsOf(aldricLoot), ['Item 1'], 'Bar\'s loot: the old award to Foo');
  assert.deepEqual(itemsOf(newcomerLoot), ['Item 2'], 'the new Foo\'s loot: the later award only');
  // The per-raid list's match.
  const old = await s.ok('GET', `/raids/${oldRaid}/loot`);
  assert.deepEqual(old.awards.map((a) => [a.winner.name, a.match.kind, a.match.personId, a.match.characterName]), [['Foo', 'character', aldric.pid, 'Bar']]);
  const later = await s.ok('GET', `/raids/${newRaid}/loot`);
  assert.deepEqual(later.awards.map((a) => [a.winner.name, a.match.kind, a.match.personId]), [['Foo', 'character', newcomer.pid]]);
  // Team views: By raid and the fix list find nobody unknown.
  const fix = await s.ok('GET', `/loot/fix?team=${s.team}`);
  assert.deepEqual(fix.unknown, []);
});

check('loot: an award dated before the rename resolves to the renamed character; without the alias (and no live Foo) it would be unmatched', async () => {
  const { s, aldric, newcomer, oldRaid } = await story();
  const before = await s.ok('GET', `/raids/${oldRaid}/loot`);
  assert.equal(before.awards[0].match.personId, aldric.pid);
  await s.exec('DELETE FROM character_name_aliases');
  await s.exec('DELETE FROM characters WHERE id = ?', newcomer.cid);
  const without = await s.ok('GET', `/raids/${oldRaid}/loot`);
  assert.equal(without.awards[0].match.kind, 'unmatched', 'the same award with the alias gone: nobody carries Foo then');
});

check('a Gargul import preview matches each winner by the name the characters carried on the day of the award', async () => {
  const { s, aldric, newcomer, oldRaid, newRaid } = await story();
  const gargul = (n, name, awardedAt) => ({
    checksum: `GARG${String(n).padStart(12, '0')}`, itemId: 40000 + n, itemName: `Import ${n}`, quality: 4, awardedAt, winnerName: name, winnerRealm: 'Nightslayer',
    winnerClass: 'MAGE', rollType: 'MS', flags: [], awardedBy: 'Gm-Nightslayer',
  });
  // Both raids have started; an import goes onto a started raid. Awards for Foo before the rename, Foo after it, and Bar (any date), and a disenchant.
  const preview = await s.ok('POST', `/raids/${oldRaid}/loot/preview`, {
    awards: [gargul(1, 'Foo', NOW - DAY), gargul(2, 'Foo', RENAMED + DAY), gargul(3, 'Bar', RENAMED + DAY), gargul(4, 'Zorgax', NOW),
      { ...gargul(5, null, NOW), winnerName: null, winnerRealm: null, winnerClass: null, disenchanted: true, rollType: null }],
  }, 200);
  const who = preview.rows.map((row) => [row.itemName, row.match.kind, row.match.personId || null]);
  assert.deepEqual(who, [
    ['Import 1', 'character', aldric.pid],
    ['Import 2', 'character', newcomer.pid],
    ['Import 3', 'character', aldric.pid],
    ['Import 4', 'unmatched', null],
    ['Import 5', 'disenchanted', null],
  ]);
  void newRaid;
});

check('the pasted roster is matched by the name a character carried on the raid\'s day', async () => {
  const { s, aldric, newcomer, oldRaid, newRaid } = await story();
  // Both raids have logs; paste needs a raid without one.
  await s.exec('DELETE FROM raid_reports WHERE raid_id IN (?, ?)', oldRaid, newRaid);
  const old = await s.ok('POST', `/raids/${oldRaid}/manual/paste/preview`, { text: 'Foo' }, 200);
  assert.deepEqual(old.matched.map((m) => [m.name, m.personId]), [['Bar', aldric.pid]], 'on the old raid, Foo was Aldric\'s character (listed by the name it has now)');
  const later = await s.ok('POST', `/raids/${newRaid}/manual/paste/preview`, { text: 'Foo' }, 200);
  assert.deepEqual(later.matched.map((m) => [m.name, m.personId]), [['Foo', newcomer.pid]], 'on the later raid, Foo is the new character');
  const bar = await s.ok('POST', `/raids/${newRaid}/manual/paste/preview`, { text: 'Bar' }, 200);
  assert.deepEqual(bar.matched.map((m) => m.personId), [aldric.pid], 'the new name works on any raid');
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
