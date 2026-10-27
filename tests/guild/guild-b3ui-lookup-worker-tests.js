/**
 * Raidsmith guild tracker - lane B3 UI (teams and claims): the Worker parts the screens stand on
 * Run: node tests/guild/guild-b3ui-lookup-worker-tests.js
 *
 *   - GET /roster/unlinked?q= ("This is me"): the roster records nobody owns, by name prefix, for a member; the same visibility as the Roster read (people on a team
 *     roster only, never a linked person, never one that records somebody else's Discord ID), minus the characters the viewer already claimed, plus the viewer's own
 *     waiting typed claims; two letters to search, 60 searches per 10 minutes, nothing for an in-game guild;
 *   - GET /auth/bnet says which guilds take Battle.net only (battlenetOnly), so My characters offers no "This is me" there;
 *   - approving a team request withdraws the person's other open requests for that team (one character per person per team);
 *   - the Home count (GET /attention total) counts every pending team request and every pending claim, one item per team / one for the guild;
 *   - GET /team-requests carries the character's spec and whether approving starts its trial; GET /claims says which roster record a link would link;
 *   - the three not-a-member messages no longer send anyone to an officer to be linked.
 */
const assert = require('node:assert/strict');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { seatOnRoster } = require('../guild-seat');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  await s.member('m3', 'Memberthree');
  return s;
}
const find = (s, who, q) => s.call(who, 'GET', '/roster/unlinked' + (q === undefined ? '' : `?q=${encodeURIComponent(q)}`));
const names = (res) => res.json.matches.map((m) => m.name);
const ask = (s, who, characterId, teamId) => s.call(who, 'POST', '/team-requests', { characterId, teamId });
const hand = (s, who, body) => s.call(who, 'POST', '/me/characters', { class: 'MAGE', mainSpec: 'Frost', ...body });

check('lookup: a member sees the roster records nobody owns, by name prefix, with spec and team (the alt shows its Main\'s team); nobody owned, on no roster or recording another account\'s Discord ID', async () => {
  const s = await world();
  const marrow = await s.person({ name: 'Marrowind', class: 'MAGE', mainSpec: 'Frost' });
  await s.alt(marrow.pid, 'Marrowalt', { class: 'ROGUE', mainSpec: 'Combat' });
  const owned = await s.person({ name: 'Marrowowned' });
  await s.link(owned.pid, 'm2');
  await s.person({ name: 'Marrowtheirs', linkUserId: s.uids.m3 });
  await s.person({ name: 'Marrownoteam', teamId: null });
  const social = await s.person({ name: 'Marrowsocial' });
  s.exec(`UPDATE characters SET core_rank = 'social' WHERE id = '${social.cid}'`);
  const res = await find(s, 'm1', 'marrow');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(names(res), ['Marrowalt', 'Marrowind'], 'by name, linked / team-less / Social and another account\'s Discord ID are left out');
  assert.deepEqual(res.json.matches[1], { name: 'Marrowind', class: 'MAGE', mainSpec: 'Frost', realm: res.json.matches[1].realm, team: { id: s.alpha, name: 'Alpha' } });
  assert.deepEqual(res.json.matches[0].team, { id: s.alpha, name: 'Alpha' }, 'an alt on no team shows its Main\'s team');
  assert.equal(res.json.more, false);
  assert.deepEqual(res.json.waiting, []);
  // A person that records the viewer's OWN Discord ID is still unowned, so it is listed (a likely claim, never an ownership).
  assert.deepEqual(names(await find(s, 'm3', 'marrow')), ['Marrowalt', 'Marrowind', 'Marrowtheirs']);
  // The owner of a person finds nothing of it; case does not matter.
  assert.deepEqual(names(await find(s, 'm2', 'MARROWI')), ['Marrowind']);
  for (const q of ['%', '_', 'zzzz']) assert.deepEqual(names(await find(s, 'm1', q + 'x')), [], q);
});

check('lookup: two letters search, shorter reads only the waiting list and counts nothing, a long name is a 400 on q, % and _ are letters; signed out is 401 and a non-member 403', async () => {
  const s = await world();
  await s.person({ name: 'Marrowind' });
  assert.deepEqual((await find(s, 'm1')).json, { matches: [], more: false, waiting: [] });
  assert.deepEqual((await find(s, 'm1', 'm')).json.matches, []);
  assert.deepEqual(names(await find(s, 'm1', 'ma')), ['Marrowind']);
  const long = await find(s, 'm1', 'x'.repeat(41));
  assert.deepEqual([long.status, long.json.error, long.json.field], [400, 'bad_request', 'q']);
  assert.equal((await s.w.call({}, 'GET', `${s.base}/roster/unlinked?q=marrow`)).status, 401);
  await s.outsider('out', 'Outsider');
  const out = await find(s, 'out', 'marrow');
  assert.deepEqual([out.status, out.json.error], [403, 'not_member']);
  assert(!/officer/i.test(out.json.message), out.json.message);
});

check('lookup: at most 8 records, more says there are others; the viewer\'s pending typed claim leaves the matches and shows as waiting (with Withdraw\'s id); a Battle.net claim is not listed there', async () => {
  const s = await world();
  for (let i = 0; i < 9; i++) await s.person({ name: `Marrow${'abcdefghi'[i]}` });
  const many = await find(s, 'm1', 'marrow');
  assert.equal(many.json.matches.length, 8);
  assert.equal(many.json.more, true);
  const typed = await hand(s, 'm1', { name: 'Marrowa', class: 'MAGE' });
  assert.deepEqual([typed.status, typed.json.claims[0].status], [201, 'pending']);
  const after = await find(s, 'm1', 'marrow');
  assert(!names(after).includes('Marrowa'), 'a name already claimed is not offered again');
  assert.equal(after.json.matches.length, 8);
  assert.deepEqual(after.json.waiting, [{ id: typed.json.claims[0].id, name: 'Marrowa', class: 'MAGE', mainSpec: 'Fire', realm: after.json.waiting[0].realm, team: { id: s.alpha, name: 'Alpha' } }]);
  assert.deepEqual((await find(s, 'm1')).json.waiting.map((w) => w.name), ['Marrowa'], 'the waiting list comes without a search too');
  assert.deepEqual((await find(s, 'm2')).json.waiting, [], 'somebody else\'s claim is none of m2\'s');
  // A claim with a level came from a Battle.net list: that shows in the Battle.net table, not here.
  s.exec(`INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
          VALUES ('cl_BBBBBBBBBBBBBBBBBBBBBB', '${s.gid}', '${s.uids.m1}', 'Marrowb', 'marrowb', NULL, '', 'MAGE', 70, 'pending', 1)`);
  assert.deepEqual((await find(s, 'm1')).json.waiting.map((w) => w.name), ['Marrowa']);
  // Withdrawing brings it back among the matches.
  await s.ok('m1', 'DELETE', `/claims/${typed.json.claims[0].id}`, undefined, 200);
  assert.deepEqual((await find(s, 'm1')).json.waiting, []);
  assert(names(await find(s, 'm1', 'marrowa')).includes('Marrowa'));
});

check('lookup: 60 searches in ten minutes, then 429 rate_limited; the waiting read and another account are not limited', async () => {
  const s = await world();
  await s.person({ name: 'Marrowind' });
  for (let i = 0; i < 60; i++) assert.equal((await find(s, 'm1', 'marrow')).status, 200, `search ${i + 1}`);
  const limited = await find(s, 'm1', 'marrow');
  assert.deepEqual([limited.status, limited.json.error], [429, 'rate_limited']);
  assert.equal((await find(s, 'm1')).status, 200, 'no search, no count');
  assert.equal((await find(s, 'm2', 'marrow')).status, 200, 'the limit is per account');
});

check('an in-game guild takes Battle.net only: GET /auth/bnet says battlenetOnly and the lookup is 409 battlenet_only; legacy and manual guilds are not', async () => {
  const s = await world();
  const bnetOf = async (who) => (await s.ok(who, 'GET', '/auth/bnet', undefined, 200)).guilds.find((g) => g.guildId === s.gid);
  assert.equal((await bnetOf('m1')).battlenetOnly, false);
  assert.equal((await find(s, 'm1', 'ma')).status, 200);
  // m1 is seated first (an in-game guild lets in only an account whose person has a character on the roster), then the source changes.
  await seatOnRoster({ call: s.call, sqlite: s.w.db.sqlite, guildId: s.gid, teamId: s.alpha, userId: s.uids.m1 }, { name: 'Seatone', id: 71001 });
  s.exec(`UPDATE guilds SET rank_source = 'manual' WHERE id = '${s.gid}'`);
  assert.equal((await bnetOf('m1')).battlenetOnly, false);
  assert.equal((await find(s, 'm1', 'ma')).status, 200);
  s.exec(`UPDATE guilds SET rank_source = 'ingame' WHERE id = '${s.gid}'`);
  assert.equal((await bnetOf('m1')).battlenetOnly, true);
  const refused = await find(s, 'm1', 'ma');
  assert.deepEqual([refused.status, refused.json.error], [409, 'battlenet_only']);
});

check('approving a team request withdraws the other open requests of the same person for that team (one character per person per team); other teams and other people keep theirs', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo', 'Charlie'] });
  const [alpha, bravo, charlie] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  const p1 = await s.person({ name: 'Askmain' });
  await s.link(p1.pid, 'm1');
  const a1 = await s.alt(p1.pid, 'Askaltone');
  const a2 = await s.alt(p1.pid, 'Askalttwo');
  const a3 = await s.alt(p1.pid, 'Askaltthree');
  const p2 = await s.person({ name: 'Otherman' });
  await s.link(p2.pid, 'm2');
  const o2 = await s.alt(p2.pid, 'Otheralt');
  const made = {};
  for (const [key, who, character, team] of [['a1', 'm1', a1, bravo], ['a2', 'm1', a2, bravo], ['a3', 'm1', a3, charlie], ['o2', 'm2', o2, bravo]]) {
    const res = await ask(s, who, character, team);
    assert.equal(res.status, 201, key + ': ' + res.text);
    made[key] = res.json.request.id;
  }
  const approved = await s.ok('o1', 'POST', '/team-requests/' + made.a1 + '/approve', {}, 200);
  const status = async (key) => (await s.one('SELECT status, decided_by, decided_at FROM team_requests WHERE id = ?', made[key]));
  assert.equal((await status('a1')).status, 'approved');
  const closed = await status('a2');
  assert.deepEqual([closed.status, closed.decided_by, typeof closed.decided_at], ['withdrawn', null, 'number'], 'the second character request for the same team closes itself');
  assert.equal((await status('a3')).status, 'pending', 'a request for another team stays');
  assert.equal((await status('o2')).status, 'pending', 'a request of another person for the same team stays');
  assert.equal(approved.teamRequestFlags[bravo], 1, 'the badge counts what is left');
  assert.deepEqual((await s.ok('m1', 'GET', '/team-requests')).mine.map((r) => r.status).sort(), ['approved', 'pending', 'withdrawn']);
  assert.equal(await s.teamOf(a2), null, 'and that character is still on no team');
  assert.equal(alpha !== bravo, true);
});

check('placing a character answers 200 when D1 counts the trigger\'s row too (migration 0040: real D1 says 2 for a placement that worked): approve, place and release', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  const [alpha, bravo] = s.tids;
  await s.officer('o1', 'Officerone');
  await s.member('m1', 'Memberone');
  const main = await s.person({ name: 'Askmain' });
  await s.link(main.pid, 'm1');
  const a1 = await s.alt(main.pid, 'Askaltone');
  const a2 = await s.alt(main.pid, 'Askalttwo');
  // The stand-in D1 counts the rows a trigger wrote like real D1 does (tests/d1-fake.js: characters_team_since_move updates team_since), so a placement says 2 here too.
  const made = await ask(s, 'm1', a1, bravo);
  assert.equal(made.status, 201, made.text);
  const approved = await s.call('o1', 'POST', `/team-requests/${made.json.request.id}/approve`, {});
  assert.equal(approved.status, 200, approved.text);
  assert.equal(await s.teamOf(a1), bravo);
  const taken = await s.call('o1', 'PUT', `/roster/${main.pid}/characters/${a2}/team`, { teamId: bravo });
  assert.deepEqual([taken.status, taken.json.error], [409, 'team_taken']);
  const released = await s.call('o1', 'DELETE', `/roster/${main.pid}/characters/${a1}/team`, { fromTeamId: bravo });
  assert.equal(released.status, 200, released.text);
  assert.equal(await s.teamOf(a1), null);
  const again = await s.call('o1', 'PUT', `/roster/${main.pid}/characters/${a1}/team`, { teamId: bravo });
  assert.equal(again.status, 200, again.text);
  assert.equal(await s.teamOf(a1), bravo);
  assert.equal(alpha !== bravo, true);
});

check('the Home count counts every pending team request and every pending claim: one item per team and one for claims, `total` counts the asks inside them', async () => {
  const s = await world();
  const base = (await s.ok('o1', 'GET', '/attention')).total;
  const p1 = await s.person({ name: 'Askone' });
  await s.link(p1.pid, 'm1');
  const p2 = await s.person({ name: 'Asktwo' });
  await s.link(p2.pid, 'm2');
  const c1 = await s.alt(p1.pid, 'Askonealt');
  const c2 = await s.alt(p2.pid, 'Asktwoalt');
  assert.equal((await ask(s, 'm1', c1, s.bravo)).status, 201);
  assert.equal((await ask(s, 'm2', c2, s.bravo)).status, 201);
  await s.person({ name: 'Unlinkedmain' });
  assert.equal((await hand(s, 'm3', { name: 'Unlinkedmain' })).json.claims[0].status, 'pending');
  const attn = await s.ok('o1', 'GET', '/attention');
  assert.deepEqual(attn.items.filter((i) => i.kind === 'team_requests').map((i) => [i.teamId, i.count]), [[s.bravo, 2]]);
  assert.deepEqual(attn.items.filter((i) => i.kind === 'claims').map((i) => i.count), [1]);
  assert.equal(attn.total, base + 3, 'two requests and one claim');
});

check('GET /team-requests: the character carries its spec and whether approving starts its trial (a Trial with no clock); GET /claims names the roster record a link would link', async () => {
  const s = await world();
  await s.lead('tlb', [s.bravo], 'Leadbravo');
  const trial = await s.person({ name: 'Trialmain', status: 'trial', teamId: null, class: 'ROGUE', mainSpec: 'Combat' });
  await s.link(trial.pid, 'm1');
  const made = await ask(s, 'm1', trial.cid, s.bravo);
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.json.request.character.mainSpec, made.json.request.character.startsTrial], ['Combat', true]);
  const pending = (await s.ok('tlb', 'GET', '/team-requests')).pending;
  assert.deepEqual([pending[0].character.name, pending[0].character.mainSpec, pending[0].character.startsTrial], ['Trialmain', 'Combat', true]);
  await s.ok('tlb', 'POST', `/team-requests/${made.json.request.id}/approve`, {}, 200);
  const mine = (await s.ok('m1', 'GET', '/team-requests')).mine[0];
  assert.equal(mine.status, 'approved');
  assert.equal(mine.character.startsTrial, false, 'the clock started at the placement');
  // A link claim says which record it would link.
  const unlinked = await s.person({ name: 'Linkme', class: 'MAGE', mainSpec: 'Frost' });
  assert.equal((await hand(s, 'm2', { name: 'Linkme' })).json.claims[0].status, 'pending');
  const claim = (await s.ok('o1', 'GET', '/claims')).claims.find((c) => c.character.name === 'Linkme');
  assert.deepEqual([claim.plan.kind, claim.plan.person.id], ['link_person', unlinked.pid]);
  assert.deepEqual(claim.plan.record, { mainSpec: 'Frost', status: 'raider', team: { id: s.alpha, name: 'Alpha' } });
});

check('the not-a-member messages: in-game says connect Battle.net, legacy says join the Discord server and sign in again or claim, manual says apply or claim - none sends anyone to an officer', async () => {
  const { notMemberMessage } = await load('worker/membership.js');
  const ingame = notMemberMessage('ingame');
  const manual = notMemberMessage('manual');
  const legacy = notMemberMessage(null);
  assert(/Connect Battle\.net with a character that is in the guild/.test(ingame) && /in-game roster/.test(ingame), ingame);
  assert(/Join the Discord server and sign in again, or claim your roster entry/.test(legacy) && /Discord server/.test(legacy), legacy);
  assert(/Apply to the guild, or claim your roster entry/.test(manual) && !/Discord/.test(manual), manual);
  for (const text of [ingame, manual, legacy]) assert(!/officer/i.test(text) && !/link your account/i.test(text), text);
  assert.equal(notMemberMessage('something-new'), legacy, 'a source this file does not know is legacy');
  // And through the route.
  const s = await world();
  await s.outsider('out', 'Outsider');
  const refused = await s.call('out', 'GET', '/roster?team=' + s.alpha);
  assert.deepEqual([refused.status, refused.json.error, refused.json.message], [403, 'not_member', legacy]);
});

runChecks(checks);
