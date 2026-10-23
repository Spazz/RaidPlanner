/**
 * PartyPlanner Web - saved plans and data tests (4.3.0, package L3-2)
 * Run: node tests/planner/saved-data-tests.js
 *
 * Delete on the landing rows, the Your plans pane copy, the last-backup stamp, the replace / template /
 * recent-import confirms, the Plan menu's Split entry and the Standby wording.
 */
const assert = require('node:assert/strict');
const app = require('../load-app');

const toasts = [];
const asked = [];
let answer = true;
const fakeStorage = {
  data: new Map(),
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; },
  setItem(k, v) { this.data.set(k, String(v)); },
};
const fakeWindow = { localStorage: fakeStorage, location: { pathname: '/', search: '', hash: '', origin: 'https://pp.test' } };
const fakeHistory = { replaceState(_s, _t, url) { fakeWindow.location.pathname = url; } };
const lastRunCalls = [];
const elements = {};
const el = (id) => elements[id] || (elements[id] = { id, disabled: false, title: '' });

const SOURCE = [
  'function initGroups() {}',
  app.slice('function hasLoadedWork()', '// A random roster replaces'),
  app.slice('function getSavedRosters()', 'function rememberImport'),
  app.slice('function linkStorage()', '// The Error for a failed API response'),
  app.slice('async function deleteSavedEntry', 'function renderLandingSavedList'),
  app.slice('const SplitFlow = {', "document.getElementById('btn-split-offer')"),
].join('\n');
const ctx = app.sandbox(
  ['State', 'Config', 'PlanStore', 'LiveLinks', 'PlanDbLinks', 'BackupStamp', 'DataBackup', 'RaidSplit', 'SplitFlow',
    'getSavedRosters', 'saveRosterToStorage', 'bindLiveLink', 'syncAddressBar', 'confirmReplaceSavedCopy', 'deleteSavedEntry', 'hasLoadedWork', 'ChangeLog', 'Backups'],
  {
    globals: {
      localStorage: fakeStorage, setTimeout, clearTimeout,
      document: { getElementById: el },
      window: fakeWindow, history: fakeHistory,
      renderLastRun: (s) => { lastRunCalls.push(s); },
      showToast: (m) => { toasts.push(m); },
      safeSetItem: (s, k, v) => { s.setItem(k, v); return true; },
      Modal: { confirm: async (opts) => { asked.push(opts); return answer; } },
    },
    extraSource: SOURCE,
  }
);
const { State, Config, PlanStore, LiveLinks, PlanDbLinks, BackupStamp, DataBackup, RaidSplit, SplitFlow, getSavedRosters, saveRosterToStorage, bindLiveLink, syncAddressBar,
  confirmReplaceSavedCopy, deleteSavedEntry, hasLoadedWork, ChangeLog, Backups } = ctx.api;

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
const planData = (id, name) => ({
  planId: id, gameVersion: 'tbc', selectedRaid: Object.keys(Config.Raids)[0], rosterName: name, groups: [[]], bench: [],
  optimizerMode: 'max_dps', buffOverrides: {},
});
const reset = () => { fakeStorage.data.clear(); asked.length = 0; toasts.length = 0; answer = true; };
const plansLeft = () => PlanStore.read(fakeStorage).map(p => p.data.rosterName);
const html = app.html.replace(/\r\n/g, '\n');
const script = app.script.replace(/\r\n/g, '\n');
const noComments = (text) => text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

(async () => {
  await check('Delete on a working plan: declining keeps it, accepting removes only that plan', async () => {
    reset();
    PlanStore.save(fakeStorage, planData('plan:a', 'Gruul Thursday'));
    PlanStore.save(fakeStorage, planData('plan:b', 'Kara Sunday'));
    const key = LiveLinks.planKey(planData('plan:a'));
    answer = false;
    assert.equal(await deleteSavedEntry('plan', key, 'Gruul Thursday'), false);
    assert.equal(plansLeft().length, 2);
    answer = true;
    assert.equal(await deleteSavedEntry('plan', key, 'Gruul Thursday'), true);
    assert.deepEqual([...plansLeft()], ['Kara Sunday']);
    const q = asked[asked.length - 1];
    assert.equal(q.title, 'Delete plan');
    assert.equal(q.message, `Delete "Gruul Thursday"? This can't be undone.`);
    assert.equal(q.confirmLabel, 'Delete');
  });

  await check('Delete on a saved copy: declining keeps it, accepting removes only that copy', async () => {
    reset();
    saveRosterToStorage('Copy A', { players: [] });
    saveRosterToStorage('Copy B', { players: [] });
    answer = false;
    assert.equal(await deleteSavedEntry('copy', 'Copy A', 'Copy A'), false);
    assert.deepEqual(Object.keys(getSavedRosters()).sort(), ['Copy A', 'Copy B']);
    answer = true;
    assert.equal(await deleteSavedEntry('copy', 'Copy A', 'Copy A'), true);
    assert.deepEqual(Object.keys(getSavedRosters()), ['Copy B']);
  });

  await check('deleting a plan flushes a waiting save first, so autosave cannot write it back', async () => {
    reset();
    const data = planData('plan:c', 'Open plan');
    PlanStore.save(fakeStorage, data);
    PlanStore.saveSoon(fakeStorage, planData('plan:c', 'Open plan edited'), () => {});
    assert(PlanStore.pending);
    assert.equal(PlanStore.remove(fakeStorage, LiveLinks.planKey(data)), true);
    assert.equal(PlanStore.pending, null);
    PlanStore.flush();
    assert.equal(plansLeft().length, 0);
    assert.equal(PlanStore.remove(fakeStorage, 'tbc|nope'), false);
  });

  await check('LiveLinks.drop removes only that plan\'s binding', () => {
    reset();
    LiveLinks.bind(fakeStorage, 'tbc|plan:a', 'AAAAAAA', 'code-a', 1);
    LiveLinks.bind(fakeStorage, 'tbc|plan:b', 'BBBBBBB', 'code-b', 2);
    assert.equal(LiveLinks.drop(fakeStorage, 'tbc|plan:a'), true);
    assert.deepEqual(Object.keys(LiveLinks.read(fakeStorage)), ['tbc|plan:b']);
    assert.equal(LiveLinks.read(fakeStorage)['tbc|plan:b'].id, 'BBBBBBB');
    assert.equal(LiveLinks.drop(fakeStorage, 'tbc|plan:a'), false, 'a missing binding is a no-op');
    assert.equal(LiveLinks.drop(fakeStorage, null), false);
    assert.equal(LiveLinks.drop(fakeStorage, 'constructor'), false, 'inherited keys are not bindings');
  });

  await check('deleting a plan also drops its live-link binding and keeps the others', async () => {
    reset();
    PlanStore.save(fakeStorage, planData('plan:a', 'Gruul Thursday'));
    PlanStore.save(fakeStorage, planData('plan:b', 'Kara Sunday'));
    LiveLinks.bind(fakeStorage, LiveLinks.planKey(planData('plan:a')), 'AAAAAAA', 'code-a', 1);
    LiveLinks.bind(fakeStorage, LiveLinks.planKey(planData('plan:b')), 'BBBBBBB', 'code-b', 2);
    State.planId = 'plan:other';
    answer = false;
    await deleteSavedEntry('plan', LiveLinks.planKey(planData('plan:a')), 'Gruul Thursday');
    assert.equal(Object.keys(LiveLinks.read(fakeStorage)).length, 2, 'declining drops nothing');
    answer = true;
    await deleteSavedEntry('plan', LiveLinks.planKey(planData('plan:a')), 'Gruul Thursday');
    assert.deepEqual(Object.keys(LiveLinks.read(fakeStorage)), [LiveLinks.planKey(planData('plan:b'))]);
  });

  await check('deleting the open plan clears the working state: no Resume offer, nothing autosaves it back', async () => {
    reset();
    const open = planData('plan:open', 'Open plan');
    PlanStore.save(fakeStorage, open);
    PlanStore.save(fakeStorage, planData('plan:b', 'Kara Sunday'));
    Object.assign(State, { planId: 'plan:open', gameVersion: 'tbc', rosterName: 'Open plan', roster: [{ uid: 'u1', name: 'A' }], groups: [[{ uid: 'u1', name: 'A' }]], bench: [{ uid: 'u2', name: 'B' }], notes: 'hello' });
    PlanStore.saveSoon(fakeStorage, planData('plan:open', 'Open plan edited'), () => {});
    assert.equal(hasLoadedWork(), true);
    assert.equal(await deleteSavedEntry('plan', LiveLinks.planKey(open), 'Open plan'), true);
    assert.equal(hasLoadedWork(), false, 'the landing Resume banner (hasLoadedWork) stops offering it');
    assert.equal(State.planId, null);
    assert.equal(State.notes, '');
    PlanStore.flush();
    assert.deepEqual([...plansLeft()], ['Kara Sunday'], 'no autosave writes the plan back');
    // another plan's deletion leaves the open plan alone
    Object.assign(State, { planId: 'plan:b', roster: [{ uid: 'u9', name: 'Z' }], groups: [[{ uid: 'u9', name: 'Z' }]] });
    assert.equal(await deleteSavedEntry('plan', LiveLinks.planKey(planData('plan:zzz')), 'Nope'), true);
    assert.equal(hasLoadedWork(), true);
    assert.equal(State.planId, 'plan:b');
    // the landing re-renders after a removal
    const handler = script.slice(script.indexOf("box.querySelectorAll('[data-delete-plan], [data-delete-copy]')"), script.indexOf("box.querySelectorAll('.saved-open')"));
    assert(/if \(removed\) renderLanding\(\);/.test(handler));
  });

  await check('Standby wording in the link and swap-in errors', () => {
    reset();
    State.roster = [{ uid: 'p1', name: 'Prime' }];
    State.bench = [{ uid: 'b1', name: 'Bench' }];
    assert.equal(Backups.link('Gone', 'Bench').error, 'Standby target must be seated');
    assert.equal(Backups.link('Prime', 'Nobody').error, 'A standby player must be on the bench');
    State.backups = {};
    assert.equal(Backups.swapIn('Prime', 0).error, 'No standby player set');
  });

  await check('landing rows are an open button plus a More menu that holds Delete (no button inside a button)', () => {
    const rows = script.slice(script.indexOf('function landingRowMoreHtml'), script.indexOf('(function initLanding'));
    for (const m of rows.matchAll(/<button[^>]*saved-open[^>]*>([^]*?)<\/button>/g)) assert(!m[1].includes('<button'));
    assert.equal((rows.match(/'data-delete-plan'/g) || []).length, 1);
    assert.equal((rows.match(/'data-delete-copy'/g) || []).length, 1);
    assert(rows.includes('class="menu-item menu-item-danger" role="menuitem"') && rows.includes('>Delete</button>'), 'Delete lives inside the menu');
    assert(rows.includes('gs-menu-list') && rows.includes('aria-haspopup="menu"') && rows.includes('aria-label="More for'), 'a labelled More button opens it');
    assert(rows.includes("querySelectorAll('.saved-open')"));
    assert(!script.includes('function showLoadModal'));
  });

  await check('Your plans pane: the browser-only foot line, backup restore link and last-backup line; old lines gone', () => {
    assert(html.includes('Plans live in this browser. Clearing site data removes them.'));
    assert(!html.includes('Saved automatically in this browser only.'));
    assert(!html.includes('Latest changes saved automatically on this device.'));
    assert(/<button[^>]*id="btn-landing-restore"[^>]*>Restore from a backup file<\/button>/.test(html));
    assert(html.includes('id="landing-last-backup"'));
    // the file input must sit outside #app so the landing link works while #app is hidden
    const appEnd = html.indexOf('</main>', html.indexOf('id="app"'));
    assert(html.indexOf('id="backup-file-input"') > appEnd, 'backup-file-input is inside #app');
    assert(script.includes("getElementById('btn-landing-restore').addEventListener('click', () => document.getElementById('backup-file-input').click())"));
  });

  await check('BackupStamp: "No backup yet" until an export is recorded, then the date; never part of DataBackup.keys', () => {
    reset();
    assert.equal(BackupStamp.label(fakeStorage), 'No backup yet');
    assert.equal(BackupStamp.key, 'pp_last_backup_at');
    BackupStamp.record(fakeStorage, Date.UTC(2026, 9, 9, 12));
    assert.match(BackupStamp.label(fakeStorage), /^Last backup: .*2026/);
    assert(![...DataBackup.keys].includes('pp_last_backup_at'));
    fakeStorage.setItem('pp_last_backup_at', 'junk');
    assert.equal(BackupStamp.label(fakeStorage), 'No backup yet');
    const exportHandler = script.slice(script.indexOf("getElementById('btn-export-backup').addEventListener"), script.indexOf('const BackupRestoreUI'));
    assert(exportHandler.includes('BackupStamp.record(localStorage)'));
  });

  await check('Save a copy under an existing name asks first; a new name does not', async () => {
    reset();
    assert.equal(await confirmReplaceSavedCopy('Fresh'), true);
    assert.equal(asked.length, 0);
    saveRosterToStorage('Taken', { players: [] });
    answer = false;
    assert.equal(await confirmReplaceSavedCopy('Taken'), false);
    const q = asked[0];
    assert.equal(q.title, 'Replace saved copy?');
    assert.equal(q.message, 'A saved copy named "Taken" exists. Replace it with the current plan?');
    assert.equal(q.confirmLabel, 'Replace');
    answer = true;
    assert.equal(await confirmReplaceSavedCopy('Taken'), true);
    const at = script.indexOf("document.getElementById('btn-do-save').onclick");
    const handler = script.slice(at, script.indexOf('closeSaveOverlay();', at));
    assert(/if \(!await confirmReplaceSavedCopy\(name\)\) return;[^]*saveRosterToStorage\(name, data\)/.test(handler));
  });

  await check('Template delete and recent-import delete confirm before removing', () => {
    const tpl = script.slice(script.indexOf("modal.querySelectorAll('[data-template-delete]')"), script.indexOf("document.getElementById('btn-unlock-templates')"));
    assert(/title: 'Delete template\?', message: `Delete the template "\$\{btn\.dataset\.templateDelete\}"\?`, confirmLabel: 'Delete'[^]*if \(!ok\) return;[^]*Templates\.delete\(/.test(tpl));
    const hist = script.slice(script.indexOf("querySelectorAll('[data-history-delete]')"), script.indexOf('// Shared by every path that hides'));
    assert(/title: 'Remove from recent imports\?'[^]*Remove "\$\{[^}]*\}" from recent imports\?`, confirmLabel: 'Remove'[^]*if \(!ok\) return;[^]*ImportHistory\.remove\(/.test(hist));
  });

  await check('Split menu entry: enabled at the raid size threshold, disabled below it with the reason', () => {
    const need = RaidSplit.suggestThreshold(Config.Raids[State.selectedRaid].size);
    const person = (i) => ({ uid: 'u' + i, name: 'P' + i });
    State.roster = Array.from({ length: need - 1 }, (_, i) => person(i));
    State.bench = [];
    let s = SplitFlow.menuState();
    assert.equal(s.enabled, false);
    assert.equal(s.title, `Needs at least ${need} players`);
    SplitFlow.syncMenu();
    assert.equal(el('btn-split-plan').disabled, true);
    State.bench = [person('b')];
    s = SplitFlow.menuState();
    assert.equal(s.enabled, true);
    SplitFlow.syncMenu();
    assert.equal(el('btn-split-plan').disabled, false);
    assert(/<button[^>]*id="btn-split-plan"[^>]*>Split into two raids<small id="split-plan-reason"><\/small><\/button>/.test(html));
    assert(!/id="btn-split-plan"[^>]*aria-label/.test(html), 'the visible reason must stay part of the accessible name');
    assert(script.includes("getElementById('btn-split-plan').addEventListener('click', () => SplitFlow.preview())"));
  });

  await check('Split menu entry ships disabled and shows the reason as visible text, cleared once enabled', () => {
    assert(/<button[^>]*id="btn-split-plan"[^>]* disabled[ >]/.test(html), 'disabled until the first sync');
    const need = RaidSplit.suggestThreshold(Config.Raids[State.selectedRaid].size);
    State.roster = [{ uid: 'u1', name: 'P1' }];
    State.bench = [];
    SplitFlow.syncMenu();
    assert.equal(el('split-plan-reason').textContent, `Needs at least ${need} players`);
    State.roster = Array.from({ length: need }, (_, i) => ({ uid: 'u' + i, name: 'P' + i }));
    SplitFlow.syncMenu();
    assert.equal(el('split-plan-reason').textContent, '');
    const flat = app.css.replace(/\r\n/g, '\n');
    assert(/\.menu-item:disabled \{ opacity: \.5; cursor: default; \}/.test(flat));
    assert(!/\.menu-item:disabled:hover/.test(flat), 'no hover change when disabled');
  });

  await check('deleting the open plan bound to a live link: address bar back to /, no binding, last-run cleared, no late re-bind', async () => {
    reset();
    lastRunCalls.length = 0;
    const open = planData('plan:live', 'Live plan');
    const key = LiveLinks.planKey(open);
    PlanStore.save(fakeStorage, open);
    Object.assign(State, { planId: 'plan:live', gameVersion: 'tbc', rosterName: 'Live plan', roster: [{ uid: 'u1', name: 'A' }], groups: [[{ uid: 'u1', name: 'A' }]], bench: [] });
    LiveLinks.bind(fakeStorage, key, 'LIVEAAA', 'code', 1);
    fakeWindow.location.pathname = '/tbc/LIVEAAA';
    syncAddressBar();
    assert.equal(fakeWindow.location.pathname, '/tbc/LIVEAAA', 'bound open plan keeps its link URL');
    assert.equal(await deleteSavedEntry('plan', key, 'Live plan'), true);
    assert.equal(fakeWindow.location.pathname, '/', 'address bar is back at the root');
    assert.deepEqual(Object.keys(LiveLinks.read(fakeStorage)), [], 'no live-link binding is left');
    assert.deepEqual(lastRunCalls, [null], 'the stale last-run summary is cleared');
    // A live-link save that finishes after the delete cannot bring the binding back.
    bindLiveLink(key, 'LIVEAAA', 'code', 2);
    assert.deepEqual(Object.keys(LiveLinks.read(fakeStorage)), [], 'a late completion does not re-bind a deleted plan');
    // ...while a plan that still exists can still be bound.
    PlanStore.save(fakeStorage, planData('plan:kept', 'Kept'));
    bindLiveLink(LiveLinks.planKey(planData('plan:kept')), 'KEPTAAA', 'c', 1);
    assert.deepEqual(Object.keys(LiveLinks.read(fakeStorage)), [LiveLinks.planKey(planData('plan:kept'))]);
  });

  await check('Standby wording: no "Backup for" or "Backup ready" in user-facing text; the new strings are present', () => {
    const visible = noComments(script) + '\n' + html;
    assert(!/Backup for|Backup ready/.test(visible));
    for (const text of ['Standby for', 'Standby ready', 'Standby: ', 'Not on Standby']) assert(visible.includes(text), text);
    assert(/class="backup-badge"[^>]*>S<\/span>/.test(script));
    // internals and data-file items are unchanged
    assert(html.includes('id="backup-banner"') && html.includes('>Export data backup<') && html.includes('Import data backup&hellip;'));
  });

  // ── guild raid plans in the database (pp_plan_db) ──
  await check('PlanStore.save never evicts a plan whose edits the server has not acknowledged (dirty pp_plan_db), but a clean binding is evictable', async () => {
    reset();
    PlanStore.max = 3;
    try {
      PlanStore.save(fakeStorage, planData('raid:r1', 'unsent'));
      PlanStore.save(fakeStorage, planData('raid:r2', 'clean'));
      PlanStore.save(fakeStorage, planData('plan:c', 'c'));
      PlanDbLinks.bind(fakeStorage, 'tbc|raid:r1', { gid: 'g1', rid: 'r1', rev: 4 });
      PlanDbLinks.markDirty(fakeStorage, 'tbc|raid:r1');
      PlanDbLinks.bind(fakeStorage, 'tbc|raid:r2', { gid: 'g1', rid: 'r2', rev: 2 });
      const res = PlanStore.save(fakeStorage, planData('plan:d', 'd'));
      assert.equal(res.evicted.length, 1);
      assert.deepEqual([...plansLeft()].sort(), ['c', 'clean', 'd', 'unsent'].filter(n => n !== res.evicted[0]).sort());
      assert(plansLeft().includes('unsent'), 'the unsent plan stays');
    } finally { PlanStore.max = 50; }
  });

  await check('with every other plan dirty the cap runs over instead of dropping unsent edits', async () => {
    reset();
    PlanStore.max = 2;
    try {
      for (const id of ['a', 'b', 'c']) {
        PlanStore.save(fakeStorage, planData('raid:' + id, id));
        PlanDbLinks.bind(fakeStorage, 'tbc|raid:' + id, { gid: 'g1', rid: id, rev: 1 });
        PlanDbLinks.markDirty(fakeStorage, 'tbc|raid:' + id);
      }
      PlanStore.save(fakeStorage, planData('plan:d', 'd'));
      assert.deepEqual([...plansLeft()].sort(), ['a', 'b', 'c', 'd']);
    } finally { PlanStore.max = 50; }
  });

  await check('a corrupt pp_plan_db protects nothing and breaks nothing', async () => {
    reset();
    fakeStorage.setItem('pp_plan_db', '{broken');
    assert.doesNotThrow(() => PlanStore.save(fakeStorage, planData('plan:a', 'a')));
    assert.deepEqual([...plansLeft()], ['a']);
  });

  const planDbEntries = (extra = {}) => JSON.stringify({ 'tbc|raid:r1': { gid: 'g1', rid: 'r1', rev: 3, dirty: true }, ...extra });

  await check('DataBackup: pp_plan_db is in the key list and a restore into an empty browser reproduces the bindings', async () => {
    reset();
    assert(DataBackup.keys.includes('pp_plan_db'));
    fakeStorage.setItem('pp_plan_db', planDbEntries());
    const backup = DataBackup.build(fakeStorage);
    assert.equal(backup.data.pp_plan_db, planDbEntries());
    const verdict = DataBackup.validate(backup);
    assert.equal(verdict.valid, true, verdict.errors.join('; '));
    assert.equal(verdict.summary.pp_plan_db.count, 1);
    fakeStorage.data.clear();
    assert.equal(DataBackup.apply(fakeStorage, backup, 'merge').success, true);
    assert.deepEqual(JSON.parse(fakeStorage.getItem('pp_plan_db')), JSON.parse(planDbEntries()));
    assert.equal(PlanDbLinks.get(fakeStorage, 'tbc|raid:r1').rev, 3);
  });

  await check('DataBackup: a browser with no bindings omits the key, and an older backup never wipes them', async () => {
    reset();
    assert(!Object.prototype.hasOwnProperty.call(DataBackup.build(fakeStorage).data, 'pp_plan_db'));
    fakeStorage.setItem('pp_plan_db', planDbEntries());
    assert.equal(DataBackup.apply(fakeStorage, { schema: DataBackup.schema, version: 1, data: { pp_sidebar_expanded: '1' } }, 'merge').success, true);
    assert.equal(PlanDbLinks.get(fakeStorage, 'tbc|raid:r1').rev, 3);
  });

  await check('DataBackup: validate rejects bad JSON, wrong shape and malformed pp_plan_db entries', async () => {
    const bad = raw => DataBackup.validate({ schema: DataBackup.schema, version: 1, data: { pp_plan_db: raw } }).valid;
    assert.equal(bad('{nope'), false);
    assert.equal(bad('[1]'), false, 'array instead of object');
    assert.equal(bad(JSON.stringify({ k: 'x' })), false, 'entry must be an object');
    assert.equal(bad(JSON.stringify({ k: { gid: 'g', rid: 'r', rev: -1, dirty: false } })), false, 'rev is a non-negative integer');
    assert.equal(bad(JSON.stringify({ k: { gid: 'g', rid: 'r', rev: 1, dirty: 'yes' } })), false, 'dirty is a boolean');
    assert.equal(bad(JSON.stringify({ k: { gid: '', rid: 'r', rev: 1, dirty: false } })), false, 'gid is required');
    assert.equal(bad(planDbEntries()), true);
    assert.equal(bad('{}'), true, 'no bindings is a valid empty set');
  });

  await check('DataBackup merge: a binding this browser already has stays (it knows its revision), missing ones come in', async () => {
    reset();
    fakeStorage.setItem('pp_plan_db', JSON.stringify({ 'tbc|raid:r1': { gid: 'g1', rid: 'r1', rev: 9, dirty: false } }));
    const backup = { schema: DataBackup.schema, version: 1, data: { pp_plan_db: planDbEntries({ 'tbc|raid:r2': { gid: 'g1', rid: 'r2', rev: 1, dirty: false } }) } };
    assert.equal(DataBackup.apply(fakeStorage, backup, 'merge').success, true);
    assert.equal(PlanDbLinks.get(fakeStorage, 'tbc|raid:r1').rev, 9, 'kept');
    assert.equal(PlanDbLinks.get(fakeStorage, 'tbc|raid:r1').dirty, false);
    assert.equal(PlanDbLinks.get(fakeStorage, 'tbc|raid:r2').rev, 1, 'added');
  });

  await check('a guild raid plan row: "Guild raid" chip, opens through the raid, Delete only clears this device and says the raid keeps its plan', async () => {
    reset();
    const raidPlan = planData('raid:r1', 'Sat BT');
    const standalone = planData('plan:a', 'Gruul Thursday');
    PlanStore.save(fakeStorage, raidPlan);
    PlanStore.save(fakeStorage, standalone);
    PlanDbLinks.bind(fakeStorage, 'tbc|raid:r1', { gid: 'g1', rid: 'r1', rev: 2 });
    const raidKey = LiveLinks.planKey(raidPlan);
    // The list: the chip on the raid row only; a click opens the raid's address, not this device's copy.
    const clicks = {};
    const copies = { innerHTML: '', querySelectorAll: () => [] };
    const list = { innerHTML: '', closest: () => ({ classList: { toggle() {} } }), querySelectorAll: sel => (sel === '.saved-open'
      ? ['tbc|raid:r1', 'tbc|plan:a'].map(key => ({ dataset: { plan: key }, addEventListener: (_e, fn) => { clicks[key] = fn; } })) : []) };
    const hash = { value: '' };
    const win = { location: { set hash(v) { hash.value = v; } }, Guild: { router: { format: r => '#/planner?raid=' + r.gid + '.' + r.rid } } };
    const sandbox = app.sandbox(['renderLandingSavedList', 'PlanStore', 'ImportHistory', 'BackupStamp', 'PlanDbLinks'], { extraSource: app.slice('function landingRowMoreHtml', '// The sample behind') + '\n', globals: {
      document: { getElementById: id => id === 'landing-saved-list' ? list : id === 'landing-copies-list' ? copies : { textContent: '' } },
      localStorage: fakeStorage, getSavedRosters: () => ({}), window: win, ChangeLog: { clear() {} }, initGroups() {}, commit() {}, showView() {}, RaidHelperSync: { check() {} },
    } });
    sandbox.api.ImportHistory.read = () => [];
    sandbox.api.BackupStamp.label = () => '';
    sandbox.api.renderLandingSavedList();
    const rows = list.innerHTML.split('<li class="gs-ph-prow">').slice(1);
    assert.equal(rows.length, 2);
    const raidRow = rows.find(r => r.includes('Sat BT'));
    const plainRow = rows.find(r => r.includes('Gruul Thursday'));
    assert(raidRow.includes('<span class="gs-hd-chip is-grey">Guild raid</span>'), 'the raid plan carries the chip');
    assert(!plainRow.includes('Guild raid'), 'a standalone plan has none');
    let restored = 0;
    sandbox.api.PlanStore.restore = () => { restored++; return true; };
    clicks['tbc|raid:r1']();
    assert.equal(hash.value, '#/planner?raid=g1.r1', 'opens through the raid context');
    assert.equal(restored, 0, 'not from this device\'s copy');
    clicks['tbc|plan:a']();
    assert.equal(restored, 1, 'a standalone plan opens from the device as before');
    // Delete.
    assert.equal(await deleteSavedEntry('plan', raidKey, 'Sat BT'), true);
    const q = asked[asked.length - 1];
    assert.equal(q.message, 'Remove "Sat BT" from this device? The raid keeps its plan.');
    assert.deepEqual([q.title, q.confirmLabel], ['Remove from this device', 'Remove']);
    assert.deepEqual([...plansLeft()], ['Gruul Thursday']);
    assert.equal(PlanDbLinks.get(fakeStorage, raidKey), null, 'the raid binding of this device goes with the copy');
    assert.equal(toasts[toasts.length - 1], 'Removed "Sat BT" from this device');
    assert.equal(await deleteSavedEntry('plan', LiveLinks.planKey(standalone), 'Gruul Thursday'), true);
    assert.equal(asked[asked.length - 1].message, 'Delete "Gruul Thursday"? This can\'t be undone.', 'a standalone plan keeps the old text');
  });

  console.log(`\nSaved data tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
})();
