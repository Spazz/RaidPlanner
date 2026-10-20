/**
 * PartyPlanner Web - landing, help and version-switch copy tests
 * Run: node tests/planner/landing-copy-tests.js
 *
 * The landing page, FAQ, status bar, version-switch copy and first-run tip say what the
 * app does: privacy lines match live links, help names the Share menu, the status bar
 * is filled from APP_VERSION, and the menu tip waits for the import feedback to clear.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('../load-app');

const html = app.html.replace(/\r\n/g, '\n');
const faqHtml = fs.readFileSync(path.join(app.ROOT, 'faq.html'), 'utf8').replace(/\r\n/g, '\n');
const script = app.script.replace(/\r\n/g, '\n');
const ctx = app.sandbox(['GameVersions', 'APP_VERSION']);
const { GameVersions, APP_VERSION } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('privacy lines say what is true about imports and live links', () => {
  assert(html.includes('No spreadsheet, no login; imports stay in your browser.'));
  assert(!/nothing uploaded/i.test(html));
  assert(faqHtml.includes('A live link is stored on our server so others can open it'));  // the FAQ now holds this fact (the feature cards are gone)
  assert(!faqHtml.includes('Nothing is stored on a server'));
  assert(faqHtml.includes('anyone with the link can see and edit the plan, and it expires 30 days after its last change'));
  assert(faqHtml.includes('A long snapshot link (#r=...) carries the plan inside the link itself'));
  assert(!faqHtml.includes('Sign-ups are fetched by your browser directly from Raid-Helper and never touch our server'));
});

check('How it works explains import grouping and ends on Share', () => {
  assert(html.includes('an event whose Raid-Helper groups are already set keeps them'));
  assert(html.includes('Press Optimize after any change'));
  assert(html.includes('<h3>Share</h3>'));
  assert(!html.includes('<h3>Export</h3>'));
  assert(html.includes('Copy for MRT') && html.includes('Copy live link'));
});

check('The FAQ page names the real API URL and the Share menu entries', () => {
  assert(faqHtml.includes('raid-helper.dev/api/v4/events/&lt;id&gt;'));
  assert(!faqHtml.includes('api/raidplan/&lt;id&gt;'));
  assert(faqHtml.includes('use Share and export&hellip;, then Download JSON under More export formats'));
  assert(faqHtml.includes('Share &gt; Copy for MRT'));
  assert(!faqHtml.includes('Copy MRT String') && !faqHtml.includes('use Export to download'));
});

check('status bar is a span filled from APP_VERSION', () => {
  assert(html.includes('<span id="status-version"></span>'));
  assert(!/v5\.0/.test(html));
  assert(script.includes("document.getElementById('status-version')"));
  assert(script.includes('`Raidsmith v${APP_VERSION}`'));
  assert(/^\d+\.\d+\.\d+$/.test(APP_VERSION));
});

check('the version tab names TBC Anniversary, and the homepage has no kicker or version note line', () => {
  assert(!html.includes('hero-kicker') && !html.includes('landing-version-note'));
  assert(!html.includes('WoW Classic &middot; TBC Anniversary &middot; WoW Forever Beta'));
  assert(/data-version="tbc"[^>]*aria-label="TBC Anniversary"/.test(html));
  assert.equal(GameVersions.tbc.name, 'WoW TBC');
});

check('every version has a short toastNote; the long note stays', () => {
  assert.equal(GameVersions.tbc.toastNote, 'TBC Anniversary party buffs and optimization rules.');
  assert.equal(GameVersions.classic.toastNote, 'WoW Classic Era rules, faction-aware: Horde shamans, Alliance paladins.');
  assert.equal(GameVersions.forever.toastNote, 'WoW Forever beta rules, data as of 2026-10-16. The landing page has the details.');
  for (const v of Object.values(GameVersions)) assert(v.note && v.note !== v.toastNote);
  assert(script.includes('(GameVersions[version].toastNote || GameVersions[version].note)'));
});

check('version-switch confirm explains the new plan', () => {
  const msg = "This becomes a new plan in ${GameVersions[version].name}: your players carry over to its default raid, totem and aura picks reset, and anyone who doesn't fit moves to the bench. Your current plan stays in Your plans.";
  assert(script.includes(msg));
});

check('menu tip has the v2 id and text', () => {
  assert(script.includes("{ id: 'menu-panel-v2', text: 'Save a copy, templates, backups and shortcuts are in this menu.',"));
  assert(!script.includes("id: 'menu-panel'"));
});

check('the tip queue waits about 3 seconds and for a visible toast to hide', () => {
  const start = script.indexOf('const SPOTLIGHT_DELAY_MS');
  const end = script.indexOf('function runSpotlightQueue');
  assert(start > 0 && end > start);
  const timers = [];
  const toast = { classList: { contains: () => toast.visible }, visible: true };
  let ran = 0;
  const factory = new Function('document', 'State', 'runSpotlightQueue', 'setTimeout', 'clearTimeout',
    script.slice(start, end) + '\nreturn { scheduleSpotlightQueue, SPOTLIGHT_DELAY_MS };');
  const api = factory({ getElementById: () => toast }, { view: 'app' }, () => ran++,
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, () => {});
  assert(api.SPOTLIGHT_DELAY_MS >= 3000 && api.SPOTLIGHT_DELAY_MS <= 3500);
  api.scheduleSpotlightQueue();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, api.SPOTLIGHT_DELAY_MS);
  timers.shift().fn();
  assert.equal(ran, 0, 'toast still showing: the tip waits');
  assert.equal(timers.length, 1, 'and checks again');
  toast.visible = false;
  timers.shift().fn();
  assert.equal(ran, 1, 'toast gone: the tip queue runs');
  assert(/if \(view === 'app'\) scheduleSpotlightQueue\(\);/.test(script));
});

check('the tip queue stays off while a guild page covers the planner, and still runs with no shell code', () => {
  const start = script.indexOf('function runSpotlightQueue');
  const end = script.indexOf('function closePlayerEditor');
  assert(start > 0 && end > start);
  const run = plannerActive => {
    const shown = [];
    const factory = new Function('document', 'SPOTLIGHT_DEFS', 'Spotlight', 'localStorage', 'showSpotlightCallout', 'plannerActive',
      script.slice(start, end) + '\nreturn runSpotlightQueue;');
    factory({ querySelector: () => null }, [{ id: 'tip', anchor: () => ({}), text: 't' }], { shouldShow: () => true }, {},
      id => { shown.push(id); return true; }, plannerActive)();
    return shown;
  };
  assert.deepEqual(run(() => true), ['tip']);
  assert.deepEqual(run(() => false), [], 'inactive: no tip');
  assert.deepEqual(run(undefined), ['tip'], 'no shell code loaded: the gate is open');
});

check('attendance copy points at saved copies', () => {
  assert(html.includes('Built from your saved copies (Plan menu &gt; Save a copy) for the current game version.'));
  assert(html.includes("Recent imports and autosaved plans don't count, so this only reflects raids you saved on purpose."));
  assert(script.includes('No saved copies yet. After a raid, use Plan menu &gt; Save a copy to start building attendance history.'));
});

// ── L2-4b: era cards, footer link ───────────────
function fakeEl(extra = {}) {
  const attrs = {};
  const handlers = {};
  const classes = new Set();
  return Object.assign({
    textContent: '', innerHTML: '', hidden: false, handlers, attrs, classes,
    classList: { toggle: (c, on) => { on ? classes.add(c) : classes.delete(c); }, contains: c => classes.has(c) },
    addEventListener(type, fn) { handlers[type] = fn; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
  }, extra);
}

function makeCardEnv(current) {
  const table = fakeEl();
  const calls = [];
  const cardFor = el => ({ closest: () => el });
  const api = app.sandbox(['renderVersionComparison', 'onVersionCardClick'], {
    globals: {
      document: { getElementById: () => table, activeElement: null },
      State: { gameVersion: current },
      GameVersions: { tbc: { name: 'WoW TBC', note: 'tbc note', raids: [] }, classic: { name: 'WoW Classic', note: 'classic note', raids: [] }, forever: { name: 'WoW Forever (Beta)', note: 'f note', raids: [] } },
      Config: { Raids: {} },
      switchGameVersion: v => calls.push(v),
    },
    extraSource: app.slice('function renderVersionComparison', '// Status bar version') + '\nglobalThis.api = { renderVersionComparison, onVersionCardClick, esc };',
  }).api;
  return { table, calls, cardFor, ...api };
}

check('era cards are buttons: the current one is marked and inert, any other switches the version', () => {
  const env = makeCardEnv('tbc');
  env.renderVersionComparison();
  const cards = env.table.innerHTML.match(/<button [^>]*>[\s\S]*?<\/button>/g);
  assert.equal(cards.length, 3);
  assert(cards.every(c => c.includes('type="button"') && c.includes('class="version-compare-col')));
  const tbc = cards.find(c => c.includes('data-version="tbc"'));
  assert(tbc.includes('aria-current="true"') && tbc.includes('<span class="go">You are here</span>'));
  const classic = cards.find(c => c.includes('data-version="classic"'));
  assert(!classic.includes('aria-current') && classic.includes('<span class="go">Switch to WoW Classic</span>'));
  assert(classic.includes('WoW Classic') && classic.includes(GameVersions.classic.note), 'content kept');
  // Phrasing content only inside a button: no headings, paragraphs or divs.
  for (const c of cards) {
    const inner = c.replace(/^<button [^>]*>/, '').replace(/<\/button>$/, '');
    assert(!/<(h[1-6]|p|div)[\s>]/.test(inner), 'block element inside a button');
  }
  assert(classic.includes('aria-label="Switch to WoW Classic"'), 'aria-label starts with the visible action');
  assert(tbc.includes('aria-label="WoW TBC, current version"'), 'current card is named');
  const click = (version, current) => env.onVersionCardClick({ target: env.cardFor({ dataset: { version }, getAttribute: k => (current && k === 'aria-current' ? 'true' : null) }) });
  click('tbc', true);
  assert.deepEqual(env.calls, [], 'the current card does nothing');
  click('classic', false);
  assert.deepEqual(env.calls, ['classic']);
  assert(/getElementById\('version-compare-table'\)[\s\S]{0,80}addEventListener\('click', onVersionCardClick\)/.test(script), 'delegated on the container');
});

check('the inert You are here card gets no hover effect, and the card parts are block spans', () => {
  const css = app.css || require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'app.css'), 'utf8');
  assert(/button\.version-compare-col\.here:hover\s*\{[^}]*border-color:\s*var\(--border-accent\)/.test(css));
  for (const cls of ['version-compare-name', 'version-compare-note', 'version-compare-raids'])
    assert(new RegExp('\\.' + cls + '\\s*\\{[^}]*display:\\s*block').test(css), cls + ' is display:block');
});

check('the footer feedback link carries the version and browser, encoded', () => {
  assert(html.includes('id="feedback-link" href="https://github.com/Spazz/RaidPlanner/issues/new" target="_blank" rel="noopener">Report a problem or suggest a feature</a>'));
  const link = fakeEl({ href: '' });
  link.attrs.href = 'https://github.com/Spazz/RaidPlanner/issues/new';
  app.sandbox([], {
    globals: { doc: { getElementById: id => (id === 'feedback-link' ? link : null) }, nav: { userAgent: 'Mozilla/5.0 (Test; x&y)' }, store: {} },
    extraSource: app.slice('function initSitePage', '// Reading localStorage') + '\ninitSitePage(doc, store, nav);',
  });
  const body = `Raidsmith ${APP_VERSION}\nBrowser: Mozilla/5.0 (Test; x&y)\n\nWhat happened:\n`;
  assert.equal(link.href, 'https://github.com/Spazz/RaidPlanner/issues/new?body=' + encodeURIComponent(body));
  assert(link.href.includes(encodeURIComponent('Mozilla/5.0 (Test; x&y)')) && !link.href.includes('x&y'));
});

console.log(`\n${passed} checks passed`);
