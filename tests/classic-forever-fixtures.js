/**
 * PartyPlanner Web - Classic/Forever optimizer fixtures
 *
 * The six realistic UNASSIGNED rosters (Classic Horde 40 and 20, Classic Alliance 40, Forever mixed 40, Forever 20 and
 * Forever 10) that two suites feed through the real Raid-Helper importer and Optimizer:
 *   classic-forever-scenarios.js   invariant checks (stranded melee, provider spread, Windfury coverage, idempotence)
 *   boards-tests.js                the golden snapshot of each optimized board (tests/boards-snapshot.json)
 * Data only: editing a roster here changes the golden board too, so it takes a deliberate `node boards-tests.js --update`.
 */

// Realistic sign-up counts per raid, following architecture-map.md's spec-key
// shape ([count, RaidHelperClassName, RaidHelperSpecName]) — same format
// classic-tests.js/forever-tests.js use for their importSignUps() rosters.
// Composition follows the 40-man convention in tasks/research-classic-buffs.md
// ("40-man comp conventions"): ~4-5 tanks, ~10-12 healers, 10-14 melee, 3-5
// hunters, 10-12 casters, a handful of shamans/paladins as the totem/aura
// providers riding inside those role buckets.
const FIXTURES = {
  classicHorde40: {
    version: 'classic', raid: 'mc', label: 'Classic Horde 40 (Molten Core)',
    roster: [
      [4, 'Warrior', 'Protection'], [1, 'Druid', 'Guardian'],
      [4, 'Shaman', 'Restoration1'], [4, 'Priest', 'Holy'], [3, 'Druid', 'Restoration'],
      [4, 'Warrior', 'Fury'], [3, 'Rogue', 'Combat'], [2, 'Rogue', 'Assassination'], [2, 'Shaman', 'Enhancement'], [1, 'Druid', 'Feral'],
      [2, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Beastmastery'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Fire'], [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Shaman', 'Elemental'],
    ],
  },
  classicAlliance40: {
    version: 'classic', raid: 'mc', label: 'Classic Alliance 40 (Molten Core)',
    roster: [
      [4, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'],
      [4, 'Paladin', 'Holy1'], [4, 'Priest', 'Holy'], [3, 'Druid', 'Restoration'],
      [4, 'Warrior', 'Fury'], [3, 'Rogue', 'Combat'], [2, 'Rogue', 'Assassination'], [2, 'Paladin', 'Retribution'], [1, 'Druid', 'Feral'],
      [2, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Beastmastery'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Fire'], [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Priest', 'Shadow'],
    ],
  },
  classicHorde20: {
    version: 'classic', raid: 'zg', label: "Classic Horde 20 (Zul'Gurub)",
    roster: [
      [2, 'Warrior', 'Protection'],
      [2, 'Shaman', 'Restoration1'], [1, 'Priest', 'Holy'], [1, 'Druid', 'Restoration'],
      [2, 'Warrior', 'Fury'], [2, 'Rogue', 'Combat'], [1, 'Shaman', 'Enhancement'], [1, 'Druid', 'Feral'],
      [1, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Shaman', 'Elemental'],
    ],
  },
  foreverMixed40: {
    version: 'forever', raid: 'f_ony', label: "Forever mixed 40 (Onyxia's Lair)",
    roster: [
      [3, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'], [1, 'Druid', 'Guardian'],
      [3, 'Priest', 'Holy'], [1, 'Priest', 'Discipline'], [3, 'Paladin', 'Holy1'], [2, 'Shaman', 'Restoration1'], [2, 'Druid', 'Restoration'],
      [3, 'Warrior', 'Fury'], [3, 'Rogue', 'Combat'], [2, 'Rogue', 'Assassination'], [2, 'Paladin', 'Retribution'], [2, 'Shaman', 'Enhancement'],
      [2, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Beastmastery'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Frost'], [1, 'Mage', 'Fire'], [1, 'Mage', 'Arcane'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Priest', 'Shadow'],
    ],
  },
  forever20: {
    version: 'forever', raid: 'f_hyjal', label: 'Forever 20 (Hyjal Summit)',
    roster: [
      [1, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'],
      [1, 'Shaman', 'Restoration1'], [1, 'Paladin', 'Holy1'], [1, 'Priest', 'Holy'], [1, 'Druid', 'Restoration'],
      [2, 'Warrior', 'Fury'], [1, 'Rogue', 'Combat'], [1, 'Paladin', 'Retribution'], [1, 'Shaman', 'Enhancement'], [1, 'Druid', 'Feral'],
      [1, 'Hunter', 'Marksmanship'], [1, 'Hunter', 'Survival'],
      [2, 'Mage', 'Frost'], [2, 'Warlock', 'Destruction'], [1, 'Warlock', 'Affliction'], [1, 'Shaman', 'Elemental'],
    ],
  },
  forever10: {
    version: 'forever', raid: 'f_barrow', label: 'Forever 10 (Barrow Deeps)',
    roster: [
      [1, 'Warrior', 'Protection'], [1, 'Paladin', 'Protection1'],
      [1, 'Priest', 'Holy'], [1, 'Shaman', 'Restoration1'], [1, 'Paladin', 'Holy1'],
      [1, 'Warrior', 'Fury'], [1, 'Rogue', 'Combat'], [1, 'Shaman', 'Enhancement'],
      [1, 'Hunter', 'Marksmanship'],
      [1, 'Mage', 'Frost'],
    ],
  },
};

module.exports = { FIXTURES };
