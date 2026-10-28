/**
 * Raidsmith guild app - lane B8a-owner of the user-hierarchy build: the Owner-seat screens (boards O1, O2, O4, O5, O5b, P1 of the approved canvas b8a-admin).
 * Run: node tests/guild/guild-b8a-owner-tests.js [name filter]
 *
 *   - the claim offer (a banner on the officer Home) shows only for a Guild Master whose role comes from the in-game rank and who does not hold the seat; it names the holder and says
 *     whether they are suspended; its button opens the confirm of the claim, whose second step is the Battle.net sign-in (purpose gm_claim, Battle.net only) and says every 409;
 *   - the suspended-Owner banner is for the seat holder alone, has one button, and ONE success banner follows when the sign-in match clears it (sessionStorage per guild);
 *   - the Owner review page (GET .../claim-review) draws the claim, roles, rank permissions, hand links and the counts; Mark as reviewed dismisses the Home item and closes the page;
 *   - Home draws claim_review (Hide / Restore), block_review and unmapped_ranks (no menu: the Worker does not let them be hidden) and follows the item's link;
 *   - the Account page says where a suspended Owner's seat goes; the hand-over copy names Users and the Owner seat;
 *   - the Worker's bearer link names the Links and keys page; one real pass against the Worker: offer -> claim -> review -> mark reviewed.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runChecks } = require('../guild-b3-world');
const { claimWorld, claim, signInAgain, ACCOUNT } = require('../guild-claim');
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
      globalThis.__claimWorlds = [];
      try { await fn(); } finally { await Promise.all(globalThis.__claimWorlds.map((s) => s.close())); await new Promise((resolve) => setTimeout(resolve, 150)); }
    },
  });
}

// ---------------------------------------------------------------------------
// The browser half: the guild scripts in a vm with no DOM, a fake document, storage and location

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout, URL };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const sandbox = loadGuild();
const G = sandbox.Guild;
const S = G.app.state;
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await tick(); };
const tight = (s) => s.replace(/\s+([.,;:])/g, '$1'); // text() leaves a space where a tag was: "Users ."
const HOME = G.router.format({ name: 'section', gid: 'g1', section: 'home' });
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const el = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null }, extra || {});

let fields = {};
sandbox.document = { getElementById: (id) => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const field = (id) => (fields[id] = { id, textContent: '', hidden: true });

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), has: (k) => map.has(k) };
}
let storage;
let navigations;
let goes;
function resetBrowser(hash = '#/g/g1/home') {
  fields = {};
  storage = memoryStorage();
  navigations = [];
  goes = [];
  sandbox.window = { sessionStorage: storage, location: { hash, origin: 'https://raidsmith.test', assign: (url) => navigations.push(url) } };
  G.fresh.navigate = (url) => navigations.push(url);
  G.fresh.now = () => Date.now();
  // The shell keeps "the success banner is showing" in memory: a visit to another page clears what an earlier check left.
  G.shell.suspendedBannerHtml({ section: 'guild', guildData: gd({ owner: { name: 'x', you: true, suspended: false } }), route: { name: 'flush' } });
  G.app.go = (hash2, replace) => goes.push([hash2, !!replace]);
  G.app.render = () => {};
  G.ui.announce = () => {};
  G.ui.focusByKey = () => true;
  G.ui.toast = () => true;
  S.me = null;
  S.guilds = {};
  S.currentGid = null;
  S.att = {};
  S.attention = {};
  S.teamByGuild = {};
}

// Scripted API: api({ 'POST /api/fresh/start': () => ..., ... }) replaces get / post / del and records every call.
function scriptApi(script) {
  const calls = [];
  const respond = (method) => (apiPath, body) => {
    calls.push({ method, path: apiPath, body: body === undefined ? undefined : plain(body) });
    const fn = script[`${method} ${apiPath}`];
    if (!fn) return Promise.reject(new G.api.ApiError(404, { error: 'not_found' }));
    try { return Promise.resolve(fn(body)); } catch (error) { return Promise.reject(error); }
  };
  G.api.get = respond('GET');
  G.api.post = respond('POST');
  G.api.del = respond('DELETE');
  return calls;
}
const apiError = (status, body) => new G.api.ApiError(status, body);
const AUTHORIZE = 'https://oauth.example.test/authorize?state=abc';

function fakeDialog(html = '<form>step 1</form>') {
  const dlg = { innerHTML: html, open: true, isConnected: true, querySelector: () => null, contains: () => false };
  const form = { closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: () => null, querySelectorAll: () => [], elements: {} };
  return { dlg, form };
}

const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'guild.access': 'guild', 'loot.edit': 'guild' };
const TEAMS = [{ id: 't1', name: 'Main 25', size: 25, archived: false, players: 3, leads: [] }];
// The guild payload of the in-game Guild Master who is not the Owner (GET /api/guild/:gid: me.roles marks the rank-given role with fromRank, owner names the holder).
function gd(over = {}) {
  return {
    guild: { id: 'g1', name: 'Vindicated', realm: 'Firemaw', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', createdAt: 1 },
    teams: TEAMS,
    me: { roles: [{ role: 'guild_master', fromRank: true }], can: OFFICER_CAN, personId: null },
    owner: { name: 'Brandon', you: false, suspended: true },
    attendanceFlags: {}, rosterFlags: {},
    ...over,
  };
}
const BOTH = { identities: { discord: { username: 'kaelen' }, bnet: { battletag: 'Kaelen#2208' } } };
const NOW = Date.UTC(2026, 9, 29, 15, 0);
const week = () => ({ offset: 0, start: '2026-10-27', end: '2026-11-02', resetDay: 2, autoAdvanced: false, raids: [] });
const attn = (over) => ({ today: '2026-10-29', total: 0, items: [], more: {}, hidden: [], counts: {}, week: week(), onboarding: null, ...(over || {}) });
const home = (guildData, data, extra) => G.pages.attention.attentionHtml({ guildData, data: data || attn(), now: NOW, ...(extra || {}) });

// ---------------------------------------------------------------------------
// 1. The claim offer (board O1) and the claim confirm (board O2)

check('claim offer: only a Guild Master whose role comes from the in-game rank and who is not the Owner; it names the holder and says suspended', () => {
  resetBrowser();
  const offer = G.pages.attention.claimOfferHtml(gd());
  assert(offer.includes('id="owner-offer"') && offer.includes('gs-banner-info'), 'an info banner');
  assert(text(offer).includes('You are the Guild Master in game. Brandon holds the Owner seat and is suspended.'), text(offer));
  assert(text(offer).includes('Take the seat to run Guild setup, ranks and hand-overs.'));
  assert(/<button type="button" class="gs-btn gs-btn-sm" data-action="claim-open"/.test(offer), 'a secondary button');
  assert(!/gs-btn-molten/.test(offer), 'the banner button is secondary, never the primary');
  assert(!offer.includes('gs-banner-x'), 'not dismissible');
  // A live holder: not "suspended". Nobody holding the seat: says vacant.
  assert(text(G.pages.attention.claimOfferHtml(gd({ owner: { name: 'Brandon', you: false } }))).includes('Brandon holds the Owner seat.'));
  assert(!text(G.pages.attention.claimOfferHtml(gd({ owner: { name: 'Brandon', you: false } }))).includes('suspended'));
  assert(text(G.pages.attention.claimOfferHtml(gd({ owner: { name: null, you: false } }))).includes('The Owner seat is vacant.'));
  // Nobody else sees it.
  assert.equal(G.pages.attention.claimOfferHtml(gd({ owner: { name: 'Kaelen', you: true, suspended: false } })), '', 'the Owner');
  assert.equal(G.pages.attention.claimOfferHtml(gd({ owner: { name: 'Kaelen', you: true, suspended: true } })), '', 'a suspended Owner');
  assert.equal(G.pages.attention.claimOfferHtml(gd({ me: { roles: [{ role: 'guild_master' }], can: OFFICER_CAN } })), '', 'a Guild Master by hand (no fromRank)');
  assert.equal(G.pages.attention.claimOfferHtml(gd({ me: { roles: [{ role: 'officer', fromRank: true }], can: OFFICER_CAN } })), '', 'an Officer');
  assert.equal(G.pages.attention.claimOfferHtml(gd({ owner: undefined })), '', 'a payload with no owner block');
  assert.equal(G.pages.attention.claimOfferHtml(gd({ owner: { name: 'Brandon' } })), '', 'no you flag');
  // It sits above the head on the officer Home, once.
  const page = home(gd());
  assert.equal((page.match(/id="owner-offer"/g) || []).length, 1);
  assert(page.indexOf('id="owner-offer"') > 0 && page.indexOf('id="owner-offer"') < page.indexOf('<header class="gs-hd-head">'), 'above the head of the Week');
  assert(!home(gd({ owner: { name: 'Kaelen', you: true, suspended: false } })).includes('owner-offer'));
});

check('claim confirm: the button opens the dialog (what happens), its submit swaps the body for the Battle.net step (gm_claim), and the sign-in starts the claim', async () => {
  resetBrowser();
  S.me = { user: { id: 'u9' }, ...BOTH };
  S.guilds = { g1: gd() };
  S.currentGid = 'g1';
  const opened = [];
  G.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return null; };
  G.handlers.click['claim-open'](el({}));
  assert.equal(opened.length, 1);
  const first = text(opened[0].html);
  assert(first.includes('Take the Owner seat of Vindicated?') && first.includes('Only the Guild Master in game can do this, and Raidsmith checks it on Battle.net.'), first);
  for (const line of ['What happens', 'You take the seat from Brandon', 'Keeps the powers of their in-game rank and every role set by hand', 'Links and keys', 'Keep working. You can turn any of them off',
    'Switched off until you publish it again', 'Unused previews are cancelled']) assert(first.includes(line), line);
  assert(opened[0].html.includes('data-submit="claim-confirm"') && opened[0].html.includes('gs-dialog-confirm') && opened[0].html.includes('gs-forge'), 'a confirm dialog with the Forge class');
  assert(opened[0].html.includes('>Take the seat<') && opened[0].html.includes('data-action="dialog-cancel"'), 'Take the seat and Cancel');
  // A vacant seat has nobody to name.
  S.guilds.g1 = gd({ owner: { name: null, you: false } });
  const vacant = text(G.pages.attention.claimDialogHtml(S.guilds.g1));
  assert(vacant.includes('You take the vacant seat') && !vacant.includes('Keeps the powers'), vacant);
  S.guilds.g1 = gd();
  // A refused page: the button does nothing for somebody who is not offered the seat.
  S.guilds.g1 = gd({ owner: { name: 'Kaelen', you: true, suspended: false } });
  G.handlers.click['claim-open'](el({}));
  assert.equal(opened.length, 1, 'nothing opened for the Owner');
  S.guilds.g1 = gd();
  // Submit: step 2 in the same dialog (never a second one).
  const { dlg, form } = fakeDialog(opened[0].html);
  G.handlers.submit['claim-confirm'](form);
  const step = text(dlg.innerHTML);
  assert(step.includes('Take the Owner seat - step 2 of 2') && step.includes('Confirm it is you'), step);
  assert(step.includes('Sign in with Battle.net. Raidsmith checks that your Battle.net account holds the rank 0 character of the Vindicated guild roster, then gives you the seat. You come back to Home.'), step);
  assert(step.includes('Kaelen#2208'), 'the Battle.net account it will use');
  assert(!dlg.innerHTML.includes('type="radio"') && dlg.innerHTML.includes('>Sign in with Battle.net<'), 'Battle.net only: no choice of sign-in');
  assert(dlg.innerHTML.includes('data-action="fresh-step-back"'), 'Back returns to step 1');
  // The sign-in: the guild's start route, purpose gm_claim, Battle.net.
  const calls = scriptApi({ 'POST /api/guild/g1/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form']({ closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: () => null, querySelectorAll: () => [] });
  await settle();
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', '/api/guild/g1/fresh/start', { purpose: 'gm_claim', params: {}, provider: 'bnet' }]]);
  assert.deepEqual(navigations, [AUTHORIZE]);
  const saved = plain(G.fresh.pending());
  assert.deepEqual([saved.kind, saved.gid, saved.purpose, saved.provider], ['gm_claim', 'g1', 'gm_claim', 'bnet']);
});

check('claim confirm: every refusal of the start is said in the step - claim_not_available, already_owner, identity_not_linked - and the person stays in it', async () => {
  resetBrowser();
  S.me = { user: { id: 'u9' }, ...BOTH };
  S.guilds = { g1: gd() };
  S.currentGid = 'g1';
  const refusals = [
    [409, { error: 'claim_not_available', message: 'This guild does not run on its in-game roster yet, so there is no Guild Master seat to claim.' }, 'This guild does not run on its in-game roster yet, so there is no Guild Master seat to claim.'],
    [409, { error: 'already_owner', message: 'You hold the Owner seat of this guild already.' }, 'You hold the Owner seat of this guild already.'],
    [409, { error: 'identity_not_linked', provider: 'bnet', message: 'x' }, 'Connect Battle.net to your account first, then repeat this.'],
  ];
  for (const [status, body, sentence] of refusals) {
    const { dlg, form } = fakeDialog('<form>ONE</form>');
    G.handlers.submit['claim-confirm'](form);
    field('dlg-error');
    scriptApi({ 'POST /api/guild/g1/fresh/start': () => { throw apiError(status, body); } });
    G.handlers.submit['fresh-step-form']({ closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: () => null, querySelectorAll: () => [] });
    await settle();
    assert.equal(fields['dlg-error'].textContent, sentence, body.error);
    assert(dlg.innerHTML.includes('Take the Owner seat - step 2 of 2'), `${body.error}: still in the step`);
    assert.deepEqual(navigations, [], 'nobody was sent to Battle.net');
    assert.equal(G.fresh.pending(), null, 'the saved act is cleared');
  }
  // An account with no Battle.net cannot be asked for it: the step says to connect it first, with a disabled button.
  S.me = { user: { id: 'u9' }, identities: { discord: { username: 'kaelen' }, bnet: null } };
  const { dlg, form } = fakeDialog('<form>ONE</form>');
  G.handlers.submit['claim-confirm'](form);
  assert(text(dlg.innerHTML).includes('Connect Battle.net to your account first, then repeat this.') && /disabled/.test(dlg.innerHTML), text(dlg.innerHTML));
});

// ---------------------------------------------------------------------------
// 2. The suspended Owner (board O4)

const shellCtx = (gdata, extra) => ({ section: 'guild', page: 'app', me: { user: { id: 'u1' }, ...BOTH }, guildData: gdata, route: { name: 'section', gid: 'g1', section: 'home' }, ...(extra || {}) });
const ownerGd = (owner) => gd({ me: { roles: [{ role: 'officer', fromRank: true }], can: OFFICER_CAN }, owner });

check('suspended Owner: a warning with one Sign in with Battle.net button for the seat holder alone, on every guild page', () => {
  resetBrowser();
  const mine = ownerGd({ name: 'Brandon', you: true, suspended: true });
  const html = G.shell.suspendedBannerHtml(shellCtx(mine));
  assert(html.includes('id="owner-suspended"') && html.includes('gs-banner-warning') && html.includes('role="alert"'), html);
  assert(text(html).includes('Your Owner powers are paused.'));
  assert(text(html).includes('Raidsmith cannot confirm through Battle.net that you hold a character on the Vindicated guild roster. You keep the seat, but only the powers of your in-game rank apply.'), text(html));
  assert.equal((html.match(/<a class="gs-btn/g) || []).length, 1, 'one button');
  assert(html.includes('href="/auth/bnet/login?mode=signin"') && text(html).includes('Sign in with Battle.net'), 'the normal sign-in (it runs the match)');
  assert(!html.includes('gs-btn-molten') && !html.includes('gs-banner-x'), 'secondary, not dismissible');
  // It is in the shell's banner slot, so every guild page carries it (and nothing else in the slot changes).
  const slots = G.shell.slots(shellCtx(mine));
  assert(slots.banner.includes('id="owner-suspended"'));
  const other = G.shell.slots(shellCtx(mine, { route: { name: 'settings', gid: 'g1', tab: 'general' } }));
  assert(other.banner.includes('id="owner-suspended"'), 'on another page too');
  // Nobody else: an officer with guild.access sees `suspended` in the payload but is not the holder; neither is the Guild Master who may claim; the live Owner.
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(ownerGd({ name: 'Brandon', you: false, suspended: true }))), '');
  storage.removeItem('raidsmith.ownerSuspended.g1'); // this tab saw the warning above; the live Owner below never was suspended here
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(ownerGd({ name: 'Kaelen', you: true, suspended: false }))), '');
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(ownerGd(undefined))), '');
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(null)), '');
  assert.equal(G.shell.slots(shellCtx(null, { section: 'planner' })).banner, '');
  // An account with no Battle.net linked connects it first (signing in with it would make a second account).
  const lonely = shellCtx(mine, { me: { user: { id: 'u1' }, identities: { discord: { username: 'brandon' }, bnet: null } } });
  const connect = G.shell.suspendedBannerHtml(lonely);
  assert(connect.includes('href="#/linked"') && text(connect).includes('Connect Battle.net') && !connect.includes('mode=signin'), connect);
});

check('suspended Owner: one success banner when the sign-in match clears it - remembered per guild in sessionStorage, gone on another page, once', () => {
  resetBrowser();
  const suspended = ownerGd({ name: 'Brandon', you: true, suspended: true });
  const live = ownerGd({ name: 'Brandon', you: true, suspended: false });
  // Never suspended in this tab: nothing.
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(live)), '');
  assert.equal(storage.getItem('raidsmith.ownerSuspended.g1'), null, 'nothing is remembered for an Owner who was never suspended');
  // Suspended: remembered.
  G.shell.suspendedBannerHtml(shellCtx(suspended));
  assert.equal(storage.getItem('raidsmith.ownerSuspended.g1'), 'suspended');
  // The round trip to Battle.net reloads the page; the payload no longer says suspended: the success banner, once.
  const back = G.shell.suspendedBannerHtml(shellCtx(live));
  assert(back.includes('id="owner-back"') && back.includes('gs-banner-success') && text(back).includes('Your Owner powers are back.'), back);
  assert(text(back).includes('Battle.net confirmed a character of yours on the Vindicated guild roster again.'));
  assert(back.includes('data-action="owner-back-dismiss"'), 'it can be dismissed');
  assert.equal(storage.getItem('raidsmith.ownerSuspended.g1'), 'live', 'remembered as live now');
  assert(G.shell.suspendedBannerHtml(shellCtx(live)).includes('id="owner-back"'), 'a redraw of the same page keeps it');
  assert(G.shell.slots(shellCtx(live)).banner.includes('id="owner-back"'));
  // Another page: gone, and it does not come back.
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(live, { route: { name: 'section', gid: 'g1', section: 'roster' } })), '');
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(live)), '');
  // Dismissed: gone for good on that page.
  G.shell.suspendedBannerHtml(shellCtx(suspended));
  assert(G.shell.suspendedBannerHtml(shellCtx(live)).includes('owner-back'));
  let removed = 0;
  G.handlers.click['owner-back-dismiss']({ closest: () => ({ remove: () => { removed++; } }) });
  assert.equal(removed, 1);
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(live)), '', 'a redraw does not bring it back');
  // Per guild: another guild's state is its own.
  G.shell.suspendedBannerHtml(shellCtx(suspended));
  const otherGuild = ownerGd({ name: 'Brandon', you: true, suspended: false });
  otherGuild.guild = { ...otherGuild.guild, id: 'g2', name: 'Ravens' };
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(otherGuild, { route: { name: 'section', gid: 'g2', section: 'home' } })), '', 'a guild that was never suspended shows nothing');
});

check('suspended Owner: blocked or missing sessionStorage never throws - the warning shows, the success banner is simply not shown', () => {
  resetBrowser();
  const suspended = ownerGd({ name: 'Brandon', you: true, suspended: true });
  const live = ownerGd({ name: 'Brandon', you: true, suspended: false });
  sandbox.window.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert(G.shell.suspendedBannerHtml(shellCtx(suspended)).includes('owner-suspended'));
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(live)), '');
  delete sandbox.window.sessionStorage;
  assert(G.shell.suspendedBannerHtml(shellCtx(suspended)).includes('owner-suspended'));
  assert.equal(G.shell.suspendedBannerHtml(shellCtx(live)), '');
});

// ---------------------------------------------------------------------------
// 3. The Owner review (board O5)

const REVIEW = () => ({
  claim: { id: 'a1', at: Date.UTC(2026, 9, 29, 16, 0), by: { id: 'u9', name: 'Kaelen' }, previousOwner: { id: 'u1', name: 'Brandon' }, previousWasSuspended: true, publicUnpublished: true },
  roles: [
    { id: 'r1', userId: 'u2', name: 'Ashgrove', roleId: 'officer', roleName: 'Officer', teamId: null, teamName: null, source: 'manual', assignedBy: { id: 'u1', name: 'Brandon' }, assignedAt: Date.UTC(2026, 9, 12, 16) },
    { id: 'r2', userId: 'u3', name: 'Hollowfen', roleId: 'team_lead', roleName: 'Team Lead', teamId: 't2', teamName: 'Sunday Alts', source: 'discord', assignedBy: null, assignedAt: Date.UTC(2026, 9, 28, 16) },
    { id: 'r3', userId: 'u4', name: 'Mendra', roleId: 'officer', roleName: 'Officer', teamId: null, teamName: null, source: 'manual', assignedBy: { id: 'u1', name: 'Brandon' }, assignedAt: Date.UTC(2026, 8, 3, 16) },
  ],
  rankMap: { rows: [
    { rank: 0, label: 'Guild Master', coreRank: 'raider', roleId: 'guild_master', roleName: 'Guild Master' },
    { rank: 1, label: 'Raid Leader', coreRank: 'raider', roleId: 'officer', roleName: 'Officer' },
    { rank: 4, label: 'Raider', coreRank: 'trial', roleId: null, roleName: null },
    { rank: 6, label: 'Spare', coreRank: null, roleId: null, roleName: null },
  ], setBy: null, setAt: null },
  handLinks: { persons: [{ personId: 'p7', userId: 'u7', accountName: 'Aldrenn', mainName: 'Aldrennmain' }], characters: [{ id: 'c1', name: 'Marrowind', class: 'ROGUE', personId: 'p8', proof: 'officer' }, { id: 'c2', name: 'Pyrewick', class: 'MAGE', personId: null, proof: 'hand' }], truncated: false, setBy: null, setAt: null },
  rolesTruncated: false,
  bearer: { name: 'settings', tab: 'links', apiKeys: 2, guestLinks: 1, joinLinks: 2, webhooks: 1 },
});
const ownerGuild = (over) => gd({ me: { roles: [{ role: 'guild_master', fromRank: true }], can: OFFICER_CAN, personId: null }, owner: { name: 'Kaelen', you: true, suspended: false, reviewOpen: true }, ...(over || {}) });

check('Owner review: the claim, roles with who and when, rank permissions, hand links, the counts and one primary', () => {
  resetBrowser();
  const g = ownerGuild();
  const html = G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: REVIEW() });
  const t = text(html);
  assert(t.includes('Kaelen took the Owner seat on Oct 29.'), t.slice(0, 300));
  assert(t.includes('Brandon held it before and was suspended. Everything Brandon set up stays live until you change it. The public page was switched off.'), t.slice(0, 500));
  assert(html.includes('href="#/g/g1/settings/public"') && t.includes('Open Public page'));
  // Roles: oldest first as the Worker sends them, with who set them and when.
  assert(t.includes('Roles 3') && tight(t).includes('Hand-set and stored roles, oldest first. Change them on Users.'), t.slice(300, 600));
  assert(html.includes('href="#/g/g1/users"'), 'Users is a link');
  for (const cell of ['Ashgrove', 'Officer', 'Whole guild', 'By hand', 'Brandon', 'Oct 12', 'Hollowfen', 'Team Lead', 'Sunday Alts', 'From Discord', 'Not recorded', 'Oct 28', 'Sep 3']) assert(t.includes(cell), cell);
  // Rank permissions.
  assert(t.includes('Rank permissions 4') && t.includes('Open Battle.net settings') && html.includes('href="#/g/g1/settings/battlenet"'));
  for (const cell of ['Rank 0', 'Guild Master', 'Raider', 'Rank 4', 'Trial', 'Not mapped', 'None']) assert(t.includes(cell), cell);
  // Hand links: people and characters in one list, the characters in their class colour, each linking to its person.
  assert(t.includes('Hand links 3') && t.includes('Aldrennmain') && t.includes('Aldrenn') && t.includes('Linked by an officer') && t.includes('Character added by an officer') && t.includes('Character added by hand'));
  assert(html.includes(`href="${G.router.format({ name: 'person', gid: 'g1', pid: 'p8' })}"`), 'a character links to its person');
  assert(html.includes(`href="${G.router.format({ name: 'person', gid: 'g1', pid: 'p7' })}">Aldrennmain</a>`), 'a person links to its page');
  assert(html.includes('Marrowind') && html.includes('Pyrewick') && html.includes('gs-class-rogue') && html.includes('gs-class-mage'), 'the characters keep their class colour');
  // The counts and the pages they open (the bearer tab comes from the Worker: Links and keys).
  assert(t.includes('2 API keys, 1 guest link, 2 raid join links') && t.includes('1 webhook'));
  assert(html.includes('href="#/g/g1/settings/links"') && html.includes('href="#/g/g1/settings/notifications"'));
  assert(/Open Links and keys/.test(t) && /Open Notifications/.test(t));
  // One primary.
  assert.equal((html.match(/gs-btn-molten/g) || []).length, 1, 'one primary');
  assert(/gs-btn-molten[^>]*data-action="claimreview-done"|data-action="claimreview-done"[^>]*gs-btn-molten/.test(html) && t.includes('Mark as reviewed'));
  // Every column head sorts.
  assert.equal((html.match(/<th scope="col"/g) || []).length, (html.match(/<th scope="col"[^>]*aria-sort/g) || []).length, 'all heads are sort buttons');
  assert((html.match(/data-action="table-sort"/g) || []).length >= 13);
  assert(!/\sstyle=|\son[a-z]+=/.test(html), 'no inline style or handlers');
});

check('Owner review: sorting a head reorders the rows; a vacant seat before and zero counts read plainly; the lists say when they were cut', () => {
  resetBrowser();
  const g = ownerGuild();
  G.ui.clearTableSort('claimreview-roles');
  const names = (html) => [...html.matchAll(/<th scope="row" class="gs-cell-strong">(Ashgrove|Hollowfen|Mendra)</g)].map((m) => m[1]);
  assert.deepEqual(names(G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: REVIEW() })), ['Ashgrove', 'Hollowfen', 'Mendra'], 'the Worker order');
  G.handlers.click['table-sort'](el({ 'data-table': 'claimreview-roles', 'data-sort': 'seton', 'data-dir': '' }));
  assert.deepEqual(names(G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: REVIEW() })), ['Mendra', 'Ashgrove', 'Hollowfen'], 'by date, oldest first');
  G.handlers.click['table-sort'](el({ 'data-table': 'claimreview-roles', 'data-sort': 'seton' }));
  assert.deepEqual(names(G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: REVIEW() })), ['Hollowfen', 'Ashgrove', 'Mendra'], 'and back');
  G.ui.clearTableSort('claimreview-roles');
  const bare = REVIEW();
  bare.claim.previousOwner = null;
  bare.claim.previousWasSuspended = false;
  bare.claim.publicUnpublished = false;
  bare.roles = [];
  bare.rankMap.rows = [];
  bare.handLinks.persons = [];
  bare.handLinks.characters = [];
  bare.bearer = { name: 'settings', tab: 'links', apiKeys: 0, guestLinks: 0, joinLinks: 0, webhooks: 0 };
  const t = text(G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: bare }));
  assert(t.includes('The seat was vacant before. Everything that was set up before stays live until you change it.') && !t.includes('public page was switched off'), t.slice(0, 300));
  assert(t.includes('No roles are set up.') && t.includes('No in-game ranks are mapped.') && t.includes('Nothing is linked by hand.') && t.includes('None are live'));
  const cut = REVIEW();
  cut.rolesTruncated = true;
  cut.handLinks.truncated = true;
  const cutText = text(G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: cut }));
  assert(cutText.includes('Roles 3+') && cutText.includes('Hand links 3+') && cutText.includes('Showing the first 300'), cutText.slice(0, 200));
  assert(G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: null }).includes('Nothing to review'));
  assert(G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: { ...REVIEW(), claim: null } }).includes('Nothing to review'));
  // The hostile text is escaped.
  const hostile = REVIEW();
  hostile.roles[0].name = '<img src=x onerror=alert(1)>';
  hostile.claim.by.name = '"><script>alert(1)</script>';
  const out = G.pages.settingsClaimReview.settingsHtml({ guildData: g, data: hostile });
  assert(!out.includes('<img') && !out.includes('<script') && out.includes('&lt;img'));
});

check('Owner review: load reads GET .../claim-review, main draws it in the settings frame, an error has Try again and a non-Owner is told who the page is for', async () => {
  resetBrowser();
  const g = ownerGuild();
  S.guilds = { g1: g };
  S.currentGid = 'g1';
  let calls = scriptApi({ 'GET /api/guild/g1/claim-review': () => REVIEW() });
  await G.pages.settingsClaimReview.load({ name: 'settings', gid: 'g1', tab: 'claimreview' }, g);
  assert.deepEqual(calls.map((c) => [c.method, c.path]), [['GET', '/api/guild/g1/claim-review']]);
  const ctx = { guildData: g, route: { name: 'settings', gid: 'g1', tab: 'claimreview' }, me: { user: { id: 'u9' } }, section: 'guild' };
  const page = G.pages.settingsClaimReview.main({ name: 'settings', gid: 'g1', tab: 'claimreview' }, g, ctx);
  assert(/<h2[^>]*>Owner review<\/h2>/.test(page) && text(page).includes('Kaelen took the Owner seat on Oct 29.'));
  assert(page.includes('gs-settings-page'), 'the settings frame');
  // A failed read: an error region with Try again; the page does not throw.
  calls = scriptApi({ 'GET /api/guild/g1/claim-review': () => { throw apiError(500, { error: 'error', message: 'It broke.' }); } });
  await G.pages.settingsClaimReview.load({ name: 'settings', gid: 'g1' }, g);
  const failed = G.pages.settingsClaimReview.main({}, g, ctx);
  assert(failed.includes('Could not load the Owner review') && failed.includes('It broke.') && failed.includes('data-action="claimreview-retry"'));
  scriptApi({ 'GET /api/guild/g1/claim-review': () => REVIEW() });
  await G.handlers.click['claimreview-retry'](el({}));
  assert(text(G.pages.settingsClaimReview.main({}, g, ctx)).includes('Mark as reviewed'), 'Try again reads it again');
  // Not the Owner (403): a sentence, no data.
  scriptApi({ 'GET /api/guild/g1/claim-review': () => { throw apiError(403, { error: 'forbidden', message: 'Only the Owner of the guild can review a claim.' }); } });
  await G.pages.settingsClaimReview.load({ name: 'settings', gid: 'g1' }, g);
  assert(text(G.pages.settingsClaimReview.main({}, g, ctx)).includes('The Owner review is for the Owner of the guild.'));
});

check('Owner review: Mark as reviewed dismisses the Home item, closes the tab (owner.reviewOpen) and goes to Home; a refusal stays on the page with the sentence', async () => {
  resetBrowser();
  const g = ownerGuild();
  S.guilds = { g1: g };
  S.currentGid = 'g1';
  scriptApi({ 'GET /api/guild/g1/claim-review': () => REVIEW() });
  await G.pages.settingsClaimReview.load({ name: 'settings', gid: 'g1' }, g);
  // A refusal first.
  let calls = scriptApi({ 'POST /api/guild/g1/attention/dismissals': () => { throw apiError(500, { error: 'error', message: 'Could not save that.' }); } });
  await G.handlers.click['claimreview-done'](el({}));
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', '/api/guild/g1/attention/dismissals', { itemId: 'claim_review' }]]);
  assert.equal(g.owner.reviewOpen, true, 'still open');
  assert.deepEqual(goes, [], 'stays');
  const ctx = { guildData: g, route: { name: 'settings', gid: 'g1', tab: 'claimreview' }, me: { user: { id: 'u9' } }, section: 'guild' };
  assert(text(G.pages.settingsClaimReview.main({}, g, ctx)).includes('Could not save that.'));
  // Then the real one.
  calls = scriptApi({ 'POST /api/guild/g1/attention/dismissals': () => ({ ok: true }) });
  await G.handlers.click['claimreview-done'](el({}));
  assert.deepEqual(calls.map((c) => [c.method, c.path, c.body]), [['POST', '/api/guild/g1/attention/dismissals', { itemId: 'claim_review' }]]);
  assert.equal(g.owner.reviewOpen, false, 'the Owner review tab closes with it');
  assert(!G.shell.settingsTabs(g.me.can, g.me.roles, g.owner).some((tab) => tab.tab === 'claimreview'));
  assert.deepEqual(goes, [[HOME, false]], 'on to Home');
  // A second press while it is running does nothing.
  const busy = G.pages.settingsClaimReview.main({}, g, ctx);
  assert(busy.includes('Mark as reviewed'));
});

// ---------------------------------------------------------------------------
// 4. Home rows (board O5b): claim_review, block_review, unmapped_ranks

const ITEMS = () => [
  { id: 'unmapped_ranks', kind: 'unmapped_ranks', severity: 'action', teamId: null, teamName: null, count: 2, ranks: [3, 9], characters: 6, link: { name: 'settings', tab: 'battlenet' } },
  { id: 'block_review', kind: 'block_review', severity: 'action', teamId: null, teamName: null, count: 3, pending: 2, held: 1, link: { name: 'users', segment: 'blocked' } },
  { id: 'claim_review', kind: 'claim_review', severity: 'action', teamId: null, teamName: null, claimedAt: Date.UTC(2026, 9, 29, 16), link: { name: 'settings', tab: 'claimreview' } },
];
const desk = (out) => out.slice(out.indexOf('class="gs-hd-desk"'), out.indexOf('class="gs-hd-phone"'));
const phoneHalf = (out) => out.slice(out.indexOf('class="gs-hd-phone"'));

check('Home: claim_review (Review), block_review (to the Users page) and unmapped_ranks (Open ranks, to Settings > Battle.net) are rows in the Guild panel and on the phone', () => {
  resetBrowser();
  const g = ownerGuild();
  const out = home(g, attn({ items: ITEMS(), total: 3 }), { previousOwner: 'Brandon' });
  for (const half of [desk(out), phoneHalf(out)]) {
    const t = text(half);
    assert(t.includes('2 in-game ranks are not mapped yet: 6 characters count as Social'), t);
    assert(t.includes('2 blocks that matched an earlier block wait for review, and 1 person who matched an earlier block was held back'), t);
    assert(t.includes('Review what Brandon set up'), t);
    assert(half.includes('aria-label="Open ranks (2 in-game ranks are not mapped yet: 6 characters count as Social)"') && half.includes('href="#/g/g1/settings/battlenet"'));
    assert(half.includes('href="#/g/g1/settings/claimreview"') && half.includes('aria-label="Review (Review what Brandon set up)"'));
    assert(half.includes('href="#/g/g1/users/blocked"'), 'block_review follows the Worker link: the Blocked list of Users');
  }
  // The name is read once; without it the row says "the previous Owner".
  assert(text(desk(home(g, attn({ items: ITEMS(), total: 3 })))).includes('Review what the previous Owner set up'));
  // A link is followed as it comes; the retired Accounts address still lands on Users.
  const moved = ITEMS();
  moved[1].link = { name: 'settings', tab: 'people' };
  assert(desk(home(g, attn({ items: moved, total: 3 }))).includes('href="#/g/g1/users"'));
  // An address from anything else falls back to the Roster (as every kind).
  moved[1].link = { name: 'nowhere' };
  assert(desk(home(g, attn({ items: moved, total: 3 }))).includes('href="#/g/g1/roster"'));
  // One singular line each.
  const one = [{ ...ITEMS()[0], count: 1, ranks: [3], characters: 1 }, { ...ITEMS()[1], count: 1, pending: 1, held: 0 }, { ...ITEMS()[1], id: 'x', count: 1, pending: 0, held: 2 }];
  const t = text(desk(home(g, attn({ items: one, total: 3 }))));
  assert(t.includes('1 in-game rank is not mapped yet: 1 character counts as Social') && t.includes('1 block that matched an earlier block waits for review') && t.includes('2 people who matched an earlier block were held back'), t);
  // The order is the Worker's (ATTENTION_KINDS): ranks, blocks, then the claim.
  const order = ['in-game ranks are not mapped', 'blocks that matched', 'Review what'].map((s) => text(desk(out)).indexOf(s));
  assert(order[0] < order[1] && order[1] < order[2], order.join());
});

check('Home: only claim_review can be hidden (More -> Hide); block_review and unmapped_ranks have no menu', () => {
  resetBrowser();
  const g = ownerGuild();
  const out = desk(home(g, attn({ items: ITEMS(), total: 3 })));
  assert((out.match(/data-action="home-hide"/g) || []).length === 1 && out.includes('data-action="home-hide" data-item="claim_review"'), 'one Hide');
  assert(!out.includes('data-item="block_review"') && !out.includes('data-item="unmapped_ranks"'));
  assert(text(out).includes('Hide') && out.includes('The Owner review page closes too'));
  assert(!out.includes('Hide for all officers'), 'the label is Hide');
});

check('Home: hiding claim_review reads the list again and closes the Owner review tab; Hidden lists it with Restore, which opens the tab again', async () => {
  resetBrowser();
  const g = ownerGuild();
  S.guilds = { g1: g };
  S.currentGid = 'g1';
  S.me = { user: { id: 'u9' }, guilds: [{ id: 'g1', name: 'Vindicated' }] };
  S.att.attention = { gid: 'g1', data: attn({ items: ITEMS(), total: 3 }), refreshing: false, error: '' };
  const hiddenEntry = { item: ITEMS()[2], mode: 'dismiss', until: null, by: { name: 'Kaelen' }, at: Date.UTC(2026, 9, 29, 17) };
  const after = attn({ items: ITEMS().slice(0, 2), total: 2, hidden: [hiddenEntry] });
  let calls = scriptApi({ 'POST /api/guild/g1/attention/dismissals': () => ({ ok: true }), 'GET /api/guild/g1/attention': () => after });
  await G.handlers.click['home-hide'](el({ 'data-item': 'claim_review' }));
  assert.deepEqual(calls.filter((c) => !c.path.endsWith('/claim-review')).map((c) => [c.method, c.path, c.body]), [['POST', '/api/guild/g1/attention/dismissals', { itemId: 'claim_review' }], ['GET', '/api/guild/g1/attention', undefined]]);
  assert.equal(g.owner.reviewOpen, false, 'the tab follows the item');
  S.att.attention.hiddenOpen = true;
  S.att.attention.toast = null;
  const out = desk(G.pages.attention.main({}, g, {}));
  assert(!text(out).includes('Review what the previous Owner set up') || text(out).includes('Hidden by Kaelen'), 'in the Hidden list, not the to-dos');
  assert(out.includes('data-action="home-restore" data-item="claim_review"') && out.includes('aria-label="Restore Review what the previous Owner set up"'), out.slice(out.indexOf('Hidden')));
  calls = scriptApi({ 'DELETE /api/guild/g1/attention/dismissals/claim_review': () => ({ ok: true }), 'GET /api/guild/g1/attention': () => attn({ items: ITEMS(), total: 3 }) });
  await G.handlers.click['home-restore'](el({ 'data-item': 'claim_review' }));
  assert.deepEqual(calls.filter((c) => !c.path.endsWith('/claim-review')).map((c) => [c.method, c.path]), [['DELETE', '/api/guild/g1/attention/dismissals/claim_review'], ['GET', '/api/guild/g1/attention']]);
  assert.equal(g.owner.reviewOpen, true, 'restored: the tab is back');
  // Somebody who is not the Owner has no flag to move.
  const plainGd = gd();
  S.guilds = { g1: plainGd };
  S.att.attention = { gid: 'g1', data: attn(), refreshing: false, error: '' };
  scriptApi({ 'POST /api/guild/g1/attention/dismissals': () => ({ ok: true }), 'GET /api/guild/g1/attention': () => attn({ items: ITEMS().slice(0, 2) }) });
  await G.handlers.click['home-hide'](el({ 'data-item': 'claim_review' }));
  assert(!('reviewOpen' in plainGd.owner));
});

check('Home: load reads the previous Owner\'s name once, only while the claim_review item (or its Hidden twin) exists, and a failed read says "the previous Owner"', async () => {
  resetBrowser();
  const g = ownerGuild();
  S.guilds = { g1: g };
  S.currentGid = 'g1';
  S.teamByGuild = { g1: 't1' };
  G.app.setAttention = () => {};
  let calls = scriptApi({ 'GET /api/guild/g1/attention': () => attn({ items: ITEMS(), total: 3 }), 'GET /api/guild/g1/claim-review': () => REVIEW() });
  await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, g);
  assert.deepEqual(calls.map((c) => c.path), ['/api/guild/g1/attention', '/api/guild/g1/claim-review']);
  assert(text(G.pages.attention.main({}, g, {})).includes('Review what Brandon set up'));
  // Nothing to review: no second read.
  calls = scriptApi({ 'GET /api/guild/g1/attention': () => attn({ items: ITEMS().slice(0, 2) }) });
  await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, g);
  assert.deepEqual(calls.map((c) => c.path), ['/api/guild/g1/attention']);
  // A failed read.
  calls = scriptApi({ 'GET /api/guild/g1/attention': () => attn({ items: ITEMS(), total: 3 }), 'GET /api/guild/g1/claim-review': () => { throw apiError(403, { error: 'forbidden' }); } });
  await G.pages.attention.load({ name: 'section', gid: 'g1', section: 'home' }, g);
  assert(text(G.pages.attention.main({}, g, {})).includes('Review what the previous Owner set up'));
  // The kinds the page knows are the Worker's, in its order (guild-wave4-ui-tests pins the same).
  const ids = G.pages.attention.KINDS.map((k) => k.id);
  assert(ids.indexOf('unmapped_ranks') < ids.indexOf('block_review') && ids.indexOf('block_review') < ids.indexOf('claim_review') && ids.indexOf('claim_review') < ids.indexOf('trial'));
  assert(G.pages.attention.KINDS.filter((k) => ['unmapped_ranks', 'block_review', 'claim_review'].includes(k.id)).every((k) => k.severity === 'action'));
});

check('Home: the setup hint for officers opens the Users page', () => {
  resetBrowser();
  const onboarding = { steps: [{ id: 'teams', done: true }, { id: 'roster', done: true }, { id: 'attendance', done: true }, { id: 'raid', done: false }, { id: 'officers', done: false }, { id: 'loot', done: false }], done: 3, total: 6 };
  const out = home(ownerGuild(), attn({ onboarding }));
  assert(out.includes('href="#/g/g1/users"') && !out.includes('href="#/g/g1/settings/people"'), 'Invite your officers -> Users');
});

// ---------------------------------------------------------------------------
// 5. The Account page: where a suspended Owner's seat goes

check('Account page: a suspended Owner is told who gets the seat (or that it waits for the Guild Master) instead of the hand-over sentence', () => {
  resetBrowser();
  const impact = { handOverFirst: [], guildsDeleted: [], autoPromote: [], succession: [
    { guild: { id: 'g1', name: 'Vindicated' }, to: { userId: 'u9', name: 'Kaelen' }, rule: 'ingame_gm' },
    { guild: { id: 'g2', name: 'Ravens' }, to: { userId: 'u4', name: 'Mendra' }, rule: 'manual_officer' },
    { guild: { id: 'g3', name: 'Owls' }, to: null, rule: 'vacant' },
  ] };
  const out = G.pages.privacy.deleteBoxHtml(impact, '');
  assert(out.includes('id="delete-succession"') && !out.includes('delete-blocked'), 'not blocked: the delete goes on');
  const t = text(out);
  assert(tight(t).includes('Your Owner seat in Vindicated passes to Kaelen (the Guild Master in game).'), t);
  assert(tight(t).includes('Your Owner seat in Ravens passes to Mendra (the longest-standing Officer).'));
  assert(tight(t).includes('Your Owner seat in Owls stays vacant until the Guild Master claims it.'));
  assert(out.includes('id="delete-confirm"') && out.indexOf('delete-succession') > out.indexOf('id="delete-confirm"'), 'inside the confirm, with the other consequences');
  assert(!/id="delete-succession"/.test(G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [], autoPromote: [] }, '')), 'nothing without succession');
  // Hostile names are escaped.
  const hostile = G.pages.privacy.deleteBoxHtml({ succession: [{ guild: { id: 'g1', name: '<b>x</b>' }, to: { userId: 'u', name: '<i>y</i>' }, rule: 'officer' }] }, '');
  assert(!hostile.includes('<b>x') && !hostile.includes('<i>y') && hostile.includes('&lt;b&gt;x'));
  // A live Owner still has to hand over first, and the sentence names Users and the Owner seat.
  const blocked = G.pages.privacy.deleteBoxHtml({ handOverFirst: [{ id: 'g1', name: 'Vindicated' }], guildsDeleted: [] }, '');
  assert(tight(text(blocked)).includes('You hold the Owner seat of Vindicated, and other people have joined. Hand over first: open Users, choose another person, then Edit permission and the Owner seat. Then you can delete your data.'), text(blocked));
  assert(blocked.includes('href="#/g/g1/users"') && !blocked.includes('settings/people') && !blocked.includes('Accounts') && !blocked.includes('Make Guild Master'));
});

// ---------------------------------------------------------------------------
// 6. CSS: only the lane's block, the phone rules

check('guild.css: the Owner block holds the styles, phone targets are 44 px and nothing sits outside the markers', () => {
  const css = read('guild.css');
  const start = css.indexOf('/* == B8a Owner (lane owner) == */');
  const end = css.indexOf('/* == end B8a Owner == */');
  assert(start > 0 && end > start);
  const block = css.slice(start, end);
  for (const cls of ['.gs-ow-strip', '.gs-ow-offer', '.gs-ow-what', '.gs-ow-review', '.gs-ow-grid', '.gs-ow-facts', '.gs-ow-done']) assert(block.includes(cls), cls);
  assert(!block.includes('@media (max-width: 600px)'), 'the framework sweep reads the last plain 600 px block of guild.css as the phone rules: the lane\'s block says "screen and"');
  const phone = block.slice(block.indexOf('@media screen and (max-width: 600px)'));
  assert(/\.gs-ow-offer \.gs-banner-actions \.gs-btn[^{]*\{[^}]*min-height: 44px/.test(phone), 'the banner button is 44 px');
  assert(/\.gs-ow-done \.gs-btn \{[^}]*min-height: 48px/.test(phone) && phone.includes('.gs-settings-page.gs-forge .gs-ow-done .gs-btn'), 'the primary is 48 px, above the settings page\'s 44 px rule');
  assert(/\.gs-ow-fact \.gs-btn[^{]*\{[^}]*min-height: 44px/.test(phone));
  // Every class the lane's pages use is defined (a selector in the block) or an existing one.
  const used = new Set();
  for (const file of ['js/guild/pages-settings-claimreview.js', 'js/guild/shell.js']) for (const m of read(file).matchAll(/gs-ow-[a-z-]+/g)) used.add(m[0]);
  for (const m of read('js/guild/pages-attention.js').matchAll(/gs-ow-[a-z-]+/g)) used.add(m[0]);
  for (const cls of used) assert(block.includes(`.${cls}`) || css.includes(`.${cls}`), `${cls} is styled`);
  assert(css.trimEnd().endsWith('/* == end B8a Owner == */') || css.includes('/* == end B8a Owner == */'));
});

// ---------------------------------------------------------------------------
// 7. The Worker: the bearer link and one real pass

const apiPath = (path, gid) => path.replace(`/api/guild/${gid}`, '');

check('worker: claim-review names the Links and keys page for the keys, links and join links', async () => {
  const s = await claimWorld();
  await claim(s, 'igm');
  const review = await s.ok('igm', 'GET', '/claim-review');
  assert.deepEqual(plain(review.bearer), { name: 'settings', tab: 'links', apiKeys: 0, guestLinks: 0, joinLinks: 0, webhooks: 0 });
  assert(read('worker/routes/claim-review.js').includes("tab: 'links'") && !/tab: 'dataaccess'/.test(read('worker/routes/claim-review.js')));
  // The address that tab opens is a settings tab the router knows.
  assert(G.router.TABS.includes('links') && G.router.TABS.includes('notifications') && G.router.TABS.includes('claimreview'));
  assert.equal(G.router.format({ name: 'settings', gid: s.gid, tab: review.bearer.tab }), `#/g/${s.gid}/settings/links`);
});

check('real pass: a suspended Owner, the in-game Guild Master is offered the seat, claims it, reviews what was left and marks it reviewed', async () => {
  const s = await claimWorld({ ownerLive: false });
  const gid = s.gid;
  // The Guild Master signs in with Battle.net first: the match binds the rank 0 character, so they are a member and a Guild Master from the rank.
  await signInAgain(s, 'igm');
  const before = await s.ok('igm', 'GET', '');
  assert.equal(before.owner.you, false);
  assert.equal(before.owner.suspended, true, 'the seat holder has no live proof');
  assert(before.me.roles.some((r) => r.role === 'guild_master' && r.fromRank === true), JSON.stringify(before.me.roles));
  // The browser half runs on the Worker's own answers.
  resetBrowser(`#/g/${gid}/home`);
  const toWorker = (method) => (p, body) => s.w.call(s.jars.igm, method, p, body).then((res) => {
    if (res.status >= 200 && res.status < 300) return res.json;
    throw new G.api.ApiError(res.status, res.json || {});
  });
  G.api.get = toWorker('GET');
  G.api.post = toWorker('POST');
  G.api.del = toWorker('DELETE');
  const guild = before;
  guild.guild.timeZone = guild.guild.timeZone || 'America/New_York';
  S.guilds = { [gid]: guild };
  S.currentGid = gid;
  S.me = { user: { id: s.uids.igm }, ...BOTH };
  G.app.setAttention = () => {};
  // O1: the offer names the seat holder and says suspended.
  const holder = before.owner.name;
  const offer = text(G.pages.attention.claimOfferHtml(guild));
  assert(offer.includes(`You are the Guild Master in game. ${holder} holds the Owner seat and is suspended.`), offer);
  // O2: the dialog, then the sign-in step whose start the Worker accepts (the claim runs at the callback).
  const opened = [];
  G.ui.openDialog = (html) => { opened.push(html); return null; };
  G.handlers.click['claim-open'](el({}));
  assert(text(opened[0]).includes(`You take the seat from ${holder}`));
  const { dlg, form } = fakeDialog(opened[0]);
  G.handlers.submit['claim-confirm'](form);
  field('dlg-error');
  G.handlers.submit['fresh-step-form']({ closest: (sel) => (sel === 'dialog' ? dlg : null), querySelector: () => null, querySelectorAll: () => [] });
  await until(() => navigations.length > 0 || fields['dlg-error'].textContent);
  assert(navigations.length === 1 && /^https?:\/\//.test(navigations[0]), `the browser was sent to Battle.net: ${navigations} ${fields['dlg-error'].textContent}`);
  const state = new URL(navigations[0]).searchParams.get('state');
  // The provider answers and the callback runs the claim (the same path tests/guild-claim.js drives).
  s.bnet.state.account = ACCOUNT.igm;
  const callback = await s.w.req('GET', `/auth/bnet/callback?code=abc&state=${encodeURIComponent(state)}`, { jar: s.jars.igm });
  assert.equal(callback.headers.get('Location'), '/#/fresh?done=gm_claim');
  // The guild payload now says Owner, with a review open; the offer is gone.
  const after = await s.ok('igm', 'GET', '');
  assert.deepEqual([after.owner.you, after.owner.suspended, after.owner.reviewOpen], [true, false, true]);
  S.guilds[gid] = after;
  assert.equal(G.pages.attention.claimOfferHtml(after), '', 'no more offer');
  assert(G.shell.settingsTabs(after.me.can, after.me.roles, after.owner).some((tab) => tab.tab === 'claimreview'), 'the Owner review is in the settings list');
  // O5b: Home carries the item with the previous Owner's name.
  await G.pages.attention.load({ name: 'section', gid, section: 'home' }, after);
  const homeText = text(desk(G.pages.attention.main({}, after, {})));
  assert(homeText.includes(`Review what ${holder} set up`), homeText);
  // O5: the review page from the Worker's own payload.
  await G.pages.settingsClaimReview.load({ name: 'settings', gid, tab: 'claimreview' }, after);
  const ctx = { guildData: after, route: { name: 'settings', gid, tab: 'claimreview' }, me: S.me, section: 'guild' };
  const page = G.pages.settingsClaimReview.main({}, after, ctx);
  const t = text(page);
  assert(t.includes('took the Owner seat on') && t.includes(`${holder} held it before and was suspended.`), t.slice(0, 400));
  assert(page.includes(`href="#/g/${gid}/settings/links"`), 'the keys line opens Links and keys');
  // Mark as reviewed: the Worker dismisses the item; the flag and the Home row are gone.
  await G.handlers.click['claimreview-done'](el({}));
  assert.deepEqual(goes, [[G.router.format({ name: 'section', gid, section: 'home' }), false]]);
  assert.equal(after.owner.reviewOpen, false);
  assert.equal((await s.ok('igm', 'GET', '')).owner.reviewOpen, false, 'the Worker agrees');
  assert(!(await s.ok('igm', 'GET', '/attention')).items.some((item) => item.kind === 'claim_review'));
  // Hidden -> Restore through the page brings it back on both sides.
  await G.pages.attention.load({ name: 'section', gid, section: 'home' }, after);
  S.att.attention.hiddenOpen = true;
  assert(desk(G.pages.attention.main({}, after, {})).includes('data-action="home-restore" data-item="claim_review"'));
  await G.handlers.click['home-restore'](el({ 'data-item': 'claim_review' }));
  assert.equal(after.owner.reviewOpen, true);
  assert.equal((await s.ok('igm', 'GET', '')).owner.reviewOpen, true);
  // The previous Owner, still holding nothing, sees none of it.
  const previous = await s.ok('gm', 'GET', '');
  assert.equal(previous.owner.you, false);
  assert(!('reviewOpen' in previous.owner));
  void apiPath;
});

runChecks(checks);
