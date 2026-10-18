/**
 * Raidsmith guild tracker, Phase 8 - CONTRACT tests (Worker <-> pages)
 * Run: node guild-guilds-contract-tests.js
 *
 * guild-guilds-worker-tests.js and guild-guilds-ui-tests.js each work with hand-made data on the other side. This suite joins them, the way the
 * other *-contract-tests.js suites do: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the
 * node:sqlite D1 stand-in) through G.api, the real handlers run, and what the pages draw from the real answers is checked next to what the Worker
 * stored: the setup checklist on Home and its Dismiss, the create page's reasons and limit, the Guild data tab's delete and export.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');
const { adminOf, memberOf, makeWorld, signIn, newJar, person, ORIGIN } = require('./tests/guild-world');

const ROOT = __dirname;
const S = ['900000000000000001', '900000000000000002', '900000000000000003', '900000000000000004', '900000000000000005', '900000000000000006'];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };
const el = (attrs) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false, closest: () => null }, {});

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

// The pages in a vm, with `fetch` answered by the Worker for one signed-in person (their cookie jar).
function pagesFor(world, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  sandbox.fetch = async (url, init = {}) => world.req(init.method || 'GET', url, { jar, rawBody: init.body, headers: init.headers && init.headers['Content-Type'] ? { 'Content-Type': init.headers['Content-Type'] } : {} });
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  const els = {};
  sandbox.document = { getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [] };
  sandbox.els = els;
  return sandbox;
}

const ALICE = person(1, 'Alice');
const BODY = { serverId: S[0], gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false };

(async () => {
  await check('Home: the Worker\'s checklist draws as a card, Dismiss reaches the Worker, and the next read has no card', async () => {
    const w = await makeWorld();
    const jar = (await signIn(w, ALICE, [adminOf(S[0])])).jar;
    const made = await w.call(jar, 'POST', '/api/guild', BODY);
    const gid = made.json.guild.id;
    const ctx = pagesFor(w, jar);
    const G = ctx.Guild;
    const state = G.app.state;
    const guildData = made.json;
    state.guilds[gid] = guildData; state.currentGid = gid;
    await G.pages.attention.load({ name: 'section', gid, section: 'home' }, guildData);
    let html = G.pages.attention.main({}, guildData, {});
    assert(html.includes('Set up your guild') && stripTags(html).includes('1 of 6 steps done'), stripTags(html).slice(0, 300));
    const hrefs = [...html.matchAll(/class="gs-onboard-link" href="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs.map((href) => G.router.parse(href).name), ['settings', 'section', 'settings', 'raidnew', 'settings', 'section'], 'every link is a route the shell knows');
    // A person is added: the next read ticks "Import your roster".
    assert.equal((await w.call(jar, 'POST', `/api/guild/${gid}/roster`, { teamId: made.json.teams[0].id, name: 'Thornwick', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, status: 'raider' })).status, 201);
    await G.handlers.click['attn-refresh'](el({}));
    html = G.pages.attention.main({}, guildData, {});
    assert(stripTags(html).includes('2 of 6 steps done'));
    assert(/gs-onboard-step is-done"><span class="gs-onboard-mark" aria-hidden="true"><svg[^]*?<\/svg><\/span><a class="gs-onboard-link" href="#\/g\/[^"]*\/roster">Import your roster<span class="gs-sr"> \(done\)/.test(html), 'the roster step is ticked');
    // Dismiss.
    G.ui.announce = () => {}; G.ui.focusByKey = () => true; G.app.render = () => {};
    await G.handlers.click['onboarding-dismiss'](el({}));
    await settle();
    assert(!G.pages.attention.main({}, guildData, {}).includes('gs-onboard'));
    assert.equal(await w.count('guilds', 'id = ? AND onboarding_dismissed_at IS NOT NULL', gid), 1);
    await G.handlers.click['attn-refresh'](el({}));
    assert(!G.pages.attention.main({}, guildData, {}).includes('gs-onboard'), 'the Worker no longer sends it');
  });

  await check('create page: the Worker\'s answers for a Battle.net-only account, a plain member, an administrator and the account limit, as the page words them', async () => {
    const w = await makeWorld();
    const bnetOnly = (await signIn(w, person(2, 'Bnetonly'), [adminOf(S[1])])).jar;
    w.db.sqlite.exec('UPDATE users SET discord_id = NULL');
    let ctx = pagesFor(w, bnetOnly);
    let me = (await w.call(bnetOnly, 'GET', '/auth/me')).json;
    let html = ctx.Guild.pages.create.createHtml({ me });
    assert(html.includes('Connect Discord to create a guild') && html.includes('href="#/linked"'));
    assert(ctx.Guild.pages.signin.noGuildHtml(me).includes('id="create-needs-discord"'));

    const member = (await signIn(w, person(3, 'Plainmember'), [memberOf(S[2])])).jar;
    me = (await w.call(member, 'GET', '/auth/me')).json;
    assert(pagesFor(w, member).Guild.pages.create.createHtml({ me }).includes('No Discord server to create a guild for'));

    const admin = (await signIn(w, ALICE, S.map((id) => adminOf(id)))).jar;
    me = (await w.call(admin, 'GET', '/auth/me')).json;
    ctx = pagesFor(w, admin);
    html = ctx.Guild.pages.create.createHtml({ me, timeZones: ['America/New_York'], defaultTimeZone: 'America/New_York' });
    assert(html.includes('data-submit="create-guild"') && !html.includes('cg-limit'));
    for (let i = 0; i < 5; i++) assert.equal((await w.call(admin, 'POST', '/api/guild', { ...BODY, serverId: S[i], name: `Guild ${i}` })).status, 201);
    me = (await w.call(admin, 'GET', '/auth/me')).json;
    html = ctx.Guild.pages.create.createHtml({ me, timeZones: ['America/New_York'], defaultTimeZone: 'America/New_York' });
    assert(html.includes('You have created 5 guilds') && /disabled data-key="create-guild">/.test(html), 'at the limit');
  });

  await check('Guild data: the real export downloads, the real delete needs the typed name and takes the guild away', async () => {
    const w = await makeWorld();
    const jar = (await signIn(w, ALICE, [adminOf(S[0])])).jar;
    const made = await w.call(jar, 'POST', '/api/guild', BODY);
    const gid = made.json.guild.id;
    const ctx = pagesFor(w, jar);
    const G = ctx.Guild;
    const state = G.app.state;
    state.guilds[gid] = made.json; state.currentGid = gid;
    const page = G.pages.settingsData.dataHtml({ guildData: made.json, alert: '' });
    const href = /href="([^"]*\/export)" download/.exec(page)[1];
    const file = await w.call(jar, 'GET', href);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('Content-Disposition'), /^attachment; filename="raidsmith-guild-ember-/);
    assert.equal(file.json.guild.name, 'Ember');

    let opened = '';
    G.ui.openDialog = (html) => { opened = html; return {}; };
    G.handlers.click['guild-delete-open'](el({}));
    assert(opened.includes('Delete Ember?'));
    const deleted = [];
    G.app.afterGuildDeleted = (id) => deleted.push(id);
    const slot = { id: 'dlg-err-confirmName', textContent: '', hidden: true };
    ctx.els['dlg-err-confirmName'] = slot;
    ctx.els['dlg-error'] = { id: 'dlg-error', textContent: '', hidden: true };
    const input = { focus() {}, setAttribute() {} };
    const dlg = (typed) => ({ elements: { confirmName: { value: typed } }, querySelector: (sel) => (sel === '#dlg-err-confirmName' ? slot : (sel === '[data-field="confirmName"]' ? input : null)), querySelectorAll: () => [], closest: () => null });
    G.handlers.submit['guild-delete-form'](dlg('Embers'));
    await settle();
    assert.match(slot.textContent, /Type the guild name exactly/, 'the Worker\'s own words, next to the field');
    assert.deepEqual(deleted, []);
    assert.equal(await w.count('guilds'), 1);
    G.handlers.submit['guild-delete-form'](dlg('Ember'));
    await settle();
    assert.deepEqual(deleted, [gid]);
    assert.equal(await w.count('guilds'), 0);
    assert.equal((await w.call(jar, 'GET', '/auth/me')).json.guilds.length, 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
