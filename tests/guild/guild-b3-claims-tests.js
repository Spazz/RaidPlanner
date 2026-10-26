/**
 * Raidsmith guild tracker - lane B3 of the user-hierarchy build: adding characters to your own record (D2), linking at once (D2b), conflicts (D2c),
 * the one-off for claims that were already waiting (D2e), and an accepted application that places the character
 * Run: node tests/guild/guild-b3-claims-tests.js
 *
 * The Battle.net side of D2 (POST /claims) is in guild-bnet-worker-tests.js, which owns the fake Battle.net; this suite drives the parts that need none:
 *   - POST /me/characters adds a typed character at once (a new Trial person on no team, or an alt of the member's person), marks it owner_proof 'hand',
 *     refuses a name on someone else's linked person (409 name_taken) or on the member's own record (409 already_yours), never links an account to a person
 *     by a typed name (it waits for an officer), and is refused outright in a guild whose rank source is the in-game roster (409 battlenet_only);
 *   - the shared applyClaimPlan: every write is guarded (the claimant must still own the person, still have none, the person still be unlinked);
 *   - POST /claims/apply applies the claims that were waiting (a new person, a link, an already-done one), leaves conflicts and hand-typed links, is for
 *     roster.edit over the whole guild, and works through at most 50 claims a call;
 *   - accepting an application whose character is the applicant's own, on no team, places it (the same guarded statement as the team routes).
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');

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
  assert.deepEqual([person.id, person.status, person.discord_user_id, person.created_by], [first.json.claims[0].personId, 'trial', (await s.one('SELECT discord_id FROM users WHERE id = ?', s.uids.m1)).discord_id, s.uids.m1]);
  const main = await charOf(s, 'Handmain');
  assert.deepEqual([main.is_main, main.team_id, main.core_rank, main.owner_proof, main.main_spec, main.class, main.realm], [1, null, 'trial', 'hand', 'Fire', 'MAGE', 'Nightslayer']);
  const second = await add(s, 'm1', { name: 'Handalt', class: 'ROGUE', mainSpec: 'Combat', offSpec: 'Assassination' });
  assert.deepEqual([second.json.claims[0].status, second.json.claims[0].outcome, second.json.claims[0].personId], ['applied', 'add_alt', person.id]);
  const alt = await charOf(s, 'Handalt');
  assert.deepEqual([alt.is_main, alt.team_id, alt.core_rank, alt.owner_proof, alt.off_spec, alt.player_id], [0, null, 'trial', 'hand', 'Assassination', person.id]);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'character.claim'")).length, 2);
  // The mirror: the five person fields agree with the characters (tools/hierarchy/mismatch.sql says 0).
  const mismatch = await s.w.db.prepare(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'tools/hierarchy/mismatch.sql'), 'utf8')).first();
  assert.deepEqual(Object.values(mismatch), [0, 0, 0, 0, 0]);
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
  s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  const refused = await add(s, 'm1', { name: 'Handmain' });
  assert.deepEqual([refused.status, refused.json.error], [409, 'battlenet_only']);
  assert.equal((await s.rows('SELECT id FROM characters WHERE name = ?', 'Handmain')).length, 0);
  assert.equal((await s.rows('SELECT id FROM players WHERE user_id = ?', s.uids.m1)).length, 0);
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
    const results = await s.w.db.batch(applied.writes);
    return results[results.length - 1].meta.changes;
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
  const fresh = await s.one('SELECT p.status, p.user_id, c.is_main, c.team_id, c.core_rank FROM characters c JOIN players p ON p.id = c.player_id WHERE c.name = ?', 'Freshone');
  assert.deepEqual([fresh.status, fresh.user_id, fresh.is_main, fresh.team_id, fresh.core_rank], ['trial', s.uids.m3, 1, null, 'trial']);
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

runChecks(checks);
