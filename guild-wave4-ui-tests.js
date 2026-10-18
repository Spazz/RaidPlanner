/**
 * Raidsmith guild UI, PM wave 4 (Discord notifications and automatic refresh) - tests for Guild settings > Notifications, "Don't mention me in reminders" on
 * Linked accounts, the three new Needs attention lines, "Sign-ups refreshed 12 min ago" on the Raids page and the privacy copy.
 * Run: node guild-wave4-ui-tests.js
 *
 * Same approach as guild-wave3-ui-tests.js: tests/guild-scripts.js is loaded in a vm with no DOM; the render functions return HTML strings and the handlers
 * run against a stubbed G.api and a fake document. guild-wave4-contract-tests.js runs the same pages against the real Worker.
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
function fakeEl(id, over) {
  const e = Object.assign({ id, value: '', textContent: '', hidden: false, innerHTML: '', focused: 0, attrs: {}, focus() { e.focused++; }, select() { e.selected = true; }, setAttribute(k, v) { e.attrs[k] = v; } }, over || {});
  els[id] = e;
  return e;
}
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const tick = () => new Promise(r => setTimeout(r, 5));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

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

const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'guild.teams': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild' };
const TEAMS = [
  { id: 't1', name: 'Team KJ', size: 25, archived: false, players: 3, leads: [] },
  { id: 't2', name: 'Weekend team', size: 25, archived: false, players: 1, leads: [] },
];
function gd(can, over) {
  return Object.assign({
    guild: { id: 'g1', name: 'Ravens', realm: 'Nightslayer', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'nightslayer', createdAt: 1 },
    teams: TEAMS.map(t => Object.assign({}, t)),
    me: { roles: [], can },
    attendanceFlags: {},
  }, over || {});
}

const team = (over) => Object.assign({
  id: 't1', name: 'Team KJ', webhook: { set: false, hint: null, state: 'ok', disabledAt: null, disabledStatus: null }, roleMention: null,
  post: { roster: false, loot: false, reminders: false, noreply: false, confirm: false }, noreplyHours: 24,
}, over || {});
const data = (teams) => ({ teams: teams || [team(), team({ id: 't2', name: 'Weekend team' })], options: { noreplyHours: [6, 12, 24, 48] } });

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const control = (value, extra) => Object.assign({ value, checked: false, focused: 0, attrs: {}, focus() { this.focused++; }, setAttribute(k, v) { this.attrs[k] = v; } }, extra || {});
function withState(fn) {
  return async () => {
    const S = ctx.Guild.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert, notifySettings: S.notifySettings, me: S.me, bnet: S.bnet };
    S.att = {}; S.guilds = {}; S.pageAlert = ''; S.notifySettings = null;
    els = {};
    const realRender = G.app.render; const realLoadMe = G.app.loadMe;
    G.app.render = () => { S.renders = (S.renders || 0) + 1; };
    try { await fn(S); } finally {
      Object.assign(S, saved); G.app.render = realRender; G.app.loadMe = realLoadMe; els = {};
    }
  };
}
class ApiErr extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.message = (extra && extra.message) || code; Object.assign(this, extra || {}); this.body = extra || {}; }
}
// The form a team's card submits: values by control name.
function formFor(teamId, values) {
  const names = ['webhookUrl', 'roleMention', 'roster', 'loot', 'reminders', 'noreply', 'confirm', 'noreplyHours'];
  const elements = {};
  for (const name of names) elements[name] = control(values[name] === undefined ? '' : values[name], { checked: values[name] === true });
  return { elements, getAttribute: k => (k === 'data-team' ? teamId : null), querySelectorAll: () => [] };
}

(async () => {
  // ═══ Router and shell ═══════════════════════════════════════════
  await check('router and shell: Notifications is a Guild settings tab for guild.teams, in the Raid rules group before Applications; the address round-trips', () => {
    assert.deepEqual(plain(G.router.parse('#/g/g1/settings/notifications')), { name: 'settings', gid: 'g1', tab: 'notifications' });
    assert.equal(G.router.format({ name: 'settings', gid: 'g1', tab: 'notifications' }), '#/g/g1/settings/notifications');
    const tabs = (can) => plain(G.shell.settingsTabs(can, []).map(t => t.tab));
    assert.deepEqual(tabs({ 'guild.teams': 'guild' }), ['general', 'teams', 'notifications', 'applications', 'battlenet']);
    assert.deepEqual(tabs({ 'raids.edit': 'guild' }), ['schedule'], 'raid editing alone does not open it');
    assert.deepEqual(tabs({ 'guild.access': 'guild' }), ['people', 'guests', 'dataaccess']);
    assert.equal(G.shell.SETTINGS_TABS.find(t => t.tab === 'notifications').label, 'Notifications');
  });

  // ═══ Guild settings > Notifications ═════════════════════════════
  await check('settings: a card per team with the address field empty, the switches as they stand and the hours; a saved address shows only its last four characters', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const saved = team({
      webhook: { set: true, hint: '.../AbCd', state: 'ok', disabledAt: null, disabledStatus: null }, roleMention: '123456789012345678',
      post: { roster: true, loot: false, reminders: true, noreply: true, confirm: false }, noreplyHours: 12,
    });
    const out = G.pages.settingsNotify.settingsHtml({ guildData: S.guilds.g1, data: data([saved, team({ id: 't2', name: 'Weekend team' })]) });
    assertNoRawAttrs(out);
    const text = stripTags(out);
    assert(text.includes('Nothing is posted until you switch a post on'));
    assert(text.includes('Team KJ') && text.includes('Weekend team') && text.includes('Webhook set') && text.includes('No webhook'));
    assert(text.includes('Webhook saved, ending in .../AbCd'));
    assert(text.includes('The address is a secret. Raidsmith stores it and never shows it again'));
    assert(!/discord\.com\/api\/webhooks\/\d/.test(out), 'no address is ever drawn');
    // Team 1: the address field is empty and labelled "New webhook address"; the role is shown the way Discord writes it.
    assert(out.includes('for="notify-t1-url">New webhook address<') && out.includes('for="notify-t2-url">Webhook address<'));
    assert(/id="notify-t1-url"[^>]*name="webhookUrl"[^>]*placeholder="https:\/\/discord\.com\/api\/webhooks\/\.\.\."(?![^>]*value=)/.test(out), 'empty, never filled in');
    assert(out.includes('value="&lt;@&amp;123456789012345678&gt;"'));
    for (const [key, on] of [['roster', true], ['loot', false], ['reminders', true], ['noreply', true], ['confirm', false]]) {
      const m = new RegExp(`<input type="checkbox" id="notify-t1-${key}" name="${key}"( checked)?>`).exec(out);
      assert(m, `switch ${key}`);
      assert.equal(!!m[1], on, `switch ${key}`);
    }
    assert(text.includes('Post the line-up when published') && text.includes('Post loot after an import') && text.includes('Post upcoming raid reminders (24 h and 2 h before)'));
    assert(text.includes("Remind people who haven't answered") && text.includes("Remind people in the line-up who haven't confirmed (6 h before the raid)"));
    const hours = [...out.matchAll(/<select class="gs-input" id="notify-t1-hours"[^>]*>([\s\S]*?)<\/select>/g)][0][1];
    assert.deepEqual([...hours.matchAll(/<option value="(\d+)"( selected)?>([^<]*)<\/option>/g)].map(o => [o[1], !!o[2], o[3]]), [['6', false, '6 hours'], ['12', true, '12 hours'], ['24', false, '24 hours'], ['48', false, '48 hours']]);
    assert(out.includes('data-action="notify-remove" data-team="t1"') && !out.includes('data-action="notify-remove" data-team="t2"'), 'Remove only where there is a webhook');
    assert(/<fieldset class="gs-pol-field"><legend class="gs-label">What to post<\/legend>/.test(out));
  }));

  await check('settings: a switched-off webhook says why and asks for a new address; loading and no-team states; hostile team names are escaped', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const dead = team({ webhook: { set: true, hint: '.../AbCd', state: 'disabled', disabledAt: 5, disabledStatus: 404 } });
    const out = G.pages.settingsNotify.settingsHtml({ guildData: S.guilds.g1, data: data([dead]) });
    assert(out.includes('class="gs-warn"') && out.includes('Switched off'));
    assert(stripTags(out).includes('The webhook ending in .../AbCd was switched off: Discord refused it (404), so the channel or the webhook is gone. Paste a new address to turn posts back on.'));
    assert(G.pages.settingsNotify.settingsHtml({ guildData: S.guilds.g1, data: null }).includes('Loading'), 'loading');
    assert(stripTags(G.pages.settingsNotify.settingsHtml({ guildData: S.guilds.g1, data: { teams: [], options: {} } })).includes('This guild has no active teams.'));
    const hostile = G.pages.settingsNotify.settingsHtml({ guildData: S.guilds.g1, data: data([team({ name: HOSTILE + QUOTES, roleMention: null })]), notice: HOSTILE, alert: HOSTILE });
    assertEscaped(hostile, 'notifications');
    assertNoRawAttrs(hostile);
    assert(G.pages.settingsNotify.settingsHtml({ guildData: S.guilds.g1, data: data(), notice: 'Saved for Team KJ.' }).includes('role="status"'));
  }));

  await check('settings: the PUT body sends the address only when one was typed, the role as typed, the switches and the lead time as a number', () => {
    const body = (values) => plain(G.pages.settingsNotify.bodyFrom(formFor('t1', values)));
    assert.deepEqual(body({ roleMention: ' <@&123456789012345678> ', roster: true, noreplyHours: '48' }), {
      roleMention: '<@&123456789012345678>', roster: true, loot: false, reminders: false, noreply: false, confirm: false, noreplyHours: 48,
    });
    assert.deepEqual(body({ webhookUrl: '  https://discord.com/api/webhooks/1/x  ', noreplyHours: '6', confirm: true }), {
      roleMention: '', webhookUrl: 'https://discord.com/api/webhooks/1/x', roster: false, loot: false, reminders: false, noreply: false, confirm: true, noreplyHours: 6,
    });
    assert.equal('webhookUrl' in body({ webhookUrl: '   ', noreplyHours: '24' }), false, 'blank keeps the saved address');
  });

  await check('settings: Save sends the team\'s PUT and shows what came back; a refusal lands under the card; Remove sends a null address', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const x = S.notifySettings = { gid: 'g1', data: data(), notice: '' };
    const after = team({ webhook: { set: true, hint: '.../wxyz', state: 'ok', disabledAt: null, disabledStatus: null }, post: { roster: true, loot: false, reminders: false, noreply: false, confirm: false } });
    let api = stub(() => Promise.resolve({ team: after, options: { noreplyHours: [6, 12, 24, 48] } }));
    const form = formFor('t1', { webhookUrl: 'https://discord.com/api/webhooks/1/x', roster: true, noreplyHours: '24' });
    try {
      G.handlers.submit['notify-save'](form);
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url]), [['put', '/api/guild/g1/teams/t1/notifications']]);
      assert.equal(api.calls[0].body.webhookUrl, 'https://discord.com/api/webhooks/1/x');
      assert.equal(api.calls[0].body.roster, true);
      assert.deepEqual(plain(x.data.teams[0]), plain(after), 'the card now shows the saved state');
      assert.equal(x.data.teams[1].id, 't2');
      assert.equal(x.notice, 'Saved for Team KJ.');
    } finally { api.restore(); }
    const err = fakeEl('notify-t1-error');
    api = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'That is not a Discord webhook address.', field: 'webhookUrl' })));
    try {
      G.handlers.submit['notify-save'](formFor('t1', { webhookUrl: 'nope', noreplyHours: '24' }));
      await settle();
      assert.equal(err.textContent, 'That is not a Discord webhook address.');
    } finally { api.restore(); }
    api = stub(() => Promise.resolve({ team: team(), options: {} }));
    try {
      const button = el({ 'data-team': 't1' });
      G.handlers.click['notify-remove'](button);
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['put', '/api/guild/g1/teams/t1/notifications', { webhookUrl: null }]]);
      assert.equal(button.disabled, true);
      assert.equal(x.notice, 'Removed the webhook of Team KJ.');
      assert.equal(x.data.teams[0].webhook.set, false);
    } finally { api.restore(); }
    // A team the page does not know sends nothing.
    api = stub(() => Promise.resolve({}));
    try {
      G.handlers.submit['notify-save'](formFor('t_unknown', { noreplyHours: '24' }));
      G.handlers.click['notify-remove'](el({ 'data-team': 't_unknown' }));
      assert.equal(api.calls.length, 0);
    } finally { api.restore(); }
  }));

  await check('settings: load reads the notifications and keeps them for the page', withState(async (S) => {
    const api = stub(() => Promise.resolve(data()));
    try {
      await G.pages.settingsNotify.load('g1');
      assert.deepEqual(api.calls.map(c => [c.m, c.url]), [['get', '/api/guild/g1/notifications']]);
      assert.equal(S.notifySettings.gid, 'g1');
      assert.equal(S.notifySettings.data.teams.length, 2);
    } finally { api.restore(); }
  }));

  // ═══ Linked accounts: Don't mention me in reminders ═════════════
  await check('linked accounts: the reminder card shows the opt-out as it stands and sits after Discord; ticking it sends the PUT and reloads', withState(async (S) => {
    const me = (optOut) => ({ user: { displayName: 'Erin' }, identities: { discord: { username: 'erin' }, bnet: null }, account: { customName: null, available: { discord: true, bnet: true }, reminderOptOut: optOut } });
    const off = G.pages.accounts.reminderCardHtml(me(false));
    const on = G.pages.accounts.reminderCardHtml(me(true));
    assertNoRawAttrs(off);
    assert(stripTags(off).includes("Discord reminders") && stripTags(off).includes("Don't mention me in reminders") && stripTags(off).includes('You are still listed by name, without a ping.'));
    assert(/<input type="checkbox" id="reminder-optout" name="reminderOptOut" data-change="reminder-optout">/.test(off));
    assert(/<input type="checkbox" id="reminder-optout" name="reminderOptOut" data-change="reminder-optout" checked>/.test(on));
    const cards = G.pages.accounts.profileCardsHtml(me(false));
    assert(cards.indexOf('id="linked-name"') < cards.indexOf('id="linked-discord"') && cards.indexOf('id="linked-discord"') < cards.indexOf('id="linked-reminders"'));
    assert.equal(G.pages.accounts.reminderOptOutOf({ user: {} }), false, 'an older answer without the field');
    // The change handler.
    G.app.loadMe = () => Promise.resolve();
    S.bnet = null;
    const api = stub((m, url) => Promise.resolve(url === '/auth/bnet' ? {} : { optOut: true }));
    try {
      const box = control('on', { checked: true });
      G.handlers.change['reminder-optout'](box);
      await settle();
      assert.deepEqual(api.calls.map(c => [c.m, c.url, c.body]), [['put', '/auth/reminders', { optOut: true }], ['get', '/auth/bnet', undefined]]);
      assert.equal(box.disabled, true, 'busy while saving');
      assert.equal(S.bnet.notice, "You won't be pinged in reminders.");
    } finally { api.restore(); }
    const err = fakeEl('reminder-optout-error');
    const failing = stub(() => Promise.reject(new ApiErr(400, 'bad_request', { message: 'optOut must be true or false.', field: 'optOut' })));
    try {
      const box = control('on', { checked: true });
      G.handlers.change['reminder-optout'](box);
      await settle();
      assert.equal(box.checked, false, 'the box goes back');
      assert.equal(box.disabled, false);
      assert.equal(err.textContent, 'optOut must be true or false.');
    } finally { failing.restore(); }
  }));

  // ═══ Needs attention ════════════════════════════════════════════
  await check('Home: the three new lines read plainly and link to the raid or to Settings > Notifications; the kinds match the Worker\'s', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const text = (item) => G.pages.attention.itemText(item);
    const day = G.ui.weekdayDay;
    assert.equal(text({ kind: 'roster_pending', date: '2027-01-16', count: 3 }), `${day('2027-01-16')}: 3 line-up players haven't confirmed`);
    assert.equal(text({ kind: 'roster_pending', date: '2027-01-16', count: 1 }), `${day('2027-01-16')}: 1 line-up player hasn't confirmed`);
    assert.equal(text({ kind: 'event_moved', date: '2027-01-16', eventDate: '2027-01-18' }), `${day('2027-01-16')}: Raid-Helper has the event on ${day('2027-01-18')}; the raid was not moved`);
    assert.equal(text({ kind: 'webhook_off', teamName: 'Team KJ', status: 404 }), 'The Discord webhook of Team KJ was switched off (Discord answered 404)');
    assert.equal(text({ kind: 'webhook_off', teamName: 'Team KJ' }), 'The Discord webhook of Team KJ was switched off');
    const items = [
      { id: 'roster_pending:r_1', kind: 'roster_pending', severity: 'action', teamId: 't1', teamName: 'Team KJ', date: '2027-01-16', count: 3, link: { name: 'raid', rid: 'r_1' } },
      { id: 'event_moved:r_1', kind: 'event_moved', severity: 'action', teamId: 't1', teamName: 'Team KJ', date: '2027-01-16', eventDate: '2027-01-18', link: { name: 'raid', rid: 'r_1' } },
      { id: 'webhook_off:t1', kind: 'webhook_off', severity: 'action', teamId: 't1', teamName: 'Team KJ', status: 401, link: { name: 'settings', tab: 'notifications' } },
    ];
    const out = G.pages.attention.attentionHtml({ guildData: S.guilds.g1, data: { today: '2027-01-15', total: 3, items, more: { webhook_off: 2 }, onboarding: null } });
    assertNoRawAttrs(out);
    assert(out.includes('href="#/g/g1/raids/r/r_1"'));
    assert(out.includes('href="#/g/g1/settings/notifications"'), 'the webhook line opens the Notifications tab');
    const t = stripTags(out);
    assert(t.includes('3 line-up players haven') && t.includes('Raid-Helper has the event on') && t.includes('The Discord webhook of Team KJ was switched off'));
    assert(out.includes('<span>Open settings</span>') && out.includes('<span>Open raid</span>'));
    assert(t.includes('and 2 more: discord webhooks switched off'), 'the hidden ones name their kind');
    assert(out.includes(G.router.format({ name: 'settings', gid: 'g1', tab: 'notifications' })) && t.includes('and 2 more'), 'and N more goes to the same place');
    // The page lists exactly the kinds the Worker produces.
    const kinds = plain(G.pages.attention.KINDS.map(k => k.id));
    const worker = fs.readFileSync(path.join(ROOT, 'worker/attention.js'), 'utf8');
    const listed = /ATTENTION_KINDS = \[([^\]]*)\]/.exec(worker)[1].match(/'([a-z_]+)'/g).map(s => s.slice(1, -1));
    assert.deepEqual(kinds, listed, 'KINDS in pages-attention.js and ATTENTION_KINDS in worker/attention.js agree, in order');
  }));

  // ═══ Raids page ═════════════════════════════════════════════════
  await check('Raids: a raid with a Raid-Helper event says how long ago its sign-ups were read; officers also see an event on another day; no event, no line', withState(async (S) => {
    S.guilds.g1 = gd(OFFICER_CAN); S.currentGid = 'g1';
    const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const row = (over) => Object.assign({
        id: 'r_1', raidOn: '2027-01-16', startsAt: NOW + 20 * 3600000, timeKnown: true, upcoming: true, zone: "Gruul's Lair", size: 25, title: 'Gruul night', eventSourced: true, eventId: '123456',
        eventSyncedAt: NOW - 12 * 60000, eventMovedOn: null, otherServer: false, signups: { signed: 3, late: 0, standby: 0, bench: 0, tentative: 0, absence: 0 }, locked: false, signupsOpen: true,
        closesAt: NOW + 20 * 3600000, closeHours: 0, mine: null, planned: false, planLive: null,
      }, over || {});
      const html = (r) => G.pages.raids.raidsHtml({ guildData: S.guilds.g1, teamId: 't1', data: { team: { id: 't1', name: 'Team KJ', archived: false, size: 25, signupCloseHours: 0 }, today: '2027-01-15', can: { edit: true, signup: false }, schedule: null, hasMore: false, upcoming: [r], raids: [] }, tab: 'upcoming' });
      const out = html(row());
      assertNoRawAttrs(out);
      assert(stripTags(out).includes('Sign-ups refreshed 12 min ago'), stripTags(out).slice(0, 400));
      assert(!stripTags(out).includes('Raid-Helper has this event on'));
      const moved = stripTags(html(row({ eventMovedOn: '2027-01-18' })));
      assert(moved.includes(`Raid-Helper has this event on ${G.ui.weekdayDay('2027-01-18')}. The raid was not moved.`));
      assert(!stripTags(html(row({ eventSourced: false, eventId: null, eventSyncedAt: null }))).includes('refreshed'), 'a raid without an event says nothing');
      assert(!stripTags(html(row({ eventSyncedAt: null }))).includes('refreshed'), 'and nothing before its first read');
      assertEscaped(html(row({ title: HOSTILE + QUOTES })), 'raids');
    } finally { Date.now = realNow; }
  }));

  await check('ui.agoText: minutes, hours, days; never negative; empty without a moment', () => {
    const NOW = 1_800_000_000_000;
    const ago = (ms) => G.ui.agoText(NOW - ms, NOW);
    assert.deepEqual([ago(0), ago(59 * 1000), ago(60 * 1000), ago(12 * 60000), ago(59 * 60000), ago(60 * 60000), ago(5 * 3600000 + 59000), ago(47 * 3600000), ago(48 * 3600000), ago(100 * 3600000)],
      ['just now', 'just now', '1 min ago', '12 min ago', '59 min ago', '1 h ago', '5 h ago', '47 h ago', '2 days ago', '4 days ago']);
    assert.equal(G.ui.agoText(NOW + 5 * 60000, NOW), 'just now', 'a clock that is ahead');
    assert.equal(G.ui.agoText(null, NOW), '');
    assert.equal(G.ui.agoText(undefined, NOW), '');
    assert.equal(G.ui.agoText(NaN, NOW), '');
  });

  // ═══ Privacy ════════════════════════════════════════════════════
  await check('privacy: Delete my data names the reminder setting, and the page says what Discord posts are, that the webhook address is a secret and how long the log is kept', () => {
    const box = stripTags(G.pages.privacy.deleteBoxHtml({ handOverFirst: [], guildsDeleted: [], autoPromote: [] }, ''));
    assert(box.includes("It deletes your Don't mention me in reminders setting too."));
    const page = stripTags(G.pages.privacy.privacyHtml({ me: null }));
    assert(page.includes('Discord channel posts, only when an officer switches them on'));
    assert(page.includes("The channel's webhook address is a secret: Raidsmith never shows it again, and officers can only replace or remove it."));
    assert(page.includes('It keeps a log of which posts it sent (no text, no names) for 90 days.'));
    assert(page.includes("pings those whose Discord account it knows unless they chose Don't mention me in reminders on Linked accounts"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
