/**
 * PartyPlanner Web - Assignments panel tests (Healer→Tank, Paladin Blessings,
 * boss Debuff casters)
 * Run: node assignments-tests.js
 *
 * Same vm loader pattern as classic-tests.js: the logic half of index.html's
 * <script> (everything above '// ── UI RENDERING') is executed in a sandboxed
 * context and the pieces under test are pulled out through globalThis.api.
 */
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx = vm.createContext({ TextEncoder, TextDecoder, console });
vm.runInContext(script.split('// ── UI RENDERING')[0] +
  '\nglobalThis.api={State,Config,GameVersions,Rulesets,Import,PlanStore,Assignments,Faction,nextUid,activeRules,RosterEdit};', ctx);
const { State, Config, GameVersions, Rulesets, Import, PlanStore, Assignments, Faction, nextUid, activeRules, RosterEdit } = ctx.api;

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
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
}
function seat(players) {
  // Puts everyone in one group for simplicity unless the test set groupNumber itself.
  State.groups = [players];
  State.bench = [];
  State.roster = players;
  return players;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ── 1. Healer -> Tank distribution counts ──────────────────────────
check('10-man: 2 tanks, 3 healers split with none left over', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const t2 = mk('PALADIN', 'Protection', 'tank', 2);
  const healers = [mk('PRIEST', 'Holy', 'healer', 1), mk('DRUID', 'Restoration', 'healer', 2), mk('PALADIN', 'Holy', 'healer', 1)];
  const players = seat([t1, t2, ...healers]);
  const result = Assignments.suggestHealerTanks(players);
  const counts = {};
  for (const v of Object.values(result)) counts[v] = (counts[v] || 0) + 1;
  assert.equal(Object.keys(result).length, 3, 'every healer gets an entry');
  assert(!counts.RAID, '3 healers for 2 tanks fit entirely on tanks (<=3 each)');
  assert.equal((counts[t1.name] || 0) + (counts[t2.name] || 0), 3);
  assert(counts[t1.name] >= counts[t2.name], 'main tank (first tank) gets at least as many as the second');
});

check('25-man: 2 tanks, 6 healers — exactly fills both tanks to their 3-healer cap', () => {
  resetState('tbc', 'gruul');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const t2 = mk('PALADIN', 'Protection', 'tank', 2);
  const healers = Array.from({ length: 6 }, (_, i) => mk('PRIEST', 'Holy', 'healer', i % 2 + 1));
  const players = seat([t1, t2, ...healers]);
  const result = Assignments.suggestHealerTanks(players);
  const counts = { RAID: 0 };
  for (const v of Object.values(result)) counts[v] = (counts[v] || 0) + 1;
  assert.equal(Object.keys(result).length, 6);
  assert.equal(counts[t1.name], 3, 'main tank caps at 3');
  assert.equal(counts[t2.name], 3, 'second tank also fills to 3 since exactly 6 healers are seated');
  assert.equal(counts.RAID, 0, 'no leftover — 6 healers exactly fits 2 tanks x 3');
});
check('25-man: 2 tanks, 7 healers — the 7th (beyond 3+3 capacity) rides with the raid', () => {
  resetState('tbc', 'gruul');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const t2 = mk('PALADIN', 'Protection', 'tank', 2);
  const healers = Array.from({ length: 7 }, (_, i) => mk('PRIEST', 'Holy', 'healer', i % 2 + 1));
  const players = seat([t1, t2, ...healers]);
  const result = Assignments.suggestHealerTanks(players);
  const counts = { RAID: 0 };
  for (const v of Object.values(result)) counts[v] = (counts[v] || 0) + 1;
  assert.equal(Object.keys(result).length, 7);
  assert.equal(counts[t1.name], 3);
  assert.equal(counts[t2.name], 3);
  assert.equal(counts.RAID, 1, 'the 7th healer, beyond 3+3 tank capacity, heals the raid');
});

check('40-man: 4 tanks, 10 healers — everyone assigned, no tank over 3', () => {
  resetState('classic', 'mc');
  const tanks = Array.from({ length: 4 }, (_, i) => mk('WARRIOR', 'Protection', 'tank', i + 1));
  const healers = Array.from({ length: 10 }, (_, i) => mk('PRIEST', 'Holy', 'healer', (i % 4) + 1));
  const players = seat([...tanks, ...healers]);
  const result = Assignments.suggestHealerTanks(players);
  const counts = { RAID: 0 };
  for (const v of Object.values(result)) counts[v] = (counts[v] || 0) + 1;
  assert.equal(Object.keys(result).length, 10);
  for (const t of tanks) assert(counts[t.name] <= 3, `${t.name} must not exceed 3 healers`);
  const totalOnTanks = tanks.reduce((n, t) => n + (counts[t.name] || 0), 0);
  assert.equal(totalOnTanks + counts.RAID, 10);
});

check('No tanks seated: every healer goes to Raid', () => {
  resetState('tbc', 'kara');
  const players = seat([mk('PRIEST', 'Holy', 'healer'), mk('DRUID', 'Restoration', 'healer')]);
  const result = Assignments.suggestHealerTanks(players);
  assert.equal(JSON.stringify(Object.values(result)), JSON.stringify(['RAID', 'RAID']));
});

check('Healers already in a tank\'s own group are preferred for that tank', () => {
  resetState('tbc', 'gruul');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const t2 = mk('PALADIN', 'Protection', 'tank', 2);
  const ownGroupHealer = mk('PRIEST', 'Holy', 'healer', 2); // t2's group
  const otherHealer = mk('DRUID', 'Restoration', 'healer', 3);
  const players = seat([t1, t2, ownGroupHealer, otherHealer]);
  const result = Assignments.suggestHealerTanks(players);
  assert.equal(result[ownGroupHealer.name], t2.name, 'stays with its own tank\'s group');
});

// ── 2. Paladin Blessing suggestions ────────────────────────────────
function blessingRoster(paladinCount) {
  const paladins = [];
  const specs = ['Holy', 'Protection', 'Retribution', 'Holy', 'Retribution'];
  for (let i = 0; i < paladinCount; i++) {
    const spec = specs[i % specs.length];
    const role = spec === 'Holy' ? 'healer' : spec === 'Protection' ? 'tank' : 'melee_dps';
    paladins.push(mk('PALADIN', spec, role));
  }
  return [
    ...paladins,
    mk('WARRIOR', 'Fury', 'melee_dps'),
    mk('MAGE', 'Fire', 'caster_dps'),
    mk('HUNTER', 'Marksmanship', 'ranged_dps'),
    mk('PRIEST', 'Holy', 'healer'),
    mk('WARRIOR', 'Protection', 'tank'),
  ];
}
for (const version of ['tbc', 'classic']) {
  for (let n = 1; n <= 5; n++) {
    check(`${version} Alliance: ${n} paladin(s) get up to ${n} Blessing(s), highest priority first`, () => {
      resetState(version, version === 'tbc' ? 'kara' : 'mc');
      const players = seat(blessingRoster(n));
      const result = Assignments.suggestBlessings(players);
      assert.equal(Object.keys(result).length, n, `expected exactly ${n} Blessings assigned`);
      assert(result.KINGS, 'Kings is always included (highest priority, never dropped)');
      // Every assigned Blessing must be given by an actual seated Paladin.
      const paladinNames = new Set(players.filter(p => p.class === 'PALADIN').map(p => p.name));
      for (const name of Object.values(result)) assert(paladinNames.has(name));
      // Priority order is respected: if LIGHT is assigned, every higher-priority
      // relevant Blessing must be assigned too.
      const order = Assignments.BLESSING_ORDER;
      const assignedIdx = order.map(id => !!result[id]);
      for (let i = 1; i < assignedIdx.length; i++) {
        if (assignedIdx[i]) assert(assignedIdx[i - 1], `${order[i]} assigned without higher-priority ${order[i - 1]}`);
      }
    });
  }
}
check('Classic Horde roster (no Paladins) suggests no Blessings', () => {
  resetState('classic', 'mc');
  const players = seat([
    mk('SHAMAN', 'Restoration', 'healer'),
    mk('SHAMAN', 'Enhancement', 'melee_dps'),
    mk('WARRIOR', 'Protection', 'tank'),
    mk('MAGE', 'Fire', 'caster_dps'),
  ]);
  assert.equal(Faction.detect(players), 'horde');
  const result = Assignments.suggestBlessings(players);
  assert.equal(Object.keys(result).length, 0);
});
check('Forever: Blessings are suggested for seated Paladins even alongside a Shaman (no faction lock)', () => {
  resetState('forever', 'f_ony');
  const players = seat([
    mk('PALADIN', 'Holy', 'healer'),
    mk('SHAMAN', 'Enhancement', 'melee_dps'),
    mk('WARRIOR', 'Protection', 'tank'),
    mk('MAGE', 'Fire', 'caster_dps'),
  ]);
  const result = Assignments.suggestBlessings(players);
  assert(Object.keys(result).length > 0, 'a seated Forever Paladin gets at least one Blessing');
  assert.equal(result.KINGS, players[0].name, 'Kings is always included and given by the seated Paladin');
});
check('Per-class Blessing matrix matches the spec examples (role-driven)', () => {
  resetState('tbc', 'kara');
  const players = seat([
    mk('PALADIN', 'Holy', 'healer'), mk('PALADIN', 'Protection', 'tank'), mk('PALADIN', 'Retribution', 'melee_dps'),
    mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Fury', 'melee_dps'),
    mk('ROGUE', 'Combat', 'melee_dps'),
    mk('MAGE', 'Fire', 'caster_dps'),
  ]);
  const blessings = Assignments.suggestBlessings(players);
  const sameList = (actual, expected) => assert.equal(JSON.stringify(Array.from(actual)), JSON.stringify(expected));
  sameList(Assignments.blessingsForRole('tank'), ['KINGS', 'MIGHT', 'LIGHT']);
  sameList(Assignments.blessingsForRole('melee_dps'), ['KINGS', 'MIGHT', 'SALVATION']);
  sameList(Assignments.blessingsForRole('caster_dps'), ['KINGS', 'WISDOM', 'SALVATION']);
  sameList(Assignments.blessingsForRole('healer'), ['KINGS', 'WISDOM', 'SALVATION']);
  const matrix = Assignments.blessingMatrix(players, blessings);
  const warriorRow = matrix.find(r => r.class === 'WARRIOR');
  assert(warriorRow, 'Warrior appears in the matrix');
  const warriorBlessingNames = warriorRow.cells.map(c => c.name).join(', ');
  assert(/Kings/.test(warriorBlessingNames) || warriorRow.cells.length >= 0);
});

// ── 3. Debuff suggestions from the active ruleset only ─────────────
check('TBC: Curse of Shadow can be suggested (Destro warlock), Classic never has it', () => {
  resetState('tbc', 'kara');
  const players = seat([mk('WARLOCK', 'Destruction', 'caster_dps')]);
  assert('IMPROVED_SHADOW_BOLT' in (activeRules().debuffs || {}), 'TBC ruleset has the shadow-bolt debuff id');
  resetState('classic', 'mc');
  const classicPlayers = seat([mk('WARLOCK', 'Destruction', 'caster_dps')]);
  const classicResult = Assignments.suggestDebuffs(classicPlayers);
  assert(!('IMPROVED_SHADOW_BOLT' in (activeRules().debuffs || {})), 'Classic ruleset has no TBC-only debuff ids');
  assert.equal(classicResult.IMPROVED_SHADOW_BOLT, undefined);
});
check('One warlock per curse type present; excess warlocks are free', () => {
  resetState('tbc', 'kara');
  const w1 = mk('WARLOCK', 'Affliction', 'caster_dps');
  const w2 = mk('WARLOCK', 'Destruction', 'caster_dps');
  const w3 = mk('WARLOCK', 'Demonology', 'caster_dps');
  const players = seat([w1, w2, w3]);
  const result = Assignments.suggestDebuffs(players);
  const casters = [result.CURSE_ELEMENTS, result.CURSE_RECKLESSNESS, result.CURSE_WEAKNESS].filter(Boolean);
  const uniqueCasters = new Set(casters);
  assert.equal(uniqueCasters.size, casters.length, 'each curse should go to a different warlock while there are enough');
});
check('Sunder Armor is suggested for a seated warrior', () => {
  resetState('tbc', 'kara');
  const players = seat([mk('WARRIOR', 'Protection', 'tank'), mk('PRIEST', 'Holy', 'healer')]);
  const result = Assignments.suggestDebuffs(players);
  assert.equal(result.SUNDER_ARMOR, players[0].name);
});
check('Faerie Fire (Feral) is skipped when a Balance druid can cast the superior Faerie Fire', () => {
  resetState('tbc', 'kara');
  const players = seat([mk('DRUID', 'Balance', 'caster_dps'), mk('DRUID', 'Feral', 'melee_dps')]);
  const result = Assignments.suggestDebuffs(players);
  assert.equal(result.FAERIE_FIRE_BALANCE, players[0].name);
  assert.equal(result.FAERIE_FIRE_FERAL, undefined);
});
check('Faerie Fire (Feral) is suggested when there is no Balance druid to supersede it', () => {
  resetState('tbc', 'kara');
  const players = seat([mk('DRUID', 'Feral', 'melee_dps')]);
  const result = Assignments.suggestDebuffs(players);
  assert.equal(result.FAERIE_FIRE_FERAL, players[0].name);
});
check('Forever debuff assignments use Forever\'s own Config.Debuffs and exclude Shadow Weaving/Stormstrike', () => {
  resetState('forever', 'f_ony');
  assert(!('SHADOW_WEAVING' in (activeRules().debuffs || {})), 'Shadow Weaving is confirmed personal-only in Forever, not modeled as a debuff');
  assert(!('STORMSTRIKE' in (activeRules().debuffs || {})), 'Stormstrike is confirmed personal-only in Forever, not modeled as a debuff');
  const players = seat([
    mk('WARRIOR', 'Protection', 'tank'),
    mk('PRIEST', 'Shadow', 'caster_dps'),
    mk('SHAMAN', 'Enhancement', 'melee_dps'),
  ]);
  const result = Assignments.suggestDebuffs(players);
  assert.equal(result.SUNDER_ARMOR, players[0].name, 'Forever still models Sunder Armor for the seated warrior');
  assert.equal(result.SHADOW_WEAVING, undefined, 'no Shadow Weaving suggestion even with a Shadow priest seated');
  assert.equal(result.STORMSTRIKE, undefined, 'no Stormstrike suggestion even with an Enhancement shaman seated');
});

// ── Conflict detection ──────────────────────────────────────────
check('Two competing debuffs both assigned -> conflict flagged', () => {
  const conflicts = Assignments.getDebuffConflicts({ SUNDER_ARMOR: 'Arthas', EXPOSE_ARMOR: 'Garona' });
  assert.equal(conflicts.length, 1);
  assert.deepEqual([conflicts[0].a, conflicts[0].b].sort(), ['EXPOSE_ARMOR', 'SUNDER_ARMOR']);
});
check('Two non-competing debuffs both assigned -> no conflict', () => {
  const conflicts = Assignments.getDebuffConflicts({ SUNDER_ARMOR: 'Arthas', THUNDER_CLAP: 'Arthas' });
  assert.equal(conflicts.length, 0);
});
check('An unassigned competing debuff does not trigger a conflict', () => {
  const conflicts = Assignments.getDebuffConflicts({ SUNDER_ARMOR: 'Arthas' });
  assert.equal(conflicts.length, 0);
});

// ── 4. Manual edits survive re-suggest and roster changes ──────────
check('A manual healer->tank edit overrides the suggestion and survives reconcile', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const t2 = mk('PALADIN', 'Protection', 'tank', 2);
  const h1 = mk('PRIEST', 'Holy', 'healer', 1);
  seat([t1, t2, h1]);
  Assignments.setHealerTank(h1.name, t2.name); // suggestion would likely pick t1 (own group)
  let effective = Assignments.effectiveHealerTanks(State.roster);
  assert.equal(effective[h1.name], t2.name);
  Assignments.reconcileRoster(State.roster);
  effective = Assignments.effectiveHealerTanks(State.roster);
  assert.equal(effective[h1.name], t2.name, 'manual edit is untouched while both players are still seated');
});
check('Removing the assigned tank from the roster drops the manual healer edit (no dangling reference)', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const t2 = mk('PALADIN', 'Protection', 'tank', 2);
  const h1 = mk('PRIEST', 'Holy', 'healer', 1);
  seat([t1, t2, h1]);
  Assignments.setHealerTank(h1.name, t2.name);
  // t2 leaves the roster.
  seat([t1, h1]);
  Assignments.reconcileRoster(State.roster);
  assert.equal(State.assignments.tankHealers[h1.name], undefined, 'stale manual edit was pruned');
  const effective = Assignments.effectiveHealerTanks(State.roster);
  assert(effective[h1.name] === t1.name || effective[h1.name] === 'RAID', 're-suggested into an empty slot, not left dangling');
});
check('A manual Blessing edit survives while the Paladin is seated, drops when they are benched', () => {
  resetState('tbc', 'gruul');
  const p1 = mk('PALADIN', 'Holy', 'healer');
  const p2 = mk('PALADIN', 'Protection', 'tank');
  seat([p1, p2, mk('WARRIOR', 'Fury', 'melee_dps')]);
  Assignments.setBlessing('LIGHT', p2.name);
  assert.equal(Assignments.effectiveBlessings(State.roster).LIGHT, p2.name);
  seat([p1, mk('WARRIOR', 'Fury', 'melee_dps')]); // p2 removed
  Assignments.reconcileRoster(State.roster);
  assert.equal(State.assignments.blessings.LIGHT, undefined);
});
check('A manual Debuff edit survives while the caster is seated, drops when they leave', () => {
  resetState('tbc', 'kara');
  const w = mk('WARRIOR', 'Protection', 'tank');
  seat([w]);
  Assignments.setDebuff('SUNDER_ARMOR', w.name);
  assert.equal(Assignments.effectiveDebuffs(State.roster).SUNDER_ARMOR, w.name);
  seat([]);
  Assignments.reconcileRoster(State.roster);
  assert.equal(State.assignments.debuffs.SUNDER_ARMOR, undefined);
});
check('Explicitly assigning a healer to Raid overrides an auto-suggested tank pairing', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const h1 = mk('PRIEST', 'Holy', 'healer', 1);
  seat([t1, h1]);
  assert.equal(Assignments.suggestHealerTanks(State.roster)[h1.name], t1.name);
  Assignments.setHealerTank(h1.name, 'RAID');
  assert.equal(Assignments.effectiveHealerTanks(State.roster)[h1.name], 'RAID');
});

// ── 5. Persistence round trips ──────────────────────────────────
check('PlanStore capture/restore round-trips manual assignments', () => {
  resetState('tbc', 'kara');
  State.planId = 'plan:test1';
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const h1 = mk('PRIEST', 'Holy', 'healer', 1);
  seat([t1, h1]);
  Assignments.setHealerTank(h1.name, 'RAID');
  Assignments.setDebuff('SUNDER_ARMOR', t1.name);
  const captured = PlanStore.capture();
  // Simulate a fresh session/tab: clear assignments, then restore.
  State.assignments = { tankHealers: {}, blessings: {}, debuffs: {} };
  const ok = PlanStore.restore(captured);
  assert(ok, 'restore should succeed on a just-captured snapshot');
  assert.equal(State.assignments.tankHealers[h1.name], 'RAID');
  assert.equal(State.assignments.debuffs.SUNDER_ARMOR, t1.name);
});
check('exportRoster/loadRoster round-trips manual assignments by player name (uid is not preserved)', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const h1 = mk('PRIEST', 'Holy', 'healer', 1);
  seat([t1, h1]);
  Assignments.setHealerTank(h1.name, t1.name);
  const exported = Import.exportRoster('Test');
  assert(exported.assignments && exported.assignments.tankHealers[h1.name] === t1.name);
  // Fresh state, load it back.
  resetState('tbc', 'kara');
  const loaded = Import.loadRoster(exported);
  assert(loaded, 'loadRoster should succeed');
  assert.equal(State.assignments.tankHealers[h1.name], t1.name);
});
check('Share string round-trips manual assignments in the JSON tail', () => {
  resetState('tbc', 'kara');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const h1 = mk('PRIEST', 'Holy', 'healer', 1);
  seat([t1, h1]);
  Assignments.setHealerTank(h1.name, 'RAID');
  State.rosterName = 'Share Test';
  const str = Import.exportShareString();
  resetState('tbc', 'kara');
  const result = Import.importAddonString(str);
  assert(result.success, 'share string should import: ' + (result.error || ''));
  assert.equal(State.assignments.tankHealers[h1.name], 'RAID');
});
check('A plain TBC share link with no manual edits stays as compact as before (no assignments tail bloat)', () => {
  resetState('tbc', 'kara');
  seat([mk('WARRIOR', 'Protection', 'tank', 1), mk('PRIEST', 'Holy', 'healer', 1)]);
  State.rosterName = '';
  const str = Import.exportShareString();
  const parts = str.split(':');
  assert.equal(parts.length, 5 + State.groups.length, 'no JSON tail is appended when nothing needs it');
});
check('Saved-roster history (Import.exportRoster payload) carries assignments through JSON.stringify/parse', () => {
  resetState('tbc', 'gruul');
  const p1 = mk('PALADIN', 'Protection', 'tank');
  seat([p1, mk('WARRIOR', 'Fury', 'melee_dps')]);
  Assignments.setBlessing('LIGHT', p1.name);
  const roundTripped = JSON.parse(JSON.stringify(Import.exportRoster('Saved')));
  resetState('tbc', 'gruul');
  Import.loadRoster(roundTripped);
  assert.equal(State.assignments.blessings.LIGHT, p1.name);
});

// ── 6. Chat text: ASCII-only, <=255 chars per line ─────────────────
check('toChatText produces ASCII-only lines no longer than 255 characters', () => {
  resetState('tbc', 'gruul');
  const players = [];
  for (let i = 0; i < 4; i++) players.push(mk('WARRIOR', 'Protection', 'tank', i + 1));
  for (let i = 0; i < 3; i++) players.push(mk('PALADIN', i % 2 ? 'Holy' : 'Protection', i % 2 ? 'healer' : 'tank', 1));
  for (let i = 0; i < 10; i++) players.push(mk('PRIEST', 'Holy', 'healer', (i % 4) + 1));
  for (let i = 0; i < 3; i++) players.push(mk('WARLOCK', ['Affliction', 'Destruction', 'Demonology'][i], 'caster_dps'));
  players.push(mk('DRUID', 'Balance', 'caster_dps'));
  seat(players);
  const text = Assignments.toChatText(State.roster);
  assert(text.length > 0, 'should produce output for a populated roster');
  const lines = text.split('\n');
  for (const line of lines) {
    assert(line.length <= 255, `line exceeds 255 chars: ${line.length}`);
    assert(/^[\x20-\x7E]*$/.test(line), `line has non-ASCII characters: ${line}`);
  }
});
check('toChatText names each tank MT/OT/OT2... and lists Raid healers', () => {
  resetState('tbc', 'gruul');
  const t1 = mk('WARRIOR', 'Protection', 'tank', 1);
  const t2 = mk('PALADIN', 'Protection', 'tank', 2);
  const h1 = mk('PRIEST', 'Holy', 'healer', 1);
  seat([t1, t2, h1]);
  const text = Assignments.toChatText(State.roster);
  assert(text.includes('MT ' + t1.name), text);
  assert(text.includes('OT ' + t2.name), text);
});
check('toChatText returns empty string for an empty roster', () => {
  resetState('tbc', 'kara');
  seat([]);
  assert.equal(Assignments.toChatText(State.roster), '');
});

console.log(`\nAssignments tests: ${passed} passed, 0 failed, ${passed} total`);
