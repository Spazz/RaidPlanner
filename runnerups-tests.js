/**
 * Raidsmith - Open-slot runner-ups ("stacked cards")
 * Run: node runnerups-tests.js
 *
 * OpenSlots.choose() ranks every candidate spec for each empty seat; the top pick becomes the suggested Open slot
 * and the next two distinct specs ride along as `alts` ({ class, spec, gap }, gap = whole percent below the top
 * pick). The alts persist wherever slots persist (PreferredSlots.clean is the one gate), a runner-up swaps in as the
 * leader's own request, and a slot with alts draws as a stack.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const ctx = app.sandbox(['State', 'Config', 'Optimizer', 'OpenSlots', 'PreferredSlots', 'PlanStore', 'Import', 'nextUid', 'RosterEdit']);
const { State, Config, Optimizer, OpenSlots, PreferredSlots, PlanStore, Import, nextUid } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}
// Objects built inside the vm sandbox have another realm's prototypes: compare them as JSON.
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);
const norm = (s) => s.replace(/\r\n/g, '\n');

const DPS_14 = [
  ['WARRIOR', 'Fury', 'melee_dps'], ['ROGUE', 'Combat', 'melee_dps'], ['ROGUE', 'Combat', 'melee_dps'], ['SHAMAN', 'Enhancement', 'melee_dps'],
  ['HUNTER', 'Beast Mastery', 'ranged_dps'], ['HUNTER', 'Beast Mastery', 'ranged_dps'], ['MAGE', 'Fire', 'caster_dps'], ['MAGE', 'Arcane', 'caster_dps'],
  ['WARLOCK', 'Destruction', 'caster_dps'], ['WARLOCK', 'Destruction', 'caster_dps'], ['PRIEST', 'Shadow', 'caster_dps'], ['DRUID', 'Balance', 'caster_dps'],
  ['SHAMAN', 'Elemental', 'caster_dps'], ['DRUID', 'Feral', 'melee_dps'],
];

function seat(specs, raid = 'bt') {
  State.gameVersion = 'tbc';
  State.selectedRaid = raid;
  State.optimizerMode = 'max_dps';
  State.preferredSlots = []; State.playerConstraints = []; State.drummers = []; State.buffOverrides = {};
  State.bench = []; State.roster = [];
  const numGroups = Config.Raids[raid].groups;
  State.groups = Array.from({ length: numGroups }, () => []);
  specs.forEach(([cls, spec, role], i) => {
    State.groups[i % numGroups].push({ uid: nextUid(), name: 'P' + i, class: cls, spec, role, groupNumber: (i % numGroups) + 1, imported: true });
  });
  State.roster = State.groups.flat();
}
const autos = () => State.preferredSlots.filter(p => p.auto);

check('choose(): every pick carries up to two distinct runner-ups', () => {
  seat(DPS_14.slice(0, 12));
  const picks = OpenSlots.choose();
  assert.equal(picks.length, 25 - 12);
  for (const pick of picks) {
    assert(pick.alts.length <= 2);
    const keys = [pick, ...pick.alts].map(p => p.class + '|' + p.spec);
    assert.equal(new Set(keys).size, keys.length, 'top pick and alts are distinct specs');
    for (const a of pick.alts) assert(a.gap === null || (Number.isInteger(a.gap) && a.gap >= 0));
  }
  assert(picks.some(p => p.alts.length === 2), 'a pool this size always has two runner-ups');
});

check('choose(): runner-ups come back in score order, so their gaps never shrink', () => {
  seat(DPS_14.slice(0, 12));
  for (const pick of OpenSlots.choose()) {
    const gaps = pick.alts.map(a => a.gap);
    if (gaps.some(g => g === null)) continue;
    same(gaps, [...gaps].sort((a, b) => a - b));
  }
});

check('Optimize stores alts on auto slots and a second Optimize is stable', () => {
  seat(DPS_14.slice(0, 12));
  Optimizer.optimize();
  const slots = autos();
  assert.equal(slots.length, 13);
  assert(slots.some(s => s.alts && s.alts.length));
  for (const s of slots) if (s.alts) assert(s.alts.every(a => a.class && a.spec && 'gap' in a));
  const specs = slots.map(s => s.class + s.spec).sort().join(',');
  Optimizer.optimize();
  assert.equal(autos().map(s => s.class + s.spec).sort().join(','), specs);
});

check('gap math: percent of the top pick gain, null when the top gain is not positive', () => {
  const mk = (topGain, gains) => ({
    candidate: { class: 'MAGE', spec: 'Fire' }, gain: topGain,
    ranked: [{ candidate: { class: 'MAGE', spec: 'Fire' }, gain: topGain }, ...gains.map(([spec, gain]) => ({ candidate: { class: 'MAGE', spec }, gain }))],
  });
  same(OpenSlots._runnerUps(mk(100, [['Frost', 94], ['Arcane', 89], ['Fire', 50]])).map(a => [a.spec, a.gap]), [['Frost', 6], ['Arcane', 11]], 'capped at two, top spec never repeated');
  assert.equal(OpenSlots._runnerUps(mk(0, [['Frost', -3]]))[0].gap, null, 'zero top gain has no percentage');
  assert.equal(OpenSlots._runnerUps(mk(-5, [['Frost', -8]]))[0].gap, null, 'negative top gain has no percentage');
  assert.equal(OpenSlots._runnerUps(mk(1000, [['Frost', 999.9]]))[0].gap, 0, 'under half a point rounds to 0');
});

check('PreferredSlots.clean keeps valid alts on auto slots and drops malformed or manual ones', () => {
  const good = { group: 0, class: 'MAGE', spec: 'Fire', auto: true, alts: [{ class: 'MAGE', spec: 'Frost', gap: 6 }, { class: 'WARLOCK', spec: 'Destruction', gap: null }, { class: 'ROGUE', spec: 'Combat', gap: 20 }] };
  const [kept] = PreferredSlots.clean([good]);
  same(kept.alts, [{ class: 'MAGE', spec: 'Frost', gap: 6 }, { class: 'WARLOCK', spec: 'Destruction', gap: null }], 'max two');
  const [bad] = PreferredSlots.clean([{ ...good, alts: [{ class: 'MAGE', spec: 'Holy', gap: 1 }, { class: 'MAGE', spec: 'Fire', gap: 2 }, null, 'x', { class: 'MAGE', spec: 'Frost', gap: 'big' }] }]);
  same(bad.alts, [{ class: 'MAGE', spec: 'Frost', gap: null }], 'unknown spec, duplicate of the top pick and junk are dropped');
  const [manual] = PreferredSlots.clean([{ group: 0, class: 'MAGE', spec: 'Fire', alts: good.alts }]);
  assert(!('alts' in manual) && !('auto' in manual), 'manual slots never carry alts');
  const [old] = PreferredSlots.clean([{ group: 0, class: 'MAGE', spec: 'Fire', auto: true }]);
  assert(!('alts' in old), 'old plans without alts load as a single card');
});

check('alts survive PlanStore save/restore, share links and saved rosters', () => {
  seat(DPS_14.slice(0, 12));
  Optimizer.optimize();
  const before = JSON.stringify(State.preferredSlots);
  assert(before.includes('"alts"'));
  State.planId = 'plan:runnerups';
  State.rosterName = 'Runner-ups';
  const snapshot = PlanStore.capture();
  const shared = Import.exportShareString();
  const saved = Import.exportRoster();
  State.preferredSlots = [];
  assert(Import.importAddonString(shared).success);
  assert.equal(JSON.stringify(State.preferredSlots), before, 'share link');
  State.preferredSlots = [];
  assert(PlanStore.restore(snapshot));
  assert.equal(JSON.stringify(State.preferredSlots), before, 'device save');
  State.preferredSlots = [];
  Import.loadRoster(saved);
  assert.equal(JSON.stringify(State.preferredSlots), before, 'saved roster');
});

check('a share payload without alts (an old link) loads as plain suggested slots', () => {
  seat(DPS_14.slice(0, 12));
  Optimizer.optimize();
  for (const s of State.preferredSlots) delete s.alts;
  const shared = Import.exportShareString();
  State.preferredSlots = [];
  assert(Import.importAddonString(shared).success);
  assert(State.preferredSlots.length > 0 && State.preferredSlots.every(s => s.auto && !('alts' in s)));
});

check('picking a runner-up makes a manual slot of that spec with no alts; Optimize keeps it', () => {
  seat(DPS_14.slice(0, 12));
  Optimizer.optimize();
  const slot = autos().find(s => s.alts && s.alts.length);
  const alt = slot.alts[0];
  assert(PreferredSlots.add(slot.group, alt.class, alt.spec, slot));
  assert(!slot.auto && !('alts' in slot));
  assert.equal(slot.class + slot.spec, alt.class + alt.spec);
  Optimizer.optimize();
  const manual = PreferredSlots.manual();
  assert.equal(manual.length, 1);
  assert.equal(manual[0].class + manual[0].spec, alt.class + alt.spec);
  assert(!('alts' in manual[0]));
});

check('editing a suggested slot in the drawer (same call) drops its alts too', () => {
  const slot = { group: 0, class: 'MAGE', spec: 'Fire', auto: true, alts: [{ class: 'MAGE', spec: 'Frost', gap: 6 }] };
  State.groups = [[]]; State.preferredSlots = [slot];
  assert(PreferredSlots.add(0, 'MAGE', 'Arcane', slot));
  same(slot, { group: 0, class: 'MAGE', spec: 'Arcane' });
});

check('a stacked slot renders as real buttons that fan out; a plain slot keeps its old card', () => {
  const src = norm(app.slice('// ── SUGGESTION STACKS', 'function renderGroups() {'));
  const c = app.sandbox(['suggestionStackHTML', 'suggestionGapLabel'], { extraSource: src, globals: {
    getSpecIcon: () => '<icon>', preferredColorClass: cls => ' pref-' + cls.toLowerCase(), commit: () => {}, renderGroups: () => {},
  } });
  const { suggestionStackHTML, suggestionGapLabel } = c.api;
  const top = { group: 0, class: 'PRIEST', spec: 'Shadow', auto: true, alts: [{ class: 'MAGE', spec: 'Fire', gap: 6 }, { class: 'WARLOCK', spec: 'Destruction', gap: 11 }] };
  const stack = suggestionStackHTML(top, 2, 4, false);
  assert(stack.includes('class="player-slot preferred-slot preferred-stack pref-priest"'), 'still a drop-target slot');
  assert(stack.includes('data-group="2" data-slot="4"'));
  assert.equal((stack.match(/class="stack-peek /g) || []).length, 2, 'two peeking layers');
  assert(stack.includes('stack-peek-2 pref-mage') && stack.includes('stack-peek-1 pref-warlock'), 'peeks use their class colours');
  assert(stack.includes('+2 close options'));
  assert(stack.includes('aria-label="Suggested Shadow Priest, 2 more options"'));
  assert(stack.includes('<button type="button" class="stack-card stack-front" data-stack-open aria-expanded="false"'));
  const one = suggestionStackHTML({ ...top, alts: [top.alts[0]] }, 0, 0, false);
  assert(one.includes('+1 close option<') && one.includes('1 more option"'));
  const fan = suggestionStackHTML(top, 2, 4, true);
  assert.equal((fan.match(/<button /g) || []).length, 4, 'three cards and the Other spec link');
  assert(fan.includes('>Best<') && fan.includes('>-6%<') && fan.includes('>-11%<'));
  assert(fan.includes('data-stack-close') && fan.includes('data-stack-pick="0"') && fan.includes('data-stack-pick="1"') && fan.includes('data-stack-other'));
  assert(fan.includes('Other spec...'));
  assert.equal(suggestionGapLabel(null), '', 'no number when the gap is not expressible');
  assert.equal(suggestionGapLabel(0), '-<1%');
  const renderSrc = norm(app.slice('function renderGroups() {', '// Buff picker delegation'));
  assert(/if \(preference\.auto && preference\.alts\?\.length\) \{/.test(renderSrc), 'renderGroups only stacks auto slots that have alts');
  assert(/Suggested by Optimize/.test(renderSrc), 'the plain card markup is still there');
});

check('stack CSS sits beside the .preferred-slot rules and uses the class colour token', () => {
  const css = norm(app.css);
  assert(css.indexOf('.preferred-stack .stack-peek') > css.indexOf('.preferred-slot {'));
  assert(/\.preferred-stack \.stack-card \{[^}]*var\(--preferred-color\)/.test(css));
  assert(/\.preferred-stack \.stack-peek-2 \{ transform: translate\(6px, 6px\)/.test(css));
});

console.log(`\n${passed} runner-up checks passed`);
