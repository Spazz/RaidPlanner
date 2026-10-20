/**
 * Raidsmith guild UI - the Raids tab redesign: the shared menu helper (ui.menuHtml / ui.menu), the raid page header with its one More menu,
 * the source chips, the Attendance board (role columns, extra lines, Needs review list, Unmatched characters), the Raids list header
 * (New raid + More) with its stacked bars, and the tone colours (contrast and lightness).
 * Run: node guild-raidsux-ui-tests.js
 *
 * Same approach as guild-attendance-ui-tests.js: the guild scripts load in a vm with no DOM and the render functions return HTML strings; the menu
 * behaviour runs against a few lines of fake DOM (a tree with closest / querySelector, focus and click counters).
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

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const css = read('guild.css');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, '');

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

// ── fixtures ─────────────────────────────────────────────────────
const T1 = { id: 't1', name: 'Team KJ' };
const OFFICER_CAN = {
  'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild',
  'attendance.policy': 'guild', 'guild.teams': 'guild', 'roster.edit': 'guild',
};
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'] };
function gd(can) {
  return {
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [T1].map(t => ({ id: t.id, name: t.name, size: 25, archived: false, players: 3, leads: [] })),
    me: { roles: [{ role: 'officer' }], can },
    attendanceFlags: {},
  };
}
function prow(id, name, extra) {
  return Object.assign({ playerId: id, name, class: 'DRUID', signup: 'signed', plan: null, pulls: { present: 4, total: 4, missedFirst: false, missedLast: false }, outcome: 'present', credit: 1, pending: false, needsReview: false, flags: [], decision: null }, extra || {});
}
const FULL_SOURCES = {
  event: { id: '1483258698854826006', title: 'Team KJ Saturday - BT', syncedAt: Date.now(), signups: 30, otherServer: false },
  reports: [{ code: 'WaghkY9zwDyvLX7m', flavour: 'fresh', startedAt: 1760000000000, pulls: 4 }, { code: 'h8VAwCFa79Jk1cvf', flavour: 'fresh', startedAt: 1760003000000, pulls: 3 }],
  plan: { label: 'BT run', players: 25 },
};
function detail(over) {
  return Object.assign({
    raid: { id: 'r4', team: 't1', raidOn: '2026-10-17', startsAt: 1, zone: 'Black Temple', size: 25, state: 'reviewed', openFlags: 0, stale: false, version: 1 },
    can: { edit: true, review: true, seeAttendance: true, seeNicknames: true },
    sources: FULL_SOURCES,
    pulls: [{ encounter: 'Illidan', kill: true, startedAt: 1 }, { encounter: 'Illidan', kill: false, startedAt: 2 }, { encounter: 'Illidan', kill: false, startedAt: 3 }, { encounter: 'Illidan', kill: false, startedAt: 4 }],
    people: [
      prow('p_a', 'Alliesha', { class: 'PALADIN', plan: 'G1', role: 'tank' }),
      prow('p_d', 'Daxxter', { class: 'MAGE', role: 'ranged', signup: 'late', plan: 'G5', pulls: { present: 3, total: 4, missedFirst: true, missedLast: false } }),
      prow('p_t', 'Terani', { class: 'MAGE', role: 'ranged', signup: 'tentative', plan: 'bench', outcome: 'bench', pulls: { present: 0, total: 4, missedFirst: false, missedLast: false } }),
      prow('p_x', 'Aimers', { class: 'HUNTER', role: 'ranged', signup: 'absence', outcome: 'missed_notice', credit: 0, pulls: { present: 0, total: 4, missedFirst: false, missedLast: false } }),
      prow('p_n', 'Bearnnaked', { signup: null, outcome: 'no_signup', credit: null, pulls: { present: 0, total: 0, missedFirst: false, missedLast: false } }),
    ],
    unmatched: [],
    signups: [
      { source: 'raid_helper', kind: 'signed', className: 'Paladin', specName: 'Protection1', position: 1, playerId: 'p_a', matched: true, nickname: 'Alli' },
      { source: 'raid_helper', kind: 'late', className: 'Late', specName: 'Arcane', position: 2, playerId: 'p_d', matched: true, nickname: null },
    ],
  }, over || {});
}
const raidPage = (data, over) => G.pages.raid.raidHtml(Object.assign({ guildData: gd(OFFICER_CAN), data }, over || {}));
const lootState = (over) => ({ gid: 'g1', rid: 'r4', status: 'ok', data: { awards: [], canEdit: true }, ui: G.pages.raidLoot.freshUi(), ...(over || {}) });
const rosterState = (over) => ({ status: 'ok', data: Object.assign({ published: false }, over || {}) });
const count = (s, re) => (s.match(re) || []).length;
const opsOf = html => [...html.matchAll(/data-op="([a-z-]+)"/g)].map(m => m[1]);
const actionsOf = html => [...html.matchAll(/data-action="([a-z-]+)"/g)].map(m => m[1]);

// ── a few lines of fake DOM for the menu behaviour ───────────────
const doc = { activeElement: null, nodes: [] };
function node(tag, attrs, kids) {
  const n = { tag, tagName: tag.toUpperCase(), attrs: Object.assign({}, attrs), kids: kids || [], parent: null, hidden: !!(attrs && attrs.hidden), focused: 0, clicks: 0, isConnected: true };
  n.kids.forEach(k => { k.parent = n; });
  n.getAttribute = k => (Object.prototype.hasOwnProperty.call(n.attrs, k) ? n.attrs[k] : null);
  n.setAttribute = (k, v) => { n.attrs[k] = String(v); };
  n.focus = () => { doc.activeElement = n; n.focused++; };
  n.click = () => { n.clicks++; };
  n.closest = sel => { for (let x = n; x; x = x.parent) if (matchesCompound(x, sel)) return x; return null; };
  n.querySelectorAll = sel => descendants(n).filter(x => matchesChain(x, sel));
  n.querySelector = sel => n.querySelectorAll(sel)[0] || null;
  doc.nodes.push(n);
  return n;
}
function descendants(n) { return n.kids.reduce((acc, k) => acc.concat([k], descendants(k)), []); }
function matchesCompound(x, sel) {
  return (sel.match(/\[[^\]]+\]/g) || []).every(part => {
    const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
    return m && x.getAttribute(m[1]) !== null && (m[2] === undefined || x.getAttribute(m[1]) === m[2]);
  });
}
function matchesChain(x, sel) {
  const parts = sel.split(' ');
  if (!matchesCompound(x, parts[parts.length - 1])) return false;
  let at = parts.length - 2;
  for (let up = x.parent; up && at >= 0; up = up.parent) if (matchesCompound(up, parts[at])) at--;
  return at < 0;
}
// root[data-menu] > button[aria-haspopup] + list[role=menu] > items; the same shape ui.menuHtml renders.
function fakeMenu(labels) {
  const items = labels.map(l => node(l === 'Docs' ? 'a' : 'button', { role: 'menuitem', tabindex: '-1', 'data-action': 'x' }));
  const list = node('div', { role: 'menu', hidden: '' }, items);
  list.hidden = true;
  const button = node('button', { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-action': 'menu-toggle' });
  const root = node('div', { 'data-menu': '' }, [button, list]);
  return { root, button, list, items };
}
function openRoots() { return doc.nodes.filter(n => n.getAttribute('aria-haspopup') === 'menu' && n.getAttribute('aria-expanded') === 'true'); }
ctx.document.querySelectorAll = sel => doc.nodes.filter(n => matchesChain(n, sel));
Object.defineProperty(ctx.document, 'activeElement', { get: () => doc.activeElement, configurable: true });
const key = (k, target) => { const ev = { key: k, target, prevented: false, preventDefault() { this.prevented = true; } }; ev.handled = G.ui.menu.keydown(ev); return ev; };
const reset = () => { doc.nodes.length = 0; doc.activeElement = null; };

(async () => {
  // ═══ 1. The shared menu helper: markup ═══
  await check('menuHtml: a real button with aria-haspopup / aria-expanded / aria-controls, a hidden role=menu list, role=menuitem items, a rule and a danger item', () => {
    const out = G.ui.menuHtml({
      id: 'm1', label: 'Actions', key: 'k1',
      items: [{ label: 'Recalculate', data: { action: 'raid-op', op: 'recompute' }, key: 'mi-r' }, { label: 'Docs', href: '#/docs' }, { separator: true }, { label: 'Delete raid', danger: true, data: { action: 'raid-op', op: 'raid-delete' } }, null],
    });
    assert(/<div class="gs-menu-wrap" data-menu><button type="button" class="gs-btn gs-menu-trigger" id="m1" data-action="menu-toggle" data-key="k1" aria-haspopup="menu" aria-expanded="false" aria-controls="m1-list"><span>Actions<\/span><svg/.test(out), out.slice(0, 400));
    assert(/<div class="gs-menu gs-menu-list" id="m1-list" role="menu" aria-labelledby="m1" hidden>/.test(out));
    assert(out.includes('<button type="button" class="gs-menu-item" role="menuitem" tabindex="-1" data-action="raid-op" data-op="recompute" data-key="mi-r">Recalculate</button>'));
    assert(out.includes('<a class="gs-menu-item" role="menuitem" tabindex="-1" href="#/docs">Docs</a>'));
    assert(out.includes('<div class="gs-menu-sep" role="separator"></div>') && out.includes('class="gs-menu-item is-danger"'));
    assert.equal((out.match(/role="menuitem"/g) || []).length, 3, 'the null entry is skipped');
    assertNoRawAttrs(out);
  });

  await check('menuHtml: an icon-only trigger needs an aria-label; no items, or only rules, renders nothing; left alignment; labels, hrefs and data values are escaped', () => {
    const icon = G.ui.menuHtml({ id: 'm2', icon: 'more', ariaLabel: 'Plan actions', triggerClass: 'gs-btn gs-btn-sm', items: [{ label: 'Replace', data: { action: 'a' } }] });
    assert(/<button type="button" class="gs-btn gs-btn-sm gs-menu-trigger is-icon" id="m2"[^>]*aria-label="Plan actions"><svg/.test(icon) && !icon.includes('<span>'));
    assert.equal(G.ui.menuHtml({ id: 'm3', label: 'x', items: [] }), '');
    assert.equal(G.ui.menuHtml({ id: 'm3', label: 'x', items: [{ separator: true }, null] }), '');
    assert.equal(G.ui.menuHtml({ label: 'x', items: [{ label: 'a' }] }), '', 'no id, no menu');
    assert(G.ui.menuHtml({ id: 'm4', label: 'x', align: 'left', items: [{ label: 'a' }] }).includes('gs-menu-list is-left'));
    const bad = G.ui.menuHtml({ id: 'm5', label: HOSTILE, ariaLabel: QUOTES, items: [{ label: HOSTILE, href: QUOTES }, { label: QUOTES, data: { action: QUOTES, 'on click': 'x', Bad: 'y' }, key: QUOTES }] });
    assertEscaped(bad, 'menu');
    assert(!bad.includes('on click') && !bad.includes('data-Bad') && !bad.includes('data-bad'), 'only lowercase data names pass');
    assertNoRawAttrs(bad);
  });

  // ═══ 2. The shared menu helper: behaviour ═══
  await check('menu: the button click (Enter / Space) opens it, shows the list, flips aria-expanded and focuses the first item; a second click closes it with focus on the button', () => {
    reset();
    const m = fakeMenu(['A', 'B', 'C']);
    G.handlers.click['menu-toggle'](m.button);
    assert.equal(m.list.hidden, false);
    assert.equal(m.button.getAttribute('aria-expanded'), 'true');
    assert.equal(doc.activeElement, m.items[0]);
    G.handlers.click['menu-toggle'](m.button);
    assert.equal(m.list.hidden, true);
    assert.equal(m.button.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.activeElement, m.button);
  });

  await check('menu: ArrowDown / ArrowUp on the button open it at the first / last item; arrows wrap inside; Home / End jump; every key is kept from the page', () => {
    reset();
    const m = fakeMenu(['A', 'B', 'C']);
    let ev = key('ArrowDown', m.button);
    assert(ev.handled && ev.prevented && m.list.hidden === false && doc.activeElement === m.items[0]);
    ev = key('ArrowDown', m.items[0]); assert(ev.handled && ev.prevented && doc.activeElement === m.items[1]);
    key('ArrowDown', m.items[1]); assert.equal(doc.activeElement, m.items[2]);
    key('ArrowDown', m.items[2]); assert.equal(doc.activeElement, m.items[0], 'wraps to the top');
    key('ArrowUp', m.items[0]); assert.equal(doc.activeElement, m.items[2], 'wraps to the bottom');
    key('Home', m.items[2]); assert.equal(doc.activeElement, m.items[0]);
    key('End', m.items[0]); assert.equal(doc.activeElement, m.items[2]);
    G.handlers.click['menu-toggle'](m.button); // closed
    ev = key('ArrowUp', m.button);
    assert(ev.handled && m.list.hidden === false && doc.activeElement === m.items[2], 'ArrowUp on the closed button opens at the last item');
    ev = key('a', m.items[2]);
    assert(!ev.handled && !ev.prevented, 'other keys are left alone');
  });

  await check('menu: Escape closes the open menu and returns focus to its button; with no menu open it is not ours', () => {
    reset();
    const m = fakeMenu(['A', 'B']);
    assert.equal(key('Escape', m.button).handled, false, 'nothing open: the account menu and dialogs keep Escape');
    G.handlers.click['menu-toggle'](m.button);
    const ev = key('Escape', m.items[0]);
    assert(ev.handled && ev.prevented);
    assert.equal(m.list.hidden, true);
    assert.equal(m.button.getAttribute('aria-expanded'), 'false');
    assert.equal(doc.activeElement, m.button);
  });

  await check('menu: Tab inside closes it and lets the focus move on; Space on a link item follows the link', () => {
    reset();
    const m = fakeMenu(['A', 'Docs']);
    G.handlers.click['menu-toggle'](m.button);
    const space = key(' ', m.items[1]);
    assert(space.handled && space.prevented && m.items[1].clicks === 1, 'Space clicks a link item');
    const buttonItem = key(' ', m.items[0]);
    assert(!buttonItem.handled && m.items[0].clicks === 0, 'a button item takes Space natively');
    const tab = key('Tab', m.items[0]);
    assert(!tab.handled && !tab.prevented, 'Tab is not stopped');
    assert.equal(m.list.hidden, true);
  });

  await check('menu: a click outside closes every open menu; a click inside its own menu keeps it; opening a second closes the first; an item click closes its menu with focus on the button', () => {
    reset();
    const a = fakeMenu(['A1', 'A2']);
    const b = fakeMenu(['B1']);
    const outside = node('p', {});
    G.handlers.click['menu-toggle'](a.button);
    G.ui.menu.outsideClick({ target: a.items[1] });
    assert.equal(a.list.hidden, false, 'inside its own menu');
    G.ui.menu.outsideClick({ target: outside });
    assert.equal(a.list.hidden, true);
    assert.equal(openRoots().length, 0);
    G.handlers.click['menu-toggle'](a.button);
    G.handlers.click['menu-toggle'](b.button);
    assert(a.list.hidden && !b.list.hidden && openRoots().length === 1, 'one menu at a time');
    G.ui.menu.itemClick({ target: b.items[0] });
    assert(b.list.hidden && b.button.getAttribute('aria-expanded') === 'false');
    assert.equal(doc.activeElement, b.button, 'focus is back on the button before the item\'s action runs');
    G.ui.menu.itemClick({ target: outside });
    G.ui.menu.outsideClick(null);
  });

  await check('menu: a dialog opened from an item returns focus to the menu button (the item is hidden again by then)', () => {
    reset();
    const m = fakeMenu(['A']);
    const dialogs = [];
    const host = { appendChild: d => dialogs.push(d) };
    ctx.HTMLDialogElement = function HTMLDialogElement() {};
    const savedGet = ctx.document.getElementById;
    const savedCreate = ctx.document.createElement;
    ctx.document.getElementById = id => (id === 'guild-dialogs' ? host : null);
    ctx.document.createElement = () => { const d = { listeners: {}, attrs: {}, className: '', setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.listeners[t] = f; }, remove() {}, showModal() {} }; return d; };
    const savedLast = G.app.lastActionEl;
    try {
      G.app.lastActionEl = m.items[0];
      const dlg = G.ui.openDialog('<p>x</p>', {});
      assert(dlg && dialogs.length === 1);
      const before = m.button.focused;
      dlg.listeners.close();
      assert.equal(m.button.focused, before + 1);
      assert.equal(doc.activeElement, m.button);
    } finally {
      G.app.lastActionEl = savedLast;
      ctx.document.getElementById = savedGet;
      ctx.document.createElement = savedCreate;
      delete ctx.HTMLDialogElement;
    }
  });

  await check('menu: app.js hands the keys, the outside click and the item click to the helper', () => {
    const app = read('js/guild/app.js');
    assert(/function onKeydown\(ev\) \{\n    if \(G\.ui\.menu\.keydown\(ev\)\) return;/.test(app));
    assert(/G\.ui\.menu\.outsideClick\(ev\);/.test(app) && /G\.ui\.menu\.itemClick\(ev\);/.test(app));
    assert(/addEventListener\('click', onClickCapture, true\)/.test(app) && /addEventListener\('keydown', onKeydown\)/.test(app));
  });

  // ═══ 3. The raid page: header and More menu ═══
  await check('raid page: the header is the title, one context line (bosses, attended / missed, items) and ONE chip, and ONE More button; the Change menus are the facts\' own', () => {
    const out = raidPage(detail(), { loot: lootState(), roster: rosterState() });
    assert(/<h1 class="gs-h1" id="page-title" tabindex="-1">Sat Oct 17 - Black Temple<\/h1>/.test(out));
    const line = out.slice(out.indexOf('gs-pagehead-context'), out.indexOf('</p>', out.indexOf('gs-pagehead-context')));
    assert(line.includes('1 kill, 3 wipes') && line.includes('2 attended, 1 missed') && !line.includes('bench'), line);
    assert.equal((out.slice(0, out.indexOf('id="raid-people"')).match(/class="gs-hd-chip /g) || []).length, 1, 'ONE chip in the head (the board has its own chips)');
    assert(out.includes('<span class="gs-hd-chip is-grey">Reviewed</span>') || out.includes('<span class="gs-hd-chip is-green">Complete</span>'), 'the state chip sits beside the title');
    assert.equal((out.match(/data-action="menu-toggle"/g) || []).length, 1 + 3, 'the More button and the Change menus of the event, the plan and the log');
    assert(/<button type="button" class="gs-btn gs-menu-trigger has-phone-icon" id="raid-actions"[^>]*aria-haspopup="menu" aria-expanded="false"[^>]*aria-label="More"[^>]*><span class="gs-menu-text">More<\/span>/.test(out), 'one labelled More button (a dots button on a phone)');
    assert(!/<button(?![^>]*role="menuitem")[^>]*>(Recalculate|Delete raid|Plan in Planner|Mark as No log)<\/button>/.test(out), 'no loose action buttons in the header');
    assert(!out.includes('gs-roster-actions') && !out.includes('gs-btn-danger-outline'));
    assertNoRawAttrs(out);
  });

  await check('raid page: the More menu holds the page-level items for a past raid - Open in Planner, Recalculate, Raid settings, the loot items - and Delete raid (danger, after a rule)', () => {
    const out = raidPage(detail(), { loot: lootState(), roster: rosterState() });
    const menu = out.slice(out.indexOf('id="raid-actions-list"'), out.indexOf('</div></div>', out.indexOf('id="raid-actions-list"')));
    const labels = [...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(labels, ['Open in Planner', 'Recalculate attendance', 'Raid settings', 'Import loot from Gargul', 'Add loot award', 'Delete raid'], 'Open in Planner is first');
    assert(menu.indexOf('gs-menu-sep') > menu.indexOf('Add loot award') && menu.indexOf('gs-menu-sep') < menu.indexOf('Delete raid'), 'Delete raid sits after a rule, alone in its group');
    assert(/class="gs-menu-item is-danger"[^>]*data-op="raid-delete"/.test(menu));
    assert(menu.includes('data-action="loot-import-open"') && menu.includes('data-op="plan-in-planner"') && menu.includes('data-op="recompute"') && menu.includes('data-op="settings"'));
    assert(!menu.includes('Mark as No log'), 'a raid with reports is not marked No log');
    assert(!menu.includes('Publish line-up') && !menu.includes('Set raid duties'), 'Publish line-up and the duties are in the Raid facts panel');
  });

  await check('raid page: Mark as No log is offered only without a log; Import loot only when the loot card would offer it; Publish line-up is no longer in More (it is the next-step primary and in the Line-up Change menu)', () => {
    const awaiting = detail({ raid: Object.assign(detail().raid, { state: 'awaiting_log' }), people: [], sources: { event: null, reports: [], plan: null } });
    assert(raidPage(awaiting, { loot: lootState() }).includes('Mark as No log'));
    assert(!raidPage(detail(), {}).includes('Import loot from Gargul'), 'loot not loaded: not offered');
    assert(!raidPage(detail(), { loot: lootState({ data: { awards: [], canEdit: false } }) }).includes('Import loot from Gargul'));
    const open = lootState(); open.ui.open = true;
    assert(!raidPage(detail(), { loot: open }).includes('>Import loot from Gargul<'), 'the import panel is already open');
    const up = detail({ raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: null, zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 }, people: [], pulls: [], signups: [] });
    const publish = raidPage(up, { roster: rosterState() });
    assert(!publish.includes('data-key="mi-ro-publish"'), 'not in More');
    assert(/data-action="roster-publish" data-op="publish" data-key="fi-publish">Publish line-up</.test(publish), 'in the Line-up fact menu');
    assert(publish.includes('data-key="ns-primary"') && publish.includes('Publish the line-up'), 'and it is the next-step primary');
    assert(!raidPage(up, { roster: rosterState({ published: true }) }).includes('data-op="publish"'), 'already published');
    assert(!raidPage(Object.assign({}, up, { sources: Object.assign({}, FULL_SOURCES, { plan: null }) }), { roster: rosterState() }).includes('data-op="publish"'), 'no plan');
    assert(!raidPage(up, {}).includes('data-op="publish"'), 'roster not loaded');
    assert(!raidPage(up, { roster: rosterState() }).includes('Recalculate'), 'an upcoming raid has nothing to recalculate');
    assert(raidPage(up, { roster: rosterState() }).includes('Delete raid'));
  });

  await check('raid page: a member gets no More menu and no Change menus; the Raid facts still say what is linked', () => {
    const member = detail({ people: null, can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } });
    const out = raidPage(member, { guildData: gd(MEMBER_CAN) });
    assert(!out.includes('menu-toggle') && !out.includes('data-op=') && !out.includes('Delete raid') && !out.includes('role="menu"') && !out.includes('>Change<'));
    assert(out.includes('<dt>Sign-ups</dt>') && out.includes('Warcraft Logs - 2 reports, 7 pulls') && out.includes('BT run, 25 players'));
  });

  // ═══ 4. The source chips ═══
  // ═══ 4. The Raid facts menus ═══
  await check('Raid facts (past raid, officer): the event, plan and log rows each have a Change menu with that fact\'s actions, the same ops as before', () => {
    const out = raidPage(detail(), {});
    assert.equal(count(out, /class="gs-rpg-fact"/g), 5, 'Sign-ups, Plan, Line-up, Log, Duties');
    for (const label of ['Change sign-ups source', 'Plan settings', 'Change log']) assert(out.includes('aria-label="' + label + '"'), label);
    assert(out.includes('<span class="gs-rpg-v">30 signed</span>') || out.includes('<span class="gs-rpg-v">'), 'the sign-ups row');
    assert(out.includes('Warcraft Logs - 2 reports, 7 pulls') && out.includes('BT run, 25 players'));
    const listOf = id => out.slice(out.indexOf('id="' + id + '-list"'), out.indexOf('</div></div>', out.indexOf('id="' + id + '-list"')));
    const eventMenu = listOf('fact-event');
    assert.deepEqual(opsOf(eventMenu), ['event-refresh', 'event-replace', 'event-remove']);
    assert(/is-danger"[^>]*data-op="event-remove"/.test(eventMenu));
    const logsMenu = listOf('fact-log');
    assert.deepEqual(opsOf(logsMenu), ['report-refresh', 'report-remove', 'report-refresh', 'report-remove', 'report-add']);
    assert(logsMenu.includes('data-code="WaghkY9zwDyvLX7m"') && logsMenu.includes('data-code="h8VAwCFa79Jk1cvf"') && logsMenu.includes('>Refresh h8VAwCFa79Jk1cvf<') && logsMenu.includes('>Remove WaghkY9zwDyvLX7m<'));
    const planMenu = listOf('fact-plan');
    assert.deepEqual(opsOf(planMenu), ['plan-in-planner', 'plan-replace', 'plan-remove']);
    assert(!out.includes('gs-srcstrip') && !out.includes('class="gs-src"') && !out.includes('gs-source'), 'the chip strips are gone');
  });

  await check('Raid facts: an empty source says so and its menu offers the one way in; a hand-entered raid takes no report; nothing sits in a menu that has no actions', () => {
    const none = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'awaiting_log' }), people: [], sources: { event: null, reports: [], plan: null } }), {});
    assert(none.includes('<dt>Sign-ups</dt><dd><span class="gs-rpg-v">None</span>') && none.includes('<span class="gs-rpg-v">Skipped</span>') && none.includes('<dt>Log</dt><dd><span class="gs-rpg-v">None</span>'));
    const listOf = (out, id) => out.slice(out.indexOf('id="' + id + '-list"'), out.indexOf('</div></div>', out.indexOf('id="' + id + '-list"')));
    assert.deepEqual(opsOf(listOf(none, 'fact-event')), ['event-replace']);
    assert(listOf(none, 'fact-event').includes('>Link an event<'));
    assert.deepEqual(opsOf(listOf(none, 'fact-log')), ['report-add', 'manual-open']);
    assert(listOf(none, 'fact-log').includes('>Mark attendance by hand<'));
    assert.deepEqual(opsOf(listOf(none, 'fact-plan')), ['plan-in-planner', 'plan-replace']);
    assert(listOf(none, 'fact-plan').includes('>Link a plan<'));
    const manual = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'manual', manual: { reason: 'Nobody uploaded', by: 'Officer', at: 1 } }), sources: { event: null, reports: [], plan: null } }), {});
    assert(!manual.includes('data-op="report-add"') && manual.includes('Entered by hand by Officer'));
    assert.deepEqual(opsOf(listOf(manual, 'fact-log')), ['manual-edit', 'manual-remove']);
    const manualWithLog = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'manual', manual: { reason: 'x', by: 'Officer', at: 1 } }) }), {});
    assert(!manualWithLog.includes('data-op="report-add"'), 'no Add report in the log menu of a hand-entered raid');
  });


  await check('every existing raid action is still reachable: the full set of ops sits in the More menu or a source menu, with its permission gate', () => {
    const awaiting = detail({ raid: Object.assign(detail().raid, { state: 'awaiting_log' }), people: [], sources: { event: FULL_SOURCES.event, reports: [], plan: FULL_SOURCES.plan } });
    const all = new Set([...opsOf(raidPage(detail(), { loot: lootState() })), ...opsOf(raidPage(awaiting, { loot: lootState() }))]);
    for (const op of ['recompute', 'manual-open', 'plan-in-planner', 'raid-delete', 'event-refresh', 'event-replace', 'event-remove', 'report-refresh', 'report-remove', 'report-add', 'plan-replace', 'plan-remove']) assert(all.has(op), op + ' is reachable');
    const manual = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'manual', manual: { reason: 'Nobody uploaded', by: 'Officer', at: 1 } }), sources: { event: null, reports: [], plan: null } }), {});
    assert(opsOf(manual).includes('manual-edit') && opsOf(manual).includes('manual-remove'), 'the hand-entered notice keeps Edit / Remove');
    assert(actionsOf(raidPage(detail(), { loot: lootState() })).includes('loot-import-open'));
    const up = detail({ raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: null, zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 }, people: [], pulls: [], signups: [] });
    const upOps = opsOf(raidPage(up, { roster: rosterState() }));
    for (const op of ['plan-in-planner', 'raid-delete', 'event-refresh', 'event-replace', 'event-remove', 'plan-replace', 'plan-remove']) assert(upOps.includes(op), 'upcoming: ' + op);
    assert(actionsOf(raidPage(up, { roster: rosterState() })).includes('roster-publish'));
    assert(!upOps.includes('report-add') && !upOps.includes('recompute'), 'an upcoming raid has no log');
  });

  await check('upcoming raid: the head has the day and the raid\'s title, the green Sign-ups open chip and the time; the Raid facts sit in the side column beside the Sign-ups', () => {
    const up = detail({ raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: 'Prog night', zone: 'Black Temple', size: 25, state: 'awaiting_log', openFlags: 0, stale: false, version: 1 }, people: [], pulls: [], signups: [] });
    const out = raidPage(up, { roster: rosterState() });
    assert(out.includes('>Sat Oct 24 - Prog night</h1>') && out.includes('<span class="gs-hd-chip is-green">Sign-ups open</span>') && out.includes('<span>Black Temple, 25-player</span>'));
    assert(out.indexOf('class="gs-rpg-main"') < out.indexOf('class="gs-rpg-side"') && out.indexOf('class="gs-rpg-side"') < out.indexOf('id="raid-facts"'), 'the facts are the side column');
    assert(!out.includes('Opens when the raid starts at '), 'no locked After the raid card');
    assert(!out.includes('data-src="logs"') && !out.includes('<dt>Log</dt>'), 'no Warcraft Logs fact before the raid');
    assertNoRawAttrs(out);
  });

  // ═══ 5. The Attendance board (lane 3b) ═══
  const panelOf = out => { const k = out.indexOf('id="raid-people"'); return out.slice(k, k + out.slice(k).indexOf('</div></section>')); };
  const colOf = (out, title) => { const p = panelOf(out); const k = p.indexOf('aria-label="' + title + '"'); return k < 0 ? '' : p.slice(k); };
  const lineOf = (out, title) => { const p = panelOf(out); const k = p.indexOf('<span class="gs-fg-ght">' + title + '</span>'); return k < 0 ? '' : p.slice(k, p.indexOf('</ul>', k)); };
  const rowOf = (out, name) => panelOf(out).split('<li class="gs-rb-row').find(r => r.includes('>' + name + '<')) || '';
  const withSignups = (me) => ({ status: 'ok', data: { entries: [], can: { edit: false, seeList: true }, raid: {}, me: me ? { personId: me } : null } });
  const board = (over, opts) => raidPage(detail(over), Object.assign({ filter: 'all' }, opts || {}));

  await check('attendance board: the Attendance panel keeps id raid-people; head has the title, "N attended", the muted bosses line and the Needs review / Everyone switch', () => {
    const out = board();
    assert(out.includes('<section class="gs-hd-panel gs-rb gs-rba" id="raid-people"') && out.includes('>Attendance</h2>'));
    assert(!out.includes('Log and attendance') && !out.includes('Open review queue'));
    assert(out.includes('<span class="gs-rb-fig">2 <span class="gs-rb-of">attended</span></span>'));
    assert(out.includes('<span class="gs-rb-mut">') && /aria-pressed="false">Needs review <span class="gs-seg-count">0</.test(out) && /aria-pressed="true">Everyone <span class="gs-seg-count">5</.test(out));
    assert(!out.includes('gs-table-raidpeople') && !out.includes('gs-pcard') && !out.includes('gs-pullbar') && !out.includes('gs-classbadge'), 'the old table, cards, pull bars and class badges are gone');
  });

  await check('attendance board: four role columns with gold heads and counts, A-Z rows with spec icon, name and muted spec; grey chips only for non-default outcomes', () => {
    const out = board();
    for (const t of ['Tanks', 'Healers', 'Melee', 'Ranged']) assert(panelOf(out).includes('<span class="gs-fg-ght">' + t + '</span>'), t);
    assert(colOf(out, 'Tanks').includes('<span class="gs-fg-ghn">1</span>') && colOf(out, 'Ranged').includes('<span class="gs-fg-ghn">2</span>') && colOf(out, 'Healers').includes('<span class="gs-fg-ghn">0</span>'));
    const ranged = colOf(out, 'Ranged');
    assert(ranged.indexOf('>Daxxter<') < ranged.indexOf('>Terani<'), 'A-Z');
    const alli = rowOf(out, 'Alliesha');
    assert(alli.includes('class="gs-spec-icon"') && alli.includes('<span class="gs-rb-sp">Protection</span>') && !alli.includes('gs-rb-chips'), 'a plain Attended row has no chip: ' + alli);
    assert(rowOf(out, 'Terani').includes('<span class="gs-hd-chip is-grey">Bench</span>'));
    const outs = detail({ people: ['late', 'left_early', 'late_left', 'fill_in'].map((o, i) => prow('p' + i, 'N' + i, { outcome: o, role: 'melee' })) });
    const lo = raidPage(outs, { filter: 'all' });
    assert(rowOf(lo, 'N0').includes('>Late<') && rowOf(lo, 'N1').includes('>Left early<') && rowOf(lo, 'N2').includes('>Late + left<') && !rowOf(lo, 'N3').includes('gs-hd-chip'), 'chips: Late, Left early, Late + left; Other team none');
    assert(colOf(lo, 'Melee').includes('<span class="gs-fg-ghn">4</span>'));
    assertNoRawAttrs(out);
  });

  await check('attendance board: Missed, Not counted, No role and any other outcome get a line with an inline gold head; every person appears exactly once', () => {
    const people = [
      prow('p1', 'Aa', { role: 'tank' }), prow('p2', 'Bb', { role: null }), prow('p3', 'Cc', { role: 'ranged', outcome: 'missed', credit: 0 }), prow('p4', 'Dd', { role: 'melee', outcome: 'missed_notice', credit: 0 }),
      prow('p5', 'Ee', { role: 'healer', outcome: 'no_signup', signup: null }), prow('p6', 'Ff', { role: 'healer', outcome: 'tentative' }), prow('p7', 'Gg', { role: 'melee', outcome: 'odd_new' }),
    ];
    const out = raidPage(detail({ people: people }), { filter: 'all' });
    assert(lineOf(out, 'No role').includes('>Bb<') && lineOf(out, 'No role').includes('<span class="gs-fg-ghn">1</span>'));
    const missed = lineOf(out, 'Missed');
    assert(missed.includes('<span class="gs-fg-ghn">2</span>') && missed.includes('>Cc<') && missed.includes('>Dd<') && missed.includes('<span class="gs-rb-mut">(with notice)</span>') && (missed.match(/with notice/g) || []).length === 1);
    assert(lineOf(out, 'Not counted').includes('>Ee<') && lineOf(out, 'Tentative').includes('>Ff<') && lineOf(out, 'odd_new').includes('>Gg<'), 'other outcomes keep a line with today\'s label');
    for (const n of ['Aa', 'Bb', 'Cc', 'Dd', 'Ee', 'Ff', 'Gg']) assert.equal((panelOf(out).match(new RegExp('>' + n + '<', 'g')) || []).length, 1, n + ' once');
    assert(!out.includes('Missed with notice'), 'the notice is a per-name note');
  });

  await check('attendance board: the later-joiner note stays, and Everyone leaves the later joiner out', () => {
    const people = [prow('p1', 'Aa', { role: 'tank' }), prow('p2', 'Latecomer', { role: 'melee', joinedAfter: true, signup: null, pulls: { present: 0, total: 4, missedFirst: false, missedLast: false } })];
    const out = raidPage(detail({ people: people }), { filter: 'all' });
    assert(out.includes('id="raid-later-note"') && out.includes('1 person who joined the guild after this raid is not listed.') && !panelOf(out).includes('>Latecomer<'));
  });

  await check('attendance board: names are buttons for a reviewer (Decide on a flagged row, Change outcome on the others), links for attendance.view, plain otherwise; a flagged row has a rose chip', () => {
    const people = [prow('p1', 'Aa', { role: 'tank' }), prow('p2', 'Flagged', { role: 'melee', outcome: 'late', credit: null, pending: true, needsReview: true, flags: ['late'] })];
    const out = raidPage(detail({ people: people }), { filter: 'all' });
    const a = rowOf(out, 'Aa'), f = rowOf(out, 'Flagged');
    assert(a.includes('<button type="button" class="gs-rb-id gs-rb-btn" data-action="decide-open"') && a.includes('data-pid="p1"') && a.includes('data-where="raid"') && a.includes('aria-label="Change outcome for Aa"'));
    assert(f.includes('aria-label="Decide for Flagged"') && f.includes('<span class="gs-hd-chip is-rose">Needs review</span>') && f.includes('>Late<'));
    const viewer = raidPage(detail({ people: people, can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), { filter: 'all' });
    assert(!viewer.includes('decide-open') && rowOf(viewer, 'Aa').includes('class="gs-char-link gs-class-druid" href="#/g/g1/') && rowOf(viewer, 'Aa').includes('<span class="gs-rb-id">'));
    const plain = raidPage(detail({ people: people, can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } }), { filter: 'all' });
    assert(!plain.includes('gs-char-link') && !plain.includes('decide-open') && rowOf(plain, 'Aa').includes('<span class="gs-char-name gs-class-druid">Aa</span>'));
  });

  await check('attendance board: the viewer\'s row is tinted and tagged You in its A-Z place', () => {
    const out = raidPage(detail(), { filter: 'all', signups: withSignups('p_d') });
    assert(panelOf(out).includes('<li class="gs-rb-row is-you" data-pid="p_d">'));
    assert(rowOf(out, 'Daxxter').includes('<span class="gs-you">You</span>') && !rowOf(out, 'Alliesha').includes('gs-you'));
    assert(!board().includes('gs-you'), 'no viewer, no tag');
  });

  await check('attendance board: Needs review shows a short list (icon, name button, grey provisional outcome, evidence, Decide) instead of the columns; empty keeps its text', () => {
    const people = [prow('p1', 'Aa', { role: 'tank' }), prow('p2', 'Flagged', { role: 'melee', outcome: 'late', credit: null, pending: true, needsReview: true, flags: ['late'], signup: 'signed', pulls: { present: 3, total: 12, missedFirst: true, missedLast: false } }),
      prow('p3', 'Gone', { role: 'ranged', outcome: 'missed', credit: null, pending: true, needsReview: true, flags: ['no_show'], pulls: { present: 0, total: 0, missedFirst: false, missedLast: false } })];
    const out = raidPage(detail({ people: people }), {});
    assert(/aria-pressed="true">Needs review <span class="gs-seg-count">2</.test(out), 'default view while anything is flagged');
    const p = panelOf(out);
    assert(!p.includes('gs-rb-cols') && !p.includes('>Aa<'));
    const f = rowOf(out, 'Flagged');
    assert(f.includes('<span class="gs-hd-chip is-grey">Late</span>') && f.includes('In 3 of 12 pulls, missed the first pull') && f.includes('data-key="decide-btn-p2"') && f.includes('>Decide</button>'));
    assert(rowOf(out, 'Gone').includes('Signed up, not in the log') && rowOf(out, 'Gone').includes('>Missed<'));
    const empty = raidPage(detail(), { filter: 'review' });
    assert(panelOf(empty).includes('Nothing needs review on this raid.'));
    const noReview = raidPage(detail({ people: people, can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), {});
    assert(!noReview.includes('>Decide</button>'));
  });

  await check('attendance board: no access and no people keep today\'s texts', () => {
    assert(raidPage(detail({ people: null }), {}).includes("Attendance for this raid is visible to the team's members."));
    assert(raidPage(detail({ people: [] }), {}).includes('No one is on this raid yet.'));
  });

  await check('unmatched characters: a panel under the board with class-coloured name, evidence and the three actions; viewers see it without the buttons', () => {
    const unm = [{ key: 'k1', name: 'Zorgax', class: 'PRIEST', realm: null, pullsPresent: 4 }];
    const out = raidPage(detail({ unmatched: unm }), { filter: 'all' });
    const k = out.indexOf('id="unm-h"');
    assert(k > out.indexOf('id="raid-people"') && out.includes('>Unmatched characters</h2>'));
    const u = out.slice(k, out.indexOf('</section>', k));
    assert(u.includes('gs-class-priest">Zorgax') && u.includes('Priest, in 4 pulls, no linked person'));
    for (const act of ['unm-link', 'unm-person', 'unm-guest']) assert(u.includes('data-action="' + act + '"'), act);
    assert(u.includes('Link to person...') && u.includes('Add as new person...') && u.includes('Mark as guest'));
    const viewer = raidPage(detail({ unmatched: unm, can: { edit: false, review: false, seeAttendance: true, seeNicknames: false } }), {});
    assert(viewer.includes('Zorgax') && !viewer.includes('unm-link'));
    assert(!raidPage(detail(), {}).includes('Unmatched characters'));
  });

  await check('attendance board: hostile names, specs, classes and outcomes are escaped', () => {
    const bad = detail({ people: [prow('p_x', HOSTILE + QUOTES, { role: 'melee', class: HOSTILE, signup: HOSTILE, plan: HOSTILE, outcome: HOSTILE, flags: [HOSTILE] })], signups: [{ source: 'raid_helper', kind: 'signed', className: HOSTILE, specName: HOSTILE, playerId: 'p_x', nickname: HOSTILE + QUOTES }], unmatched: [{ key: 'k', name: HOSTILE + QUOTES, class: HOSTILE, realm: HOSTILE, pullsPresent: 1 }] });
    assertEscaped(raidPage(bad, { filter: 'all' }), 'people');
    assertEscaped(raidPage(bad, { filter: 'review' }), 'review list');
    assertEscaped(raidPage(detail({ sources: { event: { id: '1', title: HOSTILE + QUOTES, syncedAt: 1, signups: 1, otherServer: true }, reports: [{ code: HOSTILE, pulls: 1 }], plan: { label: QUOTES, players: 2 } } }), {}), 'source chips');
  });

  // ═══ 6. The Raids list ═══
  const RAIDS = [
    { id: 'r4', raidOn: '2026-10-17', zone: 'Black Temple', bosses: { kills: 1, pulls: 4 }, sources: { event: true, reports: 1, plan: false }, counts: { present: 24, bench: 1, missed: 5 }, openFlags: 0, state: 'reviewed', stale: false },
    { id: 'r3', raidOn: '2026-10-10', zone: 'BT / Hyjal', bosses: { kills: 1, pulls: 17 }, sources: { event: true, reports: 1, plan: true }, counts: null, openFlags: 0, state: 'reviewed', stale: false },
    { id: 'r2', raidOn: '2026-10-03', zone: 'BT', bosses: { kills: 0, pulls: 0 }, sources: { event: false, reports: 0, plan: false }, counts: { present: 0, bench: 0, missed: 0 }, openFlags: 0, state: 'awaiting_log', stale: false },
  ];
  const raidsHtml = (over) => G.pages.raids.raidsHtml(Object.assign({ guildData: gd(OFFICER_CAN), teamId: 't1', data: { team: 't1', today: '2026-10-17', raids: RAIDS, schedule: { slots: 0 } } }, over || {}));

  await check('raids list: one primary New raid button and a More menu, the same size; Backfill, Raid schedule, Subscribe and My away notices live in More (in the mockup\'s order)', () => {
    const out = raidsHtml();
    // The T1 page head: the one More menu (a dots icon button on a phone, still named More) and the one primary, rightmost.
    assert(/<div class="gs-pagehead-actions"><div class="gs-menu-wrap" data-menu><button type="button" class="gs-btn gs-menu-trigger has-phone-icon" id="raids-more"[^>]*aria-expanded="false"[^>]*aria-label="More"[^>]*><span class="gs-menu-text">More<\/span>/.test(out));
    assert(/<a class="gs-btn gs-btn-molten" href="#\/g\/g1\/raids\/new"><span>New raid<\/span><\/a><\/div>/.test(out));
    const menu = out.slice(out.indexOf('id="raids-more-list"'), out.indexOf('</div></div>', out.indexOf('id="raids-more-list"')));
    assert.deepEqual([...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(m => m[1]), ['Backfill from Warcraft Logs', 'Raid schedule', 'Subscribe in your calendar', 'My away notices']);
    assert(menu.includes('href="#/g/g1/attendance/backfill"') && menu.includes('href="#/g/g1/settings/schedule"') && menu.includes('data-action="cal-open"') && menu.includes('href="#/g/g1/away"'));
    assert(/\.gs-menu-trigger\.has-phone-icon \{ width: var\(--control-h-phone\)/.test(css), 'on a phone More is a 44 px icon button beside the title');
    assertNoRawAttrs(out);
  });

  await check('raids list: Create upcoming raids is in More when the team has a schedule; a member has More (Subscribe, My away notices) and no New raid', () => {
    const withSlots = raidsHtml({ data: { team: 't1', raids: RAIDS, schedule: { slots: 2 } } });
    assert(/data-action="raids-fill" data-key="mi-raids-fill">Create upcoming raids</.test(withSlots));
    assert(!raidsHtml().includes('raids-fill'));
    const member = raidsHtml({ guildData: gd(MEMBER_CAN) });
    const menu = member.slice(member.indexOf('id="raids-more-list"'), member.indexOf('</div></div>', member.indexOf('id="raids-more-list"')));
    assert.deepEqual([...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(m => m[1]), ['Subscribe in your calendar', 'My away notices']);
    assert(!member.includes('New raid') && !member.includes('Backfill'));
    assert(!raidsHtml({ guildData: gd(MEMBER_CAN), teamId: null }).includes('cal-open'), 'no team, no calendar');
  });

  await check('raids list: present / bench / missed is a small stacked bar plus the numbers; the shares add up to the bar; no counts for those who may not see them', () => {
    const out = raidsHtml();
    const rows = out.slice(out.indexOf('<tbody>')).split('<tr class="gs-dtable-row"').map(r => r.split('</tr>')[0]);
    const first = rows[1];
    assert(first.includes('<span class="gs-stack"><svg class="gs-stackbar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">') && first.includes('24 / 1 / 5'));
    const rects = [...first.matchAll(/<rect class="gs-sb-(\w+)" x="([\d.]+)" y="0" width="([\d.]+)" height="8"\/>/g)].map(m => ({ k: m[1], x: Number(m[2]), w: Number(m[3]) }));
    assert.deepEqual(rects.map(r => r.k), ['present', 'bench', 'missed']);
    assert.equal(rects[0].x, 0);
    assert(Math.abs(rects[0].w - 80) < 0.11 && Math.abs(rects[1].w - 3.3) < 0.11 && Math.abs(rects[2].w - 16.7) < 0.11, JSON.stringify(rects));
    assert(Math.abs(rects[0].x + rects[0].w - rects[1].x) < 0.11 && Math.abs(rects[1].x + rects[1].w - rects[2].x) < 0.11 && Math.abs(rects[2].x + rects[2].w - 100) < 0.2, 'segments touch and fill the bar');
    assert(rows[2].includes('data-label="Attended / bench / missed"><span class="gs-muted">-</span>'), 'counts null: a dash');
    assert(!rows[3].includes('<svg') && rows[3].includes('0 / 0 / 0'), 'an empty raid has no bar, only 0 / 0 / 0');
    assert(out.includes('<span class="gs-stack"><svg') && out.includes('24 / 1 / 5'), 'one markup: the phone card has the bar and the numbers too');
    assertNoRawAttrs(out);
  });

  // ═══ 7. Colours ═══
  function lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function lum(hex) { const n = parseInt(hex.slice(1), 16); return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); }
  function lstar(hex) { const y = lum(hex); return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y; }
  function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  const token = name => { const m = new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})').exec(css); assert(m, 'missing --' + name); return m[1]; };

  await check('tone colours: every sign-up tag passes 4.5:1 on its own background, and the five inks differ in lightness (CIE L*) by at least 6', () => {
    const tones = ['signed', 'late', 'tentative', 'absence', 'none'].map(t => ({ t, ink: token('gs-tone-' + t), bg: token('gs-tone-' + t + '-bg') }));
    for (const r of tones) assert(contrast(r.ink, r.bg) >= 4.5, `${r.t} ${contrast(r.ink, r.bg).toFixed(2)}`);
    const sorted = tones.map(r => ({ t: r.t, l: lstar(r.ink) })).sort((a, b) => a.l - b.l);
    for (let i = 1; i < sorted.length; i++) assert(sorted[i].l - sorted[i - 1].l >= 6, `${sorted[i - 1].t} vs ${sorted[i].t}: ${(sorted[i].l - sorted[i - 1].l).toFixed(1)}`);
    for (const r of tones) assert(new RegExp('\\.gs-tag-' + r.t + ' \\{[^}]*color: var\\(--gs-tone-' + r.t + '\\)[^}]*background: var\\(--gs-tone-' + r.t + '-bg\\)').test(css), r.t + ' tag rule uses its tokens');
  });

  await check('tone colours: the totals and the stacked bars (present, bench, missed) pass 4.5:1 on the panel and differ in lightness by at least 6; the pull bar and bars use the same tokens', () => {
    const panel = '#191b1d';
    assert(new RegExp('--bg-panel:\\s*' + panel).test(read('app.css')), 'the panel background this test assumes');
    const inks = [['present', token('gs-tone-signed')], ['bench', token('gs-tone-bench')], ['missed', token('gs-tone-absence')]];
    for (const [n, ink] of inks) assert(contrast(ink, panel) >= 4.5, `${n} ${contrast(ink, panel).toFixed(2)}`);
    const sorted = inks.map(([n, ink]) => ({ n, l: lstar(ink) })).sort((a, b) => a.l - b.l);
    for (let i = 1; i < sorted.length; i++) assert(sorted[i].l - sorted[i - 1].l >= 6, `${sorted[i - 1].n} vs ${sorted[i].n}`);
    assert(/\.gs-sb-present \{ fill: var\(--gs-tone-signed\); \}/.test(css) && /\.gs-sb-bench \{ fill: var\(--gs-tone-bench\); \}/.test(css) && /\.gs-sb-missed \{ fill: var\(--gs-tone-absence\); \}/.test(css));
    assert(/\.gs-tally-present b \{ color: var\(--gs-tone-signed\); \}/.test(css) && /\.gs-tally-missed b \{ color: var\(--gs-tone-absence\); \}/.test(css));
  });

  await check('outcome pills: every outcome has a pill rule on its Attendance colour; the pill text is the page text colour (so it passes on every tint)', () => {
    for (const o of G.pages.attendance.OUTCOMES) assert(new RegExp('\\.gs-opill-' + o + ' \\{ background: color-mix\\(in srgb, var\\(--gs-out-' + o + '\\) 16%').test(css), o);
    assert(/\.gs-opill-none \{/.test(css));
    assert(/\.gs-opill \{[^}]*color: var\(--text-primary\)/.test(css));
    // The text colour over the lightest tint (16% of the lightest outcome colour over the panel) still passes.
    const mix = (hex, p, over) => {
      const a = parseInt(hex.slice(1), 16), b = parseInt(over.slice(1), 16);
      const ch = s => Math.round(((a >> s) & 255) * p + ((b >> s) & 255) * (1 - p));
      return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('');
    };
    for (const o of G.pages.attendance.OUTCOMES) assert(contrast('#e4e6e3', mix(token('gs-out-' + o), 0.16, '#191b1d')) >= 4.5, o);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
