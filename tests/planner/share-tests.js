/**
 * Raidsmith - Live share link tests (Planner side)
 * Run: node tests/planner/share-tests.js
 *
 * The Worker side of /api/share (worker/share.js over the D1 stand-in) is tested in tests/guild/guild-share-worker-tests.js. This suite proves the
 * Planner's two halves agree on the code format: a real share code from index.html's logic half is round-tripped through the Worker route, and
 * LiveLinks (the per-plan link bookkeeping) is driven directly.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const app = require('../load-app');
const { createD1Fake } = require('../d1-fake');

function loadLogic() {
  return app.sandbox(['Import', 'State', 'LiveLinks'], { globals: { btoa, atob, escape, unescape } }).api;
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

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

(async () => {
  await check('Real share code from index.html round-trips through the Worker route and keeps its game version', async () => {
    const { Import, State } = loadLogic();
    const classes = ['WARRIOR', 'PRIEST', 'MAGE', 'ROGUE', 'DRUID'];
    const specs = ['Arms', 'Holy', 'Frost', 'Combat', 'Feral']; // real specs: the importer drops unknown ones
    const players = Array.from({ length: 40 }, (_, i) => ({
      name: 'Player' + i, class: classes[i % 5], spec: specs[i % 5], role: 'melee_dps', groupNumber: 1 + Math.floor(i / 5),
    }));
    assert(Import.loadRoster({ gameVersion: 'forever', raid: 'f_ony', players }));
    State.notes = 'Pull at 8. Bring flasks, Onyxia fire resist gear, and a sense of humour. '.repeat(20);
    const code = Import.encodeSharePayload(Import.exportShareString());
    const { createApp } = await import(pathToFileURL(path.join(app.ROOT, 'worker', 'index.js')).href);
    const { MAX_CODE_LENGTH } = await import(pathToFileURL(path.join(app.ROOT, 'worker', 'share.js')).href);
    assert(code.length < MAX_CODE_LENGTH, `40-man code with long notes is ${code.length} chars`);

    const worker = createApp({ db: createD1Fake(), env: {}, log: () => {} });
    const created = await worker.handle(new Request('https://raidsmith.test/api/share', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    }));
    assert.equal(created.status, 201);
    const { id } = await created.json();
    const fetched = await (await worker.handle(new Request(`https://raidsmith.test/api/share?id=${id}`))).json();
    assert.equal(fetched.code, code);

    State.gameVersion = 'tbc';
    State.selectedRaid = 'bt';
    const res = Import.importAddonString(Import.decodeSharePayload(fetched.code));
    assert.equal(res.success, true);
    assert.equal(State.gameVersion, 'forever');
    assert.equal(State.selectedRaid, 'f_ony');
    assert.equal(res.playerCount, 40);
  });

  await check('LiveLinks.planKey is version + planId, and null without a plan ID', () => {
    const { LiveLinks } = loadLogic();
    assert.equal(LiveLinks.planKey({ planId: 'event:123', gameVersion: 'forever' }), 'forever|event:123');
    assert.equal(LiveLinks.planKey({ planId: 'plan:abc' }), 'tbc|plan:abc');
    assert.equal(LiveLinks.planKey({ planId: null, gameVersion: 'tbc' }), null);
    assert.equal(LiveLinks.planKey(null), null);
  });

  await check('LiveLinks.bind/get/findById round-trip one plan per link', () => {
    const { LiveLinks } = loadLogic();
    const storage = memoryStorage();
    LiveLinks.bind(storage, 'tbc|plan:a', 'aB3dE5g', 'code1', 10);
    assert.equal(LiveLinks.get(storage, 'tbc|plan:a').id, 'aB3dE5g');
    assert.equal(LiveLinks.get(storage, 'tbc|plan:a').lastCode, 'code1');
    assert.equal(LiveLinks.findById(storage, 'aB3dE5g').planKey, 'tbc|plan:a');
    assert.equal(LiveLinks.get(storage, 'tbc|plan:other'), null);
    assert.equal(LiveLinks.findById(storage, 'zzzzzzz'), null);
    // Opening the same link into a different plan moves the binding over.
    LiveLinks.bind(storage, 'tbc|plan:b', 'aB3dE5g', 'code2', 20);
    assert.equal(LiveLinks.get(storage, 'tbc|plan:a'), null);
    assert.equal(LiveLinks.findById(storage, 'aB3dE5g').planKey, 'tbc|plan:b');
  });

  await check('LiveLinks survives corrupted or missing storage and ignores malformed IDs', () => {
    const { LiveLinks } = loadLogic();
    assert.equal(LiveLinks.get(memoryStorage({ pp_live_links: '{oops' }), 'tbc|plan:a'), null);
    assert.equal(LiveLinks.get(memoryStorage({ pp_live_links: '[]' }), 'tbc|plan:a'), null);
    assert.equal(LiveLinks.get(null, 'tbc|plan:a'), null);
    const bad = memoryStorage({ pp_live_links: JSON.stringify({ 'tbc|plan:a': { id: '../etc' } }) });
    assert.equal(LiveLinks.get(bad, 'tbc|plan:a'), null);
  });

  await check('LiveLinks keeps only the most recently used bindings', () => {
    const { LiveLinks } = loadLogic();
    const storage = memoryStorage();
    LiveLinks.max = 3;
    for (let i = 0; i < 5; i++) LiveLinks.bind(storage, 'tbc|plan:' + i, 'abcdef' + i, 'c', i);
    const kept = Object.keys(LiveLinks.read(storage));
    assert.equal(kept.length, 3);
    assert(kept.includes('tbc|plan:4'), 'newest binding kept');
  });

  await check('LiveLinks.needsPush only when the on-screen code differs from the last sync', () => {
    const { LiveLinks } = loadLogic();
    const entry = { id: 'aB3dE5g', lastCode: 'same', updatedAt: 5 };
    assert.equal(LiveLinks.needsPush(entry, 'same'), false);
    assert.equal(LiveLinks.needsPush(entry, 'changed'), true);
    assert.equal(LiveLinks.needsPush(null, 'changed'), false);
    assert.equal(LiveLinks.needsPush(entry, ''), false);
  });

  await check('LiveLinks.shouldApply only for a newer remote with no local save waiting', () => {
    const { LiveLinks } = loadLogic();
    const entry = { id: 'aB3dE5g', lastCode: 'x', updatedAt: 100 };
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 200 }, false), true);
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 200 }, true), false, 'local save wins');
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 100 }, false), false, 'not newer');
    assert.equal(LiveLinks.shouldApply(entry, { code: 'y', updatedAt: 50 }, false), false, 'older');
    assert.equal(LiveLinks.shouldApply(null, { code: 'y', updatedAt: 200 }, false), false);
  });

  await check('A remote edit applied through the share string keeps the plan bound and does not need re-pushing', async () => {
    const { Import, State, LiveLinks } = loadLogic();
    const storage = memoryStorage();
    const players = Array.from({ length: 10 }, (_, i) => ({ name: 'P' + i, class: 'MAGE', spec: 'Frost', role: 'caster_dps', groupNumber: 1 + Math.floor(i / 5) }));
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', players }));
    State.planId = 'event:999';
    const planKey = LiveLinks.planKey(State);
    const codeA = Import.encodeSharePayload(Import.exportShareString());
    LiveLinks.bind(storage, planKey, 'aB3dE5g', codeA, 100);

    // Someone else moves P0 to group 2 and saves.
    const moved = State.groups[0].shift(); moved.groupNumber = 2; State.groups[1].push(moved);
    const codeB = Import.encodeSharePayload(Import.exportShareString());
    assert.notEqual(codeA, codeB);

    // Back on this browser: apply B the way applyRemoteLiveCode does.
    State.groups[1].pop(); moved.groupNumber = 1; State.groups[0].unshift(moved);
    const keep = { planId: State.planId };
    assert(Import.importAddonString(Import.decodeSharePayload(codeB)).success);
    Object.assign(State, keep);
    const local = Import.encodeSharePayload(Import.exportShareString());
    LiveLinks.bind(storage, LiveLinks.planKey(State), 'aB3dE5g', local, 200);
    assert.equal(LiveLinks.planKey(State), planKey, 'plan key survives the import');
    assert.equal(local, codeB, 'share string round-trips byte-for-byte');
    assert.equal(LiveLinks.needsPush(LiveLinks.get(storage, planKey), local), false, 'no echo save');
    assert(State.groups[1].some(p => p.name === 'P0'));
  });

  await check('A manual standby edit survives the share format, and the wire key stays "backups"', () => {
    const { Import, State, Backups } = app.sandbox(['Import', 'State', 'Backups'], { globals: { btoa, atob, escape, unescape } }).api;
    const players = Array.from({ length: 10 }, (_, i) => ({ name: 'P' + i, class: 'MAGE', spec: 'Frost', role: 'caster_dps', groupNumber: 1 + Math.floor(i / 5) }));
    assert(Import.loadRoster({ gameVersion: 'tbc', raid: 'kara', players }));
    const sitter = State.groups[1].pop();
    State.roster = State.roster.filter(p => p !== sitter);
    State.bench.push(sitter);
    assert.equal(Backups.link('P0', sitter.name).success, true);
    assert.equal(Backups.hasManualEdits(), true);
    const expected = JSON.stringify(Backups.serialize());
    assert.equal(expected, '{"P0":"' + sitter.name + '"}');

    const str = Import.exportShareString();
    const tail = JSON.parse(decodeURIComponent(str.split(':').pop()));
    assert.deepEqual(Object.keys(tail).filter(k => /backup|standby/i.test(k)), ['backups'], 'the PP:2 tail uses the literal key "backups"');
    assert.equal(JSON.stringify(tail.backups), expected);

    State.backups = {};
    assert.equal(Backups.hasManualEdits(), false);
    assert.equal(Import.importAddonString(str).success, true);
    assert.equal(JSON.stringify(Backups.serialize()), expected, 'the standby edit comes back identical');
  });

  console.log(`\nShare tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
})();
