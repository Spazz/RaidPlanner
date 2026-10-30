/**
 * Raidsmith guild UI - lane B3 minimal UI, RAIDS AND GUESTS (canvas "Teams and open raids (B3), round 2", boards 5, 6a, 6b, 6c, 8b)
 * Run: node tests/guild/guild-b3ui-raids-ui-tests.js
 *
 *   - New raid and Raid settings: "Open to guests" and the optional guest limit (shown once the check is ticked, empty = no limit), wired to guestsOpen / guestLimit;
 *   - the open-raid sign-up page (#/open/<gid>/<rid>): a Battle.net pick in an in-game guild, Connect Battle.net when the account has none, typed fields everywhere else,
 *     "N spots left" only when the Worker sends a number, the done state with Withdraw my sign-up (no confirm), the member and signed-out states, the way back;
 *   - the public page's Sign up link on open upcoming raids.
 * Same approach as guild-wave8-ui-tests.js: the shared script list in a vm, no DOM; handlers run against a stubbed G.api and a fake document. The Worker half is
 * guild-b3ui-open-ingame-tests.js; guild-b3ui-raids-contract-tests.js runs these pages against the real Worker.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('node:url');

let passed = 0, failed = 0;
const queue = [];
function check(name, fn) { queue.push({ name, fn }); }
async function run() {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('../guild-scripts');
const css = read('guild.css');

const ctx = (() => {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
})();
let els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}
const ascii = out => assert(!/[^\x00-\x7f]/.test(text(out)), 'ASCII only: ' + (text(out).match(/[^\x00-\x7f]/) || [''])[0]);
const okRes = body => Promise.resolve(body);
const rejectWith = (status, body) => Promise.reject(new G.api.ApiError(status, body));
const fakeEl = (id, over) => { const e = Object.assign({ id, value: '', textContent: '', innerHTML: '', hidden: false, focused: 0, attrs: {}, focus() { e.focused++; }, setAttribute(k, v) { e.attrs[k] = v; }, removeAttribute(k) { delete e.attrs[k]; } }, over || {}); els[id] = e; return e; };
const control = value => ({ value, focused: 0, focus() { this.focused++; } });

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, join: S.join };
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.join = null;
    els = {};
    const savedRender = G.app.render, savedGo = G.app.go, savedTeamFor = G.app.teamFor;
    const probe = { renders: 0, gone: [] };
    G.app.render = () => { probe.renders++; };
    G.app.go = (hash, replace) => { probe.gone.push([hash, !!replace]); };
    try { await fn(S, probe); } finally {
      Object.assign(S, saved);
      G.app.render = savedRender; G.app.go = savedGo; G.app.teamFor = savedTeamFor; els = {};
    }
  };
}

const TEAMS = [{ id: 't1', name: 'Team KJ', size: 25, archived: false, players: 3, leads: [] }, { id: 't2', name: 'Sunday Alts', size: 25, archived: false, players: 1, leads: [] }];
const OFFICER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'guild.teams': 'guild' };
const gd = () => ({
  guild: { id: 'g1', name: 'Vindicated', realm: 'Dreamscythe', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', createdAt: 1 },
  teams: TEAMS.map(t => Object.assign({}, t)), me: { roles: [], can: OFFICER_CAN }, attendanceFlags: {},
});

// ═══ Routes and API ═════════════════════════════════════════════════
check('router: #/open/<gid>/<rid> is the join page in its open-raid form; the token form is untouched; bad ids are not found', () => {
  const route = { name: 'join', open: true, gid: 'g_abc', rid: 'r_def' };
  assert.deepEqual(plain(G.router.parse('#/open/g_abc/r_def')), route);
  assert.equal(G.router.format(route), '#/open/g_abc/r_def');
  assert.equal(G.router.isViewerRoute(route), true, 'the shell draws it like the join page: no guild rail');
  assert.deepEqual(plain(G.router.parse('#/open/g_abc')), { name: 'notfound' });
  assert.deepEqual(plain(G.router.parse('#/open/g_abc/r_def/x')), { name: 'notfound' });
  assert.deepEqual(plain(G.router.parse('#/open/g%20abc/r_def')), { name: 'notfound' });
  assert.equal(G.router.format({ name: 'join', open: true, gid: 'bad id', rid: 'r' }), '#/');
  const token = 'A'.repeat(43);
  assert.deepEqual(plain(G.router.parse('#/join/' + token)), { name: 'join', token });
  assert.equal(G.router.format({ name: 'join', token }), '#/join/' + token);
  assert.deepEqual(plain(G.router.parse(G.router.format(route))), route, 'format and parse round trip');
});

check('api: the open-raid calls hit /api/open/:gid/raids/:rid with the contract bodies', async () => {
  const s = stub(() => okRes({}));
  await G.api.openRaid.view('g1', 'r1');
  await G.api.openRaid.submit('g1', 'r1', { character: { name: 'Corvane', realmSlug: 'dreamscythe' }, spec: 'Combat', website: '' });
  await G.api.openRaid.withdraw('g1', 'r1');
  s.restore();
  assert.deepEqual(plain(s.calls), [
    { m: 'get', url: '/api/open/g1/raids/r1' },
    { m: 'post', url: '/api/open/g1/raids/r1', body: { character: { name: 'Corvane', realmSlug: 'dreamscythe' }, spec: 'Combat', website: '' } },
    { m: 'del', url: '/api/open/g1/raids/r1', body: {} },
  ]);
});

// ═══ New raid and Raid settings ═════════════════════════════════════
const NR_FORM = over => Object.assign({ teamId: 't2', event: '', reports: [''], date: '2026-11-01', time: '19:00', zones: ['Serpentshrine Cavern'], title: '', size: '', guestsOpen: false, guestLimit: '' }, over || {});
const nrHtml = form => G.pages.raidNew.raidNewHtml({ guildData: gd(), state: { gid: 'g1', form, run: null, error: '' }, today: '2026-10-26' });

check('New raid: Open to guests is an unticked check with its one-line help; the guest limit field is there but hidden until the check is ticked (board 5)', () => {
  const out = nrHtml(NR_FORM());
  assert(out.includes('<div class="gs-check"><input type="checkbox" id="nr-guests" name="guestsOpen" aria-describedby="nr-guests-help" data-change="guests-open"><label for="nr-guests">Open to guests</label></div>'), 'an unticked check');
  assert(out.includes('<p class="gs-fine" id="nr-guests-help">Anyone signed in can sign up as a guest. No link needed.</p>'));
  assert(/id="nr-guests-limit-field" hidden>/.test(out), 'no limit field until ticked');
  assert(out.includes('<label class="gs-label" for="nr-guests-limit">Guest limit (optional)</label>') && out.includes('placeholder="No limit"') && out.includes('inputmode="numeric"') && out.includes('min="1"'));
  assert(out.includes('id="nr-guests-limit-help">Leave empty for no limit. With a limit, the sign-up page shows how many spots are left.</p>'));
  assert(out.includes('id="nr-guests-limit-err" role="alert" hidden'));
  assert(out.indexOf('id="nr-size"') < out.indexOf('id="nr-guests"') && out.indexOf('id="nr-guests"') < out.indexOf('id="nr-reports"'), 'under Raid size, above the reports');
  const ticked = nrHtml(NR_FORM({ guestsOpen: true, guestLimit: '10' }));
  assert(ticked.includes('id="nr-guests" name="guestsOpen" checked') && /id="nr-guests-limit-field">/.test(ticked) && ticked.includes('value="10"'), 'ticked: the field shows with the limit');
  assert(nrHtml(NR_FORM({ date: '2026-10-10' })).includes('id="nr-guests"'), 'whatever the date');
  assertNoRawAttrs(out); ascii(out);
});

check('New raid: the create body sends guestsOpen (and the limit) only when the check is ticked; an empty limit means none', () => {
  const body = f => plain(G.pages.raidNew.createBody(NR_FORM(f), false, '2026-10-26'));
  assert(!('guestsOpen' in body({})) && !('guestLimit' in body({})), 'off: neither key');
  assert(!('guestLimit' in body({ guestLimit: '5' })), 'a limit typed and then the check unticked is not sent');
  assert.deepEqual([body({ guestsOpen: true }).guestsOpen, 'guestLimit' in body({ guestsOpen: true })], [true, false]);
  assert.deepEqual([body({ guestsOpen: true, guestLimit: ' 12 ' }).guestsOpen, body({ guestsOpen: true, guestLimit: ' 12 ' }).guestLimit], [true, 12]);
  assert.equal(typeof body({ guestsOpen: true, guestLimit: '3' }).guestLimit, 'number');
  const P = G.pages.raidNew.guestLimitProblem;
  assert.deepEqual(['', ' ', null, '1', '100', '42'].map(P), ['', '', '', '', '', '']);
  for (const bad of ['0', '101', '-3', '2.5', 'ten', '1e2', '1000']) assert.match(P(bad), /^Enter a whole number from 1 to 100, or leave it empty for no limit\.$/, bad);
});

check('New raid: the check shows or hides the limit field in place and the form reads both; a bad limit stops the create with a message at the field; a good one is posted', withState(async (S) => {
  S.guilds.g1 = gd(); S.currentGid = 'g1';
  G.app.teamFor = () => 't2';
  G.pages.raidNew.load({ name: 'raidnew' }, S.guilds.g1);
  assert.deepEqual([S.att.nr.form.guestsOpen, S.att.nr.form.guestLimit], [false, ''], 'a fresh form: closed, no limit');
  const field = fakeEl('nr-guests-limit-field', { hidden: true });
  const input = fakeEl('nr-guests-limit', { value: '' });
  const box = fakeEl('nr-guests', { checked: true });
  G.handlers.change['guests-open'](box);
  assert.equal(field.hidden, false);
  assert.equal(input.focused, 1, 'focus goes to the limit');
  assert.equal(S.att.nr.form.guestsOpen, true, 'the form state follows the check');
  box.checked = false;
  G.handlers.change['guests-open'](box);
  assert.equal(field.hidden, true);
  // Create with a bad limit: nothing is posted, the field says what to do.
  box.checked = true; input.value = '0';
  fakeEl('nr-date', { value: '2026-11-01' }); fakeEl('nr-team', { value: 't2' });
  const err = fakeEl('nr-guests-limit-err', { hidden: true });
  let s = stub(() => okRes({ raid: { id: 'r_new' } }));
  G.handlers.submit['nr-create-form']();
  await settle();
  assert.equal(s.calls.length, 0, 'nothing is posted');
  assert.equal(err.hidden, false);
  assert(err.innerHTML.includes('Enter a whole number from 1 to 100'), err.innerHTML);
  assert.equal(input.focused >= 2, true, 'focus goes to the field');
  s.restore();
  // A good limit is posted with the check.
  input.value = '12'; err.hidden = true;
  fakeEl('nr-time', { value: '19:00' });
  s = stub(() => okRes({ raid: { id: 'r_new' } }));
  G.handlers.submit['nr-create-form']();
  await settle();
  assert.equal(s.calls[0].url, '/api/guild/g1/raids');
  assert.equal(s.calls[0].body.guestsOpen, true);
  assert.equal(s.calls[0].body.guestLimit, 12);
  s.restore();
}));

const DETAIL = (rover) => ({
  raid: Object.assign({
    id: 'u1', team: { id: 't2', name: 'Sunday Alts' }, teamId: 't2', raidOn: '2026-11-01', startsAt: Date.UTC(2026, 10, 2, 0, 0), timeKnown: true, upcoming: true, title: null, zone: 'Serpentshrine Cavern',
    size: 25, sizeOverride: null, closesAt: Date.UTC(2026, 10, 1, 22, 0), closeHours: 2, closeHoursOverride: null, teamCloseHours: 2, signupsLocked: false, state: 'awaiting_log', openFlags: 0, stale: false, version: 1,
    guestsOpen: false, guestLimit: null,
  }, rover || {}),
  can: { edit: true, review: true, seeAttendance: true, seeNicknames: true }, sources: { event: null, reports: [], plan: null }, pulls: [], people: [], unmatched: [], signups: [],
});
const settingsHtml = rover => G.pages.raid.settingsDialogHtml(gd(), DETAIL(rover));

check('Raid settings: Open to guests and the guest limit sit under the deadline; ticked shows the stored limit; a started raid has neither (board 5)', () => {
  const off = settingsHtml();
  assert(off.includes('<input type="checkbox" id="rs-guests" name="guestsOpen" aria-describedby="rs-guests-help" data-change="guests-open"><label for="rs-guests">Open to guests</label>'));
  assert(/id="rs-guests-limit-field" hidden>/.test(off) && off.includes('name="guestLimit"'));
  assert(off.indexOf('id="rs-hours-mode"') < off.indexOf('id="rs-guests"') && off.indexOf('id="rs-guests-limit"') < off.indexOf('id="rs-error"'));
  const on = settingsHtml({ guestsOpen: true, guestLimit: 10 });
  assert(on.includes('id="rs-guests" name="guestsOpen" checked') && /id="rs-guests-limit-field">/.test(on) && on.includes('id="rs-guests-limit" name="guestLimit" aria-describedby="rs-guests-limit-help rs-guests-limit-err" min="1" max="100" step="1" inputmode="numeric" value="10"'));
  const noLimit = settingsHtml({ guestsOpen: true, guestLimit: null });
  assert(noLimit.includes('value="" placeholder="No limit"'), 'no limit: the field is empty');
  const started = settingsHtml({ upcoming: false, guestsOpen: true, guestLimit: 10 });
  assert(!started.includes('rs-guests') && started.includes('id="rs-size"'), 'guests sign up before the start only');
  assertNoRawAttrs(on); ascii(on);
});

check('Raid settings: Save sends only what changed - the check, the limit, both; an empty limit clears it; the limit follows the check; a bad limit stops at its field; a refusal of the limit shows there', withState(async (S) => {
  S.guilds.g1 = gd(); S.currentGid = 'g1';
  const open = rover => { S.att.raid = { gid: 'g1', rid: 'u1', data: DETAIL(rover), filter: null }; };
  const form = (checked, limit, size) => ({ elements: { size: control(size == null ? '' : size), guestsOpen: Object.assign(control(''), { checked }), guestLimit: control(limit) } });
  const slots = () => ['rs-err-size', 'rs-err-hours', 'rs-guests-limit-err', 'rs-error'].forEach(id => fakeEl(id, { hidden: true }));
  const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
  const patchBodies = s => s.calls.filter(c => c.m === 'patch').map(c => c.body);
  const answer = () => DETAIL({ guestsOpen: true, guestLimit: 10 });
  let s = stub((m) => okRes(m === 'patch' ? answer() : {}));
  // Ticking the check alone.
  open(); slots();
  G.handlers.submit['raid-settings-form'](form(true, ''));
  await settle();
  assert.deepEqual(patchBodies(s), [{ guestsOpen: true }]);
  // Ticking with a limit.
  s.calls.length = 0; open(); slots();
  G.handlers.submit['raid-settings-form'](form(true, ' 10 '));
  await settle();
  assert.deepEqual(patchBodies(s), [{ guestsOpen: true, guestLimit: 10 }]);
  // Open already with 10: changing only the limit, then clearing it (null = no limit).
  s.calls.length = 0; open({ guestsOpen: true, guestLimit: 10 }); slots();
  G.handlers.submit['raid-settings-form'](form(true, '15'));
  await settle();
  G.handlers.submit['raid-settings-form'](form(true, '10'));
  assert.deepEqual(patchBodies(s), [{ guestLimit: 15 }], 'an unchanged limit sends nothing: the second submit has nothing to save');
  assert.equal(els['rs-error'].hidden, false);
  s.calls.length = 0; open({ guestsOpen: true, guestLimit: 10 }); slots();
  G.handlers.submit['raid-settings-form'](form(true, ''));
  await settle();
  assert.deepEqual(patchBodies(s), [{ guestLimit: null }]);
  // Unticking: the check goes off and the stored limit is left alone, whatever the hidden box holds.
  s.calls.length = 0; open({ guestsOpen: true, guestLimit: 10 }); slots();
  G.handlers.submit['raid-settings-form'](form(false, '99'));
  await settle();
  assert.deepEqual(patchBodies(s), [{ guestsOpen: false }]);
  // Nothing changed: the dialog says so.
  s.calls.length = 0; open({ guestsOpen: true, guestLimit: 10 }); slots();
  G.handlers.submit['raid-settings-form'](form(true, '10'));
  assert.deepEqual(patchBodies(s), []);
  // A bad limit: no request, the message at the field, focus there.
  open(); slots();
  const bad = form(true, '500');
  G.handlers.submit['raid-settings-form'](bad);
  assert.deepEqual(patchBodies(s), []);
  assert.equal(els['rs-guests-limit-err'].hidden, false);
  assert(els['rs-guests-limit-err'].innerHTML.includes('Enter a whole number from 1 to 100'));
  assert.equal(bad.elements.guestLimit.focused, 1);
  // The Worker refuses the limit: it shows at the same field.
  slots();
  s.restore();
  s = stub(() => rejectWith(400, { error: 'bad_request', message: 'guestLimit is a whole number of guests from 1 to 100, or null for no limit.', field: 'guestLimit' }));
  const refused = form(true, '50');
  G.handlers.submit['raid-settings-form'](refused);
  await settle();
  assert.equal(els['rs-guests-limit-err'].hidden, false);
  assert(els['rs-guests-limit-err'].textContent.includes('guestLimit is a whole number'));
  assert.equal(refused.elements.guestLimit.focused, 1);
  s.restore();
  G.ui.setBusy = realBusy;
}));

// ═══ The open-raid sign-up page ═════════════════════════════════════
let OPTIONS = null;
const CHARACTERS = [
  { name: 'Corvane', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'ROGUE', level: 70 },
  { name: 'Nightbriar', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'WARLOCK', level: 70 },
  { name: 'Oakmender', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'DRUID', level: 64 },
];
const BNET = over => Object.assign({ mode: 'bnet', status: 'ok', battletag: 'Corvane#4821', characters: CHARACTERS.map(c => Object.assign({}, c)) }, over || {});
const OPEN_DATA = over => Object.assign({
  guild: { name: 'Vindicated', gameVersion: 'tbc', realmKind: 'realm', timeZone: 'America/New_York' },
  raid: { raidOn: '2026-11-01', startsAt: Date.UTC(2026, 10, 2, 0, 0), timeKnown: true, zone: 'Serpentshrine Cavern', title: null, teamName: 'Sunday Alts' },
  spotsLeft: 11, noteMax: 120, rosterOptions: OPTIONS, member: false, mine: null, signUp: BNET(),
}, over || {});
const OPEN_STATE = (over) => Object.assign({ open: true, gid: 'g1', rid: 'r1', status: 'ok', data: OPEN_DATA(), draft: {}, busy: false, error: '', notice: '' }, over || {});
const page = over => G.pages.openRaid.openHtml({ state: OPEN_STATE(over) });
const specsOf = out => { const m = /<select[^>]*id="jn-spec"[^>]*>([\s\S]*?)<\/select>/.exec(out); return m ? [...m[1].matchAll(/<option value="([^"]*)"/g)].map(o => o[1]) : null; };

check('open sign-up, Battle.net guild (6a): the account\'s characters as radio rows with class, level and realm, the first one picked, the BattleTag, Refresh from Battle.net, then Spec, note and the one primary', async () => {
  OPTIONS = (await import(pathToFileURL(path.join(ROOT, 'worker/roster-data.js')).href)).rosterOptions();
  const out = page();
  const t = text(out);
  assert(out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Sign up for Vindicated</h1>'));
  assert(t.includes('Serpentshrine Cavern - Sunday Alts - Sun Nov 1, 7:00 PM ET'), 'the raid\'s start in the guild\'s zone: ' + t);
  assert(t.includes('Vindicated opened this raid to guests. 11 spots left.'));
  assert(out.includes('class="gs-page gs-form-page gs-page-narrow gs-apply gs-open gs-forge"'));
  assert(out.includes('<ul class="gs-pick" id="jn-character" role="radiogroup" aria-required="true" tabindex="-1" aria-labelledby="jn-char-l"'));
  const rows = [...out.matchAll(/<label class="gs-pickrow( is-picked)?"><input type="radio" class="gs-pickradio" name="character" value="([^"]*)"( checked)?/g)];
  assert.deepEqual(rows.map(r => [r[2], !!r[1], !!r[3]]), [['dreamscythe|Corvane', true, true], ['dreamscythe|Nightbriar', false, false], ['dreamscythe|Oakmender', false, false]]);
  assert(out.includes('<span class="gs-char-name gs-class-rogue">Corvane</span><span class="gs-picksub">Rogue - Level 70 - Dreamscythe</span>'));
  assert(out.includes('<span class="gs-char-name gs-class-druid">Oakmender</span><span class="gs-picksub">Druid - Level 64 - Dreamscythe</span>'));
  assert(out.includes('src="/icons/classicon_rogue.jpg"') && out.includes('class="gs-spec-icon"'));
  assert(out.includes('<p class="gs-fine" id="jn-char-help">From your Battle.net, Corvane#4821.</p>'));
  assert(out.includes('<a class="gs-btn gs-btn-ghost gs-btn-sm" href="/auth/bnet/login?return=%23%2Fopen%2Fg1%2Fr1" data-key="bnet-refresh"><span>Refresh from Battle.net</span></a>'), 'the Refresh link comes back to this open raid');
  assert.deepEqual(specsOf(out), ['', 'Assassination', 'Combat', 'Subtlety'], 'the Spec select lists the picked character\'s class');
  assert(!out.includes('name="name"') && !out.includes('name="class"'), 'nothing is typed in an in-game guild');
  assert(out.includes('data-submit="open-form"') && out.includes('name="website"') && out.includes('class="gs-hp"'));
  assert(out.includes('<button type="submit" class="gs-btn gs-btn-molten" data-key="jn-submit"><span>Sign up as a guest</span></button>'));
  assert.equal((out.match(/gs-btn-molten/g) || []).length, 1, 'one primary');
  assert(out.indexOf('jn-char-l') < out.indexOf('id="jn-spec"') && out.indexOf('id="jn-spec"') < out.indexOf('id="jn-note"'));
  assertNoRawAttrs(out); ascii(out);
  // The draft's pick wins over the first row, and the specs follow it.
  const second = page({ draft: { pick: 'dreamscythe|Oakmender' } });
  assert(second.includes('value="dreamscythe|Oakmender" checked') && !second.includes('value="dreamscythe|Corvane" checked'));
  assert(specsOf(second).includes('Restoration') && !specsOf(second).includes('Combat'));
  // A hostile name is escaped.
  const hostile = page({ data: OPEN_DATA({ signUp: BNET({ characters: [Object.assign({}, CHARACTERS[0], { name: '"><b>x' })] }) }) });
  assert(hostile.includes('value="dreamscythe|&quot;&gt;&lt;b&gt;x"') && !hostile.includes('<b>x'));
});

check('open sign-up: "N spots left" only when the Worker sends a number (none = no limit, 1, and 0 = full with no form)', () => {
  for (const none of [null, undefined]) {
    const t = text(page({ data: OPEN_DATA({ spotsLeft: none }) }));
    assert(t.includes('Vindicated opened this raid to guests.') && !/spot/i.test(t), 'no limit: no spot count: ' + t);
  }
  assert(text(page({ data: OPEN_DATA({ spotsLeft: 1 }) })).includes('opened this raid to guests. 1 spot left.'));
  const full = page({ data: OPEN_DATA({ spotsLeft: 0 }) });
  assert(text(full).includes('No spots left.') && text(full).includes('No guest spots left') && !full.includes('data-submit="open-form"'), 'a full raid takes no form');
  assert.equal(G.pages.openRaid.spotsText(5), ' 5 spots left.');
  assert.equal(G.pages.openRaid.spotsText(null), '');
});

check('open sign-up, Battle.net states (6c / 8b): not connected is one Connect Battle.net empty state; an old list, a failed list and an empty list offer Refresh; no form in any of them', () => {
  const connect = page({ data: OPEN_DATA({ signUp: BNET({ status: 'not_linked', battletag: null, characters: [] }) }) });
  const t = text(connect);
  assert(connect.includes('<h2 class="gs-empty2-title">Connect Battle.net to sign up</h2>') && t.includes('Vindicated takes guests who have Battle.net connected. You pick your character from your list.'));
  assert(connect.includes('<a class="gs-btn gs-btn-molten" href="/auth/bnet/login?return=%23%2Fopen%2Fg1%2Fr1" data-key="bnet-connect">') && t.includes('Connect Battle.net'), 'the Connect link comes back to this open raid');
  assert.equal((connect.match(/gs-btn-molten/g) || []).length, 1, 'the one primary');
  assert(t.includes('Vindicated opened this raid to guests. 11 spots left.') && !connect.includes('data-submit="open-form"') && !connect.includes('gs-pickrow'));
  const refresh = status => page({ data: OPEN_DATA({ signUp: BNET({ status, characters: [] }) }) });
  for (const status of ['expired', 'needs_refresh']) {
    const out = refresh(status);
    assert(text(out).includes('Load your characters from Battle.net') && text(out).includes('Refresh from Battle.net') && out.includes('href="/auth/bnet/login?return=%23%2Fopen%2Fg1%2Fr1"') && !out.includes('data-submit="open-form"'), status);
  }
  assert(text(refresh('unavailable')).includes('Battle.net did not answer'));
  assert(text(page({ data: OPEN_DATA({ signUp: BNET({ status: 'ok', characters: [] }) }) })).includes('No characters found') && text(page({ data: OPEN_DATA({ signUp: BNET({ status: 'ok', characters: [] }) }) })).includes('Corvane#4821'));
  assert(text(refresh('unsupported')).includes('Battle.net has no characters for this game') && !refresh('unsupported').includes('href="/auth/bnet/login"'));
  for (const out of [connect, refresh('expired'), refresh('unavailable'), refresh('unsupported')]) { ascii(out); assertNoRawAttrs(out); }
});

check('open sign-up, any other guild (6c): the typed name, class, spec and note of the join link, with the class colouring the specs; no Battle.net anywhere', () => {
  const out = page({ data: OPEN_DATA({ guild: { name: 'Ashen Watch', gameVersion: 'tbc', realmKind: 'realm', timeZone: 'America/New_York' }, spotsLeft: null, signUp: { mode: 'typed' } }) });
  assert(text(out).includes('Ashen Watch opened this raid to guests.') && !/spot/i.test(text(out)));
  for (const name of ['name', 'class', 'spec', 'note', 'website']) assert(out.includes('name="' + name + '"'), name);
  assert(out.includes('data-submit="open-form"') && out.includes('data-change="join-class"') && text(out).includes('Your character\'s name, 2 to 12 letters.'));
  assert(!out.includes('/auth/bnet/login') && !out.includes('gs-pickrow') && !/Battle\.net/.test(text(out)));
  assert.equal((out.match(/gs-btn-molten/g) || []).length, 1);
  assert.deepEqual(specsOf(out), [''], 'no class yet: no specs');
  // An old Worker answer without signUp is the typed form.
  assert(page({ data: OPEN_DATA({ signUp: undefined }) }).includes('name="class"'));
  ascii(out); assertNoRawAttrs(out);
});

check('open sign-up, done (6c): the banner, "Signed up as <name>, Class - Spec", and Withdraw my sign-up as a secondary button without a confirm; after a withdrawal the form says so', () => {
  const mine = { name: 'Corvane', className: 'Rogue', specName: 'Combat', note: null, classId: 'ROGUE', spec: 'Combat' };
  const out = page({ data: OPEN_DATA({ mine }) });
  const t = text(out);
  assert(out.includes('<div class="gs-banner gs-banner-success" role="status" id="jn-done-h">') && t.includes('You are signed up'));
  assert(t.includes('The officers of Vindicated can see you for Sun Nov 1, 7:00 PM ET. You do not need to do anything else.'));
  assert(out.includes('<p class="gs-lead gs-lead-sm">Signed up as <span class="gs-char-name gs-class-rogue">Corvane</span>, Rogue - Combat.</p>'));
  assert(out.includes('<button type="button" class="gs-btn" data-action="open-withdraw" data-key="open-withdraw"><span>Withdraw my sign-up</span></button>'));
  assert(!out.includes('gs-btn-molten') && !out.includes('gs-dialog') && !out.includes('data-submit'), 'secondary, no dialog, no form');
  assert(!out.includes('dismiss'), 'the banner stays');
  const after = page({ notice: 'You are no longer signed up for this raid' });
  assert(text(after).includes('You are no longer signed up for this raid') && after.includes('data-submit="open-form"'));
  ascii(out); assertNoRawAttrs(out);
});

check('open sign-up: signed out asks to sign in (and says you come back); a member is sent to the raid page; not open, blocked and failed loads have their own words', () => {
  const signin = G.pages.openRaid.openHtml({ state: OPEN_STATE({ status: 'signin', data: null }) });
  assert(text(signin).includes('Sign in to sign up') && text(signin).includes('You come back to this page.') && signin.includes('href="#/signin"') && signin.includes('data-action="open-signin"'));
  assert.equal((signin.match(/gs-btn-molten/g) || []).length, 1);
  const member = page({ status: 'member', data: OPEN_DATA({ member: true }) });
  assert(text(member).includes('You are in Vindicated') && member.includes('href="#/g/g1/raids/r/r1"') && text(member).includes('Open the raid'));
  assert(text(G.pages.openRaid.openHtml({ state: OPEN_STATE({ status: 'gone', data: null }) })).includes('This raid is not open to guests'));
  assert(text(G.pages.openRaid.openHtml({ state: OPEN_STATE({ status: 'blocked', title: 'Access removed', message: 'An officer has removed your access to this guild.', data: null }) })).includes('Access removed'));
  const error = G.pages.openRaid.openHtml({ state: OPEN_STATE({ status: 'error', message: 'Boom', data: null }) });
  assert(text(error).includes('Could not open the sign-up') && error.includes('data-action="retry"'));
  assert(G.pages.openRaid.openHtml({ state: null }).includes('Loading') && G.pages.openRaid.openHtml({ state: OPEN_STATE({ status: 'loading', data: null }) }).includes('Loading'));
  for (const out of [signin, member, error]) ascii(out);
});

check('open sign-up load: GET once for the raid; 401 -> sign in (and the way back is remembered); 404 -> not open; 403 -> the page that says why; a member is sent on; the rest is an error with a retry', withState(async (S, probe) => {
  let answer = () => okRes(OPEN_DATA());
  const s = stub(() => answer());
  const ok = await G.pages.openRaid.load({ name: 'join', open: true, gid: 'g1', rid: 'r1' });
  assert.deepEqual(plain(s.calls), [{ m: 'get', url: '/api/open/g1/raids/r1' }]);
  assert.deepEqual([ok.status, S.join === ok, ok.open], ['ok', true, true]);
  answer = () => rejectWith(401, { error: 'signed_out', message: 'Sign in first.' });
  assert.equal((await G.pages.openRaid.load({ name: 'join', open: true, gid: 'g1', rid: 'r1' })).status, 'signin');
  answer = () => rejectWith(404, { error: 'not_found', message: 'That raid is not open to guests.' });
  const gone = await G.pages.openRaid.load({ name: 'join', open: true, gid: 'g1', rid: 'r1' });
  assert.deepEqual([gone.status, gone.message], ['gone', 'That raid is not open to guests.']);
  answer = () => rejectWith(403, { error: 'access_removed', message: 'An officer has removed your access to this guild.' });
  const blocked = await G.pages.openRaid.load({ name: 'join', open: true, gid: 'g1', rid: 'r1' });
  assert.deepEqual([blocked.status, blocked.title], ['blocked', 'Access removed']);
  answer = () => rejectWith(500, { error: 'server_error', message: 'Boom' });
  assert.equal((await G.pages.openRaid.load({ name: 'join', open: true, gid: 'g1', rid: 'r1' })).status, 'error');
  answer = () => okRes(OPEN_DATA({ member: true }));
  const member = await G.pages.openRaid.load({ name: 'join', open: true, gid: 'g1', rid: 'r1' });
  assert.equal(member.status, 'member');
  assert.deepEqual(probe.gone, [['#/g/g1/raids/r/r1', true]], 'a member goes to the raid page, replacing this address so Back does not bounce');
  s.restore();
}));

check('open sign-up submit, Battle.net guild: a character and a spec are required; the body carries the picked character (name + realm), never typed fields; a refusal shows at the list; success reads the page again', withState(async (S, probe) => {
  const x = S.join = OPEN_STATE();
  const radio = value => ({ value, checked: true });
  const form = (values) => {
    const f = { elements: { spec: control(values.spec || ''), note: control(values.note || ''), website: control(values.website || '') },
      querySelector: sel => (sel === 'input[name="character"]:checked' ? (values.pick ? radio(values.pick) : null) : null), querySelectorAll: () => [] };
    return f;
  };
  const charErr = fakeEl('jn-character-err', { hidden: true });
  const specErr = fakeEl('jn-spec-err', { hidden: true });
  fakeEl('jn-character', {});
  fakeEl('jn-error', { hidden: true });
  const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
  // Nothing picked / no spec.
  G.handlers.submit['open-form'](form({ spec: 'Combat' }));
  assert.equal(charErr.hidden, false);
  assert(charErr.innerHTML.includes('Choose your character.'));
  charErr.hidden = true;
  G.handlers.submit['open-form'](form({ pick: 'dreamscythe|Corvane' }));
  assert.equal(specErr.hidden, false);
  assert(specErr.innerHTML.includes('Choose a spec.'));
  specErr.hidden = true;
  // A refusal that names the name is the picked character; the page is not changed.
  let answer = () => rejectWith(409, { error: 'on_roster', message: 'That character is on the guild\'s roster. Sign in with the account that has it.', field: 'name' });
  const s = stub((m, url) => (m === 'post' ? answer() : okRes(OPEN_DATA({ mine: { name: 'Corvane', className: 'Rogue', classId: 'ROGUE', spec: 'Combat' }, spotsLeft: 10 }))));
  G.handlers.submit['open-form'](form({ pick: 'dreamscythe|Corvane', spec: 'Combat', note: ' hi ' }));
  await settle();
  assert.deepEqual(plain(s.calls[0]), { m: 'post', url: '/api/open/g1/raids/r1', body: { spec: 'Combat', website: '', character: { name: 'Corvane', realmSlug: 'dreamscythe' }, note: 'hi' } });
  assert.equal(charErr.hidden, false);
  assert(charErr.innerHTML.includes('Sign in with the account that has it.'));
  assert.equal(x.data.mine, null);
  // Success: the view is read again and shows the done state.
  charErr.hidden = true;
  answer = () => okRes({ ok: true, spotsLeft: 10 });
  G.handlers.submit['open-form'](form({ pick: 'dreamscythe|Corvane', spec: 'Combat' }));
  await settle();
  assert.equal(s.calls.filter(c => c.m === 'post').length, 2);
  assert.equal(s.calls[s.calls.length - 1].m, 'get');
  assert.equal(x.data.mine.name, 'Corvane');
  assert(probe.renders >= 1);
  // The page was out of date (already signed up / full / not connected): it is read again, whatever was typed.
  for (const code of ['already_signed_up', 'raid_full', 'bnet_not_linked', 'bnet_refresh', 'battlenet_only']) {
    x.data.mine = null; x.status = 'ok';
    s.calls.length = 0;
    answer = () => rejectWith(409, { error: code, message: 'x' });
    G.handlers.submit['open-form'](form({ pick: 'dreamscythe|Corvane', spec: 'Combat' }));
    await settle();
    assert.deepEqual(s.calls.map(c => c.m), ['post', 'get'], code);
  }
  // Signed out meanwhile.
  x.status = 'ok'; x.data = OPEN_DATA(); s.calls.length = 0;
  answer = () => rejectWith(401, { error: 'signed_out', message: 'Sign in.' });
  G.handlers.submit['open-form'](form({ pick: 'dreamscythe|Corvane', spec: 'Combat' }));
  await settle();
  assert.equal(x.status, 'signin');
  s.restore(); G.ui.setBusy = realBusy;
}));

check('open sign-up submit, typed guild: the body is name, class, spec, note and the hidden field; a refusal of the name shows at the name', withState(async (S) => {
  const x = S.join = OPEN_STATE({ data: OPEN_DATA({ signUp: { mode: 'typed' } }) });
  const form = v => ({ elements: { name: control(v.name || ''), class: control(v.class || ''), spec: control(v.spec || ''), note: control(v.note || ''), website: control(v.website || '') }, querySelector: () => null, querySelectorAll: () => [] });
  const nameErr = fakeEl('jn-name-err', { hidden: true });
  fakeEl('jn-error', { hidden: true });
  const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
  G.handlers.submit['open-form'](form({}));
  assert.equal(nameErr.hidden, false);
  nameErr.hidden = true;
  let answer = () => rejectWith(409, { error: 'on_roster', message: 'That character is on the guild\'s roster.', field: 'name' });
  const s = stub((m) => (m === 'post' ? answer() : okRes(OPEN_DATA({ signUp: { mode: 'typed' }, mine: { name: 'Wanderer', className: 'Mage', classId: 'MAGE', spec: 'Fire' } }))));
  G.handlers.submit['open-form'](form({ name: ' Wanderer ', class: 'MAGE', spec: 'Fire', note: 'From Beta' }));
  await settle();
  assert.deepEqual(plain(s.calls[0].body), { spec: 'Fire', website: '', name: 'Wanderer', class: 'MAGE', note: 'From Beta' });
  assert.equal(nameErr.hidden, false);
  assert(nameErr.innerHTML.includes('on the guild&#39;s roster'));
  answer = () => okRes({ ok: true, spotsLeft: null });
  G.handlers.submit['open-form'](form({ name: 'Wanderer', class: 'MAGE', spec: 'Fire' }));
  await settle();
  assert.equal(x.data.mine.name, 'Wanderer');
  s.restore(); G.ui.setBusy = realBusy;
  void S;
}));

check('open sign-up: another radio marks its row and lists the specs of its class (a spec that still fits stays chosen); Withdraw my sign-up deletes at once, reads the page again and says so', withState(async (S, probe) => {
  const x = S.join = OPEN_STATE();
  const rows = [{ checked: true, classList: { on: true, toggle(c, v) { this.on = v; } }, querySelector: () => rows[0].input }, { checked: false, classList: { on: false, toggle(c, v) { this.on = v; } }, querySelector: () => rows[1].input }];
  rows[0].input = { checked: false }; rows[1].input = { checked: true };
  const spec = { value: 'Combat', innerHTML: '' };
  const form = { elements: { spec }, querySelectorAll: () => rows, querySelector: () => null };
  fakeEl('jn-character-err', { hidden: false });
  const radio = { value: 'dreamscythe|Nightbriar', checked: true, closest: () => form };
  G.handlers.change['open-pick'](radio);
  assert.equal(x.draft.pick, 'dreamscythe|Nightbriar');
  assert.deepEqual([rows[0].classList.on, rows[1].classList.on], [false, true], 'the picked row is marked');
  assert(spec.innerHTML.includes('value="Affliction"') && !spec.innerHTML.includes('Combat'), 'the Warlock\'s specs');
  assert.equal(els['jn-character-err'].hidden, true, 'a message at the list goes away');
  // Withdraw.
  x.data = OPEN_DATA({ mine: { name: 'Corvane', className: 'Rogue', classId: 'ROGUE', spec: 'Combat' }, spotsLeft: 10 });
  let reads = 0;
  const s = stub((m) => { if (m === 'del') return okRes({ ok: true }); reads++; return okRes(OPEN_DATA({ spotsLeft: 11 })); });
  const button = { disabled: false };
  G.handlers.click['open-withdraw'](button);
  await settle();
  assert.deepEqual(s.calls.map(c => [c.m, c.url]), [['del', '/api/open/g1/raids/r1'], ['get', '/api/open/g1/raids/r1']], 'one DELETE, no dialog, then the page is read again');
  assert.equal(x.data.mine, null);
  assert.equal(x.notice, 'You are no longer signed up for this raid');
  assert(text(G.pages.openRaid.openHtml({ state: x })).includes('11 spots left'));
  s.restore();
  // Nothing to withdraw (404): the page is drawn as it is now; a failure shows at the button.
  x.data = OPEN_DATA({ mine: { name: 'Corvane', className: 'Rogue', classId: 'ROGUE', spec: 'Combat' } });
  fakeEl('jn-error', { hidden: true });
  let fail = rejectWith(409, { error: 'raid_started', message: 'This raid has started: a sign-up can no longer be withdrawn here.' });
  const s2 = stub((m) => (m === 'del' ? fail : okRes(OPEN_DATA())));
  G.handlers.click['open-withdraw']({ disabled: false });
  await settle();
  assert.equal(els['jn-error'].textContent, 'This raid has started: a sign-up can no longer be withdrawn here.');
  assert.equal(x.data.mine.name, 'Corvane', 'still signed up');
  s2.restore();
  void probe;
}));

check('the way back: a short-lived marker is kept before sign-in or a Battle.net round trip and taken once, only for an open-raid address and only for 15 minutes', () => {
  const store = {};
  const real = ctx.window;
  ctx.window = { sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } } };
  try {
    const O = G.pages.openRaid;
    assert.equal(O.takeReturn(), '', 'nothing kept');
    O.rememberReturn('#/open/g1/r1');
    assert.equal(O.takeReturn(), '#/open/g1/r1');
    assert.equal(O.takeReturn(), '', 'taken once');
    O.rememberReturn('#/g/g1/settings');
    assert.equal(O.takeReturn(), '', 'only an open-raid address comes back');
    store['gs-open-return'] = JSON.stringify({ hash: '#/open/g1/r1', at: Date.now() - 16 * 60 * 1000 });
    assert.equal(O.takeReturn(), '', 'too old');
    assert.equal(store['gs-open-return'], undefined, 'and gone either way');
    store['gs-open-return'] = '{not json';
    assert.equal(O.takeReturn(), '');
    store['gs-open-return'] = JSON.stringify({ hash: '#/open/g1/r1', at: Date.now() - 60 * 1000 });
    assert.equal(O.takeReturn(), '#/open/g1/r1', 'a minute old is fine');
    // The sign-in link that leaves the page sets it; the Battle.net links name the raid as their ?return= and set nothing.
    S_join(OPEN_STATE());
    assert.equal(G.handlers.click['open-connect'], undefined, 'no marker handler on the Battle.net links');
    G.handlers.click['open-signin']();
    assert.equal(JSON.parse(store['gs-open-return']).hash, '#/open/g1/r1');
    // Without storage nothing breaks.
    ctx.window = {};
    assert.doesNotThrow(() => O.rememberReturn('#/open/g1/r1'));
    assert.equal(O.takeReturn(), '');
  } finally { ctx.window = real; if (real === undefined) delete ctx.window; S_join(null); }
  function S_join(v) { ctx.Guild.app.state.join = v; }
});

// ═══ The public page ════════════════════════════════════════════════
const PUBLIC = (upcoming) => ({
  guild: { name: 'Vindicated', realm: 'Dreamscythe', realmKind: 'realm', region: 'US', gameVersion: 'tbc', timeZone: 'America/New_York' },
  viewer: { kind: 'public' },
  sections: { raids: [
    { team: { id: 't1', name: 'Team KJ' }, upcoming, recent: [{ raidOn: '2026-10-24', startsAt: 1, zone: 'Sunwell Plateau', title: null }] },
    { team: { id: 't2', name: 'Sunday Alts' }, upcoming: [{ raidOn: '2026-11-01', startsAt: 2, zone: 'Serpentshrine Cavern', title: null, open: true, raidId: 'r_sun' }], recent: [] },
  ] },
});
const UPCOMING = [
  { raidOn: '2026-10-28', startsAt: 1, zone: 'Sunwell Plateau', title: null },
  { raidOn: '2026-10-31', startsAt: 2, zone: 'Sunwell Plateau', title: null, open: true, raidId: 'r_sat' },
];

check('public page (6b): a Sign up link only on open upcoming raids, in an action column the Upcoming table gets only when it has one; Recent never; none on a guest link\'s view (no guild id)', () => {
  const out = G.pages.view.viewHtml({ data: PUBLIC(UPCOMING), kind: 'public', gid: 'g_vin' });
  const links = [...out.matchAll(/<a class="gs-btn gs-btn-sm" href="([^"]*)" aria-label="([^"]*)"><span>Sign up<\/span><\/a>/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(links, [['#/open/g_vin/r_sat', 'Sign up for Team KJ on Sat Oct 31'], ['#/open/g_vin/r_sun', 'Sign up for Sunday Alts on Sun Nov 1']]);
  const tables = [...out.matchAll(/<table class="gs-dtable" aria-label="([^"]*)">([\s\S]*?)<\/table>/g)].map(m => [m[1], /<span class="gs-sr">Sign up<\/span>/.test(m[2]), (m[2].match(/>Sign up<\/span><\/a>/g) || []).length]);
  assert.deepEqual(tables, [['Upcoming raids of Team KJ', true, 1], ['Recent raids of Team KJ', false, 0], ['Upcoming raids of Sunday Alts', true, 1]]); // Sunday Alts has no recent raid: no table
  assert(/<th scope="col" class=""><span class="gs-sr">Sign up<\/span><\/th>/.test(out), 'the column head is read aloud, not drawn, and not a sort button');
  // The row of a raid that is not open has an empty cell.
  const row = /<tr class="gs-dtable-row"><th scope="row" class="gs-dtable-primary">Wed Oct 28<\/th>([\s\S]*?)<\/tr>/.exec(out)[1];
  assert(/<td class="">\s*<\/td>$/.test(row) && !row.includes('Sign up'), row);
  // No open raid: the table is the old one.
  const plainTable = G.pages.view.viewHtml({ data: PUBLIC([UPCOMING[0]]), kind: 'public', gid: 'g_vin' });
  assert(plainTable.includes('Upcoming raids of Team KJ') && !/Upcoming raids of Team KJ">[\s\S]*?Sign up[\s\S]*?<\/table>/.test(plainTable.slice(0, plainTable.indexOf('Recent raids of Team KJ'))), 'no open raid in this table: no column');
  // A guest link's view does not know the guild id.
  assert(!G.pages.view.viewHtml({ data: PUBLIC(UPCOMING), kind: 'guest' }).includes('Sign up'));
  assertNoRawAttrs(out); ascii(out);
});

// ═══ Styles ═════════════════════════════════════════════════════════
check('styles: the new classes are in guild.css, use tokens only, and the phone rows are 56 px with 44 px buttons', () => {
  const start = css.indexOf('/* Raids open to guests (B3');
  assert(start > 0);
  const block = css.slice(start, css.indexOf('.gs-doc-page .gs-prose p', start));
  for (const sel of ['.gs-guests', '.gs-guest-limit', '.gs-bnetpick', '.gs-pick ', '.gs-pickrow', '.gs-pickrow.is-picked', '.gs-pickradio', '.gs-pickid', '.gs-picksub', '.gs-pickact']) assert(block.includes(sel), sel);
  assert(!/#[0-9a-f]{3,8}\b/i.test(block) && !/rgba?\(/.test(block), 'no colour literal');
  assert(/@media \(width <= 600px\) \{\s*\.gs-pickrow \{ min-height: 56px; \}\s*\.gs-open \.gs-pickact \.gs-btn \{ min-height: 44px; \}/.test(block));
  assert(/\.gs-pickrow \{[^}]*min-height: 52px/.test(block) && /\.gs-guest-limit \.gs-input \{ max-width: 160px; \}/.test(block));
});

run();
