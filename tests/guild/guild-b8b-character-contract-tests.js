/**
 * Raidsmith guild UI, lane B8b "character" - CONTRACT test (Worker <-> page) for the Character page
 * Run: node tests/guild/guild-b8b-character-contract-tests.js
 *
 * The real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1 stand-in, the guild world of tests/guild-b3-world.js)
 * through G.api, as the signed-in owner:
 *   - the page from GET /api/me/characters/:cid: head (class-coloured name, ONE chip, context), Team panel, Loot rows and totals, Raids rows with Bosses, Details; the route
 *     #/characters/<cid> parses and formats, the crumb is My characters > <name>;
 *   - Raids: 10 rows then "Showing 10 of N" + Show all; every head sorts (aria-sort, the page's own 'table-sort' handler);
 *   - Request team (only while the Worker says canRequestTeam) opens the Request team dialog with THIS character first; sending shows "Requested <team>" with Withdraw request;
 *   - Change on Main spec / Off spec; Remove from my profile in More only while canRemove (an Alt in a guild that is not in-game), never on a Main or on any character in-game;
 *   - a character that is not the viewer's is a 404 for the page's load.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runChecks, scenario } = require('../guild-b3-world');
const { GUILD_SCRIPTS } = require('../guild-scripts');
const { ingameize, makeProven } = require('../guild-ingame');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const stripTags = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&middot;/g, '.').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const idOf = (prefix, n) => `${prefix}_${String(n).padStart(22, '0')}`;
let serial = 0;

// One page set for one signed-in person: the real scripts, G.api routed to the Worker with that person's session.
function pagesFor(s, who) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  const els = {};
  sandbox.document = { getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  const f = async (urlPath, init = {}) => {
    s.w.advance(2000);
    return s.w.req(init.method || 'GET', urlPath, { jar: s.jars[who], rawBody: init.body });
  };
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  const shown = { dialogs: [], went: [] };
  G.ui.openDialog = (html) => { shown.dialogs.push(html); return null; };
  G.app.go = (hash) => { shown.went.push(hash); };
  G.app.requireSignin = () => { throw new Error('the page was sent to sign-in'); };
  G.app.showFailure = (title, text) => { throw new Error('failure page: ' + title + ' ' + text); };
  return { G, els, shown, state: G.app.state, gid: s.gid };
}
const el = (attrs) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null });
const formOf = (attrs, values) => ({
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  elements: Object.fromEntries(Object.entries(values.fields || {}).map(([k, v]) => [k, { value: v }])),
  querySelector: (sel) => { const m = /input\[name="(\w+)"\]:checked/.exec(sel); return m && (values.picks || {})[m[1]] ? { value: values.picks[m[1]] } : null; },
  querySelectorAll: () => [], closest: () => null, classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {},
});

// What app.js loadCharacter does: the page's read, the guild around it, the viewer's team requests.
async function openCharacter(p, cid) {
  const { G, state, gid } = p;
  const data = await G.pages.character.load(cid);
  state.currentGid = gid;
  state.guilds[gid] = await G.api.get(`/api/guild/${gid}`);
  await G.pages.teamRequests.read(gid);
  return data;
}
const pageHtml = (p) => p.G.pages.character.pageHtml({ guildData: p.state.guilds[p.gid], state: p.state.character, alert: '' });
const text = (p) => stripTags(pageHtml(p));
// [[characterId, picked]] of the Request team dialog's character radios
const picks = (dialog) => [...dialog.matchAll(/<input[^>]*name="characterId"[^>]*>/g)].map((m) => [/value="([^"]+)"/.exec(m[0])[1], / checked/.test(m[0])]);

function addRaid(s, { zone = 'Karazhan', raidOn, teamId, mode = 'log' }) {
  const id = idOf('ra', ++serial);
  const startsAt = Date.parse(`${raidOn}T20:00:00Z`);
  s.w.db.sqlite.prepare(
    'INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, zone, log_mode, manual_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)',
  ).run(id, s.gid, teamId, raidOn, startsAt, zone, mode, mode === 'manual' ? 'No log that night' : null);
  return { id, startsAt };
}
// kills: how many of `total` encounters were killed with `name` present
function addPulls(s, raid, name, { total, present }) {
  const sqlite = s.w.db.sqlite;
  const code = `CODE${String(++serial).padStart(12, '0')}`;
  sqlite.prepare("INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, synced_at) VALUES (?, ?, ?, 'www', 1, 1)").run(raid.id, s.gid, code);
  for (let i = 0; i < total; i++) {
    const info = sqlite.prepare('INSERT INTO raid_pulls (raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(raid.id, code, i + 1, 100 + i, `Boss ${i}`, raid.startsAt + i, raid.startsAt + i + 1);
    if (i < present) {
      sqlite.prepare('INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(info.lastInsertRowid, raid.id, s.gid, name, name.toLowerCase(), 'Nightslayer', 'nightslayer');
    }
  }
}
function addLoot(s, raid, name, itemId, tag = 'MS') {
  s.w.db.sqlite.prepare(
    `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm_key, winner_class, tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nightslayer', 'DRUID', ?, 1, 1)`,
  ).run(idOf('lo', ++serial), s.gid, raid.id, s.alpha, `checksum-${serial}`, itemId, `Item ${itemId}`, raid.startsAt + 1000, name, name.toLowerCase(), tag);
}

async function world() {
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  const [alpha, bravo] = s.tids;
  Object.assign(s, { alpha, bravo });
  await s.member('m1', 'Memberone');
  await s.member('m2', 'Membertwo');
  s.main = await s.person({ name: 'Mainone', class: 'DRUID', mainSpec: 'Restoration', offSpec: 'Feral (Tank)' });
  await s.link(s.main.pid, 'm1');
  s.altId = await s.alt(s.main.pid, 'Altone', { class: 'MAGE', mainSpec: 'Fire', offSpec: null });
  s.alt3 = await s.alt(s.main.pid, 'Altthree', { class: 'ROGUE', mainSpec: 'Combat', offSpec: null });
  s.m2 = await s.person({ name: 'Maintwo' });
  await s.link(s.m2.pid, 'm2');
  return s;
}

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('the page of a Main: class-coloured name, one chip, context line, Team panel with the core rank, Loot with totals, Raids with Bosses, Details; no Request team, no More', async () => {
  const s = await world();
  const r1 = addRaid(s, { raidOn: '2026-10-01', teamId: s.alpha });
  addPulls(s, r1, 'Mainone', { total: 6, present: 5 });
  const r2 = addRaid(s, { raidOn: '2026-10-08', teamId: s.alpha, zone: 'Gruul\'s Lair' });
  addPulls(s, r2, 'Mainone', { total: 2, present: 2 });
  const manual = addRaid(s, { raidOn: '2026-10-15', teamId: s.bravo, zone: 'Magtheridon\'s Lair', mode: 'manual' });
  s.exec(`INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key) VALUES ('${manual.id}', '${s.gid}', 'Mainone', 'mainone', 'Nightslayer', 'nightslayer')`);
  addLoot(s, r1, 'Mainone', 28823, 'MS');
  addLoot(s, r2, 'Mainone', 28789, 'OS');
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.main.cid);
  const html = pageHtml(p);
  assert(html.includes('<h1 class="gs-h1 gs-class-druid" id="page-title"'), 'the name in its class colour');
  assert.equal((html.match(/gs-hd-chip/g) || []).length, 1, 'ONE chip');
  assert(html.includes('<span class="gs-hd-chip is-grey">Main</span>'));
  const t = stripTags(html);
  assert(t.includes('Druid . Restoration / Feral (Tank)') && t.includes('Nightslayer'), t.slice(0, 300));
  assert(!/Level \d/.test(t.slice(0, 400)), 'no level stored: no Level in the context line');
  assert(/Team\s+Alpha\s+Core rank Raider/.test(t), 'the Team panel names the team and the core rank');
  assert(!html.includes('character-request-open') && !html.includes('character-more') && !html.includes('character-remove-open'), 'a Main on a team: nothing to request, nothing to remove');
  assert(html.includes('MS 1 &middot; OS 1 &middot; DE 0 &middot; Bank 0'));
  assert.equal((html.match(/class="gs-loot-row"/g) || []).length, 2);
  assert(html.includes('Item 28823') || html.includes('28823'), 'the item shows');
  // raids: newest first, Bosses killed / kills, no value for the raid entered by hand
  const rows = [...html.matchAll(/<div class="gs-ch-raid" role="row">([\s\S]*?)<\/div>/g)].map((m) => stripTags(m[1]));
  assert.deepEqual(rows, ['Oct 15 Magtheridon\'s Lair Bravo No boss count -', 'Oct 8 Gruul\'s Lair Alpha 2 / 2', 'Oct 1 Karazhan Alpha 5 / 6']);
  assert(html.includes(`href="#/g/${s.gid}/raids/r/${manual.id}"`), 'a raid name links to the raid');
  // details
  for (const label of ['Name', 'Main spec', 'Off spec', 'Role', 'Realm', 'Added']) assert(t.includes(label), label);
  assert(!t.includes('In-game rank') && !/\bLevel 70\b/.test(t), 'no level and no in-game rank stored: no rows');
  assert(html.includes('data-action="character-spec-open"') && html.includes('data-which="main"') && html.includes('data-which="off"'));
  assert(/Role\s+Main\b/.test(t));
  assert(!/Attendance|Sign-ups|Credit/i.test(html), 'no attendance outcome, credit or sign-ups: those belong to the person');
});

check('the page of a teamless Alt: Alt chip, "No team", Request team in the head (not More: the guild is not in-game, so More holds Remove), empty Loot and Raids say so', async () => {
  const s = await world();
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.altId);
  const html = pageHtml(p);
  const t = stripTags(html);
  assert(html.includes('<span class="gs-hd-chip is-grey">Alt</span>') && html.includes('gs-class-mage'));
  assert(/Team\s+No team/.test(t) && html.includes('gs-ch-team-v is-none'));
  assert(html.includes('data-action="character-request-open"'));
  assert(html.includes('data-action="character-remove-open"') && t.includes('Remove from my profile'), 'an Alt in a guild that is not in-game: Remove from my profile in More');
  assert(html.includes('No loot yet.') && html.includes('No raids yet.'));
  assert(!html.includes('Core rank'), 'no team, no core rank line');
  assert(html.indexOf('character-request-open') < html.indexOf('id="character-more"'), 'Request team sits left of More');
});

check('Raids: 10 rows then "Showing 10 of 14" + Show all; Show all lists every row; every head is a sort button with aria-sort and the page sorts', async () => {
  const s = await world();
  for (let i = 0; i < 14; i++) {
    const raid = addRaid(s, { raidOn: `2026-09-${String(i + 1).padStart(2, '0')}`, teamId: i % 2 ? s.bravo : s.alpha, zone: i % 3 === 0 ? 'Karazhan' : 'Gruul\'s Lair' });
    addPulls(s, raid, 'Mainone', { total: 4, present: (i % 4) + 1 });
  }
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.main.cid);
  let html = pageHtml(p);
  const rowCount = (h) => (h.match(/<div class="gs-ch-raid" role="row">/g) || []).length;
  assert.equal(rowCount(html), 10);
  assert(stripTags(html).includes('Showing 10 of 14') && html.includes('data-action="character-raids-all"') && html.includes('Show all 14'));
  const firstDay = (h) => stripTags(/<div class="gs-ch-raid" role="row">([\s\S]*?)<\/div>/.exec(h)[1]).split(' ').slice(0, 2).join(' ');
  assert.equal(firstDay(html), 'Sep 14', 'newest first');
  assert.equal([...html.matchAll(/role="columnheader" aria-sort="(\w+)"/g)].map((m) => m[1]).join(','), 'descending,none,none,none', 'Date shows its arrow first');
  for (const col of ['date', 'raid', 'team', 'bosses']) assert(html.includes(`data-table="character-raids" data-sort="${col}"`), col);
  // sort by Date again: oldest first
  p.G.handlers.click['table-sort'](el({ 'data-table': 'character-raids', 'data-sort': 'date', 'data-dir': 'desc' }));
  html = pageHtml(p);
  assert.equal(firstDay(html), 'Sep 1');
  assert(html.includes('role="columnheader" aria-sort="ascending"'));
  // by Bosses: the fewest first, ascending
  p.G.handlers.click['table-sort'](el({ 'data-table': 'character-raids', 'data-sort': 'bosses' }));
  html = pageHtml(p);
  const bosses = [...html.matchAll(/gs-ch-raid-b" role="cell">(\d) \/ 4/g)].map((m) => Number(m[1]));
  assert.deepEqual(bosses, [...bosses].sort((a, b) => a - b), 'ascending by bosses killed');
  // Show all
  p.G.handlers.click['character-raids-all']();
  html = pageHtml(p);
  assert.equal(rowCount(html), 14);
  assert(!stripTags(html).includes('Showing 10 of 14'));
});

check('Loot also shows 10 rows, then Showing 10 of N and Show all', async () => {
  const s = await world();
  const raid = addRaid(s, { raidOn: '2026-10-01', teamId: s.alpha });
  for (let i = 0; i < 12; i++) addLoot(s, raid, 'Mainone', 30000 + i);
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.main.cid);
  let html = pageHtml(p);
  assert.equal((html.match(/class="gs-loot-row"/g) || []).length, 10);
  assert(stripTags(html).includes('Showing 10 of 12'));
  p.G.handlers.click['character-loot-all']();
  html = pageHtml(p);
  assert.equal((html.match(/class="gs-loot-row"/g) || []).length, 12);
});

check('Request team: the dialog lists this character first (picked) and the person\'s other teamless characters; sending shows Requested <team> with Withdraw request; Withdraw puts it back', async () => {
  const s = await world();
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.alt3);
  p.G.handlers.click['character-request-open']();
  assert.equal(p.shown.dialogs.length, 1);
  const dialog = p.shown.dialogs[0];
  assert.deepEqual(picks(dialog), [[s.alt3, true], [s.altId, false]], 'Altthree first and picked, then Altone');
  assert(/Bravo/.test(stripTags(dialog)) && !/Alpha/.test(stripTags(dialog)), 'only the team the person has no character on');
  p.G.handlers.submit['team-request-form'](formOf({}, { picks: { characterId: s.alt3, teamId: s.bravo } }));
  await settle();
  const html = pageHtml(p);
  assert(/Requested Bravo/.test(stripTags(html)) && html.includes('data-action="character-request-withdraw"') && html.includes('Withdraw request'));
  assert(!html.includes('character-request-open'), 'a request is waiting: no Request team');
  // the other Alt still can
  await p.G.pages.character.load(s.altId);
  assert(pageHtml(p).includes('character-request-open'));
  // withdraw on Altthree's page
  await openCharacter(p, s.alt3);
  p.G.handlers.click['character-request-withdraw'](el({}));
  await settle();
  const after = pageHtml(p);
  assert(/Team\s+No team/.test(stripTags(after)) && after.includes('character-request-open') && !after.includes('Withdraw request'));
  // a character on its own page opens the dialog first even when another is listed earlier
  await openCharacter(p, s.altId);
  p.shown.dialogs.length = 0;
  p.G.handlers.click['character-request-open']();
  assert.deepEqual(picks(p.shown.dialogs[0]), [[s.altId, true], [s.alt3, false]]);
});

check('Change on Main spec / Off spec: the dialog offers the class\'s specs, saving updates the Details; a bad pick shows the Worker\'s message in the form', async () => {
  const s = await world();
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.altId);
  p.G.handlers.click['character-spec-open'](el({ 'data-which': 'off' }));
  const dialog = p.shown.dialogs[0];
  assert(/Change off spec for Altone/.test(stripTags(dialog)));
  assert.deepEqual([...dialog.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]), ['', 'Arcane', 'Fire', 'Frost'], 'None plus the Mage\'s specs');
  p.G.handlers.submit['character-spec-form'](formOf({ 'data-which': 'off' }, { fields: { spec: 'Frost' } }));
  await settle();
  assert.equal(p.state.character.data.character.offSpec, 'Frost');
  assert(/Off spec\s+Frost/.test(text(p)) && /Mage . Fire \/ Frost/.test(text(p)), 'the Details and the context line follow');
  // the same as the main spec: refused, the message lands in the dialog's error line
  p.els['dlg-error'] = { textContent: '', hidden: true };
  p.G.handlers.submit['character-spec-form'](formOf({ 'data-which': 'off' }, { fields: { spec: 'Fire' } }));
  await settle();
  assert.equal(p.state.character.data.character.offSpec, 'Frost', 'unchanged');
  assert.match(p.els['dlg-error'].textContent, /off spec must differ/i);
  // Main spec: Not set is a choice
  p.G.handlers.submit['character-spec-form'](formOf({ 'data-which': 'main' }, { fields: { spec: '' } }));
  await settle();
  assert.equal(p.state.character.data.character.mainSpec, null);
  assert(/Main spec\s+Not set/.test(text(p)));
});

check('Remove from my profile: in More for an Alt in a guild that is not in-game; the destructive dialog names the character; removing leaves the page for My characters and the page is gone', async () => {
  const s = await world();
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.altId);
  p.G.handlers.click['character-remove-open']();
  const dialog = p.shown.dialogs[0];
  assert(dialog.includes('gs-dialog-destructive') && stripTags(dialog).includes('Remove Altone from your profile?') && stripTags(dialog).includes('Past raids and loot stay under its name.'));
  p.G.handlers.submit['character-remove-form'](formOf({}, {}));
  await settle();
  assert.deepEqual(p.shown.went, ['#/characters']);
  assert.equal(p.state.character, null);
  await assert.rejects(p.G.pages.character.load(s.altId), (err) => err.status === 404);
  // a Main has no Remove, and the handler does nothing for it either
  await openCharacter(p, s.main.cid);
  p.shown.dialogs.length = 0;
  p.G.handlers.click['character-remove-open']();
  assert.equal(p.shown.dialogs.length, 0);
});

check('in an in-game guild: no Alt has More or Remove, whatever proved it (the Worker would refuse); the level and the in-game rank show', async () => {
  const s = await world();
  ingameize(s, { owner: 'gm', people: { m1: s.main, m2: s.m2 } });
  makeProven(s, 'm1', { pid: s.main.pid, cid: s.altId }, { rank: 3, proof: 'officer', link: false });
  s.exec(`UPDATE characters SET owner_proof = 'bnet' WHERE id = '${s.altId}'`);
  const p = pagesFor(s, 'm1');
  await openCharacter(p, s.altId);
  let html = pageHtml(p);
  assert(!html.includes('character-more') && !html.includes('Remove from my profile'), 'no More on a Battle.net Alt of an in-game guild');
  assert(html.includes('character-request-open'), 'Request team stays');
  const t = stripTags(html);
  assert(/Level 70/.test(t) && /Level\s+70 . From Battle\.net/.test(t), 'level in the context line and the Details');
  assert(/In-game rank\s+Core . From the guild roster/.test(t));
  p.G.handlers.click['character-remove-open']();
  assert.equal(p.shown.dialogs.length, 0, 'the handler is a no-op without canRemove');
  await openCharacter(p, s.alt3);
  html = pageHtml(p);
  assert(!html.includes('character-more') && !html.includes('character-remove-open'), 'nor on an Alt that Battle.net did not prove: in an in-game guild the owner removes no character');
});

check('only the owner opens it: another account\'s load is a 404; the route parses and formats; the crumb is My characters > <name>', async () => {
  const s = await world();
  const other = pagesFor(s, 'm2');
  await assert.rejects(other.G.pages.character.load(s.altId), (err) => err.status === 404 && err.code === 'not_found');
  const p = pagesFor(s, 'm1');
  const { router } = p.G;
  assert.deepEqual(JSON.parse(JSON.stringify(router.parse(`#/characters/${s.altId}`))), { name: 'character', cid: s.altId });
  assert.equal(router.format({ name: 'character', cid: s.altId }), `#/characters/${s.altId}`);
  assert.deepEqual(JSON.parse(JSON.stringify(router.parse('#/characters'))), { name: 'characters' });
  assert.deepEqual(JSON.parse(JSON.stringify(router.parse('#/characters/bad id'))), { name: 'notfound' });
  assert.equal(router.format({ name: 'character', cid: 'bad id' }), '#/characters');
  await openCharacter(p, s.altId);
  assert.equal(p.G.pages.character.nameFor({ name: 'character', cid: s.altId }), 'Altone');
  assert.equal(p.G.pages.character.nameFor({ name: 'character', cid: s.main.cid }), '', 'another character\'s name is not this page\'s');
  const crumbs = p.G.shell.breadcrumbItems({ route: { name: 'character', cid: s.altId }, guildData: p.state.guilds[s.gid], leafName: 'Altone', signedOut: false, section: 'guild' });
  assert.deepEqual(JSON.parse(JSON.stringify(crumbs.map((c) => [c.label, !!c.href]))), [['My characters', true], ['Altone', false]]);
  assert.match(crumbs[0].href, /#\/characters$/);
});

runChecks(checks);
