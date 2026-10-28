/**
 * Raidsmith guild tracker - lane B3 of the user-hierarchy build: adding characters to your own record (D2), linking at once (D2b), conflicts (D2c),
 * the one-off for claims that were already waiting (D2e), and an accepted application that places the character
 * Run: node tests/guild/guild-b3-claims-tests.js
 *
 * The Battle.net side of D2 (POST /claims) is in guild-bnet-worker-tests.js, which owns the fake Battle.net; this suite drives the parts that need none (where a Battle.net list is needed it stores the list a link would have fetched):
 *   - POST /me/characters adds a typed character at once (a new Trial person on no team, or an alt of the member's person), marks it owner_proof 'hand',
 *     refuses a name on someone else's linked person (409 name_taken) or on the member's own record (409 already_yours), never links an account to a person
 *     by a typed name (it waits for an officer), and is refused outright in a guild whose rank source is the in-game roster (409 battlenet_only);
 *   - the shared applyClaimPlan: every write is guarded (the claimant must still own the person, still have none, the person still be unlinked);
 *   - typing a name never blocks the one whom Battle.net proves owns it: a Battle.net claim closes a pending typed claim on the name (audited), and a
 *     Battle.net claim on a character somebody else typed in waits for an officer instead of being refused (officer- or Battle.net-proven ones still refuse it);
 *   - POST /claims/apply applies the claims that were waiting (a new person, a link, an already-done one), leaves conflicts and hand-typed links, is for
 *     roster.edit over the whole guild, and works through at most 50 claims a call;
 *   - accepting an application whose character is the applicant's own, on no team, places it (the same guarded statement as the team routes).
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { seatOnRoster } = require('../guild-seat');
const { ingameize } = require('../guild-ingame');
const { ownPerson } = require('../guild-owner-fixture');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.lead('tla', [s.alpha], 'Leadalpha');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  await s.member('m3', 'Memberthree');
  return s;
}
const add = (s, who, body) => s.call(who, 'POST', '/me/characters', { class: 'MAGE', mainSpec: 'Fire', ...body });
const charOf = (s, name) => s.one('SELECT * FROM characters WHERE name = ?', name);

check('hand add: a member with no person gets a new Trial person with the character as Main on no team; the next characters are its alts; owner_proof is hand', async () => {
  const s = await world();
  const first = await add(s, 'm1', { name: 'Handmain' });
  assert.equal(first.status, 201, first.text);
  assert.deepEqual([first.json.claims[0].status, first.json.claims[0].outcome], ['applied', 'new_person']);
  const person = await s.one('SELECT * FROM players WHERE user_id = ?', s.uids.m1);
  assert.deepEqual([person.id, person.discord_user_id, person.created_by], [first.json.claims[0].personId, (await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.m1)).discord_id, s.uids.m1]);
  const main = await charOf(s, 'Handmain');
  assert.deepEqual([main.is_main, main.team_id, main.core_rank, main.owner_proof, main.main_spec, main.class, main.realm], [1, null, 'trial', 'hand', 'Fire', 'MAGE', 'Nightslayer']);
  const second = await add(s, 'm1', { name: 'Handalt', class: 'ROGUE', mainSpec: 'Combat', offSpec: 'Assassination' });
  assert.deepEqual([second.json.claims[0].status, second.json.claims[0].outcome, second.json.claims[0].personId], ['applied', 'add_alt', person.id]);
  const alt = await charOf(s, 'Handalt');
  assert.deepEqual([alt.is_main, alt.team_id, alt.core_rank, alt.owner_proof, alt.off_spec, alt.player_id], [0, null, 'trial', 'hand', 'Assassination', person.id]);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'character.claim'")).length, 2);
  // R4: the players row keeps only the inert placeholder; the rank is the characters'.
  assert.deepEqual(await s.rows('SELECT status, trial_start, trial_end, left_on, left_reason FROM players WHERE id = ?', person.id), [{ status: 'raider', trial_start: null, trial_end: null, left_on: null, left_reason: null }]);
  // The new person is the member's own record: they see it, and an officer can place the character on a team.
  const record = await s.ok('m1', 'GET', `/roster/${person.id}`);
  assert.deepEqual(record.characters.map((c) => [c.name, c.team.id]).sort(), [['Handalt', null], ['Handmain', null]]);
  await s.ok('tla', 'PUT', `/roster/${person.id}/characters/${main.id}/team`, { teamId: s.alpha }, 200);
});

check('hand add: validation (name, class, spec, realm) and the refusals - on your own record, on someone else\'s linked person', async () => {
  const s = await world();
  const owned = await s.person({ name: 'Linkedmain' });
  await s.link(owned.pid, 'm2');
  assert.equal((await add(s, 'm1', { name: 'X' })).json.field, 'name');
  assert.equal((await add(s, 'm1', { name: 'Bad Name1' })).json.field, 'name');
  assert.equal((await add(s, 'm1', { name: 'Okname', class: 'DEATHKNIGHT' })).json.field, 'class');
  assert.equal((await add(s, 'm1', { name: 'Okname', class: 'MAGE', mainSpec: 'Arms' })).json.field, 'mainSpec');
  assert.equal((await add(s, 'm1', { name: 'Okname', realm: 'Nowhere Isle' })).json.field, 'realm');
  assert.equal((await s.call('m1', 'POST', '/me/characters', {})).status, 400);
  assert.equal((await s.rows('SELECT id FROM characters WHERE name = ?', 'Okname')).length, 0);
  const taken = await add(s, 'm1', { name: 'Linkedmain', class: 'MAGE' });
  assert.deepEqual([taken.status, taken.json.error, taken.json.field], [409, 'name_taken', 'name']);
  assert.equal((await add(s, 'm2', { name: 'Linkedmain', class: 'MAGE' })).json.error, 'already_yours');
  // A signed-out caller and a non-member are refused before anything else.
  assert.equal((await s.w.call({}, 'POST', `${s.base}/me/characters`, { name: 'Okname', class: 'MAGE' })).status, 401);
  assert.equal((await s.rows('SELECT id FROM players WHERE user_id = ?', s.uids.m1)).length, 0);
});

check('hand add: a typed name that is on a person nobody linked is NEVER linked by typing (it proves nothing) - it waits for an officer, who may approve the link', async () => {
  const s = await world();
  const unlinked = await s.person({ name: 'Unlinkedmain' });
  // m1 has no person: a Battle.net claim would link at once (D2b); a typed name does not.
  const typed = await add(s, 'm1', { name: 'Unlinkedmain', class: 'MAGE' });
  assert.equal(typed.status, 201, typed.text);
  assert.deepEqual([typed.json.claims[0].status, typed.json.claims[0].outcome, typed.json.claims[0].reason], ['pending', 'needs_officer', 'link_person']);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', unlinked.pid)).user_id, null);
  assert.equal((await s.rows('SELECT id FROM players WHERE user_id = ?', s.uids.m1)).length, 0);
  const claim = (await s.ok('o1', 'GET', '/claims')).claims[0];
  assert.deepEqual([claim.character.name, claim.plan.kind, claim.plan.canDecide], ['Unlinkedmain', 'link_person', true]);
  // Typing it again while the claim waits is refused.
  assert.equal((await add(s, 'm1', { name: 'Unlinkedmain' })).json.error, 'claim_pending');
  const approved = await s.ok('o1', 'POST', `/claims/${claim.id}/approve`, { expectedKind: 'link_person' }, 200);
  assert.equal(approved.personId, unlinked.pid);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', unlinked.pid)).user_id, s.uids.m1);
  // A member WITH a person typing such a name is the usual conflict (other_person), and also waits.
  const other = await s.person({ name: 'Anothermain' });
  const mine = await add(s, 'm2', { name: 'Mineone' });
  assert.equal(mine.json.claims[0].status, 'applied');
  const conflict = await add(s, 'm2', { name: 'Anothermain' });
  assert.deepEqual([conflict.json.claims[0].status, conflict.json.claims[0].reason], ['pending', 'other_person']);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', other.pid)).user_id, null);
});

check('hand add is refused in a guild whose rank source is the in-game roster (characters come only through Battle.net there); legacy and manual guilds take it', async () => {
  const s = await world();
  // An in-game guild lets in only an account whose person has a character on the roster (lane B5): m1 is seated first, so the request reaches the refusal this is about.
  await seatOnRoster({ call: s.call, sqlite: s.w.db.sqlite, guildId: s.gid, teamId: s.alpha, userId: s.uids.m1 }, { name: 'Seatone', id: 71001 });
  s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  const refused = await add(s, 'm1', { name: 'Handmain' });
  assert.deepEqual([refused.status, refused.json.error], [409, 'battlenet_only']);
  assert.equal((await s.rows('SELECT id FROM characters WHERE name = ?', 'Handmain')).length, 0);
  assert.equal((await s.rows('SELECT id FROM players WHERE user_id = ?', s.uids.m1)).length, 1, 'only the seat person');
  for (const source of ['manual', null]) {
    s.exec(`UPDATE guilds SET rank_source = ${source ? `'${source}'` : 'NULL'} WHERE id = '${s.gid}'`);
    const name = source ? 'Manualone' : 'Legacyone';
    assert.equal((await add(s, 'm1', { name })).status, 201);
  }
});

check('hand add is rate limited per account (20 an hour) and the limit is swept with Delete my data', async () => {
  const s = await world();
  s.exec('UPDATE characters SET id = id');
  for (let i = 0; i < 20; i++) {
    const res = await add(s, 'm1', { name: `Hand${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x` });
    assert([201, 409].includes(res.status), res.text);
  }
  const over = await add(s, 'm1', { name: 'Handoverx' });
  assert.deepEqual([over.status, over.json.error], [429, 'rate_limited']);
  assert.equal((await add(s, 'm2', { name: 'Otherguy' })).status, 201, 'per account');
  assert.equal((await s.rows("SELECT key FROM rate_limits WHERE key = ?", `char:${s.uids.m1}`)).length, 1);
  await s.ok('m1', 'DELETE', '/auth/me', { deleteGuildIds: [] }, 200);
  assert.equal((await s.rows("SELECT key FROM rate_limits WHERE key = ?", `char:${s.uids.m1}`)).length, 0);
});

check('applyClaimPlan: every write is guarded - an alt for a person the claimant does not own, a second new person, a link of a person already linked each write nothing', async () => {
  const { applyClaimPlan } = await load('worker/claim-apply.js');
  const s = await world();
  const owned = await s.person({ name: 'Ownedmain' });
  await s.link(owned.pid, 'm2');
  const ctx = { db: s.w.db, randomBytes: s.w.randomBytes };
  const guild = { id: s.gid, time_zone: 'America/New_York' };
  const character = (name) => ({ name, realm: 'Nightslayer', realmKey: 'nightslayer', class: 'MAGE' });
  const run = async (plan, who, name, extra = {}) => {
    const applied = applyClaimPlan(ctx, { guild, plan, claimant: { userId: s.uids[who], discordId: null }, character: character(name), source: 'bnet', now: 5, actorId: s.uids[who], ...extra });
    // The own rows of the last write (SQL changes() behind it): meta.changes also counts the trigger rows of migrations 0036 and 0040 (worker/d1-changes.js).
    const { directRows, directRowsStatement } = await import('../../worker/d1-changes.js');
    const results = await s.w.db.batch([...applied.writes, directRowsStatement(s.w.db)]);
    return directRows(results[results.length - 1]);
  };
  // m1 does not own m2's person: no alt.
  assert.equal(await run({ kind: 'add_alt', person: { id: owned.pid } }, 'm1', 'Stolenalt'), 0);
  assert.equal((await s.rows('SELECT id FROM characters WHERE name = ?', 'Stolenalt')).length, 0);
  assert.equal(await run({ kind: 'add_alt', person: { id: owned.pid } }, 'm2', 'Rightalt'), 1);
  // m2 has a person: a new_person is refused (the guard sees it), so is a link.
  assert.equal(await run({ kind: 'new_person', person: null }, 'm2', 'Secondperson'), 0);
  assert.equal((await s.rows('SELECT id FROM players WHERE user_id = ?', s.uids.m2)).length, 1);
  const free = await s.person({ name: 'Freemain' });
  assert.equal(await run({ kind: 'link_person', person: { id: free.pid }, homeTeamId: s.alpha, characterId: free.cid }, 'm2', 'Unused'), 0);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', free.pid)).user_id, null);
  // m1 has none: both work, and the link needs the person still unlinked and its Main still on the team the page saw.
  assert.equal(await run({ kind: 'link_person', person: { id: free.pid }, homeTeamId: s.bravo, characterId: free.cid }, 'm1', 'Unused'), 0, 'the Main is on Alpha, not Bravo');
  assert.equal(await run({ kind: 'link_person', person: { id: free.pid }, homeTeamId: s.alpha, characterId: free.cid }, 'm1', 'Unused'), 1);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', free.pid)).user_id, s.uids.m1);
  // A claim that is no longer pending writes nothing.
  s.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm_key, class, status, decided_at, created_at) VALUES ('cl_AAAAAAAAAAAAAAAAAAAAAA', '${s.gid}', '${s.uids.m1}', 'Late', 'late', 'nightslayer', 'MAGE', 'rejected', 1, 1)`);
  const guard = { sql: "EXISTS (SELECT 1 FROM character_claims WHERE id = ? AND status = 'pending')", params: ['cl_AAAAAAAAAAAAAAAAAAAAAA'] };
  assert.equal(await run({ kind: 'add_alt', person: { id: free.pid } }, 'm1', 'Latealt', { guard }), 0);
});

// Pending claims as the old Worker left them: the rows alone (level set = they came from a Battle.net list).
function pending(s, who, name, { level = 70, id } = {}) {
  const rowId = id || `cl_${String(pending.n = (pending.n || 0) + 1).padStart(22, 'q')}`;
  s.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
    VALUES ('${rowId}', '${s.gid}', '${s.uids[who]}', '${name}', '${name.toLowerCase()}', 'Nightslayer', 'nightslayer', 'MAGE', ${level === null ? 'NULL' : level}, 'pending', ${pending.n})`);
  return rowId;
}

check('apply pending claims (D2e): a new person, a link, an alt and an already-done one are applied as an officer\'s approval; conflicts and hand-typed links stay; the counts say so', async () => {
  const s = await world();
  const unlinkedA = await s.person({ name: 'Unlinkeda' });
  const unlinkedB = await s.person({ name: 'Unlinkedb' });
  const unlinkedC = await s.person({ name: 'Unlinkedc' });
  const mineOwned = await s.person({ name: 'Ownedby' });
  await s.link(mineOwned.pid, 'o1'); // o1 owns a person: its claims are alts / conflicts
  // m1: no person, two characters (one new, one on an unlinked person) -> the first links (Unlinkeda), the other becomes an alt of that person.
  const c1 = pending(s, 'm1', 'Unlinkeda');
  const c2 = pending(s, 'm1', 'Brandnew');
  // m2: no person, a hand-typed (no level) claim on an unlinked person: stays for a person to decide.
  const c3 = pending(s, 'm2', 'Unlinkedb', { level: null });
  // m3: no person, a plain new character -> a new Trial person.
  const c4 = pending(s, 'm3', 'Freshone');
  // o1: owns a person, claims a character of an unlinked person (conflict -> stays), and one already on their record (closed).
  const c5 = pending(s, 'o1', 'Unlinkedc');
  const c6 = pending(s, 'o1', 'Ownedby');
  // Only roster.edit over the whole guild applies; a Team Lead of one team and a member cannot.
  await s.fail('tla', 'POST', '/claims/apply', {}, 403, 'forbidden');
  await s.fail('m1', 'POST', '/claims/apply', {}, 403, 'forbidden');
  const done = await s.ok('o1', 'POST', '/claims/apply', {}, 200);
  assert.deepEqual([done.applied, done.closed, done.left, done.more], [3, 1, 2, false]);
  const byId = Object.fromEntries((await s.rows('SELECT id, status, decided_by FROM character_claims')).map((r) => [r.id, r]));
  assert.deepEqual([c1, c2, c4, c6].map((id) => [byId[id].status, byId[id].decided_by]), Array(4).fill(['approved', s.uids.o1]));
  assert.deepEqual([c3, c5].map((id) => byId[id].status), ['pending', 'pending']);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', unlinkedA.pid)).user_id, s.uids.m1, 'D2b: linked');
  assert.equal((await charOf(s, 'Brandnew')).player_id, unlinkedA.pid, 'and the next character joined that person');
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', unlinkedB.pid)).user_id, null);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', unlinkedC.pid)).user_id, null);
  const fresh = await s.one('SELECT p.user_id, c.is_main, c.team_id, c.core_rank FROM characters c JOIN players p ON p.id = c.player_id WHERE c.name = ?', 'Freshone');
  assert.deepEqual([fresh.user_id, fresh.is_main, fresh.team_id, fresh.core_rank], [s.uids.m3, 1, null, 'trial']);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'claim.approve'")).length, 4);
  assert.deepEqual(done.pendingClaims, 2);
  // Run again: only the two that stay, nothing is applied twice.
  const again = await s.ok('o1', 'POST', '/claims/apply', {}, 200);
  assert.deepEqual([again.applied, again.closed, again.left], [0, 0, 2]);
  assert.equal((await s.rows('SELECT id FROM players')).length, 5, 'four people from the roster and one new');
});

check('apply pending claims works through at most 50 a call and says there are more', async () => {
  const s = await world();
  for (const who of ['m1', 'm2', 'm3']) {
    for (let i = 0; i < 18; i++) pending(s, who, `Bulk${who}${String.fromCharCode(97 + i)}`);
  }
  const first = await s.ok('o1', 'POST', '/claims/apply', {}, 200);
  assert.deepEqual([first.applied, first.more], [50, true]);
  const second = await s.ok('o1', 'POST', '/claims/apply', {}, 200);
  assert.deepEqual([second.applied, second.more], [4, false]);
  assert.equal((await s.rows("SELECT id FROM character_claims WHERE status = 'pending'")).length, 0);
});

check('accepting an application whose character is the applicant\'s own and on no team places it on the team; someone else\'s character, or one on a team, is still name_taken', async () => {
  const s = await world();
  await s.ok('gm', 'PUT', '/applications/settings', { enabled: true, questions: [] }, 200);
  // m1 adds Handmain by hand (a new person, the Main on no team), then applies with it for Alpha.
  await add(s, 'm1', { name: 'Handmain' });
  const person = await s.one('SELECT id FROM players WHERE user_id = ?', s.uids.m1);
  const apply = async (who, body) => {
    const form = await s.w.call(s.jars[who], 'GET', `/api/apply/${s.gid}`);
    assert.equal(form.status, 200, form.text);
    s.jars[who] = s.jars[who];
    return s.w.call(s.jars[who], 'POST', `/api/apply/${s.gid}`, { teamId: s.alpha, class: 'MAGE', spec: 'Fire', answers: {}, website: '', ...body });
  };
  assert.equal((await apply('m1', { name: 'Handmain' })).status, 201);
  const app = (await s.ok('o1', 'GET', '/applications')).applications[0];
  const accepted = await s.ok('tla', 'POST', `/applications/${app.id}/accept`, {}, 201);
  assert.equal(accepted.placed, true);
  assert.deepEqual([accepted.person.id, accepted.person.teamId, accepted.accountLinked, accepted.accountSkipped], [person.id, s.alpha, false, false]);
  assert.equal((await charOf(s, 'Handmain')).team_id, s.alpha);
  assert.equal((await s.rows('SELECT id FROM players')).length, 1, 'no second person');
  assert.equal(accepted.application.status, 'accepted');
  const places = await s.rows("SELECT after FROM audit_log WHERE action = 'character.place'");
  assert.deepEqual(places.map((p) => JSON.parse(p.after).via), ['application']);
  assert.equal(JSON.parse((await s.one("SELECT after FROM audit_log WHERE action = 'application.accept'")).after).placed, true);
  // The person already holds Alpha with that character: a second application for Alpha with another of their characters is team_taken.
  await add(s, 'm1', { name: 'Handalt', class: 'ROGUE', mainSpec: 'Combat' });
  assert.equal((await apply('m1', { name: 'Handalt', class: 'ROGUE', spec: 'Combat' })).status, 201);
  const second = (await s.ok('o1', 'GET', '/applications?status=new')).applications[0];
  await s.fail('o1', 'POST', `/applications/${second.id}/accept`, {}, 409, 'team_taken');
  assert.equal((await charOf(s, 'Handalt')).team_id, null);
  // Someone else's character: still name_taken.
  const other = await s.person({ name: 'Strangermain' });
  assert.equal((await apply('m2', { name: 'Strangermain' })).status, 201);
  const third = (await s.ok('o1', 'GET', '/applications?status=new')).applications.find((a) => a.name === 'Strangermain');
  await s.fail('o1', 'POST', `/applications/${third.id}/accept`, {}, 409, 'name_taken');
  assert.equal(other.pid.length > 0, true);
});

// The Battle.net list POST /claims reads: a link whose stored snapshot holds these characters of the guild's realm (no Blizzard call is made).
async function bnetList(s, who, names) {
  const { bnetSupport } = await load('worker/battlenet.js');
  const namespace = bnetSupport('tbc', 'US').namespace;
  const snapshot = { [namespace]: { fetchedAt: s.w.clock.now, characters: names.map((name) => ({ name, realm: 'Nightslayer', realmSlug: 'nightslayer', class: 'MAGE', level: 70 })) } };
  bnetList.n = (bnetList.n || 0) + 1;
  await s.w.db.prepare('DELETE FROM bnet_links WHERE user_id = ?').bind(s.uids[who]).run();
  await s.w.db.prepare('INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(s.uids[who], String(700000 + bnetList.n), `Tag#${1000 + bnetList.n}`, s.w.clock.now, JSON.stringify(snapshot), s.w.clock.now).run();
}
const bnetClaim = (s, who, ...names) => s.call(who, 'POST', '/claims', { characters: names.map((name) => ({ name, realmSlug: 'nightslayer' })) });

check('a Battle.net claim closes a pending TYPED claim on the same name (audited) instead of being blocked by it; other pending claims still block', async () => {
  const s = await world();
  const owner = await s.member('m4', 'Memberfour');
  const unlinked = await s.person({ name: 'Realchar' });
  // m1 has a person of their own and types the name of a roster character nobody linked: a pending typed claim.
  assert.equal((await add(s, 'm1', { name: 'Squatmain' })).json.claims[0].outcome, 'new_person');
  const typed = (await add(s, 'm1', { name: 'Realchar' })).json.claims[0];
  assert.deepEqual([typed.status, typed.outcome, typed.reason], ['pending', 'needs_officer', 'other_person']);
  // A second typed claim on the name still waits behind it.
  assert.equal((await add(s, 'm2', { name: 'Realchar' })).json.error, 'claim_pending');
  // The real owner has it on their Battle.net list and no person: the claim is applied at once and the typed claim is closed.
  await bnetList(s, 'm4', ['Realchar']);
  const res = await bnetClaim(s, 'm4', 'Realchar');
  assert.equal(res.status, 201, res.text);
  assert.deepEqual([res.json.claims[0].status, res.json.claims[0].outcome], ['applied', 'link_person']);
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', unlinked.pid)).user_id, owner, 'the real owner is linked to the person');
  const closed = await s.one('SELECT status, decided_by, decided_at FROM character_claims WHERE id = ?', typed.id);
  assert.deepEqual([closed.status, closed.decided_by, closed.decided_at !== null], ['rejected', owner, true]);
  const audit = await s.rows("SELECT actor_user_id, entity_id, after FROM audit_log WHERE action = 'claim.reject'");
  assert.deepEqual(audit.map((a) => [a.actor_user_id, a.entity_id, JSON.parse(a.after)]), [[owner, typed.id, { superseded: true }]]);
  assert.equal((await s.rows("SELECT id FROM character_claims WHERE status = 'pending'")).length, 0);

  // When the Battle.net claim is itself a conflict (the owner has a person), it takes the one open slot of the name.
  const second = await s.person({ name: 'Otherchar' });
  const squat = (await add(s, 'm1', { name: 'Otherchar' })).json.claims[0];
  assert.equal(squat.status, 'pending');
  await s.member('m5', 'Memberfive');
  assert.equal((await add(s, 'm5', { name: 'Fivemain' })).json.claims[0].outcome, 'new_person');
  await bnetList(s, 'm5', ['Otherchar']);
  const conflict = await bnetClaim(s, 'm5', 'Otherchar');
  assert.equal(conflict.status, 201, conflict.text);
  assert.deepEqual([conflict.json.claims[0].status, conflict.json.claims[0].outcome, conflict.json.claims[0].reason], ['pending', 'needs_officer', 'other_person']);
  const waiting = await s.rows("SELECT user_id, level FROM character_claims WHERE name_key = 'otherchar' AND status = 'pending'");
  assert.deepEqual(waiting.map((r) => [r.user_id, r.level]), [[s.uids.m5, 70]]);
  assert.equal((await s.one('SELECT status FROM character_claims WHERE id = ?', squat.id)).status, 'rejected');
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', second.pid)).user_id, null);

  // A pending BATTLE.NET claim is not closed by another one, and a typed claim never closes anything.
  await s.member('m6', 'Membersix');
  assert.equal((await add(s, 'm6', { name: 'Sixmain' })).json.claims[0].outcome, 'new_person');
  await bnetList(s, 'm6', ['Otherchar']);
  assert.equal((await bnetClaim(s, 'm6', 'Otherchar')).json.error, 'claim_pending');
  assert.equal((await add(s, 'm6', { name: 'Otherchar' })).json.error, 'claim_pending');
  assert.equal((await s.rows("SELECT id FROM character_claims WHERE name_key = 'otherchar' AND status = 'pending'")).length, 1);
});

check('a Battle.net claim on a character somebody typed in on another person waits for an officer (not name_taken); officer- or Battle.net-proven characters on other people still refuse it', async () => {
  const s = await world();
  const owner = await s.member('m4', 'Memberfour');
  // m1 types Futurechar onto their own new person (owner_proof hand).
  assert.equal((await add(s, 'm1', { name: 'Squatmain' })).json.claims[0].outcome, 'new_person');
  assert.equal((await add(s, 'm1', { name: 'Futurechar' })).json.claims[0].outcome, 'add_alt');
  assert.equal((await charOf(s, 'Futurechar')).owner_proof, 'hand');
  await bnetList(s, 'm4', ['Futurechar', 'Provenchar', 'Linkedchar']);
  const res = await bnetClaim(s, 'm4', 'Futurechar');
  assert.equal(res.status, 201, res.text);
  const claim = res.json.claims[0];
  assert.deepEqual([claim.status, claim.outcome, claim.reason, claim.level], ['pending', 'needs_officer', 'hand_added', 70]);
  assert.equal((await s.one('SELECT user_id, level, status FROM character_claims WHERE id = ?', claim.id)).user_id, owner);
  // Nothing moved: the typed character is still on the typist's person, and the officer sees a claim that cannot be approved until the roster is fixed.
  assert.equal((await s.one('SELECT user_id FROM players WHERE id = ?', (await charOf(s, 'Futurechar')).player_id)).user_id, s.uids.m1);
  const queued = (await s.ok('o1', 'GET', '/claims')).claims.find((c) => c.id === claim.id);
  assert.deepEqual([queued.plan.kind, queued.plan.reason, queued.plan.canDecide], ['blocked', 'taken', false]);
  // A typed claim on a typed character stays name_taken: typing never outranks typing.
  assert.equal((await add(s, 'm2', { name: 'Futurechar' })).json.error, 'name_taken');
  // An officer-placed character on a linked person, and a Battle.net-proven one, still refuse the claim outright.
  const linked = await s.person({ name: 'Linkedchar' });
  await s.link(linked.pid, 'm3');
  const proven = await s.person({ name: 'Provenchar' });
  await s.link(proven.pid, 'm2');
  s.exec(`UPDATE characters SET owner_proof = 'bnet' WHERE id = '${proven.cid}'`);
  for (const name of ['Linkedchar', 'Provenchar']) {
    const refused = await bnetClaim(s, 'm4', name);
    assert.deepEqual([refused.status, refused.json.error], [409, 'name_taken'], name);
  }
  assert.equal((await s.rows("SELECT id FROM character_claims WHERE status = 'pending'")).length, 1);
});

// An officer approves a claim that was waiting (an Alt of a person, or in a legacy guild a new person): the character's core rank is the one the guild's rank source gives it, and so
// is the owner's right to remove it. In an in-game guild: Social while it is off the roster (user decision H-Q44), no key (a claim carries none), and its owner removes nothing
// (user rule 2026-10-28). In a manual or legacy guild: the Main's rank (a new person is a Trial), and the owner may remove an Alt.
for (const source of ['ingame', 'manual', 'legacy']) {
  check(`approve (${source} guild): the claimed Alt (and a new person's Main) get the core rank of the guild's rank source; the owner's removal follows the guild's rule`, async () => {
    const s = await world();
    const gm = await s.person({ name: 'Gmmain' });
    await s.link(gm.pid, 'gm');
    const mine = await s.person({ name: 'Minemain' });
    await s.link(mine.pid, 'm1');
    const officerMain = await s.person({ name: 'Officermain' });
    s.exec(`UPDATE characters SET core_rank = 'raider' WHERE id IN ('${gm.cid}', '${mine.cid}')`);
    if (source === 'ingame') {
      ingameize(s, { owner: 'gm', people: { gm, m1: mine } });
    } else if (source === 'manual') {
      s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
      for (const [who, made] of [['o1', officerMain], ['m1', mine]]) ownPerson(s.w.db.sqlite, made.pid, s.uids[who]); // a manual guild's members are linked persons (players.user_id)
    }
    const officer = source === 'ingame' ? 'gm' : 'o1';
    const alt = pending(s, 'm1', 'Claimedalt');
    await s.ok(officer, 'POST', `/claims/${alt}/approve`, { expectedKind: 'add_alt' }, 200);
    const altRow = await charOf(s, 'Claimedalt');
    assert.deepEqual([altRow.player_id, altRow.is_main, altRow.owner_proof, altRow.namespace, altRow.blizzard_char_id], [mine.pid, 0, 'officer', null, null]);
    if (source === 'ingame') {
      assert.equal(altRow.core_rank, 'social', 'not on the in-game roster');
    } else {
      assert.equal(altRow.core_rank, 'raider', 'the Main\'s rank');
    }
    if (source === 'legacy') {
      // a claimant with no person: a new person (a manual or in-game guild has no such claimant: only a person's account is a member there)
      const fresh = pending(s, 'm3', 'Claimedmain');
      await s.ok(officer, 'POST', `/claims/${fresh}/approve`, { expectedKind: 'new_person', status: 'trial' }, 200);
      const mainRow = await charOf(s, 'Claimedmain');
      assert.deepEqual([mainRow.is_main, mainRow.team_id, mainRow.core_rank, mainRow.namespace, mainRow.blizzard_char_id], [1, null, 'trial', null, null]);
      assert.notEqual(mainRow.trial_start, null);
    }
    const asOwner = await s.call('m1', 'GET', `/api/me/characters/${altRow.id}`);
    assert.equal(asOwner.status, 200, asOwner.text);
    assert.equal(asOwner.json.can.remove, source !== 'ingame');
    assert.equal(asOwner.json.character.coreRank, altRow.core_rank);
    const dropped = await s.call('m1', 'DELETE', `/api/me/characters/${altRow.id}`, {});
    if (source === 'ingame') {
      assert.deepEqual([dropped.status, dropped.json.error], [403, 'battlenet_only']);
      assert.equal((await s.rows('SELECT id FROM characters WHERE id = ?', altRow.id)).length, 1);
    } else {
      assert.equal(dropped.status, 200, dropped.text);
      assert.equal((await s.rows('SELECT id FROM characters WHERE id = ?', altRow.id)).length, 0);
    }
  });
}

runChecks(checks);
