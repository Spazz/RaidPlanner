/**
 * Raidsmith guild UI - design framework Wave 3 (person pages, Away / My characters / Linked accounts, the read-only and reading pages, the message cards)
 *   9.  Person pages on T2: the roster record, the attendance history and the loot history share one object header (name, You, status, Main and Alts) and the
 *       same sections; the viewer's own page leads with a You line (who can see it) and puts attendance and loot first; notes are permission-gated; the details
 *       form has one Save bar; the trial review is a section with one primary.
 *   10. Away notices (T1 + a form dialog), My characters (T1: somebody already on the roster is told what Battle.net adds, never to connect it to see it) and
 *       Linked accounts (a T3 form page with the Save bar; no stray orange).
 *   11. The guest view and the public page (T1/T4 with a Read-only chip and the guild's zone on every time), the application form and the guest sign-up (T3 form
 *       pages with inline validation; the sign-up writes the raid's start in the GUILD's zone), Privacy and the roadmap (reading pages).
 *   12. Sign-in, no guild, create guild: the kit's buttons, one primary per card; the skip link is on every host page.
 *   Plus the sweep over all guild pages: one overflow label, no stray orange, no text under 12 px, every time with a zone, no "raid night(s)".
 * Run: node tests/guild/guild-fw3-ui-tests.js
 *
 * Same approach as guild-fw2-ui-tests.js: the guild scripts load in a vm with no DOM and the pages return HTML strings. guild-fw3-worker-tests.js pins the Worker side
 * (the guild's zone in the join / guest / public answers, onRoster on GET /auth/bnet, isMe and class on the person loot answer).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('../guild-scripts');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(e && e.stack || e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const css = (read('planner-forge.css') + '\n' + read('guild.css'));
function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const els = {};
ctx.document = { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
ctx.window = { location: { origin: 'https://raidsmith.test', hash: '' } };
const G = ctx.Guild;
const S = G.app.state;
const count = (s, re) => (s.match(re) || []).length;
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');
const ids = html => [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const withoutSaveBar = html => html.replace(/<div class="gs-savebar"[\s\S]*?<\/div><\/div>/g, '');
const molten = html => count(withoutSaveBar(html), /gs-btn-molten/g);

// ── fixtures ─────────────────────────────────────────────────────
const OFFICER_CAN = { 'roster.view': 'guild', 'roster.edit': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild', 'loot.view': 'guild', 'loot.edit': 'guild' };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'], 'loot.view': ['t1'], 'signups.self': ['t1'] };
const TEAM = (id, name) => ({ id, name, size: 25, archived: false, players: 3, leads: [] });
function gd(can, over) {
  const o = over || {};
  return {
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/New_York', gameVersion: 'tbc', realmKind: 'realm', realmSlug: 'firemaw', createdAt: 1 },
    teams: o.teams || [TEAM('t1', 'Main team')],
    me: Object.assign({ roles: [{ role: can === MEMBER_CAN ? 'member' : 'officer' }], can, personId: null }, o.me || {}),
    attendanceFlags: {}, rosterFlags: {},
    rosterOptions: { classes: [] },
  };
}
const CHAR = (id, name, cls, main, extra) => Object.assign({ id, name, class: cls, mainSpec: main ? 'Enhancement' : 'Fire', offSpec: main ? 'Restoration' : null, role: 'dps', isMain: !!main, realm: null, team: { id: 't1', name: 'Main team', archived: false } }, extra || {});
const ALL_CAN = { edit: true, notesView: true, notesEdit: true, delete: true, addCharacter: true };
const NO_CAN = { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false };
const RECORD = (over, can, extra) => Object.assign({
  today: '2026-10-17', can: Object.assign({}, ALL_CAN, can || {}),
  person: Object.assign({ id: 'p_x', status: 'raider', joinedOn: '2026-09-01', trialStart: null, trialEnd: null, trialFlag: null, isMe: false, version: 3, leftReason: null, leftOn: null,
    discord: { signIn: 'signed_in', user: { id: 'u_1', username: 'thoren', displayName: 'Thoren' }, nickname: null }, account: null }, over || {}),
  characters: [CHAR('c1', 'Thoren', 'SHAMAN', true), CHAR('c2', 'Thorenalt', 'MAGE', false)],
  notes: { text: 'Reliable', version: 1, updatedBy: { displayName: 'Alice' }, updatedAt: Date.UTC(2026, 9, 15, 1, 14) },
}, extra || {});
const page = (record, can, extra) => G.pages.person.personHtml(Object.assign({ guildData: gd(can || OFFICER_CAN), record, linkable: [], alert: '', attendance: null, trial: null, away: null }, extra || {}));
// The record's sections: its panels (gs-hd-panel gs-pr-panel), the Trial review's bare jump target, and the other pages' gs-osection sections; person-cols is the grid around them.
const sectionIds = html => [...html.matchAll(/<(?:section|div) class="(?:gs-osection[^"]*|gs-hd-panel gs-pr-panel)" id="([a-z0-9-]+)"|<div class="gs-osection-bare" id="([a-z0-9-]+)"/g)].map(m => m[1] || m[2]).filter(id => id !== 'person-cols');

const ATT = { person: { id: 'p_x', name: 'Thoren', class: 'SHAMAN', status: 'raider', isMe: true }, teams: [{ team: { id: 't1', name: 'Main team' }, window: 8, metrics: { pct: 90, pctAll: 88, signupRate: 95 },
  cells: [{ raid: { id: 'r1', raidOn: '2026-10-10', zone: 'Gruul' }, outcome: 'present', credit: 1 }, { raid: { id: 'r2', raidOn: '2026-10-03', zone: 'Gruul' }, outcome: 'absent', credit: 0 }] }] };
const LOOT = { person: { id: 'p_x', name: 'Thoren', class: 'SHAMAN', status: 'raider', isMe: true }, totals: { MS: 1, OS: 0, DE: 0, BANK: 0 },
  awards: [{ id: 'a1', raidId: 'r1', raidOn: '2026-10-10', itemId: 1, itemName: 'Blade', quality: 4, tag: 'MS', winner: 'Thoren', awardedAt: Date.UTC(2026, 9, 11, 1, 0), match: { kind: 'character', personId: 'p_x', isMain: true } }] };

(async () => {
  // ═══ 9. Person pages on T2 ═══
  await check('9. the roster record is a T2 object page: header with Main and Alts and the status chip, no stage strip, sections in a fixed order', () => {
    const out = page(RECORD());
    assert(out.includes('gs-object-page') && out.includes('<h1 class="gs-h1 gs-class-shaman" id="page-title" tabindex="-1">Thoren</h1>'));
    assert(!out.includes('gs-stages') && !out.includes('gs-nextstep'), 'a person has no stage strip');
    const head = out.slice(out.indexOf('<header class="gs-pagehead">'), out.indexOf('</header>'));
    assert(!head.includes('gs-hd-chip') && head.includes('class="gs-spec-icon"') && head.includes('href="#/g/g1/roster"') && head.includes('>Roster<'), 'a Raider has no chip; the spec icon and the way back');
    const t = stripTags(head);
    assert(t.includes('Shaman - Enhancement / Restoration') && t.includes('Alt: Thorenalt') && t.includes('Joined Sep 1, 2026') && !t.includes('Discord'), t);
    assert.deepEqual(sectionIds(out), ['attendance', 'characters', 'details', 'notes']);
    assert(out.indexOf('id="attendance"') < out.indexOf('id="characters"') && out.indexOf('id="characters"') < out.indexOf('id="details"'));
    assert(out.includes('class="gs-pr-cols"') && out.indexOf('class="gs-pr-left"') < out.indexOf('id="attendance"') && out.indexOf('class="gs-pr-right"') > out.indexOf('id="characters"') && out.indexOf('class="gs-pr-right"') < out.indexOf('id="details"'), 'history left, Details and notes right');
    assert(!out.includes('gs-youline'), 'somebody else\'s page has no You line');
  });

  await check('9. the header lists up to four Alts and counts the rest; a person with no Alts says so', () => {
    const many = RECORD({}, null, { characters: [CHAR('c1', 'Thoren', 'SHAMAN', true)].concat([2, 3, 4, 5, 6, 7].map(n => CHAR('c' + n, 'Alt' + n, 'MAGE', false))) });
    const t = stripTags(page(many)).replace(/ ,/g, ',');
    assert(t.includes('Alts: Alt2, Alt3, Alt4, Alt5 and 2 more'), t);
    assert(stripTags(page(RECORD({}, null, { characters: [CHAR('c1', 'Thoren', 'SHAMAN', true)] }))).includes('No alts'));
    assert.equal(G.pages.person.altsOf(many).length, 6);
  });

  await check('9. your own page: the You line says whose it is and who can see it, links to Away notices, and attendance and loot come before Characters', () => {
    const rec = RECORD({ isMe: true }, NO_CAN, { notes: null });
    const out = page(rec, MEMBER_CAN, { attendance: { data: ATT, denied: false } });
    assert(out.includes('<div class="gs-youline">') && out.includes('<span class="gs-youline-label">You</span>') && out.includes('This is your own record.'));
    assert(stripTags(out).includes('Who can see this page: everyone in the guild sees your name, characters and status.') && out.includes(G.pages.person.OWN_SEES.slice(0, 40)));
    assert(out.includes('Officers keep your status and characters up to date.'), 'a member is told who keeps the record');
    assert(/<a class="gs-btn" href="#\/g1\/away"|href="#\/g\/g1\/away"/.test(out) && out.includes('data-key="you-away"') && out.includes('>Away notices<'));
    assert(out.includes('<span class="gs-hd-chip is-grey">You</span>'), 'You beside the name (the one chip)');
    assert(out.includes('id="you-sees" hidden') && out.includes('data-action="you-sees-toggle"'), 'who can see the page is a disclosure');
    assert.deepEqual(sectionIds(out), ['attendance', 'characters', 'details'].filter(id => id !== 'details' || out.includes('id="details"')));
    assert(out.indexOf('id="attendance"') < out.indexOf('id="characters"'), 'what a member comes for comes first');
    // An officer on their own page gets the You line too, without the member sentence.
    const mine = page(RECORD({ isMe: true }));
    assert(mine.includes('This is your own record.') && !mine.includes('Officers keep your status'));
  });

  await check('9. a member\'s record is read-only: dates as a list, no forms, no Save bar, no Delete, no notes unless the Worker sent them', () => {
    const out = page(RECORD({ isMe: false }, NO_CAN, { notes: null }), MEMBER_CAN);
    assert(out.includes('id="details"') && stripTags(out).includes('Joined Sep 1, 2026') && !out.includes('data-action="person-edit-open"'));
    assert(!out.includes('person-details-form') && !out.includes('data-savebar') && !out.includes('person-delete') && !out.includes('id="notes"'));
    assert(!out.includes('data-action="char-edit"') && !out.includes('data-action="char-add"'));
  });

  await check('9. notes are permission-gated: absent without the Worker\'s notes, read-only with a reason without notesEdit, a form with Save note with it', () => {
    assert(!page(RECORD({}, null, { notes: null })).includes('id="notes"'));
    const ro = page(RECORD({}, { notesEdit: false }));
    assert(ro.includes('id="notes"') && ro.includes('Reliable') && !/<textarea/.test(ro) && !ro.includes('person-notes-edit') && !ro.includes('Save note'), 'read-only text and no Edit without notes.edit');
    S.currentGid = 'g1'; S.guilds.g1 = gd(OFFICER_CAN);
    const rd = page(RECORD());
    assert(rd.includes('data-action="person-notes-edit"') && !/<textarea/.test(rd), 'read-only text with Edit until Edit is pressed');
    assert(stripTags(rd).includes('Edited by Alice, Wed Oct 14, 9:14 PM ET'), 'the edit time carries the guild zone: ' + stripTags(rd).match(/Edited[^.]*/));
    G.pages.person.setEditing('g1', 'p_x', 'notes', true);
    const rw = page(RECORD());
    G.pages.person.setEditing('g1', 'p_x', 'notes', false);
    assert(rw.includes('data-submit="person-notes-form"') && rw.includes('<span>Save note</span>') && /<textarea/.test(rw));
  });

  await check('9. the details form has one Save bar for its fields (Save details), and "Saved at 8:14 PM ET" in the guild zone after a save', () => {
    const out = page(RECORD(), null, { saved: { gid: 'g1', pid: 'p_x', ms: Date.UTC(2026, 9, 17, 0, 14) } });
    assert(!out.includes('<form class="gs-details-form'), 'read-only until Edit');
    G.pages.person.setEditing('g1', 'p_x', 'details', true);
    const edit = page(RECORD());
    G.pages.person.setEditing('g1', 'p_x', 'details', false);
    const form = edit.slice(edit.indexOf('<form class="gs-details-form'), edit.indexOf('</form>', edit.indexOf('<form class="gs-details-form')));
    assert(form.includes('data-dirty-form') && form.includes('data-input="dirty-form"') && form.includes('data-savebar') && /<div class="gs-savebar"[^>]* hidden>/.test(form), 'the bar is in the form and starts hidden');
    assert(form.includes('<span>Save details</span>') && form.includes('<span>Discard</span>') && !form.includes('Save changes'));
    for (const name of ['status', 'joinedOn', 'trialStart', 'trialEnd']) assert(form.includes('name="' + name + '"'), name);
    assert(!form.includes('linkUserId'), 'the Account is one row, not a select');
    assert(out.includes('data-saved-status') && stripTags(out).includes('Saved at 8:14 PM ET'));
    assert(!page(RECORD()).includes('Saved at'), 'nothing before a save');
    assert(count(form, /gs-field-error/g) >= 5, 'every field has its message slot for inline validation');
  });

  await check('9. the trial review is a section with the trial chip and one primary (Promote); the trial bar stays text; the page has one primary besides the hidden Save bar', () => {
    const rec = RECORD({ status: 'trial', trialStart: '2026-10-03', trialEnd: '2026-10-20', trialFlag: { kind: 'ends', days: 3 } });
    const trial = { gid: 'g1', pid: 'p_x', error: '', data: { today: '2026-10-17', person: { id: 'p_x', name: 'Thoren', status: 'trial' }, since: '2026-10-03', attendance: null, loot: null, notes: null } };
    const out = page(rec, null, { trial });
    assert.deepEqual(sectionIds(out).slice(0, 2), ['trial-card', 'attendance'], 'the decision panel leads');
    assert(!out.includes('gs-trial-bar') && !out.includes('gs-chip-trial'));
    const head = out.slice(out.indexOf('<header class="gs-pagehead">'), out.indexOf('</header>'));
    assert(head.includes('is-rose">Ends in 3 days<') && count(head, /gs-hd-chip/g) === 1, 'one trial chip, in the head');
    assert.equal(molten(out), 1, 'Promote to Raider is the one primary');
    assert(out.includes('data-action="trial-end"') && out.includes('data-action="trial-extend"'));
    assert.equal(molten(page(RECORD())), 0, 'a raider\'s page has no orange');
  });

  await check('9. characters: one inline Edit, the rest in the row\'s More menu named for the character; the Main has no menu', () => {
    const out = page(RECORD());
    const table = out.match(/<section class="gs-hd-panel gs-pr-panel" id="characters"[\s\S]*?<\/section>/)[0];
    assert.equal(count(table, /data-action="char-edit"/g), 2);
    assert.equal(count(table, /aria-haspopup="menu"/g), 1);
    assert(table.includes('aria-label="More actions for Thorenalt"') && table.includes('data-action="char-main"') && table.includes('data-action="char-remove"') && table.includes('is-danger'));
    assert(!table.includes('More actions for Thoren"'));
    assert(count(table, /class="gs-pr-row gs-pr-char"/g) === 2, 'one row per character');
  });

  await check('9. ids on the page are unique with every section drawn (trial, attendance, loot, away), and the sections are jump targets', () => {
    const rec = RECORD({ status: 'trial', trialFlag: { kind: 'ended', days: -1 }, trialEnd: '2026-10-16' });
    const trial = { gid: 'g1', pid: 'p_x', error: '', data: { today: '2026-10-17', person: { id: 'p_x', status: 'trial' }, since: null, attendance: null, loot: null, notes: null } };
    S.person = { gid: 'g1', pid: 'p_x', record: rec };
    const a = G.pages.attendance.attState();
    a.personLootCard = { gid: 'g1', pid: 'p_x', data: LOOT, denied: false };
    const away = { id: 'away', title: 'Away notices', bodyHtml: '<p class="gs-fine">No away notices.</p>' };
    const out = page(rec, null, { trial, attendance: { data: ATT, denied: false }, away });
    const all = ids(out);
    assert.deepEqual(all.filter((x, i) => all.indexOf(x) !== i), [], 'no id twice');
    assert.deepEqual(sectionIds(out), ['trial-card', 'attendance', 'loot-card', 'characters', 'details', 'notes', 'away']);
    for (const id of sectionIds(out)) assert(out.includes('aria-labelledby="' + id + '-h"') && out.includes('id="' + id + '-h"'), id);
  });

  await check('9. the attendance history (Forge): the head with one chip, the rank beside the select, one block per team', () => {
    const data = JSON.parse(JSON.stringify(ATT));
    data.person.rank = { id: 'core', name: 'Core', set: true }; data.person.rankChoices = [{ id: 'core', name: 'Core' }, { id: 'raider', name: 'Raider' }]; data.person.rankTeamId = 't1';
    const out = G.pages.personAtt.personAttHtml({ guildData: gd(OFFICER_CAN), pid: 'p_x', data });
    assert(out.includes('gs-forge') && /<h1 class="gs-h1[^"]*" id="page-title" tabindex="-1">Thoren<\/h1>/.test(out) && out.includes('<span class="gs-hd-chip is-grey">You</span>'));
    assert(stripTags(out).includes('Shaman') && out.includes('gs-back-link') && out.includes('href="#/g/g1/attendance"'));
    assert.deepEqual(sectionIds(out), ['pa-rank-box']);
    const all = ids(out);
    assert.deepEqual(all.filter((x, i) => all.indexOf(x) !== i), [], 'the rank select and its section do not share an id');
    assert(out.includes('id="pa-rank"') && out.includes('id="pa-rank-box-h"'));
  });

  await check('9. the loot history is the same object page: You line when it is yours, figures first, one panel per night linking to it, the Main\'s class in the header', () => {
    const out = G.pages.personLoot.personLootHtml({ guildData: gd(OFFICER_CAN), pid: 'p_x', data: LOOT });
    assert(out.includes('gs-object-page') && out.includes('<span class="gs-hd-chip is-grey">You</span>') && stripTags(out).includes('Loot history') && stripTags(out).includes('Main: Shaman'));
    assert(stripTags(out).includes('This is your loot. The guild\'s loot setting decides who else can see it.'));
    assert.deepEqual(sectionIds(out), ['pl-cols', 'pl-totals']);
    assert(out.includes('href="#/g/g1/loot/n/r1"'));
    const other = G.pages.personLoot.personLootHtml({ guildData: gd(OFFICER_CAN), pid: 'p_x', data: Object.assign({}, LOOT, { person: Object.assign({}, LOOT.person, { isMe: false }) }) });
    assert(!other.includes('gs-youline'));
  });

  await check('9. wiring: the app passes the away section and the saved time, forgets the saved time on another page, and the Worker answer feeds both', () => {
    const app = read('js/guild/app.js');
    assert(/away: P\.away\.personSectionOf\(/.test(app) && /saved: state\.personSaved/.test(app) && /if \(r\.name !== 'person'\) state\.personSaved = null;/.test(app));
    assert(read('js/guild/pages-person.js').includes('st().personSaved = { gid: c.gid, pid: c.pid, ms: Date.now() }'));
    assert(/\.gs-youline-sub/.test(css) && /\.gs-pagehead-context:has\(> \.gs-sumsep\)/.test(css));
  });

  // ═══ 10. Away notices, My characters, Linked accounts ═══
  const AWAY_DATA = (over) => Object.assign({ personId: 'p1', today: '2026-10-20', timeZone: 'America/Chicago', max: 30, active: 2, notices: [
    { id: 'an_1', personId: 'p1', kind: 'away', atTime: null, from: '2026-10-20', to: '2026-10-27', weekday: null, reason: 'Wedding', mine: true, createdAt: 1 },
    { id: 'an_2', personId: 'p1', kind: 'late', atTime: '21:00', from: '2026-10-22', to: null, weekday: 2, reason: null, mine: true, createdAt: 1 },
    { id: 'an_3', personId: 'p1', kind: 'away', atTime: null, from: '2026-09-01', to: '2026-09-05', weekday: null, reason: null, mine: true, createdAt: 1 }] }, over || {});
  const awayPage = (data, note) => G.pages.away.mineHtml({ guildData: gd(MEMBER_CAN), state: { gid: 'g1', data, showPast: false, note: note || '' }, alert: '' });

  await check('10. Away notices is a T1 list page: Add a notice is the one primary in the header, the notices are table rows (cards on a phone) with Edit and Remove, ended ones fold away', () => {
    const out = awayPage(AWAY_DATA());
    assert(out.includes('gs-list-page') && out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Away notices</h1>') && stripTags(out).includes('(America/Chicago)'));
    assert.equal(molten(out), 1);
    assert(/<header class="gs-pagehead">[\s\S]*class="gs-btn gs-btn-molten" data-action="away-add"[\s\S]*<\/header>/.test(out), 'the primary sits in the header');
    assert(out.includes('<table class="gs-dtable" aria-label="Current and upcoming notices"') && out.includes('gs-dtable-primary">Away Oct 20 - Oct 27</th>') && out.includes('>Row actions<'));
    assert.equal(count(out, /data-action="away-edit"/g), 3, 'two current and one past');
    assert(out.includes('aria-label="Past notices"') && out.includes('id="an-past-list" hidden'), 'the past group is folded');
    assert(stripTags(out).includes('Only you and your officers see these notices and their reasons.'));
    const full = awayPage(AWAY_DATA({ active: 30 }));
    assert(/disabled data-action="away-add"/.test(full) && stripTags(full).includes('You have 30 notices, the most there can be. Remove one to add another.'));
    assert(awayPage(AWAY_DATA(), 'Notice saved.').includes('gs-banner-success'));
  });

  await check('10. Away notices: no roster entry and no notices are empty states with the next step in words; the dialogs use the kit\'s layout', () => {
    const none = awayPage(AWAY_DATA({ personId: null, notices: [] }));
    assert(stripTags(none).includes('No roster entry yet') && stripTags(none).includes('Add your character on My characters, or find your roster entry there and say This is me.') && none.includes('href="#/characters"') && molten(none) === 0 && !none.includes('away-add'));
    const empty = awayPage(AWAY_DATA({ notices: [] }));
    assert(stripTags(empty).includes('You have no away notices') && empty.includes('gs-empty2'));
    const dialog = G.pages.away.dialogHtml({ mode: 'add', ctx: 'mine', today: '2026-10-20', minToday: true });
    assert(dialog.includes('gs-dialog-form gs-dialog-form') && dialog.includes('data-submit="away-form"') && dialog.includes('class="gs-btn gs-btn-molten" id="dlg-submit"'));
    assert.equal(G.pages.away.problemOf({ kind: 'away', repeat: 'range', from: '2026-10-20', to: '' }).text, 'Add a To date, or choose Every week on one day.');
    const remove = G.pages.away.removeDialogHtml('Away Oct 20 - Oct 27', 'mine', 'an_1', '');
    assert(remove.includes('gs-dialog-destructive') && remove.includes('class="gs-btn gs-btn-danger"') && remove.includes('Remove this notice?'));
  });

  const BNET_GUILD = (over) => Object.assign({ guildId: 'g1', guildName: 'Ember', gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', realmKind: 'realm', supportLabel: 'TBC Anniversary', status: 'not_linked', message: null, onRoster: false, characters: [] }, over || {});
  const BNET = (over) => Object.assign({ configured: true, link: null, guilds: [BNET_GUILD()] }, over || {});
  const chars = (data, extra) => G.pages.bnet.charactersHtml(Object.assign({ data: data }, extra || {}));

  await check('10. My characters: somebody already on the roster is told what Battle.net adds, not to connect it to see their roster entry', () => {
    const on = chars(BNET({ guilds: [BNET_GUILD({ onRoster: true })] }));
    const t = stripTags(on);
    assert(t.includes('You are on the roster already') && t.includes('so you do not need Battle.net to raid there') && t.includes('add your alts') && t.includes('a second way to sign in'), t);
    assert(!t.includes('Connect Battle.net to see your characters') && !/Connect Battle\.net/.test(t), 'no "Connect Battle.net" anywhere: ' + t);
    assert(t.includes('Add Battle.net') && on.includes('href="/auth/bnet/login"') && molten(on) === 0, 'a quiet Add Battle.net link');
    const off = chars(BNET());
    assert(stripTags(off).includes('Connect Battle.net to see your characters') && off.includes('gs-btn-molten'), 'somebody on no roster still gets the invitation, as the page primary');
    const mixed = chars(BNET({ guilds: [BNET_GUILD({ onRoster: true }), BNET_GUILD({ guildId: 'g2', guildName: 'Owls', onRoster: false })] }));
    const m = stripTags(mixed);
    assert(m.includes('Find your characters with Battle.net') && m.includes('You are on the roster of Ember. In Owls, Battle.net finds your characters so you can add them. For Ember it adds your other characters (alts) and a second way to sign in.'), m);
    // The per-guild card of a not-connected guild says the same thing in a line.
    const guildCard = G.pages.bnet.guildCardHtml(BNET_GUILD({ onRoster: true }));
    assert(stripTags(guildCard).includes('You are already on this roster. Adding Battle.net lists your other characters here, so you can add your alts.') && !/Connect Battle\.net/.test(stripTags(guildCard)));
  });

  await check('10. My characters (connected): your own characters keep the delivered order, status as chips, Add is a quiet button, no orange, and the intro is an info banner', () => {
    const rows = [
      { name: 'Cassia', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'PRIEST', level: 68, state: 'new', claim: null, claimable: true },
      { name: 'Aldric', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'WARRIOR', level: 70, state: 'yours', claim: null, claimable: false },
      { name: 'Eliora', realm: 'Dreamscythe', realmSlug: 'dreamscythe', class: 'PALADIN', level: 61, state: 'new', claim: { id: 'cl_1', status: 'pending' }, claimable: false },
    ];
    const out = chars(BNET({ link: { battletag: 'T#1', linkedAt: 1, fetchedAt: 1, expiresAt: 2e12 }, guilds: [BNET_GUILD({ status: 'ok', onRoster: true, characters: rows })] }));
    assert(out.indexOf('>Cassia<') < out.indexOf('>Aldric<') && out.indexOf('>Aldric<') < out.indexOf('>Eliora<'), 'delivered order kept, yours not moved first');
    assert(out.includes('gs-schip gs-schip-success') && out.includes('On your record') && out.includes('gs-schip-warning') && out.includes('Needs an officer'), 'status = tint + icon + word');
    assert(/class="gs-btn gs-btn-sm" aria-label="Add Cassia" data-action="bnet-claim"/.test(out) && /aria-label="Withdraw the request for Eliora"/.test(out));
    assert.equal(count(out, /gs-btn-molten/g), 0);
    assert(out.includes('id="chars-intro"') && out.includes('gs-banner-info') && out.includes('<span>Refresh characters</span>'));
  });

  await check('10. Linked accounts is a T3 form page: the name form has the Save bar, connecting is quiet, nothing on the page is orange but the hidden bar, Disconnect is a danger outline', () => {
    const me = { user: { id: 'u1', displayName: 'Gale', username: 'gale' }, identities: { discord: { username: 'gale' }, bnet: { battletag: 'T#1' } }, account: { customName: null, available: { discord: true, bnet: true } } };
    const out = G.pages.bnet.linkedHtml({ data: { configured: true, link: { battletag: 'T#1', linkedAt: 1, fetchedAt: 1, expiresAt: 2e12 }, guilds: [] }, me });
    assert(out.includes('gs-form-page') && out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Linked accounts</h1>'));
    const name = out.slice(out.indexOf('id="account-name-form"'), out.indexOf('</form>', out.indexOf('id="account-name-form"')));
    assert(name.includes('data-dirty-form') && name.includes('data-savebar') && name.includes('<span>Save name</span>') && name.includes('name="displayName"'));
    assert.equal(molten(out), 0, 'the only primary is the Save bar\'s, and it is hidden until the name changes');
    assert(out.includes('class="gs-btn gs-btn-danger-outline"') && out.includes('gs-schip gs-schip-success'));
    const off = G.pages.bnet.linkedHtml({ data: { configured: true, link: null, guilds: [] }, me });
    assert(molten(off) === 0 && off.includes('gs-schip gs-schip-none'), 'Connect Battle.net is a quiet link; Not connected is a chip');
    assert.deepEqual(ids(out).filter((x, i, all) => all.indexOf(x) !== i), []);
  });

  // ═══ 11. Read-only and reading pages ═══
  const VIEW = (kind, over) => Object.assign({
    guild: { name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', region: 'US', gameVersion: 'tbc', timeZone: 'America/New_York' },
    viewer: kind === 'guest' ? { kind: 'guest', role: { name: 'Guest' }, team: null, expiresAt: Date.UTC(2026, 10, 20) } : { kind: 'public' },
    teams: [{ id: 't1', name: 'Alpha' }],
    sections: {
      roster: [{ team: { id: 't1', name: 'Alpha' }, people: [{ name: 'Thoren', class: 'PALADIN', role: 'tank' }] }],
      loot: [{ team: { id: 't1', name: 'Alpha' }, awards: [{ itemName: 'Blade', quality: 4, winner: 'Thoren', winnerClass: 'PALADIN', disenchanted: false, awardedAt: Date.UTC(2026, 9, 17, 0, 14) }] }],
    },
  }, over || {});

  await check('11. the guest view is a read-only list page: Read-only chip, the kind of link, Leave behind More, the awarded time in the guild zone with the zone named in the foot line', () => {
    const out = G.pages.view.viewHtml({ data: VIEW('guest'), kind: 'guest' });
    assert(out.includes('gs-list-page') && out.includes('gs-schip gs-schip-neutral') && out.includes('>Read-only<') && out.includes('>Guest link<'));
    assert(out.includes('aria-label="More"') && out.includes('data-action="view-leave"') && out.includes('>Leave this link<'), 'Leave is behind the one More menu');
    assert(stripTags(out).includes('Oct 16, 8:14 PM ET'), 'guild zone: ' + stripTags(out).match(/Oct 1\d[^|]{0,30}/));
    assert(stripTags(out).includes('A read-only copy: nothing on this page can be changed. Times are in ET, the guild\'s zone.'));
    assert.equal(molten(out), 0, 'nothing to act on');
    assert(out.includes('<table class="gs-dtable"') && !out.includes('gs-table-stack'));
  });

  await check('11. the public page is the same read-only page without Leave or link details; without a zone in an older answer the time still names a zone', () => {
    const out = G.pages.view.viewHtml({ data: VIEW('public'), kind: 'public' });
    assert(out.includes('>Read-only<') && out.includes('>Public page<') && !out.includes('view-leave') && !out.includes('aria-label="More"') && !stripTags(out).includes('Link works'));
    const old = VIEW('public'); delete old.guild.timeZone;
    const t = stripTags(G.pages.view.viewHtml({ data: old, kind: 'public' }));
    assert(!t.includes('the guild\'s zone') && /\d{1,2}:\d{2} (AM|PM)/.test(t), 'the foot line does not claim a zone it does not have');
  });

  const FORM = (over) => Object.assign({
    guild: { name: 'Ravens', realm: 'Firemaw', realmKind: 'realm', region: 'US', gameVersion: 'tbc' }, teams: [{ id: 't1', name: 'Alpha' }, { id: 't2', name: 'Bravo' }],
    rosterOptions: { classes: [{ id: 'MAGE', name: 'Mage' }], specs: { MAGE: ['Fire', 'Frost'] }, roles: {} },
    questions: [{ id: 'q1', label: 'Why us?', type: 'long', required: true }, { id: 'q2', label: 'Veteran?', type: 'choice', options: ['Yes', 'No'], required: false }], signedInAs: null,
  }, over || {});

  await check('11. the application form is a T3 form page: kit fields with (required) in words, a message slot under each, checked when a field is left, Send is the one primary', () => {
    const out = G.pages.apply.applyHtml({ state: { gid: 'g1', status: 'ok', data: FORM(), draft: {}, busy: false, error: '', done: false } });
    assert(out.includes('gs-form-page') && out.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Apply to Ravens</h1>'));
    assert(count(out, /\(required\)/g) === 5, 'name, class, spec, team, the required question');
    for (const id of ['ap-name', 'ap-class', 'ap-spec', 'ap-team', 'ap-contact', 'ap-q-q1', 'ap-q-q2']) assert(out.includes('id="' + id + '-err"'), id + ' has its message slot');
    assert(out.includes('data-change="apply-field"') && out.includes('data-change="apply-class"'));
    assert.equal(molten(out), 1);
    assert(out.includes('data-error-summary-slot'));
    const rules = G.pages.apply.rulesFor(FORM());
    assert.deepEqual(Object.keys(rules), ['ap-name', 'ap-class', 'ap-spec', 'ap-team', 'ap-q-q1']);
    assert.equal(rules['ap-name'](' '), 'Enter your character\'s name.');
    assert.equal(rules['ap-q-q1']('Because'), '');
    assert.equal(G.pages.apply.fieldId('answers.q1'), 'ap-q-q1');
    assert(G.pages.apply.applyHtml({ state: { gid: 'g1', status: 'ok', data: FORM(), draft: {}, busy: false, error: '', done: true } }).includes('gs-banner-success'));
    assert(/@media \(max-width: 600px\)[\s\S]*?\.gs-input \{ height: 44px; \}/.test(css) && /@media \(max-width: 600px\)[\s\S]*?\.gs-input-search \{ height: 44px; \}/.test(css), 'the fields are 44 px on a phone');
  });

  await check('11. the guest sign-up writes the raid\'s start in the GUILD\'s zone, not the visitor\'s, in the header and in the thanks', () => {
    const data = (zone) => ({ guild: { name: 'Ravens', gameVersion: 'tbc', realmKind: 'realm', timeZone: zone },
      raid: { raidOn: '2027-01-20', startsAt: Date.UTC(2027, 0, 21, 1), timeKnown: true, zone: 'Karazhan', title: 'Sunday Karazhan', teamName: 'Alpha' }, spotsLeft: 3, noteMax: 120, rosterOptions: null });
    const state = (zone, done) => ({ token: 't', status: 'ok', data: data(zone), draft: {}, busy: false, error: '', done: !!done, message: '', title: '' });
    const ny = stripTags(G.pages.join.joinHtml({ state: state('America/New_York') }));
    assert(ny.includes('Wed Jan 20, 8:00 PM ET'), ny);
    const berlin = stripTags(G.pages.join.joinHtml({ state: state('Europe/Berlin') }));
    assert(berlin.includes('Thu Jan 21, 2:00 AM CET') && !berlin.includes('8:00 PM ET'), berlin);
    assert(stripTags(G.pages.join.joinHtml({ state: state('America/New_York', true) })).includes('can see you for Wed Jan 20, 8:00 PM ET.'));
    assert(!read('js/guild/pages-join.js').includes("timeInZone(raid.startsAt, '')"), 'no more "the guest\'s own zone"');
    const out = G.pages.join.joinHtml({ state: state('America/New_York') });
    assert(out.includes('gs-form-page') && count(out, /\(required\)/g) === 3 && out.includes('id="jn-name-err"') && out.includes('data-change="join-field"') && molten(out) === 1);
    assert.deepEqual(Object.keys(G.pages.join.RULES), ['jn-name', 'jn-class', 'jn-spec']);
  });

  await check('11. Privacy and the roadmap are reading pages: the shared header, 760 wide, the roadmap says Read-only, the delete box uses the kit\'s buttons', () => {
    const privacy = G.pages.privacy.privacyHtml({ me: { deleteImpact: { handOverFirst: [], guildsDeleted: [] } } });
    assert(privacy.includes('gs-doc-page') && privacy.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Privacy &amp; my data</h1>') && privacy.includes('class="gs-btn gs-btn-danger-outline"') && privacy.includes('class="gs-btn gs-btn-danger"'));
    assert(/disabled[^>]*id="delete-go"/.test(privacy) && privacy.includes('id="delete-understand"') && molten(privacy) === 0);
    const road = G.pages.roadmap.roadmapHtml({ me: null, view: G.pages.roadmap.viewState() });
    assert(road.includes('gs-doc-page') && road.includes('<h1 class="gs-h1" id="page-title" tabindex="-1">Future enhancements</h1>') && road.includes('>Read-only<'));
    assert(/\.gs-doc-page/.test(css) && /\.gs-page-narrow \{ max-width: 760px/.test(css));
  });

  // ═══ 12. Sign-in, no guild, create guild ═══
  await check('12. sign-in, no guild and the message card use the kit\'s buttons with exactly one primary each', () => {
    assert.equal(molten(G.pages.signin.signinHtml({ providers: { discord: true, bnet: true } })), 1);
    assert.equal(molten(G.pages.signin.signinHtml({ providers: { discord: false, bnet: true } })), 1);
    const me = (extra) => Object.assign({ user: { displayName: 'Gale', username: 'gale' }, identities: { discord: {} }, create: { allowed: false } }, extra || {});
    for (const [label, m] of [['discord, cannot create', me()], ['discord, can create', me({ create: { allowed: true, servers: [], claimable: [] } })], ['battle.net only', me({ identities: { bnet: {} } })]]) {
      const out = G.pages.signin.noGuildHtml(m);
      assert.equal(molten(out), 1, label);
      assert(!/<button type="button" class="gs-btn[^"]*" data-action="sign-out"/.test(out) || out.includes('gs-linkbtn'), label);
    }
    assert.equal(molten(G.pages.signin.messageHtml('Oops', 'Words.', {})), 1);
    assert.equal(molten(G.pages.signin.messageHtml('Oops', 'Words.', { retry: true })), 0);
    assert(G.pages.signin.messageHtml('Oops', 'Words.', { retry: true }).includes('data-action="retry"'));
    const create = G.pages.create.createHtml({ me: { create: { allowed: true, stale: false, servers: [{ id: 's1', name: 'Hall', iconUrl: null, access: 'owner' }], claimable: [{ guildId: 'g9', guildName: 'Owls', serverName: 'Roost' }] } }, timeZones: ['UTC'], defaultTimeZone: 'UTC' });
    assert.equal(molten(create), 1, 'Create guild; the claim confirm is a quiet button');
    assert(create.includes('class="gs-btn" aria-label="Claim Owls" data-action="claim-ask"'));
  });

  await check('12. the skip link is the first thing in every host page (the app, the FAQ, What\'s new) and points at the content', () => {
    for (const f of ['index.html', 'faq.html', 'whats-new.html']) {
      const html = read(f);
      const skip = html.indexOf('class="gs-skip" href="#gs-main" data-skip-link');
      assert(skip > 0, f);
      assert(skip < html.indexOf('id="shell-rail"') || html.indexOf('id="shell-rail"') < 0, f + ': before the rail and the sidebar');
      assert(html.includes('id="gs-main"'), f + ' has the target');
    }
    const app = read('js/guild/app.js');
    assert(/candidates = \[byId\('gs-main'\), byId\('planner-root'\), [^\]]*main\.landing/.test(app), 'it focuses the visible main, the landing one on the static pages');
    assert(/\.gs-skip:focus \{ top: 8px; \}/.test(css));
  });

  // ═══ the sweep over all guild pages ═══
  const guildFiles = fs.readdirSync(path.join(ROOT, 'js/guild')).filter(f => f.endsWith('.js'));

  await check('sweep: the one overflow menu is labelled More everywhere (and a row\'s is an icon button named for its object)', () => {
    for (const f of guildFiles) {
      const src = read('js/guild/' + f);
      for (const m of src.matchAll(/menuHtml\(\{([^}]*)\}/g)) {
        const label = /label: '([^']*)'/.exec(m[1].split('items:')[0]);
        // The empty roster's chooser is the board's "Import" button (R2-7), not an overflow menu.
        const importChooser = f === 'pages-roster.js' && /id: 'roster-import'/.test(m[1]);
        // The Raid facts panel's rows each have a small "Change" menu (design-spec 4, Fact panel; the head More keeps the page-level items).
        const factChange = f === 'pages-raid-facts.js' && /id: 'fact-'/.test(m[1]);
        if (label) assert.equal(label[1], importChooser ? 'Import' : factChange ? 'Change' : 'More', f + ': ' + m[0].slice(0, 80));
      }
    }
    const retired = ['Actions menu', 'Plan actions', 'Options menu'];
    for (const f of guildFiles.filter(f => f !== 'roadmap-data.js')) for (const w of retired) assert(!read('js/guild/' + f).includes(w), f + ' says ' + w);
  });

  await check('sweep: orange is for the one primary - no row action (Claim, Accept, Approve, Save standing sign-ups, Copy recruiting post) is orange', () => {
    const forbidden = [
      ['pages-bnet.js', /bnet-claim[^\n]*gs-btn-molten|gs-btn-molten[^\n]*bnet-claim/], ['pages-applications.js', /btn\('app-accept', 'Accept', ' gs-btn-molten'\)/],
      ['pages-review.js', /gs-btn-molten" data-key="claim-approve/], ['pages-standing.js', /gs-btn-molten" data-key="st-save"/], ['pages-recruiting.js', /gs-btn-molten" data-action="recruiting-copy"/],
      ['pages-accounts.js', /gs-btn-molten/], ['pages-person.js', /gs-btn-molten/],
    ];
    for (const [f, re] of forbidden) assert(!re.test(read('js/guild/' + f)), f);
    // Dialog and page primaries come from the kit's variant.
    for (const f of ['pages-person.js', 'pages-away.js', 'pages-bnet.js', 'pages-accounts.js', 'pages-view.js', 'pages-apply.js', 'pages-join.js', 'pages-privacy.js', 'pages-roadmap.js', 'pages-signin.js', 'pages-create.js']) {
      assert(!/class="gs-btn[^"]*"/.test(read('js/guild/' + f).replace(/\/\/.*$/gm, '')), f + ' builds no raw gs-btn markup');
    }
  });

  await check('sweep: status is colour plus words - every pill and chip in the guild pages carries its text', () => {
    for (const f of guildFiles.filter(f => f !== 'roadmap-data.js')) {
      const src = read('js/guild/' + f);
      assert(!/<span class="gs-pill[^"]*"><\/span>/.test(src) && !/<span class="gs-chip[^"]*"><\/span>/.test(src), f + ' has an empty pill or chip');
    }
    assert(G.ui.chipHtml({ tone: 'success', label: 'Connected' }).includes('Connected') && G.ui.readOnlyChipHtml().includes('Read-only') && G.ui.readOnlyChipHtml().includes('<svg'));
  });

  await check('sweep: nothing on screen is under 12 px (only the printed sheet is)', () => {
    const screen = css.split('@media print')[0];
    const small = [];
    screen.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/font(?:-size)?:\s*([^;}]*)/g)) {
        const size = /(\d+(?:\.\d+)?)px(?:\s*\/|\s|$)/.exec(m[1]);
        if (size && Number(size[1]) < 12) small.push((i + 1) + ': ' + line.trim().slice(0, 80));
      }
    });
    assert.deepEqual(small, []);
  });

  await check('sweep: every time a page writes carries the guild\'s zone - formatDateTime is always given one, and no page asks the browser for a time', () => {
    for (const f of guildFiles.filter(f => !/^(ui|ui-kit|ui-templates|roadmap-data)\.js$/.test(f))) {
      const src = read('js/guild/' + f);
      assert(!/toLocaleTimeString|toLocaleString\(/.test(src), f + ' formats a time in the browser\'s zone');
      for (const m of src.matchAll(/formatDateTime\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)) assert(m[1].indexOf(',') > 0, f + ': ' + m[0]);
    }
  });

  await check('sweep: no "raid night(s)" in the guild pages, the Worker or the product copy of the host pages', () => {
    const re = /raid nights?/i;
    // The Loot pages (hub, raid night page, rules) name a raid night: the Loot redesign's own wording.
    for (const f of guildFiles.filter(f => !/loot/.test(f))) assert(!re.test(read('js/guild/' + f)), 'js/guild/' + f);
    const worker = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? worker(dir + '/' + e.name) : (e.name.endsWith('.js') ? [dir + '/' + e.name] : []));
    for (const f of worker('worker')) assert(!re.test(read(f)), f);
    for (const f of ['index.html', 'faq.html', 'whats-new.html']) assert(!re.test(read(f).replace(/forged for raid night/g, '')), f + ' (the footer tagline is the brand line)');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
