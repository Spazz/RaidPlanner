/**
 * Raidsmith guild tracker - lane B3 of the user-hierarchy build: open raids (U R8-Q3, sec A9-07) and the guild's own list of raid join links (U R7-Q1)
 * Run: node tests/guild/guild-b3-openraids-tests.js
 *
 *   - "Open to guests" (guestsOpen) is set when a raid is created and by the raid edit (raids.edit) and shows on the Raids list and the raid;
 *   - GET/POST/DELETE /api/open/:gid/raids/:rid: a signed-in non-member sees exactly the join-link view, signs up as a guest (guest = 1, no link, attached to the
 *     account), is refused when the name is on the roster, signs up once per account, withdraws; a raid that is not open answers 404 on all of them; a blocked
 *     account is refused; the caps (the raid's optional guest limit with the link guests counted too, 5 an hour, 10 a day) hold inside the INSERT; Delete my data removes the rows;
 *   - the public page and guest links mark open upcoming raids (open + raidId) and no other;
 *   - DELETE /raids/:rid/guests removes every guest of a raid;
 *   - GET /join-links and DELETE /join-links/:jid: guild.access lists and turns off every link whoever made it; a link keeps working when its maker is demoted
 *     or gone.
 */
const assert = require('node:assert/strict');
const { runChecks, scenario } = require('../guild-b3-world');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.officer('o2', 'Officertwo');
  await s.lead('tla', [s.alpha], 'Leadalpha');
  await s.lead('tlb', [s.bravo], 'Leadbravo');
  await s.member('m1', 'Memberone');
  s.m1 = await s.person({ name: 'Rosterguy' });
  await s.link(s.m1.pid, 'm1');
  s.raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan', guestsOpen: true })).raid.id;
  s.closed = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-08', startTime: '20:00', zone: 'Karazhan' })).raid.id;
  return s;
}
const open = (raid) => `/api/open/${raid.gid}/raids/${raid.rid}`;
const guest = (extra = {}) => ({ name: 'Wanderer', class: 'MAGE', spec: 'Fire', note: 'hello', website: '', ...extra });
const view = (s, who, rid) => s.call(who, 'GET', `/api/open/${s.gid}/raids/${rid || s.raid}`);
const signUp = (s, who, body, rid) => s.call(who, 'POST', `/api/open/${s.gid}/raids/${rid || s.raid}`, body === undefined ? guest() : body);
const withdraw = (s, who, rid) => s.call(who, 'DELETE', `/api/open/${s.gid}/raids/${rid || s.raid}`, {});
const guestRows = (s, rid) => s.rows("SELECT * FROM raid_signups WHERE raid_id = ? AND guest = 1 ORDER BY signup_id", rid || s.raid);

check('guestsOpen: set at creation (default off) and by the raid edit for whoever may edit the raid; it shows on the raid and on the Raids list; type-checked and audited', async () => {
  const s = await world();
  const detail = await s.ok('gm', 'GET', `/raids/${s.raid}`);
  assert.equal(detail.raid.guestsOpen, true);
  assert.equal((await s.ok('gm', 'GET', `/raids/${s.closed}`)).raid.guestsOpen, false);
  const list = (await s.ok('tla', 'GET', `/raids?team=${s.alpha}`)).upcoming;
  assert.deepEqual(list.map((r) => [r.id, r.guestsOpen]), [[s.raid, true], [s.closed, false]]);
  // The edit: a lead of the team, not of another team, not a member.
  const patched = await s.ok('tla', 'PATCH', `/raids/${s.closed}`, { guestsOpen: true }, 200);
  assert.equal(patched.raid.guestsOpen, true);
  await s.fail('tlb', 'PATCH', `/raids/${s.closed}`, { guestsOpen: false }, 403);
  await s.fail('m1', 'PATCH', `/raids/${s.closed}`, { guestsOpen: false }, 403);
  assert.equal((await s.fail('tla', 'PATCH', `/raids/${s.closed}`, { guestsOpen: 'yes' }, 400)).field, 'guestsOpen');
  assert.equal((await s.fail('tla', 'PATCH', `/raids/${s.closed}`, {}, 400)).message, 'Send size, signupCloseHours, guestsOpen, guestLimit, or any of them.');
  assert.equal((await s.call('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-03-01', guestsOpen: 'x' })).json.field, 'guestsOpen');
  // It does not disturb the other settings.
  const both = await s.ok('tla', 'PATCH', `/raids/${s.closed}`, { size: 10, guestsOpen: false }, 200);
  assert.deepEqual([both.raid.guestsOpen, both.raid.size], [false, 10]);
  const audited = await s.rows("SELECT after FROM audit_log WHERE action = 'raid.settings' ORDER BY created_at, id");
  assert.deepEqual(audited.map((r) => JSON.parse(r.after).guestsOpen), [true, false]);
  const created = await s.rows("SELECT after FROM audit_log WHERE action = 'raid.create' ORDER BY created_at, id");
  assert.equal(JSON.parse(created[0].after).guestsOpen, true);
});

check('the view: exactly the join-link view (guild, raid, spots, choices) for a signed-in non-member, nothing of the roster; closed, unknown, started and foreign raids are 404; signed out is 401', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  const res = await view(s, 'out1');
  assert.equal(res.status, 200, res.text);
  const link = await s.ok('gm', 'POST', `/raids/${s.raid}/join-links`, { maxUses: 3 });
  const joinView = (await s.w.call({}, 'POST', '/api/join/view', { token: link.created.token })).json;
  for (const key of ['guild', 'raid', 'rosterOptions', 'noteMax']) assert.deepEqual(res.json[key], joinView[key], key);
  assert.deepEqual(Object.keys(res.json).sort(), [...Object.keys(joinView), 'member', 'mine'].sort());
  assert.deepEqual([res.json.spotsLeft, res.json.member, res.json.mine], [null, false, null], 'no guest limit: no spots to show');
  assert.deepEqual([res.json.guild.name, res.json.raid.teamName, res.json.raid.zone], ['Writers B3', 'Alpha', 'Karazhan']);
  for (const word of ['Rosterguy', 'Memberone', 'Officerone']) assert(!res.text.includes(word), `the view leaks ${word}`);
  // Not open: every kind of "no".
  assert.equal((await view(s, 'out1', s.closed)).status, 404);
  assert.equal((await view(s, 'out1', 'r_AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.equal((await s.call('out1', 'GET', `/api/open/g_AAAAAAAAAAAAAAAAAAAAAA/raids/${s.raid}`)).status, 404);
  assert.equal((await s.call('out1', 'GET', `/api/open/${s.gid}/raids/not-an-id`)).status, 404);
  assert.equal((await signUp(s, 'out1', guest(), s.closed)).status, 404);
  assert.equal((await withdraw(s, 'out1', s.closed)).status, 404);
  const past = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2026-10-01', startTime: '20:00', guestsOpen: true })).raid.id;
  assert.equal((await view(s, 'out1', past)).status, 404, 'a raid that has started is not open');
  assert.equal((await signUp(s, 'out1', guest(), past)).status, 404);
  await s.ok('gm', 'PATCH', `/teams/${s.alpha}`, { archived: true }, 200);
  assert.equal((await view(s, 'out1')).status, 404, 'an archived team takes nobody');
  assert.equal((await s.w.call({}, 'GET', open({ gid: s.gid, rid: s.raid }))).status, 401);
  assert.equal((await s.w.call({}, 'POST', open({ gid: s.gid, rid: s.raid }), guest())).status, 401);
});

check('sign up: a guest sign-up attached to the account (guest 1, no link, no person), one per account, audited; the officers\' sign-up list shows it', async () => {
  const s = await world();
  const uid = await s.outsider('out1', 'Outsiderone');
  const res = await signUp(s, 'out1');
  assert.equal(res.status, 201, res.text);
  assert.deepEqual([res.json.ok, res.json.spotsLeft], [true, null]);
  const [row] = await guestRows(s);
  assert.deepEqual(
    [row.source, row.guest, row.join_link_id, row.guest_user_id, row.player_id, row.character_id, row.nickname, row.class_name, row.kind, row.note, row.discord_user_id, row.guild_id],
    ['raidsmith', 1, null, uid, null, null, 'Wanderer', 'Mage', 'signed', 'hello', null, s.gid],
  );
  assert.equal((await s.rows("SELECT id, actor_user_id FROM audit_log WHERE action = 'signup.open'")).length, 1);
  assert.equal((await s.rows("SELECT actor_user_id FROM audit_log WHERE action = 'signup.open'"))[0].actor_user_id, uid);
  const shown = await s.ok('gm', 'GET', `/raids/${s.raid}/signups`);
  assert(JSON.stringify(shown).includes('Wanderer'), 'the officers see the guest');
  assert.equal((await s.rows('SELECT 1 FROM attendance WHERE raid_id = ?', s.raid)).length, 0);
  // The view now knows it; a second sign-up is refused whatever the name.
  const mine = (await view(s, 'out1')).json;
  assert.deepEqual([mine.mine.name, mine.mine.className, mine.spotsLeft], ['Wanderer', 'Mage', null]);
  const again = await signUp(s, 'out1', guest({ name: 'Otherwander' }));
  assert.deepEqual([again.status, again.json.error], [409, 'already_signed_up']);
  assert.equal((await guestRows(s)).length, 1);
  // Withdraw, then sign up again with another name.
  assert.equal((await withdraw(s, 'out1')).status, 200);
  assert.equal((await guestRows(s)).length, 0);
  assert.equal((await withdraw(s, 'out1')).status, 404, 'nothing left to withdraw');
  assert.equal((await signUp(s, 'out1', guest({ name: 'Otherwander' }))).status, 201);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'signup.open_withdraw'")).length, 1);
  // Somebody else cannot withdraw it.
  await s.outsider('out2', 'Outsidertwo');
  assert.equal((await withdraw(s, 'out2')).status, 404);
  assert.equal((await guestRows(s)).length, 1);
});

check('sign up refuses: a name on the roster (409 on_roster), a name already signed up, a member (409 member), bad fields (400 with the field); a filled hidden field stores nothing', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  const onRoster = await signUp(s, 'out1', guest({ name: 'Rosterguy' }));
  assert.deepEqual([onRoster.status, onRoster.json.error, onRoster.json.field], [409, 'on_roster', 'name']);
  assert.equal((await signUp(s, 'out1')).status, 201);
  const dup = await signUp(s, 'out2', guest({ name: 'wanderer' }));
  assert.deepEqual([dup.status, dup.json.error, dup.json.field], [409, 'already_joined', 'name']);
  const member = await signUp(s, 'm1', guest({ name: 'Somebody' }));
  assert.deepEqual([member.status, member.json.error], [409, 'member']);
  assert.equal((await view(s, 'm1')).json.member, true);
  assert.equal((await signUp(s, 'out2', guest({ name: 'X' }))).json.field, 'name');
  assert.equal((await signUp(s, 'out2', guest({ class: 'DEATHKNIGHT' }))).json.field, 'class');
  assert.equal((await signUp(s, 'out2', guest({ name: 'Otherguy', spec: 'Arms' }))).json.field, 'spec');
  assert.equal((await signUp(s, 'out2', guest({ name: 'Otherguy', note: 'x'.repeat(200) }))).json.field, 'note');
  const trap = await signUp(s, 'out2', guest({ name: 'Trapped', website: 'http://spam.example' }));
  assert.deepEqual([trap.status, trap.json], [201, { ok: true }]);
  assert.equal((await guestRows(s)).length, 1, 'only the real one');
});

check('a blocked account is refused on the view, the sign-up and the withdrawal; unblocking brings it back', async () => {
  const s = await world();
  const uid = await s.outsider('out1', 'Outsiderone');
  assert.equal((await signUp(s, 'out1')).status, 201);
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${uid}', '${s.uids.gm}', 'spam', 1)`);
  for (const res of [await view(s, 'out1'), await signUp(s, 'out1', guest({ name: 'Another' })), await withdraw(s, 'out1')]) {
    assert.deepEqual([res.status, res.json.error], [403, 'access_removed']);
  }
  assert.equal((await guestRows(s)).length, 1, 'nothing changed');
  s.exec(`DELETE FROM guild_blocks WHERE user_id = '${uid}'`);
  assert.equal((await withdraw(s, 'out1')).status, 200);
});

check('a block made between the check and the write stops the INSERT itself (the guards sit inside the statement)', async () => {
  const s = await world();
  const uid = await s.outsider('out1', 'Outsiderone');
  s.exec(`INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at) VALUES ('${s.gid}', '${uid}', '${s.uids.gm}', 'x', 1)`);
  // The same INSERT the route runs, with the route's guards, matches no row for a blocked account.
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'worker/routes/open-raids.js'), 'utf8').split(/\r?\n/).join('\n');
  for (const guard of ['guests_open = 1 AND starts_at > ?', 'NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)', 'AND ${guestRoom.sql}', 'guest_user_id = ? AND created_at > ?) < ?']) {
    assert(source.includes(guard), `the INSERT carries: ${guard}`);
  }
  const now = s.w.clock.now;
  const results = await s.w.db.batch([s.w.db.prepare(
    `INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, created_at, updated_at, guest, guest_user_id)
     SELECT ?, 'raidsmith', 1, 'Blocked', 'signed', 0, 'Mage', 'Fire1', 1, ?, ?, ?, 1, ?
      WHERE NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)`,
  ).bind(s.raid, s.gid, now, now, uid, s.gid, uid)]);
  assert.equal(results[0].meta.changes, 0);
});

check('the caps: a guest limit of 15 with the link guests counted too (409 raid_full), 5 an hour and 10 a day per account (429), per account not per raid', async () => {
  const s = await world();
  await s.ok('gm', 'PATCH', `/raids/${s.raid}`, { guestLimit: 15 }, 200);
  // 14 guests from a link, one open sign-up fills the raid.
  const link = await s.ok('gm', 'POST', `/raids/${s.raid}/join-links`, { maxUses: 50 });
  for (let i = 0; i < 14; i++) {
    s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, created_at, updated_at, guest, join_link_id)
      VALUES ('${s.raid}', 'raidsmith', ${100 + i}, 'Linkguest${String.fromCharCode(97 + i)}', 'signed', 0, 'Mage', 'Fire1', ${100 + i}, '${s.gid}', 1, 1, 1, '${link.created.id}')`);
  }
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  assert.equal((await view(s, 'out1')).json.spotsLeft, 1);
  assert.equal((await signUp(s, 'out1')).json.spotsLeft, 0);
  const full = await signUp(s, 'out2', guest({ name: 'Toolate' }));
  assert.deepEqual([full.status, full.json.error], [409, 'raid_full']);
  assert.equal((await view(s, 'out2')).json.spotsLeft, 0, 'the view still opens');
  assert.equal((await guestRows(s)).length, 15);
  // The hourly limit: 5 sign-ups an hour for one account, over as many open raids.
  const raids = [];
  for (let i = 0; i < 12; i++) raids.push((await s.ok('gm', 'POST', '/raids', { teamId: s.bravo, raidOn: `2099-04-${String(i + 1).padStart(2, '0')}`, startTime: '20:00', guestsOpen: true })).raid.id);
  await s.outsider('out3', 'Outsiderthree');
  for (let i = 0; i < 5; i++) assert.equal((await signUp(s, 'out3', guest({ name: `Hourly${String.fromCharCode(97 + i)}` }), raids[i])).status, 201, `sign-up ${i}`);
  const hourly = await signUp(s, 'out3', guest({ name: 'Hourlyx' }), raids[5]);
  assert.deepEqual([hourly.status, hourly.json.error], [429, 'rate_limited']);
  assert.equal((await signUp(s, 'out2', guest({ name: 'Hourlyy' }), raids[5])).status, 201, 'another account is not limited');
  // The daily cap: ten sign-ups in the last day, whatever the hour, are counted from the sign-ups themselves.
  await s.outsider('out4', 'Outsiderfour');
  for (let i = 0; i < 10; i++) {
    s.exec(`INSERT INTO raid_signups (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, created_at, updated_at, guest, guest_user_id)
      VALUES ('${raids[i]}', 'raidsmith', ${200 + i}, 'Daily${String.fromCharCode(97 + i)}', 'signed', 0, 'Mage', 'Fire1', ${200 + i}, '${s.gid}', ${s.w.clock.now - 1000}, 1, 1, '${s.uids.out4}')`);
  }
  const daily = await signUp(s, 'out4', guest({ name: 'Dailyx' }), raids[10]);
  assert.deepEqual([daily.status, daily.json.error], [429, 'rate_limited']);
  assert(daily.json.retryAfter >= 1);
  assert.equal((await s.rows('SELECT 1 FROM raid_signups WHERE raid_id = ? AND guest = 1', raids[10])).length, 0);
  // A day later the oldest sign-ups no longer count.
  s.w.advance(24 * 60 * 60 * 1000 + 5000);
  assert.equal((await signUp(s, 'out4', guest({ name: 'Dailyx' }), raids[10])).status, 201);
});

check('Delete my data removes the account\'s open-raid sign-ups (the character it typed goes with the account)', async () => {
  const s = await world();
  const uid = await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  assert.equal((await signUp(s, 'out1')).status, 201);
  assert.equal((await signUp(s, 'out2', guest({ name: 'Bystander' }))).status, 201);
  await s.ok('out1', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  assert.deepEqual((await guestRows(s)).map((r) => r.nickname), ['Bystander']);
  assert.equal((await s.rows('SELECT 1 FROM raid_signups WHERE guest_user_id = ?', uid)).length, 0);
  assert.equal((await s.rows("SELECT key FROM rate_limits WHERE key = ?", `open:${uid}`)).length, 0);
});

check('the public page and a guest link mark OPEN upcoming raids (open + raidId) and no other; nothing else changes in their shape', async () => {
  const s = await world();
  await s.ok('gm', 'PUT', '/public', { enabled: true, sections: ['raids'] }, 200);
  const publicView = await s.w.call({}, 'GET', `/api/public/${s.gid}`);
  assert.equal(publicView.status, 200, publicView.text);
  const upcoming = publicView.json.sections.raids.find((entry) => entry.team.id === s.alpha).upcoming;
  assert.equal(upcoming.length, 2);
  const byDate = Object.fromEntries(upcoming.map((r) => [r.raidOn, r]));
  assert.deepEqual([byDate['2099-02-01'].open, byDate['2099-02-01'].raidId], [true, s.raid]);
  assert.deepEqual(Object.keys(byDate['2099-02-08']).sort(), ['raidOn', 'startsAt', 'title', 'zone'], 'a raid that is not open shows no id');
  assert(!publicView.text.includes(s.closed), 'the id of a closed raid is nowhere on the page');
  // A raid that has started is not marked, even when its check is on.
  const past = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2026-10-01', startTime: '20:00', guestsOpen: true })).raid.id;
  assert(!(await s.w.call({}, 'GET', `/api/public/${s.gid}`)).text.includes(past));
  // A guest link shows the same.
  const link = await s.ok('gm', 'POST', '/guest-links', { roleId: 'guest', expiresIn: '7d', label: 'x' });
  const jar = {};
  assert.equal((await s.w.call(jar, 'POST', '/auth/guest', { token: link.created.token })).status, 200);
  const guestView = await s.w.call(jar, 'GET', '/api/guest');
  assert(guestView.text.includes(s.raid) && !guestView.text.includes(s.closed));
});

check('remove every guest of a raid (raids.edit): link guests and open guests together; nothing to remove is a 404; another team\'s lead and a member are refused', async () => {
  const s = await world();
  const link = await s.ok('gm', 'POST', `/raids/${s.raid}/join-links`, { maxUses: 5 });
  await s.w.call({}, 'POST', '/api/join/view', { token: link.created.token });
  const jar = {};
  await s.w.call(jar, 'POST', '/api/join/view', { token: link.created.token });
  assert.equal((await s.w.call(jar, 'POST', '/api/join', { token: link.created.token, name: 'Linkguest', class: 'MAGE', spec: 'Fire' })).status, 201);
  await s.outsider('out1', 'Outsiderone');
  assert.equal((await signUp(s, 'out1')).status, 201);
  assert.equal((await guestRows(s)).length, 2);
  await s.fail('tlb', 'DELETE', `/raids/${s.raid}/guests`, {}, 403);
  await s.fail('m1', 'DELETE', `/raids/${s.raid}/guests`, {}, 403);
  const cleared = await s.ok('tla', 'DELETE', `/raids/${s.raid}/guests`, {}, 200);
  assert.equal(cleared.removed, 2);
  assert.equal((await guestRows(s)).length, 0);
  await s.fail('tla', 'DELETE', `/raids/${s.raid}/guests`, {}, 404);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'signup.guests_clear'")).length, 1);
  // The account may sign up again afterwards.
  assert.equal((await signUp(s, 'out1')).status, 201);
});

check('the guild\'s join links: guild.access lists every link of the raids to come, whoever made it; a Team Lead and a member cannot; the maker is named; started raids drop out', async () => {
  const s = await world();
  const a = (await s.ok('o1', 'POST', `/raids/${s.raid}/join-links`, { maxUses: 3 })).created;
  const b = (await s.ok('gm', 'POST', `/raids/${s.closed}/join-links`, { maxUses: 7 })).created;
  const other = (await s.ok('gm', 'POST', '/raids', { teamId: s.bravo, raidOn: '2099-05-01', startTime: '20:00' })).raid.id;
  const c = (await s.ok('tlb', 'POST', `/raids/${other}/join-links`, {})).created;
  await s.fail('tla', 'GET', '/join-links', undefined, 403, 'forbidden');
  await s.fail('m1', 'GET', '/join-links', undefined, 403, 'forbidden');
  const list = await s.ok('o2', 'GET', '/join-links');
  assert.deepEqual(list.links.map((l) => l.id).sort(), [a.id, b.id, c.id].sort());
  const entry = list.links.find((l) => l.id === a.id);
  assert.deepEqual([entry.raidId, entry.maxUses, entry.uses, entry.status, entry.createdBy.displayName, entry.raid.teamName, entry.raid.zone], [s.raid, 3, 0, 'active', 'Officerone', 'Alpha', 'Karazhan']);
  assert.deepEqual(list.links.find((l) => l.id === c.id).createdBy.displayName, 'Leadbravo');
  assert(!JSON.stringify(list).includes('token') && !JSON.stringify(list).includes(a.token), 'the token is shown once, when the link is made');
  assert(list.links.every((l) => !l.createdBy.avatarUrl), 'no avatar: it carries a Discord ID');
  // A raid that started drops its links out of the list.
  const past = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-06-01', startTime: '20:00' })).raid.id;
  await s.ok('gm', 'POST', `/raids/${past}/join-links`, {});
  s.exec(`UPDATE raids SET starts_at = 1 WHERE id = '${past}'`);
  assert.equal((await s.ok('o2', 'GET', '/join-links')).links.length, 3);
});

check('revoke: any holder of guild.access turns off any link (another officer\'s, a gone maker\'s); the maker demoted or deleted changes nothing about the link; revoked is 410 for the guest', async () => {
  const s = await world();
  const made = (await s.ok('o1', 'POST', `/raids/${s.raid}/join-links`, { maxUses: 5 })).created;
  const stillWorks = async (name) => {
    await s.w.call({}, 'POST', '/api/join/view', { token: made.token });
    const jar = {};
    await s.w.call(jar, 'POST', '/api/join/view', { token: made.token });
    return (await s.w.call(jar, 'POST', '/api/join', { token: made.token, name, class: 'MAGE', spec: 'Fire' })).status;
  };
  // The maker is demoted: the link works as before.
  await s.ok('gm', 'PUT', `/people/${s.uids.o1}/roles`, { officer: false, teamLeadTeamIds: [] }, 200);
  assert.equal(await stillWorks('Afterdemote'), 201);
  assert.equal((await s.ok('o2', 'GET', '/join-links')).links.find((l) => l.id === made.id).uses, 1);
  // The maker deletes their data: the link works, and the list shows no maker.
  await s.ok('o1', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  assert.equal(await stillWorks('Aftergone'), 201);
  const afterGone = (await s.ok('o2', 'GET', '/join-links')).links.find((l) => l.id === made.id);
  assert.deepEqual([afterGone.uses, afterGone.createdBy], [2, null]);
  // Another officer turns it off, whoever made it; a Team Lead of the raid's own team cannot (they hold no guild.access), and a link of another guild is a 404.
  await s.fail('tla', 'DELETE', `/join-links/${made.id}`, {}, 403, 'forbidden');
  await s.fail('o2', 'DELETE', '/join-links/jl_AAAAAAAAAAAAAAAAAAAAAA', {}, 404, 'not_found');
  // A guest who already opened the link holds its cookie; after the revocation their submit is refused too.
  const holder = {};
  assert.equal((await s.w.call(holder, 'POST', '/api/join/view', { token: made.token })).status, 200);
  const revoked = await s.ok('o2', 'DELETE', `/join-links/${made.id}`, {}, 200);
  assert.equal(revoked.links.find((l) => l.id === made.id).status, 'revoked');
  assert.equal((await s.w.call(holder, 'POST', '/api/join', { token: made.token, name: 'Afterrevoke', class: 'MAGE', spec: 'Fire' })).status, 410);
  assert.equal((await s.w.call({}, 'POST', '/api/join/view', { token: made.token })).status, 410);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'join.revoke'")).length, 1);
  // Revoking again is the same answer and writes nothing more.
  assert.equal((await s.ok('o2', 'DELETE', `/join-links/${made.id}`, {}, 200)).links.length, 1);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'join.revoke'")).length, 1);
  assert.equal((await s.rows('SELECT revoked_at FROM raid_join_links WHERE id = ?', made.id))[0].revoked_at !== null, true);
});

check('the new audit actions have a group and a sentence in the Activity log', async () => {
  const s = await world();
  await s.outsider('out1', 'Outsiderone');
  await signUp(s, 'out1');
  await withdraw(s, 'out1');
  await signUp(s, 'out1');
  await s.ok('gm', 'DELETE', `/raids/${s.raid}/guests`, {}, 200);
  const log = (await s.ok('gm', 'GET', '/audit?type=signups')).rows.map((row) => row.text).join('\n');
  assert(/Signed up as a guest for the raid on .* \(Mage\)/.test(log), log);
  assert(/Withdrew their guest sign-up from the raid on/.test(log));
  assert(/Removed every guest sign-up from the raid on/.test(log));
});

runChecks(checks);
