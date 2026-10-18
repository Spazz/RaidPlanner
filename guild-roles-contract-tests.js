/**
 * Raidsmith guild tracker - Phase 7 roles CONTRACT tests (Worker <-> pages)
 * Run: node guild-roles-contract-tests.js [name-filter]
 *
 * The Worker suite (guild-roles-worker-tests.js) and the pages suite (guild-roles-ui-tests.js) each work from the contract with hand-made data on the
 * other side. This suite joins them: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite
 * D1 stand-in) through G.api, and what the pages draw from the real answers is checked - the role grid, the Discord mapping, the guest links, the
 * public page, the read-only view, and the People page with Discord-given and custom roles. A field one side names differently, nests differently or
 * leaves out shows up here as a missing name, a blank cell or a thrown error. Discord (OAuth and the bot) is faked by an injected fetch; no network,
 * no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

const ROOT = __dirname;
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000001';
const BOT_TOKEN = 'contract-bot-token';
const ALICE = { id: '110000000000000001', username: 'alice', globalName: 'Alice A' };
const BOB = { id: '110000000000000002', username: 'bob', globalName: 'Bob B' };
const DAVE = { id: '110000000000000004', username: 'dave', globalName: 'Dave D' };
const D_OFFICERS = '700000000000000001';
const D_LEADS = '700000000000000002';
const D_LOOT = '700000000000000003';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const SECRETS = ['SECRET officer note', 'SecretNick', 'SECRET-REASON', 'SECRET LOOT NOTE', 'SecretMasterName', DAVE.id, 'discord'];

// ---------------------------------------------------------------------------
// The Worker side: one app over one D1, a cookie jar per person

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0, botIn: true, members: {} };
  const discordFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    discord.calls++;
    const auth = (init.headers && init.headers.Authorization) || '';
    if (/^Bot /.test(auth)) {
      if (auth !== `Bot ${BOT_TOKEN}`) return Response.json({ message: '401: Unauthorized' }, { status: 401 });
      if (!discord.botIn) return Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 });
      const roles = /^\/api\/v10\/guilds\/\d+\/roles$/.exec(u.pathname);
      if (roles) {
        return Response.json([
          { id: SERVER, name: '@everyone', position: 0, color: 0, managed: false },
          { id: D_OFFICERS, name: 'Officers', position: 9, color: 0xff0000, managed: false },
          { id: D_LEADS, name: 'Raid leaders', position: 7, color: 0, managed: false },
          { id: D_LOOT, name: 'Loot council', position: 5, color: 0, managed: false },
        ]);
      }
      const member = /^\/api\/v10\/guilds\/\d+\/members\/(\d+)$/.exec(u.pathname);
      if (member) return discord.members[member[1]] ? Response.json({ roles: discord.members[member[1]] }) : Response.json({ code: 10007 }, { status: 404 });
      return new Response('{}', { status: 404 });
    }
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${discord.calls}`;
      discord.tokens.set(token, discord.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec(auth);
    const session = bearer && discord.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  const clock = { now: Date.parse('2027-01-15T08:00:00Z') };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11 + counter) & 255;
    return bytes;
  };
  const env = {
    DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    DISCORD_BOT_TOKEN: BOT_TOKEN, GUILD_CREATOR_ALLOWLIST: ALICE.id,
  };
  const app = createApp({ db, env, fetch: discordFetch, now: () => clock.now, randomBytes, log: () => {} });
  return { db, clock, discord, app };
}

function absorb(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[pair.slice(0, index)];
    else jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

// A fetch the page's G.api.request can use: the Worker answers, the jar carries the cookies (a session, or a guest cookie).
const fetchFor = (world, jar) => async (urlPath, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await world.app.handle(new Request(`${ORIGIN}${urlPath}`, { method: init.method, headers, body: init.body }));
  absorb(jar, response);
  return response;
};

async function signIn(world, person, servers, jar = {}) {
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await fetchFor(world, jar)('/auth/login', { method: 'GET' });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await fetchFor(world, jar)(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { method: 'GET' });
  return jar;
}

// ---------------------------------------------------------------------------
// The pages side: the real scripts with G.api routed to the Worker

function loadPages(world, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  const f = fetchFor(world, jar);
  // The page's own request wrapper (cookies, JSON, ApiError), with the Worker as the network.
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  return G;
}

// ---------------------------------------------------------------------------
// Scenario: Alice (Guild Master) runs "Ember" with teams Alpha and Bravo. Bob signs in holding the Officers role on Discord, Dave is a plain Member.
// Thoren and Kaelith (Alpha) and Mirabel (Bravo) are on the roster; Thoren carries an officer note and Dave's Discord ID; one past raid, one upcoming
// raid and two loot awards (one a disenchant) exist.

const GUILD_BODY = { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] };

async function scenario() {
  const world = await makeWorld();
  const plain = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
  const jar = await signIn(world, ALICE, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const G = loadPages(world, jar);
  const created = await G.api.post('/api/guild', GUILD_BODY);
  const gid = created.guild.id;
  const [teamA, teamB] = created.teams.map((team) => team.id);
  const base = `/api/guild/${gid}`;
  const people = {};
  for (const [name, team, cls, spec] of [['Thoren', teamA, 'PALADIN', 'Protection'], ['Kaelith', teamA, 'ROGUE', 'Combat'], ['Mirabel', teamB, 'HUNTER', 'Marksmanship']]) {
    people[name] = (await G.api.post(`${base}/roster`, { teamId: team, name, class: cls, mainSpec: spec, offSpec: null, status: 'raider' })).person.id;
  }
  world.db.sqlite.exec(`UPDATE players SET joined_on = '2026-12-01' WHERE guild_id = '${gid}'`);
  await G.api.put(`${base}/roster/${people.Thoren}/notes`, { text: 'SECRET officer note: late twice', expectedNotesVersion: 0 });
  world.db.sqlite.exec(`UPDATE players SET discord_user_id = '${DAVE.id}', discord_nickname = 'SecretNick' WHERE id = '${people.Thoren}'`);
  const raid = (await G.api.post(`${base}/raids`, { teamId: teamA, raidOn: '2027-01-10', zone: 'Karazhan' })).raid.id;
  await G.api.put(`${base}/raids/${raid}/manual`, { reason: 'No log SECRET-REASON', presentPlayerIds: [people.Thoren] });
  await G.api.post(`${base}/raids`, { teamId: teamA, raidOn: '2027-01-20', zone: 'Gruul\'s Lair', title: 'Gruul night' });
  const award = (n, name, cls, tag) => `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, item_quality, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key, winner_class, roll_type, tag, note, awarded_by, created_at, updated_at)
    VALUES ('lo_${String(n).padStart(22, '0')}', '${gid}', '${raid}', '${teamA}', 'checksum${n}xx', ${30000 + n}, 'Item ${n}', 4, ${1_799_000_000_000 + n}, ${name ? `'${name}'` : 'NULL'}, ${name ? `'${name.toLowerCase()}'` : 'NULL'}, ${name ? "'Dreamscythe'" : 'NULL'}, ${name ? "'dreamscythe'" : "''"}, ${cls ? `'${cls}'` : 'NULL'}, 'MS', '${tag}', 'SECRET LOOT NOTE', 'SecretMasterName', 1, 1)`;
  world.db.sqlite.exec(award(1, 'Thoren', 'PALADIN', 'MS'));
  world.db.sqlite.exec(award(2, null, null, 'DE'));
  const bobJar = await signIn(world, BOB, plain);
  const daveJar = await signIn(world, DAVE, plain);
  const ids = {
    alice: (await G.api.get('/auth/me')).user.id,
    bob: (await fetchFor(world, bobJar)('/auth/me', { method: 'GET' }).then((r) => r.json())).user.id,
    dave: (await fetchFor(world, daveJar)('/auth/me', { method: 'GET' }).then((r) => r.json())).user.id,
  };
  const guildData = await G.api.get(base);
  return { world, jar, bobJar, daveJar, G, gid, teamA, teamB, base, people, raid, ids, guildData, plain };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('roles page: the real role list draws every role with its holders, the new role\'s grid offers exactly the scopes the Worker allows, and the fixed Guild Master dialog is read-only', async () => {
  const s = await scenario();
  const { G } = s;
  const made = await G.api.roles.create(s.gid, { name: 'Loot council', permissions: { 'loot.edit': 'guild', 'loot.view': 'guild' } });
  const council = made.roles.find((r) => r.name === 'Loot council');
  await G.api.put(`${s.base}/people/${s.ids.dave}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: council.id, teamId: null }] });
  const data = await G.api.roles.list(s.gid);
  const html = G.pages.settingsRoles.settingsHtml({ guildData: s.guildData, data, alert: '', notice: '' });
  const text = stripTags(html);
  for (const name of ['Guild Master', 'Officer', 'Team Lead', 'Member', 'Guest', 'Public', 'Loot council']) assert(text.includes(name), `the page names ${name}`);
  assert(/1 person/.test(text), 'the holders of the custom role are counted');
  assert(/data-action="role-new"/.test(html) && /data-action="role-edit"/.test(html));
  assert(!/null|undefined/.test(text), 'nothing reads null or undefined');
  // The dialog of the custom role: every action of the catalogue has a row; a staff action is disabled for it; the scopes offered are the Worker's `allowed`.
  const dialog = G.pages.settingsRoles.roleDialogHtml(council, data);
  const dialogText = stripTags(dialog);
  for (const action of data.actions) assert(dialogText.includes(action.label), `the grid has a row for ${action.label}`);
  assert(/Officer role only/.test(dialogText), 'staff actions say who may hold them');
  const lootEdit = data.roles.find((r) => r.id === council.id).allowed['loot.edit'];
  assert.deepEqual(lootEdit, ['guild', 'team']);
  assert(/Whole guild/.test(dialog) && /One team/.test(dialog), 'both scopes of loot.edit are offered');
  // The new-role dialog, the delete dialog (with the real counts) and the Guild Master dialog.
  assert(/data-submit="role-form"/.test(G.pages.settingsRoles.roleDialogHtml(null, data)));
  const del = stripTags(G.pages.settingsRoles.deleteDialogHtml(data.roles.find((r) => r.id === council.id)));
  assert(/1 person/.test(del), del);
  const gm = data.roles.find((r) => r.id === 'guild_master');
  const gmHtml = G.pages.settingsRoles.roleDialogHtml(gm, data);
  assert(!/<select/.test(gmHtml) && !/type="submit"/.test(gmHtml), 'the Guild Master role cannot be edited');
  assert(/every action/i.test(stripTags(gmHtml)));
  // A built-in the Guild Master edited shows as edited, and Reset is offered.
  await G.api.roles.update(s.gid, 'officer', { permissions: Object.fromEntries(Object.entries(data.roles.find((r) => r.id === 'officer').permissions).filter(([a]) => a !== 'loot.policy')) });
  const after = await G.api.roles.list(s.gid);
  const officer = after.roles.find((r) => r.id === 'officer');
  assert.equal(officer.customized, true);
  assert(/role-reset-ask/.test(G.pages.settingsRoles.roleDialogHtml(officer, after)), 'Reset to defaults is offered for an edited built-in');
  assert(/Edited/.test(stripTags(G.pages.settingsRoles.settingsHtml({ guildData: s.guildData, data: after, alert: '', notice: '' }))));
});

check('discord page: the bot states from the real Worker (connected, not in the server), the mapping rows and targets, and the invite link as the Worker built it', async () => {
  const s = await scenario();
  const { G } = s;
  const render = async () => G.pages.settingsDiscord.settingsHtml({ guildData: s.guildData, data: await G.api.discord.get(s.gid), alert: '', notice: '' });
  const connected = await render();
  const text = stripTags(connected);
  for (const name of ['Officers', 'Raid leaders', 'Loot council']) assert(text.includes(name), `the Discord role ${name} is listed`);
  assert(!text.includes('@everyone'), '@everyone is not offered');
  assert(/<select/.test(connected) && /data-submit="discord-maps"/.test(connected));
  assert(/Officer/.test(text) && /Team Lead/.test(text), 'the targets are offered');
  assert(/Connected/i.test(text), 'the bot is in the server');
  const real = (await G.api.discord.get(s.gid)).bot.inviteUrl;
  assert(real.includes('scope=bot') && real.includes('permissions=0'));
  assert(connected.includes(real.replace(/&/g, '&amp;')), 'the invite link is the Worker\'s, escaped');
  // Save a mapping through the API the page uses; the page shows it selected, with the team select for Team Lead.
  await G.api.discord.saveMaps(s.gid, [{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }, { discordRoleId: D_LEADS, roleId: 'team_lead', teamId: s.teamA }]);
  const mapped = await render();
  assert(/<option value="officer"[^>]*selected/.test(mapped) && /<option value="team_lead"[^>]*selected/.test(mapped), 'the saved targets are selected');
  assert(new RegExp(`<option value="${s.teamA}" selected`).test(mapped), 'and the team');
  // The bot not in the server: the invite link and a plain explanation; Discord down: the problem, not a crash.
  s.world.discord.botIn = false;
  const missing = stripTags(await render());
  assert(/not in your Discord server|Add the Raidsmith bot/i.test(missing), missing);
  assert(!/null|undefined/.test(missing));
  s.world.discord.botIn = true;
});

check('guest links: the page draws the real list, the created token appears once (in the dialog, never in the list), and a turned-off link shows as off', async () => {
  const s = await scenario();
  const { G } = s;
  const created = await G.api.guests.create(s.gid, { roleId: 'guest', teamId: s.teamA, expiresIn: '7d', label: 'Recruits' });
  const { token, id } = created.created;
  const url = `${ORIGIN}${created.created.path}`;
  const dialog = G.pages.settingsGuests.createdDialogHtml(url);
  assert(dialog.includes(token) && /only once/i.test(stripTags(dialog)), 'the dialog shows the link and says it is shown once');
  const list = await G.api.guests.list(s.gid);
  const html = G.pages.settingsGuests.settingsHtml({ guildData: s.guildData, data: list, alert: '', notice: '' });
  const text = stripTags(html);
  assert(!html.includes(token) && !JSON.stringify(list).includes(token), 'the list never holds the token');
  assert(text.includes('Recruits') && text.includes('Guest') && text.includes('Alpha'), text);
  assert(/Roster/.test(text) && /Attendance/.test(text), 'what the role shows');
  assert(new RegExp(`data-action="guest-revoke"[^>]*${id}|${id}[^>]*data-action="guest-revoke"`).test(html), 'a Turn off button for the active link');
  const create = G.pages.settingsGuests.createDialogHtml(list, s.guildData);
  assert(/Alpha/.test(stripTags(create)) && /1 day/.test(stripTags(create)) && /Never/.test(stripTags(create)));
  await G.api.guests.revoke(s.gid, id);
  const off = stripTags(G.pages.settingsGuests.settingsHtml({ guildData: s.guildData, data: await G.api.guests.list(s.gid), alert: '', notice: '' }));
  assert(/turned off|off/i.test(off) && !/data-action="guest-revoke"/.test(G.pages.settingsGuests.settingsHtml({ guildData: s.guildData, data: await G.api.guests.list(s.gid), alert: '', notice: '' })));
});

check('guest view: the real guest and public views draw names, percentages and loot, state the role and team, and carry nothing private', async () => {
  const s = await scenario();
  const { G } = s;
  const council = (await G.api.roles.create(s.gid, { name: 'Everything', permissions: { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': 'guild', 'loot.view': 'guild' } })).roles.find((r) => r.name === 'Everything');
  const link = (await G.api.guests.create(s.gid, { roleId: council.id, expiresIn: '1d' })).created;
  await G.api.publicPage.save(s.gid, { enabled: true, sections: ['roster', 'raids', 'attendance', 'loot'] });
  // A visitor with nothing but the link: their own cookie jar and their own page scripts.
  const visitorJar = {};
  const V = loadPages(s.world, visitorJar);
  const loaded = await V.pages.view.load({ name: 'guest', token: link.token });
  assert.equal(loaded.error, null, JSON.stringify(loaded.error));
  assert(visitorJar['__Host-rs_guest'], 'the guest cookie is set');
  const guestHtml = V.pages.view.viewHtml({ data: loaded.data, kind: 'guest', error: null });
  const guestText = stripTags(guestHtml);
  for (const needle of ['Ember', 'Thoren', 'Kaelith', 'Mirabel', 'Karazhan', 'Gruul night', 'Item 1', 'Disenchanted', 'Everything', 'Whole guild', 'Read-only', '100%']) assert(guestText.includes(needle), `the guest view shows ${needle}`);
  assert(/data-action="view-leave"/.test(guestHtml), 'a guest can leave');
  assert(!/null|undefined/.test(guestText));
  const anon = loadPages(s.world, {});
  const pub = await anon.pages.view.load({ name: 'public', gid: s.gid });
  assert.equal(pub.error, null);
  const pubHtml = anon.pages.view.viewHtml({ data: pub.data, kind: 'public', error: null });
  assert(stripTags(pubHtml).includes('Public page') && stripTags(pubHtml).includes('Thoren'));
  assert(!/view-leave/.test(pubHtml), 'the public page has nothing to leave');
  for (const html of [guestHtml, pubHtml]) {
    for (const secret of SECRETS) assert(!html.toLowerCase().includes(secret.toLowerCase()), `the page leaks ${secret}`);
  }
  // A team link shows that team only.
  const alpha = (await G.api.guests.create(s.gid, { roleId: council.id, teamId: s.teamA, expiresIn: '1d' })).created;
  const A = loadPages(s.world, {});
  const teamView = await A.pages.view.load({ name: 'guest', token: alpha.token });
  const teamText = stripTags(A.pages.view.viewHtml({ data: teamView.data, kind: 'guest', error: null }));
  assert(teamText.includes('Alpha only') && teamText.includes('Thoren') && !teamText.includes('Mirabel'), teamText);
});

check('guest view errors: a turned-off, expired or unknown link and a public page that is off, as the real Worker words them', async () => {
  const s = await scenario();
  const { G } = s;
  const first = (await G.api.guests.create(s.gid, { expiresIn: '1d' })).created;
  const second = (await G.api.guests.create(s.gid, { expiresIn: '1d' })).created;
  await G.api.guests.revoke(s.gid, first.id);
  const render = (V, view, kind) => stripTags(V.pages.view.viewHtml({ data: view.data, kind, error: view.error }));
  let V = loadPages(s.world, {});
  const revoked = await V.pages.view.load({ name: 'guest', token: first.token });
  assert.deepEqual([revoked.error.status, revoked.error.code], [410, 'link_revoked']);
  const revokedText = render(V, revoked, 'guest');
  assert(/turned this guest link off/.test(revokedText) && /ask .* for a new/i.test(revokedText), revokedText);
  assert.equal((revokedText.match(/\bask\b/gi) || []).length, 1, 'the advice is not said twice');
  V = loadPages(s.world, {});
  const fake = await V.pages.view.load({ name: 'guest', token: 'A'.repeat(43) });
  assert.equal(fake.error.code, 'link_invalid');
  assert(/not valid/i.test(render(V, fake, 'guest')));
  // An open guest session whose link is then turned off or runs out.
  V = loadPages(s.world, {});
  assert.equal((await V.pages.view.load({ name: 'guest', token: second.token })).error, null);
  s.world.clock.now += 2 * 24 * 3600 * 1000;
  const expired = await V.pages.view.load({ name: 'view' });
  assert.equal(expired.error.code, 'link_expired');
  assert(/expired/.test(render(V, expired, 'guest')));
  const off = await V.pages.view.load({ name: 'public', gid: s.gid });
  assert.equal(off.error.status, 404);
  assert(/No public page|no public page/i.test(render(V, off, 'public')));
});

check('public page settings: the real settings draw the switch and sections, a section the Public role closes is disabled, and the address is the Worker\'s path', async () => {
  const s = await scenario();
  const { G } = s;
  let data = await G.api.publicPage.get(s.gid);
  let html = G.pages.settingsPublic.settingsHtml({ guildData: s.guildData, data, alert: '', notice: '', origin: ORIGIN });
  assert(/data-submit="public-settings"/.test(html));
  assert(!stripTags(html).includes(ORIGIN), 'off: no address yet');
  await G.api.publicPage.save(s.gid, { enabled: true, sections: ['roster', 'raids'] });
  data = await G.api.publicPage.get(s.gid);
  html = G.pages.settingsPublic.settingsHtml({ guildData: s.guildData, data, alert: '', notice: '', origin: ORIGIN });
  assert(html.includes(`${ORIGIN}/#/public/${s.gid}`), 'the address: origin + the Worker\'s path');
  assert(/data-action="public-copy"/.test(html));
  const publicRole = (await G.api.roles.list(s.gid)).roles.find((r) => r.id === 'public');
  const noLoot = Object.fromEntries(Object.entries(publicRole.permissions).filter(([a]) => a !== 'loot.view'));
  await G.api.roles.update(s.gid, 'public', { permissions: noLoot });
  data = await G.api.publicPage.get(s.gid);
  assert.equal(data.allowed.loot, false);
  html = G.pages.settingsPublic.settingsHtml({ guildData: s.guildData, data, alert: '', notice: '', origin: ORIGIN });
  assert(/Closed by the Public role/i.test(stripTags(html)));
  assert(/<input[^>]*value="loot"[^>]*disabled|<input[^>]*disabled[^>]*value="loot"/.test(html), 'the loot checkbox is disabled');
});

check('people page: Discord-given roles show as Discord\'s, the Edit roles dialog lists the guild\'s own roles and only what an officer set by hand is ticked, and Sync now is offered where the Worker says', async () => {
  const s = await scenario();
  const { G } = s;
  const council = (await G.api.roles.create(s.gid, { name: 'Loot council', permissions: { 'loot.edit': 'guild' } })).roles.find((r) => r.name === 'Loot council');
  const leader = (await G.api.roles.create(s.gid, { name: 'Raid leader', permissions: { 'raids.edit': 'team' } })).roles.find((r) => r.name === 'Raid leader');
  await G.api.discord.saveMaps(s.gid, [{ discordRoleId: D_OFFICERS, roleId: 'officer', teamId: null }]);
  s.world.discord.members[BOB.id] = [D_OFFICERS];
  await signIn(s.world, BOB, s.plain, s.bobJar);
  await G.api.put(`${s.base}/people/${s.ids.dave}/roles`, { officer: false, teamLeadTeamIds: [], roles: [{ roleId: council.id, teamId: null }, { roleId: leader.id, teamId: s.teamA }] });
  const people = await G.api.get(`${s.base}/people`);
  assert.deepEqual(people.discord, { configured: true, mapped: true });
  const bob = people.people.find((p) => p.person.id === s.ids.bob);
  const dave = people.people.find((p) => p.person.id === s.ids.dave);
  assert.deepEqual(bob.roles, [{ role: 'officer', fromDiscord: true }]);
  assert.equal(bob.actions.syncDiscord, true);
  const table = G.pages.people.tableHtml({ people: people.people, teams: s.guildData.teams, sort: G.peopleSort.DEFAULT_SORT, query: '', now: Date.now(), gid: s.gid });
  const tableText = stripTags(table);
  assert(/Officer \(Discord\)/.test(tableText), tableText);
  assert(/Loot council/.test(tableText) && /Raid leader/.test(tableText), 'custom roles show by name');
  assert(/Raid leader[^<]*Alpha|Raid leader - Alpha/.test(tableText), 'with their team');
  assert(/data-action="person-sync"[^>]*data-uid="[^"]*"/.test(table));
  assert(!new RegExp(`data-action="person-sync"[^>]*data-uid="${s.ids.alice}"`).test(table), 'not for the Guild Master');
  // The dialog for Bob: the Discord Officer is a read-only line, the box is not ticked; custom roles are listed.
  const rolesList = await G.api.roles.list(s.gid);
  const bobDialog = G.pages.people.rolesDialogHtml(bob, s.guildData.teams, 'Ember', rolesList.roles.filter((r) => r.kind === 'custom'));
  assert(/From Discord/.test(stripTags(bobDialog)), 'the Discord role is shown read-only');
  assert(!/name="officer"[^>]*checked/.test(bobDialog), 'and not ticked');
  assert(/Loot council/.test(bobDialog) && /Raid leader: Alpha/.test(stripTags(bobDialog)) && /Raid leader: Bravo/.test(stripTags(bobDialog)), 'the guild\'s own roles, one box per team for the team role');
  const daveDialog = G.pages.people.rolesDialogHtml(dave, s.guildData.teams, 'Ember', rolesList.roles.filter((r) => r.kind === 'custom'));
  assert((daveDialog.match(/checked/g) || []).length >= 2, 'what Dave holds by hand is ticked');
  // The reply of Sync now: the real body feeds the notice the page builds.
  s.world.discord.members[DAVE.id] = [D_OFFICERS];
  const synced = await G.api.discord.syncPerson(s.gid, s.ids.dave);
  assert.deepEqual([synced.sync.status, synced.sync.added], ['changed', 1]);
  assert(synced.people.find((p) => p.person.id === s.ids.dave).roles.some((r) => r.role === 'officer' && r.fromDiscord === true));
  const all = await G.api.discord.syncAll(s.gid, null);
  assert.deepEqual(Object.keys(all).sort(), ['changed', 'failed', 'next', 'problem', 'processed', 'skipped', 'unchanged']);
  assert.equal(all.next, null);
});

check('router and shell: the viewer routes round-trip, the new Guild settings tabs follow the real permissions', async () => {
  const s = await scenario();
  const { G } = s;
  const token = 'Ab1-_'.repeat(8) + 'xyz';
  assert.equal(token.length, 43);
  const plain = (value) => JSON.parse(JSON.stringify(value)); // objects made inside the vm are not the test realm's
  assert.deepEqual(plain(G.router.parse(`#/guest/${token}`)), { name: 'guest', token });
  assert.equal(G.router.format({ name: 'guest', token }), `#/guest/${token}`);
  assert.deepEqual(plain(G.router.parse('#/view')), { name: 'view' });
  assert.deepEqual(plain(G.router.parse(`#/public/${s.gid}`)), { name: 'public', gid: s.gid });
  assert.equal(G.router.format({ name: 'public', gid: s.gid }), `#/public/${s.gid}`);
  assert.equal(G.router.parse('#/guest/short').name, 'notfound');
  // Tabs from the real `can` of each person.
  const tabsFor = async (jar) => {
    const P = loadPages(s.world, jar);
    return plain(P.shell.settingsTabs((await P.api.get(s.base)).me.can).map((t) => t.tab));
  };
  assert.deepEqual(await tabsFor(s.jar), ['teams', 'schedule', 'people', 'roles', 'discord', 'guests', 'public', 'attendance', 'loot', 'battlenet']);
  assert.deepEqual(await tabsFor(s.daveJar), []);
});


check('privacy page: names the guest cookie, the public page and the roles Discord gives', async () => {
  const s = await scenario();
  const text = stripTags(s.G.pages.privacy.privacyHtml({ me: null }));
  assert(/guest link/i.test(text) && /one more cookie that lasts as long as the link works/.test(text), 'the guest cookie is listed with the others');
  assert(/public page/i.test(text) && /never notes, Discord names or accounts/.test(text), 'the public page is described');
  assert(/maps Discord roles/.test(text) && /marked as given by Discord/.test(text), 'the roles Discord gives are described');
});


// @@CHECKS@@

// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;
  const only = process.argv[2];
  for (const { name, fn } of checks) {
    if (only && !name.includes(only)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String((error && error.stack) || error).split('\n').slice(0, 14).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });
