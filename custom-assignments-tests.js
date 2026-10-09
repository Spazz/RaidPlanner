/**
 * PartyPlanner Web - custom assignment rows, the MRT note export and
 * template-carried planning (assignments, backups, constraints, drummers)
 * Run: node custom-assignments-tests.js
 *
 * Same vm loader pattern as assignments-tests.js. Covers: the row API
 * (add/rename/mark/players/reorder/delete and their limits), no dangling
 * player after a delete/rename/bench move, every persistence path (PlanStore,
 * saved rosters, share string = the live-link payload, templates), old data
 * with no custom rows, escaping, and Assignments.toMrtNote() as a golden string.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'Import', 'PlanStore', 'Assignments', 'Backups', 'Constraints', 'Drummers', 'Templates', 'RosterEdit', 'PrintSheet', 'LiveLinks', 'nextUid']);
const { State, Config, Import, PlanStore, Assignments, Backups, Constraints, Drummers, Templates, RosterEdit, PrintSheet, LiveLinks, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}
const json = v => JSON.stringify(v);
// State lives in the vm context, so its arrays and objects fail deepEqual on prototypes; compare as JSON.
const same = (actual, expected, message) => assert.equal(json(actual), json(expected), message);

function mk(cls, spec, role, name, groupNumber = 1) {
  return { uid: nextUid(), name, class: cls, spec, role, groupNumber, imported: false };
}
function resetState() {
  State.gameVersion = 'tbc';
  State.selectedRaid = 'kara';
  State.groups = [];
  State.bench = [];
  State.roster = [];
  State.planId = null;
  State.rosterName = 'Test Roster';
  State.buffOverrides = {};
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.notes = '';
  State.unplaced = [];
  State.playerConstraints = [];
  State.drummers = [];
  State.backups = {};
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
}
function seat(players, bench = []) {
  State.groups = [players, ...Array.from({ length: Config.Raids[State.selectedRaid].groups - 1 }, () => [])];
  State.bench = bench.map(p => { p.groupNumber = 0; return p; });
  State.roster = players;
  return players;
}
// The raid used by most checks: a tank, two healers, a paladin and two casters.
function fixture() {
  resetState();
  const p = {
    brann: mk('WARRIOR', 'Protection', 'tank', 'Brann'),
    ayla: mk('PRIEST', 'Holy', 'healer', 'Ayla'),
    fenn: mk('DRUID', 'Restoration', 'healer', 'Fenn'),
    corvin: mk('PALADIN', 'Retribution', 'melee_dps', 'Corvin'),
    zeb: mk('MAGE', 'Frost', 'caster_dps', 'Zeb'),
    mox: mk('WARLOCK', 'Destruction', 'caster_dps', 'Mox'),
  };
  seat(Object.values(p));
  return p;
}
function fakeStorage() {
  const data = {};
  return { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
}

// ── 1. Row API ────────────────────────────────────────────────────
check('A plan with no custom rows keeps the exact three-key assignments shape', () => {
  fixture();
  Assignments.restore(null);
  assert.equal(json(State.assignments), json({ tankHealers: {}, blessings: {}, debuffs: {} }));
  assert.equal(Assignments.hasManualEdits(), false);
  same(Assignments.customRows(), []);
});
check('addCustom stores a trimmed label, a mark and sequential ids; the first row marks the plan as edited', () => {
  fixture();
  const a = Assignments.addCustom('  Interrupts  ', 8);
  const b = Assignments.addCustom('Kiters');
  assert(a.success && b.success);
  assert.equal(json(Assignments.customRows()), json([
    { id: 'c1', label: 'Interrupts', players: [], mark: 8 },
    { id: 'c2', label: 'Kiters', players: [], mark: 0 },
  ]));
  assert.equal(Assignments.hasManualEdits(), true);
});
check('addCustom rejects a blank label and refuses rows past the cap', () => {
  fixture();
  assert.equal(Assignments.addCustom('   ').success, false);
  assert.equal(Assignments.addCustom('\n\t').success, false);
  assert.equal(Assignments.customRows().length, 0);
  for (let i = 0; i < Assignments.CUSTOM_MAX_ROWS; i++) assert(Assignments.addCustom('Row ' + i).success);
  const over = Assignments.addCustom('One too many');
  assert.equal(over.success, false);
  assert.equal(Assignments.customRows().length, Assignments.CUSTOM_MAX_ROWS);
});
check('Labels are single-line free text clipped to the maximum length; markup survives untouched', () => {
  fixture();
  const row = Assignments.addCustom('Line one\nline   two\u0000' + 'x'.repeat(100)).row;
  assert(!/[\n\u0000]/.test(row.label));
  assert(row.label.startsWith('Line one line two'));
  assert(row.label.length <= Assignments.CUSTOM_LABEL_MAX);
  assert.equal(Assignments.addCustom('<b>"Cubes" & more</b>').row.label, '<b>"Cubes" & more</b>');
});
check('renameCustom changes the label, rejects blank, and rejects an unknown id', () => {
  fixture();
  const id = Assignments.addCustom('Cubes').row.id;
  assert(Assignments.renameCustom(id, ' Magtheridon cubes ').success);
  assert.equal(Assignments.findCustom(id).label, 'Magtheridon cubes');
  assert.equal(Assignments.renameCustom(id, '  ').success, false);
  assert.equal(Assignments.findCustom(id).label, 'Magtheridon cubes', 'a rejected rename keeps the old label');
  assert.equal(Assignments.renameCustom('c99', 'x').success, false);
});
check('setCustomMark accepts 0-8 and treats anything else as no mark', () => {
  fixture();
  const id = Assignments.addCustom('Kill order', 3).row.id;
  assert.equal(Assignments.findCustom(id).mark, 3);
  Assignments.setCustomMark(id, '8');
  assert.equal(Assignments.findCustom(id).mark, 8);
  Assignments.setCustomMark(id, 9);
  assert.equal(Assignments.findCustom(id).mark, 0);
  Assignments.setCustomMark(id, 'skull');
  assert.equal(Assignments.findCustom(id).mark, 0);
});
check('addCustomPlayer takes only a seated player, ignores a duplicate; removeCustomPlayer clears one', () => {
  const p = fixture();
  const id = Assignments.addCustom('Interrupts').row.id;
  assert(Assignments.addCustomPlayer(id, p.zeb.name).success);
  assert(Assignments.addCustomPlayer(id, p.mox.name).success);
  assert(Assignments.addCustomPlayer(id, p.zeb.name).success);
  same(Assignments.findCustom(id).players, ['Zeb', 'Mox']);
  assert.equal(Assignments.addCustomPlayer(id, 'Nobody').success, false, 'not on the roster');
  const benched = mk('ROGUE', 'Combat', 'melee_dps', 'Benchy', 0);
  State.bench = [benched];
  assert.equal(Assignments.addCustomPlayer(id, 'Benchy').success, false, 'a benched player is not seated');
  assert(Assignments.removeCustomPlayer(id, 'Zeb').success);
  same(Assignments.findCustom(id).players, ['Mox']);
  assert.equal(Assignments.addCustomPlayer('c99', 'Zeb').success, false);
});
check('moveCustom reorders, clamps at both ends; removeCustom deletes and drops the key with the last row', () => {
  fixture();
  const [a, b, c] = ['A', 'B', 'C'].map(l => Assignments.addCustom(l).row.id);
  const order = () => Assignments.customRows().map(r => r.label).join('');
  Assignments.moveCustom(c, -1); assert.equal(order(), 'ACB');
  Assignments.moveCustom(c, -5); assert.equal(order(), 'CAB');
  assert.equal(Assignments.moveCustom(c, -1).moved, false, 'already first');
  Assignments.moveCustom(c, 9); assert.equal(order(), 'ABC');
  assert.equal(Assignments.moveCustom('c99', 1).success, false);
  Assignments.removeCustom(b); assert.equal(order(), 'AC');
  assert.equal(Assignments.removeCustom(b).success, false);
  Assignments.removeCustom(a); Assignments.removeCustom(c);
  assert.equal('custom' in State.assignments, false, 'no empty custom key is left behind');
  assert.equal(Assignments.hasManualEdits(), false);
  assert.equal(json(State.assignments), json({ tankHealers: {}, blessings: {}, debuffs: {} }));
});
check('Ids are never reused within a plan while a row still holds them', () => {
  fixture();
  const a = Assignments.addCustom('A').row.id, b = Assignments.addCustom('B').row.id;
  Assignments.removeCustom(a);
  const c = Assignments.addCustom('C').row.id;
  assert.notEqual(c, b);
  assert.equal(new Set(Assignments.customRows().map(r => r.id)).size, 2);
});

// ── 2. No dangling players ─────────────────────────────────────────
check('reconcileRoster drops players who left the roster but keeps the row and its label', () => {
  const p = fixture();
  const id = Assignments.addCustom('Interrupts', 8).row.id;
  Assignments.addCustomPlayer(id, 'Zeb'); Assignments.addCustomPlayer(id, 'Mox');
  State.groups[0] = State.groups[0].filter(x => x !== p.zeb);
  State.bench = [p.zeb];
  State.roster = State.groups.flat();
  Assignments.reconcileRoster();
  same(Assignments.findCustom(id).players, ['Mox']);
  assert.equal(Assignments.findCustom(id).label, 'Interrupts');
  assert.equal(Assignments.findCustom(id).mark, 8);
});
check('Deleting a player through RosterEdit leaves no reference once the plan reconciles', () => {
  const p = fixture();
  const id = Assignments.addCustom('Cubes').row.id;
  Assignments.addCustomPlayer(id, 'Zeb');
  assert(RosterEdit.DeletePlayer(p.zeb.uid).success);
  Assignments.reconcileRoster();
  same(Assignments.findCustom(id).players, []);
  assert(!json(State.assignments).includes('Zeb'));
});
check('Renaming a player drops the old name from a row (name-keyed, like the other assignments)', () => {
  const p = fixture();
  const id = Assignments.addCustom('Cubes').row.id;
  Assignments.addCustomPlayer(id, 'Zeb');
  assert(RosterEdit.UpdatePlayer(p.zeb.uid, { name: 'Zebra' }).success);
  Assignments.reconcileRoster();
  same(Assignments.findCustom(id).players, []);
  assert(Assignments.addCustomPlayer(id, 'Zebra').success, 'the new name can be assigned');
});
check('Restoring rows that name players not in the roster prunes them (template onto a different raid)', () => {
  fixture();
  Assignments.restore({ custom: [{ id: 'c1', label: 'Cubes', players: ['Zeb', 'Gone'], mark: 0 }] });
  same(Assignments.findCustom('c1').players, ['Zeb']);
});

// ── 3. Defensive reading of untrusted rows ─────────────────────────
check('cleanCustom survives garbage: non-arrays, bad rows, bad ids, duplicates, bad marks, too many', () => {
  same(Assignments.cleanCustom(undefined), []);
  same(Assignments.cleanCustom('x'), []);
  same(Assignments.cleanCustom({ 0: { label: 'x' } }), []);
  const cleaned = Assignments.cleanCustom([
    null, 7, 'x', [], { label: '' }, { label: '   ' }, { players: ['A'] },
    { id: 'c5', label: 'Keep', players: ['A', 'A', '', 3, null, 'B'], mark: 4 },
    { id: 'c5', label: 'Dup id', players: 'nope', mark: 99 },
    { id: '<script>', label: 'Odd id', mark: 1.5 },
  ]);
  assert.equal(cleaned.length, 3);
  assert.equal(json(cleaned[0]), json({ id: 'c5', label: 'Keep', players: ['A', 'B'], mark: 4 }));
  same(cleaned[1].players, []);
  assert.equal(cleaned[1].mark, 0);
  assert.equal(new Set(cleaned.map(r => r.id)).size, 3);
  assert(cleaned.every(r => /^c\d+$/.test(r.id)));
  const many = Array.from({ length: 50 }, (_, i) => ({ label: 'R' + i }));
  assert.equal(Assignments.cleanCustom(many).length, Assignments.CUSTOM_MAX_ROWS);
});

// ── 4. Persistence ─────────────────────────────────────────────────
function customFixture() {
  const p = fixture();
  const interrupts = Assignments.addCustom('Interrupts', 8).row.id;
  Assignments.addCustomPlayer(interrupts, 'Zeb'); Assignments.addCustomPlayer(interrupts, 'Mox');
  const cubes = Assignments.addCustom('Magtheridon cubes').row.id;
  Assignments.addCustomPlayer(cubes, 'Brann');
  Assignments.setHealerTank('Ayla', 'RAID');
  return p;
}
const CUSTOM_EXPECTED = [
  { id: 'c1', label: 'Interrupts', players: ['Zeb', 'Mox'], mark: 8 },
  { id: 'c2', label: 'Magtheridon cubes', players: ['Brann'], mark: 0 },
];
check('PlanStore capture/restore round-trips custom rows (and the capture changes, so undo sees it)', () => {
  fixture();
  State.planId = 'plan:custom1';
  const before = json(PlanStore.capture());
  customFixture();
  State.planId = 'plan:custom1';
  const captured = PlanStore.capture();
  assert.notEqual(json(captured), before, 'adding a row changes the captured plan (undo/redo and autosave compare it)');
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  assert(PlanStore.restore(JSON.parse(JSON.stringify(captured))));
  assert.equal(json(Assignments.customRows()), json(CUSTOM_EXPECTED));
  assert.equal(State.assignments.tankHealers.Ayla, 'RAID');
});
check('PlanStore.restore of a plan saved before custom rows existed clears any rows left in State', () => {
  customFixture();
  State.planId = 'plan:old1';
  const old = JSON.parse(JSON.stringify(PlanStore.capture()));
  delete old.assignments.custom;
  assert(PlanStore.restore(old));
  same(Assignments.customRows(), []);
  assert.equal('custom' in State.assignments, false);
  const veryOld = JSON.parse(JSON.stringify(old));
  delete veryOld.assignments;
  assert(PlanStore.restore(veryOld), 'a plan with no assignments at all still loads');
  same(Assignments.customRows(), []);
});
check('exportRoster/loadRoster (saved rosters, backups, JSON file) round-trip custom rows by name', () => {
  customFixture();
  const exported = JSON.parse(JSON.stringify(Import.exportRoster('Saved')));
  assert.equal(json(exported.assignments.custom), json(CUSTOM_EXPECTED));
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  assert(Import.loadRoster(exported));
  assert.equal(json(Assignments.customRows()), json(CUSTOM_EXPECTED));
  const noRows = { ...exported, assignments: { tankHealers: {}, blessings: {}, debuffs: {} } };
  assert(Import.loadRoster(noRows), 'an export from before custom rows loads');
  same(Assignments.customRows(), []);
});
check('Share string (also the live-link payload) round-trips custom rows; none means no tail bloat', () => {
  customFixture();
  const str = Import.exportShareString();
  assert.equal(LiveLinks.rejection(str), null, 'well under the live-link size limit');
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  const result = Import.importAddonString(str);
  assert(result.success, result.error);
  assert.equal(json(Assignments.customRows()), json(CUSTOM_EXPECTED));
  fixture();
  assert.equal(Import.exportShareString().split(':').length, 5 + State.groups.length, 'a plain link carries no JSON tail');
});
check('A share link written before custom rows existed loads with none', () => {
  fixture();
  Assignments.setHealerTank('Ayla', 'RAID');
  const str = Import.exportShareString();
  assert(!decodeURIComponent(str).includes('custom'));
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {}, custom: [{ id: 'c1', label: 'Stale', players: [], mark: 0 }] };
  assert(Import.importAddonString(str).success);
  same(Assignments.customRows(), []);
  assert.equal(State.assignments.tankHealers.Ayla, 'RAID');
});
check('A share tail with a damaged custom field loads without rows instead of failing', () => {
  fixture();
  Assignments.setHealerTank('Ayla', 'RAID');
  const parts = Import.exportShareString().split(':');
  const tail = JSON.parse(decodeURIComponent(parts[parts.length - 1]));
  tail.assignments.custom = { not: 'an array' };
  parts[parts.length - 1] = encodeURIComponent(JSON.stringify(tail));
  assert(Import.importAddonString(parts.join(':')).success);
  same(Assignments.customRows(), []);
});

// ── 5. Templates (F1) ──────────────────────────────────────────────
check('Template save carries assignments with custom rows, backups, constraints and drummers', () => {
  customFixture();
  const bench = mk('ROGUE', 'Combat', 'melee_dps', 'Benchy', 0);
  State.bench = [bench];
  Backups.link('Zeb', 'Benchy');
  Constraints.add('Ayla', 'Fenn', 'apart');
  Drummers.set('Corvin', 'Battle');
  const storage = fakeStorage();
  assert(Templates.save(storage, 'Mag', 'tbc', 'kara').success);
  const saved = Templates.get(storage, 'Mag', 'tbc', 'kara');
  assert.equal(json(saved.assignments.custom), json(CUSTOM_EXPECTED));
  assert.equal(saved.assignments.tankHealers.Ayla, 'RAID');
  same(saved.backups, { Zeb: 'Benchy' });
  assert.equal(json(saved.playerConstraints), json([{ a: 'Ayla', b: 'Fenn', type: 'apart' }]));
  assert.equal(json(saved.drummers), json([{ player: 'Corvin', drum: 'Battle' }]));
  assert.equal(Templates.list(storage, 'tbc', 'kara')[0].count, 6);
});
check('Template save leaves out planning the plan does not have', () => {
  fixture();
  const storage = fakeStorage();
  Templates.save(storage, 'Plain', 'tbc', 'kara');
  const saved = Templates.get(storage, 'Plain', 'tbc', 'kara');
  same(Object.keys(saved).sort(), ['players', 'savedAt']);
});
check('Applying a template onto a fresh import restores its planning for the names that are present', () => {
  customFixture();
  const bench = mk('ROGUE', 'Combat', 'melee_dps', 'Benchy', 0);
  State.bench = [bench];
  Backups.link('Zeb', 'Benchy');
  Constraints.add('Ayla', 'Fenn', 'apart');
  Drummers.set('Corvin', 'War');
  const storage = fakeStorage();
  Templates.save(storage, 'Mag', 'tbc', 'kara');
  // A fresh import of the same people, with nothing planned and Mox not signed up.
  const names = [['WARRIOR', 'Protection', 'tank', 'Brann'], ['PRIEST', 'Holy', 'healer', 'Ayla'], ['DRUID', 'Restoration', 'healer', 'Fenn'],
    ['PALADIN', 'Retribution', 'melee_dps', 'Corvin'], ['MAGE', 'Frost', 'caster_dps', 'Zeb'], ['ROGUE', 'Combat', 'melee_dps', 'Benchy']];
  resetState();
  State.groups = Array.from({ length: Config.Raids[State.selectedRaid].groups }, () => []);
  State.bench = names.map(([c, s, r, n]) => mk(c, s, r, n, 0));
  State.roster = [];
  const result = Templates.applyToState(storage, 'Mag', 'tbc', 'kara');
  assert(result.success);
  Assignments.reconcileRoster();
  Backups.reconcile();
  Constraints.reconcile();
  Drummers.reconcile();
  same(Assignments.customRows().map(r => [r.label, r.mark, r.players]), [['Interrupts', 8, ['Zeb']], ['Magtheridon cubes', 0, ['Brann']]]);
  assert.equal(State.assignments.tankHealers.Ayla, 'RAID');
  assert.equal(json(State.playerConstraints), json([{ a: 'Ayla', b: 'Fenn', type: 'apart' }]));
  assert.equal(json(State.drummers), json([{ player: 'Corvin', drum: 'War' }]));
  assert.equal(State.groups.flat().length + State.bench.length, 6);
  assert(!json(State.assignments).includes('Mox'), 'a player who did not sign up leaves no reference');
});
check('Applying an old template (players only) applies cleanly and leaves the open planning alone', () => {
  customFixture();
  Constraints.add('Ayla', 'Fenn', 'apart');
  Drummers.set('Corvin', 'Battle');
  const storage = fakeStorage();
  const players = {};
  State.roster.forEach((p, i) => { players[p.name.toLowerCase()] = { name: p.name, group: i % 2, role: p.role }; });
  storage.setItem(Templates.key, JSON.stringify({ tbc: { kara: { Old: { savedAt: 1, players } } } }));
  assert.equal(Templates.list(storage, 'tbc', 'kara')[0].count, 6);
  const result = Templates.applyToState(storage, 'Old', 'tbc', 'kara');
  assert(result.success);
  assert.equal(result.matched, 6);
  assert.equal(json(Assignments.customRows()), json(CUSTOM_EXPECTED));
  assert.equal(State.playerConstraints.length, 1);
  assert.equal(State.drummers.length, 1);
});
check('A template with damaged planning fields applies without throwing', () => {
  fixture();
  const storage = fakeStorage();
  const players = { brann: { name: 'Brann', group: 0, role: 'tank' } };
  storage.setItem(Templates.key, JSON.stringify({ tbc: { kara: { Bad: { savedAt: 1, players, assignments: 'x', backups: [1], playerConstraints: 'y', drummers: { a: 1 } } } } }));
  assert(Templates.applyToState(storage, 'Bad', 'tbc', 'kara').success);
  same(Assignments.customRows(), []);
  same(State.backups, {});
  same(State.playerConstraints, []);
  same(State.drummers, []);
});

// ── 6. Escaping in text and HTML outputs ───────────────────────────
const HOSTILE = '<img src=x onerror=alert(1)>"&\'';
check('PrintSheet escapes a custom label and shows rows with players only', () => {
  fixture();
  const id = Assignments.addCustom(HOSTILE, 7).row.id;
  Assignments.addCustomPlayer(id, 'Zeb');
  Assignments.addCustom('Empty row');
  const html = PrintSheet.build();
  assert(!html.includes('<img'), 'no raw markup from a label');
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;&#39;: Zeb'), 'the label is shown escaped');
  assert(html.includes('Cross &lt;img'), 'the mark is named');
  assert(!html.includes('Empty row'));
});
check('toChatText lists custom rows with their raid mark, in order, skipping rows with nobody seated', () => {
  const p = fixture();
  const a = Assignments.addCustom('Interrupts', 8).row.id;
  Assignments.addCustomPlayer(a, 'Zeb'); Assignments.addCustomPlayer(a, 'Mox');
  Assignments.addCustom('Nobody here');
  const b = Assignments.addCustom('Kiters').row.id;
  Assignments.addCustomPlayer(b, 'Brann');
  const lines = Assignments.toChatText(State.roster).split('\n');
  same(lines.slice(-2), ['{rt8} Interrupts: Zeb, Mox', 'Kiters: Brann']);
  assert(!lines.some(l => l.includes('Nobody here')));
  assert(lines.every(l => new TextEncoder().encode(l).length <= 255));
});

// ── 7. MRT note ────────────────────────────────────────────────────
check('toMrtNote returns nothing for an empty roster', () => {
  resetState();
  assert.equal(Assignments.toMrtNote([]), '');
  Assignments.addCustom('Interrupts');
  assert.equal(Assignments.toMrtNote([]), '', 'a row nobody is on is not exported');
});
check('toMrtNote golden string: Healer, Blessing and Debuff assignments plus custom rows, names in class colour', () => {
  customFixture();
  Assignments.setBlessing('KINGS', 'Corvin');
  Assignments.setDebuff('SUNDER_ARMOR', 'Brann');
  assert.equal(Assignments.toMrtNote(), [
    'Healers',
    'MT |cffC69B6DBrann|r: |cffFF7C0AFenn|r',
    'Raid: |cffD0D0D0Ayla|r',
    '',
    'Blessings',
    'Kings: |cffF48CBACorvin|r',
    '',
    'Debuffs',
    'JotC: |cffF48CBACorvin|r',
    'JoL: |cffF48CBACorvin|r',
    'JoW: |cffF48CBACorvin|r',
    'Sun: |cffC69B6DBrann|r',
    'DS: |cffC69B6DBrann|r',
    'TC: |cffC69B6DBrann|r',
    'CoE: |cff8788EEMox|r',
    'CoR: |cff8788EEMox|r',
    'CoW: |cff8788EEMox|r',
    'ISB: |cff8788EEMox|r',
    'WC: |cff3FC7EBZeb|r',
    '',
    'Custom',
    '{rt8} Interrupts: |cff3FC7EBZeb|r, |cff8788EEMox|r',
    'Magtheridon cubes: |cffC69B6DBrann|r',
  ].join('\n'));
});
check('toMrtNote golden string for a small plan: a tank with no healer, no paladin, one custom row', () => {
  resetState();
  seat([mk('WARRIOR', 'Protection', 'tank', 'Brann'), mk('MAGE', 'Frost', 'caster_dps', 'Zeb'), mk('ROGUE', 'Combat', 'melee_dps', 'Vex')]);
  const id = Assignments.addCustom('Interrupts', 8).row.id;
  Assignments.addCustomPlayer(id, 'Zeb'); Assignments.addCustomPlayer(id, 'Vex');
  assert.equal(Assignments.toMrtNote(), [
    'Healers',
    'MT |cffC69B6DBrann|r: (none)',
    '',
    'Debuffs',
    'Sun: |cffC69B6DBrann|r',
    'DS: |cffC69B6DBrann|r',
    'TC: |cffC69B6DBrann|r',
    'EA: |cffFFF468Vex|r',
    'WC: |cff3FC7EBZeb|r',
    '',
    'Custom',
    '{rt8} Interrupts: |cff3FC7EBZeb|r, |cffFFF468Vex|r',
  ].join('\n'));
});
check('toMrtNote doubles a pipe in a label and strips newlines so a note cannot start an escape sequence', () => {
  fixture();
  const id = Assignments.addCustom('Cube |cffff0000red|r\nclickers').row.id;
  Assignments.addCustomPlayer(id, 'Brann');
  const line = Assignments.toMrtNote().split('\n').find(l => l.includes('Cube'));
  assert.equal(line, 'Cube ||cffff0000red||r clickers: |cffC69B6DBrann|r');
});
check('toMrtNote keeps accented names and uses only the roster a row names (stale names are skipped)', () => {
  resetState();
  seat([mk('MAGE', 'Frost', 'caster_dps', 'Thràll')]);
  const id = Assignments.addCustom('Sheep').row.id;
  Assignments.addCustomPlayer(id, 'Thràll');
  State.assignments.custom[0].players.push('Ghost');
  assert.equal(Assignments.toMrtNote().split('\n').pop(), 'Sheep: |cff3FC7EBThràll|r');
});
check('toMrtNote does not change State', () => {
  customFixture();
  const before = json({ a: State.assignments, g: State.groups });
  Assignments.toMrtNote();
  assert.equal(json({ a: State.assignments, g: State.groups }), before);
});

console.log(`\nCustom assignment tests: ${passed} passed, 0 failed, ${passed} total`);
