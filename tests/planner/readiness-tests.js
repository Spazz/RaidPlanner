/**
 * Raidsmith - Raid check strip, Coverage dialog and result line tests (planner redesign, lane 2)
 * Run: node tests/planner/readiness-tests.js
 *
 * The Raid check strip (role tiles, "Fix now" / "Needs a recruit" icon groups, "N covered") and the Coverage dialog
 * count the SAME unit: missing party buffs and raid debuffs, through one model (buildCoverageModel). The reference comp
 * has no live-plan fixes, an unmodeled version says "Rules pending", and the result line / save-failed elements stay
 * alive for the notice queue.
 */
const assert = require('node:assert/strict');
const app = require('../load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const NAMES = ['State', 'Config', 'Import', 'GameVersions', 'liveCoverageGaps', 'coverageGapCounts', 'renderReadiness', 'renderBuffCatalog',
  'buildCoverageModel', 'renderRaidCheckTiles', 'getRaidBuffCoverage', 'getRaidDebuffCoverage', 'factionRelevantBuffs', 'ResultLine', 'Optimizer',
  'DataBackup', 'renderSummaryBar', 'renderManualChanges', 'setLoaded'];

// Fake DOM: every element remembers what the code wrote to it. With fixedInsights the fixes come from setInsights() instead of the roster,
// so each kind (switch, bench, shared, none) can be driven directly.
function makeSandbox({ fixedInsights = false, globals = {} } = {}) {
  const els = {};
  const element = id => ({ id, innerHTML: '', textContent: '', hidden: false, classes: new Set(), attrs: {},
    classList: { toggle(c, on) { els[id].classes[on ? 'add' : 'delete'](c); } },
    insertAdjacentHTML(pos, html) { this.innerHTML += html; },
    querySelectorAll() { return []; } });
  const document = { getElementById: id => els[id] || (els[id] = element(id)) };
  const extraSource = `
var __loaded = true; function setLoaded(v) { __loaded = v; } function hasLoadedWork() { return __loaded; }
${fixedInsights ? 'var __insights = null; function getMissingBuffInsights() { return __insights; }' : ''}
${app.slice('function isKnownClass(', 'function preferredColorClass(')}
${app.slice('function renderReadiness', '// ── RAID NOTES')}
${app.slice('// ── RAID CHECK STRIP + COVERAGE DIALOG', '// One line under a missing utility row')}
${app.slice('const ResultLine = {', 'function persistWorkingPlan')}
${app.slice('function renderManualChanges', '// ── CONFIRM DIALOG')}
var lastAnnouncement = '', lastRaidSummary = ''; function announce(m) { __announced.push(m); }
${app.slice('function describeRaidSummary', '// One polite, atomic sr-only region')}
${app.slice('function renderSummaryBar', 'function updateStatus')}
`;
  const announced = [];
  const ctx = app.sandbox(NAMES, { globals: { document, __announced: announced, commit() {}, ...globals }, extraSource });
  return { api: ctx.api, els, announced, setInsights: insights => { ctx.__insights = insights; } };
}

const plain = html => html.replace(/<[^>]+>/g, '');

function seedRaid(api) {
  const P = (name, cls, spec, role, g) => ({ name, class: cls, spec, role, groupNumber: g });
  assert(api.Import.loadRoster({ gameVersion: 'tbc', raid: 'bt', name: 'T', players: [
    P('Tanky', 'WARRIOR', 'Protection', 'tank', 1), P('Healy', 'PRIEST', 'Holy', 'healer', 1),
    P('Shammy', 'SHAMAN', 'Enhancement', 'melee_dps', 2), P('Mage1', 'MAGE', 'Fire', 'caster_dps', 2),
  ] }));
  api.State.activeTab = 'plan';
}

// [{ label, figure, floor, short }] for the tiles a render painted.
const tilesOf = html => [...html.matchAll(/<div class="gs-pb-tile"><span class="gs-fg-lbl">([^<]*)<\/span><span class="gs-pb-fig"><b>([^<]*)<\/b>(?:<span class="gs-pb-floor">([^<]*)<\/span>)?(?:<span class="sr-only">([^<]*)<\/span>)?/g)]
  .map(m => ({ label: m[1], figure: m[2], floor: m[3] || '', short: m[4] || '' }));

// The strip groups: [{ label, text, icons: [{ aria, name, source }] }] in DOM order.
const stripGroups = html => [...html.matchAll(/<div class="gs-pb-gapgroup" role="group" aria-label="([^"]*)"><span class="gs-fg-lbl">([^<]*)<\/span><div class="gs-pb-icons">(.*?)<\/div><\/div>/g)]
  .map(m => ({ label: m[1], text: m[2], icons: [...m[3].matchAll(/<button type="button" class="gs-pb-gap" aria-label="([^"]*)" data-tt-name="([^"]*)" data-tt-desc="[^"]*" data-tt-source="([^"]*)"/g)].map(i => ({ aria: i[1], name: i[2], source: i[3] })) }));

check('role tiles: Tanks and Healers show have/floor with a muted floor, Melee and Ranged just the figure', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.renderReadiness();
  const floors = api.Optimizer.floorsFor(25);
  const tiles = tilesOf(els['raid-check-tiles'].innerHTML);
  assert.deepEqual(tiles.map(t => t.label), ['Tanks', 'Healers', 'Melee', 'Ranged']);
  assert.deepEqual(tiles.map(t => t.figure), [`1/${floors.tank}`, `1/${floors.healer}`, '1', '1'], 'caster DPS counts as ranged');
  assert.deepEqual(tiles.map(t => t.floor), [`floor ${floors.tank}`, `floor ${floors.healer}`, '', '']);
  assert.equal(tiles[0].short, `, ${floors.tank - 1} short`, 'a short tile says so to screen readers');
  const P = (role, i) => ({ name: role + i, class: 'WARRIOR', spec: 'Protection', role, groupNumber: 1 });
  for (let i = 0; i < floors.tank - 1; i++) api.State.roster.push(P('tank', i));
  for (let i = 0; i < floors.healer - 1; i++) api.State.roster.push(P('healer', i));
  api.renderReadiness();
  const full = tilesOf(els['raid-check-tiles'].innerHTML);
  assert.deepEqual(full.map(t => t.figure).slice(0, 2), [`${floors.tank}/${floors.tank}`, `${floors.healer}/${floors.healer}`]);
  assert.deepEqual(full.map(t => t.short), ['', '', '', ''], 'no "short" once the floor is met');
  api.State.roster.push(P('tank', 'x'));
  api.renderReadiness();
  assert.equal(tilesOf(els['raid-check-tiles'].innerHTML)[0].figure, String(floors.tank + 1), 'above the floor the figure stands alone');
});

check('tile figures match the seated roster; the figure is 20px white tabular, the label a Forge label', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.renderReadiness();
  const counts = { tank: 0, healer: 0, melee_dps: 0, ranged: 0 };
  for (const p of api.State.roster) counts[p.role in counts ? p.role : 'ranged']++;
  assert.deepEqual(tilesOf(els['raid-check-tiles'].innerHTML).map(t => parseInt(t.figure, 10)), [counts.tank, counts.healer, counts.melee_dps, counts.ranged]);
  assert.match(app.css, /\.gs-pb-fig b \{[^}]*font-size: 20px;[^}]*var\(--hd-white\);[^}]*tabular-nums/);
  assert.match(app.css, /\.gs-pb-floor \{[^}]*font-size: 12px;[^}]*var\(--text-muted\)/);
});

check('the strip is hidden until the plan has something in it; an unmodeled version says "Rules pending" and shows no tiles or count', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.setLoaded(false);
  api.renderReadiness();
  assert.equal(els['raid-check'].hidden, true);
  api.setLoaded(true);
  api.renderReadiness();
  assert.equal(els['raid-check'].hidden, false);
  const groups = api.State.groups;
  api.GameVersions.pending = { name: 'Pending', modeled: false }; // no registered version is unmodeled today: register a stand-in
  api.State.gameVersion = 'pending';
  try {
    api.renderReadiness();
    assert.equal(els['raid-check-tiles'].innerHTML, '');
    api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
    assert.match(els['raid-check-gaps'].innerHTML, /Rules pending/);
  } finally { delete api.GameVersions.pending; }
  assert.equal(els['btn-coverage'].hidden, true);
  assert.match(els['buff-catalog-gaps'].innerHTML, /not configured for this version yet/);
  assert.equal(els['coverage-summary'].textContent, '');
});

check('mixed factions: one chip in the strip, only for a mixed Classic roster', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.renderReadiness();
  assert.doesNotMatch(els['raid-check-tiles'].innerHTML, /Mixed factions/);
  const players = [
    { name: 'Sham', class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps', groupNumber: 1 },
    { name: 'Pal', class: 'PALADIN', spec: 'Retribution', role: 'melee_dps', groupNumber: 1 },
  ];
  api.State.gameVersion = 'classic';
  api.State.groups = [players];
  api.State.bench = [];
  api.State.roster = players;
  api.renderReadiness();
  assert.match(els['raid-check-tiles'].innerHTML, /<span class="gs-hd-chip is-short" title="Mixed Horde\/Alliance roster — impossible in Classic Era">Mixed factions<\/span>/);
});

// ── Strip icons and dialog rows come from one model ──

const person = (name, cls, spec, uid) => ({ name, class: cls, spec, uid: uid || name });
// A board whose gaps cover every kind of fix: two one-click ones (a Switch and a Swap In), a debuff Swap In, a shout with
// two warriors seated, a shout with one, and two Shadow Priest gaps nobody can fill. Everything else is covered.
function groupedBoard() {
  const { api, els, setInsights } = makeSandbox({ fixedInsights: true });
  seedRaid(api);
  const insights = {
    GRACE_OF_AIR: { kind: 'switch', player: person('Shammy', 'SHAMAN', 'Enhancement'), groupIdx: 1, currentBuffId: 'WINDFURY' },
    WINDFURY: { kind: 'bench', player: person('Benchy', 'SHAMAN', 'Enhancement') },
    SUNDER_ARMOR: { kind: 'bench', player: person('Warry', 'WARRIOR', 'Arms') },
    BATTLE_SHOUT: { kind: 'shared', player: person('Tanky', 'WARRIOR', 'Protection'), casters: 2 },
    COMMANDING_SHOUT: { kind: 'shared', player: person('Tanky', 'WARRIOR', 'Protection'), casters: 1 },
    VAMPIRIC_TOUCH: { kind: 'none' },
    MISERY: { kind: 'none' },
  };
  setInsights(insights);
  const buffs = api.factionRelevantBuffs();
  const coveredBuffs = new Set(Object.keys(buffs).filter(id => !insights[id]));
  const coveredDebuffs = new Set(Object.keys(api.Config.Debuffs).filter(id => !insights[id]));
  api.renderBuffCatalog(coveredBuffs, coveredDebuffs);
  return { api, els, coveredBuffs, coveredDebuffs, insights, render: () => api.renderBuffCatalog(coveredBuffs, coveredDebuffs) };
}
const sectionOf = (html, title) => {
  const m = html.match(new RegExp(`<h3 class="gs-fg-gh"><span class="gs-fg-ght">${title}</span><span class="gs-fg-ghn">(\\d+)</span></h3>([\\s\\S]*?)(?=<h3 class="gs-fg-gh">|$)`));
  return m && { count: +m[1], body: m[2] };
};
const rowNames = html => [...html.matchAll(/<span class="buff-row-name" title="[^"]*">([^<]*)</g)].map(m => m[1]);

check('the strip has a Fix now and a Needs a recruit group of icon buttons, each named with what fixes it', () => {
  const { els } = groupedBoard();
  const groups = stripGroups(els['raid-check-gaps'].innerHTML);
  assert.deepEqual(groups.map(g => g.text), ['Fix now 4', 'Needs a recruit 3']);
  assert.deepEqual(groups.map(g => g.label), ['Fix now 4', 'Needs a recruit 3'], 'each group is named for screen readers with its count');
  assert.deepEqual(groups[0].icons.map(i => i.aria), [
    'Windfury Totem. Fix now: swap in Benchy',
    'Grace of Air Totem. Fix now: switch Shammy to it',
    'Battle Shout. Fix now: group two warriors together',
    'Sunder Armor. Fix now: swap in Warry',
  ], 'dataset order, the debuff last');
  assert.deepEqual(groups[1].icons.map(i => i.aria), [
    'Commanding Shout. Needs a recruit: a second Warrior',
    'Vampiric Touch. Needs a recruit: Shadow Priest',
    'Misery. Needs a recruit: Shadow Priest',
  ]);
  for (const g of groups) for (const i of g.icons) {
    assert.equal(i.aria.split('. ')[0], i.name, 'the aria-label starts with the name the tooltip shows');
    assert(i.aria.endsWith(i.source), 'the tooltip source line is the status the aria-label ends with');
  }
  assert.doesNotMatch(els['raid-check-gaps'].innerHTML, /gs-hd-chip|style=/, 'a label splits the groups, never a colour');
});

check('every icon in the strip is a real button with a tooltip hook and no text of its own', () => {
  const { els } = groupedBoard();
  const html = els['raid-check-gaps'].innerHTML;
  const tags = [...html.matchAll(/<(\w+)[^>]*class="gs-pb-gap"[^>]*>/g)];
  assert(tags.length === 7 && tags.every(t => t[1] === 'button' && /type="button"/.test(t[0]) && /data-tt-name="[^"]+"/.test(t[0])), html);
  assert.match(html, /<button[^>]*class="gs-pb-gap"[^>]*>(<img src="[^"]*" alt="" loading="lazy" class="buff-img">|[A-Za-z]+)<\/button>/, 'buff art with empty alt, or the abbreviation when there is none');
  assert.equal([...html.matchAll(/ alt="[^"]+"/g)].length, 0, 'the image is decorative: the button carries the name');
});

check('strip and dialog count the same unit: icons per group = rows or entries per section, covered count = Covered section', () => {
  const { els, coveredBuffs, coveredDebuffs } = groupedBoard();
  const groups = stripGroups(els['raid-check-gaps'].innerHTML);
  const dialog = els['buff-catalog-gaps'].innerHTML;
  assert.equal(sectionOf(dialog, 'Fix now').count, groups[0].icons.length);
  assert.equal(rowNames(sectionOf(dialog, 'Fix now').body).length, groups[0].icons.length);
  const need = sectionOf(dialog, 'Needs a recruit');
  assert.equal(need.count, groups[1].icons.length, 'N counts entries (icons), not source-spec lines');
  const covered = coveredBuffs.size + coveredDebuffs.size;
  assert.equal(els['btn-coverage'].textContent, `${covered} covered`);
  assert.equal(sectionOf(els['buff-catalog-covered'].innerHTML, 'Covered').count, covered);
  assert.equal(els['coverage-summary'].textContent, `${covered} of ${covered + groups[0].icons.length + groups[1].icons.length} covered`);
  assert.equal(els['btn-coverage'].hidden, false);
});

check('the strip counts and the live gap helper agree on a real four-player raid', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  const gaps = api.liveCoverageGaps();
  assert(gaps.buffs > 0 && gaps.debuffs > 0, 'a four-player raid leaves both kinds open');
  const groups = api.State.groups;
  api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  const strip = stripGroups(els['raid-check-gaps'].innerHTML);
  assert.equal(strip.reduce((n, g) => n + g.icons.length, 0), gaps.buffs + gaps.debuffs);
  const none = new Set();
  assert.equal(api.coverageGapCounts(none, none).buffs, Object.keys(api.factionRelevantBuffs()).length);
  assert.equal(api.coverageGapCounts(none, none).debuffs, Object.keys(api.Config.Debuffs).length);
});

check('nothing missing: the strip says "No gaps" and the dialog has no gap sections', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.renderBuffCatalog(new Set(Object.keys(api.factionRelevantBuffs())), new Set(Object.keys(api.Config.Debuffs)));
  assert.equal(els['raid-check-gaps'].innerHTML, '<span class="gs-pb-quiet">No gaps</span>');
  assert.equal(els['buff-catalog-gaps'].innerHTML, '');
  assert.match(els['buff-catalog-covered'].innerHTML, /Covered<\/span><span class="gs-fg-ghn">\d+</);
  assert.match(els['coverage-summary'].textContent, /^(\d+) of \1 covered$/);
});

check('Fix now lists the one-click gaps in the dialog, buffs before debuffs, with their fix buttons; Needs a recruit lists the rest', () => {
  const { els } = groupedBoard();
  const html = els['buff-catalog-gaps'].innerHTML;
  const fix = sectionOf(html, 'Fix now');
  assert.deepEqual(rowNames(fix.body), ['Windfury Totem', 'Grace of Air Totem', 'Battle Shout', 'Sunder Armor'],
    'switch, bench and shared >= 2, dataset order, the debuff last');
  assert.equal(fix.count, 4);
  assert.match(fix.body, /<button type="button" class="insight-btn gs-btn" data-insight-switch="GRACE_OF_AIR"/);
  assert.match(fix.body, /<button type="button" class="insight-btn gs-btn" data-insight-swap="Benchy"/);
  assert.match(fix.body, /Group two warriors together/);
  assert.doesNotMatch(sectionOf(html, 'Needs a recruit').body, /<button|data-insight-|buff-row-icon/, 'recruit lines are text only');
});

check('Needs a recruit: one line per source spec, the debuff carries a Debuff label, the one-warrior shout keeps its note', () => {
  const { els } = groupedBoard();
  const need = sectionOf(els['buff-catalog-gaps'].innerHTML, 'Needs a recruit');
  const lines = [...need.body.matchAll(/<div class="rec-line">(.*?)<\/div>/g)].map(m => plain(m[1]));
  assert.deepEqual(lines, ['Warrior: Commanding Shout', 'Shadow Priest: Vampiric Touch, Misery Debuff'], 'buffs before debuffs inside a line');
  assert.match(need.body, /<span class="rec-spec">Shadow Priest<\/span>: <span class="rec-name">Vampiric Touch<\/span>, <span class="rec-name">Misery <span class="tag-deb">Debuff<\/span><\/span>/);
  assert.match(need.body, /rec-line">.*Commanding Shout<\/span><\/div><div class="buff-row-insight none"><span class="insight-text"[^>]*>Needs a 2nd warrior: <span class="insight-who [^"]*">Tanky<\/span> casts the other shout/);
  const fix = sectionOf(els['buff-catalog-gaps'].innerHTML, 'Fix now');
  assert.match(fix.body, /Sunder Armor<\/span><span class="tag-deb">Debuff<\/span>/, 'a debuff row labels itself too');
  assert.doesNotMatch(fix.body.replace(/Sunder Armor<\/span><span class="tag-deb">Debuff<\/span>/, ''), /tag-deb/, 'buff rows carry no label');
});

check('Covered lists every covered row, buffs then debuffs, with the Debuff label on debuffs', () => {
  const { els, coveredBuffs, coveredDebuffs } = groupedBoard();
  const covered = sectionOf(els['buff-catalog-covered'].innerHTML, 'Covered');
  assert.equal(rowNames(covered.body).length, coveredBuffs.size + coveredDebuffs.size);
  assert(!rowNames(covered.body).includes('Windfury Totem') && rowNames(covered.body).includes('Mana Spring Totem'));
  assert.equal([...covered.body.matchAll(/tag-deb/g)].length, coveredDebuffs.size);
});

check('dialog rows keep a title with the full text; the source word carries no class colour, player names keep theirs', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  const groups = api.State.groups;
  api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  const rows = els['buff-catalog-gaps'].innerHTML;
  assert.match(rows, /<span class="buff-row-name" title="[^"]+">/);
  assert.match(rows, /<span class="buff-row-source" title="[^"]+">/);
  assert.match(rows, /<span class="insight-text" title="[^"]+">/);
  assert.doesNotMatch(rows, /buff-row-source cc-|rec-spec cc-/, 'a class word is not a character name');
  const names = [...rows.matchAll(/<span class="buff-row-name" title="([^"]+)">([^<]+)</g)];
  assert(names.length > 0 && names.every(m => m[1] === m[2]), 'the title repeats the row name');
});

check('the reference comp shows no Switch or Swap In rows, and its strip has one Missing group', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  const groups = api.State.groups;
  const cover = () => api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  cover();
  assert.match(els['buff-catalog-gaps'].innerHTML, /buff-row-insight/, 'the live plan lists fixes');
  api.State.activeTab = 'ideal';
  cover();
  const html = els['buff-catalog-gaps'].innerHTML;
  assert.match(html, /<span class="gs-fg-ght">Missing<\/span><span class="gs-fg-ghn">\d+<\/span>/);
  assert.doesNotMatch(html, /Fix now|Needs a recruit|rec-line|buff-row-insight|data-insight-|<button/);
  const strip = stripGroups(els['raid-check-gaps'].innerHTML);
  assert.equal(strip.length, 1);
  assert.match(strip[0].text, /^Missing \d+$/);
  assert(strip[0].icons.every(i => i.aria.endsWith('. Missing') && i.source === 'Missing'));
  api.State.activeTab = 'plan';
});

check('reference comp tiles count its own players and carry no floor', () => {
  const { api, els } = makeSandbox();
  api.renderRaidCheckTiles([{ role: 'tank' }, { role: 'healer' }, { role: 'healer' }, { role: 'melee_dps' }, { role: 'caster_dps' }, { role: 'ranged_dps' }], null);
  const tiles = tilesOf(els['raid-check-tiles'].innerHTML);
  assert.deepEqual(tiles.map(t => t.figure), ['1', '2', '1', '2']);
  assert.deepEqual(tiles.map(t => t.floor), ['', '', '', '']);
});

// ── Markup ──

const htmlText = app.html.replace(/\r\n/g, '\n');
const dialogHtml = () => { const a = htmlText.indexOf('<dialog id="coverage-dialog"'); assert(a > 0, 'the page has the Coverage dialog'); return htmlText.slice(a, htmlText.indexOf('</dialog>', a)); };

check('index.html: the Raid check strip sits above the Groups line and the board; the right rail, summary bar, banner chips and phone sheet are gone', () => {
  assert.match(htmlText, /<section class="gs-hd-panel gs-pb-check" id="raid-check" aria-label="Raid check" hidden>/);
  const order = ['id="changes-log-panel"', 'id="raid-check"', 'id="manual-changes"', 'id="campfire-panel"', 'id="groups-line"', 'id="groups-container"'];
  let at = -1;
  for (const part of order) { const i = htmlText.indexOf(part); assert(i > at, part + ' comes in order'); at = i; }
  assert.match(htmlText, /<section class="gs-hd-panel gs-pb-manual" id="manual-changes" aria-label="Manual changes" hidden>/);
  assert.doesNotMatch(htmlText, /<aside|buff-sidebar|id="sidebar-|id="summary-bar"|id="coverage-sheet"|id="readiness-banner"|id="readiness-text"|btn-readiness-|class="readiness-banner"/);
  assert.match(htmlText, /<h2 class="gs-hd-sl"><span>Groups<\/span><span class="gs-pb-seated" id="seated-count"><\/span><\/h2>/);
  const strip = htmlText.slice(htmlText.indexOf('id="raid-check"'), htmlText.indexOf('</section>', htmlText.indexOf('id="raid-check"')));
  assert.match(strip, /id="raid-check-tiles"[\s\S]*id="raid-check-gaps"[\s\S]*<button type="button" class="gs-btn gs-pb-covered" id="btn-coverage" aria-haspopup="dialog" hidden><\/button>/);
});

check('index.html: the Coverage dialog holds Fix now / Needs a recruit, Covered, Utility, balance warnings, Manual changes and the swap legend, with one Close', () => {
  const d = dialogHtml();
  assert.match(d, /^<dialog id="coverage-dialog" class="gs-forge gs-pb-cov" aria-labelledby="coverage-heading">/);
  assert.match(d, /<h2 class="gs-pb-cov-title" id="coverage-heading" tabindex="-1">Coverage<\/h2>/);
  let at = -1;
  for (const id of ['buff-catalog-gaps', 'buff-catalog-covered', 'buff-catalog-utility', 'balance-warnings', 'coverage-manual', 'swap-legend']) {
    const i = d.indexOf(`id="${id}"`); assert(i > at, id + ' comes in order'); at = i;
  }
  assert.equal((d.match(/<button/g) || []).length, 1, 'one Close and nothing else');
  assert.match(d, /<button type="button" class="gs-btn" id="btn-close-coverage">Close<\/button>/);
  assert.match(d, /Icons with a small arrow can be swapped: click one to choose another buff\./);
  assert.doesNotMatch(d, /Request/i);
  assert.match(app.css, /\.swap-legend i \{[^}]*border-radius: 7px/);
  assert.match(app.css, /\.gs-pb-chev \{ position: absolute; right: -4px; bottom: -4px;/);
  assert(!/\.buff-icon\.swappable::after/.test(app.css), 'the gold corner is gone');
});

check('the tooltip portal stays a body-level element, and #autosave-status stays a visually hidden status region', () => {
  assert.match(htmlText, /<div id="buff-tooltip-portal"><\/div>\s*<\/body>/);
  const tag = app.html.match(/<span[^>]*id="autosave-status"[^>]*>/)[0];
  assert.match(tag, /role="status"/);
  assert.match(tag, /class="sr-only"/);
  assert.doesNotMatch(app.css, /#autosave-status \{[^}]*display:\s*none/, 'display:none would stop it announcing');
});

check('the notice slot keeps the save-failed chip and the result line with their ids, for the notice queue', () => {
  const slot = htmlText.slice(htmlText.indexOf('id="notice-slot"'), htmlText.indexOf('id="autosave-status"'));
  for (const part of ['id="save-failed" hidden', 'id="save-failed-chip"', 'id="result-line" hidden', 'id="result-line-text"', 'id="btn-result-dismiss" aria-label="Dismiss"']) assert(slot.includes(part), part);
  assert.doesNotMatch(htmlText, /plan-feedback/);
  const script = app.script.replace(/\r\n/g, '\n');
  const list = script.match(/const planOnly = \[([^\]]*)\]/)[1];
  assert(list.includes("'notice-slot'") && list.includes("'manual-changes'"), list);
  assert(!list.includes('readiness-banner'), list);
});

// ── Groups line, Manual changes ──

check('the Groups line says "N of M seated" (plus the open slots), marks an over-full raid, and still feeds announce()', () => {
  const { api, els, announced } = makeSandbox();
  seedRaid(api);
  api.renderSummaryBar();
  const cap = api.Config.Raids[api.State.selectedRaid].size;
  assert.equal(els['seated-count'].textContent, `4 of ${cap} seated`);
  assert.equal(announced.at(-1), `4 of ${cap} in raid: 1 tank, 1 healer, 1 melee, 1 ranged. 0 benched.`);
  api.State.preferredSlots = [{ group: 1, class: 'MAGE', spec: 'Fire' }];
  api.renderSummaryBar();
  assert.equal(els['seated-count'].textContent, `4 of ${cap} seated · 1 open slot`);
  api.State.preferredSlots.push({ group: 2, class: 'MAGE', spec: 'Fire' });
  api.renderSummaryBar();
  assert.match(els['seated-count'].textContent, /2 open slots$/);
  api.State.preferredSlots = [];
  assert.equal(els['seated-count'].classes.has('is-over'), false);
});

check('Manual changes: a panel under the strip while there are any and the same list in the dialog; real remove buttons; both hide when empty', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.State.buffOverrides = {};
  api.renderManualChanges();
  assert.equal(els['manual-changes'].hidden, true);
  assert.equal(els['coverage-manual'].hidden, true);
  assert.equal(els['manual-changes'].innerHTML, '');
  const uid = api.State.groups[1][0].uid;
  api.State.buffOverrides = { [`1:${uid}`]: { buffId: 'GRACE_OF_AIR', originalBuffId: 'WINDFURY' } };
  api.renderManualChanges();
  for (const id of ['manual-changes', 'coverage-manual']) {
    assert.equal(els[id].hidden, false, id);
    assert.match(els[id].innerHTML, /<h3 class="gs-fg-gh"><span class="gs-fg-ght">Manual changes<\/span><span class="gs-fg-ghn">1<\/span><\/h3><ul>/);
    assert.match(els[id].innerHTML, /Use <span class="change-buff">Grace of Air Totem<\/span> instead of <span class="change-buff">Windfury Totem<\/span>/);
    assert.match(els[id].innerHTML, new RegExp(`<button type="button" class="change-remove" data-override-key="1:${uid}" aria-label="Remove override: [^"]+"`));
  }
  api.State.buffOverrides = {};
});

// ── Result line ──

check('ResultLine.show fills and reveals the line, hide hides it', () => {
  const { api, els } = makeSandbox();
  els['result-line'] = { hidden: true };
  els['result-line-text'] = { textContent: '' };
  api.ResultLine.show('Arranged 24 sign-ups into 5 groups, 1 benched');
  assert.equal(els['result-line'].hidden, false);
  assert.equal(els['result-line-text'].textContent, 'Arranged 24 sign-ups into 5 groups, 1 benched');
  api.ResultLine.hide();
  assert.equal(els['result-line'].hidden, true);
});

check('imports, Optimize and the sync set the line after their commit; persistWorkingPlan clears it on a change', () => {
  const importSrc = app.slice('async function importFromText(', "document.getElementById('btn-refresh').addEventListener").replace(/\r\n/g, '\n');
  const setAt = importSrc.indexOf('ResultLine.show(result.wasUnassigned');
  assert(setAt > importSrc.lastIndexOf('commit();', setAt), 'the sign-up import sets the line after its commit');
  assert(importSrc.slice(setAt, setAt + 400).includes('Arranged ${result.playerCount} sign-ups into ${result.groupCount} groups'));
  assert(importSrc.slice(setAt, setAt + 400).includes('Kept the ${result.groupCount} groups set in Raid-Helper. Optimize rearranges them.'));
  const script = app.script.replace(/\r\n/g, '\n');
  const plainAt = script.indexOf('ResultLine.show(`Arranged ${result.playerCount} players into ${result.groupCount} groups');
  assert(plainAt > script.lastIndexOf('commit();', plainAt), 'the plain-text import sets the line after its commit');
  const optimize = script.slice(script.indexOf("getElementById('btn-optimize').addEventListener"), script.indexOf("getElementById('btn-clear').addEventListener"));
  assert(optimize.indexOf('ResultLine.show(message)') > optimize.indexOf('commit();'), 'Optimize sets the line after its commit');
  assert(script.includes('if (entry && ChangeLog.countsText(entry)) ResultLine.show(`Sign-up sync: ${ChangeLog.countsText(entry)}`)'), 'the sync shows its Changes summary');
  const persist = app.slice('function persistWorkingPlan', 'function renderPhoneSummary').replace(/\r\n/g, '\n');
  assert.match(persist, /if \(result\.changed\) \{[^}]*ResultLine\.hide\(\);/);
});

// ── CSS ──
const cssText = app.css.replace(/\r\n/g, '\n');
const phoneCss = (() => { const c = cssText.slice(cssText.lastIndexOf('/* ── Slim phone layout')); return c.slice(c.indexOf('@media (max-width: 600px)')); })();
const laneCss = (() => { const a = cssText.indexOf('Planner board on Forge (T6), lane 2'); const b = cssText.indexOf('/* Watch list: Reviewed'); assert(a > 0 && b > a); return cssText.slice(a, b); })();

check('strip styles: tokens only, 36px icon buttons, one neutral edge between the groups, no orange or gold', () => {
  assert.doesNotMatch(laneCss, /#[0-9a-fA-F]{3,8}\b/, 'no hex colour in the lane 2 block');
  assert.doesNotMatch(laneCss, /--molten|--accent-gold/, 'orange and gold are not used by the strip or the dialog');
  assert.match(laneCss, /\.gs-pb-gap \{[^}]*width: 36px; height: 36px;/);
  assert.match(laneCss, /\.gs-pb-gapgroup \+ \.gs-pb-gapgroup \{[^}]*border-left: 1px solid var\(--hd-hair\)/);
});

check('the old board chrome rules left app.css: summary bar, banner chips, right rail, phone sheet, Manual changes box', () => {
  const appOnly = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'app.css'), 'utf8');
  assert.doesNotMatch(appOnly, /\.summary-(bar|chip|main|divider|missing)|\.readiness-banner|\.rb-(row|chips|toggle|bar|arrow|note)\b|\.buff-sidebar|\.sidebar-|\.coverage-sheet|\.manual-changes-section|\.buff-row|\.insight-btn|\.swap-legend|\.cov-toggle|\.balance-warning/);
  assert.match(appOnly, /\.result-line \{/, 'the result line keeps its base rule for the notice queue');
  assert.match(appOnly, /\.rb-failed \{/, 'so does the save-failed chip');
});

check('phone toast: top, under the 40px header and safe area, 13px, above the player editor sheet', () => {
  const rule = phoneCss.match(/\n {2}\.toast \{([^}]*)\}/);
  assert(rule, 'the slim phone block has a .toast rule');
  assert.match(rule[1], /top: calc\(env\(safe-area-inset-top, 0px\) \+ 44px\)/);
  assert.match(rule[1], /bottom: auto/);
  assert.match(rule[1], /font-size: 13px/);
  assert.match(rule[1], /left: 12px; right: 12px/);
  const z = Number(rule[1].match(/z-index: (\d+)/)[1]);
  const sheet = Number(cssText.match(/\.player-editor \{[^}]*z-index: (\d+)/)[1]);
  assert(z > sheet, `toast z-index ${z} is above the sheet ${sheet}`);
  assert.match(cssText, /\.toast \{\n {2}position: fixed; bottom: 24px; right: 24px;/, 'desktop keeps the bottom-right toast');
});

check('phone: the result row has a 44px dismiss button', () => {
  assert.match(phoneCss, /\.result-line-dismiss \{[^}]*min-height: 44px/);
  assert.doesNotMatch(phoneCss, /\.plan-feedback|feedback-open/, 'the banner is always shown on phones');
});

console.log(`\n${passed} readiness checks passed`);
