/**
 * PartyPlanner Web - Wave 3 tests: Raid Prep panel, Raid-Helper version
 * auto-detect, and the printable raid sheet.
 * Run: node prep-tests.js
 *
 * Same vm loader pattern as assignments-tests.js/classic-tests.js: the logic
 * half of index.html's <script> (everything above '// ── UI RENDERING') is
 * executed in a sandboxed context and the pieces under test are pulled out
 * through globalThis.api.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({ TextEncoder, TextDecoder, console });
vm.runInContext(script.split('// ── UI RENDERING')[0] +
  '\nglobalThis.api={State,Config,GameVersions,Rulesets,Import,Readiness,Assignments,RaidPrep,PrintSheet,detectVersionFromTemplateId,getGroupBuffs,activeRules,RosterEdit,nextUid,NO_ROSTER_NAME};', ctx);
const { State, Config, GameVersions, Rulesets, Import, Readiness, Assignments, RaidPrep, PrintSheet, detectVersionFromTemplateId, getGroupBuffs, activeRules, RosterEdit, nextUid, NO_ROSTER_NAME } = ctx.api;

function mk(cls, spec, role, groupNumber) {
  return { uid: nextUid(), name: cls + '-' + spec + '-' + nextUid(), class: cls, spec, role, groupNumber: groupNumber || 1, imported: false };
}
function resetState(version, raid) {
  State.gameVersion = version;
  State.selectedRaid = raid;
  State.groups = [];
  State.bench = [];
  State.roster = [];
  State.planId = null;
  State.rosterName = 'Test Roster';
  State.buffOverrides = {};
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.notes = '';
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// Every raid key that is a real raid (not a classicN/foreverN planning
// template) — Config.Raids is a flat merge of every version's raids, built
// once at module load, so this list covers Classic + TBC + Forever together.
const realRaidKeys = Object.keys(Config.Raids).filter(k => Config.Raids[k].tier !== 'Planning templates');

// ── 1. Data shape: every real raid has prep data, every item has a source ──
check('every real raid key has a RaidPrep entry', () => {
  assert.ok(realRaidKeys.length > 15, 'sanity: expected Classic+TBC+Forever raids to be present');
  for (const key of realRaidKeys) {
    assert.ok(RaidPrep.data[key], `RaidPrep.data is missing raid key "${key}"`);
  }
});

check('planning templates have no RaidPrep entry', () => {
  assert.equal(RaidPrep.data.classic10, undefined);
  assert.equal(RaidPrep.data.forever25, undefined);
});

check('every encounter/consumable item across every raid carries a source URL', () => {
  for (const key of realRaidKeys) {
    const prep = RaidPrep.data[key];
    const items = [...(prep.encounters || []), ...(prep.consumables || [])];
    for (const item of items) {
      assert.ok(typeof item.source === 'string' && /^https?:\/\//.test(item.source),
        `item in "${key}" is missing a valid source URL: ${JSON.stringify(item)}`);
      assert.ok((item.note && item.note.trim()) || (item.item && item.item.trim()),
        `item in "${key}" has neither a note nor an item label: ${JSON.stringify(item)}`);
    }
  }
});

check('Forever raids point at Campfires with no confirmed encounter data yet', () => {
  for (const key of ['f_barrow', 'f_hyjal', 'f_ony']) {
    const prep = RaidPrep.data[key];
    assert.equal(prep.encounters.length, 0, `${key} should have no encounter notes yet`);
    assert.ok(prep.consumables.length >= 1);
    assert.match(prep.consumables[0].note, /December 9, 2026/);
  }
});

// ── 2. Utility cross-reference ──────────────────────────────────────
check('MC Magmadar note is covered when a Hunter is seated (Tranquilizing Shot)', () => {
  resetState('classic', 'mc');
  const groups = [[mk('HUNTER', 'Marksmanship', 'ranged_dps', 1)]];
  const result = RaidPrep.itemsWithCoverage('mc', groups, []);
  const magmadar = result.encounters.find(e => e.boss === 'Magmadar');
  assert.ok(magmadar, 'expected a Magmadar entry');
  assert.equal(magmadar.utility, 'TRANQ_SHOT');
  assert.ok(magmadar.coverage, 'expected a coverage object');
  assert.equal(magmadar.coverage.covered, true);
  assert.equal(magmadar.coverage.seatedCount, 1);
});

check('MC Magmadar note is NOT covered with no Hunter seated', () => {
  resetState('classic', 'mc');
  const groups = [[mk('WARRIOR', 'Protection', 'tank', 1)]];
  const result = RaidPrep.itemsWithCoverage('mc', groups, []);
  const magmadar = result.encounters.find(e => e.boss === 'Magmadar');
  assert.equal(magmadar.coverage.covered, false);
  assert.equal(magmadar.coverage.seatedCount, 0);
});

check('items with no `utility` field carry a null coverage, not a crash', () => {
  resetState('classic', 'zg');
  const result = RaidPrep.itemsWithCoverage('zg', [[mk('WARRIOR', 'Protection', 'tank', 1)]], []);
  for (const item of [...result.encounters, ...result.consumables]) {
    if (!item.utility) assert.equal(item.coverage, null);
  }
});

check('itemsWithCoverage returns null for an unknown raid key', () => {
  assert.equal(RaidPrep.itemsWithCoverage('not-a-raid', [], []), null);
});

check('TBC Archimonde note cross-references Remove Curse coverage', () => {
  resetState('tbc', 'hyjal');
  const withMage = RaidPrep.itemsWithCoverage('hyjal', [[mk('MAGE', 'Frost', 'caster_dps', 1)]], []);
  const archimonde = withMage.encounters.find(e => e.boss === 'Archimonde');
  assert.ok(archimonde);
  assert.equal(archimonde.utility, 'REMOVE_CURSE');
  assert.equal(archimonde.coverage.covered, true);
});

// ── 3. Chat text: ASCII-only, <=255 chars per line ──────────────────
check('RaidPrep.toChatText is ASCII-only and every line is <=255 chars', () => {
  for (const key of realRaidKeys) {
    const text = RaidPrep.toChatText(key);
    assert.ok(text.length > 0, `expected non-empty chat text for "${key}"`);
    const lines = text.split('\n');
    for (const line of lines) {
      assert.equal(line, line.replace(/[^\x00-\x7F]/g, ''), `non-ASCII character in "${key}" line: ${line}`);
      assert.ok(line.length <= 255, `line over 255 chars in "${key}": ${line}`);
    }
  }
});

check('RaidPrep.toChatText returns empty string for an unknown raid', () => {
  assert.equal(RaidPrep.toChatText('nope'), '');
});

// ── 4. Raid-Helper templateId -> game version detection ─────────────
check('detectVersionFromTemplateId("wowtbc") -> tbc (confirmed field)', () => {
  assert.equal(detectVersionFromTemplateId('wowtbc'), 'tbc');
  assert.equal(detectVersionFromTemplateId('WOWTBC'), 'tbc', 'case-insensitive');
});

check('detectVersionFromTemplateId heuristics for classic/forever (UNCONFIRMED, suggestion-only)', () => {
  assert.equal(detectVersionFromTemplateId('wowclassic'), 'classic');
  assert.equal(detectVersionFromTemplateId('wowera'), 'classic');
  assert.equal(detectVersionFromTemplateId('wowforever'), 'forever');
});

check('detectVersionFromTemplateId returns null for unknown/missing ids', () => {
  assert.equal(detectVersionFromTemplateId('wowretail'), null);
  assert.equal(detectVersionFromTemplateId(''), null);
  assert.equal(detectVersionFromTemplateId(null), null);
  assert.equal(detectVersionFromTemplateId(undefined), null);
  assert.equal(detectVersionFromTemplateId(42), null);
});

// ── 5. Printable raid sheet: pure builder includes groups/bench/notes ──
check('PrintSheet.build() includes every seated player, the bench and notes', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const dps1 = mk('MAGE', 'Fire', 'caster_dps', 1);
  const benched = mk('PRIEST', 'Holy', 'healer', 0);
  State.groups = [[t1, dps1], []];
  State.bench = [benched];
  State.roster = [t1, dps1];
  State.notes = 'MT swaps at 50%';
  State.rosterName = 'Friday Kara';

  const html = PrintSheet.build();
  assert.match(html, /Karazhan/);
  assert.match(html, new RegExp(t1.name));
  assert.match(html, new RegExp(dps1.name));
  assert.match(html, new RegExp(benched.name), 'bench section should list the benched player');
  assert.match(html, /MT swaps at 50%/, 'notes should be included');
  assert.match(html, /Friday Kara/);
});

check('PrintSheet.build() omits the bench/notes sections when empty', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  State.groups = [[t1]];
  State.bench = [];
  State.roster = [t1];
  State.notes = '';
  const html = PrintSheet.build();
  assert.doesNotMatch(html, /ps-bench/);
  assert.doesNotMatch(html, /ps-notes/);
});

check('PrintSheet.build() includes group buffs when the version is modeled', () => {
  resetState('tbc', 'kara');
  const tank = mk('WARRIOR', 'Protection', 'tank', 1);
  const shaman = mk('SHAMAN', 'Enhancement', 'melee_dps', 1);
  State.groups = [[tank, shaman]];
  State.bench = [];
  State.roster = [tank, shaman];
  const html = PrintSheet.build();
  assert.match(html, /ps-buffs/);
});

check('PrintSheet.build() includes assignment sections when they exist', () => {
  resetState('tbc', 'kara');
  const tank = mk('WARRIOR', 'Protection', 'tank', 1);
  const healer = mk('PRIEST', 'Holy', 'healer', 1);
  State.groups = [[tank, healer]];
  State.bench = [];
  State.roster = [tank, healer];
  Assignments.setHealerTank(healer.name, tank.name);
  const html = PrintSheet.build();
  assert.match(html, /Healer/);
  assert.match(html, new RegExp(healer.name));
  assert.match(html, new RegExp(tank.name));
});

console.log(`\n${passed} passed`);
