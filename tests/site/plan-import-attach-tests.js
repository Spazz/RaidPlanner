/**
 * Raidsmith - Raid-Helper import attach tests (guild raid plans in the database, import by a signed-in officer)
 * Run: node tests/site/plan-import-attach-tests.js
 *
 * Runs PlanAttach and runImport (js/modals.js) in a vm sandbox with the real logic half, a fake guild shell (Guild.app, Guild.api,
 * the raids page's planInPlanner, plannerLanding.planTeams, the real router and ui) and a fake document. Covers: the gate (no event id,
 * signed out, no raids.edit, a skipped event: no network call at all), a found raid opening its plan with the notice, no raid showing
 * the offer (detail line, team select when several), Create (success, other_server then retry, raid_exists then open that raid), Skip
 * remembered for the session, a failed lookup falling back to the standalone flow silently, and the markup the offer needs.
 */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../load-app');

const ATTACH_SOURCE = app.slice('// ── RAID-HELPER IMPORT ATTACH', '// ── SHARED IMPORT RUNNER');
const RUNNER_SOURCE = app.slice('// ── SHARED IMPORT RUNNER', "document.getElementById('btn-plain-import-cancel')");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err && err.stack || err}`); }
}

// The guild's own router and ui, loaded the way the page loads them.
function loadGuildParts() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['router.js', 'ui.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'guild', file), 'utf8'), sandbox, { filename: file });
  return sandbox.Guild;
}
const guildParts = loadGuildParts();

const EVENT = '1483258698854826006';
const START = Date.UTC(2026, 9, 21, 0, 0, 0); // Tue Oct 20 8 PM ET = Wed Oct 21 00:00 UTC
function metadata(extra = {}) {
  return { title: 'Gruul night', startTime: START / 1000, signUps: [{ className: 'Mage' }, { className: 'Priest' }, { className: 'Absence' }], ...extra };
}

class ApiErr extends Error {
  constructor(status, code, message, body = {}) { super(message); this.status = status; this.code = code; this.body = body; }
}

// One fake page: a fake document with the offer's elements, a fake signed-in shell, a recorder for every API call and planInPlanner.
function makeEnv({ signedIn = true, guilds = null, lookup = {}, post = null } = {}) {
  const els = {};
  const element = id => (els[id] = els[id] || { id, hidden: true, textContent: '', disabled: false, innerHTML: '', value: '', classes: new Set(),
    classList: { toggle(c, on) { on ? els[id].classes.add(c) : els[id].classes.delete(c); } }, addEventListener() {} });
  const env = { calls: [], posts: [], planned: [], toasts: [], els, element };
  const defaultGuilds = {
    g1: { guild: { name: 'Raidsmith Guild', timeZone: 'America/New_York' }, teams: [{ id: 't1', name: 'Main' }], me: { can: {} }, canEdit: ['t1'] },
  };
  const gdata = guilds || defaultGuilds;
  env.fetchedGuilds = [];
  const Guild = {
    ...guildParts,
    app: {
      state: { me: signedIn ? { guilds: Object.keys(gdata).map(id => ({ id })) } : null, guilds: Object.fromEntries(Object.entries(gdata).map(([id, g]) => [id, g])) },
      fetchGuild(gid) { env.fetchedGuilds.push(gid); return Promise.reject(new Error('no network in this test')); },
    },
    api: {
      get(url) {
        env.calls.push(url);
        const gid = /\/api\/guild\/([^/]+)\//.exec(url)[1];
        const answer = lookup[gid];
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer || { raid: null });
      },
      post(url, body) {
        env.posts.push({ url, body });
        const out = typeof post === 'function' ? post(url, body, env.posts.length) : { raid: { id: 'r_new' } };
        return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
      },
      classify(err) { return { view: 'inline', title: '', text: err && err.message ? err.message : 'Something went wrong.' }; },
    },
    pages: {
      raids: {
        planInPlanner(gid, rid, event) { env.planned.push(JSON.parse(JSON.stringify({ gid, rid, event }))); return Promise.resolve(true); },
      },
      raidNew: { createBody: (form, accept) => ({ teamId: form.teamId, eventSource: form.event, ...(accept ? { acceptOtherServer: true } : {}) }) },
      plannerLanding: { planTeams: gd => (gd.canEdit || []).map(id => gd.teams.find(t => t.id === id)).filter(Boolean) },
    },
  };
  const store = {};
  const sessionStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const document = { getElementById: id => element(id) };
  const window = { Guild };
  const showToast = msg => env.toasts.push(msg);
  const importer = { next: null };
  const importFromText = async text => { if (importer.next) importer.next(text); return importer.result !== false; };
  const c = app.sandbox(['PlanAttach', 'runImport', 'State', 'PlanStore'], {
    globals: { document, window, sessionStorage, showToast, importFromText, normalizeImportSource: () => ({}) },
    extraSource: ATTACH_SOURCE + RUNNER_SOURCE,
  });
  env.api = c.api;
  env.importer = importer;
  env.session = store;
  // An import of EVENT: what importFromText leaves behind (State plan id, the event it read) and what runImport then does.
  env.importEvent = async (eventId = EVENT, meta = metadata()) => {
    const { State, PlanAttach, runImport } = c.api;
    importer.next = () => { State.planId = 'event:' + eventId; PlanAttach.noteEvent(eventId, meta); };
    element('inp').value = 'https://raid-helper.dev/event/' + eventId;
    element('btn').disabled = false;
    element('btn').setAttribute = () => {};
    element('btn').removeAttribute = () => {};
    element('st').classList = { toggle() {} };
    await runImport('inp', 'st', 'btn', () => {});
    await new Promise(resolve => setImmediate(resolve)); // afterImport runs on its own
    await new Promise(resolve => setImmediate(resolve));
  };
  return env;
}
const lookupUrl = (gid = 'g1', event = EVENT) => `/api/guild/${gid}/raid-for-event?event=${event}`;

(async () => {
  await check('gate: signed out makes no API call and no offer', async () => {
    const env = makeEnv({ signedIn: false });
    await env.importEvent();
    assert.deepEqual(env.calls, []);
    assert.deepEqual(env.posts, []);
    assert.equal(env.element('attach-banner').hidden, true);
    assert.deepEqual(env.planned, []);
  });

  await check('gate: an import without an event id (pasted JSON, addon string) makes no API call', async () => {
    const env = makeEnv();
    const { State, runImport } = env.api;
    env.importer.next = () => { State.planId = null; };
    env.element('inp').value = '{"signUps":[]}';
    env.element('btn').setAttribute = () => {}; env.element('btn').removeAttribute = () => {};
    env.element('st').classList = { toggle() {} };
    await runImport('inp', 'st', 'btn', () => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.calls, []);
    assert.equal(env.element('attach-banner').hidden, true);
  });

  await check('gate: a plan on screen that is not the event\'s makes no API call', async () => {
    const env = makeEnv();
    const { State, PlanAttach, runImport } = env.api;
    env.importer.next = () => { State.planId = 'event:999999999'; PlanAttach.noteEvent(EVENT, metadata()); };
    env.element('inp').value = 'x';
    env.element('btn').setAttribute = () => {}; env.element('btn').removeAttribute = () => {};
    env.element('st').classList = { toggle() {} };
    await runImport('inp', 'st', 'btn', () => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.calls, []);
  });

  await check('gate: signed in without raids.edit on any team makes no lookup', async () => {
    const env = makeEnv({ guilds: { g1: { guild: { name: 'G', timeZone: 'America/New_York' }, teams: [{ id: 't1', name: 'Main' }], me: { can: {} }, canEdit: [] } } });
    await env.importEvent();
    assert.deepEqual(env.calls, []);
    assert.equal(env.element('attach-banner').hidden, true);
  });

  await check('a failed import (importFromText false) does nothing', async () => {
    const env = makeEnv();
    env.importer.result = false;
    await env.importEvent();
    assert.deepEqual(env.calls, []);
  });

  await check('found: the raid\'s plan opens through planInPlanner with the event and the notice says so', async () => {
    const env = makeEnv({ lookup: { g1: { raid: { id: 'r7', raidOn: '2099-01-01', title: 'Gruul night', teamId: 't1' } } } });
    await env.importEvent();
    assert.deepEqual(env.calls, [lookupUrl()]);
    assert.deepEqual(env.planned, [{ gid: 'g1', rid: 'r7', event: { id: EVENT, otherServer: false } }]);
    assert.deepEqual(env.toasts, ["Opened the raid's plan."]);
    assert.equal(env.element('attach-banner').hidden, true);
    assert.deepEqual(env.posts, []);
  });

  await check('found on a past raid: the plan opens without re-reading the event', async () => {
    const env = makeEnv({ lookup: { g1: { raid: { id: 'r7', raidOn: '2020-01-01', teamId: 't1' } } } });
    await env.importEvent();
    assert.deepEqual(env.planned, [{ gid: 'g1', rid: 'r7', event: null }]);
    assert.deepEqual(env.toasts, ["Opened the raid's plan."]);
  });

  await check('found: the answer of a later guild is used (up to 5 guilds are asked)', async () => {
    const mk = name => ({ guild: { name, timeZone: 'UTC' }, teams: [{ id: 't1', name: 'Main' }], me: { can: {} }, canEdit: ['t1'] });
    const guilds = { g1: mk('A'), g2: mk('B'), g3: mk('C'), g4: mk('D'), g5: mk('E'), g6: mk('F') };
    const env = makeEnv({ guilds, lookup: { g2: { raid: { id: 'r2', raidOn: '2099-01-01', teamId: 't1' } }, g6: { raid: { id: 'r6', raidOn: '2099-01-01', teamId: 't1' } } } });
    await env.importEvent();
    assert.deepEqual(env.calls, [lookupUrl('g1'), lookupUrl('g2')]);
    assert.equal(env.planned[0].gid, 'g2');
    const env2 = makeEnv({ guilds, lookup: { g6: { raid: { id: 'r6', raidOn: '2099-01-01', teamId: 't1' } } } });
    await env2.importEvent();
    assert.equal(env2.calls.length, 5, 'the sixth guild is never asked');
    assert.equal(env2.planned.length, 0);
    assert.equal(env2.element('attach-banner').hidden, false);
  });

  await check('none: the import stays standalone and the offer shows the event, its time in the guild zone and the sign-up count', async () => {
    const env = makeEnv();
    await env.importEvent();
    assert.deepEqual(env.planned, []);
    const banner = env.element('attach-banner');
    assert.equal(banner.hidden, false);
    assert.equal(env.element('attach-banner-text').textContent, 'Create a raid for this event?');
    assert.equal(env.element('attach-banner-detail').textContent, 'Gruul night, Tue Oct 20, 8:00 PM ET, 2 sign-ups');
    assert.equal(env.element('btn-attach-create').textContent, 'Create a raid');
    assert.equal(env.element('attach-team-field').hidden, true, 'one team: no select');
    assert.deepEqual(env.posts, []);
  });

  await check('none with several teams: a team select lists them (guild name too with several guilds), the pick is what Create posts', async () => {
    const guilds = {
      g1: { guild: { name: 'Alpha', timeZone: 'America/New_York' }, teams: [{ id: 't1', name: 'Main' }, { id: 't2', name: 'Alts' }], me: { can: {} }, canEdit: ['t1', 't2'] },
      g2: { guild: { name: 'Beta', timeZone: 'Europe/Berlin' }, teams: [{ id: 't9', name: 'Raid' }], me: { can: {} }, canEdit: ['t9'] },
    };
    const env = makeEnv({ guilds });
    await env.importEvent();
    assert.equal(env.element('attach-team-field').hidden, false);
    const html = env.element('attach-team').innerHTML;
    assert.match(html, /Alpha - Main/);
    assert.match(html, /Alpha - Alts/);
    assert.match(html, /Beta - Raid/);
    env.api.PlanAttach.pickTarget(2);
    assert.match(env.element('attach-banner-detail').textContent, /Wed Oct 21, 2:00 AM CEST|Wed Oct 21, 2:00 AM CET/, 'the time follows the chosen guild\'s zone');
    await env.api.PlanAttach.create();
    assert.deepEqual(env.posts, [{ url: '/api/guild/g2/raids', body: { teamId: 't9', eventSource: EVENT } }]);
  });

  await check('Create success: POST /raids {teamId, eventSource}, then the new raid\'s plan opens without a second event read', async () => {
    const env = makeEnv();
    await env.importEvent();
    await env.api.PlanAttach.create();
    assert.deepEqual(env.posts, [{ url: '/api/guild/g1/raids', body: { teamId: 't1', eventSource: EVENT } }]);
    assert.deepEqual(env.planned, [{ gid: 'g1', rid: 'r_new', event: null }]);
    assert.equal(env.element('attach-banner').hidden, true);
    assert.deepEqual(env.toasts, ['Created the raid and opened its plan.']);
  });

  await check('Create: a second click while it runs posts once', async () => {
    const env = makeEnv();
    await env.importEvent();
    const first = env.api.PlanAttach.create();
    const second = env.api.PlanAttach.create();
    await Promise.all([first, second]);
    assert.equal(env.posts.length, 1);
  });

  await check('Create other_server: the offer says it, "Import anyway" retries with acceptOtherServer', async () => {
    const env = makeEnv({ post: (url, body, n) => (n === 1 ? new ApiErr(409, 'other_server', 'That event was posted in a different Discord server.') : { raid: { id: 'r_new' } }) });
    await env.importEvent();
    await env.api.PlanAttach.create();
    assert.equal(env.element('attach-banner').hidden, false);
    assert.equal(env.element('attach-banner-text').textContent, 'That event was posted in a different Discord server.');
    assert.equal(env.element('btn-attach-create').textContent, 'Import anyway');
    assert.equal(env.element('btn-attach-create').disabled, false);
    assert.deepEqual(env.planned, []);
    await env.api.PlanAttach.create();
    assert.deepEqual(env.posts[1].body, { teamId: 't1', eventSource: EVENT, acceptOtherServer: true });
    assert.deepEqual(env.planned, [{ gid: 'g1', rid: 'r_new', event: null }]);
    assert.equal(env.element('attach-banner').hidden, true);
  });

  await check('Create raid_exists: it offers that raid\'s plan, and the button opens it', async () => {
    const env = makeEnv({ post: () => new ApiErr(409, 'raid_exists', 'That team already has a raid on that date.', { raidId: 'r_old' }) });
    await env.importEvent();
    await env.api.PlanAttach.create();
    assert.equal(env.element('attach-banner-text').textContent, 'That team already has a raid on that date.');
    assert.equal(env.element('btn-attach-create').textContent, "Open that raid's plan");
    assert.deepEqual(env.planned, []);
    await env.api.PlanAttach.create();
    assert.deepEqual(env.planned, [{ gid: 'g1', rid: 'r_old', event: null }]);
    assert.equal(env.posts.length, 1, 'no second create');
    assert.equal(env.element('attach-banner').hidden, true);
  });

  await check('Create with another error (event_exists, 500) keeps the offer and shows the Worker\'s text', async () => {
    const env = makeEnv({ post: () => new ApiErr(409, 'event_exists', 'That Raid-Helper event is already on another raid.', { raidId: 'r_x' }) });
    await env.importEvent();
    await env.api.PlanAttach.create();
    assert.equal(env.element('attach-banner').hidden, false);
    assert.equal(env.element('attach-banner-detail').textContent, 'That Raid-Helper event is already on another raid.');
    assert.equal(env.element('btn-attach-create').textContent, 'Create a raid');
    assert.deepEqual(env.planned, []);
  });

  await check('Create after the plan on screen changed: the stale offer closes without a request', async () => {
    const env = makeEnv();
    await env.importEvent();
    env.api.State.planId = 'plan:other';
    await env.api.PlanAttach.create();
    assert.deepEqual(env.posts, []);
    assert.equal(env.element('attach-banner').hidden, true);
  });

  await check('Skip: closes the offer, remembers the event for the session, a re-import makes no call', async () => {
    const env = makeEnv();
    await env.importEvent();
    env.api.PlanAttach.skip();
    assert.equal(env.element('attach-banner').hidden, true);
    assert.deepEqual(JSON.parse(env.session.pp_attach_skipped), [EVENT]);
    const before = env.calls.length;
    await env.importEvent();
    assert.equal(env.calls.length, before);
    assert.equal(env.element('attach-banner').hidden, true);
    // another event is still offered
    await env.importEvent('1500000000000000001');
    assert.equal(env.element('attach-banner').hidden, false);
  });

  await check('Skip is remembered on this page even when sessionStorage throws', async () => {
    const env = makeEnv();
    await env.importEvent();
    // a browser without storage: the in-page set still holds the skip
    const { PlanAttach } = env.api;
    PlanAttach.skippedNow.add(EVENT);
    env.session.pp_attach_skipped = '{not json';
    assert.equal(PlanAttach.skipped(EVENT), true);
    assert.equal(PlanAttach.skipped('1500000000000000002'), false, 'a broken stored value reads as nothing skipped');
  });

  await check('lookup failures (network, 401, 403, 500) fall back to the standalone flow silently', async () => {
    for (const err of [new TypeError('Failed to fetch'), new ApiErr(401, 'signed_out', 'x'), new ApiErr(403, 'forbidden', 'x'), new ApiErr(500, 'error', 'x')]) {
      const env = makeEnv({ lookup: { g1: err } });
      await env.importEvent();
      assert.equal(env.calls.length, 1);
      assert.equal(env.element('attach-banner').hidden, true, `no offer after ${err.message}`);
      assert.deepEqual(env.toasts, []);
      assert.deepEqual(env.planned, []);
      assert.deepEqual(env.posts, []);
    }
  });

  await check('a guild that cannot be read counts as unknown: no offer when no other guild holds the raid', async () => {
    const guilds = { g1: { guild: { name: 'A', timeZone: 'UTC' }, teams: [{ id: 't1', name: 'Main' }], me: { can: {} }, canEdit: ['t1'] } };
    const e2 = makeEnv({ guilds });
    e2.api.PlanAttach.tools().app.state.me.guilds.push({ id: 'g_missing' });
    await e2.importEvent();
    assert.deepEqual(e2.fetchedGuilds, ['g_missing']);
    assert.equal(e2.element('attach-banner').hidden, true);
    assert.deepEqual(e2.toasts, []);
  });

  await check('a newer import replaces the older one: the old answer does not open or offer anything', async () => {
    const env = makeEnv();
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    const real = env.api.PlanAttach.tools().api.get;
    env.api.PlanAttach.tools().api.get = url => { env.calls.push(url); return env.calls.length === 1 ? slow.then(() => ({ raid: { id: 'r_old', raidOn: '2099-01-01', teamId: 't1' } })) : real(url); };
    await env.importEvent(); // the first lookup is still waiting
    await env.importEvent('1500000000000000009');
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.planned, [], 'the first import\'s raid was not opened over the second');
    assert.equal(env.element('attach-banner').hidden, false);
    assert.match(env.element('attach-banner-detail').textContent, /sign-ups$/);
  });

  await check('the import never waits for or fails because of the attach step', async () => {
    const env = makeEnv();
    env.api.PlanAttach.afterImport = () => Promise.reject(new Error('boom'));
    const unhandled = [];
    const onRejection = err => unhandled.push(err);
    process.on('unhandledRejection', onRejection);
    await env.importEvent();
    process.off('unhandledRejection', onRejection);
    assert.deepEqual(unhandled, []);
  });

  await check('importFromText reports the event it read to PlanAttach, and runImport clears it first', () => {
    const modals = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'modals.js'), 'utf8');
    assert.match(modals, /if \(src\.eventId && Array\.isArray\(metadata\.signUps\) && typeof PlanAttach !== 'undefined'\) PlanAttach\.noteEvent\(src\.eventId, metadata\);/);
    assert.match(modals, /PlanAttach\.forget\(\);\s+const ok = await importFromText/);
    assert.match(modals, /PlanAttach\.afterImport\(\)\.catch/);
  });

  await check('the offer markup: banner in the notice slot with Create and Skip, a team select, ghost Skip, no molten', () => {
    const html = app.html;
    const slot = html.slice(html.indexOf('id="notice-slot"'), html.indexOf('id="btn-notice-more"'));
    const banner = slot.slice(slot.indexOf('id="attach-banner"'), slot.indexOf('id="sync-banner"'));
    assert(banner.includes('class="sync-banner gs-pb-notice"'), 'a notice of the next-step bar');
    assert.match(banner, /id="btn-attach-create"[^>]*>Create a raid</);
    assert.match(banner, /gs-btn-ghost" id="btn-attach-skip">Skip, keep it on this device</);
    assert(!/molten/.test(banner), 'molten is Optimize only');
    assert.match(banner, /<select id="attach-team">/);
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'guild.css'), 'utf8');
    const phone = css.slice(css.indexOf('lane 3b: the next-step bar'));
    assert.match(phone, /\.gs-pb-attach-team \{[^}]*flex-direction: column/, 'the team pick stacks on a phone');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
