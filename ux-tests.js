/**
 * PartyPlanner Web - UX and accessibility tests (Phase 2, G5: U2-U6, U9, U10)
 * Run: node ux-tests.js
 *
 *   U2  a newer import wins: an older Raid-Helper fetch that lands late is dropped; a runner
 *       that is already importing ignores a second trigger
 *   U3  switching game version asks first when a plan is loaded, and reports the benched count
 *   U4  Modal.confirm replaces window.confirm; Random roster asks before replacing a plan
 *   U5  a manual move pins the group order
 *   U6  the Optimize toast says when buff overrides were reset
 *   U9  the summary bar is not a live region; one sr-only status region announces it
 *   U10 a <main> landmark; the parties are a list
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log('PASS  ' + name);
}

// A <dialog> and its buttons, just enough for Modal.confirm: showModal marks it open and
// close() records the returnValue and fires 'close' (the real one fires it asynchronously).
function makeConfirmDom() {
  const listeners = {};
  const els = {};
  const el = id => (els[id] ||= {
    id, textContent: '', returnValue: '', open: false, focused: 0, shown: 0,
    addEventListener(type, fn) { (listeners[id + ':' + type] ||= []).push(fn); },
    focus() { this.focused++; },
    showModal() { this.open = true; this.shown++; },
    close(value) {
      if (!this.open) return;
      this.open = false;
      if (value !== undefined) this.returnValue = value;
      (listeners[id + ':close'] || []).forEach(fn => fn({ target: this }));
    },
    click() { (listeners[id + ':click'] || []).forEach(fn => fn({ target: this })); },
  });
  return { document: { getElementById: el }, el };
}

// The app's pure-logic half already declares State, Import, Config, GameVersions, PlanStore...
// at the top level, which would win over sandbox globals of the same name. Code from the UI
// half is therefore wrapped in a function whose parameters are the stand-ins for those names.
function bind(src, deps, exported) {
  const factory = `function __bound(${Object.keys(deps).join(', ')}) {
${src}
return { ${exported.join(', ')} };
}`;
  const ctx = app.sandbox(['__bound'], { extraSource: factory, globals: { AbortController, setTimeout, clearTimeout } });
  return ctx.api.__bound(...Object.values(deps));
}

(async () => {
  // ── U4: Modal.confirm ─────────────────────────────────────────────
  const modalSrc = app.slice('// ── CONFIRM DIALOG', '// ── TOAST NOTIFICATION');
  function makeModal() {
    const dom = makeConfirmDom();
    const ctx = app.sandbox(['Modal'], { globals: { document: dom.document }, extraSource: modalSrc });
    return { Modal: ctx.api.Modal, ...dom };
  }

  await check('Modal.confirm shows the text, focuses Cancel and resolves true on the confirm button', async () => {
    const { Modal, el } = makeModal();
    const pending = Modal.confirm({ title: 'Switch?', message: 'Players carry over.', confirmLabel: 'Switch now' });
    assert.equal(el('confirm-dialog').open, true);
    assert.equal(el('confirm-heading').textContent, 'Switch?');
    assert.equal(el('confirm-message').textContent, 'Players carry over.');
    assert.equal(el('btn-confirm-ok').textContent, 'Switch now');
    assert.equal(el('btn-confirm-cancel').focused, 1, 'Cancel holds the initial focus');
    el('btn-confirm-ok').click();
    assert.equal(await pending, true);
    assert.equal(el('confirm-dialog').open, false);
  });

  await check('Modal.confirm resolves false on Cancel and on Escape (dialog closed with no value)', async () => {
    const { Modal, el } = makeModal();
    let pending = Modal.confirm({ message: 'x' });
    el('btn-confirm-cancel').click();
    assert.equal(await pending, false);
    pending = Modal.confirm({ message: 'x' });
    el('confirm-dialog').close();   // what Escape does
    assert.equal(await pending, false);
  });

  await check('a stale returnValue from the last confirm never confirms the next one', async () => {
    const { Modal, el } = makeModal();
    let pending = Modal.confirm({ message: 'one' });
    el('btn-confirm-ok').click();
    assert.equal(await pending, true);
    pending = Modal.confirm({ message: 'two' });
    el('confirm-dialog').close();
    assert.equal(await pending, false);
  });

  await check('a second confirm declines the first and reuses the open dialog', async () => {
    const { Modal, el } = makeModal();
    const first = Modal.confirm({ message: 'first' });
    const second = Modal.confirm({ message: 'second' });
    assert.equal(await first, false);
    assert.equal(el('confirm-message').textContent, 'second');
    assert.equal(el('confirm-dialog').shown, 1, 'showModal is not called on an open dialog');
    el('btn-confirm-ok').click();
    assert.equal(await second, true);
  });

  await check('Modal.confirm resolves false when the dialog is unavailable', async () => {
    const dom = makeConfirmDom();
    const ctx = app.sandbox(['Modal'], { globals: { document: dom.document }, extraSource: modalSrc });
    dom.el('confirm-dialog').showModal = undefined;
    assert.equal(await ctx.api.Modal.confirm({ message: 'x' }), false);
  });

  await check('no script calls window.confirm any more', () => {
    const withoutModal = app.script.replace(/\bModal\.confirm\(/g, '').replace(/\bconfirm\(\{/g, '');
    // A call passes a message; the empty-parens hits are the confirm() methods of other dialogs.
    assert(!/(?<![\w.])confirm\(\s*[^)\s]/.test(withoutModal), 'a bare confirm(...) call remains');
    assert(!/window\.confirm\(/.test(app.script));
  });

  // ── U4: Random roster asks before replacing a plan ────────────────
  const randomSrc = app.slice('async function confirmReplaceWithRandom', 'function showView');
  await check('Random roster confirms only when there is work to lose', async () => {
    const asked = [];
    let answer = true, work = false;
    const ctx = app.sandbox(['confirmReplaceWithRandom'], {
      globals: { hasLoadedWork: () => work, Modal: { confirm: async opts => { asked.push(opts); return answer; } } },
      extraSource: randomSrc,
    });
    const { confirmReplaceWithRandom } = ctx.api;
    assert.equal(await confirmReplaceWithRandom(), true);
    assert.equal(asked.length, 0, 'an empty plan generates without asking');
    work = true;
    assert.equal(await confirmReplaceWithRandom(), true);
    assert.equal(asked.length, 1);
    assert.match(asked[0].message, /replaces/);
    answer = false;
    assert.equal(await confirmReplaceWithRandom(), false);
  });

  await check('both Random buttons go through the confirm before touching the plan', () => {
    for (const id of ['btn-random', 'btn-landing-random']) {
      const at = app.script.indexOf(`getElementById('${id}').addEventListener('click', async () => {`);
      assert(at >= 0, `${id} handler is async`);
      const body = app.script.slice(at, at + 300);
      const asks = body.indexOf('confirmReplaceWithRandom');
      assert(asks > 0 && asks < body.indexOf('RandomRoster.generate'), id);
    }
  });

  // ── U4: a shared link asks through the Modal ──────────────────────
  const shareSrc = app.slice('async function applyShareCode', "document.getElementById('btn-share')");
  await check('applyShareCode asks via Modal.confirm only when work is loaded, and a decline changes nothing', async () => {
    const calls = { confirm: 0, imported: 0, committed: 0 };
    let answer = false, work = true;
    const deps = {
      Import: {
        decodeSharePayload: c => c, previewShareString: () => ({ success: true, name: 'Raid X' }),
        importAddonString: () => { calls.imported++; return { success: true, playerCount: 3 }; },
      },
      hasLoadedWork: () => work, State: { rosterName: 'Raid X' }, commit: () => { calls.committed++; },
      showToast() {}, rememberImport: () => '',
      Modal: { confirm: async opts => { calls.confirm++; assert.match(opts.message, /Raid X/); return answer; } },
    };
    const { applyShareCode } = bind(shareSrc, deps, ['applyShareCode']);
    assert.equal(await applyShareCode('abc'), false);
    assert.deepEqual(calls, { confirm: 1, imported: 0, committed: 0 });
    answer = true;
    assert.equal(await applyShareCode('abc'), true);
    assert.deepEqual(calls, { confirm: 2, imported: 1, committed: 1 });
    work = false;
    assert.equal(await applyShareCode('abc'), true);
    assert.equal(calls.confirm, 2, 'no work to replace, no question');
  });

  await check('the share-link loaders are awaited, not read as booleans', () => {
    assert(/async function loadFromShareLink\(\)/.test(app.script));
    assert(/loadFromShareLink\(\)\.then\(opened =>/.test(app.script));
    assert(/if \(!await applyShareCode\(remote\.code\)\) return false;/.test(app.script));
  });

  // ── U3: version switch ────────────────────────────────────────────
  const versionSrc = app.slice('async function switchGameVersion', 'function renderRaidSizeControl');
  function makeVersionEnv({ work = true, answer = true, benched = 0, view = 'app' } = {}) {
    const log = { confirm: [], toasts: [], tabs: [], initGroups: 0, landing: 0 };
    const deps = {
      GameVersions: {
        tbc: { name: 'WoW TBC', defaultRaid: 'bt', note: 'TBC note.' },
        classic: { name: 'WoW Classic', defaultRaid: 'mc', note: 'Classic note.' },
      },
      Config: { Raids: { bt: { size: 25 }, mc: { size: 40 }, kara: { size: 10 } } },
      State: { view, gameVersion: 'tbc', selectedRaid: 'bt', planId: 'plan:1', buffOverrides: { '0:a:air': 'GRACE_OF_AIR' }, preferredSlots: [{ group: 0 }] },
      hasLoadedWork: () => work,
      Modal: { confirm: async opts => { log.confirm.push(opts); return answer; } },
      initGroups: () => { log.initGroups++; return benched; },
      PreferredSlots: { clean: list => list },
      switchTab: tab => log.tabs.push(tab),
      renderLanding: () => log.landing++,
      showToast: msg => log.toasts.push(msg),
    };
    const { switchGameVersion } = bind(versionSrc, deps, ['switchGameVersion']);
    return { switchGameVersion, State: deps.State, log };
  }

  await check('switching version with a plan loaded asks first and stays put on Cancel', async () => {
    const env = makeVersionEnv({ answer: false });
    assert.equal(await env.switchGameVersion('classic'), false);
    assert.equal(env.log.confirm.length, 1);
    assert.match(env.log.confirm[0].title, /WoW Classic/);
    assert.equal(env.State.gameVersion, 'tbc');
    assert.equal(env.State.planId, 'plan:1');
    assert.equal(Object.keys(env.State.buffOverrides).length, 1);
    assert.equal(env.log.initGroups, 0);
    assert.deepEqual(env.log.toasts, []);
  });

  await check('confirming switches, resets picks and reports how many players were benched', async () => {
    const env = makeVersionEnv({ benched: 3 });
    assert.equal(await env.switchGameVersion('classic'), true);
    assert.equal(env.State.gameVersion, 'classic');
    assert.equal(env.State.selectedRaid, 'mc');
    assert.equal(env.State.planId, null);
    assert.equal(Object.keys(env.State.buffOverrides).length, 0);
    assert.deepEqual(env.log.tabs, ['plan']);
    assert.equal(env.log.toasts.length, 1);
    assert.match(env.log.toasts[0], /^3 players benched: the 40-man raid is full\. Classic note\.$/);
  });

  await check('one benched player is singular; none benched leaves the plain version note', async () => {
    let env = makeVersionEnv({ benched: 1 });
    await env.switchGameVersion('classic');
    assert.match(env.log.toasts[0], /^1 player benched:/);
    env = makeVersionEnv({ benched: 0 });
    await env.switchGameVersion('classic');
    assert.equal(env.log.toasts[0], 'Classic note.');
  });

  await check('switching version from the landing view re-renders it so the resume banner is current', async () => {
    let env = makeVersionEnv({ view: 'landing' });
    await env.switchGameVersion('classic');
    assert.equal(env.log.landing, 1);
    env = makeVersionEnv({ view: 'app' });
    await env.switchGameVersion('classic');
    assert.equal(env.log.landing, 0);
  });

  await check('with nothing loaded the switch is immediate; the same or an unknown version is a no-op', async () => {
    let env = makeVersionEnv({ work: false });
    assert.equal(await env.switchGameVersion('classic'), true);
    assert.equal(env.log.confirm.length, 0);
    env = makeVersionEnv();
    assert.equal(await env.switchGameVersion('tbc'), false);
    assert.equal(await env.switchGameVersion('constructor'), false);
    assert.equal(await env.switchGameVersion('nope'), false);
    assert.equal(env.log.confirm.length, 0);
    assert.equal(env.log.initGroups, 0);
  });

  await check('the version tabs call switchGameVersion', () => {
    assert(/button\.onclick = \(\) => switchGameVersion\(button\.dataset\.version\);/.test(app.script));
  });

  // ── U2: import ordering ───────────────────────────────────────────
  const importSrc = app.slice('function normalizeImportSource', '// ── PLAIN-TEXT ROSTER IMPORT PREVIEW');
  function makeImportEnv() {
    const calls = { importRaidHelper: 0, addon: 0 };
    const fetches = [];
    const deps = {
      fetch: url => new Promise(resolve => fetches.push({ url, resolve })),
      AbortController, setTimeout, clearTimeout, localStorage: {},
      State: { rosterName: '', sourceEventId: null, planId: null, selectedRaid: 'gruul' },
      NO_ROSTER_NAME: 'No roster',
      Import: {
        importAddonString: () => { calls.addon++; return { success: true, playerCount: 5 }; },
        importRaidHelper: () => { calls.importRaidHelper++; return { success: false, error: 'stub stops here' }; },
      },
      PlanStore: { nameFor: () => 'Name', read: () => [] },
      document: { getElementById: () => ({ value: '' }) },
      initGroups: () => 0, commit() {}, showToast() {}, rememberImport: () => '',
      maybeSuggestVersionSwitch() {},
    };
    const { importFromText } = bind(importSrc, deps, ['importFromText']);
    return { importFromText, calls, fetches };
  }
  const body = JSON.stringify({ signUps: [] });
  const okResponse = { ok: true, text: async () => body };

  await check('an older fetch that lands after a newer import is dropped', async () => {
    const env = makeImportEnv();
    const reports = [];
    const report = (m, isErr) => reports.push([m, !!isErr]);
    const older = env.importFromText('https://raid-helper.dev/event/1111111', report);
    const newer = env.importFromText('PP:2:whatever', report);
    assert.equal(await newer, true);
    env.fetches[0].resolve(okResponse);
    assert.equal(await older, false);
    assert.equal(env.calls.importRaidHelper, 0, 'the late result must not be imported');
    assert(reports.some(([m]) => /newer import/.test(m)));
  });

  await check('the latest of two overlapping fetches wins whichever answers first', async () => {
    const env = makeImportEnv();
    const report = () => {};
    const first = env.importFromText('https://raid-helper.dev/event/1111111', report);
    const second = env.importFromText('https://raid-helper.dev/event/2222222', report);
    env.fetches[1].resolve(okResponse);
    await second;
    assert.equal(env.calls.importRaidHelper, 1);
    env.fetches[0].resolve(okResponse);
    assert.equal(await first, false);
    assert.equal(env.calls.importRaidHelper, 1, 'the older one never imports');
  });

  await check('a lone import is not treated as stale', async () => {
    const env = makeImportEnv();
    const pending = env.importFromText('https://raid-helper.dev/event/1111111', () => {});
    env.fetches[0].resolve(okResponse);
    await pending;
    assert.equal(env.calls.importRaidHelper, 1);
  });

  await check('runImport ignores a second trigger while its own import is still running', async () => {
    const src = app.slice('// ── SHARED IMPORT RUNNER', '// ── IMPORT MODAL (toolbar)');
    const els = {
      inp: { value: 'data', focus() {} },
      btn: { disabled: false },
      st: { textContent: '', classList: { toggle() {} } },
    };
    const document = { getElementById: id => els[id] };
    let release, calls = 0;
    const importFromText = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const { runImport } = app.sandbox(['runImport'], { globals: { document, importFromText }, extraSource: src }).api;
    const first = runImport('inp', 'st', 'btn', () => {});
    assert.equal(els.btn.disabled, true);
    await runImport('inp', 'st', 'btn', () => {});
    assert.equal(calls, 1, 'the second trigger did not start another import');
    assert.equal(els.btn.disabled, true, 'and did not re-enable the button');
    release(false);
    await first;
    assert.equal(els.btn.disabled, false);
  });

  // ── U5: manual move pins the order ────────────────────────────────
  const moveSrc = app.slice('function moveGroupPlayer', '(function initDragDrop');
  await check('moving or swapping a player by hand sets preserveGroupOrder; a failed move does not', () => {
    const run = (srcG, srcS, tgtG, tgtS) => {
      const State = {
        preserveGroupOrder: false,
        groups: [[{ name: 'A' }, { name: 'B' }], [{ name: 'C' }]],
      };
      const { moveGroupPlayer } = bind(moveSrc, { State }, ['moveGroupPlayer']);
      return { moved: moveGroupPlayer(srcG, srcS, tgtG, tgtS), State };
    };
    let r = run(0, 0, 1, 0);   // swap
    assert.equal(r.moved, true);
    assert.equal(r.State.preserveGroupOrder, true);
    r = run(0, 1, 1, 1);       // into an open seat
    assert.equal(r.moved, true);
    assert.equal(r.State.preserveGroupOrder, true);
    r = run(1, 5, 0, 0);       // nobody at the source
    assert.equal(r.moved, false);
    assert.equal(r.State.preserveGroupOrder, false);
  });

  // ── U6: Optimize toast ────────────────────────────────────────────
  const toastSrc = app.slice('function optimizeToastMessage', "document.getElementById('btn-optimize')");
  await check('the Optimize toast reports reset buff overrides, and only when there were some', () => {
    const { optimizeToastMessage } = app.sandbox(['optimizeToastMessage'], { extraSource: toastSrc }).api;
    assert.equal(optimizeToastMessage({ moved: 4, buffDelta: 3, overridesReset: 0 }), 'Optimized: +3 buffs, 4 players moved');
    assert.equal(optimizeToastMessage({ moved: 4, buffDelta: -1, overridesReset: 1 }), 'Optimized: -1 buffs, 4 players moved. 1 buff override reset');
    assert.equal(optimizeToastMessage({ moved: 2, buffDelta: 0, overridesReset: 3 }), 'Optimized: +0 buffs, 2 players moved. 3 buff overrides reset');
    assert.equal(optimizeToastMessage({ moved: 0, buffDelta: 0, overridesReset: 0 }), 'Already optimal — nothing moved');
    assert.equal(optimizeToastMessage({ moved: 0, buffDelta: 0, overridesReset: 2 }), 'Already optimal — nothing moved. 2 buff overrides reset');
  });

  await check('the Optimize click counts the overrides before it clears them', () => {
    const at = app.script.indexOf("getElementById('btn-optimize').addEventListener('click'");
    const body = app.script.slice(at, at + 1200);
    const count = body.indexOf('Object.keys(State.buffOverrides).length');
    assert(count > 0 && count < body.indexOf('State.buffOverrides = {}'));
    assert(/optimizeToastMessage\(\{ moved, buffDelta, overridesReset \}\)/.test(body));
  });

  // ── U9: one sr-only status region ─────────────────────────────────
  const summarySrc = app.slice('// The sentence the screen-reader region announces', 'function renderSummaryBar');
  await check('the summary bar is not a live region and one sr-only status region exists', () => {
    const bar = app.html.match(/<div class="summary-bar"[^>]*>/)[0];
    assert(!/aria-live/.test(bar), bar);
    const regions = app.html.match(/<div[^>]*id="sr-status"[^>]*>/g) || [];
    assert.equal(regions.length, 1);
    assert(/class="sr-only"/.test(regions[0]) && /role="status"/.test(regions[0]) && /aria-live="polite"/.test(regions[0]) && /aria-atomic="true"/.test(regions[0]));
    assert(/\.sr-only\s*\{/.test(app.css));
  });

  await check('announce() writes the region once per distinct message', () => {
    const region = { textContent: '' };
    const document = { getElementById: id => id === 'sr-status' ? region : null };
    const { announce, describeRaidSummary } = app.sandbox(['announce', 'describeRaidSummary'], { globals: { document }, extraSource: summarySrc }).api;
    announce('25 of 25 in raid');
    assert.equal(region.textContent, '25 of 25 in raid');
    region.textContent = 'cleared by something else';
    announce('25 of 25 in raid');
    assert.equal(region.textContent, 'cleared by something else', 'an unchanged message is not re-announced');
    announce('24 of 25 in raid');
    assert.equal(region.textContent, '24 of 25 in raid');
    announce('');
    assert.equal(region.textContent, '24 of 25 in raid', 'empty messages are ignored');
    assert.equal(
      describeRaidSummary({ seated: 25, capacity: 25, counts: { tank: 1, healer: 5, melee_dps: 9, ranged: 10 }, benched: 2 }),
      '25 of 25 in raid: 1 tank, 5 healers, 9 melee, 10 ranged. 2 benched.');
  });

  await check('announce() is silent when the page has no region', () => {
    const { announce } = app.sandbox(['announce'], { globals: { document: { getElementById: () => null } }, extraSource: summarySrc }).api;
    announce('anything');
  });

  await check('renderSummaryBar announces through announce()', () => {
    const fn = app.slice('function renderSummaryBar', 'function updateStatus');
    assert(/announce\(describeRaidSummary\(/.test(fn));
  });

  // ── U10: landmarks and lists ──────────────────────────────────────
  await check('the page has a <main> landmark for each view and the markup still balances', () => {
    assert(/<main\b[^>]*id="landing-view"/.test(app.html));
    assert(/<main\b[^>]*id="app"[^>]*hidden/.test(app.html));
    assert.equal((app.html.match(/<main\b/g) || []).length, (app.html.match(/<\/main>/g) || []).length);
    assert.equal((app.html.match(/<div\b/g) || []).length, (app.html.match(/<\/div>/g) || []).length, 'div tags balance');
  });

  await check('the parties container is a list and every group card is a list item', () => {
    assert(/id="groups-container"[^>]*role="list"/.test(app.html));
    const cards = app.script.match(/<div class="group-card"[^>]*>/g) || [];
    assert.equal(cards.length, 2, 'plan and ideal-comp templates');
    for (const card of cards) assert(/role="listitem"/.test(card), card);
  });

  console.log(`\n${passed} UX checks passed`);
})().catch(e => { console.error(e); process.exit(1); });
