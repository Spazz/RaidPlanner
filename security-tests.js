/**
 * PartyPlanner Web - Share-link security and name-codec tests
 * Run: node security-tests.js
 *
 * Covers the Phase 1 G1 fixes:
 *   - Class/spec/role from share links, live links, v1 strings, JSON rosters,
 *     unplaced entries and saved plans are accepted only when the active
 *     ruleset knows them (PlayerIdentity), so a crafted payload cannot reach
 *     the innerHTML renderers. getSpecIcon/getRoleIcon also escape on their own.
 *   - Player names that contain the share-string delimiters (. , :) survive a
 *     share round trip, and links generated before the fix still decode.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');
// ROLE_ICONS..getSpecIcon live past the UI split; pull just that chunk in.
const iconSource = app.slice('const ROLE_ICONS = {', '// Raid-Helper sign-up status as a small colored tag');
const ctx = app.sandbox(
  ['State', 'Config', 'Import', 'PlanStore', 'PlayerIdentity', 'SignupStatus', 'nextUid', 'getSpecIcon', 'getRoleIcon'],
  { globals: { btoa, atob, escape, unescape }, extraSource: iconSource });
const { State, Config, Import, PlanStore, PlayerIdentity, SignupStatus, nextUid, getSpecIcon, getRoleIcon } = ctx.api;

// vm-realm arrays/objects never deepEqual main-realm literals; compare their JSON shape.
const deq = (actual, expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const EVIL = 'x"><svg onload=alert(1)>';
const mk = (name, cls, spec, role, groupNumber) => ({ uid: nextUid(), name, class: cls, spec, role, groupNumber: groupNumber || 1, imported: true });

function resetState() {
  State.gameVersion = 'tbc';
  State.selectedRaid = 'kara';
  State.groups = [];
  for (let i = 0; i < Config.Raids.kara.groups; i++) State.groups.push([]);
  State.roster = [];
  State.bench = [];
  State.unplaced = [];
  State.planId = null;
  State.rosterName = 'Test Roster';
  State.notes = '';
  State.buffOverrides = {};
  State.preferredSlots = [];
  State.preserveGroupOrder = false;
  State.optimizerMode = 'balanced';
}
function seat(groupIdx, players) {
  for (const p of players) { p.groupNumber = groupIdx + 1; State.groups[groupIdx].push(p); }
  State.roster = State.groups.flat();
}
// Link whose JSON tail sits after every raid group (bench list is field 4).
const linkWithTail = (bench, tail) => ['PP', '2', 'kara', '', bench, ...Array(Config.Raids.kara.groups).fill(''), tail].join(':');
const allPlayers = () => [...State.roster, ...State.bench, ...State.unplaced];
// What renderers must never see: markup characters inside class/spec/role.
const hasInjection = (p) => [p.class, p.spec, p.role].some(v => typeof v === 'string' && /[<>"'=]/.test(v));

// ── 1. PlayerIdentity ────────────────────────────────────────────
check('PlayerIdentity accepts every ruleset class/spec with a known role', () => {
  for (const [cls, specs] of Object.entries(Config.Specs)) {
    for (const s of Object.values(specs)) assert(PlayerIdentity.isValid(mk('A', cls, s.name, s.role)), cls + ' ' + s.name);
  }
  for (const role of Object.values(Config.Roles)) assert(PlayerIdentity.isRole(role), role);
});
check('PlayerIdentity rejects unknown, mismatched, inherited-key and non-string values', () => {
  const bad = [
    mk('A', 'WARRIOR', EVIL, 'tank'), mk('A', EVIL, 'Arms', 'tank'), mk('A', 'WARRIOR', 'Arms', EVIL),
    mk('A', 'WARRIOR', 'Holy', 'healer'),                       // spec of another class
    mk('A', 'WARRIOR', 'Arms', 'dps'),                          // not a role of this ruleset
    mk('A', 'constructor', 'Arms', 'tank'), mk('A', '__proto__', 'Arms', 'tank'),
    mk('A', 'WARRIOR', 'Arms', 'constructor'), mk('A', 'warrior', 'Arms', 'tank'),
    mk('A', null, null, null), mk('A', ['WARRIOR'], 'Arms', 'tank'), mk(42, 'WARRIOR', 'Arms', 'tank'),
    null, undefined, 'WARRIOR',
  ];
  for (const p of bad) assert(!PlayerIdentity.isValid(p), 'should reject ' + JSON.stringify(p));
  deq(PlayerIdentity.cleanList(bad.concat([mk('Ok', 'MAGE', 'Frost', 'caster_dps')])).map(p => p.name), ['Ok']);
  deq(PlayerIdentity.cleanList('nope'), []);
});

// ── 2. Every ingestion path ──────────────────────────────────────
const goodPlayer = 'Good.MA.Fro.C';
check('v2 share link: a crafted spec is dropped, valid players survive', () => {
  resetState();
  const link = `PP:2:kara::Evil.WR.${EVIL}.T,${goodPlayer}:Bad.${EVIL}.Fury.M,Bad2.WR.Arms.${EVIL}:`;
  const res = Import.importAddonString(link);
  assert(res.success, res.error);
  deq(allPlayers().map(p => p.name), ['Good']);
  assert(!allPlayers().some(hasInjection));
});
check('v2 share link made only of invalid players is rejected', () => {
  resetState();
  const res = Import.importAddonString(`PP:2:kara::Evil.WR.${EVIL}.T:Evil2.HU.BM.${EVIL}:`);
  assert.equal(res.success, false);
  assert(!allPlayers().some(p => p.name.startsWith('Evil')));
});
check('v2 preview counts only valid players', () => {
  const res = Import.previewShareString(`PP:2:kara:::Evil.WR.${EVIL}.T,${goodPlayer}:`);
  assert(res.success);
  assert.equal(res.playerCount, 1);
});
check('live-link payload (base64url code) with a crafted spec renders nothing hostile', () => {
  resetState();
  const code = Import.encodeSharePayload(`PP:2:kara::Evil.WR.${EVIL}.T,${goodPlayer}:Bench.PR.${EVIL}.H:`);
  const str = Import.decodeSharePayload(code);
  assert(Import.previewShareString(str).success);
  assert(Import.importAddonString(str).success);
  deq(allPlayers().map(p => p.name), ['Good']);
  for (const p of allPlayers()) {
    const html = getSpecIcon(p);
    assert(!html.includes('<svg'), html);
  }
});
check('v2 tail JSON: crafted unplaced entries lose their class/spec/role', () => {
  resetState();
  const tail = encodeURIComponent(JSON.stringify({ unplaced: [
    { name: 'U1', class: 'WARRIOR', spec: EVIL, role: 'tank', signupStatus: 'absent' },
    { name: 'U2', class: EVIL, spec: 'Arms', role: 'tank', signupStatus: 'absent' },
    { name: 'U3', class: 'MAGE', spec: 'Frost', role: EVIL, signupStatus: 'absent' },
    { name: 'U4', class: 'constructor', spec: 'Arms', role: 'tank', signupStatus: 'absent' },
    { name: 'U5', class: 'MAGE', spec: 'Frost', role: 'caster_dps', signupStatus: 'absent' },
  ] }));
  const res = Import.importAddonString(linkWithTail(goodPlayer, tail));
  assert(res.success, res.error);
  const byName = Object.fromEntries(State.unplaced.map(p => [p.name, p]));
  assert.equal(byName.U1.class, 'WARRIOR'); assert.equal(byName.U1.spec, null); assert.equal(byName.U1.role, 'tank');
  assert.equal(byName.U2.class, null); assert.equal(byName.U2.spec, null); assert.equal(byName.U2.role, null);
  assert.equal(byName.U3.spec, 'Frost'); assert.equal(byName.U3.role, null);
  assert.equal(byName.U4.class, null);
  deq([byName.U5.class, byName.U5.spec, byName.U5.role], ['MAGE', 'Frost', 'caster_dps']);
  assert(!State.unplaced.some(hasInjection));
});
check('v1 addon string: crafted values are dropped', () => {
  resetState();
  const res = Import.importAddonString(`PP:1:kara:Evil.WR.${EVIL}.T,${goodPlayer}:Bad.WR.Arms.${EVIL}`);
  assert(res.success, res.error);
  deq(allPlayers().map(p => p.name), ['Good']);
  assert.equal(res.playerCount, 1);
});
check('loadRoster (JSON import, saved roster, history): players, bench and unplaced are validated', () => {
  resetState();
  const ok = Import.loadRoster({
    name: 'R', raid: 'kara', gameVersion: 'tbc',
    players: [
      { name: 'P1', class: 'WARRIOR', spec: EVIL, role: 'tank', groupNumber: 1 },
      { name: 'P2', class: 'MAGE', spec: 'Frost', role: 'caster_dps', groupNumber: 1 },
      { name: 'P3', class: 'MAGE', spec: 'Frost', role: EVIL, groupNumber: 2 },
    ],
    bench: [{ name: 'B1', class: EVIL, spec: 'Frost', role: 'caster_dps' }, { name: 'B2', class: 'PRIEST', spec: 'Holy', role: 'healer' }],
    unplaced: [{ name: 'U1', class: 'MAGE', spec: EVIL, role: 'caster_dps', signupStatus: 'absent' }],
  });
  assert(ok);
  deq(State.roster.map(p => p.name), ['P2']);
  deq(State.groups.flat().map(p => p.name), ['P2']);
  deq(State.bench.map(p => p.name), ['B2']);
  assert.equal(State.unplaced[0].spec, null);
  assert(!allPlayers().some(hasInjection));
});
check('SignupStatus.cleanUnplaced validates spec against its class and role against the role list', () => {
  const [p] = SignupStatus.cleanUnplaced([{ name: 'U', class: 'MAGE', spec: 'Arms', role: 'healer', signupStatus: 'absent' }]);
  deq([p.class, p.spec, p.role], ['MAGE', null, 'healer']);
});
check('PlanStore.restore (saved working plan) drops invalid players from groups and bench', () => {
  resetState();
  State.planId = 'plan:sec1';
  seat(0, [mk('Keep', 'MAGE', 'Frost', 'caster_dps'), mk('Drop', 'MAGE', EVIL, 'caster_dps')]);
  State.bench = [mk('BenchDrop', 'PRIEST', 'Holy', EVIL), mk('BenchKeep', 'PRIEST', 'Holy', 'healer')];
  const snap = PlanStore.capture();
  resetState();
  assert(PlanStore.restore(snap));
  deq(State.groups.flat().map(p => p.name), ['Keep']);
  deq(State.roster.map(p => p.name), ['Keep']);
  deq(State.bench.map(p => p.name), ['BenchKeep']);
});

// ── 3. Render helpers escape on their own ────────────────────────
check('getSpecIcon never lets a tampered spec/class/role break out of an attribute', () => {
  const well = /^<span class="role-icon spec-icon role-(?:tank|healer|dps)"><img src="[^"<>]*" alt="[^"<>]*" loading="lazy"><\/span>$/;
  for (const p of [
    { class: 'WARRIOR', spec: EVIL, role: 'tank' },
    { class: EVIL, spec: 'Arms', role: EVIL },
    { class: 'MAGE', spec: 'Frost"onerror="alert(1)', role: 'healer' },
  ]) {
    const html = getSpecIcon(p);
    assert(!html.includes('<svg'), html);
    assert(well.test(html), html);
  }
});
check('getRoleIcon ignores unknown and inherited role keys', () => {
  for (const role of [EVIL, 'constructor', '__proto__', undefined]) {
    const html = getRoleIcon(role);
    assert(html.includes('role-dps') && !html.includes('undefined') && !html.includes('<svg'), html);
  }
  assert(getRoleIcon('tank').includes('role-tank'));
});

// ── 4. Share-string name codec ───────────────────────────────────
function roundTrip(names) {
  resetState();
  State.rosterName = 'Codec Test';
  const players = names.map((n, i) => mk(n, 'MAGE', 'Frost', 'caster_dps'));
  seat(0, players.slice(0, 5));
  State.bench = players.slice(5);
  State.unplaced = [];
  const link = Import.exportShareString();
  const fresh = Import.decodeSharePayload(Import.encodeSharePayload(link));
  resetState();
  const res = Import.importAddonString(fresh);
  assert(res.success, res.error);
  return { link, grouped: State.groups.flat().map(p => p.name), benched: State.bench.map(p => p.name) };
}
check('names with delimiters, accents, CJK, percent and quotes round-trip', () => {
  const names = ['Mr.T', 'A,B', 'C:D', 'Thràll', 'Jaïna-Silvermoon', '日本語', 'Per%cent', "O'Brien", 'a.b.c,d:e', '100%25', '..', '%'];
  const { grouped, benched } = roundTrip(names);
  deq([...grouped, ...benched], names);
});
check('a delimiter name does not mis-parse into name/class (the Mr.T bug)', () => {
  const { grouped } = roundTrip(['Mr.T']);
  deq(grouped, ['Mr.T']);
  assert.equal(State.groups.flat()[0].class, 'MAGE');
});
check('names without delimiters keep the old raw, unflagged link format', () => {
  const { link } = roundTrip(['Thràll', 'Jaina', 'Per%cent']);
  assert(link.includes('Thràll.MA.Fro.C'), link);
  assert(link.includes('Per%cent.MA.Fro.C'), 'percent alone does not need the codec: ' + link);
  assert.equal(link.split(':').length, 5 + Config.Raids.kara.groups, 'no tail appended');
});
check('a delimiter name appends the tail flag and escapes every name', () => {
  const { link } = roundTrip(['Mr.T', 'Plain']);
  assert(link.includes('Mr%2ET.MA.Fro.C'), link);
  assert(link.includes('Plain.MA.Fro.C'), link);
  const tail = JSON.parse(decodeURIComponent(link.split(':').pop()));
  assert.equal(tail.encodedNames, true);
});
check('delimiter names also survive sign-up statuses and the preview count', () => {
  resetState();
  seat(0, [mk('Mr.T', 'WARRIOR', 'Protection', 'tank')]);
  State.bench = [mk('Lt,Dan', 'PRIEST', 'Holy', 'healer')];
  State.bench[0].signupStatus = 'tentative';
  const link = Import.exportShareString();
  assert.equal(Import.previewShareString(link).playerCount, 1);
  resetState();
  assert(Import.importAddonString(link).success);
  assert.equal(State.bench[0].name, 'Lt,Dan');
  assert.equal(State.bench[0].signupStatus, 'tentative');
});
check('a damaged escape in a flagged link is refused, not half-loaded', () => {
  resetState();
  const tail = encodeURIComponent(JSON.stringify({ encodedNames: true }));
  const res = Import.importAddonString(linkWithTail('Bad%E0%A4%A.MA.Fro.C', tail));
  assert.equal(res.success, false);
  assert(!allPlayers().length);
});
// Fixtures produced by the pre-fix exporter (see git history): they must keep decoding identically.
const OLD_PLAIN = 'PP:2:kara:Fixture%20Raid:Ülf.HU.BM.R:Thràll.SH.Rest.H,Jaina.MA.Fro.C:Bob%41.WR.Prot.T';
const OLD_TAIL = 'PP:2:kara:Fixture%20Raid:Ülf.HU.BM.R:Thràll.SH.Rest.H,Jaina.MA.Fro.C:Bob%41.WR.Prot.T:%7B%22gameVersion%22%3A%22tbc%22%2C%22campfires%22%3A%7B%22professions%22%3A%5B%5D%2C%22fires%22%3A%5B%5D%7D%2C%22preferredSlots%22%3A%5B%5D%2C%22preserveGroupOrder%22%3Afalse%2C%22notes%22%3A%22Pull%20at%208pm%22%2C%22signupStatuses%22%3A%7B%22%C3%9Clf%22%3A%22tentative%22%7D%7D';
check('pre-fix links (with a literal % in a name, with and without a tail) decode identically', () => {
  resetState();
  assert(Import.importAddonString(OLD_PLAIN).success);
  deq(State.groups.flat().map(p => p.name), ['Thràll', 'Jaina', 'Bob%41']);
  deq(State.bench.map(p => p.name), ['Ülf']);
  assert.equal(State.rosterName, 'Fixture Raid');
  resetState();
  assert(Import.importAddonString(OLD_TAIL).success);
  deq(State.groups.flat().map(p => p.name), ['Thràll', 'Jaina', 'Bob%41']);
  assert.equal(State.bench[0].signupStatus, 'tentative');
  assert.equal(State.notes, 'Pull at 8pm');
});
check('the exporter still emits those fixtures byte-for-byte', () => {
  resetState();
  seat(0, [mk('Thràll', 'SHAMAN', 'Restoration', 'healer'), mk('Jaina', 'MAGE', 'Frost', 'caster_dps')]);
  seat(1, [mk('Bob%41', 'WARRIOR', 'Protection', 'tank')]);
  State.bench = [mk('Ülf', 'HUNTER', 'Beast Mastery', 'ranged_dps')];
  State.rosterName = 'Fixture Raid';
  assert.equal(Import.exportShareString(), OLD_PLAIN);
  State.notes = 'Pull at 8pm';
  State.bench[0].signupStatus = 'tentative';
  assert.equal(Import.exportShareString(), OLD_TAIL);
});

console.log(`\n${passed} security checks passed`);
