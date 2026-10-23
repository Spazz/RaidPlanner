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
  assert(!faqHtml.includes('#r='));
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

check('the status bar is gone; APP_VERSION stays a semver for the changelog', () => {
  assert(!html.includes('status-version') && !html.includes('class="status-bar"'));
  assert(!/v5\.0/.test(html));
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
  const msg = "This becomes a new plan in ${GameVersions[version].name}: your players carry over to its default raid, totem and aura picks reset, and anyone who doesn't fit moves to the bench.";
  assert(script.includes(msg));
  assert(script.includes("'Your current plan stays in Your plans.'"));
  assert(script.includes("'This leaves the raid plan; the raid keeps it.'"), 'inside a raid plan the confirm says the raid keeps it');
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

check('Pick your era is gone: the top bar switch is the only version switch, and the cut copy is not on the page', () => {
  const css = app.css;
  assert(!html.includes('Pick your era') && !html.includes('version-compare') && !html.includes('id="version-comparison"'));
  assert(!/renderVersionComparison|onVersionCardClick|version-compare/.test(script), 'its script is removed');
  assert(!/version-compare/.test(css), 'its CSS is removed');
  assert((html.match(/class="game-version-tab gs-fg-seg"/g) || []).length === 3, 'the Classic | TBC | Forever segments stay');
  // Signed out: copy cut on the Planner home boards (Notes "copy that is cut").
  for (const cut of ['Melee ride with Windfury', 'See every buff you', 'Drag anyone anywhere, then share a link', 'Your plans save automatically in this browser.', 'Accepts a Raid-Helper link',
    'Gargul exports, who won what', "Raid groups built from any raid's sign-ups", 'The planner above works without signing in.', 'Built for raid leaders who would rather pull than sort.'])
    assert(!html.includes(cut), 'cut: ' + cut);
  // Kept word for word.
  for (const kept of ['Forge optimal raid groups <em>in one click.</em>', "Raidsmith also keeps your guild's records: one place for your roster, raids, attendance and loot, with the planner built in.",
    'People, characters and alts, brought in from Raid-Helper, Warcraft Logs or Battle.net.', 'To start a guild you need to own or administer its Discord server.', 'Raidsmith &middot; forged for raid night'])
    assert(html.includes(kept), 'kept: ' + kept);
  assert(html.includes('<a href="/faq.html">FAQ</a>') && html.includes('<a href="/whats-new.html">What\'s new</a>'), 'one footer line: brand line, FAQ, What\'s new, feedback');
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
