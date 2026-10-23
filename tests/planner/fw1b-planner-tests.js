/**
 * Raidsmith - design framework Wave 1 (item 4), the Planner side: a pasted plain-text roster is named "Pasted roster, <date>" (the topbar, the plans list and the
 * recent imports read the name), the Share dialog leads with Copy for MRT and the in-game path, the first-run tip stays under the top bar, the landing's slot
 * for the guild members' upcoming raids sits under the Planner heading, and the glossary words (Group, Line-up) replace the retired ones in the Planner copy.
 * The MRT string itself is pinned by mrt-tests.js. The guild half of the landing (the list of raids) is in guild-fw1b-ui-tests.js.
 * Run: node tests/planner/fw1b-planner-tests.js
 */
const assert = require('node:assert/strict');
const vm = require('vm');
const app = require('../load-app');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n      '));
  }
}

const html = app.html.replace(/\r\n/g, '\n');
const css = app.css.replace(/\r\n/g, '\n');
const script = app.script.replace(/\r\n/g, '\n');

(async () => {
  // ── naming ──
  await check('PlanStore.pastedName: "Pasted roster, Oct 18" - the short month and the day, in English', () => {
    const { PlanStore } = app.sandbox(['PlanStore']).api;
    assert.equal(PlanStore.pastedName(new Date(2026, 9, 18, 12).getTime()), 'Pasted roster, Oct 18');
    assert.equal(PlanStore.pastedName(new Date(2027, 0, 5, 12).getTime()), 'Pasted roster, Jan 5');
    assert(/^Pasted roster, [A-Z][a-z]{2} \d{1,2}$/.test(PlanStore.pastedName()), 'no argument: today');
  });

  await check('a confirmed plain-text paste names the plan "Pasted roster, <date>" instead of leaving "No Roster Loaded" in the topbar, the saved copy and the recent imports', () => {
    const start = script.indexOf('const PlainRosterImport = {');
    const plainSrc = script.slice(start, script.indexOf('\n};', start) + 3);
    const dialog = { closed: false, close() { this.closed = true; } };
    const imports = [];
    const globals = {
      document: { getElementById: id => (id === 'plain-import-dialog' ? dialog : null) },
      initGroups: () => 0, commit() {}, showView() {}, showToast() {}, rememberImport: label => { imports.push(label); return ''; },
      SplitFlow: { maybeOffer() {} }, ResultLine: { show() {} }, ChangeLog: { clear() {} }, importErrorMessage: x => x.raw,
    };
    const { State, PlainRosterImport, NO_ROSTER_NAME, PlanStore } = app.sandbox(['State', 'PlainRosterImport', 'NO_ROSTER_NAME', 'PlanStore'], { extraSource: plainSrc, globals }).api;
    State.gameVersion = 'tbc'; State.selectedRaid = 'gruul';
    assert.equal(State.rosterName, NO_ROSTER_NAME, 'a cleared planner');
    PlainRosterImport.pending = { entries: [{ name: 'Thrall', classId: 'SHAMAN', spec: 'Enhancement' }, { name: 'Jaina', classId: 'MAGE', spec: 'Frost' }], unparsed: [] };
    PlainRosterImport.confirm();
    assert.equal(dialog.closed, true);
    assert.equal(State.rosterName, PlanStore.pastedName(), 'the visible title is the pasted roster\'s name');
    assert.notEqual(State.rosterName, NO_ROSTER_NAME);
    assert(/^Pasted roster, /.test(State.rosterName));
    assert.deepEqual(imports, ['Pasted plain-text roster']);
    assert(script.includes("State.rosterName = PlanStore.pastedName();"), 'set before the import is remembered and saved');
  });

  // ── Share dialog ──
  await check('Share dialog: Copy for MRT first (the one primary) with the in-game path under it, then Copy MRT note, then Copy live link, then More export formats', () => {
    const dialog = html.slice(html.indexOf('<dialog id="share-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="share-dialog"')));
    const order = ['data-share-action="btn-copy-mrt"', 'In MRT: Raid Groups &gt; Import &gt; "From ExRT export string"', 'data-share-action="btn-copy-mrt-note"', 'data-share-action="btn-share"', '<details><summary>More export formats</summary>'];
    let at = -1;
    for (const part of order) { const i = dialog.indexOf(part); assert(i > at, part + ' in order'); at = i; }
    assert(dialog.includes('<button type="button" class="btn btn-primary" data-share-action="btn-copy-mrt" aria-describedby="share-mrt-path">Copy for MRT</button>'));
    assert(dialog.includes('<p class="share-caption" id="share-mrt-path">'), 'the caption is the button\'s description');
    assert.equal((dialog.match(/btn-primary/g) || []).length, 1, 'one primary');
    assert(dialog.includes('class="btn btn-secondary" data-share-action="btn-share" aria-describedby="share-live-note">Copy live link</button>') && dialog.includes('Anyone with the link sees and edits this plan.'));
    // The same actions as before: only their order and look changed.
    assert.deepEqual([...dialog.matchAll(/data-share-action="([^"]+)"/g)].map(m => m[1]).sort(),
      ['btn-copy-chat', 'btn-copy-chat-compact', 'btn-copy-json', 'btn-copy-mrt', 'btn-copy-mrt-note', 'btn-export-json', 'btn-print-sheet', 'btn-share']);
    // The toast says the same path (the string it copies is mrt-tests.js's business).
    assert(script.includes('In MRT: Raid Groups > Import > "From ExRT export string"'));
    assert(/\.share-action \{[^}]*flex-direction:column/.test(css) && /\.share-caption \{[^}]*font-size:13px/.test(css));
  });

  // ── first-run tip ──
  await check('first-run tip: the menu tips stay under the top bar, never over its controls', () => {
    const renderJs = script.slice(script.indexOf('function showSpotlightCallout'), script.indexOf('// Small, hand-curated'));
    const created = [];
    const callout = { classList: { add: c => created.push(c) }, style: {}, setAttribute() {}, querySelector: () => ({ addEventListener() {} }), remove() {}, contains: () => false };
    const ctx = vm.createContext({
      document: { querySelector: () => null, createElement: () => callout, body: { appendChild() {} }, addEventListener() {}, removeEventListener() {} },
      window: { innerWidth: 1280, innerHeight: 800 }, localStorage: {}, Spotlight: { dismiss() {} }, esc: s => s, setTimeout: () => 0,
    });
    vm.runInContext(renderJs + '\nthis.api = showSpotlightCallout;', ctx);
    const rect = (bottom) => ({ getBoundingClientRect: () => ({ left: 1200, top: bottom - 40, bottom, right: 1240, width: 40, height: 40 }) });
    assert.equal(ctx.api('menu', rect(50), 'tip'), true);
    assert.equal(callout.style.top, '60px', 'without a bar to clear it sits 10px under its anchor');
    assert.equal(ctx.api('menu', rect(50), 'tip', { belowEl: rect(120) }), true);
    assert.equal(callout.style.top, '130px', 'with the top bar given it clears the bar');
    const defs = script.slice(script.indexOf('const SPOTLIGHT_DEFS'), script.indexOf('const SPOTLIGHT_DELAY_MS'));
    assert.equal((defs.match(/below: \(\) => document\.getElementById\('shell-topbar'\)/g) || []).length, 2, 'both menu tips clear the top bar');
    assert(script.includes("showSpotlightCallout(def.id, def.anchor(), def.text, def.below ? { belowEl: def.below() } : {})"));
  });

  // ── the landing ──
  await check('landing: the no-guild banner leads the page, the slot for the guild members\' upcoming raids sits under the Planner heading, the tab is "Your plans" for everyone', () => {
    const banner = html.indexOf('<div id="planner-banner"></div>');
    const head = html.indexOf('<header class="gs-ph-head">');
    const slot = html.indexOf('<div id="planner-notice"></div>');
    assert(banner > 0 && head > banner, 'the banner sits above the head');
    assert(head > 0 && slot > head, 'the notice slot follows the heading');
    assert(slot < html.indexOf('<section class="gs-ph-hero"'), 'and leads the import card');
    assert(html.includes('>Your plans<span class="gs-ph-count"') && !html.includes('Other plans on this device') && !html.includes('lbl-guild'), 'one label for the tab');
    assert(!/\.lbl-guild|\.lbl-solo/.test(css), 'the relabel rules are gone');
    const guildApp = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'js/guild/app.js'), 'utf8');
    assert(/document\.body\.classList\.toggle\('has-planner-guild'/.test(guildApp), 'the shell sets the body class when the viewer has a guild');
  });

  // ── glossary ──
  await check('glossary: the Planner, landing and FAQ copy say Group and Line-up - no "Seat them", "Seat this sign-up", "published roster" or "remaining seats"', () => {
    const faq = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'faq.html'), 'utf8');
    const plannerJs = ['render.js', 'modals.js', 'app.js', 'import.js', 'analysis.js'].map(f => require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'js', f), 'utf8')).join(' ');
    for (const [name, text] of [['index.html', html], ['faq.html', faq], ['the planner scripts', plannerJs]]) {
      for (const re of [/Seat them/, /Seat this sign-up/, /published roster/i, /remaining seats/, /seated automatically/, /Seat \$\{/]) assert(!re.test(text), name + ' ' + re);
    }
    assert(html.includes('Add this sign-up to a group?') && html.includes('Add to a group anyway') && html.includes('a published line-up for every raid.'));
    assert(plannerJs.includes('Add them to a group anyway?') && plannerJs.includes('Add them to a group when they arrive'));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
