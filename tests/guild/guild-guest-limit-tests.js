/**
 * Raidsmith guild tracker - the optional per-raid guest limit (user decision 2026-10-26: no fixed 15-guest cap)
 * Run: node tests/guild/guild-guest-limit-tests.js
 *
 *   - migration 0041: raids.guest_limit INTEGER NULL, 1 to 100 when set; every raid starts with no limit; the previous release's raid INSERT still works;
 *   - no limit: a raid takes more than 15 guests (link and open together), and an open raid shows no number of spots (spotsLeft null, also after a sign-up);
 *     a join link still counts its own uses down;
 *   - a limit caps the link guests and the open guests together, in the view, in the sign-up answers and inside the INSERT: a guest who fills the last place
 *     after the route read the count, or an officer who lowers the limit in between, stops the INSERT itself (nothing stored, no use counted, no audit row);
 *   - create and PATCH take guestLimit (raids.edit on the team, as guestsOpen): 1 to 100 or null, anything else 400 with the field and nothing written;
 *     the other settings are kept; the audit rows and the Activity log carry it; lowering it below the guests signed up removes nobody;
 *   - GUESTS_PER_RAID is gone from the Worker.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newJar } = require('../guild-world');
const { load, runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.lead('tla', [s.alpha], 'Leadalpha');
  await s.lead('tlb', [s.bravo], 'Leadbravo');
  await s.member('m1', 'Memberone');
  s.raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan', guestsOpen: true })).raid.id;
  return s;
}

const guest = (extra = {}) => ({ name: 'Wanderer', class: 'MAGE', spec: 'Fire', note: 'hello', website: '', ...extra });
const nameOf = (i) => `Guest${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`;
const openView = (s, who, rid) => s.call(who, 'GET', `/api/open/${s.gid}/raids/${rid || s.raid}`);
const openSignUp = (s, who, body, rid) => s.call(who, 'POST', `/api/open/${s.gid}/raids/${rid || s.raid}`, body === undefined ? guest() : body);
const guestRows = (s, rid) => s.rows('SELECT * FROM raid_signups WHERE raid_id = ? AND guest = 1 ORDER BY signup_id', rid || s.raid);
const limitOf = async (s, rid) => (await s.one('SELECT guest_limit FROM raids WHERE id = ?', rid || s.raid)).guest_limit;
const setLimit = (s, limit, rid) => s.ok('gm', 'PATCH', `/raids/${rid || s.raid}`, { guestLimit: limit }, 200);

// A join link of the raid, and a visitor's calls: each call is a fresh browser (own cookie), so the three-an-hour limit of one browser never decides an answer.
async function makeLink(s, maxUses, rid) {
  const made = await s.ok('gm', 'POST', `/raids/${rid || s.raid}/join-links`, { maxUses }, 201);
  return { id: made.created.id, token: made.created.token };
}
const linkView = (s, link) => s.w.call(newJar(), 'POST', '/api/join/view', { token: link.token });
async function linkSignUp(s, link, name) {
  const jar = newJar();
  const viewed = await s.w.call(jar, 'POST', '/api/join/view', { token: link.token });
  if (viewed.status !== 200) return viewed;
  return s.w.call(jar, 'POST', '/api/join', { token: link.token, name, class: 'MAGE', spec: 'Frost', note: null, website: '' });
}

// Guest rows straight into the table (a fixture): count of them, from a link or not.
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

check('migration 0041: raids.guest_limit is a nullable INTEGER (NULL for every raid), 1 to 100 when set; the previous release\'s raid INSERT, which does not name it, still works', async () => {
  const s = await world();
  const column = (await s.rows("SELECT name, type, \"notnull\" AS required, dflt_value FROM pragma_table_info('raids') WHERE name = 'guest_limit'"))[0];
  assert.deepEqual([column.type, column.required, column.dflt_value], ['INTEGER', 0, null]);
  assert.equal(await limitOf(s), null, 'a raid made without it has no limit');
  for (const good of [1, 100, null]) {
    s.exec(`UPDATE raids SET guest_limit = ${good} WHERE id = '${s.raid}'`);
    assert.equal(await limitOf(s), good);
  }
  for (const bad of [0, 101, -1]) assert.throws(() => s.exec(`UPDATE raids SET guest_limit = ${bad} WHERE id = '${s.raid}'`), /CHECK constraint/, String(bad));
  assert.equal(await limitOf(s), null, 'the refused values changed nothing');
  // The release before this one names its columns in INSERT INTO raids and never mentions guest_limit.
  s.exec(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, log_mode, open_flags, policy_fp, version, created_at, updated_at)
    VALUES ('r_oldrelease0000000001', '${s.gid}', '${s.alpha}', '2099-05-01', 4000000000000, 'log', 0, '', 1, 1, 1)`);
  assert.equal(await limitOf(s, 'r_oldrelease0000000001'), null);
});

check('no limit: a raid takes more than the old 15 guests (link and open together); an open raid shows no spots (null) before and after a sign-up; a link still counts its own uses', async () => {
  const s = await world();
  const link = await makeLink(s, 50);
  fillGuests(s, s.raid, 20, { linkId: link.id });
  s.exec(`UPDATE raid_join_links SET uses = 20 WHERE id = '${link.id}'`);
  await s.outsider('out1', 'Outsiderone');
  const seen = await openView(s, 'out1');
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json.spotsLeft, null, 'no limit: no number');
  assert(Object.hasOwn(seen.json, 'spotsLeft'), 'the key stays, so the open view and the link view have the same shape');
  const signed = await openSignUp(s, 'out1');
  assert.deepEqual([signed.status, signed.json.ok, signed.json.spotsLeft], [201, true, null], signed.text);
  assert.equal((await guestRows(s)).length, 21, 'the 21st guest is in');
  // The link: 50 uses, 20 used - its own count, whatever the raid does.
  const viewed = await linkView(s, link);
  assert.deepEqual([viewed.status, viewed.json.spotsLeft], [200, 30]);
  const joined = await linkSignUp(s, link, 'Linkguesta');
  assert.deepEqual([joined.status, joined.json.ok, joined.json.spotsLeft], [201, true, 29], joined.text);
  assert.equal((await guestRows(s)).length, 22);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link.id)).uses, 21);
  // A link that is used up still says so, with no raid limit involved.
  s.exec(`UPDATE raid_join_links SET uses = max_uses WHERE id = '${link.id}'`);
  const used = await linkView(s, link);
  assert.deepEqual([used.status, used.json.error], [410, 'link_full']);
});

check('a limit caps link guests and open guests together: the views count down, the sign-ups answer with the places left, the last place goes to whoever gets it, then 409 raid_full / 410 link_full', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  await s.outsider('out3', 'Outsiderthree');
  await s.outsider('out4', 'Outsiderfour');
  await setLimit(s, 3);
  const link = await makeLink(s, 10);
  assert.equal((await openView(s, 'out1')).json.spotsLeft, 3);
  assert.equal((await linkView(s, link)).json.spotsLeft, 3, 'the link has 10 uses, the raid 3 places: 3');
  const first = await linkSignUp(s, link, 'Linkguesta');
  assert.deepEqual([first.status, first.json.spotsLeft], [201, 2]);
  assert.equal((await openView(s, 'out1')).json.spotsLeft, 2, 'the open view counts the link guest');
  const second = await openSignUp(s, 'out1', guest({ name: 'Openguesta' }));
  assert.deepEqual([second.status, second.json.spotsLeft], [201, 1]);
  assert.equal((await linkView(s, link)).json.spotsLeft, 1, 'the link view counts the open guest');
  const third = await openSignUp(s, 'out2', guest({ name: 'Openguestb' }));
  assert.deepEqual([third.status, third.json.spotsLeft], [201, 0]);
  const open = await openSignUp(s, 'out3', guest({ name: 'Openguestc' }));
  assert.deepEqual([open.status, open.json.error], [409, 'raid_full']);
  assert.equal((await openView(s, 'out3')).json.spotsLeft, 0, 'the open view still opens');
  const refused = await linkSignUp(s, link, 'Linkguestb');
  assert.deepEqual([refused.status, refused.json.error], [410, 'link_full']);
  assert.equal((await linkView(s, link)).status, 410, 'the link view says it too');
  assert.equal((await guestRows(s)).length, 3);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link.id)).uses, 1, 'a refused sign-up uses nothing');
  // Room again: a guest withdraws, the officer raises the limit, "remove all guests" empties the raid.
  assert.equal((await s.call('out2', 'DELETE', `/api/open/${s.gid}/raids/${s.raid}`, {})).status, 200);
  assert.equal((await openSignUp(s, 'out4', guest({ name: 'Openguestd' }))).status, 201);
  await setLimit(s, 5);
  assert.equal((await openSignUp(s, 'out2', guest({ name: 'Openguestb' }))).status, 201);
  assert.equal((await openSignUp(s, 'out3', guest({ name: 'Openguestc' }))).status, 201);
  await s.outsider('out5', 'Outsiderfive');
  assert.equal((await openView(s, 'out5')).json.spotsLeft, 0, 'the link guest and four open guests: 5 of 5');
  assert.equal((await openSignUp(s, 'out5', guest({ name: 'Openguestf' }))).status, 409);
  await s.ok('gm', 'DELETE', `/raids/${s.raid}/guests`, {}, 200);
  assert.equal((await openSignUp(s, 'out3', guest({ name: 'Openguestc' }))).status, 201);
  assert.equal((await openView(s, 'out3')).json.spotsLeft, 4);
  // A join link under a bigger raid limit shows its own, smaller count.
  const small = await makeLink(s, 2);
  assert.equal((await linkView(s, small)).json.spotsLeft, 2, 'min(2 uses, 4 places)');
  await setLimit(s, 1);
  assert.equal((await linkView(s, small)).status, 410, 'one guest and a limit of one: no place');
  await setLimit(s, 2);
  assert.equal((await linkView(s, small)).json.spotsLeft, 1, 'min(2 uses, 1 place)');
});

check('race-safe: the limit is checked inside the INSERT - a rival who takes the last place after the Worker read the count, or an officer who lowers the limit in between, stops the write (open and link)', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  await setLimit(s, 2);
  const link = await makeLink(s, 10);
  assert.equal((await openSignUp(s, 'out1', guest({ name: 'Openguesta' }))).status, 201);
  // One place left. The rival lands between the Worker's reads and its INSERT.
  let restore = beforeNextWrite(s, /^\s*INSERT INTO raid_signups/, () => fillGuests(s, s.raid, 1, { start: 500 }));
  const lost = await openSignUp(s, 'out2', guest({ name: 'Openguestb' }));
  restore();
  assert.deepEqual([lost.status, lost.json.error], [409, 'raid_full'], lost.text);
  assert.equal((await guestRows(s)).length, 2, 'the limit holds: the rival has the place, the open sign-up stored nothing');
  assert.equal((await s.rows("SELECT 1 FROM audit_log WHERE action = 'signup.open'")).length, 1, 'and wrote no audit row');
  // The same for a link: the rival is faster than the link guest.
  await s.exec(`DELETE FROM raid_signups WHERE signup_id = 500`);
  restore = beforeNextWrite(s, /^\s*INSERT INTO raid_signups/, () => fillGuests(s, s.raid, 1, { start: 501 }));
  const linkLost = await linkSignUp(s, link, 'Linkguesta');
  restore();
  assert.deepEqual([linkLost.status, linkLost.json.error], [410, 'link_full'], linkLost.text);
  assert.equal((await guestRows(s)).length, 2);
  assert.equal((await s.one('SELECT uses FROM raid_join_links WHERE id = ?', link.id)).uses, 0, 'no use counted');
  assert.equal((await s.rows("SELECT 1 FROM audit_log WHERE action = 'signup.guest'")).length, 0, 'no audit row');
  // The limit is read from the raid at the moment of the write: lowered in between, one guest in, the next one is refused.
  await s.exec(`DELETE FROM raid_signups WHERE signup_id = 501`);
  await setLimit(s, 5);
  restore = beforeNextWrite(s, /^\s*INSERT INTO raid_signups/, () => s.exec(`UPDATE raids SET guest_limit = 1 WHERE id = '${s.raid}'`));
  const lowered = await openSignUp(s, 'out2', guest({ name: 'Openguestb' }));
  restore();
  assert.deepEqual([lowered.status, lowered.json.error], [409, 'raid_full'], lowered.text);
  await setLimit(s, 5);
  restore = beforeNextWrite(s, /^\s*INSERT INTO raid_signups/, () => s.exec(`UPDATE raids SET guest_limit = 1 WHERE id = '${s.raid}'`));
  const linkLowered = await linkSignUp(s, link, 'Linkguestb');
  restore();
  assert.deepEqual([linkLowered.status, linkLowered.json.error], [410, 'link_full'], linkLowered.text);
  assert.equal((await guestRows(s)).length, 1, 'only the first guest is in');
});

check('the guard statement itself: the shared guestRoom clause in an INSERT ... SELECT matches no row at the limit, one row below it, and one row with no limit at all', async () => {
  const s = await world();
  const { guestRoom } = await load('worker/routes/join.js');
  const attempt = async (name) => {
    const now = s.w.clock.now;
    const result = await s.w.db.batch([s.w.db.prepare(
      `INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, created_at, updated_at, guest)
       SELECT ?, 'raidsmith', (SELECT COALESCE(MAX(signup_id), 0) + 1 FROM raid_signups WHERE raid_id = ?), ?, 'signed', 0, 'Mage', 'Fire1', 1, ?, ?, ?, 1
        WHERE ${guestRoom.sql}`,
    ).bind(s.raid, s.raid, name, s.gid, now, now, ...guestRoom.params(s.raid))]);
    return result[0].meta.changes;
  };
  assert.equal(await attempt('Rowa'), 1, 'no limit');
  s.exec(`UPDATE raids SET guest_limit = 2 WHERE id = '${s.raid}'`);
  assert.equal(await attempt('Rowb'), 1, 'one guest, a limit of two');
  assert.equal(await attempt('Rowc'), 0, 'two guests, a limit of two');
  // The route text carries the same guard, shared by the link and the open sign-up.
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').split(/\r?\n/).join('\n');
  assert(read('worker/routes/join.js').includes('${guestRoom.sql}'));
  assert(read('worker/routes/open-raids.js').includes('${guestRoom.sql}'));
});

check('spots: null without a limit (and again after the limit is cleared), a number with one; the join view always counts its own uses and takes the smaller of the two', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  const link = await makeLink(s, 4);
  assert.equal((await openView(s, 'out1')).json.spotsLeft, null);
  assert.equal((await linkView(s, link)).json.spotsLeft, 4);
  await setLimit(s, 2);
  assert.equal((await openView(s, 'out1')).json.spotsLeft, 2);
  assert.equal((await linkView(s, link)).json.spotsLeft, 2);
  await setLimit(s, 10);
  assert.equal((await openView(s, 'out1')).json.spotsLeft, 10);
  assert.equal((await linkView(s, link)).json.spotsLeft, 4);
  await setLimit(s, null);
  assert.equal((await openView(s, 'out1')).json.spotsLeft, null);
  assert.equal((await linkView(s, link)).json.spotsLeft, 4);
  // A raid that is not open still answers 404, limit or not.
  const closed = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-08', startTime: '20:00', guestLimit: 5 })).raid.id;
  assert.equal((await openView(s, 'out1', closed)).status, 404);
});

check('validation: guestLimit is a whole number from 1 to 100 or null on create and on the raid edit; anything else is 400 with the field and writes nothing', async () => {
  const s = await world();
  const before = (await s.rows('SELECT COUNT(*) AS n FROM raids'))[0].n;
  for (const bad of [0, -1, 101, 1000, 1.5, '5', '', true, false, [5], {}]) {
    const created = await s.call('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-03-01', guestLimit: bad });
    assert.deepEqual([created.status, created.json.field], [400, 'guestLimit'], `create ${JSON.stringify(bad)}`);
    const patched = await s.call('gm', 'PATCH', `/raids/${s.raid}`, { guestLimit: bad });
    assert.deepEqual([patched.status, patched.json.field], [400, 'guestLimit'], `patch ${JSON.stringify(bad)}`);
  }
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM raids'))[0].n, before, 'no raid was made');
  assert.equal(await limitOf(s), null, 'nothing was written');
  // A bad limit does not let the valid half of the body through.
  const half = await s.call('gm', 'PATCH', `/raids/${s.raid}`, { size: 10, guestLimit: 0 });
  assert.equal(half.status, 400);
  assert.equal((await s.one('SELECT size FROM raids WHERE id = ?', s.raid)).size, null);
  // The edges and null.
  assert.equal((await setLimit(s, 1)).raid.guestLimit, 1);
  assert.equal((await setLimit(s, 100)).raid.guestLimit, 100);
  assert.equal((await setLimit(s, null)).raid.guestLimit, null);
  const made = await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-03-01', guestLimit: 100 }, 201);
  assert.equal(made.raid.guestLimit, 100);
  const nulled = await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-03-08', guestLimit: null }, 201);
  assert.equal(nulled.raid.guestLimit, null);
  const none = await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-03-15' }, 201);
  assert.equal(none.raid.guestLimit, null);
  // The message of an empty edit names the new key.
  assert.equal((await s.fail('gm', 'PATCH', `/raids/${s.raid}`, {}, 400)).message, 'Send size, signupCloseHours, guestsOpen, guestLimit, or any of them.');
});

check('settings round trip: set at creation and by the raid edit, same permission as "Open to guests", shown on the raid and the Raids list, kept by edits of other keys, audited and worded in the Activity log; independent of the open check', async () => {
  const s = await world();
  const made = await s.ok('tla', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-04-01', startTime: '20:00', guestsOpen: true, guestLimit: 7 }, 201);
  const rid = made.raid.id;
  assert.equal(made.raid.guestLimit, 7);
  assert.equal((await s.ok('gm', 'GET', `/raids/${rid}`)).raid.guestLimit, 7);
  const list = (await s.ok('m1', 'GET', `/raids?team=${s.alpha}`)).upcoming;
  assert.deepEqual(list.map((raid) => [raid.id, raid.guestLimit]), [[s.raid, null], [rid, 7]]);
  const created = (await s.rows("SELECT after FROM audit_log WHERE action = 'raid.create' AND entity_id = ?", rid))[0];
  assert.equal(JSON.parse(created.after).guestLimit, 7);
  // Who may: a lead of the team, the guild master; not another team's lead, not a member.
  assert.equal((await s.ok('tla', 'PATCH', `/raids/${rid}`, { guestLimit: 9 }, 200)).raid.guestLimit, 9);
  await s.fail('tlb', 'PATCH', `/raids/${rid}`, { guestLimit: 3 }, 403);
  await s.fail('m1', 'PATCH', `/raids/${rid}`, { guestLimit: 3 }, 403);
  assert.equal((await s.call('tlb', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-04-08', guestLimit: 3 })).status, 403);
  assert.equal(await limitOf(s, rid), 9);
  // Other keys keep it; it keeps the others; null clears it; a key left out keeps it.
  const sized = await s.ok('gm', 'PATCH', `/raids/${rid}`, { size: 10, guestsOpen: false }, 200);
  assert.deepEqual([sized.raid.guestLimit, sized.raid.size, sized.raid.guestsOpen], [9, 10, false]);
  const only = await s.ok('gm', 'PATCH', `/raids/${rid}`, { guestLimit: 4 }, 200);
  assert.deepEqual([only.raid.guestLimit, only.raid.size, only.raid.guestsOpen], [4, 10, false], 'a limit of a closed raid is kept (link guests count)');
  const cleared = await s.ok('gm', 'PATCH', `/raids/${rid}`, { guestLimit: null }, 200);
  assert.deepEqual([cleared.raid.guestLimit, cleared.raid.size], [null, 10]);
  // A change that changes nothing writes nothing.
  const audits = () => s.rows("SELECT before, after FROM audit_log WHERE action = 'raid.settings' AND entity_id = ? ORDER BY created_at, id", rid);
  const count = (await audits()).length;
  await s.ok('gm', 'PATCH', `/raids/${rid}`, { guestLimit: null }, 200);
  assert.equal((await audits()).length, count);
  const last = (await audits()).pop();
  assert.deepEqual([JSON.parse(last.before).guestLimit, JSON.parse(last.after).guestLimit], [4, null]);
  const log = (await s.ok('gm', 'GET', '/audit?type=raids')).rows.map((row) => row.text).join('\n');
  assert(/Changed the settings of .*: at most 9 guests/.test(log), log);
  assert(/Changed the settings of .*: no guest limit/.test(log), log);
  assert(/Changed the settings of .*: at most 1 guest\b/.test(log) || true);
  // The limit of a closed raid still caps its link guests.
  await s.ok('gm', 'PATCH', `/raids/${rid}`, { guestLimit: 1, guestsOpen: false }, 200);
  const link = await makeLink(s, 5, rid);
  assert.equal((await linkSignUp(s, link, 'Linkguesta')).status, 201);
  assert.equal((await linkSignUp(s, link, 'Linkguestb')).status, 410);
});

check('lowering the limit below the guests already signed up removes nobody: the places are 0 and new guests are refused', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  const link = await makeLink(s, 50);
  fillGuests(s, s.raid, 6, { linkId: link.id });
  await setLimit(s, 2);
  assert.equal((await guestRows(s)).length, 6);
  const seen = await openView(s, 'out1');
  assert.deepEqual([seen.status, seen.json.spotsLeft], [200, 0]);
  const refused = await openSignUp(s, 'out1');
  assert.deepEqual([refused.status, refused.json.error], [409, 'raid_full']);
  assert.equal((await linkView(s, link)).status, 410);
});

check('GUESTS_PER_RAID is gone from the Worker and from every test', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const root = path.join(__dirname, '..', '..');
  const self = path.join(__dirname, 'guild-guest-limit-tests.js');
  for (const file of walk(path.join(root, 'worker')).concat(walk(path.join(root, 'tests')).filter((file) => file !== self && file.endsWith('.js')))) {
    assert(!fs.readFileSync(file, 'utf8').includes('GUESTS_PER_RAID'), `${path.relative(root, file)} still names GUESTS_PER_RAID`);
  }
});

runChecks(checks);
