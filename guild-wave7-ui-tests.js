/**
 * Raidsmith guild UI, PM wave 7 - tests for Guild settings > Data access (read-only API keys), the team progress board (Raids > Progress and the public
 * page's Progress section) and the rank ladder (the ladder editor, the rank chip and suggestions on Attendance, the person's attendance page, Home).
 * Run: node guild-wave7-ui-tests.js
 *
 * Same approach as guild-roles-ui-tests.js: the shared guild script list (tests/guild-scripts.js) is loaded in a vm with no DOM; the render functions return
 * HTML strings and the handlers run against a stubbed G.api and a fake document. guild-wave7-worker-tests.js covers the Worker half.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('node:url');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const css = read('guild.css');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const fields = {};
ctx.document = { getElementById: id => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 14; i++) await tick(); };
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 17, 12);
const TOKEN = 'rsk_' + 'A'.repeat(20) + '-_' + 'b'.repeat(21);
const HOSTILE = '<img src=x onerror=1>';

function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

const TEAMS = [{ id: 't1', name: 'Alpha', size: 25, archived: false }, { id: 't2', name: 'Bravo', size: 25, archived: false }];
const OFFICER = { 'guild.access': 'guild', 'guild.roles': 'guild', 'attendance.policy': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'roster.edit': 'guild' };
function guildData(can, extra) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', realmSlug: 'dreamscythe', region: 'US', timeZone: 'UTC', gameVersion: 'tbc', createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({ players: 0, leads: [] }, t)),
    me: { roles: [{ role: 'officer' }], can: can || OFFICER },
    rosterOptions: null,
  }, extra || {});
}
const person = (id, name) => ({ id, displayName: name, username: name.toLowerCase(), avatar: null });

function withApi(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = G.api[k]; G.api[k] = stubs[k]; }
  const savedGo = G.app.go, savedRender = G.app.render, savedRoute = G.app.routeAll, savedOpen = G.ui.openDialog, savedHandle = G.app.handleError;
  const opened = [];
  const routed = [];
  const handled = [];
  let renders = 0;
  G.app.go = () => {};
  G.app.render = () => { renders++; };
  G.app.routeAll = (o) => { routed.push(o); return Promise.resolve(); };
  G.app.handleError = (err, o) => { handled.push([err, o]); };
  G.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return { open: true }; };
  const probe = { opened, routed, handled, renders: () => renders };
  return Promise.resolve(fn(probe)).finally(() => {
    for (const k of Object.keys(saved)) G.api[k] = saved[k];
    G.app.go = savedGo; G.app.render = savedRender; G.app.routeAll = savedRoute; G.ui.openDialog = savedOpen; G.app.handleError = savedHandle;
  });
}
function formEl(attrs, elements, lists) {
  return {
    getAttribute: k => (attrs || {})[k], elements: elements || {}, querySelectorAll: sel => ((lists || {})[sel] || []), querySelector: () => null, closest: () => null, disabled: false,
  };
}
const el = attrs => ({ disabled: false, hidden: false, getAttribute: k => (attrs || {})[k], closest: () => null, focus() {}, select() {} });
const box = (checked, value) => Object.assign(el({ value }), { checked, value });
function field(id) { fields[id] = { textContent: '', hidden: true }; return fields[id]; }
function clearFields() { for (const k of Object.keys(fields)) delete fields[k]; }
const okRes = body => Promise.resolve(body);
const rejectWith = (status, body) => Promise.reject(new G.api.ApiError(status, body));

function keyData(extra) {
  const key = (id, over) => Object.assign({
    id, name: 'Loot sheet', team: null, datasets: ['roster', 'loot'], status: 'active', expiresAt: T0 + 30 * DAY, revokedAt: null, uses: 3, lastUsedAt: T0 - DAY, createdAt: T0 - 2 * DAY, createdBy: person('u1', 'Gale'),
  }, over || {});
  return Object.assign({
    keys: [key('ak_1'), key('ak_2', { name: 'Old', status: 'expired', expiresAt: T0 - DAY, uses: 0, lastUsedAt: null, team: { id: 't1', name: 'Alpha' }, datasets: ['attendance'] }),
      key('ak_3', { name: 'Gone', status: 'revoked', revokedAt: T0 - DAY, expiresAt: null, createdBy: null })],
    datasets: [{ id: 'roster', label: 'Roster', available: true }, { id: 'attendance', label: 'Attendance', available: true }, { id: 'loot', label: 'Loot', available: false }, { id: 'raids', label: 'Raids', available: true }],
    expiries: ['30d', '90d', '365d', 'never'], limits: { perHour: 60, maxActive: 20 },
  }, extra || {});
}

(async () => {
  const { DEFAULT_POLICY } = await import(pathToFileURL(path.join(ROOT, 'worker/attendance-policy.js')).href);

  // =========================================================================
  // Data access

  await check('router and shell: Data access is a Guild settings tab for guild.access, after Guest links; the address round-trips', () => {
    assert(G.router.TABS.includes('dataaccess'));
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings/dataaccess')), { name: 'settings', gid: 'g1', tab: 'dataaccess' });
    assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab: 'dataaccess' }), '#/g/g1/settings/dataaccess');
    const tabs = can => G.shell.settingsTabs(can, []).map(t => t.tab);
    assert.deepEqual(plain(tabs({ 'guild.access': 'guild' })), ['people', 'guests', 'dataaccess']);
    assert.equal(tabs({ 'guild.roles': 'guild' }).includes('dataaccess'), false);
    assert.equal(G.shell.settingsTabs({ 'guild.access': 'guild' }, []).find(t => t.tab === 'dataaccess').label, 'Data access');
    // The tab is wired like the Phase 7 tabs: a state key, a page, the manifest.
    assert(G.pages.settingsDataKeys && typeof G.pages.settingsDataKeys.load === 'function');
    assert(GUILD_SCRIPTS.includes('/js/guild/pages-settings-dataaccess.js'));
  });

  await check('data access page: loading, empty, and the keys with a status pill, what they read, use and end; the token and hash are never drawn; text is escaped', () => {
    const S = G.pages.settingsDataKeys;
    assert(text(S.settingsHtml({ guildData: guildData(), data: null })).includes('Loading'));
    const empty = S.settingsHtml({ guildData: guildData(), data: keyData({ keys: [] }) });
    assert(text(empty).includes('No data keys yet.') && empty.includes('data-action="dkey-new"') && empty.includes('>New key<'));
    const out = S.settingsHtml({ guildData: guildData(), data: keyData(), notice: 'Data key made.', alert: '' });
    const t = text(out);
    assert(t.includes('Loot sheet') && t.includes('Whole guild') && t.includes('Roster, Loot') && t.includes('Used 3 times') && t.includes('Never used'), t);
    assert(t.includes('Alpha') && t.includes('Attendance') && t.includes('Expired') && t.includes('Turned off') && t.includes('Active'), t);
    assert(t.includes('Expires ') && t.includes('Expired ') && t.includes('Turned off Oct'), t);
    assert(text(S.settingsHtml({ guildData: guildData(), data: keyData({ keys: [Object.assign({}, keyData().keys[0], { expiresAt: null })] }) })).includes('Never expires'));
    assert(t.includes('Data key made.') && t.includes('60 times an hour'), t);
    assert.equal((out.match(/data-action="dkey-revoke"/g) || []).length, 1, 'only the working key can be turned off');
    assert(out.includes('aria-label="Turn off key Loot sheet"'));
    assert(!/rsk_|token|hash/i.test(out.replace(/Data keys|data key/gi, '')), 'no token word in the table');
    const hostile = S.settingsHtml({ guildData: guildData(), data: keyData({ keys: [keyData().keys[0]].map(k => Object.assign({}, k, { name: HOSTILE })) }) });
    assert(!hostile.includes('<img src=x'));
    assertNoRawAttrs(out);
    assert(/<table[^>]*aria-label="Data keys"/.test(out) && /<th scope="col">Key<\/th>/.test(out));
  });

  await check('data access dialogs: the form (name, team, what it reads with a dataset members cannot see disabled, expiry), the one-time key with its links, the turn-off question', () => {
    const S = G.pages.settingsDataKeys;
    const form = S.createDialogHtml(keyData(), guildData());
    assert(form.includes('data-submit="dkey-form"') && form.includes('id="dlg-title">New data key<') && form.includes('name="name"') && form.includes('maxlength="40"'));
    assert(/<option value="" selected>Whole guild<\/option>/.test(form) && form.includes('>Alpha<') && form.includes('>Bravo<'));
    assert(/<input type="checkbox" id="dlg-dkey-ds-0" name="datasets" value="roster" checked/.test(form));
    assert(/name="datasets" value="loot" disabled/.test(form) && text(form).includes('Members cannot see this in your guild, so a key cannot read it.'));
    assert(/<option value="90d" selected>90 days<\/option>/.test(form), 'the default expiry');
    assert(form.includes('data-action="dialog-cancel"') && form.includes('>Make key<') && form.includes('id="dlg-error"'));
    assert(/for="dlg-dkey-name"/.test(form) && /for="dlg-dkey-team"/.test(form) && /for="dlg-dkey-expiry"/.test(form));
    const done = S.createdDialogHtml('https://raidsmith.test', TOKEN, ['roster', 'loot']);
    assert(done.includes('id="dkey-token"') && done.includes('readonly') && done.includes('value="' + TOKEN + '"'));
    assert(done.includes('value="https://raidsmith.test/api/v1/roster.csv?key=' + TOKEN + '"') && done.includes('value="https://raidsmith.test/api/v1/loot.csv?key=' + TOKEN + '"'));
    assert(text(done).includes('Copy it now. It is shown only once.') && text(done).includes('IMPORTDATA') && text(done).includes('Authorization: Bearer'));
    assert(text(done).includes('/api/v1/roster.json'), 'the JSON address, without the key');
    assert(!done.includes('roster.json?key='), 'a JSON address never carries the key');
    assert(done.includes('data-action="dkey-copy"') && done.includes('data-target="dkey-csv-0"') && /id="dkey-copy-status" role="status"/.test(done) && !/<form/.test(done));
    assert.deepEqual(plain(S.linksFor('https://x.test', TOKEN, ['raids'])), [{ id: 'raids', label: 'Raids', csv: 'https://x.test/api/v1/raids.csv?key=' + TOKEN, json: 'https://x.test/api/v1/raids.json' }]);
    const off = S.revokeDialogHtml(keyData().keys[0]);
    assert(off.includes('data-submit="dkey-revoke-form"') && off.includes('data-key-id="ak_1"') && text(off).includes('Turn off this key?') && text(off).includes('Loot sheet') && off.includes('gs-btn-danger'));
    assertNoRawAttrs(form); assertNoRawAttrs(done); assertNoRawAttrs(off);
  });

  await check('dkey-form: POSTs the choices, opens the one-time dialog with origin + key, and keeps the token nowhere in the page state; a refusal stays in the dialog', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData(); s.currentGid = 'g1';
    s.dataKeySettings = { gid: 'g1', data: keyData({ keys: [] }), notice: '' };
    clearFields();
    for (const id of ['dlg-err-name', 'dlg-err-teamId', 'dlg-err-datasets', 'dlg-err-expiresIn', 'dlg-error']) field(id);
    fields['dkey-token'] = { select() { fields['dkey-token'].selected = true; } };
    const makeForm = (name, teamId, expiresIn, checked) => formEl({}, { name: { value: name }, teamId: { value: teamId }, expiresIn: { value: expiresIn } },
      { 'input[name="datasets"]': ['roster', 'attendance', 'loot', 'raids'].map(id => box(checked.includes(id), id)) });
    const sent = [];
    const savedOrigin = G.ui.pageOrigin;
    G.ui.pageOrigin = () => 'https://raidsmith.test';
    const after = keyData({ keys: [keyData().keys[0]] });
    await withApi({ post: (url, body) => { sent.push([url, plain(body)]); return okRes(Object.assign({}, after, { created: { id: 'ak_new', token: TOKEN } })); } }, async probe => {
      G.handlers.submit['dkey-form'](makeForm('  Loot sheet  ', 't1', '30d', ['roster', 'raids']));
      await settle();
      assert.deepEqual(sent, [['/api/guild/g1/api-keys', { name: 'Loot sheet', teamId: 't1', datasets: ['roster', 'raids'], expiresIn: '30d' }]]);
      assert.equal(probe.opened.length, 1);
      assert(probe.opened[0].html.includes('value="' + TOKEN + '"') && probe.opened[0].html.includes('https://raidsmith.test/api/v1/roster.csv?key=' + TOKEN));
      assert(probe.opened[0].html.includes('/api/v1/raids.csv') && !probe.opened[0].html.includes('/api/v1/loot.csv'), 'a link for each dataset the key reads');
      assert.equal(fields['dkey-token'].selected, true, 'the key is selected for Ctrl+C');
      assert.equal(s.dataKeySettings.notice, 'Data key made.');
      assert.deepEqual(plain(s.dataKeySettings.data), plain(after));
      assert(!JSON.stringify(plain(s.dataKeySettings)).includes(TOKEN) && !JSON.stringify(plain(s.pageAlert)).includes(TOKEN), 'the token is not kept');
      sent.length = 0;
      G.handlers.submit['dkey-form'](makeForm('Everything', '', 'never', ['roster']));
      await settle();
      assert.deepEqual(sent[0][1], { name: 'Everything', teamId: null, datasets: ['roster'], expiresIn: 'never' }, 'Whole guild is null');
    });
    // A refusal from the Worker is shown at its field.
    clearFields();
    for (const id of ['dlg-err-name', 'dlg-err-teamId', 'dlg-err-datasets', 'dlg-err-expiresIn', 'dlg-error']) field(id);
    await withApi({ post: () => rejectWith(400, { error: 'bad_request', message: 'Pick what the key reads: roster.', field: 'datasets' }) }, async probe => {
      G.handlers.submit['dkey-form'](makeForm('x', '', '30d', []));
      await settle();
      assert.equal(probe.opened.length, 0);
    });
    G.ui.pageOrigin = savedOrigin;
    s.dataKeySettings = null; clearFields();
  });

  await check('dkey-revoke: the question opens for a working key only; turning it off replaces the list and says so', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData(); s.currentGid = 'g1';
    s.dataKeySettings = { gid: 'g1', data: keyData(), notice: '' };
    await withApi({ del: (url) => okRes(Object.assign(keyData(), { keys: keyData().keys.map(k => (k.id === 'ak_1' ? Object.assign({}, k, { status: 'revoked', revokedAt: T0 }) : k)), url })) }, async probe => {
      G.handlers.click['dkey-revoke'](el({ 'data-key-id': 'ak_3' }));
      assert.equal(probe.opened.length, 0, 'a key that is already off');
      G.handlers.click['dkey-revoke'](el({ 'data-key-id': 'ak_1' }));
      assert.equal(probe.opened.length, 1);
      G.handlers.submit['dkey-revoke-form'](formEl({ 'data-key-id': 'ak_1' }));
      await settle();
      assert.equal(s.dataKeySettings.notice, 'Turned off Loot sheet.');
      assert.equal(s.dataKeySettings.data.keys[0].status, 'revoked');
    });
    s.dataKeySettings = null;
  });

  await check('data access: the API client calls the key routes, and the page is wired into app.js like the other Guild settings tabs', async () => {
    const calls = [];
    await withApi({
      get: (url) => { calls.push(['get', url]); return okRes(keyData()); },
      post: (url, body) => { calls.push(['post', url, plain(body)]); return okRes({}); },
      del: (url, body) => { calls.push(['del', url, plain(body)]); return okRes({}); },
    }, async () => {
      await G.api.dataKeys.list('g1');
      await G.api.dataKeys.create('g1', { name: 'x' });
      await G.api.dataKeys.revoke('g1', 'ak_1');
    });
    assert.deepEqual(calls, [['get', '/api/guild/g1/api-keys'], ['post', '/api/guild/g1/api-keys', { name: 'x' }], ['del', '/api/guild/g1/api-keys/ak_1', {}]]);
    const src = read('js/guild/app.js');
    assert(/dataaccess: \{ state: 'dataKeySettings', page: 'settingsDataKeys' \}/.test(src) && /state\.dataKeySettings = null;/.test(src), 'a tab entry and a sign-out reset');
    assert(/wrangler/.test('wrangler') && /"\/api\/v1\/\*"/.test(read('wrangler.jsonc')), 'the Worker runs first for /api/v1/*');
  });

  // =========================================================================
  // Progress

  const PROGRESS = {
    team: { id: 't1', name: 'Alpha' },
    zones: [
      { zone: 'Karazhan', bossesKilled: 0, nightCount: 0, nights: [], bestClear: null, bosses: [{ encounterId: 652, name: 'Attumen the Huntsman', killed: false, firstKillOn: null, firstKillRaidId: null, wipesBeforeKill: 0, wipes: 4, kills: 0, killsSince: 0, pulls: 4 }] },
      { zone: "Gruul's Lair", bossesKilled: 2, nightCount: 11, bestClear: { raidId: 'r_2', raidOn: '2026-12-08', bosses: 2, kills: 2, wipes: 0, durationMs: 20 * 60000 },
        nights: [{ raidId: 'r_2', raidOn: '2026-12-08', bosses: 2, kills: 2, wipes: 0, durationMs: 80 * 60000 }, { raidId: 'r_1', raidOn: '2026-12-01', bosses: 1, kills: 1, wipes: 3, durationMs: 65 * 60000 }],
        bosses: [{ encounterId: 649, name: 'High King Maulgar', killed: true, firstKillOn: '2026-12-01', firstKillRaidId: 'r_1', wipesBeforeKill: 2, wipes: 2, kills: 3, killsSince: 2, pulls: 5 },
          { encounterId: 650, name: 'Gruul the Dragonkiller', killed: true, firstKillOn: '2026-12-08', firstKillRaidId: 'r_2', wipesBeforeKill: 0, wipes: 0, kills: 1, killsSince: 0, pulls: 1 }] },
    ],
  };

  await check('progress board: per zone the bosses with first kill, wipes before it and kills since, the best clear, the nights; a boss not yet down says Progressing; stacks on a phone', () => {
    const P = G.pages.progress;
    assert.equal(P.duration(0), '0m'); assert.equal(P.duration(45 * 60000), '45m'); assert.equal(P.duration(192 * 60000), '3h 12m'); assert.equal(P.duration(65 * 60000), '1h 05m'); assert.equal(P.duration(-5), '0m');
    const out = P.boardHtml({ gid: 'g1', data: PROGRESS });
    const t = text(out);
    assert(t.includes('Karazhan') && t.includes("Gruul's Lair") && t.includes('0 of 1 boss down') && t.includes('2 of 2 bosses down'), t);
    assert(t.includes('Progressing') && t.includes('Down') && t.includes('Attumen the Huntsman'), t);
    assert(t.includes('Best clear: 2 bosses in 20m on'), t);
    assert(t.includes('No night with a boss kill yet.'), 'a zone with no kill says so');
    assert(t.includes('Nights with a kill (newest 2 of 11)'), t);
    assert(t.includes('1h 20m') && t.includes('1h 05m'), t);
    // Wipes: before the kill for a boss that is down, all wipes for one that is not.
    assert(/data-label="Wipes before the kill" class="gs-num">2</.test(out) && /data-label="Wipes" class="gs-num">4</.test(out));
    assert(/<th scope="col">Wipes before the kill<\/th>/.test(out) && /<th scope="col">Kills since<\/th>/.test(out));
    assert(/<a href="#\/g\/g1\/raids\/r\/r_2">/.test(out), 'a night links to its raid for members');
    assert(out.includes('gs-table-stack') && out.includes('data-label="First kill"'));
    assert(/\.gs-table-prog \{ min-width: 520px; \}/.test(css) && /@media \(max-width: 600px\) \{\s*\.gs-table-prog \{ min-width: 0; \}/.test(css), 'the desktop minimum is reset on a phone');
    // The public variant has no raid links; an empty team says what to do; a failure and loading are plain.
    const pub = P.blockHtml(PROGRESS, 'vprog-t1');
    assert(!/href=/.test(pub) && text(pub).includes('Gruul') && pub.includes('id="vprog-t1-z0-h"'), 'no links, ids from the prefix');
    assert(text(P.boardHtml({ gid: 'g1', data: { zones: [] } })).includes('No boss pulls yet.'));
    assert(text(P.boardHtml({ gid: 'g1', data: null })).includes('Loading'));
    assert(P.boardHtml({ gid: 'g1', error: 'Nope' }).includes('role="alert"'));
    assert(!P.boardHtml({ gid: 'g1', data: Object.assign({}, PROGRESS, { zones: [Object.assign({}, PROGRESS.zones[0], { zone: HOSTILE })] }) }).includes('<img src=x'));
    assertNoRawAttrs(out);
  });

  await check('Raids page: a third tab, Progress; opening it reads the board once, shows it, and a reload of the list keeps Upcoming / Past but not Progress', async () => {
    const gd = guildData();
    const data = { raids: [{ id: 'r_1', raidOn: '2026-12-01', zone: "Gruul's Lair", state: 'reviewed', openFlags: 0, sources: {} }], upcoming: [], today: '2026-12-10', can: {} };
    const tabs = G.pages.raids.raidsHtml({ guildData: gd, teamId: 't1', data, tab: 'past' });
    assert(/data-action="raids-tab" data-tab="progress"[^>]*aria-pressed="false">Progress</.test(tabs), 'the third button');
    const withBoard = G.pages.raids.raidsHtml({ guildData: gd, teamId: 't1', data, tab: 'progress', progressHtml: '<p id="the-board">Board</p>' });
    assert(/data-tab="progress"[^>]*aria-pressed="true"/.test(withBoard) && withBoard.includes('id="the-board"') && text(withBoard).includes('Boss progress from the logged raids'));
    assert(!withBoard.includes('aria-label="Raids"><thead'), 'the list of past raids is not drawn under it');
    // An unknown tab falls back; the empty team has no tabs at all.
    assert(/data-tab="past"[^>]*aria-pressed="true"/.test(G.pages.raids.raidsHtml({ guildData: gd, teamId: 't1', data, tab: 'nonsense' })));
    // The click.
    const S = G.app.state;
    S.guilds.g1 = gd; S.currentGid = 'g1';
    const x = { gid: 'g1', teamId: 't1', data, tab: 'past' };
    S.att = { raids: x };
    const gets = [];
    await withApi({ get: (url) => { gets.push(url); return okRes(PROGRESS); } }, async probe => {
      G.handlers.click['raids-tab'](el({ 'data-tab': 'progress' }));
      assert.equal(x.tab, 'progress');
      assert.deepEqual(plain(x.progress), { teamId: 't1', data: null, error: '' }, 'loading while it is read');
      assert(text(G.pages.progress.tabHtml(x)).includes('Loading'));
      await settle();
      assert.deepEqual(gets, ['/api/guild/g1/teams/t1/progress']);
      assert.equal(x.progress.data.zones.length, 2);
      assert(G.pages.progress.tabHtml(x).includes('prog-board'));
      G.handlers.click['raids-tab'](el({ 'data-tab': 'upcoming' }));
      assert.equal(x.tab, 'upcoming');
      assert.equal(G.pages.progress.tabHtml(x), '', 'only on its own tab');
    });
    // A failed read shows its words.
    await withApi({ get: () => rejectWith(403, { error: 'forbidden', message: 'You do not have permission to do that.' }) }, async () => {
      G.handlers.click['raids-tab'](el({ 'data-tab': 'progress' }));
      await settle();
      assert(x.progress.error && !x.progress.data);
      assert(G.pages.progress.tabHtml(x).includes('role="alert"'));
    });
    S.att = {};
  });

  await check('public page: Progress is an option between Raids and Attendance, and the read-only view draws the board without raid links', () => {
    const items = G.pages.settingsPublic.SECTION_ITEMS.map(i => i.key);
    assert.deepEqual(plain(items), ['roster', 'raids', 'progress', 'attendance', 'loot']);
    const settings = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: { enabled: true, sections: ['progress'], allowed: { roster: true, raids: true, progress: true, attendance: true, loot: true }, path: '/#/public/g1' }, origin: 'https://r.test' });
    assert(/id="public-sec-progress" name="section" value="progress" checked/.test(settings) && text(settings).includes('Boss progress'));
    const closed = G.pages.settingsPublic.settingsHtml({ guildData: guildData(), data: { enabled: true, sections: [], allowed: { roster: true, raids: true, progress: false }, path: '/#/public/g1' } });
    assert(/id="public-sec-progress"[^>]*disabled/.test(closed));
    const view = G.pages.view.viewHtml({ kind: 'public', data: { viewer: { kind: 'public' }, guild: { name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', region: 'US', gameVersion: 'tbc' }, teams: [{ id: 't1', name: 'Alpha' }], sections: { progress: [PROGRESS] } } });
    assert(text(view).includes('Progress') && text(view).includes("Gruul's Lair") && text(view).includes('High King Maulgar'));
    assert(!/href="#\/g\//.test(view), 'no link into the guild');
    assert(view.indexOf('view-progress-h') > 0 && /<h3 class="gs-h3">Alpha<\/h3>/.test(view));
    assertNoRawAttrs(view);
  });

  // =========================================================================
  // Ranks

  const SUGGEST_PROMOTE = { kind: 'promote', from: { id: 'raider', name: 'Raider' }, to: { id: 'core', name: 'Core' }, reasons: ['attendance of 90% or more', '6 raids attended since the current rank'] };
  const SUGGEST_REVIEW = { kind: 'review', from: { id: 'raider', name: 'Raider' }, to: { id: 'member', name: 'Member' }, reasons: ['attendance 25% (the rank asks 75%)'] };

  await check('ranks: the chip says "Suggested: promote to Core" / "Suggested: review (below Raider)", with Accept and Dismiss that name the person; only a suggestion has buttons', () => {
    const R = G.pages.ranks;
    assert.equal(R.suggestionText(SUGGEST_PROMOTE), 'Suggested: promote to Core');
    assert.equal(R.suggestionText(SUGGEST_REVIEW), 'Suggested: review (below Raider)');
    assert.equal(R.suggestionText(null), '');
    const line = R.lineHtml({ id: 'p_1', name: 'Bran', rank: { id: 'raider', name: 'Raider', set: true }, rankSuggestion: SUGGEST_PROMOTE }, 't1');
    assert(text(line).includes('Rank: Raider') && text(line).includes('Suggested: promote to Core'), text(line));
    assert(/data-action="rank-accept" data-pid="p_1" data-team="t1" data-kind="promote" data-to="core" data-from="raider"/.test(line));
    assert(/data-action="rank-dismiss" data-pid="p_1" data-team="t1" data-kind="promote" data-to="core"/.test(line));
    assert(line.includes('aria-label="Accept: Promote Bran to Core"') && line.includes('aria-label="Dismiss for 30 days: Suggested: promote to Core for Bran"'));
    assert(line.includes('title="attendance of 90% or more; 6 raids attended since the current rank"'));
    const review = R.lineHtml({ id: 'p_2', name: 'Cora', rank: { id: 'raider', name: 'Raider', set: true }, rankSuggestion: SUGGEST_REVIEW }, 't1');
    assert(review.includes('aria-label="Accept: Move Cora down to Member"') && text(review).includes('Suggested: review (below Raider)'));
    // A person on the default rank carries no expected rank (the Worker has none stored); no suggestion, no buttons; no ladder, nothing.
    const plainLine = R.lineHtml({ id: 'p_3', name: 'Aria', rank: { id: 'member', name: 'Member', set: false } }, 't1');
    assert(text(plainLine).includes('Member') && !plainLine.includes('data-action'));
    assert(/data-from=""/.test(R.lineHtml({ id: 'p_3', name: 'Aria', rank: { id: 'member', name: 'Member', set: false }, rankSuggestion: SUGGEST_PROMOTE }, 't1')));
    assert.equal(R.lineHtml({ id: 'p_4', name: 'Dax' }, 't1'), '');
    assert(!R.lineHtml({ id: 'p_5', name: HOSTILE, rank: { id: 'x', name: HOSTILE, set: true }, rankSuggestion: SUGGEST_PROMOTE }, 't1').includes('<img src=x'));
    assertNoRawAttrs(line);
  });

  const teamData = (people) => ({
    team: { id: 't1', name: 'Alpha' }, today: '2027-01-15', window: 8, policy: { switchWeeks: [8, 12], defaultWeeks: 8, streakFlagAt: 4, creditValues: [] }, weeks: [{ weekStart: '2027-01-12', raids: [{ id: 'r_1', raidOn: '2027-01-12', zone: 'Karazhan' }] }],
    awaitingReview: 0, staleRaids: 0, watch: null, ladder: [{ id: 'member', name: 'Member' }, { id: 'raider', name: 'Raider' }, { id: 'core', name: 'Core' }],
    people: people || [
      { id: 'p_1', name: 'Bran', class: 'MAGE', status: 'raider', isMe: false, pct: 100, pctAll: 100, signupRate: 100, streak: 0, lastAttended: '2027-01-12', cells: [], rank: { id: 'raider', name: 'Raider', set: true }, rankSuggestion: SUGGEST_PROMOTE },
      { id: 'p_2', name: 'Aria', class: 'WARRIOR', status: 'raider', isMe: false, pct: 90, pctAll: 90, signupRate: 90, streak: 0, lastAttended: '2027-01-12', cells: [], rank: { id: 'member', name: 'Member', set: false } },
    ],
  });

  await check('Attendance page: each person\'s rank under their name on the table and the phone cards, and the suggestion where there is one; nothing when the guild has no ladder', () => {
    const gd = guildData();
    const out = G.pages.attendance.attendanceHtml({ guildData: gd, teamId: 't1', data: teamData(), view: {}, policy: null });
    assert.equal((out.match(/gs-rank-chip/g) || []).length, 4, 'two people, table and card');
    assert.equal((out.match(/data-action="rank-accept"/g) || []).length, 2, 'the one suggestion, table and card');
    assert(text(out).includes('Suggested: promote to Core'));
    const none = teamData([{ id: 'p_1', name: 'Bran', class: 'MAGE', status: 'raider', pct: 100, pctAll: 100, signupRate: 100, streak: 0, lastAttended: '2027-01-12', cells: [] }]);
    delete none.ladder;
    const bare = G.pages.attendance.attendanceHtml({ guildData: gd, teamId: 't1', data: none, view: {}, policy: null });
    assert(!bare.includes('gs-rank') && !bare.includes('rank-accept'));
    assertNoRawAttrs(out);
  });

  await check('rank handlers: Accept PUTs the suggested rank with the one the page showed, Dismiss POSTs the kind and target; both read the page again and forget the Home count; a conflict reads again too', async () => {
    const S = G.app.state;
    S.guilds.g1 = guildData(); S.currentGid = 'g1'; S.attention = { g1: { data: { total: 3 }, at: 1 } };
    const calls = [];
    await withApi({ put: (url, body) => { calls.push(['put', url, plain(body)]); return okRes({ ok: true }); }, post: (url, body) => { calls.push(['post', url, plain(body)]); return okRes({ ok: true, until: 1 }); } }, async probe => {
      const attrs = { 'data-pid': 'p_1', 'data-team': 't1', 'data-kind': 'promote', 'data-to': 'core', 'data-from': 'raider' };
      const button = el(attrs);
      G.handlers.click['rank-accept'](button);
      assert.equal(button.disabled, true, 'a second click does nothing');
      await settle();
      assert.deepEqual(calls[0], ['put', '/api/guild/g1/roster/p_1/rank', { teamId: 't1', rank: 'core', via: 'accept', expectedRank: 'raider' }]);
      assert.deepEqual(plain(probe.routed), [{ force: true }]);
      assert.equal(S.attention.g1, undefined, 'the Home count is read again');
      G.handlers.click['rank-accept'](el(Object.assign({}, attrs, { 'data-from': '' })));
      await settle();
      assert.equal(calls[1][2].expectedRank, null, 'a person with no stored rank');
      G.handlers.click['rank-dismiss'](el(attrs));
      await settle();
      assert.deepEqual(calls[2], ['post', '/api/guild/g1/roster/p_1/rank/dismiss', { teamId: 't1', kind: 'promote', to: 'core' }]);
    });
    // A conflict shows the Worker's words and reads again; another failure goes to the page alert.
    await withApi({ put: () => rejectWith(409, { error: 'conflict', message: 'Someone changed this rank. Reload and look again.' }) }, async probe => {
      const button = el({ 'data-pid': 'p_1', 'data-team': 't1', 'data-kind': 'promote', 'data-to': 'core', 'data-from': 'raider' });
      G.handlers.click['rank-accept'](button);
      await settle();
      assert.equal(S.pageAlert, 'Someone changed this rank. Reload and look again.');
      assert.deepEqual(plain(probe.routed), [{ force: true }]);
    });
    await withApi({ put: () => rejectWith(500, { error: 'server_error' }) }, async probe => {
      const button = el({ 'data-pid': 'p_1', 'data-team': 't1', 'data-kind': 'promote', 'data-to': 'core', 'data-from': '' });
      G.handlers.click['rank-accept'](button);
      await settle();
      assert.equal(button.disabled, false, 'the button comes back');
      assert.equal(probe.handled.length, 1);
    });
    S.pageAlert = '';
  });

  await check('person attendance page: the rank, a select of the ladder with Set rank (for whoever reviews a team of theirs), and the suggestion with its reasons; a member sees only the rank', async () => {
    const gd = guildData();
    const data = {
      person: { id: 'p_9', name: 'Cora', class: 'MAGE', status: 'raider', joinedOn: '2026-09-01', isMe: false, rank: { id: 'raider', name: 'Raider', set: true, on: '2026-10-01' },
        rankChoices: [{ id: 'member', name: 'Member' }, { id: 'raider', name: 'Raider' }, { id: 'core', name: 'Core' }], rankTeamId: 't1' },
      teams: [{ team: { id: 't1', name: 'Alpha' }, window: 8, metrics: {}, cells: [], rankSuggestion: SUGGEST_REVIEW }],
    };
    const out = G.pages.personAtt.personAttHtml({ guildData: gd, pid: 'p_9', data });
    assert(/<select class="gs-input gs-input-short" id="pa-rank"/.test(out) && /<option value="raider" selected>Raider<\/option>/.test(out) && out.includes('<option value="core">Core</option>'));
    assert(/data-action="rank-set" data-pid="p_9" data-team="t1" data-from="raider"/.test(out) && text(out).includes('Set rank'));
    assert(text(out).includes('Suggested: review (below Raider)') && text(out).includes('attendance 25% (the rank asks 75%)'));
    assert(/<label class="gs-label" for="pa-rank">Rank<\/label>/.test(out));
    const member = G.pages.personAtt.personAttHtml({ guildData: gd, pid: 'p_9', data: { person: Object.assign({}, data.person, { rankTeamId: null }), teams: [{ team: { id: 't1', name: 'Alpha' }, window: 8, metrics: {}, cells: [] }] } });
    assert(text(member).includes('Raider') && !member.includes('rank-set') && !member.includes('pa-rank"'), 'no way to change it');
    const none = G.pages.personAtt.personAttHtml({ guildData: gd, pid: 'p_9', data: { person: { id: 'p_9', name: 'Cora', status: 'raider' }, teams: [] } });
    assert(!none.includes('gs-rank-box'), 'no ladder, no box');
    // Set rank by hand.
    const S = G.app.state;
    S.guilds.g1 = gd; S.currentGid = 'g1';
    fields['pa-rank'] = { value: 'core' };
    const calls = [];
    await withApi({ put: (url, body) => { calls.push([url, plain(body)]); return okRes({ ok: true }); } }, async probe => {
      G.handlers.click['rank-set'](el({ 'data-pid': 'p_9', 'data-team': 't1', 'data-from': 'raider' }));
      await settle();
      assert.deepEqual(calls, [['/api/guild/g1/roster/p_9/rank', { teamId: 't1', rank: 'core', via: 'manual', expectedRank: 'raider' }]]);
      assert.equal(probe.routed.length, 1);
    });
    clearFields();
    assertNoRawAttrs(out);
  });

  await check('Home: a Rank suggestions group after the watch list, a sentence per suggestion that links to the person\'s attendance', () => {
    const A = G.pages.attention;
    const kinds = A.KINDS.map(k => k.id);
    assert(kinds.indexOf('rank') === kinds.indexOf('watch') + 1);
    const promote = { id: 'rank:t1:p_1', kind: 'rank', severity: 'action', teamId: 't1', teamName: 'Alpha', personId: 'p_1', name: 'Bran', suggestion: 'promote', from: { id: 'raider', name: 'Raider' }, to: { id: 'core', name: 'Core' }, reasons: [], link: { name: 'personatt', pid: 'p_1' } };
    const review = Object.assign({}, promote, { id: 'rank:t1:p_2', name: 'Cora', suggestion: 'review', to: { id: 'member', name: 'Member' }, link: { name: 'personatt', pid: 'p_2' } });
    assert.equal(A.itemText(promote), 'Bran: suggested promotion to Core');
    assert.equal(A.itemText(review), 'Cora: suggested review (below Raider)');
    assert.equal(A.itemHref('g1', promote), '#/g/g1/attendance/p/p_1');
    const out = A.attentionHtml({ guildData: guildData(), data: { today: '2027-01-15', total: 2, items: [promote, review], more: { rank: 3 } } });
    assert(text(out).includes('Rank suggestions') && text(out).includes('Bran: suggested promotion to Core') && text(out).includes('and 3 more'));
    assert(out.includes('>Rank<'), 'the chip');
    assert(/href="#\/g\/g1\/attendance"[^>]*>and 3 more/.test(out), 'where the rest is');
  });

  // ladder editor on Guild settings > Attendance
  const policyView = (ranks) => ({
    defaults: DEFAULT_POLICY, guild: ranks ? { ladder: { ranks } } : {}, teams: {}, resolved: {}, versions: { guild: 2, teams: {} }, resetDayDerived: 2, wcl: { guildId: null, uploaders: {} },
  });
  const STARTER = [{ id: 'member', name: 'Member', rules: {} }, { id: 'raider', name: 'Raider', rules: { minAttendance: 0.75, minWeeksAttended: 2, since: 'join' } }];
  const settingsState = (ranks, scope = 'guild') => {
    const view = policyView(ranks);
    return { gid: 'g1', view, scope, draft: JSON.parse(JSON.stringify(scope === 'guild' ? view.guild : {})), wclUi: null, stale: 0 };
  };

  await check('Attendance settings: the rank ladder editor - empty, started, with the rules of each rank; the ladder belongs to the guild default only', () => {
    const gd = guildData();
    const empty = G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(null) });
    assert(/id="pg-ladder">Rank ladder</.test(empty) && empty.includes('data-action="pol-rank-start"') && text(empty).includes('No ladder yet.'));
    const out = G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(STARTER) });
    assert((out.match(/<li class="gs-rank-row">/g) || []).length === 2);
    assert(text(out).includes('Everyone starts here.') && text(out).includes('To earn Raider, a person needs all of these that are set'));
    assert(/id="pr-minAttendance-1"[^>]*value="75"/.test(out) && /id="pr-minWeeksAttended-1"[^>]*value="2"/.test(out) && /id="pr-minRaids-1"[^>]*value=""/.test(out) && /placeholder="Off"/.test(out));
    assert(/<option value="join" selected>When they joined<\/option>/.test(out) && out.includes('When they got the rank before this one'));
    assert(!/id="pr-minAttendance-0"/.test(out), 'the first rank has no rules');
    assert(/aria-label="Move Member down"/.test(out) && /aria-label="Move Member up"[^>]*disabled/.test(out) && /aria-label="Remove Member"[^>]*disabled/.test(out), 'two ranks at least');
    assert(out.includes('data-action="pol-rank-add"') && out.includes('data-action="pol-rank-off"'));
    assert(/for="pr-n-0"/.test(out) && /for="pr-minRaids-1"/.test(out), 'labels for the controls');
    const six = Array.from({ length: 6 }, (_, i) => ({ id: 'rank' + String.fromCharCode(97 + i), name: 'R' + i, rules: {} }));
    assert(/data-action="pol-rank-add"[^>]*disabled/.test(G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(six) })), 'six at most');
    const team = G.pages.settingsAtt.settingsHtml({ guildData: gd, s: settingsState(STARTER, 't1') });
    assert(text(team).includes('The rank ladder belongs to the whole guild') && !team.includes('pol-rank-add'), 'a team override does not edit it');
    assertNoRawAttrs(out);
  });

  await check('ladder editor handlers: start, add, rename, set a rule (empty = off, percent -> fraction), move, remove, turn off; and Save sends the whole ladder', async () => {
    const S = G.app.state;
    S.guilds.g1 = guildData(); S.currentGid = 'g1';
    const a = G.pages.attendance.attState();
    a.settingsAtt = settingsState(null);
    const s = a.settingsAtt;
    const savedRender = G.app.render;
    G.app.render = () => {};
    const savedFocus = G.ui.focusByKey;
    G.ui.focusByKey = () => {};
    const ranks = () => plain(s.draft.ladder && s.draft.ladder.ranks);
    try {
      G.handlers.click['pol-rank-start'](el({}));
      assert.deepEqual(ranks(), STARTER);
      G.handlers.click['pol-rank-add'](el({}));
      assert.deepEqual(ranks()[2], { id: 'rank', name: 'New rank', rules: { since: 'join' } });
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'name' }), { value: '  Core Raider  ' }));
      assert.equal(ranks()[2].name, 'Core Raider', 'the id stays');
      assert.equal(ranks()[2].id, 'rank');
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'minRaids' }), { value: '8' }));
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'since' }), { value: 'rank' }));
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'minAttendance' }), { value: '90' }));
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'maxMissed' }), { value: '99999' }));
      assert.deepEqual(ranks()[2].rules, { since: 'rank', minRaids: 8, minAttendance: 0.9, maxMissed: 100 }, 'clamped to what the Worker takes');
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'minRaids' }), { value: '' }));
      assert.equal(ranks()[2].rules.minRaids, null, 'an empty box turns the rule off');
      G.handlers.change['pol-rank'](Object.assign(el({ 'data-idx': '2', 'data-field': 'name' }), { value: '   ' }));
      assert.equal(ranks()[2].name, 'Core Raider', 'a blank name changes nothing');
      G.handlers.click['pol-rank-move'](el({ 'data-idx': '2', 'data-dir': '-1', 'data-key': 'pr-up-2' }));
      assert.deepEqual(ranks().map(r => r.id), ['member', 'rank', 'raider']);
      G.handlers.click['pol-rank-remove'](el({ 'data-idx': '1' }));
      assert.deepEqual(ranks().map(r => r.id), ['member', 'raider']);
      G.handlers.click['pol-rank-remove'](el({ 'data-idx': '1' }));
      assert.equal(ranks().length, 2, 'two ranks are the least');
      // Save: the guild default stores only the differences; the ladder is one value.
      const sent = [];
      const form = Object.assign(formEl({}), { querySelectorAll: () => [] });
      field('pol-error');
      await withApi({ put: (url, body) => { sent.push([url, plain(body)]); return Promise.reject(new G.api.ApiError(500, { error: 'server_error' })); } }, async () => {
        G.handlers.submit['pol-form'](form);
        await settle();
      });
      assert.equal(sent[0][0], '/api/guild/g1/attendance/policy');
      assert.deepEqual(sent[0][1].policy, { ladder: { ranks: STARTER } });
      assert.equal(sent[0][1].teamId, null);
      assert.equal(sent[0][1].expectedVersion, 2);
      G.handlers.click['pol-rank-off'](el({}));
      assert.deepEqual(ranks(), []);
      // In a team scope the handlers do nothing.
      s.scope = 't1'; s.draft = {};
      G.handlers.click['pol-rank-start'](el({}));
      assert.deepEqual(s.draft, {});
    } finally {
      G.app.render = savedRender; G.ui.focusByKey = savedFocus; a.settingsAtt = null; clearFields();
    }
  });

  await check('wave 7 wiring: the new scripts are in the manifest after the pages they extend; no inline styles or handlers; the styles exist', () => {
    const manifest = GUILD_SCRIPTS.map(s => s.replace('/js/guild/', ''));
    for (const [file, after] of [['pages-settings-dataaccess.js', 'pages-settings-guests.js'], ['pages-progress.js', 'pages-raids.js'], ['pages-ranks.js', 'pages-person-attendance.js']]) {
      assert(manifest.indexOf(file) > manifest.indexOf(after) && manifest.indexOf(file) < manifest.indexOf('app.js'), file);
    }
    for (const cls of ['gs-prog-board', 'gs-table-prog', 'gs-rank-line', 'gs-rank-suggest', 'gs-rank-list', 'gs-rank-row', 'gs-rank-rules', 'gs-rank-rule', 'gs-rank-set']) assert(css.includes('.' + cls), cls);
    for (const file of ['pages-settings-dataaccess.js', 'pages-progress.js', 'pages-ranks.js']) assert(!/\sstyle=|\sonclick=/.test(read('js/guild/' + file)), file);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
