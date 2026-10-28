/**
 * Raidsmith guild UI - the design framework, Wave 0: tokens and global rules in guild.css, the component helpers (js/guild/ui-kit.js), the page templates
 * (js/guild/ui-templates.js), the guild-zone time formatter (js/guild/ui.js), the skip link and the Help fold in the shell, the glossary pass (decision 2, D1-D8)
 * and the dead ends (F10 / quick wins 2, 6, 7, 8).
 * Run: node tests/guild/guild-framework-ui-tests.js
 *
 * Same approach as guild-raidsux-ui-tests.js: the guild scripts load in a vm with no DOM, the helpers return HTML strings, and the few behaviours (the Save bar,
 * the leave guard, the toast, the dialog that never stacks) run against a few lines of fake DOM.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('../guild-scripts');
const GuildCss = require('../guild-css');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const css = (read('planner-forge.css') + '\n' + read('guild.css'));
const appCss = read('app.css');

function loadGuild(extra) {
  const sandbox = Object.assign({ console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout, clearTimeout }, extra || {});
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
ctx.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const ui = G.ui;
const plain = v => JSON.parse(JSON.stringify(v));
const stripTags = s => s.replace(/<[^>]*>/g, '');
const count = (s, re) => (s.match(re) || []).length;

const HOSTILE = '<img src=x onerror=1>';
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute (the CSP forbids it): ' + tag.slice(0, 90));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 90));
  }
}

(async () => {
  // ═══ 1. Tokens and the global rules ═══
  await check('tokens: the framework block names the field edge, status roles, type scale with a 12 px floor, control sizes and the focus ring', () => {
    const block = GuildCss.frameworkBlock(css);
    assert(block.includes('--border-field: #6b6f72;') && block.includes('--danger-text: #e98479;') && block.includes('--class-shaman-text: #4a9bff;'));
    assert(/--t-micro: 12px;/.test(block) && /--t-meta: 14px;/.test(block) && /--t-body: 16px;/.test(block) && /--t-h1-phone: 24px;/.test(block));
    assert(/--control-h: 40px;/.test(block) && /--control-h-phone: 44px;/.test(block) && /--control-h-sm: 34px;/.test(block) && /--control-h-lg: 48px;/.test(block));
    assert(/--focus-ring: 2px solid var\(--text-primary\);/.test(block) && /--focus-offset: 2px;/.test(block));
    for (const tone of ['success', 'warning', 'danger', 'info', 'neutral', 'none']) {
      for (const part of ['ink', 'bg', 'edge']) assert(new RegExp('--status-' + tone + '-' + part + ': #[0-9a-f]{6};').test(block), tone + ' ' + part);
    }
    assert(/--status-info-bg: #18232e;/.test(block), 'the new info background');
    assert(appCss.includes('--role-dps: #e06666;'), 'DPS text colour 5.2:1');
  });

  await check('tokens: molten orange is the primary button only; count badges are gold; "New" is a neutral outline', () => {
    const uses = css.split('\n').filter(l => /var\(--molten|var\(--text-on-molten|var\(--ember/.test(l));
    for (const l of uses) assert(/\.gs-btn-molten|\.gs-logo-dots/.test(l), 'molten outside a primary button: ' + l.trim().slice(0, 100));
    assert(/\.gs-nav-badge \{[^}]*background: var\(--accent-gold\); color: var\(--text-on-accent\)/.test(css), 'sidebar count');
    assert(/\.gs-tab-count \{[^}]*background: var\(--accent-gold\); color: var\(--text-on-accent\)/.test(css), 'tab count');
    assert(/\.gs-cbadge \{[^}]*background: var\(--accent-gold\)/.test(css));
    assert(/\.gs-new-pill \{[^}]*background: transparent; border: 1px solid var\(--border-field\); color: var\(--text-secondary\)/.test(css), 'the sidebar NEW mark');
    assert(/\.gs-new-dot \{[^}]*background: var\(--text-secondary\)/.test(css));
    assert(/\.gs-nbadge \{[^}]*border: 1px solid var\(--border-field\)/.test(css));
  });

  await check('tokens: field edges are #6b6f72 (a gold edge on focus), DPS and Shaman text colours, a 12 px text floor, 44 px phone controls', () => {
    assert(/\.gs-input \{[^}]*border: 1px solid var\(--border-field\)/.test(css) && /\.gs-input:focus \{ border-color: var\(--text-primary\); \}/.test(css));
    assert(/\.gs-class-shaman, \.guild-page a\.gs-class-shaman \{ color: var\(--class-shaman-text\); \}/.test(css) && /\.cc-shaman \{ color: var\(--class-shaman-text\); \}/.test(css));
    // No font size under 12 px anywhere in guild.css but the printed loot sheet (paper, not screen).
    const screen = css.replace(/@media print \{[\s\S]*?\n\}\n/, '');
    const sizes = [...screen.matchAll(/font(?:-size)?:[^;{}]*?\b(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
    assert(sizes.length > 100 && Math.min(...sizes) >= 12, 'smallest font size: ' + Math.min(...sizes));
    const phone = css.slice(css.lastIndexOf('@media (max-width: 600px)'));
    assert(/\.gs-icon-btn, \.gs-banner-x \{ width: var\(--control-h-phone\); height: var\(--control-h-phone\); \}/.test(phone));
    assert(/\.guild-page a\.gs-char-link, \.guild-page a\.gs-raid-link \{[^}]*min-height: var\(--control-h-phone\)/.test(phone), 'roster names and raid dates are 44 px targets');
    assert(/\.gs-dialog \{ width: 100%;[^}]*margin: auto 0 0/.test(css) && /\.gs-dialog-actions \{ flex-direction: column-reverse;/.test(phone), 'dialogs are bottom sheets, primary on top');
    assert(/\.gs-btn \{[^}]*min-height: var\(--control-h\)/.test(css) && /\.gs-btn-lg \{ min-height: var\(--control-h-lg\)/.test(css));
    assert(/\.gs-savebar, \.gs-commitbar \{ bottom: 64px;/.test(phone), 'the Save and commit bars sit above the phone tab bar');
    assert(/\.gs-pagehead-actions \{ display: contents; \}/.test(phone) && /\.gs-pagehead-actions > \.gs-btn-molten \{ order: 3; flex: 1 1 100%; min-height: var\(--control-h-lg\)/.test(phone), 'the primary moves under the context line as a full-width L button');
    assert(/\.gs-menu-trigger\.has-phone-icon \{ width: var\(--control-h-phone\)/.test(css), 'More is a 44 px dots button');
  });

  await check('tokens: the table cards, and the settings panes switch below 760 px; the skip link is off-screen until focused', () => {
    const wide = css.slice(css.indexOf('Design framework: below 760 px'), css.indexOf('Design framework: phone controls'));
    assert(/@media \(max-width: 760px\)/.test(wide));
    assert(/\.gs-dtable td\[data-label\]::before \{ content: attr\(data-label\)/.test(wide) && /\.gs-dtable thead \{ position: absolute;/.test(wide));
    assert(/\.gs-settings-page\.is-view-list \.gs-sdetail \{ display: none; \}/.test(wide) && /\.gs-settings-page\.is-view-detail \.gs-slist \{ display: none; \}/.test(wide));
    assert(/\.gs-skip \{ position: absolute; left: 8px; top: -64px;/.test(css) && /\.gs-skip:focus \{ top: 8px; \}/.test(css));
    assert(/\.gs-skeleton \{[^}]*animation: gs-skel-in 0s linear 300ms forwards/.test(css), 'skeleton rows appear after 300 ms');
    assert(/@media \(prefers-reduced-motion: reduce\) \{ \.gs-toast \{ animation: none; \} \}/.test(css));
  });

  // ═══ 2. Times in the guild's zone ═══
  const AUG = Date.UTC(2026, 7, 5, 0, 0, 0);       // summer in the north
  const JAN = Date.UTC(2026, 0, 21, 1, 0, 0);      // winter in the north
  const OCT21 = Date.UTC(2026, 9, 22, 0, 0, 0);    // Wed Oct 21 8:00 PM New York (EDT)

  await check('time: zone labels are the short family names (ET CT MT PT AKT CET EET GMT), the same in winter and summer; no short name reads as an offset', () => {
    const label = (zone, ms) => ui.zoneLabel(zone, ms);
    for (const [zone, want] of [['America/New_York', 'ET'], ['America/Chicago', 'CT'], ['America/Denver', 'MT'], ['America/Phoenix', 'MT'], ['America/Los_Angeles', 'PT'], ['America/Anchorage', 'AKT'],
      ['Europe/London', 'GMT'], ['Europe/Berlin', 'CET'], ['Europe/Paris', 'CET'], ['Europe/Athens', 'EET'], ['UTC', 'UTC']]) {
      assert.equal(label(zone, JAN), want, zone + ' in winter');
      assert.equal(label(zone, AUG), want, zone + ' in summer');
    }
    assert.equal(label('Australia/Brisbane', JAN), 'UTC+10');
    assert.equal(label('Asia/Kolkata', JAN), 'UTC+5:30');
    assert.equal(label('Asia/Tokyo', AUG), 'UTC+9');
    assert.equal(label('America/Sao_Paulo', JAN), 'UTC-3');
    assert.equal(label('Europe/Moscow', JAN), 'UTC+3');
    // Daylight saving moves the offset, and the offset label follows it.
    assert.equal(label('Australia/Sydney', JAN), 'UTC+11');
    assert.equal(label('Australia/Sydney', AUG), 'UTC+10');
    assert.equal(label('Pacific/Auckland', OCT21), 'UTC+13');
  });

  await check('time: "Wed Oct 21, 8:00 PM ET" - date, time, zone; the time of day moves with daylight saving; a plain space before PM (no no-break space)', () => {
    assert.equal(ui.dateTimeInZone(OCT21, 'America/New_York'), 'Tue Oct 21, 8:00 PM ET'.replace('Tue', 'Wed'));
    assert.equal(ui.timeInZone(OCT21, 'America/New_York'), '8:00 PM ET');
    assert.equal(ui.timeInZone(OCT21, 'America/Chicago'), '7:00 PM CT');
    assert.equal(ui.timeInZone(OCT21, 'America/Los_Angeles'), '5:00 PM PT');
    assert.equal(ui.timeInZone(OCT21, 'Europe/Berlin'), '2:00 AM CET');
    assert.equal(ui.dayInZone(OCT21, 'Europe/Berlin'), 'Thu Oct 22', 'the date of that zone, not the browser');
    assert.equal(ui.dayKeyInZone(OCT21, 'America/New_York'), '2026-10-21');
    // Winter and summer in New York: 8:00 PM local is a different UTC moment, and the label stays ET.
    assert.equal(ui.dateTimeInZone(Date.UTC(2027, 0, 14, 1, 0, 0), 'America/New_York'), 'Wed Jan 13, 8:00 PM ET');
    assert.equal(ui.dateTimeInZone(Date.UTC(2026, 6, 15, 0, 0, 0), 'America/New_York'), 'Tue Jul 14, 8:00 PM ET');
    assert.equal(ui.timeInZone(Date.UTC(2026, 9, 21, 4, 5, 0), 'America/New_York'), '12:05 AM ET', 'midnight reads 12, not 0');
    assert(!/[\u202f\u00a0]/.test(ui.dateTimeInZone(OCT21, 'America/New_York')));
    assert(/^[\x20-\x7e]+$/.test(ui.dateTimeInZone(OCT21, 'America/New_York')), 'plain ASCII');
  });

  await check('time: the year joins only when asked or when it is not this year; the zone can be left off; bad input is empty, an unknown zone falls back to the viewer\'s named zone', () => {
    const AT = Date.UTC(2026, 9, 18, 0, 15, 0);
    assert.equal(ui.dateTimeInZone(AT, 'America/New_York', { year: 'auto', now: Date.UTC(2026, 10, 1) }), 'Sat Oct 17, 8:15 PM ET');
    assert.equal(ui.dateTimeInZone(AT, 'America/New_York', { year: 'auto', now: Date.UTC(2027, 0, 5) }), 'Sat Oct 17, 2026, 8:15 PM ET');
    assert.equal(ui.dateTimeInZone(AT, 'America/New_York', { year: true }), 'Sat Oct 17, 2026, 8:15 PM ET');
    assert.equal(ui.dateTimeInZone(AT, 'America/New_York', { noZone: true }), 'Sat Oct 17, 8:15 PM');
    for (const bad of [null, undefined, 'x', NaN, Infinity]) {
      assert.equal(ui.timeInZone(bad, 'America/New_York'), '');
      assert.equal(ui.dateTimeInZone(bad, 'America/New_York'), '');
      assert.equal(ui.dayInZone(bad, 'America/New_York'), '');
    }
    const fallback = ui.timeInZone(AT, 'Not/AZone');
    assert(/^\d{1,2}:\d{2} [AP]M \S+$/.test(fallback), 'the viewer\'s zone, still named: ' + fallback);
    assert.equal(ui.timeInZone(AT, ''), ui.timeInZone(AT, 'Not/AZone'));
    assert.equal(ui.formatDateTime(AT, 'America/New_York'), 'Sat Oct 17, 8:15 PM ET', 'formatDateTime with the guild zone');
    assert(!/ET$/.test(ui.formatDateTime(AT)), 'without a zone it is the viewer\'s own, as before');
    assert.equal(ui.guildZone(), '', 'no app: no guild zone');
  });

  await check('time: the pages write times with the guild zone - Raids list, sign-up deadline, loot, activity, the guest page', () => {
    const raids = read('js/guild/pages-raids.js');
    assert(raids.includes('return G.ui.timeInZone(ms, timeZone);') && !/toLocaleTimeString/.test(raids));
    const loot = read('js/guild/pages-loot.js');
    assert(loot.includes('G.ui.timeInZone(ms, timeZone)') && loot.includes('G.ui.dateTimeInZone(ms, timeZone)'));
    assert(read('js/guild/pages-settings-activity.js').includes("G.ui.dateTimeInZone(ms, timeZone, { year: 'auto', now: now })"));
    assert(read('js/guild/pages-join.js').includes('G.ui.dateTimeInZone(raid.startsAt, zone)') && read('js/guild/pages-join.js').includes('data.guild.timeZone'), 'the guest sign-up writes the start in the guild zone');
    assert(read('js/app.js').includes('guild.ui.timeInZone(Date.now()'), 'the Planner\'s "Saved to the raid at" uses the guild clock');
    for (const f of ['pages-applications', 'pages-settings-guests', 'pages-settings-dataaccess']) assert(read('js/guild/' + f + '.js').includes('G.ui.guildZone()'), f);
  });

  // ═══ 3. Buttons, chips, badges, segments ═══
  await check('buttons: the variants map to the six looks; sizes and block; a link renders as <a>; disabled and busy keep the label and say so; no inline attributes', () => {
    const b = o => ui.buttonHtml(o);
    assert.equal(b({ label: 'Plan in Planner', variant: 'primary', attrs: { 'data-action': 'plan' } }), '<button type="button" class="gs-btn gs-btn-molten" data-action="plan"><span>Plan in Planner</span></button>');
    assert(b({ label: 'Add log' }).includes('class="gs-btn"'));
    assert(b({ label: 'Cancel', variant: 'ghost' }).includes('class="gs-btn gs-btn-ghost"'));
    assert(b({ label: 'Delete raid', variant: 'danger-outline' }).includes('gs-btn gs-btn-danger-outline'));
    assert(b({ label: 'Delete raid', variant: 'danger' }).includes('gs-btn gs-btn-danger"'));
    assert(b({ label: 'Open raid', variant: 'link' }).includes('class="gs-linkbtn"'));
    assert(b({ label: 'Edit', size: 'sm' }).includes('gs-btn gs-btn-sm') && b({ label: 'Confirm', variant: 'primary', size: 'lg', block: true }).includes('gs-btn gs-btn-molten gs-btn-lg gs-btn-wide'));
    assert(b({ label: 'x', variant: 'nonsense' }).includes('class="gs-btn"'), 'an unknown variant is secondary');
    assert.deepEqual(ui.BUTTON_VARIANTS, ['primary', 'secondary', 'ghost', 'danger-outline', 'danger', 'link']);
    assert(b({ label: 'Open', href: '#/g/g1/raids' }).startsWith('<a class="gs-btn" href="#/g/g1/raids"'));
    assert(b({ label: 'Save', variant: 'primary', type: 'submit' }).includes('type="submit"'));
    const busy = b({ label: 'Save changes', variant: 'primary', busy: true, busyLabel: 'Saving...' });
    assert(busy.includes('aria-busy="true"') && busy.includes(' disabled') && busy.includes('Saving...') && busy.includes('is-busy'));
    assert(b({ label: 'Import', busy: true }).includes('Import...'), 'busy keeps the label and adds the state');
    assert(b({ label: 'Go', disabled: true, href: '#/x' }).includes('aria-disabled="true"'));
    const hostile = b({ label: HOSTILE, attrs: { 'data-x': HOSTILE, onclick: 'alert(1)', style: 'color:red', class: 'evil' } });
    assert(!hostile.includes('<img') && !/onclick|style=|class="evil"/.test(hostile));
    assertNoRawAttrs(hostile);
  });

  await check('buttons: an icon-only button always carries an aria-label naming the object, else nothing is rendered', () => {
    const out = ui.iconButtonHtml({ icon: 'more', ariaLabel: 'More actions for Naturesgrasp', attrs: { 'data-action': 'row-menu' } });
    assert(out.startsWith('<button type="button" class="gs-icon-btn" aria-label="More actions for Naturesgrasp"') && out.includes('<svg'));
    assert.equal(ui.iconButtonHtml({ icon: 'more' }), '');
    assert(ui.iconButtonHtml({ icon: 'trash', ariaLabel: 'Remove report 1', danger: true }).includes('gs-icon-btn-danger'));
  });

  await check('chips: a status chip is tint + icon + word in one of six tones; a tag is a neutral outline; marks come from classes', () => {
    for (const tone of ui.CHIP_TONES) {
      const out = ui.chipHtml({ tone: tone, label: 'Word' });
      assert(out.includes('gs-schip gs-schip-' + tone) && out.includes('<svg class="gs-schip-icon"') && out.includes('aria-hidden="true"') && stripTags(out) === 'Word', tone);
    }
    assert.deepEqual(plain(ui.CHIP_TONES), ['success', 'warning', 'danger', 'info', 'neutral', 'none']);
    assert(ui.chipHtml({ tone: 'bogus', label: 'X' }).includes('gs-schip-neutral'));
    const cant = ui.signupChipHtml('cant_come');
    assert(cant.includes('gs-schip-danger') && stripTags(cant) === 'Can&#39;t come');
    assert.equal(stripTags(ui.signupChipHtml('signed')), 'Signed');
    assert.equal(stripTags(ui.signupChipHtml('late')), 'Late');
    assert.equal(stripTags(ui.signupChipHtml('none')), 'No sign-up');
    assert.equal(ui.signupChipHtml('nope'), '');
    assert.equal(ui.tagHtml('Raid-Helper', 'info'), '<span class="gs-tag gs-tag-plain"><span class="gs-tag-mark is-info" aria-hidden="true"></span>Raid-Helper</span>');
    assert(ui.tagHtml('Warrior', 'WARRIOR').includes('is-warrior') && !ui.tagHtml('Plain').includes('gs-tag-mark'));
    assert(ui.markBarHtml('DRUID').includes('gs-markbar is-druid') && ui.markBarHtml('dps').includes('is-dps') && ui.markBarHtml('nonsense') === '');
    assertNoRawAttrs(ui.chipHtml({ tone: 'danger', label: HOSTILE, title: HOSTILE }));
    assert(!ui.chipHtml({ tone: 'danger', label: HOSTILE }).includes('<img'));
    for (const tone of ['success', 'warning', 'danger', 'info', 'neutral', 'none']) assert(css.includes('.gs-schip-' + tone + ' {'), tone);
  });

  await check('badges: a gold count (gone at 0, 99+, with words for a screen reader) and a neutral New that never sits with a count', () => {
    assert.equal(ui.countBadgeHtml(0, 'x'), '');
    assert.equal(ui.countBadgeHtml(-2), '');
    assert.equal(ui.countBadgeHtml('x'), '');
    const three = ui.countBadgeHtml(3, '3 items need attention');
    assert(three.includes('gs-cbadge') && three.includes('<span aria-hidden="true">3</span>') && three.includes('<span class="gs-sr">3 items need attention</span>'));
    assert(ui.countBadgeHtml(150, '150 waiting').includes('>99+<'));
    assert.equal(ui.newBadgeHtml(), '<span class="gs-nbadge">New</span>');
    assert(ui.badgeHtml({ count: 2, label: '2 flags to review', isNew: true }).includes('gs-cbadge') && !ui.badgeHtml({ count: 2, label: 'x', isNew: true }).includes('gs-nbadge'), 'a count wins over New');
    assert(ui.badgeHtml({ count: 0, isNew: true }).includes('gs-nbadge'));
    assert.equal(ui.badgeHtml({ count: 0 }), '');
  });

  await check('segments: a labelled group of toggle buttons; the selected one is aria-pressed; counts follow the label', () => {
    const out = ui.segmentsHtml({ label: 'Show raids', action: 'raids-tab', selected: 'past', items: [{ key: 'upcoming', label: 'Upcoming', count: 2 }, { key: 'past', label: 'Past', count: 14 }, { key: 'all', label: 'All' }] });
    assert(out.startsWith('<div class="gs-segs" role="group" aria-label="Show raids">'));
    assert(out.includes('aria-pressed="true" data-action="raids-tab" data-value="past">Past <span class="gs-seg-count">14</span>'));
    assert.equal(count(out, /aria-pressed="false"/g), 2);
    assert(out.includes('data-value="all">All</button>'));
    assert.equal(ui.segmentsHtml({ items: [] }), '');
    assertNoRawAttrs(out);
  });

  // ═══ 4. Next-step bar (the stage strip left with the raids revamp: the bar and the Raid facts carry the stages) ═══
  await check('next-step bar: the one primary sits rightmost after at most one secondary; a member\'s bar names what the officers wait for and has no buttons', () => {
    const out = ui.nextStepHtml({ title: 'Plan this raid', text: '23 signed up, 2 on the bench.', primary: { label: 'Plan in Planner', attrs: { 'data-action': 'plan' } }, secondary: { label: 'Skip planning' } });
    assert(out.startsWith('<section class="gs-nextstep" aria-labelledby="nextstep-t">') && out.includes('<h2 class="gs-nextstep-title" id="nextstep-t">Plan this raid</h2>'));
    assert(out.indexOf('Skip planning') < out.indexOf('Plan in Planner') && count(out, /gs-btn-molten/g) === 1);
    const wait = ui.nextStepHtml({ title: 'The officers are planning', text: 'You will see your group here once it is published.' });
    assert(wait.includes('gs-nextstep is-waiting') && !wait.includes('<button') && !wait.includes('gs-nextstep-actions'));
    assertNoRawAttrs(out);
  });

  // ═══ 5. The data table ═══
  const COLS = [
    { key: 'name', label: 'Character', primary: true, sort: 'ascending' },
    { key: 'role', label: 'Role' },
    { key: 'status', label: 'Status' },
    { key: 'updated', label: 'Updated', align: 'right' },
  ];
  const row = (id, name, extra) => Object.assign({ id: id, cells: { name: '<a href="#/p/' + id + '">' + name + '</a>', role: 'DPS', status: ui.signupChipHtml('signed'), updated: 'Tue 7:12 PM ET' } }, extra || {});
  await check('data table: head with aria-sort, first column is the row header and link, the viewer\'s row keeps its place with a YOU tag, cells carry data-label for the phone card', () => {
    const out = ui.dataTableHtml({ label: 'Sign-ups', columns: COLS, rows: [row('a', 'Ironvale', { mark: 'WARRIOR' }), row('me', 'Thornwick', { you: true, mark: 'DRUID' }), row('c', 'Mirelle')] });
    assert(out.startsWith('<div class="gs-dtable-wrap"><table class="gs-dtable" aria-label="Sign-ups">'));
    assert(out.includes('<th scope="col" class="" aria-sort="ascending"><button type="button" class="gs-sort" data-action="table-sort" data-table="Sign-ups" data-sort="name" data-key="tsort-Sign-ups-name" data-dir="asc">Character'));
    assert(out.includes('<th scope="col" class="is-right" aria-sort="none"><button type="button" class="gs-sort" data-action="table-sort" data-table="Sign-ups" data-sort="updated"'), 'every head is sortable');
    const firstRow = out.slice(out.indexOf('<tbody>'));
    assert(firstRow.indexOf('Ironvale') < firstRow.indexOf('Thornwick') && firstRow.indexOf('Thornwick') < firstRow.indexOf('Mirelle'), 'You keep the given order, not first');
    assert(firstRow.includes('<th scope="row" class="gs-dtable-primary"><a href="#/p/me">Thornwick</a> <span class="gs-you">You</span></th>'));
    assert(out.includes('<tr class="gs-dtable-row is-you has-mark is-druid" data-row="me">') && out.includes('has-mark is-warrior'));
    assert(out.includes('<td class="" data-label="Role">DPS</td>') && out.includes('<td class="is-right" data-label="Updated">Tue 7:12 PM ET</td>'));
    assert.equal(count(out, /gs-you/g), 1);
    assert(css.includes('.gs-dtable-row.is-druid { --mark: var(--class-druid); }'));
  });

  await check('data table: over 10 rows shows 10 and "Show all N" (no pagination); showAll shows everything; nothing to show is the empty state', () => {
    const rows = []; for (let i = 0; i < 23; i++) rows.push(row('r' + i, 'Name' + i));
    const out = ui.dataTableHtml({ label: 'Sign-ups', columns: COLS, rows: rows, noun: 'sign-ups' });
    assert.equal(count(out, /<tr class="gs-dtable-row/g), 10);
    assert(out.includes('Showing 10 of 23 sign-ups') && out.includes('<button type="button" class="gs-linkbtn" data-action="table-show-all">Show all 23</button>'));
    const all = ui.dataTableHtml({ label: 'Sign-ups', columns: COLS, rows: rows, showAll: true });
    assert.equal(count(all, /<tr class="gs-dtable-row/g), 23);
    assert(!all.includes('Show all'));
    assert.equal(ui.dataTableHtml({ columns: COLS, rows: rows.slice(0, 10) }).includes('gs-dtable-foot'), false, 'exactly ten fit');
    const empty = ui.emptyStateHtml({ kind: 'filtered', title: 'No sign-ups match', actions: [{ label: 'Show all sign-ups' }] });
    assert.equal(ui.dataTableHtml({ columns: COLS, rows: [], emptyHtml: empty }), empty);
    assert.equal(ui.dataTableHtml({ columns: [], rows: rows }), '');
    // A pinned row beyond the first ten still shows (it is pinned before the cut).
    const lastMine = ui.dataTableHtml({ columns: COLS, rows: rows.concat([row('me', 'Thornwick', { you: true })]) });
    assert(lastMine.indexOf('Thornwick') < lastMine.indexOf('Name0'));
    assertNoRawAttrs(out);
  });

  // ═══ 6. Form fields, validation, the Save bar ═══
  await check('fields: label above, "(required)" in words, help under it, aria-describedby ties help and error, the control is 40 px (a class), nothing inline', () => {
    const out = ui.fieldHtml({ id: 'f-name', name: 'name', label: 'Guild name', required: true, value: 'Vindicated', help: 'Shown in the sidebar.' });
    assert(out.includes('<label class="gs-label" for="f-name">Guild name <span class="gs-req">(required)</span></label>'));
    assert(out.includes('<input class="gs-input" type="text" id="f-name" name="name" required aria-required="true" aria-describedby="f-name-help f-name-err" value="Vindicated">'));
    assert(out.includes('<p class="gs-fine" id="f-name-help">Shown in the sidebar.</p>') && out.includes('<p class="gs-field-error" id="f-name-err" role="alert" hidden></p>'));
    assert(!out.includes('aria-invalid'));
    assertNoRawAttrs(out);
    const sel = ui.fieldHtml({ id: 'f-tz', name: 'timeZone', label: 'Time zone', kind: 'select', options: [{ value: 'America/New_York', label: 'ET' }, { value: 'America/Chicago', label: 'CT' }], selected: 'America/Chicago' });
    assert(sel.includes('<select class="gs-input" id="f-tz"') && sel.includes('<option value="America/Chicago" selected>CT</option>'));
    assert(ui.fieldHtml({ id: 'n', label: 'Notes', kind: 'textarea', value: 'a<b', rows: 3 }).includes('<textarea class="gs-input gs-textarea"') );
    assert(ui.fieldHtml({ id: 'n', label: 'Notes', kind: 'textarea', value: HOSTILE }).includes('&lt;img'));
    assert.equal(ui.fieldHtml({ label: 'No id' }), '');
  });

  await check('fields: an error shows an icon and what to do under the field, marks it invalid and describes it; a read-only or disabled field always says why', () => {
    const bad = ui.fieldHtml({ id: 'f-to', label: 'To', error: 'Add a To date, or choose Every week on one day.' });
    assert(bad.includes('aria-invalid="true"') && bad.includes('id="f-to-err" role="alert">') && bad.includes('<svg') && bad.includes('Add a To date, or choose Every week on one day.'));
    assert(!bad.includes('id="f-to-err" role="alert" hidden'));
    const ro = ui.fieldHtml({ id: 'f-gv', label: 'Game version', value: 'TBC Anniversary', readonly: true, reason: 'Set when the guild was created, because the rule sets differ.' });
    assert(ro.includes(' readonly') && ro.includes('Set when the guild was created, because the rule sets differ.') && ro.includes('gs-field is-locked'));
    const noReason = ui.fieldHtml({ id: 'f-x', label: 'X', disabled: true });
    assert(noReason.includes('This can&#39;t be changed here.'), 'a locked field with no reason still says something');
    assert(ui.fieldHtml({ id: 'f-y', label: 'Y', readonly: true, help: 'The realm.', reason: 'Imported from Battle.net.' }).includes('The realm. Imported from Battle.net.'));
    const chk = ui.checkFieldHtml({ id: 'c1', name: 'standing', label: 'Standing sign-up', checked: true });
    assert(chk.includes('<div class="gs-check"><input type="checkbox" id="c1" name="standing" checked><label for="c1">Standing sign-up</label></div>'));
    assert(ui.checkFieldHtml({ id: 'r1', name: 'repeat', type: 'radio', value: 'weekly', label: 'Every week' }).includes('type="radio"'));
  });

  await check('validation: rules give messages in field order; 3 or more errors get a summary linking each field; the DOM helpers set aria-invalid, the message, and focus the first', () => {
    const rules = { to: (v, all) => (!v && !all.weekly ? 'Add a To date, or choose Every week on one day.' : ''), reason: v => (String(v || '').length > 5 ? 'Keep the reason to 5 characters.' : ''), name: v => (v ? '' : 'Add a name.') };
    const errors = ui.validateValues({ to: '', reason: 'too long', name: '' }, rules);
    assert.deepEqual(plain(errors), [{ id: 'to', message: 'Add a To date, or choose Every week on one day.' }, { id: 'reason', message: 'Keep the reason to 5 characters.' }, { id: 'name', message: 'Add a name.' }]);
    assert.deepEqual(plain(ui.validateValues({ to: 'x', reason: 'ok', name: 'a' }, rules)), []);
    assert.equal(ui.errorSummaryHtml(errors.slice(0, 2)), '', 'two errors are visible under their fields');
    const sum = ui.errorSummaryHtml(errors);
    assert(sum.includes('3 things to fix') && sum.includes('role="alert"') && sum.includes('data-target="to"') && sum.includes('data-target="name"'));
    // The runtime half, on a few fake nodes.
    const nodes = {};
    const mk = (id, extra) => { const n = Object.assign({ id, attrs: {}, hidden: true, innerHTML: '', value: '', focused: 0, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, focus() { this.focused++; } }, extra || {}); nodes[id] = n; return n; };
    mk('to'); mk('to-err'); mk('name', { value: '' }); mk('name-err'); mk('reason', { value: 'too long' }); mk('reason-err');
    const slot = { innerHTML: '' };
    const form = { querySelector(sel) { if (sel === '[data-error-summary-slot]') return slot; if (sel === '[aria-invalid="true"]') return Object.keys(nodes).map(k => nodes[k]).filter(n => n.attrs && n.attrs['aria-invalid'] === 'true')[0] || null; return nodes[sel.slice(1)] || null; } };
    const res = ui.validateForm(form, rules);
    assert.equal(res.ok, false);
    assert.equal(nodes.to.attrs['aria-invalid'], 'true');
    assert(nodes['to-err'].innerHTML.includes('Add a To date') && nodes['to-err'].hidden === false);
    assert.equal(nodes.to.focused, 1, 'the first error takes focus');
    assert(slot.innerHTML.includes('3 things to fix'));
    nodes.to.value = 'Sun Nov 1'; nodes.name.value = 'Thornwick'; nodes.reason.value = 'ok';
    const ok = ui.validateForm(form, rules);
    assert.equal(ok.ok, true);
    assert(nodes.to.attrs['aria-invalid'] === undefined && nodes['to-err'].hidden === true && slot.innerHTML === '');
  });

  // The fake form behind the Save bar: two named inputs, a checkbox and a bar with a text node.
  function fakeForm(values) {
    const els = Object.keys(values).map(name => ({ name, type: typeof values[name] === 'boolean' ? 'checkbox' : 'text', value: typeof values[name] === 'boolean' ? 'on' : values[name], checked: values[name] === true }));
    const bar = { hidden: true, querySelector: sel => (sel === '[data-savebar-text]' ? bar.textNode : null), textNode: { textContent: '' } };
    const form = { id: 'settings-form', elements: els, bar, resets: 0, querySelector: sel => (sel === '[data-savebar]' ? bar : null), reset() { this.resets++; els.forEach(e => { e.value = e.initial.value; e.checked = e.initial.checked; }); } };
    els.forEach(e => { e.initial = { value: e.value, checked: e.checked }; });
    return form;
  }
  await check('Save bar: markup is hidden until something changes; the bar counts changes against the saved values, says how many, and goes away after Save', () => {
    const out = ui.saveBarHtml();
    assert(out.startsWith('<div class="gs-savebar" role="region" aria-label="Unsaved changes" data-savebar hidden>') && out.includes('role="status" data-savebar-text'));
    assert(out.includes('data-action="savebar-discard"') && out.includes('>Discard<') && out.includes('type="submit"') && out.includes('Save changes') && count(out, /gs-btn-molten/g) === 1);
    assert.equal(ui.dirtyFormAttrs(), ' data-dirty-form data-input="dirty-form" data-change="dirty-form"');
    assert(ui.savedStatusHtml('Saved at 8:14 PM ET').includes('is-saved') && ui.savedStatusHtml('Unsaved changes', 'unsaved').includes('is-unsaved'));
    const form = fakeForm({ name: 'Vindicated', zone: 'America/New_York', announce: false });
    ui.saveBar.bind(form);
    assert.equal(form.bar.hidden, true);
    assert.deepEqual(plain(ui.saveBar.snapshot(form)), { name: 'Vindicated', zone: 'America/New_York', announce: '' });
    form.elements[0].value = 'Vindicated Raiders';
    G.handlers.input['dirty-form'](form);
    assert.equal(form.bar.hidden, false);
    assert.equal(form.bar.textNode.textContent, '1 unsaved change');
    form.elements[2].checked = true; form.elements[2].value = 'on';
    G.handlers.change['dirty-form'](form);
    assert.equal(form.bar.textNode.textContent, '2 unsaved changes');
    assert.equal(ui.unsaved.isDirty(), true);
    // Typing it back is no change at all.
    form.elements[0].value = 'Vindicated'; form.elements[2].checked = false;
    G.handlers.input['dirty-form'](form);
    assert.equal(form.bar.hidden, true);
    assert.equal(ui.unsaved.isDirty(), false);
    // Save: the new values are the saved ones.
    form.elements[0].value = 'Renamed';
    ui.saveBar.update(form);
    assert.equal(form.bar.hidden, false);
    ui.saveBar.markSaved(form, OCT21, 'America/New_York');
    assert.equal(form.bar.hidden, true);
    assert.equal(ui.unsaved.isDirty(), false);
    assert.deepEqual(plain(ui.saveBar.diff({ a: '1', b: '2' }, { a: '1', b: '3', c: 'x' })), ['b', 'c']);
  });

  await check('Save bar: Discard puts the saved values back, clears the errors and hides the bar', () => {
    const form = fakeForm({ name: 'Vindicated' });
    form.querySelectorAll = () => [];
    ui.saveBar.bind(form);
    form.elements[0].value = 'Changed';
    ui.saveBar.update(form);
    assert.equal(form.bar.hidden, false);
    G.handlers.click['savebar-discard']({ closest: sel => (sel === 'form' ? form : null) });
    assert.equal(form.resets, 1);
    assert.equal(form.elements[0].value, 'Vindicated');
    assert.equal(form.bar.hidden, true);
    assert.equal(ui.unsaved.isDirty(), false);
  });

  const click = (href, over) => { const a = { getAttribute: k => (k === 'href' ? href : null), hasAttribute: () => false }; const ev = Object.assign({ target: { closest: sel => (sel === 'a[href]' ? a : null) }, button: 0, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }, over || {}); return ev; };
  await check('leaving with unsaved changes: an in-app link click asks Stay or Leave and discard instead of navigating; nothing is asked when nothing is dirty or for new tabs and modified clicks', () => {
    const opened = [];
    const realOpen = ui.openDialog;
    ui.openDialog = html => { opened.push(html); return {}; };
    try {
      assert.equal(ui.unsaved.guardClick(click('#/g/g1/raids')), false, 'clean: no question');
      ui.unsaved.set('settings-form', true);
      const ev = click('#/g/g1/raids');
      assert.equal(ui.unsaved.guardClick(ev), true);
      assert(ev.prevented && ev.stopped);
      assert.equal(opened.length, 1);
      assert(opened[0].includes('Leave this page?') && opened[0].includes('Stay') && opened[0].includes('Leave and discard') && opened[0].includes('gs-btn-danger') && opened[0].includes('data-action="unsaved-leave"'));
      assert(opened[0].includes('autofocus'), 'Stay has the initial focus');
      assert.equal(ui.unsaved.pendingHref(), '#/g/g1/raids');
      assert.equal(ui.unsaved.guardClick(click('#/g/g1/raids', { ctrlKey: true })), false);
      assert.equal(ui.unsaved.guardClick(click('#/g/g1/raids', { button: 1 })), false);
      assert.equal(ui.unsaved.guardClick(click('https://example.com/x')), false, 'only in-app links are held');
      assert.equal(ui.unsaved.guardClick({ target: {} }), false);
      // Stay drops the question; Leave clears the flag and goes.
      ctx.location = { hash: '#/g/g1/home' };
      G.handlers.click['unsaved-stay']({ closest: () => null });
      assert.equal(ui.unsaved.pendingHref(), '');
      ui.unsaved.guardClick(click('#/g/g1/raids'));
      G.handlers.click['unsaved-leave']({ closest: () => null });
      assert.equal(ctx.location.hash, '/g/g1/raids');
      assert.equal(ui.unsaved.isDirty(), false);
    } finally { ui.openDialog = realOpen; ui.unsaved.clear(); delete ctx.location; }
  });

  await check('leaving with unsaved changes: the browser\'s own prompt covers closing or reloading the tab (beforeunload), and only while something is dirty', () => {
    const handlers = {};
    ui.unsaved.install({ addEventListener: (type, fn) => { handlers[type] = fn; } });
    assert.equal(typeof handlers.beforeunload, 'function');
    const clean = { prevented: false, preventDefault() { this.prevented = true; } };
    handlers.beforeunload(clean);
    assert.equal(clean.prevented, false);
    ui.unsaved.set('f', true);
    const dirty = { prevented: false, preventDefault() { this.prevented = true; } };
    handlers.beforeunload(dirty);
    assert.equal(dirty.prevented, true);
    ui.unsaved.clear();
    assert.equal(read('js/guild/app.js').includes('G.ui.unsaved.install(window);'), true);
    assert(read('js/guild/app.js').includes('if (G.ui.unsaved.guardClick(ev)) return;'));
    assert(read('js/guild/app.js').includes('G.ui.unsaved.clear(); // the address changed'));
  });

  // ═══ 7. Feedback: banners, toasts, states ═══
  await check('banners: inline by default - status for success and info, alert for warning and danger; a dismiss button that names its job; actions are secondary buttons', () => {
    const ok = ui.bannerHtml({ tone: 'success', title: 'Published the line-up', text: '17 of 19 raiders were told in Discord #raid-night; 2 have DMs off.', actions: [{ label: 'View line-up' }] });
    assert(ok.startsWith('<div class="gs-banner gs-banner-success" role="status">') && ok.includes('<p class="gs-banner-title">Published the line-up</p>'));
    assert(ok.includes('aria-label="Dismiss message" data-action="banner-dismiss"') && !ok.includes('gs-btn-molten'));
    assert(ok.includes('class="gs-btn gs-btn-sm"'), 'a banner action is a small secondary button');
    assert(ui.bannerHtml({ tone: 'danger', title: 'Nothing was created' }).includes('role="alert"') && ui.bannerHtml({ tone: 'warning', title: 'x' }).includes('role="alert"'));
    assert(ui.bannerHtml({ tone: 'info', title: 'x' }).includes('role="status"') && ui.bannerHtml({ title: 'x' }).includes('gs-banner-info'));
    assert(!ui.bannerHtml({ tone: 'info', title: 'x', dismissible: false }).includes('banner-dismiss'));
    const hostile = ui.bannerHtml({ tone: 'danger', title: HOSTILE, text: HOSTILE, actions: [{ label: HOSTILE }] });
    assert(!hostile.includes('<img'));
    assertNoRawAttrs(hostile);
    let removed = 0;
    G.handlers.click['banner-dismiss']({ closest: sel => (sel === '.gs-banner' ? { remove() { removed++; } } : null) });
    assert.equal(removed, 1);
  });

  await check('toasts: only for a local, reversible action - one line with Dismiss, 4 s; an error or warning is refused (those go inline)', () => {
    const html = ui.toastHtml('Copied for MRT. In game: /mrt, Notes, Import.');
    assert(html.startsWith('<div class="gs-toast" role="status">') && html.includes('Copied for MRT') && html.includes('data-action="toast-dismiss">Dismiss</button>'));
    const host = { id: 'gs-toasts', innerHTML: '', className: '' };
    const timers = [];
    const sandbox = { getElementById: id => (id === 'gs-toasts' ? host : null), createElement: () => host, body: { appendChild() {} } };
    const saved = [ctx.document, ctx.setTimeout, ctx.clearTimeout];
    ctx.document = sandbox;
    ctx.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    ctx.clearTimeout = () => {};
    try {
      assert.equal(ui.toast('Link copied'), true);
      assert(host.innerHTML.includes('Link copied') && timers[0].ms === 4000);
      timers[0].fn();
      assert.equal(host.innerHTML, '');
      assert.equal(ui.toast('Could not save', { tone: 'danger' }), false);
      assert.equal(ui.toast('Careful', { tone: 'warning' }), false);
      assert.equal(ui.toast(''), false);
      assert.equal(host.innerHTML, '');
      host.innerHTML = 'x';
      G.handlers.click['toast-dismiss']({ closest: sel => (sel === '#gs-toasts' ? host : null) });
      assert.equal(host.innerHTML, '');
    } finally { [ctx.document, ctx.setTimeout, ctx.clearTimeout] = saved; }
  });

  await check('states: empty (first use, filtered, good news), loading (skeleton, aria-busy, the words), error in one region (what is safe, Try again)', () => {
    const first = ui.emptyStateHtml({ kind: 'first', icon: 'raids', title: 'No raids yet', text: 'Create one, or set a weekly slot and Raidsmith creates the dates for you.', actions: [{ label: 'New raid' }, { label: 'Set a schedule' }] });
    assert(first.includes('gs-empty2 is-first') && first.includes('<h2 class="gs-empty2-title">No raids yet</h2>') && first.includes('gs-btn gs-btn-molten') && count(first, /gs-btn-molten/g) === 1 && first.includes('Set a schedule'));
    const filtered = ui.emptyStateHtml({ kind: 'filtered', title: 'No sign-ups match "Can\'t come"', actions: [{ label: 'Show all sign-ups' }] });
    assert(filtered.includes('is-filtered') && !filtered.includes('gs-btn-molten') && filtered.includes('Show all sign-ups'), 'a filtered empty offers a secondary, never a primary');
    const good = ui.emptyStateHtml({ kind: 'good', text: 'Nothing needs you. No flags to review.' });
    assert(good.includes('gs-empty-good') && good.includes('Nothing needs you. No flags to review.') && !good.includes('<button'));
    const loading = ui.loadingHtml({ label: 'Loading raids', rows: 3 });
    assert(loading.includes('aria-busy="true"') && loading.includes('Loading raids...') && count(loading, /gs-skel-row/g) === 3 && !loading.includes('spinner'));
    assert.equal(count(ui.loadingHtml({ rows: 99 }), /gs-skel-row/g), 8);
    const err = ui.errorRegionHtml({ title: 'Couldn\'t load the roster', text: 'The server did not answer.', retry: { attrs: { 'data-action': 'retry' } } });
    assert(err.includes('role="alert"') && err.includes('gs-banner-danger') && err.includes('The server did not answer. Your data is safe.') && err.includes('>Try again<') && err.includes('data-action="retry"'));
    assert(ui.errorRegionHtml({ title: 'x', safe: 'Your plan is safe on this device.' }).includes('Your plan is safe on this device.'));
    assertNoRawAttrs(first + filtered + good + loading + err);
  });

  // ═══ 8. Dialogs ═══
  await check('dialog markup: four kinds; confirm and destructive start on Cancel; the destructive confirm is the one filled danger button; a step says where it is and offers Back', () => {
    const form = ui.dialogHtml({ kind: 'form', title: 'Add an away notice', bodyHtml: '<p>fields</p>', primary: { label: 'Save notice' }, formAttrs: { 'data-submit': 'away-form' } });
    assert(form.startsWith('<form class="gs-dialog-form gs-dialog-form" data-submit="away-form" novalidate>') && form.includes('<h2 class="gs-dialog-title" id="dlg-title">Add an away notice</h2>'));
    assert(form.indexOf('>Cancel<') < form.indexOf('>Save notice<') && form.includes('type="submit"') && form.includes('id="dlg-error" role="alert" hidden'));
    assert(!form.includes('autofocus'), 'a form dialog focuses its first field');
    const confirm = ui.dialogHtml({ kind: 'confirm', title: 'Publish the line-up?', text: '19 players in 4 groups. Raiders are told in Discord #raid-night.', primary: { label: 'Publish line-up' } });
    assert(confirm.includes('Cancel') && /<button type="button" class="gs-btn" autofocus data-action="dialog-cancel">/.test(confirm) || /autofocus/.test(confirm));
    assert(count(confirm, /autofocus/g) === 1 && confirm.includes('gs-btn gs-btn-molten') && confirm.includes('gs-dialog-confirm'));
    const destroy = ui.dialogHtml({ kind: 'destructive', title: 'Delete Wed Oct 21?', text: 'This can\'t be undone.', primary: { label: 'Delete raid' } });
    assert(destroy.includes('gs-dialog-destructive') && destroy.includes('gs-btn gs-btn-danger"') && !destroy.includes('gs-btn-molten') && /autofocus/.test(destroy));
    const step = ui.dialogHtml({ kind: 'step', step: 'Link a Raid-Helper event - step 2 of 2', title: 'Move this raid to Thu Oct 22?', text: 'The event is dated Thu Oct 22.', back: { label: 'Back', attrs: { 'data-action': 'link-back' } }, primary: { label: 'Move raid' } });
    assert(step.includes('<p class="gs-dialog-step">Link a Raid-Helper event - step 2 of 2</p>') && step.indexOf('>Back<') < step.indexOf('>Cancel<') && step.indexOf('>Cancel<') < step.indexOf('>Move raid<'));
    assert(step.includes('gs-btn gs-btn-ghost'));
    assert(ui.dialogHtml({ kind: 'form', title: 'x', wide: true, primary: { label: 'y' } }).includes('gs-dialog-preview'));
    assert(!ui.dialogHtml({ kind: 'form', title: 'x', formless: true, primary: { label: 'y' } }).includes('<form'));
    assertNoRawAttrs(form + confirm + destroy + step);
  });

  // A tiny dialog DOM: a host that holds dialogs, with open/close/remove, a close event, contains() and isConnected.
  function dialogDom() {
    const host = { kids: [], appendChild(d) { this.kids.push(d); d.isConnected = true; } };
    const focusLog = [];
    const doc = {
      getElementById: id => (id === 'guild-dialogs' ? host : null),
      createElement: () => {
        const d = { open: false, isConnected: false, listeners: {}, attrs: {}, html: '', setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.listeners[t] = f; },
          showModal() { this.open = true; }, contains(el) { return !!el && el.dialog === this; }, querySelector: () => null,
          close() { if (!this.open) return; this.open = false; const f = this.listeners.close; if (f) f(); }, remove() { this.isConnected = false; host.kids = host.kids.filter(k => k !== this); } };
        Object.defineProperty(d, 'innerHTML', { get() { return this.html; }, set(v) { this.html = v; } });
        return d;
      },
      activeElement: null, querySelector: () => null, querySelectorAll: () => [],
    };
    return { host, doc, focusLog };
  }
  await check('dialogs never stack: opening one replaces the open one, and focus still returns to the control on the page that opened the first', () => {
    const { host, doc, focusLog } = dialogDom();
    const pageButton = { isConnected: true, getAttribute: k => (k === 'data-key' ? 'link-event' : null), focus() { focusLog.push('page-button'); doc.activeElement = this; } };
    const insideButton = { isConnected: true, dialog: null, getAttribute: () => null, focus() { focusLog.push('inside-button'); doc.activeElement = this; } };
    const sandbox = loadGuild({ document: doc, HTMLDialogElement: function HTMLDialogElement() {} });
    const U = sandbox.Guild.ui;
    sandbox.Guild.app = { lastActionEl: pageButton };
    const first = U.openDialog('<form>link</form>', {});
    assert(first.open && host.kids.length === 1);
    insideButton.dialog = first;
    sandbox.Guild.app.lastActionEl = insideButton; // the second dialog is started from a button inside the first
    const second = U.openDialog('<form>move</form>', {});
    assert.equal(host.kids.length, 1, 'only one dialog in the host');
    assert(second.open && !first.open && host.kids[0] === second);
    assert.equal(U.dialogIsOpen(), true);
    assert.deepEqual(focusLog, [], 'the replaced dialog does not move focus');
    second.close();
    assert.deepEqual(focusLog, ['page-button'], 'focus returns to the page control that started the flow');
    assert.equal(U.dialogIsOpen(), false);
    // A step replaces the body in place.
    const third = U.openDialog('<form>a</form>', {});
    U.replaceDialogBody(third, '<form>b</form>');
    assert.equal(third.html, '<form>b</form>');
    assert.equal(host.kids.length, 1);
  });

  // ═══ 9. Page templates ═══
  await check('page head: gold h1, one context line, the one More menu (a dots icon on a phone) and the primary rightmost', () => {
    const out = ui.pageHeadHtml({ title: 'Raids', context: 'Main team - weekly slot Wed 8:00 PM ET - 2 upcoming, 14 past', more: { id: 'raids-more', items: [{ label: 'Raid schedule', href: '#/g/g1/settings/schedule' }] }, primary: { label: 'New raid', href: '#/g/g1/raids/new' }, chipsHtml: ui.chipHtml({ tone: 'info', label: 'Synced' }) });
    assert(out.startsWith('<header class="gs-pagehead">') && out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Raids</h1>') && out.includes('gs-schip-info'));
    assert(out.includes('<p class="gs-sub gs-pagehead-context">Main team - weekly slot Wed 8:00 PM ET - 2 upcoming, 14 past</p>'));
    assert(out.includes('<span class="gs-menu-text">More</span>') && out.includes('gs-menu-dots') && out.includes('has-phone-icon') && out.includes('aria-label="More"'));
    assert(out.indexOf('gs-menu-wrap') < out.indexOf('gs-btn-molten') && count(out, /gs-btn-molten/g) === 1);
    assert(ui.pageHeadHtml({ title: 'Raid', back: { href: '#/g/g1/raids', label: 'Raids' } }).includes('<a class="gs-back-link" href="#/g/g1/raids">'));
    assert(!ui.pageHeadHtml({ title: 'Home' }).includes('gs-pagehead-actions'));
    assert(ui.pageHeadHtml({ title: HOSTILE, context: HOSTILE }).indexOf('<img') < 0);
    assertNoRawAttrs(out);
  });

  await check('T1 list page: head, the segment / filter bar that stays when the table is empty, the table, the footer line', () => {
    const out = ui.listPageHtml({ head: { title: 'Raids', context: '2 upcoming' }, barHtml: ui.segmentsHtml({ label: 'Show raids', items: [{ key: 'upcoming', label: 'Upcoming' }, { key: 'past', label: 'Past' }], selected: 'upcoming', action: 'raids-tab' }),
      bodyHtml: ui.emptyStateHtml({ kind: 'first', title: 'No past raids yet' }), footHtml: '3 upcoming raids.' });
    assert(out.startsWith('<div class="gs-page gs-list-page"><header class="gs-pagehead">') && out.includes('<div class="gs-listbar">') && out.includes('aria-live="polite">') && out.includes('<p class="gs-listfoot">3 upcoming raids.</p>'));
    assert(out.indexOf('gs-listbar') < out.indexOf('gs-empty2'));
    assert(!ui.listPageHtml({ head: { title: 'X' } }).includes('gs-listbar'));
  });

  await check('T2 object page: head (no primary), the next-step bar with the one primary, the You line, then the sections in order; a locked section says when it opens', () => {
    const out = ui.objectPageHtml({
      head: { title: 'Wed Oct 21 - Gruul\'s Lair', context: 'Main team - 8:00 PM ET', more: { id: 'raid-more', items: [{ label: 'Open in Planner', href: '#/planner' }] } },
      nextStep: { title: 'Plan this raid', text: 'x', primary: { label: 'Plan in Planner' } }, youHtml: 'You are in <strong>Group 2</strong> as Enhancement Shaman.',
      sections: [{ id: 's-signups', title: 'Sign-ups', chipHtml: ui.chipHtml({ tone: 'success', label: 'Open' }), bodyHtml: '<p>list</p>' }, { id: 's-plan', title: 'Plan and line-up', bodyHtml: '<p>plan</p>' }, { id: 's-log', title: 'After the raid', locked: 'Opens when the raid starts.' }],
    });
    assert(out.indexOf('gs-pagehead') < out.indexOf('gs-nextstep') && !out.includes('gs-stages') && out.indexOf('gs-nextstep') < out.indexOf('gs-youline') && out.indexOf('gs-youline') < out.indexOf('<section class="gs-osection'));
    assert.equal(count(out, /gs-btn-molten/g), 1, 'one primary on the page, and it is in the next-step bar');
    assert(out.indexOf('gs-btn-molten') > out.indexOf('gs-nextstep'));
    assert(out.includes('<section class="gs-osection" id="s-signups" tabindex="-1" aria-labelledby="s-signups-h">') && out.includes('<section class="gs-osection is-locked" id="s-log"') && out.includes('Opens when the raid starts.'));
    assert(out.includes('id="s-plan"'));
    assert(!('stageStripHtml' in ui) && !('STAGES' in ui) && !('normalizeStages' in ui), 'the stage strip helpers are gone');
    assert(typeof G.handlers.click.jump === 'function' && G.handlers.change['jump-select'] === undefined, 'the jump link stays, the phone select left with the strip');
    assertNoRawAttrs(out);
  });

  await check('T3 settings: five-group list beside a 760 detail; the active page is aria-current; on a phone one pane shows with a Back link; the head carries the save status and the bar sits below', () => {
    const groups = [{ label: 'Guild', items: [{ key: 'general', label: 'General', href: '#/g/g1/settings/general', isNew: true }, { key: 'teams', label: 'Teams', href: '#/g/g1/settings/teams' }] }, { label: 'People and access', items: [{ key: 'people', label: 'Accounts', href: '#/g/g1/settings/people' }] }];
    const detail = ui.settingsPageHtml({ groups, activeKey: 'general', view: 'detail', listHref: '#/g/g1/settings', title: 'General', purpose: 'The basics of the guild.', savedHtml: ui.savedStatusHtml('Saved at 8:14 PM ET'), bodyHtml: '<p>fields</p>', saveBarHtml: ui.saveBarHtml() });
    assert(detail.startsWith('<div class="gs-page gs-settings-page gs-forge is-view-detail">') && detail.includes('<nav class="gs-slist" aria-label="Guild settings sections">'));
    assert(detail.includes('<h2 class="gs-sgroup-h" id="sg-0">Guild</h2>') && detail.includes('<h2 class="gs-sgroup-h" id="sg-1">People and access</h2>'));
    assert(detail.includes('class="gs-sitem is-active" href="#/g/g1/settings/general" aria-current="page">General<span class="gs-nbadge">New</span>'));
    assert.equal(count(detail, /aria-current="page"/g), 1);
    assert(detail.includes('<a class="gs-back-link gs-sback" href="#/g/g1/settings">') && detail.includes('<h2 class="gs-h1 gs-sdetail-h" id="settings-title" tabindex="-1">General</h2>') && detail.includes('Saved at 8:14 PM ET'));
    assert(detail.indexOf('gs-sdetail-body') < detail.indexOf('gs-savebar'));
    assert(ui.settingsPageHtml({ groups, view: 'list', title: 'x' }).includes('is-view-list'));
    assert(!ui.settingsPageHtml({ groups, title: 'x' }).includes('gs-sback'), 'no Back link without a list address');
  });

  await check('T4 home: Needs attention first with a gold count and one secondary button per row; with nothing it is one good-news line; cards follow', () => {
    const busy = ui.homePageHtml({ head: { title: 'Home' }, attention: { items: [{ tone: 'warning', title: '3 attendance flags to review', text: 'Wed Oct 14, Tempest Keep: The Eye.', action: { label: 'Review flags', href: '#/g/g1/attendance/review' } }, { tone: 'info', title: '1 new application', action: { label: 'Review application' } }] }, cards: [{ id: 'next-raid', title: 'Next raid', bodyHtml: '<p>x</p>' }] });
    assert(busy.includes('<h2 class="gs-h2" id="attn-h">Needs attention</h2>') && busy.includes('gs-cbadge') && busy.includes('2 items need attention') && count(busy, /gs-attn2-item/g) === 2);
    assert(count(busy, /gs-btn-molten/g) === 0 && busy.includes('>Review flags<'), 'attention rows are secondary buttons');
    assert(busy.indexOf('gs-attn2') < busy.indexOf('gs-hcard') && busy.includes('<section class="gs-hcard" id="next-raid" aria-labelledby="next-raid-h">'));
    const none = ui.homePageHtml({ head: { title: 'Home' }, attention: { items: [], goodText: 'Nothing needs you.' }, cards: [] });
    assert(none.includes('gs-empty-good') && none.includes('Nothing needs you.') && !none.includes('gs-attn2-list'));
    assert(!ui.homePageHtml({ head: { title: 'Home' } }).includes('gs-attn2'));
  });

  await check('T5 flow: a stepper names the steps, the preview, and the sticky commit bar says how many and that nothing is saved yet (Back, Cancel, one primary)', () => {
    const stepper = ui.stepperHtml({ steps: ['Source', 'Preview', 'Import'], current: 2, label: 'Import steps' });
    assert(stepper.startsWith('<ol class="gs-stepper" aria-label="Import steps">') && count(stepper, /aria-current="step"/g) === 1);
    assert(stepper.includes('<li class="gs-step is-done"') && stepper.includes('<li class="gs-step is-current" aria-current="step">') && stepper.includes('<li class="gs-step is-later"'));
    assert(ui.stepperHtml({ current: 4 }).split('is-done').length - 1 === 3, 'past the last step all are done');
    const bar = ui.commitBarHtml({ text: '23 of 24 will be imported.', back: { label: 'Back', attrs: { 'data-action': 'imp-back' } }, cancel: { label: 'Cancel' }, commit: { label: 'Import 23 people', type: 'submit' } });
    assert(bar.startsWith('<div class="gs-commitbar" role="region" aria-label="Import">') && bar.includes('<strong>23 of 24 will be imported.</strong> <span class="gs-fine">Nothing is saved yet.</span>'));
    assert(bar.indexOf('>Back<') < bar.indexOf('>Cancel<') && bar.indexOf('>Cancel<') < bar.indexOf('Import 23 people') && count(bar, /gs-btn-molten/g) === 1);
    const page = ui.flowPageHtml({ head: { title: 'Import from Raid-Helper' }, steps: ['Source', 'Preview', 'Import'], current: 2, bodyHtml: '<p>rows</p>', commitBarHtml: bar });
    assert(page.indexOf('gs-stepper') < page.indexOf('gs-flowbody') && page.indexOf('gs-flowbody') < page.indexOf('gs-commitbar'));
    assert.deepEqual(plain(ui.TEMPLATES), ['list', 'object', 'settings', 'home', 'flow']);
    assertNoRawAttrs(page);
  });

  await check('templates: every gs- class the kit and templates write has a rule in guild.css', () => {
    const files = ['js/guild/ui-kit.js', 'js/guild/ui-templates.js'].map(read).join('\n');
    const used = new Set();
    for (const m of files.matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/^gs-[a-z0-9_-]+$/.test(c)) used.add(c);
    for (const m of files.matchAll(/'(gs-[a-z0-9_-]+)(?: [^']*)?'/g)) used.add(m[1]);
    for (const m of files.matchAll(/(?:class="|')(gs-[a-z0-9-]+-)'?\s*\+/g)) used.delete(m[1]); // a prefix that is completed at run time (gs-schip-<tone>, ...)
    const defined = new Set([...css.matchAll(/\.(gs-[a-z0-9_-]+)/g)].map(m => m[1]));
    assert.deepEqual([...used].filter(c => !defined.has(c)), [], 'classes with no CSS');
    for (const c of ['gs-schip-success', 'gs-banner-warning', 'gs-dialog-confirm', 'gs-dialog-destructive', 'gs-settings-page', 'gs-hcard']) assert(defined.has(c), c);
    assert(!/[^\x00-\x7f]/.test(files.replace(/[\u2500-\u257f]/g, '')), 'ASCII (WoW fonts and the boards: no Unicode in copy)');
  });

  // ═══ 10. The shell: skip link and the Help fold ═══
  const ME = { user: { id: 'u1', username: 'a', displayName: 'A', prefs: {} }, guilds: [{ id: 'g1', name: 'Ravens' }], create: { allowed: false } };
  const OFFICER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'roster.edit': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild' };
  const GD = { guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm' }, teams: [{ id: 't1', name: 'Main', size: 25, archived: false }], me: { roles: [{ role: 'officer' }], can: OFFICER_CAN } };
  await check('skip link: the first tab stop of every page - in the three static skeletons, in shell.render, sent to the visible main area without touching the hash', () => {
    for (const f of ['index.html', 'faq.html', 'whats-new.html']) {
      const html = read(f);
      const root = html.indexOf('<div id="guild-root" class="gs-app">');
      assert(root > 0, f);
      assert(html.slice(root).replace('<div id="guild-root" class="gs-app">', '').trimStart().startsWith('<a class="gs-skip" href="#gs-main" data-skip-link>Skip to content</a>'), f + ': the skip link is the first thing in the page');
    }
    const out = G.shell.render({ section: 'guild', page: 'app', me: ME, route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: GD, teamId: 't1' }, '<p>x</p>');
    assert(out.startsWith('<a class="gs-skip" href="#gs-main" data-skip-link>Skip to content</a>'));
    assert.equal(G.shell.SKIP_LINK_HTML, '<a class="gs-skip" href="#gs-main" data-skip-link>Skip to content</a>');
    const app = read('js/guild/app.js');
    assert(app.includes("t.closest('a[data-skip-link]') && isPlainClick(ev)") && app.includes('function focusMain()'));
  });

  await check('Help fold: one Help item (separated, last) holds What\'s new, Future enhancements, How it works and FAQ; closed unless one of them is current; ids differ between sidebar and drawer', () => {
    const base = { section: 'guild', page: 'app', me: ME, route: { name: 'section', gid: 'g1', section: 'roster' }, guildData: GD, teamId: 't1' };
    const items = G.shell.sidebarItems(base);
    const help = items[items.length - 1];
    assert.deepEqual(plain([help.key, help.label, help.separated]), ['help', 'Help', true]);
    assert.deepEqual(plain(help.children.map(c => c.key)), ['whats-new', 'roadmap', 'how-it-works', 'faq']);
    assert.equal(items.filter(i => ['whats-new', 'roadmap', 'how-it-works', 'faq'].includes(i.key)).length, 0, 'none of the four is a top-level item any more');
    const slots = G.shell.slots(base);
    assert(slots.sidebar.includes('<button type="button" class="gs-nav-link gs-nav-foldbtn" data-action="help-toggle" data-fold="help" data-key="help-toggle-side" aria-expanded="false" aria-controls="nav-fold-help-side" aria-label="Help">'));
    assert(slots.sidebar.includes('<ul class="gs-nav-sub" id="nav-fold-help-side" hidden>'));
    assert(slots.drawer.includes('aria-controls="nav-fold-help-drawer"') && slots.drawer.includes('id="nav-fold-help-drawer"'));
    for (const href of ['/whats-new.html', '#/roadmap', '#how-it-works', '/faq.html']) assert(slots.sidebar.includes('href="' + href + '"'), href);
    assert.equal(count(slots.sidebar, /class="gs-nav-link is-active"/g), 1, 'only Roster is current');
    // Open on a Help page.
    const faq = G.shell.slots({ section: 'page', page: 'faq', me: ME, route: null, guildData: GD, teamId: 't1' }).sidebar;
    assert(faq.includes('aria-expanded="true"') && !faq.includes('id="nav-fold-help-side" hidden') && faq.includes('class="gs-nav-link is-active" href="/faq.html" aria-label="FAQ" aria-current="page"'));
    const road = G.shell.slots(Object.assign({}, base, { route: { name: 'roadmap' } })).sidebar;
    assert(road.includes('aria-expanded="true"') && road.includes('class="gs-nav-fold is-open"'));
    // What's new unseen: the Help item carries the neutral NEW mark, and so does the page inside it.
    const unseen = G.shell.slots(Object.assign({}, base, { whatsNewUnseen: true })).sidebar;
    assert(unseen.includes('aria-label="Help, new"') && count(unseen, /gs-new-pill/g) === 2);
    assert(!G.shell.slots(base).sidebar.includes('gs-new-pill'));
    // Signed out: Planner, then the one Help item.
    assert.deepEqual(plain(G.shell.sidebarItems({ section: 'planner', page: 'app', me: null }).map(i => i.key)), ['planner', 'help']);
  });

  await check('Help fold: the toggle shows or hides the list and keeps aria-expanded in step', () => {
    const list = { hidden: true };
    const calls = [];
    const btn = { getAttribute: k => (k === 'aria-controls' ? 'nav-fold-help-side' : null), setAttribute: (k, v) => calls.push([k, v]) };
    ctx.document.getElementById = id => (id === 'nav-fold-help-side' ? list : null);
    // app.js registers help-toggle on load, but needs #guild-root to start; the handler is exercised through a fresh load with the element in place.
    const sandbox = loadGuild({ document: { getElementById: id => (id === 'nav-fold-help-side' ? list : null), querySelector: () => null, querySelectorAll: () => [] } });
    const fn = sandbox.Guild.handlers.click['help-toggle'];
    assert.equal(typeof fn, 'function');
    fn(btn);
    assert.deepEqual([list.hidden, calls[0]], [false, ['aria-expanded', 'true']]);
    fn(btn);
    assert.deepEqual([list.hidden, calls[1]], [true, ['aria-expanded', 'false']]);
    ctx.document.getElementById = () => null;
  });

  await check('Help fold: the CSS styles the fold, the sub list and the collapsed rail', () => {
    for (const sel of ['.gs-nav-foldbtn', '.gs-nav-sub', '.gs-nav-sub[hidden]', '.gs-nav-fold.is-open > .gs-nav-foldbtn', '.is-collapsed .gs-sidebar .gs-nav-sub .gs-nav-link']) assert(css.includes(sel), sel);
  });

  // ═══ 11. The glossary (decision 2, D1-D8) ═══
  const sources = fs.readdirSync(path.join(ROOT, 'js/guild')).filter(f => f.endsWith('.js') && f !== 'roadmap-data.js').map(f => ['js/guild/' + f, read('js/guild/' + f)])
    .concat(fs.readdirSync(path.join(ROOT, 'worker')).filter(f => f.endsWith('.js')).map(f => ['worker/' + f, read('worker/' + f)]))
    .concat(fs.readdirSync(path.join(ROOT, 'worker/routes')).filter(f => f.endsWith('.js')).map(f => ['worker/routes/' + f, read('worker/routes/' + f)]));
  const code = text => text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\s\/\/ [^'"\n]*$/gm, '');
  await check('glossary: the retired words are gone from the screens, posts and sentences - Publish roster, Your seat, Can\'t make it, Loot board, Plan actions, Actions menu, People and roles', () => {
    const retired = [/Publish roster/, /Re-publish roster/, /Your seat/, /Can\\?'t make it/, /can\\?'t make it/, /cannot make it/, /Loot board/, /Plan actions/, /label: 'Actions'/, /People and roles/, /Roster published/, /published roster/i,
      /label: 'Intent'/, /Rostered /, /rostered people/, /Open an intent round/, /No intent round yet/];
    const hits = [];
    for (const [file, text] of sources) for (const re of retired) if (re.test(code(text))) hits.push(file + ' ' + re);
    assert.deepEqual(hits, []);
  });

  await check('glossary: the words that replace them are in place - Line-up, Loot prios, Loot awards, Can\'t come, Spec poll, Recruiting needs, Accounts, More, Plan settings, Group', () => {
    const all = Object.fromEntries(sources);
    assert(all['js/guild/pages-raid-roster.js'].includes('Publish line-up') && all['js/guild/pages-raid-roster.js'].includes('>Line-up</h2>') && all['js/guild/pages-raid-you.js'].includes("'Group '"));
    assert(all['js/guild/pages-raid-roster.js'].includes('Can\\\'t come'));
    assert(all['js/guild/pages-raid-board.js'].includes('Loot prios') && all['js/guild/pages-raid-loot.js'].includes('">Loot</h2>'));
    assert(all['js/guild/pages-roster-tabs.js'].includes("intent: 'Spec poll'") && all['js/guild/pages-roster-tabs.js'].includes("recruiting: 'Recruiting'"));
    assert(all['js/guild/shell.js'].includes("label: 'Spec poll'") && all['js/guild/shell.js'].includes("label: 'Recruiting'") && all['js/guild/shell.js'].includes("label: 'Users'"));
    assert(all['js/guild/pages-raid.js'].includes("label: 'More', key: 'raid-actions'") && all['js/guild/pages-raid-facts.js'].includes("changeMenu('plan', 'Plan settings'"));
    assert(all['js/guild/pages-raid-signups.js'].includes("absence: 'Can\\'t come'"));
    assert(all['worker/notify.js'].includes('Line-up published:') && all['worker/notify.js'].includes('Please confirm your group, or say you can\'t come.'));
    assert(all['worker/audit-view.js'].includes('Published the line-up of') && all['worker/audit-view.js'].includes("can't come to ${onRaid(ent)}") && all['worker/audit-view.js'].includes('Opened a spec poll for'));
    assert(all['worker/routes/roster-publish.js'].includes('its line-up is frozen') && all['worker/routes/roster-publish.js'].includes('You are not in this line-up.'));
    // Route names, ids and data keys did not change.
    assert(read('js/guild/router.js').includes("ROSTER_TABS = ['intent', 'recruiting', 'applications', 'launch']"));
    assert(all['js/guild/pages-raid.js'].includes("id: 'raid-actions'") && all['js/guild/pages-raid-roster.js'].includes("data-action=\"roster-publish\""));
    assert(!all['js/guild/shell.js'].includes("{ tab: 'people'") && read('js/guild/router.js').includes("RETIRED_TAB = 'people'"), 'Settings > Accounts is retired into Users; its address still resolves');
  });

  // ═══ 12. Dead ends (F10) ═══
  await check('dead ends: an away notice\'s To starts as From and follows it; the empty-To message says what to do', () => {
    const away = read('js/guild/pages-away.js');
    assert(away.includes("esc(n ? (n.to || '') : (repeat === 'range' ? from : ''))"), 'Add: To starts as From for a range');
    assert(away.includes("data-change=\"away-from-change\"") && away.includes("G.handlers.change['away-from-change']"));
    assert(away.includes("text: 'Add a To date, or choose Every week on one day.'") && !away.includes('Pick the last day'));
    // The behaviour, on a fake form.
    const sandbox = loadGuild();
    const fn = sandbox.Guild.handlers.change['away-from-change'];
    const form = { elements: { from: { value: '2026-10-30' }, to: { value: '' }, repeat: { value: 'range' } } };
    fn({ closest: () => form });
    assert.equal(form.elements.to.value, '2026-10-30', 'an empty To follows From');
    form.elements.to.value = '2026-11-02';
    form.elements.from.value = '2026-10-31'; fn({ closest: () => form });
    assert.equal(form.elements.to.value, '2026-11-02', 'a To after From is left alone');
    form.elements.from.value = '2026-11-05'; fn({ closest: () => form });
    assert.equal(form.elements.to.value, '2026-11-05', 'From moved past To: To follows');
    form.elements.repeat.value = 'weekly'; form.elements.to.value = ''; form.elements.from.value = '2026-11-12'; fn({ closest: () => form });
    assert.equal(form.elements.to.value, '', 'a weekly notice\'s Until stays empty');
  });

  await check('dead ends: a failed New raid create offers "Back to the form" beside Import anyway; Back keeps what was typed', () => {
    const raids = read('js/guild/pages-raids.js');
    assert(raids.includes("runLinesHtml(gid, run, null, 'nr-back')") && raids.includes('Back to the form') && raids.includes("G.handlers.click['nr-back']"));
    // The page through the real renderer: a create that failed on the other-server check.
    const gd = { guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm' }, teams: [{ id: 't1', name: 'Main', size: 25, archived: false }], me: { roles: [{ role: 'officer' }], can: { 'raids.edit': 'guild' } } };
    const form = { teamId: 't1', event: '1483258698854826006', date: '', plan: '', time: '20:00', zone: '', title: '', size: '', reports: [''], mode: 'log' };
    const failed = { gid: 'g1', form, running: false, raidId: null, lines: [{ id: 'raid', label: 'Create the raid from the Raid-Helper event', status: 'error', message: 'That event was posted in a different Discord server.', accept: 'Import anyway' }] };
    const out = G.pages.raidNew.raidNewHtml({ guildData: gd, state: { gid: 'g1', form, run: failed, error: '' }, today: '2026-10-18' });
    assert(out.includes('data-action="nr-back" data-key="nr-back">Back to the form</button>') && out.includes('>Import anyway</button>'));
    assert(out.indexOf('Back to the form') < out.indexOf('Import anyway'), 'Back leads, then the confirm');
    assert(!out.includes('Open raid'), 'nothing was created');
    // Once the raid exists a later failure (the plan) does not offer to go back and create it again.
    const made = { gid: 'g1', form, running: false, raidId: 'r_1', lines: [{ id: 'raid', label: 'Create the raid', status: 'ok' }, { id: 'plan', label: 'Raidsmith plan', status: 'error', message: 'x' }] };
    assert(!G.pages.raidNew.raidNewHtml({ guildData: gd, state: { gid: 'g1', form, run: made, error: '' }, today: '2026-10-18' }).includes('Back to the form'));
    // The handler drops the run and keeps the typed form.
    const state = { gid: 'g1', form, run: failed, error: 'old' };
    const renders = [];
    ctx.Guild.app = { render() { renders.push(1); }, state: {} };
    G.pages.attendance.attState().nr = state;
    G.handlers.click['nr-back']();
    assert.deepEqual([state.run, state.error, state.form.event, renders.length], [null, '', '1483258698854826006', 1]);
  });

  await check('dead ends: the Link-event dialog closes when the Move prompt opens (no stacking), and Cancel leaves "Not linked" on the page', () => {
    const raid = read('js/guild/pages-raid.js');
    assert(raid.includes("'Not linked. The event is on another day than the raid, and the raid was not moved.'"));
    assert(raid.includes('function dialogStillOpen(form)') && raid.includes('if (!dialogStillOpen(form)) { pageError(err); return; }'));
    assert(raid.includes('if (notLinked) { a().note = notLinked;'));
    // The Move prompt goes through ui.openDialog, which replaces the open link dialog.
    assert(/function confirmMove[\s\S]*?G\.ui\.openDialog\(moveDialogHtml\(err\)/.test(read('js/guild/pages-raids.js')));
  });

  await check('dead ends: the Raid-Helper preview says "than the <guild> server", not "than <guild>\'s"', () => {
    const imp = read('js/guild/pages-import.js');
    assert(imp.includes("different Discord server than the ' + esc(gd.guild.name) + ' server.</div>'"));
    assert(!/than ' \+ esc\(gd\.guild\.name\) \+ '\\'s/.test(imp));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
