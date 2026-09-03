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
 *   partyplanner  - our own additions covering what that list leaves out: 10-man raids,
 *                   Bench sign-ups, unknown specs, realm suffixes, duplicate names,
 *                   floors at the edge, empty/absence-only imports, big overflow
 *
 * Optional per-scenario fields
 *   raid    - raid key to select before import (default: the app's current selection,
 *             which the importer switches to a 10-man automatically for <= 10 raiders)
 *   expect  - see scenario-tests.js: { importFails, skipped, benched, seated, raidSize,
 *             minHealersSeated, tentativeBenched, feralGroups, windfuryGroups, missingNone: [buffId],
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
  unknownClass: ['Deathknight', 'Blood'],      // unknown class and spec -> skipped
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
    entries: [["druidTank","Bearwick"], ["warriorTank","Shieldwall"], ["enh","Windcaller"], ["enh","Stormbrew"], ["ele","Ronii"], ["restoS","Tidecrest"], ["arms","Sunra"], ["fury","Ragefist"], ["feral","Ashwolf"], ["feral","Thornpaw"], ["combat","Yow"], ["assassin","Nightblade"], ["retPala","Cromer"], ["bm","Beastmode"], ["bm","Relapse"], ["mm","Arrowhead"], ["sv","Trapper"], ["shadow","Treshflay"], ["demo","Doomfire"], ["destro","Felstorm"], ["balance","Kerne"], ["arcane","Syba"], ["holyP","Greedius"], ["holyPala","Azuraab"], ["restoD","Sheimz"]] },
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
  { id: 'P06', source: 'partyplanner', label: 'Unknown class is skipped, not seated',
    entries: CORE_25.slice(0, 24).concat([['unknownClass','Arthas']]),
    expect: { seated: 24, skipped: 1 } },
  { id: 'P17', source: 'partyplanner', label: 'Unknown spec on a known class is seated by class',
    entries: CORE_25.slice(0, 24).concat([['unknownSpec','Gladiatus']]),
    expect: { seated: 25, skipped: 0 } },
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
    entries: many('arms', 'Gone', 6, 'absence'), expect: { importFails: true, skipped: 6 } },
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
];

return { SPEC_KEYS, scenarios, toRaidHelperJson, signUp };
});
