/**
 * Raidsmith guild tracker - lane B6b part 3b: ONE redaction helper by viewer tier (worker/redact.js) and the sentinel CI over every route
 * Run: node tests/guild/guild-b6b-p3b-redaction-tests.js        (P3B_DEBUG=1 prints every hit that is not allowed, grouped)
 *
 *   helper ........ worker/redact.js: the tier of a guild context, what each tier reveals, toPerson's default (no avatar, no handle), the viewers that are no member, View-as
 *   walker ........ a unique sentinel planted for every class (Discord id, avatar, Discord handle, Battle.net account id, Blizzard character / realm id, BattleTag, token hash, raw token,
 *                   webhook, tombstone HMAC) in an in-game guild with every kind of principal; EVERY route of worker/index.js ROUTES is called as each principal (the live Owner, a
 *                   derived Guild Master / Officer / Team Lead, a stored Officer / Team Lead, a custom-role holder, a plain member, a signed-in non-member, a guest of a guest link, a guest
 *                   of a join link, the public, an API key, a calendar feed); no sentinel is in any body or Location outside the explicit ALLOWED list (route + principal + class, each
 *                   with a reason, each used)
 *   coverage ...... a GET route must answer 2xx or 3xx for somebody, or be listed in UNREACHED with a reason; a route whose ids the fixture cannot fill fails; a route that answers 500
 *                   fails: a new route fails here until it is classified. A deliberately leaky route is added to a copy of ROUTES to prove the walker would catch it
 *   replies ....... the answers of writes (People, API keys, guest links, notes, editing a person) as an Officer and as a Team Lead; the legacy guild's linkable list
 *   source ........ no worker file but worker/person.js and worker/redact.js builds a person from a users row or an avatar URL; every personFor call names a viewer
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { newJar } = require('../guild-world');
const { CLASSES, sentinelWorld, sentinelsOf } = require('../guild-sentinels');

const ROOT = path.join(__dirname, '..', '..');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// ---------------------------------------------------------------------------
// What may carry a sentinel: routes (method + path of ROUTES) + principals + classes (+ own: only the caller's own value). Every entry has a reason, and every principal of an entry
// must have had a hit (the list is as narrow as the code). The people who may open People: the Owner, a Guild Master, an Officer (derived or stored).
const SESSION = ['own', 'dgm', 'dof', 'dtl', 'sof', 'stl', 'cust', 'mem', 'out1'];
const OPENS_PEOPLE = ['own', 'dgm', 'dof', 'sof'];
const AVATAR = ['discord_id', 'avatar', 'handle']; // an avatar URL carries the Discord ID and the avatar hash; the handle is its card's username
const ALLOWED = [
  { routes: ['GET /auth/me'], who: SESSION, classes: ['discord_id', 'avatar', 'handle', 'battletag'], own: true, reason: 'the signed-in account\'s own sign-in data (its avatar, handle and linked BattleTag), to itself' },
  { routes: ['GET /auth/bnet'], who: SESSION.filter((id) => id !== 'out1'), classes: ['battletag'], own: true, reason: 'the account\'s own Battle.net link, to itself' },
  { routes: ['GET /api/guild/:gid/people', 'POST /api/guild/:gid/people/:uid/block', 'PUT /api/guild/:gid/people/:uid/roles'], who: OPENS_PEOPLE, classes: AVATAR,
    reason: 'People and roles: the cards of the guild\'s accounts, for whoever opens People (guild.access or guild.roles: the Owner, a Guild Master, an Officer); REVEAL in worker/redact.js' },
  { routes: ['GET /api/guild/:gid'], who: OPENS_PEOPLE, classes: AVATAR, reason: 'the guild payload lists the Team Leads of each team: their cards, for whoever opens People (everyone else gets name and initials)' },
  { routes: ['GET /api/guild/:gid/api-keys', 'POST /api/guild/:gid/api-keys', 'GET /api/guild/:gid/guest-links', 'POST /api/guild/:gid/guest-links'], who: OPENS_PEOPLE, classes: AVATAR,
    reason: 'Guild settings > Data access and guest links (guild.access): who made each key or link, as a card' },
  { routes: ['GET /api/guild/:gid/join-links'], who: OPENS_PEOPLE, classes: ['handle'], reason: 'Guild settings: who made each sign-up link (guild.access), by name and handle, never an avatar' },
  { routes: ['GET /api/guild/:gid/roster/:pid', 'PUT /api/guild/:gid/roster/:pid/notes'], who: OPENS_PEOPLE, classes: AVATAR, reason: 'the person record: the account behind the person and who wrote the notes, as cards, for whoever opens People' },
  { routes: ['GET /api/guild/:gid/team-requests', 'GET /api/guild/:gid/claims'], who: OPENS_PEOPLE, classes: AVATAR, reason: 'the requester / claimant card of the officers\' queues, for whoever opens People (a Team Lead gets name and initials)' },
  { routes: ['GET /api/guild/:gid/accounts'], who: OPENS_PEOPLE, classes: ['battletag'], reason: 'the exact lookup: an officer typed a whole BattleTag and gets that BattleTag back with the account (never the Discord id, avatar or handle)' },
];

// GET routes that answer nothing but errors to every principal of the fixture: why each one is not walked to its payload.
const UNREACHED = {
  'GET /api/guild/:gid/attendance/backfill/reports': 'asks Warcraft Logs, which the fixture cannot reach (502 wcl_unavailable by design); its payload is report titles',
  'GET /api/guild/:gid/roster/unlinked': 'the fixture guild is an in-game guild, which refuses it (409 battlenet_only); its reply is roster names, class, spec and team plus the caller\'s own waiting claims (checked in guild-b3ui-lookup-worker-tests.js)',
  'GET /api/dev/guild/:gid/viewer': 'dev-only View-as: 404 unless DEV_VIEW_AS=1 on 127.0.0.1 (pinned closed in the isolation suite); the tier of a stand-in is checked in the helper tests below',
};

// ---------------------------------------------------------------------------
// The walker

const STEP_MS = 30_000; // between requests: no per-minute limit decides an answer
const PHANTOM_TAIL = 'ZZZZZZZZZZZZZZZZZZZZZZ';
// Ids of the right shape that nothing has: a write sent with them is refused or finds nothing, so the walk never changes the fixture.
const PHANTOM = {
  tid: `t_${PHANTOM_TAIL}`, uid: `u_${PHANTOM_TAIL}`, ukey: `u_${PHANTOM_TAIL}`, pid: `p_${PHANTOM_TAIL}`, cid: `c_${PHANTOM_TAIL}`, rid: `r_${PHANTOM_TAIL}`, aid: `lo_${PHANTOM_TAIL}`,
  lootitem: '1234567', clid: `cl_${PHANTOM_TAIL}`, rolid: `cr_${PHANTOM_TAIL}`, lid: `gl_${PHANTOM_TAIL}`, nid: `an_${PHANTOM_TAIL}`, iid: `ir_${PHANTOM_TAIL}`, apid: `am_${PHANTOM_TAIL}`,
  code: 'ZZZZZZZZZZZZZZZZ', kid: `ak_${PHANTOM_TAIL}`, jid: `jl_${PHANTOM_TAIL}`, trid: `tq_${PHANTOM_TAIL}`, itemid: 'claims', sid: '999', dataset: 'roster.csv',
  cal: `${'Z'.repeat(43)}.ics`,
};
const keyOf = (route) => `${route.method} ${route.path}`;
const paramsOf = (route) => [...route.path.matchAll(/:([a-z]+)/g)].map((match) => match[1]);
const fill = (route, ids) => route.path.replace(/:([a-z]+)/g, (_, name) => {
  assert(ids[name] !== undefined, `the walker has no ${name} to fill in ${keyOf(route)}: give the fixture one`);
  return ids[name];
});

// The principals. session: the cookie of that account (a key of s.jars). cookie: the jar of a visitor. key / calendar: a credential that is no session.
function principals(s) {
  const list = [
    ['own', 'the live Owner'], ['dgm', 'a derived Guild Master'], ['dof', 'a derived Officer'], ['dtl', 'a derived Team Lead'], ['sof', 'a stored Officer'], ['stl', 'a stored Team Lead'],
    ['cust', 'a custom-role holder'], ['mem', 'a plain member'], ['out1', 'a signed-in non-member'],
  ].map(([id, label]) => ({ id, label, kind: 'session', jar: () => ({ ...s.jars[id] }) }));
  list.push({ id: 'guest', label: 'the guest of a guest link', kind: 'cookie', jar: () => ({ ...s.guestJar }) });
  list.push({ id: 'join', label: 'the guest of a raid join link', kind: 'cookie', jar: () => ({ ...s.joinJar }) });
  list.push({ id: 'public', label: 'the public', kind: 'cookie', jar: () => newJar() });
  list.push({ id: 'key', label: 'an API key', kind: 'key', jar: () => newJar() });
  list.push({ id: 'calendar', label: 'a calendar feed', kind: 'calendar', jar: () => newJar() });
  return list;
}

// What one principal sends to one route: [{ label, method, path, body, headers }]
function requestsFor(s, route, principal) {
  const key = keyOf(route);
  const out = [];
  // An open raid is the one record of a route that is not the fixture's usual: the upcoming raid that is open to guests.
  const ids = key === 'GET /api/open/:gid/raids/:rid' ? { ...s.ids, rid: s.upcomingRaid } : s.ids;
  const path = fill(route, { ...ids, dataset: 'roster.json' });
  const phantomPath = route.path.replace(/:([a-z]+)/g, (_, name) => (name === 'gid' ? ids.gid : PHANTOM[name]));
  const headers = principal.kind === 'key' ? { Authorization: `Bearer ${s.tokens.apiKey}` } : {};
  if (route.path === '/api/v1/:dataset') {
    // The API key's own route: every dataset in both formats, the key in the header and (CSV only) in the address. Everyone else asks once with no key.
    if (principal.kind !== 'key') return [{ label: 'no key', method: 'GET', path: '/api/v1/roster.json', headers }];
    for (const dataset of ['roster', 'attendance', 'loot', 'raids']) for (const format of ['csv', 'json']) out.push({ label: `${dataset}.${format}`, method: 'GET', path: `/api/v1/${dataset}.${format}`, headers });
    out.push({ label: 'csv with ?key=', method: 'GET', path: `/api/v1/roster.csv?key=${s.tokens.apiKey}`, headers: {} });
    return out;
  }
  if (route.path === '/api/join/view' || route.path === '/api/join') return [{ label: 'token only', method: 'POST', path, body: { token: s.tokens.join }, headers }];
  if (route.path === '/auth/guest' && route.method === 'POST') return [{ label: 'redeem', method: 'POST', path, body: { token: s.tokens.guest }, headers }];
  if (route.method !== 'GET') return [{ label: 'probe', method: route.method, path: phantomPath, body: {}, headers }];
  out.push({ label: 'read', method: 'GET', path: `${path}?team=${ids.tid}`, headers });
  const extra = {
    'GET /api/guild/:gid/users': ['segment=nonmembers', 'segment=former', 'segment=blocked'],
    'GET /api/guild/:gid/raid-for-event': ['event=100000'],
    'GET /api/guild/:gid/accounts': [`q=${encodeURIComponent(s.ids.lookupTag)}`],
  }[key] || [];
  for (const query of extra) out.push({ label: `read ${query}`, method: 'GET', path: `${path}?${query}`, headers });
  return out;
}

// The scan of one response: every planted value in the body or in a Location header (also percent-decoded).
function scanResponse(planted, res) {
  const location = res.headers.get('location') || '';
  let decoded = location;
  try { decoded = decodeURIComponent(location); } catch { /* keep the raw address */ }
  const where = [['body', res.text], ['location', location], ['location', decoded]];
  const hits = [];
  for (const sentinel of planted) {
    for (const [name, text] of where) if (text && text.includes(sentinel.value)) { hits.push({ ...sentinel, in: name }); break; }
  }
  return hits;
}

async function walk(s, routes, { only = null } = {}) {
  const planted = sentinelsOf(s);
  const hits = [];             // { route, principal, request, status, ...sentinel, in }
  const answered = new Map();  // route key -> Set of "principal:status"
  const problems = [];
  let sent = 0;
  for (const principal of principals(s).filter((entry) => !only || only.includes(entry.id))) {
    for (const route of routes) {
      const key = keyOf(route);
      if ((principal.kind === 'calendar') !== (route.path === '/cal/:cal')) continue;       // the feed is the calendar's route, and its only one
      if (principal.kind === 'key' && route.method !== 'GET') continue;                       // a key is asked on every read, to see that it opens nothing but its own datasets
      if (!paramsOf(route).includes('gid') && route.auth && route.method !== 'GET') continue; // account writes act on the caller's own account: the account suites' business
      let requests;
      try { requests = requestsFor(s, route, principal); } catch (error) { problems.push(String(error.message)); continue; }
      for (const request of requests) {
        s.w.advance(STEP_MS);
        const res = await s.w.call(principal.jar(), request.method, request.path, request.body, { headers: request.headers });
        sent++;
        if (!answered.has(key)) answered.set(key, new Set());
        answered.get(key).add(`${principal.id}:${res.status}`);
        if (res.status === 500) problems.push(`${principal.id} ${key} answered 500: ${res.text.slice(0, 120)}`);
        for (const hit of scanResponse(planted, res)) hits.push({ route: key, principal: principal.id, request: request.label, status: res.status, ...hit });
      }
    }
  }
  return { hits, answered, problems, planted, sent };
}

const describeHit = (hit) => `${hit.route} | ${hit.principal} | ${hit.class}${hit.owner ? ` (of ${hit.owner})` : ''} | ${hit.in}`;
const groupHits = (hits) => {
  const seen = new Map();
  for (const hit of hits) seen.set(describeHit(hit), (seen.get(describeHit(hit)) || 0) + 1);
  return [...seen].map(([id, n]) => `${n}x ${id}`);
};

// The hits that no ALLOWED entry covers, and the (entry, principal) pairs that never had a hit.
function classify(hits, { complete = true } = {}) {
  const leaks = [];
  const used = new Set();
  for (const hit of hits) {
    const index = ALLOWED.findIndex((entry) => entry.routes.includes(hit.route) && entry.who.includes(hit.principal) && entry.classes.includes(hit.class)
      && (!entry.own || hit.owner === hit.principal));
    if (index < 0) leaks.push(hit); else used.add(`${index}|${hit.principal}`);
  }
  const unused = [];
  if (complete) ALLOWED.forEach((entry, index) => entry.who.forEach((who) => { if (!used.has(`${index}|${who}`)) unused.push(`${entry.routes[0]} for ${who}`); }));
  return { leaks, unused };
}

// GET routes that nobody got a 2xx / 3xx answer from and that are not listed with a reason; listed ones that were reached after all.
function unreachedRoutes(routes, answered) {
  const missing = [];
  const stale = [];
  for (const route of routes) {
    if (route.method !== 'GET') continue;
    const key = keyOf(route);
    const reached = [...(answered.get(key) || [])].some((entry) => /:[23]\d\d$/.test(entry));
    if (!reached && !UNREACHED[key]) missing.push(`${key} -> ${[...new Set([...(answered.get(key) || [])].map((entry) => entry.split(':')[1]))].join(',') || 'never asked'}`);
    if (reached && UNREACHED[key]) stale.push(key);
  }
  return { missing, stale };
}

// ---------------------------------------------------------------------------
// The helper

check('toPerson shows a name and initials and nothing else unless it is told to: no avatar, no handle by default', async () => {
  const { toPerson } = await load('worker/person.js');
  const row = { id: 'u_x', discord_id: '777000000000000001', username: 'hndl_row_q9', global_name: 'Globalname', display_name: null, avatar: 'ab'.repeat(16) };
  const plain = toPerson(row);
  assert.deepEqual(plain, { id: 'u_x', username: '', displayName: 'Globalname', avatarUrl: null, initials: 'GL' });
  assert(toPerson(row, { avatar: true }).avatarUrl.includes('777000000000000001'), 'the avatar is an opt-in');
  assert.equal(toPerson(row, { handle: true }).username, 'hndl_row_q9');
  assert.equal(toPerson(row, { avatar: true }).username, '', 'one opt-in does not open the other');
  // An account with no chosen name and no Discord global name IS shown by its username (the name the account shows), with or without the handle opt-in.
  assert.equal(toPerson({ ...row, global_name: null }).displayName, 'hndl_row_q9');
});

check('redact: personFor opts in by the viewer and never beyond the emitter\'s ceiling; a field that does not exist throws', async () => {
  const redact = await load('worker/redact.js');
  const row = { id: 'u_x', discord_id: '777000000000000001', username: 'hndl_row_q9', global_name: 'Globalname', display_name: null, avatar: 'ab'.repeat(16) };
  const staff = redact.viewerAtTier('guild_master');
  const both = redact.personFor(row, staff);
  assert(both.avatarUrl.includes('777000000000000001') && both.username === 'hndl_row_q9');
  assert.deepEqual(redact.personFor(row, staff, { ceiling: ['handle'] }), { ...both, avatarUrl: null }, 'the join links never showed an avatar: the ceiling keeps it out for staff too');
  assert.deepEqual(redact.personFor(row, staff, { ceiling: [] }), { ...both, avatarUrl: null, username: '' });
  for (const key of ['guest', 'public', 'key', 'calendar', 'lookup']) {
    assert.deepEqual(redact.personFor(row, redact.VIEWERS[key]), { ...both, avatarUrl: null, username: '' }, `${key} sees a name and initials`);
  }
  assert.deepEqual(redact.personFor(row, redact.VIEWERS.self), both, 'the caller\'s own account to itself');
  assert.throws(() => redact.mayReveal(staff, 'discordId'), /not a field/);
  assert.deepEqual([...redact.FIELDS], ['avatar', 'handle']);
  assert.deepEqual(redact.TIERS.slice(0, 4), ['guild_master', 'officer', 'team_lead', 'member']);
  // viewerAtTier follows the tier alone: Officer and above, nothing below.
  for (const [tier, shows] of [['guild_master', true], ['officer', true], ['team_lead', false], ['member', false], ['guest', false], ['public', false], ['key', false], ['calendar', false]]) {
    assert.equal(redact.viewerAtTier(tier).reveals.has('avatar'), shows, tier);
    assert.equal(redact.viewerAtTier(tier).reveals.has('handle'), shows, tier);
  }
});

check('redact: the tier needs BOTH the rank and one of the staff actions (an Officer role stripped of them reveals nothing; a rank below Officer never does)', async () => {
  const { viewerFor, tierOf } = await load('worker/redact.js');
  const context = (rank, can) => ({ rank, can });
  assert.deepEqual([0, 1, 2, 3, 7].map((rank) => tierOf(context(rank, {}))), ['guild_master', 'officer', 'team_lead', 'member', 'member']);
  const shows = (rank, can) => [...viewerFor(context(rank, can)).reveals].sort();
  assert.deepEqual(shows(0, { 'guild.roles': 'guild' }), ['avatar', 'handle']);
  assert.deepEqual(shows(1, { 'guild.access': 'guild' }), ['avatar', 'handle']);
  assert.deepEqual(shows(1, { 'roster.view': 'guild', 'guild.access': ['t_x'] }), [], 'a team-scoped action is no People gate (allows() needs the whole guild)');
  assert.deepEqual(shows(1, { 'roster.edit': 'guild' }), [], 'an Officer without guild.access and guild.roles');
  assert.deepEqual(shows(2, { 'guild.access': 'guild', 'guild.roles': 'guild' }), [], 'a Team Lead never reveals, whatever it holds');
  assert.deepEqual(shows(3, { 'guild.access': 'guild' }), [], 'a Member never reveals');
});

check('redact: the tier and the reveals of every principal of a real guild (Owner, derived and stored staff, custom role, member), and of a View-as stand-in', async () => {
  const { viewerFor, tierOf } = await load('worker/redact.js');
  const { loadGuildContext } = await load('worker/permissions.js');
  const s = await sentinelWorld();
  const expected = {
    own: ['guild_master', true], dgm: ['guild_master', true], dof: ['officer', true], sof: ['officer', true],
    dtl: ['team_lead', false], stl: ['team_lead', false], cust: ['member', false], mem: ['member', false],
  };
  for (const [key, [tier, reveals]] of Object.entries(expected)) {
    const context = await loadGuildContext(s.w.db, s.uids[key], s.gid);
    const viewer = viewerFor(context);
    assert.equal(tierOf(context), tier, key);
    assert.equal(viewer.tier, tier, key);
    assert.deepEqual([...viewer.reveals].sort(), reveals ? ['avatar', 'handle'] : [], key);
  }
  // View-as (dev): the Owner previewing a role is read with that role's rights, so a preview of a Member or a Team Lead shows what they see, never more.
  const as = async (roleId, teamId = null) => viewerFor(await loadGuildContext(s.w.db, s.uids.own, s.gid, { guildId: s.gid, roleId, teamId }));
  assert.deepEqual([(await as('member')).tier, [...(await as('member')).reveals]], ['member', []]);
  assert.deepEqual([(await as('team_lead', s.alpha)).tier, [...(await as('team_lead', s.alpha)).reveals]], ['team_lead', []]);
  assert.deepEqual([(await as('officer')).tier, [...(await as('officer')).reveals].sort()], ['officer', ['avatar', 'handle']]);
});

// ---------------------------------------------------------------------------
// The walker

check('the sentinel world plants every class once or more, for accounts that are all different', async () => {
  const s = await sentinelWorld();
  const planted = sentinelsOf(s);
  for (const klass of CLASSES) assert(planted.some((entry) => entry.class === klass), `no ${klass} sentinel`);
  assert(planted.length >= 90, `${planted.length} sentinels`);
  assert.equal(new Set(planted.map((entry) => entry.value)).size, planted.length);
  assert(planted.some((entry) => entry.class === 'tombstone') && planted.some((entry) => entry.class === 'webhook'));
  // Every principal exists and is what its key says (the derived ones have no stored row at all).
  const roles = (key) => s.w.db.sqlite.prepare('SELECT role_id, source FROM effective_roles WHERE guild_id = ? AND user_id = ? ORDER BY role_id, source').all(s.gid, s.uids[key]).map((row) => `${row.role_id}:${row.source}`);
  assert.deepEqual(roles('own'), ['guild_master:owner']);
  assert.deepEqual(roles('dgm'), ['guild_master:ingame']);
  assert.deepEqual(roles('dof'), ['officer:ingame']);
  assert.deepEqual(roles('dtl'), ['team_lead:ingame']);
  assert.deepEqual(roles('sof'), ['officer:manual']);
  assert.deepEqual(roles('stl'), ['team_lead:manual']);
});

check('every route of ROUTES, as every principal: no Discord id, avatar, handle, Battle.net id, Blizzard id, BattleTag, token, token hash, webhook or tombstone outside the ALLOWED list', async () => {
  const { ROUTES } = await load('worker/index.js');
  const s = await sentinelWorld();
  const result = await walk(s, ROUTES);
  const { leaks, unused } = classify(result.hits);
  if (process.env.P3B_DEBUG) console.log(groupHits(leaks).join('\n'));
  assert.deepEqual(groupHits(leaks), [], 'a sentinel in a reply that no ALLOWED entry covers');
  assert.deepEqual(unused, [], 'ALLOWED entries no reply used: narrow the list');
  assert.deepEqual(result.problems, [], 'a route the walker could not fill or that answered 500');
  const { missing, stale } = unreachedRoutes(ROUTES, result.answered);
  assert.deepEqual(missing, [], 'GET routes nobody got an answer from: make the fixture reach them or list them in UNREACHED with a reason');
  assert.deepEqual(stale, [], 'UNREACHED routes that were reached after all: remove them from the list');
  // Every route was asked, and every route that needs a session was answered by somebody past the sign-in check.
  assert.equal(result.answered.size, ROUTES.filter((route) => route.auth ? paramsOf(route).includes('gid') || route.method === 'GET' : true).length, 'routes asked');
  for (const route of ROUTES) {
    if (!route.auth || !paramsOf(route).includes('gid')) continue;
    const statuses = [...(result.answered.get(keyOf(route)) || [])].filter((entry) => SESSION.includes(entry.split(':')[0])).map((entry) => entry.split(':')[1]);
    assert(statuses.some((status) => status !== '401'), `${keyOf(route)} was answered 401 to every signed-in principal`);
  }
  assert(result.sent >= 2000, `${result.sent} requests`);
  // The detector works: the allowed hits are in the walk (not an empty scan), for the people who open People and for nobody below them.
  const peopleHits = result.hits.filter((hit) => hit.route === 'GET /api/guild/:gid/people');
  assert.deepEqual([...new Set(peopleHits.map((hit) => hit.principal))].sort(), [...OPENS_PEOPLE].sort());
  assert(peopleHits.some((hit) => hit.class === 'discord_id') && peopleHits.some((hit) => hit.class === 'avatar') && peopleHits.some((hit) => hit.class === 'handle'));
  assert(result.hits.some((hit) => hit.route === 'GET /api/guild/:gid/accounts' && hit.class === 'battletag' && hit.owner === 'look'), 'the exact lookup returns the typed BattleTag');
  console.log(`      ${result.sent} requests, ${result.planted.length} sentinels, ${result.hits.length} allowed hits`);
});

check('below the people who open People nothing of the cards is in any reply: Team Lead, custom role, member, non-member, guest, public, key and calendar see names and initials', async () => {
  const { ROUTES } = await load('worker/index.js');
  const s = await sentinelWorld();
  const below = ['dtl', 'stl', 'cust', 'mem', 'out1', 'guest', 'join', 'public', 'key', 'calendar'];
  const result = await walk(s, ROUTES, { only: below });
  const bad = result.hits.filter((hit) => !(hit.owner === hit.principal && ['GET /auth/me', 'GET /auth/bnet'].includes(hit.route)));
  assert.deepEqual(groupHits(bad), []);
  // The team leads are in the guild payload for a member too, as a name.
  const guild = await s.ok('mem', 'GET', '');
  const leads = guild.teams.find((team) => team.id === s.alpha).leads;
  assert(leads.length >= 1, 'the Team Leads of Alpha');
  for (const lead of leads) assert.deepEqual([lead.avatarUrl, lead.username], [null, ''], 'a lead\'s card for a member');
  assert(leads.every((lead) => lead.displayName && lead.initials));
});

check('the walker catches a leak: routes that answer a Discord id, a handle, a BattleTag or a token to any member are reported, and a route nobody can read is reported', async () => {
  const { ROUTES } = await load('worker/index.js');
  const { jsonResponse } = await load('worker/http.js');
  const leakyUsers = async (ctx) => jsonResponse({ rows: (await ctx.db.prepare('SELECT discord_id, username, avatar FROM users').all()).results });
  const leakyBnet = async (ctx) => jsonResponse({ rows: (await ctx.db.prepare('SELECT bnet_account_id, battletag FROM bnet_links').all()).results });
  const leakySessions = async (ctx) => jsonResponse({ rows: (await ctx.db.prepare('SELECT token_hash FROM sessions').all()).results });
  const never = async () => { const { HttpError } = await load('worker/http.js'); throw new HttpError(404, 'not_found', 'Nothing.'); };
  const routes = [
    ...ROUTES,
    { method: 'GET', path: '/api/guild/:gid/leaky-users', auth: true, handler: leakyUsers },
    { method: 'GET', path: '/api/guild/:gid/leaky-bnet', auth: true, handler: leakyBnet },
    { method: 'GET', path: '/api/guild/:gid/leaky-sessions', auth: true, handler: leakySessions },
    { method: 'GET', path: '/api/guild/:gid/nobody-reads-this', auth: true, handler: never },
  ];
  const s = await sentinelWorld({ routes });
  const result = await walk(s, routes, { only: ['mem', 'dtl'] });
  const { leaks } = classify(result.hits, { complete: false });
  const text = groupHits(leaks).join('\n');
  for (const [route, klass] of [['leaky-users', 'discord_id'], ['leaky-users', 'handle'], ['leaky-users', 'avatar'], ['leaky-bnet', 'bnet_account_id'], ['leaky-bnet', 'battletag'], ['leaky-sessions', 'token_hash']]) {
    assert(new RegExp(`GET /api/guild/:gid/${route} \\| mem \\| ${klass}`).test(text), `${route} ${klass} for a member is reported:\n${text}`);
  }
  assert(/leaky-users \| dtl \| discord_id/.test(text), 'and for a Team Lead');
  assert.deepEqual(unreachedRoutes(routes, result.answered).missing.filter((entry) => /nobody-reads-this/.test(entry)), ['GET /api/guild/:gid/nobody-reads-this -> 404']);
});

check('the answers of writes: as an Officer (People, roles, API keys, guest links, notes) every card is the People tier\'s; as a Team Lead (notes, editing a person) a name and initials', async () => {
  const s = await sentinelWorld();
  const planted = sentinelsOf(s);
  const hits = [];
  const send = async (who, method, tail, body, status, route) => {
    const res = await s.call(who, method, tail, body);
    assert.equal(res.status, status, `${who} ${method} ${tail} -> ${res.status} ${res.text.slice(0, 160)}`);
    for (const hit of scanResponse(planted, res)) hits.push({ route, principal: who, request: 'write', status: res.status, ...hit });
    return res;
  };
  // The Officer's replies.
  await send('own', 'PUT', `/people/${s.uids.cust}/roles`, { officer: false, teamLeadTeamIds: [s.alpha], roles: [] }, 200, 'PUT /api/guild/:gid/people/:uid/roles');
  await send('dof', 'POST', `/people/${s.uids.cust}/block`, { reason: 'Test' }, 200, 'POST /api/guild/:gid/people/:uid/block');
  const key = await send('dof', 'POST', '/api-keys', { name: 'Reply key', teamId: null, datasets: ['roster'], expiresIn: '30d' }, 201, 'POST /api/guild/:gid/api-keys');
  const link = await send('dof', 'POST', '/guest-links', { roleId: 'guest', expiresIn: '7d', label: 'Reply link' }, 201, 'POST /api/guild/:gid/guest-links');
  assert(key.json.created.token && link.json.created.token, 'the token comes back once, to its maker');
  await send('sof', 'PUT', `/roster/${s.ghost.pid}/notes`, { text: 'Another note', expectedNotesVersion: 0 }, 200, 'PUT /api/guild/:gid/roster/:pid/notes');
  // The Team Lead's: notes on a person of Alpha and linking an account to one (the reply is the person record, with the account behind it).
  const noted = await send('stl', 'PUT', `/roster/${s.ghost.pid}/notes`, { text: 'Lead note', expectedNotesVersion: 1 }, 200, 'PUT /api/guild/:gid/roster/:pid/notes');
  assert.deepEqual([noted.json.notes.updatedBy.avatarUrl, noted.json.notes.updatedBy.username], [null, ''], 'a Team Lead sees the author of the notes as a name');
  // A Team Lead edits a person of the team: the reply is the person record, with the account behind it as a card.
  const before = await send('stl', 'GET', `/roster/${s.people.mem.pid}`, undefined, 200, 'GET /api/guild/:gid/roster/:pid');
  const edited = await send('stl', 'PATCH', `/roster/${s.people.mem.pid}`, { expectedVersion: before.json.person.version, joinedOn: '2026-11-30' }, 200, 'PATCH /api/guild/:gid/roster/:pid');
  const card = edited.json.person.account.user;
  assert.equal(card.displayName, 'Plainmember');
  assert.deepEqual([card.avatarUrl, card.username], [null, ''], 'a Team Lead sees the account behind a person as a name');
  const { leaks } = classify(hits, { complete: false });
  assert.deepEqual(groupHits(leaks), []);
  assert(hits.some((hit) => hit.principal === 'dof' && hit.class === 'avatar'), 'the Officer\'s replies do carry cards');
  assert(!hits.some((hit) => hit.principal === 'stl'), 'the Team Lead\'s replies carry no card');
});

check('the legacy guild: the list of accounts a Team Lead may link shows names and initials; an Officer sees the card', async () => {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  await s.lead('tl', [s.tids[0]], 'Teamlead');
  await s.officer('off', 'Officer');
  await s.member('free', 'Freeone');
  s.w.db.sqlite.prepare('UPDATE users SET username = ?, avatar = ? WHERE id = ?').run('hndl_free_q9', 'cd'.repeat(16), s.uids.free);
  const freeDiscord = s.w.db.sqlite.prepare('SELECT discord_id FROM users WHERE id = ?').get(s.uids.free).discord_id;
  const asLead = await s.ok('tl', 'GET', '/roster/linkable');
  const entry = asLead.users.find((user) => user.id === s.uids.free);
  assert(entry, 'the member without a person is listed');
  assert.deepEqual([entry.displayName, entry.username, entry.avatarUrl], ['Freeone', '', null]);
  assert(!JSON.stringify(asLead).includes('hndl_free_q9') && !JSON.stringify(asLead).includes(freeDiscord));
  const asOfficer = await s.ok('off', 'GET', '/roster/linkable');
  const card = asOfficer.users.find((user) => user.id === s.uids.free);
  assert.equal(card.username, 'hndl_free_q9');
  assert(card.avatarUrl.includes(freeDiscord));
});

// ---------------------------------------------------------------------------
// The source

const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walkFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const workerFiles = () => walkFiles(path.join(ROOT, 'worker')).filter((file) => file.endsWith('.js'));
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

check('source: only worker/person.js and worker/redact.js build a person card; the avatar URL is built in person.js only; the sign-in\'s own card is made in two places', async () => {
  const using = (pattern) => workerFiles().filter((file) => pattern.test(fs.readFileSync(file, 'utf8'))).map(rel).sort();
  assert.deepEqual(using(/\btoPerson\(/), ['worker/person.js', 'worker/redact.js']);
  assert.deepEqual(using(/\bavatarUrl\(/), ['worker/discord.js', 'worker/person.js']);
  assert.deepEqual(using(/\bpersonFromSession\(/), ['worker/person.js', 'worker/routes/accounts.js', 'worker/routes/auth.js']);
  assert.deepEqual(using(/import[^;]*\btoPerson\b[^;]*from/), ['worker/redact.js']);
});

check('source: every personFor call names the viewer it builds the card for (a call without one would read as "everybody")', async () => {
  let calls = 0;
  for (const file of workerFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/\bpersonFor\(/g)) {
      if (/export function personFor/.test(text.slice(Math.max(0, match.index - 16), match.index))) continue;
      let depth = 1;
      let args = 1;
      let index = match.index + match[0].length;
      for (; index < text.length && depth > 0; index++) {
        const ch = text[index];
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === ',' && depth === 1) args++;
      }
      calls++;
      assert(args >= 2, `${rel(file)}: personFor(...) near offset ${match.index} has no viewer`);
    }
  }
  assert(calls >= 15, `${calls} personFor calls found`);
});

runChecks(checks);
