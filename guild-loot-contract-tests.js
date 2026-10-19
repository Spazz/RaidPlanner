/**
 * Raidsmith guild tracker - Phase 4 loot CONTRACT tests (Worker <-> pages)
 * Run: node guild-loot-contract-tests.js [name-filter]
 *
 * The Worker suite (guild-loot-worker-tests.js) and the pages suite (guild-loot-ui-tests.js) each work from the contract in
 * tasks/guild-phase4-spec.md, with hand-made data on the other side. This suite joins them: the real pages (tests/guild-scripts.js in
 * a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in) through G.api, and what the pages draw from
 * the real answers is checked. A field one side names differently, nests differently or leaves out shows up here as a missing name, a
 * blank cell or a thrown error. Discord is faked by an injected fetch; no network, no Wrangler, no credentials.
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
const ALICE = { id: '110000000000000001', username: 'alice', globalName: 'Alice A' };
const ERIN = { id: '110000000000000005', username: 'erin', globalName: 'Erin E' };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// The Worker side: one app over one D1, a cookie jar per signed-in person

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
  const clock = { now: Date.parse('2026-10-20T16:00:00Z') }; // ten days after the raid, inside every attendance window
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
// Scenario: Alice (Guild Master) runs the guild, Erin (Member) is linked to Thoren. One past raid; the Gargul fixture holds 14 awards
// (13 with a winner and one disenchant), 8 of them from the raid's own night.

const FIXTURE = read('tests/fixtures/gargul-detailed-sample.json').replace(/-Ashmere/g, '-Nightslayer');
const GUILD_BODY = { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };
const RAID_ON = '2026-10-10';

async function scenario() {
  const world = await makeWorld();
  const jar = await signIn(world, ALICE, [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }]);
  const G = loadPages(world, jar);
  const created = await G.api.post('/api/guild', GUILD_BODY);
  const gid = created.guild.id;
  const teamId = created.teams[0].id;
  const base = `/api/guild/${gid}`;
  const people = {};
  for (const [name, cls] of [['Thoren', 'PALADIN'], ['Kaelith', 'ROGUE'], ['Mirabel', 'HUNTER']]) {
    const made = await G.api.post(`${base}/roster`, { teamId, name, class: cls, mainSpec: null, offSpec: null, status: 'raider' });
    people[name] = made.person.id;
  }
  const raid = (await G.api.post(`${base}/raids`, { teamId, raidOn: RAID_ON })).raid.id;
  await G.api.put(`${base}/raids/${raid}/manual`, { reason: 'No log kept', presentPlayerIds: Object.values(people) });
  // Erin is the member behind Thoren.
  world.db.sqlite.exec(`UPDATE players SET discord_user_id = '${ERIN.id}' WHERE id = '${people.Thoren}'`);
  const memberJar = await signIn(world, ERIN, [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }]);
  const guildData = await G.api.get(base);
  const parsed = G.gargul.parse(FIXTURE);
  assert(parsed.ok && parsed.awards.length === 14, 'the fixture parses to 14 awards (one is a disenchant)');
  return { world, jar, memberJar, G, gid, teamId, base, people, raid, guildData, parsed, awards: plain(parsed.awards) };
}

// Imports the 8 awards of the raid's own night (the other 6, the disenchant among them, are the next day's), as the page does.
async function importNight(s, include = false) {
  return s.G.api.loot.commit(s.gid, s.raid, s.awards, include);
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// The state bag the pages keep, reset for a fresh render.
function pageState(s, G, gd) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: gd };
  S.currentGid = s.gid;
  S.pageAlert = '';
  G.app.teamFor = () => s.teamId;
  return S;
}

// ---------------------------------------------------------------------------

check('import: the pages\' parsed awards go through preview and commit; the preview rows and the result carry what the panel reads', async () => {
  const s = await scenario();
  const { G } = s;
  const preview = await G.api.loot.preview(s.gid, s.raid, s.awards);
  assert.deepEqual(Object.keys(preview.counts).sort(), ['conflict', 'deleted', 'new', 'otherDay', 'otherRaid', 'same', 'update']);
  assert.equal(preview.counts.new, 8);
  assert.equal(preview.counts.otherDay, 6);
  assert.equal(preview.rows.length, 14);
  for (const row of preview.rows) {
    for (const key of ['checksum', 'itemId', 'itemName', 'quality', 'awardedAt', 'winnerName', 'winnerRealm', 'winnerClass', 'disenchanted', 'rollType', 'flags', 'status', 'match', 'tag']) assert(key in row, `preview row has ${key}`);
    assert(['character', 'guest', 'unmatched', 'disenchanted'].includes(row.match.kind));
  }
  const deRow = preview.rows.filter((row) => row.disenchanted);
  assert.equal(deRow.length, 1, 'the ||de|| row of the fixture reaches the Worker as an award');
  assert.deepEqual([deRow[0].match, deRow[0].tag, deRow[0].winnerName, deRow[0].status], [{ kind: 'disenchanted' }, 'DE', null, 'otherDay']);
  // The panel's own render of that answer: every winner is named, every row has its status chip.
  const gd = s.guildData;
  const ui = Object.assign(G.pages.raidLoot.freshUi(), { stage: 'preview', parsed: s.parsed, preview });
  const html = G.pages.raidLoot.importPanelHtml(ui, gd);
  const text = stripTags(html);
  for (const name of ['Thoren', 'Kaelith', 'Mirabel', 'Dorrin', 'Tarn']) assert(text.includes(name), `the preview names ${name}`);
  assert(/Import 8 awards/.test(text), 'the commit button counts the new awards');
  assert(/Include 6 awards from other days/.test(text));
  assert(/Disenchanted/.test(text), 'the preview names the disenchant');
  const committed = await importNight(s);
  assert.deepEqual([committed.inserted, committed.updated, committed.unchanged, committed.skippedOtherRaid, committed.skippedOtherDay], [8, 0, 0, 0, 6]);
  assert.equal(G.pages.raidLoot.resultLine(committed), 'Imported 8 new awards. 6 awards from other days were left out.');
  assert(Array.isArray(committed.awards) && committed.awards.length === 8);
  const again = await importNight(s, true);
  assert.deepEqual([again.inserted, again.unchanged], [6, 8]);
  assert.equal(again.awards.filter((award) => award.match.kind === 'disenchanted').length, 1);
});

check('import: a bad award is a 400 naming the award (field "awards", index) and the page words it as a row of the paste; an upcoming raid is 409 raid_not_started', async () => {
  const s = await scenario();
  const { G } = s;
  const bad = plain(s.awards);
  bad[3].itemId = 0;
  let error = null;
  try { await G.api.loot.preview(s.gid, s.raid, bad); } catch (e) { error = e; }
  assert(error && error.status === 400, 'a bad item id is refused');
  assert.equal(error.field, 'awards');
  assert.equal(error.index, 3);
  const message = G.pages.raidLoot.describeError(error, s.parsed);
  assert(/^Row \d+ of the paste \(/.test(message) && !/Award 4:/.test(message), message);
  const future = (await G.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn: '2027-03-01' })).raid.id;
  error = null;
  try { await G.api.loot.commit(s.gid, future, s.awards, false); } catch (e) { error = e; }
  assert(error && error.status === 409 && error.code === 'raid_not_started', 'an upcoming raid takes no loot');
});

check('raid loot card: GET /raids/:rid/loot draws every winner by name (person, guest, not on roster), the tag select for an editor, and the review hint', async () => {
  const s = await scenario();
  const { G } = s;
  await importNight(s, true);
  const S = pageState(s, G, s.guildData);
  const detail = await G.api.get(`${s.base}/raids/${s.raid}`);
  assert.equal(detail.raid.upcoming, false);
  await G.pages.raidLoot.loadFor(s.guildData, detail);
  const state = G.pages.raidLoot.stateFor(s.gid, s.raid);
  assert(state && state.status === 'ok', 'the card loaded');
  assert.equal(state.data.canEdit, true);
  const html = G.pages.raidLoot.cardHtml({ guildData: s.guildData, data: detail, state });
  const text = stripTags(html);
  for (const name of ['Thoren', 'Kaelith', 'Mirabel', 'Dorrin', 'Veyla', 'Brogan', 'Sylwen', 'Ruvik', 'Ysolde', 'Tarn', 'Nimue']) assert(text.includes(name), `the card names ${name}`);
  assert(/data-change="loot-tag"/.test(html), 'an editor gets the tag select');
  assert(/Review queue/.test(text), 'the card points at the review queue');
  const offRoster = state.data.awards.filter((award) => award.match.kind === 'unmatched').length;
  const noted = /(\d+) awards? go(?:es)? to a winner who is not on the roster/.exec(text);
  assert(noted && Number(noted[1]) === offRoster && state.data.awards.some((award) => award.match.kind === 'disenchanted'), 'the disenchant has no winner, so it is not one of the winners off the roster');
  const rowOf = (needle) => html.split('<li class="gs-loot-row"').filter((row) => row.includes(needle));
  const deRows = rowOf('<span class="gs-muted">Disenchanted</span>');   // the tag selects also say Disenchanted, as an option
  assert.equal(deRows.length, 1);
  assert(!/data-change="loot-tag"/.test(deRows[0]) && />DE</.test(deRows[0]) && /loot-delete/.test(deRows[0]), 'no tag select on a disenchant, the chip and the delete button stay');
  assert(!/null|undefined/.test(text), 'nothing reads null or undefined');
  assert(S.att.raidLoot === state, 'the state sits in the attendance bag');
});

check('tag, note, delete: PATCH answers { award }, DELETE { ok }; the row shows the officer tag and the note', async () => {
  const s = await scenario();
  const { G } = s;
  const committed = await importNight(s);
  const first = committed.awards.find((award) => award.itemName === 'Nathrezim Mindblade');
  const tagged = await G.api.loot.update(s.gid, first.id, { tag: 'DE' });
  assert.equal(tagged.award.tag, 'DE');
  assert.equal(tagged.award.tagSetBy, 'officer');
  const noted = await G.api.loot.update(s.gid, first.id, { note: 'Went to the bank' });
  assert.equal(noted.award.note, 'Went to the bank');
  assert.equal(noted.award.tag, 'DE', 'a note leaves the tag alone');
  const row = stripTags(G.pages.loot.awardRowHtml(s.guildData, noted.award, { edit: false }));
  assert(/Nathrezim Mindblade/.test(row) && /Note: Went to the bank/.test(row) && /set by an officer/.test(row), row);
  const gone = await G.api.loot.remove(s.gid, first.id);
  assert.deepEqual(gone, { ok: true });
  const left = await G.api.loot.raid(s.gid, s.raid);
  assert.equal(left.awards.length, 7);
});

check('balance: GET /loot/balance draws one row per person with raids, MS, OS, counted, per raid and vs team; the window switch reads the server\'s weeks', async () => {
  const s = await scenario();
  const { G } = s;
  await importNight(s);
  pageState(s, G, s.guildData);
  const view = { name: 'section', gid: s.gid, section: 'loot' };
  await G.pages.loot.load(view, s.guildData);
  const x = G.app.state.att.loot;
  assert(x && x.data && !x.denied, 'the balance loaded');
  assert.equal(x.data.scope, 'team');
  assert.deepEqual(x.data.window.switchWeeks.length > 0, true);
  const html = G.pages.loot.main(view, s.guildData);
  const text = stripTags(html);
  for (const name of ['Thoren', 'Kaelith', 'Mirabel']) assert(text.includes(name), `the balance lists ${name}`);
  assert(/Team average per raid/.test(text));
  assert(/Last \d+ full reset weeks since/.test(text), 'the window line');
  const rows = G.pages.loot.balanceRows(x.data, 'window');
  const thoren = rows.find((row) => row.name === 'Thoren');
  assert.equal(thoren.raids, 1);
  assert.equal(thoren.ms, 1);
  assert.equal(thoren.counted, 1);
  assert.equal(thoren.perRaid, 1);
  assert(thoren.vs !== null, 'vs team is a number');
  // A week count the server offers is accepted by the server.
  const weeks = x.data.window.switchWeeks[x.data.window.switchWeeks.length - 1];
  const other = await G.api.loot.balance(s.gid, s.teamId, weeks);
  assert.equal(other.window.weeks, weeks);
});

check('by raid and by item: the lists name every winner, also the ones not on the roster and the guests', async () => {
  const s = await scenario();
  const { G } = s;
  await importNight(s, true);
  pageState(s, G, s.guildData);
  const guest = await G.api.post(`${s.base}/raids/${s.raid}/unmatched`, { key: 'dorrin|nightslayer', action: 'guest' });
  assert(guest.raid, 'Dorrin is marked a guest');
  await G.pages.loot.load({ name: 'section', gid: s.gid, section: 'loot', view: 'raids' }, s.guildData);
  const raidsText = stripTags(G.pages.loot.main({ name: 'section', gid: s.gid, section: 'loot', view: 'raids' }, s.guildData));
  assert(/14/.test(raidsText) && /winners? not on the roster/.test(raidsText), raidsText);
  assert(/Disenchanted/.test(raidsText), 'the By raid table has a Disenchanted column');
  const raidsRow = (await G.api.loot.raids(s.gid, s.teamId)).raids[0];
  assert.deepEqual([raidsRow.awards, raidsRow.disenchanted], [14, 1]);
  await G.pages.loot.load({ name: 'section', gid: s.gid, section: 'loot', view: 'items' }, s.guildData);
  const itemsHtml = G.pages.loot.main({ name: 'section', gid: s.gid, section: 'loot', view: 'items' }, s.guildData);
  const names = [...itemsHtml.matchAll(/<li class="gs-loot-subrow">([\s\S]*?)<\/li>/g)].map((m) => stripTags(m[1]));
  assert.equal(names.length, 14, 'every award is listed under its item');
  assert(names.some((line) => /Disenchanted/.test(line) && /DE/.test(line)), 'the disenchant is named as one');
  assert(names.every((line) => !/null|undefined/.test(line)));
  // Every sub-row names its winner: a person, a guest or a name the roster does not know.
  for (const name of ['Dorrin', 'Veyla', 'Brogan', 'Ruvik', 'Ysolde', 'Tarn', 'Nimue']) {
    assert(names.some((line) => line.includes(name)), `the by-item list names ${name}`);
  }
  assert(names.some((line) => /Guest/.test(line) && line.includes('Dorrin')), 'a guest keeps his name next to the Guest chip');
});

check('person loot: GET /loot/person/:pid draws the page grouped by raid and the card on the roster record', async () => {
  const s = await scenario();
  const { G } = s;
  await importNight(s, true);
  pageState(s, G, s.guildData);
  const pid = s.people.Thoren;
  await G.pages.personLoot.load({ name: 'lootperson', gid: s.gid, pid }, s.guildData);
  const html = G.pages.personLoot.main({ name: 'lootperson', gid: s.gid, pid }, s.guildData);
  const text = stripTags(html);
  assert(/Thoren/.test(text) && /Nathrezim Mindblade/.test(text) && /Warp Slicer/.test(text), text);
  assert.equal(G.pages.personLoot.nameFor({ pid }), 'Thoren');
  await G.pages.personLoot.loadCard(s.gid, pid);
  const record = await G.api.get(`${s.base}/roster/${pid}`);
  const card = stripTags(G.pages.personLoot.cardFor(s.guildData, record, pid));
  assert(/Nathrezim Mindblade/.test(card) && /All loot/.test(card), card);
  const section = G.pages.personLoot.sectionFor(s.guildData, record, pid);
  assert(/^MS \d+ &middot; OS \d+ &middot; DE \d+ &middot; Bank \d+$/.test(section.metaHtml), section.metaHtml);
});

check('loot policy: GET / PUT /loot/policy round-trip through the settings page helpers; a stale version is a 409 carrying the current view', async () => {
  const s = await scenario();
  const { G } = s;
  const view = await G.api.loot.policy(s.gid);
  for (const key of ['defaults', 'guild', 'teams', 'resolved', 'versions']) assert(key in view, `policy view has ${key}`);
  const Sa = G.pages.settingsAtt;
  assert.equal(Sa.versionFor(view, 'guild'), 0);
  assert.deepEqual(plain(Sa.effective(view, 'guild', {}, 'balance.countTags').value), ['MS']);
  const saved = await G.api.loot.savePolicy(s.gid, null, { visibility: { members: 'guild' }, balance: { countTags: ['MS', 'OS'] } }, 0);
  assert.equal(saved.versions.guild, 1);
  assert.deepEqual(plain(Sa.overrideFor(saved, 'guild')), { visibility: { members: 'guild' }, balance: { countTags: ['MS', 'OS'] } });
  const team = await G.api.loot.savePolicy(s.gid, s.teamId, { balance: { mode: 'count' } }, 0);
  assert.equal(Sa.versionFor(team, s.teamId), 1);
  assert.equal(team.resolved[s.teamId].balance.mode, 'count');
  let error = null;
  try { await G.api.loot.savePolicy(s.gid, null, {}, 0); } catch (e) { error = e; }
  assert(error && error.status === 409 && error.code === 'stale', 'a stale version is refused');
  assert(error.body.current && error.body.current.defaults && error.body.current.versions, 'the refusal carries the current view the page adopts');
  error = null;
  try { await G.api.loot.savePolicy(s.gid, null, { balance: { countTags: [] } }, 1); } catch (e) { error = e; }
  assert(error && error.status === 400 && error.field === 'balance.countTags', 'an empty tag list names its field');
  const html = G.pages.settingsLoot.settingsHtml({ guildData: s.guildData, s: { view: team, scope: s.teamId, draft: Sa.overrideFor(team, s.teamId) } });
  assert(/Overridden/.test(html) && /Inherited/.test(html), 'the team scope marks overridden and inherited keys');
});

check('review queue: loot winners nobody matches arrive as lootUnmatched; Link / Add as new person / Mark as guest act on them and the raid loot follows', async () => {
  const s = await scenario();
  const { G } = s;
  await importNight(s, true);
  pageState(s, G, s.guildData);
  const review = await G.api.get(`${s.base}/attendance/review?team=${encodeURIComponent(s.teamId)}`);
  assert(Array.isArray(review.lootUnmatched) && review.lootUnmatched.length === 1, 'one raid has loot winners to link');
  const group = review.lootUnmatched[0];
  assert.deepEqual(Object.keys(group.raid).sort(), ['id', 'raidOn', 'zone']);
  assert(group.items.every((item) => typeof item.name === 'string' && item.name.length > 1), 'the disenchant (no winner) is not a loot winner to link');
  const veyla = group.items.find((item) => item.name === 'Veyla');
  assert.deepEqual(Object.keys(veyla).sort(), ['awards', 'class', 'key', 'kind', 'name', 'realm']);
  const html = G.pages.review.reviewHtml({ guildData: s.guildData, teamId: s.teamId, data: review, lootGroups: review.lootUnmatched, filter: 'all' });
  const text = stripTags(html);
  assert(/Loot winners not on the roster/.test(text) && /Veyla/.test(text) && /won 1 item/.test(text), text.slice(0, 400));
  assert(/data-action="unm-link"/.test(html) && /data-action="unm-person"/.test(html) && /data-action="unm-guest"/.test(html));
  const key = (name) => group.items.find((item) => item.name === name).key;
  // The three actions, as the dialogs send them.
  await G.api.post(`${s.base}/raids/${s.raid}/unmatched`, { key: key('Dorrin'), action: 'alt', personId: s.people.Thoren, makeMain: false });
  await G.api.post(`${s.base}/raids/${s.raid}/unmatched`, { key: key('Veyla'), action: 'person', status: 'raider', joinedOn: RAID_ON });
  await G.api.post(`${s.base}/raids/${s.raid}/unmatched`, { key: key('Ruvik'), action: 'guest' });
  const after = await G.api.get(`${s.base}/attendance/review?team=${encodeURIComponent(s.teamId)}`);
  const left = after.lootUnmatched[0].items.map((item) => item.name);
  assert(!['Dorrin', 'Veyla', 'Ruvik'].some((name) => left.includes(name)), 'the three are out of the queue: ' + left);
  const loot = await G.api.loot.raid(s.gid, s.raid);
  const by = (item) => loot.awards.find((award) => award.itemName === item.itemName && award.winner.name === item.name);
  assert.equal(loot.awards.find((a) => a.winner.name === 'Dorrin').match.personName, 'Thoren', 'Dorrin is now Thoren\'s alt');
  assert.equal(loot.awards.find((a) => a.winner.name === 'Veyla').match.kind, 'character', 'Veyla is a new person');
  assert.equal(loot.awards.find((a) => a.winner.name === 'Ruvik').match.kind, 'guest', 'Ruvik is a guest');
  assert(by({ itemName: 'Eye of Gruul', name: 'Dorrin' }), 'the award is still there');
  // A name that is in neither the log nor the loot is a 404.
  let error = null;
  try { await G.api.post(`${s.base}/raids/${s.raid}/unmatched`, { key: 'nobody|nightslayer', action: 'guest' }); } catch (e) { error = e; }
  assert(error && error.status === 404);
});

check('visibility: a member under "own" gets scope "own" (one row and the team average); somebody else\'s person page is a 403 the pages tell as a note', async () => {
  const s = await scenario();
  await importNight(s);
  await s.G.api.loot.savePolicy(s.gid, null, { visibility: { members: 'own', standings: true } }, 0);
  const M = loadPages(s.world, s.memberJar);
  const gd = await M.api.get(s.base);
  pageState(s, M, gd);
  assert.equal(M.shell.allowsTeam(gd.me.can, 'loot.edit', s.teamId), false, 'a member cannot edit');
  const view = { name: 'section', gid: s.gid, section: 'loot' };
  await M.pages.loot.load(view, gd);
  const data = M.app.state.att.loot.data;
  assert.equal(data.scope, 'own');
  assert.equal(data.people.length, 1);
  assert.equal(data.people[0].name, 'Thoren');
  const text = stripTags(M.pages.loot.main(view, gd));
  assert(/own loot only/.test(text) && /Team average per raid/.test(text), text);
  // Raid card: the member sees only their own awards and no editing controls.
  const detail = await M.api.get(`${s.base}/raids/${s.raid}`);
  await M.pages.raidLoot.loadFor(gd, detail);
  const card = M.pages.raidLoot.cardHtml({ guildData: gd, data: detail, state: M.pages.raidLoot.stateFor(s.gid, s.raid) });
  assert(!/data-change="loot-tag"/.test(card) && !/loot-import-open/.test(card), 'no editing controls for a member');
  assert(/Thoren/.test(stripTags(card)) && !/Kaelith/.test(stripTags(card)), 'only their own awards');
  await M.pages.personLoot.loadCard(s.gid, s.people.Kaelith);
  const denied = M.pages.personLoot.cardFor(gd, { person: { isMe: false } }, s.people.Kaelith);
  assert(/not shown to you/.test(stripTags(denied)), 'someone else\'s card is a note, not an error');
});

check('disenchants: the Worker refuses another tag on a no-winner award (400 on the tag field), takes DE, a note and a delete, and the balance never attributes it', async () => {
  const s = await scenario();
  const { G } = s;
  await importNight(s, true);
  const de = (await G.api.loot.raid(s.gid, s.raid)).awards.find((award) => award.match.kind === 'disenchanted');
  assert(de && de.winner.name === null && de.winner.realm === null && de.winner.class === null && de.tag === 'DE' && de.tagSetBy === null);
  assert.equal(de.itemName, 'The Phylactery of Kel\'Thuzad');
  for (const tag of ['MS', 'OS', 'BANK']) {
    let error = null;
    try { await G.api.loot.update(s.gid, de.id, { tag }); } catch (e) { error = e; }
    assert(error && error.status === 400 && error.field === 'tag', `${tag} is refused on the tag field`);
  }
  assert.equal((await G.api.loot.update(s.gid, de.id, { tag: 'DE' })).award.tagSetBy, 'officer');
  assert.equal((await G.api.loot.update(s.gid, de.id, { note: 'Shattered for the enchanter' })).award.note, 'Shattered for the enchanter');
  const balance = await G.api.loot.balance(s.gid, s.teamId, null);
  assert.equal(balance.people.reduce((sum, person) => sum + person.items.DE.all, 0), 0, 'nobody received the disenchant');
  const gone = await G.api.loot.remove(s.gid, de.id);
  assert.deepEqual(gone, { ok: true });
  assert.equal((await G.api.loot.raid(s.gid, s.raid)).awards.length, 13);
  // The delete left a tombstone: the same export does not bring it back unasked.
  const back = await importNight(s, true);
  assert.deepEqual([back.inserted, back.deleted.kept, back.awards.filter((award) => award.match.kind === 'disenchanted').length], [0, 1, 0]);
});

check('review queue: a loot winner with no class gets the class select, and the class picked there is what the Worker needs to add or link the character', async () => {
  const s = await scenario();
  const { G } = s;
  await importNight(s, true);
  const night = s.awards[0].awardedAt;
  const classless = (checksum, name, itemId) => Object.assign({}, s.awards[0], { checksum, winnerName: name, winnerRealm: 'Nightslayer', winnerClass: null, itemId, itemName: null, quality: null, awardedAt: night + 1000 });
  const done = await G.api.loot.commit(s.gid, s.raid, [classless('CLASSLESS0001', 'Nomad', 28830), classless('CLASSLESS0002', 'Roamer', 28831)], false);
  assert.equal(done.inserted, 2);
  const review = await G.api.get(`${s.base}/attendance/review?team=${encodeURIComponent(s.teamId)}`);
  const items = review.lootUnmatched[0].items;
  const nomad = items.find((item) => item.name === 'Nomad');
  const roamer = items.find((item) => item.name === 'Roamer');
  assert.deepEqual([nomad.class, roamer.class], [null, null]);
  const R = G.pages.review;
  const person = R.personDialogHtml({ unm: nomad, raidId: s.raid, raidOn: RAID_ON, where: 'review', guildData: s.guildData });
  const link = R.linkDialogHtml({ unm: roamer, people: [], raidId: s.raid, where: 'review', guildData: s.guildData });
  for (const html of [person, link]) {
    assert(/<select[^>]*id="unm-class"[^>]*name="class"/.test(html) && /Class \(required\)/.test(html), 'the dialog asks for the class');
  }
  // The classes the select offers are exactly the ones the Worker takes.
  const offered = [...person.slice(person.indexOf('id="unm-class"')).split('</select>')[0].matchAll(/<option value="([A-Z]+)"/g)].map((m) => m[1]);
  assert.equal(offered.length, 9);
  const post = (body) => G.api.post(`${s.base}/raids/${s.raid}/unmatched`, body);
  let error = null;
  try { await post({ key: nomad.key, action: 'person', status: 'raider', joinedOn: RAID_ON }); } catch (e) { error = e; }
  assert(error && error.status === 400 && error.field === 'class', 'without a class the Worker names the class field');
  for (const id of offered) {
    error = null;
    try { await post({ key: 'nobody|nightslayer', action: 'guest', class: id }); } catch (e) { error = e; }
    assert(error && error.status === 404, `${id} passes the class check (the unknown name is the only problem)`);
  }
  await post({ key: nomad.key, action: 'person', status: 'raider', joinedOn: RAID_ON, class: 'ROGUE' });
  await post({ key: roamer.key, action: 'alt', personId: s.people.Thoren, class: 'MAGE' });
  const loot = (await G.api.loot.raid(s.gid, s.raid)).awards;
  const nomadAward = loot.find((award) => award.winner.name === 'Nomad');
  const roamerAward = loot.find((award) => award.winner.name === 'Roamer');
  assert.deepEqual([nomadAward.match.kind, nomadAward.winner.class], ['character', 'ROGUE']);
  assert.deepEqual([roamerAward.match.personName, roamerAward.winner.class], ['Thoren', 'MAGE']);
  const after = await G.api.get(`${s.base}/attendance/review?team=${encodeURIComponent(s.teamId)}`);
  assert(!after.lootUnmatched[0].items.some((item) => ['Nomad', 'Roamer'].includes(item.name)), 'both are out of the queue');
});

check('loot page routes (lane W): hub, item, award record, Needs fixing and the PATCH edit answer through G.api with the shapes the pages read; a stale save is a 409 with `current`', async () => {
  const s = await scenario();
  const { G } = s;
  const committed = await importNight(s);
  const lootBase = `${s.base}/loot`;
  const hub = await G.api.get(`${lootBase}/hub?team=${encodeURIComponent(s.teamId)}`);
  assert.deepEqual(Object.keys(hub), ['team', 'can', 'me', 'nights', 'standingsTop', 'fix']);
  assert.deepEqual(hub.can, { edit: true, rules: true, standings: true, itemLookup: true });
  assert.equal(hub.nights[0].awards.length, committed.awards.length);
  assert.deepEqual(Object.keys(hub.nights[0]), ['raid', 'awards']);

  const first = committed.awards[0];
  const record = await G.api.get(`${lootBase}/a/${encodeURIComponent(first.id)}`);
  assert.deepEqual([Object.keys(record), record.canEdit, record.award.id, record.raid.teamId], [['award', 'raid', 'origin', 'history', 'canEdit'], true, first.id, s.teamId]);
  const item = await G.api.get(`${lootBase}/items/${first.itemId}?team=${encodeURIComponent(s.teamId)}`);
  assert.deepEqual([Object.keys(item), item.item.itemId, item.drops.some((drop) => drop.id === first.id)], [['team', 'item', 'counts', 'drops'], first.itemId, true]);
  const fix = await G.api.get(`${lootBase}/fix?team=${encodeURIComponent(s.teamId)}`);
  assert.deepEqual(Object.keys(fix), ['team', 'duplicates', 'unknown']);

  // Edit details: the winner and the tag in one PATCH; the answer is the new award view with a new updatedAt.
  const edited = await G.api.loot.update(s.gid, first.id, { winnerName: 'Wanderfell', tag: 'OS', updatedAt: record.award.updatedAt });
  assert.deepEqual([edited.award.winner.name, edited.award.tag, edited.award.editedFields], ['Wanderfell', 'OS', ['winner']]);
  let stale = null;
  try { await G.api.loot.update(s.gid, first.id, { winnerName: 'Aldric', updatedAt: record.award.updatedAt - 1 }); } catch (e) { stale = e; }
  assert.deepEqual([stale && stale.status, stale && stale.code, stale && stale.body.current.id], [409, 'stale', first.id]);
  // Re-importing the same export: the edited winner is a conflict row the preview describes, and the result counts it.
  const preview = await G.api.loot.preview(s.gid, s.raid, s.awards);
  const row = preview.rows.find((r) => r.awardId === first.id);
  assert.deepEqual([row.status, row.conflicts.map((c) => c.field), preview.counts.conflict], ['conflict', ['winner'], 1]);
});

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
