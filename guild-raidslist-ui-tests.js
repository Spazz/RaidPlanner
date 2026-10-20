/**
 * Raidsmith guild UI - the Raids LIST page on the Forge look (lane 1 of the raids revamp): the Upcoming cards (one link, gold date, one status item,
 * 8 then Show all), the Past table (no Sources column, one status chip, 10 rows then Show all, Show older raids), the right rail (standing sign-ups
 * with On / Off and the Change dialog, the officer's away panel with Create upcoming raids, the member's away line) and the head More items.
 * Run: node guild-raidslist-ui-tests.js
 *
 * Same approach as guild-wave2-ui-tests.js: the guild scripts load in a vm with no DOM and the render functions return HTML strings.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const css = read('guild.css');

const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout };
vm.createContext(sandbox);
for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = sandbox.Guild;
const ws = s => String(s).replace(/[  ]/g, ' ');
const count = (s, needle) => String(s).split(needle).length - 1;

const OFFICER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'raids.edit': 'guild', 'attendance.view': 'guild', 'attendance.review': 'guild', 'guild.teams': 'guild' };
const MEMBER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'attendance.view': ['t1'] };
function gd(can) {
  return {
    guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc', realmKind: 'realm', realmSlug: null, createdAt: 1 },
    teams: [{ id: 't1', name: 'Team KJ', size: 25, archived: false, players: 3, leads: [] }],
    me: { roles: [{ role: 'officer' }], can },
    attendanceFlags: {},
  };
}
const STARTS = Date.UTC(2026, 9, 24, 0, 0); // Fri Oct 23 2026, 19:00 in Chicago (CDT)
const UP = (id, over) => Object.assign({
  id, raidOn: '2026-10-23', startsAt: STARTS, timeKnown: true, upcoming: true, zone: 'Black Temple', size: 25, title: null, eventSourced: false, eventId: null, otherServer: false,
  signups: { signed: 12, late: 1, standby: 0, bench: 0, tentative: 0, absence: 0 }, locked: false, signupsOpen: true, mine: null, planned: false,
}, over || {});
const PAST = (id, over) => Object.assign({ id, raidOn: '2026-10-10', zone: 'Gruul\'s Lair', size: 25, bosses: { kills: 2, pulls: 3 }, sources: { event: true, reports: 1, plan: true }, counts: { present: 20, bench: 2, missed: 3 }, openFlags: 0, state: 'reviewed', stale: false }, over || {});
const LIST = (over) => Object.assign({ team: { id: 't1', name: 'Team KJ' }, today: '2026-10-19', can: { edit: false, signup: true }, schedule: null, hasMore: false, upcoming: [UP('u1')], raids: [PAST('r1')] }, over || {});
const page = (data, can, over) => ws(G.pages.raids.raidsHtml(Object.assign({ guildData: gd(can || MEMBER_CAN), teamId: 't1', data, tab: 'upcoming' }, over || {})));
const cardOf = (out, id) => out.split('<li class="gs-up">').filter(c => c.includes('/' + id + '"'))[0].split('</li>')[0];

(async () => {
  await check('page root is Forge; the head has the title, the context line and New raid (the one molten) for officers only', () => {
    const o = page(LIST({ can: { edit: true, signup: false } }), OFFICER_CAN);
    assert(o.includes('class="gs-page gs-list-page gs-forge gs-raids-page"') && o.includes('>Raids</h1>') && o.includes('Ravens - 1 upcoming, 1 past'));
    assert.equal(count(o, 'gs-btn-molten'), 1);
    assert(o.includes('<span>New raid</span>'));
    assert(!page(LIST()).includes('gs-btn-molten'), 'a member page has no molten button');
  });

  await check('head More: officers keep Backfill, Raid schedule, Create upcoming raids (with slots), Subscribe and My away notices; members keep Subscribe and My away notices', () => {
    G.pages.calendar = G.pages.calendar || {};
    const sched = { slots: 2, weeks: 2, auto: false };
    const o = page(LIST({ can: { edit: true, signup: false }, schedule: sched }), OFFICER_CAN);
    for (const t of ['Backfill from Warcraft Logs', 'Raid schedule', 'Create upcoming raids', 'Subscribe in your calendar', 'My away notices']) assert(o.includes('>' + t + '<'), 'officer: ' + t);
    const m = page(LIST());
    for (const t of ['Subscribe in your calendar', 'My away notices']) assert(m.includes('>' + t + '<'), 'member: ' + t);
    for (const t of ['Backfill from Warcraft Logs', 'Raid schedule', 'Create upcoming raids']) assert(!m.includes('>' + t + '<'), 'member without: ' + t);
  });

  await check('tabs: Forge .gs-subtabs with gold .gs-tab-count badges; the Upcoming tab is pressed', () => {
    const o = page(LIST());
    assert(o.includes('<ul class="gs-subtabs gs-raids-tabs">') && o.includes('Upcoming <span class="gs-tab-count">1</span>') && o.includes('Past <span class="gs-tab-count">1</span>'));
    assert(/class="gs-subtab is-active" aria-pressed="true" data-action="raids-tab" data-value="upcoming"/.test(o));
  });

  await check('card: ONE link wraps the gold date, the time and the title; the figure, the thin bar and the status item sit outside it', () => {
    const o = page(LIST());
    const c = cardOf(o, 'u1');
    assert.equal(count(c, '<a '), 1, 'one link');
    assert(c.startsWith('<a class="gs-up-link" href="#/g/g1/raids/r/u1">') || c.includes('<a class="gs-up-link" href="#/g/g1/raids/r/u1">'));
    const link = c.slice(c.indexOf('<a '), c.indexOf('</a>'));
    assert(link.includes('<span class="gs-hd-daydate gs-up-date">Fri Oct 23</span>') && link.includes('<span class="gs-up-time">7:00 PM CT</span>') && link.includes('<span class="gs-up-title">Black Temple</span>'));
    const after = c.slice(c.indexOf('</a>'));
    assert(after.includes('gs-up-fig') && after.includes('<svg class="gs-up-bar"') && after.includes('gs-up-status'));
    assert(/\.gs-hd-daydate \{[^}]*color: var\(--accent-gold\)/.test(css), 'the date is gold (the week-strip recipe)');
    assert(/\.gs-hd-daydate \{[^}]*text-transform: uppercase/.test(css) && /\.gs-hd-daydate \{[^}]*var\(--font-cond\)/.test(css));
  });

  await check('card status: at most ONE status item - member Sign up button; Signed up green (+ Standing); other kinds a grey chip; Group N; Sign-ups closed; officer Plan chip', () => {
    const items = (html) => count(html, 'gs-hd-chip') + count(html, '<button') + count(html, 'Sign-ups closed');
    const o = page(LIST({ upcoming: [
      UP('a'),
      UP('b', { mine: { kind: 'signed', source: 'raidsmith', characterName: 'Eliora', standing: true } }),
      UP('c', { mine: { kind: 'late', source: 'raidsmith', characterName: 'Eliora' } }),
      UP('d', { mine: { kind: 'signed', roster: { group: 2, status: 'pending' } } }),
      UP('e', { signupsOpen: false }),
      UP('f', { mine: { kind: 'tentative', source: 'raidsmith', characterName: 'Eliora' } }),
    ] }));
    assert(cardOf(o, 'a').includes('data-action="raids-signup" data-rid="a"') && cardOf(o, 'a').includes('>Sign up</span>') === false && cardOf(o, 'a').includes('>Sign up</button>'));
    assert(cardOf(o, 'b').includes('<span class="gs-hd-chip is-green">Signed up</span>') && cardOf(o, 'b').includes('<span class="gs-up-note">Standing</span>'));
    assert(cardOf(o, 'c').includes('<span class="gs-hd-chip is-grey">Late</span>'));
    assert(cardOf(o, 'd').includes('<span class="gs-hd-chip is-grey">Group 2</span>') && !cardOf(o, 'd').includes('Signed up'));
    assert(cardOf(o, 'e').includes('<span class="gs-up-note">Sign-ups closed</span>'));
    assert(cardOf(o, 'f').includes('is-grey">Tentative<'));
    for (const id of ['a', 'c', 'd', 'e', 'f']) assert(items(cardOf(o, id)) <= 1, 'one item on ' + id);
    const off = page(LIST({ can: { edit: true, signup: true }, upcoming: [UP('p'), UP('q', { planned: true }), UP('m', { eventSourced: true, eventMovedOn: '2026-10-24' })] }), OFFICER_CAN);
    assert(cardOf(off, 'p').includes('<span class="gs-hd-chip is-grey">Plan</span>') && !cardOf(off, 'q').includes('gs-hd-chip') && !off.includes('Publish'));
    assert(cardOf(off, 'm').includes('Raid-Helper has this event on Sat Oct 24. The raid was not moved.'));
    assert(!off.includes('raids-signup'), 'an officer card carries no sign-up button');
  });

  await check('cards: the first 8, then "Show all N"; showAll draws all of them; the foot line and Edit weekly schedule are gone', () => {
    const many = Array.from({ length: 11 }, (_, i) => UP('u' + i));
    const o = page(LIST({ upcoming: many }));
    assert.equal(count(o, '<li class="gs-up">'), 8);
    assert(o.includes('Showing 8 of 11 raids') && o.includes('data-action="raids-show-all">Show all 11</button>'));
    assert.equal(count(page(LIST({ upcoming: many }), null, { showAll: true }), '<li class="gs-up">'), 11);
    assert(!o.includes('11 upcoming raids.') && !o.includes('Edit weekly schedule'));
    assert(/\.gs-up-grid \{[^}]*repeat\(auto-fill, minmax\(176px, 1fr\)\)/.test(css) && /\.gs-up-grid \{ grid-template-columns: minmax\(0, 1fr\)/.test(css.slice(css.indexOf('@media (max-width:600px)', css.indexOf('Raids list on Forge')))), '4 across wide, 1 per row on a phone');
  });

  await check('Past table: Date | Raid | Bosses | Attended / bench / missed | Status; no Sources column; one chip word per state; officer-only words', () => {
    const raids = [PAST('r1'), PAST('r2', { state: 'to_review', openFlags: 3 }), PAST('r3', { stale: true, state: 'stale' }), PAST('r4', { state: 'awaiting_log' }), PAST('r5', { state: 'manual' }), PAST('r6', { state: 'upcoming' })];
    const o = page(LIST({ raids }), OFFICER_CAN, { tab: 'past' });
    for (const col of ['Date', 'Raid', 'Bosses', 'Attended / bench / missed', 'Status']) assert(o.includes('>' + col + '<'), col);
    assert(!o.includes('>Sources<') && !o.includes('>Zone<'));
    assert(o.includes('<strong class="gs-rp-zone">Gruul&#39;s Lair</strong><span class="gs-rp-size">25-player</span>'));
    for (const [tone, word] of [['grey', 'Reviewed'], ['rose', '3 to review'], ['rose', 'Needs recalculation'], ['grey', 'Awaiting log'], ['grey', 'No log - by hand'], ['grey', 'Upcoming']]) assert(o.includes('<span class="gs-hd-chip is-' + tone + '">' + word + '</span>'), word);
    assert.equal(count(o, 'gs-hd-chip'), 6, 'one chip per row');
    const m = page(LIST({ raids }), MEMBER_CAN, { tab: 'past' });
    assert(m.includes('is-grey">Reviewed<') && m.includes('is-grey">Awaiting log<') && !m.includes('to review') && !m.includes('Needs recalculation') && !m.includes('No log - by hand') && !m.includes('Upcoming</span>'));
  });

  await check('Past table: 10 rows then "Showing 10 of N" + Show all; Show older raids when the API has more', () => {
    const raids = Array.from({ length: 14 }, (_, i) => PAST('r' + i));
    const o = page(LIST({ raids }), null, { tab: 'past', more: true });
    assert.equal(count(o, 'data-row="'), 10);
    assert(o.includes('Showing 10 of 14 raids') && o.includes('data-action="raids-past-all">Show all 14</button>') && o.includes('data-action="raids-older"'));
    assert.equal(count(page(LIST({ raids }), null, { tab: 'past', showAllPast: true }), 'data-row="'), 14);
    assert(!page(LIST({ raids: [PAST('r1')] }), null, { tab: 'past' }).includes('raids-older'));
  });

  // ── the rail ──
  const S = G.app.state;
  const ST_CHARS = [{ id: 'c_eli', name: 'Eliora', class: 'PRIEST', mainSpec: 'Holy' }, { id: 'c_mir', name: 'Mirabel', class: 'HUNTER', mainSpec: 'Marksmanship' }];
  const STAND = { personId: 'p_e', teams: [{ teamId: 't1', teamName: 'Team KJ', slots: [{ weekday: 5, startTime: '19:00', zone: 'Black Temple', title: null }, { weekday: 6, startTime: '19:00', zone: null, title: null }], characters: ST_CHARS, mine: [{ weekday: 5, kind: 'signed', characterId: null }] }] };
  const standingState = () => ({ gid: 'g1', teamId: 't1', status: 'ok', data: STAND, draft: G.pages.standing.draftFrom(STAND.teams[0]), busy: false, error: '', note: '', message: '', forList: null });
  const AWAY = { team: { id: 't1' }, today: '2026-10-19', until: '2026-11-16', entries: [{ noticeId: 'an_1', personId: 'p_z', name: 'Zzaps', class: 'DRUID', kind: 'away', atTime: null, from: '2026-11-04', to: null, weekday: null, reason: 'Trip', dates: [] }] };
  function withRail(can, over, fn) {
    const saved = { att: S.att, guilds: S.guilds, currentGid: S.currentGid };
    S.guilds = { g1: gd(can) }; S.currentGid = 'g1';
    S.att = { raids: { gid: 'g1', teamId: 't1', data: LIST(over), more: false, tab: 'upcoming' }, standing: standingState() };
    try { return fn(); } finally { Object.assign(S, saved); }
  }
  const mainOf = () => ws(G.pages.raids.main({ name: 'section', gid: 'g1', section: 'raids' }, S.guilds.g1));

  await check('rail (member): Your standing sign-ups with an On row, its "Signed up - My usual character - Change" line, an Off row, Save; no away card, just the away link', () => {
    withRail(MEMBER_CAN, {}, () => {
      const o = mainOf();
      assert(o.includes('<aside class="gs-raids-rail"') && o.includes('Your standing sign-ups'));
      assert(o.includes('>Every Friday 7:00 PM ET<') && o.includes('>Every Saturday 7:00 PM ET<'));
      assert(o.includes('aria-pressed="true"') && o.includes('>On</button>') && o.includes('>Off</button>'));
      assert(o.includes('Signed up - My usual character - <button type="button" class="gs-rl-link" data-action="st-change" data-wd="5"'));
      assert.equal(count(o, 'data-action="st-change"'), 1);
      assert(o.includes('Save standing sign-ups'));
      assert(!o.includes('Away in the next 4 weeks') && !o.includes('away-add') && !o.includes('Create upcoming raids'), 'no away card for a member');
      assert(o.includes('<a class="gs-rl-link" href="#/g/g1/away">Add an away notice</a>'), 'no new call: the link to the page');
    });
  });

  await check('rail (member): with their own notices already read, the line says "You\'re away Nov 4 - Add a notice"', () => {
    withRail(MEMBER_CAN, {}, () => {
      S.att.away = { gid: 'g1', data: { personId: 'p_e', today: '2026-10-19', notices: [{ id: 'n1', kind: 'away', from: '2026-11-04', to: '2026-11-04', weekday: null, reason: null }] }, showPast: false, note: '' };
      const o = mainOf();
      assert(o.includes('You&#39;re away Nov 4 - <a class="gs-rl-link" href="#/g/g1/away">Add a notice</a>'), o.slice(o.indexOf('gs-an-mine')));
    });
  });

  await check('rail (officer who can sign up): BOTH panels - standing sign-ups, then Away in the next 4 weeks (class-coloured names, Edit / Remove) and Create upcoming raids', () => {
    withRail(OFFICER_CAN, { can: { edit: true, signup: true }, schedule: { slots: 2, weeks: 2, auto: false } }, () => {
      S.att.awayTeam = { gid: 'g1', teamId: 't1', status: 'ok', data: AWAY, message: '', forList: null };
      const o = mainOf();
      assert(o.indexOf('Your standing sign-ups') > 0 && o.indexOf('Your standing sign-ups') < o.indexOf('Away in the next 4 weeks'));
      assert(/class="gs-char-link gs-class-druid"[^>]*>Zzaps</.test(o) && o.includes('data-action="away-add" data-ctx="team"') && o.includes('data-action="away-edit"') && o.includes('data-action="away-remove"'));
      assert(o.includes('data-action="raids-fill" data-key="rail-raids-fill">Create upcoming raids</button>'));
      assert(!o.includes('Add an away notice'), 'the member line is the member\'s');
    });
    withRail(OFFICER_CAN, { can: { edit: true, signup: false }, schedule: { slots: 0, weeks: 2, auto: false } }, () => {
      S.att.awayTeam = { gid: 'g1', teamId: 't1', status: 'ok', data: AWAY, message: '', forList: null };
      const o = mainOf();
      assert(!o.includes('Your standing sign-ups') && !o.includes('rail-raids-fill'), 'no person / no schedule: neither panel part');
    });
  });

  await check('standing: toggle flips On / Off in the draft; Change opens the dialog; the dialog Save sends the same body as the panel Save', async () => {
    const calls = [];
    await withRail(MEMBER_CAN, {}, async () => {
      S.currentGid = 'g1';
      const el = (attrs) => ({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false });
      G.handlers.click['st-toggle'](el({ 'data-wd': '6' }));
      assert.deepEqual(S.att.standing.draft.map(r => r.checked), [true, true]);
      let html = '';
      const realOpen = G.ui.openDialog; G.ui.openDialog = (h) => { html = h; return null; };
      G.handlers.click['st-change'](el({ 'data-wd': '5' }));
      G.ui.openDialog = realOpen;
      assert(html.includes('gs-dialog-form') && html.includes('gs-forge') && html.includes('>Every Friday 7:00 PM ET</h2>') && html.includes('id="st-dlg-kind"') && html.includes('id="st-dlg-char"'));
      assert(/gs-btn-ghost[^>]*data-action="dialog-cancel"/.test(html) && count(html, 'gs-btn-molten') === 1);
      const realPut = G.api.standing.save; G.api.standing.save = (gid, tid, body) => { calls.push(JSON.parse(JSON.stringify(body))); return Promise.resolve(STAND.teams[0]); };
      const realGet = G.api.get; G.api.get = () => Promise.resolve(LIST());
      const realClose = G.ui.closeDialogOf; G.ui.closeDialogOf = () => {};
      G.handlers.submit['st' + 'anding-change-form']({ getAttribute: () => '5', elements: { kind: { value: 'late' }, character: { value: 'c_mir' } } });
      await new Promise(r => setTimeout(r, 0));
      G.api.standing.save = realPut; G.api.get = realGet; G.ui.closeDialogOf = realClose;
    });
    assert.deepEqual(calls, [{ slots: [{ weekday: 5, kind: 'late', characterId: 'c_mir' }, { weekday: 6, kind: 'signed' }] }]);
  });

  await check('copy: the rail and cards are ASCII, never say "raid night"; the 600 px rules keep 44 px targets', () => {
    const o = withRail(OFFICER_CAN, { can: { edit: true, signup: true }, schedule: { slots: 2, weeks: 2, auto: false } }, () => { S.att.awayTeam = { gid: 'g1', teamId: 't1', status: 'ok', data: AWAY, message: '', forList: null }; return mainOf(); });
    assert(!/[^\x00-\x7f]/.test(o.replace(/&[a-z#0-9]+;/g, '')) && !/raid night/i.test(o));
    const phone = css.slice(css.indexOf('Raids list on Forge'));
    assert(/\.gs-rl-tog \{ min-height: 44px/.test(phone) && /\.gs-up-status \.gs-btn[^}]*min-height: 44px/.test(phone));
  });

  await check('card: the one link is a stretched link (::after covers the card), the status item sits above it, hover is neutral and only on hover devices', () => {
    const c = cardOf(page(LIST()), 'u1');
    assert.equal(count(c, '<a '), 1);
    assert(c.indexOf('</a>') < c.indexOf('class="gs-up-status"') && !c.slice(c.indexOf('<a '), c.indexOf('</a>')).includes('<button'), 'Sign up is outside the link');
    assert(/\.gs-up \{[^}]*position: relative/.test(css));
    assert(/\.gs-up-link::after \{[^}]*position: absolute; inset: 0/.test(css) && /\.gs-up-link:focus-visible::after \{[^}]*outline: 2px solid var\(--text-primary\); outline-offset: 2px/.test(css));
    assert(/\.gs-up-status \{ position: relative; z-index: 1/.test(css));
    assert(/@media \(hover: hover\) \{ \.gs-up:hover \{[^}]*rgba\(255, 255, 255, 0\.03\)/.test(css));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
