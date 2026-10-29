/**
 * Raidsmith guild tracker - lane B3 minimal UI, RAIDS AND GUESTS: CONTRACT tests (Worker <-> pages)
 * Run: node tests/guild/guild-b3ui-raids-contract-tests.js
 *
 * The real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in) through G.api, the way
 * guild-fw3-contract-tests.js does, and what they draw from the real answers is checked:
 *   - New raid and Raid settings write guestsOpen / guestLimit (and an empty limit, an unticked check and a bad limit do what the page says);
 *   - the open-raid sign-up page in a guild that is not in-game (typed fields, "N spots left", done + Withdraw, a full raid) and in an in-game guild (Connect Battle.net,
 *     the account's own Battle.net list, the pick, the in-game rule), a member being sent to the raid page;
 *   - the public page's Sign up link, on open upcoming raids only.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = path.join(__dirname, '..', '..');
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000001';
const PEOPLE = {
  alice: { id: '110000000000000001', username: 'alice', globalName: 'Alice A' },
  dave: { id: '110000000000000004', username: 'dave', globalName: 'Dave D' },
  erin: { id: '110000000000000005', username: 'erin', globalName: 'Erin E' },
};
const NOW = Date.parse('2026-10-17T16:00:00Z');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
const ws = (text) => String(text).split(String.fromCharCode(0x202f)).join(' ').split(String.fromCharCode(0xa0)).join(' ').replace(/ ([,.])/g, '$1');
const ctrl = (value, extra) => Object.assign({ value, checked: false, focus() {}, setAttribute() {} }, extra || {});
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0 };
  const discordFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    discord.calls++;
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
  const env = { DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`, GUILD_CREATOR_ALLOWLIST: PEOPLE.alice.id, BNET_CLIENT_ID: 'bnet-id', BNET_CLIENT_SECRET: 'bnet-secret', BNET_REDIRECT_URI: `${ORIGIN}/auth/bnet/callback` };
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
  G.dialogs = [];
  G.texts = {};
  G.gone = [];
  G.ui.openDialog = (html) => { G.dialogs.push(html); return null; };
  G.ui.runDialog = (form, promise, onOk) => promise.then(onOk);
  G.ui.setText = (id, text) => { G.texts[id] = text; };
  G.ui.setBusy = () => {};
  G.ui.closeDialogOf = () => {};
  G.ui.focusByKey = () => false;
  G.app.handleError = () => {};
  G.app.render = () => {};
  G.app.go = (hash, replace) => { G.gone.push([hash, !!replace]); };
  return G;
}

async function scenario() {
  const world = await makeWorld();
  const aliceJar = await signIn(world, PEOPLE.alice, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const A = loadPages(world, aliceJar);
  const created = await A.api.post('/api/guild', { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Vindicated', timeZone: 'America/New_York', multipleTeams: false });
  const gid = created.guild.id;
  const teamId = created.teams[0].id;
  const base = `/api/guild/${gid}`;
  const D = loadPages(world, await signIn(world, PEOPLE.dave, []));
  const E = loadPages(world, await signIn(world, PEOPLE.erin, []));
  A.guildData = await A.api.get(base);
  const userIds = {};
  for (const [key, G] of [['dave', D], ['erin', E]]) userIds[key] = (await G.api.get('/auth/me')).user.id;
  const s = {
    world, A, D, E, gid, teamId, base, userIds,
    raid: async (over) => (await A.api.post(`${base}/raids`, { teamId, raidOn: '2026-12-05', startTime: '20:00', zone: 'Karazhan', ...(over || {}) })).raid.id,
    rows: (sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results),
    ingame: () => world.db.sqlite.prepare("UPDATE guilds SET rank_source = 'ingame' WHERE id = ?").run(gid),
    bnetList: (who, characters) => {
      const { bnetSupport } = s.battlenet;
      const snapshot = { [bnetSupport('tbc', 'US').namespace]: { fetchedAt: NOW, characters } };
      world.db.sqlite.prepare('DELETE FROM bnet_links WHERE user_id = ?').run(userIds[who]);
      world.db.sqlite.prepare("INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(userIds[who], String(880000 + (who === 'dave' ? 1 : 2)), `${who[0].toUpperCase()}${who.slice(1)}#4821`, NOW, JSON.stringify(snapshot), NOW);
    },
  };
  s.battlenet = await import(pathToFileURL(path.join(ROOT, 'worker/battlenet.js')).href);
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const MAGE = { name: 'Corvane', realm: 'Nightslayer', realmSlug: 'nightslayer', class: 'ROGUE', level: 70 };
const WARLOCK = { name: 'Nightbriar', realm: 'Nightslayer', realmSlug: 'nightslayer', class: 'WARLOCK', level: 64 };

check('New raid and Raid settings write guestsOpen and guestLimit: the create body, the settings dialog from the real raid, and each Save (check, limit, cleared, unticked, a bad limit that never leaves the page)', async () => {
  const s = await scenario();
  const { A } = s;
  const form = (over) => ({ teamId: s.teamId, event: '', reports: [''], plan: '', mode: 'log', date: '2026-12-05', time: '20:00', zone: 'Karazhan', title: '', size: '', guestsOpen: true, guestLimit: '10', ...over });
  const body = A.pages.raidNew.createBody(form(), false, '2026-10-17');
  assert.equal(body.guestsOpen, true);
  const rid = (await A.api.post(`${s.base}/raids`, body)).raid.id;
  assert.deepEqual((await s.rows('SELECT guests_open, guest_limit FROM raids WHERE id = ?', rid))[0], { guests_open: 1, guest_limit: 10 });
  const closed = (await A.api.post(`${s.base}/raids`, A.pages.raidNew.createBody(form({ date: '2026-12-06', guestsOpen: false }), false, '2026-10-17'))).raid.id;
  assert.deepEqual((await s.rows('SELECT guests_open, guest_limit FROM raids WHERE id = ?', closed))[0], { guests_open: 0, guest_limit: null });
  const noLimit = (await A.api.post(`${s.base}/raids`, A.pages.raidNew.createBody(form({ date: '2026-12-07', guestLimit: '' }), false, '2026-10-17'))).raid.id;
  assert.deepEqual((await s.rows('SELECT guests_open, guest_limit FROM raids WHERE id = ?', noLimit))[0], { guests_open: 1, guest_limit: null });

  // The dialog is drawn from the real raid and each Save is one PATCH of what changed.
  const S = A.app.state;
  S.att = {}; S.guilds = { [s.gid]: A.guildData }; S.currentGid = s.gid; A.app.teamFor = () => s.teamId;
  const route = { name: 'raid', gid: s.gid, rid };
  await A.pages.raid.load(route, A.guildData);
  const dialog = () => { A.handlers.click['raid-op']({ getAttribute: (k) => (k === 'data-op' ? 'settings' : null), disabled: false }); return ws(A.dialogs[A.dialogs.length - 1]); };
  const html = dialog();
  assert(html.includes('id="rs-guests" name="guestsOpen" checked') && html.includes('name="guestLimit"') && html.includes('value="10"'), html.slice(html.indexOf('rs-guests') - 20, html.indexOf('rs-guests') + 700));
  const save = async (checked, limit) => {
    await A.handlers.submit['raid-settings-form']({ elements: { size: ctrl(''), hoursMode: ctrl(''), hours: ctrl(''), guestsOpen: ctrl('', { checked }), guestLimit: ctrl(limit) } });
    await settle();
    return (await s.rows('SELECT guests_open, guest_limit FROM raids WHERE id = ?', rid))[0];
  };
  assert.deepEqual(await save(true, '25'), { guests_open: 1, guest_limit: 25 });
  assert.deepEqual(await save(true, ''), { guests_open: 1, guest_limit: null }, 'empty = no limit');
  assert.deepEqual(await save(true, '500'), { guests_open: 1, guest_limit: null }, 'a bad limit never leaves the page');
  assert.deepEqual(await save(false, ''), { guests_open: 0, guest_limit: null });
  assert.deepEqual(await save(true, '3'), { guests_open: 1, guest_limit: 3 });
  assert(dialog().includes('value="3"'), 'the dialog reads the saved limit back');
  const list = await A.api.get(`${s.base}/raids?team=${s.teamId}`);
  assert.deepEqual(list.upcoming.filter((r) => r.id === rid).map((r) => r.guestsOpen), [true]);
});

check('the open-raid page in a guild that is not in-game: typed fields, the spot count from the limit, sign up, done + Withdraw my sign-up, a full raid, a member sent to the raid page', async () => {
  const s = await scenario();
  const { A, D, E } = s;
  const rid = await s.raid({ guestsOpen: true, guestLimit: 1 });
  const route = { name: 'join', open: true, gid: s.gid, rid };
  const draw = (G) => G.pages.openRaid.openHtml({ state: G.app.state.join });
  await D.pages.openRaid.load(route);
  let out = draw(D);
  let t = ws(stripTags(out));
  assert(t.includes('Sign up for Vindicated') && t.includes('Karazhan - Main team - Sat Dec 5, 8:00 PM ET') && t.includes('Vindicated opened this raid to guests. 1 spot left.'), t);
  assert(out.includes('name="name"') && out.includes('name="class"') && !out.includes('gs-pickrow'), 'typed fields');
  // Sign up through the form handler.
  const form = (v) => ({ elements: { name: ctrl(v.name), class: ctrl(v.class), spec: ctrl(v.spec), note: ctrl(v.note || ''), website: ctrl('') }, querySelector: () => null, querySelectorAll: () => [] });
  await D.handlers.submit['open-form'](form({ name: 'Wanderer', class: 'MAGE', spec: 'Fire', note: 'from Ashen Watch' }));
  await settle();
  const rows = await s.rows("SELECT nickname, class_name, spec_name, note, guest, guest_user_id FROM raid_signups WHERE raid_id = ? AND guest = 1", rid);
  assert.deepEqual(rows.map((r) => [r.nickname, r.class_name, r.note, r.guest, r.guest_user_id]), [['Wanderer', 'Mage', 'from Ashen Watch', 1, s.userIds.dave]]);
  out = draw(D);
  t = ws(stripTags(out));
  assert(t.includes('You are signed up') && t.includes('Signed up as Wanderer, Mage - Fire.') && t.includes('Withdraw my sign-up'), t);
  assert(out.includes('<span class="gs-char-name gs-class-mage">Wanderer</span>'), 'the name is in its class colour');
  // The raid is full for the next guest.
  await E.pages.openRaid.load(route);
  t = ws(stripTags(draw(E)));
  assert(t.includes('No guest spots left') && t.includes('No spots left.') && !draw(E).includes('data-submit'), t);
  // The Worker agrees if the page was stale.
  const stale = await E.api.openRaid.submit(s.gid, rid, { name: 'Latecomer', class: 'MAGE', spec: 'Fire', website: '' }).catch((e) => e);
  assert.equal(stale.code, 'raid_full');
  // Withdraw: one DELETE, the form (and the spot) are back.
  await D.handlers.click['open-withdraw']({ disabled: false });
  await settle();
  assert.equal((await s.rows('SELECT 1 FROM raid_signups WHERE raid_id = ? AND guest = 1', rid)).length, 0);
  out = draw(D);
  t = ws(stripTags(out));
  assert(t.includes('You are no longer signed up for this raid') && t.includes('1 spot left.') && out.includes('data-submit="open-form"'), t);
  // The Guild Master is a member: sent to the raid page (the address is replaced).
  await A.pages.openRaid.load(route);
  assert.equal(A.app.state.join.status, 'member');
  assert.deepEqual(A.gone, [[`#/g/${s.gid}/raids/r/${rid}`, true]]);
  // A raid that is not open, and one that does not exist: "not open to guests".
  const closed = await s.raid({ raidOn: '2026-12-06' });
  await D.pages.openRaid.load({ name: 'join', open: true, gid: s.gid, rid: closed });
  assert(ws(stripTags(draw(D))).includes('This raid is not open to guests'));
});

check('the open-raid page in an in-game guild: Connect Battle.net without a link; the account\'s own list as radio rows with it; the pick signs up with the list\'s name and class; a typed character and another account\'s character are refused by the Worker', async () => {
  const s = await scenario();
  const { D, E } = s;
  const rid = await s.raid({ guestsOpen: true, guestLimit: 11 });
  // A roster character of the guild with the name of one of erin's Battle.net characters (made before the guild runs on the in-game roster).
  assert((await s.A.api.post(`${s.base}/roster`, { teamId: s.teamId, name: 'Erinsrogue', class: 'ROGUE', mainSpec: 'Combat', offSpec: null, status: 'raider' })).person.id);
  s.ingame();
  const route = { name: 'join', open: true, gid: s.gid, rid };
  const draw = (G) => G.pages.openRaid.openHtml({ state: G.app.state.join });
  // Not connected.
  await D.pages.openRaid.load(route);
  let out = draw(D);
  let t = ws(stripTags(out));
  assert(t.includes('Connect Battle.net to sign up') && t.includes('Vindicated takes guests who have Battle.net connected.') && out.includes(`href="/auth/bnet/login?return=${encodeURIComponent(`#/open/${s.gid}/${rid}`)}"`) && !out.includes('data-submit'), t);
  assert(t.includes('11 spots left.'));
  // Connected: the list, highest level first, the first one picked, the specs of its class.
  s.bnetList('dave', [WARLOCK, MAGE]);
  s.bnetList('erin', [{ ...MAGE, name: 'Erinsrogue' }]);
  await D.pages.openRaid.load(route);
  out = draw(D);
  t = ws(stripTags(out));
  assert(t.includes('From your Battle.net, Dave#4821.') && t.includes('Rogue - Level 70 - Nightslayer') && t.includes('Warlock - Level 64 - Nightslayer'), t);
  assert(out.indexOf('Corvane') < out.indexOf('Nightbriar') && out.includes('value="nightslayer|Corvane" checked'));
  assert(out.includes('<option value="Combat">Combat</option>') && !out.includes('name="name"'));
  // Pick the second character with a fake form, as the radio change and the submit do.
  const form = (pick, spec, note) => ({ elements: { spec: ctrl(spec), note: ctrl(note || ''), website: ctrl('') }, querySelector: (sel) => (sel === 'input[name="character"]:checked' ? { value: pick, checked: true } : null), querySelectorAll: () => [] });
  await D.handlers.submit['open-form'](form('nightslayer|Nightbriar', 'Affliction', 'hello'));
  await settle();
  const rows = await s.rows('SELECT nickname, class_name, spec_name, note FROM raid_signups WHERE raid_id = ? AND guest = 1', rid);
  assert.deepEqual(rows.map((r) => [r.nickname, r.class_name, r.note]), [['Nightbriar', 'Warlock', 'hello']]);
  out = draw(D);
  t = ws(stripTags(out));
  assert(t.includes('You are signed up') && t.includes('Signed up as Nightbriar, Warlock - Affliction.') && out.includes('gs-class-warlock'), t);
  assert(t.includes('Withdraw my sign-up') && (await D.api.get(`/api/open/${s.gid}/raids/${rid}`)).spotsLeft === 10);
  // The in-game rule at the Worker: typed fields, another account's character, a made-up one.
  const typed = await E.api.openRaid.submit(s.gid, rid, { name: 'Wanderer', class: 'MAGE', spec: 'Fire', website: '' }).catch((e) => e);
  assert.deepEqual([typed.status, typed.code], [409, 'battlenet_only']);
  const foreign = await E.api.openRaid.submit(s.gid, rid, { character: { name: 'Corvane', realmSlug: 'nightslayer' }, spec: 'Combat', website: '' }).catch((e) => e);
  assert.deepEqual([foreign.status, foreign.code, foreign.field], [400, 'bad_request', 'character']);
  // The page for erin shows her list only and refuses to draw anyone else's.
  await E.pages.openRaid.load(route);
  out = draw(E);
  assert(out.includes('Erinsrogue') && !out.includes('Nightbriar') && !out.includes('Corvane<'), 'her own list only');
  // The form's own refusal: erin picks a character she has, but the name is on the guild's roster.
  await E.handlers.submit['open-form'](form('nightslayer|Erinsrogue', 'Combat'));
  await settle();
  assert.equal((await s.rows('SELECT 1 FROM raid_signups WHERE raid_id = ? AND guest = 1 AND guest_user_id = ?', rid, s.userIds.erin)).length, 0, 'a roster name is refused');
});

check('the public page: Sign up on open upcoming raids only, linking to the sign-up page; none after the check is switched off', async () => {
  const s = await scenario();
  const { A } = s;
  const open = await s.raid({ raidOn: '2026-12-05', guestsOpen: true });
  const closed = await s.raid({ raidOn: '2026-12-06' });
  await A.api.put(`${s.base}/public`, { enabled: true, sections: ['raids'] });
  const visitor = loadPages(s.world, {});
  const links = async () => {
    const view = await visitor.pages.view.load({ name: 'public', gid: s.gid });
    assert.equal(view.error, null, JSON.stringify(view.error));
    const out = visitor.pages.view.viewHtml({ data: view.data, kind: 'public', gid: s.gid });
    return [...out.matchAll(/<a class="gs-btn gs-btn-sm" href="([^"]*)" aria-label="([^"]*)"><span>Sign up<\/span><\/a>/g)].map((m) => [m[1], m[2]]);
  };
  assert.deepEqual(await links(), [[`#/open/${s.gid}/${open}`, 'Sign up for Main team on Sat Dec 5']]);
  assert(!JSON.stringify(await visitor.api.get(`/api/public/${s.gid}`)).includes(closed), 'the id of a raid that is not open is not sent');
  await A.api.patch(`${s.base}/raids/${open}`, { guestsOpen: false });
  assert.deepEqual(await links(), []);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 8).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
