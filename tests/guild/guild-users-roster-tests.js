/**
 * Raidsmith guild app - Users list: the members of the in-game roster that no character carries (guild_roster rows with no visible character), listed as kind 'roster'
 * (user decisions U R4-Q8, H-Q26, H-Q29: Users lists everyone who interacted with the guild, the roster included; 2026-10-29 live bug report "the Users page does not show every guild member").
 * Run: node tests/guild/guild-users-roster-tests.js
 *
 *   in-game guild ... a roster-only member is a Member, with class, level, realm, the in-game rank (the guild's name for it) and the core rank of the stored map (Social when unmapped);
 *                     a roster row a character carries (by the identity key, by name and realm for a keyless one, a Former one too) is not listed; a sighting of the same name is not a second row
 *   pinned guild .... a guild whose rank source is not 'ingame' lists the same rows as Non-members tagged ingame_roster; the switch-over moves each row to Members, once
 *   list ............ search, the rank filter, the source filter, every sort both ways and paging across the merge of accounts, persons, names and roster rows; the counts
 *   page ............ a roster row opens its in-game facts; 404 for a bad key, another guild's key, a row a character carries since; nothing to block, nothing to add
 *   budget .......... the statements of a list do not grow (12), no scan of the roster, the characters or the rank map, rows returned bounded by the page, on 300 roster rows
 *   redaction ....... a roster row carries no Blizzard id
 */
const assert = require('node:assert/strict');
const { runChecks, scenario: baseScenario } = require('../guild-b3-world');
const { makeProven, flip, setMap, DEFAULT_MAP } = require('../guild-ingame');
const { NAMESPACE, REALM_ID } = require('../guild-seat');
const { scansSince, statementsSince, GUARDED_TABLES } = require('../guild-plans');
const { exec, rowsOf, addRaid, addLoot, addPresence, addSignup, addApplication, leave } = require('../guild-evidence');

// The routes allow 30 requests a minute per user and the fixtures ask far more within a few simulated seconds: a request to the users routes starts with an empty window.
function unlimited(s) {
  const call = s.call.bind(s);
  s.call = (who, method, tail, body) => {
    if (/\/users(\/|\?|$)/.test(tail)) s.w.db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'users:%'");
    return call(who, method, tail, body);
  };
  return s;
}
const scenario = async (options) => unlimited(await baseScenario(options));

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const QUIET_SIGN_IN = Date.parse('2026-11-15T17:00:00Z');
const hex = (text) => Buffer.from(text, 'utf8').toString('hex');
// The key of a roster row: 'r_' + hex of the name key, '/' and the realm slug.
const keyOf = (name, slug = 'nightslayer') => `r_${hex(`${name.toLowerCase()}/${slug}`)}`;

let nextRosterId = 30000;
// A member of the in-game roster that nobody carries: the row itself (what a roster sync leaves).
function addRoster(s, { name, rank = 4, cls = 'MAGE', level = 70, slug = 'nightslayer', guildId = s.gid } = {}) {
  exec(s, `INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    guildId, NAMESPACE, REALM_ID, ++nextRosterId, name, name.toLowerCase(), slug, cls, level, rank);
  return keyOf(name, slug);
}

// The roster-only members of the fixtures: one per kind of rank. DEFAULT_MAP: 0 Guild Master, 1 Officer, 2 Raid Assistant, 3 Core, 4 Raider (all Raider core rank), 5 Social (Social); 7 has no row.
const ONLY = [
  { name: 'Rosterzero', rank: 0, cls: 'WARRIOR', level: 70 },
  { name: 'Rosteralpha', rank: 1, cls: 'MAGE', level: 70 },
  { name: 'Rosterbravo', rank: 4, cls: 'ROGUE', level: 68 },
  { name: 'Rostercharlie', rank: 5, cls: 'DRUID', level: 41 },
  { name: 'Rosterdelta', rank: 7, cls: 'PRIEST', level: 20 },
  { name: 'Rosterecho', rank: 3, cls: 'WARLOCK', level: 62, slug: 'area-52' },
  { name: 'Rosterfoxtrot', rank: 4, cls: 'HUNTER', level: 70, slug: 'dreamscythe' },
];

// The guild of the checks: an Officer, a Discord member with a person, an account-less person, an outsider with an application, a loot name and a log name. `ingame`: the rank source
// 'ingame' with a rank map (the Owner, the Officer and the member have a character on the roster); otherwise the guild is legacy (a pinned guild that has not switched over).
async function world({ ingame = false, roster = ONLY } = {}) {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officer');
  await s.member('m1', 'Memberone');
  s.gmp = await s.person({ name: 'Gmchar' });
  await s.link(s.gmp.pid, 'gm');
  s.offp = await s.person({ name: 'Offchar' });
  await s.link(s.offp.pid, 'off');
  s.mone = await s.person({ name: 'Mone' });
  await s.link(s.mone.pid, 'm1');
  s.ghost = await s.person({ name: 'Ghost' });
  await s.outsider('out1', 'Outsiderone');
  s.r1 = addRaid(s, '2026-12-01');
  addApplication(s, { name: 'Appchar', userId: s.uids.out1, at: Date.parse('2026-12-05T12:00:00Z') });
  addLoot(s, s.r1, 'Lootguy');
  addPresence(s, s.r1, 'Logguy');
  addSignup(s, s.r1, { guest: 1, nickname: 'Linkguest' });
  exec(s, 'UPDATE users SET last_seen_at = ?', QUIET_SIGN_IN);
  if (ingame) {
    makeProven(s, 'gm', s.gmp, { rank: 4 });
    makeProven(s, 'off', s.offp, { rank: 1, proof: 'officer', link: false });
    makeProven(s, 'm1', s.mone, { rank: 5, proof: 'officer', link: false });
    flip(s, { owner: 'gm' });
  }
  s.keys = Object.fromEntries(roster.map((entry) => [entry.name, addRoster(s, entry)]));
  return s;
}

const list = (s, query = '', who = 'gm') => s.ok(who, 'GET', `/users${query ? `?${query}` : ''}`);
const rosterRows = (res) => res.rows.filter((row) => row.kind === 'roster');
const names = (res) => res.rows.map((row) => row.name);
// Every row of a segment, a page of 100 at a time.
async function all(s, query, who = 'gm') {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const res = await list(s, `${query}&limit=100&offset=${offset}`, who);
    rows.push(...res.rows);
    if (!res.more) return rows;
  }
}
const SEGMENTS = ['members', 'former', 'nonmembers', 'blocked'];
// Where each name is listed: { name: [segment, ...] }.
async function placement(s, who = 'gm') {
  const out = {};
  for (const segment of SEGMENTS) for (const row of await all(s, `segment=${segment}`, who)) (out[row.name] = out[row.name] || []).push(segment);
  return out;
}

// ---------------------------------------------------------------------------
// An in-game guild

check('in-game guild: a roster-only member is a Member with class, level, realm, the in-game rank (the guild\'s name for it) and the core rank of the stored map; Social when unmapped', async () => {
  const s = await world({ ingame: true });
  const members = await list(s, 'segment=members&limit=100');
  const rows = Object.fromEntries(rosterRows(members).map((row) => [row.name, row]));
  assert.deepEqual(Object.keys(rows).sort(), ONLY.map((entry) => entry.name).sort());
  assert.deepEqual(rows.Rosteralpha, {
    key: s.keys.Rosteralpha, kind: 'roster', name: 'Rosteralpha', main: { name: 'Rosteralpha', class: 'MAGE', realm: 'Nightslayer' }, permission: null, lastSeen: null, tags: [], flags: {},
    roster: { class: 'MAGE', level: 70, realm: 'Nightslayer', ingameRank: { rank: 1, label: 'Officer' }, coreRank: 'raider' },
  });
  assert.deepEqual(rows.Rosterzero.roster.ingameRank, { rank: 0, label: 'Guild Master' });
  assert.equal(rows.Rosterzero.permission, null, 'nobody signed in: no permission');
  assert.deepEqual([rows.Rosterbravo.roster.coreRank, rows.Rostercharlie.roster.coreRank, rows.Rosterecho.roster.coreRank], ['raider', 'social', 'raider']);
  assert.deepEqual(rows.Rosterdelta.roster, { class: 'PRIEST', level: 20, realm: 'Nightslayer', ingameRank: { rank: 7, label: null }, coreRank: 'social' }, 'rank 7 has no map row: no label, Social');
  assert.equal(rows.Rosterecho.roster.realm, 'Area 52', 'a realm slug that is in no list reads in words');
  assert.equal(rows.Rosterfoxtrot.roster.realm, 'Dreamscythe', 'a listed realm keeps its name');
  assert.equal(rows.Rosterfoxtrot.main.realm, 'Dreamscythe');
  // Each of them once, in Members only; the four counts add the rows to Members.
  const where = await placement(s);
  for (const entry of ONLY) assert.deepEqual(where[entry.name], ['members'], entry.name);
  const counts = (await list(s, 'segment=members')).counts;
  assert.equal(counts.members, (await all(s, 'segment=members')).length);
  assert.equal(counts.nonmembers, (await all(s, 'segment=nonmembers')).length);
  // A character that is on the roster by its key is the person's, not a second row: the proven characters of the fixture are 'Roster<id>' rows.
  assert(!Object.keys(where).some((name) => /^Roster\d+$/.test(name)), 'no roster row for a character a person carries');
  assert.deepEqual(where.Gmb3, ['members']);
});

check('in-game guild: the stored map decides - changing a label or a core rank changes the row; an unmapped rank is Social with no label; the map of ANOTHER guild never reaches the row', async () => {
  const s = await world({ ingame: true });
  setMap(s, DEFAULT_MAP.map((entry) => (entry.rank === 4 ? { ...entry, label: 'Trial Raider', coreRank: 'trial' } : entry)).concat([{ rank: 7, label: 'Friend', coreRank: 'reserve', roleId: null }]));
  const rows = Object.fromEntries(rosterRows(await list(s, 'segment=members&limit=100')).map((row) => [row.name, row.roster]));
  assert.deepEqual([rows.Rosterbravo.ingameRank.label, rows.Rosterbravo.coreRank], ['Trial Raider', 'trial']);
  assert.deepEqual([rows.Rosterdelta.ingameRank.label, rows.Rosterdelta.coreRank], ['Friend', 'reserve']);
  assert.equal(rows.Rosterecho.coreRank, 'raider');
  const other = await world({ ingame: true, roster: [] });
  exec(other, "INSERT OR REPLACE INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id, team_id) VALUES (?, 'ingame', '7', 'Elsewhere', 'trial', NULL, NULL)", other.gid);
  const here = await list(s, 'segment=members&limit=100');
  assert.equal(rosterRows(here).find((row) => row.name === 'Rosterdelta').roster.ingameRank.label, 'Friend');
});

check('in-game guild: a roster row a character carries is not listed - by the identity key (Former too), by name and realm for a character with no key - and a different realm is a different member', async () => {
  const s = await world({ ingame: true, roster: [] });
  // 1. keyed (the fixture's proven characters) and a keyed Former character.
  const former = await s.person({ name: 'Formerkeyed' });
  const formerId = 7777;
  exec(s, 'UPDATE characters SET namespace = ?, blizzard_realm_id = ?, blizzard_char_id = ? WHERE id = ?', NAMESPACE, REALM_ID, formerId, former.cid);
  exec(s, `INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank) VALUES (?, ?, ?, ?, 'Formerkeyed', 'formerkeyed', 'nightslayer', 'MAGE', 70, 4)`, s.gid, NAMESPACE, REALM_ID, formerId);
  leave(s, former.cid);
  // 2. no key: the same name and realm resolves it; the same name on another realm does not.
  const keyless = await s.person({ name: 'Keylessone' });
  addRoster(s, { name: 'Keylessone', slug: 'nightslayer' });
  const wrong = await s.person({ name: 'Wrongrealm' });
  const wrongKey = addRoster(s, { name: 'Wrongrealm', slug: 'area-52' });
  // 3. a hidden placeholder (a re-homed character's husk) carries nothing: its roster row is a row.
  const husk = await s.person({ name: 'Huskowner' });
  exec(s, "UPDATE characters SET name_key = '~ph:husk', blizzard_char_id = NULL WHERE id = ?", husk.cid);
  const members = await all(s, 'segment=members');
  const listed = members.filter((row) => row.kind === 'roster').map((row) => row.name);
  assert.deepEqual(listed, ['Wrongrealm'], 'only the member no character carries');
  assert.equal(members.find((row) => row.kind === 'roster').key, wrongKey);
  assert(!(await all(s, 'segment=nonmembers')).some((row) => row.kind === 'roster'));
  assert.equal((await placement(s)).Keylessone.length, 1, 'the person is listed once');
  void keyless; void wrong;
  // 4. a ruleset guild keeps no realm in a key: the name alone resolves.
  exec(s, "UPDATE guilds SET realm_kind = 'ruleset' WHERE id = ?", s.gid);
  exec(s, "UPDATE characters SET realm_key = '' WHERE id = ?", wrong.cid);
  assert.deepEqual((await all(s, 'segment=members')).filter((row) => row.kind === 'roster').map((row) => row.name), []);
});

check('in-game guild: a sighting that carries a roster member\'s name key (loot, the raid log, an application, a sign-up) is that member - one row, no name row, no name page', async () => {
  const s = await world({ ingame: true });
  addLoot(s, s.r1, 'Rosterbravo');
  addPresence(s, s.r1, 'Rosteralpha');
  addApplication(s, { name: 'Rostercharlie' });
  addSignup(s, s.r1, { source: 'raid_helper', nickname: 'Rosterdelta' });
  const where = await placement(s);
  for (const name of ['Rosterbravo', 'Rosteralpha', 'Rostercharlie', 'Rosterdelta']) assert.deepEqual(where[name], ['members'], name);
  const page = await s.call('gm', 'GET', `/users/n_${hex('rosterbravo')}`);
  assert.equal(page.status, 404, 'the name has no page of its own any more');
  // A name that is NOT on the roster stays a name row.
  assert.deepEqual(where.Lootguy, ['nonmembers']);
  const lootRow = (await all(s, 'segment=nonmembers')).find((row) => row.name === 'Lootguy');
  assert.equal(lootRow.kind, 'name');
});

// ---------------------------------------------------------------------------
// A pinned guild that has not switched over

check('pinned guild: the roster rows are Non-members tagged ingame_roster, in the filter and the counts; the switch-over moves each of them to Members, still once', async () => {
  const s = await world({ ingame: false });
  const everyone = ONLY.map((entry) => entry.name);
  let where = await placement(s);
  for (const name of everyone) assert.deepEqual(where[name], ['nonmembers'], `${name} before the switch`);
  const non = await list(s, 'segment=nonmembers&limit=100');
  const rows = Object.fromEntries(rosterRows(non).map((row) => [row.name, row]));
  assert.deepEqual(rows.Rosteralpha.tags, ['ingame_roster']);
  assert.equal(rows.Rosteralpha.lastSeen, null);
  assert.deepEqual(rows.Rosteralpha.roster, { class: 'MAGE', level: 70, realm: 'Nightslayer', ingameRank: { rank: 1, label: null }, coreRank: 'social' }, 'no stored map yet: no label, Social');
  assert.equal(rosterRows(await list(s, 'segment=members&limit=100')).length, 0);
  // The filter: only the roster rows; another source filter keeps none of them.
  const only = await list(s, 'segment=nonmembers&from=ingame_roster&limit=100');
  assert.deepEqual(names(only).sort(), everyone.slice().sort());
  assert(only.rows.every((row) => row.kind === 'roster'));
  assert.deepEqual(names(await list(s, 'segment=nonmembers&from=loot&limit=100')), ['Lootguy']);
  assert.deepEqual(names(await list(s, 'segment=members&from=ingame_roster&limit=100')).filter((name) => everyone.includes(name)), [], 'the filter belongs to Non-members');
  // A stored map labels them even before the switch.
  setMap(s);
  assert.deepEqual(rosterRows(await list(s, 'segment=nonmembers&limit=100')).find((row) => row.name === 'Rosteralpha').roster.ingameRank, { rank: 1, label: 'Officer' });
  const counts = (await list(s, 'segment=nonmembers')).counts;
  assert.equal(counts.nonmembers, (await all(s, 'segment=nonmembers')).length, 'the count of Non-members holds the roster rows');
  assert(counts.nonmembers >= everyone.length);
  // The switch-over: the rank source is 'ingame' (the Owner and the Officer have a character on the roster).
  makeProven(s, 'gm', s.gmp, { rank: 4 });
  makeProven(s, 'off', s.offp, { rank: 1, proof: 'officer', link: false });
  makeProven(s, 'm1', s.mone, { rank: 5, proof: 'officer', link: false });
  flip(s, { owner: 'gm' });
  where = await placement(s);
  for (const name of everyone) assert.deepEqual(where[name], ['members'], `${name} after the switch`);
  const after = (await list(s, 'segment=members')).counts;
  assert.equal(after.nonmembers, (await all(s, 'segment=nonmembers')).length);
  assert(!(await all(s, 'segment=nonmembers')).some((row) => row.kind === 'roster'), 'none is left under Non-members');
  assert.equal(after.members, (await all(s, 'segment=members')).length);
  // The keys do not change with the switch.
  assert.deepEqual(Object.fromEntries(rosterRows(await list(s, 'segment=members&limit=100')).map((row) => [row.name, row.key])), s.keys);
  // Every roster row of the fixture, once across the four segments.
  const flat = Object.values(where).filter((segments) => segments.length !== 1);
  assert.deepEqual(flat, [], 'every row is in exactly one segment');
});

// ---------------------------------------------------------------------------
// Search, the filters, the sorts and the pages

check('list: search by prefix finds roster rows by name (case-insensitive, % and _ literal); the rank filter reads the roster row\'s core rank; Former and Blocked have none', async () => {
  const s = await world({ ingame: true });
  assert.deepEqual(names(await list(s, 'segment=members&q=ROSTERA')), ['Rosteralpha']);
  assert.deepEqual(names(await list(s, 'segment=members&q=roster&limit=100')).sort(), ONLY.map((entry) => entry.name).sort());
  assert.deepEqual(names(await list(s, 'segment=members&q=roster%25')), []);
  assert.deepEqual(names(await list(s, 'segment=members&q=roster_')), []);
  const raider = await all(s, 'segment=members&rank=raider');
  const rosterRaiders = raider.filter((row) => row.kind === 'roster').map((row) => row.name).sort();
  assert.deepEqual(rosterRaiders, ['Rosteralpha', 'Rosterbravo', 'Rosterecho', 'Rosterfoxtrot', 'Rosterzero']);
  const social = await all(s, 'segment=members&rank=social');
  assert.deepEqual(social.filter((row) => row.kind === 'roster').map((row) => row.name).sort(), ['Rostercharlie', 'Rosterdelta']);
  assert.deepEqual(names(await list(s, 'segment=members&rank=reserve&q=roster')), [], 'no roster row is Reserve');
  assert.equal((await all(s, 'segment=former')).filter((row) => row.kind === 'roster').length, 0);
  assert.equal((await all(s, 'segment=blocked')).filter((row) => row.kind === 'roster').length, 0);
  // The page of a pinned guild: the same search under Non-members.
  const legacy = await world({ ingame: false });
  assert.deepEqual(names(await list(legacy, 'segment=nonmembers&q=rosterb')), ['Rosterbravo']);
  assert.deepEqual(names(await list(legacy, 'segment=nonmembers&q=ROSTERB&from=ingame_roster')), ['Rosterbravo']);
  assert.deepEqual(names(await list(legacy, 'segment=nonmembers&q=rosterb&from=loot')), []);
});

// The order the list promises: the sort value (NULL last in both directions), then the name, the kind (account, person, name, roster), the key.
function expectedOrder(rows, sort, dir) {
  const kind = { account: 0, person: 1, name: 2, roster: 3 };
  const value = (row) => {
    if (sort === 'user') return row.name.toLowerCase();
    if (sort === 'main') return row.main ? row.main.name.toLowerCase() : null;
    if (sort === 'permission') return ['Guild Master', 'Officer', 'Team Lead'].indexOf(row.permission) >= 0 ? ['Guild Master', 'Officer', 'Team Lead'].indexOf(row.permission) : (row.permission ? 3 : 4);
    return row.lastSeen;
  };
  const sign = dir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    if (x !== null && x !== y) return (x < y ? -1 : 1) * sign;
    const [n, m] = [a.name.toLowerCase(), b.name.toLowerCase()];
    return n < m ? -1 : n > m ? 1 : (kind[a.kind] - kind[b.kind]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }).map((row) => row.key);
}

check('sort and paging: every column both ways across accounts, persons, names and roster rows; a page boundary anywhere loses no row and repeats none; roster rows have no Last seen (last in both directions)', async () => {
  for (const ingame of [true, false]) {
    const s = await world({ ingame });
    const segment = ingame ? 'members' : 'nonmembers';
    for (const sort of ['user', 'main', 'permission', 'lastSeen']) {
      for (const dir of ['asc', 'desc']) {
        const whole = await all(s, `segment=${segment}&sort=${sort}&dir=${dir}`);
        const label = `${segment}/${sort}/${dir}`;
        assert(whole.some((row) => row.kind === 'roster'), label);
        assert.equal(new Set(whole.map((row) => row.key)).size, whole.length, `${label}: a key twice`);
        assert.deepEqual(whole.map((row) => row.key), expectedOrder(whole, sort, dir), `${label}: the documented order`);
        for (const size of [3, 4, 7]) {
          const paged = [];
          for (let offset = 0; ; offset += size) {
            const page = await list(s, `segment=${segment}&sort=${sort}&dir=${dir}&offset=${offset}&limit=${size}`);
            paged.push(...page.rows.map((row) => row.key));
            assert.equal(page.more, offset + size < whole.length, `${label}: more at ${offset}`);
            if (!page.more) break;
          }
          assert.deepEqual(paged, whole.map((row) => row.key), `${label}: pages of ${size}`);
        }
        if (sort === 'lastSeen') {
          const firstRoster = whole.findIndex((row) => row.kind === 'roster');
          assert(whole.slice(firstRoster).every((row) => row.lastSeen === null), `${label}: a dateless row never sits before a dated one`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The page of one roster row

check('page of a roster row: the in-game facts (class, level, in-game rank, core rank, realm), no identity, no block; the segment and tag follow the rank source', async () => {
  const s = await world({ ingame: true });
  const page = await s.ok('gm', 'GET', `/users/${s.keys.Rosterecho}`);
  assert.deepEqual(page, {
    key: s.keys.Rosterecho, kind: 'roster', segment: 'members', name: 'Rosterecho', identity: { account: null, battlenet: false, signInMethods: [] },
    main: { name: 'Rosterecho', class: 'WARLOCK', realm: 'Area 52' }, characters: [],
    roster: { class: 'WARLOCK', level: 62, realm: 'Area 52', ingameRank: { rank: 3, label: 'Core' }, coreRank: 'raider' },
    permission: null, permissions: [], lastSeen: null, block: { blocked: false, pendingReview: false, blockedOn: null }, flags: {}, tags: [], sightings: [],
    battlenetOnly: true, ownerSeat: true,
  });
  // The list row and the page agree on every roster row.
  for (const row of rosterRows(await list(s, 'segment=members&limit=100'))) {
    const detail = await s.ok('gm', 'GET', `/users/${row.key}`);
    assert.deepEqual([detail.name, detail.main, detail.roster, detail.lastSeen, detail.tags, detail.segment], [row.name, row.main, row.roster, row.lastSeen, row.tags, 'members'], row.name);
  }
  // A pinned guild: Non-members, tagged.
  const pinned = await world({ ingame: false });
  const detail = await pinned.ok('gm', 'GET', `/users/${pinned.keys.Rosteralpha}`);
  assert.deepEqual([detail.segment, detail.tags, detail.battlenetOnly], ['nonmembers', ['ingame_roster'], false]);
});

check('page of a roster row: 404 for a malformed key, another realm, another guild\'s key, a name a roster row does not carry, and a row a character carries since', async () => {
  const s = await world({ ingame: true });
  const bad = [
    `r_${hex('rosteralpha')}`, // no realm
    `r_${hex('/nightslayer')}`, `r_${hex('rosteralpha/')}`, 'r_', 'r_zz', `r_${hex('rosteralpha/dreamscythe')}`, // the row is on another realm
    keyOf('nobody'), `r_${hex('rosteralpha/nightslayer').toUpperCase()}`,
  ];
  for (const key of bad) assert.equal((await s.call('gm', 'GET', `/users/${key}`)).status, 404, key);
  // Another guild's row is not this guild's.
  const other = await world({ ingame: true, roster: [] });
  addRoster(other, { name: 'Otherguildonly' });
  assert.equal((await s.call('gm', 'GET', `/users/${keyOf('otherguildonly')}`)).status, 404);
  assert.equal((await other.call('gm', 'GET', `/users/${keyOf('otherguildonly')}`)).status, 200);
  assert.equal((await other.call('gm', 'GET', `/users/${s.keys.Rosteralpha}`)).status, 404);
  assert(!names(await list(s, 'segment=members&limit=100')).includes('Otherguildonly'));
  // A character takes the name: the row and its page are gone (the person is listed by itself).
  await s.person({ name: 'Rosterbravo' });
  assert.equal((await s.call('gm', 'GET', `/users/${s.keys.Rosterbravo}`)).status, 404);
  assert.equal((await placement(s)).Rosterbravo.length, 1);
  assert(!rosterRows(await list(s, 'segment=members&limit=100')).some((row) => row.name === 'Rosterbravo'));
});

check('actions: a roster row has nothing to block and nothing to add - Block skips it with its own sentence, Add to a person refuses it as a name and as the person', async () => {
  const s = await world({ ingame: false });
  const blocked = await s.ok('off', 'POST', '/users/block', { keys: [s.keys.Rosteralpha], reason: 'x' }, 200);
  assert.deepEqual(blocked.done, []);
  assert.equal(blocked.skipped[0].reason, 'roster_only');
  assert(/in-game roster/.test(blocked.skipped[0].message), blocked.skipped[0].message);
  const unblocked = await s.ok('off', 'POST', '/users/unblock', { keys: [s.keys.Rosteralpha] }, 200);
  assert.equal(unblocked.skipped[0].reason, 'roster_only');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guild_blocks')[0].n, 0, 'nothing was written');
  const added = await s.ok('off', 'POST', '/users/add-to-person', { person: s.mone.pid, names: [{ key: s.keys.Rosteralpha, class: 'MAGE' }] }, 200);
  assert.equal(added.skipped[0].reason, 'not_a_name');
  const before = rowsOf(s, 'SELECT COUNT(*) AS n FROM characters')[0].n;
  await s.fail('off', 'POST', '/users/add-to-person', { person: s.keys.Rosteralpha, names: [{ key: `n_${hex('lootguy')}`, class: 'MAGE' }] }, 400, 'bad_request');
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM characters')[0].n, before);
});

check('redaction: a roster row and its page carry no Blizzard id, namespace or realm id', async () => {
  const s = await world({ ingame: true });
  const texts = [JSON.stringify(await list(s, 'segment=members&limit=100')), JSON.stringify(await s.ok('gm', 'GET', `/users/${s.keys.Rosteralpha}`))];
  const ids = rowsOf(s, 'SELECT blizzard_char_id AS id FROM guild_roster WHERE guild_id = ?', s.gid).map((row) => String(row.id));
  for (const body of texts) {
    assert(!body.includes(NAMESPACE) && !/blizzard/i.test(body), 'namespace or a Blizzard field');
    for (const id of ids) assert(!new RegExp(`[:"/_-]${id}[,"}/_-]`).test(body.replace(/"level":\d+/g, '')), `character id ${id}`);
  }
  for (const row of rosterRows(await list(s, 'segment=members&limit=100'))) assert(/^r_(?:[0-9a-f]{2})+$/.test(row.key), row.key);
});

// ---------------------------------------------------------------------------
// Budgets

const EVIDENCE_TABLES = [
  ...GUARDED_TABLES, 'users', 'raid_signups', 'loot_awards', 'attendance', 'raid_presence', 'raid_pulls', 'applications', 'raids', 'user_servers', 'guild_blocks', 'person_blocks',
  'raid_manual_names', 'attendance_guests', 'character_name_aliases', 'bnet_links', 'source_rank_maps', 'teams',
];

check('budget: 300 roster rows - a list costs at most 12 statements in every segment and sort, no scan of the roster, the characters or the rank map, and the rows returned grow with the page, not the roster', async () => {
  for (const ingame of [true, false]) {
    const small = await world({ ingame });
    const big = await world({ ingame });
    for (let i = 0; i < 300; i++) addRoster(big, { name: `Bulk${String(i).padStart(3, '0')}x`, rank: i % 6 });
    const db = big.w.db;
    const rowsRead = (from) => db.statementLog.slice(from).reduce((sum, entry) => sum + entry.rowsRead, 0);
    const segment = ingame ? 'members' : 'nonmembers';
    let statements = 0;
    for (const target of [segment, 'former', 'blocked']) {
      for (const sort of ['user', 'main', 'permission', 'lastSeen']) {
        const from = db.statementLog.length;
        const res = await big.ok('gm', 'GET', `/users?segment=${target}&sort=${sort}&dir=desc&offset=20&limit=50`);
        statements = Math.max(statements, statementsSince(db, from));
        assert.deepEqual(scansSince(db, from, { tables: EVIDENCE_TABLES }).map((entry) => `${entry.table}: ${entry.detail}`), [], `${target}/${sort}`);
        if (target === segment) assert.equal(res.rows.length, 50, `${target}/${sort}`);
      }
    }
    assert(statements <= 12, `${statements} statements`);
    const first = async (world) => { const from = world.w.db.statementLog.length; await world.ok('gm', 'GET', `/users?segment=${segment}&limit=20`); return world.w.db.statementLog.slice(from).reduce((sum, entry) => sum + entry.rowsRead, 0); };
    const [few, many] = [await first(small), await first(big)];
    assert(Math.abs(many - few) <= 40, `${few} rows returned on ${ONLY.length} roster rows, ${many} on ${300 + ONLY.length}`);
    // The page of one roster row: one statement more than the guild context, no scan.
    const key = keyOf('bulk007x');
    const from = db.statementLog.length;
    await big.ok('gm', 'GET', `/users/${key}`);
    assert(statementsSince(db, from) <= 15, `${statementsSince(db, from)} statements for a page`);
    assert.deepEqual(scansSince(db, from, { tables: EVIDENCE_TABLES }).map((entry) => `${entry.table}: ${entry.detail}`), []);
    void rowsRead;
    console.log(`      measured (${ingame ? 'in-game' : 'pinned'} guild): a list costs ${statements} statements at most; ${few} rows returned on ${ONLY.length} roster rows, ${many} on ${300 + ONLY.length}; a roster page ${statementsSince(db, from)} statements`);
  }
});

runChecks(checks);
