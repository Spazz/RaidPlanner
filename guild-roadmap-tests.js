/**
 * Raidsmith guild - tests for the Future enhancements page (#/roadmap)
 * Run: node guild-roadmap-tests.js
 *
 * The data file (js/guild/roadmap-data.js), the route, the page's markup (js/guild/pages-roadmap.js), the nav item
 * and the breadcrumb, all pure string builders loaded in a vm sandbox the way guild-ui-tests.js does. The routes of the idea
 * box and the triage tool are in guild-roadmap-worker-tests.js; the page driven against fake documents is in guild-shell-tests.js.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

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
const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
vm.createContext(sandbox);
for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
const G = sandbox.Guild;
const P = G.pages.roadmap;
const plain = v => JSON.parse(JSON.stringify(v));

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}

const isRealDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const count = (text, needle) => text.split(needle).length - 1;
const idsIn = html => [...html.matchAll(/\sid="([^"]*)"/g)].map(m => m[1]);
const item = (id, extra) => Object.assign({ id, title: `Title ${id}`, summary: `Summary ${id}.`, area: 'loot', status: 'next', source: 'user', added: '2026-10-01' }, extra || {});
const data = (items, updated) => ({ updated: updated || '2026-10-17', items });
const view = extra => Object.assign(P.freshView(), extra || {});
const idea = (id, extra) => Object.assign({ id, title: `Idea ${id}`, details: null, area: 'planner', status: 'new', roadmapId: null, triageNote: null, createdAt: Date.UTC(2026, 9, 17, 12), mine: false }, extra || {});
const me = { user: { id: 'u1', username: 'alice', displayName: 'Alice' }, guilds: [] };

(async () => {
  // ── the data file ──────────────────────────────────────────────
  await check('roadmap data: unique kebab-case ids, allowed area / status / source, real dates, shipped only on done items', () => {
    const roadmap = G.roadmap;
    assert(isRealDate(roadmap.updated), 'updated is a date');
    assert(Array.isArray(roadmap.items) && roadmap.items.length > 0);
    const keys = new Set(['id', 'title', 'summary', 'area', 'status', 'source', 'added', 'shipped', 'why']);
    const seen = new Set();
    for (const it of roadmap.items) {
      const label = `item ${it.id}`;
      assert.deepEqual(Object.keys(it).filter(k => !keys.has(k)), [], `${label}: unknown field`);
      assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(it.id) && it.id.length <= 80, `${label}: kebab-case id up to 80 characters`);
      assert(!seen.has(it.id), `${label}: duplicate id`);
      seen.add(it.id);
      for (const field of ['title', 'summary']) assert(typeof it[field] === 'string' && it[field].trim() === it[field] && it[field].length > 0, `${label}: ${field} is text`);
      assert(it.title.length <= 80 && it.summary.length <= 450, `${label}: keep the title and the summary short`);
      assert(P.AREAS.includes(it.area), `${label}: area ${it.area}`);
      assert(P.STATUSES.includes(it.status), `${label}: status ${it.status}`);
      assert(P.SOURCES.includes(it.source), `${label}: source ${it.source}`);
      assert(isRealDate(it.added), `${label}: added`);
      if (it.status === 'done') {
        assert(isRealDate(it.shipped), `${label}: a done item has a shipped date`);
        assert(it.added <= it.shipped, `${label}: added is not after shipped`);
      } else {
        assert(!('shipped' in it), `${label}: only a done item has shipped`);
      }
      if ('why' in it) assert(typeof it.why === 'string' && it.why.trim().length > 0, `${label}: why is text when present`);
      assert(it.added <= roadmap.updated && (!it.shipped || it.shipped <= roadmap.updated), `${label}: updated is not older than the item's dates`);
    }
  });

  await check('roadmap data: the vocab is complete (a label for every area and source, a chip for every idea status)', () => {
    assert.deepEqual(plain(P.AREAS), Object.keys(P.AREA_LABELS));
    assert.deepEqual(plain(P.SOURCES), Object.keys(P.SOURCE_LABELS));
    assert.deepEqual(plain(P.SOURCE_LABELS), { user: 'You asked', backlog: 'Agreed backlog', pm: 'Product Manager idea' });
    assert.deepEqual(plain(P.STATUSES), ['in_progress', 'next', 'idea', 'done']);
    assert.deepEqual(Object.keys(P.IDEA_STATUS), ['new', 'added', 'declined', 'done']);
    assert.equal(new Set(P.AREAS).size, P.AREAS.length);
  });

  // ── route ──────────────────────────────────────────────────────
  await check('router: #/roadmap parses and formats, ignores a query, and does not swallow other paths', () => {
    const parse = h => plain(G.router.parse(h));
    assert.deepEqual(parse('#/roadmap'), { name: 'roadmap' });
    assert.deepEqual(parse('#/roadmap/'), { name: 'roadmap' });
    assert.deepEqual(parse('#/roadmap?area=loot'), { name: 'roadmap' });
    assert.equal(G.router.format({ name: 'roadmap' }), '#/roadmap');
    assert.deepEqual(plain(G.router.parse(G.router.format({ name: 'roadmap' }))), { name: 'roadmap' });
    for (const h of ['#/roadmap/x', '#/roadmaps', '#/g/g1/roadmap']) assert.equal(G.router.parse(h).name, 'notfound', h);
    assert.deepEqual(parse('#/privacy'), { name: 'privacy' });
  });

  // ── nav and breadcrumb ─────────────────────────────────────────
  const guildData = { guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'EU', realmKind: 'realm', gameVersion: 'tbc' }, teams: [{ id: 't1', name: 'Main', size: 25, archived: false }], me: { roles: [{ role: 'member' }], can: { 'roster.view': 'guild' } } };
  const signedIn = { user: { id: 'u1', username: 'alice', displayName: 'Alice', prefs: {} }, guilds: [{ id: 'g1', name: 'Ravens' }], create: { allowed: false } };
  const shells = {
    'signed out': { section: 'guild', page: 'app', me: null, signedOut: true, route: { name: 'roadmap' }, guildData: null },
    'signed in, no guild': { section: 'guild', page: 'app', me: Object.assign({}, signedIn, { guilds: [] }), route: { name: 'roadmap' }, guildData: null },
    'signed in with a guild': { section: 'guild', page: 'app', me: signedIn, route: { name: 'roadmap' }, guildData, teamId: 't1' },
  };

  await check('nav: Future enhancements sits in the help group for everyone, links to #/roadmap, and is the current item on the roadmap route', () => {
    for (const [label, ctx] of Object.entries(shells)) {
      const items = G.shell.sidebarItems(ctx);
      const help = items[items.length - 1];
      assert.equal(help.key, 'help', label + ': the one Help item closes the sidebar');
      assert.deepEqual(plain(help.children.map(i => i.key)), ['whats-new', 'roadmap', 'how-it-works', 'faq'], label);
      const entry = help.children.filter(i => i.key === 'roadmap')[0];
      assert.equal(entry.label, 'Future enhancements');
      assert.equal(entry.href, '#/roadmap');
      assert(G.icons.names.includes(entry.icon));
      const slots = G.shell.slots(ctx);
      for (const [where, html] of [['sidebar', slots.sidebar], ['drawer', slots.drawer]]) {
        assert(/<a class="gs-nav-link is-active" href="#\/roadmap" aria-label="Future enhancements" aria-current="page">/.test(html), `${label}: ${where} link is current`);
        assert(html.includes('Future enhancements') && html.includes('Roadmap'), `${label}: ${where} labels`);
        assert.equal(count(html, 'href="#/roadmap"'), 1, `${label}: ${where} has one roadmap link`);
      }
    }
  });

  await check('nav: on the planner and the static pages the link is absolute and not current; the phone tabs do not carry it', () => {
    for (const ctx of [{ section: 'planner', page: 'app', me: null }, { section: 'page', page: 'faq', me: signedIn, guildData, teamId: 't1' }]) {
      const html = G.shell.slots(ctx).sidebar;
      const expected = ctx.section === 'page' ? '/#/roadmap' : '#/roadmap';
      assert(html.includes(`href="${expected}" aria-label="Future enhancements">`), ctx.section);
      assert(!html.includes('href="' + expected + '" aria-label="Future enhancements" aria-current'), ctx.section);
    }
    assert(!G.shell.slots(shells['signed in with a guild']).tabs.includes('roadmap'));
    assert(G.icons.icon('roadmap', 20).includes('<path') && G.icons.icon('roadmap', 20).includes('<circle'));
  });

  await check('breadcrumb: the roadmap is one crumb, signed in or out, and the phone title names it', () => {
    for (const [label, ctx] of Object.entries(shells)) {
      assert.deepEqual(plain(G.shell.breadcrumbItems(ctx)), [{ label: 'Future enhancements' }], label);
    }
    assert(G.shell.slots(shells['signed out']).lead.includes('>Future enhancements<'));
  });

  // ── page: sections ─────────────────────────────────────────────
  await check('page: title, intro line, last updated, and the four sections in order; signed out sees the same sections', () => {
    const out = P.roadmapHtml({ me: null });
    assert.equal(count(out, '<h1'), 1);
    assert(out.includes('<h1 class="gs-h1" tabindex="-1">Future enhancements</h1>'));
    assert(out.includes('What&#39;s being built next and ideas under review. Updated as work ships.') || out.includes('What\'s being built next and ideas under review. Updated as work ships.'));
    assert(out.includes('Last updated ' + G.ui.formatDay(G.roadmap.updated)));
    const at = ['In progress', 'Next up', 'Ideas', 'Shipped'].map(t => out.indexOf(`>${t} <span class="gs-rm-count">`));
    assert(at.every(i => i > 0) && at.every((i, n) => n === 0 || at[n - 1] < i), 'sections in order: ' + at.join(','));
    assert.equal(count(out, '<h2 '), 5, 'Suggest an idea (the sign-in line) and the four sections');
    assert(/aria-labelledby="rm-h-in_progress"/.test(out) && out.includes('id="rm-h-done"'));
    for (const it of G.roadmap.items) assert(out.includes(`id="rm-item-${it.id}"`) && out.includes(`>${it.title.replace(/'/g, '&#39;')}</h3>`), it.id);
    assert.equal(count(out, '<li class="gs-rm-card"'), G.roadmap.items.length);
  });

  await check('page: a card shows title, summary, an area chip, a source chip and the added or shipped date; why only when given', () => {
    const out = P.roadmapHtml({
      me: null,
      data: data([
        item('a', { status: 'idea', area: 'planner', source: 'backlog', why: 'It is faint today.' }),
        item('b', { status: 'idea', area: 'signups', source: 'pm', added: '2026-09-30' }),
        item('c', { status: 'done', area: 'raids', source: 'user', added: '2026-10-02', shipped: '2026-10-05' }),
      ]),
    });
    const card = id => out.slice(out.indexOf(`id="rm-item-${id}"`), out.indexOf('</li>', out.indexOf(`id="rm-item-${id}"`)));
    assert(card('a').includes('<h3 class="gs-rm-title">Title a</h3>') && card('a').includes('Summary a.'));
    assert(card('a').includes('<span class="gs-chip">Planner</span>') && card('a').includes('<span class="gs-chip gs-chip-src">Agreed backlog</span>'));
    assert(card('a').includes('Added Oct 1, 2026') && card('a').includes('It is faint today.'));
    assert(card('b').includes('Sign-ups') && card('b').includes('Product Manager idea') && card('b').includes('Added Sep 30, 2026'));
    assert(!card('b').includes('gs-rm-why'));
    assert(card('c').includes('You asked') && card('c').includes('Shipped Oct 5, 2026') && !card('c').includes('Added'));
  });

  await check('page: Shipped is a closed <details> by default, newest first; it opens when the view says so', () => {
    const items = [
      item('old', { status: 'done', shipped: '2026-10-01', added: '2026-10-01' }),
      item('new', { status: 'done', shipped: '2026-10-09', added: '2026-10-01' }),
      item('mid', { status: 'done', shipped: '2026-10-05', added: '2026-10-01' }),
      item('tie-a', { status: 'done', shipped: '2026-10-05', added: '2026-10-01' }),
    ];
    const closed = P.roadmapHtml({ me: null, data: data(items) });
    assert(/<details class="gs-how gs-rm-shipped"><summary data-action="roadmap-shipped" data-key="rm-shipped">Show shipped items<\/summary>/.test(closed));
    const order = ['new', 'mid', 'tie-a', 'old'].map(id => closed.indexOf(`id="rm-item-${id}"`));
    assert(order.every((i, n) => i > 0 && (n === 0 || order[n - 1] < i)), 'newest first, ties keep the file order: ' + order.join(','));
    assert(!/<details[^>]* open/.test(closed));
    assert(/<details class="gs-how gs-rm-shipped" open>/.test(P.roadmapHtml({ me: null, data: data(items), view: view({ shippedOpen: true }) })));
    assert.equal(count(closed, '<details'), 1, 'only Shipped is collapsed');
  });

  await check('page: a section with nothing in it says so', () => {
    const out = P.roadmapHtml({ me: null, data: data([item('only', { status: 'next' })]) });
    for (const t of ['Nothing is in progress right now.', 'No ideas are under review.', 'Nothing has shipped yet.']) assert(out.includes(t), t);
    assert(!out.includes('Nothing is lined up next.'));
  });

  // ── page: area filter ──────────────────────────────────────────
  await check('filter: real buttons in a labelled group, All plus each area that has items, aria-pressed on the current one', () => {
    const items = [item('a', { area: 'loot' }), item('b', { area: 'loot' }), item('c', { area: 'planner' })];
    const out = P.roadmapHtml({ me: null, data: data(items) });
    const group = out.slice(out.indexOf('<div class="gs-segs gs-rm-filters"'), out.indexOf('</div>', out.indexOf('gs-rm-filters')));
    assert(group.includes('role="group" aria-label="Filter by area"'));
    const buttons = [...group.matchAll(/<button type="button" class="gs-seg" data-action="roadmap-area" data-area="([^"]+)" data-key="rm-area-[^"]+" aria-pressed="(true|false)">([^<]*) <span class="gs-seg-count">(\d+)<\/span><\/button>/g)];
    assert.deepEqual(buttons.map(m => [m[1], m[2], m[3], m[4]]), [['all', 'true', 'All', '3'], ['loot', 'false', 'Loot', '2'], ['planner', 'false', 'Planner', '1']]);
    const loot = P.roadmapHtml({ me: null, data: data(items), view: view({ area: 'loot' }) });
    assert(/data-area="loot"[^>]*aria-pressed="true"/.test(loot) && /data-area="all"[^>]*aria-pressed="false"/.test(loot));
    assert.equal(count(loot, '<li class="gs-rm-card"'), 2, 'only the loot cards');
    assert.equal(count(loot, 'Nothing here for this area.'), 3, 'In progress, Ideas and Shipped are empty for Loot');
  });

  await check('filter: an area with no items, or an unknown one, shows everything; a filtered empty section says so', () => {
    const items = [item('a', { area: 'loot', status: 'next' }), item('b', { area: 'planner', status: 'idea' })];
    for (const area of ['other', 'nope', '', null, undefined]) {
      const out = P.roadmapHtml({ me: null, data: data(items), view: view({ area }) });
      assert.equal(count(out, '<li class="gs-rm-card"'), 2, String(area));
      assert(/data-area="all"[^>]*aria-pressed="true"/.test(out));
    }
    const planner = P.roadmapHtml({ me: null, data: data(items), view: view({ area: 'planner' }) });
    assert.equal(count(planner, 'Nothing here for this area.'), 3, 'In progress, Next up and Shipped are empty for Planner');
  });

  await check('page: every item field is escaped (title, summary, why, ids, labels, dates)', () => {
    const hostile = item(`x"><img src=x onerror=1>`, {
      title: HOSTILE + QUOTES, summary: HOSTILE + QUOTES, why: HOSTILE + QUOTES, area: HOSTILE, source: HOSTILE, status: 'done', added: HOSTILE, shipped: QUOTES,
    });
    assertEscaped(P.roadmapHtml({ me: null, data: data([hostile], HOSTILE) }), 'roadmap');
    assertEscaped(P.roadmapHtml({ me, data: data([hostile]), view: view({ draft: { title: HOSTILE + QUOTES, area: HOSTILE, details: HOSTILE + QUOTES }, notice: HOSTILE }) }), 'form');
  });

  // ── page: signed out / signed in ───────────────────────────────
  await check('signed out: a sign-in link replaces the form, and there is no ideas list', () => {
    const out = P.roadmapHtml({ me: null });
    assert(out.includes('<a href="#/signin">Sign in to suggest an idea</a>'));
    for (const gone of ['<form', 'data-submit="roadmap-idea"', 'Submitted ideas', 'id="rm-ideas"', 'id="rm-title"']) assert(!out.includes(gone), gone);
    assert.equal(P.roadmapHtml({ me: {} }).includes('<form'), false, 'a me without a user is signed out');
  });

  await check('signed in: the Suggest an idea form sits below the intro and above the filters and sections, with real labels', () => {
    const out = P.roadmapHtml({ me });
    assert(out.indexOf('Last updated') < out.indexOf('Suggest an idea') && out.indexOf('Suggest an idea') < out.indexOf('Submitted ideas'));
    assert(out.indexOf('Submitted ideas') < out.indexOf('gs-rm-filters') && out.indexOf('gs-rm-filters') < out.indexOf('>In progress <'));
    assert(/<form class="gs-rm-form" data-submit="roadmap-idea" aria-labelledby="rm-suggest-h" novalidate>/.test(out));
    assert(/<label class="gs-label" for="rm-title">Title<\/label><input class="gs-input" type="text" id="rm-title" name="title"[^>]*maxlength="120"[^>]*required/.test(out));
    assert(/<label class="gs-label" for="rm-area">Area<\/label><select class="gs-input" id="rm-area" name="area"/.test(out));
    assert(/<label class="gs-label" for="rm-details">Details \(optional\)<\/label><textarea class="gs-input gs-textarea" id="rm-details" name="details" rows="4" maxlength="2000"/.test(out));
    assert(/<button type="submit" class="gs-btn gs-btn-molten" data-key="rm-submit">Submit idea<\/button>/.test(out));
    assert(out.includes('<span class="gs-rm-status" id="rm-status" role="status"></span>'));
    assert(out.includes('id="rm-title-error" role="alert" hidden') && out.includes('id="rm-area-error" role="alert" hidden') && out.includes('id="rm-details-error" role="alert" hidden'));
    assert(out.includes('<option value="" selected>Choose an area</option>'));
    const optionValues = [...out.slice(out.indexOf('id="rm-area"'), out.indexOf('</select>')).matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
    assert.deepEqual(optionValues, ['', ...P.AREAS]);
  });

  await check('signed in: a draft and the thanks line come back into the form (escaped), the area is reselected', () => {
    const out = P.roadmapHtml({ me, view: view({ draft: { title: 'Dark "mode"', area: 'loot', details: 'Line one\nLine two' }, notice: P.THANKS }) });
    assert(out.includes('value="Dark &quot;mode&quot;"'));
    assert(out.includes('<option value="loot" selected>Loot</option>'));
    assert(out.includes('>Line one\nLine two</textarea>'));
    assert(out.includes('role="status">Thanks - your idea is saved and will be reviewed.</span>'));
  });

  await check('signed in: ids are unique and every aria-labelledby / aria-describedby points at one', () => {
    const out = P.roadmapHtml({ me, view: view({ ideas: { status: 'ok', list: [idea('ri_1'), idea('ri_2', { status: 'added', roadmapId: 'loot-history' })], error: '' } }) });
    const ids = idsIn(out);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate ids');
    for (const m of out.matchAll(/aria-(?:labelledby|describedby)="([^"]*)"/g)) for (const id of m[1].split(' ')) assert(ids.includes(id), `missing target ${id}`);
  });

  await check('validate: the same limits the Worker enforces (title 3-120, an area from the list, details up to 2000)', () => {
    const ok = { title: 'abc', area: 'other', details: '' };
    assert.deepEqual(plain(P.validate(ok)), {});
    assert.deepEqual(Object.keys(P.validate({ title: 'ab', area: 'other', details: '' })), ['title']);
    assert.deepEqual(Object.keys(P.validate({ title: '  ab  ', area: 'other', details: '' })), ['title'], 'trimmed first');
    assert.deepEqual(plain(P.validate(Object.assign({}, ok, { title: 'x'.repeat(120) }))), {});
    assert.deepEqual(Object.keys(P.validate(Object.assign({}, ok, { title: 'x'.repeat(121) }))), ['title']);
    assert.deepEqual(plain(P.validate(Object.assign({}, ok, { title: '\u{1F600}'.repeat(120) }))), {}, 'characters, not UTF-16 units');
    for (const area of ['', 'nope', undefined, 'LOOT']) assert.deepEqual(Object.keys(P.validate({ title: 'abc', area, details: '' })), ['area'], String(area));
    assert.deepEqual(plain(P.validate(Object.assign({}, ok, { details: 'd'.repeat(2000) }))), {});
    assert.deepEqual(Object.keys(P.validate(Object.assign({}, ok, { details: 'd'.repeat(2001) }))), ['details']);
    assert.deepEqual(Object.keys(P.validate({ title: '', area: '', details: 'd'.repeat(2001) })).sort(), ['area', 'details', 'title']);
  });

  // ── page: submitted ideas ──────────────────────────────────────
  await check('ideas: loading, error with a retry button, and the empty line', () => {
    const inner = ideas => P.ideasInnerHtml(view({ ideas }), G.roadmap.items);
    assert(inner({ status: 'loading', list: [], error: '' }).includes('Loading the submitted ideas...'));
    const failed = inner({ status: 'error', list: [], error: 'Could not reach Raidsmith. ' + HOSTILE });
    assert(failed.includes('role="alert">The submitted ideas could not be loaded. Could not reach Raidsmith.'));
    assert(/data-action="roadmap-ideas-retry" data-key="rm-ideas-retry">Try again<\/button>/.test(failed));
    assertEscaped(failed, 'error');
    assert(inner({ status: 'ok', list: [], error: '' }).includes('No ideas yet. Yours can be the first.'));
    assert(inner({ status: 'ok', list: [], error: '' }).startsWith('<h2 class="gs-h2 gs-h2-plain" id="rm-ideas-h">Submitted ideas</h2>'));
    const both = inner({ status: 'error', list: [idea('ri_1')], error: 'x' });
    assert(both.includes('could not be loaded') && both.includes('Idea ri_1'), 'a failed refresh keeps the list that was read');
  });

  await check('ideas: each status has its chip; Added and Done link to the roadmap item only when it exists on the page', () => {
    const items = [item('loot-history', { area: 'loot' })];
    const out = P.ideasInnerHtml(view({ ideas: { status: 'ok', error: '', list: [
      idea('ri_new'),
      idea('ri_added', { status: 'added', roadmapId: 'loot-history' }),
      idea('ri_lost', { status: 'added', roadmapId: 'not-on-the-page' }),
      idea('ri_declined', { status: 'declined', triageNote: 'Out of scope for now.' }),
      idea('ri_done', { status: 'done', roadmapId: 'loot-history', triageNote: 'Shipped as loot history.' }),
    ] } }), items);
    const card = id => out.slice(out.indexOf(`>Idea ${id}</h3>`), out.indexOf('</li>', out.indexOf(`>Idea ${id}</h3>`)));
    assert(card('ri_new').includes('gs-pill gs-pill-info">New</span>') && card('ri_new').includes('Waiting for review'));
    assert(card('ri_added').includes('gs-pill gs-pill-ok">Added to the roadmap</span>'));
    assert(/<a href="#\/roadmap" data-action="roadmap-goto" data-item="loot-history">See it on the roadmap<\/a>/.test(card('ri_added')));
    assert(card('ri_lost').includes('Added to the roadmap') && !card('ri_lost').includes('roadmap-goto'));
    assert(card('ri_declined').includes('gs-pill gs-pill-muted">Declined</span>') && card('ri_declined').includes('Note: Out of scope for now.'));
    assert(card('ri_done').includes('gs-pill gs-pill-ok">Done</span>') && card('ri_done').includes('roadmap-goto') && card('ri_done').includes('Note: Shipped as loot history.'));
    assert(!card('ri_new').includes('Note:'));
    assert(card('ri_new').includes('<span class="gs-chip">Planner</span>') && card('ri_new').includes('Submitted Oct 17, 2026'));
  });

  await check('ideas: Yours chip for the viewer\'s own, details keep line breaks, unknown status reads as New', () => {
    const out = P.ideasInnerHtml(view({ ideas: { status: 'ok', error: '', list: [idea('ri_mine', { mine: true, details: 'One\nTwo' }), idea('ri_odd', { status: 'weird' })] } }), []);
    const mine = out.slice(out.indexOf('>Idea ri_mine<'), out.indexOf('</li>'));
    assert(mine.includes('<span class="gs-chip gs-chip-plain">Yours</span>') && mine.includes('<p class="gs-rm-summary gs-rm-details">One\nTwo</p>'));
    assert.equal(count(out, 'Yours'), 1);
    assert(out.slice(out.indexOf('>Idea ri_odd<')).includes('>New</span>'));
  });

  await check('ideas: the newest five show, with a Show all button that toggles; no button for five or fewer', () => {
    const list = Array.from({ length: 7 }, (_, i) => idea(`ri_${i}`));
    const shortened = P.ideasInnerHtml(view({ ideas: { status: 'ok', list, error: '' } }), []);
    assert.equal(count(shortened, '<li class="gs-rm-card"'), 5);
    assert(/data-action="roadmap-ideas-all" data-key="rm-ideas-all" aria-expanded="false">Show all 7 ideas<\/button>/.test(shortened));
    const all = P.ideasInnerHtml(view({ ideasAll: true, ideas: { status: 'ok', list, error: '' } }), []);
    assert.equal(count(all, '<li class="gs-rm-card"'), 7);
    assert(/aria-expanded="true">Show fewer ideas<\/button>/.test(all));
    assert(!P.ideasInnerHtml(view({ ideas: { status: 'ok', list: list.slice(0, 5), error: '' } }), []).includes('roadmap-ideas-all'));
  });

  await check('ideas: every submitted field is escaped', () => {
    const hostile = idea(HOSTILE + QUOTES, { title: HOSTILE + QUOTES, details: HOSTILE + QUOTES, area: HOSTILE, status: HOSTILE, roadmapId: HOSTILE + QUOTES, triageNote: HOSTILE + QUOTES, createdAt: 'x', mine: true });
    assertEscaped(P.ideasInnerHtml(view({ ideas: { status: 'ok', list: [hostile], error: '' } }), [item(HOSTILE + QUOTES)]), 'ideas');
    assertEscaped(P.ideasInnerHtml(view({ ideas: { status: 'ok', list: [idea('ri_x', { status: 'added', roadmapId: 'a"b' })], error: '' } }), [item('a"b')]), 'linked id');
  });

  await check('page: the unauthenticated and authenticated pages share the same roadmap sections and cards', () => {
    const strip = html => html.slice(html.indexOf('<div class="gs-segs gs-rm-filters"'));
    assert.equal(strip(P.roadmapHtml({ me: null })), strip(P.roadmapHtml({ me })));
  });

  await check('guild.css has a rule for every gs-rm class the page uses, a phone rule, and no custom properties of its own', () => {
    const css = read('guild.css');
    const used = new Set();
    for (const m of read('js/guild/pages-roadmap.js').matchAll(/class="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) if (/^gs-[a-z0-9_-]+$/.test(c)) used.add(c);
    const defined = new Set([...css.matchAll(/\.(gs-[a-z0-9_-]+)/g)].map(m => m[1]));
    assert.deepEqual([...used].filter(c => !defined.has(c)), []);
    const from = css.indexOf('Future enhancements (#/roadmap)');
    const block = css.slice(from, css.indexOf('/* ── Loot (Phase 4)', from)); // the roadmap section alone: the sections after it have their own tokens
    assert(/@media \(max-width: 600px\)/.test(block) && !/(^|[;{\s])--[\w-]+\s*:/.test(block));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
