// The sentinel world (lane B6b part 3b): ONE in-game guild with every kind of principal and one of every kind of record, and a unique sentinel planted wherever the Worker keeps a value
// that no reply may carry outside the few allowed ones (the Owner / Guild Master tier's People pages and the exact-lookup of accounts). Nothing here is a test.
//   const s = await sentinelWorld();            -> the scenario (tests/guild-b3-world.js) plus s.people, s.ids, s.tokens, s.alpha, s.bravo
//   const planted = sentinelsOf(s);             -> [{ value, class, owner }]   class: one of CLASSES; owner: the key of the account the value belongs to, or null
// The principals (keys of s.jars): own = the live Owner, dgm = a derived Guild Master, dof = a derived Officer, dtl = a derived Team Lead (Alpha), sof = a stored Officer, stl = a stored
// Team Lead (Alpha), cust = a holder of the custom role "Loot council", mem = a plain member; blk and pnd are blocked, out1 is a signed-in outsider with an application. Not session
// principals: the guest of a guest link (s.tokens.guest), the API key (s.tokens.apiKey), the calendar feed of mem (s.tokens.calendar), a guest of a raid join link (s.tokens.join).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, scenario } = require('./guild-b3-world');
const { flip, makeProven } = require('./guild-ingame');
const { addApplication, addLoot, addPresence, addSignup, exec, pendingBlock, rowsOf } = require('./guild-evidence');
const { newJar } = require('./guild-world');

const KEY = 'test-tombstone-key-0123456789abcdef';
const WEBHOOK_ID = '123456789012345678';
const WEBHOOK_SECRET = 'SentinelWebhookSecret';

// The classes of what no reply may carry (plan "Redaction"; the first seven are the plan's list, `handle` and `token` come from the same helper's scope).
const CLASSES = ['discord_id', 'avatar', 'handle', 'bnet_account_id', 'blizzard_id', 'battletag', 'token_hash', 'token', 'webhook', 'tombstone'];

// The accounts: key, display name, in-game rank of its character (0 Guild Master ... 5 Social).
const SPEC = [
  ['own', 'Seatowner', 4], ['dgm', 'Derivedgm', 0], ['dof', 'Derivedoff', 1], ['dtl', 'Derivedlead', 2], ['sof', 'Storedoff', 5], ['stl', 'Storedlead', 5], ['cust', 'Customholder', 5],
  ['mem', 'Plainmember', 5], ['blk', 'Blockedone', 5], ['pnd', 'Pendingone', 5],
];
const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');
const CHAR_ID = (index) => 7000000000000000 + index;          // a Blizzard character id: 16 digits, unique, still an exact JS integer
const REALM = 87654321098;                                      // the Blizzard realm id of every character
const BNET_ID = (index) => `44000000000000000${String(index).padStart(2, '0')}`;
const BATTLETAG = (index) => `Sentineltag${index}#${5000 + index}`;
const LOOKUP_TAG = 'Lookuptag#6666';

// options: env (more bindings), routes (the routes of the app, for a test that adds one), wrap(s) (a suite's own helpers on the scenario, applied before anything is made)
async function sentinelWorld({ env = {}, routes, wrap = (scene) => scene } = {}) {
  const s = wrap(await scenario({
    teams: ['Alpha', 'Bravo'],
    ...(routes ? { routes } : {}),
    // The import routes check the server's credentials before the guild: configure them so the guild check (and the answer behind it) is reached.
    env: { TOMBSTONE_KEY: KEY, WCL_CLIENT_ID: 'wcl-id', WCL_CLIENT_SECRET: 'wcl-secret', BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret', ...env },
  }));
  [s.alpha, s.bravo] = s.tids;
  s.people = {};
  s.tokens = {};
  for (const [key, name] of SPEC) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
  }
  await s.ok('gm', 'PUT', `/people/${s.uids.sof}/roles`, { officer: true, teamLeadTeamIds: [] }, 200);
  await s.ok('gm', 'PUT', `/people/${s.uids.stl}/roles`, { officer: false, teamLeadTeamIds: [s.alpha] }, 200);
  const role = await s.ok('gm', 'POST', '/roles', { name: 'Loot council', permissions: { 'loot.view': 'guild' } });
  await s.ok('gm', 'PUT', `/people/${s.uids.cust}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: role.roles.find((entry) => entry.name === 'Loot council').id, teamId: null }] }, 200);
  let index = 0;
  for (const [key, , rank] of SPEC) {
    index++;
    const derivedRole = ['own', 'dgm', 'dof', 'dtl'].includes(key);
    makeProven(s, key, s.people[key], { rank, id: CHAR_ID(index), bnetId: BNET_ID(index), proof: derivedRole ? 'bnet' : 'officer', link: derivedRole });
    // Every account has a Battle.net link of its own, proven or not.
    exec(s, "INSERT OR IGNORE INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)", s.uids[key], BNET_ID(index), BATTLETAG(index));
    exec(s, 'UPDATE bnet_links SET battletag = ? WHERE user_id = ?', BATTLETAG(index), s.uids[key]);
  }
  flip(s, { owner: 'own' });
  exec(s, 'UPDATE characters SET blizzard_realm_id = ? WHERE blizzard_realm_id IS NOT NULL', REALM);
  exec(s, 'UPDATE guild_roster SET blizzard_realm_id = ?', REALM);
  await s.ok('own', 'POST', `/people/${s.uids.blk}/block`, { reason: 'Rude' }, 200);
  pendingBlock(s, 'pnd');
  // A person with a Discord id of their own, and a person who is blocked.
  s.ghost = await s.person({ name: 'Ghost' }, 'own');
  exec(s, "UPDATE players SET discord_user_id = '888000000000000001' WHERE id = ?", s.ghost.pid);
  s.wanted = await s.person({ name: 'Wanted' }, 'own');
  exec(s, "UPDATE players SET discord_user_id = '888000000000000002' WHERE id = ?", s.wanted.pid);
  await s.ok('own', 'POST', `/roster/${s.wanted.pid}/block`, { reason: 'Banned' }, 200);
  await s.outsider('out1', 'Outsiderone');
  // An account with a BattleTag that nobody has linked to a person: what an officer's exact lookup finds.
  await s.outsider('look', 'Lookupguy');
  exec(s, "INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)", s.uids.look, BNET_ID(90), LOOKUP_TAG);
  // The past raid is made through the API: its id has the shape the routes accept (a raid written with the columns would answer 404 to every path that names it).
  s.r1 = (await s.ok('own', 'POST', '/raids', { teamId: s.alpha, raidOn: '2026-12-01', startTime: '20:00', zone: 'Karazhan', title: 'Pastraid' }, 201)).raid.id;
  addLoot(s, s.r1, 'Lootguy');
  addPresence(s, s.r1, 'Logguy');
  addSignup(s, s.r1, { source: 'raid_helper', nickname: 'Helperguy', discordId: '555000000000000001' });
  addSignup(s, s.r1, { source: 'raid_helper', nickname: 'Selfhelper', discordId: rowsOf(s, 'SELECT discord_id FROM users WHERE id = ?', s.uids.dof)[0].discord_id });
  addApplication(s, { name: 'Hopeful' });
  addApplication(s, { name: 'Appchar', userId: s.uids.out1 });
  exec(s, 'INSERT INTO team_notifications (team_id, guild_id, webhook_url, updated_at) VALUES (?, ?, ?, 1)', s.alpha, s.gid, `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_SECRET}`);
  // Every account shows a Discord handle and an avatar of its own (the sign-in wrote a plain lower-case name and no avatar): unique values, so a reply that carries one is found.
  for (const key of Object.keys(s.uids)) {
    exec(s, 'UPDATE users SET username = ?, avatar = ? WHERE id = ?', `hndl_${key}_q9`, md5(`avatar-${key}`), s.uids[key]);
  }
  await records(s);
  return s;
}

// One of every kind of record the routes name (the ids the walker fills in), made through the API where it is simple and with the columns where it is not.
async function records(s) {
  const base = s.base;
  const own = (method, tail, body, status) => s.ok('own', method, tail, body, status);
  const alphaPerson = s.people.mem;
  // An officer's note on a person: a Team Lead who opens the person sees who wrote it (notes.updatedBy), as a name.
  await s.ok('dof', 'PUT', `/roster/${alphaPerson.pid}/notes`, { text: 'an officer note', expectedNotesVersion: 0 }, 200);
  // A teamless alt, and a team request for it.
  const alt = await s.alt(alphaPerson.pid, 'Sentinelalt', {}, 'own');
  exec(s, "INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, note, created_at) VALUES ('tq_Sentinelrequest00000000', ?, ?, ?, ?, 'a request note', 1)", s.gid, s.alpha, alt, s.uids.mem);
  // Raids: the past one has a report and loot (addPresence, addLoot and rows with ids of the right shape); an upcoming one carries a join link and the guest who used it.
  const upcoming = await own('POST', '/raids', { teamId: s.alpha, raidOn: '2027-02-10', startTime: '20:00', zone: 'Karazhan', title: 'Upcomingraid' }, 201);
  s.upcomingRaid = upcoming.raid.id;
  exec(s, 'UPDATE raids SET guests_open = 1 WHERE id = ?', s.upcomingRaid); // open to guests: a signed-in non-member may look at it (GET /api/open/:gid/raids/:rid)
  const join = await own('POST', `/raids/${s.upcomingRaid}/join-links`, { maxUses: 3 }, 201);
  s.tokens.join = join.created.token;
  const joiner = newJar();
  assert.equal((await s.w.call(joiner, 'POST', '/api/join/view', { token: join.created.token })).status, 200);
  assert.equal((await s.w.call(joiner, 'POST', '/api/join', { token: join.created.token, name: 'Joinguest', class: 'MAGE', spec: 'Fire', note: 'a guest note' })).status, 201);
  s.joinJar = joiner;
  // A guest link (Guest role), read by a guest.
  const link = await own('POST', '/guest-links', { roleId: 'guest', expiresIn: '7d', label: 'Sentinel link' }, 201);
  s.tokens.guest = link.created.token;
  s.guestJar = newJar();
  assert.equal((await s.w.call(s.guestJar, 'POST', '/auth/guest', { token: link.created.token })).status, 200);
  // The public page and the apply page.
  await own('PUT', '/public', { enabled: true, sections: ['roster', 'raids'] }, 200);
  await own('PUT', '/applications/settings', { enabled: true, questions: [{ label: 'An open question', type: 'short', required: false }] }, 200);
  // An API key reading every dataset of the guild, and a calendar feed of a plain member.
  const key = await own('POST', '/api-keys', { name: 'Sentinel key', teamId: null, datasets: ['roster', 'attendance', 'loot', 'raids'], expiresIn: '30d' }, 201);
  s.tokens.apiKey = key.created.token;
  const cal = await s.ok('mem', 'POST', '/calendar', { teamId: s.alpha }, 201);
  s.tokens.calendar = new URL(cal.url).pathname.replace('/cal/', '').replace(/\.ics$/, '');
  // An intent round with a pick, a character claim, an away notice.
  const round = await own('POST', `/teams/${s.alpha}/intent`, { title: 'Intent title' }, 201);
  await own('PUT', `/intent/${round.round.id}/picks/${s.people.mem.pid}`, { kind: 'main', class: 'MAGE', spec: 'Fire', note: 'an intent note' }, 200);
  exec(s, "INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, status, created_at) VALUES ('cl_Sentinelclaim0000000000', ?, ?, 'Claimchar', 'claimchar', 'Nightslayer', 'nightslayer', 'MAGE', 'pending', 1)", s.gid, s.uids.out1);
  exec(s, "INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, reason, created_at, updated_at) VALUES ('an_Sentinelnotice0000000', ?, ?, 'away', '2026-12-01', '2026-12-02', 'a reason', 1, 1)", s.gid, alphaPerson.pid);
  // A loot award and an application with ids of the shape the routes accept (the evidence helpers' ids are for the Users list only).
  const lootId = `lo_${'SentinelAward'.padEnd(22, '0')}`;
  const applicationId = `am_${'Sentinelapp'.padEnd(22, '0')}`;
  exec(s, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, winner_class, tag, note, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'sentinelsum1', 30001, 'Sentinel Trinket', 5, 'Plainmember', 'plainmember', 'nightslayer', 'MAGE', 'MS', 'a loot note', 1, 1)`, lootId, s.gid, s.r1, s.alpha);
  exec(s, `INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, realm, realm_key, class, spec, contact, answers, created_at, updated_at)
    VALUES (?, ?, ?, 'new', 'Sentinelhopeful', 'sentinelhopeful', 'Nightslayer', 'nightslayer', 'MAGE', 'Fire', 'a contact', '[]', 1, 1)`, applicationId, s.gid, s.alpha);
  const first = (text, ...values) => rowsOf(s, text, ...values)[0];
  s.ids = {
    gid: s.gid, tid: s.alpha, uid: s.uids.dof, ukey: s.uids.dof, pid: alphaPerson.pid, cid: alphaPerson.cid, rid: s.r1,
    rolid: first("SELECT id FROM roles WHERE guild_id = ? AND name = 'Loot council'", s.gid).id,
    lid: first('SELECT id FROM guest_links WHERE guild_id = ?', s.gid).id,
    code: first('SELECT code FROM raid_reports WHERE guild_id = ?', s.gid).code,
    aid: lootId,
    clid: 'cl_Sentinelclaim0000000000', nid: 'an_Sentinelnotice0000000', iid: round.round.id,
    apid: applicationId,
    kid: first('SELECT id FROM api_keys WHERE guild_id = ?', s.gid).id,
    jid: first('SELECT id FROM raid_join_links WHERE guild_id = ?', s.gid).id,
    trid: 'tq_Sentinelrequest00000000', itemid: `no_loot:${s.r1}`, lootitem: 30001,
    sid: 1, cal: `${s.tokens.calendar}.ics`, lookupTag: LOOKUP_TAG,
  };
  s.ids.cid2 = alt;
}

// Every planted value with its class and the account it belongs to (owner), read from the database as it is now. Values under 8 characters are no sentinel.
function sentinelsOf(s) {
  const planted = new Map();
  const owners = new Map(Object.entries(s.uids).map(([key, id]) => [id, key]));
  const put = (value, klass, owner = null) => {
    if (value === null || value === undefined || String(value).length < 8) return;
    const text = String(value);
    if (!planted.has(text)) planted.set(text, { value: text, class: klass, owner });
  };
  const take = (klass, text, ...bind) => rowsOf(s, text, ...bind).forEach((row) => { const [first, second] = Object.values(row); put(first, klass, second === undefined ? null : owners.get(second) || null); });
  take('discord_id', 'SELECT discord_id, id FROM users WHERE discord_id IS NOT NULL');
  take('discord_id', 'SELECT account_key, id FROM users WHERE account_key <> id'); // an account made without Discord has its own id as the key: that is no secret
  take('discord_id', 'SELECT discord_user_id FROM players WHERE discord_user_id IS NOT NULL');
  take('discord_id', 'SELECT discord_user_id FROM raid_signups WHERE discord_user_id IS NOT NULL');
  take('avatar', 'SELECT avatar, id FROM users WHERE avatar IS NOT NULL');
  take('handle', 'SELECT username, id FROM users');
  take('bnet_account_id', 'SELECT bnet_account_id, user_id FROM bnet_links');
  take('bnet_account_id', 'SELECT proof_bnet_account_id, proof_user_id FROM characters WHERE proof_bnet_account_id IS NOT NULL');
  take('battletag', 'SELECT battletag, user_id FROM bnet_links');
  take('blizzard_id', 'SELECT blizzard_char_id FROM characters WHERE blizzard_char_id IS NOT NULL');
  take('blizzard_id', 'SELECT blizzard_char_id FROM guild_roster');
  take('blizzard_id', 'SELECT DISTINCT blizzard_realm_id FROM guild_roster');
  for (const table of ['sessions', 'calendar_tokens', 'guest_links', 'api_keys', 'raid_join_links', 'dry_run_approvals']) take('token_hash', `SELECT token_hash FROM ${table}`);
  take('tombstone', 'SELECT hmac FROM block_tombstones');
  put(WEBHOOK_SECRET.slice(0, -4), 'webhook'); // the notifications reply may show the last four characters (webhookHint), never more
  put(WEBHOOK_ID, 'webhook');
  for (const [name, value] of Object.entries(s.tokens)) put(value, 'token', name === 'calendar' ? 'mem' : null);
  return [...planted.values()];
}

module.exports = { CLASSES, KEY, SPEC, LOOKUP_TAG, sentinelWorld, sentinelsOf };
