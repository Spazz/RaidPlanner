/**
 * PartyPlanner Web - Roster test scenarios
 *
 * Each scenario is a Raid-Helper style sign-up list expressed as [specKey, name, status?]
 * tuples. toRaidHelperJson() turns one into the exact JSON shape Raid-Helper's API
 * returns (signUps with className/specName), so scenarios exercise the real importer.
 *
 * Sources
 *   wowraidforge  - the 46 dev "Load test roster" scenarios shipped in wowraidforge.com's
 *                   bundle (extracted 2026-09-03, emoji stripped from labels)
 *   tbc25         - 50 hand-designed TBC 25-man guild rosters (T01-T50, 2026-10-10) with composition
 *                   expectations from the user's reference comp
 *   partyplanner  - our own additions covering what that list leaves out: 10-man raids,
 *                   Bench sign-ups, unknown specs, realm suffixes, duplicate names,
 *                   floors at the edge, empty/absence-only imports, big overflow
 *
 * Optional per-scenario fields
 *   raid    - raid key to select before import (default: the app's current selection,
 *             which the importer switches to a 10-man automatically for <= 10 raiders)
 *   expect  - see scenario-tests.js: { importFails, unplaced, benched, seated, raidSize,
 *             minHealersSeated, tentativeBenched, feralGroups, windfuryGroups, missingNone: [buffId],
 *             composition keys (max_dps only unless compModes): compModes, together, apart, mixedDpsGroups,
 *             huntersInCasterGroups, tankGroup, suggested, suggestedCount, benchHas, localOptimum
 *             (selectors: specKey | 'class:HUNTER' | 'role:healer'; details in scenario-tests.js header)
 *             knownGap: 'text' (documents current behaviour we consider a gap; shown in the summary) }
 *             A nested object keyed by optimizer mode (max_dps, tank_mit, balanced, relaxed)
 *             overrides the shared values for that mode only.
 *
 * Loaded by scenario-tests.js (node) and by index.html when opened with ?dev (browser).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.PPScenarios = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// specKey -> [Raid-Helper className, Raid-Helper specName]
const SPEC_KEYS = {
  druidTank:   ['Tank', 'Guardian'],
  warriorTank: ['Tank', 'Protection'],
  palaTank:    ['Tank', 'Protection1'],
  arms:        ['Warrior', 'Arms'],
  fury:        ['Warrior', 'Fury'],
  feral:       ['Druid', 'Feral'],
  balance:     ['Druid', 'Balance'],
  restoD:      ['Druid', 'Restoration'],
  dreamstate:  ['Druid', 'Dreamstate'],
  combat:      ['Rogue', 'Combat'],
  assassin:    ['Rogue', 'Assassination'],
  sub:         ['Rogue', 'Subtlety'],
  retPala:     ['Paladin', 'Retribution'],
  holyPala:    ['Paladin', 'Holy1'],
  bm:          ['Hunter', 'Beastmastery'],
  mm:          ['Hunter', 'Marksmanship'],
  sv:          ['Hunter', 'Survival'],
  shadow:      ['Priest', 'Shadow'],
  holyP:       ['Priest', 'Holy'],
  disc:        ['Priest', 'Discipline'],
  arcane:      ['Mage', 'Arcane'],
  fire:        ['Mage', 'Fire'],
  frost:       ['Mage', 'Frost'],
  affli:       ['Warlock', 'Affliction'],
  demo:        ['Warlock', 'Demonology'],
  destro:      ['Warlock', 'Destruction'],
  enh:         ['Shaman', 'Enhancement'],
  ele:         ['Shaman', 'Elemental'],
  restoS:      ['Shaman', 'Restoration1'],
  // Not real: exercise the importer's fallback paths.
  unknownSpec:  ['Warrior', 'Gladiator'],      // known class, unknown spec -> seated by class
  unknownClass: ['Deathknight', 'Blood'],      // unknown class and spec -> unplaced
};

// status: 'primary' (default) | 'tentative' | 'bench' | 'absence'
// Raid-Helper carries these in className and, for Absence, has no spec at all.
function signUp(key, name, status, index) {
  const def = SPEC_KEYS[key];
  if (!def) throw new Error('Unknown spec key: ' + key);
  const [className, specName] = def;
  const entry = { id: 100000 + index, userId: String(100000 + index), name, position: index };
  if (status === 'absence') { entry.className = 'Absence'; entry.specName = 'Absence'; }
  else if (status === 'tentative') { entry.className = 'Tentative'; entry.specName = specName; }
  else if (status === 'bench') { entry.className = 'Bench'; entry.specName = specName; }
  else { entry.className = className; entry.specName = specName; }
  return entry;
}

function toRaidHelperJson(scenario) {
  return {
    title: scenario.label,
    date: '03-09-2026',
    templateId: 'wowtbc',
    signUps: scenario.entries.map(([key, name, status], i) => signUp(key, name, status, i + 1)),
  };
}

// Convenience for our own scenarios: n copies of a spec with numbered names.
function many(key, base, n, status) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(status ? [key, base + i, status] : [key, base + i]);
  return out;
}

const CORE_25 = [
  ['warriorTank','Shieldwall'], ['palaTank','Reyn'],
  ['enh','Windcaller'], ['ele','Ronii'], ['restoS','Tidecrest'], ['restoS','Toms'],
  ['arms','Sunra'], ['fury','Ragefist'], ['feral','Ashwolf'], ['combat','Yow'], ['retPala','Cromer'],
  ['bm','Beastmode'], ['bm','Relapse'], ['mm','Arrowhead'],
  ['shadow','Treshflay'], ['demo','Doomfire'], ['destro','Felstorm'], ['affli','Poena'],
  ['balance','Kerne'], ['arcane','Syba'], ['fire','Pyroblast'],
  ['holyP','Greedius'], ['holyPala','Azuraab'], ['restoD','Sheimz'], ['disc','Mendel'],
];
const KARA_10 = [
  ['warriorTank','Shieldwall'], ['feral','Ashwolf'],
  ['holyP','Greedius'], ['holyPala','Azuraab'], ['restoS','Tidecrest'],
  ['enh','Windcaller'], ['combat','Yow'], ['bm','Beastmode'], ['destro','Felstorm'], ['arcane','Syba'],
];

const scenarios = [
  { id: 'F01', source: 'wowraidforge', label: "Balanced Ideal 25 - man",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Beastmode"], ["bm","Relapse"], ["mm","Arrowhead"], ["sv","Trapper"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["balance","Kerne"], ["arcane","Syba"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["restoD","Sheimz"]],
    // design: localOptimum must hold under the de-isolation rule (2026-10-10): swaps that would leave a caster alone in a melee group (Trapper<->Greedius isolating Doomfire) are not improvements.
    expect: { localOptimum: true } },
  { id: 'F02', source: 'wowraidforge', label: "Balanced 2 Shadow Priests",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Pybz"], ["ele","Ronii"], ["restoS","Sté"], ["arms","Sunra"], ["fury","Holyfire"], ["feral","Ashwolf"], ["combat","Yow"], ["retPala","Cromer"], ["bm","Courgette"], ["bm","Yum"], ["sv","Khartor"], ["shadow","Treshflay"], ["shadow","Mindweaver"], ["demo","Femscout"], ["destro","MrCam"], ["affli","Poena"], ["balance","Kerne"], ["arcane","Syba"], ["fire","Pyroblast"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["restoD","Sheimz"], ["restoS","Toms"]] },
  { id: 'F03', source: 'wowraidforge', label: "Balanced Alt comp (no feral)",
    entries: [["warriorTank","Shieldwall"], ["palaTank","Reyn"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["arms","Sunra"], ["arms","Bladestorm"], ["fury","Ragefist"], ["fury","Ironbreaker"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["frost","Icebolt"], ["holyP","Greedius"], ["holyP","Sanctus"], ["holyPala","Azuraab"], ["restoD","Sheimz"], ["restoS","Toms"]] },
  { id: 'F04', source: 'wowraidforge', label: "Exact Reproduction roster rel",
    entries: [["enh","Pybz/Dodz"], ["affli","femscout"], ["druidTank","Shouna"], ["combat","Yow"], ["shadow","treshflay"], ["restoD","Sheimz"], ["arcane","Syba"], ["fury","Holyfire"], ["retPala","Cromer"], ["destro","Poena"], ["feral","Ashwolf"], ["balance","Kerne"], ["restoS","Toms⛷️"], ["sv","Khartor/Minko"], ["palaTank","Reyn"], ["enh","Klyaksah"], ["restoS","Sté"], ["bm","Courgette"], ["ele","Ronii"], ["arms","Sunra"], ["bm","Yum"], ["destro","MrCam"], ["bm","Relapse"], ["holyPala","Azuraab/Ashkaz"], ["holyP","Greedìus","tentative"], ["arcane","Möoncake/Kelolon","tentative"]] },
  { id: 'F05', source: 'wowraidforge', label: "Melee Heavy Warriors & Rogues",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["enh","Stormbrew"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Holyrad"], ["arms","Sunra"], ["arms","Bladestorm"], ["fury","Ragefist"], ["fury","Ironbreaker"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["combat","Shadowstep"], ["assassin","Nightblade"], ["assassin","Toxin"], ["retPala","Cromer"], ["retPala","Judgement"], ["bm","Relapse"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"], ["holyP","Greedius"], ["disc","Sanctus"]] },
  { id: 'F06', source: 'wowraidforge', label: "Melee Heavy Double Guardian Tank",
    entries: [["druidTank","Bearwick"], ["druidTank","Grizzhide"], ["enh","Windcaller"], ["enh","Stormbrew"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Holyrad"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["balance","Kerne"], ["arcane","Syba"], ["holyP","Greedius"], ["disc","Sanctus"], ["restoS","Toms"]] },
  { id: 'F07', source: 'wowraidforge', label: "Triple Feral (3 LotP)",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Holyrad"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["feral","Wildclaw"], ["combat","Yow"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["balance","Kerne"], ["arcane","Syba"], ["holyP","Greedius"], ["disc","Sanctus"], ["restoS","Toms"]] },
  { id: 'F08', source: 'wowraidforge', label: "Triple Enhancement Shaman",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["enh","Stormbrew"], ["enh","Thunderfist"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Holyrad"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["holyP","Greedius"], ["disc","Sanctus"], ["ele","Ronii"]] },
  { id: 'F09', source: 'wowraidforge', label: "Caster Heavy 5 Mages",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Holyrad"], ["holyP","Greedius"], ["arms","Sunra"], ["feral","Ashwolf"], ["combat","Yow"], ["shadow","Treshflay"], ["shadow","Mindweaver"], ["arcane","Syba"], ["arcane","Möoncake"], ["fire","Pyroblast"], ["fire","Infernal"], ["frost","Icebolt"], ["demo","Doomfire"], ["demo","Demonia"], ["destro","Felstorm"], ["destro","MrCam"], ["affli","Femscout"], ["balance","Kerne"], ["restoS","Toms"]] },
  { id: 'F10', source: 'wowraidforge', label: "Caster Heavy 4 Warlocks Demo",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Holyrad"], ["holyP","Greedius"], ["arms","Sunra"], ["feral","Ashwolf"], ["shadow","Treshflay"], ["demo","Doomfire"], ["demo","Demonia"], ["demo","Felmaster"], ["demo","Soulcrush"], ["destro","Felstorm"], ["affli","Femscout"], ["affli","Cursecaster"], ["arcane","Syba"], ["fire","Pyroblast"], ["frost","Icebolt"], ["balance","Kerne"], ["disc","Sanctus"], ["restoS","Toms"], ["bm","Relapse"]] },
  { id: 'F11', source: 'wowraidforge', label: "Caster Heavy 3 Balance Druids",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Holyrad"], ["holyP","Greedius"], ["arms","Sunra"], ["feral","Ashwolf"], ["shadow","Treshflay"], ["balance","Kerne"], ["balance","Stardancer"], ["balance","Lunaris"], ["demo","Doomfire"], ["destro","Felstorm"], ["affli","Femscout"], ["arcane","Syba"], ["fire","Pyroblast"], ["frost","Icebolt"], ["disc","Sanctus"], ["restoS","Toms"], ["combat","Yow"], ["retPala","Cromer"], ["bm","Relapse"]] },
  { id: 'F12', source: 'wowraidforge', label: "6 Healers (over - healed)",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["ele","Ronii"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["holyP","Greedius"], ["holyP","Sanctus"], ["holyPala","Azuraab"], ["holyPala","Lightbringer"], ["restoD","Sheimz"], ["restoD","Moondew"], ["restoS","Tidecrest"], ["restoS","Toms"], ["disc","Holyspam"]] },
  { id: 'F13', source: 'wowraidforge', label: "All Druid Healers",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["ele","Ronii"], ["restoD","Sheimz"], ["restoD","Moondew"], ["restoD","Leafsong"], ["dreamstate","Dreamer"], ["dreamstate","Stardew"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["holyP","Greedius"], ["mm","Arrowhead"], ["assassin","Nightblade"], ["fire","Pyroblast"]] },
  { id: 'F14', source: 'wowraidforge', label: "Only 4 Healers",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["ele","Ronii"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["sv","Trapper"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["fire","Pyroblast"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["restoD","Sheimz"], ["disc","Sanctus"]] },
  { id: 'F15', source: 'wowraidforge', label: "Only 3 Healers",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["ele","Ronii"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["sv","Trapper"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["fire","Pyroblast"], ["affli","Femscout"], ["holyP","Greedius"], ["restoD","Sheimz"], ["disc","Sanctus"]] },
  { id: 'F16', source: 'wowraidforge', label: "Zero Tanks",
    entries: [["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["enh","Windcaller"], ["ele","Ronii"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["fire","Pyroblast"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["restoD","Sheimz"], ["restoS","Toms"], ["disc","Sanctus"], ["affli","Femscout"], ["frost","Icebolt"]] },
  { id: 'F17', source: 'wowraidforge', label: "Single Tank Only",
    entries: [["druidTank","Bearwick"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["fire","Pyroblast"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["restoD","Sheimz"], ["disc","Sanctus"], ["affli","Femscout"]] },
  { id: 'F18', source: 'wowraidforge', label: "4 Tanks (2W + 2P)",
    entries: [["warriorTank","Shieldwall"], ["warriorTank","Ironwall"], ["palaTank","Reyn"], ["palaTank","Fortify"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyP","Greedius"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["retPala","Cromer"], ["bm","Relapse"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["disc","Sanctus"], ["affli","Femscout"], ["fire","Pyroblast"], ["holyPala","Azuraab"]] },
  { id: 'F19', source: 'wowraidforge', label: "No Shaman (no Bloodlust/Windfury)",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["affli","Femscout"], ["arcane","Syba"], ["fire","Pyroblast"], ["balance","Kerne"], ["holyP","Greedius"], ["holyP","Sanctus"], ["holyPala","Azuraab"], ["restoD","Sheimz"], ["restoD","Moondew"], ["disc","Spellspam"]] },
  { id: 'F20', source: 'wowraidforge', label: "No Warlocks (no Curse of Elements)",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["arcane","Syba"], ["arcane","Möoncake"], ["fire","Pyroblast"], ["fire","Infernal"], ["frost","Icebolt"], ["balance","Kerne"], ["disc","Sanctus"]] },
  { id: 'F21', source: 'wowraidforge', label: "No Druids (no Mark of the Wild)",
    entries: [["warriorTank","Shieldwall"], ["palaTank","Reyn"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoS","Toms"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["disc","Sanctus"], ["arms","Sunra"], ["fury","Ragefist"], ["fury","Ironbreaker"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["fire","Pyroblast"], ["affli","Femscout"]] },
  { id: 'F22', source: 'wowraidforge', label: "No Mage (no Arcane Intellect)",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["shadow","Mindweaver"], ["demo","Doomfire"], ["destro","Felstorm"], ["affli","Femscout"], ["balance","Kerne"], ["disc","Sanctus"]] },
  { id: 'F23', source: 'wowraidforge', label: "No Warriors (no Battle Shout)",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["disc","Sanctus"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["retPala","Judgement"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["affli","Femscout"]] },
  { id: 'F24', source: 'wowraidforge', label: "No Enhancement Shaman (no Windfury)",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["ele","Ronii"], ["ele","Stormcaller"], ["restoS","Tidecrest"], ["restoS","Toms"], ["restoD","Leafsong"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["mm","Arrowhead"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["disc","Sanctus"], ["affli","Femscout"]] },
  { id: 'F25', source: 'wowraidforge', label: "Small Roster 15 players",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyP","Greedius"], ["arms","Sunra"], ["feral","Ashwolf"], ["combat","Yow"], ["bm","Relapse"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"], ["balance","Kerne"]] },
  { id: 'F26', source: 'wowraidforge', label: "Micro Roster 10 players",
    entries: [["druidTank","Bearwick"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["holyP","Greedius"], ["arms","Sunra"], ["feral","Ashwolf"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"]] },
  { id: 'F27', source: 'wowraidforge', label: "Overflow 30 players (bench test)",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["palaTank","Reyn"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoS","Toms"], ["restoD","Leafsong"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["disc","Sanctus"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["bm","Yum"], ["mm","Arrowhead"], ["sv","Trapper"], ["shadow","Treshflay"], ["shadow","Mindweaver"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"]] },
  { id: 'F28', source: 'wowraidforge', label: "Huge Roster 38 players (big bench)",
    entries: [["druidTank","Bearwick"], ["druidTank","Grizzhide"], ["warriorTank","Shieldwall"], ["palaTank","Reyn"], ["palaTank","Fortify"], ["enh","Windcaller"], ["enh","Stormbrew"], ["enh","Thunderfist"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoS","Toms"], ["restoD","Leafsong"], ["restoD","Sheimz"], ["holyP","Greedius"], ["holyP","Sanctus"], ["holyPala","Azuraab"], ["disc","Spellspam"], ["arms","Sunra"], ["arms","Bladestorm"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["combat","Shadowstep"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["bm","Yum"], ["mm","Arrowhead"], ["sv","Trapper"], ["shadow","Treshflay"], ["demo","Doomfire"], ["demo","Felmaster"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["affli","Femscout"]] },
  { id: 'F29', source: 'wowraidforge', label: "All Tentative 25 players",
    entries: [["druidTank","Bearwick","tentative"], ["warriorTank","Shieldwall","tentative"], ["enh","Windcaller","tentative"], ["ele","Ronii","tentative"], ["restoS","Tidecrest","tentative"], ["restoD","Leafsong","tentative"], ["holyP","Greedius","tentative"], ["holyPala","Azuraab","tentative"], ["disc","Sanctus","tentative"], ["arms","Sunra","tentative"], ["fury","Ragefist","tentative"], ["feral","Ashwolf","tentative"], ["feral","Thornpaw","tentative"], ["combat","Yow","tentative"], ["assassin","Nightblade","tentative"], ["retPala","Cromer","tentative"], ["bm","Relapse","tentative"], ["bm","Courgette","tentative"], ["mm","Arrowhead","tentative"], ["shadow","Treshflay","tentative"], ["demo","Doomfire","tentative"], ["destro","Felstorm","tentative"], ["arcane","Syba","tentative"], ["balance","Kerne","tentative"], ["affli","Femscout","tentative"]],
    expect: { raidSize: 25, seated: 0, benched: 25, tentativeBenched: 25 } },
  { id: 'F30', source: 'wowraidforge', label: "Mixed 18 primary + 10 tentative",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["bm","Relapse"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"], ["holyP","Greedius"], ["restoD","Sheimz"], ["holyPala","Azuraab"], ["destro","MrCam"], ["balance","Kerne"], ["feral","Thornpaw","tentative"], ["enh","Stormbrew","tentative"], ["mm","Arrowhead","tentative"], ["disc","Sanctus","tentative"], ["affli","Femscout","tentative"], ["bm","Courgette","tentative"], ["retPala","Cromer","tentative"], ["frost","Icebolt","tentative"], ["restoS","Toms","tentative"], ["palaTank","Reyn","tentative"]] },
  { id: 'F31', source: 'wowraidforge', label: "Tentative fills role gaps",
    entries: [["druidTank","Bearwick"], ["enh","Windcaller"], ["ele","Ronii"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["bm","Relapse"], ["bm","Courgette"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["affli","Femscout"], ["warriorTank","Shieldwall","tentative"], ["holyP","Greedius","tentative"], ["holyP","Sanctus","tentative"], ["holyPala","Azuraab","tentative"], ["restoD","Sheimz","tentative"], ["restoS","Toms","tentative"], ["fire","Pyroblast","tentative"], ["frost","Icebolt","tentative"], ["disc","Spellspam","tentative"], ["retPala","Cromer","tentative"], ["mm","Arrowhead","tentative"], ["sv","Trapper","tentative"]] },
  { id: 'F32', source: 'wowraidforge', label: "All Hunters Guild 20 BM Hunters",
    entries: [["druidTank","TankInAGuildOfHunters"], ["restoS","ShamanPeacekeeper"], ["restoS","HealsThemAll"], ["restoD","DruidMama"], ["holyP","OnlyHealerISwear"], ["bm","Beastmode"], ["bm","Petmaster"], ["bm","Relapse"], ["bm","Courgette"], ["bm","Yum"], ["bm","Petwhisperer"], ["bm","Archerboy"], ["bm","Featherhands"], ["bm","Wolflover"], ["bm","Quiverfull"], ["bm","Snipez"], ["bm","HunterHarold"], ["bm","Trapmaster"], ["bm","Beastlord"], ["bm","Huntress"], ["bm","Arrowhead"], ["bm","Bowmaster"], ["bm","FluffyArrows"], ["bm","CritChance"], ["mm","MMNotBM"]] },
  { id: 'F33', source: 'wowraidforge', label: "All Mages Raid",
    entries: [["druidTank","TankInMageGuild"], ["palaTank","ThePaladinSuffer"], ["restoS","ShamanForBL"], ["restoS","Manaspring"], ["holyPala","WisdomBot"], ["holyP","FortitudeGiver"], ["arcane","Syba"], ["arcane","Möoncake"], ["arcane","Arcaneek"], ["arcane","Spellsteal"], ["arcane","Blinky"], ["fire","Pyroblast"], ["fire","Infernal"], ["fire","Scorch"], ["fire","Fireball"], ["fire","Combustion"], ["frost","Icebolt"], ["frost","Frostbolt"], ["frost","Blizzard"], ["frost","IcyVeins"], ["frost","ShatterPoint"], ["frost","ColdSnap"], ["arcane","Evocation"], ["fire","DragonBreath"], ["frost","Winterchill"]] },
  { id: 'F34', source: 'wowraidforge', label: "Warlock Apocalypse 12 Warlocks",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["demo","Doomfire"], ["demo","Demonia"], ["demo","Felmaster"], ["demo","Soulcrush"], ["destro","Felstorm"], ["destro","MrCam"], ["destro","Hellfire"], ["destro","Shadowbolt"], ["affli","Femscout"], ["affli","Cursecaster"], ["affli","Dotvomit"], ["affli","Plague"], ["shadow","Treshflay"], ["arcane","Syba"], ["balance","Kerne"], ["arms","Sunra"], ["combat","Yow"]] },
  { id: 'F35', source: 'wowraidforge', label: "Paladin Supremacy 8 Paladins",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["palaTank","Fortify"], ["enh","Windcaller"], ["ele","Ronii"], ["arms","Sunra"], ["feral","Ashwolf"], ["combat","Yow"], ["bm","Relapse"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"], ["balance","Kerne"], ["holyPala","Azuraab"], ["holyPala","Lightbringer"], ["holyPala","Holyrad"], ["holyPala","Divinia"], ["retPala","Cromer"], ["retPala","Judgement"], ["retPala","Crusader"], ["restoD","Sheimz"], ["restoS","Toms"], ["disc","Sanctus"], ["frost","Icebolt"], ["affli","Femscout"]] },
  { id: 'F36', source: 'wowraidforge', label: "Druid Council 8 Druids",
    entries: [["druidTank","Bearwick"], ["druidTank","Grizzhide"], ["enh","Windcaller"], ["ele","Ronii"], ["palaTank","Reyn"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["feral","Wildclaw"], ["balance","Kerne"], ["balance","Stardancer"], ["restoD","Sheimz"], ["restoD","Leafsong"], ["restoD","Moondew"], ["dreamstate","Dreamer"], ["arms","Sunra"], ["combat","Yow"], ["bm","Relapse"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"], ["restoS","Toms"], ["disc","Sanctus"], ["fury","Ragefist"]] },
  { id: 'F37', source: 'wowraidforge', label: "Shaman Paradise 6 Shamans",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["enh","Stormbrew"], ["enh","Thunderfist"], ["ele","Ronii"], ["ele","Stormcaller"], ["restoS","Tidecrest"], ["restoS","Toms"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["combat","Yow"], ["retPala","Cromer"], ["bm","Relapse"], ["bm","Courgette"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["arcane","Syba"], ["balance","Kerne"], ["disc","Sanctus"], ["affli","Femscout"]] },
  { id: 'F38', source: 'wowraidforge', label: "No DPS Tanks & Healers Only",
    entries: [["druidTank","Bearwick"], ["druidTank","Grizzhide"], ["warriorTank","Shieldwall"], ["warriorTank","Ironwall"], ["palaTank","Reyn"], ["holyP","Greedius"], ["holyP","Sanctus"], ["holyP","Blessings"], ["holyPala","Azuraab"], ["holyPala","Lightbringer"], ["restoD","Sheimz"], ["restoD","Leafsong"], ["restoD","Moondew"], ["restoS","Tidecrest"], ["restoS","Toms"], ["disc","Sanctus2"], ["disc","Spellspam"], ["dreamstate","Dreamer"], ["dreamstate","Stardew"], ["ele","Ronii"], ["enh","Windcaller"], ["enh","Stormbrew"], ["restoS","Wavecrest"], ["holyP","Loophole"], ["holyPala","Crusader"]] },
  { id: 'F39', source: 'wowraidforge', label: "Absences Test 8 absences in roster",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["arms","Sunra"], ["feral","Ashwolf"], ["combat","Yow"], ["bm","Relapse"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"], ["balance","Kerne"], ["disc","Sanctus"], ["fury","Ragefist"], ["fury","Absentee1","absence"], ["bm","Absentee2","absence"], ["arcane","Absentee3","absence"], ["restoS","Absentee4","absence"], ["arms","Absentee5","absence"], ["feral","Absentee6","absence"], ["palaTank","Absentee7","absence"], ["shadow","Absentee8","absence"]] },
  { id: 'F40', source: 'wowraidforge', label: "Perfect Buff Coverage",
    entries: [["druidTank","Bearwick"], ["palaTank","Reyn"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["restoD","Sheimz"], ["holyPala","Azuraab"], ["disc","Sanctus"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["bm","Relapse"], ["shadow","Treshflay"], ["demo","Doomfire"], ["arcane","Syba"], ["balance","Kerne"], ["retPala","Cromer"], ["mm","Arrowhead"], ["sv","Trapper"], ["holyP","Greedius"], ["affli","Femscout"], ["restoS","Toms"]] },
  { id: 'F41', source: 'wowraidforge', label: "Optimal Melee Comp",
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["enh","Stormbrew"], ["restoS","Tidecrest"], ["restoD","Leafsong"], ["holyPala","Azuraab"], ["holyP","Greedius"], ["disc","Sanctus"], ["arms","Sunra"], ["arms","Bladestorm"], ["fury","Ragefist"], ["fury","Ironbreaker"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["combat","Shadowstep"], ["assassin","Nightblade"], ["retPala","Cromer"], ["retPala","Judgement"], ["bm","Relapse"], ["bm","Courgette"], ["shadow","Treshflay"], ["demo","Doomfire"], ["balance","Kerne"]] },
  { id: 'F42', source: 'wowraidforge', label: "Optimal Caster Comp",
    entries: [["warriorTank","Shieldwall"], ["palaTank","Reyn"], ["enh","Windcaller"], ["ele","Ronii"], ["ele","Stormcaller"], ["restoS","Tidecrest"], ["restoS","Toms"], ["restoD","Sheimz"], ["holyPala","Azuraab"], ["disc","Sanctus"], ["arms","Sunra"], ["feral","Ashwolf"], ["shadow","Treshflay"], ["shadow","Mindweaver"], ["demo","Doomfire"], ["demo","Demonia"], ["destro","Felstorm"], ["affli","Femscout"], ["arcane","Syba"], ["arcane","Möoncake"], ["fire","Pyroblast"], ["frost","Icebolt"], ["balance","Kerne"], ["balance","Stardancer"], ["combat","Yow"]] },
  { id: 'F43', source: 'wowraidforge', label: "Edge 1 Player",
    entries: [["druidTank","LonelyTank"]] },
  { id: 'F44', source: 'wowraidforge', label: "Edge Only Healers (no DPS/Tanks)",
    entries: [["holyP","Healer1"], ["holyP","Healer2"], ["holyP","Healer3"], ["holyPala","Healer4"], ["restoD","Healer5"], ["restoD","Healer6"], ["restoS","Healer7"], ["restoS","Healer8"], ["disc","Healer9"], ["dreamstate","Healer10"]] },
  { id: 'F45', source: 'wowraidforge', label: "Edge Only Rogues (12 Rogues)",
    entries: [["combat","Backstab1"], ["combat","Backstab2"], ["combat","Backstab3"], ["assassin","Poison1"], ["assassin","Poison2"], ["assassin","Poison3"], ["combat","Slice1"], ["assassin","Eviscerate1"], ["combat","Sap1"], ["combat","Ambush1"], ["assassin","Garrote1"], ["combat","Gouge1"]] },
  { id: 'F46', source: 'wowraidforge', label: "Dual Enh + Feral + Battle Shout spread (10 players)",
    entries: [["enh","Chamelio"], ["enh","Chamelio2"], ["druidTank","Bearwall"], ["feral","Thornpaw"], ["fury","Ragefist"], ["arms","Bladestorm"], ["combat","Yow"], ["bm","Relapse"], ["bm","Courgette"], ["bm","Petgap"]] },

  // ── Our additions ─────────────────────────────────────────────
  { id: 'P01', source: 'partyplanner', label: 'Karazhan - textbook 10 (2 tanks, 3 healers)',
    entries: KARA_10, expect: { raidSize: 10, seated: 10, benched: 0 } },
  { id: 'P02', source: 'partyplanner', label: 'Karazhan - 12 sign-ups, 2 benched',
    raid: 'kara', entries: KARA_10.concat([['fury','Ragefist'], ['mm','Arrowhead']]),
    expect: { raidSize: 10, seated: 10, benched: 2 } },
  { id: 'P03', source: 'partyplanner', label: "Zul'Aman - 3 tanks, 2 healers (below healer floor)",
    raid: 'za', entries: [['warriorTank','Shieldwall'], ['palaTank','Reyn'], ['druidTank','Bearwick'],
      ['holyP','Greedius'], ['restoS','Tidecrest'], ['enh','Windcaller'], ['combat','Yow'], ['bm','Beastmode'], ['destro','Felstorm'], ['arcane','Syba']],
    expect: { raidSize: 10, seated: 10, benched: 0 } },
  { id: 'P04', source: 'partyplanner', label: '10-man from 25 sign-ups (15 benched, floors kept)',
    raid: 'kara', entries: CORE_25, expect: { raidSize: 10, seated: 10, benched: 15 } },
  { id: 'P05', source: 'partyplanner', label: 'Bench sign-ups (Raid-Helper Bench class) stay benched',
    entries: CORE_25.slice(0, 22).concat([['fury','Benchwarrior','bench'], ['holyP','Benchpriest','bench'], ['arcane','Benchmage','bench']]),
    expect: { seated: 22, benched: 3 } },
  { id: 'P06', source: 'partyplanner', label: 'Unknown class is held unplaced, not seated',
    entries: CORE_25.slice(0, 24).concat([['unknownClass','Arthas']]),
    expect: { seated: 24, unplaced: 1 } },
  { id: 'P17', source: 'partyplanner', label: 'Unknown spec on a known class is seated by class',
    entries: CORE_25.slice(0, 24).concat([['unknownSpec','Gladiatus']]),
    expect: { seated: 25, unplaced: 0 } },
  { id: 'P07', source: 'partyplanner', label: 'Realm-suffixed and duplicate names',
    entries: CORE_25.map(([k, n], i) => [k, i % 3 === 0 ? n + '-Whitemane' : (i % 7 === 0 ? 'Sunra' : n)]),
    expect: { seated: 25 } },
  { id: 'P08', source: 'partyplanner', label: 'Exactly 5 healers with 25 sign-ups (under floor, all seated)',
    entries: CORE_25.slice(0, 24), expect: { seated: 24, benched: 0 } },
  { id: 'P09', source: 'partyplanner', label: '9 healers in 30 sign-ups (floor met, surplus judged on value)',
    entries: CORE_25.concat([['holyP','Extra1'], ['restoD','Extra2'], ['holyPala','Extra3'], ['restoS','Extra4'], ['disc','Extra5']]),
    expect: { seated: 25, benched: 5, minHealersSeated: 6 } },
  { id: 'P10', source: 'partyplanner', label: 'Empty sign-up list',
    entries: [], expect: { importFails: true } },
  { id: 'P11', source: 'partyplanner', label: 'Only absences',
    entries: many('arms', 'Gone', 6, 'absence'), expect: { importFails: true } },
  { id: 'P12', source: 'partyplanner', label: 'Tentative healers cannot cover a missing healer floor',
    entries: CORE_25.slice(0, 21).concat([['holyP','Maybe1','tentative'], ['restoD','Maybe2','tentative'], ['restoS','Maybe3','tentative']]),
    expect: { seated: 21, benched: 3, tentativeBenched: 3 } },
  { id: 'P13', source: 'partyplanner', label: '40 sign-ups (15 benched)',
    entries: CORE_25.concat(many('fury', 'Fury', 5), many('arcane', 'Mage', 5), many('bm', 'Hunter', 5)),
    expect: { seated: 25, benched: 15 } },
  { id: 'P14', source: 'partyplanner', label: 'Seven tanks, one healer',
    entries: [['warriorTank','T1'], ['warriorTank','T2'], ['palaTank','T3'], ['palaTank','T4'], ['druidTank','T5'], ['druidTank','T6'], ['warriorTank','T7'], ['holyP','Solo']]
      .concat(many('fury', 'Fury', 9), many('destro', 'Lock', 8)),
    expect: { seated: 25, benched: 0 } },
  { id: 'P15', source: 'partyplanner', label: 'Three Enhancement + six Rogues (WF demand exceeds providers)',
    entries: [['warriorTank','Shieldwall'], ['palaTank','Reyn'], ['enh','E1'], ['enh','E2'], ['enh','E3'],
      ['combat','R1'], ['combat','R2'], ['assassin','R3'], ['sub','R4'], ['combat','R5'], ['assassin','R6'],
      ['fury','Ragefist'], ['arms','Sunra'], ['bm','Beastmode'], ['bm','Relapse'],
      ['destro','Felstorm'], ['arcane','Syba'], ['shadow','Treshflay'], ['balance','Kerne'],
      ['holyP','Greedius'], ['holyPala','Azuraab'], ['restoD','Sheimz'], ['restoS','Tidecrest'], ['restoS','Toms'], ['disc','Mendel']],
    // Max DPS spreads all three shamans; the mitigation-weighted modes may pair one with the tanks.
    expect: { seated: 25, windfuryGroups: 2, max_dps: { windfuryGroups: 3 } } },
  { id: 'P16', source: 'partyplanner', label: 'Single Feral tank among 25 (tank-role Feral rides with melee)',
    entries: [['druidTank','Bearwick'], ['palaTank','Reyn']].concat(CORE_25.slice(2)),
    expect: { seated: 25, feralGroups: 2 } },

  // design: 1 tank, 5 healers, 10 physical, 9 casters, M=2; physical fills the 2 melee groups exactly (10 seats), casters+2 healers fill the 2 caster groups, tank group = Prot + 3-4 healers (+ Aff overflow), so every key holds.
  { id: 'T01', source: 'tbc25', label: 'T01 reference comp as 25 sign-ups',
    entries: [
      ['feral', 'Lunaclaw'], ['feral', 'Thornpaw'], ['enh', 'Stormbrew'], ['enh', 'Windcaller'], ['retPala', 'Dawnbringer'],
      ['arms', 'Gorehowl'], ['fury', 'Brakkar'], ['combat', 'Shadowstep'], ['bm', 'Arrowhead'], ['sv', 'Trapper'],
      ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'], ['destro', 'Emberlash'],
      ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['palaTank', 'Ironaegis'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 2, feralGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['feral', 1], ['enh', 1], ['class:SHAMAN', 1], ['class:HUNTER', 1]] } },

  // design: 1 tank, 5 healers, 10 physical (Enh -> Assassination), 9 casters, M=2; one Enh only, so the second melee group can get WF only from a Resto/Ele at the price of one mixed group; hence mixedDpsGroups<=1 and windfuryGroups>=1. hunters may stack (fewer than 2 Enh)
  { id: 'T02', source: 'tbc25', label: 'T02 reference with one Enh swapped for Assassination',
    entries: [
      ['feral', 'Lunaclaw'], ['feral', 'Thornpaw'], ['enh', 'Stormbrew'], ['assassin', 'Nightblade'], ['retPala', 'Dawnbringer'],
      ['arms', 'Gorehowl'], ['fury', 'Brakkar'], ['combat', 'Shadowstep'], ['bm', 'Arrowhead'], ['sv', 'Trapper'],
      ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'], ['destro', 'Emberlash'],
      ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['palaTank', 'Ironaegis'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 1, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 1, feralGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['feral', 1], ['class:SHAMAN', 1]] } },

  // design: 1 tank, 5 healers, 10 physical (Enh -> second Fury and Assassination), 9 casters, M=2; shamans are Ele + 2 Resto, so rule 1 lets one cover a melee group (cost: at most one mixed group); no Enh exists so no Ret-Enh pairing is asserted. Hunters are not held apart: with 0 Enh on the board they may stack (2026-10-10 decision, hunter spread only applies with 2+ Enh).
  { id: 'T03', source: 'tbc25', label: 'T03 reference with no Enh shaman',
    entries: [
      ['feral', 'Mistfang'], ['feral', 'Bramblehide'], ['assassin', 'Nightblade'], ['fury', 'Skullsplit'], ['retPala', 'Dawnbringer'],
      ['arms', 'Gorehowl'], ['fury', 'Brakkar'], ['combat', 'Shadowstep'], ['bm', 'Arrowhead'], ['sv', 'Trapper'],
      ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'], ['destro', 'Emberlash'],
      ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['palaTank', 'Ironaegis'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 1, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 1, feralGroups: 2,
      apart: [['feral', 1], ['class:SHAMAN', 1]] } },

  // design: 1 tank, 5 healers, 10 physical (Arms -> second Ret), 9 casters, M=2; 2 Enh + 2 Ret fill the 2 melee groups one pair each, 5 per group exactly as the reference.
  { id: 'T04', source: 'tbc25', label: 'T04 two Ret Paladins, each with an Enh',
    entries: [
      ['feral', 'Lunaclaw'], ['feral', 'Thornpaw'], ['enh', 'Stormbrew'], ['enh', 'Windcaller'], ['retPala', 'Dawnbringer'],
      ['retPala', 'Truthseeker'], ['fury', 'Brakkar'], ['combat', 'Shadowstep'], ['bm', 'Arrowhead'], ['sv', 'Trapper'],
      ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'], ['destro', 'Emberlash'],
      ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['palaTank', 'Ironaegis'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 2, feralGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['retPala', 1], ['enh', 1], ['feral', 1], ['class:SHAMAN', 1], ['class:HUNTER', 1]] } },

  // design: 1 tank, 5 healers, 10 physical (Ret -> second Arms), 9 casters, M=2; no Ret to pair, so the melee groups only need Feral + Enh + hunter each.
  { id: 'T05', source: 'tbc25', label: 'T05 no Ret Paladin, two Arms',
    entries: [
      ['feral', 'Lunaclaw'], ['feral', 'Thornpaw'], ['enh', 'Stormbrew'], ['enh', 'Windcaller'], ['arms', 'Bladestorm'],
      ['arms', 'Gorehowl'], ['fury', 'Brakkar'], ['combat', 'Shadowstep'], ['bm', 'Arrowhead'], ['sv', 'Trapper'],
      ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'], ['destro', 'Emberlash'],
      ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['palaTank', 'Ironaegis'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 2, feralGroups: 2,
      apart: [['feral', 1], ['enh', 1], ['class:SHAMAN', 1], ['class:HUNTER', 1]] } },

  // design: 2 tanks (Prot Pal + Feral bear), 5 healers, 9 physical (2 Feral cats), 9 casters, M=2; melee seats 10 = 9 physical + 1 slot; three Ferals cannot all sit apart in 2 melee groups, so one Feral sits outside the melee groups. Legal resolutions: the bear rides in the tank group (Prot + bear + 3 healers; spare melee slot takes a healer, no mixed group) or a cat sits in a caster group (one mixed group); hence mixedDpsGroups<=1, and feralGroups 3 is asserted only in max_dps (other modes may seat the bear in melee).
  { id: 'T06', source: 'tbc25', label: 'T06 three Ferals (bear tank + two cats)',
    entries: [
      ['feral', 'Lunaclaw'], ['feral', 'Thornpaw'], ['druidTank', 'Grizzlemaw'], ['enh', 'Stormbrew'], ['enh', 'Windcaller'],
      ['retPala', 'Dawnbringer'], ['arms', 'Gorehowl'], ['fury', 'Brakkar'], ['bm', 'Arrowhead'], ['sv', 'Trapper'],
      ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'], ['destro', 'Emberlash'],
      ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['palaTank', 'Ironaegis'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 1, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 2, max_dps: { feralGroups: 3 },
      together: [['retPala', 'enh']],
      apart: [['feral', 1], ['enh', 1], ['class:HUNTER', 1]] } },

  // design: 2 tanks (Prot Pal + Prot Warrior), 5 healers, 9 physical (no Feral), 9 casters, M=2; the warrior tank fills the 10th melee seat, Prot Pal + 3 healers + Aff form the tank group, Holy Priest + Resto Shaman join 8 casters, so every seat count closes.
  { id: 'T07', source: 'tbc25', label: 'T07 no Feral, two Prot tanks, extra Rogue',
    entries: [
      ['enh', 'Stormbrew'], ['enh', 'Windcaller'], ['retPala', 'Dawnbringer'], ['arms', 'Gorehowl'], ['fury', 'Brakkar'],
      ['combat', 'Shadowstep'], ['assassin', 'Nightblade'], ['bm', 'Arrowhead'], ['sv', 'Trapper'], ['warriorTank', 'Shieldwall'],
      ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'], ['destro', 'Emberlash'],
      ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['palaTank', 'Ironaegis'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['enh', 1], ['class:SHAMAN', 1], ['class:HUNTER', 1]] } },

  // design: 3 tanks (Prot Warrior, Prot Pal, Feral bear), 6 healers, 8 physical (1 Feral cat), 8 casters, M=2; melee seats 10 = 8 physical + warrior tank + bear, the tank group takes Prot Pal + 3-4 healers (+ Aff), remaining healers + casters fill 10 caster seats. the second Enh rides with the tanks and hunters, which want Grace of Air, so one Windfury group
  { id: 'T08', source: 'tbc25', label: 'T08 three tanks and six healers',
    entries: [
      ['warriorTank', 'Shieldwall'], ['palaTank', 'Ironaegis'], ['druidTank', 'Grizzlemaw'], ['feral', 'Lunaclaw'], ['enh', 'Stormbrew'],
      ['enh', 'Windcaller'], ['retPala', 'Dawnbringer'], ['fury', 'Brakkar'], ['combat', 'Shadowstep'], ['bm', 'Arrowhead'],
      ['sv', 'Trapper'], ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'],
      ['destro', 'Emberlash'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'], ['holyP', 'Lightmend'],
      ['disc', 'Penitent'], ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 6, mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 1, feralGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['enh', 1], ['feral', 1], ['class:SHAMAN', 1], ['class:HUNTER', 1]] } },

  // design: 2 tanks, 8 healers (2 Holy Priest, Disc, 2 Holy Pal, Resto Druid, 2 Resto Shaman), 8 physical, 7 casters, M=2; tank group takes Prot Pal + 3-4 healers (4th healer or Aff is the only guest), the surplus healers sit in DPS groups (Holy Priests beside the 2 Shadow Priests) without making a group mixed; Prot Warrior fills melee seat 10. hunters may stack (fewer than 2 Enh)
  { id: 'T09', source: 'tbc25', label: 'T09 two tanks and eight healers',
    entries: [
      ['palaTank', 'Ironaegis'], ['warriorTank', 'Shieldwall'], ['holyP', 'Lightmend'], ['holyP', 'Prayerbind'], ['disc', 'Penitent'],
      ['holyPala', 'Sunhealer'], ['holyPala', 'Beaconlight'], ['restoD', 'Barkskin'], ['restoS', 'Tidecaller'], ['restoS', 'Earthmender'],
      ['feral', 'Lunaclaw'], ['enh', 'Stormbrew'], ['retPala', 'Dawnbringer'], ['arms', 'Gorehowl'], ['fury', 'Brakkar'],
      ['combat', 'Shadowstep'], ['bm', 'Arrowhead'], ['sv', 'Trapper'], ['arcane', 'Frostweave'], ['arcane', 'Spellwright'],
      ['shadow', 'Voidmind'], ['shadow', 'Mindflay'], ['destro', 'Hellscream'], ['destro', 'Emberlash'], ['affli', 'Rotcurse'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 8, mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 1, feralGroups: 1,
      together: [['retPala', 'enh'], ['holyP', 'shadow']],
      apart: [['class:SHAMAN', 1]] } },

  // design: 2 tanks (Prot Pal + Prot Warrior), 5 healers, 9 physical (2 hunters), 9 casters = 18 DPS, M=2; warrior tank fills melee seat 10, so melee groups hold exactly the physical DPS and caster groups hold casters + 1-2 healers: no group needs to mix. hunters may stack (fewer than 2 Enh)
  { id: 'T10', source: 'tbc25', label: 'T10 two tanks and five healers, 18 DPS',
    entries: [
      ['palaTank', 'Ironaegis'], ['warriorTank', 'Shieldwall'], ['holyPala', 'Sunhealer'], ['restoD', 'Barkskin'], ['restoS', 'Tidecaller'],
      ['holyP', 'Lightmend'], ['disc', 'Penitent'], ['feral', 'Lunaclaw'], ['feral', 'Thornpaw'], ['enh', 'Stormbrew'],
      ['retPala', 'Dawnbringer'], ['arms', 'Gorehowl'], ['fury', 'Brakkar'], ['combat', 'Shadowstep'], ['bm', 'Arrowhead'],
      ['mm', 'Longshot'], ['arcane', 'Frostweave'], ['arcane', 'Spellwright'], ['shadow', 'Voidmind'], ['destro', 'Hellscream'],
      ['destro', 'Emberlash'], ['destro', 'Cindervow'], ['ele', 'Thundermaw'], ['balance', 'Moonwhisper'], ['affli', 'Rotcurse'],
    ],
    expect: { seated: 25, benched: 0, minHealersSeated: 5, mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true, windfuryGroups: 1, feralGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['feral', 1], ['class:SHAMAN', 1]] } },

// design: 2 tanks / 6 healers / P=9 (4 hunters, 2 Enh, 2 cat, 1 Fury) / C=8, M=round(36/17)=2. Melee seats 10 = 9 physical + Prot Warrior; caster seats 10 = 8 casters + 2 healers, so the fit is exact and 0 hunters in caster groups is achievable. Windfury is asserted for 1 group only: Ferals and hunters value no Windfury, so only the group with Fury is guaranteed to credit it. Single Resto Shaman: placement is an open decision.
{ id: 'T11', source: 'tbc25', label: 'T11 Hunter-heavy: 4 hunters, 2 Enh, 2 Feral',
  entries: [['palaTank','Aldrimar'], ['warriorTank','Stonebrow'],
    ['holyPala','Seraphine'], ['restoS','Tidewalker'], ['restoD','Mossgrove'], ['holyP','Lumina'], ['holyP','Candlewick'], ['disc','Mendara'],
    ['bm','Arrowhead'], ['bm','Trapper'], ['mm','Longshot'], ['sv','Snakebite'],
    ['enh','Windcaller'], ['enh','Stormbrew'], ['feral','Clawdia'], ['feral','Nightpaw'], ['fury','Ragefist'],
    ['shadow','Voidtouch'], ['arcane','Syba'], ['arcane','Frostwick'], ['destro','Felstorm'], ['destro','Cinderax'], ['destro','Hexblaze'], ['ele','Thundrak'], ['balance','Starfall']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 1, feralGroups: 2,
    together: [['ele','destro'], ['balance','destro'], ['destro','destro']],
    apart: [['feral',1], ['enh',1], ['class:HUNTER',2]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 7 healers / P=11 (4 warriors, 3 rogues, 2 Enh, Ret, 1 cat) / C=5, M=round(44/16)=3. Melee seats 15 = 11 physical + Prot Warrior + 3 healers; the one caster group is exactly 5 casters, so no mixed group is needed. Shamans: Enh x2 cover two melee groups (Windfury groups = 2), Ele sits with the casters, and the Resto Shaman stays with the tank-group healers (2026-10-10: a roster's only Resto stays with the tank group). The third melee-identity group is the second tank + 3 healers + one Arms warrior (11 melee for 10 Windfury-covered seats), so a Resto there would cover one receiver; measured: moving Riptide out of the tank group loses about 45 points there against about 35 gained.
{ id: 'T12', source: 'tbc25', label: 'T12 Melee-heavy: 4 warriors, 3 rogues, 2 Enh, Ret, Feral',
  entries: [['palaTank','Gorrash'], ['warriorTank','Ironhide'],
    ['holyPala','Lightbringer'], ['holyPala','Dawnwarden'], ['restoS','Riptide'], ['restoD','Thornheal'], ['holyP','Benedyn'], ['holyP','Oracle'], ['disc','Wardweaver'],
    ['arms','Bladesong'], ['arms','Cleaver'], ['fury','Whirlwind'], ['fury','Bloodrage'],
    ['combat','Shadowstep'], ['combat','Daggerfall'], ['assassin','Venomtip'],
    ['enh','Earthstrike'], ['enh','Fistoflame'], ['retPala','Cromer'], ['feral','Pouncer'],
    ['shadow','Mindrot'], ['arcane','Aethon'], ['arcane','Pyrelle'], ['destro','Brimstone'], ['ele','Voltaic']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2,
    together: [['retPala','enh']],
    apart: [['enh',1], ['class:SHAMAN',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 7 healers / P=3 (Enh, Fury, cat) / C=13, M=round(12/16)=1. One melee group = 3 physical + Prot Warrior + 1 healer; three caster groups = 13 casters + 2 healers = 15 seats, exact fit; Destro x3 + Ele + Boomkin is a full group. Only 1 melee group exists, so Windfury counts for 1 group (casters/healers value none).
{ id: 'T13', source: 'tbc25', label: 'T13 Caster-heavy: 5 mages, 4 locks, 2 Shadow, Boomkin, Ele',
  entries: [['warriorTank','Shieldmaiden'], ['palaTank','Bulwark'],
    ['holyPala','Radiance'], ['holyPala','Solace'], ['restoS','Brooktide'], ['restoD','Wildgrowth'], ['holyP','Hymnal'], ['holyP','Vesperal'], ['disc','Shielder'],
    ['enh','Skyfury'], ['fury','Mauler'], ['feral','Stalkpaw'],
    ['arcane','Aluneth'], ['arcane','Manaflux'], ['arcane','Spellweft'], ['fire','Scorchlyn'], ['frost','Rimewind'],
    ['destro','Felbolt'], ['destro','Shadowflame'], ['destro','Ruinous'], ['demo','Impkeeper'],
    ['shadow','Dreadmind'], ['shadow','Voidcaller'], ['balance','Moonflare'], ['ele','Lightningrod']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 1,
    together: [['ele','destro'], ['balance','destro'], ['destro','destro']],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 6 healers / P=7 (2 Enh, cat, Arms, Fury, Combat, BM) / C=10 (5 locks), M=round(28/17)=2. Tank group = Prot Pal + 3 healers + Affli overflow; melee seats 10 = 7 physical + Prot Warrior + 2 healers; caster seats 10 = 9 casters + 1 healer. Destro x3 + Ele + Boomkin fills a group.
{ id: 'T14', source: 'tbc25', label: 'T14 Warlock-heavy: 5 locks (3 Destro, Affli, Demo)',
  entries: [['palaTank','Dunmar'], ['warriorTank','Gruntlock'],
    ['holyPala','Sunmender'], ['restoD','Briarwind'], ['restoS','Springwater'], ['holyP','Lightwell'], ['disc','Penitent'], ['holyP','Renewal'],
    ['enh','Rockbiter'], ['enh','Doomhammer'], ['feral','Catclaw'], ['arms','Mortalis'], ['fury','Titangrip'], ['combat','Backstab'], ['bm','Packleader'],
    ['destro','Soulfire'], ['destro','Chaosbolt'], ['destro','Shadowburn'], ['affli','Corruptia'], ['demo','Metamorph'],
    ['ele','Chainzap'], ['balance','Eclipsa'], ['shadow','Mindflay'], ['arcane','Blinkster'], ['arcane','Polymorpha']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2,
    together: [['destro','ele'], ['balance','destro'], ['destro','destro']],
    apart: [['enh',1], ['feral',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 6 healers / P=8 (2 Enh, Ret, cat, Arms, Fury, Combat, BM) / C=9 (5 mages, Shadow, 2 Destro, Affli), M=round(32/17)=2. Melee seats 10 = 8 physical + Prot Warrior + 1 healer; caster groups hold the 5 mages + Shadow + Destro x2 (+Affli or healers) with the Resto Shaman beside the Shadow Priest (Holy Priest placement is not asserted: it depends on whether Affli overflows into the tank group). Single Resto Shaman: placement is an open decision.
{ id: 'T15', source: 'tbc25', label: 'T15 Mage-heavy: 5 mages, Resto Shaman, Shadow Priest',
  entries: [['palaTank','Valorian'], ['warriorTank','Ironwall'],
    ['holyPala','Beaconer'], ['restoS','Wavecrest'], ['restoD','Lifebloom'], ['holyP','Haloed'], ['holyP','Serenity'], ['disc','Absolver'],
    ['arcane','Arcanist'], ['arcane','Evocatia'], ['arcane','Intellect'], ['fire','Pyroblast'], ['frost','Icelance'],
    ['shadow','Shadowmend'], ['destro','Hellfire'], ['destro','Incinera'], ['affli','Agonia'],
    ['enh','Totemic'], ['enh','Earthshock'], ['retPala','Crusadian'], ['feral','Maulwyn'], ['arms','Slamson'], ['fury','Rampage'], ['combat','Gouger'], ['bm','Huntsman']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2,
    together: [['retPala','enh'], ['destro','destro']],
    apart: [['enh',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 6 healers (3 Holy Priest, Disc, Resto Druid, Resto Shaman) / P=9 / C=8 (2 Shadow), M=round(36/17)=2. Melee seats 10 = 9 physical + Prot Warrior; caster seats 10 = 7-8 casters + 2-3 healers, so every Shadow Priest can sit with a Holy Priest. No Shadow-Holy Priest pairing is asserted: Vampiric Touch is party-wide, so a Holy Priest gets it whether the three sit with one Shadow Priest or are split, and the second Shadow Priest rightly sits with four DPS casters (2026-10-10).
{ id: 'T16', source: 'tbc25', label: 'T16 Priest-heavy healing: 3 Holy, Disc, 2 Shadow',
  entries: [['palaTank','Templar'], ['warriorTank','Rampart'],
    ['holyP','Prayerful'], ['holyP','Chastise'], ['holyP','Anchorite'], ['disc','Bubblegum'], ['restoD','Verdance'], ['restoS','Healstream'],
    ['shadow','Vampiric'], ['shadow','Nightmind'], ['arcane','Frostfire'], ['arcane','Manawell'], ['destro','Ashbringer'], ['destro','Fellash'], ['affli','Siphon'], ['balance','Lunarwrath'],
    ['enh','Shockfist'], ['enh','Flametongue'], ['retPala','Vengeful'], ['feral','Predator'], ['arms','Overpower'], ['fury','Bloodthirst'], ['combat','Riposte'], ['bm','Wildcall'], ['sv','Expose']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2,
    together: [['retPala','enh'], ['balance','destro']],
    apart: [['enh',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 6 healers (3 Holy Pal, Resto Shaman, Resto Druid, Holy Priest) / P=9 (2 Ret, 2 Enh, ...) / C=8, M=round(36/17)=2. Melee seats 10 = 9 physical + Prot Warrior; caster seats 10 = 7-8 casters + 2-3 healers. Both Ret fit in melee groups with the 2 Enh. Single Resto Shaman: placement is an open decision.
{ id: 'T17', source: 'tbc25', label: 'T17 Paladin-heavy healing: 3 Holy Pal, 2 Ret, Prot Pal',
  entries: [['palaTank','Lightshield'], ['warriorTank','Garrosh'],
    ['holyPala','Flashlight'], ['holyPala','Holyshock'], ['holyPala','Illumina'], ['restoS','Mistwalker'], ['restoD','Rejuvia'], ['holyP','Smiteous'],
    ['retPala','Templar'], ['retPala','Judgemental'], ['enh','Maelstrom'], ['enh','Lavalash'], ['feral','Ravager'], ['arms','Colossus'], ['fury','Berserkr'], ['combat','Sinister'], ['bm','Beastlord'],
    ['shadow','Penumbra'], ['arcane','Spellfire'], ['arcane','Netherwind'], ['destro','Conflag'], ['destro','Infernus'], ['affli','Haunter'], ['balance','Wrathful'], ['ele','Earthquake']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2,
    together: [['retPala','enh'], ['ele','destro'], ['balance','destro']],
    apart: [['enh',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks (Prot Pal anchor + Feral bear) / 6 healers (2 Resto Druid) / P=12 (2 cats, 2 Enh, Ret, 2 Arms, Fury, Combat, 3 hunters) / C=5 (Boomkin, 3 Destro, Ele), M=round(48/17)=3. Melee seats 15 = 12 physical + bear + 2 healers; the single caster group is the full Destro x3 + Ele + Boomkin pack. Cats and bear (3 Ferals, all matched by the 'feral' selector) take one melee group each. Windfury groups = 2: the third melee-identity group is 3 hunters + the bear + 2 healers, none of whom receive Windfury (hunters and Ferals value it at 0), so a shaman there drops Grace of Air, not Windfury. Hunters: max 2 per group (2026-10-10, hunters spread only as evenly as seats allow); spreading a hunter into an Enh group would push a Fury/Combat out of its Windfury, which costs more than the second hunter's spread tax.
{ id: 'T18', source: 'tbc25', label: 'T18 Druid-heavy: 2 Resto, Boomkin, 2 cats, bear',
  entries: [['palaTank','Aegis'], ['druidTank','Ursoc'],
    ['restoD','Treeform'], ['restoD','Swiftmend'], ['holyPala','Redeemer'], ['restoS','Chainheal'], ['holyP','Prayerbook'], ['disc','Painsupp'],
    ['balance','Starsurge'], ['feral','Shredder'], ['feral','Rakeclaw'],
    ['enh','Stormstrike'], ['enh','Boltcaller'], ['retPala','Sanctimon'], ['arms','Mortal'], ['arms','Sunder'], ['fury','Execute'], ['combat','Eviscera'],
    ['bm','Hawkeye'], ['sv','Raptor'], ['mm','Steadyshot'],
    ['destro','Shadowbolt'], ['destro','Immolates'], ['destro','Dreadlock'], ['ele','Lightningbolt']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2, feralGroups: 3,
    together: [['ele','destro'], ['balance','destro'], ['destro','destro'], ['retPala','enh']],
    apart: [['feral',1], ['enh',1], ['class:HUNTER',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 6 healers (incl. Resto Shaman) / P=9 (2 Enh, Ret, ...) / C=8 (Ele), M=round(36/17)=2. 4 shamans over 4 DPS groups: Enh in each melee group, Ele with the warlocks, Resto Shaman with the mage/shadow group. Melee seats 10 = 9 physical + Prot Warrior. Windfury counts only in the 2 melee groups (Ele/Resto sit in caster groups where it is worth nothing). Single Resto Shaman: placement is an open decision.
{ id: 'T19', source: 'tbc25', label: 'T19 Four shamans: 2 Enh, Ele, Resto',
  entries: [['warriorTank','Bulwarkus'], ['palaTank','Dawnshield'],
    ['holyPala','Radiant'], ['restoS','Healingrain'], ['restoD','Naturecall'], ['holyP','Flashheal'], ['disc','Barrier'], ['holyP','Circle'],
    ['enh','Windfury'], ['enh','Rockbitter'], ['retPala','Crusadin'], ['feral','Savagery'], ['arms','Mortalstrike'], ['fury','Enrager'], ['combat','Bladeflurry'], ['bm','Aspectx'], ['sv','Lacerate'],
    ['ele','Stormcaller'], ['shadow','Shadowform'], ['arcane','Arcblast'], ['arcane','Slowfall'], ['destro','Shadowfury'], ['destro','Conflagrate'], ['affli','Unstable'], ['balance','Typhoon']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2,
    together: [['retPala','enh'], ['ele','destro'], ['balance','destro']],
    apart: [['class:SHAMAN',1], ['enh',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

// design: 2 tanks / 6 healers / P=12 (Ret, 2 cats, 2 Arms, Fury, 3 rogues, 3 hunters) / C=5 (Shadow, 2 Arcane, Destro, Boomkin), no shaman, M=round(48/17)=3. Melee seats 15 = 12 physical + Prot Warrior + 2 healers; the caster group is exactly 5 casters. Windfury has no source so it is not asserted. hunters may stack (fewer than 2 Enh)
{ id: 'T20', source: 'tbc25', label: 'T20 No shaman: Alliance-style roster',
  entries: [['palaTank','Highlord'], ['warriorTank','Wallbreaker'],
    ['holyPala','Chronicler'], ['holyPala','Lightforge'], ['restoD','Tranquil'], ['holyP','Circlehealer'], ['disc','Powershield'], ['holyP','Binding'],
    ['retPala','Retribulus'], ['feral','Mangle'], ['feral','Rippler'], ['arms','Whirlblade'], ['arms','Hamstrung'], ['fury','Slammer'],
    ['combat','Sinistrike'], ['combat','Gougewise'], ['assassin','Mutilatus'], ['bm','Kilcommand'], ['sv','Wyvern'], ['mm','Aimedshot'],
    ['shadow','Mindblast'], ['arcane','Missilez'], ['arcane','Arcanum'], ['destro','Soulburn'], ['balance','Starshard']],
  expect: { seated: 25, benched: 0, minHealersSeated: 6, feralGroups: 2,
    apart: [['feral',1]],
    mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=8 / C=9 (2 Shadow incl. affli) -> M=2; tank group = Prot Pala + 3 healers + Affliction overflow, melee 8P+2 non-DPS, casters 8C+restoS+holyP, so a clean split exists.
  { id: 'T21', source: 'tbc25', label: 'T21 Two Shadow Priests',
    entries: [
      ['palaTank','Aegisor'], ['warriorTank','Brickwall'],
      ['holyPala','Lumina'], ['holyPala','Dawnbringer'], ['restoD','Mosswalker'], ['restoS','Tidecaller'], ['holyP','Mercya'], ['disc','Warden'],
      ['arms','Sundersplit'], ['fury','Bloodrager'], ['feral','Clawdia'], ['combat','Shivster'], ['enh','Stormfist'], ['retPala','Crusadon'], ['bm','Arrowind'], ['sv','Snaretrap'],
      ['shadow','Voidwhisper'], ['shadow','Mindflayr'], ['arcane','Frostbyte'], ['arcane','Pyrolyte'], ['destro','Felbolt'], ['destro','Chaosnova'], ['ele','Thunderlux'], ['balance','Starfell'], ['affli','Doomcurse']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6,
      together: [['shadow','role:caster_dps'], ['holyP','shadow'], ['retPala','enh'], ['ele','balance'], ['destro','ele']],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers (no Resto Shaman) / P=9 / C=8 (2 Ele, 1 Boomkin; Moonwell is Resto Druid) -> M=2; the Boomkin sits with one Ele (apart ele 1); one Enh covers one melee group, an Ele may cover the other (rule 1) so one mixed group is allowed; casters seat 7 + 3 non-DPS.
  { id: 'T22', source: 'tbc25', label: 'T22 Two Ele Shamans, no Resto Shaman',
    entries: [
      ['palaTank','Ironhide'], ['warriorTank','Shieldmaw'],
      ['holyPala','Radiance'], ['holyPala','Beaconis'], ['restoD','Barkskin'], ['holyP','Prayerful'], ['disc','Painsupp'], ['restoD','Moonwell'],
      ['arms','Mortalis'], ['fury','Whirlwynd'], ['feral','Pouncer'], ['combat','Backstabb'], ['assassin','Poisonara'], ['enh','Earthfury'], ['retPala','Smitelord'], ['bm','Wyvernsting'], ['sv','Explotrap'],
      ['ele','Lightningx'], ['ele','Chainzap'], ['destro','Shadowburn'], ['destro','Hellfirex'], ['affli','Corruptia'], ['shadow','Dispella'], ['arcane','Blinkster'], ['balance','Lunarwrath']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6,
      together: [['destro','ele'], ['balance','ele'], ['retPala','enh']],
      apart: [['ele', 1]],
      mixedDpsGroups: 1, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=8 / C=9 (2 Boomkin) -> M=2 so exactly two caster groups for two non-stacking Moonkin auras; Destro + Ele + Boomkin pack is achievable; 1 Ele pairs with one Boomkin, the other rides with the mage/Resto group.
  { id: 'T23', source: 'tbc25', label: 'T23 Two Boomkins',
    entries: [
      ['palaTank','Holdfast'], ['warriorTank','Bulwarkk'],
      ['holyPala','Lightbringr'], ['holyPala','Sanctifier'], ['restoD','Wildgrowth'], ['restoS','Healingtide'], ['holyP','Renewal'], ['disc','Shieldpriest'],
      ['arms','Slamjob'], ['fury','Rampager'], ['feral','Mangleclaw'], ['combat','Sinisterx'], ['enh','Windlash'], ['retPala','Judgemint'], ['bm','Killshot'], ['sv','Wingclip'],
      ['balance','Eclipsia'], ['balance','Starfyre'], ['destro','Incinerax'], ['destro','Shadowbolt'], ['ele','Stormcaller'], ['shadow','Mindblast'], ['arcane','Arcanist'], ['arcane','Evocaton'], ['affli','Siphonic']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6,
      together: [['ele','balance'], ['destro','ele'], ['retPala','enh']],
      apart: [['balance', 1]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=9 (3 Ret, 2 Enh) / C=8 -> M=2; each melee group takes one Enh and the Rets split 2+1, so Ret-Enh pairing and Enh spreading are both achievable; melee 9P+1, casters 7C+3 healers.
  { id: 'T24', source: 'tbc25', label: 'T24 Three Rets, two Enh',
    entries: [
      ['palaTank','Stonewall'], ['warriorTank','Rampart'],
      ['holyPala','Illuminas'], ['holyPala','Redemptor'], ['restoD','Thornbloom'], ['restoS','Riptide'], ['holyP','Circlehealr'], ['disc','Barrierix'],
      ['retPala','Vengeance'], ['retPala','Hammerfall'], ['retPala','Templarx'], ['enh','Stormstrike'], ['enh','Doomhammer'], ['arms','Tendonrip'], ['fury','Bladestorm'], ['feral','Shredder'], ['bm','Aimedshot'],
      ['arcane','Missilex'], ['arcane','Slowfall'], ['fire','Scorchmark'], ['destro','Conflagra'], ['destro','Soulfire'], ['shadow','Painweave'], ['balance','Wrathwood'], ['affli','Unstablex']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2, feralGroups: 1,
      together: [['retPala','enh']],
      apart: [['retPala', 2], ['enh', 1]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=9 (6 rogues, 2 Enh, Feral) / C=8 -> M=2; melee seats 10 = 9P + 1 tank, so every melee group gets an Enh (rogues may split 4+2 or 3+3, both legal); casters 7C + 3 healers.
  { id: 'T25', source: 'tbc25', label: 'T25 Six Rogues, two Enh',
    entries: [
      ['palaTank','Oakenshld'], ['warriorTank','Gatekeepr'],
      ['holyPala','Vindicia'], ['holyPala','Guardiana'], ['restoD','Rejuvix'], ['restoS','Earthshield'], ['holyP','Serenity'], ['disc','Atonex'],
      ['combat','Swashbuk'], ['combat','Riposter'], ['combat','Bladeflurry'], ['assassin','Mutilatr'], ['assassin','Envenomx'], ['sub','Shadowdnc'], ['enh','Totemlord'], ['enh','Fireslash'], ['feral','Catform'],
      ['arcane','Spellsteal'], ['arcane','Polymorpher'], ['destro','Imprix'], ['destro','Felhunt'], ['shadow','Shadowfend'], ['balance','Hurricanx'], ['ele','Earthquaker'], ['affli','Hauntedx']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2, feralGroups: 1,
      together: [['class:ROGUE','enh']],
      apart: [['enh', 1]],
      mixedDpsGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks (Prot Warrior is the only warrior) / 6 healers / P=9 (rogues, 2 Feral, 2 Enh, Ret, BM) / C=8 -> M=2; 2 Ferals one per melee group (LotP does not stack), each with an Enh.
  { id: 'T26', source: 'tbc25', label: 'T26 No DPS warriors',
    entries: [
      ['palaTank','Sentinelle'], ['warriorTank','Wallbreakr'],
      ['holyPala','Auralight'], ['holyPala','Consecrax'], ['restoD','Lifebloomr'], ['restoS','Chainheal'], ['holyP','Binding'], ['disc','Penancer'],
      ['combat','Gougemaster'], ['combat','Daggerfan'], ['assassin','Garrotes'], ['feral','Leaderpak'], ['feral','Rakeclaw'], ['enh','Maelstrmx'], ['enh','Spiritwolf'], ['retPala','Sealcmdr'], ['bm','Packleadr'],
      ['arcane','Ignitex'], ['arcane','Counterspl'], ['destro','Shadowfury'], ['destro','Rainoffire'], ['shadow','Vampirix'], ['ele','Totemwrath'], ['balance','Typhoonx'], ['affli','Lifetapper']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2, feralGroups: 2,
      together: [['retPala','enh']],
      apart: [['feral', 1], ['enh', 1]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=8 (no hunters) / C=9 (3 Destro) -> M=2; melee 8P + 2 non-DPS, casters 8C + 2 non-DPS; no hunters, so no hunter check; Destro + Ele + Boomkin pack is available.
  { id: 'T27', source: 'tbc25', label: 'T27 No hunters at all',
    entries: [
      ['palaTank','Titanguard'], ['warriorTank','Defiantus'],
      ['holyPala','Holyshock'], ['holyPala','Lightsworn'], ['restoD','Treeform'], ['restoS','Manatide'], ['holyP','Lightwell'], ['disc','Fortitude'],
      ['arms','Overpowr'], ['fury','Berserkr'], ['feral','Lacerate'], ['combat','Daggerdance'], ['assassin','Cheapshot'], ['enh','Shamanwolf'], ['enh','Lavalash'], ['retPala','Holywrath'],
      ['destro','Chaosbolt'], ['destro','Havocx'], ['destro','Backdraft'], ['arcane','Slowx'], ['arcane','Manaburn'], ['shadow','Shadowform'], ['ele','Elementalx'], ['balance','Naturesgrasp'], ['affli','Agonyx']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 2,
      together: [['destro','ele'], ['ele','balance'], ['retPala','enh']],
      apart: [['enh', 1]],
      mixedDpsGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=9 / C=8 (4 mages, 2 Shadow, Ele, Boomkin; no warlock so no overflow DPS for the tank group) -> M=2; tank group is Prot Pala (+ maybe 2nd tank) + 3-4 healers, so it holds no DPS.
  { id: 'T28', source: 'tbc25', label: 'T28 No warlocks',
    entries: [
      ['palaTank','Bastionor'], ['warriorTank','Shieldbash'],
      ['holyPala','Judgmentx'], ['holyPala','Flashlite'], ['restoD','Tranquilx'], ['restoS','Earthliving'], ['holyP','Chastise'], ['disc','Powerword'],
      ['arms','Mortalstrk'], ['fury','Execution'], ['feral','Maulbear'], ['combat','Sliceanddice'], ['assassin','Rupturex'], ['enh','Flametongue'], ['retPala','Crusader'], ['bm','Bestialwrth'], ['sv','Lockandload'],
      ['arcane','Arcanepwr'], ['arcane','Presenceofm'], ['fire','Combustn'], ['frost','Icelance'], ['shadow','Shadowweav'], ['shadow','Vampiric'], ['ele','Thunderstrm'], ['balance','Starfire']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6,
      together: [['holyP','shadow'], ['ele','balance'], ['retPala','enh']],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=9 / C=8 (5 warlocks incl. 1 Affliction for the tank group, Shadow, Ele, Boomkin; no mage) -> M=2; casters outside tank group 7 + 3 non-DPS fill the two caster groups.
  { id: 'T29', source: 'tbc25', label: 'T29 No mages',
    entries: [
      ['palaTank','Fortressa'], ['warriorTank','Shieldwal'],
      ['holyPala','Beaconic'], ['holyPala','Wingsofgld'], ['restoD','Naturescare'], ['restoS','Healwave'], ['holyP','Lightfont'], ['disc','Oraclex'],
      ['arms','Cleaver'], ['arms','Deepwound'], ['fury','Bloodthirst'], ['feral','Savageroar'], ['combat','Adrenaline'], ['enh','Thunderfury'], ['retPala','Avenging'], ['bm','Serpentstng'], ['sv','Lacerates'],
      ['destro','Ruinx'], ['destro','Shadowflme'], ['destro','Emberstorm'], ['demo','Metamorphx'], ['affli','Soulrot'], ['shadow','Mindsear'], ['ele','Lavaburst'], ['balance','Insectswrm']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6,
      together: [['destro','ele'], ['ele','balance'], ['shadow','holyP'], ['retPala','enh']],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / P=7 (3 hunters, Feral, Ret, 2 Enh) / C=10 -> M=2; melee seats 10 = 7P + 3 non-DPS, casters 9 outside tank group + Resto Shaman = 10, so every hunter fits a melee group with an Enh (3 hunters over 2 groups = max 2 per group). Windfury 1 group: an Enh Shaman whose group is hunters + a Feral drops Grace of Air, not Windfury.
  { id: 'T30', source: 'tbc25', label: 'T30 Two Enh, hunters as melee company',
    entries: [
      ['palaTank','Shieldmaiden'], ['warriorTank','Ironbark'],
      ['holyPala','Holylight'], ['holyPala','Sanctuary'], ['restoD','Swiftmendr'], ['restoS','Tidalwave'], ['holyP','Prayerofhl'], ['disc','Painsuppr'],
      ['enh','Stormbringr'], ['enh','Windfurious'], ['feral','Tigersfury'], ['retPala','Retribute'], ['bm','Rapidfire'], ['bm','Bestialpet'], ['mm','Steadyshot'],
      ['arcane','Arcaneblast'], ['arcane','Spellfrost'], ['fire','Livingbomb'], ['destro','Seedofcorr'], ['destro','Dreadlock'], ['destro','Shadowshard'], ['ele','Earthshockr'], ['balance','Naturewrath'], ['affli','Unstableaff'], ['shadow','Mindcontrolr']],
    expect: { seated: 25, benched: 0, minHealersSeated: 6, windfuryGroups: 1, feralGroups: 1,
      together: [['class:HUNTER','enh'], ['retPala','enh']],
      apart: [['enh', 1], ['class:HUNTER', 2]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: tanks 2, healers 5 (+1 open = floor 6), phys 8, casters 9 -> M=round(32/17)=2. Melee seats 10 = 8 phys + 2 fillers, caster seats 10 = 9 casters + 1 filler, fillers = 2 healers beyond tank-group 4 + 2nd tank = 3. Exact fit, so mixed 0 and hunters 0 are achievable. (Healer floor forces the suggestion; its spec is not asserted.) hunters may stack (fewer than 2 Enh)
  { id: 'T31', source: 'tbc25', label: 'T31 24 signups one healer short',
    entries: [
      ['palaTank', 'Aldrin'], ['warriorTank', 'Selene'], ['holyPala', 'Kestrel'], ['restoD', 'Drystan'],
      ['restoS', 'Wynstan'], ['holyP', 'Pyrrha'], ['disc', 'Isolde'], ['arms', 'Brynja'],
      ['fury', 'Tamsin'], ['feral', 'Lysander'], ['combat', 'Eira'], ['enh', 'Xanthe'],
      ['retPala', 'Quillon'], ['bm', 'Jorvik'], ['sv', 'Caelum'], ['shadow', 'Ursa'],
      ['arcane', 'Morwen'], ['arcane', 'Fenwick'], ['affli', 'Yorrick'], ['destro', 'Rhaegal'],
      ['destro', 'Kaelith'], ['ele', 'Dorgal'], ['balance', 'Valen'], ['fire', 'Nyssa'],
    ],
    expect: { seated: 24, benched: 0, suggestedCount: 1, minHealersSeated: 5, tankGroup: { maxDps: 1, minHealers: 3 }, together: [['retPala', 'enh']], mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2, healers 6, phys 11 (+2 Enh open = 13), casters 4 -> M=round(52/17)=3. Melee seats 15 = 13 phys + 2nd tank + 1 healer; caster group = 4 casters + restoS; tank group = pala tank + 4 healers, no DPS (no affli, no seat pressure). Exact fit. hunters may stack (fewer than 2 Enh). Suggested = 2 Enh (rule 1, 2026-10-10): with two melee groups and no shaman on the board, a second Enh gives Windfury to the whole second melee group (the two Open Enh seats sit one per melee group; windfuryGroups is not asserted because Open seats are not real players and give no buff in the checker) and beats a Ret, which would be the third pick; no Ret is on the board so no Ret-Enh pairing is asserted.
  { id: 'T32', source: 'tbc25', label: 'T32 23 signups no Enh no Ret',
    entries: [
      ['palaTank', 'Branwen'], ['warriorTank', 'Ulrich'], ['holyPala', 'Norrin'], ['restoD', 'Gwynna'],
      ['restoS', 'Zarek'], ['holyP', 'Rowan'], ['holyP', 'Joran'], ['disc', 'Corvus'],
      ['arms', 'Vexari'], ['arms', 'Orsyn'], ['fury', 'Haldor'], ['fury', 'Aldrin'],
      ['feral', 'Selene'], ['combat', 'Kestrel'], ['assassin', 'Drystan'], ['sub', 'Wynstan'],
      ['bm', 'Pyrrha'], ['sv', 'Isolde'], ['mm', 'Brynja'], ['shadow', 'Tamsin'],
      ['arcane', 'Lysander'], ['destro', 'Eira'], ['destro', 'Xanthe'],
    ],
    expect: { seated: 23, benched: 0, suggested: ['enh', 'enh'], suggestedCount: 2, tankGroup: { maxDps: 0, minHealers: 3 }, mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 1 (+1 open), healers 4 (+2 open), phys 9, casters 8 -> M=round(36/17)=2. Melee seats 10 = 9 phys + 1 filler, caster seats 10 = 8 casters + 2 fillers; fillers = 2 healers beyond tank-group 4 + 2nd tank = 3. Floors (2 tanks, 6 healers) force exactly 3 suggestions.
  { id: 'T33', source: 'tbc25', label: 'T33 22 signups 1 tank 4 healers',
    entries: [
      ['palaTank', 'Elowen'], ['holyPala', 'Wren'], ['restoD', 'Osric'], ['holyP', 'Halvard'],
      ['restoS', 'Thalin'], ['arms', 'Torvald'], ['fury', 'Mirela'], ['feral', 'Faldrek'],
      ['feral', 'Yara'], ['combat', 'Perrin'], ['enh', 'Ingrid'], ['retPala', 'Branwen'],
      ['bm', 'Ulrich'], ['sv', 'Norrin'], ['shadow', 'Gwynna'], ['arcane', 'Zarek'],
      ['arcane', 'Rowan'], ['fire', 'Joran'], ['destro', 'Corvus'], ['destro', 'Vexari'],
      ['ele', 'Orsyn'], ['balance', 'Haldor'],
    ],
    expect: { seated: 22, benched: 0, suggestedCount: 3, minHealersSeated: 4, tankGroup: { maxDps: 1, minHealers: 3 }, together: [['retPala', 'enh']], apart: [['feral', 1], ['class:HUNTER', 1]], mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2, healers 6 (floors met), melee 6 incl. the Ret + 1 hunter = 7 phys, casters 6; 4 suggestions are all DPS and the Ret has no real Enh so one suggestion must be Enh. P=8..11 vs C=6..9 gives M of 2 or 3 and melee seats always exceed the lone hunter, so it rides melee.
  { id: 'T34', source: 'tbc25', label: 'T34 21 signups no Enh one Ret six melee',
    entries: [
      ['palaTank', 'Fenwick'], ['warriorTank', 'Yorrick'], ['holyPala', 'Rhaegal'], ['restoD', 'Kaelith'],
      ['restoS', 'Dorgal'], ['holyP', 'Valen'], ['holyP', 'Nyssa'], ['disc', 'Garrick'],
      ['arms', 'Zephra'], ['fury', 'Sylvar'], ['feral', 'Lorcan'], ['combat', 'Elowen'],
      ['assassin', 'Wren'], ['retPala', 'Osric'], ['bm', 'Halvard'], ['shadow', 'Thalin'],
      ['arcane', 'Torvald'], ['arcane', 'Mirela'], ['destro', 'Faldrek'], ['destro', 'Yara'],
      ['affli', 'Perrin'],
    ],
    expect: { seated: 21, benched: 0, suggested: ['enh'], suggestedCount: 4, together: [['retPala', 'enh']], tankGroup: { maxDps: 1, minHealers: 3 }, huntersInCasterGroups: 0, localOptimum: true } },
  // design: Exact brief roster: tanks 2, healers 5 (+1 open), phys 8, casters 5; 5 suggestions = 1 healer + 4 DPS so P=8..12, C=5..9, M=2 or 3. Druid tank is the only tank placed as a regular member (melee group); warrior anchors the tank group. 3 hunters always fit in melee seats (10+ seats vs 8 phys + druid tank = 9 worst case), so hunters 0 holds. Ret (if suggested) must sit with Enh (if suggested). The Guardian Druid tank and the Feral DPS both give LotP (rule 4), so they must sit in different groups: feralGroups 2 (max_dps only; M>=2 and the Druid tank rides a melee group).
  { id: 'T35', source: 'tbc25', label: 'T35 20 signups Ret suggestion regression',
    entries: [
      ['druidTank', 'Isolde'], ['warriorTank', 'Brynja'], ['holyP', 'Tamsin'], ['holyP', 'Lysander'],
      ['holyP', 'Eira'], ['restoD', 'Xanthe'], ['restoS', 'Quillon'], ['assassin', 'Jorvik'],
      ['assassin', 'Caelum'], ['arms', 'Ursa'], ['arms', 'Morwen'], ['feral', 'Fenwick'],
      ['mm', 'Yorrick'], ['mm', 'Rhaegal'], ['sv', 'Kaelith'], ['shadow', 'Dorgal'],
      ['ele', 'Valen'], ['ele', 'Nyssa'], ['fire', 'Garrick'], ['fire', 'Zephra'],
    ],
    expect: { seated: 20, benched: 0, suggestedCount: 5, together: [['retPala', 'enh']], apart: [['role:tank', 1]], tankGroup: { maxDps: 1, minHealers: 3 }, huntersInCasterGroups: 0, localOptimum: true, max_dps: { feralGroups: 2 } } },
  // design: tanks 2, healers 6, phys 3 (no hunters), casters 8; 6 suggestions are all DPS. Floors are met so the tank group is anchor + 4 healers; the optimizer picks the 6 DPS specs, so only structure is asserted.
  { id: 'T36', source: 'tbc25', label: 'T36 19 signups caster heavy partial',
    entries: [
      ['palaTank', 'Joran'], ['warriorTank', 'Corvus'], ['holyPala', 'Vexari'], ['restoD', 'Orsyn'],
      ['restoS', 'Haldor'], ['restoS', 'Aldrin'], ['holyP', 'Selene'], ['disc', 'Kestrel'],
      ['arms', 'Drystan'], ['feral', 'Wynstan'], ['combat', 'Pyrrha'], ['shadow', 'Isolde'],
      ['arcane', 'Brynja'], ['arcane', 'Tamsin'], ['destro', 'Lysander'], ['destro', 'Eira'],
      ['destro', 'Xanthe'], ['ele', 'Quillon'], ['balance', 'Jorvik'],
    ],
    expect: { seated: 19, benched: 0, suggestedCount: 6, minHealersSeated: 6, together: [['destro', 'ele'], ['ele', 'balance']], tankGroup: { maxDps: 1, minHealers: 3 }, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2, healers 6 (no shaman), phys 11 incl. Ret and a hunter, casters 4; 2 suggestions, one must be Enh (Ret needs a Sanctity+Windfury pack, no shaman at all). Other suggestion physical: P=13,C=4 M=3; caster: P=12,C=5 M=3. Melee seats 15 fit all phys + fillers, casters fit one group, so mixed 0 holds either way.
  { id: 'T37', source: 'tbc25', label: 'T37 23 signups melee heavy no shaman',
    entries: [
      ['palaTank', 'Mirela'], ['warriorTank', 'Faldrek'], ['holyPala', 'Yara'], ['holyPala', 'Perrin'],
      ['restoD', 'Ingrid'], ['restoD', 'Branwen'], ['holyP', 'Ulrich'], ['disc', 'Norrin'],
      ['arms', 'Gwynna'], ['arms', 'Zarek'], ['fury', 'Rowan'], ['fury', 'Joran'],
      ['feral', 'Corvus'], ['feral', 'Vexari'], ['combat', 'Orsyn'], ['assassin', 'Haldor'],
      ['sub', 'Aldrin'], ['retPala', 'Selene'], ['bm', 'Kestrel'], ['shadow', 'Drystan'],
      ['arcane', 'Wynstan'], ['destro', 'Pyrrha'], ['affli', 'Isolde'],
    ],
    expect: { seated: 23, benched: 0, suggested: ['enh'], suggestedCount: 2, together: [['retPala', 'enh']], apart: [['feral', 1]], tankGroup: { maxDps: 1, minHealers: 3 }, mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2, healers 6, phys 7, casters 7; 3 suggestions give P=7..10, C=10..7 -> M=2 always (4P/17 in 1.65..2.35). Melee seats 10 >= P and caster seats 10 >= C with 3 fillers (2 healers + 2nd tank), so mixed 0 is always achievable; any suggested hunter must ride melee. Rule 3: the 2 Destro locks stack with the Ele + Boomkin.
  { id: 'T38', source: 'tbc25', label: 'T38 22 signups no hunters',
    entries: [
      ['palaTank', 'Nyssa'], ['warriorTank', 'Garrick'], ['holyPala', 'Zephra'], ['restoD', 'Sylvar'],
      ['restoS', 'Lorcan'], ['holyP', 'Elowen'], ['disc', 'Wren'], ['holyP', 'Osric'],
      ['arms', 'Halvard'], ['fury', 'Thalin'], ['feral', 'Torvald'], ['combat', 'Mirela'],
      ['enh', 'Faldrek'], ['retPala', 'Yara'], ['assassin', 'Perrin'], ['shadow', 'Ingrid'],
      ['arcane', 'Branwen'], ['arcane', 'Ulrich'], ['destro', 'Norrin'], ['destro', 'Gwynna'],
      ['ele', 'Zarek'], ['balance', 'Rowan'],
    ],
    expect: { seated: 22, benched: 0, suggestedCount: 3, together: [['retPala', 'enh'], ['destro', 'ele'], ['ele', 'balance']], tankGroup: { maxDps: 1, minHealers: 3 }, mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2, healers 6, phys 8, casters 5 (3 Destro + Arcane + Shadow); 4 suggestions all DPS. Rule 3: Destro locks stack with Ele + Boomkin, so the missing amplifiers must be suggested. P=8..10, C=7..9 -> M=2 always; melee seats 10 fit P, casters split into the Arcane/Shadow+restoS group and the lock group. hunters may stack (fewer than 2 Enh)
  { id: 'T39', source: 'tbc25', label: 'T39 21 signups no Ele no Boomkin',
    entries: [
      ['palaTank', 'Quillon'], ['warriorTank', 'Jorvik'], ['holyPala', 'Caelum'], ['restoD', 'Ursa'],
      ['restoS', 'Morwen'], ['holyP', 'Fenwick'], ['holyP', 'Yorrick'], ['disc', 'Rhaegal'],
      ['arms', 'Kaelith'], ['fury', 'Dorgal'], ['feral', 'Valen'], ['combat', 'Nyssa'],
      ['enh', 'Garrick'], ['retPala', 'Zephra'], ['bm', 'Sylvar'], ['sv', 'Lorcan'],
      ['destro', 'Elowen'], ['destro', 'Wren'], ['destro', 'Osric'], ['arcane', 'Halvard'],
      ['shadow', 'Thalin'],
    ],
    expect: { seated: 21, benched: 0, suggested: ['ele', 'balance'], suggestedCount: 4, together: [['retPala', 'enh'], ['destro', 'ele'], ['ele', 'balance']], tankGroup: { maxDps: 1, minHealers: 3 }, mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2 (none Druid), healers 6, phys 9, casters 7; the single suggestion should be the missing Feral (LotP for melee groups, rule 4). With it P=10,C=7 -> M=2: melee seats 10 = 10 phys exactly, casters + 3 fillers fill the other 10. hunters may stack (fewer than 2 Enh)
  { id: 'T40', source: 'tbc25', label: 'T40 24 signups no Feral',
    entries: [
      ['palaTank', 'Selene'], ['warriorTank', 'Kestrel'], ['holyPala', 'Drystan'], ['restoD', 'Wynstan'],
      ['restoS', 'Pyrrha'], ['holyP', 'Isolde'], ['holyP', 'Brynja'], ['disc', 'Tamsin'],
      ['arms', 'Lysander'], ['arms', 'Eira'], ['fury', 'Xanthe'], ['combat', 'Quillon'],
      ['assassin', 'Jorvik'], ['enh', 'Caelum'], ['retPala', 'Ursa'], ['bm', 'Morwen'],
      ['sv', 'Fenwick'], ['shadow', 'Yorrick'], ['arcane', 'Rhaegal'], ['arcane', 'Kaelith'],
      ['destro', 'Dorgal'], ['destro', 'Valen'], ['ele', 'Nyssa'], ['balance', 'Garrick'],
    ],
    expect: { seated: 24, benched: 0, suggestedCount: 1, together: [['retPala', 'enh']], tankGroup: { maxDps: 1, minHealers: 3 }, mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2, healers 4, phys 7, casters 7; 5 suggestions must restore the healer floor (2 healers) plus 3 DPS: P=7..10, C=7..10 -> M=2 always. Spec choice is the optimizer, so assert healers seated and tank group staffing instead of keys.
  { id: 'T41', source: 'tbc25', label: 'T41 20 signups healer light',
    entries: [
      ['palaTank', 'Ulrich'], ['warriorTank', 'Norrin'], ['holyPala', 'Gwynna'], ['restoD', 'Zarek'],
      ['restoS', 'Rowan'], ['holyP', 'Joran'], ['arms', 'Corvus'], ['fury', 'Vexari'],
      ['feral', 'Orsyn'], ['combat', 'Haldor'], ['enh', 'Aldrin'], ['retPala', 'Selene'],
      ['bm', 'Kestrel'], ['shadow', 'Drystan'], ['arcane', 'Wynstan'], ['arcane', 'Pyrrha'],
      ['destro', 'Isolde'], ['destro', 'Brynja'], ['ele', 'Tamsin'], ['balance', 'Lysander'],
    ],
    expect: { seated: 20, benched: 0, suggestedCount: 5, minHealersSeated: 4, tankGroup: { maxDps: 1, minHealers: 3 }, together: [['retPala', 'enh']], mixedDpsGroups: 0, huntersInCasterGroups: 0, localOptimum: true } },
  // design: tanks 2 (Prot Warrior anchors, Druid tank rides melee), healers 6, phys 7, casters 7; 3 suggestions. P=7..10 -> M=2: melee seats 10 hold P + Druid tank (up to 11), so at most ONE phys DPS overflows into a caster group (mixed <= 1). Warrior anchor must not share the group with the Druid tank. Guardian Druid tank and Feral DPS both give LotP (rule 4): feralGroups 2 (max_dps only; M=2 gives two melee groups). Ret-with-Enh is vacuous unless a Ret is suggested (no paladin signed, likely).
  { id: 'T42', source: 'tbc25', label: 'T42 22 signups no paladin',
    entries: [
      ['warriorTank', 'Wren'], ['druidTank', 'Osric'], ['restoD', 'Halvard'], ['restoD', 'Thalin'],
      ['holyP', 'Torvald'], ['holyP', 'Mirela'], ['disc', 'Faldrek'], ['restoS', 'Yara'],
      ['arms', 'Perrin'], ['fury', 'Ingrid'], ['feral', 'Branwen'], ['combat', 'Ulrich'],
      ['assassin', 'Norrin'], ['enh', 'Gwynna'], ['bm', 'Zarek'], ['shadow', 'Rowan'],
      ['arcane', 'Joran'], ['arcane', 'Corvus'], ['destro', 'Vexari'], ['destro', 'Orsyn'],
      ['ele', 'Haldor'], ['balance', 'Aldrin'],
    ],
    expect: { seated: 22, benched: 0, suggestedCount: 3, apart: [['role:tank', 1]], together: [['druidTank', 'role:melee_dps'], ['retPala', 'enh']], tankGroup: { maxDps: 1, minHealers: 3 }, mixedDpsGroups: 1, huntersInCasterGroups: 0, localOptimum: true, max_dps: { feralGroups: 2 } } },
  // design: 20 normal sign-ups seated: tanks 2, healers 6, phys 6, casters 6; 3 Tentative (bm, ele, sub) are benched before any normal sign-up, so 5 Open slots are suggested. Tentatives never enter the board.
  { id: 'T43', source: 'tbc25', label: 'T43 23 signups 3 Tentative',
    entries: [
      ['palaTank', 'Yorrick'], ['warriorTank', 'Rhaegal'], ['holyPala', 'Kaelith'], ['restoD', 'Dorgal'],
      ['restoS', 'Valen'], ['holyP', 'Nyssa'], ['holyP', 'Garrick'], ['disc', 'Zephra'],
      ['arms', 'Sylvar'], ['fury', 'Lorcan'], ['feral', 'Elowen'], ['combat', 'Wren'],
      ['enh', 'Osric'], ['retPala', 'Halvard'], ['shadow', 'Thalin'], ['arcane', 'Torvald'],
      ['arcane', 'Mirela'], ['destro', 'Faldrek'], ['destro', 'Yara'], ['balance', 'Perrin'],
      ['bm', 'Ingrid', 'tentative'], ['ele', 'Branwen', 'tentative'], ['sub', 'Ulrich', 'tentative'],
    ],
    expect: { seated: 20, benched: 3, tentativeBenched: 3, suggestedCount: 5, benchHas: [['bm', 1], ['ele', 1], ['sub', 1]], minHealersSeated: 6, together: [['retPala', 'enh']], tankGroup: { maxDps: 1, minHealers: 3 }, huntersInCasterGroups: 0, localOptimum: true } },
  // design: 17 normal sign-ups seated: tanks 2, healers 6, phys 5, casters 4; 2 Bench-status (fury, affli) stay benched, so 8 Open slots are suggested.
  { id: 'T44', source: 'tbc25', label: 'T44 19 signups 2 Bench status',
    entries: [
      ['palaTank', 'Brynja'], ['warriorTank', 'Tamsin'], ['holyPala', 'Lysander'], ['restoD', 'Eira'],
      ['restoS', 'Xanthe'], ['holyP', 'Quillon'], ['holyP', 'Jorvik'], ['disc', 'Caelum'],
      ['arms', 'Ursa'], ['feral', 'Morwen'], ['combat', 'Fenwick'], ['enh', 'Yorrick'],
      ['retPala', 'Rhaegal'], ['shadow', 'Kaelith'], ['arcane', 'Dorgal'], ['destro', 'Valen'],
      ['ele', 'Nyssa'], ['fury', 'Garrick', 'bench'], ['affli', 'Zephra', 'bench'],
    ],
    expect: { seated: 17, benched: 2, suggestedCount: 8, benchHas: [['fury', 1], ['affli', 1]], minHealersSeated: 6, together: [['retPala', 'enh']], tankGroup: { maxDps: 1, minHealers: 3 }, huntersInCasterGroups: 0, localOptimum: true } },

  // design: 2 tanks / 6 healers / 8 physical + 9 casters (M=2) = 25 primary + 2 Tentative; the healer floor is 5, so 6 healers are seated because only 6 healer seats carry buffs (tank group up to 4, Resto Shaman with casters, Holy Priest with the Shadow Priest) and extra healers displace DPS; tank group = Prot + 3 healers + Affliction overflow, melee seats 10 = 8 phys + warrior tank + 1 healer, caster seats 10 = 8 casters + 2 buff healers, so the reference comp fits with zero mixing; one shaman per group (Enh, Enh, Resto with the mage/shadow group, Ele, second Resto in the tank group) and no Open slots on a full board.
  { id: 'T45', source: 'tbc25', label: 'T45 27 sign-ups, 2 Tentative benched',
    entries: [
      ['palaTank', 'Holybulwark'], ['warriorTank', 'Ironhide'],
      ['holyPala', 'Lightbringer'], ['restoD', 'Mossbark'], ['disc', 'Serenia'], ['restoS', 'Tidecaller'], ['restoS', 'Brookwater'], ['holyP', 'Divinia'],
      ['feral', 'Clawdan'], ['enh', 'Stormhowl'], ['enh', 'Earthfury'], ['retPala', 'Crusadus'], ['arms', 'Mortalis'], ['fury', 'Rageblade'], ['combat', 'Shadowstep'], ['bm', 'Hawkeyes'],
      ['arcane', 'Spellweft'], ['arcane', 'Blinkdrake'], ['shadow', 'Mindshiv'], ['destro', 'Felburn'], ['destro', 'Chaosbolt'], ['destro', 'Soulrend'], ['ele', 'Thunderkin'], ['balance', 'Starfallen'], ['affli', 'Corruptia'],
      ['fire', 'Pyrodan', 'tentative'], ['frost', 'Icewind', 'tentative']
    ],
    expect: { raidSize: 25, seated: 25, benched: 2, tentativeBenched: 2, minHealersSeated: 6, windfuryGroups: 2, feralGroups: 1,
      together: [['retPala', 'enh'], ['destro', 'ele'], ['balance', 'ele'], ['shadow', 'holyP'], ['arcane', 'restoS'], ['shadow', 'restoS']],
      apart: [['enh', 1], ['class:SHAMAN', 1]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, suggestedCount: 0, localOptimum: true } },

  // design: 2 tanks / 9 healers / 9 physical + 10 casters = 30 primary (M=2 or 3 after benching 2 DPS); floors seat 2 tanks + 6 healers, 17 DPS fill the other seats, at most 7 of the 9 healers seated; P is 7-9 and C 8-10 so M=2 always, melee seats (10 = warrior tank + 9) hold every physical DPS incl. both hunters, so zero mixing and zero hunters in caster groups.
  { id: 'T46', source: 'tbc25', label: 'T46 30 sign-ups, 9 healers',
    entries: [
      ['palaTank', 'Aegisor'], ['warriorTank', 'Bastionel'],
      ['holyPala', 'Dawnlight'], ['holyPala', 'Sunwarden'], ['restoD', 'Wildgrove'], ['restoD', 'Barkskin'], ['disc', 'Penitent'], ['disc', 'Shieldmend'], ['holyP', 'Prayerful'], ['restoS', 'Waveshaper'], ['restoS', 'Totemic'],
      ['feral', 'Pouncer'], ['enh', 'Windlash'], ['enh', 'Skyfury'], ['retPala', 'Vengeor'], ['arms', 'Cleaver'], ['fury', 'Bloodrage'], ['combat', 'Daggerfall'], ['bm', 'Beastlord'], ['sv', 'Snaretrap'],
      ['arcane', 'Arcmage'], ['arcane', 'Polymorpha'], ['shadow', 'Voidtouch'], ['destro', 'Hellfirer'], ['destro', 'Shadowflame'], ['destro', 'Imphater'], ['ele', 'Lavaburst'], ['balance', 'Moonfury'], ['affli', 'Hexcurse'], ['fire', 'Pyromancer']
    ],
    expect: { raidSize: 25, seated: 25, benched: 5,
      benchHas: [['role:healer', 3]],
      together: [['retPala', 'enh']],
      apart: [['enh', 1]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / 9 physical (3 Enh) + 9 casters (Ele incl.) = 26; the surplus Enh is benched (Windfury is per group, only M=2 melee groups, a third Enh adds no coverage); with 8 physical + 9 casters M=2, melee seats 10 = warrior tank + 8 physical + 1 healer, so the board is the T45 layout with one shaman per group (Enh, Enh, Resto, Ele) and zero mixing.
  { id: 'T47', source: 'tbc25', label: 'T47 26 sign-ups, 3 Enh shamans',
    entries: [
      ['palaTank', 'Oathkeeper'], ['warriorTank', 'Shieldbreaker'],
      ['holyPala', 'Beacon'], ['restoD', 'Rejuvena'], ['restoD', 'Treebeard'], ['disc', 'Atonia'], ['holyP', 'Renewal'], ['restoS', 'Chainheal'],
      ['enh', 'Rockbiter'], ['enh', 'Flametongue'], ['enh', 'Windfurious'], ['retPala', 'Templarr'], ['arms', 'Sunderer'], ['fury', 'Berserka'], ['combat', 'Eviscerate'], ['feral', 'Lacerate'], ['bm', 'Falconer'],
      ['arcane', 'Mirrorimg'], ['arcane', 'Evocate'], ['shadow', 'Fiendish'], ['destro', 'Dreadflame'], ['destro', 'Cinderlock'], ['destro', 'Warlockian'], ['ele', 'Earthshock'], ['balance', 'Typhoona'], ['affli', 'Siphonia']
    ],
    expect: { raidSize: 25, seated: 25, benched: 1, windfuryGroups: 2, feralGroups: 1,
      benchHas: [['enh', 1]],
      together: [['retPala', 'enh'], ['destro', 'ele'], ['balance', 'ele'], ['shadow', 'holyP']],
      apart: [['enh', 1], ['class:SHAMAN', 1]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / 13 physical (6 hunters) + 7 casters = 28; 17 DPS seats, 3 benched, 7 non-hunter physical leave 2-3 melee seats for hunters at M=2 P=10 and C=7 (M=2) so one physical overflows into a caster group; that overflow can be a non-hunter, so 1 is only the safe bound (hunters are not forced onto the bench). Ferocious Inspiration stacks per BM hunter, so two BM in one group is fine; no Affliction means no free tank-group DPS, so the tank group is Prot + 4 healers.
  { id: 'T48', source: 'tbc25', label: 'T48 28 sign-ups, 6 hunters',
    entries: [
      ['palaTank', 'Wardenic'], ['warriorTank', 'Stonewall'],
      ['holyPala', 'Radiance'], ['restoD', 'Grovetender'], ['restoD', 'Mendleaf'], ['disc', 'Absolver'], ['holyP', 'Lumina'], ['restoS', 'Tideturner'],
      ['bm', 'Beastmaster'], ['bm', 'Packleader'], ['bm', 'Direwolf'], ['mm', 'Longshot'], ['mm', 'Deadeye'], ['sv', 'Wyvernsting'],
      ['enh', 'Galewarden'], ['enh', 'Stoneclaw'], ['retPala', 'Justicar'], ['arms', 'Executor'], ['fury', 'Warcry'], ['combat', 'Riposte'], ['feral', 'Mangler'],
      ['arcane', 'Frostbolt'], ['arcane', 'Manasurge'], ['shadow', 'Dreadwhisper'], ['destro', 'Ashbringer'], ['destro', 'Emberlash'], ['destro', 'Doomcaller'], ['ele', 'Voltshock']
    ],
    expect: { raidSize: 25, seated: 25, benched: 3, windfuryGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['class:HUNTER', 2], ['enh', 1]],
      mixedDpsGroups: 1, huntersInCasterGroups: 1, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks / 6 healers / 15 physical + 6 casters = 29; 17 DPS seats, M=3 (P>=10), 3 melee groups hold 14 DPS/support seats and one caster group holds 5 casters, so 4 benched (3 melee + 1 caster) fits with no mixing, 1 mixed group allowed; no Affliction, so the tank group is Prot + 4 healers with 0 guest DPS; Windfury in all 3 melee groups (2 Enh + Resto Shaman covers the Enh-less one).
  { id: 'T49', source: 'tbc25', label: 'T49 29 sign-ups, melee-heavy overflow',
    entries: [
      ['palaTank', 'Ramparts'], ['warriorTank', 'Ironbulwark'],
      ['holyPala', 'Soulmend'], ['restoD', 'Everbloom'], ['restoD', 'Thornwhisper'], ['disc', 'Painless'], ['holyP', 'Chantress'], ['restoS', 'Waterwalker'],
      ['arms', 'Slayerx'], ['arms', 'Titanfall'], ['arms', 'Maimer'], ['fury', 'Thirstblade'], ['fury', 'Windfuria'],
      ['combat', 'Swashbuck'], ['combat', 'Shivster'], ['assassin', 'Mutilator'], ['sub', 'Shadedance'],
      ['enh', 'Totembrawler'], ['enh', 'Lightningrod'], ['retPala', 'Zealot'], ['retPala', 'Smiteful'], ['feral', 'Ravager'], ['feral', 'Mauler'],
      ['arcane', 'Frostflux'], ['arcane', 'Manaburn'], ['shadow', 'Painweaver'], ['destro', 'Pyrolord'], ['destro', 'Cindermaw'], ['ele', 'Thunderlord']
    ],
    expect: { raidSize: 25, seated: 25, benched: 4, windfuryGroups: 3, feralGroups: 2,
      together: [['retPala', 'enh']],
      apart: [['enh', 1], ['retPala', 1], ['feral', 1]],
      mixedDpsGroups: 1, tankGroup: { maxDps: 0, minHealers: 3 }, localOptimum: true } },

  // design: 2 tanks (Prot + bear) / 6 healers / 8 physical + 9 casters (M=2) = 25 primary + 3 Tentative + 2 Bench status; melee seats 10 = 8 phys + bear + 1 healer, caster seats 10 = 8 casters + 2 buff healers, Affliction is the tank-group overflow; feral selector matches cat and bear together (one Feral per group); no Open slots on a full board. single Resto Shaman stays with the healers (user decision)
  { id: 'T50', source: 'tbc25', label: 'T50 30 sign-ups, Tentative and Bench',
    entries: [
      ['palaTank', 'Dawnshield'], ['druidTank', 'Grizzlepaw'],
      ['holyPala', 'Lightforge'], ['restoD', 'Verdancy'], ['restoD', 'Wildmend'], ['disc', 'Atoner'], ['holyP', 'Seraphine'], ['restoS', 'Spiritlink'],
      ['enh', 'Thunderfist'], ['enh', 'Earthbind'], ['feral', 'Prowler'], ['retPala', 'Paragon'], ['arms', 'Warbringer'], ['fury', 'Gladiatrix'], ['combat', 'Backstabber'], ['sv', 'Marksmaster'],
      ['arcane', 'Arcanum'], ['arcane', 'Starweaver'], ['shadow', 'Dreamless'], ['destro', 'Rainoffire'], ['destro', 'Immolator'], ['destro', 'Voidcaller'], ['ele', 'Stormcaller'], ['balance', 'Lunarbeam'], ['affli', 'Plaguebringer'],
      ['fire', 'Scorchy', 'tentative'], ['mm', 'Steadyshot', 'tentative'], ['holyPala', 'Gracebringer', 'tentative'],
      ['destro', 'Hellspawn', 'bench'], ['combat', 'Gouger', 'bench']
    ],
    expect: { raidSize: 25, seated: 25, benched: 5, tentativeBenched: 5, minHealersSeated: 6, windfuryGroups: 2,
      together: [['retPala', 'enh'], ['destro', 'ele'], ['balance', 'ele'], ['shadow', 'holyP']],
      apart: [['enh', 1], ['feral', 1]],
      mixedDpsGroups: 0, huntersInCasterGroups: 0, tankGroup: { maxDps: 1, minHealers: 3 }, suggestedCount: 0, localOptimum: true } },

  // design: 2 tanks / 4 healers (floor 5, so one suggestion is a healer) / 8 physical incl. 3 hunters, one Enh / 9 casters; the full melee group holds the Enh, the hunters share a group with the Prot Warrior and one free seat; the reference comp gives every physical group a Feral (rule 4) and LotP is worth more to three hunters than Trueshot; the Feral must not be charged for Windfury there (nobody in that group can use it) and a Marksmanship suggestion earns nothing for Improved Hunter's Mark (any hunter covers it)
  { id: 'T51', source: 'tbc25', label: 'T51 23 signups, hunter group gets a Feral',
    entries: [
      ['palaTank', 'Bastionel'], ['warriorTank', 'Stonewarden'],
      ['restoS', 'Tidecaller'], ['restoD', 'Mossheart'], ['holyPala', 'Dawnbringer'], ['holyP', 'Hymnal'],
      ['enh', 'Stormhowl'], ['retPala', 'Crusadia'], ['fury', 'Rageborn'], ['combat', 'Blademist'], ['arms', 'Colossar'],
      ['bm', 'Beastcaller'], ['bm', 'Packleader'], ['sv', 'Snaretrap'],
      ['ele', 'Voltaic'], ['ele', 'Galecrest'], ['affli', 'Wiltshade'], ['balance', 'Starfallen'], ['destro', 'Emberlash'], ['destro', 'Ashmantle'],
      ['shadow', 'Gloomveil'], ['arcane', 'Spellwisp'], ['arcane', 'Runebloom'],
      ['arcane', 'Idlemage', 'bench'], ['druidTank', 'Thornhide', 'tentative'], ['restoS', 'Brookwhisper', 'tentative']
    ],
    expect: { raidSize: 25, seated: 23, benched: 3, tentativeBenched: 3, suggestedCount: 2, suggested: ['feral'],
      together: [['feral', 'bm']], apart: [['feral', 1]],
      tankGroup: { maxDps: 0, minHealers: 3 }, huntersInCasterGroups: 0, minHealersSeated: 4, localOptimum: true } }
];

return { SPEC_KEYS, scenarios, toRaidHelperJson, signUp };
});
