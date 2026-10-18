/**
 * Raidsmith guild UI - the Raids tab redesign: the shared menu helper (ui.menuHtml / ui.menu), the raid page header with its one More menu,
 * the source chips, the people table (class badge, sign-up tags, pull bar, outcome pill, change button, phone cards), the Raids list header
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
      prow('p_a', 'Alliesha', { class: 'PALADIN', plan: 'G1' }),
      prow('p_d', 'Daxxter', { class: 'MAGE', signup: 'late', plan: 'G5', pulls: { present: 3, total: 4, missedFirst: true, missedLast: false } }),
      prow('p_t', 'Terani', { class: 'MAGE', signup: 'tentative', plan: 'bench', outcome: 'bench', pulls: { present: 0, total: 4, missedFirst: false, missedLast: false } }),
      prow('p_x', 'Aimers', { class: 'HUNTER', signup: 'absence', outcome: 'missed_notice', credit: 0, pulls: { present: 0, total: 4, missedFirst: false, missedLast: false } }),
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
  await check('raid page: the header is the title, one summary line (bosses, present / bench / missed, status chip) and ONE More button', () => {
    const out = raidPage(detail(), { loot: lootState(), roster: rosterState() });
    assert(/<h1 class="gs-h1" id="page-title" tabindex="-1">Sat Oct 17 - Black Temple - 25<\/h1>/.test(out));
    const line = out.slice(out.indexOf('gs-pagehead-context'), out.indexOf('</p>', out.indexOf('gs-pagehead-context')));
    assert(line.includes('1 kill, 3 wipes') && line.includes('2 present, 1 bench, 1 missed') && line.includes('linked to Raid-Helper'), line);
    assert(out.includes('>Reviewed<'), 'the state chip sits beside the title');
    assert.equal((out.match(/data-action="menu-toggle"/g) || []).length, 1 + 3, 'the More button and the three source menus');
    assert(/<button type="button" class="gs-btn gs-menu-trigger has-phone-icon" id="raid-actions"[^>]*aria-haspopup="menu" aria-expanded="false"[^>]*aria-label="More"[^>]*><span class="gs-menu-text">More<\/span>/.test(out), 'one labelled More button (a dots button on a phone)');
    assert(!/<button(?![^>]*role="menuitem")[^>]*>(Recalculate|Delete raid|Plan in Planner|Mark as No log)<\/button>/.test(out), 'no loose action buttons in the header');
    assert(!out.includes('gs-roster-actions') && !out.includes('gs-btn-danger-outline'));
    assertNoRawAttrs(out);
  });

  await check('raid page: the More menu holds Recalculate, Import loot from Gargul, Open in Planner and Delete raid (danger, after a rule) for a past raid', () => {
    const out = raidPage(detail(), { loot: lootState(), roster: rosterState() });
    const menu = out.slice(out.indexOf('id="raid-actions-list"'), out.indexOf('</div></div>', out.indexOf('id="raid-actions-list"')));
    const labels = [...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.deepEqual(labels, ['Open in Planner', 'Recalculate attendance', 'Import loot from Gargul', 'Add loot award', 'Set raid duties', 'Delete raid'], 'Open in Planner is first');
    assert(menu.indexOf('gs-menu-sep') > menu.indexOf('Set raid duties') && menu.indexOf('gs-menu-sep') < menu.indexOf('Delete raid'), 'Delete raid sits after a rule, alone in its group');
    assert(/class="gs-menu-item is-danger"[^>]*data-op="raid-delete"/.test(menu));
    assert(menu.includes('data-action="loot-import-open"') && menu.includes('data-op="plan-in-planner"') && menu.includes('data-op="recompute"'));
    assert(!menu.includes('Mark as No log'), 'a raid with reports is not marked No log');
    assert(!menu.includes('Publish line-up'), 'a past raid has no line-up to publish');
  });

  await check('raid page: Mark as No log is offered only without a log; Import loot only when the loot card would offer it; Publish line-up only for an upcoming raid with a plan that is not published', () => {
    const awaiting = detail({ raid: Object.assign(detail().raid, { state: 'awaiting_log' }), people: [], sources: { event: null, reports: [], plan: null } });
    assert(raidPage(awaiting, { loot: lootState() }).includes('Mark as No log'));
    assert(!raidPage(detail(), {}).includes('Import loot from Gargul'), 'loot not loaded: not offered');
    assert(!raidPage(detail(), { loot: lootState({ data: { awards: [], canEdit: false } }) }).includes('Import loot from Gargul'));
    const open = lootState(); open.ui.open = true;
    assert(!raidPage(detail(), { loot: open }).includes('>Import loot from Gargul<'), 'the import panel is already open');
    const up = detail({ raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: null, zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 }, people: [], pulls: [], signups: [] });
    const publish = raidPage(up, { roster: rosterState() });
    assert(/data-action="roster-publish" data-op="publish" data-key="mi-ro-publish">Publish line-up</.test(publish));
    assert(!raidPage(up, { roster: rosterState({ published: true }) }).includes('data-key="mi-ro-publish"'), 'already published');
    assert(!raidPage(Object.assign({}, up, { sources: Object.assign({}, FULL_SOURCES, { plan: null }) }), { roster: rosterState() }).includes('data-key="mi-ro-publish"'), 'no plan');
    assert(!raidPage(up, {}).includes('data-key="mi-ro-publish"'), 'roster not loaded');
    assert(!raidPage(up, { roster: rosterState() }).includes('Recalculate'), 'an upcoming raid has nothing to recalculate');
    assert(raidPage(up, { roster: rosterState() }).includes('Delete raid'));
  });

  await check('raid page: a member gets no More menu and no source menus; the chips still say what is linked', () => {
    const member = detail({ people: null, can: { edit: false, review: false, seeAttendance: false, seeNicknames: false } });
    const out = raidPage(member, { guildData: gd(MEMBER_CAN) });
    assert(!out.includes('menu-toggle') && !out.includes('data-op=') && !out.includes('Delete raid') && !out.includes('role="menu"'));
    assert(out.includes('Team KJ Saturday - BT') && out.includes('>2 reports<') && out.includes('>BT run<'));
  });

  // ═══ 4. The source chips ═══
  await check('source chips: three equal chips in one strip, each with a dot, its name, one line of detail and a "..." menu with that source\'s actions', () => {
    const out = raidPage(detail(), {});
    // The chips sit in their sections: the Raid-Helper event with the sign-ups, the logs with the attendance; the plan is a row of Plan and line-up with its Plan settings menu.
    assert.equal((out.match(/class="gs-src"/g) || []).length, 2);
    assert.equal((out.match(/class="gs-src-dot"/g) || []).length, 2);
    assert(out.includes('>Raid-Helper<') && out.includes('>Warcraft Logs<') && out.includes('<span class="gs-prow-name">Plan</span>'));
    assert(out.includes('>Team KJ Saturday - BT<') && out.includes('30 sign-ups, synced today') && out.includes('>2 reports<') && out.includes('7 boss pulls') && out.includes('>BT run<') && out.includes('25 players'));
    for (const label of ['Raid-Helper event actions', 'Warcraft Logs actions', 'Plan settings']) assert(out.includes('aria-label="' + label + '"'), label);
    assert(!out.includes('gs-source') && !out.includes('gs-sources'), 'the three cards are gone');
    const listOf = id => out.slice(out.indexOf('id="' + id + '-list"'), out.indexOf('</div></div>', out.indexOf('id="' + id + '-list"')));
    const eventMenu = listOf('src-event');
    assert.deepEqual(opsOf(eventMenu), ['event-refresh', 'event-replace', 'event-remove']);
    assert(/is-danger"[^>]*data-op="event-remove"/.test(eventMenu));
    const logsMenu = listOf('src-logs');
    assert.deepEqual(opsOf(logsMenu), ['report-refresh', 'report-remove', 'report-refresh', 'report-remove', 'report-add']);
    assert(logsMenu.includes('data-code="WaghkY9zwDyvLX7m"') && logsMenu.includes('data-code="h8VAwCFa79Jk1cvf"') && logsMenu.includes('>Refresh h8VAwCFa79Jk1cvf<') && logsMenu.includes('>Remove WaghkY9zwDyvLX7m<'));
    const planMenu = listOf('src-plan');
    assert.deepEqual(opsOf(planMenu), ['plan-replace', 'plan-remove']);
    assert(/<button type="button" class="gs-linkbtn" data-action="raid-op" data-op="plan-in-planner"[^>]*>BT run<\/button>/.test(out), 'the plan name opens the Planner');
  });

  await check('source chips: an empty source is a dashed chip whose one action is a button; a hand-entered raid takes no report; nothing sits in the menus then', () => {
    const none = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'awaiting_log' }), people: [], sources: { event: null, reports: [], plan: null } }), {});
    assert.equal((none.match(/class="gs-src is-empty"/g) || []).length, 2, 'the event and the logs; the plan is a row');
    for (const [op, label] of [['event-replace', 'Link an event'], ['report-add', 'Add report'], ['plan-replace', 'Link a plan']]) {
      assert(new RegExp('<button type="button" class="gs-btn gs-btn-sm" data-action="raid-op" data-op="' + op + '" data-key="' + op + '">' + label + '</button>').test(none), label);
    }
    assert(!none.includes('src-event-list') && !none.includes('src-logs-list') && !none.includes('src-plan-list'));
    const manual = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'manual', manual: { reason: 'Nobody uploaded', by: 'Officer', at: 1 } }), sources: { event: null, reports: [], plan: null } }), {});
    assert(!manual.includes('data-op="report-add"') && manual.includes('attendance entered by hand'));
    const manualWithLog = raidPage(detail({ raid: Object.assign(detail().raid, { state: 'manual', manual: { reason: 'x', by: 'Officer', at: 1 } }) }), {});
    assert(!manualWithLog.includes('data-op="report-add"'), 'no Add report in the logs menu of a hand-entered raid');
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

  await check('upcoming raid: the header keeps the start line and the plan chip; the slim chip strip sits above the Sign-ups panel', () => {
    const up = detail({ raid: { id: 'u1', team: 't1', raidOn: '2026-10-24', startsAt: Date.UTC(2026, 9, 25, 0, 0), upcoming: true, title: 'Prog night', zone: 'Black Temple', state: 'awaiting_log', openFlags: 0, stale: false, version: 1 }, people: [], pulls: [], signups: [] });
    const out = raidPage(up, { roster: rosterState() });
    assert(out.includes('Prog night &middot; Starts Sat Oct 24, ') && out.includes('>Upcoming<') && out.includes('>Planned<'));
    assert(out.indexOf('id="s-signups"') < out.indexOf('class="gs-srcstrip"') && out.indexOf('class="gs-srcstrip"') < out.indexOf('id="s-plan"'), 'the chip strip is in the Sign-ups section');
    assert(out.includes('Opens when the raid starts at '), 'After the raid is locked until the start');
    assert(!out.includes('data-src="logs"'), 'no Warcraft Logs chip before the raid');
    assertNoRawAttrs(out);
  });

  // ═══ 5. The people table ═══
  const bodyOf = out => out.slice(out.indexOf('<tbody>'), out.indexOf('</tbody>'));
  const rowOf = (out, name) => bodyOf(out).split('<tr>').find(r => r.includes('>' + name + '<'));

  await check('people table: fixed-width columns, class badge + class colour + spec under the name, sign-up tag, plan, pull bar, outcome pill, Change button', () => {
    const out = raidPage(detail(), { filter: 'all' });
    const head = out.slice(out.indexOf('<thead>'), out.indexOf('</thead>'));
    for (const c of ['gs-col-player', 'gs-col-signup', 'gs-col-plan', 'gs-col-pulls', 'gs-col-act']) assert(head.includes(c), c);
    assert(['Player', 'Sign-up', 'Plan', 'Boss pulls', 'Outcome'].every(t => head.includes('>' + t + '<')) && head.includes('<span class="gs-sr">Change</span>'));
    const alli = rowOf(out, 'Alliesha');
    assert(alli.includes('<span class="gs-classbadge gs-class-paladin" aria-hidden="true">PL</span>') && alli.includes('class="gs-char-link gs-class-paladin"'));
    assert(alli.includes('<span class="gs-char-sub">Paladin &middot; Protection</span>'), 'Raid-Helper\'s Protection1 loses its digit: ' + alli.slice(0, 500));
    assert(alli.includes('class="gs-tag gs-tag-signed">Signed up<') && alli.includes('<span class="gs-char-sub">Alli</span>'));
    assert(alli.includes('<span class="gs-plan">G1</span>'));
    assert(alli.includes('class="gs-pullbar"') && alli.includes('4/4'));
    assert(alli.includes('<span class="gs-opill gs-opill-present"><span class="gs-cell gs-out-present" aria-hidden="true">P</span><span>Present</span></span>'));
    assert(alli.includes('class="gs-iconbtn"') && alli.includes('aria-label="Change outcome for Alliesha"') && alli.includes('data-action="decide-open"') && alli.includes('data-key="decide-p_a"'));
    // The meta class of a Late row is not a class: the spec line falls back to the class alone.
    assert(rowOf(out, 'Daxxter').includes('<span class="gs-char-sub">Mage</span>'));
    assertNoRawAttrs(out);
  });

  await check('people table: the sign-up kinds get Signed green, Late amber, Tentative muted, Absence red and a grey No sign-up; the plan reads G5 / Bench / -', () => {
    const out = raidPage(detail(), { filter: 'all' });
    assert(rowOf(out, 'Alliesha').includes('gs-tag-signed'));
    assert(rowOf(out, 'Daxxter').includes('class="gs-tag gs-tag-late">Late<') && rowOf(out, 'Daxxter').includes('<span class="gs-plan">G5</span>'));
    assert(rowOf(out, 'Terani').includes('class="gs-tag gs-tag-tentative">Tentative<') && rowOf(out, 'Terani').includes('<span class="gs-plan is-bench">Bench</span>'));
    assert(rowOf(out, 'Aimers').includes('class="gs-tag gs-tag-absence">Can&#39;t come<') && rowOf(out, 'Aimers').includes('<span class="gs-muted">-</span>'));
    assert(rowOf(out, 'Bearnnaked').includes('class="gs-tag gs-tag-none">No sign-up<'));
    const kinds = detail({ people: ['standby', 'bench', 'strange'].map((k, i) => prow('p' + i, 'N' + i, { signup: k })) });
    const k = raidPage(kinds, { filter: 'all' });
    assert(['N0', 'N1', 'N2'].every(n => rowOf(k, n).includes('gs-tag-tentative')), 'Standby, Bench and anything unknown are muted');
  });

  await check('people table: the pull bar fills present of total (scaled to 12 cells on a long night, never empty or full by rounding), with the missed first / last chips', () => {
    const out = raidPage(detail(), { filter: 'all' });
    const bar = r => ({ cells: (r.match(/<span( class="is-on")?><\/span>/g) || []).length, on: (r.match(/class="is-on"/g) || []).length });
    assert.deepEqual(bar(rowOf(out, 'Alliesha')), { cells: 4, on: 4 });
    assert.deepEqual(bar(rowOf(out, 'Daxxter')), { cells: 4, on: 3 });
    assert(rowOf(out, 'Daxxter').includes('3/4') && rowOf(out, 'Daxxter').includes('missed first'));
    assert.deepEqual(bar(rowOf(out, 'Terani')), { cells: 4, on: 0 });
    assert(rowOf(out, 'Bearnnaked').includes('<span class="gs-muted">-</span>') && !rowOf(out, 'Bearnnaked').includes('gs-pullbar'), 'no pulls, no bar');
    const long = raidPage(detail({ people: [prow('p1', 'Long1', { pulls: { present: 16, total: 17, missedFirst: false, missedLast: false } }), prow('p2', 'Long2', { pulls: { present: 1, total: 40, missedFirst: false, missedLast: false } }), prow('p3', 'Long3', { pulls: { present: 17, total: 17, missedFirst: false, missedLast: false } })] }), { filter: 'all' });
    assert.deepEqual(bar(rowOf(long, 'Long1')), { cells: 12, on: 11 }, '16 of 17 is not a full bar');
    assert.deepEqual(bar(rowOf(long, 'Long2')), { cells: 12, on: 1 }, '1 of 40 is not an empty bar');
    assert.deepEqual(bar(rowOf(long, 'Long3')), { cells: 12, on: 12 });
  });

  await check('people table: outcomes are pills with their letter (Missed with notice N, No sign-up -); Decide stays in words on a flagged row; members see no change button', () => {
    const out = raidPage(detail({ people: [prow('p1', 'Flagged', { outcome: 'late', credit: null, pending: true, needsReview: true, flags: ['late'] }), prow('p2', 'Notice', { outcome: 'missed_notice', credit: 0 }), prow('p3', 'Nobody', { outcome: 'no_signup', credit: null })] }), { filter: 'all' });
    assert(rowOf(out, 'Flagged').includes('gs-out-late is-pending" aria-hidden="true">L?<') && rowOf(out, 'Flagged').includes('Late (awaiting review)') && rowOf(out, 'Flagged').includes('>Decide<') && !rowOf(out, 'Flagged').includes('gs-iconbtn'));
    assert(rowOf(out, 'Notice').includes('>N</span><span>Missed with notice</span>'));
    assert(rowOf(out, 'Nobody').includes('gs-opill-no_signup') && rowOf(out, 'Nobody').includes('>No sign-up</span></span>'));
    const noReview = raidPage(detail({ can: { edit: true, review: false, seeAttendance: true, seeNicknames: false } }), { filter: 'all' });
    assert(!noReview.includes('decide-open'));
    const plainNames = raidPage(detail({ can: { edit: true, review: false, seeAttendance: false, seeNicknames: false } }), { filter: 'all' });
    assert(!plainNames.includes('gs-char-link') && plainNames.includes('<span class="gs-char-name gs-class-paladin">Alliesha</span>'));
  });

  await check('people table: the phone gets stacked cards (name, spec, change button; tags and pull bar; outcome pill) from the same pieces; the table hides at 600px', () => {
    const out = raidPage(detail(), { filter: 'all' });
    const cards = out.slice(out.indexOf('<ul class="gs-roster-cards gs-raid-cards"'));
    const card = cards.split('<li class="gs-roster-card gs-pcard">').find(c => c.includes('>Daxxter<'));
    assert(card.includes('class="gs-pcard-top"') && card.includes('gs-classbadge') && card.includes('Change outcome for Daxxter'));
    assert(card.includes('gs-tag-late') && card.includes('<span class="gs-fine">Plan</span><span class="gs-plan">G5</span>') && card.includes('3/4') && card.includes('gs-opill-present'));
    assert.equal((cards.match(/<li class="gs-roster-card gs-pcard">/g) || []).length, 5);
    assert(/@media \(max-width: 600px\) \{[^}]*\n  \.gs-raids-table, \.gs-raid-people/.test(css) || /\.gs-raids-table, \.gs-raid-people, \.gs-pa-table, \.gs-att-table \{ display: none; \}/.test(css));
    assert(/\.gs-roster-cards, \.gs-char-cards \{ display: flex;/.test(css), 'cards show on the phone');
  });

  await check('people table: the toolbar keeps Needs review / Everyone and shows the coloured totals; hostile names, specs and nicknames are escaped', () => {
    const out = raidPage(detail(), { filter: 'all' });
    assert(/aria-pressed="false">Needs review <span class="gs-seg-count">0</.test(out) && /aria-pressed="true">Everyone <span class="gs-seg-count">5</.test(out));
    assert(/<p class="gs-tally"><span class="gs-tally-present"><b>2<\/b> present<\/span><span class="gs-tally-bench"><b>1<\/b> bench<\/span><span class="gs-tally-missed"><b>1<\/b> missed<\/span><\/p>/.test(out));
    const bad = detail({ people: [prow('p_x', HOSTILE + QUOTES, { class: HOSTILE, signup: HOSTILE, plan: HOSTILE, outcome: HOSTILE, flags: [HOSTILE] })], signups: [{ source: 'raid_helper', kind: 'signed', className: HOSTILE, specName: HOSTILE, playerId: 'p_x', nickname: HOSTILE + QUOTES }] });
    assertEscaped(raidPage(bad, { filter: 'all' }), 'people');
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
    assert(rows[2].includes('data-label="Present / Bench / Missed"><span class="gs-muted">-</span>'), 'counts null: a dash');
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
