/**
 * Raidsmith guild app - lane B8a-fix: "Delete my data" on the Account / Privacy page runs the "Confirm it is you" sign-in when the Worker asks for it
 * (tasks/open/b6b-api-contract.md, F1 + G1: purpose account_delete, account scope, params {}).
 * Run: node tests/guild/guild-b8a-fix-tests.js [name filter]
 *
 *   - DELETE /auth/me answering 403 fresh_required (purpose account_delete) opens the sign-in step (Battle.net or Discord where the account has both, its only linked one otherwise)
 *     in a dialog of its own and shows no error; any other refusal is today's (the Worker's sentence in the delete box);
 *   - the step starts POST /api/fresh/start { purpose: 'account_delete', params: {}, provider } and keeps the act with the same deleteGuildIds;
 *   - #/fresh?done=account_delete repeats the DELETE with those ids and ends where a delete ends (afterAccountDeleted, then the start page);
 *   - a pending act older than the helper's 15 minutes is not repeated; a refusal after the return shows the Worker's sentence.
 * The UI half loads the shared guild script list into a vm with fake documents (as the other UI suites).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runChecks } = require('../guild-b3-world');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const checks = [];
const filter = process.argv[2];
function check(name, fn) {
  if (filter && !name.includes(filter)) return;
  checks.push({ name, fn });
}

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, URL };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const sandbox = loadGuild();
const G = sandbox.Guild;
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

let fields = {};
sandbox.document = { getElementById: (id) => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const field = (id) => (fields[id] = { id, textContent: '', hidden: true });

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), has: (k) => map.has(k) };
}
let storage;
let navigations;
let goes;
let opened;
let ended;
let rereads;
function resetBrowser(hash = '#/privacy') {
  fields = {};
  storage = memoryStorage();
  navigations = [];
  goes = [];
  opened = [];
  ended = 0;
  rereads = 0;
  sandbox.window = { sessionStorage: storage, location: { hash, assign: (url) => navigations.push(url) } };
  G.fresh.navigate = (url) => navigations.push(url);
  G.fresh.now = () => Date.now();
  G.app.go = (hash2, replace) => goes.push([hash2, !!replace]);
  G.app.afterAccountDeleted = () => { ended++; };
  G.app.loadMe = () => { rereads++; return Promise.resolve(); };
  G.app.render = () => {};
  G.app.requireSignin = () => {};
  G.app.state.privacyMessage = '';
  G.app.state.guilds = {};
  G.app.state.lastGid = null;
  G.pages.fresh.reset();
  // The dialog host: the step opens in a dialog of its own, so the page needs one to open.
  G.ui.openDialog = (html, opts) => { opened.push({ html, opts }); return { innerHTML: html }; };
}

function scriptApi(script) {
  const calls = [];
  const respond = (method) => (apiPath, body) => {
    calls.push({ method, path: apiPath, body: body === undefined ? undefined : plain(body) });
    const fn = script[`${method} ${apiPath}`];
    if (!fn) return Promise.reject(new G.api.ApiError(404, { error: 'not_found' }));
    try { return Promise.resolve(fn(body, calls.length)); } catch (error) { return Promise.reject(error); }
  };
  G.api.get = respond('GET');
  G.api.post = respond('POST');
  G.api.del = respond('DELETE');
  return calls;
}
const apiError = (status, body) => new G.api.ApiError(status, body);
const freshRequired = (purpose, params) => apiError(403, { error: 'fresh_required', message: 'Confirm it is you first.', purpose, ...(params ? { params } : {}) });
const AUTHORIZE = 'https://oauth.example.test/authorize?state=abc';
const BOTH = { identities: { discord: { username: 'brandon' }, bnet: { battletag: 'Brandon#1482' } } };
const DISCORD_ONLY = { identities: { discord: { username: 'brandon' }, bnet: null } };
const GUILDS = [{ id: 'g1', name: 'Ravens' }, { id: 'g2', name: 'Owls' }];

function meWith(identities, guildsDeleted = GUILDS) {
  return { user: { id: 'u1' }, ...identities, guilds: [], deleteImpact: { handOverFirst: [], guildsDeleted, autoPromote: [], succession: [] } };
}
function stepForm(provider) {
  return { closest: () => null, querySelector: (sel) => (provider && /input\[name="provider"\]/.test(sel) ? { value: provider } : null), querySelectorAll: () => [] };
}
const click = () => { const btn = { disabled: false }; G.handlers.click['delete-go'](btn); return btn; };

// ---------------------------------------------------------------------------

check('Delete my data: 403 fresh_required (account_delete) opens the "Confirm it is you" step, offers both sign-ins, and shows no error', async () => {
  resetBrowser();
  G.app.state.me = meWith(BOTH);
  const calls = scriptApi({ 'DELETE /auth/me': () => { throw freshRequired('account_delete', {}); } });
  const btn = click();
  assert.equal(btn.disabled, true, 'busy while the request runs');
  await settle();
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/auth/me', body: { deleteGuildIds: ['g1', 'g2'] } }]);
  assert.equal(opened.length, 1, 'one dialog, the step');
  const html = opened[0].html;
  const t = text(html);
  assert(t.includes('Confirm it is you') && t.includes('Delete my data - step 2 of 2') && t.includes('Sign in and delete'), t);
  assert(html.includes('id="fresh-prov-bnet"') && html.includes('id="fresh-prov-discord"') && t.includes('Battle.net (Brandon#1482)') && t.includes('Discord (brandon)'), 'both sign-ins where the account has both');
  assert(html.includes('data-submit="fresh-step-form"') && !html.includes('fresh-step-back'), 'the step is the dialog\'s only body: no Back, Cancel closes it');
  assert.equal(btn.disabled, false, 'the delete button is usable again when the dialog is closed');
  assert.equal(G.app.state.privacyMessage, '', 'no message in the delete box');
  assert.equal(rereads, 0, 'nothing re-read');
  assert.equal(ended, 0, 'nothing deleted yet');
});

check('Delete my data: an account with one linked sign-in is offered that one only', async () => {
  resetBrowser();
  G.app.state.me = meWith(DISCORD_ONLY);
  scriptApi({ 'DELETE /auth/me': () => { throw freshRequired('account_delete', {}); } });
  click();
  await settle();
  const html = opened[0].html;
  assert(!html.includes('type="radio"'), 'no choice to make');
  assert(text(html).includes('Sign in with Discord again so Raidsmith knows it is you.') && text(html).includes('brandon') && html.includes('Sign in and delete'), text(html));
  // The step then starts with that provider (the form carries none).
  const calls = scriptApi({ 'POST /api/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form'](stepForm(null));
  await settle();
  assert.equal(calls[0].body.provider, 'discord');
});

check('Delete my data: the step posts to /api/fresh/start (purpose account_delete, params {}) with the picked provider and keeps the act and its guild list', async () => {
  resetBrowser();
  G.app.state.me = meWith(BOTH);
  scriptApi({ 'DELETE /auth/me': () => { throw freshRequired('account_delete', {}); } });
  click();
  await settle();
  const calls = scriptApi({ 'POST /api/fresh/start': () => ({ authorizeUrl: AUTHORIZE, provider: 'discord', purpose: 'account_delete', validForSeconds: 600 }) });
  G.handlers.submit['fresh-step-form'](stepForm('discord'));
  await settle();
  assert.deepEqual(calls, [{ method: 'POST', path: '/api/fresh/start', body: { purpose: 'account_delete', params: {}, provider: 'discord' } }]);
  assert.deepEqual(navigations, [AUTHORIZE]);
  const saved = plain(G.fresh.pending());
  assert.deepEqual([saved.kind, saved.gid, saved.purpose, saved.params, saved.data, saved.provider, saved.returnTo],
    ['account_delete', null, 'account_delete', {}, { deleteGuildIds: ['g1', 'g2'] }, 'discord', '#/privacy']);
});

check('Delete my data: an account without a guild to delete repeats with an empty list', async () => {
  resetBrowser();
  G.app.state.me = meWith(BOTH, []);
  scriptApi({ 'DELETE /auth/me': () => { throw freshRequired('account_delete', {}); } });
  click();
  await settle();
  scriptApi({ 'POST /api/fresh/start': () => ({ authorizeUrl: AUTHORIZE }) });
  G.handlers.submit['fresh-step-form'](stepForm('bnet'));
  await settle();
  assert.deepEqual(plain(G.fresh.pending().data), { deleteGuildIds: [] });
});

check('Delete my data: every other refusal stays today\'s (the Worker\'s sentence in the box, the impact re-read); a 403 for another purpose is no step', async () => {
  for (const err of [
    apiError(409, { error: 'hand_over_guild_master', message: 'Hand over Ravens first.' }),
    apiError(409, { error: 'confirm_mismatch', message: 'The guilds changed. Check the list and try again.' }),
    freshRequired('guild_delete', {}),
  ]) {
    resetBrowser();
    G.app.state.me = meWith(BOTH);
    scriptApi({ 'DELETE /auth/me': () => { throw err; } });
    click();
    await settle();
    assert.equal(opened.length, 0, 'no step');
    assert.equal(G.app.state.privacyMessage, G.api.classify(err).text, 'the Worker\'s sentence');
    assert.equal(rereads, 1, 'the impact is read again');
  }
  // A dialog host that cannot open the step falls back to the same path, not to a silent button.
  resetBrowser();
  G.app.state.me = meWith(BOTH);
  G.ui.openDialog = () => null;
  scriptApi({ 'DELETE /auth/me': () => { throw freshRequired('account_delete', {}); } });
  click();
  await settle();
  assert.equal(G.app.state.privacyMessage, 'Confirm it is you first.');
  assert.equal(G.fresh.pending(), null);
});

check('Delete my data: a delete that needs no sign-in ends as before', async () => {
  resetBrowser();
  G.app.state.me = meWith(BOTH, []);
  const calls = scriptApi({ 'DELETE /auth/me': () => ({ ok: true }) });
  click();
  await settle();
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/auth/me', body: { deleteGuildIds: [] } }]);
  assert.equal(ended, 1);
  assert.equal(opened.length, 0);
});

// ---------------------------------------------------------------------------
// #/fresh?done=account_delete

function savePending(overrides = {}) {
  storage.setItem(G.fresh.PENDING_KEY, JSON.stringify({ kind: 'account_delete', gid: null, purpose: 'account_delete', params: {}, data: { deleteGuildIds: ['g1', 'g2'] }, provider: 'discord', returnTo: '#/privacy', at: Date.now(), ...overrides }));
}
const landing = async (hash) => {
  const route = G.router.parse(hash);
  sandbox.window.location.hash = hash;
  await G.pages.fresh.load(route);
  const view = G.pages.fresh.view();
  if (view && view.running) await view.running;
  await settle();
  return { route, view, html: G.pages.fresh.main(route, null, {}) };
};

check('#/fresh?done=account_delete: repeats the DELETE with the same deleteGuildIds, ends where a delete ends, and uses the saved act once', async () => {
  resetBrowser('#/fresh?done=account_delete');
  G.app.state.me = meWith(BOTH);
  const calls = scriptApi({ 'DELETE /auth/me': () => ({ ok: true }) });
  savePending();
  const { html } = await landing('#/fresh?done=account_delete');
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/auth/me', body: { deleteGuildIds: ['g1', 'g2'] } }], 'the ids come from the saved act, not from the page');
  assert.equal(ended, 1, 'afterAccountDeleted: the session is reset and the signed-out start page shows its notice');
  assert.deepEqual(goes, [['#/', true]], 'and the page goes to the start page, replacing this entry');
  assert.equal(G.fresh.pending(), null, 'taken');
  assert(text(html).includes('You are signed in again.'), text(html));
});

check('#/fresh?done=account_delete: a pending act older than the helper\'s limit is not repeated', async () => {
  for (const age of [G.fresh.MAX_AGE_MS, G.fresh.MAX_AGE_MS + 60 * 1000]) {
    resetBrowser('#/fresh?done=account_delete');
    G.app.state.me = meWith(BOTH);
    const calls = scriptApi({ 'DELETE /auth/me': () => ({ ok: true }) });
    savePending({ at: Date.now() - age });
    const { html } = await landing('#/fresh?done=account_delete');
    assert.deepEqual(calls, [], `age ${age} ms: no DELETE`);
    assert.equal(ended, 0);
    assert.deepEqual(goes, []);
    assert(text(html).includes('It was started too long ago to repeat on its own.'), text(html));
    assert.equal(G.fresh.pending(), null, 'the old act is cleared');
  }
});

check('#/fresh?done=account_delete: no pending act, or one of another purpose, deletes nothing', async () => {
  resetBrowser('#/fresh?done=account_delete');
  G.app.state.me = meWith(BOTH);
  const calls = scriptApi({ 'DELETE /auth/me': () => ({ ok: true }) });
  await landing('#/fresh?done=account_delete');
  savePending({ purpose: 'guild_delete', kind: 'guild_delete', gid: 'g1', data: { confirmName: 'x' } });
  await landing('#/fresh?done=account_delete');
  assert.deepEqual(calls, []);
  assert.equal(ended, 0);
});

check('#/fresh?done=account_delete: a refusal after the return shows the Worker\'s sentence and the way back; nothing ends', async () => {
  for (const [err, sentence] of [
    [apiError(409, { error: 'hand_over_guild_master', message: 'You are the only Guild Master of Ravens. Hand over first.' }), 'You are the only Guild Master of Ravens. Hand over first.'],
    [apiError(409, { error: 'confirm_mismatch', message: 'The guilds that would be deleted changed. Check the list and try again.' }), 'The guilds that would be deleted changed. Check the list and try again.'],
  ]) {
    resetBrowser('#/fresh?done=account_delete');
    G.app.state.me = meWith(BOTH);
    const calls = scriptApi({ 'DELETE /auth/me': () => { throw err; } });
    savePending();
    const { html } = await landing('#/fresh?done=account_delete');
    assert.equal(calls.length, 1);
    assert(text(html).includes('That did not go through.') && text(html).includes(sentence) && html.includes('href="#/privacy"'), text(html));
    assert.equal(ended, 0);
    assert.deepEqual(goes, []);
  }
  // The grant not counting (403 again) says so instead of looping back into the step.
  resetBrowser('#/fresh?done=account_delete');
  G.app.state.me = meWith(BOTH);
  scriptApi({ 'DELETE /auth/me': () => { throw freshRequired('account_delete', {}); } });
  savePending();
  const lost = await landing('#/fresh?done=account_delete');
  assert(text(lost.html).includes('The sign-in did not count.'), text(lost.html));
  assert.equal(opened.length, 0);
  assert.equal(ended, 0);
});

check('the act is registered by the privacy page and the helper knows the purpose (account scope, both providers)', () => {
  assert.equal(G.fresh.hasAct('account_delete'), true);
  assert.deepEqual(plain(G.fresh.PURPOSES.account_delete), { providers: ['bnet', 'discord'], scope: 'account', owner: false });
  const src = read('js/guild/pages-privacy.js');
  assert(src.includes("G.fresh.registerAct('account_delete'") && src.includes('G.fresh.openStep('));
});

runChecks(checks);
