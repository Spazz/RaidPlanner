/**
 * Raidsmith guild tracker - the identity split (user decision 2026-10-26)
 * Run: node tests/guild/guild-identity-split-tests.js
 *
 * "My person" (ownership of a roster person) comes ONLY from players.user_id. A person's Discord ID (players.discord_user_id) and names are bookkeeping: sign-ups, logs and
 * loot keep following them and staff keep recording them (within team scope and the Seniority guard), but they never make an account the owner of a person.
 *   1. worker/membership.js ownPlayerSql / isOwnPlayer / ownPersonStatement are user_id only, and every "mine" route follows.
 *   2. players.user_id is written by exactly three paths: Battle.net proof (bnet-match.js), the account holder's own accepted application (routes/applications.js) and an
 *      officer-approved "This is me" claim (claim-apply.js). A CI grep of worker/ pins it. The staff writers (Link account, the Discord field, linking a sign-up, imports,
 *      attendance) record a Discord ID only. Link account: an account with a Discord ID -> recorded; one without -> 409 no_discord_id.
 *   3. Migration 0039 backfills players.user_id for the people a Discord ID owned, without changing anybody's membership (proved against a JS oracle).
 *   4. roster PATCH of a person's status, trial dates or left date runs the Seniority guard, before and inside the writes.
 *   5. The Link account list gives accounts that show the same name a short suffix.
 * The guild is built through the API (tests/guild-b3-world.js); the migration runs on the node:sqlite D1 stand-in.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scenario, runChecks, load } = require('../guild-b3-world');
const { createD1Fake } = require('../d1-fake');
const { ownPerson } = require('../guild-owner-fixture');

const ROOT = path.join(__dirname, '..', '..');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// 1. The ownership helpers and the routes that use them

check('ownPlayerSql / isOwnPlayer / ownPersonStatement / personStanding: players.user_id and nothing else', async () => {
  const { ownPlayerSql, isOwnPlayer, ownPersonStatement, personStanding } = await load('worker/membership.js');
  assert.equal(ownPlayerSql('p', 'u.id'), '(p.user_id = u.id)');
  assert(!/discord/i.test(ownPlayerSql('players', '?')), 'the fragment names no Discord column');
  assert.equal((ownPlayerSql('players', '?').match(/\?/g) || []).length, 1, 'the account is used once: callers bind it once');
  const viewer = { userId: 'u_me', discordId: '123' };
  assert.equal(isOwnPlayer({ user_id: 'u_me', discord_user_id: null }, viewer), true);
  assert.equal(isOwnPlayer({ user_id: null, discord_user_id: '123' }, viewer), false, 'the Discord ID of the viewer on the person does not make it theirs');
  assert.equal(isOwnPlayer({ user_id: 'u_other', discord_user_id: '123' }, viewer), false);
  assert.equal(isOwnPlayer({ user_id: null, discord_user_id: null }, viewer), false);
  assert.equal(isOwnPlayer({ user_id: 'u_me' }, { userId: null, discordId: null }), false);
  assert.equal(isOwnPlayer(null, viewer), false);
  // The claim-time view of a person for an account that wants to claim one of its characters.
  assert.equal(personStanding({ user_id: 'u_me', discord_user_id: null }, viewer), 'yours');
  assert.equal(personStanding({ user_id: 'u_other', discord_user_id: null }, viewer), 'taken');
  assert.equal(personStanding({ user_id: null, discord_user_id: '999' }, viewer), 'taken', 'it records somebody else\'s Discord ID');
  assert.equal(personStanding({ user_id: null, discord_user_id: '123' }, viewer), 'open', 'it records the viewer\'s own Discord ID: claimable, not theirs');
  assert.equal(personStanding({ user_id: null, discord_user_id: null }, viewer), 'open');

  const s = await scenario();
  const erin = await s.member('erin', 'Erin');
  const p = await s.person({ name: 'Recordone' });
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.res.person.version, linkUserId: erin }, 200);
  const row = await s.one('SELECT discord_user_id, user_id FROM players WHERE id = ?', p.pid);
  assert.notEqual(row.discord_user_id, null, 'the Discord ID is recorded');
  assert.equal(row.user_id, null);
  assert.equal(await ownPersonStatement(s.w.db, s.gid, erin).first(), null, 'a recorded Discord ID is not a person of the account');
  const sql = await s.w.db.prepare(`SELECT id FROM players WHERE guild_id = ? AND ${ownPlayerSql('players', '?')}`).bind(s.gid, erin).first();
  assert.equal(sql, null);
  ownPerson(s.w.db.sqlite, p.pid, erin);
  assert.deepEqual({ ...(await ownPersonStatement(s.w.db, s.gid, erin).first()) }, { id: p.pid });
});

check('a Discord ID on a person is bookkeeping in the "mine" routes (guild payload, sign-up, roster record, own team scope); players.user_id makes it mine', async () => {
  const s = await scenario();
  const erin = await s.member('erin', 'Erin');
  const p = await s.person({ name: 'Recordtwo' });
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.res.person.version, linkUserId: erin }, 200);
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.tids[0], raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan' })).raid.id;
  const guildMe = async () => (await s.ok('erin', 'GET', '')).me;
  assert.equal((await guildMe()).personId, null, 'me.personId');
  assert.deepEqual((await guildMe()).can['attendance.view'], [], 'no own team from a Discord ID');
  const refused = await s.call('erin', 'PUT', `/raids/${raid}/signup`, { kind: 'signed' });
  assert.deepEqual([refused.status, refused.json.error], [403, 'forbidden'], 'no person, no sign-up');
  assert.equal((await s.ok('erin', 'GET', `/roster/${p.pid}`)).person.isMe, false, 'roster record isMe');
  assert.equal((await s.ok('erin', 'GET', `/roster?team=${s.tids[0]}`)).people.find((x) => x.id === p.pid).isMe, false, 'roster list isMe');
  ownPerson(s.w.db.sqlite, p.pid, erin);
  assert.equal((await guildMe()).personId, p.pid);
  assert.deepEqual((await guildMe()).can['attendance.view'], [s.tids[0]]);
  assert.equal((await s.ok('erin', 'GET', `/roster/${p.pid}`)).person.isMe, true);
  assert.equal((await s.call('erin', 'PUT', `/raids/${raid}/signup`, { kind: 'signed' })).status, 200);
});

// ---------------------------------------------------------------------------
// 2. The writers of players.user_id

check('Link account records the Discord ID (audited, version bumped) and never the owner; an account without a Discord ID is refused (409 no_discord_id)', async () => {
  const s = await scenario();
  const erin = await s.member('erin', 'Erin');
  const bnetOnly = `u_${'B'.repeat(22)}`;
  s.exec(`INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('${bnetOnly}', '${bnetOnly}', NULL, 'Bnetonly', 1, 1)`);
  const p = await s.person({ name: 'Linkone' });
  const q = await s.person({ name: 'Linktwo' });
  const refused = await s.call('gm', 'PUT', `/roster/${p.pid}/account`, { userId: bnetOnly });
  assert.deepEqual([refused.status, refused.json.error, refused.json.field], [409, 'no_discord_id', 'userId']);
  assert.match(refused.json.message, /claims this record themselves/);
  assert.deepEqual({ ...(await s.one('SELECT discord_user_id, user_id, version FROM players WHERE id = ?', p.pid)) }, { discord_user_id: null, user_id: null, version: p.res.person.version });
  assert.equal(await s.w.count('audit_log', "action = 'person.account_link'"), 0);

  const done = await s.call('gm', 'PUT', `/roster/${p.pid}/account`, { userId: erin });
  assert.equal(done.status, 200, done.text);
  assert.deepEqual([done.json.person.account.via, done.json.person.account.linked], ['discord', false]);
  const stored = await s.one('SELECT discord_user_id, user_id, version FROM players WHERE id = ?', p.pid);
  assert.deepEqual([stored.discord_user_id !== null, stored.user_id, stored.version], [true, null, p.res.person.version + 1]);
  assert.equal(await s.w.count('players', 'user_id IS NOT NULL'), 0, 'no owner was written');
  const log = (await s.ok('gm', 'GET', '/audit')).rows[0];
  assert.equal(log.action, 'person.account_link');
  assert.match(log.text, /^Recorded the Discord ID of the account Erin on /);
  assert.deepEqual(log.after, { userId: erin, recordedDiscord: true });
  // The same Discord ID cannot sit on a second person of the guild.
  const twice = await s.call('gm', 'PUT', `/roster/${q.pid}/account`, { userId: erin });
  assert.deepEqual([twice.status, twice.json.error], [409, 'already_linked']);
  // Unlink clears the owner (the one write of players.user_id staff keep).
  ownPerson(s.w.db.sqlite, p.pid, erin, { bump: true });
  const off = await s.call('gm', 'PUT', `/roster/${p.pid}/account`, { userId: null });
  assert.equal(off.status, 200, off.text);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', p.pid)).user_id, null);
  assert.equal(await s.w.count('audit_log', "action = 'person.account_unlink'"), 1);
});

check('Link account keeps its team scope and the Seniority guard (a Team Lead: own team, never a senior person)', async () => {
  const s = await scenario();
  const [alpha, bravo] = s.tids;
  const erin = await s.member('erin', 'Erin');
  await s.lead('tl', [alpha], 'Leadone');
  const officerId = await s.officer('off', 'Offone');
  const onBravo = await s.person({ name: 'Bravoone', teamId: bravo });
  const seniorPerson = await s.person({ name: 'Seniorone' });
  ownPerson(s.w.db.sqlite, seniorPerson.pid, officerId, { bump: true });
  const wrongTeam = await s.call('tl', 'PUT', `/roster/${onBravo.pid}/account`, { userId: erin });
  assert.deepEqual([wrongTeam.status, wrongTeam.json.error], [403, 'forbidden']);
  const senior = await s.call('tl', 'PUT', `/roster/${seniorPerson.pid}/account`, { userId: erin });
  assert.deepEqual([senior.status, senior.json.error], [403, 'seniority']);
  assert.equal(await s.w.count('players', 'discord_user_id IS NOT NULL'), 0, 'nothing was recorded');
  const mine = await s.person({ name: 'Memberone' });
  assert.equal((await s.call('tl', 'PUT', `/roster/${mine.pid}/account`, { userId: erin })).status, 200, 'a plain person of the lead\'s own team');
});

check('the staff writers record a Discord ID and never write players.user_id: create with a member, the Discord field, linking a Raid-Helper sign-up', async () => {
  const s = await scenario();
  const erin = await s.member('erin', 'Erin');
  const dave = await s.member('dave', 'Dave');
  const created = await s.person({ name: 'Createone', linkUserId: erin });
  assert.notEqual((await s.one('SELECT discord_user_id FROM players WHERE id = ?', created.pid)).discord_user_id, null);
  const patched = await s.person({ name: 'Patchone' });
  await s.ok('gm', 'PATCH', `/roster/${patched.pid}`, { expectedVersion: patched.res.person.version, linkUserId: dave }, 200);
  assert.notEqual((await s.one('SELECT discord_user_id FROM players WHERE id = ?', patched.pid)).discord_user_id, null);
  const target = await s.person({ name: 'Signupone' });
  const raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.tids[0], raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan' })).raid.id;
  const discordId = '555000555000550001';
  s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id)
          VALUES ('${raid}', 'raid_helper', 1, '${discordId}', 'Attacker1', 'signed', 'Mage', 'Fire', 1, '${s.gid}')`);
  await s.ok('gm', 'POST', `/raids/${raid}/signups/link`, { signupId: 1, personId: target.pid }, 200);
  assert.equal((await s.one('SELECT discord_user_id FROM players WHERE id = ?', target.pid)).discord_user_id, discordId);
  assert.equal(await s.w.count('players', 'user_id IS NOT NULL'), 0, 'none of them wrote an owner');
});

// The CI grep: every SQL literal of worker/ that writes players.user_id, and who may. Literals are read the way tests/guild/guild-b6a-placeholder-greps-tests.js reads them.
function literalsOf(source) {
  const out = [];
  const n = source.length;
  function skipString(start) {
    const quote = source[start];
    let j = start + 1;
    while (j < n && source[j] !== quote && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
    return { text: source.slice(start + 1, j), end: j + 1 };
  }
  function skipRegex(i) {
    const before = source.slice(Math.max(0, i - 40), i).trimEnd();
    if (!(before === '' || /[=(,:;!&|?{}[+\-*%<>~^]$/.test(before) || /\b(return|typeof|case)$/.test(before))) return -1;
    let j = i + 1;
    let inClass = false;
    while (j < n && source[j] !== '\n' && (inClass || source[j] !== '/')) {
      if (source[j] === '\\') j++;
      else if (source[j] === '[') inClass = true;
      else if (source[j] === ']') inClass = false;
      j++;
    }
    return j + 1;
  }
  function readTemplate(start) {
    let text = '';
    let j = start + 1;
    while (j < n) {
      const ch = source[j];
      if (ch === '\\') { text += source.slice(j, j + 2); j += 2; continue; }
      if (ch === '`') return { text, end: j + 1 };
      if (ch === '$' && source[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < n && depth) {
          const c = source[j];
          if (c === '`') { const inner = readTemplate(j); out.push(inner.text); j = inner.end; continue; }
          if (c === '\'' || c === '"') { const t = skipString(j); out.push(t.text); j = t.end; continue; }
          if (c === '/' && source[j + 1] !== '/' && source[j + 1] !== '*') { const after = skipRegex(j); if (after > 0) { j = after; continue; } }
          if (c === '{') depth++;
          else if (c === '}') depth--;
          j++;
        }
        text += '\u0000';
        continue;
      }
      text += ch;
      j++;
    }
    throw new Error('unterminated template literal');
  }
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (ch === '/' && source[i + 1] === '*') { i = source.indexOf('*/', i + 2) + 2; continue; }
    if (ch === '`') { const t = readTemplate(i); out.push(t.text); i = t.end; continue; }
    if (ch === '\'' || ch === '"') { const t = skipString(i); out.push(t.text); i = t.end; continue; }
    if (ch === '/') { const after = skipRegex(i); if (after > 0) { i = after; continue; } }
    i++;
  }
  return out;
}

function workerFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) files.push(rel);
    }
  };
  walk('worker');
  return files.sort();
}

const INSERT_PLAYERS = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+players\s*\(([^)]*)\)/i;
const UPDATE_PLAYERS = /\bUPDATE\s+players\s+SET\s+([\s\S]*?)(?:\bWHERE\b|$)/i;
// 'insert' / 'update' when the statement writes players.user_id to something; a clear (user_id = NULL) is not a write of an owner.
function userIdWrite(sql) {
  const insert = INSERT_PLAYERS.exec(sql);
  if (insert && /\buser_id\b/.test(insert[1].replace(/\bdiscord_user_id\b/g, ''))) return 'insert';
  const update = UPDATE_PLAYERS.exec(sql);
  if (update && /(?:^|[,\s])user_id\s*=(?!\s*NULL\b)/i.test(update[1])) return 'update';
  return null;
}
const isPlayersWrite = (sql) => INSERT_PLAYERS.test(sql) || UPDATE_PLAYERS.test(sql);

// file -> how many statements write the owner. These are the three paths: Battle.net proof, the account holder's own accepted application, an approved "This is me" claim.
const OWNER_WRITERS = {
  'worker/bnet-match.js': 2,         // CREATE_PERSON_SQL, LINK_PERSON_SQL: the sign-in match / Battle.net proof
  'worker/claim-apply.js': 2,        // INSERT_PLAYER_SQL, LINK_PERSON_SQL: a claim applied at once or approved by an officer
  'worker/routes/applications.js': 1, // the accepted application of an account that applied while signed in
};

check('CI grep: only Battle.net proof, an accepted application and an approved claim write players.user_id (a clear is the only other write)', async () => {
  // The detectors run on seeded SQL first, so a broken detector fails here instead of passing everything.
  const positives = [
    'INSERT INTO players (id, guild_id, user_id) VALUES (?, ?, ?)',
    'INSERT OR REPLACE INTO players (id, user_id, status) VALUES (?, ?, ?)',
    'UPDATE players SET user_id = ?, version = version + 1 WHERE id = ?',
    'UPDATE players SET discord_user_id = ?, user_id = ?, discord_nickname = NULL WHERE id = ?',
    'UPDATE players SET user_id = (SELECT u.id FROM users u) WHERE id = ?',
    'UPDATE players SET user_id = COALESCE(user_id, ?) WHERE id = ?',
  ];
  const negatives = [
    'UPDATE players SET user_id = NULL, version = version + 1 WHERE user_id = ?',
    'UPDATE players SET discord_user_id = ?, version = version + 1 WHERE id = ?',
    'UPDATE players SET discord_user_id = NULL, discord_nickname = NULL WHERE discord_user_id = ?',
    'INSERT INTO players (id, guild_id, status, discord_user_id) VALUES (?, ?, ?, ?)',
    'UPDATE characters SET user_id = ? WHERE id = ?',
    'SELECT user_id FROM players WHERE user_id = ?',
    'UPDATE raid_signups SET discord_user_id = ? WHERE id = ?',
  ];
  for (const sql of positives) assert(userIdWrite(sql), `detector misses: ${sql}`);
  for (const sql of negatives) assert.equal(userIdWrite(sql), null, `detector flags: ${sql}`);

  const found = [];
  const playersWrites = new Map();
  for (const rel of workerFiles()) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    for (const literal of literalsOf(source)) {
      const sql = literal.replace(/\u0000/g, '?').replace(/\s+/g, ' ');
      if (isPlayersWrite(sql)) {
        if (!playersWrites.has(rel)) playersWrites.set(rel, []);
        playersWrites.get(rel).push(sql);
      }
      const kind = userIdWrite(sql);
      if (kind) found.push({ file: rel, kind, sql: sql.slice(0, 90) });
    }
  }
  const counts = {};
  for (const hit of found) counts[hit.file] = (counts[hit.file] || 0) + 1;
  const outside = found.filter((hit) => !Object.prototype.hasOwnProperty.call(OWNER_WRITERS, hit.file));
  assert.deepEqual(outside, [], `these statements write players.user_id outside the three paths:\n${outside.map((hit) => `${hit.file}: ${hit.sql}`).join('\n')}`);
  assert.deepEqual(counts, OWNER_WRITERS, 'the allowlist matches the statements exactly (a stale entry or a new writer fails)');
  // The dynamic SET list of a person join names no user_id (its pieces are literals of person-join.js).
  const join = literalsOf(fs.readFileSync(path.join(ROOT, 'worker/person-join.js'), 'utf8').replace(/\r\n/g, '\n'));
  assert.deepEqual(join.filter((literal) => /^\s*user_id\s*=/.test(literal)), [], 'a person join keeps the survivor\'s owner');
  // The staff writers still record the Discord ID (bookkeeping), and write it only: each has a players write that names discord_user_id.
  for (const file of ['worker/routes/signups.js', 'worker/routes/roster.js', 'worker/routes/roster-import.js', 'worker/routes/attendance.js', 'worker/routes/accounts.js']) {
    assert((playersWrites.get(file) || []).some((sql) => /discord_user_id/.test(sql)), `${file} records a Discord ID on a person`);
  }
});

// ---------------------------------------------------------------------------
// Claims: a Discord ID on a person makes a claim likely, never an ownership

check('claim planning: a person that records the claimant\'s Discord ID is "open" (This is me links it), someone else\'s Discord ID is taken, a new character next to a recorded person waits', async () => {
  const { planClaims } = await load('worker/bnet-store.js');
  const s = await scenario();
  const erin = await s.member('erin', 'Erin');
  const dave = await s.member('dave', 'Dave');
  const p = await s.person({ name: 'Recordedone' });
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.res.person.version, linkUserId: erin }, 200);
  const guild = { id: s.gid, discord_server_id: s.serverId };
  const keys = await s.one('SELECT name_key, realm_key FROM characters WHERE id = ?', p.cid);
  const claim = (id, userId, nameKey = keys.name_key) => ({ id, user_id: userId, name_key: nameKey, realm_key: keys.realm_key });
  const plan = async (...claims) => planClaims(s.w.db, guild, claims);
  let plans = await plan(claim('a', erin), claim('b', erin, 'brandnew'), claim('c', dave), claim('d', dave, 'brandnew'));
  assert.deepEqual([plans.get('a').kind, plans.get('a').person.id], ['link_person', p.pid], 'her own Discord ID on the person: a link she can ask for, not an ownership');
  assert.deepEqual([plans.get('b').kind, plans.get('b').reason], ['blocked', 'recorded'], 'a second person cannot take the Discord ID the first records');
  assert.deepEqual([plans.get('c').kind, plans.get('c').reason], ['blocked', 'taken'], 'the person records erin\'s Discord ID: not dave\'s to claim');
  assert.equal(plans.get('d').kind, 'new_person');
  ownPerson(s.w.db.sqlite, p.pid, erin);
  plans = await plan(claim('a', erin), claim('b', erin, 'brandnew'), claim('c', dave));
  assert.deepEqual([plans.get('a').kind, plans.get('b').kind, plans.get('c').reason], ['already', 'add_alt', 'taken']);
});

check('This is me: a hand-typed claim on the person that records your Discord ID waits for an officer, and the approval is what writes players.user_id (and keeps the Discord ID)', async () => {
  const s = await scenario();
  const erin = await s.member('erin', 'Erin');
  const p = await s.person({ name: 'Mendrax' });
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.res.person.version, linkUserId: erin }, 200);
  const discordId = (await s.one('SELECT discord_user_id FROM players WHERE id = ?', p.pid)).discord_user_id;
  const asked = await s.ok('erin', 'POST', '/me/characters', { name: 'Mendrax', class: 'MAGE', mainSpec: 'Fire', offSpec: null }, 201);
  assert.equal(asked.claims[0].status, 'pending');
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', p.pid)).user_id, null, 'typing a name proves nothing: no owner yet');
  await s.ok('gm', 'POST', `/claims/${asked.claims[0].id}/approve`, { expectedKind: 'link_person' }, 200);
  const row = await s.one('SELECT user_id, discord_user_id FROM players WHERE id = ?', p.pid);
  assert.deepEqual({ ...row }, { user_id: erin, discord_user_id: discordId });
  assert.equal((await s.ok('erin', 'GET', '')).me.personId, p.pid);
});

check('a block still reaches a person that only records the account\'s Discord ID (it is the account\'s by bookkeeping): off every team', async () => {
  const s = await scenario();
  const erin = await s.member('erin', 'Erin');
  const p = await s.person({ name: 'Blockedone' });
  await s.ok('gm', 'PATCH', `/roster/${p.pid}`, { expectedVersion: p.res.person.version, linkUserId: erin }, 200);
  assert.equal(await s.teamOf(p.cid), s.tids[0]);
  await s.ok('gm', 'POST', `/people/${erin}/block`, { reason: 'test' }, 200);
  assert.equal(await s.teamOf(p.cid), null, 'the block took the person off the team');
});

// ---------------------------------------------------------------------------
// 3. Migration 0039

const MIGRATIONS = path.join(ROOT, 'migrations');
const FILE = '0039_identity_backfill.sql';
const MIGRATION = fs.readFileSync(path.join(MIGRATIONS, FILE), 'utf8').split(/\r?\n/).join('\n');
const exec = (db, sql) => db.sqlite.exec(sql);
// The file adds the flag column first; the test of the membership rule adds it to the 0038 database itself (every row 0, as for the previous release's links), so the rule can be
// read before and after, and then runs the rest of the file.
const ALTER = 'ALTER TABLE players ADD COLUMN user_id_backfilled INTEGER NOT NULL DEFAULT 0;\n';
assert(MIGRATION.includes(ALTER), 'the file adds the user_id_backfilled column');
const MIGRATION_AFTER_ALTER = MIGRATION.replace(ALTER, '');
const rows = (db, sql, ...values) => db.sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));

// The database the previous release runs on: every migration before 0039.
function worldAt0038() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-0039-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0039')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const db = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return db;
}

const DID = (key) => `3000000000000000${String(key.charCodeAt(0)).padStart(3, '0')}`;

// A world with every case of the rule. Returns { persons: { name: person id } }.
function seed(db) {
  exec(db, `
    INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source) VALUES
      ('gL1', 'Legacy one', 'R', 'realm', 'US', 'srvL1', 'America/Chicago', 'tbc', 1, NULL),
      ('gL2', 'Legacy two', 'R', 'realm', 'US', 'srvL2', 'America/Chicago', 'tbc', 1, NULL),
      ('gN',  'No Discord', 'R', 'realm', 'US', 'none:gN', 'America/Chicago', 'tbc', 1, NULL),
      ('gM',  'Manual', 'R', 'realm', 'US', 'srvM', 'America/Chicago', 'tbc', 1, 'manual'),
      ('gI',  'In game', 'R', 'realm', 'US', 'srvI', 'America/Chicago', 'tbc', 1, 'ingame'),
      ('gX',  'Unknown source', 'R', 'realm', 'US', 'srvX', 'America/Chicago', 'tbc', 1, 'future');
  `);
  const users = 'ABCDEFGHIJKLMNO'.split('');
  for (const key of users) {
    exec(db, `INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('u${key}', 'u${key}', '${DID(key)}', 'user${key}', 1, 1)`);
  }
  exec(db, `INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES ('uZ', 'uZ', NULL, 'bnetonly', 1, 1)`);
  const inServer = (key, server) => exec(db, `INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('u${key}', '${server}', 1)`);
  const persons = {};
  const person = (name, guild, { discord = null, user = null } = {}) => {
    persons[name] = `p_${name}`;
    exec(db, `INSERT INTO players (id, guild_id, status, discord_user_id, user_id, created_at, updated_at)
              VALUES ('p_${name}', '${guild}', 'raider', ${discord ? `'${discord}'` : 'NULL'}, ${user ? `'${user}'` : 'NULL'}, 1, 1)`);
  };
  const character = (id, playerId, guild, proof) => exec(db, `INSERT INTO characters (id, guild_id, player_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, owner_proof)
              VALUES ('${id}', '${guild}', '${playerId}', '${id}', '${id}', 'Realm', 'realm', 'MAGE', ${proof === 'main' ? 1 : 0}, 1, 1, 'raider', ${proof && proof !== 'main' ? `'${proof}'` : 'NULL'})`);
  // 1 A: in the server, not blocked -> linked
  inServer('A', 'srvL1'); person('A', 'gL1', { discord: DID('A') });
  // 2 B: not in the server -> left alone (leaving the server still ends access)
  person('B', 'gL1', { discord: DID('B') });
  // 3 C: in the server but blocked -> left alone
  inServer('C', 'srvL1'); person('C', 'gL1', { discord: DID('C') });
  exec(db, `INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES ('gL1', 'uC', 1)`);
  // 4 D owns a person already: the Discord person stays bookkeeping (one person per account per guild)
  inServer('D', 'srvL1'); person('D0', 'gL1', { user: 'uD' }); person('D1', 'gL1', { discord: DID('D') });
  // 5 E: a Discord ID that no account holds
  person('E', 'gL1', { discord: DID('E') });
  // 6 F: in two legacy guilds, a person in each -> both linked (one person per guild)
  inServer('F', 'srvL1'); inServer('F', 'srvL2'); person('F1', 'gL1', { discord: DID('F') }); person('F2', 'gL2', { discord: DID('F') });
  // 7 G: linked, and the attestations on its characters survive the link
  inServer('G', 'srvL1'); person('G', 'gL1', { discord: DID('G') });
  character('c_g_main', 'p_G', 'gL1', 'main'); character('c_g_off', 'p_G', 'gL1', 'officer'); character('c_g_hand', 'p_G', 'gL1', 'hand');
  // 8 H: blocked, but the stored Guild Master of a legacy guild: a block on the Owner is ignored -> linked (and the row is still the Owner's)
  inServer('H', 'srvL1'); person('H', 'gL1', { discord: DID('H') });
  exec(db, `INSERT INTO guild_blocks (guild_id, user_id, created_at) VALUES ('gL1', 'uH', 1)`);
  exec(db, `INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at) VALUES ('ra_h', 'gL1', 'uH', 'guild_master', NULL, NULL, 1)`);
  // 9 I: the person is another account's already (user_id set) and carries I's Discord ID
  inServer('I', 'srvL1'); person('I', 'gL1', { discord: DID('I'), user: 'uJ' });
  // 10 K in a manual guild, 11 L in an in-game guild: the server grants nothing there -> left alone
  inServer('K', 'srvM'); person('K', 'gM', { discord: DID('K') });
  inServer('L', 'srvI'); person('L', 'gI', { discord: DID('L') });
  // 12 M: a guild without Discord has no server to be in
  exec(db, `INSERT INTO user_servers (user_id, server_id, seen_at) VALUES ('uM', 'none:gN', 1)`);
  person('M', 'gN', { discord: DID('M') });
  // 13 N: a rank source this release does not know is the legacy rule
  inServer('N', 'srvX'); person('N', 'gX', { discord: DID('N') });
  // 14 O: no Discord ID on the person at all
  inServer('O', 'srvL1'); person('O', 'gL1');
  return persons;
}

// The JS oracle: who should own each person after the backfill, from the rows alone and the pure membership rules of worker/membership.js and worker/owner.js.
async function expectedOwners(db) {
  const { membershipOf } = await load('worker/membership.js');
  const { ownerOf } = await load('worker/owner.js');
  const guilds = rows(db, 'SELECT id, discord_server_id, rank_source, owner_user_id FROM guilds');
  const players = rows(db, 'SELECT id, guild_id, user_id, discord_user_id FROM players');
  const accounts = rows(db, 'SELECT id, discord_id FROM users');
  const servers = rows(db, 'SELECT user_id, server_id FROM user_servers');
  const blocks = rows(db, 'SELECT guild_id, user_id FROM guild_blocks');
  const masters = rows(db, "SELECT guild_id, user_id FROM role_assignments WHERE role_id = 'guild_master'");
  const expected = {};
  for (const p of players) {
    expected[p.id] = p.user_id;
    if (p.user_id !== null || p.discord_user_id === null) continue;
    const matches = accounts.filter((u) => u.discord_id === p.discord_user_id);
    if (matches.length !== 1) continue;
    const u = matches[0];
    if (players.some((o) => o.guild_id === p.guild_id && o.user_id === u.id)) continue;
    if (players.filter((o) => o.guild_id === p.guild_id && o.discord_user_id === p.discord_user_id).length !== 1) continue;
    const g = guilds.find((x) => x.id === p.guild_id);
    const realServer = g.discord_server_id !== null && !g.discord_server_id.startsWith('none:');
    const master = masters.find((m) => m.guild_id === g.id);
    const facts = {
      source: g.rank_source,
      inServer: realServer && servers.some((x) => x.user_id === u.id && x.server_id === g.discord_server_id),
      linked: false,
      owner: ownerOf({ userId: u.id, ownerUserId: g.owner_user_id, rankSource: g.rank_source, storedMasterUserId: master ? master.user_id : null }),
      rosterCharacter: false,
    };
    const blocked = blocks.some((b) => b.guild_id === g.id && b.user_id === u.id);
    if (membershipOf({ blocked, ...facts }) === 'member') expected[p.id] = u.id;
  }
  return expected;
}

async function memberships(db) {
  const { memberSql } = await load('worker/membership.js');
  return rows(db, `SELECT u.id AS uid, g.id AS gid, ${memberSql('u.id', 'g.id', 'g.discord_server_id')} AS member FROM users u, guilds g ORDER BY u.id, g.id`);
}

const OLD_MINE = "(p.user_id = u.id OR (p.discord_user_id IS NOT NULL AND p.discord_user_id = u.discord_id))"; // ownPlayerSql of the previous release
// Line endings are not schema: a checkout on Windows reads 0031 with CRLF, 0039 is read as written.
const schemaOf = (db) => JSON.stringify(rows(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").map((row) => ({ ...row, sql: row.sql && row.sql.replace(/\r\n/g, '\n') })));

check('migration 0039: every person gets exactly the owner the JS oracle says, nothing else changes, and nobody\'s membership moves', async () => {
  const db = worldAt0038();
  const persons = seed(db);
  exec(db, ALTER); // every existing link has the flag 0: the rule the previous release ran
  const expected = await expectedOwners(db);
  const membersBefore = await memberships(db);
  const schemaBefore = schemaOf(db);
  const before = rows(db, 'SELECT * FROM players ORDER BY id');
  const oldMine = (await Promise.all(membersBefore.filter((m) => m.member === 1).map(async (m) => ({
    uid: m.uid, gid: m.gid, mine: rows(db, `SELECT p.id FROM players p, users u WHERE u.id = ? AND p.guild_id = ? AND ${OLD_MINE} ORDER BY p.id`, m.uid, m.gid).map((r) => r.id),
  }))));
  exec(db, MIGRATION_AFTER_ALTER);
  const after = rows(db, 'SELECT * FROM players ORDER BY id');
  // The oracle, row by row.
  assert.deepEqual(Object.fromEntries(after.map((p) => [p.id, p.user_id])), expected);
  // The cases, by name (so a wrong oracle cannot hide a wrong rule).
  const owner = (name) => after.find((p) => p.id === persons[name]).user_id;
  assert.deepEqual(
    ['A', 'B', 'C', 'D0', 'D1', 'E', 'F1', 'F2', 'G', 'H', 'I', 'K', 'L', 'M', 'N', 'O'].map((k) => [k, owner(k)]),
    [['A', 'uA'], ['B', null], ['C', null], ['D0', 'uD'], ['D1', null], ['E', null], ['F1', 'uF'], ['F2', 'uF'], ['G', 'uG'], ['H', 'uH'], ['I', 'uJ'], ['K', null], ['L', null], ['M', null], ['N', 'uN'], ['O', null]],
  );
  // Only user_id and its flag moved: every other column of every person is what it was (version and updated_at on purpose).
  assert.deepEqual(after.map(({ user_id, user_id_backfilled, ...rest }) => rest), before.map(({ user_id, user_id_backfilled, ...rest }) => rest));
  // The flag marks exactly the links the file wrote.
  assert.deepEqual(after.filter((p) => p.user_id_backfilled === 1).map((p) => p.id),
    after.filter((p) => p.user_id !== before.find((b) => b.id === p.id).user_id).map((p) => p.id), 'the flag is 1 on every backfilled person and nowhere else');
  assert(after.some((p) => p.user_id_backfilled === 1) && before.every((p) => p.user_id_backfilled === 0));
  // Membership: the same answer for every account in every guild. A backfilled link is the person's owner and no membership, so an account that left the Discord server of
  // a legacy guild is as out as it was.
  assert.deepEqual(await memberships(db), membersBefore, 'a backfilled link lets nobody in and keeps nobody out');
  // Ownership of the members is kept: the person the previous rule gave them is theirs now. An account with two persons keeps the one it owned by user_id, and a person
  // another account already owns (user_id set) is not taken from it by a Discord ID.
  for (const m of oldMine) {
    const mine = rows(db, 'SELECT id FROM players WHERE guild_id = ? AND user_id = ? ORDER BY id', m.gid, m.uid).map((r) => r.id);
    const claimable = m.mine.filter((id) => { const row = before.find((p) => p.id === id); return row.user_id === null || row.user_id === m.uid; });
    assert.equal(mine.length, claimable.length ? 1 : 0, `${m.uid} in ${m.gid}: one person, never two`);
    if (claimable.length) assert(claimable.includes(mine[0]), `${m.uid} in ${m.gid}: a person it had`);
    if (m.mine.length === 1 && claimable.length) assert.deepEqual(mine, m.mine, `${m.uid} in ${m.gid}: the same person as before`);
  }
  // No account has two persons in one guild.
  assert.deepEqual(rows(db, 'SELECT guild_id, user_id, COUNT(*) AS n FROM players WHERE user_id IS NOT NULL GROUP BY guild_id, user_id HAVING n > 1'), []);
  assert.deepEqual(rows(db, 'PRAGMA foreign_key_check'), []);
  // Schema: only the three triggers are new (the flag column was added above); the proof trigger is back with its 0031 text.
  const objects = (json) => Object.fromEntries(JSON.parse(json).map((row) => [row.name, row]));
  const was = objects(schemaBefore);
  const now = objects(schemaOf(db));
  assert.deepEqual(Object.keys(now).filter((name) => !was[name]).sort(),
    ['characters_bnet_proof_confirms_link', 'characters_bnet_proof_update_confirms_link', 'players_user_change_clears_backfill']);
  for (const name of Object.keys(was)) assert.deepEqual(now[name], was[name], name + ' is as it was');
});

check('migration 0039: the attestations on a linked person\'s characters survive; the proof-clearing trigger is back and still clears them on a real change of owner; a rerun changes nothing', async () => {
  const db = worldAt0038();
  seed(db);
  const proofs = () => Object.fromEntries(rows(db, "SELECT id, owner_proof FROM characters WHERE player_id = 'p_G' ORDER BY id").map((r) => [r.id, r.owner_proof]));
  const before = proofs();
  assert.deepEqual(before, { c_g_hand: 'hand', c_g_main: null, c_g_off: 'officer' });
  exec(db, MIGRATION);
  assert.deepEqual(proofs(), before, 'linking the account that was already behind the person is not a change of owner');
  const once = rows(db, 'SELECT id, user_id, user_id_backfilled, version, updated_at FROM players ORDER BY id');
  exec(db, MIGRATION_AFTER_ALTER);
  assert.deepEqual(rows(db, 'SELECT id, user_id, user_id_backfilled, version, updated_at FROM players ORDER BY id'), once, 'the backfill and the triggers rerun to the same state (the ALTER is applied once)');
  assert.equal(rows(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'players_user_change_clears_proof'").length, 1);
  exec(db, "UPDATE players SET user_id = 'uZ' WHERE id = 'p_G'");
  assert.deepEqual(proofs(), { c_g_hand: null, c_g_main: null, c_g_off: null }, 'a real change of owner still clears the attestations');
});

check('migration 0039: the previous release\'s statements still work on the backfilled data (the old "mine" rule finds the same person; the unique index holds)', async () => {
  const db = worldAt0038();
  const persons = seed(db);
  exec(db, MIGRATION);
  const mine = (userId, guild) => rows(db, `SELECT p.id FROM players p, users u WHERE u.id = ? AND p.guild_id = ? AND ${OLD_MINE} ORDER BY p.id`, userId, guild).map((r) => r.id);
  assert.deepEqual(mine('uA', 'gL1'), [persons.A]);
  assert.deepEqual(mine('uF', 'gL2'), [persons.F2]);
  assert.throws(() => exec(db, `UPDATE players SET user_id = 'uA' WHERE id = '${persons.O}'`), /UNIQUE/i, 'players_guild_user still allows one person per account per guild');
  exec(db, `INSERT INTO players (id, guild_id, status, discord_user_id, created_at, updated_at) VALUES ('p_new', 'gL1', 'raider', '${DID('O')}', 1, 1)`);
  assert.equal(rows(db, "SELECT user_id FROM players WHERE id = 'p_new'")[0].user_id, null, 'a person created later records a Discord ID and owns nobody');
});

// ---------------------------------------------------------------------------
// 4. Seniority on status, rank and left date

check('roster PATCH: a Team Lead cannot change a senior\'s status, trial dates or left date; an equal Officer cannot either; their own and a junior\'s are fine; joined-on alone stays open', async () => {
  const s = await scenario();
  const [alpha] = s.tids;
  const off1 = await s.officer('off1', 'Offone');
  await s.officer('off2', 'Offtwo');
  const tl = await s.lead('tl', [alpha], 'Leadone');
  const m1 = await s.member('m1', 'Memone');
  const po = await s.person({ name: 'Seniorp' });
  const pm = await s.person({ name: 'Juniorp' });
  const pt = await s.person({ name: 'Leadp' });
  ownPerson(s.w.db.sqlite, po.pid, off1);
  ownPerson(s.w.db.sqlite, pm.pid, m1);
  ownPerson(s.w.db.sqlite, pt.pid, tl);
  const version = async (pid) => (await s.one('SELECT version FROM players WHERE id = ?', pid)).version;
  const rank = async (cid) => ({ ...(await s.one('SELECT core_rank, left_on, left_reason, trial_start, trial_end FROM characters WHERE id = ?', cid)) });
  const patch = async (who, pid, body) => s.call(who, 'PATCH', `/roster/${pid}`, { expectedVersion: await version(pid), ...body });
  const refusedAndUnchanged = async (who, pid, cid, body, label) => {
    const rankBefore = await rank(cid);
    const versionBefore = await version(pid);
    const audits = await s.w.count('audit_log', "action = 'person.update'");
    const res = await patch(who, pid, body);
    assert.deepEqual([res.status, res.json.error], [403, 'seniority'], `${label}: ${res.text}`);
    assert.deepEqual(await rank(cid), rankBefore, `${label}: the rank is unchanged`);
    assert.equal(await version(pid), versionBefore, `${label}: the person is unchanged`);
    assert.equal(await s.w.count('audit_log', "action = 'person.update'"), audits, `${label}: no audit row`);
  };
  await refusedAndUnchanged('tl', po.pid, po.cid, { status: 'reserve' }, 'status');
  // The Guild Master puts the Officer's person on trial, then inactive: the lead may not touch either.
  assert.equal((await patch('gm', po.pid, { status: 'trial', trialStart: '2027-01-10', trialEnd: '2027-01-24' })).status, 200);
  await refusedAndUnchanged('tl', po.pid, po.cid, { trialEnd: '2027-01-31' }, 'trial end');
  assert.equal((await patch('gm', po.pid, { status: 'inactive', leftOn: '2027-01-12', leftReason: 'left' })).status, 200);
  await refusedAndUnchanged('tl', po.pid, po.cid, { leftOn: '2027-01-01' }, 'left date');
  await refusedAndUnchanged('tl', po.pid, po.cid, { leftReason: 'kicked' }, 'left reason');
  await refusedAndUnchanged('tl', po.pid, po.cid, { status: 'raider' }, 'back to raider');
  await refusedAndUnchanged('off2', po.pid, po.cid, { status: 'raider' }, 'an equal Officer');
  // Joined on is not status, rank or left date: it stays open to whoever may edit the roster.
  assert.equal((await patch('tl', po.pid, { joinedOn: '2026-12-01' })).status, 200);
  // A junior's person and the lead's own are theirs to change.
  const junior = await patch('tl', pm.pid, { status: 'reserve' });
  assert.equal(junior.status, 200, junior.text);
  assert.equal((await rank(pm.cid)).core_rank, 'reserve');
  assert.equal((await patch('tl', pt.pid, { status: 'reserve' })).status, 200, 'their own person');
  // The Officer who ranks above the lead, and the Guild Master, may.
  assert.equal((await patch('off1', pm.pid, { status: 'raider' })).status, 200);
  assert.equal((await patch('gm', po.pid, { status: 'raider' })).status, 200);
  assert.equal((await rank(po.cid)).core_rank, 'raider');
});

check('roster PATCH: the Seniority guard sits inside the writes - a person promoted between the pre-check and the batch changes nothing (409)', async () => {
  const s = await scenario();
  const [alpha] = s.tids;
  await s.lead('tl', [alpha], 'Leadone');
  const m1 = await s.member('m1', 'Memone');
  const pm = await s.person({ name: 'Juniorq' });
  ownPerson(s.w.db.sqlite, pm.pid, m1);
  const db = s.w.db;
  const batch = db.batch.bind(db);
  let promote = () => s.exec(`INSERT INTO role_assignments (id, guild_id, user_id, role_id, team_id, assigned_by, assigned_at)
    VALUES ('ra_idsplit', '${s.gid}', '${m1}', 'officer', NULL, '${s.uids.gm}', 1)`);
  db.batch = async (statements) => {
    if (promote && statements.some((statement) => /UPDATE characters SET core_rank/.test(statement.sql))) {
      const run = promote;
      promote = null;
      run();
    }
    return batch(statements);
  };
  const versionBefore = (await s.one('SELECT version FROM players WHERE id = ?', pm.pid)).version;
  const res = await s.call('tl', 'PATCH', `/roster/${pm.pid}`, { expectedVersion: versionBefore, status: 'reserve' });
  assert.equal(promote, null, 'the promotion ran between the read and the batch');
  assert.deepEqual([res.status, res.json.error], [409, 'conflict'], res.text);
  assert.equal((await s.one('SELECT core_rank FROM characters WHERE id = ?', pm.cid)).core_rank, 'raider', 'the rank did not move');
  assert.equal((await s.one('SELECT version FROM players WHERE id = ?', pm.pid)).version, versionBefore);
  assert.equal(await s.w.count('audit_log', "action = 'person.update'"), 0);
  // Now an Officer, the same lead is refused up front.
  const refused = await s.call('tl', 'PATCH', `/roster/${pm.pid}`, { expectedVersion: versionBefore, status: 'reserve' });
  assert.deepEqual([refused.status, refused.json.error], [403, 'seniority']);
});

// ---------------------------------------------------------------------------
// 5. The Link account list

check('nameSuffixes: accounts that show one name (any case) get the shortest tail of their id (4 or more characters) that tells them apart; a name of its own gets none', async () => {
  const { nameSuffixes } = await load('worker/routes/accounts.js');
  const id = (tail) => `u_${'A'.repeat(18)}${tail}`;
  const accounts = [
    { id: id('wxyz'), display_name: 'Twin' }, { id: id('qrst'), display_name: 'twin' }, { id: id('lone'), display_name: 'Lonely' },
    { id: id('1111'), global_name: 'Same' }, { id: id('x1111'), display_name: null, global_name: null, username: 'SAME' },
  ];
  const suffixes = nameSuffixes(accounts);
  assert.equal(suffixes.get(accounts[0].id), '#wxyz');
  assert.equal(suffixes.get(accounts[1].id), '#qrst');
  assert.equal(suffixes.has(accounts[2].id), false, 'a name of its own needs none');
  assert.notEqual(suffixes.get(accounts[3].id), suffixes.get(accounts[4].id), 'tails that collide at four characters grow until they differ');
  assert(suffixes.get(accounts[3].id).length > 5 || suffixes.get(accounts[4].id).length > 5);
  assert.equal(nameSuffixes([]).size, 0);
  assert.equal(nameSuffixes([{ id: id('aaaa'), display_name: 'A' }, { id: id('bbbb'), display_name: 'B' }]).size, 0);
});

check('GET /accounts as a Team Lead (the claimants list): two claimants that show the same name carry different suffixes, a third with its own name none', async () => {
  const s = await scenario();
  const [alpha] = s.tids;
  await s.lead('tl', [alpha], 'Leadone');
  const twin1 = await s.member('twin1', 'Twin one');
  const twin2 = await s.member('twin2', 'Twin two');
  const solo = await s.member('solo', 'Solo');
  s.exec(`UPDATE users SET display_name = 'Twin' WHERE id IN ('${twin1}', '${twin2}')`);
  let n = 0;
  for (const userId of [twin1, twin2, solo]) {
    const claimId = `cl_${String(++n).padStart(22, 'q')}`;
    s.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
            VALUES ('${claimId}', '${s.gid}', '${userId}', 'Claimed${n}', 'claimed${n}', 'Nightslayer', 'nightslayer', 'MAGE', 70, 'pending', ${n})`);
  }
  const list = (await s.ok('tl', 'GET', '/accounts')).accounts;
  assert.equal(list.length, 3);
  const by = Object.fromEntries(list.map((a) => [a.id, a]));
  assert.notEqual(by[twin1].nameSuffix, by[twin2].nameSuffix);
  assert(/^#.{4,}$/.test(by[twin1].nameSuffix) && /^#.{4,}$/.test(by[twin2].nameSuffix), 'short, with a #');
  assert(twin1.endsWith(by[twin1].nameSuffix.slice(1)) && twin2.endsWith(by[twin2].nameSuffix.slice(1)));
  assert.equal(by[solo].nameSuffix, '');
  assert(!JSON.stringify(list).includes('1100000000'), 'no Discord ID in the list');
});

runChecks(checks);
