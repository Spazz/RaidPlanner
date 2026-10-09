/**
 * PartyPlanner Web — Wave 1 feature tests
 * Run: node features-tests.js
 *
 * Same vm loader pattern as classic-tests.js/version-tests.js: the logic half
 * of index.html's <script> (everything before '// ── UI RENDERING') runs in a
 * sandboxed context and the pieces under test are pulled out through
 * globalThis.api. Covers the three wave-1 features:
 *   #1 Import.exportChatText()      — chat text export (full + compact)
 *   #2/#3 Readiness.utilityCoverage()/.balanceWarnings() — utility checklist
 *        + soft composition warnings
 *   #11 State.notes                 — raid notes round-trip
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
const ctx = app.sandbox(['State', 'Config', 'GameVersions', 'Rulesets', 'Import', 'Optimizer', 'Readiness', 'getGroupBuffs', 'getMissingBuffInsights', 'getRaidDebuffCoverage', 'Faction', 'enforceRaidCapacity', 'nextUid', 'PlanStore', 'NO_ROSTER_NAME', 'NOTES_MAX_LENGTH']);
const { State, Config, GameVersions, Rulesets, Import, Optimizer, Readiness, getGroupBuffs, getMissingBuffInsights, getRaidDebuffCoverage, Faction, enforceRaidCapacity, nextUid, PlanStore, NO_ROSTER_NAME, NOTES_MAX_LENGTH } = ctx.api;

function mk(cls, spec, role, name) {
  return { uid: nextUid(), name: name || (cls + '-' + spec), class: cls, spec, role, groupNumber: 0 };
}
function numberGroups(groups) {
  groups.forEach((g, gi) => g.forEach(p => { p.groupNumber = gi + 1; }));
  return groups;
}
function resetState() {
  State.gameVersion = 'tbc';
  State.selectedRaid = 'bt';
  State.groups = [];
  State.bench = [];
  State.roster = [];
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.buffOverrides = {};
  State.campfires = { professions: [], fires: [] };
  State.rosterName = 'Test Raid';
  State.notes = '';
  State.planId = null;
  State.sourceEventId = null;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

// ════════════════════════════════════════════════════════════════
// #1 — Copy Raid Chat Text (Import.exportChatText)
// ════════════════════════════════════════════════════════════════

check('TBC chat text: header, group lines, buffs, bench (full variant)', () => {
  resetState();
  State.groups = numberGroups([
    [mk('WARRIOR', 'Protection', 'tank', 'Tanko'), mk('SHAMAN', 'Enhancement', 'melee_dps', 'Shammy'), mk('MAGE', 'Frost', 'caster_dps', 'Frosty')],
  ]);
  State.bench = [mk('PRIEST', 'Discipline', 'healer', 'Bencho')];
  State.roster = State.groups.flat();

  const text = Import.exportChatText({ compact: false });
  const lines = text.split('\n');

  assert.match(lines[0], /^25-man /, 'header names the raid size (the specific raid is no longer shown)');
  assert.match(lines[0], /WoW TBC/, 'header names the version');
  assert.match(lines[0], /Test Raid/, 'header names the roster');

  const groupLine = lines.find(l => l.startsWith('G1:'));
  assert(groupLine, 'a G1 line exists');
  assert(groupLine.includes('Tanko (Protection Warrior)'), 'seated player formatted as Name (Spec Class)');
  assert(groupLine.includes('Shammy (Enhancement Shaman)'), 'shaman formatted correctly');
  assert(groupLine.includes('Frosty (Frost Mage)'), 'mage formatted correctly');
  assert(groupLine.includes('buffs:'), 'group line includes a buffs tail');
  assert(groupLine.includes('WF'), 'Windfury abbreviation present (Enhancement Shaman in a melee group)');

  const benchLine = lines.find(l => l.startsWith('Bench:'));
  assert(benchLine, 'a Bench line exists');
  assert(benchLine.includes('Bencho (Discipline Priest)'), 'benched player listed');
  assert(!benchLine.includes('Tanko'), 'seated players are not repeated on the bench line');
});

check('Classic chat text: Horde group with Windfury, no paladin content leaks in', () => {
  resetState();
  State.gameVersion = 'classic';
  State.selectedRaid = 'mc';
  State.groups = numberGroups([
    [mk('WARRIOR', 'Fury', 'melee_dps', 'Furio'), mk('ROGUE', 'Combat', 'melee_dps', 'Sneaky'), mk('SHAMAN', 'Enhancement', 'melee_dps', 'Totemus')],
  ]);
  State.bench = [];
  State.roster = State.groups.flat();
  assert.equal(Faction.current(), 'horde');

  const text = Import.exportChatText({ compact: false });
  assert.match(text.split('\n')[0], /^40-man /);
  assert.match(text.split('\n')[0], /WoW Classic/);
  const groupLine = text.split('\n').find(l => l.startsWith('G1:'));
  assert(groupLine.includes('Totemus (Enhancement Shaman)'));
  assert(groupLine.includes('WF'), 'Windfury covers this melee group');
  assert(!/paladin|Paladin|PALADIN/.test(text), 'a Horde roster produces no Paladin content');
});

check('Full variant includes non-empty notes; omits them when empty', () => {
  resetState();
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps', 'Solo')]]);
  State.roster = State.groups.flat();

  State.notes = 'MT swap at 20%, watch for adds.';
  let text = Import.exportChatText({ compact: false });
  assert(text.includes('Notes: MT swap at 20%, watch for adds.'), 'non-empty notes appear in the full variant');

  State.notes = '';
  text = Import.exportChatText({ compact: false });
  assert(!text.includes('Notes:'), 'empty notes produce no Notes: line');

  State.notes = 'Should not appear in compact';
  const compact = Import.exportChatText({ compact: true });
  assert(!compact.includes('Notes:'), 'compact variant never includes notes');
});

// Printable ASCII plus Latin-1 Supplement / Latin Extended-A/B letters (minus
// the multiplication/division signs) — what chatSafe() keeps. See index.html
// UTILITIES > chatSafe.
const CHAT_SAFE_CHARS = /^[\x20-\x7EÀ-ÖØ-öø-ɏ]*$/;

check('Compact variant: every line <= 255 UTF-8 bytes, printable ASCII + Latin letters only, no pipes, accented names survive', () => {
  resetState();
  // A big, buff-heavy 25-man to try to force a long line, plus deliberately
  // long/accented names to stress both the byte cap and the sanitizer.
  const longName = 'Superduperlongraidernamethatgoesonandon' + 'X'.repeat(40);
  const group = [
    mk('WARRIOR', 'Protection', 'tank', longName + '1'),
    mk('PALADIN', 'Holy', 'healer', 'Thráll2'), // accented Latin letters must survive, not be deleted
    mk('SHAMAN', 'Enhancement', 'melee_dps', longName + '3'),
    mk('MAGE', 'Frost', 'caster_dps', longName + '4'),
    mk('PRIEST', 'Discipline', 'healer', longName + '5'),
  ];
  State.groups = numberGroups([group, group.map(p => ({ ...p, uid: nextUid() }))]);
  State.bench = [mk('DRUID', 'Balance', 'caster_dps', longName + '6')];
  State.roster = State.groups.flat();

  const text = Import.exportChatText({ compact: true });
  const lines = text.split('\n').filter(Boolean);
  assert(lines.length >= 3, 'header + at least 2 group lines + bench');
  assert(text.includes('Thráll2'), 'accented player name survives the compact export instead of being deleted');
  for (const line of lines) {
    const byteLen = Buffer.byteLength(line, 'utf8');
    assert(byteLen <= 255, `line exceeds 255 UTF-8 bytes (${byteLen}): ${line.slice(0, 60)}...`);
    assert(CHAT_SAFE_CHARS.test(line), `line has characters outside printable ASCII/Latin: ${line}`);
    assert(!line.includes('|'), `line contains a pipe character: ${line}`);
    assert(!/ {2,}/.test(line), `line has doubled spaces: ${line}`);
  }
});

check('chatSafe (via exportChatText notes) normalizes dashes/quotes/ellipsis and strips emoji', () => {
  resetState();
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps', 'Solo')]]);
  State.roster = State.groups.flat();
  State.notes = 'MT swap at 20% — watch adds 😀 “ready”… go!';
  const text = Import.exportChatText({ compact: false });
  const notesLine = text.split('\n').find(l => l.startsWith('Notes:'));
  assert(notesLine, 'notes line present');
  assert(notesLine.includes(' - watch'), 'em dash normalized to " - " instead of deleted');
  assert(notesLine.includes('"ready"'), 'curly double quotes normalized to straight quotes');
  assert(notesLine.includes('...'), 'ellipsis normalized to three dots');
  assert(!/[\u{1F300}-\u{1FAFF}]/u.test(notesLine), 'emoji stripped');
  assert(!/ {2,}/.test(notesLine), 'no doubled spaces left behind by stripped characters');
});

check('Empty roster produces no group/bench lines, just the header', () => {
  resetState();
  const text = Import.exportChatText({ compact: false });
  const lines = text.split('\n');
  assert.equal(lines.length, 1, 'only the header line is produced');
  assert(!text.includes('G1:'));
  assert(!text.includes('Bench:'));
});

// ════════════════════════════════════════════════════════════════
// #2/#3 — Utility coverage + balance warnings (Readiness)
// ════════════════════════════════════════════════════════════════

check('Utility coverage: seated Druid covers Battle Rez; bench Druid reported separately', () => {
  resetState();
  State.groups = numberGroups([[mk('DRUID', 'Restoration', 'healer'), mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.bench = [];
  State.roster = State.groups.flat();

  let items = Readiness.utilityCoverage();
  let battleRez = items.find(i => i.id === 'BATTLE_REZ');
  assert(battleRez, 'Battle Rez is in the TBC utility table');
  assert.equal(battleRez.covered, true);
  assert.equal(battleRez.seatedCount, 1);

  // No Druid/Warlock seated, but one benched.
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.bench = [mk('DRUID', 'Balance', 'caster_dps')];
  items = Readiness.utilityCoverage();
  battleRez = items.find(i => i.id === 'BATTLE_REZ');
  assert.equal(battleRez.covered, false);
  assert.equal(battleRez.benchCount, 1);
  assert.equal(battleRez.benchProviders[0].class, 'DRUID');

  // Nobody at all.
  State.bench = [];
  items = Readiness.utilityCoverage();
  battleRez = items.find(i => i.id === 'BATTLE_REZ');
  assert.equal(battleRez.covered, false);
  assert.equal(battleRez.benchCount, 0);
});

check('Utility coverage: TBC-only entries (Bloodlust, Misdirection) exist only on TBC', () => {
  assert(Rulesets.tbc.utilities.BLOODLUST, 'TBC has Bloodlust');
  assert(Rulesets.tbc.utilities.MISDIRECTION, 'TBC has Misdirection');
  assert(!Rulesets.classic.utilities.BLOODLUST, 'Classic has no Bloodlust');
  assert(!Rulesets.classic.utilities.MISDIRECTION, 'Classic has no Misdirection');
  assert(Rulesets.classic.utilities.TRANQ_SHOT, 'Classic has Tranquilizing Shot');
  assert(!Rulesets.tbc.utilities.TRANQ_SHOT, 'TBC does not model Tranquilizing Shot');
});

check('Utility coverage: Classic faction lock drops Fear Break entirely for Alliance', () => {
  resetState();
  State.gameVersion = 'classic';
  State.selectedRaid = 'mc';
  // Alliance roster: Paladin present, no Shaman.
  State.groups = numberGroups([[mk('PALADIN', 'Holy', 'healer'), mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.bench = [];
  State.roster = State.groups.flat();
  assert.equal(Faction.current(), 'alliance');

  let items = Readiness.utilityCoverage();
  assert(!items.find(i => i.id === 'FEAR_BREAK'), 'Fear Break (Shaman-only) is not shown to an Alliance roster');
  // Cure Poison still shows because Druid/Paladin remain possible providers.
  const curePoison = items.find(i => i.id === 'CURE_POISON');
  assert(curePoison, 'Cure Poison still applies (Paladin Cleanse remains a provider)');
  assert.equal(curePoison.covered, true, 'the seated Paladin covers it');

  // Horde roster: Shaman present, no Paladin.
  State.groups = numberGroups([[mk('SHAMAN', 'Restoration', 'healer'), mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.roster = State.groups.flat();
  assert.equal(Faction.current(), 'horde');
  items = Readiness.utilityCoverage();
  const fearBreak = items.find(i => i.id === 'FEAR_BREAK');
  assert(fearBreak, 'Fear Break applies to a Horde roster');
  assert.equal(fearBreak.covered, true, 'the seated Shaman covers it');
});

check('Utility coverage: Forever is now modeled but still borrows the Classic utility table', () => {
  resetState();
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  State.groups = numberGroups([[mk('DRUID', 'Restoration', 'healer')]]);
  State.bench = [];
  State.roster = State.groups.flat();
  assert(Rulesets.forever, 'Forever now has its own ruleset (buffs/debuffs/rules)');
  assert.equal(Rulesets.forever.utilities, undefined, 'Forever does not define its own utilities table');
  assert.equal(Config.Utilities, Rulesets.classic.utilities, 'Forever falls back to the Classic utility table');
  const items = Readiness.utilityCoverage();
  assert(items.find(i => i.id === 'BATTLE_REZ'), 'Forever borrows the Classic utility table rather than showing nothing');
});

check('Utility coverage: a mixed Forever raid (Shaman + Paladin, no faction lock) sees both totem and aura utility providers', () => {
  resetState();
  State.gameVersion = 'forever';
  State.selectedRaid = 'f_ony';
  // Forever has no faction lock, so a Shaman and a Paladin can be seated together.
  State.groups = numberGroups([[
    mk('SHAMAN', 'Restoration', 'healer', 'Shammy'),
    mk('PALADIN', 'Holy', 'healer', 'Pallyman'),
  ]]);
  State.bench = [];
  State.roster = State.groups.flat();
  assert.equal(Rulesets.forever.rules.factionLock, false, 'Forever opts out of the faction lock');

  const items = Readiness.utilityCoverage();
  const fearBreak = items.find(i => i.id === 'FEAR_BREAK');
  assert(fearBreak, 'Fear Break (Shaman-only) is not faction-filtered away on Forever');
  assert.equal(fearBreak.covered, true, 'the seated Shaman covers Fear Break');
  const cureDisease = items.find(i => i.id === 'CURE_DISEASE');
  assert(cureDisease, 'Cure Disease applies');
  assert.equal(cureDisease.covered, true, 'the seated Paladin (Cleanse) covers Cure Disease');
});

check('Balance warnings: melee/ranged skew fires above 70%, not below', () => {
  resetState();
  const meleeHeavy = [
    mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'),
    mk('ROGUE', 'Assassination', 'melee_dps'), mk('WARRIOR', 'Arms', 'melee_dps'), mk('DRUID', 'Feral', 'melee_dps'),
    mk('WARRIOR', 'Fury', 'melee_dps'), mk('MAGE', 'Frost', 'caster_dps'), mk('PRIEST', 'Holy', 'healer'),
  ];
  State.groups = numberGroups([meleeHeavy]);
  State.roster = State.groups.flat();
  let warnings = Readiness.balanceWarnings();
  assert(warnings.find(w => w.id === 'SKEW_MELEE'), 'a melee-heavy roster warns about skew');

  const balanced = [
    mk('WARRIOR', 'Protection', 'tank'), mk('WARRIOR', 'Fury', 'melee_dps'), mk('ROGUE', 'Combat', 'melee_dps'),
    mk('MAGE', 'Frost', 'caster_dps'), mk('HUNTER', 'Marksmanship', 'ranged_dps'), mk('WARLOCK', 'Destruction', 'caster_dps'),
    mk('PRIEST', 'Holy', 'healer'), mk('DRUID', 'Restoration', 'healer'),
  ];
  State.groups = numberGroups([balanced]);
  State.roster = State.groups.flat();
  warnings = Readiness.balanceWarnings();
  assert(!warnings.find(w => w.id === 'SKEW_MELEE' || w.id === 'SKEW_RANGED'), 'a balanced roster has no skew warning');
});

check('Balance warnings: class stacking beyond the cap warns, small rosters are skipped', () => {
  resetState();
  const stacked = Array.from({ length: 5 }, () => mk('WARRIOR', 'Fury', 'melee_dps'))
    .concat([mk('PRIEST', 'Holy', 'healer'), mk('MAGE', 'Frost', 'caster_dps'), mk('HUNTER', 'Marksmanship', 'ranged_dps')]);
  State.groups = numberGroups([stacked]);
  State.roster = State.groups.flat();
  assert(State.roster.length >= 8, 'fixture is large enough to not be skipped as noise');
  let warnings = Readiness.balanceWarnings();
  assert(warnings.find(w => w.id === 'STACK_WARRIOR'), '5/8 Warriors (62%) triggers a stacking warning');

  // Tiny roster: skipped even though it is 100% one class.
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps'), mk('WARRIOR', 'Arms', 'melee_dps')]]);
  State.roster = State.groups.flat();
  warnings = Readiness.balanceWarnings();
  assert.equal(warnings.length, 0, 'a roster below the minimum size produces no warnings at all');
});

check('Balance warnings: healer surplus warns well above the floor', () => {
  resetState();
  State.selectedRaid = 'bt'; // 25-man, floor healers per Optimizer.floorsFor
  const floor = Optimizer.floorsFor(25).healer;
  const healers = Array.from({ length: Math.ceil(floor * 2.2) }, () => mk('PRIEST', 'Holy', 'healer'));
  const rest = Array.from({ length: 10 }, () => mk('WARRIOR', 'Fury', 'melee_dps'));
  State.groups = numberGroups([[...healers, ...rest]]);
  State.roster = State.groups.flat();
  const warnings = Readiness.balanceWarnings();
  assert(warnings.find(w => w.id === 'HEALER_SURPLUS'), `expected a healer surplus warning (floor=${floor}, healers=${healers.length})`);
});

// ════════════════════════════════════════════════════════════════
// #11 — Raid Notes round-trip
// ════════════════════════════════════════════════════════════════

check('Notes round-trip through PlanStore capture/restore', () => {
  resetState();
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.roster = State.groups.flat();
  State.planId = 'notes-test-plan';
  State.notes = 'MT swap at phase 2.';
  const snapshot = PlanStore.capture();
  assert.equal(snapshot.notes, 'MT swap at phase 2.');

  State.notes = 'something else entirely';
  assert.equal(PlanStore.restore(snapshot), true);
  assert.equal(State.notes, 'MT swap at phase 2.', 'restore brings the captured notes back');
});

check('Notes do not leak into a plan saved before this field existed', () => {
  resetState();
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.roster = State.groups.flat();
  State.planId = 'legacy-plan';
  const legacy = PlanStore.capture();
  delete legacy.notes; // simulate a plan saved before #11 shipped

  State.notes = 'leftover notes from a different plan';
  assert.equal(PlanStore.restore(legacy), true);
  assert.equal(State.notes, '', 'a plan with no notes field clears State.notes rather than leaving the old value');
});

check('Notes round-trip through exportRoster/loadRoster', () => {
  resetState();
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.roster = State.groups.flat();
  State.notes = 'Roster-level notes.';
  const data = Import.exportRoster('Notes Test');
  assert.equal(data.notes, 'Roster-level notes.');

  State.notes = '';
  assert.equal(Import.loadRoster(JSON.parse(JSON.stringify(data))), true);
  assert.equal(State.notes, 'Roster-level notes.');
});

check('Notes round-trip through the share string', () => {
  resetState();
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.roster = State.groups.flat();
  State.notes = 'Share-string notes with spaces & punctuation!';
  const share = Import.exportShareString();
  assert(share.includes(':'), 'share string is colon-delimited');

  State.notes = '';
  const res = Import.importAddonString(share);
  assert.equal(res.success, true);
  assert.equal(State.notes, 'Share-string notes with spaces & punctuation!');
});

check('Notes are capped at NOTES_MAX_LENGTH on every persistence path', () => {
  resetState();
  State.groups = numberGroups([[mk('WARRIOR', 'Fury', 'melee_dps')]]);
  State.roster = State.groups.flat();
  const huge = 'x'.repeat(NOTES_MAX_LENGTH + 500);

  State.notes = huge;
  const data = Import.exportRoster('Cap Test');
  // exportRoster itself doesn't truncate (the UI textarea's maxlength does),
  // but loadRoster/PlanStore.restore must never let an oversized value in.
  data.notes = huge;
  State.notes = '';
  Import.loadRoster(data);
  assert.equal(State.notes.length, NOTES_MAX_LENGTH, 'loadRoster caps an oversized notes field');

  State.planId = 'cap-test-plan';
  const snap = PlanStore.capture();
  snap.notes = huge;
  State.notes = '';
  PlanStore.restore(snap);
  assert.equal(State.notes.length, NOTES_MAX_LENGTH, 'PlanStore.restore caps an oversized notes field');
});

check('Empty-notes share link is byte-for-byte unchanged (no tail appended)', () => {
  resetState();
  State.selectedRaid = 'bt';
  State.groups = numberGroups(Array.from({ length: Config.Raids.bt.groups }, () => []));
  State.groups[0] = [mk('WARRIOR', 'Fury', 'melee_dps')];
  State.groups[0][0].groupNumber = 1;
  State.bench = [];
  State.roster = State.groups.flat();
  State.notes = ''; // default: no preferredSlots, no preserveGroupOrder, tbc version

  const share = Import.exportShareString();
  const parts = share.split(':');
  // 'PP','2',raid,name,bench + one part per group = 5 + numGroups; no extra
  // tail segment should be appended when nothing optional is set.
  assert.equal(parts.length, 5 + Config.Raids.bt.groups, 'no optional tail is appended for an all-default plan with empty notes');

  // Now force a tail to exist for another reason (Classic version) while
  // notes stays empty — the tail must still omit the "notes" key entirely.
  State.gameVersion = 'classic';
  State.selectedRaid = 'mc';
  State.groups = numberGroups(Array.from({ length: Config.Raids.mc.groups }, () => []));
  State.groups[0] = [mk('WARRIOR', 'Fury', 'melee_dps')];
  State.groups[0][0].groupNumber = 1;
  State.roster = State.groups.flat();
  const shareWithTail = Import.exportShareString();
  const tailParts = shareWithTail.split(':');
  const tail = JSON.parse(decodeURIComponent(tailParts[tailParts.length - 1]));
  assert(!('notes' in tail), 'empty notes never appear as a key in the optional tail');
});

console.log(`\nFeature tests (chat text, utility/balance readiness, raid notes): ${passed} passed, 0 failed, ${passed} total`);
