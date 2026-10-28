/**
 * Raidsmith guild UI, Phase 5 (Battle.net) - tests for the Linked accounts and My characters pages, the Character claims group on the
 * review queue, the Battle.net guild roster import page and the Guild settings > Battle.net tab.
 * Run: node tests/guild/guild-bnet-ui-tests.js
 *
 * Same approach as guild-roster-ui-tests.js: the shared guild script list (tests/guild-scripts.js) is loaded in a vm sandbox with no DOM,
 * the render functions return HTML strings, and handlers that talk to the API run against a stubbed G.api. The routes through the real
 * router (#/linked, #/characters, the import and settings pages) are driven in guild-shell-tests.js against fake documents.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS, guildScriptsOf } = require('../guild-scripts');
const css = read('guild.css');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout };
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
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 17, 12);

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// ── fixtures (the Worker's response shapes) ──────────────────────
function character(name, cls, level, extra) {
  return Object.assign({ name, realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: cls, level, state: 'new', claim: null, claimable: true }, extra || {});
}
function guildEntry(extra) {
  return Object.assign({
    guildId: 'g1', guildName: 'Ember', gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', realmKind: 'realm', supportLabel: 'TBC Anniversary',
    status: 'ok', message: null,
    characters: [
      character('Aldric', 'WARRIOR', 70, { state: 'yours', claimable: false }),
      character('Brindle', 'MAGE', 70, { state: 'on_roster' }),
      character('Cassia', 'PRIEST', 68, { realm: 'Nightslayer', realmSlug: 'nightslayer' }),
      character('Dunmar', 'HUNTER', 70, { state: 'taken', claimable: false }),
      character('Eliora', 'PALADIN', 61, { claim: { id: 'cl_1', status: 'pending' }, claimable: false }),
      character('Fenwick', 'ROGUE', 12, { claim: { id: 'cl_2', status: 'rejected' } }),
      character('Stranger', 'MAGE', 70, { realm: 'Faraway Isle', realmSlug: 'faraway-isle', state: 'other_realm', claimable: false }),
    ],
  }, extra || {});
}
function bnetData(extra) {
  return Object.assign({
    configured: true,
    link: { battletag: 'Tester#1234', linkedAt: T0, fetchedAt: T0, expiresAt: T0 + 30 * DAY },
    guilds: [guildEntry()],
  }, extra || {});
}

const TEAMS = [{ id: 't1', name: 'Alpha', size: 25, archived: false }, { id: 't2', name: 'Bravo', size: 25, archived: false }, { id: 't3', name: 'Old', size: 25, archived: true }];
function guildData(can, extra) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', realmSlug: 'dreamscythe', region: 'US', timeZone: 'UTC', gameVersion: 'tbc', createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({ players: 0, leads: [] }, t)),
    me: { roles: [{ role: 'officer' }], can: can || { 'roster.edit': 'guild', 'guild.teams': 'guild', 'attendance.review': 'guild' } },
    rosterOptions: null,
  }, extra || {});
}

function withApi(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = G.api[k]; G.api[k] = stubs[k]; }
  const savedGo = G.app.go;
  const hashes = [];
  G.app.go = h => hashes.push(h);
  return Promise.resolve(fn(hashes)).finally(() => { for (const k of Object.keys(saved)) G.api[k] = saved[k]; G.app.go = savedGo; });
}
const el = attrs => ({ disabled: false, getAttribute: k => (attrs || {})[k] });

(async () => {
  // ── router ─────────────────────────────────────────────────────
  await check('router: #/linked (with a known error only), #/characters, the Battle.net import and settings tab parse and format back', () => {
    const p = h => plain(G.router.parse(h));
    assert.deepEqual(p('#/linked'), { name: 'linked', error: null });
    assert.deepEqual(p('#/linked?error=denied'), { name: 'linked', error: 'denied' });
    for (const e of G.router.LINKED_ERRORS) assert.equal(p('#/linked?error=' + e).error, e, e);
    assert.deepEqual(plain(G.router.LINKED_ERRORS), ['denied', 'state', 'bnet', 'not_configured', 'busy', 'taken', 'discord', 'discord_taken', 'has_discord', 'has_bnet', 'roster_conflict', 'fresh_required']);
    assert.deepEqual(p('#/linked?error=<script>'), { name: 'linked', error: null });
    assert.deepEqual(p('#/characters'), { name: 'characters' });
    assert.deepEqual(p('#/g/g1/roster/import/bnet'), { name: 'import', gid: 'g1', source: 'bnet' });
    assert.deepEqual(p('#/g/g1/settings/battlenet'), { name: 'settings', gid: 'g1', tab: 'battlenet' });
    for (const h of ['#/linked/x', '#/characters/x', '#/g/g1/roster/import/battlenet', '#/g/g1/settings/bnet']) assert.deepEqual(p(h), { name: 'notfound' }, h);
    for (const route of [{ name: 'linked', error: null }, { name: 'linked', error: 'taken' }, { name: 'characters' }, { name: 'import', gid: 'g1', source: 'bnet' }, { name: 'settings', gid: 'g1', tab: 'battlenet' }]) {
      assert.deepEqual(p(G.router.format(route)), route, JSON.stringify(route));
    }
    assert.equal(G.router.format({ name: 'linked', error: 'nope' }), '#/linked');
    assert.deepEqual(plain(G.router.IMPORT_SOURCES), ['raid-helper', 'wcl', 'bnet', 'csv']);
  });

  await check('shell: the Battle.net settings tab follows guild.teams; the crumbs and the import menu know the new pages', () => {
    const tabs = can => plain(G.shell.settingsTabs(can).map(t => t.tab));
    assert.deepEqual(tabs({ 'guild.teams': 'guild' }), ['general', 'teams', 'notifications', 'applications', 'battlenet']);
    assert.deepEqual(tabs({ 'guild.access': 'guild' }), ['links']);
    assert.deepEqual(tabs({ 'attendance.policy': 'guild' }), ['attendance']);
    assert.deepEqual(tabs({ 'guild.teams': 'guild', 'guild.access': 'guild', 'attendance.policy': 'guild' }), ['general', 'teams', 'links', 'attendance', 'notifications', 'applications', 'battlenet']);
    const gd = guildData();
    const crumbs = (route, extra) => plain(G.shell.breadcrumbItems(Object.assign({ section: 'guild', page: 'app', me: { user: {} }, route, guildData: gd, teamId: 't1' }, extra)).map(c => c.label));
    assert.deepEqual(crumbs({ name: 'linked' }), ['Linked accounts']);
    assert.deepEqual(crumbs({ name: 'characters' }), ['My characters']);
    assert.deepEqual(crumbs({ name: 'linked' }, { signedOut: true, me: null }), ['Sign in']);
    assert.deepEqual(crumbs({ name: 'import', gid: 'g1', source: 'bnet' }), ['Ember', 'Alpha', 'Roster', 'Import from Battle.net']);
    assert.deepEqual(crumbs({ name: 'import', gid: 'g1', source: 'wcl' }).slice(-1), ['Import from Warcraft Logs']);
    assert.deepEqual(crumbs({ name: 'settings', gid: 'g1', tab: 'battlenet' }).slice(-2), ['Guild settings', 'Battle.net']);
    const menu = G.pages.roster.importMenuHtml ? G.pages.roster.importMenuHtml('g1') : '';
    assert(menu.includes('href="#/g/g1/roster/import/bnet"') && menu.includes('Import from the Battle.net guild roster'), 'Import menu');
  });

  // ── Linked accounts ────────────────────────────────────────────
  await check('Linked accounts: not connected = what is read and kept, and a plain Connect link to /auth/bnet/login', () => {
    const out = G.pages.bnet.linkedHtml({ data: bnetData({ link: null }) });
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Linked accounts</h1>'));
    assert(/<a class="gs-btn" href="\/auth\/bnet\/login"[^>]*>[\s\S]*Connect Battle\.net/.test(out), 'a quiet link: connecting is optional, so it is not the page primary');
    assert(!out.includes('gs-btn-molten'), 'one primary per screen: none on this page');
    const t = text(out);
    for (const s of ['Not connected', 'never sees your password', 'keeps that list for 30 days', 'Disconnect any time']) assert(t.includes(s), s);
    assert(!out.includes('data-action="bnet-disconnect-open"'));
    assertNoRawAttrs(out);
  });

  await check('Linked accounts: connected = BattleTag, the load and delete dates, My characters, Refresh and Disconnect', () => {
    const out = G.pages.bnet.linkedHtml({ data: bnetData() });
    const t = text(out);
    assert(t.includes('Connected') && t.includes('Tester#1234'));
    assert(t.includes('loaded Oct 17, 2026') && t.includes('deletes them on Nov 16, 2026'), t);
    assert(out.includes('href="#/characters"') && out.includes('Refresh characters') && out.includes('href="/auth/bnet/login"'));
    assert(/data-action="bnet-disconnect-open"/.test(out));
    assert(out.includes('href="#/privacy"'));
  });

  await check('Linked accounts: loading, a server without Battle.net set up, and every error the link can come back with', () => {
    assert(G.pages.bnet.linkedHtml({ data: null }).includes('Loading'));
    const off = G.pages.bnet.linkedHtml({ data: bnetData({ configured: false, link: null }) });
    assert(off.includes('id="bnet-not-set-up"') && text(off).includes("Battle.net isn't set up on this server."));
    assert(!off.includes('/auth/bnet/login'), 'no Connect link when it cannot work');
    for (const key of G.router.LINKED_ERRORS) {
      const out = G.pages.bnet.linkedHtml({ data: bnetData({ link: null }), error: key });
      assert(out.includes('id="bnet-link-error"') && out.includes('role="alert"'), key);
      assert(text(out).includes(text(G.pages.bnet.LINK_ERROR_TEXT[key])), key);
    }
    assert(!G.pages.bnet.linkedHtml({ data: bnetData(), error: 'nope' }).includes('bnet-link-error'));
    assert(G.pages.bnet.linkedHtml({ data: bnetData(), notice: 'Battle.net disconnected.' }).includes('Battle.net disconnected.'));
  });

  await check('Linked accounts: Disconnect asks first (what is deleted, what stays), then sends DELETE /auth/bnet and reloads with a notice', async () => {
    const dialog = G.pages.bnet.disconnectDialogHtml();
    assert(text(dialog).includes('deletes your BattleTag and your character list from Raidsmith now') && dialog.includes('data-submit="bnet-disconnect-form"'));
    assert(text(dialog).includes('Claims you already sent stay with your officers'));
    G.app.state.bnet = { data: bnetData(), notice: '', alert: '' };
    const calls = [];
    const closed = [];
    const realClose = G.ui.closeDialogOf;
    G.ui.closeDialogOf = f => closed.push(f);
    await withApi({
      del: (url, body) => { calls.push(['DELETE', url, plain(body)]); return Promise.resolve({ ok: true }); },
      get: url => { calls.push(['GET', url]); return Promise.resolve(bnetData({ link: null })); },
    }, async () => {
      G.handlers.submit['bnet-disconnect-form']({ querySelectorAll: () => [], elements: {} });
      await tick(); await tick();
    });
    G.ui.closeDialogOf = realClose;
    // The account's sign-ins changed too, so /auth/me is read again with the page (Phase 7a).
    assert.deepEqual(calls, [['DELETE', '/auth/bnet', {}], ['GET', '/auth/me'], ['GET', '/auth/bnet']]);
    assert.equal(closed.length, 1);
    assert.equal(G.app.state.bnet.data.link, null);
    assert.equal(G.app.state.bnet.notice, 'Battle.net disconnected. Your BattleTag and character list are deleted.');
  });

  // ── My characters ──────────────────────────────────────────────
  await check('My characters: one card per guild, class-coloured names, level, realm, and a status or action for every state', () => {
    const out = G.pages.bnet.charactersHtml({ data: bnetData() });
    assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">My characters</h1>'));
    assert(out.includes('id="chars-g1"') && text(out).includes('Ember') && text(out).includes('TBC Anniversary'));
    const rows = out.split('<tr class="gs-dtable-row').slice(1).filter(r => r.includes('<th scope="row"'));
    assert.equal(rows.length, 7);
    const row = name => rows.find(r => r.includes('>' + name + '</span>'));
    assert(row('Aldric').includes('On your record') && !row('Aldric').includes('<button'));
    assert(row('Brindle').includes('On the roster, not linked to anyone') && row('Brindle').includes('data-action="bnet-claim"'));
    assert(row('Cassia').includes('aria-label="Add Cassia"') && row('Cassia').includes('<span>Add</span>') && row('Cassia').includes('data-action="bnet-claim"') && row('Cassia').includes('data-realm="nightslayer"') && row('Cassia').includes('Nightslayer'));
    assert(row('Dunmar').includes('On someone else&#39;s record') && !row('Dunmar').includes('<button'));
    assert(row('Eliora').includes('Needs an officer') && row('Eliora').includes('aria-label="Withdraw the request for Eliora"') && row('Eliora').includes('data-action="bnet-withdraw"') && row('Eliora').includes('data-claim="cl_1"') && !row('Eliora').includes('bnet-claim"'));
    assert(row('Fenwick').includes('An officer turned this down before') && row('Fenwick').includes('data-action="bnet-claim"'));
    assert(row('Stranger').includes('Another realm') && !row('Stranger').includes('<button'));
    assert(row('Aldric').includes('gs-class-warrior') && row('Brindle').includes('gs-class-mage'));
    assert(row('Aldric').includes('>70<') && row('Fenwick').includes('>12<'));
    assert(row('Aldric').includes('data-label="Level"') && row('Aldric').includes('data-label="Realm"'), 'phone labels');
    assert(out.includes('gs-dtable') && !out.includes('gs-btn-molten'), 'the data table (cards on a phone); Claim is a quiet button, not orange');
    const delivered = guildEntry().characters.slice().reverse();
    const rev = G.pages.bnet.charactersHtml({ data: bnetData({ guilds: [guildEntry({ characters: delivered })] }) });
    assert(rev.indexOf('>Aldric</span>') > rev.indexOf('>Brindle</span>'), 'your own character keeps the delivered order, it is not moved first');
    assert(rev.split('<tr class="gs-dtable-row').find(r => r.includes('>Aldric</span>')).includes('On your record'), 'the yours state stays on its row');
    assertNoRawAttrs(out);
  });

  await check('My characters: a missing level shows a dash, an approved claim reads "Approved"', () => {
    const none = G.pages.bnet.charactersHtml({ data: bnetData({ guilds: [guildEntry({ characters: [character('Nolevel', 'DRUID', null)] })] }) });
    assert(none.includes('gs-muted gs-dash">-<'));
    assert.equal(G.pages.bnet.stateText(character('Aldric', 'WARRIOR', 70, { state: 'yours', claim: { id: 'cl_9', status: 'approved' }, claimable: false })), 'Approved');
    assert.equal(G.pages.bnet.stateText(character('X', 'MAGE', 1, { state: 'new', claim: { id: 'cl_9', status: 'approved' } })), '');
  });

  await check('My characters: every state a guild can be in says what to do - unsupported version, not linked, joined later, a failed namespace, nothing found', () => {
    const body = entry => G.pages.bnet.charactersHtml({ data: bnetData({ guilds: [entry] }) });
    const unsupported = body(guildEntry({ guildName: 'Fresh', gameVersion: 'forever', supportLabel: 'WoW Forever', realmKind: 'ruleset', realm: 'Normal', status: 'unsupported', characters: [], message: "Battle.net doesn't offer character data for WoW Forever yet." }));
    assert(text(unsupported).includes("Battle.net doesn't offer character data for WoW Forever yet.") && unsupported.includes('data-status="unsupported"') && !unsupported.includes('Connect again'));
    assert(text(unsupported).includes('Normal ruleset'));
    assert(body(guildEntry({ status: 'not_linked', characters: [] })).includes('data-status="not_linked"'));
    const refresh = body(guildEntry({ status: 'needs_refresh', characters: [] }));
    assert(refresh.includes('data-status="needs_refresh"') && text(refresh).includes('You joined this guild after you connected Battle.net') && refresh.includes('href="/auth/bnet/login"'));
    const unavailable = body(guildEntry({ status: 'unavailable', characters: [] }));
    assert(unavailable.includes('data-status="unavailable"') && unavailable.includes('Connect again'));
    const empty = body(guildEntry({ characters: [] }));
    assert(empty.includes('data-status="empty"') && text(empty).includes('log out of the game completely'));
  });

  await check('My characters: not connected, not set up, no guild and loading', () => {
    const notLinked = G.pages.bnet.charactersHtml({ data: bnetData({ link: null }) });
    assert(text(notLinked).includes('Connect Battle.net to see your characters') && notLinked.includes('href="/auth/bnet/login"'));
    assert(G.pages.bnet.charactersHtml({ data: bnetData({ configured: false, link: null }) }).includes('id="bnet-not-set-up"'));
    assert(text(G.pages.bnet.charactersHtml({ data: bnetData({ guilds: [] }) })).includes('You are not in a Raidsmith guild yet'));
    assert(G.pages.bnet.charactersHtml({ data: null }).includes('Loading'));
    const intro = G.pages.bnet.charactersHtml({ data: bnetData() });
    assert(text(intro).includes('Add the characters that are yours. They go on your profile at once.') && !text(intro).includes('officers approve each claim') && text(intro).includes('deleted on Nov 16, 2026'));
    assert(G.pages.bnet.charactersHtml({ data: bnetData(), notice: 'Claim sent: Eliora.' }).includes('Claim sent: Eliora.'));
  });

  await check('hostile names: BattleTag, guild, character, realm and notices come out escaped on both pages', () => {
    const evil = guildEntry({ guildName: HOSTILE + QUOTES, realm: HOSTILE, characters: [character(HOSTILE + QUOTES, 'MAGE', 70, { realm: HOSTILE + QUOTES, realmSlug: 'x" onfocus="alert(1)', claim: { id: 'cl_" onfocus="alert(1)', status: 'pending' }, claimable: false })] });
    const data = bnetData({ link: { battletag: HOSTILE + QUOTES, linkedAt: T0, fetchedAt: T0, expiresAt: T0 + 30 * DAY }, guilds: [evil] });
    assertEscaped(G.pages.bnet.linkedHtml({ data, notice: HOSTILE + QUOTES, alert: HOSTILE + QUOTES }), 'linked');
    assertEscaped(G.pages.bnet.charactersHtml({ data, notice: HOSTILE + QUOTES, alert: HOSTILE + QUOTES }), 'characters');
    assertNoRawAttrs(G.pages.bnet.charactersHtml({ data }));
  });

  await check('claim: Claim sends the one character, then reloads GET /auth/bnet with a notice; Withdraw deletes the claim', async () => {
    G.app.state.bnet = { data: bnetData(), notice: '', alert: '' };
    const calls = [];
    const button = el({ 'data-gid': 'g1', 'data-name': 'Cassia', 'data-realm': 'nightslayer' });
    await withApi({
      post: (url, body) => { calls.push(['POST', url, plain(body)]); return Promise.resolve({ claims: [{ id: 'cl_3' }] }); },
      get: url => { calls.push(['GET', url]); return Promise.resolve(bnetData()); },
      del: (url, body) => { calls.push(['DELETE', url, plain(body)]); return Promise.resolve({ ok: true }); },
    }, async () => {
      G.handlers.click['bnet-claim'](button);
      await tick(); await tick();
      assert.equal(button.disabled, true, 'the button stays off while the request runs');
      G.handlers.click['bnet-withdraw'](el({ 'data-gid': 'g1', 'data-name': 'Eliora', 'data-claim': 'cl_1' }));
      await tick(); await tick();
    });
    assert.deepEqual(calls[0], ['POST', '/api/guild/g1/claims', { characters: [{ name: 'Cassia', realmSlug: 'nightslayer' }] }]);
    assert.deepEqual(calls[1], ['GET', '/auth/bnet']);
    assert.deepEqual(calls[2], ['DELETE', '/api/guild/g1/claims/cl_1', {}]);
    assert.equal(G.app.state.bnet.notice, 'Request for Eliora withdrawn.');
  });

  await check('claim: a refused claim shows the server message on the page and turns the button back on', async () => {
    G.app.state.bnet = { data: bnetData(), notice: '', alert: '' };
    const button = el({ 'data-gid': 'g1', 'data-name': 'Cassia', 'data-realm': 'nightslayer' });
    await withApi({ post: () => Promise.reject(new G.api.ApiError(409, { error: 'claim_pending', message: 'Cassia already has a claim waiting for officers.' })) }, async () => {
      G.handlers.click['bnet-claim'](button);
      await tick(); await tick();
    });
    assert.equal(button.disabled, false);
    assert.equal(G.app.state.bnet.alert, 'Cassia already has a claim waiting for officers.');
    const out = G.pages.bnet.charactersHtml({ data: G.app.state.bnet.data, alert: G.app.state.bnet.alert });
    assert(out.includes('Cassia already has a claim waiting for officers.') && out.includes('role="alert"'));
  });

  // ── Character claims on the review queue ───────────────────────
  function claim(id, name, cls, plan, extra) {
    return Object.assign({
      id, character: { name, realm: 'Dreamscythe', class: cls, level: 61 }, claimedAt: T0 - 3 * DAY,
      claimant: { id: 'u9', username: 'erin', displayName: 'Erin E', avatarUrl: null, initials: 'EE' },
      plan: Object.assign({ kind: 'add_alt', reason: null, message: null, person: { id: 'p1', name: 'Aldric' }, defaultTeamId: 't1', canDecide: true }, plan || {}),
    }, extra || {});
  }
  const reviewData = { team: 't1', raids: [], stale: [] };
  const reviewOpts = (claims, can) => ({ guildData: guildData(can), teamId: 't1', data: reviewData, filter: 'all', claims });

  await check('Character claims: a group above the flags, each claim with who claimed what and what approving does', () => {
    const claims = [
      claim('cl_a', 'Eliora', 'PALADIN'),
      claim('cl_b', 'Galdor', 'WARLOCK', { kind: 'new_person', person: null, defaultTeamId: null }),
      claim('cl_c', 'Brindle', 'MAGE', { kind: 'link_person', person: { id: 'p2', name: 'Brindle' }, defaultTeamId: null }),
      claim('cl_d', 'Dunmar', 'HUNTER', { kind: 'already', person: { id: 'p3', name: 'Dunmar' }, defaultTeamId: null }),
      claim('cl_e', 'Cassia', 'PRIEST', { kind: 'blocked', reason: 'other_person', message: 'Merge them by hand.', person: null, defaultTeamId: null, canDecide: false }),
    ];
    // The page words claim ages against the wall clock: pin it to T0 so '3 days ago' does not depend on the day the suite runs.
    const realNow = Date.now;
    Date.now = () => T0;
    let out;
    try { out = G.pages.review.reviewHtml(reviewOpts(claims)); } finally { Date.now = realNow; }
    assert(out.includes('id="claims-section"') && out.includes('<h2 class="gs-h2" id="claims-h">Character claims</h2>') && text(out).includes('5 claims waiting'));
    assert(out.indexOf('claims-section') < out.indexOf('review-no-flags'), 'claims come before the flags');
    assert(text(out).includes('No open attendance flags.') && !out.includes('Nothing to review'), 'the empty card only shows when nothing at all is waiting');
    assert(text(out).includes('0 open flags on 0 raids') && text(out).includes('5 character claims'));
    const t = text(out);
    assert(t.includes("Approving adds Eliora to Aldric's record as an Alt."), t);
    assert(t.includes("Approving creates a new person with Galdor as their Main, linked to Erin E's Discord account."));
    assert(t.includes("Brindle is already on the roster on Brindle's record. Approving links Erin E's Discord account to Brindle."));
    assert(t.includes("Dunmar is already on Erin E's record. Approving only closes the claim."));
    assert(t.includes('Merge them by hand.') && out.includes('gs-cclaim-plan is-blocked'));
    assert(t.includes('Claimed by Erin E 3 days ago') && t.includes('Paladin, level 61, Dreamscythe'));
    const item = id => out.split('<li class="gs-review-item gs-cclaim-item">').slice(1).find(x => x.includes('data-claim="' + id + '"'));
    assert(!item('cl_a').includes('name="teamId"') && !item('cl_a').includes('claim-team-') && !item('cl_a').includes('name="status"') && item('cl_a').includes('data-kind="add_alt"'), 'an Alt starts on no team: no Team picker');
    assert(item('cl_b').includes('name="teamId"') && item('cl_b').includes('name="status"') && /<option value="trial" selected>/.test(item('cl_b')));
    assert(!item('cl_c').includes('name="teamId"') && item('cl_c').includes('data-kind="link_person"') && item('cl_c').includes('>Approve<'));
    assert(!item('cl_d').includes('name="teamId"') && item('cl_d').includes('data-kind="already"'));
    assert(!item('cl_e').includes('>Approve<') && item('cl_e').includes('data-action="claim-reject"'), 'a blocked claim can only be rejected');
    assert(item('cl_a').includes('data-action="claim-reject"'));
    assertNoRawAttrs(out);
  });

  await check('Character claims: the team picker lists only active teams the viewer can edit, preselecting the person\'s own team', () => {
    const lead = reviewOpts([claim('cl_a', 'Eliora', 'PALADIN', { kind: 'new_person', person: null, defaultTeamId: 't1' }), claim('cl_b', 'Galdor', 'WARLOCK', { defaultTeamId: 't1' })], { 'roster.edit': ['t2'], 'attendance.review': ['t1'] });
    const out = G.pages.review.reviewHtml(lead);
    const opts = html => [...html.matchAll(/<option value="([^"]*)"( selected)?>/g)].map(m => m[1] + (m[2] ? '*' : ''));
    const [a, b] = out.split('<li class="gs-review-item gs-cclaim-item">').slice(1);
    assert.deepEqual(opts(a.slice(a.indexOf('name="teamId"'), a.indexOf('</select>'))), ['t2*'], 'the lead of Bravo sees Bravo only; Alpha is not theirs, Old is archived');
    const officer = G.pages.review.reviewHtml(reviewOpts([claim('cl_a', 'Eliora', 'PALADIN', { kind: 'new_person', person: null, defaultTeamId: 't2' })]));
    assert.deepEqual(opts(officer.slice(officer.indexOf('name="teamId"'), officer.indexOf('</select>'))), ['t1', 't2*']);
    assert(!b.includes('name="teamId"'), 'an Alt claim has no Team picker for anyone');
    const other = G.pages.review.reviewHtml(reviewOpts([claim('cl_a', 'Eliora', 'PALADIN', { canDecide: false })]));
    assert(text(other).includes("Another team's lead decides this one") && !other.includes('>Approve<') && other.includes('claim-reject'));
  });

  await check('Character claims: none = no group, the usual empty card stays; claims that failed to load say so without hiding the flags', () => {
    assert(!G.pages.review.reviewHtml(reviewOpts([])).includes('claims-section'));
    assert(G.pages.review.reviewHtml(reviewOpts([])).includes('Nothing to review'));
    assert(!G.pages.review.reviewHtml(reviewOpts(undefined)).includes('claims-section'));
    const failed = G.pages.review.reviewHtml(reviewOpts(null));
    assert(failed.includes('id="claims-error"') && failed.includes('Nothing to review'));
    assert(G.pages.review.claimsSectionHtml(guildData(), []) === '' && G.pages.review.claimsSectionHtml(guildData(), undefined) === '');
    assertEscaped(G.pages.review.reviewHtml(reviewOpts([claim('cl_a', HOSTILE + QUOTES, 'MAGE', { person: { id: 'p1', name: HOSTILE + QUOTES } }, { claimant: { displayName: HOSTILE + QUOTES } })])), 'claims');
  });

  await check('Review queue: loot winners not on the roster and character claims show together; the sub line counts both', () => {
    const loot = [{ raid: { id: 'r1', raidOn: '2026-10-10' }, items: [{ kind: 'unmatched', key: 'veyla|ashmere', name: 'Veyla', realm: 'Ashmere', class: 'MAGE', awards: 2 }] }];
    const out = G.pages.review.reviewHtml(Object.assign(reviewOpts([claim('cl_a', 'Eliora', 'PALADIN')]), { lootGroups: loot }));
    const t = text(out);
    assert(out.includes('id="claims-section"') && t.includes('Loot winners not on the roster') && t.includes('Veyla'), 'both groups are drawn');
    assert(out.indexOf('claims-section') < out.indexOf('Loot winners not on the roster'), 'claims come first, then the flags and loot winners');
    assert(t.includes('0 open flags on 0 raids') && t.includes('1 loot winner to link') && t.includes('1 character claim'), t);
    assert(!out.includes('Nothing to review') && !t.includes('No open attendance flags.'), 'loot winners are something to review');
    assertNoRawAttrs(out);
  });

  function reviewState(claims) {
    const s = G.app.state;
    s.guilds.g1 = guildData();
    s.currentGid = 'g1';
    s.pageAlert = '';
    s.att = { review: { gid: 'g1', teamId: 't1', data: reviewData, claims, filter: 'all' }, note: '' };
    return s;
  }
  const formEl = (attrs, values) => ({ getAttribute: k => attrs[k], elements: values, querySelectorAll: () => [] });

  await check('Character claims: Approve sends what the page saw (expectedKind) with the team and status, then reloads the queue with a note', async () => {
    const s = reviewState([claim('cl_b', 'Galdor', 'WARLOCK', { kind: 'new_person', person: null, defaultTeamId: null })]);
    const calls = [];
    await withApi({
      post: (url, body) => { calls.push(['POST', url, plain(body)]); return Promise.resolve({ claim: { id: 'cl_b', status: 'approved' }, outcome: 'new_person', personId: 'p9', rosterFlags: { t1: 3 } }); },
      get: url => {
        calls.push(['GET', url]);
        return Promise.resolve(url.indexOf('/claims') >= 0 ? { claims: [] } : reviewData);
      },
    }, async () => {
      G.handlers.submit['claim-approve'](formEl({ 'data-claim': 'cl_b', 'data-kind': 'new_person' }, { teamId: { value: 't2' }, status: { value: 'raider' } }));
      await tick(); await tick(); await tick();
    });
    assert.deepEqual(calls[0], ['POST', '/api/guild/g1/claims/cl_b/approve', { expectedKind: 'new_person', teamId: 't2', status: 'raider' }]);
    assert(calls.some(c => c[1] === '/api/guild/g1/claims') && calls.some(c => String(c[1]).indexOf('/attendance/review?team=t1') >= 0), 'the queue is read again');
    assert.equal(s.att.note, 'Approved: Galdor joined the roster as a new person.');
    assert.deepEqual(plain(s.att.review.claims), []);
    assert.equal(s.guilds.g1.rosterFlags.t1, 3, 'the Roster badge follows the reply');
  });

  await check('Character claims: approving an Alt sends no team (it starts on no team); a new person sends the picked one', async () => {
    const s = reviewState([claim('cl_a', 'Eliora', 'PALADIN')]);
    const calls = [];
    await withApi({ post: (url, body) => { calls.push(plain(body)); return Promise.resolve({ outcome: 'add_alt' }); }, get: url => Promise.resolve(url.indexOf('/claims') >= 0 ? { claims: [] } : reviewData) }, async () => {
      const form = G.pages.review.reviewHtml(reviewOpts(s.att.review.claims)).split('<li class="gs-review-item gs-cclaim-item">')[1];
      assert(!/<select[^>]*name="teamId"/.test(form));
      G.handlers.submit['claim-approve'](formEl({ 'data-claim': 'cl_a', 'data-kind': 'add_alt' }, {}));
      await tick(); await tick(); await tick();
    });
    assert.deepEqual(calls, [{ expectedKind: 'add_alt' }]);
  });

  await check('Character claims: the message for each approval outcome, and Reject posts to /reject', async () => {
    const s = reviewState([claim('cl_a', 'Eliora', 'PALADIN'), claim('cl_c', 'Brindle', 'MAGE', { kind: 'link_person', person: { id: 'p2', name: 'Brindle' } })]);
    const notes = [];
    for (const [id, kind, outcome, expected] of [
      ['cl_a', 'add_alt', 'add_alt', 'Approved: Eliora joined the roster as an Alt.'],
      ['cl_c', 'link_person', 'link_person', 'Approved: Erin E is now linked to Brindle.'],
      ['cl_a', 'already', 'already', 'Closed the claim on Eliora.'],
    ]) {
      s.att.review.claims = [claim('cl_a', 'Eliora', 'PALADIN'), claim('cl_c', 'Brindle', 'MAGE', { kind: 'link_person', person: { id: 'p2', name: 'Brindle' } })];
      await withApi({ post: () => Promise.resolve({ outcome }), get: url => Promise.resolve(url.indexOf('/claims') >= 0 ? { claims: [] } : reviewData) }, async () => {
        G.handlers.submit['claim-approve'](formEl({ 'data-claim': id, 'data-kind': kind }, {}));
        await tick(); await tick(); await tick();
      });
      notes.push(s.att.note);
      assert.equal(s.att.note, expected);
    }
    const calls = [];
    s.att.review.claims = [claim('cl_a', 'Eliora', 'PALADIN')];
    const button = el({ 'data-claim': 'cl_a' });
    await withApi({ post: (url, body) => { calls.push([url, plain(body)]); return Promise.resolve({ claim: { status: 'rejected' } }); }, get: url => Promise.resolve(url.indexOf('/claims') >= 0 ? { claims: [] } : reviewData) }, async () => {
      G.handlers.click['claim-reject'](button);
      await tick(); await tick(); await tick();
    });
    assert.deepEqual(calls, [['/api/guild/g1/claims/cl_a/reject', {}]]);
    assert.equal(s.att.note, 'Rejected the claim on Eliora.');
  });

  await check('Character claims: a lost race (claim_changed / claim_decided) shows the server message and reloads the queue', async () => {
    const s = reviewState([claim('cl_a', 'Eliora', 'PALADIN')]);
    let reads = 0;
    await withApi({
      post: () => Promise.reject(new G.api.ApiError(409, { error: 'claim_decided', message: 'Someone already decided this claim. Reload to see it.' })),
      get: url => { reads++; return Promise.resolve(url.indexOf('/claims') >= 0 ? { claims: [] } : reviewData); },
    }, async () => {
      G.handlers.submit['claim-approve'](formEl({ 'data-claim': 'cl_a', 'data-kind': 'add_alt' }, { teamId: { value: 't1' } }));
      await tick(); await tick(); await tick(); await tick();
    });
    assert.equal(s.pageAlert, 'Someone already decided this claim. Reload to see it.');
    assert(reads >= 2, 'both lists were read again');
    assert.deepEqual(plain(s.att.review.claims), []);
  });

  // ── Import from Battle.net ─────────────────────────────────────
  function member(name, cls, level, rank, extra) {
    return Object.assign({ key: name.toLowerCase() + '|dreamscythe', name, realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: cls, level, rank, status: 'new', person: null }, extra || {});
  }
  const PREVIEW = {
    guild: { name: 'Ember Company', realm: 'Dreamscythe' }, team: { id: 't1', name: 'Alpha' }, fetchedAt: T0, rankLabels: ['Guild Master', 'Officer', '', '', '', '', '', '', '', ''],
    ranks: [{ rank: 0, label: 'Guild Master', count: 1 }, { rank: 1, label: 'Officer', count: 2 }, { rank: 4, label: 'Rank 4', count: 4 }],
    rows: [
      member('Thornwick', 'WARRIOR', 70, 0),
      member('Pyrelo', 'MAGE', 70, 1),
      member('Mendra', 'SHAMAN', 70, 1, { status: 'on_roster', person: { id: 'p1', name: 'Mendra' } }),
      member('Ashgrove', 'PRIEST', 64, 4),
      member('Tinkerpop', 'MAGE', 22, 4),
      member('Newtooth', 'ROGUE', null, 4),
      member('Wayfarer', 'HUNTER', 70, 4, { status: 'other_realm', realm: 'Faraway Isle', realmSlug: 'faraway-isle', key: 'wayfarer|faraway-isle' }),
    ],
  };
  const INFO = { configured: true, supported: true, supportLabel: 'TBC Anniversary', message: null, realmKind: 'realm', guildName: null, effectiveGuildName: 'Ember Company', realmSlug: 'dreamscythe', realmNeeded: false, rankLabels: [], canEdit: true };
  function importState(extra) {
    const s = G.app.state;
    s.guilds.g1 = guildData();
    s.currentGid = 'g1';
    s.imports = {};
    const b = G.pages.importBnet.ensureState('g1', 't1');
    b.info = Object.assign({}, INFO);
    return Object.assign(b, extra || {});
  }

  await check('Battle.net import: the filters - on-roster rows hidden unless asked, minimum level (a row with no level fails it), ranks and the name search', () => {
    const I = G.pages.importBnet;
    const view = (extra) => Object.assign(I.newView(PREVIEW), extra || {});
    const names = v => I.visibleRows(PREVIEW, v).map(r => r.name);
    assert.deepEqual(names(view()), ['Thornwick', 'Pyrelo', 'Ashgrove', 'Tinkerpop', 'Newtooth', 'Wayfarer'], 'Mendra is on the roster');
    assert.deepEqual(names(view({ showRoster: true })).length, 7);
    assert.deepEqual(names(view({ minLevel: 60 })), ['Thornwick', 'Pyrelo', 'Ashgrove', 'Wayfarer'], 'level 22 and no level are out');
    assert.deepEqual(names(view({ minLevel: 1 })).includes('Newtooth'), true);
    assert.deepEqual(names(view({ ranks: { 0: true, 1: false, 4: true } })), ['Thornwick', 'Ashgrove', 'Tinkerpop', 'Newtooth', 'Wayfarer']);
    assert.deepEqual(names(view({ query: '  TIN ' })), ['Tinkerpop']);
    assert.deepEqual(plain(I.newView(PREVIEW)), { minLevel: 1, ranks: { 0: true, 1: true, 4: true }, query: '', showRoster: false });
    const counts = I.counts(PREVIEW, view(), { 'thornwick|dreamscythe': true, 'mendra|dreamscythe': true, 'wayfarer|faraway-isle': true });
    assert.deepEqual(plain(counts), { total: 7, shown: 6, addable: 5, allShownTicked: false, ticked: 1, tooMany: false }, 'only new rows count as ticked');
    const all = {}; I.visibleRows(PREVIEW, view()).forEach(r => { if (r.status === 'new') all[r.key] = true; });
    assert.equal(I.counts(PREVIEW, view(), all).allShownTicked, true);
  });

  await check('Battle.net import: the commit body names only which members; at most 250 at a time', () => {
    const I = G.pages.importBnet;
    const built = I.commitBody('t1', PREVIEW, { 'pyrelo|dreamscythe': true, 'thornwick|dreamscythe': true, 'mendra|dreamscythe': true, 'ashgrove|dreamscythe': false }, 'raider');
    assert.deepEqual(plain(built.body), { teamId: 't1', defaultStatus: 'raider', members: [{ name: 'Thornwick', realmSlug: 'dreamscythe' }, { name: 'Pyrelo', realmSlug: 'dreamscythe' }] });
    assert.deepEqual(plain(built.sent), ['thornwick|dreamscythe', 'pyrelo|dreamscythe']);
    const rows = Array.from({ length: 251 }, (_, i) => member('Zq' + i, 'MAGE', 70, 0));
    const big = { rows, ranks: [{ rank: 0, label: 'Guild Master', count: 251 }] };
    const ticked = {}; rows.forEach(r => { ticked[r.key] = true; });
    assert.equal(I.counts(big, I.newView(big), ticked).tooMany, true);
    const footer = I.footerHtml('g1', { preview: big, view: I.newView(big), ticked, status: 'ready' });
    assert(footer.includes('add at most 250 at a time') && /<button[^>]*disabled[^>]*data-action="bnet-commit"/.test(footer));
    assert.equal(I.MAX_COMMIT, 250);
  });

  await check('Battle.net import: before loading = which guild and realm will be read and a Load button; not set up, unsupported and a missing realm explain themselves', () => {
    const gd = guildData();
    const page = b => G.pages.importBnet.bnetHtml({ guildData: gd, bnet: b });
    const ready = page(importState());
    assert(ready.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Import from Battle.net</h1>') && ready.includes('data-action="bnet-load"') && text(ready).includes('Preview guild roster') && text(ready).includes('Nothing is saved until you press the button on the next step.'));
    assert(text(ready).includes('Reads Ember Company on Dreamscythe (US)') && ready.includes('href="#/g/g1/settings/battlenet"'));
    assert(!ready.includes('bnet-footer'));
    const loading = page(importState({ status: 'loading' }));
    assert(/data-action="bnet-load"[^>]* disabled/.test(loading));
    const none = importState({ info: null });
    assert(page(none).includes('Loading') && !page(none).includes('data-action="bnet-load"'));
    const off = page(importState({ info: Object.assign({}, INFO, { configured: false }) }));
    assert(off.includes('id="bnet-import-not-set-up"') && text(off).includes("Battle.net isn't set up on this server.") && !off.includes('data-action="bnet-load"'));
    const unsupported = page(importState({ info: Object.assign({}, INFO, { supported: false, message: "Battle.net doesn't offer character data for WoW Forever yet." }) }));
    assert(text(unsupported).includes("Battle.net doesn't offer character data for WoW Forever yet.") && !unsupported.includes('data-action="bnet-load"'));
    const realm = page(importState({ info: Object.assign({}, INFO, { realmNeeded: true }) }));
    assert(realm.includes('id="bnet-import-realm"') && text(realm).includes('Battle.net needs the realm this guild lives on.') && realm.includes('Open Guild settings') && !realm.includes('data-action="bnet-load"'));
    const teamLead = page(importState({ info: Object.assign({}, INFO, { realmNeeded: true, canEdit: false }) }));
    assert(text(teamLead).includes('Ask an officer to set it in Guild settings.') && !teamLead.includes('href="#/g/g1/settings/battlenet"'));
    assertNoRawAttrs(ready);
  });

  await check('Battle.net import: the loaded roster shows rank names, level, class and status; ticked rows and the footer follow the counts', () => {
    const I = G.pages.importBnet;
    const b = importState({ preview: PREVIEW, view: I.newView(PREVIEW), ticked: { 'pyrelo|dreamscythe': true } });
    const out = I.bnetHtml({ guildData: guildData(), bnet: b });
    const t = text(out);
    assert(t.includes('Ember Company') && t.includes('7 members') && t.includes('Showing 6 of 7.'), t);
    assert(out.includes('id="bnet-min-level"') && out.includes('id="bnet-search"') && out.includes('id="bnet-show-roster"') && out.includes('id="bnet-start"'));
    assert(/<option value="trial" selected>/.test(out), 'new people start as Trial');
    assert(out.includes('id="bnet-rank-0"') && t.includes('Guild Master (1)') && t.includes('Officer (2)') && t.includes('Rank 4 (4)'));
    const rows = out.split('<tr>').slice(1).filter(r => r.includes('<th scope="row"'));
    const row = name => rows.find(r => r.includes('>' + name + '</span>'));
    assert(row('Pyrelo').includes('checked') && !row('Thornwick').includes('checked'));
    assert(row('Wayfarer').includes('disabled') && row('Wayfarer').includes('Another realm: Faraway Isle'));
    assert(!row('Mendra'), 'on the roster: hidden by default');
    assert(row('Thornwick').includes('0 <span class="gs-fine">Guild Master</span>') && row('Pyrelo').includes('1 <span class="gs-fine">Officer</span>'));
    assert(row('Newtooth').includes('gs-muted">-<'), 'no level = dash');
    assert(out.includes('id="bnet-tick-all"') && !/id="bnet-tick-all"[^>]* checked/.test(out));
    assert(t.includes('1 character ticked') && t.includes('Add 1 person'));
    const shown = I.bnetHtml({ guildData: guildData(), bnet: Object.assign(b, { view: Object.assign(I.newView(PREVIEW), { showRoster: true }) }) });
    assert(text(shown).includes('On the roster (Mendra)') && shown.split('<tr>').slice(1).find(r => r.includes('>Mendra</span>')).includes('disabled'));
    const empty = I.bnetHtml({ guildData: guildData(), bnet: Object.assign(b, { view: Object.assign(I.newView(PREVIEW), { query: 'zzz' }) }) });
    assert(empty.includes('id="bnet-none"') && text(empty).includes('No one matches these filters.'));
    assertEscaped(I.bnetHtml({ guildData: guildData(), bnet: Object.assign(b, { view: I.newView(PREVIEW), preview: Object.assign({}, PREVIEW, { guild: { name: HOSTILE + QUOTES, realm: HOSTILE }, rows: [member(HOSTILE + QUOTES, 'MAGE', 70, 0)] }) }) }), 'import');
    assertNoRawAttrs(out);
  });

  await check('Battle.net import: Load posts the team, keeps the state, and shows Blizzard\'s message when it fails', async () => {
    const b = importState();
    const calls = [];
    await withApi({ post: (url, body) => { calls.push([url, plain(body)]); return Promise.resolve(JSON.parse(JSON.stringify(PREVIEW))); } }, async () => {
      G.handlers.click['bnet-load']();
      await tick(); await tick();
    });
    assert.deepEqual(calls, [['/api/guild/g1/roster/import/bnet/preview', { teamId: 't1' }]]);
    assert.equal(b.status, 'ready');
    assert.equal(b.preview.rows.length, 7);
    assert.deepEqual(plain(b.view), { minLevel: 1, ranks: { 0: true, 1: true, 4: true }, query: '', showRoster: false });
    assert.deepEqual(plain(b.ticked), {});
    const b2 = importState();
    await withApi({ post: () => Promise.reject(new G.api.ApiError(404, { error: 'bnet_guild_not_found', message: 'Battle.net has no guild with that name on that realm.' })) }, async () => {
      G.handlers.click['bnet-load']();
      await tick(); await tick();
    });
    assert.equal(b2.status, 'idle');
    assert.equal(b2.preview, null);
    assert.equal(b2.error, 'Battle.net has no guild with that name on that realm.');
    assert(G.pages.importBnet.bnetHtml({ guildData: guildData(), bnet: b2 }).includes('Battle.net has no guild with that name on that realm.'));
  });

  await check('Battle.net import: ticking, Select all shown and the filters change the counts; a commit goes to the roster with a notice and a fresh badge', async () => {
    const I = G.pages.importBnet;
    const b = importState({ preview: JSON.parse(JSON.stringify(PREVIEW)), view: I.newView(PREVIEW), ticked: {}, status: 'ready' });
    const list = { innerHTML: '' };
    const footer = { outerHTML: '' };
    fields['bnet-list'] = list;
    fields['bnet-footer'] = footer;
    G.handlers.change['bnet-tick']({ checked: true, getAttribute: () => 'pyrelo|dreamscythe' });
    assert.deepEqual(plain(b.ticked), { 'pyrelo|dreamscythe': true });
    assert(list.innerHTML.includes('Showing 6 of 7') && footer.outerHTML.includes('Add 1 person'));
    G.handlers.change['bnet-tick-all']({ checked: true });
    assert.equal(Object.keys(b.ticked).filter(k => b.ticked[k]).length, 5, 'every new row shown');
    G.handlers.input['bnet-min-level']({ value: '60' });
    assert.equal(b.view.minLevel, 60);
    assert(list.innerHTML.includes('Showing 4 of 7'));
    G.handlers.input['bnet-min-level']({ value: 'abc' });
    assert.equal(b.view.minLevel, 1);
    G.handlers.change['bnet-rank']({ checked: false, getAttribute: () => '4' });
    assert.equal(b.view.ranks[4], false);
    G.handlers.input['bnet-search']({ value: 'thorn' });
    assert(list.innerHTML.includes('Thornwick') && !list.innerHTML.includes('Pyrelo'));
    G.handlers.change['bnet-show-roster']({ checked: true });
    G.handlers.change['bnet-start']({ value: 'reserve' });
    G.handlers.change['bnet-start']({ value: 'inactive' });
    assert.equal(b.defaultStatus, 'reserve', 'inactive is not a start status');
    b.ticked = { 'thornwick|dreamscythe': true, 'pyrelo|dreamscythe': true };
    G.app.state.rosterNotice = '';
    let sent;
    let hashes;
    await withApi({ post: (url, body) => { sent = [url, plain(body)]; return Promise.resolve({ people: 2, characters: 2, rosterFlags: { t1: 4 } }); } }, async h => {
      G.handlers.click['bnet-commit']();
      await tick(); await tick();
      hashes = h;
    });
    assert.deepEqual(sent, ['/api/guild/g1/roster/import/bnet/commit', { teamId: 't1', defaultStatus: 'reserve', members: [{ name: 'Thornwick', realmSlug: 'dreamscythe' }, { name: 'Pyrelo', realmSlug: 'dreamscythe' }] }]);
    assert.deepEqual(plain(hashes), [], 'the officer stays on the import page');
    assert.equal(b.result.title, 'Added 2 people from the Battle.net guild roster.');
    assert.equal(G.app.state.guilds.g1.rosterFlags.t1, 4);
    const done = I.bnetHtml({ guildData: G.app.state.guilds.g1, bnet: b });
    assert(done.includes('id="bnet-result-banner"') && done.includes('Added 2 people') && done.includes('href="#/g/g1/roster"') && done.includes('data-action="bnet-again"') && !done.includes('id="bnet-footer"'));
    delete fields['bnet-list']; delete fields['bnet-footer'];
  });

  await check('Battle.net import: commit errors - a row error marks its row, roster_changed offers a reload, nothing ticked sends nothing', async () => {
    const I = G.pages.importBnet;
    const fresh = () => importState({ preview: JSON.parse(JSON.stringify(PREVIEW)), view: I.newView(PREVIEW), ticked: { 'thornwick|dreamscythe': true, 'pyrelo|dreamscythe': true }, status: 'ready' });
    let b = fresh();
    await withApi({ post: () => Promise.reject(new G.api.ApiError(409, { error: 'name_taken', message: 'Pyrelo is already on the roster.', index: 1, field: 'name' })) }, async () => {
      G.handlers.click['bnet-commit']();
      await tick(); await tick();
    });
    assert.equal(b.rowErrors['pyrelo|dreamscythe'], 'Pyrelo is already on the roster.');
    assert(b.error.includes('Untick it and try again') && b.offerReload === false);
    b = fresh();
    await withApi({ post: () => Promise.reject(new G.api.ApiError(409, { error: 'roster_changed', message: 'The guild roster changed since you loaded it. Load it again.', index: 0 })) }, async () => {
      G.handlers.click['bnet-commit']();
      await tick(); await tick();
    });
    assert.equal(b.error, 'The guild roster changed since you loaded it. Load it again.');
    assert.equal(b.offerReload, true);
    assert(I.bnetHtml({ guildData: guildData(), bnet: b }).includes('Load the roster again'));
    b = importState({ preview: JSON.parse(JSON.stringify(PREVIEW)), view: I.newView(PREVIEW), ticked: {}, status: 'ready' });
    let called = 0;
    await withApi({ post: () => { called++; return Promise.resolve({}); } }, async () => {
      G.handlers.click['bnet-commit']();
      await tick();
    });
    assert.equal(called, 0);
  });

  // ── Guild settings > Battle.net ────────────────────────────────
  const SETTINGS = {
    configured: true, supported: true, supportLabel: 'TBC Anniversary', message: null, realmKind: 'realm', guildName: null, effectiveGuildName: 'Ember', realmSlug: 'dreamscythe',
    realmNeeded: false, rankLabels: ['Guild Master', 'Officer', '', '', '', '', '', '', '', ''], rankDefaults: ['Guild Master', 'Rank 1', 'Rank 2', 'Rank 3', 'Rank 4', 'Rank 5', 'Rank 6', 'Rank 7', 'Rank 8', 'Rank 9'], canEdit: true,
  };

  await check('Settings > Battle.net: guild name with the Raidsmith name as the hint, ten rank fields with default hints, a realm line for a realm guild', () => {
    const out = G.pages.settingsBnet.settingsHtml({ guildData: guildData(), data: SETTINGS });
    assert(out.includes('id="bnet-guild-name"') && out.includes('placeholder="Ember"') && text(out).includes('Leave empty to use the Raidsmith guild name (Ember).'));
    for (let i = 0; i < 10; i++) assert(out.includes('id="bnet-rank-' + i + '"'), 'rank ' + i);
    assert(out.includes('id="bnet-rank-0"') && /id="bnet-rank-0"[^>]*value="Guild Master"/.test(out) && /id="bnet-rank-2"[^>]*placeholder="Rank 2"[^>]*value=""/.test(out));
    assert(out.includes('id="bnet-realm-line"') && text(out).includes('Realm: Dreamscythe (US)') && !out.includes('id="bnet-realm"'));
    assert(text(out).includes('Battle.net gives guild ranks as numbers only.'));
    assert(out.includes('data-submit="bnet-settings"') && out.includes('data-dirty-form') && out.includes('data-savebar') && out.includes('>Save changes<'), 'the form keeps its Save bar');
    assertNoRawAttrs(out);
  });

  await check('Settings > Battle.net: a ruleset guild gets the realm field; not set up and unsupported are explained; without guild.teams it is read-only; loading', () => {
    const ruleset = guildData(null, { guild: { id: 'g1', name: 'Fresh', realm: 'Normal', realmKind: 'ruleset', realmSlug: null, region: 'US', timeZone: 'UTC', gameVersion: 'forever', createdAt: 1 } });
    const data = Object.assign({}, SETTINGS, { realmKind: 'ruleset', realmSlug: null, realmNeeded: true, supported: false, message: "Battle.net doesn't offer character data for WoW Forever yet." });
    const out = G.pages.settingsBnet.settingsHtml({ guildData: ruleset, data });
    assert(out.includes('id="bnet-realm"') && out.includes('name="realmSlug"') && text(out).includes('Realm the guild lives on'));
    assert(out.includes('id="bnet-set-unsupported"') && text(out).includes("Battle.net doesn't offer character data for WoW Forever yet. You can still fill this in"));
    assert(G.pages.settingsBnet.settingsHtml({ guildData: guildData(), data: Object.assign({}, SETTINGS, { configured: false }) }).includes('id="bnet-set-not-configured"'));
    const readOnly = G.pages.settingsBnet.settingsHtml({ guildData: guildData(), data: Object.assign({}, SETTINGS, { canEdit: false }) });
    assert(!readOnly.includes('>Save changes<') && !readOnly.includes('data-savebar') && /id="bnet-guild-name"[^>]* disabled/.test(readOnly) && text(readOnly).includes('Only people who can edit teams can change these.'));
    assert(G.pages.settingsBnet.settingsHtml({ guildData: guildData(), data: null }).includes('Loading'));
    assertEscaped(G.pages.settingsBnet.settingsHtml({ guildData: guildData(), data: Object.assign({}, SETTINGS, { guildName: HOSTILE + QUOTES, rankLabels: [HOSTILE + QUOTES, '', '', '', '', '', '', '', '', ''] }), alert: HOSTILE + QUOTES, notice: HOSTILE + QUOTES }), 'settings');
  });

  await check('Settings > Battle.net: Save sends the trimmed name and the ten labels (the realm only for a ruleset guild), shows Saved, and puts a field error at its field', async () => {
    const s = G.app.state;
    s.guilds.g1 = guildData();
    s.currentGid = 'g1';
    s.bnetSettings = { gid: 'g1', data: Object.assign({}, SETTINGS), notice: '' };
    const values = { guildName: { value: '  Ember Company ' }, realmSlug: { value: 'old-blanchy' } };
    for (let i = 0; i < 10; i++) values['rank' + i] = { value: i === 1 ? ' Officer ' : '' };
    const form = { elements: values, querySelectorAll: () => [] };
    const sent = [];
    await withApi({ put: (url, body) => { sent.push([url, plain(body)]); return Promise.resolve(Object.assign({}, SETTINGS, { guildName: 'Ember Company' })); } }, async () => {
      G.handlers.submit['bnet-settings'](form);
      await tick(); await tick();
    });
    assert.equal(sent[0][0], '/api/guild/g1/bnet');
    assert.equal(sent[0][1].guildName, 'Ember Company');
    assert.equal(sent[0][1].rankLabels.length, 10);
    assert.equal(sent[0][1].rankLabels[1], ' Officer ', 'trimming is the Worker\'s job; the page sends what was typed');
    assert.equal('realmSlug' in sent[0][1], false, 'a realm guild never sends a realm');
    assert.equal(s.bnetSettings.notice, '', 'the page head says Saved at; there is no banner');
    assert.equal(G.app.state.settingsSaved && G.app.state.settingsSaved.tab, 'battlenet');
    assert.equal(s.bnetSettings.data.guildName, 'Ember Company');
    s.bnetSettings.data = Object.assign({}, SETTINGS, { realmKind: 'ruleset' });
    const ruleset = [];
    await withApi({ put: (url, body) => { ruleset.push(plain(body)); return Promise.reject(new G.api.ApiError(400, { error: 'bad_request', message: 'Enter the realm.', field: 'realmSlug' })); } }, async () => {
      fields['bnet-err-realmSlug'] = { textContent: '', hidden: true };
      G.handlers.submit['bnet-settings'](form);
      await tick(); await tick();
    });
    assert.equal(ruleset[0].realmSlug, 'old-blanchy');
    assert.equal(fields['bnet-err-realmSlug'].textContent, 'Enter the realm.');
    delete fields['bnet-err-realmSlug'];
  });

  // ── privacy, CSS and files ─────────────────────────────────────
  await check('privacy: the Battle.net data, the 30 days and the third cookie are in the policy, and Delete my data names Battle.net', () => {
    const out = G.pages.privacy.privacyHtml({ me: { user: {}, deleteImpact: { handOverFirst: [], guildsDeleted: [] } } });
    const t = text(out);
    for (const s of [
      'Battle.net, only if you connect it', 'BattleTag', 'does not keep the access token', 'for 30 days at most', 'Disconnect on Linked accounts',
      'A character you claim is sent to your guild', 'That list is not kept', 'Connecting Battle.net sets one more for 10 minutes',
      'It also deletes your Battle.net link and character list, and the character claims you made.', 'your Discord data and your Battle.net data now',
    ]) assert(t.includes(s), s);
    assert(text(G.pages.privacy.privacyHtml({ me: null })).includes('Battle.net, only if you connect it'), 'signed-out visitors read it too');
    assert(!text(G.pages.privacy.privacyHtml({ me: null })).includes('Delete my data'));
  });

  await check('guild.css and files: the Battle.net classes exist, nothing sets inline styles, and the scripts load in order before app.js', () => {
    for (const c of ['.gs-table-bnet', '.gs-bnet-state', '.gs-cclaim-form', '.gs-cclaim-plan.is-blocked', '.gs-bnet-filters', '.gs-bnet-ranks', '.gs-bnet-form']) assert(css.includes(c), c);
    const phone = css.split('@media (max-width: 600px)').slice(1).join('');
    assert(/\.gs-table-bnet, \.gs-table-bnet-import \{ min-width: 0; \}/.test(phone) && /\.gs-cclaim-form \{ width: 100%; \}/.test(phone));
    for (const f of ['pages-bnet.js', 'pages-import-bnet.js', 'pages-settings-bnet.js']) {
      read('js/guild/' + f).split('\n').forEach((line, i) => assert(!/[\s`'"]style\s*=\s*["'`\\]/.test(line), `${f}:${i + 1} inline style`));
      assert(GUILD_SCRIPTS.indexOf('/js/guild/' + f) > GUILD_SCRIPTS.indexOf('/js/guild/ui.js') && GUILD_SCRIPTS.indexOf('/js/guild/' + f) < GUILD_SCRIPTS.indexOf('/js/guild/app.js'), f);
      for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert(guildScriptsOf(read(page)).includes('/js/guild/' + f), page + ' loads ' + f);
    }
    const order = page => guildScriptsOf(read(page));
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert.deepEqual(order(page), GUILD_SCRIPTS.filter(s => s.indexOf('/js/guild/') === 0), page);
    const noEm = ['pages-bnet.js', 'pages-import-bnet.js', 'pages-settings-bnet.js', 'tools/fake-battlenet.js', 'worker/battlenet.js'].map(f => f.indexOf('/') > 0 ? f : 'js/guild/' + f);
    for (const f of noEm) assert(!/[^\x00-\x7f]/.test(read(f).replace(/\u2500/g, '')), f + ' has non-ASCII text');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
