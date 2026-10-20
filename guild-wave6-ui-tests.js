/**
 * Raidsmith guild UI, PM wave 6 - tests for the Attendance nav badge with pending character claims, the date-only deadline on the raid page, the away page's
 * cap and Guild settings > Notifications "Send a test post".
 * Run: node guild-wave6-ui-tests.js
 *
 * Same approach as guild-wave4-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render functions return HTML strings and the handlers
 * run against a stubbed G.api and a fake document. guild-wave6-worker-tests.js covers the Worker half.
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
let els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
function fakeEl(id, over) {
  const e = Object.assign({ id, value: '', textContent: '', hidden: false, innerHTML: '', disabled: false }, over || {});
  els[id] = e;
  return e;
}

const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'guild.teams': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild' };
const TEAMS = [{ id: 't1', name: 'Team KJ', size: 25, archived: false, players: 3, leads: [] }, { id: 't2', name: 'Weekend team', size: 25, archived: false, players: 1, leads: [] }];
function gd(can, over) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Nightslayer', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'nightslayer', createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({}, t)),
    me: { roles: [], can },
    attendanceFlags: {},
  }, over || {});
}
const navCtx = (guildData, teamId = 't1') => ({ section: 'guild', page: 'app', me: { user: { id: 'u1' } }, guildData, teamId });
const attendanceItem = (items) => items.find(i => i.key === 'attendance');

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, notifySettings: S.notifySettings, me: S.me };
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.notifySettings = null;
    els = {};
    const realRender = G.app.render;
    G.app.render = () => { S.renders = (S.renders || 0) + 1; };
    try { await fn(S); } finally { Object.assign(S, saved); G.app.render = realRender; els = {}; }
  };
}
class ApiErr extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.message = (extra && extra.message) || code; Object.assign(this, extra || {}); this.body = extra || {}; }
}

(async () => {
  // ═══ The Attendance badge ═══════════════════════════════════════
  await check('nav: pending character claims add to the Attendance badge (the Review queue is under it) for people who can decide them; the label says both', () => {
    const base = gd(OFFICER_CAN, { attendanceFlags: { t1: 2 }, pendingClaims: 3 });
    const item = attendanceItem(G.shell.sidebarItems(navCtx(base)));
    assert.equal(item.badge, 5);
    assert.equal(item.ariaLabel, 'Attendance, 2 flags and 3 character claims to review');
    assert.equal(attendanceItem(G.shell.tabItems(navCtx(base))).badge, 5, 'also on the phone tabs');
    // Claims only.
    const claims = attendanceItem(G.shell.sidebarItems(navCtx(gd(OFFICER_CAN, { pendingClaims: 1 }))));
    assert.deepEqual([claims.badge, claims.ariaLabel], [1, 'Attendance, 1 character claim to review']);
    // Raids only: the label is as it was.
    const raids = attendanceItem(G.shell.sidebarItems(navCtx(gd(OFFICER_CAN, { attendanceFlags: { t1: 1 } }))));
    assert.deepEqual([raids.badge, raids.ariaLabel], [1, 'Attendance, 1 flag to review']);
    assert.deepEqual([attendanceItem(G.shell.sidebarItems(navCtx(gd(OFFICER_CAN)))).badge, attendanceItem(G.shell.sidebarItems(navCtx(gd(OFFICER_CAN)))).ariaLabel], [0, 'Attendance']);
    // Without roster.edit (can not decide a claim) or attendance.review (can not open the queue) the claims add nothing.
    for (const drop of ['roster.edit', 'attendance.review']) {
      const can = Object.assign({}, OFFICER_CAN); delete can[drop];
      assert.equal(attendanceItem(G.shell.sidebarItems(navCtx(gd(can, { attendanceFlags: { t1: 2 }, pendingClaims: 3 })))).badge, drop === 'roster.edit' ? 2 : 0, drop);
    }
    // Rubbish counts are ignored.
    for (const junk of [undefined, null, -1, 'x', NaN, 0]) assert.equal(G.shell.claimsBadge(gd(OFFICER_CAN, { pendingClaims: junk }), 't1'), 0, String(junk));
    assert.equal(G.shell.claimsBadge(gd(OFFICER_CAN, { pendingClaims: 2.9 }), 't1'), 2);
    assert.equal(G.shell.claimsBadge(gd(OFFICER_CAN, { pendingClaims: 3 }), null), 0, 'no team, no badge');
  });

  await check('nav: a reply with pendingClaims refreshes the badge without a refetch, and opening the Review queue sets it from the claims it listed', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN, { pendingClaims: 4 }); S.currentGid = 'g1';
    G.app.applyFlags('g1', { pendingClaims: 1 });
    assert.equal(S.guilds.g1.pendingClaims, 1);
    G.app.applyFlags('g1', { pendingClaims: 'x' });
    assert.equal(S.guilds.g1.pendingClaims, 1, 'only a number counts');
    G.app.applyFlags('g1', { rosterFlags: {} });
    assert.equal(S.guilds.g1.pendingClaims, 1, 'a reply without it leaves it');
    G.app.applyFlags('g1', { pendingClaims: 0 });
    assert.equal(S.guilds.g1.pendingClaims, 0);
  }));

  // ═══ The date-only deadline on the raid page ════════════════════
  await check('raid page: a raid with only a date says which time its sign-ups close at and why (the team slot, or 18:00 guild time), also with a deadline in hours', () => {
    const gdata = gd(OFFICER_CAN);
    const closes = Date.UTC(2026, 9, 25, 1, 0); // 20:00 Chicago on Sat Oct 24
    assert.equal(G.pages.raids.closeNoteText({ closeHours: 0 }), '', 'a raid with a start time says nothing');
    assert.equal(G.pages.raids.closeNoteText(null), '');
    assert.equal(G.pages.raids.closeNoteText({ closesSource: 'slot', closeHours: 0 }), 'this raid has only a date, so sign-ups close at the time of the schedule slot that day');
    assert.equal(G.pages.raids.closeNoteText({ closesSource: 'default', closeHours: 0 }), 'this raid has only a date and the team has no schedule slot that day, so sign-ups close at 18:00 guild time');
    assert(G.pages.raids.closeNoteText({ closesSource: 'slot', closeHours: 2 }).endsWith(', 2 hours earlier'));
    assert(G.pages.raids.closeNoteText({ closesSource: 'default', closeHours: 1 }).endsWith(', 1 hour earlier'));
    // The sign-ups panel's pill.
    const v = { raid: { id: 'u1', teamId: 't1', startsAt: Date.UTC(2026, 9, 24, 12), upcoming: true, locked: false, closed: null, closesAt: closes, closesSource: 'slot', closeHours: 0, timeKnown: false },
      can: { edit: false, self: true, seeList: true, seeNicknames: false }, me: { personId: 'p_e', signup: null, characters: [], defaultCharacterId: null, canChange: true, closed: null }, counts: null, entries: null, roster: null };
    const detail = { raid: { id: 'u1', team: { id: 't1', name: 'Team KJ' }, teamId: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 24, 12), timeKnown: false, upcoming: true, title: null, zone: 'Karazhan', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 }, can: { edit: false }, sources: {}, pulls: [], people: [], unmatched: [], signups: [] };
    const html = G.pages.raidSignups.panelHtml({ guildData: gdata, data: detail, state: { gid: 'g1', rid: 'u1', status: 'ok', data: v, ui: G.pages.raidSignups.freshUi(v) } });
    const text = stripTags(html);
    assert(/Open until Sat Oct 24, 8:00 PM CT \(this raid has only a date, so sign-ups close at the time of the schedule slot that day\)/.test(text), text.slice(0, 400));
    const dflt = G.pages.raidSignups.panelHtml({ guildData: gdata, data: detail, state: { gid: 'g1', rid: 'u1', status: 'ok', ui: G.pages.raidSignups.freshUi(v), data: Object.assign({}, v, { raid: Object.assign({}, v.raid, { closesSource: 'default', closesAt: Date.UTC(2026, 9, 24, 23, 0) }) }) } });
    assert(/Open until Sat Oct 24, 6:00 PM CT \(this raid has only a date and the team has no schedule slot that day, so sign-ups close at 18:00 guild time\)/.test(stripTags(dflt)));
    // A raid with a start time is as before.
    const timed = Object.assign({}, v, { raid: Object.assign({}, v.raid, { closesSource: undefined, timeKnown: true, closeHours: 2, closesAt: closes }) });
    const timedText = stripTags(G.pages.raidSignups.panelHtml({ guildData: gdata, data: detail, state: { gid: 'g1', rid: 'u1', status: 'ok', ui: G.pages.raidSignups.freshUi(timed), data: timed } }));
    assert(/Open until Sat Oct 24, 8:00 PM CT \(sign-ups close 2 hours before the start\)/.test(timedText), timedText.slice(0, 300));
    // The officer's raid settings: "In effect".
    const raidDetail = { raid: Object.assign({}, detail.raid, { closeHours: 0, closeHoursOverride: null, teamCloseHours: 0, closesAt: closes, closesSource: 'slot', sizeOverride: null, size: 25 }), can: { edit: true }, sources: {}, pulls: [], people: [], unmatched: [], signups: [] };
    const settings = stripTags(G.pages.raid.settingsDialogHtml(gdata, raidDetail));
    assert(/In effect: members can change their sign-up until Sat Oct 24, 8:00 PM CT \(this raid has only a date, so sign-ups close at the time of the schedule slot that day\), the team's setting\./.test(settings), settings);
    const timedSettings = stripTags(G.pages.raid.settingsDialogHtml(gdata, { raid: Object.assign({}, raidDetail.raid, { closesSource: undefined, timeKnown: true }), can: { edit: true }, sources: {}, pulls: [], people: [], unmatched: [], signups: [] }));
    assert(/In effect: members can change their sign-up until the raid starts, the team's setting\./.test(timedSettings), timedSettings);
  });

  // ═══ The away page's cap ════════════════════════════════════════
  await check('away page: the cap counts the Worker\'s active notices, so ended notices do not disable Add; a list from an older Worker still counts every notice', withState(async (S) => {
    S.guilds.g1 = gd({}); S.currentGid = 'g1';
    const notice = (i, from, to) => ({ id: 'an_x' + i, personId: 'p1', kind: 'away', atTime: null, from, to, weekday: null, reason: null, mine: true, createdAt: 1 });
    const list = Array.from({ length: 30 }, (_, i) => notice(i, '2026-09-0' + (1 + (i % 9)), '2026-09-0' + (1 + (i % 9))));
    const html = (extra) => {
      const d = Object.assign({ personId: 'p1', today: '2026-10-20', timeZone: 'America/Chicago', notices: list, max: 30 }, extra);
      return G.pages.away.mineHtml({ guildData: S.guilds.g1, state: { gid: 'g1', data: d, showPast: false, note: '' } });
    };
    const full = html({});
    assert(full.includes('an-add'), 'the page drew');
    assert(/disabled data-action="away-add"/.test(full), 'no `active`: every notice counts, as before');
    assert(!/disabled data-action="away-add"/.test(html({ active: 12 })), 'twelve current notices: Add is open');
    assert(/disabled data-action="away-add"/.test(html({ active: 30 })));
  }));

  // ═══ Send a test post ═══════════════════════════════════════════
  const team = (over) => Object.assign({
    id: 't1', name: 'Team KJ', webhook: { set: false, hint: null, state: 'ok', disabledAt: null, disabledStatus: null }, roleMention: null,
    post: { roster: false, loot: false, reminders: false, noreply: false, confirm: false }, noreplyHours: 24,
  }, over || {});
  const data = (teams) => ({ teams: teams || [team(), team({ id: 't2', name: 'Weekend team' })], options: { noreplyHours: [6, 12, 24, 48] } });
  const WEBHOOK = { set: true, hint: '.../AbCd', state: 'ok', disabledAt: null, disabledStatus: null };

  await check('settings: "Send a test post" shows beside Save only for a team whose webhook is saved and on; the line under the card is a live region', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const out = G.pages.settingsNotify.settingsHtml({ guildData: S.guilds.g1, data: data([team({ webhook: WEBHOOK }), team({ id: 't2', name: 'Weekend team' }), team({ id: 't3', name: 'Dead', webhook: Object.assign({}, WEBHOOK, { state: 'disabled', disabledStatus: 404 }) })]) });
    assert(out.includes('data-action="notify-test" data-team="t1"') && out.includes('>Send a test post</button>'));
    assert(!out.includes('data-action="notify-test" data-team="t2"'), 'no webhook, no test');
    assert(!out.includes('data-action="notify-test" data-team="t3"'), 'a switched-off webhook is not tested: paste a new one');
    assert(/<p class="gs-fine gs-notify-test" id="notify-t1-test" role="status"><\/p>/.test(out));
    assert(stripTags(out).includes(G.pages.settingsNotify.TEST_HELP));
    assert(/aria-describedby="notify-t1-test-help"/.test(out) && out.includes('id="notify-t1-test-help"'));
    for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) assert(!/\sstyle=|\son[a-z]+=/i.test(tag.replace(/="[^"]*"/g, '="')), tag.slice(0, 80));
  }));

  await check('settings: the answers read in words - sent, switched off (with the status) and failed (with and without an answer)', () => {
    const t = G.pages.settingsNotify.testText;
    assert.equal(t({ result: 'sent', status: 204 }), 'Test post sent. Look for it in the channel.');
    assert.equal(t({ result: 'disabled', status: 404 }), 'Discord refused the test post (Discord answered 404), so the webhook was switched off. Paste a new address to turn posts back on.');
    assert.equal(t({ result: 'failed', status: 500 }), 'The test post did not arrive (Discord answered 500). The webhook stays on; try again in a moment.');
    assert.equal(t({ result: 'failed', status: null }), 'The test post did not arrive (no answer from Discord). The webhook stays on; try again in a moment.');
    assert.equal(t(null), 'The test post did not arrive (no answer from Discord). The webhook stays on; try again in a moment.');
  });

  await check('settings: the button posts to the team\'s test route and shows the answer under the card without redrawing it; the button comes back', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const x = S.notifySettings = { gid: 'g1', data: data([team({ webhook: WEBHOOK })]), notice: '' };
    const sink = fakeEl('notify-t1-test');
    const button = { disabled: false, getAttribute: k => (k === 'data-team' ? 't1' : null) };
    const api = stub(() => Promise.resolve({ result: 'sent', status: 204, team: team({ webhook: WEBHOOK }) }));
    try {
      G.handlers.click['notify-test'](button);
      assert.equal(button.disabled, true, 'busy while it runs');
      assert.equal(sink.textContent, 'Sending a test post...');
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url]), [['post', '/api/guild/g1/teams/t1/notifications/test']]);
      assert.equal(sink.textContent, 'Test post sent. Look for it in the channel.');
      assert.equal(button.disabled, false);
      assert(!S.renders, 'a sent post redraws nothing');
      // A second click while the first runs does nothing.
      button.disabled = true;
      G.handlers.click['notify-test'](button);
      assert.equal(api.calls.length, 1);
    } finally { api.restore(); }
    // Failed: the answer, the webhook stays on.
    const failing = stub(() => Promise.resolve({ result: 'failed', status: 500, team: team({ webhook: WEBHOOK }) }));
    button.disabled = false;
    try { G.handlers.click['notify-test'](button); await settle(); } finally { failing.restore(); }
    assert.match(sink.textContent, /^The test post did not arrive \(Discord answered 500\)/);
    assert.equal(x.data.teams[0].webhook.state, 'ok');
  }));

  await check('settings: a refused webhook redraws the card as switched off with the answer in the notice; a refusal of the request (429, 409) shows its message under the card', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const x = S.notifySettings = { gid: 'g1', data: data([team({ webhook: WEBHOOK })]), notice: '' };
    const sink = fakeEl('notify-t1-test');
    const button = { disabled: false, getAttribute: k => (k === 'data-team' ? 't1' : null) };
    const off = team({ webhook: Object.assign({}, WEBHOOK, { state: 'disabled', disabledAt: 5, disabledStatus: 404 }) });
    let api = stub(() => Promise.resolve({ result: 'disabled', status: 404, team: off }));
    try { G.handlers.click['notify-test'](button); await settle(); } finally { api.restore(); }
    assert.equal(x.data.teams[0].webhook.state, 'disabled');
    assert.match(x.notice, /^Discord refused the test post \(Discord answered 404\), so the webhook was switched off/);
    assert.equal(S.renders, 1);
    // The Worker's refusals.
    x.data.teams[0] = team({ webhook: WEBHOOK });
    for (const [status, code, message] of [[429, 'rate_limited', 'That team has had five test posts this hour. Try again later.'], [409, 'webhook_off', 'This webhook was switched off. Paste a new address and save it first.']]) {
      button.disabled = false;
      api = stub(() => Promise.reject(new ApiErr(status, code, { message, retryAfter: status === 429 ? 1800 : undefined })));
      try { G.handlers.click['notify-test'](button); await settle(); } finally { api.restore(); }
      assert(sink.textContent.startsWith(message), `${status}: ${sink.textContent}`);
      assert.equal(button.disabled, false);
    }
    // Signed out: back to the sign-in page.
    let signedIn = false;
    const realRequire = G.app.requireSignin;
    G.app.requireSignin = () => { signedIn = true; };
    button.disabled = false;
    api = stub(() => Promise.reject(new ApiErr(401, 'signed_out', { message: 'Sign in.' })));
    try { G.handlers.click['notify-test'](button); await settle(); } finally { api.restore(); G.app.requireSignin = realRequire; }
    assert(signedIn);
  }));

  await check('settings: the test route is in the API module and the privacy copy still says the address is a secret', () => {
    assert.equal(typeof G.api.notifications.test, 'function');
    const calls = [];
    const real = G.api.post;
    G.api.post = (url, body) => { calls.push([url, plain(body)]); return Promise.resolve({}); };
    try { G.api.notifications.test('g1', 't 1'); } finally { G.api.post = real; }
    assert.deepEqual(calls, [['/api/guild/g1/teams/t%201/notifications/test', {}]]);
    assert(/ASCII/.test('ASCII') && !/[^\x00-\x7f]/.test(read('js/guild/pages-settings-notifications.js')), 'the page file stays ASCII');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
