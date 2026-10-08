const assert = require('node:assert/strict');
const app = require('./tests/load-app');
app.compileFull(); // Includes UI handlers: catch syntax errors outside core logic.
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Import', 'PlanStore', 'Optimizer', 'getGroupBuffs', 'getMissingBuffInsights', 'enforceRaidCapacity', 'activeRules']);
const {State,Config,GameVersions,Import,PlanStore,Optimizer,getGroupBuffs,getMissingBuffInsights,enforceRaidCapacity,activeRules} = ctx.api;
const storage = {data:{}, getItem(k){return this.data[k] || null;}, setItem(k,v){this.data[k]=v;}};
const players = Array.from({length:40}, (_,i) => ({name:`Fixture${i}`,class:'MAGE',spec:'Frost',role:'caster_dps',groupNumber:Math.floor(i/5)+1}));
for (const version of ['classic','forever','tbc']) {
  const raid = GameVersions[version].defaultRaid;
  assert.equal(Import.loadRoster({gameVersion:version,raid,players,name:version}),true);
  enforceRaidCapacity(State.groups,State.bench,Config.Raids[raid].groups);
  State.roster=State.groups.flat();
  State.planId='event:fixture';
  const snapshot=PlanStore.capture();
  PlanStore.save(storage,snapshot);
  const saved=Import.exportRoster();
  const share=Import.exportShareString();
  State.gameVersion=version==='tbc'?'forever':'tbc';
  assert.equal(Import.importAddonString(share).success,true);
  assert.equal(State.gameVersion,version);
  assert.equal(State.selectedRaid,raid);
  assert.equal(Import.loadRoster(JSON.parse(JSON.stringify(saved))),true);
  assert.equal(State.gameVersion,version);
  assert.equal(PlanStore.restore(snapshot),true);
  assert.equal(State.gameVersion,version);
  if (version === 'forever') {
    // Forever IS modeled (Phase C) — real buffs/debuffs, and Optimizer.optimize()
    // actually runs (an all-Mage roster just has nothing to buff, so it must not throw).
    assert.equal(GameVersions.forever.modeled,true);
    assert(Object.keys(Config.Buffs).length>0);
    assert(Object.keys(Config.Debuffs).length>0);
    Optimizer.optimize();
    assert(State.groups.flat().length<=Config.Raids[State.selectedRaid].size);
  }
  if (version === 'classic') {
    // Classic IS modeled (Phase B) — real buffs/debuffs, and Optimizer.optimize()
    // actually runs (an all-Mage roster just has nothing to buff, so it must not throw).
    assert.equal(GameVersions.classic.modeled,true);
    assert(Object.keys(Config.Buffs).length>0);
    assert(Object.keys(Config.Debuffs).length>0);
    Optimizer.optimize();
    assert(State.groups.flat().length<=Config.Raids[State.selectedRaid].size);
  }
  if (version !== 'tbc') {
    // Legacy classicN/foreverN planning templates stay usable for old saved plans.
    State.selectedRaid=version+'10';
    enforceRaidCapacity(State.groups,State.bench,2);
    assert.equal(State.groups.flat().length,10);
    assert.equal(State.bench.length,30);
    assert.equal(new Set([...State.groups.flat(),...State.bench].map(p=>p.name)).size,40);
    State.selectedRaid=version+'40';
    assert.equal(Import.importRaidHelper(JSON.stringify({signUps:players.map(p=>({name:p.name,className:'Mage',specName:'Frost'}))})).success,true);
    assert.equal(State.roster.length,40);
    assert(State.groups.every(g=>g.length<=5));
    State.selectedRaid=version+'10';
    Import.importRaidHelper(JSON.stringify({signUps:players.map(p=>({name:p.name,className:'Mage',specName:'Frost'}))}));
    assert.equal(State.roster.length,10);
    assert.equal(State.bench.length,30);
  }
}
assert.equal(PlanStore.read(storage).length,3,'same event remains separate by version');
const before=JSON.stringify(State);
assert.equal(Import.loadRoster({gameVersion:'unknown',raid:'bt',players:[]}),false);
assert.equal(Import.loadRoster({gameVersion:'forever',raid:'bt',players:[]}),false);
assert.equal(JSON.stringify(State),before,'invalid imports are non-mutating');
State.gameVersion='forever';
assert.equal(Import.loadRoster({raid:'bt',players:players.slice(0,5)}),true);
assert.equal(State.gameVersion,'tbc','old saves default to TBC');
assert(Object.keys(Config.Buffs).length>0);
State.planId='legacy-fixture';
const legacy=PlanStore.capture(); delete legacy.gameVersion;
State.gameVersion='forever';
assert.equal(PlanStore.restore(legacy),true);
assert.equal(State.gameVersion,'tbc');

// Every real GameVersion (tbc/classic/forever) now has a ruleset, but the
// registry's empty-ruleset fallback (Rulesets[version] || EMPTY_RULESET)
// still exists for any future unmodeled version — cover it directly since no
// shipped version exercises that branch anymore.
const savedVersion=State.gameVersion;
State.gameVersion='some-future-unmodeled-version';
const empty=activeRules();
assert.equal(Object.keys(empty.buffs).length,0);
assert.equal(Object.keys(empty.debuffs).length,0);
assert.equal(Object.keys(empty.rules).length,0);
assert.equal(empty.idealComp,null);
State.gameVersion=savedVersion;

console.log('Version tests passed: saves, shares, migration, isolated rules, imports, capacity, event separation, empty-ruleset fallback.');
