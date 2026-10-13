/**
 * PartyPlanner Web - import copy tests (4.3.0, package L2-1)
 * Run: node import-copy-tests.js
 *
 *   - every failure class maps to one plain sentence plus a next step; unmapped errors keep their text
 *   - the landing import status clears on render and on input, and survives right after a failed run
 *   - the plain-text preview names the raid the players go to, incl. the automatic 10-man pick
 *   - the Load button reads "Loading..." with aria-busy during a run and is restored afterwards
 *   - the import card copy
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS  ' + name); }

const importSrc = app.slice('function normalizeImportSource', '// ── PLAIN-TEXT ROSTER IMPORT PREVIEW');
const plainStart = app.script.indexOf('const PlainRosterImport = {');
const plainSrc = app.script.slice(plainStart, app.script.indexOf('\n};', plainStart) + 3);
const runnerSrc = app.slice('// ── SHARED IMPORT RUNNER', "document.getElementById('btn-plain-import-cancel')");

function importEnv(fetchImpl) {
  const globals = {
    fetch: fetchImpl || (async () => { throw new TypeError('x'); }),
    AbortController, TypeError, setTimeout, clearTimeout, localStorage: {},
    document: { getElementById: () => null },
    initGroups: () => 0, commit() {}, showToast() {}, rememberImport: () => '', maybeSuggestVersionSwitch() {},
  };
  return app.sandbox(['importFromText', 'importErrorMessage', 'fetchRosterJson'], { globals, extraSource: importSrc }).api;
}

(async () => {
  const MSG = {
    unreadable: "We couldn't read that as a Raid-Helper link, event ID, JSON or player list. A player line looks like: Thrall - Enhancement Shaman.",
    notFound: "Raid-Helper couldn't find that event. Check the link or ID. For a private event, paste its JSON export instead.",
    http: status => `Raid-Helper returned an error (HTTP ${status}). Try again in a minute, or paste the event's JSON export.`,
    timeout: "Raid-Helper took too long to answer. Try again, or paste the event's JSON export.",
    network: "Couldn't reach Raid-Helper. Your connection may be down, or the browser blocked the request. Paste the event's JSON export instead.",
    private: "Raid-Helper won't share that event. It may be private: paste its JSON export instead.",
    notAnEvent: "Raid-Helper answered with something that isn't an event export. Try again, or paste the event's JSON export.",
    notExport: "That JSON isn't a Raid-Helper event export. Use the event's JSON export, or paste a player list.",
    noPlayers: 'That event has no sign-ups with a class yet.',
    unsupported: "That event's game version or raid isn't supported here.",
  };

  await check('importErrorMessage maps each failure class and keeps unmapped text', () => {
    const { importErrorMessage } = importEnv();
    assert.equal(importErrorMessage({ raw: 'Invalid JSON: Unexpected token' }), MSG.unreadable);
    assert.equal(importErrorMessage({ http: 404 }), MSG.notFound);
    assert.equal(importErrorMessage({ http: 503 }), MSG.http(503));
    assert.equal(importErrorMessage({ http: 401 }), MSG.private);
    assert.equal(importErrorMessage({ http: 403 }), MSG.private);
    assert.equal(importErrorMessage({ timeout: true }), MSG.timeout);
    assert.equal(importErrorMessage({ network: true }), MSG.network);
    assert.equal(importErrorMessage({ raw: "No 'slots' or 'signUps' array found in JSON" }), MSG.notExport);
    assert.equal(importErrorMessage({ raw: 'No valid players found in sign-ups' }), MSG.noPlayers);
    assert.equal(importErrorMessage({ raw: 'invalid game version or raid' }), MSG.unsupported);
    assert.equal(importErrorMessage({ raw: 'Something else broke' }), 'Import failed: Something else broke');
  });

  await check('fetchRosterJson reports the mapped HTTP, timeout and network messages', async () => {
    const run = async fetchImpl => {
      const out = [];
      const body = await importEnv(fetchImpl).fetchRosterJson('https://raid-helper.dev/api/v4/events/1', (m, e) => out.push([m, e]));
      return { body, out };
    };
    let r = await run(async () => ({ ok: false, status: 404 }));
    assert.deepEqual(r.out, [[MSG.notFound, true]]);
    assert.equal(r.body, null);
    r = await run(async () => ({ ok: false, status: 500 }));
    assert.deepEqual(r.out, [[MSG.http(500), true]]);
    r = await run(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    assert.deepEqual(r.out, [[MSG.timeout, true]]);
    r = await run(async () => { throw new TypeError('Failed to fetch'); });
    assert.deepEqual(r.out, [[MSG.network, true]]);
    r = await run(async () => { throw new Error('weird'); });
    assert.deepEqual(r.out, [['Fetch failed: weird', true]]);
  });

  await check('Refresh failures use refresh wording and never mention pasting', async () => {
    const refresh = {
      notFound: "Raid-Helper couldn't find this event any more. It may have been deleted or made private.",
      private: "Raid-Helper won't share this event any more. It may have been made private.",
      http: status => `Raid-Helper returned an error (HTTP ${status}). Try Refresh again in a minute.`,
      timeout: 'Raid-Helper took too long to answer. Try Refresh again.',
      network: "Couldn't reach Raid-Helper. Check your connection and try Refresh again.",
    };
    const run = async fetchImpl => {
      const out = [];
      await importEnv(fetchImpl).fetchRosterJson('https://raid-helper.dev/api/v4/events/1', (m, e) => out.push([m, e]), 'refresh');
      return out;
    };
    assert.deepEqual(await run(async () => ({ ok: false, status: 404 })), [[refresh.notFound, true]]);
    assert.deepEqual(await run(async () => ({ ok: false, status: 401 })), [[refresh.private, true]]);
    assert.deepEqual(await run(async () => ({ ok: false, status: 403 })), [[refresh.private, true]]);
    assert.deepEqual(await run(async () => ({ ok: false, status: 502 })), [[refresh.http(502), true]]);
    assert.deepEqual(await run(async () => { const e = new Error('a'); e.name = 'AbortError'; throw e; }), [[refresh.timeout, true]]);
    assert.deepEqual(await run(async () => { throw new TypeError('Failed to fetch'); }), [[refresh.network, true]]);
    // The Refresh path itself asks for the refresh wording.
    const syncEnv = app.sandbox(['RaidHelperSync', 'State'], {
      globals: {
        fetch: async () => ({ ok: false, status: 404 }), AbortController, TypeError, setTimeout, clearTimeout, localStorage: {},
        document: { getElementById: () => null },
      },
      extraSource: importSrc + ' ' + app.slice('const RaidHelperSync = {', "document.getElementById('btn-refresh').addEventListener"),
    }).api;
    syncEnv.State.sourceEventId = '123'; syncEnv.State.planId = 'event:123';
    const sync = syncEnv.RaidHelperSync;
    const out = [];
    assert.equal(await sync.fetchDiff((m, e) => out.push([m, e])), null);
    assert.deepEqual(out, [[refresh.notFound, true]]);
    assert(!out.some(([m]) => /paste/i.test(m)));
  });

  await check('a fetched link whose body is not JSON gets the not-an-export text, not the unreadable-paste text', async () => {
    const html = async () => ({ ok: true, status: 200, text: async () => '<html>Service unavailable</html>' });
    const out = [];
    assert.equal(await importEnv(html).importFromText('https://raid-helper.dev/api/v4/events/123456789', (m, e) => out.push([m, e])), false);
    assert.deepEqual(out.filter(([, e]) => e), [[MSG.notAnEvent, true]]);
    // A paste that is not JSON keeps the unreadable-paste text.
    const pasted = [];
    await importEnv().importFromText('zzz qqq', (m, e) => pasted.push([m, e]));
    assert.deepEqual(pasted, [[MSG.unreadable, true]]);
  });

  await check('importFromText reports the mapped text for unreadable and non-export pastes', async () => {
    const env = importEnv();
    const attempt = async text => { const out = []; const ok = await env.importFromText(text, (m, e) => out.push([m, e])); return { ok, out }; };
    let r = await attempt('zzz qqq');
    assert.equal(r.ok, false);
    assert.deepEqual(r.out, [[MSG.unreadable, true]]);
    r = await attempt('{"foo": 1}');
    assert.deepEqual(r.out, [[MSG.notExport, true]]);
  });

  await check('the host and event-link refusals keep their wording', async () => {
    const out = [];
    await importEnv().importFromText('https://example.com/x', m => out.push(m));
    assert.equal(out.length, 1);
    assert(/Raid-Helper/.test(out[0]) && /event link or ID/.test(out[0]) && /JSON/.test(out[0]));
  });

  await check('the plain-text preview names the raid: TBC 25-man, and the automatic 10-man pick', () => {
    const { State, PlainRosterImport, Config } = app.sandbox(['State', 'PlainRosterImport', 'Config'], { extraSource: plainSrc }).api;
    const parsed = n => ({ entries: Array.from({ length: n }, (_, i) => ({ name: 'P' + i })), unparsed: [] });
    State.gameVersion = 'tbc'; State.selectedRaid = 'gruul';
    assert.equal(PlainRosterImport.summaryText(parsed(12), 0), "12 players into WoW TBC Gruul's Lair (25-man). Groups are arranged automatically.");
    const ten = Config.Raids[Config.RaidOrder.find(k => Config.Raids[k].size === 10)];
    assert.equal(PlainRosterImport.summaryText(parsed(1), 0), `1 player into WoW TBC ${ten.name} (10-man). Groups are arranged automatically.`);
    assert.equal(PlainRosterImport.summaryText(parsed(10), 2), `10 players into WoW TBC ${ten.name} (10-man). Groups are arranged automatically. 2 flagged for review.`);
    assert.equal(PlainRosterImport.summaryText(parsed(0), 0), 'No players recognized.');
  });

  await check('Import.plainRosterRaid is the pick importPlainRoster makes', () => {
    const { State, Import, Config } = app.sandbox(['State', 'Import', 'Config']).api;
    assert.equal(Import.plainRosterRaid(11, 'tbc', 'gruul'), 'gruul');
    assert.equal(Config.Raids[Import.plainRosterRaid(10, 'tbc', 'gruul')].size, 10);
    // Classic picks from the Classic list whichever version is open: the first 20-man there is Zul'Gurub.
    assert.equal(State.gameVersion, 'tbc');
    assert.equal(Import.plainRosterRaid(20, 'classic', 'mc'), 'zg');
    State.gameVersion = 'classic';
    assert.equal(Import.plainRosterRaid(20, 'classic', 'mc'), 'zg');
    State.gameVersion = 'tbc';
    assert.equal(Import.plainRosterRaid(21, 'classic', 'mc'), 'mc');
    assert.equal(Import.plainRosterRaid(3, 'forever', 'f_ony'), 'f_ony');
    State.gameVersion = 'tbc'; State.selectedRaid = 'gruul';
    const result = Import.importPlainRoster([{ name: 'A', class: 'MAGE', spec: 'Frost', role: 'caster_dps' }]);
    assert.equal(result.success, true);
    assert.equal(Config.Raids[State.selectedRaid].size, 10);
  });

  await check('runImport shows Loading... with aria-busy during the run and restores both afterwards', async () => {
    const attrs = {};
    const els = {
      inp: { value: 'data', focus() {} },
      btn: { disabled: false, textContent: 'Load roster', setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; } },
      st: { textContent: '', classList: { toggle() {} } },
    };
    let during = null; let release;
    const importFromText = () => new Promise(resolve => {
      during = { label: els.btn.textContent, busy: attrs['aria-busy'] };
      release = resolve;
    });
    const make = fn => app.sandbox(['runImport'], { globals: { document: { getElementById: id => els[id] }, importFromText: fn }, extraSource: runnerSrc }).api.runImport;
    const run = make(importFromText)('inp', 'st', 'btn', () => {});
    assert.deepEqual(during, { label: 'Loading...', busy: 'true' });
    release(false);
    await run;
    assert.equal(els.btn.textContent, 'Load roster');
    assert.equal('aria-busy' in attrs, false);
    await assert.rejects(make(async () => { throw new Error('x'); })('inp', 'st', 'btn', () => {}));
    assert.equal(els.btn.textContent, 'Load roster');
    assert.equal('aria-busy' in attrs, false);
  });

  await check('the landing import status clears on render and on input; a failed run still shows it', async () => {
    const status = { textContent: 'Old error', cls: new Set(['error']), classList: { remove(c) { status.cls.delete(c); } } };
    const fnStart = app.script.indexOf('function clearLandingImportStatus');
    const src = app.script.slice(fnStart, app.script.indexOf('\n}', fnStart) + 2);
    const { clearLandingImportStatus } = app.sandbox(['clearLandingImportStatus'], {
      globals: { document: { getElementById: id => id === 'landing-status-import' ? status : null } }, extraSource: src,
    }).api;
    clearLandingImportStatus();
    assert.equal(status.textContent, '');
    assert.equal(status.cls.has('error'), false);
    const renderBody = app.script.slice(app.script.indexOf('function renderLanding()'), app.script.indexOf('function renderVersionComparison'));
    assert(/clearLandingImportStatus\(\);/.test(renderBody), 'renderLanding clears the status');
    assert(/getElementById\('landing-import'\)\.addEventListener\('input', clearLandingImportStatus\)/.test(app.script), 'typing clears the status');
    // Right after a failed run the error and the typed text are both still there.
    const els = {
      inp: { value: 'bad', focus() {} },
      btn: { disabled: false, textContent: 'Load', setAttribute() {}, removeAttribute() {} },
      st: { textContent: '', classList: { toggle() {} } },
    };
    const importFromText = async (t, report) => { report('Nope', true); return false; };
    const { runImport } = app.sandbox(['runImport'], { globals: { document: { getElementById: id => els[id] }, importFromText }, extraSource: runnerSrc }).api;
    await runImport('inp', 'st', 'btn', () => {});
    assert.equal(els.st.textContent, 'Nope');
    assert.equal(els.inp.value, 'bad');
  });

  await check('the import card copy', () => {
    const html = app.html.replace(/\r\n/g, '\n');
    assert(html.includes('Paste a Raid-Helper event link or ID, its JSON export, a Party Planner share code, or a plain list of players (one per line). Your plans save automatically in this browser.'));
    assert(html.includes('placeholder="Paste a Raid-Helper link, event ID, JSON or a player list"'));
    assert(html.includes('>Raid-Helper link, event ID, JSON, share code or player list</label>'));
  });

  console.log(`\n${passed} import copy checks passed`);
})().catch(err => { console.error(err); process.exit(1); });
