/**
 * Raidsmith guild app - lane B8a-setup of the user-hierarchy build: the in-game Guild setup screens (boards G0-G6 and P1 of the B8a admin canvas).
 * Run: node tests/guild/guild-b8a-setup-tests.js [name filter]
 *
 *   - Settings > Battle.net: the In-game guild panel in its states (not linked, linked, switched, hand-set; the Owner's primary only while pinOpen), the pinned guild name and realm
 *     read-only and left out of the PUT, the Roster row from the new `roster` part of GET /bnet (Worker: member count and last good fetch, no scan);
 *   - Settings > Discord roles: one line instead of the mapping form for a guild with a rank source (read with the roles, or from a 409 discord_roles_off);
 *   - Guild setup (pages-setup.js): every step renders from the answers of the Worker, the Owner alone acts, the sign-in carries the pin and the switch (Guild.fresh), the rank map PUT
 *     leaves "Not mapped" ranks out, the flip sends the token and the ticked ids, the pending act repeats it, an old or refused preview is "out of date", every refusal code has its sentence;
 *   - the pages against the REAL Worker (flipWorld over the D1 stand-in): the answers the screens were built from.
 * The UI half loads the shared guild script list into a vm with fake documents (as the other UI suites).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, runChecks } = require('../guild-b3-world');
const { flipWorld, grant } = require('../guild-flip');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({
    name,
    fn: async () => {
      globalThis.__flipWorlds = [];
      globalThis.__pinWorlds = [];
      try { await fn(); } finally { await Promise.all([...globalThis.__flipWorlds, ...globalThis.__pinWorlds].map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 150)); }
    },
  });
}

// ---------------------------------------------------------------------------
// The browser half: the guild scripts in a vm with no DOM, a fake document, storage and location

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, URL };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const sandbox = loadGuild();
const G = sandbox.Guild;
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
// The real Worker answers over a SQLite stand-in: wait for what the page is waiting for (up to 5 s) instead of counting ticks.
const until = async (done) => { for (let i = 0; i < 500 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); await settle(); };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

let fields = {};
sandbox.document = { getElementById: (id) => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const field = (id) => (fields[id] = { id, textContent: '', hidden: true });

const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
};
const realSetText = G.ui.setText;
const realSetBusy = G.ui.setBusy;
let storage;
let navigations;
let goes;
let renders;
let signedOut;
let failures;
let dialogs;
let refreshed;
function resetBrowser(hash = '#/g/g1/setup') {
  fields = {};
  storage = memoryStorage();
  navigations = []; goes = []; renders = 0; signedOut = 0; failures = []; dialogs = []; refreshed = [];
  sandbox.window = { sessionStorage: storage, location: { hash, assign: (url) => navigations.push(url) } };
  G.fresh.navigate = (url) => navigations.push(url);
  G.fresh.now = () => Date.now();
  G.app.go = (to, replace) => goes.push([to, !!replace]);
  G.app.render = () => { renders++; };
  G.app.requireSignin = () => { signedOut++; };
  G.app.showFailure = (title, body) => failures.push([title, body]);
  G.app.refreshGuild = (gid) => { refreshed.push(gid); return Promise.resolve(); };
  G.app.state.me = { user: { id: 'u1' }, identities: { bnet: { battletag: 'Brandon#1482' }, discord: { username: 'brandon' } } };
  G.app.state.guilds = {};
  G.app.state.bnetSettings = null;
  G.app.state.discordSettings = null;
  G.app.state.pageAlert = '';
  G.pages.setup.reset();
  G.ui.setText = realSetText;
  G.ui.setBusy = realSetBusy;
  // A dialog is a fake: the page opens it, the test submits its form.
  G.ui.openDialog = (html) => { const dlg = { innerHTML: html, open: true, isConnected: true, querySelector: () => null, contains: () => false }; dialogs.push(dlg); return dlg; };
  G.ui.closeDialogOf = (el) => { const dlg = el && el.closest ? el.closest('dialog') : null; if (dlg) dlg.open = false; };
}

// Scripted API: scriptApi({ 'GET /api/guild/g1/bnet': () => ..., ... }) replaces get / post / put / del and records every call.
function scriptApi(script) {
  const calls = [];
  const respond = (method) => (apiPath, body) => {
    calls.push({ method, path: apiPath, body: body === undefined ? undefined : plain(body) });
    const fn = script[`${method} ${apiPath}`];
    if (!fn) return Promise.reject(new G.api.ApiError(404, { error: 'not_found' }));
    try { return Promise.resolve(fn(body)); } catch (error) { return Promise.reject(error); }
  };
  G.api.get = respond('GET'); G.api.post = respond('POST'); G.api.put = respond('PUT'); G.api.del = respond('DELETE');
  return calls;
}
const apiError = (status, body) => new G.api.ApiError(status, body);
const AUTHORIZE = 'https://oauth.example.test/authorize?state=abc';

function fakeDialog(html = '<form>step 1</form>') {
  const dlg = { innerHTML: html, open: true, isConnected: true, querySelector: () => null, contains: () => false };
  const form = { closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: () => null, querySelectorAll: () => [], elements: {} };
  return { dlg, form };
}
const el = (attrs, extra = {}) => ({ getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null), closest: () => null, ...extra });

// ---------------------------------------------------------------------------
// Fixtures: what the Worker answers (b4b / b5 / b6b / b9 contracts), small

const T0 = Date.UTC(2026, 9, 27, 13, 12);
const GUILD = { id: 'g1', name: 'Writers', realm: 'Dreamscythe', region: 'US', gameVersion: 'tbc', timeZone: 'America/New_York' };
const MASTER = { can: { 'guild.teams': 'guild', 'guild.access': 'guild' }, roles: [{ role: 'guild_master' }], personId: null };
const OFFICER = { can: { 'guild.teams': 'guild', 'guild.access': 'guild' }, roles: [{ role: 'officer' }], personId: null };
const gdOf = (o = {}) => ({ guild: GUILD, teams: [], me: MASTER, owner: { name: 'Brandon', you: true }, ...o });
const DEFAULTS = ['Guild Master', 'Rank 1', 'Rank 2', 'Rank 3', 'Rank 4', 'Rank 5', 'Rank 6', 'Rank 7', 'Rank 8', 'Rank 9'];
const bnetOf = (o = {}) => ({
  configured: true, supported: true, supportLabel: 'TBC Anniversary', message: null, realmKind: 'realm', guildName: null, effectiveGuildName: 'Writers', realmSlug: 'dreamscythe', realmNeeded: false,
  rankLabels: Array(10).fill(''), rankDefaults: DEFAULTS, canEdit: true, pin: { pinned: false, complete: false, rankSource: null, guildSlug: null, realmSlug: null, namespace: null }, pinOpen: true,
  roster: { members: 0, fetchedAt: null }, ...o,
});
const LINKED = (o = {}) => bnetOf({ pin: { pinned: true, complete: true, rankSource: null, guildSlug: 'writers', realmSlug: 'dreamscythe', namespace: 'profile-classicann-us' }, roster: { members: 64, fetchedAt: T0 }, ...o });
const SWITCHED = (o = {}) => LINKED({ pin: { pinned: true, complete: true, rankSource: 'ingame', guildSlug: 'writers', realmSlug: 'dreamscythe', namespace: 'profile-classicann-us' }, ...o });

const MEMBERS = [1, 2, 3, 27, 8, 23, 0, 0, 0, 0];
const LABELS = ['Guild Master', 'Raid Leader', 'Raid Assistant', 'Core Raider', 'Raider', 'Member'];
const rankMapOf = ({ mapped = true } = {}) => ({
  source: 'ingame', rankSource: null, applies: false, rosterSyncId: 'rs1',
  ranks: MEMBERS.map((members, rank) => ({
    rank, mapped: mapped && rank < 6, label: rank < 6 ? LABELS[rank] : DEFAULTS[rank],
    coreRank: mapped && rank < 6 ? ['raider', 'raider', 'raider', 'raider', 'trial', 'social'][rank] : null, roleId: mapped && rank < 3 ? ['guild_master', 'officer', 'team_lead'][rank] : null, members,
  })),
  unmapped: mapped ? [] : [{ rank: 0, members: 1 }, { rank: 1, members: 2 }, { rank: 2, members: 3 }, { rank: 3, members: 27 }, { rank: 4, members: 8 }, { rank: 5, members: 23 }], complete: mapped,
  coreRanks: [{ id: 'raider', label: 'Raider' }, { id: 'trial', label: 'Trial' }, { id: 'reserve', label: 'Reserve' }, { id: 'social', label: 'Social' }],
  roles: [{ id: 'officer', name: 'Officer' }, { id: 'team_lead', name: 'Team Lead' }, { id: 'guild_master', name: 'Guild Master', rankZeroOnly: true }, { id: 'role_loot', name: 'Loot master', custom: true }],
});

const previewOf = (o = {}) => ({
  token: 'tok1', expiresAt: T0 + 600000, rankSource: null, rosterSyncId: 'rs1', confirmedCharacterIds: ['c_1', 'c_2', 'c_3', 'c_4'],
  access: {
    members: { today: 39, afterFlip: 29 },
    loses: { count: 12, reasons: { discord_only: 3, needs_claim: 5, no_roster_character: 3, all_former: 1 }, samples: [
      { reason: 'discord_only', name: 'Brightmane' }, { reason: 'needs_claim', personId: 'p_c', name: 'Cindervale' }, { reason: 'no_roster_character', personId: 'p_a', name: 'Aldersong', unkeyedCharacters: 0 },
      { reason: 'all_former', personId: 'p_g', name: 'Glimmerfen', unkeyedCharacters: 0 }, { reason: 'discord_only', name: null }, { reason: 'discord_only', name: 'Seventh' },
    ] },
    gains: { count: 2, reasons: { linked_person: 2 }, samples: [{ reason: 'linked_person', personId: 'p_t', name: 'Tamsin' }, { reason: 'linked_person', personId: 'p_w', name: 'Wrenna' }] },
  },
  needsClaim: { count: 5, ownerIncluded: false, onRoster: 4, samples: [{ personId: 'p_c', name: 'Cindervale', onRoster: true }, { personId: 'p_t', name: 'Tolliver', onRoster: false }] },
  permissions: {
    gains: { count: 3, byRole: { officer: 1, team_lead: 2 }, reasons: { rank: 3 }, samples: [
      { userId: 'u_a', personId: 'p1', name: 'Ashgrove', roleId: 'officer', roleName: 'Officer', teamId: null, teamName: null, reason: 'rank' },
      { userId: 'u_b', personId: 'p2', name: 'Cinderlow', roleId: 'team_lead', roleName: 'Team Lead', teamId: 't1', teamName: 'Team KJ', reason: 'rank' },
    ] },
    loses: { count: 0, byRole: {}, reasons: {}, samples: [] },
    discordRoles: { count: 6, withHandTwin: 1, samples: [
      { userId: 'u_a', personId: 'p1', name: 'Ashgrove', roleId: 'officer', roleName: 'Officer', teamId: null, teamName: null, handTwin: true },
      { userId: 'u_q', personId: 'p3', name: 'Quill', roleId: 'team_lead', roleName: 'Team Lead', teamId: 't1', teamName: 'Team KJ', handTwin: false },
    ] },
  },
  owner: { exists: true, userId: 'u_o', personId: 'p_o', name: 'Thornwick', source: 'stored_guild_master', live: true, willBeSuspended: false, reason: 'live', via: { characterName: 'Thornwick', rank: 0 }, rosterStored: true, rosterFetchedAt: T0 },
  boundByName: {
    count: 4, ids: ['c_1', 'c_2', 'c_3', 'c_4'], byProof: { officer: 4 }, classMismatch: 1, samples: [
      { characterId: 'c_1', name: 'Pyrewick', class: 'MAGE', rosterRank: 3, personId: 'p9', userId: null, proof: 'officer' }, { characterId: 'c_2', name: 'Marrowind', class: 'ROGUE', rosterRank: 3, personId: 'p8', userId: null, proof: 'officer' },
      { characterId: 'c_3', name: 'Hexwhistle', class: 'DRUID', rosterRank: 4, personId: 'p7', userId: null, proof: 'officer' }, { characterId: 'c_4', name: 'Zephyrion', class: 'MAGE', rosterRank: 5, personId: 'p6', userId: null, proof: 'officer' },
    ],
  },
  ranks: {
    changed: 24, becomesTrial: 7, becomesSocial: 12, transitions: [{ from: 'raider', to: 'trial', count: 7 }, { from: 'raider', to: 'social', count: 12 }, { from: 'trial', to: 'social', count: 5 }],
    samples: [{ name: 'Quillfeather', class: 'HUNTER', from: 'social', to: 'trial', rosterRank: 4 }, { name: 'Rookmantle', class: 'ROGUE', from: 'social', to: 'trial', rosterRank: 4 }, { name: 'Skyward', class: 'SHAMAN', from: 'reserve', to: 'trial', rosterRank: 4 }, { name: 'Dunmere', class: 'SHAMAN', from: 'raider', to: 'social', rosterRank: null }], unmapped: [],
  },
  notOnRoster: { count: 12, former: 7, social: 5, samples: [
    { character: 'Dunmere', class: 'SHAMAN', person: 'Dunmere', after: 'former' }, { character: 'Gravelpriest', class: 'PRIEST', person: 'Gravelkin', after: 'social' },
  ] },
  blockers: [], ...o,
});

const APPLIED = { membersBefore: 39, membersAfter: 29, stay: 27, gains: 2, loses: 12, rankChanges: 24, becameTrial: 7, becameSocial: 12, discordRolesMadeManual: 6, discordRolesDropped: 1, newPermissions: 3, lostPermissions: 0, needsClaim: 5, boundByName: 3, owner: { userId: 'u_o', live: true } };

// A loaded page: load() against a scripted API, then the view.
async function openSetup({ gd = gdOf(), bnet = bnetOf(), extra = {}, carry = null } = {}) {
  if (carry) {
    // What a repeated act leaves for the page: run the act the way #/fresh does, then load.
  }
  G.app.state.guilds.g1 = gd;
  const calls = scriptApi({ 'GET /api/guild/g1/bnet': () => bnet, 'GET /api/guild/g1/rank-map': () => rankMapOf(), ...extra });
  await G.pages.setup.load({ name: 'setup', gid: 'g1' }, gd);
  await settle();
  return { calls, view: G.pages.setup.view(), html: () => G.pages.setup.main({ name: 'setup', gid: 'g1' }, gd) };
}

const noRawAttrs = (html, label) => assert(!/\sstyle=|\son[a-z]+=\s*["']/i.test(html), `${label}: no inline style or handler`);
const bar = (html) => (html.match(/class="gs-commitbar[\s\S]*?<\/div><\/div>/) || [''])[0];
const primaryOf = (html, label) => (html.match(new RegExp(`<(?:button|a) [^>]*gs-btn-molten[^>]*>(?:<span>)?${label}`)) || [null])[0];

// ---------------------------------------------------------------------------
// 1. Settings > Battle.net: the In-game guild panel

check('Battle.net page: the In-game guild panel, not linked - the Owner sees the primary while the pin is open, nobody else does', () => {
  resetBrowser();
  const page = (gd, bnet) => G.pages.settingsBnet.settingsHtml({ guildData: gd, data: bnet, alert: '', notice: '' });
  const owner = page(gdOf(), bnetOf());
  assert(owner.includes('id="bnet-ingame"') && owner.includes('data-state="none"') && owner.includes('>In-game guild<'), 'the panel sits above the form');
  assert(owner.indexOf('bnet-ingame') < owner.indexOf('id="bnet-form"'));
  assert(owner.includes('href="#/g/g1/setup"') && owner.includes('Set up the in-game guild') && /gs-btn-molten[^>]*href="#\/g\/g1\/setup"|href="#\/g\/g1\/setup"[^>]*gs-btn-molten/.test(owner), 'the primary opens Guild setup');
  assert(text(owner).includes('Not linked yet') && text(owner).includes('Writers follows Discord roles for members and ranks.') && text(owner).includes('Not read yet'));
  noRawAttrs(owner, 'panel');
  const closed = page(gdOf(), bnetOf({ pinOpen: false }));
  assert(!closed.includes('Set up the in-game guild') && text(closed).includes('Linking to the in-game guild is not open for this guild yet.'), 'closed: no button, one line for the Owner');
  const officer = page(gdOf({ owner: { name: 'Brandon', you: false }, me: OFFICER }), bnetOf());
  assert(!officer.includes('Set up the in-game guild') && !officer.includes('href="#/g/g1/setup"') && !text(officer).includes('not open for this guild yet'), 'not the Owner: the facts, no button, no remark about the switch');
});

check('Battle.net page: linked (Continue setup for the Owner), switched (Sync now for the Guild Master) and hand-set; the Roster row says how many and when', () => {
  resetBrowser();
  const page = (gd, bnet) => G.pages.settingsBnet.settingsHtml({ guildData: gd, data: bnet, alert: '', notice: '' });
  const linked = page(gdOf(), LINKED());
  assert(linked.includes('data-state="linked"') && linked.includes('Continue setup') && !linked.includes('Set up the in-game guild'));
  assert(text(linked).includes('Writers on Dreamscythe (US)') && text(linked).includes('Not switched yet: Writers still follows Discord roles.'));
  assert(text(linked).includes('64 members') && text(linked).includes('Last read Oct 27, 9:12 AM ET'), text(linked));
  assert(!page(gdOf({ owner: { name: 'Brandon', you: false } }), LINKED()).includes('Continue setup'), 'only the Owner continues');
  assert(page(gdOf(), LINKED({ pinOpen: false })).includes('Continue setup'), 'a linked guild continues whatever the allowlist says: only the pin itself is gated');
  const switched = page(gdOf(), SWITCHED());
  assert(switched.includes('data-state="ingame"') && switched.includes('Sync now') && switched.includes('data-action="bnet-sync-now"') && !switched.includes('Continue setup'));
  assert(text(switched).includes('Members and ranks come from the guild roster.') && text(switched).includes('Last checked Oct 27, 9:12 AM ET'));
  assert(!page(gdOf({ me: OFFICER }), SWITCHED()).includes('Sync now'), 'Sync now is the Guild Master\'s (the Worker refuses the others)');
  const manual = page(gdOf(), bnetOf({ pin: { pinned: false, complete: false, rankSource: 'manual', guildSlug: null, realmSlug: null, namespace: null } }));
  assert(manual.includes('data-state="manual"') && text(manual).includes('Members and ranks are set by hand in this guild.') && !manual.includes('Set up the in-game guild'));
  assert(text(page(gdOf(), LINKED({ roster: { members: 0, fetchedAt: null } }))).includes('Not read yet'));
  // The spec's time: a date like "Oct 27", the guild's zone, no weekday, the year only when it is not this year.
  assert(!/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(text(linked).slice(text(linked).indexOf('Last read'))), 'no weekday in the Roster row');
  const lastYear = Date.UTC(new Date().getFullYear() - 1, 9, 27, 13, 12);
  assert.equal(G.ui.formatStamp(T0, 'America/New_York'), 'Oct 27, 9:12 AM ET');
  assert.equal(G.ui.formatStamp(lastYear, 'America/New_York'), `Oct 27, ${new Date().getFullYear() - 1}, 9:12 AM ET`);
  assert.equal(G.ui.formatStamp(NaN, 'America/New_York'), '');
  assert.equal(G.ui.formatDateTime(T0, 'America/New_York'), 'Tue Oct 27, 9:12 AM ET', 'the app-wide time keeps its weekday');
});

check('Battle.net page: once pinned the guild name and realm are read-only and stay out of the PUT; the rank names are still saved', async () => {
  resetBrowser();
  const free = G.pages.settingsBnet.settingsHtml({ guildData: gdOf(), data: bnetOf(), alert: '', notice: '' });
  assert(/id="bnet-guild-name"[^>]*data-field="guildName"/.test(free) && !/id="bnet-guild-name"[^>]*readonly/.test(free), 'free before the pin');
  const pinned = G.pages.settingsBnet.settingsHtml({ guildData: gdOf(), data: LINKED(), alert: '', notice: '' });
  assert(/id="bnet-guild-name"[^>]*readonly/.test(pinned), 'the guild name is read-only');
  assert(!/id="bnet-rank-0"[^>]*readonly/.test(pinned) && !/id="bnet-rank-0"[^>]*disabled/.test(pinned), 'the rank names stay editable');
  const ruleset = G.pages.settingsBnet.settingsHtml({ guildData: gdOf(), data: LINKED({ realmKind: 'ruleset', realmSlug: 'old-blanchy' }), alert: '', notice: '' });
  assert(/id="bnet-realm"[^>]*readonly/.test(ruleset), 'the ruleset realm is read-only too');
  // The submit sends only the rank names.
  G.app.state.bnetSettings = { gid: 'g1', data: LINKED({ guildName: 'Writers' }), notice: '' };
  const elements = { guildName: { value: 'Writers' } };
  for (let i = 0; i < 10; i++) elements['rank' + i] = { value: i === 0 ? 'Guild Master' : '' };
  const sent = [];
  G.api.put = (p, body) => { sent.push([p, plain(body)]); return Promise.resolve(LINKED()); };
  G.app.markSettingsSaved = () => {};
  G.ui.setText = () => {};
  G.ui.setBusy = () => {};
  G.handlers.submit['bnet-settings']({ elements });
  await settle();
  assert.equal(sent.length, 1);
  assert(!('guildName' in sent[0][1]) && !('realmSlug' in sent[0][1]) && sent[0][1].rankLabels[0] === 'Guild Master', JSON.stringify(sent[0][1]));
  // Not pinned: the guild name goes along as before.
  G.app.state.bnetSettings = { gid: 'g1', data: bnetOf(), notice: '' };
  G.handlers.submit['bnet-settings']({ elements });
  await settle();
  assert.equal(sent[1][1].guildName, 'Writers');
});

check('Battle.net page: Sync now posts to the roster sync, then reads the panel again; a refusal is the page alert', async () => {
  resetBrowser();
  G.app.state.bnetSettings = { gid: 'g1', data: SWITCHED(), notice: '' };
  let call = 0;
  const calls = scriptApi({
    'POST /api/guild/g1/roster-sync': () => { call++; if (call === 2) throw apiError(429, { error: 'sync_too_soon', message: 'The roster was synced less than an hour ago. Try again later.' }); return { status: 'applied' }; },
    'GET /api/guild/g1/bnet': () => SWITCHED({ roster: { members: 65, fetchedAt: T0 + 3600000 } }),
  });
  const button = { disabled: false };
  G.handlers.click['bnet-sync-now'](button);
  await settle();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /api/guild/g1/roster-sync', 'GET /api/guild/g1/bnet']);
  assert.equal(G.app.state.bnetSettings.data.roster.members, 65);
  assert(G.app.state.bnetSettings.notice.includes('65 members'), G.app.state.bnetSettings.notice);
  button.disabled = false; // the re-render drew a fresh button
  G.handlers.click['bnet-sync-now'](button);
  await settle();
  assert.equal(G.app.state.pageAlert, 'The roster was synced less than an hour ago. Try again later.');
  assert.equal(button.disabled, false);
});

// ---------------------------------------------------------------------------
// 2. Settings > Discord roles

check('Discord roles page: a guild with a rank source shows one line instead of the mapping form; a refused save does the same', async () => {
  resetBrowser();
  const DISCORD = { bot: { configured: true, inServer: true, inviteUrl: null, problem: null }, roles: [{ id: '700000000000000001', name: 'Officers' }], maps: [], targets: [{ roleId: 'officer', name: 'Officer' }] };
  const open = async (rankSource) => {
    scriptApi({
      'GET /api/guild/g1/discord': () => JSON.parse(JSON.stringify(DISCORD)),
      'GET /api/guild/g1/bnet': () => (rankSource === 'denied' ? Promise.reject(apiError(403, { error: 'forbidden' })) : bnetOf({ pin: { pinned: true, complete: true, rankSource: rankSource === 'none' ? null : rankSource } })),
    });
    await G.pages.settingsDiscord.load('g1');
    return G.pages.settingsDiscord.settingsHtml({ guildData: gdOf(), data: G.app.state.discordSettings.data, alert: '', notice: '' });
  };
  const legacy = await open('none');
  assert(legacy.includes('id="discord-form"') && legacy.includes('Officers') && !legacy.includes('discord-roles-off'), 'the legacy guild keeps its form');
  const ingame = await open('ingame');
  assert(!ingame.includes('id="discord-form"') && !ingame.includes('Save mapping') && ingame.includes('id="discord-roles-off"'), 'the form is gone');
  assert(text(ingame).includes('This guild takes its roles from the in-game guild roster, so Discord roles do not give any here.'));
  const manual = await open('manual');
  assert(text(manual).includes('This guild sets its roles by hand, so Discord roles do not give any here.') && !manual.includes('id="discord-form"'));
  // A person who cannot read the Battle.net settings still gets the form; the save is refused and the page turns into the line.
  const denied = await open('denied');
  assert(denied.includes('id="discord-form"'), 'no rank source known: the form');
  G.api.discord.saveMaps = () => Promise.reject(apiError(409, { error: 'discord_roles_off', message: 'This guild takes its roles from the in-game guild roster, so Discord roles do not give any here.' }));
  const form = { querySelectorAll: () => [] };
  G.ui.setBusy = () => {};
  G.ui.setText = () => {};
  G.handlers.submit['discord-maps'](form);
  await settle();
  assert.equal(G.app.state.discordSettings.data.rankSource, 'ingame');
  const after = G.pages.settingsDiscord.settingsHtml({ guildData: gdOf(), data: G.app.state.discordSettings.data, alert: '', notice: '' });
  assert(!after.includes('id="discord-form"') && after.includes('discord-roles-off'));
});

// ---------------------------------------------------------------------------
// 3. Guild setup: who sees what

check('Guild setup: anyone but the Owner sees the facts and no button; a hand-set guild says so', async () => {
  resetBrowser();
  const { html } = await openSetup({ gd: gdOf({ owner: { name: 'Brandon', you: false }, me: OFFICER }), bnet: LINKED() });
  const page = html();
  assert(/<h1[^>]*>Guild setup<\/h1>/.test(page) && page.includes('gs-stepper'));
  assert(text(page).includes('Only Brandon can set up the in-game guild.') && text(page).includes('Writers on Dreamscythe (US)') && text(page).includes('64 members'));
  assert(!page.includes('gs-commitbar') && !page.includes('gs-btn-molten') && !page.includes('data-action="setup-'), 'no bar, no primary, no action');
  noRawAttrs(page, 'read-only');
  const unlinked = await openSetup({ gd: gdOf({ owner: { name: null, you: false }, me: OFFICER }), bnet: bnetOf() });
  assert(text(unlinked.html()).includes('Only the Owner can set up the in-game guild.') && text(unlinked.html()).includes('Not linked yet'));
  const manual = await openSetup({ bnet: bnetOf({ pin: { pinned: false, complete: false, rankSource: 'manual' } }) });
  assert(text(manual.html()).includes('Members and ranks are set by hand in this guild.') && !manual.html().includes('gs-commitbar'));
});

check('Guild setup: the loading state keeps the head and the steps; only the Owner\'s handlers act', async () => {
  resetBrowser();
  G.pages.setup.reset();
  const loading = G.pages.setup.main({ name: 'setup', gid: 'g1' }, gdOf());
  assert(/<h1[^>]*>Guild setup<\/h1>/.test(loading) && loading.includes('aria-busy="true"') && loading.includes('gs-stepper') && !loading.includes('gs-commitbar'));
  const calls = scriptApi({});
  const { view } = await openSetup({ gd: gdOf({ owner: { name: 'Brandon', you: false }, me: OFFICER }), bnet: LINKED() });
  const seen = calls.length;
  G.handlers.click['setup-pin-next']();
  G.handlers.click['setup-ranks-next']();
  G.handlers.click['setup-switch']();
  await settle();
  assert.equal(view.owner, false);
  assert.equal(dialogs.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Guild setup, step 1: In-game guild

const PIN_ANSWER = { pinned: true, mode: 'first', guildName: 'Writers', guildSlug: 'writers', realmSlug: 'dreamscythe', namespace: 'profile-classicann-us', rankSource: null, sync: { status: 'applied', reason: null, members: 64, syncId: 'rs_1' } };
const stepForm = (dlg, provider) => ({ closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: (sel) => (provider && /input\[name="provider"\]/.test(sel) ? { value: provider } : null), querySelectorAll: () => [] });
const pendingRecord = (o = {}) => ({ kind: 'pin', gid: 'g1', purpose: 'pin', params: { guildName: 'Writers', realmSlug: 'dreamscythe' }, data: { guildName: 'Writers', realmSlug: 'dreamscythe' }, provider: 'bnet', returnTo: '#/g/g1/setup', at: Date.now(), ...o });
const stepperOf = (html) => [...html.matchAll(/<li class="gs-step is-(\w+)"/g)].map((m) => m[1]);

check('Guild setup, step 1 (G1): the guild name typed, the realm from the guild, the Battle.net account; the primary starts the sign-in with the name and keeps the act', async () => {
  resetBrowser();
  const { html, view } = await openSetup();
  const page = html();
  assert(/<h1[^>]*>Guild setup<\/h1>/.test(page) && page.includes('class="gs-back-link" href="#/g/g1/settings/battlenet"'), 'the head: Battle.net is the way back');
  assert.deepEqual(stepperOf(page), ['current', 'later', 'later', 'later']);
  assert(/id="pin-name"[^>]*value="Writers"/.test(page) && !/id="pin-name"[^>]*readonly/.test(page), 'the name is typed, prefilled with the guild\'s Battle.net name');
  assert(text(page).includes('Realm: Dreamscythe (US)') && !page.includes('id="pin-realm" maxlength'), 'a realm guild shows its realm as a fact line');
  assert(text(page).includes('Confirm it is you') && text(page).includes('Brandon#1482') && text(page).includes('Raidsmith checks that this account holds a character on the guild\'s roster.'));
  assert(text(bar(page)).includes('Writers, Dreamscythe (US).') && primaryOf(page, 'Confirm with Battle.net') && !bar(page).includes('Back'), 'the bar: the name and realm, no Back on step 1');
  noRawAttrs(page, 'step 1');
  // Empty name: the field says so and nothing is sent.
  let calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.input['setup-pin-name']({ value: '  ' });
  G.handlers.click['setup-pin']();
  assert(text(html()).includes('Type the guild\'s name as it is spelled in game.') && calls.length === 0 && navigations.length === 0);
  // The sign-in carries the typed name and the realm; the act is kept for the way back.
  G.handlers.input['setup-pin-name']({ value: 'Writers Guild' });
  G.handlers.click['setup-pin']();
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/fresh/start', body: { purpose: 'pin', params: { guildName: 'Writers Guild', realmSlug: 'dreamscythe' }, provider: 'bnet' } });
  assert.deepEqual(navigations, [AUTHORIZE]);
  const saved = plain(G.fresh.pending());
  assert.deepEqual([saved.kind, saved.gid, saved.purpose, saved.data, saved.returnTo], ['pin', 'g1', 'pin', { guildName: 'Writers Guild', realmSlug: 'dreamscythe' }, '#/g/g1/setup']);
  assert.equal(view.busy, true, 'busy while the browser is on its way');
  // No Battle.net on the account: the refusal needs no round trip.
  resetBrowser();
  G.app.state.me = { user: { id: 'u1' }, identities: { discord: { username: 'brandon' } } };
  const second = await openSetup();
  calls = scriptApi({});
  G.handlers.click['setup-pin']();
  const banner = text(second.html());
  assert(banner.includes('Link Battle.net to your account first.') && banner.includes('The guild roster is read through Battle.net.') && second.html().includes('href="#/linked"') && calls.length === 0);
  assert(text(second.html()).includes('Not linked yet'), 'the account line says so');
});

check('Guild setup, step 1: a ruleset guild types the realm too', async () => {
  resetBrowser();
  const { html } = await openSetup({ gd: gdOf({ guild: { ...GUILD, realm: 'WoW Forever', gameVersion: 'forever' } }), bnet: bnetOf({ realmKind: 'ruleset', realmSlug: null, realmNeeded: true }) });
  assert(/id="pin-realm"[^>]*placeholder="old-blanchy"/.test(html()), 'the realm is an input');
  let calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.click['setup-pin']();
  assert(text(html()).includes('Type the realm the guild lives on.') && calls.length === 0);
  G.handlers.input['setup-pin-realm']({ value: 'Old Blanchy' });
  G.handlers.click['setup-pin']();
  await settle();
  assert.deepEqual(calls[0].body.params, { guildName: 'Writers', realmSlug: 'Old Blanchy' }, 'typed as the realm is named: the Worker makes the slug');
});

check('Guild setup, step 1: the pin act posts the name on the way back and lands on step 1 linked (G1b)', async () => {
  resetBrowser();
  const sent = [];
  scriptApi({ 'POST /api/guild/g1/bnet/pin': (body) => { sent.push(plain(body)); return PIN_ANSWER; } });
  const address = await G.fresh.repeat(pendingRecord());
  assert.equal(address, '#/g/g1/setup');
  assert.deepEqual(sent, [{ guildName: 'Writers', realmSlug: 'dreamscythe' }]);
  const { html, view } = await openSetup({ bnet: LINKED() });
  const page = html();
  assert(text(page).includes('Linked to Writers on Dreamscythe.') && !text(page).includes('Linked to Writers on Dreamscythe (US)') && text(page).includes('64 members read from the guild roster.') && page.includes('gs-banner-success'), 'the success banner with the count');
  assert(/id="pin-name"[^>]*readonly/.test(page) && /id="pin-name"[^>]*value="Writers"/.test(page), 'the name is the pin\'s now');
  assert(text(page).includes('Confirmed just now.') && page.includes('is-done'));
  assert(text(bar(page)).includes('Writers, Dreamscythe (US): 64 members.') && primaryOf(page, 'Next') && !/disabled/.test(bar(page).match(/<[^>]*>Next/)[0]), 'Next is the primary');
  assert.equal(view.pinResult.mode, 'first');
  // A reload without the act: the same page, no "just now".
  resetBrowser();
  const again = await openSetup({ bnet: LINKED() });
  assert(!text(again.html()).includes('Confirmed just now.') && text(again.html()).includes('Confirmed when the guild was linked.') && !again.html().includes('gs-banner-success'));
  // The roster could not be read on the first try: the pin stands, Next waits, the Guild Master can read it again.
  resetBrowser();
  scriptApi({ 'POST /api/guild/g1/bnet/pin': () => ({ ...PIN_ANSWER, sync: { status: 'failed', reason: 'bnet_unavailable', members: 0, syncId: 'x' } }) });
  await G.fresh.repeat(pendingRecord());
  const failed = await openSetup({ bnet: LINKED({ roster: { members: 0, fetchedAt: null } }) });
  assert(text(failed.html()).includes('Linked to Writers.') && text(failed.html()).includes('The guild roster could not be read just now.') && failed.html().includes('data-action="setup-sync"'));
  assert(/<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(failed.html()) && text(bar(failed.html())).includes('The roster has not been read yet.'));
  const calls = scriptApi({ 'POST /api/guild/g1/roster-sync': () => ({ status: 'applied' }), 'GET /api/guild/g1/bnet': () => LINKED() });
  G.handlers.click['setup-sync']();
  await settle();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /api/guild/g1/roster-sync', 'GET /api/guild/g1/bnet']);
  assert(!failed.html().includes('data-action="setup-sync"') && text(failed.html()).includes('64 members read from the guild roster.'), 'read: the success banner');
});

check('Guild setup, step 1: the act\'s refusals land on step 1 as a banner (G6 #4); the sign-in\'s own failure is the fresh page\'s', async () => {
  const cases = [
    [403, 'pin_not_on_roster', 'None of your characters is on the Writers roster.', 'Check the guild name, or sign in with the Battle.net account that holds your character.'],
    [409, 'pin_taken', 'Another Raidsmith guild already follows this in-game guild.', 'One in-game guild belongs to one Raidsmith guild.'],
    [409, 'pin_locked', 'This guild is linked to another in-game guild.', 'Only the same in-game guild can be linked again, after a rename or a realm move.'],
    [404, 'bnet_guild_not_found', 'Battle.net has no guild called Writers on this realm.', 'Check how the guild name is spelled in game.'],
    [502, 'bnet_unavailable', 'Battle.net did not answer.', 'Try again in a moment.'],
    [409, 'roster_too_large', 'That in-game guild is too large to link.', 'at most 1,200 members'],
  ];
  for (const [status, code, title, body] of cases) {
    resetBrowser();
    scriptApi({ 'POST /api/guild/g1/bnet/pin': () => { throw apiError(status, { error: code, message: 'Worker words' }); } });
    const address = await G.fresh.repeat(pendingRecord());
    assert.equal(address, '#/g/g1/setup', code);
    const { html } = await openSetup();
    assert(html().includes('gs-banner-warning') && text(html()).includes(title) && text(html()).includes(body), `${code}: ${text(html()).slice(0, 400)}`);
    assert(/<button[^>]*(?:gs-btn-molten)[^>]*data-action="setup-pin"/.test(html()) || html().includes('data-action="setup-pin"'), `${code}: the page is still step 1, ready to try again`);
  }
  resetBrowser();
  scriptApi({ 'POST /api/guild/g1/bnet/pin': () => { throw apiError(403, { error: 'fresh_required', message: 'x', purpose: 'pin' }); } });
  await assert.rejects(G.fresh.repeat(pendingRecord()), (error) => error.code === 'fresh_required', 'the page for the sign-in says it did not count');
  scriptApi({ 'POST /api/guild/g1/bnet/pin': () => { throw apiError(401, { error: 'signed_out' }); } });
  await assert.rejects(G.fresh.repeat(pendingRecord()), (error) => error.status === 401);
  // The refused start (before the trip to Battle.net) is the same banner.
  resetBrowser();
  const { html } = await openSetup();
  scriptApi({ 'POST /api/guild/g1/fresh/start': () => { throw apiError(403, { error: 'identity_too_new', message: 'x', provider: 'bnet', eligibleAt: Date.UTC(2026, 10, 3, 12) }); } });
  G.handlers.click['setup-pin']();
  await settle();
  assert(text(html()).includes('This Battle.net account was linked a few days ago.') && text(html()).includes('It can confirm this from Nov 3, 2026.'), text(html()));
  scriptApi({ 'POST /api/guild/g1/fresh/start': () => { throw apiError(403, { error: 'pin_not_open', message: 'x' }); } });
  G.handlers.click['setup-pin']();
  await settle();
  assert(text(html()).includes('Linking to the in-game guild is not open yet.'));
});

// ---------------------------------------------------------------------------
// 5. Step 2: Ranks

async function atRanks(o = {}) {
  resetBrowser();
  const opened = await openSetup({ bnet: LINKED(), ...o });
  const rankMap = o.rankMap || rankMapOf();
  scriptApi({
    'GET /api/guild/g1/bnet': () => LINKED(), 'GET /api/guild/g1/rank-map': () => rankMap,
    'POST /api/guild/g1/rank-map/dry-run': () => ({ token: 'rm1', expiresAt: T0, applies: false }), 'PUT /api/guild/g1/rank-map': () => ({ ...rankMapOf(), applied: { mapRows: 6, characters: 0 } }),
    'POST /api/guild/g1/flip/dry-run': () => previewOf(), ...(o.extra || {}),
  });
  G.handlers.click['setup-pin-next']();
  await settle();
  return opened;
}
const select = (rank, kind, value) => G.handlers.change['setup-rank-' + kind](el({ 'data-rank': String(rank) }, { value }));

check('Guild setup, step 2 (G2): one row per in-game rank, rank 0 locked, unused ranks muted, a used rank without a core rank flagged with the reason in the bar', async () => {
  const { html, view } = await atRanks();
  assert.equal(view.step, 2);
  const page = html();
  assert.deepEqual(stepperOf(page), ['done', 'current', 'later', 'later']);
  assert(text(page).includes('Battle.net gives guild ranks as numbers only.') && text(page).includes('Ranks nobody holds can stay unmapped.'));
  assert.equal((page.match(/<tr[ >]/g) || []).length, 11, 'a header row and ten ranks');
  assert(/id="rk-0-p"[^>]*disabled><option>Guild Master<\/option>/.test(page), 'rank 0 is locked to Guild Master');
  assert(/id="rk-0-n"[^>]*value="Guild Master"/.test(page) && /id="rk-3-n"[^>]*value="Core Raider"/.test(page));
  assert((page.match(/class="is-unused"/g) || []).length === 4 && /id="rk-6-n"[^>]*placeholder="Rank 6" value=""/.test(page), 'ranks 6-9 are muted with an empty name');
  assert(/id="rk-6-c"[\s\S]*?<option value="" selected>Not mapped<\/option>/.test(page), 'an unused rank is Not mapped');
  assert(/id="rk-2-p"[\s\S]*?<option value="team_lead" selected>Team Lead \(their own team\)<\/option>/.test(page) && page.includes('Loot master'), 'the permission choices: None, Officer, Team Lead, the guild\'s own roles');
  assert(!/value="guild_master"/.test(page.replace(/id="rk-0-p"[\s\S]*?<\/select>/, '')), 'Guild Master is offered for rank 0 only');
  assert(text(bar(page)).includes('6 of 6 ranks in use are mapped.') && primaryOf(page, 'Next') && bar(page).includes('data-action="setup-back"'));
  assert(!text(page).includes('Map every in-game rank first.'), 'nothing to flag');
  noRawAttrs(page, 'step 2');
  // A used rank with no core rank: flagged, named in a banner, Next off.
  select(3, 'core', '');
  const gap = html();
  assert(gap.includes('gs-banner-warning') && text(gap).includes('Map every in-game rank first. Not mapped yet: Core Raider (27 members).'), text(gap).slice(0, 500));
  assert(/<tr class="is-gap">/.test(gap) && /<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(gap) && text(bar(gap)).includes('1 of 6 ranks in use are not mapped.'));
  G.handlers.click['setup-ranks-next']();
  await settle();
  assert.equal(view.step, 2, 'Next does nothing while a rank is unmapped');
  // Back goes to step 1, nothing lost.
  G.handlers.click['setup-back']();
  assert.equal(view.step, 1);
});

check('Guild setup, step 2: Next with changes is the dry run, then the PUT with its token; a "Not mapped" rank stays out of both; rank 0 is always Guild Master', async () => {
  const { view } = await atRanks({ rankMap: rankMapOf({ mapped: false }) });
  const calls = scriptApi({
    'POST /api/guild/g1/rank-map/dry-run': () => ({ token: 'rm1', expiresAt: T0, applies: false }), 'PUT /api/guild/g1/rank-map': () => ({ ...rankMapOf(), applied: { mapRows: 6, characters: 0 } }),
    'POST /api/guild/g1/flip/dry-run': () => previewOf(),
  });
  assert.equal(view.step, 2);
  assert(G.pages.setup.gapsOf(view.rows).length === 6, 'nothing is mapped yet: six used ranks are gaps');
  [[0, 'raider'], [1, 'raider'], [2, 'raider'], [3, 'raider'], [4, 'trial'], [5, 'social']].forEach(([rank, core]) => select(rank, 'core', core));
  select(1, 'role', 'officer');
  select(2, 'role', 'team_lead');
  G.handlers.input['setup-rank-label']({ getAttribute: () => '4', value: '  Raider  ' });
  G.handlers.input['setup-rank-label']({ getAttribute: () => '0', value: '' });
  G.handlers.click['setup-ranks-next']();
  await settle();
  const want = [
    { rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master' }, { rank: 1, label: 'Raid Leader', coreRank: 'raider', roleId: 'officer' },
    { rank: 2, label: 'Raid Assistant', coreRank: 'raider', roleId: 'team_lead' }, { rank: 3, label: 'Core Raider', coreRank: 'raider', roleId: null },
    { rank: 4, label: 'Raider', coreRank: 'trial', roleId: null }, { rank: 5, label: 'Member', coreRank: 'social', roleId: null },
  ];
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /api/guild/g1/rank-map/dry-run', 'PUT /api/guild/g1/rank-map', 'POST /api/guild/g1/flip/dry-run']);
  assert.deepEqual(calls[0].body, { ranks: want }, 'ranks 6-9 (Not mapped) are left out, the cleared name falls back to the default');
  assert.deepEqual(calls[1].body, { ranks: want, token: 'rm1' }, 'the PUT carries the dry run\'s token');
  assert.equal(view.step, 3, 'the map is saved: the preview is next');
  assert(view.preview && view.preview.token === 'tok1');
  // The body builder on its own: an unused rank that is mapped is sent, with its default name.
  const rows = G.pages.setup.rowsOf(rankMapOf());
  rows[7].core = 'reserve';
  const body = G.pages.setup.mapBody(rows, DEFAULTS);
  assert.deepEqual(plain(body.map((r) => r.rank)), [0, 1, 2, 3, 4, 5, 7]);
  assert.deepEqual(plain(body[6]), { rank: 7, label: 'Rank 7', coreRank: 'reserve', roleId: null });
});

check('Guild setup, step 2: an unchanged map is not saved again; a refused save is a banner and keeps the person on the step', async () => {
  const { view } = await atRanks();
  const calls = scriptApi({ 'POST /api/guild/g1/flip/dry-run': () => previewOf() });
  G.handlers.click['setup-ranks-next']();
  await settle();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /api/guild/g1/flip/dry-run'], 'no dry run, no PUT');
  assert.equal(view.step, 3);
  // Refusals of the save.
  for (const [status, code, title] of [[400, 'rank_zero_only', 'Only rank 0 can be Guild Master.'], [429, 'rate_limited', 'Too many tries.'], [409, 'approval_stale', 'The guild changed while the map was being saved.'], [409, 'approval_invalid', 'The guild changed while the map was being saved.']]) {
    const again = await atRanks();
    select(3, 'core', 'trial');
    scriptApi({
      'POST /api/guild/g1/rank-map/dry-run': () => { throw apiError(status, { error: code, message: 'Worker words', retryAfter: 60 }); },
    });
    G.handlers.click['setup-ranks-next']();
    await settle();
    assert.equal(again.view.step, 2, code);
    assert(again.html().includes('gs-banner-warning') && text(again.html()).includes(title), `${code}: ${text(again.html()).slice(0, 300)}`);
    assert(!/<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(again.html()), `${code}: Next is back`);
  }
});

// ---------------------------------------------------------------------------
// 6. Step 3: Preview

async function atPreview(o = {}) {
  const opened = await atRanks({ extra: { 'POST /api/guild/g1/flip/dry-run': () => (o.preview || previewOf()) } });
  G.handlers.click['setup-ranks-next']();
  await settle();
  return opened;
}

check('Guild setup, step 3 (G3): the Owner panel, the summary, five tiles and the four panels, from the flip dry run', async () => {
  const { html, view } = await atPreview();
  assert.equal(view.step, 3);
  const page = html();
  const t = text(page);
  assert.deepEqual(stepperOf(page), ['done', 'done', 'current', 'later']);
  assert(t.includes('Owner Brandon Live Thornwick (rank 0, Guild Master) is on the roster and confirmed by Battle.net, so Brandon keeps every Owner power.'), 'the Owner is live through a character, with the rank\'s name');
  assert(t.includes('29 accounts are members of Writers after the switch. 27 stay, 2 gain access, 12 lose it.'));
  const tiles = [...page.matchAll(/gs-fg-lbl">([^<]+)<\/span><span class="gs-su-stat-n">(\d+)/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(tiles, [['Lose access', 12], ['Gain access', 2], ['Core rank changes', 24], ['Become Trial', 7], ['New permissions', 3]]);
  for (const panel of ['Access', 'Ranks', 'Permissions', 'Characters']) assert(page.includes(`aria-label="${panel}"`), panel);
  // Access: the reasons in plain words; an account without a name is still a row; the claims section names how many are on the roster.
  assert(t.includes('Lose access 12') && t.includes('Brightmane Only in Discord: no person of the guild is theirs') && t.includes('Cindervale Their person waits for their claim') && t.includes('Aldersong No character of theirs is on the roster'));
  assert(t.includes('Unnamed account') && t.includes('Glimmerfen Every character of theirs has left the guild'));
  assert(t.includes('Gain access 2') && t.includes('Tamsin Their person is on the roster'));
  assert(t.includes('Waiting for their claim 5') && t.includes('4 of the 5 are on the roster. The switch links nobody: each player claims theirs with This is me.'));
  // Ranks: the aggregated changes in words, then the characters.
  assert(t.includes('Core rank changes 24') && /Raider Trial 7/.test(t) && /Raider Social 12/.test(t));
  assert(t.includes('Become Trial 7') && t.includes('Quillfeather Social Raider') && t.includes('Skyward Reserve Raider') && !t.includes('Dunmere Raider Social'), 'the Trial characters with their in-game rank; the group is not the list of every change');
  assert(!t.includes('Characters that change rank'));
  // Permissions and characters.
  assert(t.includes('New permissions 3') && t.includes('Ashgrove Officer Whole guild') && t.includes('Cinderlow Team Lead Team KJ'));
  assert(t.includes('Roles from Discord that become hand-set 6') && t.includes('Ashgrove Officer Also set by hand: the copy is removed') && t.includes('Quill Team Lead, Team KJ Kept'));
  assert(t.includes('Lose permissions 0 No permission is taken away.'));
  assert(t.includes('Not on the guild roster 12') && t.includes('Dunmere Dunmere Former') && t.includes('Gravelpriest Gravelkin Social'));
  assert(t.includes('Matched by name only 4') && t.includes('Pyrewick Core Raider') && t.includes('Hexwhistle Raider') && t.includes('Zephyrion Member'), 'the roster rank is the rank\'s name');
  assert(t.includes('Unticked characters are not matched: they stay Social and off the roster. 1 more has the right name with another class and is not matched.'));
  assert(text(bar(page)).includes('29 members after the switch, 24 core ranks change.') && primaryOf(page, 'Next') && bar(page).includes('data-action="setup-back"'));
  noRawAttrs(page, 'step 3');
});

check('Guild setup, step 3: groups show the first rows and "Show all" opens the samples; a list longer than its samples says so', async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ reason: 'discord_only', name: `Lost${String(i).padStart(2, '0')}` }));
  const { html } = await atPreview({ preview: previewOf({ access: { members: { today: 100, afterFlip: 70 }, loses: { count: 30, reasons: { discord_only: 30 }, samples: many }, gains: { count: 0, reasons: {}, samples: [] } } }) });
  const group = (page) => (page.match(/data-group="lose"[\s\S]*?(?=data-group="gain"|<div class="gs-su-group"><h3 class="gs-fg-gh"><span class="gs-fg-ght">Gain)/) || [''])[0];
  const first = group(html());
  assert.equal((first.match(/<th scope="row"/g) || []).length, 5, 'five rows to begin with');
  assert(text(first).includes('Showing 5 of 30') && first.includes('data-action="setup-show-all"') && first.includes('data-group="lose"'));
  G.handlers.click['setup-show-all'](el({ 'data-group': 'lose' }));
  const all = group(html());
  assert.equal((all.match(/<th scope="row"/g) || []).length, 25, 'all the samples');
  assert(text(all).includes('Showing 25 of 30.') && !all.includes('data-action="setup-show-all"'), 'the answer carries 25 of 30: no button for the rest');
  assert(text(html()).includes('Nobody gains access.'), 'an empty group says so');
});

check('Guild setup, step 3: a tick per character bound by name, default ticked; the beyond-the-samples candidates share one tick; the flip takes what is ticked', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `c_${i + 1}`);
  const samples = ids.slice(0, 25).map((id, i) => ({ characterId: id, name: `Bound${String(i).padStart(2, '0')}`, class: 'MAGE', rosterRank: 3, personId: `p${i}`, userId: null, proof: 'officer' }));
  const { html, view } = await atPreview({ preview: previewOf({ confirmedCharacterIds: ids, boundByName: { count: 30, ids, byProof: {}, classMismatch: 0, samples } }) });
  const page = html();
  assert.equal((page.match(/class="gs-su-chk"/g) || []).length, 26, '25 samples and one for the rest');
  assert.equal((page.match(/class="gs-su-chk"[^>]*checked/g) || []).length, 26, 'all ticked');
  assert(page.includes('aria-label="Match Bound00 to the roster"') && page.includes('aria-label="Match the other 5 characters to the roster"') && text(page).includes('5 more characters'));
  assert.deepEqual(plain(G.pages.setup.confirmedIds(view)), ids);
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_2' }, { checked: false }));
  G.handlers.change['setup-bind'](el({ 'data-id': '*rest*' }, { checked: false }));
  assert.deepEqual(plain(G.pages.setup.confirmedIds(view)), ids.slice(0, 25).filter((id) => id !== 'c_2'), 'one sample and the rest unticked');
  assert(/id="bn-1"(?![^>]*checked)/.test(html()) && /id="bn-rest"(?![^>]*checked)/.test(html()));
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_2' }, { checked: true }));
  assert(G.pages.setup.confirmedIds(view).includes('c_2'));
});

check('Guild setup, step 3: a preview that the flip would refuse says so; Next stays off (G6 #2)', async () => {
  const suspended = previewOf({
    owner: { exists: true, userId: 'u_o', name: 'Brandon', source: 'stored_guild_master', live: false, willBeSuspended: true, reason: 'no_proven_character', via: null, rosterStored: true, rosterFetchedAt: T0 },
    permissions: { ...previewOf().permissions, loses: { count: 1, byRole: { guild_master: 1 }, reasons: { owner_not_live: 1 }, samples: [{ userId: 'u_o', name: 'Brandon', roleId: 'guild_master', roleName: 'Guild Master', teamId: null, teamName: null, reason: 'owner_not_live' }] } },
    blockers: [{ code: 'owner_would_be_suspended', message: 'Worker words' }],
  });
  const { html } = await atPreview({ preview: suspended });
  const page = html();
  assert(page.includes('gs-su-owner is-bad') && text(page).includes('Would be suspended') && page.includes('href="/auth/bnet/login"') && text(page).includes('Sign in with Battle.net'), 'the Owner panel, with the way to prove a character');
  assert(text(page).includes('Lose permissions 1 Account Permission Why Brandon Guild Master The Owner would be suspended'));
  assert(text(bar(page)).includes('Sign in with Battle.net before you switch.') && /<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(page), 'the reason beside the disabled Next');
  G.handlers.click['setup-preview-next']();
  assert.equal(G.pages.setup.view().step, 3, 'Next does nothing');
  // Another blocker: a banner with its sentence.
  const incomplete = previewOf({ blockers: [{ code: 'rank_map_incomplete', message: 'Worker words', ranks: [{ rank: 3, members: 27 }, { rank: 9, members: 1 }] }] });
  const second = await atPreview({ preview: incomplete });
  assert(text(second.html()).includes('Map every in-game rank first. Not mapped yet: Core Raider (27 members), Rank 9 (1 member).') && text(bar(second.html())).includes('Map every in-game rank first.'));
  // A failed preview: the banner and a way to run it again.
  const failed = await atRanks({ extra: { 'POST /api/guild/g1/flip/dry-run': () => { throw apiError(429, { error: 'rate_limited', message: 'Too many dry runs.', retryAfter: 120 }); } } });
  G.handlers.click['setup-ranks-next']();
  await settle();
  assert(text(failed.html()).includes('Too many tries.') && failed.html().includes('data-action="setup-preview-again"') && /<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(failed.html()));
  scriptApi({ 'POST /api/guild/g1/flip/dry-run': () => previewOf() });
  G.handlers.click['setup-preview-again']();
  await settle();
  assert(failed.view.preview && !text(failed.html()).includes('Too many tries.'));
});

check('Guild setup, phone (P1): stat tiles in two columns, tables as cards, 44 px targets (the CSS of the block; no browser check was run)', () => {
  const css = read('guild.css');
  const block = css.slice(css.indexOf('/* == B8a Guild setup (lane setup) == */'), css.indexOf('/* == end B8a Guild setup == */'));
  assert(block.length > 2000, 'the block is filled');
  const phone = block.slice(block.indexOf('@media (width <= 600px)'));
  assert(/\.gs-su-stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/.test(phone), 'two columns of tiles');
  assert(/\.gs-su-chkbox \{ width: 44px; height: 44px;/.test(phone) && /\.gs-table-ranks \.gs-input \{[^}]*height: 44px/.test(phone), '44 px ticks and inputs');
  assert(/\.gs-table-ranks th:nth-child\(n\) \{ width: auto; \}/.test(phone) && /\.gs-su-group \.gs-table td, \.gs-su-group \.gs-table th\[scope="row"\] \{ height: auto; \}/.test(phone), 'tables stack');
  assert(!/!important|style=/.test(block), 'no important');
  assert(!/@media \(max-width: 600px\)/.test(block), 'the framework suite reads the LAST max-width 600 block: this one must not be it');
});

// ---------------------------------------------------------------------------
// 7. Step 4: Switch over

async function atSwitch(o = {}) {
  const opened = await atPreview(o);
  G.handlers.click['setup-preview-next']();
  await settle();
  return opened;
}
// Unticks characters on the preview step and updates the preview for those ticks, the way the page asks for it: the Worker's answer is the preview for exactly them, under a new token.
async function untickAndUpdate(off, token = 'tok2') {
  for (const id of off) G.handlers.change['setup-bind'](el({ 'data-id': id }, { checked: false }));
  const calls = scriptApi({ 'POST /api/guild/g1/flip/dry-run': (body) => previewOf({ token, confirmedCharacterIds: body.confirmedCharacterIds }) });
  G.handlers.click['setup-preview-update']();
  await settle();
  return calls;
}
const FLIP_OK = { ok: true, rankSource: 'ingame', ownerUserId: 'u_o', applied: APPLIED };
const needFresh = () => apiError(403, { error: 'fresh_required', message: 'Confirm it is you first.', purpose: 'source_switch', params: { from: null, to: 'ingame' } });

check('Guild setup, step 4 (G4): the page restates the facts; the primary opens a confirm; Back goes to the preview', async () => {
  const { html, view } = await atPreview();
  await untickAndUpdate(['c_4']);
  G.handlers.click['setup-preview-next']();
  await settle();
  assert.equal(view.step, 4);
  const page = html();
  const t = text(page);
  assert.deepEqual(stepperOf(page), ['done', 'done', 'done', 'current']);
  assert(t.includes('What the switch does') && t.includes('Members 29 accounts are members after the switch: 27 stay, 2 gain access, 12 lose it'));
  assert(t.includes('Claims 5 people wait for their player to claim them with This is me; the switch links nobody') && t.includes('Ranks 24 characters change core rank, 7 of them become Trial'));
  assert(t.includes('Roles 6 roles from Discord become hand-set; Discord stops giving roles') && t.includes('Owner Brandon, live through Thornwick'));
  assert(text(bar(page)).includes('29 members after the switch, 24 core ranks change.') && primaryOf(page, 'Switch over') && bar(page).includes('data-action="setup-back"'));
  noRawAttrs(page, 'step 4');
  assert(t.includes('Name matches 3 of 4 characters are matched to the roster by name'), 'the ticks the preview is for');
  G.handlers.click['setup-switch']();
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0].innerHTML;
  assert(dialog.includes('Switch Writers to its in-game guild?') && dialog.includes('From now on the guild roster decides who is a member and what rank they hold. You cannot switch back from the app.'));
  assert(dialog.includes('What changes') && dialog.includes('29 after the switch: 27 stay, 2 gain access, 12 lose it') && dialog.includes('data-submit="setup-switch-form"') && dialog.includes('gs-forge') && dialog.includes('gs-dialog-confirm'));
  assert(/gs-btn-molten[^>]*type="submit"[^>]*><span>Switch over|type="submit"[^>]*gs-btn-molten[^>]*><span>Switch over/.test(dialog) || dialog.includes('Switch over</span>'));
  G.handlers.click['setup-back']();
  assert.equal(view.step, 3);
});

check('Guild setup, step 4: the flip sends the token and the ticked ids; a missing sign-in is step 2 of the same dialog and the pending act repeats the flip (G4)', async () => {
  const { view } = await atPreview();
  await untickAndUpdate(['c_4']);
  G.handlers.click['setup-preview-next']();
  await settle();
  assert.equal(view.step, 4);
  G.handlers.click['setup-switch']();
  const { dlg, form } = fakeDialog(dialogs[0].innerHTML);
  // 1. no grant yet: the flip answers 403 fresh_required and the dialog turns into the sign-in step
  let calls = scriptApi({ 'POST /api/guild/g1/flip': () => { throw needFresh(); } });
  G.handlers.submit['setup-switch-form'](form);
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/flip', body: { token: 'tok2', confirmedCharacterIds: ['c_1', 'c_2', 'c_3'] } });
  assert(dlg.innerHTML.includes('Switch over - step 2 of 2') && dlg.innerHTML.includes('Confirm it is you') && dlg.innerHTML.includes('Sign in with Battle.net, then the switch runs. You come back to this page.'), dlg.innerHTML.slice(0, 300));
  assert(dlg.innerHTML.includes('Brandon#1482') && !dlg.innerHTML.includes('type="radio"'), 'Battle.net only');
  assert.equal(view.step, 4, 'the page stays');
  // 2. the step starts the sign-in with the act's purpose and params
  calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form'](stepForm(dlg, 'bnet'));
  await settle();
  assert.deepEqual(calls[0], { method: 'POST', path: '/api/guild/g1/fresh/start', body: { purpose: 'source_switch', params: { from: null, to: 'ingame' }, provider: 'bnet' } });
  assert.deepEqual(navigations, [AUTHORIZE]);
  const saved = plain(G.fresh.pending());
  assert.deepEqual([saved.kind, saved.gid, saved.purpose, saved.params, saved.returnTo], ['source_switch', 'g1', 'source_switch', { from: null, to: 'ingame' }, '#/g/g1/setup']);
  assert.deepEqual([saved.data.token, saved.data.confirmedCharacterIds], ['tok2', ['c_1', 'c_2', 'c_3']]);
  // 3. back from Battle.net: #/fresh?done=source_switch repeats the flip with the stored token and ids, then the page shows the result
  const sent = [];
  scriptApi({ 'POST /api/guild/g1/flip': (body) => { sent.push(plain(body)); return FLIP_OK; } });
  const address = await G.fresh.repeat(G.fresh.takePending());
  assert.equal(address, '#/g/g1/setup');
  assert.deepEqual(plain(sent), [{ token: 'tok2', confirmedCharacterIds: ['c_1', 'c_2', 'c_3'] }]);
  const done = await openSetup({ bnet: SWITCHED() });
  const t = text(done.html());
  assert(done.html().includes('gs-banner-success') && t.includes('Writers now follows the in-game guild.') && t.includes('29 accounts are members: 27 stayed, 2 gained access and 12 lost it. 24 characters changed core rank, 7 of them are on Trial.'), t.slice(0, 500));
  assert(t.includes('Writers now') && t.includes('Roles 6 roles from Discord are now hand-set, 3 new permissions from ranks') && t.includes('Claims 5 people wait for their player to claim them with This is me') && t.includes('Name matches 3 characters are matched to the roster by name'));
  assert(t.includes('Roster 64 members Last checked Oct 27, 9:12 AM ET') && done.html().includes('href="#/g/g1/roster"') && !done.html().includes('gs-commitbar'));
  assert.deepEqual(stepperOf(done.html()), ['done', 'done', 'done', 'done']);
  assert(text(done.html()).includes('Writers follows its in-game guild.') && !/Open Users/.test(t) === !done.html().includes('href="#/g/g1/users"'));
});

check('Guild setup, step 4: with the sign-in already fresh the flip applies at once and the page shows the counts; a switched guild opens on the result', async () => {
  const { view, html } = await atSwitch();
  G.handlers.click['setup-switch']();
  const { form } = fakeDialog(dialogs[0].innerHTML);
  const calls = scriptApi({ 'POST /api/guild/g1/flip': () => FLIP_OK });
  G.handlers.submit['setup-switch-form'](form);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(view.step, 5);
  assert.deepEqual(refreshed, ['g1'], 'the guild is read again: the nav follows the new rank source');
  assert(text(html()).includes('Writers now follows the in-game guild.') && text(html()).includes('29 accounts are members'));
  // Opening the page of a guild that already switched: the result step with the facts it still knows.
  resetBrowser();
  const later = await openSetup({ bnet: SWITCHED() });
  assert.equal(later.view.step, 5);
  assert(text(later.html()).includes('Writers follows the in-game guild.') && text(later.html()).includes('Writers on Dreamscythe (US)') && text(later.html()).includes('64 members') && !later.html().includes('gs-commitbar'));
  assert(!later.html().includes('data-action="setup-'), 'nothing left to do here');
});

check('Guild setup, step 4: an old or refused preview is "out of date" - the dialog says so and the primary runs the preview again (G6 #3)', async () => {
  for (const mode of ['old', 'stale', 'invalid']) {
    const { view, html } = await atSwitch();
    G.handlers.click['setup-switch']();
    const { dlg, form } = fakeDialog(dialogs[0].innerHTML);
    let calls = scriptApi({ 'POST /api/guild/g1/flip': () => { throw apiError(409, { error: mode === 'invalid' ? 'approval_invalid' : 'approval_stale', message: 'Worker words' }); } });
    const at = G.fresh.now;
    if (mode === 'old') G.fresh.now = () => view.previewAt + 10 * 60 * 1000;
    G.handlers.submit['setup-switch-form'](form);
    await settle();
    G.fresh.now = at;
    assert.equal(calls.length, mode === 'old' ? 0 : 1, `${mode}: an old token is not even sent`);
    assert(dlg.innerHTML.includes('This preview is out of date: the guild changed since you ran it. Run it again to see what would change now.') && dlg.innerHTML.includes('Run the preview again') && !dlg.innerHTML.includes('Switch over</span>'), `${mode}: ${dlg.innerHTML.slice(-400)}`);
    // The primary closes the dialog and runs the dry run again; the page is on the preview.
    calls = scriptApi({ 'POST /api/guild/g1/flip/dry-run': () => previewOf({ token: 'tok2' }) });
    G.handlers.submit['setup-switch-form'](stepForm(dlg));
    await settle();
    assert.equal(dlg.open, false, `${mode}: the dialog closed`);
    assert.equal(calls.length, 1);
    assert(view.step === 3 && view.preview.token === 'tok2', `${mode}: a new preview`);
    assert(html().includes('29 accounts are members of Writers'));
  }
});

check('Guild setup, step 4: every other refusal of the flip is one sentence in the dialog; already_ingame closes it and shows the result', async () => {
  const flipCodes = [
    [503, 'effective_roles_missing', 'The switch cannot run on this server yet.'], [400, 'approval_required', 'The preview did not come with its approval.'], [400, 'confirmation_required', 'Say which characters to match by name.'],
    [400, 'bad_confirmation', 'Some ticked characters are not on the preview.'], [409, 'source_not_legacy', 'This guild does not take its members from the Discord server.'], [409, 'not_pinned', 'Link the guild first.'],
    [409, 'no_good_sync', 'The guild roster has not been read yet.'], [409, 'no_owner', 'This guild has no Owner yet.'], [409, 'owner_would_be_suspended', 'You would be suspended after the switch.'],
    [409, 'rank_map_incomplete', 'Map every in-game rank first. Not mapped yet: Core Raider (27 members).'],
  ];
  for (const [status, code, sentence] of flipCodes) {
    const { view } = await atSwitch();
    G.handlers.click['setup-switch']();
    const { dlg, form } = fakeDialog(dialogs[0].innerHTML);
    field('dlg-error');
    scriptApi({ 'POST /api/guild/g1/flip': () => { throw apiError(status, { error: code, message: 'Worker words', ranks: [{ rank: 3, members: 27 }] }); } });
    G.handlers.submit['setup-switch-form'](form);
    await settle();
    assert(fields['dlg-error'].textContent.includes(sentence), `${code}: ${fields['dlg-error'].textContent}`);
    assert.equal(dlg.open, true, `${code}: the dialog stays`);
    assert.equal(view.step, 4);
  }
  const { view, html } = await atSwitch();
  G.handlers.click['setup-switch']();
  const { dlg, form } = fakeDialog(dialogs[0].innerHTML);
  scriptApi({ 'POST /api/guild/g1/flip': () => { throw apiError(409, { error: 'already_ingame', message: 'Worker words' }); } });
  G.handlers.submit['setup-switch-form'](form);
  await settle();
  assert.equal(dlg.open, false);
  assert(view.step === 5 && text(html()).includes('Writers follows the in-game guild.'));
});

check('Guild setup: the act `source_switch` after an old token or a refusal lands on the preview with the reason (and no flip is sent for an old token)', async () => {
  const record = (o = {}) => ({ kind: 'source_switch', gid: 'g1', purpose: 'source_switch', params: { from: null, to: 'ingame' }, data: { token: 'tok1', tokenAt: Date.now(), confirmedCharacterIds: ['c_1'] }, provider: 'bnet', returnTo: '#/g/g1/setup', at: Date.now(), ...o });
  // An old token: the flip is not sent.
  resetBrowser();
  let calls = scriptApi({ 'POST /api/guild/g1/flip': () => FLIP_OK });
  assert.equal(await G.fresh.repeat(record({ data: { token: 'tok1', tokenAt: Date.now() - 11 * 60 * 1000, confirmedCharacterIds: [] } })), '#/g/g1/setup');
  assert.equal(calls.length, 0);
  let opened = await openSetup({ bnet: LINKED(), extra: { 'POST /api/guild/g1/flip/dry-run': () => previewOf({ token: 'tok9' }) } });
  assert.equal(opened.view.step, 3);
  assert(opened.view.preview && opened.view.preview.token === 'tok9', 'the preview ran again');
  assert(text(opened.html()).includes('This preview is out of date.') && text(opened.html()).includes('This is the preview as it is now.') && opened.html().includes('gs-banner-warning'));
  assert(opened.calls.some((c) => c.path === '/api/guild/g1/rank-map'), 'the map is read for the rank names');
  // The Worker says the approval is stale: the same landing.
  resetBrowser();
  scriptApi({ 'POST /api/guild/g1/flip': () => { throw apiError(409, { error: 'approval_stale', message: 'x' }); } });
  await G.fresh.repeat(record());
  opened = await openSetup({ bnet: LINKED(), extra: { 'POST /api/guild/g1/flip/dry-run': () => previewOf() } });
  assert(opened.view.step === 3 && text(opened.html()).includes('This preview is out of date.'));
  // Another refusal: its own banner above the new preview.
  resetBrowser();
  scriptApi({ 'POST /api/guild/g1/flip': () => { throw apiError(409, { error: 'owner_would_be_suspended', message: 'x' }); } });
  await G.fresh.repeat(record());
  opened = await openSetup({ bnet: LINKED(), extra: { 'POST /api/guild/g1/flip/dry-run': () => previewOf() } });
  assert(opened.view.step === 3 && text(opened.html()).includes('You would be suspended after the switch.') && opened.html().includes('gs-banner-warning'));
  // Switched in the meantime.
  resetBrowser();
  scriptApi({ 'POST /api/guild/g1/flip': () => { throw apiError(409, { error: 'already_ingame', message: 'x' }); } });
  await G.fresh.repeat(record());
  opened = await openSetup({ bnet: SWITCHED() });
  assert.equal(opened.view.step, 5);
  // The sign-in's own failure and a sign-out are the fresh page's.
  scriptApi({ 'POST /api/guild/g1/flip': () => { throw needFresh(); } });
  await assert.rejects(G.fresh.repeat(record()), (error) => error.code === 'fresh_required');
  scriptApi({ 'POST /api/guild/g1/flip': () => { throw apiError(401, { error: 'signed_out' }); } });
  await assert.rejects(G.fresh.repeat(record()), (error) => error.status === 401);
});

// ---------------------------------------------------------------------------
// 7b. The preview and its ticks (lane B8a-fix3): what the Owner reads is what the switch does

const staleOf = (page) => ({
  summary: /class="gs-su-summary is-stale"/.test(page),
  tiles: /class="gs-su-stats is-stale"/.test(page),
  access: /class="gs-hd-panel gs-su-list is-stale" aria-label="Access"/.test(page),
  ranks: /class="gs-hd-panel gs-su-list is-stale" aria-label="Ranks"/.test(page),
  permissions: /class="gs-hd-panel gs-su-list is-stale" aria-label="Permissions"/.test(page),
  offRoster: /class="gs-su-group is-stale" data-group="notonroster"/.test(page),
});

check('Guild setup, step 3: a changed tick dims the counts and lists that depend on it, says so with an "Update preview" button, and Next stays off until the preview matches the ticks', async () => {
  const { html, view } = await atPreview();
  const clean = html();
  assert(!clean.includes('is-stale') && !clean.includes('setup-preview-update') && primaryOf(clean, 'Next') && !/<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(clean), 'in sync: nothing dimmed, no button');
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_2' }, { checked: false }));
  const page = html();
  assert.deepEqual(staleOf(page), { summary: true, tiles: true, access: true, ranks: true, permissions: false, offRoster: true }, 'the counts and lists the ticks move are dimmed; the Owner and the permissions are not');
  assert(!/class="gs-hd-panel gs-su-owner[^"]*is-stale/.test(page));
  assert(text(page).includes('You changed which characters are matched. The counts and lists above are for the earlier ticks.'));
  assert(/<button type="button" class="gs-btn gs-btn-sm"[^>]*data-action="setup-preview-update"[^>]*><span>Update preview<\/span>/.test(page), 'a secondary (not the primary) button');
  assert(text(bar(page)).includes('The ticks changed. Update the preview to go on.') && /<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(page), 'the reason beside the disabled Next');
  G.handlers.click['setup-preview-next']();
  assert.equal(view.step, 3, 'Next does nothing');
  // Ticking it back: the page is the preview again.
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_2' }, { checked: true }));
  const back = html();
  assert(!back.includes('is-stale') && !back.includes('setup-preview-update') && primaryOf(back, 'Next'));
  // The rest tick counts too.
  const ids = Array.from({ length: 30 }, (_, i) => `c_${i + 1}`);
  const samples = ids.slice(0, 25).map((id, i) => ({ characterId: id, name: `Bound${String(i).padStart(2, '0')}`, class: 'MAGE', rosterRank: 3, personId: `p${i}`, userId: null, proof: 'officer' }));
  const many = await atPreview({ preview: previewOf({ confirmedCharacterIds: ids, boundByName: { count: 30, ids, byProof: {}, classMismatch: 0, samples } }) });
  G.handlers.change['setup-bind'](el({ 'data-id': '*rest*' }, { checked: false }));
  assert(staleOf(many.html()).summary && many.html().includes('setup-preview-update'));
});

check('Guild setup, step 3: Update preview sends the ticked ids, keeps the old preview dimmed and the ticks locked while it runs, then shows the answer for exactly those ticks', async () => {
  const { html, view } = await atPreview();
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_2' }, { checked: false }));
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_4' }, { checked: false }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const promised = previewOf({
    token: 'tok2', confirmedCharacterIds: ['c_1', 'c_3'],
    access: { ...previewOf().access, members: { today: 39, afterFlip: 28 }, loses: { ...previewOf().access.loses, count: 13 } }, ranks: { ...previewOf().ranks, changed: 25, becomesTrial: 6 },
  });
  const calls = scriptApi({ 'POST /api/guild/g1/flip/dry-run': () => gate.then(() => promised) });
  G.handlers.click['setup-preview-update']();
  assert.equal(view.updating, true);
  const while_ = html();
  assert(text(while_).includes('29 accounts are members of Writers after the switch. 27 stay, 2 gain access, 12 lose it.') && staleOf(while_).summary, 'the old numbers stay, dimmed');
  assert(/<button[^>]*disabled[^>]*data-action="setup-preview-update"/.test(while_) && text(while_).includes('Updating the preview...'), 'the button is busy');
  assert((while_.match(/class="gs-su-chk"[^>]*disabled/g) || []).length === 4, 'the ticks are locked while it runs');
  G.handlers.click['setup-preview-update'](); // a second press changes nothing
  release();
  await settle();
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', '/api/guild/g1/flip/dry-run', { confirmedCharacterIds: ['c_1', 'c_3'] }]], 'one call, with exactly the ticked ids');
  assert(!view.updating && view.preview.token === 'tok2');
  const page = html();
  assert(!page.includes('is-stale') && !page.includes('setup-preview-update') && !/class="gs-su-chk"[^>]*disabled/.test(page), 'in sync again');
  assert(text(page).includes('28 accounts are members of Writers after the switch. 26 stay, 2 gain access, 13 lose it.') && /Core rank changes<\/span><span class="gs-su-stat-n">25</.test(page), 'the numbers are the new answer\'s');
  assert((page.match(/class="gs-su-chk"[^>]*checked/g) || []).length === 2 && /id="bn-1"(?![^>]*checked)/.test(page) && /id="bn-3"(?![^>]*checked)/.test(page), 'the ticks are the ones asked for');
  assert.deepEqual(plain(G.pages.setup.confirmedIds(view)), ['c_1', 'c_3']);
  assert(primaryOf(page, 'Next'));
  // A refused update keeps the old preview on the page, dimmed, with the reason and the ticks as they are.
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_1' }, { checked: false }));
  scriptApi({ 'POST /api/guild/g1/flip/dry-run': () => { throw apiError(429, { error: 'rate_limited', message: 'Too many dry runs.', retryAfter: 120 }); } });
  G.handlers.click['setup-preview-update']();
  await settle();
  const refused = html();
  assert(view.preview.token === 'tok2' && !view.updating && text(refused).includes('Too many tries.') && staleOf(refused).summary && refused.includes('setup-preview-update') && /<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(refused));
});

check('Guild setup, step 3: when a ticked character is no candidate any more the update starts again from every candidate ticked, and says so', async () => {
  const { html, view } = await atPreview();
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_2' }, { checked: false }));
  const calls = scriptApi({
    'POST /api/guild/g1/flip/dry-run': (body) => {
      if (body.confirmedCharacterIds) throw apiError(400, { error: 'bad_confirmation', message: 'Worker words', ids: ['c_1'] });
      return previewOf({ token: 'tok3' });
    },
  });
  G.handlers.click['setup-preview-update']();
  await settle();
  assert.deepEqual(calls.map((c) => c.body), [{ confirmedCharacterIds: ['c_1', 'c_3', 'c_4'] }, {}]);
  assert(view.preview.token === 'tok3' && G.pages.setup.confirmedIds(view).length === 4, 'every candidate is ticked again');
  const page = html();
  assert(text(page).includes('The list of characters to match changed. Every one is ticked again.') && !page.includes('is-stale') && primaryOf(page, 'Next'));
});

check('Guild setup, step 3: the first dry run asks for no ids; leaving the preview and coming back runs it again for the ticks that were set', async () => {
  const first = [];
  const { view } = await atRanks({ extra: { 'POST /api/guild/g1/flip/dry-run': (body) => { first.push(plain(body)); return previewOf(); } } });
  G.handlers.click['setup-ranks-next']();
  await settle();
  assert.deepEqual(first, [{}], 'the first dry run sends an empty body');
  const calls = scriptApi({ 'POST /api/guild/g1/flip/dry-run': (body) => previewOf({ token: 'tok2', confirmedCharacterIds: body.confirmedCharacterIds || ['c_1', 'c_2', 'c_3', 'c_4'] }) });
  G.handlers.change['setup-bind'](el({ 'data-id': 'c_3' }, { checked: false }));
  G.handlers.click['setup-preview-update']();
  await settle();
  G.handlers.click['setup-back']();
  assert.equal(view.step, 2);
  G.handlers.click['setup-ranks-next']();
  await settle();
  assert.deepEqual(calls.map((c) => c.body), [{ confirmedCharacterIds: ['c_1', 'c_2', 'c_4'] }, { confirmedCharacterIds: ['c_1', 'c_2', 'c_4'] }]);
  assert.deepEqual(plain(G.pages.setup.confirmedIds(view)), ['c_1', 'c_2', 'c_4']);
});

check('Guild setup, step 4: Switch over is off while the ticks differ from the preview (a changed tick, then the page is on step 4), and the switch sends the ids of the token', async () => {
  const { html, view } = await atSwitch();
  assert.equal(view.step, 4);
  view.unticked.c_1 = true; // a tick moved without an update
  const page = html();
  assert(text(bar(page)).includes('The ticks changed. Update the preview to go on.') && /<button[^>]*disabled[^>]*>(?:<span>)?Switch over/.test(page));
  G.handlers.click['setup-switch']();
  assert.equal(dialogs.length, 0, 'no dialog');
  delete view.unticked.c_1;
  G.handlers.click['setup-switch']();
  const { form } = fakeDialog(dialogs[0].innerHTML);
  const calls = scriptApi({ 'POST /api/guild/g1/flip': () => FLIP_OK });
  G.handlers.submit['setup-switch-form'](form);
  await settle();
  assert.deepEqual(calls[0].body, { token: 'tok1', confirmedCharacterIds: ['c_1', 'c_2', 'c_3', 'c_4'] }, 'the ids the token was made for');
});

check('Guild setup: the act after the sign-in keeps the ticks when the preview has to run again, and the Worker\'s "ticks changed" refusal is its own banner', async () => {
  const record = (data) => ({ kind: 'source_switch', gid: 'g1', purpose: 'source_switch', params: { from: null, to: 'ingame' }, data: { token: 'tok1', tokenAt: Date.now(), ...data }, provider: 'bnet', returnTo: '#/g/g1/setup', at: Date.now() });
  const rerun = async (flipError, data) => {
    resetBrowser();
    scriptApi({ 'POST /api/guild/g1/flip': () => { throw flipError; } });
    await G.fresh.repeat(record(data));
    const bodies = [];
    const opened = await openSetup({ bnet: LINKED(), extra: { 'POST /api/guild/g1/flip/dry-run': (body) => { bodies.push(plain(body)); return previewOf({ token: 'tok7', confirmedCharacterIds: body.confirmedCharacterIds }); } } });
    return { opened, bodies };
  };
  let { opened, bodies } = await rerun(apiError(409, { error: 'approval_stale', message: 'x' }), { confirmedCharacterIds: ['c_1', 'c_4'] });
  assert.deepEqual(bodies, [{ confirmedCharacterIds: ['c_1', 'c_4'] }]);
  assert.deepEqual(plain(G.pages.setup.confirmedIds(opened.view)), ['c_1', 'c_4']);
  assert(text(opened.html()).includes('This preview is out of date.') && !opened.html().includes('setup-preview-update'), 'the new preview is for those ticks: in sync');
  ({ opened, bodies } = await rerun(apiError(409, { error: 'confirmation_changed', message: 'x' }), { confirmedCharacterIds: [] }));
  assert.deepEqual(bodies, [{ confirmedCharacterIds: [] }], 'nothing ticked stays nothing ticked');
  assert.deepEqual(plain(G.pages.setup.confirmedIds(opened.view)), []);
  assert(text(opened.html()).includes('The ticked characters changed. Update the preview, then switch over.') && opened.html().includes('gs-banner-warning'));
  // An old token: the same, without sending the flip.
  resetBrowser();
  const sent = scriptApi({ 'POST /api/guild/g1/flip': () => FLIP_OK });
  await G.fresh.repeat(record({ tokenAt: Date.now() - 11 * 60 * 1000, confirmedCharacterIds: ['c_2'] }));
  assert.equal(sent.length, 0);
  const old = await openSetup({ bnet: LINKED(), extra: { 'POST /api/guild/g1/flip/dry-run': (body) => previewOf({ confirmedCharacterIds: body.confirmedCharacterIds }) } });
  assert.deepEqual(plain(G.pages.setup.confirmedIds(old.view)), ['c_2']);
});

check('Guild setup: the Owner is named the same way in the preview, on step 4, in the dialog and on the done page (the account\'s name, never the person the preview lists them under)', async () => {
  const opened = await atPreview();
  const preview = text(opened.html());
  assert(preview.includes('Owner Brandon Live Thornwick (rank 0, Guild Master) is on the roster and confirmed by Battle.net, so Brandon keeps every Owner power.'));
  G.handlers.click['setup-preview-next']();
  await settle();
  const four = text(opened.html());
  assert(four.includes('Owner Brandon Live') && four.includes('Owner Brandon, live through Thornwick'));
  G.handlers.click['setup-switch']();
  assert(/Owner<\/span><span class="gs-pr-v">Brandon</.test(dialogs[0].innerHTML), 'the dialog');
  // The done page after the sign-in round trip knows only the guild: the same name.
  resetBrowser();
  scriptApi({ 'POST /api/guild/g1/flip': () => FLIP_OK });
  await G.fresh.repeat({ kind: 'source_switch', gid: 'g1', purpose: 'source_switch', params: { from: null, to: 'ingame' }, data: { token: 'tok1', tokenAt: Date.now(), confirmedCharacterIds: [] }, provider: 'bnet', returnTo: '#/g/g1/setup', at: Date.now() });
  const done = await openSetup({ bnet: SWITCHED() });
  assert(text(done.html()).includes('Owner Brandon') && !text(done.html()).includes('Thornwick'));
  // Without the guild's Owner block the preview's own name is the fallback.
  resetBrowser();
  const bare = await atPreview();
  bare.view.gd = { ...bare.view.gd, owner: { you: true } };
  assert(text(G.pages.setup.main({ name: 'setup', gid: 'g1' }, bare.view.gd)).includes('Owner Thornwick Live'));
});

check('Guild setup: counts of one read as one ("1 member", "1 core rank changes", "1 stays", "1 of them becomes Trial"), zero and many as before', async () => {
  const one = previewOf({
    access: {
      members: { today: 1, afterFlip: 1 }, loses: { count: 1, reasons: { discord_only: 1 }, samples: [{ reason: 'discord_only', name: 'Brightmane' }] },
      gains: { count: 1, reasons: { linked_person: 1 }, samples: [{ reason: 'linked_person', personId: 'p_t', name: 'Tamsin' }] },
    },
    needsClaim: { count: 1, ownerIncluded: false, onRoster: 1, samples: [{ personId: 'p_c', name: 'Cindervale', onRoster: true }] },
    ranks: { changed: 1, becomesTrial: 1, becomesSocial: 0, transitions: [{ from: 'raider', to: 'trial', count: 1 }], samples: [{ name: 'Quillfeather', class: 'HUNTER', from: 'raider', to: 'trial', rosterRank: 4 }], unmapped: [] },
    permissions: { ...previewOf().permissions, discordRoles: { count: 1, withHandTwin: 0, samples: [] } },
  });
  const opened = await atPreview({ preview: one });
  const page = opened.html();
  const t = text(page);
  assert(t.includes('1 account is a member of Writers after the switch. 0 stay, 1 gains access, 1 loses it.'), t.slice(t.indexOf('account'), t.indexOf('account') + 120));
  assert(text(bar(page)).includes('1 member after the switch, 1 core rank changes.'));
  assert(t.includes('1 of the 1 is on the roster.'));
  G.handlers.click['setup-preview-next']();
  await settle();
  const four = text(opened.html());
  assert(four.includes('Members 1 account is a member after the switch: 0 stay, 1 gains access, 1 loses it'), four);
  assert(four.includes('Ranks 1 character changes core rank, 1 of them becomes Trial') && four.includes('Roles 1 role from Discord becomes hand-set; Discord stops giving roles'));
  assert(four.includes('Claims 1 person waits for their player to claim them with This is me; the switch links nobody'));
  assert(text(bar(opened.html())).includes('1 member after the switch, 1 core rank changes.'));
  G.handlers.click['setup-switch']();
  const dialog = text(dialogs[0].innerHTML);
  assert(dialog.includes('Members 1 after the switch: 0 stay, 1 gains access, 1 loses it') && dialog.includes('Ranks 1 character changes core rank') && dialog.includes('Roles 1 from Discord becomes hand-set'), dialog);
  // Zero and many.
  const zero = await atPreview({ preview: previewOf({ access: { members: { today: 0, afterFlip: 0 }, loses: { count: 0, reasons: {}, samples: [] }, gains: { count: 0, reasons: {}, samples: [] } }, ranks: { changed: 0, becomesTrial: 0, becomesSocial: 0, transitions: [], samples: [], unmapped: [] } }) });
  assert(text(bar(zero.html())).includes('0 members after the switch, 0 core ranks change.') && text(zero.html()).includes('0 accounts are members of Writers after the switch. 0 stay, 0 gain access, 0 lose it.'));
  assert(text(zero.html()).includes('No character becomes Trial.'));
  // The done page.
  resetBrowser();
  const applied = { ...APPLIED, membersAfter: 1, stay: 1, gains: 1, loses: 1, rankChanges: 1, becameTrial: 1, discordRolesMadeManual: 1, newPermissions: 1, needsClaim: 1, boundByName: 1 };
  scriptApi({ 'POST /api/guild/g1/flip': () => ({ ok: true, rankSource: 'ingame', ownerUserId: 'u_o', applied }) });
  await G.fresh.repeat({ kind: 'source_switch', gid: 'g1', purpose: 'source_switch', params: { from: null, to: 'ingame' }, data: { token: 'tok1', tokenAt: Date.now(), confirmedCharacterIds: ['c_1'] }, provider: 'bnet', returnTo: '#/g/g1/setup', at: Date.now() });
  const done = text((await openSetup({ bnet: SWITCHED() })).html());
  assert(done.includes('1 account is a member: 1 stayed, 1 gained access and 1 lost it. 1 character changed core rank, 1 of them is on Trial.'), done.slice(0, 400));
  assert(done.includes('Roles 1 role from Discord is now hand-set, 1 new permission from ranks') && done.includes('Name matches 1 character is matched to the roster by name') && done.includes('Claims 1 person waits for their player'));
});

check('Guild setup, step 1: the lead names the guild and the order of the steps (G1); once linked there is no lead and the banner names the realm without its region (G1b)', async () => {
  const fresh = await openSetup({ bnet: bnetOf() });
  const t = text(fresh.html());
  assert(t.includes('Raidsmith reads Writers\'s guild roster from Battle.net. Confirm it is you, then name the guild to follow.'), t.slice(0, 300));
  assert(!t.includes('Name the in-game guild to follow, then confirm it is you.'));
  resetBrowser();
  const linked = await openSetup({ bnet: LINKED() });
  assert(!text(linked.html()).includes('Raidsmith reads') && !linked.html().includes('gs-su-lead'), 'linked: no lead');
  assert(/id="pin-name"[^>]*readonly/.test(linked.html()));
});

check('Guild setup, step 3: the in-game rank column of "Become Trial" says what the character is on the roster ("-" when the Worker did not say)', async () => {
  const noRank = previewOf({ ranks: { ...previewOf().ranks, samples: [{ name: 'Quillfeather', class: 'HUNTER', from: 'social', to: 'trial' }] } });
  const opened = await atPreview({ preview: noRank });
  assert(text(opened.html()).includes('Become Trial 7 Character Today In-game rank Quillfeather Social -'), text(opened.html()).slice(text(opened.html()).indexOf('Become Trial'), 400));
});

// ---------------------------------------------------------------------------
// 8. The refusals, one sentence each

const REFUSAL_CASES = [
  // [status, code, title fragment]: the pin and its sign-in (b6b part 3a), the rank map (b4b), the flip (b9)
  [403, 'pin_not_open', 'not open yet'], [403, 'forbidden', 'Only the Owner'], [400, 'bad_request', 'Check what you typed'], [503, 'bnet_not_configured', 'not set up on this server'],
  [409, 'bnet_unsupported', 'game version'], [403, 'fresh_required', 'did not count'], [429, 'rate_limited', 'Too many tries'], [404, 'bnet_guild_not_found', 'no guild called Writers'],
  [502, 'bnet_guild_refused', 'would not show'], [502, 'bnet_unavailable', 'did not answer'], [502, 'bnet_roster_invalid', 'incomplete'], [409, 'pin_locked', 'another in-game guild'],
  [409, 'roster_too_large', 'too large'], [409, 'roster_over_caps', 'too many members'], [403, 'pin_not_on_roster', 'None of your characters'], [409, 'pin_taken', 'Another Raidsmith guild'],
  [409, 'conflict', 'changed while'], [403, 'identity_too_new', 'linked a few days ago'], [409, 'identity_not_linked', 'Link Battle.net'],
  [400, 'rank_zero_only', 'Only rank 0'], [400, 'approval_required', 'approval'], [409, 'approval_invalid', 'out of date'], [409, 'approval_stale', 'out of date'],
  [503, 'effective_roles_missing', 'cannot run'], [409, 'already_ingame', 'already follows'], [400, 'confirmation_required', 'Say which characters'], [400, 'bad_confirmation', 'not on the preview'], [409, 'confirmation_changed', 'ticked characters changed'],
  [409, 'source_not_legacy', 'does not take its members'], [409, 'not_pinned', 'Link the guild first'], [409, 'no_good_sync', 'has not been read'], [409, 'no_owner', 'no Owner'],
  [409, 'owner_would_be_suspended', 'would be suspended'], [409, 'rank_map_incomplete', 'Map every in-game rank'],
];

check('refusals: every error code the contracts list has its title and sentence; one the page does not know falls back to the Worker\'s words', () => {
  resetBrowser();
  const titles = new Set();
  for (const [status, code, fragment] of REFUSAL_CASES) {
    const r = G.pages.setup.refusalOf(apiError(status, { error: code, message: 'Worker words', ranks: [{ rank: 3, members: 27 }], eligibleAt: Date.UTC(2026, 10, 3) }), { guildName: 'Writers' });
    assert(r.title && r.text && (r.title + ' ' + r.text).includes(fragment), `${code}: ${r.title} / ${r.text}`);
    assert(typeof r.title === 'string' && typeof r.text === 'string', code);
    assert(!/Worker words/.test(r.title) && r.tone === 'warning', code);
    titles.add(code);
    assert(G.pages.setup.refusalLine(apiError(status, { error: code, message: 'x' }), { guildName: 'Writers' }).length > 12, `${code}: one line`);
  }
  assert.equal(titles.size, REFUSAL_CASES.length);
  for (const code of G.pages.setup.REFUSAL_CODES) assert(titles.has(code), `${code} is in the table and in the cases above`);
  const unknown = G.pages.setup.refusalOf(apiError(409, { error: 'something_new', message: 'The Worker words.' }));
  assert.equal(unknown.title, 'That did not go through.');
  assert.equal(unknown.text, 'The Worker words.');
  assert.equal(G.pages.setup.refusalOf(apiError(0, null)).text, 'Could not reach Raidsmith. Check your connection and try again.');
  // The details that come from the answer: the date of the 7-day rule, the ranks that are not mapped.
  assert(G.pages.setup.refusalOf(apiError(403, { error: 'identity_too_new', eligibleAt: Date.UTC(2026, 10, 3, 12) })).text.includes('Nov 3, 2026'));
  assert(G.pages.setup.refusalOf(apiError(409, { error: 'rank_map_incomplete', ranks: [{ rank: 3, members: 27 }, { rank: 9, members: 1 }] })).text === 'Not mapped yet: Rank 3 (27 members), Rank 9 (1 member).');
});

// ---------------------------------------------------------------------------
// 9. The Worker: GET /bnet carries the stored roster's status

check('Worker: GET /bnet and its PUT answer carry roster { members, fetchedAt } - the stored roster\'s rows and its last good fetch - from one statement that scans nothing', async () => {
  const { scansSince } = require('../guild-plans');
  const s = await flipWorld();
  const stored = (await s.one('SELECT COUNT(*) AS n FROM guild_roster WHERE guild_id = ?', s.gid)).n;
  assert(stored > 5, 'the fixture holds a roster');
  const mark = s.w.db.statementLog.length;
  const res = await s.call('gm', 'GET', '/bnet');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.roster, { members: stored, fetchedAt: 2 }, 'the rows of the roster and guilds.last_good_fetched_at');
  const mine = s.w.db.statementLog.slice(mark).filter((statement) => /last_good_fetched_at AS fetched_at/.test(statement.sql));
  assert.equal(mine.length, 1, 'one statement');
  assert.deepEqual(scansSince({ sqlite: s.w.db.sqlite, statementLog: mine }, 0), [], 'no SCAN of guilds or guild_roster');
  const saved = await s.call('gm', 'PUT', '/bnet', { rankLabels: Array(10).fill('') });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.roster, { members: stored, fetchedAt: 2 }, 'the PUT answer replaces the page\'s copy: it must carry it too');
  assert.equal(res.json.pin.complete, true);
  // Nothing stored: nothing to say.
  s.exec(`DELETE FROM guild_roster WHERE guild_id = '${s.gid}'`);
  s.exec(`UPDATE guilds SET last_good_fetched_at = NULL WHERE id = '${s.gid}'`);
  assert.deepEqual((await s.call('gm', 'GET', '/bnet')).json.roster, { members: 0, fetchedAt: null });
});

check('Worker: after the setup pin the first sync is on the page - GET /bnet says how many were read and when', async () => {
  const { pinWorld, pin } = require('../guild-pin');
  const s = await pinWorld();
  {
    assert.deepEqual((await s.call('gm', 'GET', '/bnet')).json.roster, { members: 0, fetchedAt: null }, 'before: not read yet');
    const res = await pin(s, 'gm');
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.sync.status, 'applied');
    const after = (await s.call('gm', 'GET', '/bnet')).json;
    assert.equal(after.roster.members, res.json.sync.members);
    assert(after.roster.members >= 2 && typeof after.roster.fetchedAt === 'number' && after.roster.fetchedAt > 0, JSON.stringify(after.roster));
    assert.equal(after.pin.complete, true);
  }
});

// ---------------------------------------------------------------------------
// 10. The pages against the REAL Worker

// Every call of the pages goes to the Worker as the person `who` (the D1 stand-in); answers become what G.api resolves, errors an ApiError.
function bridge(s, who = 'gm') {
  const run = (method) => async (apiPath, body) => {
    const tail = apiPath.replace(`/api/guild/${s.gid}`, '');
    const res = await s.call(who, method, tail, body === undefined ? undefined : plain(body));
    if (res.status >= 200 && res.status < 300) return JSON.parse(JSON.stringify(res.json));
    throw new G.api.ApiError(res.status, res.json);
  };
  G.api.get = run('GET'); G.api.post = run('POST'); G.api.put = run('PUT'); G.api.del = run('DELETE');
}
async function realPage(s, who = 'gm') {
  bridge(s, who);
  const gd = JSON.parse(JSON.stringify((await s.call(who, 'GET', '')).json));
  const me = (await s.w.call(s.jars[who], 'GET', '/auth/me')).json;
  G.app.state.me = JSON.parse(JSON.stringify(me));
  G.app.state.guilds[s.gid] = gd;
  const route = { name: 'setup', gid: s.gid };
  await G.pages.setup.load(route, gd);
  await settle();
  return { gd, view: G.pages.setup.view(), html: () => G.pages.setup.main(route, gd) };
}

check('the pages against the Worker: step by step on a pinned legacy guild (pin, rank map, flip dry run, flip) - what the screens draw is what the Worker answered', async () => {
  const s = await flipWorld();
  resetBrowser(`#/g/${s.gid}/setup`);
  const { view, html } = await realPage(s);
  const gid = s.gid;
  // Step 1: the guild is linked (flipWorld pins it), the roster is the stored one.
  assert.equal(view.owner, true);
  assert.equal(view.step, 1);
  const rosterRows = (await s.one('SELECT COUNT(*) AS n FROM guild_roster WHERE guild_id = ?', gid)).n;
  assert(/id="pin-name"[^>]*readonly/.test(html()) && text(bar(html())).includes(`${rosterRows} members.`), text(bar(html())));
  // Step 2: the map the Worker stored.
  G.handlers.click['setup-pin-next']();
  await until(() => view.step === 2);
  assert.equal(view.step, 2);
  assert(html().includes('id="rk-0-p"') && view.rows.length === 10 && view.rows.filter((r) => r.members > 0).every((r) => r.core), 'the stored map, every used rank mapped');
  G.handlers.click['setup-ranks-next']();
  await until(() => view.step === 3 && view.preview);
  // Step 3: the real dry run.
  assert.equal(view.step, 3, text(html()).slice(0, 300));
  const page = html();
  const dry = view.preview;
  assert(dry && dry.token && Array.isArray(dry.blockers));
  assert(text(page).includes(`${dry.access.members.afterFlip} accounts are members of`) && text(page).includes('Gmmain') && text(page).includes('Live'), 'the Owner is live through the proven character');
  assert(text(page).includes('Namebound') && text(page).includes('Matched by name only'), 'the characters bound by name are listed');
  assert(dry.boundByName.classMismatch === 0 || text(page).includes('right name with another class'), 'the class mismatch is counted');
  assert(dry.boundByName.classMismatch > 0, 'the fixture has one (Nameclass)');
  assert(text(page).includes('Nameleft Nameleft Former') && text(page).includes('Not on the guild roster 7') && text(page).includes('Showing 5 of 7'), 'the character that left the guild comes first; the rest is behind Show all');
  noRawAttrs(page, 'real step 3');
  const tiles = [...page.matchAll(/gs-su-stat-n">(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(tiles, [dry.access.loses.count, dry.access.gains.count, dry.ranks.changed, dry.ranks.becomesTrial, dry.permissions.gains.count]);
  // Step 4 and the dialog: no grant yet, so the flip answers fresh_required and the dialog turns into the sign-in step.
  G.handlers.click['setup-preview-next']();
  G.handlers.click['setup-switch']();
  const { dlg, form } = fakeDialog(dialogs[0].innerHTML);
  G.handlers.submit['setup-switch-form'](form);
  await until(() => dlg.innerHTML.includes('step 2 of 2'));
  assert(dlg.innerHTML.includes('Switch over - step 2 of 2') && dlg.innerHTML.includes('Sign in with Battle.net, then the switch runs.'), dlg.innerHTML.slice(0, 400));
  assert.equal((await s.one('SELECT rank_source FROM guilds WHERE id = ?', gid)).rank_source, null, 'nothing changed');
  // The step starts the real sign-in; the browser would go to Battle.net.
  G.handlers.submit['fresh-step-form'](stepForm(dlg, 'bnet'));
  await until(() => navigations.length === 1);
  assert.equal(navigations.length, 1, 'the Worker gave an address to go to');
  const pending = G.fresh.pending();
  assert(pending && pending.kind === 'source_switch' && pending.data.token === dry.token && pending.data.confirmedCharacterIds.length === dry.boundByName.ids.length);
  // Back from Battle.net with the grant: the act repeats the flip.
  await grant(s, 'gm');
  const address = await G.fresh.repeat(G.fresh.takePending());
  assert.equal(address, `#/g/${gid}/setup`);
  const guild = await s.one('SELECT rank_source, owner_user_id FROM guilds WHERE id = ?', gid);
  assert.equal(guild.rank_source, 'ingame', 'the guild follows the in-game roster');
  const done = await realPage(s);
  assert.equal(done.view.step, 5);
  const banner = text(done.html());
  const m = /(\d+) accounts are members: (\d+) stayed, (\d+) gained access and (\d+) lost it\. (\d+) characters? changed core rank, (\d+) of them (?:is|are) on Trial\./.exec(banner);
  assert(m, banner.slice(0, 400));
  assert.deepEqual([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])], [dry.access.members.afterFlip, dry.access.members.today - dry.access.loses.count, dry.access.gains.count, dry.access.loses.count], 'the result says what the preview promised');
  assert.deepEqual([Number(m[5]), Number(m[6])], [dry.ranks.changed, dry.ranks.becomesTrial]);
});

check('the pages against the Worker: unticking characters, Update preview and the switch - the result is the updated preview, which showed something else than the first one (the defect of the live run)', async () => {
  const s = await flipWorld();
  resetBrowser(`#/g/${s.gid}/setup`);
  const { view, html } = await realPage(s);
  G.handlers.click['setup-pin-next']();
  await until(() => view.step === 2);
  G.handlers.click['setup-ranks-next']();
  await until(() => view.step === 3 && view.preview);
  const first = view.preview;
  // Untick Nbperson (their account keeps its access only through the match) and Trialone (the Trial character).
  for (const id of [s.people.nb.cid, s.people.trial.cid]) G.handlers.change['setup-bind'](el({ 'data-id': id }, { checked: false }));
  assert(html().includes('class="gs-su-stats is-stale"') && /<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(html()), 'dimmed, Next off');
  G.handlers.click['setup-preview-next']();
  assert.equal(view.step, 3);
  G.handlers.click['setup-preview-update']();
  await until(() => !view.updating && view.preview !== first);
  const second = view.preview;
  assert(second.token !== first.token);
  assert.deepEqual(second.confirmedCharacterIds, first.boundByName.ids.filter((id) => id !== s.people.nb.cid && id !== s.people.trial.cid).sort());
  assert.equal(second.access.loses.count, first.access.loses.count + 1, 'Nbperson\'s account loses its access');
  assert.equal(second.ranks.becomesTrial, first.ranks.becomesTrial - 1, 'Trialone is no Trial');
  assert(!html().includes('is-stale') && primaryOf(html(), 'Next'), 'in sync');
  const tiles = (page) => [...page.matchAll(/gs-su-stat-n">(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(tiles(html()), [second.access.loses.count, second.access.gains.count, second.ranks.changed, second.ranks.becomesTrial, second.permissions.gains.count]);
  // Switch: the sign-in is fresh, so the flip applies at once with the token and the ids of the updated preview.
  G.handlers.click['setup-preview-next']();
  assert.equal(view.step, 4);
  await grant(s, 'gm');
  G.handlers.click['setup-switch']();
  const { form } = fakeDialog(dialogs[0].innerHTML);
  G.handlers.submit['setup-switch-form'](form);
  await until(() => view.step === 5);
  assert.equal(view.step, 5, text(html()).slice(0, 300));
  const banner = text(html());
  const m = /(\d+) accounts? (?:is a member|are members): (\d+) stayed, (\d+) gained access and (\d+) lost it\. (\d+) characters? changed core rank, (\d+) of them (?:is|are) on Trial\./.exec(banner);
  assert(m, banner.slice(0, 400));
  assert.deepEqual([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])],
    [second.access.members.afterFlip, second.access.members.today - second.access.loses.count, second.access.gains.count, second.access.loses.count, second.ranks.changed, second.ranks.becomesTrial], 'the result is what the updated preview promised');
  assert.notDeepEqual([Number(m[4]), Number(m[6])], [first.access.loses.count, first.ranks.becomesTrial], 'and not what the first one showed');
  const kept = await s.rows('SELECT id, blizzard_char_id FROM characters WHERE id IN (?, ?)', s.people.nb.cid, s.people.trial.cid);
  assert(kept.every((row) => row.blizzard_char_id === null), 'the unticked characters stay unmatched');
});

check('the pages against the Worker: the pin (the sign-in carries the name, the act posts it) and the map on a fresh legacy guild; the Owner who cannot be proved sees it before switching', async () => {
  const { pinWorld, TARGET, grantPin } = require('../guild-pin');
  const s = await pinWorld();
  {
    resetBrowser(`#/g/${s.gid}/setup`);
    let { view, html } = await realPage(s);
    assert.equal(view.step, 1);
    assert(/id="pin-name"[^>]*value="Writers B3"/.test(html()) && text(html()).includes('Realm: Nightslayer'), text(html()).slice(0, 400));
    assert(text(bar(html())).includes('Writers B3, Nightslayer') && primaryOf(html(), 'Confirm with Battle.net'));
    // The page starts the real sign-in with the typed name; the callback (real, through the fake Battle.net) writes the grant; the act posts the pin.
    G.handlers.click['setup-pin']();
    await until(() => navigations.length === 1 || view.error);
    assert.equal(navigations.length, 1, view.error ? view.error.title + ' / ' + view.error.text + ' / ' + view.error.code : 'the start answered with the provider\'s address');
    const pending = G.fresh.pending();
    assert.deepEqual(plain(pending.params), { guildName: TARGET.guildName, realmSlug: TARGET.realmSlug });
    await grantPin(s, 'gm', TARGET);
    const address = await G.fresh.repeat(G.fresh.takePending());
    assert.equal(address, `#/g/${s.gid}/setup`);
    ({ view, html } = await realPage(s));
    assert(text(html()).includes('Linked to') && text(html()).includes('members read from the guild roster.') && /id="pin-name"[^>]*readonly/.test(html()), text(html()).slice(0, 500));
    assert(view.bnet.roster.members >= 2 && view.bnet.pin.complete);
    // Step 2: the map is empty, every used rank is a gap; map them (the real dry run and PUT).
    G.handlers.click['setup-pin-next']();
    await until(() => view.step === 2);
    assert.equal(view.step, 2);
    const used = view.rows.filter((r) => r.members > 0);
    assert(used.length >= 2 && used.every((r) => !r.core), 'nothing is mapped yet');
    assert(text(html()).includes('Map every in-game rank first. Not mapped yet:'));
    used.forEach((r) => select(r.rank, 'core', 'raider'));
    G.handlers.click['setup-ranks-next']();
    await until(() => (view.step === 3 && view.preview) || view.error);
    assert.equal(view.step, 3, view.error ? view.error.title + ' ' + view.error.text + ' ' + view.error.code : text(html()).slice(0, 300));
    const stored = await s.rows('SELECT source_key, core_rank, role_id FROM source_rank_maps WHERE guild_id = ? ORDER BY CAST(source_key AS INTEGER)', s.gid);
    assert.equal(stored.length, used.length, 'only the mapped ranks were saved');
    assert.equal(stored[0].source_key, '0');
    assert.equal(stored[0].role_id, 'guild_master', 'rank 0 is Guild Master');
    // Step 3: the Owner has no proven character on this roster: the page says so and stops there.
    assert(view.preview.blockers.some((b) => b.code === 'owner_would_be_suspended'), JSON.stringify(view.preview.blockers));
    assert(html().includes('gs-su-owner is-bad') && text(html()).includes('Would be suspended') && text(bar(html())).includes('Sign in with Battle.net before you switch.') && /<button[^>]*disabled[^>]*>(?:<span>)?Next/.test(html()));
  }
});

check('the pages against the Worker: not the Owner - the Worker refuses the reads the Owner steps make, the page shows facts only', async () => {
  const s = await flipWorld();
  resetBrowser(`#/g/${s.gid}/setup`);
  const { view, html } = await realPage(s, 'off');
  assert.equal(view.owner, false);
  assert(text(html()).includes('Only') && text(html()).includes('can set up the in-game guild.') && !html().includes('gs-commitbar'), text(html()).slice(0, 300));
  const res = await s.call('off', 'GET', '/rank-map');
  assert.equal(res.status, 403);
  assert.equal((await s.call('off', 'POST', '/flip/dry-run', {})).status, 403);
});

runChecks(checks);
