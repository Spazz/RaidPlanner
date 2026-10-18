/**
 * Raidsmith guild UI, Phase 8 (opening Raidsmith to other guilds) - tests for the setup checklist on Home, the Guild data tab (export and delete),
 * the create page's reasons and limit, the Battle.net-only hint, and the signed-out landing's "For guilds" section.
 * Run: node guild-guilds-ui-tests.js
 *
 * Same approach as guild-wave1-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render functions return HTML strings and the
 * handlers run against a stubbed G.api. guild-guilds-worker-tests.js pins the Worker side of every payload used here.
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
    console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const ApiErr = (status, code, extra) => new ctx.Guild.api.ApiError(status, Object.assign({ error: code, message: 'Server says so.' }, extra || {}));
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null }, extra || {});

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
}
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'guild.roles': 'guild' };
function gd(roles, name) {
  return {
    guild: { id: 'g1', name: name || 'Ember', realm: 'Nightslayer', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [{ id: 't1', name: 'Main team', size: 25, archived: false, players: 0, leads: [] }],
    me: { roles: roles.map(role => ({ role })), can: OFFICER_CAN },
    attendanceFlags: {}, rosterFlags: {},
  };
}
const STEP_IDS = ['teams', 'roster', 'attendance', 'raid', 'officers', 'loot'];
const onboarding = done => ({ steps: STEP_IDS.map(id => ({ id, done: done.includes(id) })), done: done.length, total: 6 });
const attention = (over) => Object.assign({ today: '2027-01-15', total: 0, items: [], more: {}, onboarding: null }, over || {});
const attnHtml = (data, g) => G.pages.attention.attentionHtml({ guildData: g || gd(['officer']), data });

function withState(fn) {
  return async () => {
    const S = G.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, attention: S.attention, teamByGuild: S.teamByGuild };
    const savedApp = { requireSignin: G.app.requireSignin, showFailure: G.app.showFailure, afterGuildDeleted: G.app.afterGuildDeleted, render: G.app.render };
    const savedUi = { openDialog: G.ui.openDialog, announce: G.ui.announce, focusByKey: G.ui.focusByKey };
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.attention = {}; S.teamByGuild = {};
    Object.keys(els).forEach(k => delete els[k]);
    try { await fn(S); } finally { Object.assign(S, saved); Object.assign(G.app, savedApp); Object.assign(G.ui, savedUi); }
  };
}

(async () => {
  // ═══ the setup checklist on Home ═══════════════════════════════════
  await check('checklist: six steps, each a link to its page, ticked from the data; the count and the Dismiss button are in words (the whole list until the guild has a raid)', () => {
    const out = attnHtml(attention({ onboarding: onboarding(['teams', 'roster']) }));
    assert(out.includes('class="gs-onboard" id="setup"') && out.includes('Set up your guild') && !out.includes('is-line'));
    assert(out.includes('2 of 6 steps done'));
    const links = [...out.matchAll(/<a class="gs-onboard-link" href="([^"]*)">([^<]*)(?:<span class="gs-sr"> \(done\)<\/span>)?<\/a>/g)].map(m => [m[1], m[2]]);
    assert.deepEqual(links, [
      ['#/g/g1/settings/teams', 'Set up your teams'], ['#/g/g1/roster', 'Import your roster'], ['#/g/g1/settings/attendance', 'Set the attendance rules'],
      ['#/g/g1/raids/new', 'Add your first raid'], ['#/g/g1/settings/people', 'Invite your officers'], ['#/g/g1/loot', 'Import loot'],
    ]);
    assert.equal((out.match(/class="gs-onboard-step is-done"/g) || []).length, 2, 'two steps are ticked');
    assert.equal((out.match(/<span class="gs-sr"> \(done\)<\/span>/g) || []).length, 2, 'a ticked step says so for a screen reader');
    assert.equal((out.match(/class="gs-onboard-dot is-done"/g) || []).length, 2);
    assert(/<button type="button" class="gs-btn gs-btn-sm" data-action="onboarding-dismiss" data-key="onboarding-dismiss"><span>Dismiss<\/span><\/button>/.test(out));
    assert(out.indexOf('gs-onboard') > out.indexOf('Nothing needs you right now'), 'the work comes first, the checklist after it');
    assert(!out.includes('data-action="setup-toggle"'), 'no way to fold it before the guild has a raid');
    assertNoRawAttrs(out);
    // Every step is a real route of the router (a mistyped tab would fall back to "roster").
    for (const def of G.pages.attention.ONBOARDING) assert.notEqual(G.router.parse(G.router.format(Object.assign({}, def.route, { gid: 'g1' }))).name, 'notfound', def.id);
    assert.deepEqual(plain(G.pages.attention.ONBOARDING.map(def => def.id)), STEP_IDS, 'the page and the Worker name the same six steps in the same order');
  });

  await check('checklist: nothing without onboarding data (not for this viewer, dismissed, or all done); a step the Worker does not know is ignored', () => {
    for (const data of [attention(), attention({ onboarding: null }), attention({ onboarding: { steps: [] } }), { today: 'x', total: 0, items: [], more: {} }]) {
      assert(!attnHtml(data).includes('gs-onboard'), JSON.stringify(data.onboarding));
    }
    const odd = attnHtml(attention({ onboarding: { steps: [{ id: 'teams', done: true }, { id: 'mystery', done: true }], done: 2, total: 2 } }));
    assert(odd.includes('1 of 6 steps done'), 'counted against the six steps the page knows');
    assert(!odd.includes('mystery'));
    assertEscaped(attnHtml(attention({ onboarding: onboarding([]) }), gd(['officer'], HOSTILE + QUOTES)), 'checklist with a hostile guild name');
  });

  await check('checklist: Dismiss asks the Worker, hides the card for good, tells a screen reader, and keeps the page on a failure', withState(async (S) => {
    S.guilds.g1 = gd(['guild_master']); S.currentGid = 'g1';
    const data = attention({ onboarding: onboarding(['teams']) });
    S.att.attention = { gid: 'g1', data, refreshing: false, error: '' };
    const spoken = [];
    G.ui.announce = (id, text) => spoken.push([id, text]);
    G.ui.focusByKey = () => true;
    let renders = 0;
    G.app.render = () => { renders++; };
    let s = stub(() => Promise.resolve({ ok: true }));
    await G.handlers.click['onboarding-dismiss'](el({}));
    assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['post', '/api/guild/g1/onboarding/dismiss']]);
    assert.equal(S.att.attention.data.onboarding, null);
    assert.equal(S.att.attention.dismissing, false);
    assert(renders >= 2, 'drawn busy, then drawn without the card');
    assert.deepEqual(spoken, [['attn-status', 'The setup checklist is hidden.']]);
    assert(!G.pages.attention.main({}, gd(['guild_master']), {}).includes('gs-onboard'));
    s.restore();

    // A failure leaves the card and says why; a second click while it runs does nothing.
    S.att.attention = { gid: 'g1', data: attention({ onboarding: onboarding([]) }), refreshing: false, error: '' };
    s = stub(() => Promise.reject(ApiErr(500, 'server_error')));
    await G.handlers.click['onboarding-dismiss'](el({}));
    assert.equal(S.att.attention.error, 'Server says so.');
    assert.notEqual(S.att.attention.data.onboarding, null);
    assert.equal(S.att.attention.dismissing, false);
    s.restore();
    S.att.attention.dismissing = true;
    s = stub(() => Promise.resolve({ ok: true }));
    G.handlers.click['onboarding-dismiss'](el({}));
    assert.equal(s.calls.length, 0);
    s.restore();
    // While it runs the button is disabled.
    assert(/disabled data-action="onboarding-dismiss" data-key="onboarding-dismiss"/.test(G.pages.attention.attentionHtml({ guildData: gd(['officer']), data: attention({ onboarding: onboarding([]) }), dismissing: true })));
    // Signed out in the middle of it: back to sign-in.
    S.att.attention = { gid: 'g1', data: attention({ onboarding: onboarding([]) }), refreshing: false, error: '' };
    let signedOut = 0;
    G.app.requireSignin = () => { signedOut++; };
    s = stub(() => Promise.reject(ApiErr(401, 'signed_out')));
    await G.handlers.click['onboarding-dismiss'](el({}));
    assert.equal(signedOut, 1);
    s.restore();
  }));

  // ═══ the Guild data tab ════════════════════════════════════════════
  await check('guild data: the Guild Master gets a download link and a delete button; nobody else gets either', () => {
    const gm = G.pages.settingsData.dataHtml({ guildData: gd(['guild_master']), alert: '' });
    assert(gm.includes('Export guild data') && gm.includes('Delete this guild'));
    assert(gm.includes('<a class="gs-btn gs-btn-molten" href="/api/guild/g1/export" download data-key="gdata-export">Download guild data</a>'));
    assert(gm.includes('data-action="guild-delete-open"') && gm.includes('Delete Ember...'));
    assert(gm.includes('leaves out Discord IDs and names, accounts and role assignments, Battle.net data, guest and calendar links'));
    assertNoRawAttrs(gm);
    const officer = G.pages.settingsData.dataHtml({ guildData: gd(['officer']), alert: '' });
    assert(officer.includes('Only the Guild Master can export or delete the guild.'));
    assert(!officer.includes('/export') && !officer.includes('guild-delete-open'));
    assertEscaped(G.pages.settingsData.dataHtml({ guildData: gd(['guild_master'], HOSTILE + QUOTES), alert: '' }), 'guild data with a hostile name');
  });

  await check('guild data: the tab is the Guild Master\'s only, and its address round-trips', () => {
    const tabs = (can, roles) => plain(G.shell.settingsTabs(can, roles).map(t => t.tab));
    assert(tabs(OFFICER_CAN, [{ role: 'guild_master' }]).includes('data'));
    assert(!tabs(OFFICER_CAN, [{ role: 'officer' }]).includes('data'));
    assert(!tabs(OFFICER_CAN).includes('data'));
    assert.equal(tabs(OFFICER_CAN, [{ role: 'guild_master' }]).pop(), 'data', 'last in the bar');
    assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab: 'data' }), '#/g/g1/settings/data');
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings/data')), { name: 'settings', gid: 'g1', tab: 'data' });
    assert.equal(G.shell.settingsTabs({}, [{ role: 'guild_master' }]).find(t => t.tab === 'data').label, 'Guild data');
  });

  await check('guild data: the delete dialog asks for the name; the request carries what was typed; the page moves on only after the Worker agrees', withState(async (S) => {
    S.guilds.g1 = gd(['guild_master']); S.currentGid = 'g1';
    let opened = null;
    G.ui.openDialog = (html, opts) => { opened = { html, opts }; return {}; };
    G.handlers.click['guild-delete-open'](el({}));
    assert(opened.html.includes('Delete Ember?') && opened.html.includes('name="confirmName"') && opened.html.includes('id="dlg-err-confirmName"'));
    assert(opened.html.includes('Type the guild name to confirm.'));
    assertNoRawAttrs(opened.html);
    // An officer's click does nothing.
    opened = null;
    S.guilds.g1 = gd(['officer']);
    G.handlers.click['guild-delete-open'](el({}));
    assert.equal(opened, null);
    S.guilds.g1 = gd(['guild_master']);

    const deleted = [];
    G.app.afterGuildDeleted = gid => deleted.push(gid);
    // The dialog's form as ui.showFormError sees it: the field's error slot and the input are found by their selectors.
    const input = { focus() { input.focused = true; }, setAttribute() {} };
    const dlgForm = (typed) => ({
      elements: { confirmName: { value: typed } },
      querySelector: sel => (sel === '#dlg-err-confirmName' ? els['dlg-err-confirmName'] : (sel === '[data-field="confirmName"]' ? input : null)),
      querySelectorAll: () => [], closest: () => null,
    });
    const sink = (id) => { els[id] = { id, textContent: '', hidden: true }; return els[id]; };
    const confirmErr = sink('dlg-err-confirmName'); sink('dlg-error');
    let s = stub(() => Promise.reject(ApiErr(400, 'confirm_mismatch', { field: 'confirmName', message: 'Type the guild name exactly as shown to delete the guild.' })));
    G.handlers.submit['guild-delete-form'](dlgForm('ember'));
    await settle();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['del', '/api/guild/g1', { confirmName: 'ember' }]]);
    assert.equal(confirmErr.textContent, 'Type the guild name exactly as shown to delete the guild.', 'the Worker\'s message lands next to the field');
    assert.deepEqual(deleted, [], 'a refusal does not move the page');
    s.restore();
    s = stub(() => Promise.resolve({ ok: true }));
    G.handlers.submit['guild-delete-form'](dlgForm('Ember'));
    await settle();
    assert.deepEqual(s.calls.map(c => c.body), [{ confirmName: 'Ember' }]);
    assert.deepEqual(deleted, ['g1']);
    s.restore();
  }));

  await check('guild data: Worker paths of the three calls', () => {
    assert.equal(G.api.guildData.exportUrl('g_A-1'), '/api/guild/g_A-1/export');
    const s = stub(() => Promise.resolve({ ok: true }));
    G.api.guildData.remove('g1', 'Ember');
    G.api.guildData.dismissOnboarding('g1');
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['del', '/api/guild/g1', { confirmName: 'Ember' }], ['post', '/api/guild/g1/onboarding/dismiss', {}]]);
    s.restore();
  });

  // ═══ the create page ═══════════════════════════════════════════════
  await check('create page: each reason a guild cannot be created gets its own words and a way forward', () => {
    const page = reason => G.pages.create.createHtml({ me: { create: { allowed: false, reason } } });
    const needs = page('needs_discord');
    assert(needs.includes('Connect Discord to create a guild') && needs.includes('href="#/linked"'), 'a Battle.net-only account is sent to Linked accounts');
    assert(needs.includes('because') === false && needs.includes('belongs to a Discord server'));
    const reauth = page('reauth');
    assert(reauth.includes('Sign in again to find your servers') && reauth.includes('href="/auth/login"'));
    const none = page('no_server');
    assert(none.includes('No Discord server to create a guild for') && none.includes('Administrator or Manage Server') && none.includes('href="/auth/login"'));
    for (const reason of ['not_approved', undefined, 'something new']) assert(page(reason).includes('You cannot create a guild'), String(reason));
    for (const html of [needs, reauth, none]) assert(html.includes('Back to start'), 'the way out stays');
  });

  await check('create page: at the per-account limit the form says so and cannot be sent; below it nothing changes', () => {
    const create = (limit) => ({ allowed: true, stale: false, servers: [{ id: '900000000000000001', name: 'Hall', iconUrl: null, access: 'administrator' }], claimable: [], limit,
      options: { versions: [{ key: 'tbc', label: 'TBC Anniversary' }], regions: ['US'], realms: { tbc: { US: [{ name: 'Nightslayer' }] } }, rulesets: [] } });
    const full = G.pages.create.createHtml({ me: { create: create({ created: 5, max: 5 }) }, timeZones: ['UTC'], defaultTimeZone: 'UTC' });
    assert(full.includes('id="cg-limit"') && full.includes('You have created 5 guilds'));
    assert(/data-key="create-guild"[^>]*disabled|disabled[^>]*data-key="create-guild"/.test(full), 'the Create button is off');
    const room = G.pages.create.createHtml({ me: { create: create({ created: 4, max: 5 }) }, timeZones: ['UTC'], defaultTimeZone: 'UTC' });
    assert(!room.includes('cg-limit') && !/disabled[^>]*data-key="create-guild"/.test(room));
    const older = G.pages.create.createHtml({ me: { create: create(undefined) }, timeZones: ['UTC'], defaultTimeZone: 'UTC' });
    assert(!older.includes('cg-limit'), 'an answer without a limit is fine');
  });

  await check('no-guild card: an account without Discord is told that creating a guild needs it, with the link; a Discord account is not', () => {
    const bnetOnly = { user: { username: 'Holly', displayName: 'Holly' }, identities: { discord: null, bnet: { battletag: 'Holly#1' } }, guilds: [], create: { allowed: false, reason: 'needs_discord' }, removedFrom: [] };
    const card = G.pages.signin.noGuildHtml(bnetOnly);
    assert(card.includes('id="create-needs-discord"') && card.includes('Connect Discord to create a guild') && card.includes('href="#/linked"'));
    assert(G.pages.signin.noGuildNoticeHtml(bnetOnly).includes('Connect Discord to create a guild'));
    const withDiscord = Object.assign({}, bnetOnly, { identities: { discord: { username: 'holly' }, bnet: null }, create: { allowed: false, reason: 'no_server' } });
    assert(!G.pages.signin.noGuildHtml(withDiscord).includes('create-needs-discord'));
  });

  // ═══ the landing ═══════════════════════════════════════════════════
  await check('landing: a short "For guilds" section after the planner, with a Sign in with Discord button; only for the signed out', () => {
    const html = read('index.html');
    const css = read('app.css');
    const at = html.indexOf('id="for-guilds"');
    assert(at > 0);
    const section = html.slice(at, html.indexOf('</section>', at));
    for (const word of ['Roster', 'Raids', 'Attendance', 'Loot', 'Planner']) assert(new RegExp(`<h3>${word}</h3>`).test(section), word);
    assert(/<a class="btn btn-primary btn-lg" id="btn-guilds-signin" href="\/auth\/login">Sign in with Discord<\/a>/.test(section));
    assert(html.indexOf('id="import-card"') < at && at < html.indexOf('id="version-comparison"'), 'the planner\'s import card comes first, anonymous as ever');
    assert(!/<script/.test(section) && !/style=/.test(section) && !/[^\x00-\x7f]/.test(section));
    assert(css.includes('body:not(.is-signed-out) #landing-view #for-guilds'), 'hidden for anyone signed in');
    assert(css.includes('body.shell-pending #landing-view #for-guilds'), 'and before the session is known');
    assert(/\.guild-points\s*\{/.test(css) && /\.guilds-cta\s*\{/.test(css));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
