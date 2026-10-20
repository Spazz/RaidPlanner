/**
 * PartyPlanner Web - readiness banner, Coverage rail and phone toast tests (4.3.0 package L1-4, 4.3.1 banner)
 * Run: node tests/planner/readiness-tests.js
 *
 * The readiness banner (status chips, a minimize toggle, the result row) and the rail summary count
 * party buffs and raid debuffs through ONE helper,
 * the rail names the gold corner, rail text carries a title for when it is cut off, the reference
 * comp shows no live-plan fixes, and phones put the toast at the top.
 */
const assert = require('node:assert/strict');
const app = require('../load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const NAMES = ['State', 'Config', 'Import', 'liveCoverageGaps', 'coverageGapCounts', 'renderReadiness', 'renderBuffCatalog',
  'getRaidBuffCoverage', 'getRaidDebuffCoverage', 'factionRelevantBuffs', 'ResultLine', 'renderSidebarSummary', 'Optimizer',
  'ReadinessBanner', 'DataBackup', 'setCoveredListOpen'];

// Fake DOM: every element remembers what the code wrote to it. With fixedGaps the live gap
// counts come from setGaps() instead of the roster, so each wording state can be driven directly.
function makeSandbox({ fixedGaps = false, fixedInsights = false, globals = {} } = {}) {
  const els = {};
  const document = { getElementById: id => els[id] || (els[id] = { id, innerHTML: '', textContent: '', hidden: false }) };
  const extraSource = `
var lastReadiness = null;
function renderPhoneMissing() {}
function hasLoadedWork() { return true; }
${fixedGaps ? 'var __gaps = null; function liveCoverageGaps() { return __gaps; }' : ''}
${fixedInsights ? 'var __insights = null; function getMissingBuffInsights() { return __insights; }' : ''}
${app.slice('function isKnownClass(', 'function preferredColorClass(')}
${app.slice('function renderReadiness', '// ── RAID NOTES')}
${app.slice('function renderBuffCatalog(', '// One line under a missing utility row')}
${app.slice('const ResultLine = {', 'function persistWorkingPlan')}
`;
  const ctx = app.sandbox(NAMES, { globals: { document, ...globals }, extraSource });
  return { api: ctx.api, els, setGaps: gaps => { ctx.__gaps = gaps; }, setInsights: insights => { ctx.__insights = insights; } };
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

// The chips a render painted: [{ kind, title, text }], with the entities decoded.
const decode = s => s.replace(/&#10003;/g, '(ok)').replace(/&middot;/g, '|');
const chipsOf = html => [...html.matchAll(/<span class="chip([^"]*)" title="([^"]*)">([^<]*)<\/span>/g)]
  .map(m => ({ kind: m[1].trim(), title: m[2], text: decode(m[3]) }));
const chipTexts = html => chipsOf(html).map(c => c.text);

check('coverage chip: both kinds, one kind, none, singular', () => {
  const { api, els, setGaps } = makeSandbox({ fixedGaps: true });
  seedRaid(api);
  const coverage = gaps => { setGaps(gaps); api.renderReadiness(); return chipsOf(els['readiness-text'].innerHTML).find(c => c.text.startsWith('Coverage')); };
  const both = coverage({ buffs: 7, debuffs: 4 });
  assert.equal(both.text, 'Coverage: 7 buffs | 4 debuffs missing');
  assert.equal(both.kind, 'warn');
  assert.equal(both.title, '7 party buffs missing · 4 raid debuffs missing');
  assert.equal(coverage({ buffs: 7, debuffs: 0 }).text, 'Coverage: 7 buffs missing');
  assert.equal(coverage({ buffs: 0, debuffs: 6 }).text, 'Coverage: 6 debuffs missing');
  assert.equal(coverage({ buffs: 1, debuffs: 1 }).text, 'Coverage: 1 buff | 1 debuff missing');
  const none = coverage({ buffs: 0, debuffs: 0 });
  assert.equal(none.text, 'Coverage (ok)');
  assert.equal(none.kind, 'ok');
  assert.equal(none.title, 'All party buffs and raid debuffs covered');
});

check('tank and healer chips: short in the warning colour, ok with a check mark', () => {
  const { api, els, setGaps } = makeSandbox({ fixedGaps: true });
  seedRaid(api);
  setGaps({ buffs: 0, debuffs: 0 });
  const floors = api.Optimizer.floorsFor(25);
  const chips = () => { api.renderReadiness(); return chipsOf(els['readiness-text'].innerHTML); };
  const short = chips();
  const tanksShort = floors.tank - 1, healersShort = floors.healer - 1;
  assert(tanksShort > 0 && healersShort > 0, 'the four-player raid is short on both');
  assert.deepEqual(short.slice(0, 2).map(c => [c.kind, c.text]), [
    ['warn', `Tanks ${tanksShort} short`], ['warn', `Healers ${healersShort} short`]]);
  assert(short[0].title.includes(`1 of ${floors.tank} tank slots filled`), short[0].title);
  const P = (role, i) => ({ name: role + i, class: 'WARRIOR', spec: 'Protection', role, groupNumber: 1 });
  for (let i = 0; i < tanksShort; i++) api.State.roster.push(P('tank', i));
  for (let i = 0; i < healersShort; i++) api.State.roster.push(P('healer', i));
  const ok = chips();
  assert.deepEqual(ok.slice(0, 2).map(c => [c.kind, c.text]), [['ok', 'Tanks (ok)'], ['ok', 'Healers (ok)']]);
  assert.equal(ok[0].title, `${floors.tank} tank slots filled`);
  // one tank missing reads "1 tank short", not "1 tanks short"
  api.State.roster.length = 0;
  seedRaid(api);
  for (let i = 0; i < floors.tank - 2; i++) api.State.roster.push(P('tank', 'z' + i));
  const singular = chips()[0];
  assert.equal(singular.text, 'Tanks 1 short');
  assert(singular.title.startsWith('1 tank short'), singular.title);
});

check('open slots chip only when slots are open; mixed factions chip only for a mixed Classic roster', () => {
  const { api, els, setGaps } = makeSandbox({ fixedGaps: true });
  seedRaid(api);
  setGaps({ buffs: 0, debuffs: 0 });
  api.renderReadiness();
  assert.deepEqual(chipTexts(els['readiness-text'].innerHTML).filter(x => /open slot|Mixed/.test(x)), []);
  api.State.preferredSlots = [{ group: 1, class: 'MAGE', spec: 'Fire' }];
  api.renderReadiness();
  let open = chipsOf(els['readiness-text'].innerHTML).find(c => /open slot/.test(c.text));
  assert.equal(open.text, '1 open slot');
  assert.equal(open.kind, '', 'a neutral chip');
  assert.equal(open.title, '1 preferred slot open');
  api.State.preferredSlots.push({ group: 2, class: 'MAGE', spec: 'Fire' });
  api.renderReadiness();
  open = chipsOf(els['readiness-text'].innerHTML).find(c => /open slot/.test(c.text));
  assert.equal(open.text, '2 open slots');
  api.State.preferredSlots = [];

  // A Classic Era roster with both a Shaman and a Paladin.
  const players = [
    { name: 'Sham', class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps', groupNumber: 1 },
    { name: 'Pal', class: 'PALADIN', spec: 'Retribution', role: 'melee_dps', groupNumber: 1 },
  ];
  api.State.gameVersion = 'classic';
  api.State.groups = [players];
  api.State.bench = [];
  api.State.roster = players;
  api.renderReadiness();
  const mixed = chipsOf(els['readiness-text'].innerHTML).find(c => c.text === 'Mixed factions');
  assert(mixed, els['readiness-text'].innerHTML);
  assert.equal(mixed.kind, 'danger');
  assert.equal(mixed.title, 'Mixed Horde/Alliance roster — impossible in Classic Era');
});

check('every chip carries a title, and dynamic text is escaped', () => {
  const { api, els, setGaps } = makeSandbox({ fixedGaps: true });
  seedRaid(api);
  setGaps({ buffs: 2, debuffs: 3 });
  api.State.preferredSlots = [{ group: 1, class: 'MAGE', spec: 'Fire' }];
  api.renderReadiness();
  const html = els['readiness-text'].innerHTML;
  const spans = [...html.matchAll(/<span class="chip[^"]*"[^>]*>/g)];
  assert(spans.length >= 4 && spans.every(m => /title="[^"]+"/.test(m[0])), html);
  assert.equal(els['readiness-chips-min'].innerHTML, html, 'the minimized bar shows the same chips');
  assert.doesNotMatch(plain(html), /[<>"]/);
  api.State.preferredSlots = [];
});

check('the readiness chips and the rail summary come from one helper and agree', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  const gaps = api.liveCoverageGaps();
  assert(gaps.buffs > 0 && gaps.debuffs > 0, 'a four-player raid leaves both kinds open');
  api.renderReadiness();
  const groups = api.State.groups;
  api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  const coverage = chipsOf(els['readiness-text'].innerHTML).find(c => c.text.startsWith('Coverage'));
  assert.equal(coverage.text, `Coverage: ${gaps.buffs} buffs | ${gaps.debuffs} debuffs missing`);
  const rail = els['sidebar-summary'].innerHTML;
  assert(rail.includes(`Party buffs missing</span><b>${gaps.buffs}</b>`), rail);
  assert(rail.includes(`Raid debuffs missing</span><b>${gaps.debuffs}</b>`), rail);
  // The helper counts the same buff list the rail lists (faction-relevant buffs, Config.Debuffs).
  const none = new Set();
  assert.equal(api.coverageGapCounts(none, none).buffs, Object.keys(api.factionRelevantBuffs()).length);
  assert.equal(api.coverageGapCounts(none, none).debuffs, Object.keys(api.Config.Debuffs).length);
});

check('rail summary: one success row when nothing is missing', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.renderBuffCatalog(new Set(Object.keys(api.factionRelevantBuffs())), new Set(Object.keys(api.Config.Debuffs)));
  assert.equal(els['sidebar-summary'].innerHTML, '<div class="sidebar-summary-row ok"><span>All party buffs and raid debuffs covered</span></div>');
  assert.match(app.css, /\.sidebar-summary-row\.ok \{[^}]*var\(--success\)/);
});

check('rail text carries a title with the full text: names, sources and insights', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  const groups = api.State.groups;
  api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  const rows = els['buff-catalog-gaps'].innerHTML;
  assert.match(rows, /<span class="buff-row-name" title="[^"]+">/);
  assert.match(rows, /<span class="buff-row-source [^"]*" title="[^"]+">/);
  assert.match(rows, /<span class="insight-text" title="[^"]+">/);
  const names = [...rows.matchAll(/<span class="buff-row-name" title="([^"]+)">([^<]+)</g)];
  assert(names.length > 0 && names.every(m => m[1] === m[2]), 'the title repeats the row name');
});

check('the reference comp shows no Switch or Swap In rows taken from the live plan', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  const groups = api.State.groups;
  const cover = () => api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  cover();
  assert.match(els['buff-catalog-gaps'].innerHTML, /buff-row-insight/, 'the live plan lists fixes');
  api.State.activeTab = 'ideal';
  cover();
  assert.doesNotMatch(els['buff-catalog-gaps'].innerHTML, /buff-row-insight|data-insight-/);
  assert.doesNotMatch(els['buff-catalog-covered'].innerHTML, /buff-row-insight|data-insight-/);
  api.State.activeTab = 'plan';
});

check('the Coverage rail opens with the gold-corner legend, and the corner it names is the swappable icon corner', () => {
  const aside = app.html.slice(app.html.indexOf('<aside class="buff-sidebar'), app.html.indexOf('</aside>'));
  assert(aside.includes('Icons with a gold corner can be swapped: click one to choose another buff.'));
  assert(aside.indexOf('id="sidebar-summary"') < aside.indexOf('swap-legend'), 'the legend sits at the bottom of the open rail');
  assert(aside.indexOf('id="buff-catalog-utility"') < aside.indexOf('swap-legend'), 'after Utility, the last thing in the rail body');
  assert(aside.indexOf('id="sidebar-body"') < aside.indexOf('swap-legend'), 'inside the body, so a collapsed rail hides it');
  assert.match(app.css, /\.swap-legend i \{[^}]*background: var\(--accent-gold\)/);
  assert.match(app.css, /\.buff-icon\.swappable::after \{[^}]*background: var\(--accent-gold\)/);
});

// ── Coverage rail groups (4.4.0) ──

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
  return { api, els, coveredBuffs, coveredDebuffs, render: () => api.renderBuffCatalog(coveredBuffs, coveredDebuffs) };
}
const sectionOf = (html, title) => {
  const m = html.match(new RegExp(`<h4 class="buff-sidebar-title">${title} <span class="buff-sidebar-count">&middot; (\\d+)</span></h4>([\\s\\S]*?)(?=<div class="buff-sidebar-section">|$)`));
  return m && { count: +m[1], body: m[2] };
};
const rowNames = html => [...html.matchAll(/<span class="buff-row-name" title="[^"]*">([^<]*)</g)].map(m => m[1]);

check('Fix now lists the one-click gaps, buffs before debuffs; Needs a recruit lists the rest', () => {
  const { els } = groupedBoard();
  const html = els['buff-catalog-gaps'].innerHTML;
  const fix = sectionOf(html, 'Fix now');
  assert.deepEqual(rowNames(fix.body), ['Windfury Totem', 'Grace of Air Totem', 'Battle Shout', 'Sunder Armor'],
    'switch, bench and shared >= 2, dataset order, the debuff last');
  assert.equal(fix.count, 4);
  assert.match(fix.body, /data-insight-switch="GRACE_OF_AIR"/);
  assert.match(fix.body, /data-insight-swap="Benchy"/);
  assert.match(fix.body, /Group two warriors together/);
  assert.doesNotMatch(sectionOf(html, 'Needs a recruit').body, /<button|data-insight-|buff-row-icon/, 'recruit lines are text only');
});

check('Needs a recruit: one line per source spec, N counts lines, the debuff carries a Debuff label', () => {
  const { els } = groupedBoard();
  const need = sectionOf(els['buff-catalog-gaps'].innerHTML, 'Needs a recruit');
  const lines = [...need.body.matchAll(/<div class="rec-line">(.*?)<\/div>/g)].map(m => plain(m[1]));
  assert.deepEqual(lines, ['Warrior: Commanding Shout', 'Shadow Priest: Vampiric Touch, Misery Debuff'], 'buffs before debuffs inside a line');
  assert.equal(need.count, 2, 'N counts lines, not entries');
  assert.match(need.body, /<span class="rec-spec [^"]*">Shadow Priest<\/span>: <span class="rec-name">Vampiric Touch<\/span>, <span class="rec-name">Misery <span class="tag-deb">Debuff<\/span><\/span>/);
  assert.match(app.css, /\.buff-row-groups \.buff-sidebar-section \{ flex: none; \}/, 'tablet: sections inside a group do not stretch');
  assert.match(app.css, /\.rec-name \{ white-space: nowrap; \}/, 'a wrapped Debuff label stays with its name');
  assert.match(need.body, /rec-line">.*Commanding Shout<\/span><\/div><div class="buff-row-insight none"><span class="insight-text"[^>]*>Needs a 2nd warrior: <span class="insight-who [^"]*">Tanky<\/span> casts the other shout/,
    'the one-warrior shout keeps its insight line under the Warrior line');
  const fix = sectionOf(els['buff-catalog-gaps'].innerHTML, 'Fix now');
  assert.match(fix.body, /Sunder Armor<\/span><span class="tag-deb">Debuff<\/span>/, 'a debuff row labels itself too');
  assert.doesNotMatch(fix.body.replace(/Sunder Armor<\/span><span class="tag-deb">Debuff<\/span>/, ''), /tag-deb/, 'buff rows carry no label');
});

check('Covered is a toggle, closed by default, with a count; it stays open across re-renders', () => {
  const { api, els, coveredBuffs, coveredDebuffs, render } = groupedBoard();
  const total = coveredBuffs.size + coveredDebuffs.size;
  let html = els['buff-catalog-covered'].innerHTML;
  assert.match(html, new RegExp(`<button type="button" class="cov-toggle" id="btn-covered-toggle" aria-expanded="false">Show ${total} covered &#9656;</button>$`));
  assert.doesNotMatch(html, /buff-row/, 'closed: no covered rows');
  api.setCoveredListOpen(true);
  html = els['buff-catalog-covered'].innerHTML;
  assert.match(html, /aria-expanded="true">Hide covered &#9662;<\/button>/);
  assert.equal(rowNames(html).length, total, 'open: every covered row, buffs then debuffs');
  assert(rowNames(html).indexOf('Windfury Totem') < 0 && rowNames(html).includes('Mana Spring Totem'));
  assert.equal([...html.matchAll(/tag-deb/g)].length, coveredDebuffs.size, 'covered debuff rows are labelled');
  render();
  assert.match(els['buff-catalog-covered'].innerHTML, /aria-expanded="true"/, 'a re-render keeps it open');
  api.setCoveredListOpen(false);
  assert.match(els['buff-catalog-covered'].innerHTML, /aria-expanded="false"/);
});

check('a board with nothing missing shows the success row and a Covered toggle, no gap groups', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.renderBuffCatalog(new Set(Object.keys(api.factionRelevantBuffs())), new Set(Object.keys(api.Config.Debuffs)));
  assert.equal(els['buff-catalog-gaps'].innerHTML, '');
  assert.match(els['buff-catalog-covered'].innerHTML, /Show \d+ covered/);
});

check('the reference comp has one Missing group: no Fix now, no Needs a recruit, no insight lines', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  api.State.activeTab = 'ideal';
  const groups = api.State.groups;
  api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  const html = els['buff-catalog-gaps'].innerHTML;
  assert.match(html, /<h4 class="buff-sidebar-title">Missing <span class="buff-sidebar-count">&middot; \d+<\/span><\/h4>/);
  assert.doesNotMatch(html, /Fix now|Needs a recruit|rec-line|buff-row-insight|data-insight-|<button/);
  assert(rowNames(html).length > 0);
  api.State.activeTab = 'plan';
});

check('no Request text or button anywhere in the rail', () => {
  const aside = app.html.slice(app.html.indexOf('<aside class="buff-sidebar'), app.html.indexOf('</aside>'));
  assert.doesNotMatch(aside, /Request/i);
  const { els } = groupedBoard();
  for (const id of ['buff-catalog-gaps', 'buff-catalog-covered']) assert.doesNotMatch(els[id].innerHTML, /Request/i);
  assert.doesNotMatch(app.html.slice(app.html.indexOf('<aside class="buff-sidebar'), app.html.indexOf('</aside>')), /buff-count-(buffs|debuffs)/, 'the old section counts are gone');
});

// The banner's markup, cut out of index.html (LF-normalized).
const bannerHtml = () => {
  const html = app.html.replace(/\r\n/g, '\n');
  const start = html.indexOf('<div class="readiness-banner" id="readiness-banner">');
  assert(start > 0, 'index.html has the readiness banner');
  return html.slice(start, html.indexOf('\n  </div>', start) + 9);
};

check('the banner is one element: chips button, minimize button, hidden result row, expand bar; no save text', () => {
  const html = app.html.replace(/\r\n/g, '\n');
  assert.doesNotMatch(html, /id="plan-feedback"|class="plan-feedback"/, 'the old strip is gone');
  const banner = bannerHtml();
  const order = ['id="readiness-text"', 'id="btn-readiness-minimize"', 'id="result-line" hidden', 'id="result-line-text"', 'id="btn-result-dismiss" aria-label="Dismiss"', 'id="btn-readiness-expand"'];
  let at = -1;
  for (const part of order) { const i = banner.indexOf(part); assert(i > at, part + ' comes in order'); at = i; }
  assert.match(banner, /id="btn-readiness-minimize" aria-label="Minimize readiness"/);
  assert.match(banner, /id="btn-readiness-expand" aria-label="Expand readiness"/);
  assert.match(banner, /<button type="button" class="rb-chips" id="readiness-text"/, 'the chips are a button (it opens the Coverage rail)');
  assert.doesNotMatch(banner, /Saved on this device|autosave-status/, 'no save text in the banner');
});

check('#autosave-status stays in the page as a visually hidden status region', () => {
  const tag = app.html.match(/<span[^>]*id="autosave-status"[^>]*>/)[0];
  assert.match(tag, /role="status"/);
  assert.match(tag, /class="sr-only"/);
  assert.doesNotMatch(app.css, /#autosave-status \{[^}]*display:\s*none/, 'display:none would stop it announcing');
});

check('minimized: the bar shows and the chips row and the result row hide', () => {
  const css = app.css.replace(/\r\n/g, '\n');
  assert.match(css, /\.readiness-banner\.min \.rb-bar \{ display: flex; \}/);
  assert.match(css, /\.readiness-banner\.min \.rb-row, \.readiness-banner\.min \.result-line \{ display: none; \}/);
  assert.match(css, /\.rb-bar \{\s*display: none;[^}]*min-height: 28px/);
  assert.match(css, /\.rb-bar \{ min-height: 36px;/, 'phones: a 36px bar');
  assert.match(css, /\.rb-toggle \{ width: 44px; height: 44px;/, 'phones: a 44px toggle');
  assert.match(css, /\.readiness-banner \{\s*background: color-mix\(in srgb, var\(--accent-gold\) 8%, transparent\); border-bottom: 1px solid var\(--border-accent\)/);
});

check('the banner is in the plan-only list (not the old strip id)', () => {
  const script = app.script.replace(/\r\n/g, '\n');
  const list = script.match(/const planOnly = \[([^\]]*)\]/)[1];
  assert(list.includes("'readiness-banner'"), list);
  assert(!list.includes('plan-feedback'), list);
});

// A fake page for the minimize toggle: elements with classList and aria attributes, and a storage.
function bannerSandbox({ phone, stored }) {
  const storage = { data: stored === undefined ? {} : { pp_readiness_minimized: stored }, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = String(v); } };
  const els = {};
  const node = id => els[id] || (els[id] = { id, attrs: {}, classes: new Set(),
    classList: { toggle: (c, on) => { if (on) els[id].classes.add(c); else els[id].classes.delete(c); } },
    setAttribute(k, v) { this.attrs[k] = v; } });
  const document = { getElementById: node };
  const { api } = makeSandbox({ globals: { document, localStorage: storage, window: { matchMedia: () => ({ matches: phone }) } } });
  return { api, els, node, storage };
}

check('minimized state: desktop starts expanded, phones start minimized, a stored choice wins', () => {
  assert.equal(bannerSandbox({ phone: false }).api.ReadinessBanner.isMinimized(), false);
  assert.equal(bannerSandbox({ phone: true }).api.ReadinessBanner.isMinimized(), true);
  assert.equal(bannerSandbox({ phone: true, stored: '0' }).api.ReadinessBanner.isMinimized(), false);
  assert.equal(bannerSandbox({ phone: false, stored: '1' }).api.ReadinessBanner.isMinimized(), true);
});

check('set() stores the choice under pp_readiness_minimized, toggles .min and the aria-expanded states', () => {
  const { api, node, storage } = bannerSandbox({ phone: false });
  node('readiness-banner');
  api.ReadinessBanner.set(true);
  assert.equal(storage.data.pp_readiness_minimized, '1');
  assert(node('readiness-banner').classes.has('min'));
  for (const id of ['btn-readiness-minimize', 'btn-readiness-expand', 'btn-summary-missing']) assert.equal(node(id).attrs['aria-expanded'], 'false', id);
  api.ReadinessBanner.set(false);
  assert.equal(storage.data.pp_readiness_minimized, '0');
  assert(!node('readiness-banner').classes.has('min'));
  assert.equal(node('btn-readiness-expand').attrs['aria-expanded'], 'true');
});

check('the minimized choice is a device preference: not part of the data backup', () => {
  const { api } = bannerSandbox({ phone: false });
  assert(![...api.DataBackup.keys].includes('pp_readiness_minimized'));
});

check('the minimize and expand buttons store the choice and move focus to the control that appears', () => {
  const modals = app.slice('(function initReadinessBanner() {', "document.getElementById('btn-result-dismiss')").replace(/\r\n/g, '\n');
  assert.match(modals, /ReadinessBanner\.apply\(ReadinessBanner\.isMinimized\(\)\)/, 'the stored state is painted at load');
  assert.match(modals, /'btn-readiness-minimize'\)\?\.addEventListener\('click', \(\) => \{\s*ReadinessBanner\.set\(true\);\s*document\.getElementById\('btn-readiness-expand'\)\?\.focus\(\);/);
  assert.match(modals, /'btn-readiness-expand'\)\?\.addEventListener\('click', \(\) => \{\s*ReadinessBanner\.set\(false\);\s*document\.getElementById\('btn-readiness-minimize'\)\?\.focus\(\);/);
});

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

check('phone: the result row has a 44px dismiss button; "N missing" has a 44px hit area at 12px text', () => {
  assert.match(phoneCss, /\.result-line-dismiss \{[^}]*min-height: 44px/);
  assert.doesNotMatch(phoneCss, /\.plan-feedback|feedback-open/, 'the banner is always shown on phones');
  const missing = phoneCss.match(/\.phone-missing-slot \.summary-missing \{([^}]*)\}/);
  assert(missing);
  assert.match(missing[1], /min-height: 44px/);
  assert.match(missing[1], /font-size: 12px/);
});

check('rail summary: a row with a count of 0 is muted (zero), the other stays red', () => {
  const { api, els } = makeSandbox();
  api.renderSidebarSummary({ buffs: 0, debuffs: 6 });
  assert(els['sidebar-summary'].innerHTML.includes('<div class="sidebar-summary-row missing zero"><span>Party buffs missing</span><b>0</b></div>'), els['sidebar-summary'].innerHTML);
  assert(els['sidebar-summary'].innerHTML.includes('<div class="sidebar-summary-row missing"><span>Raid debuffs missing</span><b>6</b></div>'));
  api.renderSidebarSummary({ buffs: 2, debuffs: 0 });
  assert(els['sidebar-summary'].innerHTML.includes('missing"><span>Party buffs missing'));
  assert(els['sidebar-summary'].innerHTML.includes('missing zero"><span>Raid debuffs missing'));
});

console.log(`\n${passed} readiness checks passed`);
