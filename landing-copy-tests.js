/**
 * PartyPlanner Web - landing, help and version-switch copy tests
 * Run: node landing-copy-tests.js
 *
 * The landing page, FAQ, status bar, version-switch copy and first-run tip say what the
 * app does: privacy lines match live links, help names the Share menu, the status bar
 * is filled from APP_VERSION, and the menu tip waits for the import feedback to clear.
 */
const assert = require('node:assert/strict');
const app = require('./tests/load-app');

const html = app.html.replace(/\r\n/g, '\n');
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
  assert(html.includes('Live links are stored on our server until 30 days after their last change.'));
  assert(!html.includes('Nothing is stored on a server'));
  assert(html.includes('anyone with the link can see and edit the plan, and it expires 30 days after its last change'));
  assert(html.includes('A long snapshot link (#r=...) carries the plan inside the link itself'));
  assert(!html.includes('Sign-ups are fetched by your browser directly from Raid-Helper and never touch our server'));
});

check('How it works explains import grouping and ends on Share', () => {
  assert(html.includes('an event whose Raid-Helper groups are already set keeps them'));
  assert(html.includes('Press Optimize after any change'));
  assert(html.includes('<h3>Share</h3>'));
  assert(!html.includes('<h3>Export</h3>'));
  assert(html.includes('Copy for MRT') && html.includes('Copy live link'));
});

check('FAQ names the real API URL and the Share menu entries', () => {
  assert(html.includes('raid-helper.dev/api/v4/events/&lt;id&gt;'));
  assert(!html.includes('api/raidplan/&lt;id&gt;'));
  assert(html.includes('use Share &gt; Download JSON'));
  assert(html.includes('Share &gt; Copy for MRT'));
  assert(!html.includes('Copy MRT String') && !html.includes('use Export to download'));
});

check('status bar is a span filled from APP_VERSION', () => {
  assert(html.includes('<span id="status-version"></span>'));
  assert(!/v5\.0/.test(html));
  assert(script.includes("document.getElementById('status-version')"));
  assert(script.includes('`Party Planner v${APP_VERSION}`'));
  assert(/^\d+\.\d+\.\d+$/.test(APP_VERSION));
});

check('TBC Anniversary naming on the kicker and the version tab', () => {
  assert(html.includes('WoW Classic &middot; TBC Anniversary &middot; WoW Forever Beta'));
  assert(/data-version="tbc"[^>]*aria-label="TBC Anniversary"/.test(html));
  assert.equal(GameVersions.tbc.name, 'WoW TBC');
});

check('every version has a short toastNote; the long note stays', () => {
  assert.equal(GameVersions.tbc.toastNote, 'TBC Anniversary party buffs and optimization rules.');
  assert.equal(GameVersions.classic.toastNote, 'WoW Classic Era rules, faction-aware: Horde shamans, Alliance paladins.');
  assert.equal(GameVersions.forever.toastNote, 'WoW Forever beta rules, data as of 2026-10-10. The landing page has the details.');
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

check('attendance copy points at saved copies', () => {
  assert(html.includes('Built from your saved copies (Plan menu &gt; Save a copy) for the current game version.'));
  assert(html.includes("Recent imports and autosaved plans don't count, so this only reflects raids you saved on purpose."));
  assert(script.includes('No saved copies yet. After a raid, use Plan menu &gt; Save a copy to start building attendance history.'));
});

console.log(`\n${passed} checks passed`);
