/**
 * Raidsmith guild UI - RAID ZONES (lane U; canvas "Raid zones", concept A for both screens)
 * Run: node tests/guild/guild-zones-ui-tests.js
 *
 *   - New raid: the Zones field is the tiles picker in every mode (no date, past date, today, with an event), up to 3 (the rest dim and cannot be ticked), the count line,
 *     the event hint, Classic / Forever tiles, no Attendance source and no plan field, the create body carries `zones`;
 *   - Raid settings: the same picker, preselected, the source lines, the PATCH body only when the ticked set changed, a past raid too;
 *   - the raid page head on the zone art (1 / 2 / 3 zones, Classic art, Barrow Deeps none) and the art keys' files.
 * Same approach as guild-b3ui-raids-ui-tests.js: the shared script list in a vm, no DOM; handlers run against a stubbed G.api and a fake document.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const ctx = (() => {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const file of ['catalog', 'tbc', 'classic', 'forever']) vm.runInContext(read('js/rules/' + file + '.js'), sandbox); // index.html loads the rules before the guild scripts
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
})();
let els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const count = (s, re) => (s.match(re) || []).length;
const okRes = body => Promise.resolve(body);

function stub(handler) {
  const calls = [];
  const real = ctx.Guild.api;
  ctx.Guild.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { ctx.Guild.api = real; } };
}

const OFFICER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'guild.teams': 'guild' };
const gd = (version) => ({
  guild: { id: 'g1', name: 'Vindicated', realm: 'Dreamscythe', region: 'US', timeZone: 'America/New_York', gameVersion: version || 'tbc', realmKind: 'realm', createdAt: 1 },
  teams: [{ id: 't1', name: 'Team KJ', size: 25, archived: false, players: 3, leads: [] }], me: { roles: [], can: OFFICER_CAN }, attendanceFlags: {},
});

// ═══ New raid ═══════════════════════════════════════════════════════
const BASE = { teamId: 't1', event: '', reports: [''], date: '', time: '19:00', zones: [], title: '', size: '', guestsOpen: false, guestLimit: '' };
const nrHtml = (form, version, today) => G.pages.raidNew.raidNewHtml({ guildData: gd(version), state: { gid: 'g1', form: Object.assign({}, BASE, form), run: null, error: '' }, today: today || '2026-10-26' });
const fieldOf = out => out.slice(out.indexOf('<fieldset class="gs-field gs-zp"'), out.indexOf('</fieldset>', out.indexOf('<fieldset class="gs-field gs-zp"')));

check('New raid: the Zones field is the tiles picker in every mode (no date, past date, today, later date, event), each tile a real checkbox with its art and tier', () => {
  const modes = [{}, { date: '2026-10-10' }, { date: '2026-10-26' }, { date: '2026-11-02' }, { event: '123456' }, { date: '2026-10-10', reports: ['abc'] }];
  for (const form of modes) {
    const out = nrHtml(form);
    const field = fieldOf(out);
    assert(field.length > 100 && !/id="nr-zones-field"[^>]*hidden/.test(out), 'shown: ' + JSON.stringify(form));
    assert.equal(count(field, /<input type="checkbox"[^>]*name="zones"/g), 9, 'the nine TBC zones');
    assert(field.includes('<legend class="gs-label gs-zp-legend">Zones (optional)</legend>') && field.includes('id="nr-zones-help">' + (form.event ? 'Leave empty' : 'Pick up to 3.')));
  }
  const field = fieldOf(nrHtml({}));
  assert(field.includes('<img class="gs-zt-art" src="/icons/raids/kara-sm.webp" alt="" width="192" height="108" loading="lazy">'));
  assert(field.includes('<span class="gs-zt-name">Karazhan</span><span class="gs-zt-tier">Tier 4</span>') && field.includes('<span class="gs-zt-tier">Tier 6</span>'));
  assert(field.includes('name="zones" value="Gruul&#39;s Lair"'), 'the stored value is the canonical name');
  assert(!field.includes('checked') && !field.includes('disabled'));
});

check('New raid: no Attendance source and no Raidsmith plan field; the Warcraft Logs reports fieldset stays (hidden for a future date only); the date label reads the reports', () => {
  for (const form of [{}, { date: '2026-10-10' }, { date: '2026-11-02' }]) {
    const out = nrHtml(form);
    assert(!out.includes('Attendance source') && !out.includes('nr-mode') && !out.includes('enter attendance by hand') && !out.includes('tick who was present'));
    assert(!out.includes('nr-plan') && !out.includes('Raidsmith plan'));
    assert(out.includes('id="nr-reports"') && out.includes('Warcraft Logs reports (optional)'));
  }
  assert(/id="nr-reports"[^>]*hidden/.test(nrHtml({ date: '2026-11-02' })) && !/id="nr-reports"[^>]*hidden/.test(nrHtml({ date: '2026-10-10' })));
  assert(nrHtml({ reports: ['abc'] }).includes('Raid date (optional)') && nrHtml({ event: '1' }).includes('Raid date (optional)') && !nrHtml({}).includes('Raid date (optional)'));
  assert(nrHtml({}).indexOf('id="nr-event"') < nrHtml({}).indexOf('id="nr-zones-field"'));
});

check('New raid: ticked zones are checked; at 3 the others dim and cannot be ticked and the line says untick one; 1 and 2 say N of 3; with an event link and nothing ticked the hint', () => {
  const two = fieldOf(nrHtml({ zones: ['Black Temple', 'Hyjal Summit'] }));
  assert.equal(count(two, / checked/g), 2);
  assert(two.includes('id="nr-zones-help">2 of 3 picked.</p>') && !two.includes('is-off') && !two.includes('disabled'));
  assert(fieldOf(nrHtml({ zones: ['Karazhan'] })).includes('>1 of 3 picked.</p>'));
  const three = fieldOf(nrHtml({ zones: ['Karazhan', 'Black Temple', 'Hyjal Summit'] }));
  assert.equal(count(three, / checked/g), 3);
  assert.equal(count(three, /class="gs-zt is-off"/g), 6, 'the other six dim');
  assert.equal(count(three, / disabled/g), 6);
  assert(three.includes('id="nr-zones-help">3 of 3 picked. Untick one to pick another.</p>'));
  assert(three.includes('<label class="gs-zt is-on"'), 'a ticked tile is marked');
  const hint = fieldOf(nrHtml({ event: 'https://raid-helper.dev/event/123' }));
  assert(hint.includes('>Leave empty to read the zones from the Raid-Helper event title. Or pick up to 3.</p>'));
  assert(fieldOf(nrHtml({ event: '123', zones: ['Karazhan'] })).includes('>1 of 3 picked.</p>'), 'the hint goes once something is ticked');
});

check('New raid: Classic and Forever guilds show their art too; a zone without art (Barrow Deeps) gets a letter tile; no template entries', () => {
  const classic = fieldOf(nrHtml({}, 'classic'));
  assert.equal(count(classic, /name="zones"/g), 7);
  for (const key of ['mc', 'ony', 'bwl', 'zg', 'aq20', 'aq40', 'naxx']) assert(classic.includes('/icons/raids/' + key + '-sm.webp'), key);
  assert(classic.includes('Phase 1') && classic.includes('Phase 6') && !classic.includes('template'));
  const forever = fieldOf(nrHtml({}, 'forever'));
  assert.equal(count(forever, /name="zones"/g), 3);
  assert(forever.includes('/icons/raids/hyjal-sm.webp') && forever.includes('/icons/raids/ony-sm.webp'));
  assert(forever.includes('<span class="gs-zt-art gs-zt-letter" aria-hidden="true">BD</span>') && count(forever, /<img/g) === 2, 'Barrow Deeps: a letter tile, no picture');
});

check('New raid: the create body carries zones (1 to 3, any mode, any date), leaves the key out with none, no plan key, the zone key is gone', () => {
  const body = (f, today) => plain(G.pages.raidNew.createBody(Object.assign({}, BASE, f), false, today));
  assert.deepEqual(body({ date: '2026-10-10', zones: ['Karazhan', 'Gruul\'s Lair'] }, '2026-10-26'), { teamId: 't1', raidOn: '2026-10-10', zones: ['Karazhan', 'Gruul\'s Lair'] });
  assert.deepEqual(body({ date: '2026-10-10' }, '2026-10-26'), { teamId: 't1', raidOn: '2026-10-10' });
  assert.deepEqual(body({ event: '123', zones: ['Black Temple'] }), { teamId: 't1', eventSource: '123', zones: ['Black Temple'] });
  assert.deepEqual(body({ reports: ['AAAAAAAAAAAAAAAA'], zones: ['Black Temple'] }), { teamId: 't1', reportSources: ['AAAAAAAAAAAAAAAA'], zones: ['Black Temple'] });
  assert.deepEqual(body({ date: '2026-11-02', zones: ['A', 'B', 'C', 'D'] }, '2026-10-26').zones, ['A', 'B', 'C']);
  assert.equal(plain(G.pages.raidNew.buildLines(Object.assign({}, BASE, { date: '2026-10-10', reports: ['x', 'y'] }))).length, 1, 'one create step');
});

// A fake picker: a fieldset with inputs whose parentNode is the tile; the handler redraws it in place.
function fakePicker(prefix, names, ticked) {
  const inputs = names.map((name, i) => {
    const tile = { cls: new Set(), classList: { toggle(c, on) { if (on) tile.cls.add(c); else tile.cls.delete(c); } } };
    return { id: prefix + '-zones-' + i, value: name, checked: ticked.indexOf(name) >= 0, disabled: false, parentNode: tile };
  });
  els = {};
  els[prefix + '-zones-field'] = { querySelectorAll: () => inputs };
  els[prefix + '-zones-help'] = { textContent: '' };
  return inputs;
}

check('New raid: ticking works in place - at 3 the unticked tiles are disabled and dimmed, unticking one frees them; the line follows; the form state keeps the ticked names', () => {
  const names = G.zones.zonesFor('tbc');
  const state = { gid: 'g1', form: Object.assign({}, BASE), run: null, error: '' };
  const S = ctx.Guild.app.state; const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds };
  S.att = { nr: state }; S.guilds = { g1: gd() }; S.currentGid = 'g1';
  try {
    const inputs = fakePicker('nr', names, []);
    els['nr-event'] = { value: '' };
    const pick = i => { inputs[i].checked = !inputs[i].checked; G.handlers.change['zone-pick'](inputs[i]); };
    pick(0); pick(6); pick(7);
    assert.deepEqual(inputs.map(i => i.disabled), [false, true, true, true, true, true, false, false, true]);
    assert(inputs[1].parentNode.cls.has('is-off') && !inputs[0].parentNode.cls.has('is-off') && inputs[0].parentNode.cls.has('is-on'));
    assert.equal(els['nr-zones-help'].textContent, '3 of 3 picked. Untick one to pick another.');
    assert.deepEqual(plain(state.form.zones), ['Karazhan', 'Hyjal Summit', 'Black Temple'], 'in tile order');
    pick(6);
    assert.equal(inputs.filter(i => i.disabled).length, 0);
    assert.equal(els['nr-zones-help'].textContent, '2 of 3 picked.');
    pick(0); pick(7);
    assert.equal(els['nr-zones-help'].textContent, 'Pick up to 3.');
    els['nr-event'].value = 'https://raid-helper.dev/event/1';
    G.handlers.input['nr-when']();
    assert.equal(els['nr-zones-help'].textContent, 'Leave empty to read the zones from the Raid-Helper event title. Or pick up to 3.', 'typing the event link shows the hint');
  } finally { Object.assign(S, saved); els = {}; }
});

// ═══ Raid settings ══════════════════════════════════════════════════
const DETAIL = (rover, sources) => ({
  raid: Object.assign({
    id: 'u1', team: { id: 't1', name: 'Team KJ' }, teamId: 't1', raidOn: '2026-11-01', startsAt: Date.UTC(2026, 10, 2, 0, 0), timeKnown: true, upcoming: true, title: null, zone: 'Black Temple + Hyjal Summit',
    zones: ['Black Temple', 'Hyjal Summit'], zoneSource: 'hand', size: 25, sizeOverride: null, closesAt: Date.UTC(2026, 10, 1, 22, 0), closeHours: 2, closeHoursOverride: null, signupsLocked: false,
    state: 'awaiting_log', openFlags: 0, stale: false, version: 1, guestsOpen: false, guestLimit: null,
  }, rover || {}),
  can: { edit: true, review: true, seeAttendance: true, seeNicknames: true }, sources: Object.assign({ event: null, reports: [], plan: null }, sources || {}), pulls: [], people: [], unmatched: [], signups: [],
});
const EVENT = { id: '1483258698854826006', title: 'Team KJ Saturday - BT & Hyjal cleanup', syncedAt: 1760000000000, signups: 3, otherServer: false };
const settingsHtml = (rover, sources, version) => G.pages.raid.settingsDialogHtml(gd(version), DETAIL(rover, sources));

check('Raid settings: Zones is the first field, preselected from raid.zones, the same picker as New raid; a past raid shows it too (deadline and guests stay hidden)', () => {
  const out = settingsHtml();
  assert(out.indexOf('id="rs-zones-field"') > 0 && out.indexOf('id="rs-zones-field"') < out.indexOf('id="rs-size"'), 'first');
  const field = fieldOf(out);
  assert.equal(count(field, /name="zones"/g), 9);
  assert.equal(count(field, / checked/g), 2);
  assert(/value="Black Temple" checked/.test(field) && /value="Hyjal Summit" checked/.test(field) && field.includes('id="rs-zones-help">2 of 3 picked.</p>'));
  assert(field.includes('aria-describedby="rs-zones-help" data-change="zone-pick"'));
  const past = settingsHtml({ upcoming: false, raidOn: '2026-10-10', zones: ['Karazhan'] });
  assert(past.includes('id="rs-zones-field"') && /value="Karazhan" checked/.test(past) && !past.includes('rs-hours-mode') && !past.includes('rs-guests'));
  const three = fieldOf(settingsHtml({ zones: ['Karazhan', 'Black Temple', 'Hyjal Summit'] }));
  assert.equal(count(three, / disabled/g), 6);
  assert(three.includes('Untick one to pick another.'));
  assert(fieldOf(settingsHtml({ zones: [], zoneSource: null })).includes('>Pick up to 3.</p>'));
  assert.equal(count(out, /gs-btn-molten/g), 1, 'one primary: Save settings');
});

check('Raid settings: the source line - event title while the zones follow it; "No zones" after clearing on a raid with an event; nothing otherwise', () => {
  const follow = settingsHtml({ zoneSource: 'event' }, { event: EVENT });
  assert(follow.includes('<p class="gs-fine gs-zp-src">Read from the event title &quot;Team KJ Saturday - BT &amp; Hyjal cleanup&quot;. They keep following it until you change them here.</p>'));
  assert(follow.indexOf('gs-zp-src') > follow.indexOf('rs-zones-help') && follow.indexOf('gs-zp-src') < follow.indexOf('</fieldset>'));
  const cleared = settingsHtml({ zoneSource: 'hand', zones: [] }, { event: EVENT });
  assert(cleared.includes('<p class="gs-fine gs-zp-src">No zones. The event title is not read again.</p>'));
  assert(!settingsHtml({ zoneSource: 'hand' }, { event: EVENT }).includes('gs-zp-src'), 'picked by hand: no line');
  assert(!settingsHtml({ zoneSource: 'hand', zones: [] }).includes('gs-zp-src'), 'cleared on a raid without an event: no line');
  assert(!settingsHtml({ zoneSource: 'log' }, { event: EVENT }).includes('gs-zp-src') && !settingsHtml({ zoneSource: null, zones: [] }, { event: EVENT }).includes('gs-zp-src'));
});

check('Raid settings: Save sends zones only when the ticked set changed (replace, clear with [], a past raid), never when it did not', async () => {
  const S = ctx.Guild.app.state; const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds };
  S.guilds = { g1: gd() }; S.currentGid = 'g1';
  const realBusy = G.ui.setBusy; G.ui.setBusy = () => {};
  const form = (ticked, version) => {
    const names = G.zones.zonesFor(version || 'tbc');
    const inputs = names.map(n => ({ name: 'zones', value: n, checked: ticked.indexOf(n) >= 0 }));
    return { querySelectorAll: () => inputs, elements: { size: { value: '', focus() {} } } };
  };
  const bodies = s => s.calls.filter(c => c.m === 'patch').map(c => c.body);
  const open = rover => { S.att = { raid: { gid: 'g1', rid: 'u1', data: DETAIL(rover), filter: null } }; };
  const slots = () => ['rs-err-size', 'rs-err-hours', 'rs-guests-limit-err', 'rs-error'].forEach(id => { els[id] = { hidden: true, textContent: '', innerHTML: '' }; });
  const s = stub((m) => okRes(m === 'patch' ? DETAIL() : {}));
  try {
    els = {};
    open(); slots();
    G.handlers.submit['raid-settings-form'](form(['Black Temple', 'Hyjal Summit']));
    assert.deepEqual(bodies(s), [], 'the same set: nothing to save');
    G.handlers.submit['raid-settings-form'](form(['Hyjal Summit', 'Black Temple', 'Karazhan']));
    await settle();
    assert.deepEqual(bodies(s), [{ zones: ['Karazhan', 'Hyjal Summit', 'Black Temple'] }], 'tile order');
    s.calls.length = 0; open(); slots();
    G.handlers.submit['raid-settings-form'](form([]));
    await settle();
    assert.deepEqual(bodies(s), [{ zones: [] }], 'cleared = []');
    s.calls.length = 0; open({ upcoming: false, raidOn: '2026-10-10', zones: [], zoneSource: 'log' }); slots();
    G.handlers.submit['raid-settings-form'](form(['Sunwell Plateau']));
    await settle();
    assert.deepEqual(bodies(s), [{ zones: ['Sunwell Plateau'] }], 'a past raid too');
    assert.equal(s.calls[0].url, '/api/guild/g1/raids/u1');
  } finally { s.restore(); G.ui.setBusy = realBusy; Object.assign(S, saved); els = {}; }
});

// ═══ Raid page banner ═══════════════════════════════════════════════
const raidPage = (rover, version) => G.pages.raid.raidHtml({ guildData: gd(version), data: DETAIL(rover) });
const headOf = out => out.slice(out.indexOf('<div class="gs-rz-head'), out.indexOf('</header>') + 9);

check('Raid page: the head sits on the zone art - one zone is the right part, two are halves, three are thirds; -md pictures, the head text and More stay in the head', () => {
  const one = raidPage({ zones: ['Serpentshrine Cavern'], zone: 'Serpentshrine Cavern' });
  assert(one.includes('<div class="gs-rz-head is-1"><div class="gs-rz-art is-1"><img class="gs-hd-artimg" src="/icons/raids/ssc-md.webp" alt="Serpentshrine Cavern" width="480" height="270"></div><div class="gs-rz-scrim"></div><header class="gs-pagehead">'));
  assert(!headOf(one).includes('loading="lazy"'), 'above the fold');
  const two = headOf(raidPage({}));
  assert(two.startsWith('<div class="gs-rz-head is-2"><div class="gs-rz-art is-2">') && two.includes('bt-md.webp') && two.includes('hyjal-md.webp') && count(two, /<img /g) === 2);
  const three = headOf(raidPage({ zones: ['Karazhan', 'Black Temple', 'Hyjal Summit'] }));
  assert(three.startsWith('<div class="gs-rz-head is-3">') && count(three, /<img /g) === 3);
  for (const out of [one, two, three]) {
    assert(out.includes('class="gs-back-link"') && out.includes('id="page-title"') && out.includes('gs-menu-trigger') && out.includes('gs-pagehead-context'), 'the real head, wrapped');
    assert.equal(count(out, /class="gs-rz-head/g), 1);
  }
  assert(two.indexOf('<header') > two.indexOf('gs-rz-scrim') && two.indexOf('</header>') < two.length, 'header after the art');
});

check('Raid page: no zone, or no zone with art, keeps the head exactly as today; Classic art shows; a zone without art among others is a filler half', () => {
  for (const [rover, version] of [[{ zones: [], zone: null, zoneSource: null }], [{ zones: [], zone: 'Mystery' }], [{ zones: ['Barrow Deeps'], zone: 'Barrow Deeps' }, 'forever'], [{ zones: undefined }]]) {
    const out = raidPage(rover, version);
    assert(!out.includes('gs-rz-head') && !out.includes('gs-rz-art') && out.includes('<header class="gs-pagehead">'), JSON.stringify(rover));
  }
  const plainHead = raidPage({ zones: [] });
  assert(plainHead.indexOf('<div class="gs-page gs-object-page') === 0 && plainHead.slice(plainHead.indexOf('<div class="gs-page gs-object-page')).includes('"><header class="gs-pagehead">'.slice(2)), 'the page div, then the header');
  const classic = raidPage({ zones: ['Molten Core', 'Onyxia\'s Lair'], zone: 'Molten Core + Onyxia\'s Lair' }, 'classic');
  assert(classic.includes('mc-md.webp') && classic.includes('ony-md.webp') && classic.includes('gs-rz-head is-2'));
  const mixed = headOf(raidPage({ zones: ['Barrow Deeps', 'Hyjal Summit'], zone: 'Barrow Deeps + Hyjal Summit' }, 'forever'));
  assert(mixed.includes('hyjal-md.webp') && mixed.includes('gs-hd-artimg is-fill') && count(mixed, /<img /g) === 1 && mixed.includes('gs-rz-head is-2'));
  assert.equal(count(raidPage({ zones: ['Black Temple'] }), /gs-btn-molten/g), count(plainHead, /gs-btn-molten/g), 'the banner adds no primary');
});

check('Art: every art key has its -sm and -md file; the Classic keys and the Forever picks resolve; the CSS has the picker and the banner', () => {
  const keys = G.zones.ART_KEYS;
  for (const key of ['kara', 'gruul', 'mag', 'ssc', 'tk', 'hyjal', 'bt', 'za', 'swp', 'mc', 'ony', 'bwl', 'zg', 'aq20', 'aq40', 'naxx']) assert(keys.indexOf(key) >= 0, key);
  for (const key of keys) for (const size of ['sm', 'md']) assert(fs.existsSync(path.join(ROOT, 'icons', 'raids', key + '-' + size + '.webp')), key + '-' + size);
  assert.equal(G.zones.tile('Hyjal Summit').art, 'hyjal');
  assert.equal(G.zones.tile("Onyxia's Lair").art, 'ony');
  assert.deepEqual(plain(G.zones.tile('Barrow Deeps')), { abbr: 'BD', tint: 'other' });
  const css = read('guild.css');
  for (const name of ['Molten Core', "Onyxia's Lair", 'Blackwing Lair', "Zul'Gurub", "Ruins of Ahn'Qiraj", "Temple of Ahn'Qiraj", 'Naxxramas']) assert(css.includes('.gs-hd-tile.is-' + G.zones.tile(name).tint + ' '), name + ' has a tint');
  for (const sel of ['.gs-zp-grid', '.gs-zt.is-on', '.gs-zt.is-off', '.gs-rz-head', '.gs-rz-art.is-1', '.gs-rz-scrim']) assert(css.includes(sel), sel);
});

run();
