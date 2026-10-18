/**
 * Raidsmith guild tracker - Phase 6 sign-ups + raid schedule CONTRACT tests (Worker <-> pages)
 * Run: node guild-signups-contract-tests.js [name-filter]
 *
 * The Worker suite (guild-signups-worker-tests.js) and the pages suite (guild-signups-ui-tests.js) each work from "API (as built)" in
 * tasks/guild-phase6-signups-spec.md, with hand-made data on the other side. This suite joins them: the real pages (tests/guild-scripts.js
 * in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in) through G.api, their real click and submit
 * handlers run, and what they draw from the real answers is checked. A field one side names differently, nests differently or leaves out
 * shows up here as a missing name, a blank cell or a thrown error. The last check hands the Worker's planner seed to the Planner's own
 * Raid-Helper reader. Discord is faked by an injected fetch; no network, no Wrangler, no credentials.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('./tests/d1-fake');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const planner = require('./tests/load-app');

const ROOT = __dirname;
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000001';
const ALICE = { id: '110000000000000001', username: 'alice', globalName: 'Alice A' };
const ERIN = { id: '110000000000000005', username: 'erin', globalName: 'Erin E' };
const HANK = { id: '110000000000000008', username: 'hank', globalName: 'Hank H' };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const el = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});

// ---------------------------------------------------------------------------
// The Worker side: one app over one D1, a cookie jar per signed-in person

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0 };
  const events = new Map(); // Raid-Helper events by id (the Worker's GET /api/v4/events/:id)
  const discordFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === 'raid-helper.dev') {
      const event = events.get(u.pathname.split('/').pop());
      return event ? Response.json(event) : new Response('{}', { status: 404 });
    }
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
  const clock = { now: Date.parse('2026-10-17T16:00:00Z') }; // Saturday; the raid is the next Saturday at 20:00 New York time
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = {
    DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`,
    GUILD_CREATOR_ALLOWLIST: ALICE.id,
  };
  const app = createApp({ db, env, fetch: discordFetch, now: () => clock.now, randomBytes, log: () => {} });
  return { db, clock, discord, app, events };
}

function absorb(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[pair.slice(0, index)];
    else jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

// A fetch the page's G.api.request can use: the Worker answers, the jar carries the session.
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
// The pages side: the real scripts with G.api routed to the Worker, one set per signed-in person

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
  // The dialog shell needs a DOM: the dialogs' HTML is kept for the checks and their requests run as they do.
  G.dialogs = [];
  G.ui.openDialog = (html) => { G.dialogs.push(html); return null; };
  G.ui.runDialog = (form, promise, onOk) => promise.then(onOk);
  G.ui.setText = () => {};
  G.ui.focusByKey = () => false;
  return G;
}

// ---------------------------------------------------------------------------
// Scenario: Alice (Guild Master) runs the guild; Erin is the member behind Thoren (a Paladin with a Mage alt); Hank has no character.
// One raid of the team is a week away.

const GUILD_BODY = { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };
const RAID_ON = '2026-10-24';

async function scenario() {
  const world = await makeWorld();
  const aliceJar = await signIn(world, ALICE, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const A = loadPages(world, aliceJar);
  const created = await A.api.post('/api/guild', GUILD_BODY);
  const gid = created.guild.id;
  const teamId = created.teams[0].id;
  const base = `/api/guild/${gid}`;
  const people = {};
  for (const [name, cls, main, off] of [['Thoren', 'PALADIN', 'Protection', 'Holy'], ['Kaelith', 'ROGUE', 'Combat', null], ['Mirabel', 'HUNTER', 'Marksmanship', null]]) {
    const made = await A.api.post(`${base}/roster`, { teamId, name, class: cls, mainSpec: main, offSpec: off, status: 'raider' });
    people[name] = made.person.id;
  }
  const alt = await A.api.post(`${base}/roster/${people.Thoren}/characters`, { name: 'Thorenmage', class: 'MAGE', mainSpec: 'Fire', offSpec: null, teamId, makeMain: false });
  assert(alt.characters || alt.person, 'the alt was added');
  world.db.sqlite.exec(`UPDATE players SET discord_user_id = '${ERIN.id}' WHERE id = '${people.Thoren}'`);
  const raid = (await A.api.post(`${base}/raids`, { teamId, raidOn: RAID_ON, startTime: '20:00' })).raid.id;
  const member = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
  const E = loadPages(world, await signIn(world, ERIN, member));
  const H = loadPages(world, await signIn(world, HANK, member));
  const s = { world, A, E, H, gid, teamId, base, people, raid, rid: raid };
  for (const G of [A, E, H]) G.guildData = await G.api.get(base);
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// The state bag the pages keep, reset for a fresh page, with the guild payload this person got.
function pageState(s, G) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: G.guildData };
  S.currentGid = s.gid;
  S.pageAlert = '';
  G.app.teamFor = () => s.teamId;
  return S;
}

// Opens the raid page the way the router does: the detail, then the panel's data; -> the page HTML.
async function openRaid(s, G) {
  pageState(s, G);
  const route = { name: 'raid', gid: s.gid, rid: s.rid };
  await G.pages.raid.load(route, G.guildData);
  return () => G.pages.raid.main(route, G.guildData);
}

const rows = (world, sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results);

// ---------------------------------------------------------------------------

check('member: the raid page offers four buttons; Sign up, Late, a change of character and spec, a note, and Remove my sign-up are real requests the Worker accepts', async () => {
  const s = await scenario();
  const { E } = s;
  const page = await openRaid(s, E);
  let html = page();
  let text = stripTags(html);
  assert(/Your sign-up/.test(text) && /You have not signed up yet\./.test(text), text.slice(0, 400));
  for (const label of ['Sign up', 'Late', 'Tentative', 'Can']) assert(text.includes(label), label);
  assert(/Thoren \(Paladin\)/.test(text) && /Thorenmage \(Mage\)/.test(text), 'both characters are offered');
  assert(/Open until Sat, Oct 24, 8:00 PM|Open until Sat Oct 24, 8:00 PM/.test(text), 'the close time is in the guild\'s zone: ' + text.slice(0, 300));
  assert(!/Add a sign-up|Close sign-ups/.test(text), 'no officer tools for a member');

  await E.handlers.click['su-kind'](el({ 'data-kind': 'signed' }));
  let row = (await rows(s.world, "SELECT kind, class_name, spec_name, note FROM raid_signups WHERE source = 'raidsmith'"))[0];
  assert.deepEqual(row, { kind: 'signed', class_name: 'Paladin', spec_name: 'Protection1', note: null }, 'the default character and its main spec');
  html = page();
  text = stripTags(html);
  assert(/Tanks 1/.test(text) && /Thoren/.test(text) && /Protection/.test(text), text);
  assert(/Signed 1 Late 0/.test(text), 'the counts follow: ' + text.slice(0, 600));
  assert(html.includes('aria-pressed="true"') && /data-kind="signed"[^>]*aria-pressed="true"/.test(html));
  assert(/You are down as <strong>signed up<\/strong> with Thoren \(Protection\)/.test(html));

  // A different character, its spec, a note: through the form's own handlers.
  const mage = (await rows(s.world, "SELECT id FROM characters WHERE name = 'Thorenmage'"))[0].id;
  E.handlers.change['su-char'](el({}, { value: mage }));
  assert.equal(E.app.state.att.raidSignups.ui.form.spec, 'Fire', 'its main spec follows the character');
  E.handlers.change['su-spec'](el({}, { value: 'Frost' }));
  E.handlers.input['su-note'](el({}, { value: 'on my mage this week' }));
  await E.handlers.submit['su-details-form']();
  row = (await rows(s.world, "SELECT kind, class_name, spec_name, note, character_id FROM raid_signups WHERE source = 'raidsmith'"))[0];
  assert.deepEqual(row, { kind: 'signed', class_name: 'Mage', spec_name: 'Frost', note: 'on my mage this week', character_id: mage });
  text = stripTags(page());
  assert(/Ranged 1/.test(text) && /Thorenmage/.test(text) && /on my mage this week/.test(text), text);

  await E.handlers.click['su-kind'](el({ 'data-kind': 'late' }));
  assert.equal((await rows(s.world, "SELECT kind FROM raid_signups WHERE source = 'raidsmith'"))[0].kind, 'late');
  assert(/Late 1/.test(stripTags(page())));
  await E.handlers.click['su-kind'](el({ 'data-kind': 'absence' }));
  html = page();
  assert(/Can&#39;t come 1/.test(stripTags(html)) && /data-kind="absence"[^>]*aria-pressed="true"/.test(html));

  await E.handlers.click['su-withdraw'](el({}));
  assert.equal(await s.world.db.prepare('SELECT COUNT(*) AS n FROM raid_signups').first('n'), 0);
  assert(/You have not signed up yet\./.test(stripTags(page())));
  assert.equal(E.app.state.att.raidSignups.ui.error, '', 'no error left on the panel');
});

check('officer: the panel carries the tools; the Add / Edit dialogs are built from the real roster and their submits are real requests; Close sign-ups closes it for the member, whose next click says why', async () => {
  const s = await scenario();
  const { A, E } = s;
  await E.api.signups.save(s.gid, s.rid, { kind: 'signed' });
  const page = await openRaid(s, A);
  let html = page();
  let text = stripTags(html);
  assert(/Add a sign-up/.test(text) && /Close sign-ups/.test(text), text.slice(0, 500));
  assert(/data-action="su-edit" data-pid="/.test(html) && /data-action="su-remove"/.test(html));
  assert(!/id="su-me-h"/.test(html), 'the Guild Master has no character, so no sign-up of their own');
  assert(/Thoren/.test(text) && /Tanks 1/.test(text));

  // Edit Kaelith (no sign-up yet): the dialog lists the roster; the form submit makes him Bench.
  const kaelith = s.people.Kaelith;
  A.handlers.click['su-edit'](el({ 'data-pid': kaelith }));
  assert.equal(A.dialogs.length, 1);
  assert(/Change a sign-up/.test(A.dialogs[0]) && /Kaelith \(Rogue\)/.test(A.dialogs[0]) && /<option value="Combat" selected>/.test(A.dialogs[0]), A.dialogs[0].slice(0, 500));
  const kaelithChar = (await rows(s.world, "SELECT id FROM characters WHERE name = 'Kaelith'"))[0].id;
  await A.handlers.submit['su-edit-form']({ elements: { person: { value: kaelith }, kind: { value: 'bench' }, character: { value: kaelithChar }, spec: { value: 'Combat' }, note: { value: 'standby' } } });
  text = stripTags(page());
  assert(/Bench 1/.test(text) && /Kaelith/.test(text) && /standby/.test(text), text);
  assert.equal((await rows(s.world, "SELECT kind, updated_by FROM raid_signups WHERE player_id = ?", kaelith))[0].kind, 'bench');

  // Add Mirabel through the Add dialog (the first person of the roster is not her: the dialog's person select picks).
  A.handlers.click['su-add'](el({}));
  assert(/Add a sign-up/.test(A.dialogs[1]) && /id="su-d-person"/.test(A.dialogs[1]) && /Mirabel/.test(A.dialogs[1]));
  const mirabelChar = (await rows(s.world, "SELECT id FROM characters WHERE name = 'Mirabel'"))[0].id;
  await A.handlers.submit['su-edit-form']({ elements: { person: { value: s.people.Mirabel }, kind: { value: 'signed' }, character: { value: mirabelChar }, spec: { value: '' }, note: { value: '' } } });
  assert(/Ranged 1/.test(stripTags(page())));
  assert.equal((await rows(s.world, "SELECT spec_name FROM raid_signups WHERE player_id = ?", s.people.Mirabel))[0].spec_name, null, 'no spec chosen = none');

  // Remove asks, then does it.
  A.handlers.click['su-remove'](el({ 'data-pid': kaelith }));
  assert(/Remove this sign-up\?/.test(A.dialogs[2]) && /Kaelith/.test(A.dialogs[2]));
  await A.handlers.submit['su-remove-form'](el({}, { getAttribute: (k) => (k === 'data-pid' ? kaelith : null) }));
  assert(!/Kaelith/.test(stripTags(page())));

  // Close sign-ups: the member's page, built from the Worker's answer, is closed; their next click is a 409 with the reason.
  await A.handlers.click['su-lock'](el({ 'data-lock': '1' }));
  html = page();
  assert(/Reopen sign-ups/.test(stripTags(html)) && /Closed by an officer/.test(html));
  const memberPage = await openRaid(s, E);
  const mText = stripTags(memberPage());
  assert(/Closed by an officer/.test(mText) && /An officer has closed sign-ups\./.test(mText));
  assert(/data-kind="signed"[^>]*disabled/.test(memberPage()), 'the buttons are disabled');
  // A page that was open before the lock: its click reaches the Worker, which says why not; the panel then shows the closed state.
  await s.world.db.prepare('UPDATE raids SET signups_locked = 0 WHERE id = ?').bind(s.rid).run();
  const stale = await openRaid(s, E);
  await s.world.db.prepare('UPDATE raids SET signups_locked = 1 WHERE id = ?').bind(s.rid).run();
  await E.handlers.click['su-kind'](el({ 'data-kind': 'late' }));
  const x = E.app.state.att.raidSignups;
  assert.equal(x.ui.error, 'An officer has closed sign-ups for this raid. Ask an officer.');
  assert.equal(x.data.raid.closed, 'locked');
  assert(/An officer has closed sign-ups\./.test(stripTags(stale())));
  await A.handlers.click['su-lock'](el({ 'data-lock': '0' }));
  assert(/Close sign-ups/.test(stripTags(await openRaid(s, A).then((p) => p()))));
});

check('members see the list of their own team only; a member with no character gets the sentence and no buttons', async () => {
  const s = await scenario();
  const { H, E } = s;
  await E.api.signups.save(s.gid, s.rid, { kind: 'tentative' });
  const hankPage = await openRaid(s, H);
  const text = stripTags(hankPage());
  assert(/Sign-ups are visible to the team's members\./.test(text), text.slice(0, 500));
  assert(!/Thoren|Tentative 1|data-kind/.test(text + hankPage()), 'nothing of the list, no buttons');
  const erinText = stripTags((await openRaid(s, E).then((p) => p())));
  assert(/Tentative 1/.test(erinText) && /Thoren/.test(erinText));
});

check('Raids list: a member sees Your sign-up with a Sign up button that is one real request; the chip then names the character; a member with no character sees neither', async () => {
  const s = await scenario();
  const { E, H, A } = s;
  pageState(s, E);
  const route = { name: 'section', gid: s.gid, section: 'raids' };
  await E.pages.raids.load(route, E.guildData);
  let html = E.pages.raids.main(route, E.guildData);
  assert(/Your sign-up/.test(html) && /data-action="raids-signup"/.test(html), 'the table has the column and the button');
  assert(/No sign-ups yet/.test(stripTags(html)));
  await E.handlers.click['raids-signup'](el({ 'data-rid': s.rid }));
  html = E.pages.raids.main(route, E.guildData);
  const text = stripTags(html);
  assert(/Signed up - Thoren/.test(text), text);
  assert(/1 \/ \d+ signed up/.test(text), 'the counts follow the answer, against the raid size');
  assert(!/data-action="raids-signup"/.test(html), 'signed up: no button');
  assert.equal(await s.world.db.prepare("SELECT COUNT(*) AS n FROM raid_signups WHERE source = 'raidsmith'").first('n'), 1);
  // Hank: no column, no counts.
  pageState(s, H);
  await H.pages.raids.load(route, H.guildData);
  const hank = H.pages.raids.main(route, H.guildData);
  assert(!/Your sign-up|raids-signup/.test(hank), 'a member with no character cannot sign up');
  // The officer sees the sign-up count and Raid schedule, and no sign-up column of their own.
  pageState(s, A);
  await A.pages.raids.load(route, A.guildData);
  const officer = A.pages.raids.main(route, A.guildData);
  assert(/1 \/ \d+ signed up/.test(stripTags(officer)) && /Raid schedule/.test(stripTags(officer)) && !/Your sign-up/.test(officer));
  // Locked: the list says so.
  await A.api.signups.lock(s.gid, s.rid, true);
  pageState(s, E);
  await E.pages.raids.load(route, E.guildData);
  const locked = E.pages.raids.main(route, E.guildData);
  assert(!/raids-signup/.test(locked) && /Signed up - Thoren/.test(stripTags(locked)));
});

check('schedule: Settings > Raid schedule saves slots with the real validation and fills the raids; the Raids page shows them and fills by itself when the team says so', async () => {
  const s = await scenario();
  const { A } = s;
  pageState(s, A);
  const route = { name: 'settings', gid: s.gid, tab: 'schedule' };
  await A.pages.settingsSchedule.load(route, A.guildData);
  const ctxShell = { guildData: A.guildData };
  let html = A.pages.settingsSchedule.main(route, A.guildData, ctxShell);
  assert(/No weekly slots yet\./.test(stripTags(html)) && /America\/New_York/.test(html));
  assert(/Raid schedule/.test(html), 'the tab is in the strip');
  // Two slots, built with the page's own handlers.
  A.handlers.click['sched-add'](el({}));
  A.handlers.click['sched-add'](el({}));
  const draft = A.app.state.att.settingsSchedule.draft;
  assert.deepEqual(draft.slots.map((x) => x.weekday), [1, 2], 'Tuesday first (the US reset), then the first free day');
  A.handlers.change['sched-field'](el({ 'data-idx': '1', 'data-field': 'zone' }, { value: 'Karazhan' }));
  A.handlers.input['sched-field'](el({ 'data-idx': '1', 'data-field': 'title' }, { value: 'Prog' }));
  A.handlers.input['sched-field'](el({ 'data-idx': '0', 'data-field': 'startTime' }, { value: '19:30' }));
  A.handlers.change['sched-weeks'](el({}, { value: '3' }));
  await A.handlers.submit['sched-form']();
  const sc = A.app.state.att.settingsSchedule;
  assert.equal(sc.note, '', 'the page head says Saved at; there is no banner');
  assert.equal(A.app.state.settingsSaved && A.app.state.settingsSaved.tab, 'schedule');
  assert.deepEqual(sc.data.slots.map((x) => [x.weekday, x.startTime, x.zone, x.title]), [[1, '19:30', null, null], [2, '20:00', 'Karazhan', 'Prog']]);
  assert.equal(sc.data.weeks, 3);
  // The Worker's own refusal reaches the page naming the slot.
  A.app.state.att.settingsSchedule.draft.slots[0].startTime = '25:00';
  await A.handlers.submit['sched-form']();
  assert(/^Slot 1: enter a start time/.test(A.app.state.att.settingsSchedule.error), A.app.state.att.settingsSchedule.error);
  A.app.state.att.settingsSchedule.draft.slots[0].startTime = '19:30';
  A.app.state.att.settingsSchedule.error = '';
  // Create upcoming raids now: Monday Oct 19, Tuesday Oct 20, Monday Oct 26, Tuesday Oct 27, Monday Nov 2, Tuesday Nov 3 (3 weeks from Saturday Oct 17).
  await A.handlers.click['sched-fill'](el({}));
  assert.match(A.app.state.att.settingsSchedule.note, /^Created 6 upcoming raids: Oct 19, Oct 20, Oct 26, Oct 27, Nov 2, Nov 3\./);
  const made = await rows(s.world, 'SELECT raid_on, starts_at, zone, title FROM raids ORDER BY raid_on');
  assert.deepEqual(made.map((r) => r.raid_on), ['2026-10-19', '2026-10-20', '2026-10-24', '2026-10-26', '2026-10-27', '2026-11-02', '2026-11-03']);
  assert.equal(made[0].starts_at, Date.parse('2026-10-19T23:30:00Z'), '19:30 New York in October is 23:30Z');
  assert.equal(made[1].starts_at, Date.parse('2026-10-21T00:00:00Z'));
  assert.deepEqual([made[1].zone, made[1].title], ['Karazhan', 'Prog']);
  assert.equal(made[5].starts_at, Date.parse('2026-11-03T00:30:00Z'), 'Monday Nov 2 19:30 is EST after the clocks changed on Nov 1');
  // The Raids page lists them, soonest first, and the list says the schedule has slots.
  const list = { name: 'section', gid: s.gid, section: 'raids' };
  pageState(s, A);
  await A.pages.raids.load(list, A.guildData);
  const listHtml = A.pages.raids.main(list, A.guildData);
  assert(/Create upcoming raids/.test(listHtml) && /Upcoming <span class="gs-seg-count">7<\/span>/.test(listHtml));
  assert(/Mon, Oct 19, 7:30 PM|Mon Oct 19, 7:30 PM/.test(stripTags(listHtml)), stripTags(listHtml).slice(0, 600));
  // Again: nothing new. The button on the Raids page says so.
  await A.handlers.click['raids-fill'](el({}));
  assert.equal(A.app.state.att.raids.note, 'Nothing new to create: the next 3 weeks already have their raids.');
  // By itself: turn it on, move the clock a week on, open Raids.
  A.app.state.att.settingsSchedule = null;
  pageState(s, A);
  await A.pages.settingsSchedule.load(route, A.guildData);
  A.handlers.change['sched-auto'](el({}, { checked: true }));
  await A.handlers.submit['sched-form']();
  assert.equal(A.app.state.att.settingsSchedule.data.auto, true);
  s.world.clock.now = Date.parse('2026-10-24T16:00:00Z');
  pageState(s, A);
  await A.pages.raids.load(list, A.guildData);
  assert.match(A.app.state.att.raids.note, /^Created 2 upcoming raids: Nov 9, Nov 10\./);
  assert.equal(await s.world.db.prepare('SELECT COUNT(*) AS n FROM raids').first('n'), 9);
  await A.pages.raids.load(list, A.guildData);
  assert.equal(A.app.state.att.raids.note, '', 'once a day per browser session');
});

check('schedule: a Team Lead (no Guild settings item) edits their own team\'s schedule; a member is refused with the Worker\'s 403', async () => {
  const s = await scenario();
  const { A, H } = s;
  const hankId = (await H.api.get('/auth/me')).user.id;
  await A.api.put(`${s.base}/people/${hankId}/roles`, { officer: false, teamLeadTeamIds: [s.teamId] });
  H.guildData = await H.api.get(s.base);
  assert.deepEqual(H.guildData.me.can['raids.edit'], [s.teamId], 'Hank leads the team now');
  assert.deepEqual(plain(H.shell.settingsTabs(H.guildData.me.can).map((t) => t.tab)), ['schedule']);
  assert.equal(H.shell.canSeeSettings(H.guildData.me.can), false, 'no Guild settings item');
  pageState(s, H);
  await H.pages.settingsSchedule.load({ name: 'settings', gid: s.gid, tab: 'schedule' }, H.guildData);
  const leadPage = stripTags(H.pages.settingsSchedule.main({ name: 'settings', tab: 'schedule' }, H.guildData, { guildData: H.guildData }));
  assert(/Raid schedule/.test(leadPage) && /No weekly slots yet\./.test(leadPage));
  // A plain member: the page has no team to offer (403), and the Worker refuses a save sent anyway.
  const E = s.E;
  pageState(s, E);
  await assert.rejects(() => E.pages.settingsSchedule.load({ name: 'settings', tab: 'schedule' }, E.guildData), (e) => e.status === 403);
  const refused = await E.api.signups.saveSchedule(s.gid, s.teamId, { slots: [] }).then(() => null, (e) => e);
  assert(refused && refused.status === 403 && refused.code === 'forbidden');
});

check('event on another day: the real pages ask with the Worker\'s dates; Cancel leaves the raid alone, Move raid moves its day and time, and a day the team already has a raid on is refused in words', async () => {
  const s = await scenario();
  const { A, world } = s;
  const eventId = '666666666666666666';
  const setEvent = (iso) => world.events.set(eventId, { id: eventId, title: 'Black Temple', serverId: SERVER, startTime: Date.parse(iso) / 1000, signUps: [] });
  const raidRow = async () => (await rows(world, 'SELECT raid_on, starts_at, event_id FROM raids WHERE id = ?', s.rid))[0];
  const until = async (test) => { for (let i = 0; i < 400 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); assert(test(), 'timed out waiting'); };
  // The dialog shell needs a DOM: a fake dialog keeps the close listener (Cancel / Escape), the form's own submit is Move raid.
  const closers = [];
  A.dialogs.length = 0;
  A.ui.openDialog = (html) => { A.dialogs.push(html); return { addEventListener: (type, fn) => { if (type === 'close') closers.push(fn); } }; };
  const cancel = () => { while (closers.length) closers.shift()(); };
  const errors = [];
  A.app.handleError = (err) => errors.push(err);

  // Link an event that is on Tuesday 2026-10-27 to the raid of Saturday 2026-10-24: the link dialog's submit asks.
  setEvent('2026-10-28T00:00:00Z'); // 20:00 New York
  await openRaid(s, A);
  const form = { elements: { source: { value: eventId, focus() {} }, confirm: { value: '0' } }, closest: () => null, querySelectorAll: () => [] };
  A.handlers.submit['event-form'](form);
  await until(() => A.dialogs.length === 1);
  assert(stripTags(A.dialogs[0]).includes('This event is on Tue Oct 27, the raid is on Sat Oct 24. Move the raid to Tue Oct 27?'), stripTags(A.dialogs[0]));
  assert.deepEqual(await raidRow(), { raid_on: RAID_ON, starts_at: Date.parse('2026-10-25T00:00:00Z'), event_id: null }, 'asked, nothing written');
  cancel();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await raidRow(), { raid_on: RAID_ON, starts_at: Date.parse('2026-10-25T00:00:00Z'), event_id: null }, 'Cancel leaves the raid alone');
  assert.equal(A.app.state.att.raid.data.raid.raidOn, RAID_ON);

  A.handlers.submit['event-form'](form);
  await until(() => A.dialogs.length === 2);
  A.handlers.submit['raid-move-form']({ closest: () => null });
  await until(() => A.app.state.att.raid.data.raid.raidOn === '2026-10-27');
  assert.deepEqual(await raidRow(), { raid_on: '2026-10-27', starts_at: Date.parse('2026-10-28T00:00:00Z'), event_id: eventId }, 'the day AND the time moved');
  const detail = A.app.state.att.raid.data;
  assert.deepEqual([detail.raid.startsAt, detail.raid.upcoming, detail.sources.event.id], [Date.parse('2026-10-28T00:00:00Z'), true, eventId]);

  // The Raids list: the event moved again, to Friday; Refresh sign-ups asks and the list shows the new day.
  setEvent('2026-10-31T00:00:00Z'); // Fri 2026-10-30 20:00 New York
  pageState(s, A);
  await A.pages.raids.load({ name: 'section', section: 'raids', gid: s.gid }, A.guildData);
  const x = A.app.state.att.raids;
  assert.deepEqual(x.data.upcoming.map((r) => [r.id, r.raidOn]), [[s.rid, '2026-10-27']]);
  const refresh = el({ 'data-rid': s.rid });
  A.handlers.click['raids-refresh'](refresh);
  await until(() => A.dialogs.length === 3);
  assert(stripTags(A.dialogs[2]).includes('This event is on Fri Oct 30, the raid is on Tue Oct 27. Move the raid to Fri Oct 30?'), stripTags(A.dialogs[2]));
  A.handlers.submit['raid-move-form']({ closest: () => null });
  await until(() => x.data.upcoming[0].raidOn === '2026-10-30');
  assert.equal(x.note, 'Moved the raid to Fri Oct 30.');
  assert.equal((await raidRow()).raid_on, '2026-10-30');

  // The team has a raid on 2026-11-06 already: moving there is refused, and the page says which day.
  await A.api.post(s.base + '/raids', { teamId: s.teamId, raidOn: '2026-11-06', startTime: '20:00' });
  setEvent('2026-11-07T01:00:00Z'); // Fri 2026-11-06 20:00 New York
  refresh.disabled = false;
  A.handlers.click['raids-refresh'](refresh);
  await until(() => A.dialogs.length === 4);
  A.handlers.submit['raid-move-form']({ closest: () => null });
  await until(() => errors.length === 1);
  assert.deepEqual([errors[0].code, errors[0].message], ['raid_date_taken', 'This team already has a raid on Fri Nov 6, so this raid cannot move there.']);
  assert.equal((await raidRow()).raid_on, '2026-10-30', 'the raid stayed where it was');
  assert.equal(refresh.disabled, false, 'the button is back');
});

check('Planner: the Worker\'s seed, read by the Planner\'s own Raid-Helper code, gives each Raidsmith sign-up the class, spec, role and status it was made with', async () => {
  const s = await scenario();
  const { A, E } = s;
  await E.api.signups.save(s.gid, s.rid, { kind: 'signed' });                                 // Thoren, Protection: a tank
  await A.api.signups.savePerson(s.gid, s.rid, s.people.Kaelith, { kind: 'late', spec: 'Subtlety' });
  await A.api.signups.savePerson(s.gid, s.rid, s.people.Mirabel, { kind: 'bench' });
  const seed = await A.api.get(`${s.base}/raids/${s.rid}/planner`);
  assert.deepEqual(seed.signups.map((x) => x.name), ['Thoren', 'Kaelith', 'Mirabel']);
  const ctx = planner.sandbox(['Import', 'RaidLink', 'Config']);
  const json = ctx.api.RaidLink.seedToRaidHelper(seed);
  const entries = ctx.api.Import.parseRaidHelperSignUps(JSON.parse(json)).entries;
  const by = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual([by.Thoren.class, by.Thoren.spec, by.Thoren.role, by.Thoren.status, by.Thoren.category], ['PALADIN', 'Protection', 'tank', 'confirmed', 'raider']);
  assert.deepEqual([by.Kaelith.class, by.Kaelith.spec, by.Kaelith.status, by.Kaelith.category], ['ROGUE', 'Subtlety', 'late', 'bench']);
  assert.deepEqual([by.Mirabel.class, by.Mirabel.spec, by.Mirabel.status, by.Mirabel.category], ['HUNTER', 'Marksmanship', 'bench', 'bench']);
  assert(entries.every((e) => !e.needsReview), 'nothing was guessed: the Worker sent the Raid-Helper words');
});

// ---------------------------------------------------------------------------

(async () => {
  const filter = process.argv[2] || '';
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split('\n').slice(0, 14).join('\n      ')}`);
    }
  }
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
