/**
 * Raidsmith guild tracker - PM wave 4 CONTRACT tests (Worker <-> pages)
 * Run: node guild-wave4-contract-tests.js [name-filter]
 *
 * guild-wave4-worker-tests.js and guild-wave4-ui-tests.js each work with hand-made data on the other side. This suite joins them, the way
 * guild-wave3-contract-tests.js does: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1
 * stand-in) through G.api, their real handlers run, and what they draw from the real answers is checked next to what the Worker stored. Discord is never
 * called: a webhook post goes to an injected fetch that records it. One check per thing a person can see: Settings > Notifications, the opt-out on Linked
 * accounts, and the Home and Raids lines that follow from what the scheduler found.
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
const SERVER = '900000000000000041';
const PEOPLE = {
  alice: { id: '110000000000000201', username: 'alice', globalName: 'Alice A' },
  erin: { id: '110000000000000205', username: 'erin', globalName: 'Erin E' },
};
const NOW = Date.parse('2026-10-17T16:00:00Z');
const HOOK = 'https://discord.com/api/webhooks/987654321098765432/abcdefghijklmnopqrstuvwxyz0123456789ABCDE';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const ctrl = (value, extra) => Object.assign({ value, checked: false, focus() {}, setAttribute() {} }, extra || {});
const el = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

// ---------------------------------------------------------------------------
// The Worker side

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0, posts: [] };
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    discord.calls++;
    if (u.hostname === 'discord.com' && u.pathname.startsWith('/api/webhooks/')) {
      discord.posts.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${discord.calls}`;
      discord.tokens.set(token, discord.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec((init.headers && init.headers.Authorization) || '');
    const session = bearer && discord.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  const clock = { now: NOW };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = { DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`, GUILD_CREATOR_ALLOWLIST: PEOPLE.alice.id };
  const app = createApp({ db, env, fetch: fakeFetch, now: () => clock.now, randomBytes, log: () => {} });
  return { db, clock, discord, app, env, fetch: fakeFetch, randomBytes };
}

function absorb(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[pair.slice(0, index)];
    else jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

const fetchFor = (world, jar) => async (urlPath, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await world.app.handle(new Request(`${ORIGIN}${urlPath}`, { method: init.method, headers, body: init.body }));
  absorb(jar, response);
  return response;
};

async function signIn(world, person, servers) {
  const jar = {};
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await fetchFor(world, jar)('/auth/login', { method: 'GET' });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await fetchFor(world, jar)(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { method: 'GET' });
  return jar;
}

// ---------------------------------------------------------------------------
// The pages side

function loadPages(world, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  const f = fetchFor(world, jar);
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  G.texts = {};
  G.errors = [];
  G.ui.setText = (id, text) => { G.texts[id] = text; };
  G.ui.setBusy = () => {};
  G.app.render = () => {};
  G.app.handleError = (err) => { G.errors.push(err); };
  G.app.go = () => {};
  return G;
}

const MEMBER_SERVER = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];

async function scenario() {
  const world = await makeWorld();
  const aliceJar = await signIn(world, PEOPLE.alice, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const A = loadPages(world, aliceJar);
  const created = await A.api.post('/api/guild', { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] });
  const gid = created.guild.id;
  const teamIds = created.teams.map((team) => team.id);
  const base = `/api/guild/${gid}`;
  const E = loadPages(world, await signIn(world, PEOPLE.erin, MEMBER_SERVER));
  const s = { world, A, E, gid, teamId: teamIds[0], teamIds, base };
  for (const G of [A, E]) G.guildData = await G.api.get(base);
  s.rows = (sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results);
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function pageState(s, G, teamId) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: G.guildData };
  S.currentGid = s.gid;
  S.pageAlert = '';
  S.notifySettings = null;
  G.app.teamFor = () => teamId || s.teamId;
  return S;
}
// The form a team's card submits, by control name.
function formFor(teamId, values) {
  const elements = {};
  for (const name of ['webhookUrl', 'roleMention', 'roster', 'loot', 'reminders', 'noreply', 'confirm', 'noreplyHours']) {
    elements[name] = ctrl(values[name] === undefined ? '' : values[name], { checked: values[name] === true });
  }
  return { elements, getAttribute: (k) => (k === 'data-team' ? teamId : null), querySelectorAll: () => [] };
}

// ---------------------------------------------------------------------------

check('Settings > Notifications: an officer saves a team\'s webhook through the real page; the address is stored, never drawn; a bad address lands under the card; Remove clears it; a member cannot open the tab', async () => {
  const s = await scenario();
  const { A, E } = s;
  const S = pageState(s, A);
  await A.pages.settingsNotify.load(s.gid);
  const page = () => A.pages.settingsNotify.settingsHtml({ guildData: A.guildData, data: S.notifySettings.data, notice: S.notifySettings.notice });
  let text = stripTags(page());
  assert(text.includes('Alpha') && text.includes('Bravo') && text.includes('No webhook'));
  // Save Alpha: the address, a role, the roster post and no-reply reminders at 12 hours.
  A.handlers.submit['notify-save'](formFor(s.teamId, { webhookUrl: HOOK, roleMention: '<@&223456789012345678>', roster: true, noreply: true, noreplyHours: '12' }));
  await settle();
  const row = (await s.rows('SELECT webhook_url, role_mention, post_roster, post_loot, post_noreply, noreply_hours, webhook_state FROM team_notifications'))[0];
  assert.deepEqual(plain(row), { webhook_url: HOOK, role_mention: '223456789012345678', post_roster: 1, post_loot: 0, post_noreply: 1, noreply_hours: 12, webhook_state: 'ok' });
  assert.equal(S.notifySettings.notice, 'Saved for Alpha.');
  const html = page();
  assert(!html.includes('abcdefghijklmnop') && !html.includes('987654321098765432'), 'the page never has the address');
  assert(stripTags(html).includes('Webhook saved, ending in .../' + HOOK.slice(-4)) && stripTags(html).includes('Webhook set'));
  assert(html.includes('value="&lt;@&amp;223456789012345678&gt;"'));
  assert(/<input type="checkbox" id="notify-t_[A-Za-z0-9_-]+-roster" name="roster" checked>/.test(html));
  // A mistake comes back from the Worker and lands under the card.
  A.handlers.submit['notify-save'](formFor(s.teamId, { webhookUrl: 'https://example.com/hook', noreplyHours: '12' }));
  await settle();
  assert.match(A.texts[`notify-${s.teamId}-error`], /not a Discord webhook address/);
  assert.equal((await s.rows('SELECT webhook_url FROM team_notifications'))[0].webhook_url, HOOK, 'unchanged');
  A.handlers.submit['notify-save'](formFor(s.teamId, { roleMention: '@everyone', noreplyHours: '12' }));
  await settle();
  assert.match(A.texts[`notify-${s.teamId}-error`], /@everyone and @here are never used/);
  // Remove.
  A.handlers.click['notify-remove'](el({ 'data-team': s.teamId }));
  await settle();
  assert.equal((await s.rows('SELECT webhook_url FROM team_notifications'))[0].webhook_url, null);
  assert(stripTags(page()).includes('Removed the webhook of Alpha.'));
  // The Activity log says what changed in words, and never the address.
  const log = await A.api.get(`${s.base}/audit?group=settings`);
  const sentences = log.rows.filter((r) => r.action === 'notify.update').map((r) => r.text);
  assert.deepEqual(sentences, ['Changed the Discord notifications of Alpha: webhook', 'Changed the Discord notifications of Alpha: webhook, mentioned role, line-up posts, no-reply reminders and no-reply lead time'], 'newest first');
  assert(!JSON.stringify(log).includes('abcdefghijklmnop'));
  // A member does not get the tab, and the Worker refuses the read.
  assert.deepEqual(plain(E.shell.settingsTabs(E.guildData.me.can, E.guildData.me.roles).map((t) => t.tab)), []);
  await assert.rejects(E.api.get(`${s.base}/notifications`), (err) => err.status === 403);
});

check('Linked accounts: a member ticks "Don\'t mention me in reminders" on the real page; the Worker keeps one row and /auth/me draws the box ticked; unticking removes it', async () => {
  const s = await scenario();
  const { E } = s;
  const S = E.app.state;
  S.bnet = null;
  await E.app.loadMe();
  assert.equal(E.pages.accounts.reminderOptOutOf(S.me), false);
  assert(!/reminder-optout" name="reminderOptOut" checked data-change="reminder-optout"/.test(E.pages.accounts.reminderCardHtml(S.me)));
  const box = ctrl('on', { checked: true });
  E.handlers.change['reminder-optout'](box);
  await settle();
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM reminder_optouts'))[0].n, 1);
  assert.equal(E.pages.accounts.reminderOptOutOf(S.me), true, 'refresh read the new /auth/me');
  assert(/reminder-optout" name="reminderOptOut" checked data-change="reminder-optout"/.test(E.pages.accounts.reminderCardHtml(S.me)));
  assert.equal(S.bnet.notice, "You won't be pinged in reminders.");
  E.handlers.change['reminder-optout'](ctrl('off', { checked: false }));
  await settle();
  assert.equal((await s.rows('SELECT COUNT(*) AS n FROM reminder_optouts'))[0].n, 0);
  assert.equal(E.pages.accounts.reminderOptOutOf(S.me), false);
});

check('Home and Raids: what the scheduler found - an event on another day, a webhook Discord refused, seats nobody confirmed - is drawn from the real answers with working links; the Raids line says how fresh the sign-ups are', async () => {
  const s = await scenario();
  const { A } = s;
  const raid = await A.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn: '2026-10-18', startTime: '14:00', zone: "Gruul's Lair", title: 'Gruul night' });
  const rid = raid.raid.id;
  const startsAt = (await s.rows('SELECT starts_at FROM raids WHERE id = ?', rid))[0].starts_at;
  const synced = startsAt - 5 * 3600000 - 12 * 60000; // the scheduler read the event 12 minutes before the clock the pages will see
  // The scheduler's findings, as it leaves them in the database.
  s.world.db.sqlite.prepare("UPDATE raids SET event_id = '123456789', event_server = ?, event_synced = ?, event_checked_at = ?, event_moved_on = '2026-10-19' WHERE id = ?").run(SERVER, synced, synced, rid);
  await A.api.put(`${s.base}/teams/${s.teamId}/notifications`, { webhookUrl: HOOK, reminders: true });
  s.world.db.sqlite.prepare("UPDATE team_notifications SET webhook_state = 'disabled', disabled_at = ?, disabled_status = 404").run(NOW);
  s.world.db.sqlite.prepare("INSERT INTO raid_roster (raid_id, guild_id, name_key, name, group_number, status, seq) VALUES (?, ?, 'aldric', 'Aldric', 1, 'pending', 0), (?, ?, 'bryn', 'Bryn', 1, 'pending', 1)").run(rid, s.gid, rid, s.gid);
  s.world.db.sqlite.prepare('UPDATE raids SET roster_published_at = ? WHERE id = ?').run(NOW - 3600000, rid);
  s.world.clock.now = startsAt - 5 * 3600000; // 5 h before the start: the confirm count is open
  // Home.
  const S = pageState(s, A);
  const view = { name: 'section', gid: s.gid, section: 'home' };
  await A.pages.attention.load(view, A.guildData);
  const data = S.att.attention.data;
  const kinds = plain(data.items.map((item) => item.kind));
  assert.deepEqual(kinds.filter((k) => ['roster_pending', 'event_moved', 'webhook_off'].includes(k)), ['roster_pending', 'event_moved', 'webhook_off']);
  // Round 4: the seats nobody confirmed are a readiness fact (they read in the raid's sentence); the event on another day is a to-do of its raid (shown on its
  // day), the webhook one of the Guild box.
  S.att.attention.sel = rid;
  const html = A.pages.attention.main(view, A.guildData);
  const text = stripTags(html);
  const day = A.ui.weekdayDay;
  assert(/2 no answer./.test(text), text.slice(0, 800));
  assert(text.includes(`${day('2026-10-18')}: Raid-Helper has the event on ${day('2026-10-19')}; the raid was not moved`));
  assert(text.includes('The Discord webhook of Alpha was switched off (Discord answered 404)'));
  assert(!text.includes("haven't confirmed"), 'the pending seats are no to-do row');
  for (const item of data.items.filter((i) => ['event_moved', 'webhook_off'].includes(i.kind))) {
    const href = A.pages.attention.itemHref(s.gid, item);
    assert(html.includes(`href="${href}"`), href);
    assert.notEqual(href, A.router.format({ name: 'section', gid: s.gid, section: 'roster' }), 'a link of its own, not the Roster fallback');
    const parsed = plain(A.router.parse(href));
    assert(['raid', 'settings'].includes(parsed.name), JSON.stringify(parsed));
  }
  assert(html.includes(`href="#/g/${s.gid}/settings/notifications"`));
  // Raids (the page reads the clock of the browser; here that is the Worker's).
  const realNow = Date.now;
  Date.now = () => s.world.clock.now;
  try {
    pageState(s, A);
    const route = { name: 'section', gid: s.gid, section: 'raids' };
    await A.pages.raids.load(route, A.guildData);
    const list = stripTags(A.pages.raids.main(route, A.guildData));
    assert(list.includes('Sign-ups refreshed 12 min ago'), list.slice(0, 600));
    assert(list.includes(`Raid-Helper has this event on ${day('2026-10-19')}. The raid was not moved.`));
    // A member sees the freshness, not the officers' warning.
    pageState(s, s.E);
    await s.E.pages.raids.load(route, s.E.guildData);
    const mine = stripTags(s.E.pages.raids.main(route, s.E.guildData));
    assert(mine.includes('Sign-ups refreshed 12 min ago') && !mine.includes('Raid-Helper has this event on'));
  } finally { Date.now = realNow; }
});

// ---------------------------------------------------------------------------

async function main() {
  const filter = process.argv[2] || '';
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 10).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
