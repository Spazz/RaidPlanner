/**
 * Raidsmith guild tracker - the three LOW findings of the release R3 security review
 * Run: node tests/guild/guild-r3fix-tests.js
 *
 *   R3-1 ... a Discord ID that an officer records on a roster person (PUT .../roster/:pid/account) ties nobody to the guild: the account is not on the Users list, has no page and is no
 *            bulk-block target; the person is listed (and blocked) as the person it is. Any other tie (an application here) lists the account and merges the person into it. The
 *            account lookup answers with the name and nothing account-wide.
 *   R3-2 ... a raid with no guest limit takes at most 100 guests (link and open together), counted as the limit is, inside the INSERT: the same 409 raid_full / 410 link_full, the
 *            same exact count under parallel sign-ups; spotsLeft stays null.
 *   R3-3 ... a typed name that mixes alphabets ("Mаinone" with a Cyrillic а) is 400 "Use letters from one alphabet." on every route that reads a typed name; single-alphabet names
 *            (Latin with accents, Cyrillic, Greek, Han/Kana) stay allowed; stored names are not touched.
 */
const assert = require('node:assert/strict');
const { newJar } = require('../guild-world');
const { load, runChecks, scenario: baseScenario } = require('../guild-b3-world');
const { exec, rowsOf, addApplication } = require('../guild-evidence');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// The Users routes allow 30 requests a minute per user and the stand-in's clock moves 2 s per call; a request to them starts with an empty window.
function unlimited(s) {
  const call = s.call.bind(s);
  s.call = (who, method, tail, body) => {
    if (/\/users(\/|\?|$)/.test(tail)) s.w.db.sqlite.exec("DELETE FROM rate_limits WHERE key LIKE 'users:%'");
    return call(who, method, tail, body);
  };
  return s;
}
const scenario = async (options) => unlimited(await baseScenario(options));

// ---------------------------------------------------------------------------
// R3-1: a Discord ID on a person is bookkeeping

const USERS = '/users';
const ALL_SEGMENTS = ['members', 'former', 'nonmembers', 'blocked'];
const listOf = (s, who, segment) => s.ok(who, 'GET', `${USERS}?segment=${segment}&limit=100`, undefined, 200);
const discordIdOf = (s, key) => rowsOf(s, 'SELECT discord_id FROM users WHERE id = ?', s.uids[key])[0].discord_id;

async function strangerWorld() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('off', 'Officerone');
  await s.member('m1', 'Memberone');
  s.stranger = await s.outsider('str', 'Strangerone');
  s.target = await s.person({ name: 'Targetchar' });
  return s;
}

check('R3-1: the lookup answers with the name and nothing account-wide; linking a stranger records only the Discord ID on the person', async () => {
  const s = await strangerWorld();
  // Everything account-wide about the stranger exists: a sign-in time, a Battle.net link.
  exec(s, 'UPDATE users SET last_seen_at = ? WHERE id = ?', 1_790_000_000_000, s.stranger);
  exec(s, "INSERT INTO bnet_links (user_id, battletag, bnet_account_id, snapshot, snapshot_at, linked_at) VALUES (?, 'Strange#1234', '4242424242', '{}', 1, 1)", s.stranger);
  const found = await s.call('off', 'GET', '/accounts?q=Strangerone');
  assert.equal(found.status, 200, found.text);
  assert.equal(found.json.accounts.length, 1);
  assert.deepEqual(Object.keys(found.json.accounts[0]).sort(),
    ['ambiguous', 'avatarUrl', 'battletag', 'displayName', 'id', 'initials', 'matchedBy', 'nameSuffix', 'username'], 'the link picker\'s fields only');
  const account = found.json.accounts[0];
  assert.deepEqual([account.id, account.displayName, account.username, account.avatarUrl, account.battletag, account.matchedBy], [s.stranger, 'Strangerone', '', null, null, 'name']);
  for (const secret of [String(1_790_000_000_000), discordIdOf(s, 'str'), '4242424242', 'Strange#1234']) assert(!found.text.includes(secret), `the reply carries ${secret}`);
  // Typing the BattleTag shows that BattleTag (what the officer typed) and still nothing else.
  const byTag = await s.call('off', 'GET', `/accounts?q=${encodeURIComponent('Strange#1234')}`);
  assert.deepEqual([byTag.json.accounts.length, byTag.json.accounts[0].matchedBy, byTag.json.accounts[0].battletag], [1, 'battletag', 'Strange#1234']);
  assert(!byTag.text.includes('4242424242') && !byTag.text.includes(String(1_790_000_000_000)));
  // The link keeps working: the person records the stranger's Discord ID, nothing else changes hands.
  const linked = await s.call('off', 'PUT', `/roster/${s.target.pid}/account`, { userId: s.stranger });
  assert.equal(linked.status, 200, linked.text);
  const row = rowsOf(s, 'SELECT user_id, discord_user_id FROM players WHERE id = ?', s.target.pid)[0];
  assert.deepEqual([row.user_id, row.discord_user_id], [null, discordIdOf(s, 'str')]);
});

check('R3-1: a stranger an officer linked is on no Users segment, has no page and is no bulk-block target; the person is listed as the person it is', async () => {
  const s = await strangerWorld();
  const before = {};
  for (const segment of ALL_SEGMENTS) before[segment] = (await listOf(s, 'gm', segment)).counts;
  assert.equal((await s.call('off', 'PUT', `/roster/${s.target.pid}/account`, { userId: s.stranger })).status, 200);
  for (const segment of ALL_SEGMENTS) {
    const res = await listOf(s, 'gm', segment);
    assert(!res.rows.some((entry) => entry.key === s.stranger || entry.name === 'Strangerone'), `${segment}: the stranger is not listed`);
    assert.deepEqual(res.counts, before[segment], `${segment}: the counts are the same as before the link`);
  }
  const members = await listOf(s, 'gm', 'members');
  const person = members.rows.find((entry) => entry.key === s.target.pid);
  assert(person, 'the person stays on the list');
  assert.deepEqual([person.kind, person.main && person.main.name], ['person', 'Targetchar']);
  assert.equal((await s.call('gm', 'GET', `${USERS}/${s.stranger}`)).status, 404, 'no page for the stranger');
  assert.equal((await s.call('gm', 'GET', `${USERS}/${s.target.pid}`)).status, 200, 'the person has its own page');
  // Bulk block: nothing is written for the stranger (an unknown key); the person answers as the single route does - it carries an account's Discord ID, so has_account.
  const res = await s.ok('off', 'POST', `${USERS}/block`, { keys: [s.stranger, s.target.pid], reason: 'Test' }, 200);
  assert.deepEqual(res.skipped.map((entry) => [entry.key, entry.reason]), [[s.stranger, 'not_found'], [s.target.pid, 'has_account']], JSON.stringify(res));
  assert.deepEqual(res.done, []);
  assert.equal(rowsOf(s, 'SELECT COUNT(*) AS n FROM guild_blocks WHERE user_id = ?', s.stranger)[0].n, 0, 'the stranger was not blocked');
  assert.equal((await s.call('off', 'POST', `/roster/${s.target.pid}/block`, { reason: 'Test' })).json.error, 'has_account', 'the single route says the same');
});

check('R3-1: any other tie lists the account and merges the person into it - an application here; the Discord-server members and linked owners keep their rows', async () => {
  const s = await strangerWorld();
  assert.equal((await s.call('off', 'PUT', `/roster/${s.target.pid}/account`, { userId: s.stranger })).status, 200);
  assert(!(await listOf(s, 'gm', 'nonmembers')).rows.some((entry) => entry.key === s.stranger));
  // The stranger applies to this guild: now it is tied.
  addApplication(s, { name: 'Strangerapp', userId: s.stranger });
  const nonmembers = await listOf(s, 'gm', 'nonmembers');
  const account = nonmembers.rows.find((entry) => entry.key === s.stranger);
  assert(account, 'the applicant is listed');
  assert.deepEqual([account.kind, account.main && account.main.name], ['account', 'Targetchar'], 'the person is the account\'s Main');
  assert(!(await listOf(s, 'gm', 'members')).rows.some((entry) => entry.key === s.target.pid), 'the person is no row of its own any more');
  assert.equal((await s.call('gm', 'GET', `${USERS}/${s.stranger}`)).status, 200);
  // A member by the Discord server who carries a recorded ID keeps the old behaviour: one row, the person is the Main.
  const second = await s.person({ name: 'Secondchar' });
  assert.equal((await s.call('off', 'PUT', `/roster/${second.pid}/account`, { userId: s.uids.m1 })).status, 200);
  const members = await listOf(s, 'gm', 'members');
  assert.equal(members.rows.find((entry) => entry.key === s.uids.m1).main.name, 'Secondchar');
  assert(!members.rows.some((entry) => entry.key === second.pid));
});

// ---------------------------------------------------------------------------
// R3-2: the guest ceiling

const guest = (extra = {}) => ({ name: 'Wanderer', class: 'MAGE', spec: 'Fire', note: 'hello', website: '', ...extra });
const nameOf = (i) => `Guest${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;

async function guestWorld() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.member('m1', 'Memberone');
  s.raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan', guestsOpen: true })).raid.id;
  return s;
}
const openView = (s, who, rid) => s.call(who, 'GET', `/api/open/${s.gid}/raids/${rid || s.raid}`);
const openSignUp = (s, who, body, rid) => s.call(who, 'POST', `/api/open/${s.gid}/raids/${rid || s.raid}`, body === undefined ? guest() : body);
const guestRows = (s, rid) => s.rows('SELECT * FROM raid_signups WHERE raid_id = ? AND guest = 1 ORDER BY signup_id', rid || s.raid);
async function makeLink(s, maxUses, rid) {
  const made = await s.ok('gm', 'POST', `/raids/${rid || s.raid}/join-links`, { maxUses }, 201);
  return { id: made.created.id, token: made.created.token };
}
const linkView = (s, link) => s.w.call(newJar(), 'POST', '/api/join/view', { token: link.token });
async function linkSignUp(s, link, name, extra = {}) {
  const jar = newJar();
  const viewed = await s.w.call(jar, 'POST', '/api/join/view', { token: link.token });
  if (viewed.status !== 200) return viewed;
  return s.w.call(jar, 'POST', '/api/join', { token: link.token, name, class: 'MAGE', spec: 'Frost', note: null, website: '', ...extra });
}
function fillGuests(s, rid, count, { start = 100, linkId = null } = {}) {
  for (let i = 0; i < count; i++) {
    s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, created_at, updated_at, guest, join_link_id)
      VALUES ('${rid}', 'raidsmith', ${start + i}, '${nameOf(start + i)}', 'signed', 0, 'Mage', 'Fire1', ${start + i}, '${s.gid}', 1, 1, 1, ${linkId ? `'${linkId}'` : 'NULL'})`);
  }
}
// Run `action` once, right before the next batch that carries a statement matching `pattern` (the Worker has read its numbers by then): a race with the INSERT.
function beforeNextWrite(s, pattern, action) {
  const db = s.w.db;
  const original = db.batch;
  db.batch = function patched(statements) {
    if (statements.some((statement) => pattern.test(statement.sql))) {
      db.batch = original;
      action();
    }
    return original.call(this, statements);
  };
  return () => { db.batch = original; };
}

check('R3-2: a raid with no guest limit takes 100 guests (link and open together), then 409 raid_full / 410 link_full; spotsLeft stays null; a set limit still rules', async () => {
  const s = await guestWorld();
  assert.equal((await s.one('SELECT guest_limit FROM raids WHERE id = ?', s.raid)).guest_limit, null, 'no limit is set');
  const link = await makeLink(s, 50);
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  fillGuests(s, s.raid, 98, { linkId: link.id });
  s.exec(`UPDATE raid_join_links SET uses = 40 WHERE id = '${link.id}'`);
  assert.equal((await openView(s, 'out1')).json.spotsLeft, null);
  const ninetyNinth = await openSignUp(s, 'out1', guest({ name: 'Openguesta' }));
  assert.deepEqual([ninetyNinth.status, ninetyNinth.json.spotsLeft], [201, null], ninetyNinth.text);
  const hundredth = await linkSignUp(s, link, 'Linkguesta');
  assert.equal(hundredth.status, 201, hundredth.text);
  assert.equal((await guestRows(s)).length, 100);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link.id)).uses, 41);
  // Over the ceiling: the answers of the limit.
  const open = await openSignUp(s, 'out2', guest({ name: 'Openguestb' }));
  assert.deepEqual([open.status, open.json.error], [409, 'raid_full'], open.text);
  const joined = await linkSignUp(s, link, 'Linkguestb');
  assert.deepEqual([joined.status, joined.json.error], [410, 'link_full'], joined.text);
  assert.equal((await linkView(s, link)).status, 410, 'the link view says it too');
  const view = await openView(s, 'out2');
  assert.deepEqual([view.status, view.json.spotsLeft], [200, null], 'the open view still opens and shows no number');
  assert.equal((await guestRows(s)).length, 100);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link.id)).uses, 41, 'a refused sign-up uses nothing');
  assert.equal((await s.rows("SELECT 1 FROM audit_log WHERE action IN ('signup.open', 'signup.guest')")).length, 2, 'the refused ones wrote no audit row');
  // Room again: one guest goes.
  await s.ok('gm', 'DELETE', `/raids/${s.raid}/guests/100`, undefined, 200);
  assert.equal((await openSignUp(s, 'out2', guest({ name: 'Openguestb' }))).status, 201);
  assert.equal((await openSignUp(s, 'out1', guest({ name: 'Openguestc' }))).status, 409, 'out1 has a sign-up already, and the raid is full again');
  // A limit below the ceiling rules as before; a limit of 100 is the ceiling itself.
  await s.ok('gm', 'PATCH', `/raids/${s.raid}`, { guestLimit: 100 }, 200);
  assert.equal((await openView(s, 'out2')).json.spotsLeft, 0);
  assert.equal((await openSignUp(s, 'out2', guest({ name: 'Openguestd' }))).status, 409);
});

check('R3-2: race-safe without a limit - 8 parallel open sign-ups and 8 parallel link sign-ups at 98 guests give exactly 2 each; a rival taking the last place after the reads stops the INSERT', async () => {
  const s = await guestWorld();
  for (let i = 1; i <= 8; i++) await s.outsider(`o${i}`, `Outsider${'abcdefgh'[i - 1]}`);
  fillGuests(s, s.raid, 98);
  const open = await Promise.all(Array.from({ length: 8 }, (_, i) => openSignUp(s, `o${i + 1}`, guest({ name: `Openguest${'abcdefgh'[i]}` }))));
  assert.deepEqual(open.map((res) => res.status).sort(), [201, 201, 409, 409, 409, 409, 409, 409], open.map((res) => res.text).join('\n'));
  assert(open.filter((res) => res.status === 409).every((res) => res.json.error === 'raid_full'));
  assert.equal((await guestRows(s)).length, 100, 'exactly the ceiling');

  const other = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-02', startTime: '20:00', zone: 'Karazhan', guestsOpen: true })).raid.id;
  const link = await makeLink(s, 50, other);
  fillGuests(s, other, 98);
  const names = ['Linkguesta', 'Linkguestb', 'Linkguestc', 'Linkguestd', 'Linkgueste', 'Linkguestf', 'Linkguestg', 'Linkguesth'];
  const viaLink = await Promise.all(names.map((name) => linkSignUp(s, link, name)));
  assert.deepEqual(viaLink.map((res) => res.status).sort(), [201, 201, 410, 410, 410, 410, 410, 410], viaLink.map((res) => res.text).join('\n'));
  assert.equal((await guestRows(s, other)).length, 100);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link.id)).uses, 2, 'only the two that got in used the link');

  // A rival lands between the Worker's reads and its INSERT, at one place left.
  const third = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-03', startTime: '20:00', zone: 'Karazhan', guestsOpen: true })).raid.id;
  const link3 = await makeLink(s, 10, third);
  fillGuests(s, third, 99);
  await s.outsider('rival1', 'Rivalone');
  let restore = beforeNextWrite(s, /^\s*INSERT INTO raid_signups/, () => fillGuests(s, third, 1, { start: 900 }));
  const lost = await openSignUp(s, 'rival1', guest({ name: 'Openrival' }), third);
  restore();
  assert.deepEqual([lost.status, lost.json.error], [409, 'raid_full'], lost.text);
  assert.equal((await guestRows(s, third)).length, 100);
  await s.exec(`DELETE FROM raid_signups WHERE raid_id = '${third}' AND signup_id = 900`);
  restore = beforeNextWrite(s, /^\s*INSERT INTO raid_signups/, () => fillGuests(s, third, 1, { start: 901 }));
  const linkLost = await linkSignUp(s, link3, 'Linkrival');
  restore();
  assert.deepEqual([linkLost.status, linkLost.json.error], [410, 'link_full'], linkLost.text);
  assert.equal((await guestRows(s, third)).length, 100);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link3.id)).uses, 0, 'no use counted');
});

check('R3-2: the guard clause itself - one row at 99 guests with no limit, none at 100; the limit still wins over the ceiling', async () => {
  const s = await guestWorld();
  const { guestRoom, GUEST_CEILING } = await load('worker/routes/join.js');
  assert.equal(GUEST_CEILING, 100);
  const attempt = async (name) => {
    const now = s.w.clock.now;
    const result = await s.w.db.batch([s.w.db.prepare(
      `INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, created_at, updated_at, guest)
       SELECT ?, 'raidsmith', (SELECT COALESCE(MAX(signup_id), 0) + 1 FROM raid_signups WHERE raid_id = ?), ?, 'signed', 0, 'Mage', 'Fire1', 1, ?, ?, ?, 1
        WHERE ${guestRoom.sql}`,
    ).bind(s.raid, s.raid, name, s.gid, now, now, ...guestRoom.params(s.raid))]);
    return result[0].meta.changes;
  };
  fillGuests(s, s.raid, 98);
  assert.equal(await attempt('Rowa'), 1, '98 guests, no limit: the 99th');
  assert.equal(await attempt('Rowb'), 1, '99 guests, no limit: the 100th');
  assert.equal(await attempt('Rowc'), 0, '100 guests, no limit: refused');
  s.exec(`UPDATE raids SET guest_limit = 50 WHERE id = '${s.raid}'`);
  assert.equal(await attempt('Rowd'), 0, 'a limit of 50 at 100 guests: refused');
  const { guestsAtLimit, limitSpotsOf } = await load('worker/routes/join.js');
  assert.deepEqual([guestsAtLimit({ guest_limit: null, guests: 99 }), guestsAtLimit({ guest_limit: null, guests: 100 }), guestsAtLimit({ guest_limit: 3, guests: 3 })], [false, true, true]);
  assert.equal(limitSpotsOf({ guest_limit: null, guests: 100 }), null, 'spotsLeft is no number without a limit');
});

// ---------------------------------------------------------------------------
// R3-3: look-alike names

const CYRILLIC_A = 'а';
const LOOKALIKE = `M${CYRILLIC_A}inone`;

check('R3-3: mixesAlphabets - one alphabet passes (Latin with accents and marks, Cyrillic, Greek, Han and Kana together), a mix of alphabets does not', async () => {
  const { mixesAlphabets } = await load('worker/roster-data.js');
  for (const name of ['Mainone', 'Zoë', 'Émile', 'élan', 'Майн', 'Αθηνά', '山田太郎', 'ヤマダ山', '영희']) {
    assert.equal(mixesAlphabets(name), false, name);
  }
  for (const name of [LOOKALIKE, `Alαx`, `Маiн`, 'Mainonе', '山Yamada', '𝐌ainone']) assert.equal(mixesAlphabets(name), true, name);
});

check('R3-3: a guest name that mixes alphabets is 400 on a join link and on an open raid (nothing stored); a look-alike of a member is no longer 409 on_roster or already_joined', async () => {
  const s = await guestWorld();
  await s.person({ name: 'Mainone' });
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  const link = await makeLink(s, 10);
  const asked = await linkSignUp(s, link, LOOKALIKE);
  assert.deepEqual([asked.status, asked.json.error, asked.json.field, asked.json.message], [400, 'bad_request', 'name', 'Use letters from one alphabet.'], asked.text);
  const open = await openSignUp(s, 'out1', guest({ name: LOOKALIKE }));
  assert.deepEqual([open.status, open.json.error, open.json.field, open.json.message], [400, 'bad_request', 'name', 'Use letters from one alphabet.'], open.text);
  assert.equal((await guestRows(s)).length, 0);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link.id)).uses, 0);
  // The real name is still the roster's.
  const plain = await linkSignUp(s, link, 'Mainone');
  assert.deepEqual([plain.status, plain.json.error], [409, 'on_roster']);
  // A look-alike of a guest who is already in.
  assert.equal((await openSignUp(s, 'out1', guest({ name: 'Wanderer' }))).status, 201);
  const second = await openSignUp(s, 'out2', guest({ name: `W${CYRILLIC_A}nderer` }));
  assert.deepEqual([second.status, second.json.error], [400, 'bad_request'], second.text);
  assert.equal((await openSignUp(s, 'out2', guest({ name: 'Wanderer' }))).json.error, 'already_joined');
  // Single-alphabet names are guests like any other.
  const cyrillic = await linkSignUp(s, link, 'Майни');
  assert.equal(cyrillic.status, 201, cyrillic.text);
  const accented = await openSignUp(s, 'out2', guest({ name: 'Zoë' }));
  assert.equal(accented.status, 201, accented.text);
});

check('R3-3: the roster routes that read a typed name refuse a mix of alphabets with the same 400; names already stored are not touched', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  const base = { teamId: s.tids[0], class: 'MAGE', mainSpec: 'Fire', offSpec: null };
  const created = await s.call('gm', 'POST', '/roster', { ...base, name: LOOKALIKE });
  assert.deepEqual([created.status, created.json.error, created.json.field, created.json.message], [400, 'bad_request', 'name', 'Use letters from one alphabet.'], created.text);
  const person = await s.person({ name: 'Realname' });
  const renamed = await s.call('gm', 'PATCH', `/roster/${person.pid}/characters/${person.cid}`, { name: `R${CYRILLIC_A}alname` });
  assert.deepEqual([renamed.status, renamed.json.message], [400, 'Use letters from one alphabet.'], renamed.text);
  const alt = await s.call('gm', 'POST', `/roster/${person.pid}/characters`, { class: 'ROGUE', mainSpec: 'Combat', offSpec: null, name: `Alt${CYRILLIC_A}` });
  assert.deepEqual([alt.status, alt.json.message], [400, 'Use letters from one alphabet.'], alt.text);
  assert.equal((await s.call('gm', 'POST', '/roster', { ...base, name: 'Майни' })).status, 201, 'one alphabet is fine');
  // A name stored before the rule stays exactly as it is.
  exec(s, 'UPDATE characters SET name = ?, name_key = ? WHERE id = ?', LOOKALIKE, LOOKALIKE.toLowerCase(), person.cid);
  const roster = await s.ok('gm', 'GET', `/roster?team=${s.tids[0]}`, undefined, 200);
  assert(JSON.stringify(roster).includes(LOOKALIKE), 'the stored name is shown unchanged');
  assert.equal(rowsOf(s, 'SELECT name FROM characters WHERE id = ?', person.cid)[0].name, LOOKALIKE);
});

runChecks(checks);
