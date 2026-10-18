/**
 * Raidsmith guild tracker, Phase 8 - cross-guild isolation walker
 * Run: node guild-isolation-tests.js
 *
 * Two guilds (Alpha, Beta) with one of everything in each: a team, a person and character, a raid with a report and loot, a custom role, a guest
 * link, a calendar link, an away notice, a character claim. The suite walks EVERY route of worker/index.js ROUTES, so a route added later is covered
 * without anyone listing it, and tries it the ways a stranger could:
 *   - a member of one guild (its Guild Master and a plain member) on the other guild's id, and on its own guild's path with the other guild's
 *     person / raid / team / award / role / link / claim / notice ids: always refused (403 or 404), never a 2xx, never a word of the other guild;
 *   - a guest-link visitor and a public visitor (no session) on every route that needs a session: 401, and on the open routes (/api/guest,
 *     /api/public/:gid, /cal/:cal, /auth/guest) only their own guild's view;
 *   - and after the whole walk, nothing in either guild has changed (every table but the session bookkeeping is compared before and after).
 * A route that needs no guild id (the caller's own account) must be listed in ACCOUNT_ROUTES, an open route in OPEN_ROUTES: an unlisted one fails the
 * suite until somebody says what it is. A deliberately leaky route is added to a copy of ROUTES to prove the walker would catch a leak.
 * ISO_DEBUG=1 prints the positive control and the problems grouped by route.
 */
const assert = require('node:assert/strict');
const { load, adminOf, memberOf, makeWorld, signIn, newJar, person } = require('./tests/guild-world');

const S_ALPHA = '900000000000000011';
const S_BETA = '900000000000000012';
const PEOPLE = {
  alphaGm: person(11, 'Alphagm'), alphaMember: person(12, 'Alphamember'),
  betaGm: person(21, 'Betagm'), betaMember: person(22, 'Betamember'),
};
const STEP_MS = 30_000; // between requests, so no per-minute write limit or import window ever decides an answer

// Routes that need a session but name no guild or other record: they act on the caller's own account (or the app-wide idea box). Listed by hand.
const ACCOUNT_ROUTES = new Set([
  'GET /auth/me', 'DELETE /auth/me', 'PATCH /auth/prefs', 'PATCH /api/me', 'DELETE /auth/discord', 'GET /auth/bnet', 'DELETE /auth/bnet',
  'POST /auth/logout', 'POST /api/guild', 'GET /api/roadmap/ideas', 'POST /api/roadmap/ideas',
]);
// Routes that need no session. Each has a contract below (checked by name); anything else open fails until it is classified here.
const OPEN_ROUTES = new Set([
  'GET /guild', 'GET /guild/', 'GET /auth/login', 'GET /auth/callback', 'GET /auth/providers', 'GET /auth/bnet/login', 'GET /auth/bnet/callback',
  'POST /auth/guest', 'DELETE /auth/guest', 'GET /api/guest', 'GET /api/public/:gid', 'GET /cal/:cal',
]);
// Account routes that read and are safe to call for the "never lists the other guild" check.
const ACCOUNT_READS = ['GET /auth/me', 'GET /auth/bnet', 'GET /api/roadmap/ideas'];

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }
const keyOf = (route) => `${route.method} ${route.path}`;
const paramsOf = (route) => [...route.path.matchAll(/:([a-z]+)/g)].map((match) => match[1]);
// Routes that check the SHAPE of the body before they read the database, on purpose (a malformed or oversized body costs no query: see "fix 13" in
// guild-roster-worker-tests.js). A generic body would stop at that check and say nothing about the guild check behind it, so each gets a body that
// passes it. A new route that answers 400 to the generic body is reported with this hint.
const REF = 'AbCdEfGhIjKlMnOp';
const EVENT = '123456789012345678';
const REASON = 'A fine reason';
const VALID_BODIES = {
  'POST /api/guild/:gid/roster/import/raid-helper/preview': (ids) => ({ teamId: ids.tid, source: EVENT }),
  'POST /api/guild/:gid/roster/import/raid-helper/commit': (ids) => ({ teamId: ids.tid, eventId: EVENT, defaultStatus: 'raider', rows: [] }),
  'POST /api/guild/:gid/roster/import/wcl/preview': (ids) => ({ teamId: ids.tid, source: REF }),
  'POST /api/guild/:gid/roster/import/wcl/commit': (ids) => ({ teamId: ids.tid, report: { code: REF, flavour: 'classic' }, decisions: [] }),
  'POST /api/guild/:gid/roster/import/bnet/preview': (ids) => ({ teamId: ids.tid }),
  'POST /api/guild/:gid/roster/import/bnet/commit': (ids) => ({ teamId: ids.tid, defaultStatus: 'trial', members: [] }),
  'PATCH /api/guild/:gid/raids/:rid': () => ({ size: 25 }),
  'PUT /api/guild/:gid/raids/:rid/event': () => ({ source: EVENT }),
  'PUT /api/guild/:gid/raids/:rid/plan': () => ({ label: 'A plan', players: [{ name: 'Someone', group: 1 }] }),
  'PUT /api/guild/:gid/raids/:rid/manual': () => ({ reason: REASON, presentPlayerIds: [] }),
  'DELETE /api/guild/:gid/raids/:rid/manual': () => ({ reason: REASON }),
  'PUT /api/guild/:gid/raids/:rid/signups/:pid': () => ({ kind: 'signed' }),
  'PUT /api/guild/:gid/raids/:rid/signup': () => ({ kind: 'signed' }),
  'POST /api/guild/:gid/raids/:rid/decisions': (ids) => ({ playerId: ids.pid, reason: REASON, outcome: 'present', expectedFlags: [] }),
  'DELETE /api/guild/:gid/raids/:rid/decisions/:pid': () => ({ reason: REASON }),
  'POST /api/guild/:gid/raids/:rid/unmatched': () => ({ key: 'somebody|nightslayer', action: 'guest' }),
};
// A read gets ?team=<the team id>, a write the valid body of its route if it has one, else a body naming the ids it might look for. Fields a
// route does not know are ignored by it.
const requestOf = (route, path, ids) => {
  if (route.method === 'GET') return [`${path}?team=${ids.tid || ''}`];
  const valid = VALID_BODIES[`${route.method} ${route.path}`];
  return [path, valid ? valid(ids) : { teamId: ids.tid, playerId: ids.pid, characterId: ids.cid }];
};
const fill = (route, ids) => route.path.replace(/:([a-z]+)/g, (_, name) => {
  assert(ids[name] !== undefined, `the walker has no ${name} to fill in ${keyOf(route)}: give the fixture one`);
  return ids[name];
});

// ---------------------------------------------------------------------------
// The fixture

async function seedGuild(w, { label, serverId, gm, member, publicOn }) {
  const jars = {
    gm: (await signIn(w, gm, [adminOf(serverId)])).jar,
  };
  const base = { serverId, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', timeZone: 'America/New_York', multipleTeams: false };
  const made = await w.call(jars.gm, 'POST', '/api/guild', { ...base, name: `Guild ${label}` });
  assert.equal(made.status, 201, made.text);
  const gid = made.json.guild.id;
  const tid = made.json.teams[0].id;
  jars.member = (await signIn(w, member, [memberOf(serverId)])).jar;
  const uid = (await w.call(jars.member, 'GET', '/auth/me')).json.user.id;
  const path = `/api/guild/${gid}`;
  const need = async (res, label2) => { assert([200, 201].includes(res.status), `${label}: ${label2} -> ${res.status} ${res.text}`); return res.json; };

  const added = await need(await w.call(jars.gm, 'POST', `${path}/roster`, { teamId: tid, name: `${label}person`, class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' }), 'person');
  const pid = added.person.id;
  const cid = added.characters[0].id;
  w.db.sqlite.exec(`UPDATE players SET notes = '${label} officer note' WHERE id = '${pid}'`);
  const raid = await need(await w.call(jars.gm, 'POST', `${path}/raids`, { teamId: tid, raidOn: '2026-10-01', startTime: '20:00', zone: 'Karazhan', title: `${label}past` }), 'raid');
  const rid = raid.raid.id;
  await need(await w.call(jars.gm, 'PUT', `${path}/raids/${rid}/manual`, { reason: `${label} seed`, presentPlayerIds: [pid] }), 'manual attendance');
  const soon = await need(await w.call(jars.gm, 'POST', `${path}/raids`, { teamId: tid, raidOn: '2027-02-10', startTime: '20:00', zone: 'Karazhan', title: `${label}title` }), 'upcoming raid');
  const role = await need(await w.call(jars.gm, 'POST', `${path}/roles`, { name: `${label} council`, permissions: { 'loot.view': 'guild' } }), 'custom role');
  const rolid = role.roles.find((entry) => entry.name === `${label} council`).id;
  const link = await need(await w.call(jars.gm, 'POST', `${path}/guest-links`, { roleId: 'guest', expiresIn: '7d', label: `${label} link` }), 'guest link');
  const lid = link.created.id;
  const cal = await need(await w.call(jars.gm, 'POST', `${path}/calendar`, { teamId: tid }), 'calendar link');
  const calFile = new URL(cal.url).pathname.replace('/cal/', '');
  if (publicOn) await need(await w.call(jars.gm, 'PUT', `${path}/public`, { enabled: true, sections: ['roster', 'raids'] }), 'public page');
  const code = (label + 'AbCdEfGhIjKlMnOpQr').slice(0, 16).replace(/[^A-Za-z0-9]/g, 'x');
  const aid = `lo_${(label + 'xxxxxxxxxxxxxxxxxxxxxx').slice(0, 22)}`;
  const clid = `cl_${(label + 'yyyyyyyyyyyyyyyyyyyyyy').slice(0, 22)}`;
  const nid = `an_${(label + 'zzzzzzzzzzzzzzzzzzzzzz').slice(0, 22)}`;
  w.db.sqlite.exec(`
    INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES ('${rid}', '${gid}', '${code}', 'classic', 1, 2, '${label}uploader', 3);
    INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, winner_class, tag, note, created_at, updated_at)
      VALUES ('${aid}', '${gid}', '${rid}', '${tid}', '${label}sum0001', 28830, '${label} Trinket', 5, '${label}person', '${label.toLowerCase()}person', 'nightslayer', 'WARRIOR', 'MS', '${label} loot note', 1, 1);
    INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, status, created_at)
      VALUES ('${clid}', '${gid}', '${uid}', '${label}claimant', '${label.toLowerCase()}claimant', 'Nightslayer', 'nightslayer', 'MAGE', 'pending', 1);
    INSERT INTO away_notices (id, guild_id, player_id, kind, starts_on, ends_on, reason, created_at, updated_at)
      VALUES ('${nid}', '${gid}', '${pid}', 'away', '2026-12-01', '2026-12-02', '${label} away reason', 1, 1);`);
  return {
    label, serverId, gid, jars, ids: { gid, tid, uid, pid, cid, rid, rolid, lid, code, aid, clid, nid, cal: calFile },
    guestToken: link.created.token, calFile,
    // Words that only this guild's data contains. A response to anyone else must not carry one.
    words: [`Guild ${label}`, `${label}person`, `${label}title`, `${label}past`, `${label} council`, `${label} link`, `${label} officer note`, `${label} loot note`,
      `${label} Trinket`, `${label}claimant`, `${label} away reason`, `${label}uploader`, code, gid, tid, pid, cid, rid, rolid, lid, aid, clid, nid],
  };
}

async function fixture(options = {}) {
  // The Warcraft Logs and Battle.net import routes check the server's credentials before the guild: configure them so the guild check is reached.
  const configured = { WCL_CLIENT_ID: 'wcl-id', WCL_CLIENT_SECRET: 'wcl-secret', BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret' };
  const w = await makeWorld({ ...options, env: { ...configured, ...(options.env || {}) } });
  const alpha = await seedGuild(w, { label: 'Alpha', serverId: S_ALPHA, gm: PEOPLE.alphaGm, member: PEOPLE.alphaMember, publicOn: true });
  const beta = await seedGuild(w, { label: 'Beta', serverId: S_BETA, gm: PEOPLE.betaGm, member: PEOPLE.betaMember, publicOn: false });
  // A guest-link visitor of Alpha: redeeming the link counts a use, so it happens here, before any snapshot.
  const guestJar = newJar();
  assert.equal((await w.call(guestJar, 'POST', '/auth/guest', { token: alpha.guestToken })).status, 200);
  assert.equal(Object.keys(guestJar).length, 1, 'the guest cookie');
  return { w, alpha, beta, guestJar };
}

// Every table but the bookkeeping a refused request may touch (rate counters, sessions, last-seen stamps): the rows, in a stable order.
function snapshot(w) {
  const skip = new Set(['rate_limits', 'sessions', 'users']);
  const tables = w.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name).filter((name) => !skip.has(name));
  const out = {};
  for (const table of tables) out[table] = w.db.sqlite.prepare(`SELECT * FROM ${table}`).all().map((row) => JSON.stringify(row)).sort();
  return out;
}

// ---------------------------------------------------------------------------
// The walker. routes: the routes to walk. Returns { problems: [...], tried: n, own: { ok, notOk: [...] } }.

async function walk(f, routes) {
  const { w, alpha, beta } = f;
  const problems = [];
  const tried = { foreignGuild: 0, foreignChild: 0, signedOut: 0 };
  const problem = (message) => problems.push(message);
  const listed = new Set(routes.map(keyOf));
  for (const key of [...ACCOUNT_ROUTES, ...OPEN_ROUTES]) if (!listed.has(key)) problem(`the lists name ${key}, which is not a route any more`);

  const send = async (jar, route, ids) => {
    w.advance(STEP_MS);
    const path = fill(route, ids);
    const res = await w.call(jar, route.method, ...requestOf(route, path, ids));
    return { res, path };
  };
  const checkRefused = (route, who, path, res, others, allowed) => {
    const where = `${who} ${route.method} ${path}`;
    if (!allowed.includes(res.status)) {
      const hint = res.status === 400 ? ' - if this route checks its body before the guild on purpose, give it a valid body in VALID_BODIES' : '';
      problem(`${where} answered ${res.status} (expected ${allowed.join(' or ')}): ${res.text.slice(0, 120)}${hint}`);
    }
    for (const word of others) if (res.text.includes(word)) problem(`${where} leaked "${word}"`);
  };

  const members = [
    { who: 'alpha gm', jar: alpha.jars.gm, mine: alpha, theirs: beta },
    { who: 'alpha member', jar: alpha.jars.member, mine: alpha, theirs: beta },
    { who: 'beta gm', jar: beta.jars.gm, mine: beta, theirs: alpha },
    { who: 'beta member', jar: beta.jars.member, mine: beta, theirs: alpha },
  ];
  // Signed out: a guest-link visitor (the cookie a redeemed link sets) and a public visitor (nothing at all).
  const guestJar = f.guestJar;
  const visitors = [{ who: 'guest of alpha', jar: guestJar }, { who: 'public visitor', jar: newJar() }];

  for (const route of routes) {
    const key = keyOf(route);
    const params = paramsOf(route);
    if (!route.auth) {
      if (!OPEN_ROUTES.has(key)) problem(`${key} needs no session and is not classified: add it to OPEN_ROUTES and give it a contract`);
      continue;
    }
    if (!params.length) {
      if (!ACCOUNT_ROUTES.has(key)) problem(`${key} needs a session, names no guild or record and is not classified: add it to ACCOUNT_ROUTES, or give it a :gid`);
      for (const visitor of visitors) {
        tried.signedOut++;
        const { res, path } = await send(visitor.jar, route, {});
        checkRefused(route, visitor.who, path, res, [...alpha.words, ...beta.words], [401]);
      }
      continue;
    }

    for (const { who, jar, mine, theirs } of members) {
      // 1. The other guild's id (and every other id of the other guild): the guild check must stop it.
      tried.foreignGuild++;
      {
        const { res, path } = await send(jar, route, theirs.ids);
        checkRefused(route, who, path, res, theirs.words, [403, 404]);
      }
      // 2. Their own guild's path with the other guild's record ids, all at once and one at a time.
      const children = params.filter((name) => name !== 'gid');
      if (!children.length) continue;
      const variants = [children, ...(children.length > 1 ? children.map((name) => [name]) : [])];
      for (const swap of variants) {
        tried.foreignChild++;
        const ids = { ...mine.ids };
        for (const name of swap) ids[name] = theirs.ids[name];
        const { res, path } = await send(jar, route, ids);
        // Refused (a 4xx) and silent about the other guild. 400 and 409 are fine here: the record was not found or the body was checked first.
        checkRefused(route, `${who} (${swap.join('+')} from ${theirs.label})`, path, res, theirs.words, [400, 403, 404, 409]);
      }
    }

    // 3. Signed out, on both guilds' ids: a guest cookie or nothing is never a session.
    for (const visitor of visitors) {
      for (const target of [alpha, beta]) {
        tried.signedOut++;
        const { res, path } = await send(visitor.jar, route, target.ids);
        checkRefused(route, visitor.who, path, res, [...alpha.words, ...beta.words], [401]);
      }
    }
  }

  // The account routes that read: the caller's own account only.
  for (const { who, jar, theirs } of members) {
    for (const entry of ACCOUNT_READS) {
      const route = routes.find((candidate) => keyOf(candidate) === entry);
      if (!route) continue;
      const { res, path } = await send(jar, route, {});
      checkRefused(route, who, path, res, theirs.words, [200]);
    }
  }
  return { problems, tried };
}

// Positive control: the same GET routes on a member's OWN guild answer 200, so the refusals above are about the other guild and not about a
// fixture whose ids never worked.
async function ownControl({ w, alpha }, routes) {
  const notOk = [];
  let ok = 0;
  for (const route of routes) {
    if (!route.auth || route.method !== 'GET' || !paramsOf(route).includes('gid')) continue;
    w.advance(STEP_MS);
    const res = await w.call(alpha.jars.gm, route.method, ...requestOf(route, fill(route, alpha.ids), alpha.ids));
    if (res.status === 200) ok++; else notOk.push(`${keyOf(route)} -> ${res.status} ${res.json && res.json.error}`);
  }
  return { ok, notOk };
}

// ISO_DEBUG=1: the problems grouped by route (ids blanked), to read a long list at a glance.
function summarise(problems) {
  const seen = new Map();
  for (const text of problems) {
    const key = text.replace(/\b(?:g|t|r|p|c|u|cr|gl|an|cl|lo)_[\w-]{22}\b/g, '<id>').replace(/^(alpha|beta) (gm|member)/, '$2').slice(0, 170);
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  console.log([...seen].map(([key, n]) => `${n}x ${key}`).join('\n'));
}

// ---------------------------------------------------------------------------
// The checks

check('every route of ROUTES: another guild\'s ids, a guest cookie and no session at all are refused, and nothing changes', async () => {
  const { ROUTES } = await load('worker/index.js');
  const f = await fixture();
  const control = await ownControl(f, ROUTES);
  if (process.env.ISO_DEBUG) console.log('control ok', control.ok, control.notOk);
  assert(control.ok >= 30, `the control found only ${control.ok} guild GET routes that answer 200 for their own member`);
  // Some reads need something the fixture does not have (an external service, a feature switch): they answer an error on purpose.
  const expectedOdd = [
    'GET /api/guild/:gid/raids/:rid/signup -> 403',                    // the caller's OWN sign-up: the Guild Master is no roster person here
    'GET /api/guild/:gid/attendance/backfill/reports -> 502',          // asks Warcraft Logs, which the fixture cannot reach
  ];
  assert.deepEqual(control.notOk.filter((entry) => !expectedOdd.some((pattern) => entry.startsWith(pattern))), [], 'GET routes on the member\'s own guild that did not answer 200');

  const before = snapshot(f.w);
  const result = await walk(f, ROUTES);
  if (process.env.ISO_DEBUG) { console.log('tried', result.tried); summarise(result.problems); }
  assert.deepEqual(result.problems, [], result.problems.slice(0, 12).join('\n'));
  assert(result.tried.foreignGuild >= 4 * 100, `walked only ${result.tried.foreignGuild} cross-guild requests`);
  assert(result.tried.foreignChild >= 4 * 40, `walked only ${result.tried.foreignChild} cross-record requests`);
  assert(result.tried.signedOut >= 2 * 100, `walked only ${result.tried.signedOut} signed-out requests`);
  const after = snapshot(f.w);
  for (const table of Object.keys(before)) assert.deepEqual(after[table], before[table], `${table} changed during the walk`);
});

check('the open routes show a visitor only the one guild their link, address or token names', async () => {
  const f = await fixture();
  const { w, alpha, beta } = f;
  // Nothing of the other guild in what a visitor of this one is shown.
  const only = (text, theirs, where) => {
    for (const word of theirs.words) assert(!text.includes(word), `${where} leaked ${word}`);
  };

  // /api/public/:gid - the guild that switched it on answers; the other one is a 404 that cannot be told from a guild that does not exist.
  const visitor = newJar();
  const open = await w.call(visitor, 'GET', `/api/public/${alpha.gid}`);
  assert.equal(open.status, 200, open.text);
  assert.equal(open.json.guild.name, 'Guild Alpha');
  only(open.text, beta, 'public alpha');
  assert(!open.text.includes('Alpha officer note') && !open.text.includes('Alpha loot note') && !open.text.includes('Alpha away reason'), 'no officer text on the public page');
  const closed = await w.call(visitor, 'GET', `/api/public/${beta.gid}`);
  const missing = await w.call(visitor, 'GET', '/api/public/g_AAAAAAAAAAAAAAAAAAAAAA');
  assert.deepEqual([closed.status, closed.json.error], [missing.status, missing.json.error], 'a private guild looks like a guild that is not there');
  assert.equal(closed.status, 404);
  for (const jar of [visitor, alpha.jars.gm, alpha.jars.member, beta.jars.member]) {
    const again = await w.call(jar, 'GET', `/api/public/${beta.gid}`);
    assert.equal(again.status, 404, 'a signed-in member of any guild gets no more than a stranger');
  }

  // /auth/guest and /api/guest - a guest link opens its own guild, only.
  const guest = newJar();
  assert.equal((await w.call(guest, 'POST', '/auth/guest', { token: alpha.guestToken })).status, 200);
  const view = await w.call(guest, 'GET', '/api/guest');
  assert.equal(view.status, 200, view.text);
  assert.equal(view.json.guild.name, 'Guild Alpha');
  only(view.text, beta, 'guest view');
  assert.equal((await w.call(newJar(), 'GET', '/api/guest')).status, 404, 'no cookie, no view');
  assert.equal((await w.call(newJar(), 'POST', '/auth/guest', { token: 'x'.repeat(43) })).status, 404, 'a token nobody made');
  assert.equal((await w.call(guest, 'DELETE', '/auth/guest', {})).status, 200);
  assert.equal((await w.call(guest, 'GET', '/api/guest')).status, 404, 'after leaving there is nothing to see');
  // The other guild's link works for the other guild - and for nothing of Alpha's.
  const betaGuest = newJar();
  assert.equal((await w.call(betaGuest, 'POST', '/auth/guest', { token: beta.guestToken })).status, 200);
  const betaView = await w.call(betaGuest, 'GET', '/api/guest');
  assert.equal(betaView.json.guild.name, 'Guild Beta');
  only(betaView.text, alpha, 'guest view of beta');
  // A turned-off link stops working at once.
  assert.equal((await w.call(beta.jars.gm, 'DELETE', `/api/guild/${beta.gid}/guest-links/${beta.ids.lid}`, {})).status, 200);
  assert.equal((await w.call(betaGuest, 'GET', '/api/guest')).status, 410);

  // /cal/:cal - the token is the credential and names one team of one guild.
  const feed = await w.call(newJar(), 'GET', `/cal/${alpha.calFile}`);
  assert.equal(feed.status, 200, feed.text.slice(0, 200));
  assert(feed.text.includes('Alphatitle'), 'the feed carries its own raid');
  only(feed.text, beta, 'alpha calendar');
  const betaFeed = await w.call(newJar(), 'GET', `/cal/${beta.calFile}`);
  assert.equal(betaFeed.status, 200);
  only(betaFeed.text, alpha, 'beta calendar');
  assert.equal((await w.call(newJar(), 'GET', `/cal/${'A'.repeat(43)}.ics`)).status, 404, 'a token nobody made');
  assert.equal((await w.call(alpha.jars.gm, 'DELETE', `/api/guild/${alpha.gid}/calendar`, { teamId: alpha.ids.tid })).status, 200);
  assert.equal((await w.call(newJar(), 'GET', `/cal/${alpha.calFile}`)).status, 404, 'a turned-off feed is gone');
});

check('the walker catches a leaky route: one that answers the other guild\'s data to any member', async () => {
  const { ROUTES } = await load('worker/index.js');
  const { jsonResponse } = await load('worker/http.js');
  // A handler that forgets the guild check: it reads the roster of whatever :gid says.
  const leaky = async (ctx) => {
    const rows = (await ctx.db.prepare('SELECT name FROM characters WHERE guild_id = ?').bind(ctx.params.gid).all()).results;
    return jsonResponse({ names: rows.map((row) => row.name) });
  };
  const leakyWrite = async (ctx) => {
    await ctx.db.prepare("UPDATE teams SET name = 'Pwned' WHERE guild_id = ?").bind(ctx.params.gid).run();
    return jsonResponse({ ok: true });
  };
  const routes = [
    ...ROUTES,
    { method: 'GET', path: '/api/guild/:gid/leaky-read', auth: true, handler: leaky },
    { method: 'POST', path: '/api/guild/:gid/leaky-write', auth: true, handler: leakyWrite },
    { method: 'GET', path: '/api/unclassified/:rid', auth: true, handler: leaky },
    { method: 'GET', path: '/api/nobody-classified-this', auth: false, handler: leaky },
    { method: 'GET', path: '/api/me-too', auth: true, handler: leaky },
  ];
  const f = await fixture({ routes });
  const before = snapshot(f.w);
  const result = await walk(f, routes);
  const text = result.problems.join('\n');
  assert(/GET \/api\/guild\/g_[\w-]+\/leaky-read answered 200/.test(text), 'the 200 on another guild is reported');
  assert(/leaked "Betaperson"|leaked "Alphaperson"/.test(text), 'the leaked name is reported');
  assert(/POST \/api\/guild\/g_[\w-]+\/leaky-write answered 200/.test(text), 'the cross-guild write is reported');
  assert(/GET \/api\/nobody-classified-this needs no session and is not classified/.test(text), 'an unclassified open route is reported');
  assert(/GET \/api\/me-too needs a session, names no guild or record and is not classified/.test(text), 'an unclassified account route is reported');
  assert.notDeepEqual(snapshot(f.w).teams, before.teams, 'the snapshot sees the write');
});

// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 14).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
