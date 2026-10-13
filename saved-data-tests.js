/**
 * PartyPlanner Web - saved plans and data tests (4.3.0, package L3-2)
 * Run: node saved-data-tests.js
 *
 * Delete on the landing rows, the Your plans pane copy, the last-backup stamp, the replace / template /
 * recent-import confirms, the Plan menu's Split entry and the Standby wording.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const toasts = [];
const asked = [];
let answer = true;
const fakeStorage = {
  data: new Map(),
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; },
  setItem(k, v) { this.data.set(k, String(v)); },
};
const elements = {};
const el = (id) => elements[id] || (elements[id] = { id, disabled: false, title: '' });

const SOURCE = [
  app.slice('function getSavedRosters()', 'function rememberImport'),
  app.slice('async function deleteSavedEntry', 'function renderLandingSavedList'),
  app.slice('const SplitFlow = {', "document.getElementById('btn-split-offer')"),
].join('\n');
const ctx = app.sandbox(
  ['State', 'Config', 'PlanStore', 'LiveLinks', 'BackupStamp', 'DataBackup', 'RaidSplit', 'SplitFlow',
    'getSavedRosters', 'saveRosterToStorage', 'confirmReplaceSavedCopy', 'deleteSavedEntry'],
  {
    globals: {
      localStorage: fakeStorage, setTimeout, clearTimeout,
      document: { getElementById: el },
      showToast: (m) => { toasts.push(m); },
      safeSetItem: (s, k, v) => { s.setItem(k, v); return true; },
      Modal: { confirm: async (opts) => { asked.push(opts); return answer; } },
    },
    extraSource: SOURCE,
  }
);
const { State, Config, PlanStore, LiveLinks, BackupStamp, DataBackup, RaidSplit, SplitFlow, getSavedRosters, saveRosterToStorage,
  confirmReplaceSavedCopy, deleteSavedEntry } = ctx.api;

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

  await check('landing rows are an open button plus a separate Delete button (no button inside a button)', () => {
    const rows = script.slice(script.indexOf('function renderLandingSavedList'), script.indexOf('(function initLanding'));
    for (const m of rows.matchAll(/<button[^>]*saved-open[^>]*>([^]*?)<\/button>/g)) assert(!m[1].includes('<button'));
    assert.equal((rows.match(/data-delete-plan=/g) || []).length, 1);
    assert.equal((rows.match(/data-delete-copy=/g) || []).length, 1);
    assert(rows.includes('class="link-btn del"') && rows.includes('>Delete</button>'));
    assert(rows.includes("querySelectorAll('.saved-open')"));
    assert(!script.includes('function showLoadModal'));
  });

  await check('Your plans pane: new storage note, backup restore link and last-backup line; old line gone', () => {
    assert(html.includes('Saved automatically in this browser only. Clearing site data removes them.'));
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
    assert(/<button[^>]*id="btn-split-plan"[^>]*>Split into two raids<\/button>/.test(html));
    assert(script.includes("getElementById('btn-split-plan').addEventListener('click', () => SplitFlow.preview())"));
  });

  await check('Standby wording: no "Backup for" or "Backup ready" in user-facing text; the new strings are present', () => {
    const visible = noComments(script) + '\n' + html;
    assert(!/Backup for|Backup ready/.test(visible));
    for (const text of ['Standby for', 'Standby ready', 'Standby: ', 'Not on Standby']) assert(visible.includes(text), text);
    assert(/class="backup-badge"[^>]*>S<\/span>/.test(script));
    // internals and data-file items are unchanged
    assert(html.includes('id="backup-banner"') && html.includes('>Export data backup<') && html.includes('Import data backup&hellip;'));
  });

  console.log(`\nSaved data tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
})();
