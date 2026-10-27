/**
 * Raidsmith guild tracker - lane B3 minimal UI, raids and guests: the open-raid sign-up in an IN-GAME guild (user decision 2026-10-26)
 * Run: node tests/guild/guild-b3ui-open-ingame-tests.js
 *
 *   - the view says HOW the guest signs up: signUp = { mode: 'typed' } in a guild that is not in-game; { mode: 'bnet', status, battletag, characters } in an in-game one,
 *     the characters being the account's own Battle.net list for the guild's game version (highest level first), with the status the page needs (not linked, expired,
 *     nothing loaded for this game yet, Blizzard failed);
 *   - POST in an in-game guild takes { character: { name, realmSlug }, spec, note? }: a typed name and class is refused (409 battlenet_only), so is no Battle.net link
 *     (409 bnet_not_linked), a stale or empty list (409 bnet_refresh) and a character that is not on the account's list (400, field character: another account's
 *     character, another realm's namesake, a made-up one); the stored name and class come from the list, never from the request;
 *   - in every other guild a character key changes nothing: the typed fields are still what is read.
 */
const assert = require('node:assert/strict');
const { runChecks, scenario, load } = require('../guild-b3-world');
const { derivedGm, flip } = require('../guild-ingame');

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const DAY = 24 * 60 * 60 * 1000;

async function world({ ingame = true } = {}) {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha] = s.tids;
  s.raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.alpha, raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan', guestsOpen: true, guestLimit: 3 })).raid.id;
  await s.outsider('out1', 'Outsiderone');
  await s.outsider('out2', 'Outsidertwo');
  if (ingame) flip(s, { owner: 'gm' });
  const { bnetSupport } = await load('worker/battlenet.js');
  s.namespace = bnetSupport('tbc', 'US').namespace;
  return s;
}

const MAGE = { name: 'Corvane', realm: 'Nightslayer', realmSlug: 'nightslayer', class: 'MAGE', level: 70 };
const ROGUE = { name: 'Nightbriar', realm: 'Nightslayer', realmSlug: 'nightslayer', class: 'ROGUE', level: 64 };
const DRUID = { name: 'Oakmender', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'DRUID', level: 70 };

// A Battle.net link for the account whose stored snapshot holds these characters for the guild's namespace (no Blizzard call is made). `entry` replaces the namespace
// entry (an error, or nothing), `age` is how long ago the list was loaded.
let linkCounter = 0;
async function bnetLink(s, who, characters, { entry, age = 0, namespace = s.namespace } = {}) {
  linkCounter++;
  const at = s.w.clock.now - age;
  const snapshot = entry === null ? {} : { [namespace]: entry || { fetchedAt: at, characters } };
  await s.w.db.prepare('DELETE FROM bnet_links WHERE user_id = ?').bind(s.uids[who]).run();
  await s.w.db.prepare('INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(s.uids[who], String(910000 + linkCounter), `Tag${who}#${4000 + linkCounter}`, at, JSON.stringify(snapshot), at).run();
}

const open = (s) => `/api/open/${s.gid}/raids/${s.raid}`;
const view = (s, who) => s.call(who, 'GET', open(s));
const signUp = (s, who, body) => s.call(who, 'POST', open(s), { website: '', ...body });
const pick = (character, extra = {}) => ({ character: { name: character.name, realmSlug: character.realmSlug }, spec: 'Fire', note: 'hi', ...extra });
const guestRows = (s) => s.rows("SELECT * FROM raid_signups WHERE raid_id = ? AND guest = 1 ORDER BY signup_id", s.raid);

check('the view: typed in a guild that is not in-game; in an in-game guild the account\'s Battle.net list, highest level first, in every state the page has to draw', async () => {
  const plain = await world({ ingame: false });
  assert.deepEqual((await view(plain, 'out1')).json.signUp, { mode: 'typed' });
  // Even with a Battle.net list on the account, a guild that is not in-game offers no pick.
  await bnetLink(plain, 'out1', [MAGE]);
  assert.deepEqual((await view(plain, 'out1')).json.signUp, { mode: 'typed' });

  const s = await world();
  let res = await view(s, 'out1');
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.signUp, { mode: 'bnet', status: 'not_linked', battletag: null, characters: [] }, 'no link: the page asks to connect Battle.net');
  await bnetLink(s, 'out1', [ROGUE, DRUID, MAGE]);
  res = await view(s, 'out1');
  assert.deepEqual(res.json.signUp.characters.map((c) => c.name), ['Corvane', 'Oakmender', 'Nightbriar'], 'level 70 first, then by name');
  assert.deepEqual([res.json.signUp.status, res.json.signUp.battletag], ['ok', `Tagout1#${4000 + linkCounter}`]);
  assert.deepEqual(Object.keys(res.json.signUp.characters[0]).sort(), ['class', 'level', 'name', 'realm', 'realmSlug'], 'no ids of Blizzard\'s leave the Worker');
  // One account's list is not another's.
  assert.deepEqual((await view(s, 'out2')).json.signUp.status, 'not_linked');
  // The other states.
  await bnetLink(s, 'out1', [MAGE], { age: 31 * DAY });
  assert.deepEqual((await view(s, 'out1')).json.signUp, { mode: 'bnet', status: 'expired', battletag: `Tagout1#${4000 + linkCounter}`, characters: [] });
  await bnetLink(s, 'out1', [], { entry: null });
  assert.equal((await view(s, 'out1')).json.signUp.status, 'needs_refresh');
  await bnetLink(s, 'out1', [], { entry: { fetchedAt: s.w.clock.now, error: 'unavailable' } });
  assert.equal((await view(s, 'out1')).json.signUp.status, 'unavailable');
  await bnetLink(s, 'out1', [MAGE], { namespace: 'profile-classic1x-us' });
  assert.equal((await view(s, 'out1')).json.signUp.status, 'needs_refresh', 'a list for another game is not this guild\'s list');
  for (const word of ['characterId', 'realmId']) assert(!JSON.stringify((await view(s, 'out1')).json).includes(word), word);
});

check('a member of an in-game guild is told so and never reads their Battle.net list here: the mode only, no BattleTag, no character', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  s.raid = (await s.ok('gm', 'POST', '/raids', { teamId: s.tids[0], raidOn: '2099-02-01', startTime: '20:00', zone: 'Karazhan', guestsOpen: true })).raid.id;
  await derivedGm(s, 'dgm', 'Derivedgm'); // a plain member whose character sits on in-game rank 0, made before the flip
  flip(s, { owner: 'gm' });
  const { bnetSupport } = await load('worker/battlenet.js');
  s.namespace = bnetSupport('tbc', 'US').namespace;
  await bnetLink(s, 'dgm', [MAGE]);
  const res = await view(s, 'dgm');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.member, true);
  assert.deepEqual(res.json.signUp, { mode: 'bnet' });
  assert(!res.text.includes('Tag') && !res.text.includes('Corvane'), 'no BattleTag, no character');
});

check('in-game sign-up: the character is picked from the account\'s Battle.net list; the stored name and class come from the list, not from the request', async () => {
  const s = await world();
  await bnetLink(s, 'out1', [MAGE, ROGUE]);
  // A tampered name and class beside the pick change nothing: the list decides.
  const res = await signUp(s, 'out1', pick(MAGE, { name: 'Impostor', class: 'WARRIOR' }));
  assert.equal(res.status, 201, res.text);
  assert.deepEqual([res.json.ok, res.json.spotsLeft], [true, 2], 'a limit of 3: two spots left');
  const [row] = await guestRows(s);
  assert.deepEqual(
    [row.nickname, row.class_name, row.spec_name, row.note, row.guest_user_id, row.player_id, row.character_id, row.join_link_id],
    ['Corvane', 'Mage', 'Fire', 'hi', s.uids.out1, null, null, null],
  );
  const mine = (await view(s, 'out1')).json;
  assert.deepEqual([mine.mine.name, mine.mine.className, mine.spotsLeft], ['Corvane', 'Mage', 2]);
  // The spec has to be one of the picked character's class (a Rogue has no Fire).
  await s.w.db.prepare('DELETE FROM raid_signups WHERE raid_id = ?').bind(s.raid).run();
  const wrongSpec = await signUp(s, 'out1', pick(ROGUE));
  assert.deepEqual([wrongSpec.status, wrongSpec.json.field], [400, 'spec']);
  assert.equal((await signUp(s, 'out1', pick(ROGUE, { spec: 'Combat' }))).status, 201);
  assert.equal((await guestRows(s))[0].class_name, 'Rogue');
  // Withdraw works as everywhere.
  assert.equal((await s.call('out1', 'DELETE', open(s), {})).status, 200);
  assert.equal((await guestRows(s)).length, 0);
});

check('in-game sign-up refuses a typed character (409 battlenet_only), whatever else is sent; nothing is stored', async () => {
  const s = await world();
  await bnetLink(s, 'out1', [MAGE]);
  for (const body of [
    { name: 'Wanderer', class: 'MAGE', spec: 'Fire' },
    { name: 'Corvane', class: 'MAGE', spec: 'Fire' }, // the name of a character that IS on the list: still typed
    { spec: 'Fire' },
    { character: null, name: 'Wanderer', class: 'MAGE', spec: 'Fire' },
  ]) {
    const res = await signUp(s, 'out1', body);
    assert.deepEqual([res.status, res.json.error], [409, 'battlenet_only'], JSON.stringify(body));
    assert.match(res.json.message, /Writers B3 takes guests through Battle\.net/);
  }
  assert.equal((await guestRows(s)).length, 0);
  // A character that is not an object is a bad request on the character.
  for (const character of ['Corvane', 7, ['Corvane'], { name: 'Corvane' }, { realmSlug: 'nightslayer' }, { name: 5, realmSlug: 'nightslayer' }]) {
    const res = await signUp(s, 'out1', { character, spec: 'Fire' });
    assert.deepEqual([res.status, res.json.field], [400, 'character'], JSON.stringify(character));
  }
  assert.equal((await guestRows(s)).length, 0);
});

check('in-game sign-up: the picked character must be on THIS account\'s list (another account\'s, another realm\'s namesake and a made-up one are refused); no link and a stale list are told apart', async () => {
  const s = await world();
  await bnetLink(s, 'out1', [MAGE]);
  await bnetLink(s, 'out2', [ROGUE]);
  const refused = async (who, character, status = 400, field = 'character') => {
    const res = await signUp(s, who, pick(character, { spec: 'Fire' }));
    assert.deepEqual([res.status, res.json.field], [status, field], `${who} ${character.name}: ${res.text}`);
    return res.json;
  };
  await refused('out1', ROGUE); // out2's character
  await refused('out2', MAGE); // out1's character
  await refused('out1', { ...MAGE, realmSlug: 'dreamscythe' }); // the right name on a realm the account does not have it on
  await refused('out1', { name: 'Madeup', realmSlug: 'nightslayer' });
  assert.equal((await guestRows(s)).length, 0);
  // A name is compared the way the roster compares them: case does not matter, the realm does.
  assert.equal((await signUp(s, 'out1', pick({ name: 'corvane', realmSlug: 'nightslayer' }))).status, 201);
  assert.equal((await guestRows(s))[0].nickname, 'Corvane', 'the list\'s spelling is stored');

  // Not linked at all: connect first. Expired or nothing loaded for this game: connect again.
  const nolink = await signUp(s, 'out2', pick(ROGUE, { spec: 'Combat' }));
  assert.equal(nolink.status, 201, 'out2 is linked');
  await s.w.db.prepare('DELETE FROM bnet_links WHERE user_id = ?').bind(s.uids.out2).run();
  await s.w.db.prepare('DELETE FROM raid_signups WHERE guest_user_id = ?').bind(s.uids.out2).run();
  const unlinked = await signUp(s, 'out2', pick(ROGUE, { spec: 'Combat' }));
  assert.deepEqual([unlinked.status, unlinked.json.error], [409, 'bnet_not_linked']);
  await bnetLink(s, 'out2', [ROGUE], { age: 31 * DAY });
  assert.deepEqual([(await signUp(s, 'out2', pick(ROGUE, { spec: 'Combat' }))).json.error], ['bnet_refresh']);
  await bnetLink(s, 'out2', [], { entry: null });
  assert.deepEqual([(await signUp(s, 'out2', pick(ROGUE, { spec: 'Combat' }))).json.error], ['bnet_refresh']);
  assert.equal((await guestRows(s)).length, 1, 'only out1\'s sign-up exists');
});

check('in-game sign-up: the other rules still hold (a roster name, one per account, the guest limit, the hidden field)', async () => {
  const s = await world({ ingame: false });
  // A roster character that an account also has on its Battle.net list (before the flip: the roster is public data, so the name is refused as it is for a typed one).
  await s.person({ name: 'Corvane', class: 'MAGE', mainSpec: 'Fire' });
  flip(s, { owner: 'gm' });
  await bnetLink(s, 'out1', [MAGE, ROGUE]);
  const onRoster = await signUp(s, 'out1', pick(MAGE));
  assert.deepEqual([onRoster.status, onRoster.json.error, onRoster.json.field], [409, 'on_roster', 'name']);
  assert.match(onRoster.json.message, /Sign in with the account that has it/, 'no Discord word in an in-game guild');
  assert.equal((await signUp(s, 'out1', pick(ROGUE, { spec: 'Combat' }))).status, 201);
  const again = await signUp(s, 'out1', pick(ROGUE, { spec: 'Combat' }));
  assert.deepEqual([again.status, again.json.error], [409, 'already_signed_up']);
  // The hidden field stores nothing and says it worked.
  const honey = await s.call('out2', 'POST', open(s), { ...pick(MAGE), website: 'http://spam' });
  assert.deepEqual([honey.status, honey.json.ok], [201, true]);
  assert.equal((await guestRows(s)).length, 1);
  // The limit (3) fills up: raid_full.
  for (const [n, who] of [[1, 'a1'], [2, 'a2']]) {
    await s.outsider(who, `Guest${n}`);
    await bnetLink(s, who, [{ ...MAGE, name: `Guestmage${n === 1 ? 'a' : 'b'}` }]);
    assert.equal((await signUp(s, who, pick({ name: `Guestmage${n === 1 ? 'a' : 'b'}`, realmSlug: 'nightslayer' }))).status, 201);
  }
  const late = { ...MAGE, name: 'Latecomer' };
  await bnetLink(s, 'out2', [late]);
  const full = await signUp(s, 'out2', pick(late));
  assert.deepEqual([full.status, full.json.error], [409, 'raid_full']);
});

check('a guild that is not in-game still reads the typed fields: a character key is ignored, nothing is picked from Battle.net', async () => {
  const s = await world({ ingame: false });
  await bnetLink(s, 'out1', [MAGE]);
  const typed = await signUp(s, 'out1', { name: 'Wanderer', class: 'MAGE', spec: 'Fire', character: { name: 'Corvane', realmSlug: 'nightslayer' } });
  assert.equal(typed.status, 201, typed.text);
  assert.equal((await guestRows(s))[0].nickname, 'Wanderer');
  const bare = await signUp(s, 'out2', { character: { name: 'Corvane', realmSlug: 'nightslayer' }, spec: 'Fire' });
  assert.deepEqual([bare.status, bare.json.field], [400, 'name'], 'without a typed name there is nothing to read');
});

runChecks(checks);
