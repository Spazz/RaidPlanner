/**
 * PartyPlanner Web - readiness line, Coverage rail and phone toast tests (4.3.0, package L1-4)
 * Run: node readiness-tests.js
 *
 * The readiness line and the rail summary count party buffs and raid debuffs through ONE helper,
 * the rail names the gold corner, rail text carries a title for when it is cut off, the reference
 * comp shows no live-plan fixes, and phones put the toast at the top.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const NAMES = ['State', 'Config', 'Import', 'liveCoverageGaps', 'coverageGapCounts', 'renderReadiness', 'renderBuffCatalog',
  'getRaidBuffCoverage', 'getRaidDebuffCoverage', 'factionRelevantBuffs', 'ResultLine', 'renderSidebarSummary'];

// Fake DOM: every element remembers what the code wrote to it. With fixedGaps the live gap
// counts come from setGaps() instead of the roster, so each wording state can be driven directly.
function makeSandbox({ fixedGaps = false } = {}) {
  const els = {};
  const document = { getElementById: id => els[id] || (els[id] = { id, innerHTML: '', textContent: '', hidden: false }) };
  const extraSource = `
var lastReadiness = null;
function renderPhoneMissing() {}
function hasLoadedWork() { return true; }
${fixedGaps ? 'var __gaps = null; function liveCoverageGaps() { return __gaps; }' : ''}
${app.slice('function isKnownClass(', 'function preferredColorClass(')}
${app.slice('function renderReadiness', '// ── RAID NOTES')}
${app.slice('function renderBuffCatalog(', '// One line under a missing utility row')}
${app.slice('const ResultLine = {', 'function persistWorkingPlan')}
`;
  const ctx = app.sandbox(NAMES, { globals: { document }, extraSource });
  return { api: ctx.api, els, setGaps: gaps => { ctx.__gaps = gaps; } };
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

check('readiness line: both gaps, buffs only, debuffs only, none', () => {
  const { api, els, setGaps } = makeSandbox({ fixedGaps: true });
  seedRaid(api);
  const line = gaps => { setGaps(gaps); api.renderReadiness(); return plain(els['readiness-text'].innerHTML); };
  assert.match(line({ buffs: 7, debuffs: 6 }), /7 party buffs missing · 6 raid debuffs missing/);
  const buffsOnly = line({ buffs: 7, debuffs: 0 });
  assert.match(buffsOnly, /7 party buffs missing/);
  assert.doesNotMatch(buffsOnly, /debuff/);
  const debuffsOnly = line({ buffs: 0, debuffs: 6 });
  assert.match(debuffsOnly, /6 raid debuffs missing/);
  assert.doesNotMatch(debuffsOnly, /party buff/);
  assert.match(line({ buffs: 0, debuffs: 0 }), /All party buffs and raid debuffs covered/);
  assert.match(line({ buffs: 1, debuffs: 1 }), /1 party buff missing · 1 raid debuff missing/);
});

check('readiness line keeps tank, healer and preferred-slot parts, with short and missing parts in warning spans', () => {
  const { api, els, setGaps } = makeSandbox({ fixedGaps: true });
  seedRaid(api);
  setGaps({ buffs: 2, debuffs: 0 });
  api.State.preferredSlots = [{ group: 1, class: 'MAGE', spec: 'Fire' }];
  api.renderReadiness();
  const html = els['readiness-text'].innerHTML;
  assert.match(plain(html), /^\d+ tanks? short · \d+ healers? short · 2 party buffs missing · 1 preferred slot open$/);
  assert.match(html, /<span class="readiness-short">\d+ tanks? short<\/span>/);
  assert.match(html, /<span class="readiness-short"><b>2<\/b> party buffs missing<\/span>/);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ''), /[<>&"]/, 'only numbers and fixed text go into the markup');
  api.State.preferredSlots = [];
});

check('the readiness line and the rail summary come from one helper and agree', () => {
  const { api, els } = makeSandbox();
  seedRaid(api);
  const gaps = api.liveCoverageGaps();
  assert(gaps.buffs > 0 && gaps.debuffs > 0, 'a four-player raid leaves both kinds open');
  api.renderReadiness();
  const groups = api.State.groups;
  api.renderBuffCatalog(api.getRaidBuffCoverage(groups), api.getRaidDebuffCoverage(groups));
  const line = plain(els['readiness-text'].innerHTML);
  assert(line.includes(`${gaps.buffs} party buffs missing`), line);
  assert(line.includes(`${gaps.debuffs} raid debuffs missing`), line);
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
  const rows = els['buff-catalog-buffs'].innerHTML;
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
  assert.match(els['buff-catalog-buffs'].innerHTML, /buff-row-insight/, 'the live plan lists fixes');
  api.State.activeTab = 'ideal';
  cover();
  assert.doesNotMatch(els['buff-catalog-buffs'].innerHTML, /buff-row-insight|data-insight-/);
  assert.doesNotMatch(els['buff-catalog-debuffs'].innerHTML, /buff-row-insight|data-insight-/);
  api.State.activeTab = 'plan';
});

check('the Coverage rail opens with the gold-corner legend, and the corner it names is the swappable icon corner', () => {
  const aside = app.html.slice(app.html.indexOf('<aside class="buff-sidebar'), app.html.indexOf('</aside>'));
  assert(aside.includes('Icons with a gold corner can be swapped: click one to choose another buff.'));
  assert(aside.indexOf('swap-legend') < aside.indexOf('id="sidebar-summary"'), 'the legend sits at the top of the rail');
  assert(aside.indexOf('swap-legend') < aside.indexOf('id="sidebar-body"'));
  assert.match(app.css, /\.swap-legend i \{[^}]*background: var\(--accent-gold\)/);
  assert.match(app.css, /\.buff-icon\.swappable::after \{[^}]*background: var\(--accent-gold\)/);
});

check('the result line sits right after the plan feedback, hidden, with a dismiss button for phones', () => {
  const html = app.html.replace(/\r\n/g, '\n');
  const feedback = html.indexOf('id="plan-feedback"');
  const result = html.indexOf('<div class="result-line" id="result-line" hidden');
  assert(feedback > 0 && result > feedback);
  assert(!html.slice(feedback, result).includes('<div'), 'nothing but the end of the feedback div sits between them');
  assert.match(html, /id="btn-result-dismiss" aria-label="Dismiss"/);
  assert.match(app.css, /\.result-line-dismiss \{ display: none; \}/, 'the dismiss button is for phones only');
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

check('phone: the result line is a gold strip with a visible dismiss button; "N missing" has a 44px hit area at 12px text', () => {
  assert.match(phoneCss, /\.result-line \{[^}]*border-bottom: 1px solid var\(--border-accent\)/);
  assert.match(phoneCss, /\.result-line-dismiss \{[^}]*display: block/);
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
