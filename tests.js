/**
 * PartyPlanner Web — Comprehensive Test Suite
 * Tests: Optimizer, Import/Export, Buff calculation, Edge cases
 * Run: node tests.js
 *
 * Logic is imported directly from index.html — single source of truth.
 */

// ── Extract and load the core logic from index.html ──
const app = require('./tests/load-app');

// Only the logic portion of index.html (before UI rendering / DOM code), loaded as a
// CommonJS module (via a temp file, cleaned up immediately) for readable stack traces.
const PP = app.requireLogic(['SignupStatus', 'nextUid', 'PreferredSlots', 'PlanStore', 'PlanSession', 'ImportHistory', 'Config', 'Import', 'Optimizer', 'RosterEdit', 'getGroupBuffs', 'getBuffPriority', 'getRaidDebuffCoverage', 'getMissingBuffInsights', 'State', 'TOTEM_ELEMENTS', 'PALADIN_AURAS', 'BEST_AIR_TOTEM', 'BEST_PALADIN_AURA', 'NO_ROSTER_NAME', 'enforceRaidCapacity', 'esc', 'Constraints', 'Backups', 'Drummers', 'PrintSheet', 'ChangeLog'], '_pp_test_logic.tmp.js');

const { SignupStatus, nextUid, Config, Import, Optimizer, RosterEdit, getGroupBuffs, getBuffPriority, getRaidDebuffCoverage, getMissingBuffInsights, State, TOTEM_ELEMENTS, PALADIN_AURAS, BEST_AIR_TOTEM, BEST_PALADIN_AURA, NO_ROSTER_NAME, enforceRaidCapacity, esc, Constraints, Backups, Drummers } = PP;

// NOTE: All logic (Config, Optimizer, Import, getGroupBuffs, etc.)
// is now loaded directly from index.html. No duplicate code to maintain.

// ════════════════════════════════════════════════════════════════
// TEST FRAMEWORK (old inlined Config/Import/Optimizer/getGroupBuffs removed)
// ════════════════════════════════════════════════════════════════
let passed = 0, failed = 0, totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) { passed++; }
  else { failed++; console.error(`  FAIL: ${message}`); }
}

function assertEqual(actual, expected, message) {
  totalTests++;
  if (actual === expected) { passed++; }
  else { failed++; console.error(`  FAIL: ${message} — expected ${expected}, got ${actual}`); }
}

function assertIncludes(arr, item, message) {
  totalTests++;
  if (arr.includes(item)) { passed++; }
  else { failed++; console.error(`  FAIL: ${message} — ${item} not found in [${arr.join(',')}]`); }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

function resetState() {
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.roster = [];
  State.groups = [];
  State.bench = [];
  State.buffOverrides = {};
  State.selectedRaid = 'bt';
  State.rosterName = 'Test';
  State.playerConstraints = [];
  State.drummers = [];
  State.backups = {};
}

// ── Helper: create a player ──
function mkPlayer(name, cls, spec, role) {
  return { name, class: cls, spec, role, groupNumber: 1, imported: true };
}

// ── Helper: build a standard 25-man roster ──
function buildStandard25ManRoster() {
  return [
    // Tanks (3)
    mkPlayer('ProtPally','PALADIN','Protection','tank'),
    mkPlayer('ProtWarrior','WARRIOR','Protection','tank'),
    mkPlayer('FeralTank','DRUID','Feral','tank'),
    // Healers (6)
    mkPlayer('HolyPally1','PALADIN','Holy','healer'),
    mkPlayer('HolyPally2','PALADIN','Holy','healer'),
    mkPlayer('HolyPriest','PRIEST','Holy','healer'),
    mkPlayer('DiscPriest','PRIEST','Discipline','healer'),
    mkPlayer('RestoDruid','DRUID','Restoration','healer'),
    mkPlayer('RestoSham','SHAMAN','Restoration','healer'),
    // Melee DPS (6)
    mkPlayer('EnhSham1','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('EnhSham2','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Rogue1','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue2','ROGUE','Combat','melee_dps'),
    mkPlayer('RetPally','PALADIN','Retribution','melee_dps'),
    mkPlayer('FuryWarrior','WARRIOR','Fury','melee_dps'),
    // Feral DPS (1)
    mkPlayer('FeralDPS','DRUID','Feral','melee_dps'),
    // Caster DPS (6)
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('ShadowPriest','PRIEST','Shadow','caster_dps'),
    mkPlayer('Boomkin','DRUID','Balance','caster_dps'),
    mkPlayer('Mage1','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Fire','caster_dps'),
    mkPlayer('Warlock1','WARLOCK','Destruction','caster_dps'),
    // Ranged DPS (3)
    mkPlayer('Hunter1','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('Hunter2','HUNTER','Marksmanship','ranged_dps'),
    mkPlayer('Warlock2','WARLOCK','Affliction','caster_dps'),
  ];
}

function loadRosterAndOptimize(roster, raid) {
  resetState();
  State.selectedRaid = raid || 'bt';
  const raidInfo = Config.Raids[State.selectedRaid];
  const numGroups = raidInfo.groups;
  State.roster = roster.map(p => ({...p}));
  State.groups = [];
  for (let i = 0; i < numGroups; i++) State.groups.push([]);
  // Put all players in group 1 initially
  for (const p of State.roster) { State.groups[0].push(p); p.groupNumber = 1; }
  Optimizer.optimize();
}

// ════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════

// ── IMPORT TESTS ────────────────────────────────────────────────
describe('Import: raid-helper.dev JSON format', () => {
  resetState();
  const json = JSON.stringify({
    slots: [
      { name:'Starck', specName:'Protection1', className:'Tank', groupNumber:1, slotNumber:1 },
      { name:'Sanga', specName:'Enhancement', className:'Shaman', groupNumber:1, slotNumber:2 },
      { name:'Gnope', specName:'Destruction', className:'Warlock', groupNumber:2, slotNumber:3 },
      { name:'Daxxter', specName:'Arcane', className:'Mage', groupNumber:2, slotNumber:4 },
      { name:'Drenna', specName:'Holy1', className:'Paladin', groupNumber:3, slotNumber:5 },
    ]
  });

  const result = Import.importRaidHelper(json);
  assert(result.success, 'Import should succeed');
  assertEqual(result.playerCount, 5, 'Should import 5 players');
  assertEqual(result.groupCount, 3, 'Should detect 3 groups');

  // Verify class/spec mapping
  const starck = State.roster.find(p => p.name === 'Starck');
  assertEqual(starck.class, 'PALADIN', 'Starck should be PALADIN (Protection1 maps to Paladin)');
  assertEqual(starck.spec, 'Protection', 'Starck spec should be Protection');
  assertEqual(starck.role, 'tank', 'Starck role should be tank');

  const sanga = State.roster.find(p => p.name === 'Sanga');
  assertEqual(sanga.class, 'SHAMAN', 'Sanga should be SHAMAN');
  assertEqual(sanga.spec, 'Enhancement', 'Sanga spec should be Enhancement');

  const gnope = State.roster.find(p => p.name === 'Gnope');
  assertEqual(gnope.class, 'WARLOCK', 'Gnope should be WARLOCK');

  const drenna = State.roster.find(p => p.name === 'Drenna');
  assertEqual(drenna.class, 'PALADIN', 'Drenna should be PALADIN (Holy1)');
  assertEqual(drenna.role, 'healer', 'Drenna should be healer');
});

describe('Import: invalid JSON', () => {
  resetState();
  const result1 = Import.importRaidHelper('not json');
  assert(!result1.success, 'Should fail on invalid JSON');
  assert(result1.error.includes('Invalid JSON'), 'Error should mention invalid JSON');

  const result2 = Import.importRaidHelper('{"foo":"bar"}');
  assert(!result2.success, 'Should fail when no slots array');

  const result3 = Import.importRaidHelper('{"slots":[]}');
  assert(!result3.success, 'Should fail on empty slots with no groups');
});

describe('Import: auto-detect 10-man raid', () => {
  resetState();
  State.selectedRaid = 'bt'; // Start at 25-man
  const json = JSON.stringify({
    slots: Array.from({length:10}, (_, i) => ({
      name:'Player'+i, specName:'Combat', className:'Rogue', groupNumber: i < 5 ? 1 : 2, slotNumber:i+1,
    }))
  });
  Import.importRaidHelper(json);
  assertEqual(State.selectedRaid, 'kara', 'Should auto-select Karazhan for 10 players');
});

// ── EXPORT TESTS ────────────────────────────────────────────────
describe('Export: roster format', () => {
  resetState();
  State.selectedRaid = 'bt';
  State.roster = [
    mkPlayer('TestPlayer','WARRIOR','Arms','melee_dps'),
    mkPlayer('TestHealer','PRIEST','Holy','healer'),
  ];
  State.rosterName = 'Test Export';

  const exported = Import.exportRoster('My Roster');
  assertEqual(exported.name, 'My Roster', 'Export name should match');
  assertEqual(exported.raid, 'bt', 'Export raid should match');
  assertEqual(exported.players.length, 2, 'Should export 2 players');
  assert(exported.timestamp > 0, 'Should have timestamp');

  // Verify round-trip
  resetState();
  const loaded = Import.loadRoster(exported);
  assert(loaded, 'Should load exported roster');
  assertEqual(State.roster.length, 2, 'Round-trip should preserve player count');
  assertEqual(State.roster[0].name, 'TestPlayer', 'Round-trip should preserve player name');
});

// ── OPTIMIZER: 25-MAN TESTS ─────────────────────────────────────
// ── MRT RAID GROUPS EXPORT ──────────────────────────────────────
// Test-local port of LibDeflate:DecodeForPrint (the 6-bit printable codec MRT
// uses). Kept independent from the encoder in index.html so the test is a
// genuine round-trip and not the encoder checking itself.
const MRT_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()';
function mrtDecodeForPrint(str) {
  const val = c => MRT_ALPHABET.indexOf(c);
  const out = [];
  let i = 0;
  while (i + 4 <= str.length) {
    const x1 = val(str[i]), x2 = val(str[i+1]), x3 = val(str[i+2]), x4 = val(str[i+3]);
    if (x1 < 0 || x2 < 0 || x3 < 0 || x4 < 0) return null;
    i += 4;
    let cache = x1 + x2*64 + x3*4096 + x4*262144;
    const b1 = cache % 256; cache = (cache - b1) / 256;
    const b2 = cache % 256; const b3 = (cache - b2) / 256;
    out.push(b1, b2, b3);
  }
  let cache = 0, bits = 0;
  while (i < str.length) {
    const x = val(str[i]); if (x < 0) return null;
    cache += x * Math.pow(2, bits); bits += 6; i++;
  }
  while (bits >= 8) {
    const b = cache % 256; out.push(b); cache = (cache - b) / 256; bits -= 8;
  }
  return Buffer.from(out).toString('utf8');
}

describe('Export: MRT Raid Groups string', () => {
  resetState();
  State.selectedRaid = 'gruul';
  State.groups = [
    [mkPlayer('Alpha','WARRIOR','Protection','tank'), mkPlayer('Bravo','PRIEST','Holy','healer')],
    [],
    [mkPlayer('Charlie','ROGUE','Combat','melee_dps')],
    [], [],
  ];
  State.roster = State.groups.flat();

  const str = Import.exportMrtString();
  assert(str.startsWith('MRTRGR0'), 'MRT string starts with the uncompressed MRTRGR0 header');
  const body = str.slice(7);
  assert(/^[A-Za-z0-9()]+$/.test(body), 'MRT body only uses the 64 printable codec characters');

  const decoded = mrtDecodeForPrint(body);
  assertEqual(decoded, '0,{[1]="Alpha",[2]="Bravo",[11]="Charlie"}',
    'Decoded payload is MRT table text with slot = (group-1)*5 + position');

  // Codec edge: payload length not a multiple of 3 must round-trip too.
  assertEqual(mrtDecodeForPrint(Import.encodeForPrint('ab')), 'ab', 'encodeForPrint round-trips a 2-byte tail');
  assertEqual(mrtDecodeForPrint(Import.encodeForPrint('a')), 'a', 'encodeForPrint round-trips a 1-byte tail');
  assertEqual(mrtDecodeForPrint(Import.encodeForPrint('abc')), 'abc', 'encodeForPrint round-trips an exact 3-byte block');

  // Reference vector from the WeakAuras/LibDeflate 6-bit scheme: "abc" -> bytes 97,98,99.
  // 97 + 98*256 + 99*65536 = 6513249 -> 6-bit groups (LSB first): 33,9,54,24 -> H j 2 y
  assertEqual(Import.encodeForPrint('abc'), 'Hj2y', 'encodeForPrint matches the LibDeflate reference vector');

  // Names carrying a quote or backslash are escaped the way MRT TextToTable un-escapes.
  State.groups = [[mkPlayer('Ba"ck\\slash','MAGE','Fire','caster_dps')], [], [], [], []];
  State.roster = State.groups.flat();
  assertEqual(mrtDecodeForPrint(Import.exportMrtString().slice(7)),
    '0,{[1]="Ba\\"ck\\\\slash"}', 'Quotes and backslashes in names are escaped');

  // Non-ASCII names (WoW names are UTF-8) survive as their UTF-8 bytes.
  State.groups = [[mkPlayer('Ærin','MAGE','Fire','caster_dps')], [], [], [], []];
  State.roster = State.groups.flat();
  assertEqual(mrtDecodeForPrint(Import.exportMrtString().slice(7)),
    '0,{[1]="Ærin"}', 'UTF-8 names round-trip byte-for-byte');

  // Sixth+ member of a group (over-capacity edge) never bleeds into the next group's slots.
  State.groups = [[1,2,3,4,5,6].map(n => mkPlayer('P'+n,'MAGE','Fire','caster_dps')), [mkPlayer('Q','MAGE','Fire','caster_dps')], [], [], []];
  State.roster = State.groups.flat();
  assertEqual(mrtDecodeForPrint(Import.exportMrtString().slice(7)),
    '0,{[1]="P1",[2]="P2",[3]="P3",[4]="P4",[5]="P5",[6]="Q"}', 'Only five slots per group are written');
});

describe('Optimizer 25-man: all players placed', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  const totalPlaced = State.groups.reduce((sum, g) => sum + g.length, 0);
  assertEqual(totalPlaced, 25, 'All 25 players should be placed');

  // No group should exceed 5
  for (let i = 0; i < State.groups.length; i++) {
    assert(State.groups[i].length <= 5, `Group ${i+1} should have <= 5 players (has ${State.groups[i].length})`);
  }
});

describe('Optimizer 25-man: enhance shamans placed with melee', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  // Find groups containing enhance shamans
  for (const g of State.groups) {
    const enhShams = g.filter(p => p.class === 'SHAMAN' && p.spec === 'Enhancement');
    if (enhShams.length > 0) {
      // Group with enhance shaman should have melee or tanks (to benefit from WF)
      const meleeOrTanks = g.filter(p => p.role === 'melee_dps' || p.role === 'tank');
      assert(meleeOrTanks.length > 0, `Group with enhance shaman (${enhShams[0].name}) should have melee/tanks`);
    }
  }
});

describe('Optimizer 25-man: elemental shaman placed with casters', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  for (const g of State.groups) {
    const eleShams = g.filter(p => p.class === 'SHAMAN' && p.spec === 'Elemental');
    if (eleShams.length > 0) {
      const casters = g.filter(p => p.role === 'caster_dps' || p.role === 'ranged_dps');
      assert(casters.length > 0, `Group with ele shaman should have casters/ranged`);
    }
  }
});

describe('Optimizer 25-man: shadow priest placed with casters', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  for (const g of State.groups) {
    const sp = g.filter(p => p.class === 'PRIEST' && p.spec === 'Shadow');
    if (sp.length > 0) {
      const casters = g.filter(p => p.role === 'caster_dps');
      assert(casters.length >= 1, 'Shadow priest should be grouped with casters');
    }
  }
});

describe('Optimizer 25-man: resto shaman placed with healers', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  for (const g of State.groups) {
    const restoShams = g.filter(p => p.class === 'SHAMAN' && p.spec === 'Restoration');
    if (restoShams.length > 0) {
      const healers = g.filter(p => p.role === 'healer');
      assert(healers.length >= 1, 'Resto shaman should be grouped with healers');
    }
  }
});

describe('Optimizer 25-man: feral druid placed with melee for LotP', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  for (const g of State.groups) {
    const ferals = g.filter(p => p.class === 'DRUID' && p.spec === 'Feral');
    if (ferals.length > 0) {
      const meleeOrTanks = g.filter(p => p.role === 'melee_dps' || p.role === 'tank');
      assert(meleeOrTanks.length > 0, 'Feral druid should be grouped with melee/tanks for LotP');
    }
  }
});

// ── OPTIMIZER: 10-MAN TESTS ─────────────────────────────────────
describe('Optimizer 10-man: basic layout', () => {
  const roster = [
    mkPlayer('Tank1','WARRIOR','Protection','tank'),
    mkPlayer('Tank2','PALADIN','Protection','tank'),
    mkPlayer('EnhSham','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
    mkPlayer('Healer1','PRIEST','Holy','healer'),
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Mage','MAGE','Arcane','caster_dps'),
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Healer2','DRUID','Restoration','healer'),
    mkPlayer('Hunter','HUNTER','Beast Mastery','ranged_dps'),
  ];
  loadRosterAndOptimize(roster, 'kara');

  assertEqual(State.groups.length, 2, 'Kara should have 2 groups');
  const totalPlaced = State.groups.reduce((sum, g) => sum + g.length, 0);
  assertEqual(totalPlaced, 10, 'All 10 players placed');

  // Group 1 should have tanks + enhance shaman
  const g1 = State.groups[0];
  const g1Tanks = g1.filter(p => p.role === 'tank');
  assert(g1Tanks.length >= 1, 'Group 1 should have tanks');
  const g1Enh = g1.filter(p => p.spec === 'Enhancement');
  assert(g1Enh.length > 0, 'Group 1 should have enhance shaman for WF');

  // Group 2 should have casters + ele shaman
  const g2 = State.groups[1];
  const g2Ele = g2.filter(p => p.spec === 'Elemental');
  assert(g2Ele.length > 0, 'Group 2 should have ele shaman for WoA/ToW');
});

// ── BUFF CALCULATION TESTS ──────────────────────────────────────
describe('Buffs: enhance shaman provides Windfury in melee group', () => {
  const group = [
    mkPlayer('EnhSham','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Rogue1','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue2','ROGUE','Combat','melee_dps'),
    mkPlayer('FuryWarr','WARRIOR','Fury','melee_dps'),
    mkPlayer('RetPally','PALADIN','Retribution','melee_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assertIncludes(buffIds, 'WINDFURY', 'Melee group with enh shaman should have Windfury');
  assertIncludes(buffIds, 'STRENGTH_OF_EARTH', 'Enh shaman should also provide SoE');
});

describe('Buffs: elemental shaman provides Wrath of Air in caster group', () => {
  const group = [
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Mage1','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Fire','caster_dps'),
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
    mkPlayer('SPriest','PRIEST','Shadow','caster_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assertIncludes(buffIds, 'WRATH_OF_AIR', 'Caster group should get WoA from ele shaman');
  assertIncludes(buffIds, 'TOTEM_OF_WRATH', 'Ele shaman should provide ToW');
  assert(!buffIds.includes('SHADOW_WEAVING'),
    'Shadow Weaving is a raid debuff, not a party buff, so it must not appear in group buffs');
  assert(!!Config.Debuffs.SHADOW_WEAVING, 'Shadow Weaving should be catalogued as a raid debuff');
});

describe('Buffs: totem element exclusivity — one air totem per shaman', () => {
  const group = [
    mkPlayer('EnhSham','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
    mkPlayer('Mage','MAGE','Arcane','caster_dps'),
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const airBuffs = buffs.filter(b => TOTEM_ELEMENTS[b.id] === 'air');
  // Two shamans each provide one air totem
  assertEqual(airBuffs.length, 2, 'Two shamans should each provide one air totem');
});

describe('Buffs: totem element exclusivity — only one water totem per group', () => {
  const group = [
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('RestoSham','SHAMAN','Restoration','healer'),
    mkPlayer('Mage','MAGE','Arcane','caster_dps'),
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Healer','PRIEST','Holy','healer'),
  ];
  const buffs = getGroupBuffs(group);
  const waterBuffs = buffs.filter(b => TOTEM_ELEMENTS[b.id] === 'water');
  // Two shamans each provide one water totem
  assertEqual(waterBuffs.length, 2, 'Two shamans should each provide one water totem');
  // With a healer present and dominant caster role, Mana Tide should be preferred over Mana Spring
  // Actually the dominant role here is caster_dps (2 casters + 1 ele), but resto provides Mana Tide
  // which is preferred over Mana Spring regardless
  const hasMT = buffs.some(b => b.id === 'MANA_TIDE');
  assert(hasMT, 'Mana Tide should be preferred over Mana Spring when resto shaman present');
});

describe('Buffs: paladin aura — only one aura type per paladin', () => {
  const group = [
    mkPlayer('HolyPally','PALADIN','Holy','healer'),
    mkPlayer('ProtPally','PALADIN','Protection','tank'),
    mkPlayer('Mage','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Fire','caster_dps'),
    mkPlayer('Healer','PRIEST','Holy','healer'),
  ];
  const buffs = getGroupBuffs(group);
  const auraBuffs = buffs.filter(b => PALADIN_AURAS[b.id]);
  // Each paladin should contribute at most one aura type
  // Two paladins could contribute two different auras
  assert(auraBuffs.length <= 2, 'Should have at most 2 aura types (one per paladin)');
  // But no duplicate aura types
  const auraIds = auraBuffs.map(b => b.id);
  const uniqueAuras = [...new Set(auraIds)];
  assertEqual(auraIds.length, uniqueAuras.length, 'No duplicate aura types');
});

describe('Buffs: feral druid provides Leader of the Pack', () => {
  const group = [
    mkPlayer('Feral','DRUID','Feral','melee_dps'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
    mkPlayer('Warrior','WARRIOR','Fury','melee_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assertIncludes(buffIds, 'LEADER_OF_THE_PACK', 'Feral druid should provide LotP');
});

describe('Buffs: boomkin provides Moonkin Aura', () => {
  const group = [
    mkPlayer('Boomkin','DRUID','Balance','caster_dps'),
    mkPlayer('Mage','MAGE','Arcane','caster_dps'),
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assertIncludes(buffIds, 'MOONKIN_AURA', 'Boomkin should provide Moonkin Aura');
});

describe('Buffs: Marksmanship hunter provides Trueshot Aura', () => {
  const group = [
    mkPlayer('Hunter','HUNTER','Marksmanship','ranged_dps'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assertIncludes(buffIds, 'TRUESHOT_AURA', 'Marksmanship hunter should provide TSA');
});

describe('Buffs: BM hunter does NOT provide Trueshot Aura', () => {
  const group = [
    mkPlayer('Hunter','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assert(!buffIds.includes('TRUESHOT_AURA'), 'BM hunter should not provide TSA');
  assertIncludes(buffIds, 'FEROCIOUS_INSP', 'BM hunter should provide Ferocious Inspiration');
});

describe('Buffs: warlock provides Blood Pact', () => {
  const group = [
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Mage','MAGE','Arcane','caster_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const buffIds = buffs.map(b => b.id);
  assertIncludes(buffIds, 'BLOOD_PACT', 'Warlock should provide Blood Pact');
});

describe('Buffs: empty group returns no buffs', () => {
  const buffs = getGroupBuffs([]);
  assertEqual(buffs.length, 0, 'Empty group should have no buffs');
});

describe('Buffs: melee-dominant group selects Windfury over WoA for air totem', () => {
  // Group with 3 melee + 1 enhance shaman + 1 caster
  const group = [
    mkPlayer('EnhSham','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
    mkPlayer('Warrior','WARRIOR','Fury','melee_dps'),
    mkPlayer('Mage','MAGE','Arcane','caster_dps'),
    mkPlayer('RetPally','PALADIN','Retribution','melee_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const airBuff = buffs.find(b => TOTEM_ELEMENTS[b.id] === 'air');
  assertEqual(airBuff.id, 'WINDFURY', 'Melee-dominant group should pick Windfury for air totem');
});

describe('Buffs: caster-dominant group selects Wrath of Air for air totem', () => {
  const group = [
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Mage1','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Fire','caster_dps'),
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
  ];
  const buffs = getGroupBuffs(group);
  const airBuff = buffs.find(b => TOTEM_ELEMENTS[b.id] === 'air');
  assertEqual(airBuff.id, 'WRATH_OF_AIR', 'Caster-dominant group should pick WoA for air totem');
});

// ── EDGE CASES ──────────────────────────────────────────────────
describe('Edge: empty roster', () => {
  resetState();
  State.groups = [[], [], [], [], []];
  Optimizer.optimize();
  const total = State.groups.reduce((s, g) => s + g.length, 0);
  assertEqual(total, 0, 'Empty roster should produce empty groups');
});

describe('Edge: all one class (25 rogues)', () => {
  const roster = Array.from({length:25}, (_, i) => mkPlayer('Rogue'+i, 'ROGUE', 'Combat', 'melee_dps'));
  loadRosterAndOptimize(roster, 'bt');
  const total = State.groups.reduce((s, g) => s + g.length, 0);
  assertEqual(total, 25, 'All 25 rogues should be placed');
  for (const g of State.groups) {
    assertEqual(g.length, 5, 'Each group should have exactly 5');
  }
});

describe('Edge: more players than slots', () => {
  const roster = Array.from({length:30}, (_, i) => mkPlayer('Player'+i, 'ROGUE', 'Combat', 'melee_dps'));
  loadRosterAndOptimize(roster, 'bt');
  const total = State.groups.reduce((s, g) => s + g.length, 0);
  assertEqual(total, 25, 'Should only place up to max capacity (25)');
});

describe('Edge: all healers', () => {
  const roster = Array.from({length:10}, (_, i) => mkPlayer('Healer'+i, 'PRIEST', 'Holy', 'healer'));
  loadRosterAndOptimize(roster, 'kara');
  const total = State.groups.reduce((s, g) => s + g.length, 0);
  assertEqual(total, 10, 'All healers should be placed');
});

describe('Edge: only buff providers (shamans)', () => {
  const roster = [
    mkPlayer('Enh1','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Enh2','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Ele1','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Resto1','SHAMAN','Restoration','healer'),
    mkPlayer('Resto2','SHAMAN','Restoration','healer'),
  ];
  loadRosterAndOptimize(roster, 'kara');
  const total = State.groups.reduce((s, g) => s + g.length, 0);
  assertEqual(total, 5, 'All shamans should be placed');
});

describe('Edge: single player', () => {
  const roster = [mkPlayer('Solo','WARRIOR','Arms','melee_dps')];
  loadRosterAndOptimize(roster, 'bt');
  const total = State.groups.reduce((s, g) => s + g.length, 0);
  assertEqual(total, 1, 'Single player should be placed');
});

// ── DETERMINISM TEST ────────────────────────────────────────────
describe('Optimizer: deterministic results', () => {
  const roster1 = buildStandard25ManRoster();
  loadRosterAndOptimize(roster1, 'bt');
  const result1 = State.groups.map(g => g.map(p => p.name));

  const roster2 = buildStandard25ManRoster();
  loadRosterAndOptimize(roster2, 'bt');
  const result2 = State.groups.map(g => g.map(p => p.name));

  assertEqual(JSON.stringify(result1), JSON.stringify(result2), 'Optimizer should produce identical results for same input');
});

// ── COMPREHENSIVE BUFF OPTIMIZATION VALIDATION ──────────────────
describe('Optimizer 25-man: comprehensive buff check', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  // Check that NO group has two shamans with the same totem element active
  for (let gi = 0; gi < State.groups.length; gi++) {
    const g = State.groups[gi];
    const buffs = getGroupBuffs(g);

    // Count air totems in this group's buffs
    const airBuffs = buffs.filter(b => TOTEM_ELEMENTS[b.id] === 'air');
    assert(airBuffs.length <= 1, `Group ${gi+1} should have at most 1 air totem buff, has ${airBuffs.length}`);

    const waterBuffs = buffs.filter(b => TOTEM_ELEMENTS[b.id] === 'water');
    assert(waterBuffs.length <= 1, `Group ${gi+1} should have at most 1 water totem buff, has ${waterBuffs.length}`);

    const fireBuffs = buffs.filter(b => TOTEM_ELEMENTS[b.id] === 'fire');
    assert(fireBuffs.length <= 1, `Group ${gi+1} should have at most 1 fire totem buff, has ${fireBuffs.length}`);

    const earthBuffs = buffs.filter(b => TOTEM_ELEMENTS[b.id] === 'earth');
    assert(earthBuffs.length <= 1, `Group ${gi+1} should have at most 1 earth totem buff, has ${earthBuffs.length}`);

    // Check paladin aura exclusivity
    const auraBuffs = buffs.filter(b => PALADIN_AURAS[b.id]);
    const uniqueAuras = [...new Set(auraBuffs.map(b => b.id))];
    assertEqual(auraBuffs.length, uniqueAuras.length, `Group ${gi+1} should have no duplicate aura types`);
  }
});

describe('Optimizer 25-man: tanks grouped together', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  // Find the group(s) with the most tanks
  let maxTankGroup = -1, maxTanks = 0;
  for (let gi = 0; gi < State.groups.length; gi++) {
    const tankCount = State.groups[gi].filter(p => p.role === 'tank').length;
    if (tankCount > maxTanks) { maxTanks = tankCount; maxTankGroup = gi; }
  }
  // Rule (2026-09-02): only the Prot Paladin anchors the healer group; Feral tanks ride
  // with melee for LotP. The old "2 tanks together" expectation is gone.
  const protPal = State.roster.find(p => p.class === 'PALADIN' && p.spec === 'Protection');
  const feral = State.roster.find(p => p.class === 'DRUID' && p.spec === 'Feral' && p.role === 'tank');
  assertEqual(protPal.groupNumber, State.groups.length, 'Prot Paladin anchors the last (healer/tank) group');
  assert(feral.groupNumber !== protPal.groupNumber, 'Feral tank does not ride in the healer/tank group');
});

// ── IMPORT: RAID HELPER FORMAT WITH BENCH/TANK OVERRIDES ────────
describe('Import: Tank className override', () => {
  resetState();
  const json = JSON.stringify({
    slots: [
      { name:'FuryTank', specName:'Fury', className:'Tank', groupNumber:1, slotNumber:1 },
    ]
  });
  Import.importRaidHelper(json);
  const player = State.roster[0];
  assertEqual(player.role, 'tank', 'Tank className should override spec role');
  assertEqual(player.class, 'WARRIOR', 'Should still resolve class from specName');
});

describe('Import: Bench className lands on the bench, not in a group', () => {
  resetState();
  const json = JSON.stringify({
    slots: [
      { name:'RealMage',  specName:'Fire',   className:'Mage',  groupNumber:1, slotNumber:1 },
      { name:'BenchMage', specName:'Arcane', className:'Bench', groupNumber:1, slotNumber:2 },
    ]
  });
  Import.importRaidHelper(json);
  assertEqual(State.bench.length, 1, 'Bench players should be imported onto the bench');
  assertEqual(State.bench[0].class, 'MAGE', 'Bench player class should resolve from spec');
  assertEqual(State.bench[0].groupNumber, 0, 'Bench player should not carry a group number');
  assertEqual(State.roster.length, 1, 'Bench player should not occupy a group slot');
});

// ════════════════════════════════════════════════════════════════
// PHASE 3: STRENGTHENED VALIDATION TESTS
// ════════════════════════════════════════════════════════════════

describe('VALIDATION: exact 25-man group composition for known roster', () => {
  // This test validates strict-mode behavior (ele shaman to tanks, enhance to melee)
  State.optimizerMode = 'strict';
  // Build a roster matching the reference TBC ideal comp pattern
  const roster = [
    // 2 tanks (go to G5 healer/tank group)
    mkPlayer('Tank1','WARRIOR','Protection','tank'),
    mkPlayer('Tank2','PALADIN','Protection','tank'),
    // 2 enhance shamans (1 per melee group for WF)
    mkPlayer('Enh1','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Enh2','SHAMAN','Enhancement','melee_dps'),
    // 2 feral druids (1 per melee group for LotP)
    mkPlayer('Feral1','DRUID','Feral','melee_dps'),
    mkPlayer('Feral2','DRUID','Feral','melee_dps'),
    // 3 melee DPS
    mkPlayer('Rogue1','ROGUE','Combat','melee_dps'),
    mkPlayer('RetPally','PALADIN','Retribution','melee_dps'),
    mkPlayer('Warrior1','WARRIOR','Fury','melee_dps'),
    // 1 shadow priest (caster support group)
    mkPlayer('SPriest','PRIEST','Shadow','caster_dps'),
    // 1 ele shaman (caster DPS group with Boomkin + Destro Locks)
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    // 3 destro warlocks (stack in caster DPS group)
    mkPlayer('Lock1','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Lock2','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Lock3','WARLOCK','Destruction','caster_dps'),
    // 1 aff warlock (healer/tank group)
    mkPlayer('AffLock','WARLOCK','Affliction','caster_dps'),
    // 1 boomkin (caster DPS group with ele shaman)
    mkPlayer('Boomkin','DRUID','Balance','caster_dps'),
    // 2 arcane mages (caster support group)
    mkPlayer('Mage1','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Arcane','caster_dps'),
    // 1 BM hunter (melee group)
    mkPlayer('Hunter1','HUNTER','Beast Mastery','ranged_dps'),
    // 1 survival hunter (melee group)
    mkPlayer('Hunter2','HUNTER','Survival','ranged_dps'),
    // 2 resto shamans (1 caster support, 1 healer/tank group)
    mkPlayer('RestoSham1','SHAMAN','Restoration','healer'),
    mkPlayer('RestoSham2','SHAMAN','Restoration','healer'),
    // 3 healers
    mkPlayer('HPally','PALADIN','Holy','healer'),
    mkPlayer('HPriest','PRIEST','Holy','healer'),
    mkPlayer('RDruid','DRUID','Restoration','healer'),
  ];
  assertEqual(roster.length, 25, 'Test roster should have exactly 25 players');
  loadRosterAndOptimize(roster, 'bt');

  // ── BUFF-BASED VALIDATION ──
  // The optimizer follows the reference TBC ideal comp pattern:
  // G1/G2: Melee (Feral + Shaman/WF + physical DPS)
  // G3: Caster support (Resto Shaman + SPriest + casters + healer)
  // G4: Caster DPS (Ele Shaman + Boomkin + Destro Locks)
  // G5: Healer/Tank (tanks + healers + Aff Lock)

  // Melee groups (G1/G2) should have Windfury + Leader of the Pack
  const g1Buffs = getGroupBuffs(State.groups[0]);
  const g1BuffIds = g1Buffs.map(b => b.id);
  assert(g1BuffIds.includes('WINDFURY'), 'Melee group 1 should have Windfury Totem');
  assert(g1BuffIds.includes('LEADER_OF_THE_PACK'), 'Melee group 1 should have Leader of the Pack');

  // The Prot Paladin anchors the healer/tank group (last group)
  const protPal = State.roster.find(p => p.name === 'Tank2');
  assertEqual(protPal.groupNumber, State.groups.length, 'Prot Paladin anchors the healer/tank group');

  // Enhance shamans should be in melee groups (providing WF to DPS)
  const meleeGroupsWithEnhance = State.groups.slice(0, 2).filter(g =>
    g.some(p => p.class === 'SHAMAN' && p.spec === 'Enhancement')
  );
  assert(meleeGroupsWithEnhance.length >= 1, 'At least one melee group should have an Enhancement Shaman');

  // A shadow priest in the raid covers Shadow Weaving as a raid debuff. It is not a
  // party buff, so it is checked through debuff coverage rather than getGroupBuffs.
  const shadowPriestPresent = State.roster.some(p => p.class === 'PRIEST' && p.spec === 'Shadow');
  assert(shadowPriestPresent, 'The standard roster should contain a shadow priest');

  // At least one group should have Totem of Wrath (from ele shaman) or Wrath of Air
  let hasTotemOfWrath = false;
  for (const g of State.groups) {
    const buffs = getGroupBuffs(g);
    if (buffs.some(b => b.id === 'TOTEM_OF_WRATH')) { hasTotemOfWrath = true; break; }
  }
  // Ele shaman should be in caster DPS group (G4) providing ToW
  assert(hasTotemOfWrath, 'At least one group should have Totem of Wrath');

  // The group with resto shaman should have Mana Tide buff
  let hasMTGroup = false;
  for (const g of State.groups) {
    const buffs = getGroupBuffs(g);
    if (buffs.some(b => b.id === 'MANA_TIDE')) { hasMTGroup = true; break; }
  }
  assert(hasMTGroup, 'A group with resto shaman should provide Mana Tide Totem');

  // At least one group should have Moonkin Aura
  let hasMoonkin = false;
  for (const g of State.groups) {
    const buffs = getGroupBuffs(g);
    if (buffs.some(b => b.id === 'MOONKIN_AURA')) { hasMoonkin = true; break; }
  }
  assert(hasMoonkin, 'At least one group should have Moonkin Aura');
  // Reset back to default
  State.optimizerMode = 'balanced';
});

describe('VALIDATION: no enhance shaman wasted in caster group', () => {
  const roster = buildStandard25ManRoster();
  loadRosterAndOptimize(roster, 'bt');

  for (const g of State.groups) {
    const enhShams = g.filter(p => p.class === 'SHAMAN' && p.spec === 'Enhancement');
    if (enhShams.length > 0) {
      const casterOnly = g.every(p => p.role === 'caster_dps' || p.role === 'ranged_dps' || (p.class === 'SHAMAN' && p.spec === 'Enhancement'));
      assert(!casterOnly || g.length === 1, 'Enhance shaman should not be in a pure caster/ranged group');
    }
  }
});

describe('VALIDATION: group size never exceeds 5 for any raid', () => {
  for (const raidKey of Config.RaidOrder) {
    const raidInfo = Config.Raids[raidKey];
    const roster = Array.from({length: raidInfo.size}, (_, i) =>
      mkPlayer('Player'+i, 'WARRIOR', 'Fury', 'melee_dps')
    );
    loadRosterAndOptimize(roster, raidKey);
    for (let gi = 0; gi < State.groups.length; gi++) {
      assert(State.groups[gi].length <= 5, `${raidInfo.name} group ${gi+1} exceeds 5 (has ${State.groups[gi].length})`);
    }
    const total = State.groups.reduce((s, g) => s + g.length, 0);
    assertEqual(total, raidInfo.size, `${raidInfo.name} should place all ${raidInfo.size} players`);
  }
});

describe('VALIDATION: buff priority order is descending', () => {
  const group = [
    mkPlayer('EnhSham','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Feral','DRUID','Feral','melee_dps'),
    mkPlayer('Hunter','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('ProtPally','PALADIN','Protection','tank'),
    mkPlayer('Warlock','WARLOCK','Destruction','caster_dps'),
  ];
  const buffs = getGroupBuffs(group);
  for (let i = 1; i < buffs.length; i++) {
    assert(getBuffPriority(buffs[i-1].buff) >= getBuffPriority(buffs[i].buff),
      `Buff ${buffs[i-1].id} (${getBuffPriority(buffs[i-1].buff)}) should be >= ${buffs[i].id} (${getBuffPriority(buffs[i].buff)})`);
  }
});

describe('VALIDATION: round-trip import/export preserves all data', () => {
  resetState();
  State.selectedRaid = 'ssc';
  const original = [
    mkPlayer('TestWarrior','WARRIOR','Arms','melee_dps'),
    mkPlayer('TestPaladin','PALADIN','Holy','healer'),
    mkPlayer('TestShaman','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('TestDruid','DRUID','Feral','tank'),
    mkPlayer('TestHunter','HUNTER','Survival','ranged_dps'),
  ];
  State.roster = original;
  State.groups = [original.slice()];

  const exported = Import.exportRoster('RT Test');
  resetState();
  Import.loadRoster(exported);

  assertEqual(State.roster.length, 5, 'Round-trip: player count preserved');
  assertEqual(State.selectedRaid, 'ssc', 'Round-trip: raid preserved');
  assertEqual(State.rosterName, 'RT Test', 'Round-trip: name preserved');
  for (let i = 0; i < 5; i++) {
    assertEqual(State.roster[i].name, original[i].name, `Round-trip: player ${i} name preserved`);
    assertEqual(State.roster[i].class, original[i].class, `Round-trip: player ${i} class preserved`);
    assertEqual(State.roster[i].spec, original[i].spec, `Round-trip: player ${i} spec preserved`);
    assertEqual(State.roster[i].role, original[i].role, `Round-trip: player ${i} role preserved`);
  }
});

describe('VALIDATION: all spec mappings produce valid classes', () => {
  for (const [specName, mapping] of Object.entries(Config.RaidHelperSpecMap)) {
    assert(Config.ClassColors[mapping.class] !== undefined,
      `RaidHelperSpecMap[${specName}].class = ${mapping.class} should be a valid class`);
    assert(['tank','healer','melee_dps','ranged_dps','caster_dps'].includes(mapping.role),
      `RaidHelperSpecMap[${specName}].role = ${mapping.role} should be a valid role`);
  }
});

describe('VALIDATION: every buff has a valid abbreviation', () => {
  for (const buffId of Object.keys(Config.Buffs)) {
    assert(Config.BuffAbbreviations[buffId] !== undefined,
      `Buff ${buffId} should have an abbreviation`);
    assert(typeof Config.BuffAbbreviations[buffId] === 'string' && Config.BuffAbbreviations[buffId].length > 0,
      `Buff ${buffId} abbreviation should be a non-empty string`);
  }
});

describe('VALIDATION: optimizer distributes shamans across groups for max buff coverage', () => {
  // A roster with 3 enhance shamans should spread them across multiple groups
  const roster = [
    mkPlayer('Tank1','WARRIOR','Protection','tank'),
    mkPlayer('Tank2','PALADIN','Protection','tank'),
    mkPlayer('Enh1','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Enh2','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Enh3','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Rogue1','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue2','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue3','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue4','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue5','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue6','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue7','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue8','ROGUE','Combat','melee_dps'),
    mkPlayer('Mage1','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage3','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage4','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage5','MAGE','Arcane','caster_dps'),
    mkPlayer('H1','PRIEST','Holy','healer'),
    mkPlayer('H2','PRIEST','Holy','healer'),
    mkPlayer('H3','PRIEST','Holy','healer'),
    mkPlayer('H4','PRIEST','Holy','healer'),
    mkPlayer('H5','PRIEST','Holy','healer'),
    mkPlayer('Hunter1','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('Hunter2','HUNTER','Marksmanship','ranged_dps'),
  ];
  loadRosterAndOptimize(roster, 'bt');

  // Count how many groups have an enhance shaman
  let groupsWithEnh = 0;
  for (const g of State.groups) {
    if (g.some(p => p.class === 'SHAMAN' && p.spec === 'Enhancement')) groupsWithEnh++;
  }
  assert(groupsWithEnh >= 2, `3 enhance shamans should be spread across at least 2 groups (got ${groupsWithEnh})`);
});

describe('VALIDATION: BM hunters placed in melee groups, not caster groups', () => {
  const roster = [
    mkPlayer('Tank1','WARRIOR','Protection','tank'),
    mkPlayer('Tank2','PALADIN','Protection','tank'),
    mkPlayer('Enh1','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Feral1','DRUID','Feral','melee_dps'),
    mkPlayer('Rogue1','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue2','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue3','ROGUE','Combat','melee_dps'),
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('SPriest','PRIEST','Shadow','caster_dps'),
    mkPlayer('Mage1','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Fire','caster_dps'),
    mkPlayer('Lock1','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Lock2','WARLOCK','Affliction','caster_dps'),
    mkPlayer('Lock3','WARLOCK','Demonology','caster_dps'),
    mkPlayer('Boomkin','DRUID','Balance','caster_dps'),
    // 3 BM hunters — should be layered into melee groups
    mkPlayer('BM1','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('BM2','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('BM3','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('RestoSham','SHAMAN','Restoration','healer'),
    mkPlayer('HPally','PALADIN','Holy','healer'),
    mkPlayer('HPriest','PRIEST','Holy','healer'),
    mkPlayer('RDruid','DRUID','Restoration','healer'),
    mkPlayer('DiscPriest','PRIEST','Discipline','healer'),
    mkPlayer('HPally2','PALADIN','Holy','healer'),
    mkPlayer('RetPally','PALADIN','Retribution','melee_dps'),
  ];
  assertEqual(roster.length, 25, 'Test roster should have exactly 25 players');
  loadRosterAndOptimize(roster, 'bt');

  // BM hunters should prioritize melee groups. With this roster (5 melee + 2 tanks +
  // 1 feral + 1 enh + 1 ele = 10, filling 2 groups of 5), there's only room for 1 BM
  // hunter in the melee section. The other 2 overflow. Verify at least 1 is with melee.
  let bmInMeleeGroups = 0;
  for (const g of State.groups) {
    const bmCount = g.filter(p => p.class === 'HUNTER' && p.spec === 'Beast Mastery').length;
    const meleeOrTanks = g.filter(p => p.role === 'melee_dps' || p.role === 'tank');
    if (bmCount > 0 && meleeOrTanks.length > 0) bmInMeleeGroups += bmCount;
  }
  assert(bmInMeleeGroups >= 1, `At least 1 BM hunter should be in a melee group (got ${bmInMeleeGroups})`);

  // BM hunters should have Ferocious Inspiration buff in their groups
  for (const g of State.groups) {
    if (g.some(p => p.class === 'HUNTER' && p.spec === 'Beast Mastery')) {
      const buffs = getGroupBuffs(g);
      assert(buffs.some(b => b.id === 'FEROCIOUS_INSP'), 'Group with BM hunter should show Ferocious Inspiration buff');
    }
  }
});

describe('VALIDATION: BM hunters spread 1-per-group before doubling up', () => {
  const roster = [
    mkPlayer('Tank1','WARRIOR','Protection','tank'),
    mkPlayer('Tank2','PALADIN','Protection','tank'),
    mkPlayer('Enh1','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Enh2','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Feral1','DRUID','Feral','melee_dps'),
    mkPlayer('Rogue1','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue2','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue3','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue4','ROGUE','Combat','melee_dps'),
    mkPlayer('Rogue5','ROGUE','Combat','melee_dps'),
    // 2 BM hunters — should each go to a different melee group
    mkPlayer('BM1','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('BM2','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('EleSham','SHAMAN','Elemental','caster_dps'),
    mkPlayer('SPriest','PRIEST','Shadow','caster_dps'),
    mkPlayer('Mage1','MAGE','Arcane','caster_dps'),
    mkPlayer('Mage2','MAGE','Fire','caster_dps'),
    mkPlayer('Lock1','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Boomkin','DRUID','Balance','caster_dps'),
    mkPlayer('RestoSham','SHAMAN','Restoration','healer'),
    mkPlayer('HPally','PALADIN','Holy','healer'),
    mkPlayer('HPriest','PRIEST','Holy','healer'),
    mkPlayer('RDruid','DRUID','Restoration','healer'),
    mkPlayer('DiscPriest','PRIEST','Discipline','healer'),
    mkPlayer('HPally2','PALADIN','Holy','healer'),
    mkPlayer('Hunter3','HUNTER','Marksmanship','ranged_dps'),
  ];
  assertEqual(roster.length, 25, 'Test roster should have exactly 25 players');
  loadRosterAndOptimize(roster, 'bt');

  // Count BM hunters per group — no group should have 2 while another has 0
  // (in the melee section)
  let groupsWithBM = 0;
  let maxBMInGroup = 0;
  for (const g of State.groups) {
    const bmCount = g.filter(p => p.class === 'HUNTER' && p.spec === 'Beast Mastery').length;
    if (bmCount > 0) groupsWithBM++;
    if (bmCount > maxBMInGroup) maxBMInGroup = bmCount;
  }
  assert(groupsWithBM >= 2, `2 BM hunters should be in at least 2 different groups (got ${groupsWithBM})`);
  assert(maxBMInGroup <= 1, `No group should have more than 1 BM hunter when there are only 2 (max was ${maxBMInGroup})`);
});

// ════════════════════════════════════════════════════════════════
// PLAN MODE ROSTER EDITING
// ════════════════════════════════════════════════════════════════

// ── Import routing ──

describe('Import: Tentative sign-ups go to the bench, not into groups', () => {
  resetState();
  const json = JSON.stringify({ signUps: [
    { name:'RealTank',   className:'Tank',      specName:'Protection',   id:1 },
    { name:'RealHealer', className:'Paladin',   specName:'Holy',         id:2 },
    { name:'Hellsmouth', className:'Tentative', specName:'Beastmastery', id:3 },
    { name:'Annorok',    className:'Tentative', specName:'Arcane',       id:4 },
  ]});
  const result = Import.importRaidHelper(json);
  assert(result.success, 'Import should succeed');
  assertEqual(State.bench.length, 2, 'Both Tentative sign-ups should be benched');
  assertEqual(result.benchCount, 2, 'Result should report benchCount');
  const names = State.roster.map(p => p.name);
  assert(!names.includes('Hellsmouth'), 'Tentative player must not be in a group');
  assert(!names.includes('Annorok'), 'Tentative player must not be in a group');
  assertEqual(State.roster.length, 2, 'Only real sign-ups should be assigned');
});

describe('Import: sign-ups beyond the raid size are benched, not dropped', () => {
  resetState();
  State.selectedRaid = 'bt';
  const specs = ['Protection','Holy','Arms','Fire','Affliction','Beastmastery','Combat','Restoration1','Shadow','Elemental'];
  const classes = ['Tank','Paladin','Warrior','Mage','Warlock','Hunter','Rogue','Druid','Priest','Shaman'];
  const signUps = [];
  for (let i = 0; i < 30; i++) signUps.push({ name:'P' + (i + 1), className:classes[i % 10], specName:specs[i % 10], id:i + 1 });
  const result = Import.importRaidHelper(JSON.stringify({ signUps }));
  assert(result.success, 'Import of 30 sign-ups should succeed');
  assertEqual(State.roster.length, 25, 'Exactly 25 players are seated in a 25-man');
  assertEqual(State.bench.length, 5, 'The 5 extra sign-ups land on the bench');
  assertEqual(result.overflowCount, 5, 'Result reports how many were benched for capacity');
  assertEqual(result.benchCount, 5, 'benchCount includes the overflow');
  // Sign-up order no longer decides who sits: the optimizer sees the whole
  // pool and benches by marginal value, so the bench is not simply P26-P30.
  const benchNames = State.bench.map(p => p.name).sort();
  assert(benchNames.join(',') !== 'P26,P27,P28,P29,P30', 'Bench is chosen by value, not by sign-up order');
  const seatedTanks = State.roster.filter(p => p.role === 'tank').length;
  const seatedHealers = State.roster.filter(p => p.role === 'healer').length;
  assert(seatedTanks >= 2, 'At least 2 tanks are seated (floor)');
  assert(seatedHealers >= 5, 'At least 5 healers are seated (floor)');
  assert(State.bench.every(p => p.groupNumber === 0), 'Benched players carry groupNumber 0');
  assert(State.groups.every(g => g.length <= 5), 'No group holds more than 5 after optimize');
});

describe('Import: raid-helper slots beyond the raid size are benched, not dropped', () => {
  resetState();
  State.selectedRaid = 'bt';
  const slots = [];
  // 6 groups of 5 (a 30-man plan), plus a sixth player crammed into group 1
  for (let g = 1; g <= 6; g++) for (let s = 1; s <= 5; s++) {
    slots.push({ name:'G' + g + 'S' + s, className:'Mage', specName:'Fire', groupNumber:g, slotNumber:(g - 1) * 5 + s });
  }
  slots.push({ name:'Extra', className:'Rogue', specName:'Combat', groupNumber:1, slotNumber:31 });
  const result = Import.importRaidHelper(JSON.stringify({ slots }));
  assert(result.success, 'Import of a 31-player plan should succeed');
  assertEqual(State.groups.length, 6, 'Import keeps the plan\'s own 6 groups');
  assertEqual(State.bench.length, 1, 'Only the over-full group sheds a player at import');
  assertEqual(result.overflowCount, 1, 'Result reports the over-full group overflow');
  assert(State.bench.some(p => p.name === 'Extra'), 'The sixth player in a group is benched');
  // What the UI does next: fold the plan into the selected 25-man template.
  const folded = enforceRaidCapacity(State.groups, State.bench, Config.Raids.bt.groups);
  assertEqual(folded, 5, 'Folding a 30-man plan into a 25-man benches 5');
  assertEqual(State.groups.length, 5, 'Only the raid template\'s 5 groups remain');
  assertEqual(State.groups.flat().length, 25, '25 players are seated');
  assertEqual(State.bench.length, 6, 'Group 6 and the extra group-1 player are all on the bench');
  assert(State.bench.filter(p => p.name.startsWith('G6')).length === 5, 'The whole sixth group is benched');
});

describe('Raid capacity: shrinking to 10-man benches instead of dropping', () => {
  resetState();
  const groups = [];
  for (let g = 0; g < 5; g++) {
    groups.push([]);
    for (let s = 0; s < 5; s++) groups[g].push({ name:'P' + (g * 5 + s), class:'MAGE', spec:'Fire', role:'caster_dps', groupNumber:g + 1 });
  }
  const bench = [];
  const benched = enforceRaidCapacity(groups, bench, 2);
  assertEqual(benched, 15, '15 players do not fit a 2-group raid');
  // Open seats are used before anyone is benched
  const g3 = [[{ name:'A' }, { name:'B' }], [{ name:'C' }], [{ name:'D' }, { name:'E' }]];
  const b3 = [];
  assertEqual(enforceRaidCapacity(g3, b3, 2), 0, 'Nobody is benched while seats are open');
  assertEqual(g3.length, 2, 'Third group folded away');
  assertEqual(g3[0].length + g3[1].length, 5, 'All five players still seated');
  assertEqual(groups.length, 2, 'Only 2 groups remain');
  assertEqual(bench.length, 15, 'All 15 are on the bench');
  assert(bench.every(p => p.groupNumber === 0), 'Benched players carry groupNumber 0');
  // Over-full single group
  const g2 = [[1,2,3,4,5,6,7].map(i => ({ name:'X' + i, groupNumber:1 }))];
  const b2 = [];
  assertEqual(enforceRaidCapacity(g2, b2, 1), 2, 'Two extras in one group are benched');
  assertEqual(g2[0].length, 5, 'Group is trimmed to 5');
});

describe('Optimizer: an over-capacity board benches the leftovers', () => {
  resetState();
  State.selectedRaid = 'bt';
  State.groups = [[], [], [], [], []];
  for (let i = 0; i < 28; i++) State.groups[i % 5].push({ uid:'u' + i, name:'P' + i, class:'MAGE', spec:'Arcane', role:'caster_dps', groupNumber:(i % 5) + 1 });
  Optimizer.optimize();
  assertEqual(State.roster.length, 25, 'Optimizer seats 25');
  assertEqual(State.bench.length, 3, 'The 3 who do not fit are benched, not lost');
  assert(State.groups.every(g => g.length <= 5), 'No group exceeds 5');
});

describe('Import: benched Tentative keeps its resolved class and spec', () => {
  resetState();
  Import.importRaidHelper(JSON.stringify({ signUps: [
    { name:'RealMage',   className:'Mage',      specName:'Fire',   id:1 },
    { name:'KashPatail', className:'Tentative', specName:'Shadow', id:2 },
  ]}));
  const benched = State.bench[0];
  assertEqual(benched.name, 'KashPatail', 'Benched player keeps their name');
  assertEqual(benched.class, 'PRIEST', 'Benched Tentative resolves class from spec');
  assertEqual(benched.spec, 'Shadow', 'Benched Tentative keeps spec');
  assertEqual(benched.role, 'caster_dps', 'Benched Tentative keeps derived role');
  assertEqual(benched.groupNumber, 0, 'Benched player has groupNumber 0');
});

describe('Import: Absence sign-ups are kept as unplaced, never benched or seated', () => {
  resetState();
  const result = Import.importRaidHelper(JSON.stringify({ signUps: [
    { name:'RealMage', className:'Mage',    specName:'Fire', id:1 },
    { name:'Healthas', className:'Absence', specName:null,   id:2 },
  ]}));
  assertEqual(result.unplacedCount, 1, 'Absence is counted as unplaced');
  assertEqual(State.unplaced.map(p => p.name + ':' + p.signupStatus).join(), 'Healthas:absent', 'Absence kept with its status');
  assertEqual(State.bench.length, 0, 'Absence must not land on the bench');
  assertEqual(State.roster.length, 1, 'Absence must not land in a group');
});

describe('Import: every Raid-Helper status is filed by how the person signed up', () => {
  resetState();
  const result = Import.importRaidHelper(JSON.stringify({ signUps: [
    { name:'Tanky',  className:'Tank',        specName:'Protection', id:1 },
    { name:'Magey',  className:'Mage',        specName:'Fire',       id:2 },
    { name:'Benchy', className:'Bench',       specName:'Holy',       id:3 },
    { name:'Maybe',  className:'Tentative',   specName:'Shadow',     id:4 },
    { name:'Laggy',  className:'Late',        specName:'Arcane',     id:5 },
    { name:'Gone',   className:'Absence',     specName:'Absence',    id:6 },
    { name:'Who',    className:'Deathknight', specName:'Blood',      id:7 },
  ]}));
  assert(result.success, 'import succeeds');
  const status = (n) => [...State.roster, ...State.bench, ...State.unplaced].find(p => p.name === n)?.signupStatus;
  assertEqual(State.roster.map(p => p.name).sort().join(), 'Magey,Tanky', 'only confirmed sign-ups are seated');
  assertEqual(State.bench.map(p => p.name).sort().join(), 'Benchy,Laggy,Maybe', 'Bench, Tentative and Late wait on the bench');
  assertEqual(State.unplaced.map(p => p.name).sort().join(), 'Gone,Who', 'Absent and classless sign-ups are unplaced');
  assertEqual([status('Magey'), status('Benchy'), status('Maybe'), status('Laggy'), status('Gone'), status('Who')].join(),
    'confirmed,bench,tentative,late,absent,confirmed', 'each person keeps their Raid-Helper status');
  assertEqual(SignupStatus.tabFor(status('Laggy')), 'late', 'Late files under the Late tab');
  assertEqual(SignupStatus.tabFor(status('Benchy')), 'bench', 'Bench files under the Bench tab');
  assertEqual(SignupStatus.tabFor(undefined), 'bench', 'unstatused (hand-added or legacy) players file under Bench');
});

describe('Import: real Temp.json shape splits 21 raiders / 3 bench / 1 unplaced', () => {
  resetState();
  // Mirrors the live raid-helper export: 21 real sign-ups, 3 Tentative, 1 Absence.
  const signUps = [];
  const fillers = [
    ['Warrior','Arms'], ['Shaman','Elemental'], ['Warlock','Affliction'],
    ['Hunter','Beastmastery'], ['Warlock','Destruction'], ['Druid','Balance'],
    ['Paladin','Holy'], ['Mage','Fire'], ['Rogue','Combat'], ['Priest','Holy'],
    ['Tank','Protection'], ['Tank','Protection'], ['Shaman','Restoration'],
    ['Shaman','Enhancement'], ['Warrior','Fury'], ['Warlock','Demonology'],
    ['Mage','Frost'], ['Druid','Restoration'], ['Paladin','Retribution'],
    ['Hunter','Marksmanship'], ['Warrior','Fury'],
  ];
  fillers.forEach((f, i) => signUps.push({ name:'P'+i, className:f[0], specName:f[1], id:i }));
  signUps.push({ name:'Hellsmouth', className:'Tentative', specName:'Beastmastery', id:90 });
  signUps.push({ name:'KashPatail', className:'Tentative', specName:'Shadow',       id:91 });
  signUps.push({ name:'Annorok',    className:'Tentative', specName:'Arcane',       id:92 });
  signUps.push({ name:'Healthas',   className:'Absence',   specName:null,           id:93 });

  const result = Import.importRaidHelper(JSON.stringify({ signUps }));
  assertEqual(result.playerCount, 21, '21 real sign-ups should be assigned');
  assertEqual(result.benchCount, 3, '3 Tentative sign-ups should be benched');
  assertEqual(result.unplacedCount, 1, '1 Absence should be unplaced');
  assertEqual(State.roster.length, 21, 'Roster holds only assigned players');
});

describe('Import: bench survives the optimizer run triggered by sign-up import', () => {
  resetState();
  Import.importRaidHelper(JSON.stringify({ signUps: [
    { name:'T1',   className:'Tank',      specName:'Protection', id:1 },
    { name:'H1',   className:'Paladin',   specName:'Holy',       id:2 },
    { name:'D1',   className:'Mage',      specName:'Fire',       id:3 },
    { name:'Tent', className:'Tentative', specName:'Arcane',     id:4 },
  ]}));
  // Optimizer.optimize() sets State.roster = groups.flat(); the bench must be untouched.
  assertEqual(State.bench.length, 1, 'Bench should survive the import-time optimize');
  assertEqual(State.bench[0].name, 'Tent', 'Benched player should still be the Tentative one');
});

describe('Optimizer: an explicit optimize run never wipes the bench', () => {
  resetState();
  const roster = buildStandard25ManRoster();
  State.roster = roster;
  State.bench = [ mkPlayer('BenchedLock','WARLOCK','Affliction','caster_dps') ];
  State.bench[0].uid = 'bench1';
  State.bench[0].groupNumber = 0;
  Optimizer.optimize();
  assertEqual(State.bench.length, 1, 'Bench must survive Optimizer.optimize()');
  assert(!State.roster.some(p => p.name === 'BenchedLock'), 'Benched player must not be pulled into groups');
});

// ── Spec / class editing ──

describe('RosterEdit: changing spec re-derives the role', () => {
  resetState();
  State.groups = [[ mkPlayer('Roost','SHAMAN','Elemental','caster_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();

  const result = RosterEdit.UpdatePlayer('u1', { spec:'Restoration' });
  assert(result.success, 'Spec change should succeed');
  assertEqual(result.player.spec, 'Restoration', 'Spec should be updated');
  assertEqual(result.player.role, 'healer', 'Role must follow the new spec');
});

describe('RosterEdit: changing class re-derives class, spec and role together', () => {
  resetState();
  State.groups = [[ mkPlayer('Swapper','SHAMAN','Elemental','caster_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();

  const result = RosterEdit.UpdatePlayer('u1', { class:'WARRIOR', spec:'Protection' });
  assert(result.success, 'Class change should succeed');
  assertEqual(result.player.class, 'WARRIOR', 'Class should be updated');
  assertEqual(result.player.role, 'tank', 'Role must follow the new class/spec');
});

describe('RosterEdit: a spec that does not belong to the class is rejected', () => {
  resetState();
  State.groups = [[ mkPlayer('Bad','WARRIOR','Arms','melee_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();

  const result = RosterEdit.UpdatePlayer('u1', { class:'WARRIOR', spec:'Restoration' });
  assert(!result.success, 'Warrior cannot be Restoration');
  assertEqual(State.groups[0][0].spec, 'Arms', 'Rejected edit must not mutate the player');
});

describe('RosterEdit: renaming a player keeps them in place', () => {
  resetState();
  State.groups = [[ mkPlayer('OldName','MAGE','Fire','caster_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();

  const result = RosterEdit.UpdatePlayer('u1', { name:'NewName' });
  assert(result.success, 'Rename should succeed');
  assertEqual(State.groups[0][0].name, 'NewName', 'Name should be updated in place');
  assertEqual(State.groups[0].length, 1, 'Rename must not duplicate or drop the player');
});

describe('RosterEdit: an empty name is rejected', () => {
  resetState();
  State.groups = [[ mkPlayer('Keep','MAGE','Fire','caster_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();

  const result = RosterEdit.UpdatePlayer('u1', { name:'   ' });
  assert(!result.success, 'Blank name should be rejected');
  assertEqual(State.groups[0][0].name, 'Keep', 'Player name must be unchanged');
});

describe('RosterEdit: editing a player clears their stale buff overrides', () => {
  resetState();
  State.groups = [[ mkPlayer('Totemer','SHAMAN','Elemental','caster_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();
  State.buffOverrides['0:Totemer:air'] = { buffId:'WRATH_OF_AIR', originalBuffId:'GRACE_OF_AIR' };
  State.buffOverrides['0:SomeoneElse:air'] = { buffId:'GRACE_OF_AIR', originalBuffId:'WRATH_OF_AIR' };

  RosterEdit.UpdatePlayer('u1', { class:'WARRIOR', spec:'Arms' });
  assertEqual(State.buffOverrides['0:Totemer:air'], undefined, 'Edited player override should be cleared');
  assert(State.buffOverrides['0:SomeoneElse:air'] !== undefined, 'Other players overrides must be left alone');
});

// ── Add / remove ──

describe('RosterEdit: adding a player fills the next empty slot', () => {
  resetState();
  State.groups = [[ mkPlayer('Existing','MAGE','Fire','caster_dps') ], []];
  RosterEdit.syncRoster();

  const result = RosterEdit.AddPlayer(1, { name:'Newbie', class:'ROGUE', spec:'Combat' });
  assert(result.success, 'Add should succeed');
  assertEqual(State.groups[1].length, 1, 'Player should land in group 2');
  assertEqual(result.player.role, 'melee_dps', 'Added player role derives from spec');
  assertEqual(result.player.groupNumber, 2, 'Added player groupNumber should match the group');
  assertEqual(State.roster.length, 2, 'Roster should include the new player');
  assert(!!result.player.uid, 'Added player must get a uid');
});

describe('RosterEdit: adding to a full group is refused', () => {
  resetState();
  State.groups = [[
    mkPlayer('A','MAGE','Fire','caster_dps'), mkPlayer('B','MAGE','Fire','caster_dps'),
    mkPlayer('C','MAGE','Fire','caster_dps'), mkPlayer('D','MAGE','Fire','caster_dps'),
    mkPlayer('E','MAGE','Fire','caster_dps'),
  ]];
  RosterEdit.syncRoster();

  const result = RosterEdit.AddPlayer(0, { name:'Overflow', class:'ROGUE', spec:'Combat' });
  assert(!result.success, 'Cannot add a 6th player to a group');
  assertEqual(State.groups[0].length, 5, 'Group must stay at 5');
});

describe('RosterEdit: removing a player moves them to the bench', () => {
  resetState();
  State.groups = [[ mkPlayer('Sitting','HUNTER','Survival','ranged_dps'),
                    mkPlayer('Staying','MAGE','Fire','caster_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();

  const result = RosterEdit.BenchPlayer('u1');
  assert(result.success, 'Bench should succeed');
  assertEqual(State.groups[0].length, 1, 'Player should leave the group');
  assertEqual(State.bench.length, 1, 'Player should land on the bench');
  assertEqual(State.bench[0].name, 'Sitting', 'Correct player benched');
  assertEqual(State.bench[0].groupNumber, 0, 'Benched player has groupNumber 0');
  assertEqual(State.roster.length, 1, 'Roster tracks only assigned players');
});

describe('RosterEdit: a benched player can be brought back into a group', () => {
  resetState();
  State.groups = [[], []];
  State.bench = [ mkPlayer('Backup','DRUID','Balance','caster_dps') ];
  State.bench[0].uid = 'b1';
  State.bench[0].groupNumber = 0;

  const result = RosterEdit.UnbenchPlayer('b1', 1);
  assert(result.success, 'Unbench should succeed');
  assertEqual(State.bench.length, 0, 'Bench should be empty again');
  assertEqual(State.groups[1].length, 1, 'Player should be in group 2');
  assertEqual(State.groups[1][0].groupNumber, 2, 'groupNumber should be updated');
  assertEqual(State.roster.length, 1, 'Roster should include the returning player');
});

describe('RosterEdit: unbenching into a full group is refused', () => {
  resetState();
  State.groups = [[
    mkPlayer('A','MAGE','Fire','caster_dps'), mkPlayer('B','MAGE','Fire','caster_dps'),
    mkPlayer('C','MAGE','Fire','caster_dps'), mkPlayer('D','MAGE','Fire','caster_dps'),
    mkPlayer('E','MAGE','Fire','caster_dps'),
  ]];
  State.bench = [ mkPlayer('Backup','DRUID','Balance','caster_dps') ];
  State.bench[0].uid = 'b1';

  const result = RosterEdit.UnbenchPlayer('b1', 0);
  assert(!result.success, 'Cannot unbench into a full group');
  assertEqual(State.bench.length, 1, 'Player should stay benched');
});

describe('RosterEdit: deleting a benched player removes them for good', () => {
  resetState();
  State.groups = [[]];
  State.bench = [ mkPlayer('Gone','WARLOCK','Affliction','caster_dps') ];
  State.bench[0].uid = 'b1';

  const result = RosterEdit.DeletePlayer('b1');
  assert(result.success, 'Delete should succeed');
  assertEqual(State.bench.length, 0, 'Player should be gone from the bench');
  assertEqual(State.roster.length, 0, 'Player should not reappear in the roster');
});

describe('RosterEdit: editing an unknown uid fails cleanly', () => {
  resetState();
  State.groups = [[ mkPlayer('Only','MAGE','Fire','caster_dps') ]];
  State.groups[0][0].uid = 'u1';
  RosterEdit.syncRoster();

  assert(!RosterEdit.UpdatePlayer('nope', { spec:'Frost' }).success, 'Unknown uid update should fail');
  assert(!RosterEdit.BenchPlayer('nope').success, 'Unknown uid bench should fail');
  assert(!RosterEdit.DeletePlayer('nope').success, 'Unknown uid delete should fail');
  assertEqual(State.groups[0].length, 1, 'Group should be untouched');
});

// ── Spec helpers ──

describe('RosterEdit: spec list is complete and role lookup matches Config', () => {
  for (const cls of RosterEdit.ClassList) {
    const specs = RosterEdit.SpecsForClass(cls);
    assertEqual(specs.length, 3, cls + ' should offer 3 specs');
    for (const sp of specs) {
      assertEqual(RosterEdit.RoleForSpec(cls, sp.name), sp.role,
        cls + '/' + sp.name + ' role lookup should match the spec list');
    }
  }
  assertEqual(RosterEdit.RoleForSpec('WARRIOR', 'Nonsense'), null, 'Unknown spec returns null');
  assertEqual(RosterEdit.SpecsForClass('NOTACLASS').length, 0, 'Unknown class returns no specs');
});

// ── Persistence ──

describe('Export/Load: the bench round-trips', () => {
  resetState();
  State.groups = [[ mkPlayer('Main','MAGE','Fire','caster_dps') ]];
  State.bench = [ mkPlayer('Sub','PRIEST','Shadow','caster_dps') ];
  State.bench[0].groupNumber = 0;
  RosterEdit.syncRoster();

  const data = Import.exportRoster('BenchTest');
  assertEqual(data.bench.length, 1, 'Export should carry the bench');

  resetState();
  Import.loadRoster(data);
  assertEqual(State.bench.length, 1, 'Load should restore the bench');
  assertEqual(State.bench[0].name, 'Sub', 'Benched player should survive the round-trip');
  assertEqual(State.bench[0].spec, 'Shadow', 'Benched player spec should survive');
  assertEqual(State.roster.length, 1, 'Assigned players should not absorb the bench');
});

describe('Load: a roster saved before the bench existed still loads', () => {
  resetState();
  const legacy = { name:'Legacy', raid:'bt', players:[
    { name:'Old', class:'MAGE', spec:'Fire', role:'caster_dps', groupNumber:1 },
  ]};
  assert(Import.loadRoster(legacy), 'Legacy roster should load');
  assertEqual(State.bench.length, 0, 'Missing bench field should become an empty bench');
  assertEqual(State.roster.length, 1, 'Legacy players should still load');
});

// ════════════════════════════════════════════════════════════════
// SHARE LINKS (v2 string + base64url payload)
// ════════════════════════════════════════════════════════════════

describe('Share: a full layout round-trips through the v2 string', () => {
  resetState();
  State.selectedRaid = 'gruul';
  State.rosterName = 'Tuesday Gruul';
  State.groups = [
    [ mkPlayer('Tankadin','PALADIN','Protection','tank'), mkPlayer('Shammy','SHAMAN','Enhancement','melee_dps') ],
    [ mkPlayer('Boomy','DRUID','Balance','caster_dps') ],
  ];
  State.bench = [ mkPlayer('Benchy','PRIEST','Shadow','caster_dps') ];
  State.bench[0].groupNumber = 0;
  RosterEdit.syncRoster();

  const str = Import.exportShareString();
  assert(str.startsWith('PP:2:'), 'Share string should carry the v2 header');

  resetState();
  const res = Import.importAddonString(str);
  assert(res.success, 'v2 share string should import: ' + (res.error || ''));
  assertEqual(State.rosterName, 'Tuesday Gruul', 'Roster name should survive the round-trip');
  assertEqual(State.selectedRaid, 'gruul', 'Raid selection should survive the round-trip');
  assertEqual(State.groups[0].length, 2, 'Group 1 should keep both players');
  assertEqual(State.groups[0][0].name, 'Tankadin', 'Player order within a group should hold');
  assertEqual(State.groups[0][0].spec, 'Protection', 'Player spec should survive');
  assertEqual(State.groups[0][0].role, 'tank', 'Player role should survive');
  assertEqual(State.groups[1][0].name, 'Boomy', 'Group 2 assignment should hold');
  assertEqual(State.bench.length, 1, 'Bench should survive the round-trip');
  assertEqual(State.bench[0].name, 'Benchy', 'Benched player should survive');
  assertEqual(State.bench[0].groupNumber, 0, 'Benched player should stay unassigned');
});

describe('Share: an empty bench round-trips as an empty bench', () => {
  resetState();
  State.groups = [[ mkPlayer('Solo','MAGE','Fire','caster_dps') ]];
  RosterEdit.syncRoster();
  const str = Import.exportShareString();

  resetState();
  assert(Import.importAddonString(str).success, 'String with no bench should import');
  assertEqual(State.bench.length, 0, 'Bench should come back empty');
  assertEqual(State.roster.length, 1, 'The assigned player should still load');
});

describe('Share: roster names with delimiters survive', () => {
  resetState();
  State.rosterName = 'Kara: Wed, 8pm';
  State.groups = [[ mkPlayer('Solo','MAGE','Fire','caster_dps') ]];
  RosterEdit.syncRoster();
  const str = Import.exportShareString();

  resetState();
  assert(Import.importAddonString(str).success, 'Name with colons/commas should import');
  assertEqual(State.rosterName, 'Kara: Wed, 8pm', 'Delimiters in the name should not corrupt the payload');
});

describe('Share: the payload is URL-safe and reversible', () => {
  resetState();
  State.rosterName = 'Kara: Wed, 8pm';
  State.groups = [[ mkPlayer('Solo','MAGE','Fire','caster_dps') ]];
  RosterEdit.syncRoster();

  const str = Import.exportShareString();
  const code = Import.encodeSharePayload(str);
  assert(!/[+/=]/.test(code), 'Payload should contain no +, / or = characters');
  assert(/^[A-Za-z0-9_-]+$/.test(code), 'Payload should be base64url alphabet only');
  assertEqual(Import.decodeSharePayload(code), str, 'Payload should decode back to the exact string');
});

describe('Share: corrupt payloads fail without touching the planner', () => {
  resetState();
  State.groups = [[ mkPlayer('Keepme','MAGE','Fire','caster_dps') ]];
  RosterEdit.syncRoster();

  assertEqual(Import.decodeSharePayload('!!!not base64!!!'), null, 'Garbage payload should decode to null');
  assertEqual(Import.decodeSharePayload(''), null, 'Empty payload should decode to null');

  const bad = Import.importAddonString('PP:2:bt');
  assert(!bad.success, 'A truncated v2 string should be rejected');
  const alien = Import.importAddonString('NOTPP:2:bt:x::');
  assert(!alien.success, 'A foreign string should be rejected');
  const future = Import.importAddonString('PP:99:bt:x::');
  assert(!future.success, 'An unknown version should be rejected');

  assertEqual(State.roster.length, 1, 'A rejected import should leave the roster alone');
  assertEqual(State.roster[0].name, 'Keepme', 'A rejected import should leave players alone');
});

describe('Share: an unnamed roster arrives as "Shared Roster"', () => {
  resetState();
  State.rosterName = NO_ROSTER_NAME; // hand-built on a cleared planner, never saved
  State.groups = [[ mkPlayer('Handmade','MAGE','Fire','caster_dps') ]];
  RosterEdit.syncRoster();

  const str = Import.exportShareString();
  assertEqual(Import.previewShareString(str).name, 'Shared Roster',
    'The empty-planner sentinel should not travel as the roster name');

  resetState();
  assert(Import.importAddonString(str).success, 'Unnamed share string should import');
  assertEqual(State.rosterName, 'Shared Roster', 'Recipient should see a real name in the header');
  assertEqual(State.roster.length, 1, 'The hand-built player should still load');
});

describe('Share: a real roster name is still carried verbatim', () => {
  resetState();
  State.rosterName = 'Tuesday BT';
  State.groups = [[ mkPlayer('Named','MAGE','Fire','caster_dps') ]];
  RosterEdit.syncRoster();
  const str = Import.exportShareString();

  resetState();
  Import.importAddonString(str);
  assertEqual(State.rosterName, 'Tuesday BT', 'A named roster must not be renamed');
});

describe('Share: a link can be previewed without touching the planner', () => {
  resetState();
  State.rosterName = 'Someone Elses Raid';
  State.groups = [[ mkPlayer('Theirs','MAGE','Fire','caster_dps') ]];
  RosterEdit.syncRoster();
  const str = Import.exportShareString();

  resetState();
  State.groups = [[ mkPlayer('Mine','WARRIOR','Fury','melee_dps') ]];
  RosterEdit.syncRoster();

  const preview = Import.previewShareString(str);
  assert(preview.success, 'Preview should succeed on a valid string');
  assertEqual(preview.name, 'Someone Elses Raid', 'Preview should report the shared roster name');
  assertEqual(preview.playerCount, 1, 'Preview should report the player count');
  assertEqual(State.roster[0].name, 'Mine', 'Preview must not replace the current layout');

  const badPreview = Import.previewShareString('PP:2:bt');
  assert(!badPreview.success, 'Preview should reject a truncated string');
  assertEqual(State.roster[0].name, 'Mine', 'A rejected preview must not touch the layout');
});

describe('Share: v1 addon strings still import', () => {
  resetState();
  const v1 = 'PP:1:bt:Legacy.WR.Prot.T';

  resetState();
  const res = Import.importAddonString(v1);
  assert(res.success, 'v1 strings must keep working: ' + (res.error || ''));
  assertEqual(State.roster[0].name, 'Legacy', 'v1 player should load');
  assert(!Import.exportAddonString, 'the site no longer exports addon strings (the addon was dropped)');
});

// ── REAL ROSTER ACCEPTANCE (2026-09-02) ─────────────────────────
// The user's live Raid-Helper roster (22 raiders). Target layout agreed with the
// user, derived from the Ideal Comp tab: Ferals ride in melee groups even when
// tanking, only the Prot Paladin sits with the healers, BM hunters sit with
// melee, and the second Resto Shaman is a raid-leader coin flip between the
// WF-less melee group (G2) and the Arcane mage group (G4).
function buildRealRoster22() {
  return [
    mkPlayer('Liquidium','WARRIOR','Arms','melee_dps'),
    mkPlayer('Cordliss','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Yesireadit','PALADIN','Retribution','melee_dps'),
    mkPlayer('Kajuk','WARRIOR','Arms','melee_dps'),
    mkPlayer('Hinastorm','ROGUE','Combat','melee_dps'),
    mkPlayer('Sanga','WARRIOR','Fury','melee_dps'),
    mkPlayer('Aimers','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('Roost','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Zzaps','DRUID','Balance','caster_dps'),
    mkPlayer('Daxxter','MAGE','Arcane','caster_dps'),
    mkPlayer('Soulavenger','WARLOCK','Affliction','caster_dps'),
    mkPlayer('Daolith','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Gnope','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Terani','MAGE','Arcane','caster_dps'),
    mkPlayer('Originalgoat','SHAMAN','Restoration','healer'),
    mkPlayer('Drenna','PALADIN','Holy','healer'),
    mkPlayer('Stingz','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('Bearnnaked','DRUID','Feral','tank'),
    mkPlayer('Starck','PALADIN','Protection','tank'),
    mkPlayer('kimmjungheal','DRUID','Restoration','healer'),
    mkPlayer('Voctave','SHAMAN','Restoration','healer'),
    mkPlayer('Azukl','PRIEST','Holy','healer'),
  ];
}

function layoutKey() {
  return State.groups.map(g => g.map(p => p.name).sort().join(',')).join(' | ');
}

function groupOf(name) {
  return State.groups.findIndex(g => g.some(p => p.name === name));
}

function shuffled(arr, seedStart) {
  let seed = seedStart;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('ACCEPTANCE: real 22-man roster follows the reference comp rules (max_dps)', () => {
  State.optimizerMode = 'max_dps';
  loadRosterAndOptimize(buildRealRoster22(), 'bt');

  const g = name => groupOf(name);
  const grp = name => State.groups[g(name)];
  const sameGroup = (a, b, msg) => assert(g(a) >= 0 && g(a) === g(b), msg + ' (' + a + ' in G' + (g(a)+1) + ', ' + b + ' in G' + (g(b)+1) + ')');
  const differentGroup = (a, b, msg) => assert(g(a) >= 0 && g(b) >= 0 && g(a) !== g(b), msg + ' (both in G' + (g(a)+1) + ')');
  const isPhysical = grp0 => grp0.filter(p => p.role === 'melee_dps' || p.role === 'tank').length >= 2
                           && !grp0.some(p => p.role === 'caster_dps' || p.role === 'healer' && p.class !== 'SHAMAN');

  // Melee: Enh Shaman anchors the WF group with its best recipients
  sameGroup('Yesireadit', 'Cordliss', 'Ret Pal with Enh Shaman (best WF recipient)');
  sameGroup('Sanga', 'Cordliss', 'Fury with Enh Shaman');
  assert(!grp('Cordliss').some(p => p.role === 'caster_dps' || p.role === 'healer'), 'Enh melee group holds only physical DPS');
  assertEqual(grp('Cordliss').length, 5, 'Enh melee group is full');

  // Feral tank rides in a physical group, never with the healers
  assert(isPhysical(grp('Bearnnaked')), 'Feral tank rides in a physical group (was G' + (g('Bearnnaked')+1) + ')');
  differentGroup('Bearnnaked', 'Starck', 'Feral tank is NOT in the healer/tank group');

  // Hunters ride with physical DPS, never with the mages
  assert(isPhysical(grp('Aimers')), 'BM hunter Aimers rides in a physical group (was G' + (g('Aimers')+1) + ')');
  assert(isPhysical(grp('Stingz')), 'BM hunter Stingz rides in a physical group (was G' + (g('Stingz')+1) + ')');
  assert(!grp('Terani').some(p => p.class === 'HUNTER'), 'No hunter parked with the mages');

  // Both melee groups are populated (no 2-man group next to full ones)
  const meleeGroups = State.groups.filter(isPhysical);
  assertEqual(meleeGroups.length, 2, 'Exactly two physical groups');
  for (const mg of meleeGroups) assert(mg.length >= 4, 'Physical group has at least 4 members (had ' + mg.length + ')');

  // Casters: Ele + Boomkin + Destro x2 + Aff (reference comp G4)
  sameGroup('Zzaps', 'Roost', 'Boomkin with Ele Shaman');
  sameGroup('Daolith', 'Roost', 'Destro lock with Ele Shaman');
  sameGroup('Gnope', 'Roost', 'Second Destro lock with Ele Shaman');
  // 2026-10-01: the MT group may hold 4 healers, so this 22-man has three
  // empty seats on the caster side; the Ele group's fifth seat is either the
  // Aff lock or a suggested Open slot.
  const seatsWithOpens = gi => State.groups[gi].length + State.preferredSlots.filter(s => s.group === gi).length;
  assertEqual(seatsWithOpens(g('Roost')), 5, 'Ele caster group is full, counting suggested Opens');

  // Mages: together, with one healer (reference comp G3)
  sameGroup('Daxxter', 'Terani', 'Both Arcane mages together');
  assert(grp('Terani').some(p => p.role === 'healer'), 'A healer rides with the Arcane mages');

  // Open slots are seated exactly as real players of their specs would be.
  const asReal = State.preferredSlots.map(s => mkPlayer('', s.class, s.spec, PP.RosterEdit.RoleForSpec(s.class, s.spec)));
  const planned = Optimizer.plan(buildRealRoster22().concat(asReal), {
    gameVersion: 'tbc', numGroups: 5, raidSize: 25, mode: 'max_dps',
  }).groups;
  const shape = gs => gs.map(gr => gr.map(p => p.name || p.spec).sort().join(',')).join(' | ');
  const withOpens = State.groups.map((gr, gi) => gr.concat(State.preferredSlots.filter(s => s.group === gi).map(s => ({ spec: s.spec }))));
  assertEqual(shape(withOpens), shape(planned), 'The board with its Opens is the plan() for 25 real players of those specs');

  // Tank group: Prot Pal + exactly three healers, no DPS
  const tankGroup = grp('Starck');
  const tankHealers = tankGroup.filter(p => p.role === 'healer').length;
  assert(tankHealers >= 3 && tankHealers <= 4, 'Three or four healers ride with the Prot Paladin (had ' + tankHealers + ')');
  assert(tankGroup.some(p => p.class === 'SHAMAN' && p.spec === 'Restoration'), 'One Resto Shaman rides with the tank group');
  sameGroup('kimmjungheal', 'Starck', 'Resto Druid with the Prot Paladin');
  // 2026-10-09: with the three suggested Opens seated as members the raid is
  // full, both caster groups are full, and the second Holy healer rides with
  // the mages, so the tank group's fifth seat goes to the Affliction lock,
  // exactly as plan() seats 25 real players of these specs (asserted above).
  // No physical DPS and at most that one caster.
  assert(!tankGroup.some(p => p.role === 'melee_dps' || p.role === 'ranged_dps'), 'No physical DPS parked in the healer/tank group');
  assert(tankGroup.filter(p => p.role === 'caster_dps').length <= 1, 'At most one caster rides with the tank group');

  // Second Resto Shaman: raid-leader coin flip between the WF-less melee group and the mage group
  const otherRsham = tankGroup.some(p => p.name === 'Originalgoat') ? 'Voctave' : 'Originalgoat';
  const wfLessMelee = meleeGroups.find(mg => !mg.some(p => p.class === 'SHAMAN' && p.spec === 'Enhancement'));
  assert(grp(otherRsham) === wfLessMelee || g(otherRsham) === g('Terani'),
    'Second Resto Shaman in the WF-less melee group or the mage group (was G' + (g(otherRsham)+1) + ')');
});

// Team KJ Hyjal sign-ups (2026-10-01 report), Alliesha switched to Ret by hand.
// Reported: two shamans stacked, an Ele Shaman in a melee group, both Rets in
// one group, Zzaps moved to the mage group, Kajuk parked with the warlocks.
function buildHyjalRoster22() {
  return [
    mkPlayer('Daolith','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Stingz','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('Zzaps','DRUID','Balance','caster_dps'),
    mkPlayer('Genow','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Roost','MAGE','Arcane','caster_dps'),
    mkPlayer('Soulavenger','WARLOCK','Affliction','caster_dps'),
    mkPlayer('Voctave','SHAMAN','Restoration','healer'),
    mkPlayer('Hinastorm','ROGUE','Combat','melee_dps'),
    mkPlayer('kimmjungheal','DRUID','Restoration','healer'),
    mkPlayer('Sanga','WARRIOR','Fury','melee_dps'),
    mkPlayer('KashPatail','PRIEST','Shadow','caster_dps'),
    mkPlayer('Rhyme','WARRIOR','Arms','melee_dps'),
    mkPlayer('Ohmnath','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Throssel','PALADIN','Protection','tank'),
    mkPlayer('Daxxter','MAGE','Arcane','caster_dps'),
    mkPlayer('Kajuk','WARRIOR','Protection','tank'),
    mkPlayer('Alliesha','PALADIN','Retribution','melee_dps'),
    mkPlayer('Ceedarius','PALADIN','Retribution','melee_dps'),
    mkPlayer('Azukl','PRIEST','Holy','healer'),
    mkPlayer('Drenna','PALADIN','Holy','healer'),
    mkPlayer('Gnope','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Originalgoat','SHAMAN','Enhancement','melee_dps'),
  ];
}

for (const mode of ['max_dps', 'tank_mit', 'balanced', 'relaxed']) {
  describe('ACCEPTANCE: Hyjal 22-man report has no awkward placements (' + mode + ')', () => {
    State.optimizerMode = mode;
    loadRosterAndOptimize(buildHyjalRoster22(), 'hyjal');
    const g = name => State.groups.findIndex(gr => gr.some(p => p.name === name));
    const grp = name => State.groups[g(name)];
    const physical = gr => gr.filter(p => (p.role === 'melee_dps' && p.class !== 'SHAMAN') || p.role === 'ranged_dps').length;
    const casters = gr => gr.filter(p => p.role === 'caster_dps').length;

    for (const gr of State.groups) {
      assert(gr.filter(p => p.class === 'SHAMAN').length <= 1,
        'No group holds two shamans (' + gr.map(p => p.name).join(', ') + ')');
    }
    for (const ele of ['Genow', 'Ohmnath']) {
      assert(casters(grp(ele)) > physical(grp(ele)), ele + ' (Ele) rides with casters, not melee');
    }
    assert(g('Alliesha') !== g('Ceedarius'), 'The two Ret Paladins are split across groups');
    assert(g('Zzaps') === g('Daolith') && g('Zzaps') === g('Gnope'), 'Zzaps (Boomkin) rides with both Destro locks');
    assert(!grp('Kajuk').some(p => p.class === 'WARLOCK' || p.class === 'MAGE'), 'Kajuk (Prot Warrior) is not parked with the casters');
  });
}

// The board behind the report: an Open request for a Resto Druid froze G3
// (the three tanks), and Optimize used to lay the other four groups out as a
// 4-group raid, collapsing a caster group into a "melee" one. 2026-10-09: the
// request no longer freezes its group; it is seated like a player.
for (const mode of ['max_dps', 'balanced']) {
  describe('ACCEPTANCE: Optimize around an Open request keeps 5-group roles (' + mode + ')', () => {
    resetState();
    State.selectedRaid = 'hyjal';
    State.optimizerMode = mode;
    const byName = Object.fromEntries(buildHyjalRoster22().map(p => [p.name, p]));
    const kanyan = mkPlayer('Kanyan','DRUID','Feral','tank');
    const layout = [
      ['Originalgoat','Sanga','Ceedarius','Hinastorm','Rhyme'],
      ['Ohmnath','Stingz','Zzaps','Daolith','Gnope'],
      ['Throssel','Kajuk'],
      ['Genow','KashPatail','Soulavenger','Daxxter','Roost'],
      ['Alliesha','Voctave','kimmjungheal','Azukl','Drenna'],
    ];
    State.groups = layout.map(names => names.map(n => byName[n]));
    State.groups[2].push(kanyan);
    State.groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
    State.roster = State.groups.flat();
    State.preferredSlots = [{ group: 2, class: 'DRUID', spec: 'Restoration' }];
    Optimizer.optimize();

    const g = name => State.groups.findIndex(gr => gr.some(p => p.name === name));
    const manual = PP.PreferredSlots.manual();
    assertEqual(manual.map(s => s.class + ':' + s.spec).join(','), 'DRUID:Restoration', 'The request survives Optimize and stays the leader\'s own');
    assert(g('Kanyan') !== g('Throssel') || g('Kajuk') !== g('Throssel'), 'The requested group is re-arranged, not kept as the three tanks');
    assert(State.groups.every((gr, gi) => gr.length + PP.PreferredSlots.forGroup(gi).length <= 5), 'No group over 5, counting Opens');
    for (const gr of State.groups) assert(gr.filter(p => p.class === 'SHAMAN').length <= 1, 'No group holds two shamans');
    for (const ele of ['Genow', 'Ohmnath']) {
      const gr = State.groups[g(ele)];
      const otherCasters = gr.filter(p => p.role === 'caster_dps' && p.class !== 'SHAMAN').length;
      const physical = gr.filter(p => p.role === 'melee_dps' || p.role === 'ranged_dps').length;
      assert(otherCasters > physical, ele + ' (Ele) rides with casters, not melee');
    }
    assert(g('Alliesha') !== g('Ceedarius'), 'Ret Paladins split');
    assert(g('Zzaps') === g('Daolith') && g('Zzaps') === g('Gnope'), 'Zzaps with both Destro locks');
    const first = State.groups.map(gr => gr.map(p => p.name).sort().join(',')).join(' | ');
    Optimizer.optimize();
    assertEqual(State.groups.map(gr => gr.map(p => p.name).sort().join(',')).join(' | '), first, 'A second Optimize moves nobody');
  });
}

// Same event loaded fresh (2026-10-01, Alliesha back to Prot): 3 empty seats.
// Suggestions used to be Resto Shaman + Enh Shaman + Ret, all crammed into
// the one group with room, because only party buffs were scored.
for (const mode of ['max_dps', 'tank_mit', 'balanced', 'relaxed']) {
  describe('OpenSlots: Hyjal 22-man suggests what the raid lacks (' + mode + ')', () => {
    State.optimizerMode = mode;
    const roster = buildHyjalRoster22().map(p => p.name === 'Alliesha' ? mkPlayer('Alliesha','PALADIN','Protection','tank') : p);
    loadRosterAndOptimize(roster, 'hyjal');
    const slots = State.preferredSlots.filter(s => s.auto);
    const has = (cls, spec) => slots.some(s => s.class === cls && s.spec === spec);
    assertEqual(slots.length, 3, 'one suggestion per empty seat');
    assert(has('PRIEST', 'Discipline'), 'Disc Priest suggested (Power Infusion + Misery missing)');
    assert(has('HUNTER', 'Survival'), 'Survival Hunter suggested (Expose Weakness missing)');
    assert(!has('SHAMAN', 'Restoration'), 'no Resto Shaman suggested on a 4-shaman raid');
    assert(!has('PALADIN', 'Retribution'), 'no second Ret');
    for (const s of slots) {
      const gr = State.groups[s.group];
      const role = PP.RosterEdit.RoleForSpec(s.class, s.spec);
      const physical = gr.filter(p => p.role === 'melee_dps' || p.role === 'ranged_dps').length;
      const casters = gr.filter(p => p.role === 'caster_dps').length;
      if (role === 'ranged_dps' || role === 'melee_dps') assert(physical >= casters, s.spec + ' ' + s.class + ' suggested into a physical group (G' + (s.group + 1) + ')');
    }
    const mt = State.groups.find(gr => gr.some(p => p.name === 'Alliesha'));
    assert(mt.some(p => p.name === 'Voctave'), 'Resto Shaman rides with the MT');
    if (mode !== 'relaxed') {
      // Vampiric Touch: the CoH-spamming Holy Priest needs the mana, a warlock barely does.
      const sp = State.groups.find(gr => gr.some(p => p.name === 'KashPatail'));
      assert(sp.some(p => p.name === 'Azukl'), 'Holy Priest rides with the Shadow Priest');
      assert(!sp.some(p => p.name === 'Soulavenger'), 'Aff lock is not the one taking the Vampiric Touch seat');
    }
    const key = () => State.groups.map(gr => gr.map(p => p.name).sort().join(',')).join('|') + '#' +
      State.preferredSlots.map(s => s.group + s.class + s.spec).sort().join(',');
    const first = key();
    Optimizer.optimize();
    assertEqual(key(), first, 'a second Optimize gives the same board and suggestions');
  });
}

describe('Optimizer: one Resto Shaman provides both Mana Spring and Mana Tide', () => {
  resetState();
  const group = [mkPlayer('R','SHAMAN','Restoration','healer'), mkPlayer('M','MAGE','Arcane','caster_dps')];
  const chosen = Optimizer.resolveGroupBuffs(group, () => 1);
  assert(chosen.has('MANA_SPRING') && chosen.has('MANA_TIDE'), 'Mana Tide does not occupy the Mana Spring water slot');
});

describe('Optimizer: group identities follow the roster DPS mix (TBC)', () => {
  resetState();
  assertEqual(Optimizer.roleIdentitiesFor(5).join(','), 'melee_dps,melee_dps,caster_dps,caster_dps,tank', 'Default split without a roster');
  const casterHeavy = [
    mkPlayer('a','ROGUE','Combat','melee_dps'), mkPlayer('b','HUNTER','Beast Mastery','ranged_dps'), mkPlayer('c','SHAMAN','Enhancement','melee_dps'),
    ...['d','e','f','g','h','i','j','k','l','m','n','o'].map(n => mkPlayer(n,'WARLOCK','Destruction','caster_dps')),
  ];
  assertEqual(Optimizer.roleIdentitiesFor(5, casterHeavy).join(','), 'melee_dps,caster_dps,caster_dps,caster_dps,tank', '3 physical vs 12 casters: one melee group');
});

describe('Optimizer: de-isolation picks the cheapest fix, not the first healer it finds', () => {
  resetState();
  State.selectedRaid = 'hyjal';
  const groups = [
    [mkPlayer('enh','SHAMAN','Enhancement','melee_dps'), mkPlayer('fury','WARRIOR','Fury','melee_dps'), mkPlayer('ret','PALADIN','Retribution','melee_dps'), mkPlayer('rog','ROGUE','Combat','melee_dps'), mkPlayer('bm','HUNTER','Beast Mastery','ranged_dps')],
    [mkPlayer('arms','WARRIOR','Arms','melee_dps'), mkPlayer('rog2','ROGUE','Combat','melee_dps'), mkPlayer('sv','HUNTER','Survival','ranged_dps')],
    [mkPlayer('rsham','SHAMAN','Restoration','healer'), mkPlayer('arc','MAGE','Arcane','caster_dps'), mkPlayer('aff','WARLOCK','Affliction','caster_dps'), mkPlayer('fire1','MAGE','Fire','caster_dps'), mkPlayer('hpal','PALADIN','Holy','healer')],
    [mkPlayer('fire2','MAGE','Fire','caster_dps')],
    [mkPlayer('tank','PALADIN','Protection','tank'), mkPlayer('rdru','DRUID','Restoration','healer'), mkPlayer('hpri','PRIEST','Holy','healer')],
  ];
  groups._roleIdentities = ['melee_dps','melee_dps','caster_dps','caster_dps','tank'];
  groups._anchors = new Set([groups[4][0]]);
  const total = () => groups.reduce((s, gr, gi) => s + Optimizer.groupScore(gr, gi, groups, 'max_dps'), 0);
  const before = total();
  Optimizer.deIsolate(groups, 'max_dps', 5);
  const where = n => groups.findIndex(gr => gr.some(p => p.name === n));
  assertEqual(where('rsham'), 2, 'The caster group keeps its Resto Shaman');
  assert(groups[where('fire2')].filter(p => p.role === 'caster_dps').length >= 2, 'The lone Fire mage now has a caster peer');
  assert(total() >= before - 5, 'De-isolation did not wreck the board score (' + before.toFixed(1) + ' -> ' + total().toFixed(1) + ')');
});

describe('ACCEPTANCE: optimize is idempotent (second click moves nobody)', () => {
  State.optimizerMode = 'max_dps';
  loadRosterAndOptimize(buildRealRoster22(), 'bt');
  const first = layoutKey();
  const before = {}; for (const p of State.roster) before[p.name] = p.groupNumber;
  Optimizer.optimize();
  assertEqual(layoutKey(), first, 'Second optimize produces the same layout');
  const moved = State.roster.filter(p => before[p.name] !== p.groupNumber).length;
  assertEqual(moved, 0, 'Second optimize moves zero players');
});

describe('ACCEPTANCE: layout does not depend on the starting arrangement', () => {
  State.optimizerMode = 'max_dps';
  const base = buildRealRoster22();
  loadRosterAndOptimize(base, 'bt');
  const reference = layoutKey();
  for (let t = 1; t <= 20; t++) {
    resetState();
    State.selectedRaid = 'bt';
    const pool = shuffled(base.map(p => ({...p})), 1000 + t * 7919);
    State.roster = pool;
    State.groups = [[], [], [], [], []];
    pool.forEach((p, i) => { State.groups[i % 5].push(p); p.groupNumber = (i % 5) + 1; });
    Optimizer.optimize();
    assertEqual(layoutKey(), reference, 'Shuffle #' + t + ' lands on the same layout');
  }
});

// ── SANCTITY AURA (2026-09-02) ──────────────────────────────────
describe('Buffs: Retribution paladin provides Sanctity Aura, Holy paladin cannot', () => {
  resetState();
  const melee = [
    mkPlayer('Ret','PALADIN','Retribution','melee_dps'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
    mkPlayer('Fury','WARRIOR','Fury','melee_dps'),
  ];
  const ids = getGroupBuffs(melee).map(b => b.id);
  assertIncludes(ids, 'SANCTITY_AURA', 'Ret paladin in a melee group runs Sanctity Aura');

  const holyGroup = [
    mkPlayer('Holy','PALADIN','Holy','healer'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
  ];
  const holyIds = getGroupBuffs(holyGroup).map(b => b.id);
  assert(!holyIds.includes('SANCTITY_AURA'), 'Holy paladin never provides Sanctity Aura');

  const twoPals = [
    mkPlayer('Ret','PALADIN','Retribution','melee_dps'),
    mkPlayer('Prot','PALADIN','Protection','tank'),
    mkPlayer('Rogue','ROGUE','Combat','melee_dps'),
  ];
  const twoIds = getGroupBuffs(twoPals).map(b => b.id);
  assertIncludes(twoIds, 'SANCTITY_AURA', 'Ret + Prot: Sanctity present');
  assertIncludes(twoIds, 'DEVOTION_AURA', 'Ret + Prot: Devotion present');

  const twoRets = [
    mkPlayer('Ret1','PALADIN','Retribution','melee_dps'),
    mkPlayer('Ret2','PALADIN','Retribution','melee_dps'),
  ];
  const retIds = getGroupBuffs(twoRets).map(b => b.id);
  assertEqual(retIds.filter(id => id === 'SANCTITY_AURA').length, 1, 'Two Ret paladins: Sanctity only once');
});

describe('Optimizer: Sanctity Aura is counted in group scoring', () => {
  resetState();
  const groups = [[mkPlayer('Ret','PALADIN','Retribution','melee_dps'), mkPlayer('Rogue','ROGUE','Combat','melee_dps')], [], [], [], []];
  groups._roleIdentities = ['melee_dps','melee_dps','caster_dps','caster_dps','tank'];
  const chosen = Optimizer.resolveGroupBuffs(groups[0], id => (id === 'SANCTITY_AURA' ? 10 : 1));
  assert(chosen.has('SANCTITY_AURA'), 'resolveGroupBuffs lets a Ret paladin drop Sanctity');
  const holyGroups = [[mkPlayer('Holy','PALADIN','Holy','healer')], [], [], [], []];
  const holyChosen = Optimizer.resolveGroupBuffs(holyGroups[0], id => (id === 'SANCTITY_AURA' ? 10 : 1));
  assert(!holyChosen.has('SANCTITY_AURA'), 'resolveGroupBuffs never gives Sanctity to a Holy paladin');
});

// ── SHARED 25-MAN ROSTER (2026-09-02) ───────────────────────────
// The user's second live roster (share link). Agreed target: three Arcane +
// Shadow Priest + a Holy Priest (Circle of Healing on Vampiric Touch mana);
// Ele Shaman with Boomkin + Destro x2 + Aff; lone Resto Shaman with the tank.
function buildSharedRoster25() {
  return [
    mkPlayer('Starck','PALADIN','Protection','tank'),
    mkPlayer('Voctave','SHAMAN','Restoration','healer'),
    mkPlayer('kimmjungheal','DRUID','Restoration','healer'),
    mkPlayer('Drenna','PALADIN','Holy','healer'),
    mkPlayer('Azukl','PRIEST','Holy','healer'),
    mkPlayer('Stingz','HUNTER','Beast Mastery','ranged_dps'),
    mkPlayer('Sanga','WARRIOR','Fury','melee_dps'),
    mkPlayer('Ceedarius','PALADIN','Retribution','melee_dps'),
    mkPlayer('Originalgoat','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Bearnnaked','DRUID','Feral','tank'),
    mkPlayer('Cordliss','SHAMAN','Enhancement','melee_dps'),
    mkPlayer('Hehebigbear','DRUID','Feral','tank'),
    mkPlayer('Apocalypse','WARRIOR','Arms','melee_dps'),
    mkPlayer('Aimers','HUNTER','Survival','ranged_dps'),
    mkPlayer('Hinastorm','ROGUE','Combat','melee_dps'),
    mkPlayer('Soulavenger','WARLOCK','Affliction','caster_dps'),
    mkPlayer('KashPatail','PRIEST','Shadow','caster_dps'),
    mkPlayer('RaawTotem','SHAMAN','Elemental','caster_dps'),
    mkPlayer('Daxxter','MAGE','Arcane','caster_dps'),
    mkPlayer('Roost','MAGE','Arcane','caster_dps'),
    mkPlayer('Terani','MAGE','Arcane','caster_dps'),
    mkPlayer('Zzaps','DRUID','Balance','caster_dps'),
    mkPlayer('Daolith','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Gnope','WARLOCK','Destruction','caster_dps'),
    mkPlayer('Healthas','PRIEST','Holy','healer'),
  ];
}

describe('ACCEPTANCE: shared 25-man roster follows the reference comp rules (max_dps)', () => {
  State.optimizerMode = 'max_dps';
  loadRosterAndOptimize(buildSharedRoster25(), 'bt');
  const g = name => groupOf(name);
  const grp = name => State.groups[g(name)];
  const sameGroup = (a, b, msg) => assert(g(a) >= 0 && g(a) === g(b), msg + ' (' + a + ' in G' + (g(a)+1) + ', ' + b + ' in G' + (g(b)+1) + ')');
  const differentGroup = (a, b, msg) => assert(g(a) >= 0 && g(b) >= 0 && g(a) !== g(b), msg + ' (both in G' + (g(a)+1) + ')');

  // Mage group: three Arcane + Shadow Priest + a Holy Priest
  sameGroup('Daxxter', 'Terani', 'Arcane mages together (1)');
  sameGroup('Roost', 'Terani', 'Arcane mages together (2)');
  sameGroup('KashPatail', 'Terani', 'Shadow Priest with the Arcane mages');
  assert(grp('Terani').some(p => p.class === 'PRIEST' && p.spec === 'Holy'), 'A Holy Priest rides with the Shadow Priest');

  // Lock group: Ele + Boomkin + Destro x2 + Aff
  sameGroup('Zzaps', 'RaawTotem', 'Boomkin with Ele Shaman');
  sameGroup('Daolith', 'RaawTotem', 'Destro lock with Ele Shaman');
  sameGroup('Gnope', 'RaawTotem', 'Second Destro lock with Ele Shaman');
  sameGroup('Soulavenger', 'RaawTotem', 'Aff lock with Ele Shaman');
  differentGroup('RaawTotem', 'Terani', 'Ele Shaman is not in the mage group');

  // Tank group: Prot Pal + lone Resto Shaman + Resto Druid + Holy Pal (+ 1 more healer)
  sameGroup('Voctave', 'Starck', 'Lone Resto Shaman rides with the Prot Paladin');
  sameGroup('kimmjungheal', 'Starck', 'Resto Druid with the Prot Paladin');
  sameGroup('Drenna', 'Starck', 'Holy Pal with the Prot Paladin');
  assert(!grp('Starck').some(p => p.role.endsWith('dps')), 'No DPS parked in the healer/tank group');

  // Both Feral tanks ride with melee; hunters ride with physical groups
  for (const n of ['Bearnnaked', 'Hehebigbear', 'Stingz', 'Aimers']) {
    assert(grp(n).filter(p => p.role === 'melee_dps').length >= 2, n + ' rides in a melee group (was G' + (g(n)+1) + ')');
  }
  differentGroup('Bearnnaked', 'Hehebigbear', 'One Feral per melee group');
  differentGroup('Originalgoat', 'Cordliss', 'One Enh Shaman per melee group');

  // Idempotent on this roster too
  const first = layoutKey();
  Optimizer.optimize();
  assertEqual(layoutKey(), first, 'Second optimize on the shared roster moves nobody');
});


// ════════════════════════════════════════════════════════════════
// OVERFLOW BENCHING: ROLE FLOORS + MARGINAL VALUE
// ════════════════════════════════════════════════════════════════
describe('Floors: 25-man requires 2 tanks and 5 healers, 10-man 2 and 3', () => {
  assertEqual(Optimizer.floorsFor(25).tank, 2, '25-man tank floor');
  assertEqual(Optimizer.floorsFor(25).healer, 5, '25-man healer floor');
  assertEqual(Optimizer.floorsFor(10).tank, 2, '10-man tank floor');
  assertEqual(Optimizer.floorsFor(10).healer, 3, '10-man healer floor');
});

describe('Overflow: healer floor is filled before any DPS when 31 sign up with exactly 5 healers', () => {
  resetState();
  State.selectedRaid = 'bt';
  const signUps = [];
  let id = 1;
  // 24 DPS first so sign-up order would have benched every healer.
  const dps = [['Mage','Fire'],['Warlock','Destruction'],['Rogue','Combat'],['Hunter','Beastmastery'],['Warrior','Fury'],['Priest','Shadow']];
  for (let i = 0; i < 24; i++) signUps.push({ name:'D' + i, className:dps[i % 6][0], specName:dps[i % 6][1], id:id++ });
  signUps.push({ name:'Tank1', className:'Tank', specName:'Protection1', id:id++ });
  signUps.push({ name:'Tank2', className:'Tank', specName:'Protection', id:id++ });
  for (let i = 0; i < 5; i++) signUps.push({ name:'Heal' + i, className:'Paladin', specName:'Holy1', id:id++ });
  const result = Import.importRaidHelper(JSON.stringify({ signUps }));
  assert(result.success, 'Import succeeds');
  assertEqual(State.roster.length, 25, '25 seated');
  assertEqual(State.bench.length, 6, '6 benched');
  assertEqual(State.roster.filter(p => p.role === 'tank').length, 2, 'Both tanks seated');
  assertEqual(State.roster.filter(p => p.role === 'healer').length, 5, 'All 5 healers seated (floor)');
  assert(State.bench.every(p => p.role !== 'healer' && p.role !== 'tank'), 'Only DPS are benched');
  assertEqual(result.overflowCount, 6, 'overflowCount reports the six benched for capacity');
});

describe('Overflow: benching is by marginal value, not sign-up order', () => {
  resetState();
  State.selectedRaid = 'bt';
  const roster = buildStandard25ManRoster();
  // A Retribution Paladin (Sanctity Aura for a whole group) signs up LAST.
  // It must not be benched just for being last.
  roster.push(mkPlayer('LateRet','PALADIN','Retribution','melee_dps'));
  roster.forEach((p, i) => { p.uid = 'v' + i; });
  State.groups = [[], [], [], [], []];
  roster.forEach((p, i) => State.groups[i % 5].push(p));
  Optimizer.optimize();
  assertEqual(State.roster.length, 25, '25 seated');
  assertEqual(State.bench.length, 1, '1 benched');
  assert(State.bench[0].name !== 'LateRet', 'The late Retribution Paladin is seated on merit');
  assert(State.roster.filter(p => p.role === 'healer').length >= 6, 'Healer floor holds');
});

describe('Overflow: Tentative sign-ups never auto-fill even when they would beat a primary', () => {
  resetState();
  State.selectedRaid = 'bt';
  const signUps = [];
  let id = 1;
  for (let i = 0; i < 26; i++) signUps.push({ name:'M' + i, className:'Mage', specName:'Arcane', id:id++ });
  signUps.push({ name:'TentShaman', className:'Tentative', specName:'Enhancement', id:id++ });
  const result = Import.importRaidHelper(JSON.stringify({ signUps }));
  assert(result.success, 'Import succeeds');
  assertEqual(State.roster.length, 25, '25 seated');
  assert(!State.roster.some(p => p.name === 'TentShaman'), 'Tentative stays on the bench');
  assertEqual(State.bench.length, 2, 'One overflow mage plus the tentative shaman on the bench');
});

describe('Overflow: explicit Optimize on a full board still never pulls from the bench', () => {
  resetState();
  State.selectedRaid = 'bt';
  const roster = buildStandard25ManRoster();
  roster.forEach((p, i) => { p.uid = 'e' + i; });
  State.groups = [[], [], [], [], []];
  roster.forEach((p, i) => State.groups[i % 5].push(p));
  State.bench = [ Object.assign(mkPlayer('BenchFeral','DRUID','Feral','melee_dps'), { uid:'bf', groupNumber:0 }) ];
  Optimizer.optimize();
  assertEqual(State.bench.length, 1, 'Bench untouched');
  assertEqual(State.roster.length, 25, 'Roster untouched');
});

// ════════════════════════════════════════════════════════════════
// MISSING-BUFF INSIGHTS: switch / bench / none
// ════════════════════════════════════════════════════════════════
function seatStandardRoster() {
  resetState();
  State.selectedRaid = 'bt';
  const roster = buildStandard25ManRoster();
  roster.forEach((p, i) => { p.uid = 'i' + i; });
  State.groups = [[], [], [], [], []];
  roster.forEach((p, i) => State.groups[i % 5].push(p));
  Optimizer.optimize();
}
function removeClassFromGroups(cls) {
  for (const g of State.groups) for (let i = g.length - 1; i >= 0; i--) if (g[i].class === cls) g.splice(i, 1);
  RosterEdit.syncRoster();
}

describe('Insights: a buff nobody in the roster can give reports "none"', () => {
  seatStandardRoster();
  removeClassFromGroups('HUNTER');
  const insights = getMissingBuffInsights();
  assert(insights.TRUESHOT_AURA, 'Trueshot Aura is reported missing');
  assertEqual(insights.TRUESHOT_AURA.kind, 'none', 'No hunter anywhere -> none');
});

describe('Insights: a benched provider is reported with the bench kind', () => {
  seatStandardRoster();
  removeClassFromGroups('HUNTER');
  State.bench = [ Object.assign(mkPlayer('BenchMM','HUNTER','Marksmanship','ranged_dps'), { uid:'bmm', groupNumber:0 }) ];
  const insights = getMissingBuffInsights();
  assertEqual(insights.TRUESHOT_AURA.kind, 'bench', 'Benched Marksmanship hunter is the source');
  assertEqual(insights.TRUESHOT_AURA.player.uid, 'bmm', 'Insight points at the benched player');
});

describe('Insights: a raider whose totem is overridden away is reported with the switch kind', () => {
  seatStandardRoster();
  let found = null;
  State.groups.forEach((g, gi) => g.forEach(p => { if (!found && p.spec === 'Enhancement') found = { p, gi }; }));
  assert(found, 'Standard roster has an Enhancement shaman');
  // Drop the other Enhancement shaman so Windfury really goes missing.
  State.groups.forEach(g => { for (let i = g.length - 1; i >= 0; i--) if (g[i].spec === 'Enhancement' && g[i].uid !== found.p.uid) g.splice(i, 1); });
  RosterEdit.syncRoster();
  State.buffOverrides[found.gi + ':' + found.p.uid + ':air'] = { buffId:'GRACE_OF_AIR', originalBuffId:'WINDFURY' };
  const insights = getMissingBuffInsights();
  assert(insights.WINDFURY, 'Windfury is missing after the override');
  assertEqual(insights.WINDFURY.kind, 'switch', 'The overridden shaman can switch back');
  assertEqual(insights.WINDFURY.player.uid, found.p.uid, 'Insight points at the shaman');
  const res = RosterEdit.SwitchBuff(insights.WINDFURY.groupIdx, insights.WINDFURY.player.uid, 'WINDFURY');
  assert(res.success, 'SwitchBuff succeeds');
  assert(!getMissingBuffInsights().WINDFURY, 'Windfury is covered after the switch');
});

describe('Insights: Swap In seats the benched provider and benches the lowest-value same-role raider', () => {
  seatStandardRoster();
  removeClassFromGroups('HUNTER');
  let n = 0;
  State.groups.forEach(g => { while (g.length < 5) { n++; g.push(Object.assign(mkPlayer('Filler' + n, 'ROGUE', 'Subtlety', 'melee_dps'), { uid:'f' + n, groupNumber:0 })); } });
  RosterEdit.syncRoster();
  assertEqual(State.roster.length, 25, 'Raid is full before the swap');
  State.bench = [ Object.assign(mkPlayer('BenchMM','HUNTER','Marksmanship','ranged_dps'), { uid:'bmm', groupNumber:0 }) ];
  const insight = getMissingBuffInsights().TRUESHOT_AURA;
  assertEqual(insight.kind, 'bench', 'Trueshot source is on the bench');
  const res = RosterEdit.SwapIn('bmm');
  assert(res.success, 'SwapIn succeeds');
  assertEqual(State.roster.length, 25, 'Raid is still full');
  assertEqual(State.bench.length, 1, 'Exactly one player was benched in exchange');
  assert(State.roster.some(p => p.uid === 'bmm'), 'The hunter is seated');
  assert(State.bench[0].uid !== 'bmm', 'The hunter is not on the bench');
  assert(!getMissingBuffInsights().TRUESHOT_AURA, 'Trueshot Aura is covered after the swap');
  assert(State.groups.every(g => g.length <= 5), 'No group exceeds 5');
});

describe('Insights: Swap In with an open seat just seats the player, benching nobody', () => {
  seatStandardRoster();
  removeClassFromGroups('HUNTER');
  State.bench = [ Object.assign(mkPlayer('BenchMM','HUNTER','Marksmanship','ranged_dps'), { uid:'bmm', groupNumber:0 }) ];
  const res = RosterEdit.SwapIn('bmm');
  assert(res.success, 'SwapIn succeeds');
  assertEqual(State.bench.length, 0, 'Nobody benched when a seat was free');
  assertEqual(res.benched, null, 'Result reports no one benched');
});

describe('Insights: a missing debuff whose provider is benched reports bench', () => {
  seatStandardRoster();
  removeClassFromGroups('WARLOCK');
  State.bench = [ Object.assign(mkPlayer('BenchLock','WARLOCK','Affliction','caster_dps'), { uid:'bl', groupNumber:0 }) ];
  const insights = getMissingBuffInsights();
  const anyLockDebuff = Object.keys(Config.Debuffs).find(id => Config.Debuffs[id].sourceClass === 'WARLOCK' && !Config.Debuffs[id].sourceSpec);
  assert(anyLockDebuff, 'There is a warlock debuff in the catalog');
  assert(insights[anyLockDebuff], 'Warlock debuff is missing');
  assertEqual(insights[anyLockDebuff].kind, 'bench', 'Benched warlock is the source');
});


describe('Bench refinement: a Combat Rogue beats a fourth tank for the last seat (real event roster)', () => {
  resetState();
  State.selectedRaid = 'bt';
  const rows = [["Daolith","Warlock","Destruction"],["Ceedarius","Paladin","Retribution"],["Terani","Mage","Arcane"],["Voctave","Shaman","Restoration1"],["Cordliss","Shaman","Enhancement"],["Gnope","Warlock","Destruction"],["Azukl","Priest","Holy"],["Bearnnaked","Tank","Guardian"],["Kajuk","Tank","Protection"],["Apocalypse","Warrior","Arms"],["Drenna","Paladin","Holy1"],["Aimers","Hunter","Beastmastery"],["Soulavenger","Warlock","Affliction"],["kimmjungheal","Druid","Restoration"],["Roost","Mage","Arcane"],["KashPatail","Priest","Shadow"],["Hinastorm","Rogue","Combat"],["Originalgoat","Shaman","Enhancement"],["Healthas","Priest","Holy"],["Stingz","Hunter","Beastmastery"],["Starck","Tank","Protection1"],["Sanga","Warrior","Fury"],["Daxxter","Mage","Arcane"],["Zzaps","Druid","Balance"],["RaawTotem","Shaman","Elemental"],["Hehebigbear","Tank","Guardian"]];
  const signUps = rows.map((r, i) => ({ name:r[0], className:r[1], specName:r[2], id:i + 1 }));
  const result = Import.importRaidHelper(JSON.stringify({ signUps }));
  assert(result.success, 'Import succeeds');
  assertEqual(State.roster.length, 25, '25 seated');
  assertEqual(State.bench.length, 1, '1 benched');
  assert(State.bench[0].name !== 'Hinastorm', 'The Combat Rogue is not the one benched');
  assertEqual(State.bench[0].role, 'tank', 'The surplus tank is benched instead');
  assert(State.roster.filter(p => p.role === 'tank').length >= 2, 'Tank floor holds');
  assertEqual(State.roster.filter(p => p.role === 'healer').length, 5, 'All five healers stay seated');
  const rogueGroup = State.groups.findIndex(g => g.some(p => p.name === 'Hinastorm'));
  assert(State.groups[rogueGroup].some(p => p.spec === 'Enhancement'), 'The rogue sits with an Enhancement Shaman');
});

describe('Bench refinement: never pulls in Tentative sign-ups or a hand-benched player', () => {
  resetState();
  State.selectedRaid = 'bt';
  const roster = buildStandard25ManRoster();
  roster.push(mkPlayer('WeakExtra','WARRIOR','Protection','tank'));
  roster.forEach((p, i) => { p.uid = 'br' + i; });
  State.groups = [[], [], [], [], []];
  roster.forEach((p, i) => State.groups[i % 5].push(p));
  State.bench = [ Object.assign(mkPlayer('TentEnh','SHAMAN','Enhancement','melee_dps'), { uid:'tent', groupNumber:0 }) ];
  Optimizer.optimize();
  assertEqual(State.roster.length, 25, '25 seated');
  assert(!State.roster.some(p => p.uid === 'tent'), 'Pre-benched Enhancement Shaman stays on the bench');
  assertEqual(State.bench.length, 2, 'Bench holds the tentative plus one overflow');
});

// ════════════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(50));
describe('Import: an all-Tentative sign-up list loads an empty board with everyone benched', () => {
  resetState();
  const signUps = [];
  for (let i = 1; i <= 25; i++) signUps.push({ name: 'Maybe' + i, className: 'Tentative', specName: i % 5 === 0 ? 'Holy' : 'Arms', id: i });
  const res = Import.importRaidHelper(JSON.stringify({ signUps }));
  assert(res.success, 'import must succeed: ' + (res.error || ''));
  assertEqual(res.playerCount, 0, 'nobody is seated');
  assertEqual(res.benchCount, 25, 'every Tentative sign-up is benched');
  assertEqual(State.groups.length, 5, '25 sign-ups still size the raid as a 25-man');
  assert(State.groups.every(g => g.length === 0), 'all groups are empty');
  assert(State.bench.every(p => p.groupNumber === 0 && p.spec), 'benched players keep their spec and carry no group');
});

describe('Import: a sign-up list with no usable players still fails', () => {
  resetState();
  const res = Import.importRaidHelper(JSON.stringify({ signUps: [{ name: 'Gone', className: 'Absence', specName: 'Absence', id: 1 }] }));
  assert(!res.success, 'absence-only import is rejected');
});

// ════════════════════════════════════════════════════════════════
// RAID-HELPER RE-SYNC (Refresh)
// ════════════════════════════════════════════════════════════════
function syncFixture() {
  // 4 seated + 1 Tentative on the bench, imported from a sign-up list.
  resetState();
  State.selectedRaid = 'kara';
  const signUps = [
    { name: 'Tanky',  className: 'Tank',    specName: 'Protection',  id: 1 },
    { name: 'Healy',  className: 'Priest',  specName: 'Holy1',       id: 2 },
    { name: 'Magey',  className: 'Mage',    specName: 'Fire',        id: 3 },
    { name: 'Roguey', className: 'Rogue',   specName: 'Combat',      id: 4 },
    { name: 'Maybe',  className: 'Tentative', specName: 'Affliction', id: 5 },
  ];
  const res = Import.importRaidHelper(JSON.stringify({ signUps }));
  if (!res.success) throw new Error('fixture import failed: ' + res.error);
  return signUps;
}
const byName = (n) => State.roster.find(p => p.name === n) || (State.bench || []).find(p => p.name === n);

describe('Sync: an unchanged sign-up list produces an empty diff', () => {
  const signUps = syncFixture();
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assert(diff.success, 'diff succeeds');
  assert(!Import.hasRaidHelperChanges(diff), 'no changes reported');
  assertEqual(diff.promoted.length, 0, 'nothing promoted');
});

describe('Sync: diff rejects bad input without touching State', () => {
  syncFixture();
  const before = State.roster.length;
  assert(!Import.diffRaidHelperSignUps('nope').success, 'invalid JSON fails');
  assert(!Import.diffRaidHelperSignUps('{"slots":[]}').success, 'slots export is not a sign-up list');
  assertEqual(State.roster.length, before, 'roster untouched');
});

describe('Sync: new sign-ups land on the bench; seats are untouched', () => {
  const signUps = syncFixture();
  const seatsBefore = State.roster.map(p => p.name + ':' + p.groupNumber).join(',');
  signUps.push({ name: 'Newbie', className: 'Hunter', specName: 'Beastmastery', id: 6 });
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.added.length, 1, 'one added');
  assertEqual(diff.added[0].name, 'Newbie', 'the new name is reported');
  const counts = Import.applyRaidHelperSync(diff);
  assertEqual(counts.added, 1, 'apply reports one added');
  const nb = byName('Newbie');
  assert(nb && nb.groupNumber === 0 && State.bench.includes(nb), 'Newbie is on the bench');
  assertEqual(nb.class, 'HUNTER', 'class resolved');
  assertEqual(State.roster.map(p => p.name + ':' + p.groupNumber).join(','), seatsBefore, 'seated players kept their groups');
});

describe('Sync: withdrawn players are removed; an Absent one moves to the unplaced list', () => {
  const signUps = syncFixture();
  const gone = signUps.splice(2, 1)[0]; // Magey withdraws entirely
  signUps[signUps.length - 1] = { name: 'Maybe', className: 'Absence', specName: 'Absence', id: 5 }; // bench player now Absent
  const magey = byName('Magey');
  State.buffOverrides['0:' + magey.uid + ':fire'] = { buffId: 'x' };
  // Name-keyed features tied to the fully-withdrawn player must be dropped
  // the same way buff overrides already are (review finding #3) — otherwise
  // they dangle in State.playerConstraints/State.drummers and can silently
  // re-attach to an unrelated future sign-up that happens to reuse the name.
  Constraints.add('Magey', 'Tanky', 'together');
  Drummers.set('Magey', 'Battle');
  const maybe = byName('Maybe');
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.removed.length, 1, 'one removed');
  Import.applyRaidHelperSync(diff);
  assert(!byName('Magey'), 'Magey is gone');
  assert(!byName('Maybe'), 'Maybe is off the bench');
  assert(State.unplaced.includes(maybe) && maybe.signupStatus === 'absent', 'Maybe is kept as Absent');
  assertEqual(maybe.class, 'WARLOCK', 'an Absence keeps the class already known');
  assert(State.groups.every(g => !g.includes(magey)), 'Magey left the group');
  assertEqual(Object.keys(State.buffOverrides).length, 0, 'overrides for the removed player are cleared');
  assertEqual(State.roster.length, 3, 'three seated remain');
  assertEqual(Constraints.forPlayer('Magey').length, 0, 'Magey\'s constraint is dropped on full withdrawal');
  assertEqual(Constraints.forPlayer('Tanky').length, 0, 'Tanky no longer inherits the stale constraint either');
  assert(!Drummers.isDrummer('Magey'), 'Magey\'s drummer tag is dropped on full withdrawal');
});

describe('Sync: a spec change updates the player in place', () => {
  const signUps = syncFixture();
  signUps[2] = { name: 'Magey', className: 'Mage', specName: 'Frost', id: 3 };
  const magey = byName('Magey');
  const groupBefore = magey.groupNumber;
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.changed.length, 1, 'one changed');
  Import.applyRaidHelperSync(diff);
  assertEqual(byName('Magey'), magey, 'same player object');
  assertEqual(magey.spec, 'Frost', 'spec updated');
  assertEqual(magey.groupNumber, groupBefore, 'seat kept');
});

describe('Sync: a role change is a change too (Prot -> Arms)', () => {
  const signUps = syncFixture();
  signUps[0] = { name: 'Tanky', className: 'Warrior', specName: 'Arms', id: 1 };
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.changed.length, 1, 'one changed');
  Import.applyRaidHelperSync(diff);
  assertEqual(byName('Tanky').role, 'melee_dps', 'role updated');
});

describe('Sync: a seated player who goes Tentative moves to the bench', () => {
  const signUps = syncFixture();
  signUps[3] = { name: 'Roguey', className: 'Tentative', specName: 'Combat', id: 4 };
  const roguey = byName('Roguey');
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.demoted.length, 1, 'one demoted');
  Import.applyRaidHelperSync(diff);
  assert(State.bench.includes(roguey) && roguey.groupNumber === 0, 'Roguey is benched');
  assert(!State.roster.includes(roguey), 'Roguey is not seated');
  assert(State.groups.every(g => !g.includes(roguey)), 'Roguey left the group');
});

describe('Sync: a benched player who confirms is reported but stays benched', () => {
  const signUps = syncFixture();
  signUps[4] = { name: 'Maybe', className: 'Warlock', specName: 'Affliction', id: 5 };
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.promoted.length, 1, 'one promoted');
  assert(Import.hasRaidHelperChanges(diff), 'Tentative -> confirmed moves them to the Bench tab, so it is a change');
  assertEqual(Import.describeRaidHelperChanges(diff), '1 on the bench now confirmed', 'told once, as a confirmation');
  Import.applyRaidHelperSync(diff);
  assert(State.bench.includes(byName('Maybe')), 'Maybe stays on the bench');
  assertEqual(byName('Maybe').signupStatus, 'confirmed', 'Maybe is now a confirmed sign-up');
});

describe('Sync: a benched Tentative who goes Late moves tabs and keeps their place', () => {
  const signUps = syncFixture();
  signUps[4] = { name: 'Maybe', className: 'Late', specName: 'Affliction', id: 5 };
  const maybe = byName('Maybe');
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assert(Import.hasRaidHelperChanges(diff), 'a status change is a change');
  assertEqual(Import.describeRaidHelperChanges(diff), '1 now Late', 'reported by new status');
  const counts = Import.applyRaidHelperSync(diff);
  assertEqual(Import.describeRaidHelperChanges(counts), '1 now Late', 'the applied counts read the same');
  assert(State.bench.includes(maybe), 'still benched');
  assertEqual(maybe.signupStatus, 'late', 'status updated');
});

describe('Sync: a seated player who goes Late is unseated into the Late tab', () => {
  const signUps = syncFixture();
  signUps[2] = { name: 'Magey', className: 'Late', specName: 'Fire', id: 3 };
  const magey = byName('Magey');
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.demoted.length, 1, 'one demoted');
  assertEqual(Import.describeRaidHelperChanges(diff), '1 seated now Late', 'told as a seat change, not twice');
  const counts = Import.applyRaidHelperSync(diff);
  assertEqual(Import.describeRaidHelperChanges(counts), '1 seated now Late', 'the applied counts read the same');
  assert(State.bench.includes(magey) && !State.roster.includes(magey), 'Magey benched');
  assertEqual(SignupStatus.tabFor(magey.signupStatus), 'late', 'Magey files under Late');
});

describe('Sync: a Late player dragged into a group stays seated on the next refresh', () => {
  const signUps = syncFixture();
  signUps[4] = { name: 'Maybe', className: 'Late', specName: 'Affliction', id: 5 };
  Import.applyRaidHelperSync(Import.diffRaidHelperSignUps(JSON.stringify({ signUps })));
  const maybe = byName('Maybe');
  const open = State.groups.findIndex(g => g.length < 5);
  assert(RosterEdit.UnbenchPlayer(maybe.uid, open).success, 'seated by hand');
  assert(State.roster.includes(maybe), 'Maybe is seated');
  const again = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assert(!Import.hasRaidHelperChanges(again), 'still Late on Raid-Helper is no change');
  assertEqual(again.demoted.length, 0, "the leader's choice to seat them is kept");
});

describe('Sync: an Absent sign-up who signs up with a class moves from unplaced to the bench', () => {
  const signUps = syncFixture();
  signUps.push({ name: 'Ghost', className: 'Absence', specName: null, id: 9 });
  Import.applyRaidHelperSync(Import.diffRaidHelperSignUps(JSON.stringify({ signUps })));
  const ghost = State.unplaced.find(p => p.name === 'Ghost');
  assert(ghost && ghost.class === null, 'Ghost held unplaced without a class');
  signUps[signUps.length - 1] = { name: 'Ghost', className: 'Tentative', specName: 'Frost', id: 9 };
  Import.applyRaidHelperSync(Import.diffRaidHelperSignUps(JSON.stringify({ signUps })));
  assert(!State.unplaced.includes(ghost), 'Ghost left the unplaced list');
  assert(State.bench.includes(ghost), 'Ghost is on the bench');
  assertEqual([ghost.class, ghost.signupStatus, ghost.groupNumber].join(), 'MAGE,tentative,0', 'class, status and bench seat set');
});

describe('Sync: a plan saved before statuses existed backfills them silently', () => {
  const signUps = syncFixture();
  for (const p of [...State.roster, ...State.bench]) delete p.signupStatus;
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assert(diff.restatus.length > 0 && diff.restatus.every(r => r.backfill), 'every status is a backfill');
  assert(!Import.hasRaidHelperChanges(diff), 'no banner for a backfill');
  Import.applyRaidHelperSync(diff);
  assertEqual(byName('Maybe').signupStatus, 'tentative', 'Refresh fills the status in');
});

describe('Sign-up status survives save, roster export and share links', () => {
  syncFixture();
  State.unplaced = [{ uid: nextUid(), name: 'Gone', signupStatus: 'absent', class: null, spec: null, role: null }];
  byName('Maybe').signupStatus = 'late';
  State.planId = 'plan:status-test'; State.rosterName = 'Status test';
  const capture = PP.PlanStore.capture();
  resetState();
  assert(PP.PlanStore.restore(capture), 'plan restores');
  assertEqual(byName('Maybe').signupStatus, 'late', 'plan keeps a bench status');
  assertEqual(State.unplaced.map(p => p.name + ':' + p.signupStatus).join(), 'Gone:absent', 'plan keeps unplaced sign-ups');
  const exported = Import.exportRoster('x');
  resetState();
  assert(Import.loadRoster(exported), 'roster reloads');
  assertEqual(byName('Maybe').signupStatus, 'late', 'roster export keeps status');
  assertEqual(State.unplaced.length, 1, 'roster export keeps unplaced');
  const share = Import.exportShareString();
  resetState();
  assert(Import.importAddonString(share).success, 'share link loads');
  assertEqual(byName('Maybe').signupStatus, 'late', 'share link keeps status');
  assertEqual(State.unplaced.map(p => p.name).join(), 'Gone', 'share link keeps unplaced');
});

describe('RosterEdit.PlaceUnplaced seats an Absent sign-up only with a class, keeping the Absent status', () => {
  syncFixture();
  State.unplaced = [{ uid: nextUid(), name: 'Gone', signupStatus: 'absent', class: null, spec: null, role: null }];
  const uid = State.unplaced[0].uid;
  const open = State.groups.findIndex(g => g.length < 5);
  assert(!RosterEdit.PlaceUnplaced(uid, open).success, 'no class picked -> refused');
  assertEqual(State.unplaced.length, 1, 'still unplaced after a refusal');
  const full = State.groups.findIndex(g => g.length >= 5);
  if (full >= 0) assert(!RosterEdit.PlaceUnplaced(uid, full, { class:'MAGE', spec:'Frost' }).success, 'full group refused');
  const result = RosterEdit.PlaceUnplaced(uid, open, { class:'MAGE', spec:'Frost' });
  assert(result.success, 'seated with a picked class/spec');
  assertEqual([result.player.role, result.player.signupStatus, result.player.groupNumber].join(), 'caster_dps,absent,' + (open + 1), 'role from spec, status kept, seated');
  assert(State.roster.includes(result.player) && State.unplaced.length === 0, 'moved from unplaced into the roster');
});

describe('Share link stays compact when every status is a plain confirmed sign-up', () => {
  resetState();
  Import.importRaidHelper(JSON.stringify({ signUps: [
    { name:'Tanky', className:'Tank', specName:'Protection', id:1 },
    { name:'Magey', className:'Mage', specName:'Fire',       id:2 },
  ]}));
  assert(!Import.exportShareString().includes('signupStatuses'), 'no status tail for an all-confirmed plan');
});

describe('Sync: name matching ignores case and whitespace; duplicates are not re-added', () => {
  const signUps = syncFixture();
  signUps[2] = { name: ' MAGEY ', className: 'Mage', specName: 'Fire', id: 3 };
  signUps.push({ name: 'magey', className: 'Mage', specName: 'Arcane', id: 7 });
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assertEqual(diff.added.length, 0, 'nothing added');
  assertEqual(diff.removed.length, 0, 'nothing removed');
  assertEqual(diff.changed.length, 0, 'first duplicate wins, no change');
});

describe('Sync: applying twice is a no-op the second time', () => {
  const signUps = syncFixture();
  signUps.push({ name: 'Newbie', className: 'Hunter', specName: 'Beastmastery', id: 6 });
  signUps.splice(1, 1);
  Import.applyRaidHelperSync(Import.diffRaidHelperSignUps(JSON.stringify({ signUps })));
  const again = Import.diffRaidHelperSignUps(JSON.stringify({ signUps }));
  assert(!Import.hasRaidHelperChanges(again), 'second diff is empty');
});

describe('Sync: sourceEventId round-trips through export and load', () => {
  syncFixture();
  State.sourceEventId = '1483258698854826006';
  const exported = Import.exportRoster('Linked');
  assertEqual(exported.sourceEventId, '1483258698854826006', 'export carries the event id');
  State.sourceEventId = null;
  Import.loadRoster(exported);
  assertEqual(State.sourceEventId, '1483258698854826006', 'load restores it');
  Import.loadRoster({ name: 'Old', players: [] });
  assertEqual(State.sourceEventId, null, 'older saves without an id clear it');
});

describe('Import history: snapshots survive edits and restore seats, bench and event link', () => {
  const storage = { data: new Map(), getItem(k) { return this.data.get(k) || null; }, setItem(k,v) { this.data.set(k,v); } };
  syncFixture();
  State.sourceEventId = '123456789';
  State.rosterName = 'History fixture';
  State.bench = [mkPlayer('Waiting', 'MAGE', 'Arcane', 'caster_dps')];
  const originalNames = State.groups.flat().map(p => p.name).join(',');
  const entry = PP.ImportHistory.add(storage, 'Pasted JSON');
  State.groups[0][0].name = 'Edited after import';
  State.bench = [];
  const saved = PP.ImportHistory.read(storage);
  assertEqual(saved.length, 1, 'one import stored');
  assertEqual(saved[0].roster.players.map(p => p.name).join(','), originalNames, 'stored snapshot is independent of later edits');
  assert(Import.loadRoster(saved[0].roster), 'snapshot loads');
  assertEqual(State.groups.flat().map(p => p.name).join(','), originalNames, 'seating restored');
  assertEqual(State.bench[0].name, 'Waiting', 'bench restored');
  assertEqual(State.sourceEventId, '123456789', 'event link restored');
  for (let i = 0; i < 35; i++) { State.rosterName = 'Import ' + i; PP.ImportHistory.add(storage, 'JSON'); }
  const recent = PP.ImportHistory.read(storage);
  assertEqual(recent.length, 30, 'history is bounded');
  assertEqual(recent[0].roster.name, 'Import 34', 'newest first');
  assertEqual(recent[29].roster.name, 'Import 5', 'oldest trimmed');
  PP.ImportHistory.remove(storage, recent[0].id);
  assertEqual(PP.ImportHistory.read(storage).length, 29, 'individual deletion');
  assertEqual(storage.getItem('pp_rosters'), null, 'manual saves untouched');
  storage.setItem(PP.ImportHistory.key, '{bad');
  assertEqual(PP.ImportHistory.read(storage).length, 0, 'corrupt JSON handled');
  storage.setItem(PP.ImportHistory.key, JSON.stringify([null, {}, { ...entry, roster: { players: [] } }, entry]));
  assertEqual(PP.ImportHistory.read(storage).length, 1, 'invalid records skipped');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  assertEqual(PP.ImportHistory.read(blocked).length, 0, 'blocked reads handled');
  let failed = false;
  try { PP.ImportHistory.add(blocked, 'JSON'); } catch { failed = true; }
  assert(failed, 'write failure reaches UI for reporting');
});

describe('Working plans: full snapshots, independent plans, identity and undo', () => {
  const storage = {data:new Map(), getItem(k){return this.data.get(k)||null;},setItem(k,v){this.data.set(k,v);}};
  syncFixture();
  State.planId = 'event:123'; State.sourceEventId = '123'; State.rosterName='Friday raid'; State.optimizerMode='max_dps';
  State.groups[0][0].uid='p9000';
  State.buffOverrides={'0:p9000:air':{buffId:'WINDFURY'}};
  const original = PP.PlanStore.capture();
  PP.PlanStore.save(storage, original);
  State.rosterName='Edited'; PP.PlanStore.save(storage,PP.PlanStore.capture());
  assertEqual(PP.PlanStore.read(storage).length,1,'same plan updated rather than duplicated');
  State.planId='second'; PP.PlanStore.save(storage,PP.PlanStore.capture());
  assertEqual(PP.PlanStore.read(storage).length,2,'independent plans retained');
  assert(PP.PlanStore.restore(original),'snapshot restores');
  assertEqual(State.rosterName,'Friday raid','name restored');
  assertEqual(State.optimizerMode,'max_dps','mode restored');
  // Plans saved before the nav slim-down may carry another strategy; Optimize only runs Max DPS now.
  assert(PP.PlanStore.restore({...original, optimizerMode:'balanced'}),'an old strategy still loads');
  assertEqual(State.optimizerMode,'max_dps','an old strategy is forced to Max DPS');
  PP.PlanStore.restore(original);
  assertEqual(State.sourceEventId,'123','event retained');
  assertEqual(State.buffOverrides['0:p9000:air'].buffId,'WINDFURY','buff override retained');
  const added=RosterEdit.AddPlayer(1,{name:'Fresh',class:'MAGE',spec:'Arcane'});
  assert(added.success && added.player.uid !== 'p9000','new identity does not collide');
  PP.PlanStore.restore(original);
  PP.PlanSession.previous=null; PP.PlanSession.undo=[]; PP.PlanSession.ready=true;
  PP.PlanSession.observe();
  RosterEdit.BenchPlayer(State.roster[0].uid); PP.PlanSession.observe();
  assertEqual(PP.PlanSession.undo.length,1,'bench change is undoable');
  assert(PP.PlanSession.undoLast(),'undo succeeds'); PP.PlanSession.observe();
  assertEqual(JSON.stringify(PP.PlanStore.capture()),JSON.stringify(original),'undo restores full state');
  assertEqual(PP.PlanSession.undo.length,0,'undo does not create another undo entry');
  State.rosterName='renamed'; PP.PlanSession.observe();
  State.planId='different'; PP.PlanSession.observe();
  assertEqual(PP.PlanSession.undo.length,0,'undo does not cross plans');
  storage.setItem(PP.PlanStore.key,'broken'); assertEqual(PP.PlanStore.read(storage).length,0,'corrupt storage is safe');
  assert(!PP.PlanStore.restore({groups:[]}), 'malformed draft rejected');
  PP.PlanSession.ready=false;
});

describe('Tap moves: open seats, explicit swaps, bench and full groups', () => {
  resetState();
  const mage=mkPlayer('Mover','MAGE','Arcane','caster_dps');
  const peers=Array.from({length:5},(_,i)=>mkPlayer('Peer'+i,'MAGE','Arcane','caster_dps'));
  mage.uid='move-mage'; peers.forEach((p,i)=>p.uid='move-peer'+i);
  State.groups=[[mage],peers]; State.roster=State.groups.flat(); State.bench=[];
  assert(!RosterEdit.MovePlayer(mage.uid,1).success,'full group requires explicit swap');
  assert(RosterEdit.MovePlayer(mage.uid,1,peers[0].uid).success,'group swap succeeds');
  assertEqual(State.groups[0][0].name,'Peer0','other player replaces origin');
  RosterEdit.BenchPlayer(mage.uid);
  assert(RosterEdit.MovePlayer(mage.uid,0).success,'bench player can use open seat');
  assertEqual(State.bench.length,0,'bench player removed from bench');
  assertEqual(new Set(State.groups.flat().map(p=>p.uid)).size,6,'all identities retained once');
  RosterEdit.BenchPlayer(mage.uid);
  State.groups[1].push(mkPlayer('Extra','MAGE','Arcane','caster_dps'));
  const outgoing=State.groups[1][0];
  assert(RosterEdit.MovePlayer(mage.uid,1,outgoing.uid).success,'bench swap succeeds');
  assertEqual(State.bench[0].uid,outgoing.uid,'outgoing player goes to bench');
});

describe('Preferred slots: real-player counts, import matching, storage and sharing', () => {
  resetState();
  const prefs = PP.PreferredSlots;
  State.groups = [[],[],[],[],[]];
  assert(prefs.add(2, 'SHAMAN', 'Restoration'), 'request can be created without a player');
  assert(prefs.add(2, 'SHAMAN', 'Restoration'), 'multiple identical requests supported');
  assert(!prefs.add(2, 'MAGE', 'Restoration'), 'invalid class/spec rejected');
  assertEqual(State.roster.length, 0, 'requests do not count as players');
  assertEqual(getGroupBuffs(State.groups[2],2).length, 0, 'requests provide no buffs');
  State.planId = 'plan:preferences';
  State.rosterName = 'Recruiting';
  const snapshot = PP.PlanStore.capture();
  const shared = Import.exportShareString();
  State.preferredSlots = [];
  assert(Import.importAddonString(shared).success, 'placeholder-only share loads');
  assertEqual(State.preferredSlots.length, 2, 'share retains requests');
  assert(PP.PlanStore.restore(snapshot), 'working plan restores');
  assertEqual(State.preferredSlots[0].group, 2, 'group retained');
  const saved = Import.exportRoster();
  Import.loadRoster(saved);
  assertEqual(State.preferredSlots.length, 2, 'saved copy retains requests');
  const result = Import.importRaidHelper(JSON.stringify({signUps:[
    {name:'ConfirmedA',className:'Shaman',specName:'Restoration1'},
    {name:'Waiting',className:'Tentative',specName:'Restoration1'},
    {name:'Unmatched',className:'Mage',specName:'Fire'},
  ]}));
  assert(result.success, 'import succeeds');
  assertEqual(result.filledCount, 1, 'only confirmed exact match is placed');
  assertEqual(State.groups[2][0]?.name, 'ConfirmedA', 'match gets requested group');
  assertEqual(State.selectedRaid, 'bt', 'planned raid size retained for small import');
  assertEqual(State.bench.length, 2, 'tentative and unmatched remain benched');
  assertEqual(State.preferredSlots.length, 1, 'unfilled request stays visible');
  const before = State.groups[2][0];
  const diff = Import.diffRaidHelperSignUps(JSON.stringify({signUps:[
    {name:'ConfirmedA',className:'Shaman',specName:'Restoration1'},
    {name:'Waiting',className:'Shaman',specName:'Restoration1'},
    {name:'Unmatched',className:'Mage',specName:'Fire'},
  ]}));
  assert(Import.hasRaidHelperChanges(diff), 'matching promotion triggers refresh');
  assertEqual(Import.applyRaidHelperSync(diff).filled, 1, 'promotion fills remaining request');
  assertEqual(State.groups[2][0], before, 'existing placement preserved');
  assertEqual(State.groups[2][1].name, 'Waiting', 'promoted match seated');
  assertEqual(State.preferredSlots.length, 0, 'requests consumed once');
  prefs.add(2, 'MAGE', 'Arcane');
  RosterEdit.AddPlayer(0, {name:'FreeMage', class:'MAGE', spec:'Fire'});
  Optimizer.optimize();
  assertEqual(prefs.manual().length, 1, 'optimizer retains empty request');
  assertEqual(prefs.manual()[0].spec, 'Arcane', 'the request is re-seated as the leader\'s own Arcane slot');
  assert(State.groups.every((g, gi) => g.length + prefs.forGroup(gi).length <= 5), 'no group over 5, counting Opens');
  assertEqual(State.preferredSlots.filter(p => p.auto).length, 21, 'every other empty seat gets a suggested Open (25 - 3 seated - 1 request)');
  assertEqual(State.roster.length, 3, 'optimizer retains all real players');
  assert(State.groups.every(g => g.length <= 5), 'optimizer respects capacity');
  assert(State.preserveGroupOrder, 'requested layout retains its group order after matching');
  PP.PlanSession.ready = true; PP.PlanSession.previous = null; PP.PlanSession.undo = [];
  State.planId = 'plan:preferred-undo';
  PP.PlanSession.observe();
  prefs.remove(prefs.manual()[0]); PP.PlanSession.observe();
  assert(PP.PlanSession.undoLast(), 'preference removal can be undone');
  assertEqual(prefs.manual().length, 1, 'undo restores request');
  const beforeInvalid = JSON.stringify(PP.PlanStore.capture());
  assert(!Import.importRaidHelper('{"signUps":[]}').success, 'empty import is rejected');
  assertEqual(JSON.stringify(PP.PlanStore.capture()), beforeInvalid, 'invalid import preserves plan');
  const wrongClass = {name:'Other',class:'DRUID',spec:'Arcane',role:'caster_dps'};
  assert(!prefs.seat(wrongClass), 'matching spec alone is insufficient');
  const legacy = {...snapshot}; delete legacy.preferredSlots;
  PP.PlanStore.restore(legacy);
  assertEqual(State.preferredSlots.length, 0, 'old drafts do not inherit requests');
  State.groups = [[],[],[],[],[]];
  for (let i = 0; i < 5; i++) assert(prefs.add(0,'MAGE','Fire'), 'five open requests fit');
  assert(!prefs.add(0,'MAGE','Fire'), 'sixth request rejected');
  const slotsResult = Import.importRaidHelper(JSON.stringify({slots:[{name:'SlotMage',className:'Mage',specName:'Fire',groupNumber:4}]}));
  assertEqual(slotsResult.filledCount, 1, 'raidplan slot import also fills request');
  assertEqual(State.groups[0][0]?.name, 'SlotMage', 'preferred destination overrides imported group');
  assertEqual(State.preferredSlots.length, 4, 'one signup consumes only one request');
  resetState();
});

// ════════════════════════════════════════════════════════════════
// esc() — HTML escaping (review finding #1: attribute injection)
// ════════════════════════════════════════════════════════════════
describe('esc(): escapes every character that is special in HTML text or attribute position', () => {
  assertEqual(esc('&'), '&amp;', 'ampersand');
  assertEqual(esc('<'), '&lt;', 'less-than');
  assertEqual(esc('>'), '&gt;', 'greater-than');
  assertEqual(esc('"'), '&quot;', 'double quote');
  assertEqual(esc("'"), '&#39;', 'single quote');
  assertEqual(esc(null), '', 'null becomes empty string');
  assertEqual(esc(undefined), '', 'undefined becomes empty string');
  assertEqual(esc('Plain Name'), 'Plain Name', 'ordinary text is untouched');
});

describe('esc(): a name built to break out of a double-quoted HTML attribute renders inert', () => {
  // The exact payload used for the manual browser verification pass too —
  // a raw " ends the attribute early and lets the rest add a live handler.
  const payload = 'Foo" onmouseover="window.__pwned=1" x="';
  const escaped = esc(payload);
  assert(!escaped.includes('"'), 'no raw double-quote survives escaping');
  assert(!escaped.includes("'"), 'no raw single-quote survives escaping');

  // Reproduce a real call site's shape (e.g. data-template="${esc(t.name)}")
  // and confirm the browser would parse exactly one attribute out of it,
  // with no separate onmouseover attribute appearing anywhere on the tag.
  const html = `<div data-template="${escaped}" class="saved-roster-item"></div>`;
  // `key="` (an unescaped quote right after `=`) is what actually opens a new
  // HTML attribute — matching that, rather than just the substring
  // "onmouseover=", proves the injected text stayed inert data inside
  // data-template's value instead of becoming a second, real attribute.
  const attrOpenings = html.match(/[a-zA-Z0-9_-]+="/g) || [];
  assertEqual(attrOpenings.length, 2, 'exactly the two real attributes (data-template, class) are present');
  assert(html.includes('&quot;'), 'the quote character survives only in its escaped form');
});

// ── OPEN SLOT SUGGESTIONS (auto-filled empty seats) ──────────────
// Seats a hand-built roster round-robin, then runs the real Optimize.
function seatForOpenSlots(specs, raid = 'bt') {
  resetState();
  State.selectedRaid = raid;
  State.optimizerMode = 'max_dps';
  const numGroups = Config.Raids[raid].groups;
  State.groups = Array.from({ length: numGroups }, () => []);
  specs.forEach(([cls, spec, role], i) => {
    const player = { uid: nextUid(), name: 'P' + i, class: cls, spec, role, groupNumber: (i % numGroups) + 1, imported: true };
    State.groups[i % numGroups].push(player);
  });
  State.roster = State.groups.flat();
  Optimizer.optimize();
}
const autoSlots = () => State.preferredSlots.filter(p => p.auto);
const seatsWithOpens = () => State.groups.map((g, gi) => g.length + PP.PreferredSlots.forGroup(gi).length);
const DPS_14 = [
  ['WARRIOR','Fury','melee_dps'], ['ROGUE','Combat','melee_dps'], ['ROGUE','Combat','melee_dps'], ['SHAMAN','Enhancement','melee_dps'],
  ['HUNTER','Beast Mastery','ranged_dps'], ['HUNTER','Beast Mastery','ranged_dps'], ['MAGE','Fire','caster_dps'], ['MAGE','Arcane','caster_dps'],
  ['WARLOCK','Destruction','caster_dps'], ['WARLOCK','Destruction','caster_dps'], ['PRIEST','Shadow','caster_dps'], ['DRUID','Balance','caster_dps'],
  ['SHAMAN','Elemental','caster_dps'], ['DRUID','Feral','melee_dps'],
];

describe('OpenSlots: every empty seat in a short raid gets a suggested Open, tanks/healers first', () => {
  seatForOpenSlots([['WARRIOR','Protection','tank'], ['PRIEST','Holy','healer'], ['PALADIN','Holy','healer'], ['DRUID','Restoration','healer'], ...DPS_14]);
  const seated = State.roster.length;
  assertEqual(seated, 18, 'fixture seats 18');
  assertEqual(autoSlots().length, 25 - seated, 'one Open per empty seat');
  assert(seatsWithOpens().every(n => n === 5), 'every group ends at exactly 5 with its Opens');
  const role = (slot) => PP.RosterEdit.RoleForSpec(slot.class, slot.spec);
  const roles = autoSlots().map(role);
  assertEqual(roles.filter(r => r === 'tank').length, 1, 'one tank to reach the 2-tank floor');
  assertEqual(roles.filter(r => r === 'healer').length, 2, 'two healers to reach the 5-healer floor');
  assert(roles.slice(3).every(r => r !== 'tank' && r !== 'healer'), 'seats past the floors go to DPS');
});

describe('OpenSlots: a full raid gets no suggestions', () => {
  const specs = [['WARRIOR','Protection','tank'], ['PALADIN','Protection','tank']];
  for (let i = 0; i < 6; i++) specs.push(['PRIEST','Holy','healer']);
  while (specs.length < 25) specs.push(DPS_14[specs.length % DPS_14.length]);
  seatForOpenSlots(specs);
  assertEqual(State.roster.length, 25, 'raid is full');
  assertEqual(State.preferredSlots.length, 0, 'no Opens');
});

describe('OpenSlots: suggestions are recalculated each Optimize, never stacked', () => {
  seatForOpenSlots(DPS_14.slice(0, 10));
  const first = JSON.stringify(State.preferredSlots);
  Optimizer.optimize();
  assertEqual(JSON.stringify(State.preferredSlots), first, 'a second Optimize yields the same suggestions');
  assertEqual(autoSlots().length, 15, 'still exactly one per empty seat');
});

describe('OpenSlots: no Open slot freezes a group; a manual one is re-seated and stays manual', () => {
  seatForOpenSlots(DPS_14.slice(0, 12));
  const fresh = State.groups.map(g => g.map(p => p.uid).join(',')).join('|');
  assert(autoSlots().length > 0, 'Opens were suggested');
  Optimizer.optimize();
  assertEqual(State.groups.map(g => g.map(p => p.uid).join(',')).join('|'), fresh, 'groups with Opens are re-optimized normally');
  const gi = autoSlots()[0].group;
  assert(PP.PreferredSlots.add(gi, 'MAGE', 'Frost'), 'a manual request takes a suggested seat');
  Optimizer.optimize();
  const manual = PP.PreferredSlots.manual();
  assertEqual(manual.length, 1, 'the manual slot survives Optimize');
  assertEqual(manual[0].spec, 'Frost', 'still the leader\'s Frost Mage');
  assertEqual(autoSlots().length, 25 - State.roster.length - 1, 'suggestions fill around the manual slot');
  assert(seatsWithOpens().every(n => n <= 5), 'no group over 5');
});

describe('OpenSlots: a manual Open slot does not freeze its group; its players can move', () => {
  const specs = [['PALADIN','Protection','tank'], ['PRIEST','Holy','healer'], ['PALADIN','Holy','healer'], ['DRUID','Restoration','healer'], ...DPS_14];
  // Lays the players out from a given start with one manual Arms Warrior request.
  const optimizeFrom = (requestGroup, startGroupOf) => {
    seatForOpenSlots(specs);
    const players = State.groups.flat().sort((a, b) => a.name < b.name ? -1 : 1);
    State.groups = [[], [], [], [], []];
    players.forEach((p, i) => { const gi = startGroupOf(p, i); State.groups[gi].push(p); p.groupNumber = gi + 1; });
    State.roster = State.groups.flat();
    State.preferredSlots = [{ group: requestGroup, class: 'WARRIOR', spec: 'Arms' }];
    Optimizer.optimize();
    const slot = PP.PreferredSlots.manual()[0];
    return { slot, key: State.groups.map((g, gi) => g.map(p => p.name).sort().concat(gi === slot.group ? ['ARMS'] : []).join(',')).join(' | ') };
  };
  // Four casters packed into the requested group, everyone else round robin.
  const casters = new Set();
  const packed = optimizeFrom(0, (p, i) => {
    if (p.role === 'caster_dps' && casters.size < 4) { casters.add(p.name); return 0; }
    return 1 + i % 4;
  });
  assert(packed.slot && !packed.slot.auto, 'the request is still the leader\'s own');
  const slotGroup = State.groups[packed.slot.group];
  assert(![...casters].every(n => slotGroup.some(p => p.name === n)), 'the casters packed with the request were moved');
  const physical = slotGroup.filter(p => p.role === 'melee_dps' || p.role === 'ranged_dps' || p.role === 'tank').length;
  assert(physical > slotGroup.length - physical, 'the Arms request sits with physical DPS (G' + (packed.slot.group + 1) + ')');
  const other = optimizeFrom(3, (p, i) => i % 5);
  assertEqual(other.key, packed.key, 'the layout does not depend on where the request or the players started');
});

// Share plan jolBchk (2026-10-09): one empty seat besides the Disc Priest's.
// The suggested Enh Shaman used to sit with the hunters/Feral/Prot Warrior
// because placement only seated it where a seat was free or one real player
// could step out; Arms, Ret, Fury and the Rogue stayed with the hunters.
describe('OpenSlots: a suggested Enh Shaman is seated with the melee it buffs (jolBchk)', () => {
  resetState();
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  State.optimizerMode = 'max_dps';
  const layout = [
    [['Stingz','HUNTER','Beast Mastery','ranged_dps'], ['hellsmouth','HUNTER','Beast Mastery','ranged_dps'], ['Kanyan','DRUID','Feral','tank'], ['Therhyme','WARRIOR','Arms','melee_dps'], ['Ceedarius','PALADIN','Retribution','melee_dps']],
    [['Sanga','WARRIOR','Fury','melee_dps'], ['Hinastorm','ROGUE','Combat','melee_dps'], ['Aimers','HUNTER','Beast Mastery','ranged_dps'], ['Kajuk','WARRIOR','Protection','tank']],
    [['Genow','SHAMAN','Elemental','caster_dps'], ['KashPatail','PRIEST','Shadow','caster_dps'], ['Firefly','MAGE','Arcane','caster_dps'], ['Roost','MAGE','Arcane','caster_dps'], ['Azukl','PRIEST','Holy','healer']],
    [['Ohmnath','SHAMAN','Elemental','caster_dps'], ['Daolith','WARLOCK','Destruction','caster_dps'], ['Gnope','WARLOCK','Destruction','caster_dps'], ['Soulavenger','WARLOCK','Affliction','caster_dps'], ['Zzaps','DRUID','Balance','caster_dps']],
    [['Alliesha','PALADIN','Protection','tank'], ['Voctave','SHAMAN','Restoration','healer'], ['kimmjungheal','DRUID','Restoration','healer'], ['Drenna','PALADIN','Holy','healer']],
  ];
  State.groups = layout.map((g, gi) => g.map(([name, cls, spec, role]) => ({ ...mkPlayer(name, cls, spec, role), groupNumber: gi + 1 })));
  State.roster = State.groups.flat();
  State.bench = [{ ...mkPlayer('Originalgoat', 'SHAMAN', 'Enhancement', 'melee_dps'), groupNumber: 0 }];
  State.preferredSlots = [{ group: 4, class: 'PRIEST', spec: 'Discipline', auto: true }, { group: 1, class: 'SHAMAN', spec: 'Enhancement', auto: true }];
  Optimizer.optimize();

  const enh = autoSlots().find(s => s.class === 'SHAMAN' && s.spec === 'Enhancement');
  assert(enh, 'an Enh Shaman is suggested');
  const names = State.groups[enh.group].map(p => p.name).sort().join(',');
  for (const n of ['Therhyme', 'Ceedarius', 'Sanga', 'Hinastorm']) assert(names.includes(n), n + ' rides with the suggested Enh Shaman (G' + (enh.group + 1) + ': ' + names + ')');
  const board = State.groups.map((g, gi) => g.concat(PP.PreferredSlots.forGroup(gi).map(s => ({ class: s.class, spec: s.spec, role: PP.RosterEdit.RoleForSpec(s.class, s.spec), name: '' }))));
  board._roleIdentities = State.groups._roleIdentities;
  board._anchors = State.groups._anchors;
  const total = board.reduce((sum, g, gi) => sum + Optimizer.groupScore(g, gi, board, 'max_dps'), 0);
  assert(total >= 393.05 - 1e-6, 'raid score with the Opens is at least 393.05 (was 374.90), got ' + total.toFixed(2));
  assertEqual(State.bench.map(p => p.name).join(','), 'Originalgoat', 'the benched Enh Shaman stays benched');
});

// A suggestion is priced on a board that never holds more than a party: a
// pick priced in a group of 9 or 10 inflated the specs that pile onto the
// best-buffed group (a short raid lost its Enh/Ele/Shadow picks).
describe('OpenSlots: suggestions are priced on groups of at most five', () => {
  seatForOpenSlots(DPS_14.slice(0, 12));
  const score = Optimizer.groupScore;
  let largest = 0;
  Optimizer.groupScore = function (group, ...rest) { largest = Math.max(largest, group.length); return score.call(this, group, ...rest); };
  try { Optimizer.optimize(); } finally { Optimizer.groupScore = score; }
  assert(autoSlots().length > 0, 'Opens were suggested');
  assert(largest <= 5, 'no group priced past five members (largest ' + largest + ')');
});

// More players and Open slots than the raid seats: the slots give way, a
// signed-up player is never benched for a hypothetical one.
describe('OpenSlots: a full raid drops a manual Open slot, never a real player', () => {
  resetState();
  State.selectedRaid = 'bt';
  State.optimizerMode = 'max_dps';
  State.roster = buildStandard25ManRoster().map(p => ({ ...p, uid: nextUid() }));
  State.groups = [0, 1, 2, 3, 4].map(gi => State.roster.slice(gi * 5, gi * 5 + 5));
  State.groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  State.preferredSlots = [{ group: 0, class: 'PRIEST', spec: 'Discipline' }];
  Optimizer.optimize();
  assertEqual(State.groups.flat().length, 25, 'all 25 players stay seated');
  assertEqual(State.bench.length, 0, 'nobody is benched');
  assertEqual(State.preferredSlots.length, 0, 'the Open slot that no longer fits is dropped');
});

describe('OpenSlots: editing a suggestion makes it the leader\'s own', () => {
  seatForOpenSlots(DPS_14.slice(0, 20));
  const slot = autoSlots()[0];
  assert(PP.PreferredSlots.add(slot.group, 'HUNTER', 'Survival', slot), 'edit accepted');
  assert(!slot.auto, 'no longer a suggestion');
  Optimizer.optimize();
  assert(State.preferredSlots.some(p => !p.auto && p.spec === 'Survival'), 'kept through the next Optimize');
});

describe('OpenSlots: a matching sign-up fills a suggested seat', () => {
  seatForOpenSlots(DPS_14.slice(0, 20));
  const slot = autoSlots()[0];
  const player = { uid: nextUid(), name: 'Joiner', class: slot.class, spec: slot.spec, role: PP.RosterEdit.RoleForSpec(slot.class, slot.spec), groupNumber: 0 };
  State.bench.push(player);
  assert(PP.PreferredSlots.seat(player), 'seated into the Open');
  assertEqual(player.groupNumber, slot.group + 1, 'in the suggested group');
  assert(!State.preferredSlots.includes(slot), 'the Open is consumed');
});

describe('OpenSlots: suggestions do not hijack a fresh import or pin the group order', () => {
  seatForOpenSlots(DPS_14.slice(0, 12));
  assert(autoSlots().length > 0, 'Opens exist');
  const result = Import.importRaidHelper(JSON.stringify({ signUps: [
    { name:'NewTank', className:'Tank', specName:'Protection', id:1 },
    { name:'NewMage', className:'Mage', specName:'Fire', id:2 },
  ]}));
  assert(result.success && !result.preferredImport, 'a new import is a normal import, not "fill the planned layout"');
  assertEqual(PP.PreferredSlots.manual().length, 0, 'no manual slots appeared');
  const capture = PP.PlanStore.capture();
  capture.planId = 'plan:open-test';
  assert(PP.PlanStore.restore(capture), 'plan restores');
  assert(State.preferredSlots.length > 0 && State.preferredSlots.every(p => p.auto), 'suggestions persist as suggestions');
  assert(!State.preserveGroupOrder, 'suggestions alone never pin the group order');
});

describe('OpenSlots: under Classic faction lock a Horde raid is never offered a Paladin', () => {
  const savedVersion = State.gameVersion;
  State.gameVersion = 'classic';
  try {
    const horde = [['WARRIOR','Protection','tank'], ['SHAMAN','Restoration','healer'], ['PRIEST','Holy','healer'],
      ['ROGUE','Combat','melee_dps'], ['MAGE','Fire','caster_dps'], ['WARLOCK','Destruction','caster_dps']];
    seatForOpenSlots(horde, 'mc');
    assert(autoSlots().length === 40 - 6, 'every empty seat in the 40-man gets an Open');
    assert(!State.preferredSlots.some(p => p.class === 'PALADIN'), 'no Paladin for a Horde raid');
    assert(seatsWithOpens().every(n => n === 5), 'all 8 groups end at 5');
  } finally {
    State.gameVersion = savedVersion;
    resetState();
  }
});

// Exercise the actual async UI import controller with isolated storage/network fixtures.
(async () => {
  const vm = require('vm');
  const storage = {data:new Map(),getItem(k){return this.data.get(k)||null;},setItem(k,v){this.data.set(k,v);}};
  let payload = {title:'Fixture event',startTime:1790377200,signUps:[
    {name:'FirstMage',className:'Mage',specName:'Arcane'},
    {name:'SecondMage',className:'Mage',specName:'Fire'}]};
  let lastToast = '';
  const ChangeLog = PP.ChangeLog;
  const context = { State, Import, PlanStore:PP.PlanStore, NO_ROSTER_NAME, ChangeLog,
    localStorage:storage, document:{getElementById(){return {}; }},
    initGroups:()=>0, commit:()=>PP.PlanStore.save(storage,PP.PlanStore.capture()),
    showToast:(m)=>{lastToast=m;}, rememberImport:()=>'', fetchRosterJson:async()=>JSON.stringify(payload) };
  // app.slice throws if a marker is missing, so a renamed function can't silently slice the wrong code.
  const importSrc = app.slice('function normalizeImportSource(','// Fetch roster JSON')
    + app.slice('async function importFromText(',"document.getElementById('btn-refresh').addEventListener");
  vm.createContext(context);
  vm.runInContext(importSrc,context);
  resetState();
  assert(await context.importFromText('123456789'), 'event ID import succeeds');
  assert(State.rosterName.startsWith('Fixture event'), 'event title used');
  assertEqual(State.planId,'event:123456789','canonical event plan created');
  assertEqual(ChangeLog.entries.length,0,'a fresh import is not a logged change');
  assertEqual(State.eventStartTime,1790377200*1000,'event start time is stored with the plan');
  assert(Import.exportChatText().split(String.fromCharCode(10))[0].includes(new Date(1790377200*1000).toLocaleDateString()),'chat export is dated with the event day');
  State.groups.reverse(); State.groups.forEach((g,gi)=>g.forEach(p=>p.groupNumber=gi+1));
  State.roster=State.groups.flat(); State.rosterName='Custom event name';
  PP.PlanStore.save(storage,PP.PlanStore.capture());
  const layout=JSON.stringify(State.groups);
  PP.PlanSession.previous=null; PP.PlanSession.undo=[]; PP.PlanSession.ready=true;
  PP.PlanSession.observe();
  payload.signUps.push({name:'NewMage',className:'Mage',specName:'Frost'});
  payload.startTime=1790550000; // the event was rescheduled
  assert(await context.importFromText('https://raid-helper.dev/event/123456789'), 'same event URL reopens');
  PP.PlanSession.observe();
  assertEqual(JSON.stringify(State.groups),layout,'reimport preserves edited groups');
  assertEqual(State.rosterName,'Custom event name','custom name preserved');
  assertEqual(PP.PlanStore.read(storage).length,1,'same event does not duplicate plan');
  assertEqual(State.bench.map(p=>p.name).join(),'NewMage','reimport pulls the new signup onto the bench without a Refresh click');
  assert(lastToast.startsWith('Reopened your plan: 1 new sign-up'),'reimport toast reports what changed');
  assertEqual(ChangeLog.entries.length,1,'the re-paste sync is logged once');
  assertEqual(ChangeLog.entries[0].kind+':'+ChangeLog.entries[0].items.map(i=>i.kind+' '+i.name+' '+i.detail).join(),'sync:added NewMage added to the bench','the log names the new sign-up');
  assertEqual(PP.PlanStore.read(storage)[0].data.bench.length,1,'merged sign-ups are saved with the plan');
  assertEqual(State.eventStartTime,1790550000*1000,'reopening picks up the rescheduled event start');
  PP.PlanSession.undoLast(); PP.PlanSession.observe();
  assertEqual(State.bench.length,0,'reimport merge can be undone');
  assertEqual(JSON.stringify(State.groups),layout,'undo keeps original layout');
  assert(await context.importFromText('123456789'), 'unchanged event reopens');
  assert(lastToast.startsWith('Reopened your plan. Up to date.'),'unchanged reimport says it is current');
  assertEqual(ChangeLog.entries.length,1,'a sync that changed nothing records nothing');
  // A different event's link must start that event's own plan, even when the
  // open plan has Open-slot requests (which otherwise fill the open layout).
  State.preferredSlots=[{group:1,class:'MAGE',spec:'Fire'}]; State.notes='Friday notes';
  PP.PlanSession.observe();
  payload={id:'987654321',title:'Other event',startTime:1790463600,signUps:[
    {name:'OtherPriest',className:'Priest',specName:'Holy'},
    {name:'OtherRogue',className:'Rogue',specName:'Combat'}]};
  assert(await context.importFromText('https://raid-helper.xyz/event/987654321'), 'other event imports');
  PP.PlanSession.observe();
  assertEqual(State.planId,'event:987654321','other event gets its own plan');
  assertEqual(ChangeLog.entries.length,0,'another event starts with an empty change log');
  assertEqual(State.sourceEventId,'987654321','other event is the linked source');
  assertEqual(State.eventStartTime,1790463600*1000,'other event plan takes its own start time');
  assert(State.rosterName.startsWith('Other event'),'other event plan takes its own title');
  assertEqual([...State.roster,...State.bench].map(p=>p.name).sort().join(),'OtherPriest,OtherRogue','other event roster holds only its sign-ups');
  assertEqual(State.notes,'','other event plan does not inherit notes');
  assertEqual(State.preferredSlots.filter(p=>!p.auto).length,0,'other event plan does not inherit Open-slot requests');
  const firstPlan=PP.PlanStore.read(storage).find(p=>p.data.planId==='event:123456789');
  assertEqual(firstPlan && firstPlan.data.rosterName,'Custom event name','first event plan keeps its name');
  assert(firstPlan && firstPlan.data.groups.flat().every(p=>p.name!=='OtherPriest'),'first event plan keeps its own roster');
  // A leader who only planned Open slots (no linked event) fills them from an event: the date still comes along.
  State.sourceEventId=null; State.eventStartTime=null; State.planId=null; State.rosterName=NO_ROSTER_NAME;
  State.preferredSlots=[{group:0,class:'PRIEST',spec:'Holy'}];
  payload={id:'111222333',title:'Planned event',startTime:1790600000,signUps:[{name:'PlannedPriest',className:'Priest',specName:'Holy'}]};
  assert(await context.importFromText('https://raid-helper.xyz/event/111222333'), 'event fills planned Open slots');
  assertEqual(State.eventStartTime,1790600000*1000,'Open-slot fill stores the event start time');
  assertEqual(ChangeLog.entries.length,1,'filling planned Open slots is a logged sync');
  assert(ChangeLog.entries[0].items.some(i=>i.kind==='added'&&i.name==='PlannedPriest'),'the fill lists who arrived');
  payload.startTime=undefined;
  State.sourceEventId='111222333'; State.planId='event:111222333';
  PP.PlanSession.ready=false;
  console.log(`Results: ${passed} passed, ${failed} failed, ${totalTests} total`);
if (failed === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.log(`${failed} TEST(S) FAILED`);
  process.exit(1);
}

})().catch(error => { console.error(error); process.exitCode=1; });
