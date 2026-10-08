/**
 * PartyPlanner Web - Keyboard / screen-reader / contrast tests (Phase 1, G5)
 * Run: node a11y-tests.js
 *
 * Covers:
 *   - Seated, bench and unplaced player slots are role="button" tabindex="0" with a
 *     meaningful aria-label, and Enter/Space activates them (like the empty slots).
 *   - Focus returns to the same player's slot after a re-render.
 *   - The toast uses ONE timer (a second toast is not cut off) and is a polite live region.
 *   - --text-faint meets WCAG AA (4.5:1) on the surfaces it is used on; the "Buffs" labels
 *     are at least 10px; the dead .undo-link CSS is gone.
 *   - The in-app Import dialog shares the landing runImport flow (disabled button while
 *     importing, inline errors, success callback).
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('PASS  ' + name);
}

const baseNames = ['State', 'Config', 'nextUid'];
const slotSource = app.slice('const ROLE_ICONS = {', 'function getDominantRoleLabel')
  + '\n' + app.slice('const SignupTray = {', 'const UnplacedDialog');
const ctx = app.sandbox([...baseNames, 'seatedSlotHTML', 'playerSlotLabel', 'SignupTray', 'SignupStatus'],
  { extraSource: slotSource });
const { State, Config, nextUid, seatedSlotHTML, playerSlotLabel, SignupTray } = ctx.api;
State.gameVersion = 'tbc';

const player = (over) => Object.assign({ uid: nextUid(), name: 'Tarlox-Realm', class: 'WARRIOR', spec: 'Fury', role: 'dps' }, over);
const attr = (html, name) => { const m = html.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };
// The slot's own opening tag (first tag), so inner markup cannot satisfy an assertion.
const openTag = (html) => html.match(/^\s*<div[^>]*>/)[0];

(async () => {
  await check('seated slot is a focusable button with name, spec and group in its label', () => {
    const p = player();
    const tag = openTag(seatedSlotHTML(p, 2, 0));
    assert.equal(attr(tag, 'role'), 'button');
    assert.equal(attr(tag, 'tabindex'), '0');
    assert.equal(attr(tag, 'aria-label'), 'Tarlox, Fury Warrior, group 3');
    assert.equal(attr(tag, 'data-uid'), p.uid);
    assert.equal(attr(tag, 'data-group'), '2');
    assert.equal(attr(tag, 'data-slot'), '0');
    assert.equal(attr(tag, 'draggable'), 'true', 'drag-and-drop must stay enabled');
  });

  await check('seated slot label carries sign-up status and needs-review hints, and is escaped', () => {
    const p = player({ name: 'x"><svg onload=alert(1)>-Realm', signupStatus: 'tentative', needsReview: true });
    const tag = openTag(seatedSlotHTML(p, 0, 1));
    const label = attr(tag, 'aria-label');
    assert(/tentative/i.test(label), label);
    assert(/needs review/i.test(label), label);
    assert(!/[<>]/.test(tag.slice(1, -1)), 'no raw markup characters may leak out of the attribute: ' + tag);
    assert(tag.includes('needs-review'), 'existing needs-review class is kept');
  });

  await check('playerSlotLabel tolerates a nameless / specless entry', () => {
    assert.equal(playerSlotLabel({}, 'on the bench'), 'Unknown, on the bench');
  });

  await check('bench slot is a focusable button labelled with name and spec', () => {
    const p = player({ name: 'Benchy-Realm', class: 'PRIEST', spec: 'Holy', role: 'healer' });
    const tag = openTag(SignupTray.slotHTML({ p, bi: 0, unplaced: false }, 'bench'));
    assert.equal(attr(tag, 'role'), 'button');
    assert.equal(attr(tag, 'tabindex'), '0');
    assert.equal(attr(tag, 'aria-label'), 'Benchy, Holy Priest, on the bench');
    assert.equal(attr(tag, 'data-uid'), p.uid);
    assert.equal(attr(tag, 'draggable'), 'true');
  });

  await check('unplaced slot is a focusable button, with or without a class', () => {
    const withClass = player({ name: 'Away-Realm', signupStatus: 'absent' });
    let tag = openTag(SignupTray.slotHTML({ p: withClass, unplaced: true }, 'absent'));
    assert.equal(attr(tag, 'role'), 'button');
    assert.equal(attr(tag, 'tabindex'), '0');
    assert.equal(attr(tag, 'data-unplaced-uid'), withClass.uid);
    assert(/Away, Fury Warrior/.test(attr(tag, 'aria-label')), attr(tag, 'aria-label'));
    assert(/absent/i.test(attr(tag, 'aria-label')));

    const noClass = { uid: nextUid(), name: 'Nobody-Realm', signupStatus: 'absent' };
    tag = openTag(SignupTray.slotHTML({ p: noClass, unplaced: true }, 'absent'));
    assert.equal(attr(tag, 'role'), 'button');
    assert(/Nobody/.test(attr(tag, 'aria-label')));
  });

  await check('Enter and Space activate a role=button slot; other keys and other targets do not', () => {
    const src = app.slice('function activateSlotOnKey(', '(function initPlayerEditor()');
    const c = app.sandbox(['activateSlotOnKey'], { extraSource: src });
    const { activateSlotOnKey } = c.api;
    const press = (key, matches) => {
      const log = { prevented: 0, clicked: 0 };
      const target = { matches: (sel) => matches && sel.includes('.player-slot[role="button"]'), click() { log.clicked++; } };
      activateSlotOnKey({ key, target, preventDefault() { log.prevented++; } });
      return log;
    };
    assert.deepEqual({ ...press('Enter', true) }, { prevented: 1, clicked: 1 });
    assert.deepEqual({ ...press(' ', true) }, { prevented: 1, clicked: 1 });
    assert.deepEqual({ ...press('a', true) }, { prevented: 0, clicked: 0 });
    assert.deepEqual({ ...press('Enter', false) }, { prevented: 0, clicked: 0 });
  });

  await check('focus is restored to the same player after a re-render, wherever the slot went', () => {
    const src = app.slice('function capturePlayerSlotFocus(', 'function getDominantRoleLabel');
    const mkSlot = (dataset) => {
      const s = { dataset, focused: null, focus(opts) { s.focused = opts; document.activeElement = s; }, closest(sel) { return sel === '.player-slot' ? s : null; } };
      return s;
    };
    const document = { activeElement: null, slots: [], querySelectorAll() { return this.slots; } };
    const c = app.sandbox(['capturePlayerSlotFocus', 'restorePlayerSlotFocus'], { globals: { document }, extraSource: src });
    const { capturePlayerSlotFocus, restorePlayerSlotFocus } = c.api;

    // Focus on a seated slot in group 0, then the player lands on the bench (new element, other place).
    const before = mkSlot({ uid: 'u7', group: '0', slot: '2' });
    document.activeElement = before;
    const key = capturePlayerSlotFocus();
    const other = mkSlot({ uid: 'u9', group: '0', slot: '2' });
    const moved = mkSlot({ uid: 'u7' });
    document.activeElement = null;
    document.slots = [other, moved];
    restorePlayerSlotFocus(key);
    assert.equal(document.activeElement, moved, 'focus follows the uid, not the position');
    assert.deepEqual({ ...moved.focused }, { preventScroll: true });

    // Player gone entirely: fall back to whatever now sits in the same group/slot.
    document.activeElement = before;
    const key2 = capturePlayerSlotFocus();
    document.activeElement = null;
    document.slots = [other];
    restorePlayerSlotFocus(key2);
    assert.equal(document.activeElement, other, 'falls back to the same seat');

    // Unplaced slot.
    const un = mkSlot({ unplacedUid: 'x1' });
    document.activeElement = un;
    const key3 = capturePlayerSlotFocus();
    const un2 = mkSlot({ unplacedUid: 'x1' });
    document.activeElement = null;
    document.slots = [other, un2];
    restorePlayerSlotFocus(key3);
    assert.equal(document.activeElement, un2);

    // Focus somewhere else (an input, nothing): nothing is captured and nothing is stolen.
    document.activeElement = { closest: () => null };
    assert.equal(capturePlayerSlotFocus(), null);
    const bystander = { closest: () => null };
    document.activeElement = bystander;
    restorePlayerSlotFocus(null);
    assert.equal(document.activeElement, bystander);
  });

  await check('toast: a second toast restarts one timer instead of being cut off by the first', () => {
    const src = app.slice('// ── TOAST NOTIFICATION', '// ── VERSION AUTO-DETECT');
    const timers = new Map(); let nextId = 1, now = 0;
    const setTimeoutFake = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
    const clearTimeoutFake = (id) => { timers.delete(id); };
    const advance = (ms) => {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    };
    const classes = new Set();
    const toastEl = { textContent: '', classList: { add: c => classes.add(c), remove: c => classes.delete(c) } };
    const document = { getElementById: (id) => (id === 'toast' ? toastEl : null) };
    const c = app.sandbox(['showToast'], { globals: { document, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake }, extraSource: src });
    const { showToast } = c.api;

    showToast('first');
    advance(2000);
    showToast('second');
    assert.equal(toastEl.textContent, 'second');
    advance(1000); // 3000ms since the first toast: its old timer would have hidden this one at 2500
    assert(classes.has('visible'), 'second toast must still be visible 1s after it appeared');
    assert.equal(timers.size, 1, 'only one pending timer');
    advance(1500);
    assert(!classes.has('visible'), 'hidden 2.5s after the LAST toast');
    assert.equal(timers.size, 0);
  });

  const html = app.html;

  await check('toast element is a polite, atomic live region', () => {
    const m = html.match(/<div class="toast" id="toast"[^>]*>/);
    assert(m, 'toast element not found');
    assert.equal(attr(m[0], 'role'), 'status');
    assert.equal(attr(m[0], 'aria-live'), 'polite');
    assert.equal(attr(m[0], 'aria-atomic'), 'true');
  });

  await check('dead .undo-link CSS is removed and nothing references it', () => {
    assert(!/undo-link/.test(html));
  });

  await check('--text-faint is at least 4.5:1 on every surface it is used on', () => {
    const token = (name) => { const m = html.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)); assert(m, name); return m[1]; };
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const faint = token('text-faint');
    // Hover backgrounds (--bg-card-hover) are not a faint-text surface.
    for (const surface of ['bg-deepest', 'bg-frame', 'bg-panel', 'bg-card', 'bg-slot', 'bg-input']) {
      const r = ratio(faint, token(surface));
      assert(r >= 4.5, `${faint} on --${surface} is ${r.toFixed(2)}:1`);
    }
    assert(ratio(faint, '#131416') >= 4.5, 'page background');
  });

  await check('the "Buffs" labels are at least 10px', () => {
    for (const sel of ['.buff-bar-label', '.buff-sidebar-sub']) {
      const rule = html.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`));
      assert(rule, sel);
      const size = rule[1].match(/font-size:\s*(\d+(?:\.\d+)?)px/);
      assert(size && Number(size[1]) >= 10, `${sel} font-size ${size && size[1]}px`);
    }
  });

  await check('runImport: disables the button while importing, reports errors inline, runs onSuccess only on success', async () => {
    const src = app.slice('// ── SHARED IMPORT RUNNER', '// ── IMPORT MODAL (toolbar)');
    const els = {
      inp: { value: '  data  ', focused: 0, focus() { this.focused++; } },
      btn: { disabled: false },
      st: { textContent: '', cls: new Set(), classList: { toggle(c, on) { on ? els.st.cls.add(c) : els.st.cls.delete(c); } } },
    };
    const document = { getElementById: (id) => ({ inp: els.inp, btn: els.btn, st: els.st })[id] };
    let outcome = true; let sawDisabled = null; let calls = 0;
    const importFromText = async (text, report) => {
      calls++;
      sawDisabled = els.btn.disabled;
      if (outcome === 'throw') throw new Error('boom');
      if (!outcome) report('Import failed: nope', true);
      return outcome;
    };
    const c = app.sandbox(['runImport'], { globals: { document, importFromText }, extraSource: src });
    const { runImport } = c.api;
    let successes = 0;
    const onSuccess = () => { successes++; };

    // Empty paste: inline message, focus back to the field, nothing imported.
    els.inp.value = '   ';
    await runImport('inp', 'st', 'btn', onSuccess);
    assert.equal(els.st.textContent, 'Paste something first');
    assert(els.st.cls.has('error'));
    assert.equal(els.inp.focused, 1);
    assert.equal(calls, 0);
    assert.equal(els.btn.disabled, false);

    // Failure: button was disabled during the import, re-enabled after, error kept, text kept.
    els.inp.value = 'bad'; outcome = false;
    await runImport('inp', 'st', 'btn', onSuccess);
    assert.equal(sawDisabled, true);
    assert.equal(els.btn.disabled, false);
    assert.equal(els.st.textContent, 'Import failed: nope');
    assert(els.st.cls.has('error'));
    assert.equal(els.inp.value, 'bad');
    assert.equal(successes, 0);

    // Exception: the button must not stay disabled.
    outcome = 'throw';
    await assert.rejects(runImport('inp', 'st', 'btn', onSuccess));
    assert.equal(els.btn.disabled, false);

    // Success: status cleared, input cleared, callback runs once.
    outcome = true;
    await runImport('inp', 'st', 'btn', onSuccess);
    assert.equal(els.st.textContent, '');
    assert(!els.st.cls.has('error'));
    assert.equal(els.inp.value, '');
    assert.equal(successes, 1);
    assert.equal(els.btn.disabled, false);
  });

  await check('in-app Import dialog has an inline status line and copy that matches what is accepted', () => {
    const modal = html.match(/<div class="import-overlay" id="import-overlay"[\s\S]*?<!-- Save modal -->/)[0];
    assert(/id="import-status"[^>]*role="status"/.test(modal), 'inline status region');
    assert(!/Paste JSON data from raid-helper\.dev/.test(modal), 'old copy removed');
    assert(/Raid-Helper link, event ID/.test(modal));
    assert(/PP:/.test(modal));
    // The dialog button goes through the shared runner (not a bespoke handler).
    assert(/runImport\('import-textarea', 'import-status', 'btn-do-import'/.test(html));
  });

  console.log(`\n${passed} a11y checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
