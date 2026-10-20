/**
 * Raidsmith guild UI - loot page redesign, lane U2: the award record and Edit details, Needs fixing, and the import preview's conflict / deleted rows.
 * Run: node tests/guild/guild-loot-award-tests.js
 *
 * Same approach as guild-loot-ui-tests.js: the guild scripts load in a vm with no DOM, pages return HTML strings and the handlers run against a stubbed G.api.
 * The real Worker answers the same calls in guild-loot-contract-tests.js.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('../guild-scripts');
const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
vm.createContext(sandbox);
for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
sandbox.window = { location: { hash: '' } };
const G = sandbox.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setTimeout(r, 5));
const stripTags = s => s.replace(/<[^>]*>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const OFFICER_CAN = { 'roster.view': 'guild', 'raids.view': 'guild', 'loot.view': 'guild', 'loot.edit': 'guild', 'loot.policy': 'guild' };
const gd = (can) => ({
  guild: { id: 'g1', name: 'Ravens', realm: 'Firemaw', region: 'US', timeZone: 'America/Chicago', gameVersion: 'tbc' },
  teams: [{ id: 't1', name: 'Team KJ', size: 25, archived: false }, { id: 't2', name: 'Weekend', size: 25, archived: false }],
  me: { roles: [{ role: 'officer' }], can }, attendanceFlags: {},
});
const award = (over) => Object.assign({
  id: 'lo_1', raidId: 'r1', raidOn: '2026-09-18', teamId: 't1', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: 1791681160000,
  winner: { name: 'Drenna', realm: 'Firemaw', class: 'MAGE' }, match: { kind: 'character', personId: 'p_dr', personName: 'Drenna', characterName: 'Drenna', isMain: true },
  tag: 'OS', tagSetBy: null, flags: [], rollType: 'OS', note: null, awardedBy: 'Lootmaster-Firemaw', manual: false, updatedAt: 1000, editedFields: [],
}, over || {});
const detail = (aw) => ({
  award: aw || award(), raid: { id: 'r1', raidOn: '2026-09-18', title: null, zone: 'KJ Hyjal', teamId: 't1', teamName: 'Team KJ' },
  origin: { kind: 'gargul', at: 1791681160000, by: null, awardedBy: 'Lootmaster-Firemaw', text: 'Imported from Gargul (awarded by Lootmaster-Firemaw)' },
  history: [{ id: 'h1', at: 1791681160000, action: 'loot.update', text: 'Winner changed from Healthas to Drenna (Nathrezim Mindblade)', by: { id: 'u1', displayName: 'Bob' } }], canEdit: true,
});

function stub(handler) {
  const calls = [];
  const real = G.api;
  G.api = Object.assign({}, real, ['get', 'post', 'put', 'patch', 'del'].reduce((o, m) => { o[m] = (url, body) => { calls.push({ m, url, body: body && plain(body) }); return handler(m, url, body); }; return o; }, {}));
  return { calls, restore() { G.api = real; } };
}
function withState(fn) {
  return async () => {
    const S = G.app.state;
    const saved = { att: S.att, currentGid: S.currentGid, guilds: S.guilds, pageAlert: S.pageAlert };
    S.att = {}; S.guilds = { g1: gd(OFFICER_CAN) }; S.currentGid = 'g1'; S.pageAlert = '';
    const realRender = G.app.render;
    G.app.render = () => {};
    try { await fn(S); } finally { G.app.render = realRender; Object.assign(S, saved); }
  };
}
const el = (attrs, extra) => Object.assign({ getAttribute: k => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const route = (over) => Object.assign({ name: 'lootaward', gid: 'g1', aid: 'lo_1', edit: false }, over || {});
const page = (S) => G.pages.lootAward.main(route(), S.guilds.g1);
const X = (S) => S.att.lootAward;
const routes = (extra) => (m, url) => {
  if (/\/loot\/a\//.test(url)) return Promise.resolve(detail());
  if (/\/raids\?team=t1/.test(url)) return Promise.resolve({ raids: [{ id: 'r1', raidOn: '2026-09-18', zone: 'KJ Hyjal', title: null }, { id: 'r0', raidOn: '2026-09-11', zone: 'KJ Hyjal', title: null }] });
  if (/\/raids\?team=t2/.test(url)) return Promise.resolve({ raids: [{ id: 'r9', raidOn: '2026-09-12', zone: 'SSC', title: 'Weekend run' }] });
  if (/\/roster/.test(url)) return Promise.resolve({ people: [{ names: ['Healthas', 'Drenna'] }] });
  return extra ? extra(m, url) : Promise.reject(new Error('unexpected ' + m + ' ' + url));
};

(async () => {
  await check('router and manifest: the award and fix pages are real pages, not placeholders', () => {
    assert.equal(typeof G.pages.lootAward.awardHtml, 'function');
    assert.equal(typeof G.pages.lootFix.fixHtml, 'function');
    assert(fs.readFileSync(path.join(ROOT, 'js/guild/manifest.js'), 'utf8').includes('pages-loot-award.js'));
  });

  await check('award record: the details, the origin line and the history for an edit holder; Edit details and Delete are offered', withState(async (S) => {
    const s = stub(routes());
    await G.pages.lootAward.load(route(), S.guilds.g1);
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/a/lo_1']);
    const out = page(S);
    const text = stripTags(out);
    assert(out.includes('Nathrezim Mindblade') && text.includes('KJ Hyjal') && text.includes('Imported from Gargul (awarded by Lootmaster-Firemaw)'));
    assert(text.includes('Raid night') && text.includes('Winner') && text.includes('Tag') && text.includes('No note'));
    assert(out.includes('data-action="la-edit-open"') && out.includes('data-action="la-delete"') && out.includes('Newest first'));
    assert(text.includes('Winner changed from Healthas to Drenna (Nathrezim Mindblade)') && text.includes('by Bob'));
    assert(!out.includes('data-savebar'), 'no Save bar until Edit details opens');
    assert.equal(G.pages.lootAward.nameFor(route()), 'Nathrezim Mindblade');
  }));

  await check('award record: an edited award says Edited; a disenchant reads Disenchanted', withState(async (S) => {
    const s = stub((m, url) => Promise.resolve(detail(award({ editedFields: ['winner'], winner: { name: null, realm: null, class: null }, match: { kind: 'disenchanted' }, tag: 'DE' }))));
    await G.pages.lootAward.load(route(), S.guilds.g1);
    s.restore();
    const out = page(S);
    assert(out.includes('Edited') && stripTags(out).includes('Disenchanted'));
  }));

  await check('award record: a member (403) gets the plain Team Leads state, a missing award (404) the not-found state; other errors throw', withState(async (S) => {
    let s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await G.pages.lootAward.load(route(), S.guilds.g1);
    s.restore();
    let out = page(S);
    assert(stripTags(out).includes('Only Team Leads and above can open an award.') && !out.includes('data-action="la-edit-open"'));
    s = stub(() => Promise.reject(new G.api.ApiError(404, { error: 'not_found' })));
    await G.pages.lootAward.load(route(), S.guilds.g1);
    s.restore();
    out = page(S);
    assert(stripTags(out).includes('Award not found'));
    s = stub(() => Promise.reject(new G.api.ApiError(500, { error: 'boom' })));
    await assert.rejects(G.pages.lootAward.load(route(), S.guilds.g1));
    s.restore();
  }));

  await check('award record: hostile text stays escaped', withState(async (S) => {
    const s = stub(() => Promise.resolve(detail(award({ itemName: '<img src=x onerror=1>', note: '"><script>1</script>' }))));
    await G.pages.lootAward.load(route(), S.guilds.g1);
    s.restore();
    const out = page(S);
    assert(!out.includes('<img src=x') && !/<script/i.test(out));
  }));

  await check('Edit details: ?edit=1 opens the form with the raid nights of the editable teams and the roster names; the Save bar starts hidden', withState(async (S) => {
    const s = stub(routes());
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    s.restore();
    assert(s.calls.some(c => /raids\?team=t1/.test(c.url)) && s.calls.some(c => /raids\?team=t2/.test(c.url)) && s.calls.some(c => /roster\?team=t1/.test(c.url)));
    const out = page(S);
    assert(out.includes('data-submit="la-form"') && out.includes('id="la-winner"') && out.includes('id="la-item"') && out.includes('id="la-raid"') && out.includes('id="la-tag"') && out.includes('id="la-note"'));
    assert(out.includes('<option value="r9"') && out.includes('<option value="r0"') && out.includes('<option value="healthas"') === false);
    assert(out.includes('value="Healthas"'), 'the roster names are suggested');
    assert(/data-savebar-count="0"[^>]*hidden/.test(out), 'the bar is hidden with nothing changed');
    assert(out.includes('Save details') && out.includes('data-action="la-discard"'));
    assert.equal(G.pages.lootAward.changeCount(X(S)), 0);
  }));

  await check('Edit details: every changed field counts once; Discard puts the draft back', withState(async (S) => {
    const s = stub(routes());
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    s.restore();
    const x = X(S);
    G.handlers.input['la-winner'](el({}, { value: 'Healthas' }));
    G.handlers.input['la-item'](el({}, { value: '30311' }));
    G.handlers.change['la-raid'](el({}, { value: 'r0' }));
    G.handlers.change['la-tag'](el({}, { value: 'MS' }));
    G.handlers.input['la-note'](el({}, { value: 'Kept for the alt' }));
    assert.deepEqual(plain(G.pages.lootAward.changedFields(x)), ['winner', 'item', 'raid', 'tag', 'note']);
    assert.equal(G.pages.lootAward.changeCount(x), 5);
    let out = page(S);
    assert(out.includes('data-savebar-count="5"') && out.includes('5 unsaved changes') && !/data-savebar-count="5"[^>]*hidden/.test(out));
    assert(out.includes('Changed from Drenna.') && out.includes('Changed from Off-spec.'));
    G.handlers.input['la-note'](el({}, { value: '  ' }));
    assert.equal(G.pages.lootAward.changeCount(x), 4, 'a blank note is no change');
    G.handlers.click['la-discard']();
    assert.equal(G.pages.lootAward.changeCount(x), 0);
    out = page(S);
    assert(/data-savebar-count="0"[^>]*hidden/.test(out) && out.includes('value="Drenna"'));
  }));

  async function saveWith(S, mutate, aw) {
    let patched = false;
    const s = stub((m, url, body) => {
      if (m === 'patch') { patched = true; return Promise.resolve({ award: award(Object.assign({ updatedAt: 2000 }, aw || {})) }); }
      if (/\/loot\/a\//.test(url)) return Promise.resolve(detail(award({ updatedAt: patched ? 2000 : 1000 })));
      return routes()(m, url);
    });
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    mutate();
    G.handlers.submit['la-form']();
    await tick();
    s.restore();
    return s.calls.filter(c => c.m === 'patch');
  }

  await check('Edit details: each field sends only itself plus updatedAt', withState(async (S) => {
    let p = await saveWith(S, () => G.handlers.input['la-winner'](el({}, { value: 'Healthas' })));
    assert.deepEqual(p.map(c => [c.url, c.body]), [['/api/guild/g1/loot/lo_1', { updatedAt: 1000, winnerName: 'Healthas' }]]);
    p = await saveWith(S, () => G.handlers.input['la-item'](el({}, { value: '30311' })));
    assert.deepEqual(p[0].body, { updatedAt: 1000, itemId: 30311 });
    p = await saveWith(S, () => G.handlers.input['la-item'](el({}, { value: 'https://www.wowhead.com/tbc/item=30311/warp-slicer' })));
    assert.equal(p[0].body.itemId, 30311);
    p = await saveWith(S, () => G.handlers.input['la-item'](el({}, { value: 'Warp Slicer' })));
    assert.deepEqual(p[0].body, { updatedAt: 1000, itemName: 'Warp Slicer' });
    p = await saveWith(S, () => G.handlers.change['la-raid'](el({}, { value: 'r9' })));
    assert.deepEqual(p[0].body, { updatedAt: 1000, raidId: 'r9' });
    p = await saveWith(S, () => G.handlers.change['la-tag'](el({}, { value: 'MS' })));
    assert.deepEqual(p[0].body, { updatedAt: 1000, tag: 'MS' });
    p = await saveWith(S, () => G.handlers.input['la-note'](el({}, { value: ' Kept ' })));
    assert.deepEqual(p[0].body, { updatedAt: 1000, note: 'Kept' });
    p = await saveWith(S, () => { G.handlers.input['la-winner'](el({}, { value: 'Healthas' })); G.handlers.change['la-tag'](el({}, { value: 'OS' })); });
    assert.deepEqual(p[0].body, { updatedAt: 1000, winnerName: 'Healthas' }, 'an unchanged tag is not sent');
  }));

  await check('Edit details: a saved award reloads, leaves edit mode, shows Saved and the new history', withState(async (S) => {
    const p = await saveWith(S, () => G.handlers.input['la-note'](el({}, { value: 'Kept' })));
    assert.equal(p.length, 1);
    const x = X(S);
    assert.equal(x.editing, false);
    assert.equal(x.data.award.updatedAt, 2000);
    assert(stripTags(page(S)).includes('Saved'));
  }));

  await check('Edit details: Disenchanted both ways', withState(async (S) => {
    let p = await saveWith(S, () => G.handlers.change['la-de'](el({}, { checked: true })));
    assert.deepEqual(p[0].body, { updatedAt: 1000, disenchanted: true }, 'a tag is not sent with disenchanted');
    // From a disenchant to a winner: the tag defaults to MS.
    const de = award({ winner: { name: null, realm: null, class: null }, match: { kind: 'disenchanted' }, tag: 'DE' });
    const s = stub((m, url) => (m === 'patch' ? Promise.resolve({ award: award() }) : (/\/loot\/a\//.test(url) ? Promise.resolve(detail(de)) : routes()(m, url))));
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    const x = X(S);
    assert.equal(x.draft.disenchanted, true);
    let out = page(S);
    assert(out.includes('checked') && !out.includes('id="la-winner"') && out.includes('disabled'));
    G.handlers.change['la-de'](el({}, { checked: false }));
    assert.equal(x.draft.tag, 'MS');
    G.handlers.input['la-winner'](el({}, { value: 'Healthas' }));
    G.handlers.submit['la-form']();
    await tick();
    s.restore();
    p = s.calls.filter(c => c.m === 'patch');
    assert.deepEqual(p[0].body, { updatedAt: 1000, winnerName: 'Healthas', tag: 'MS' });
  }));

  await check('Edit details: an empty winner, an empty item and a DE tag on a winner stop at the field; nothing is sent', withState(async (S) => {
    const s = stub(routes());
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    G.handlers.input['la-winner'](el({}, { value: '   ' }));
    G.handlers.input['la-item'](el({}, { value: '' }));
    G.handlers.change['la-tag'](el({}, { value: 'DE' }));
    G.handlers.submit['la-form']();
    await tick();
    s.restore();
    assert.equal(s.calls.filter(c => c.m === 'patch').length, 0);
    const out = page(S);
    assert(out.includes('Pick the winner') && out.includes('Enter the item name') && out.includes('needs a tag other than Disenchanted'));
    assert(/id="la-winner-err" role="alert">/.test(out) || out.includes('la-winner-err'));
  }));

  await check('Edit details: a stale save (409) says so with a Reload; Reload re-reads the award and keeps the form', withState(async (S) => {
    let s = stub((m, url) => (m === 'patch' ? Promise.reject(new G.api.ApiError(409, { error: 'stale', message: 'Someone changed this award. Reload to see it.' })) : routes()(m, url)));
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    G.handlers.input['la-note'](el({}, { value: 'Mine' }));
    G.handlers.submit['la-form']();
    await tick();
    s.restore();
    let out = page(S);
    assert(stripTags(out).includes('Someone changed this award. Reload to see it.') && out.includes('data-action="la-reload"'));
    assert.equal(X(S).busy, false);
    s = stub((m, url) => Promise.resolve(detail(award({ updatedAt: 3000, note: 'Theirs' }))));
    G.handlers.click['la-reload']();
    await tick();
    s.restore();
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/a/lo_1']);
    out = page(S);
    assert(!out.includes('la-reload') && out.includes('value="Theirs"') && X(S).data.award.updatedAt === 3000);
  }));

  await check('Edit details: a Worker field error shows at its field; another error shows above the Save bar', withState(async (S) => {
    let s = stub((m, url) => (m === 'patch' ? Promise.reject(new G.api.ApiError(400, { error: 'invalid', message: 'That is not a character name.', field: 'winnerName' })) : routes()(m, url)));
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    G.handlers.input['la-winner'](el({}, { value: 'X1' }));
    G.handlers.submit['la-form']();
    await tick();
    s.restore();
    let out = page(S);
    assert(out.includes('That is not a character name.') && out.includes('aria-invalid="true"'));
    s = stub((m, url) => (m === 'patch' ? Promise.reject(new G.api.ApiError(409, { error: 'raid_not_started', message: 'That raid has not started yet.', field: 'raidId' })) : routes()(m, url)));
    G.handlers.change['la-raid'](el({}, { value: 'r9' }));
    G.handlers.submit['la-form']();
    await tick();
    s.restore();
    out = page(S);
    assert(out.includes('That raid has not started yet.'));
  }));

  await check('Edit details: Cancel leaves edit mode with the saved values; Delete award asks, deletes and goes back to the night', withState(async (S) => {
    const s = stub(routes((m) => Promise.resolve({ ok: true })));
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    G.handlers.input['la-note'](el({}, { value: 'x' }));
    G.handlers.click['la-edit-close']();
    assert.equal(X(S).editing, false);
    assert(!page(S).includes('data-submit="la-form"'));
    const opened = [];
    const realOpen = G.ui.openDialog, realRun = G.ui.runDialog;
    G.ui.openDialog = html => { opened.push(html); return null; };
    G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    G.handlers.click['la-delete']();
    assert(opened[0].includes('Delete this award?') && opened[0].includes('data-submit="la-delete-form"'));
    G.handlers.submit['la-delete-form']({ getAttribute: () => 'lo_1' });
    await tick();
    s.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun;
    assert.deepEqual(s.calls.filter(c => c.m === 'del').map(c => c.url), ['/api/guild/g1/loot/lo_1']);
    assert.equal(sandbox.window.location.hash, '#/g/g1/loot/n/r1');
  }));

  // ── Needs fixing ──
  const dupe = (n) => award({ id: 'lo_d' + n, raidId: 'r1', tag: 'MS' });
  const FIX = () => ({
    team: { id: 't1', name: 'Team KJ' },
    duplicates: [{ key: 'r1:28770:raawtotem', raidId: 'r1', raidOn: '2026-09-04', itemId: 28770, itemName: 'Gloves of the Forgotten Protector', winnerKey: 'raawtotem', winnerName: 'Raawtotem', awards: [dupe(1), dupe(2)] }],
    unknown: [award({ id: 'lo_u1', winner: { name: 'Zorgax', realm: null, class: null }, match: { kind: 'unmatched' } })],
  });
  const fixRoute = { name: 'lootfix', gid: 'g1' };

  await check('Needs fixing: duplicate groups (Open / Delete per award, Keep both) and unknown winners (Edit details); the header counts them', withState(async (S) => {
    const realFor = G.app.teamFor; G.app.teamFor = () => 't1';
    const s = stub(() => Promise.resolve(FIX()));
    await G.pages.lootFix.load(fixRoute, S.guilds.g1);
    s.restore(); G.app.teamFor = realFor;
    assert.deepEqual(s.calls.map(c => c.url), ['/api/guild/g1/loot/fix?team=t1']);
    const out = G.pages.lootFix.main(fixRoute, S.guilds.g1);
    const text = stripTags(out);
    assert(text.includes('Possible duplicates') && text.includes('Gloves of the Forgotten Protector') && text.includes('Award 1') && text.includes('Award 2') && text.includes('Keep both'));
    assert(out.includes('href="#/g/g1/loot/a/lo_d1"') && out.includes('data-action="lf-delete" data-aid="lo_d2"') && out.includes('data-action="lf-keep"'));
    assert(text.includes('Unknown winner names') && text.includes('Zorgax') && out.includes('href="#/g/g1/loot/a/lo_u1?edit=1"'));
    assert(text.includes('1 possible duplicate, 1 unknown winner'));
  }));

  await check('Needs fixing: Keep both posts the group and removes it; Delete one reloads the list; nothing left shows the empty state; a member gets the plain state', withState(async (S) => {
    const realFor = G.app.teamFor; G.app.teamFor = () => 't1';
    let s = stub(() => Promise.resolve(FIX()));
    await G.pages.lootFix.load(fixRoute, S.guilds.g1);
    s.restore();
    s = stub(() => Promise.resolve({ ok: true, key: 'k' }));
    G.handlers.click['lf-keep'](el({ 'data-group': 'r1:28770:raawtotem' }));
    await tick();
    s.restore();
    assert.deepEqual(s.calls.map(c => [c.m, c.url, c.body]), [['post', '/api/guild/g1/loot/fix/keep', { raidId: 'r1', itemId: 28770, winnerKey: 'raawtotem' }]]);
    assert.equal(S.att.lootFix.data.duplicates.length, 0);
    let out = G.pages.lootFix.main(fixRoute, S.guilds.g1);
    assert(!out.includes('Keep both') && stripTags(out).includes('None.'));
    // Delete one: the dialog, the DELETE, then the list is read again.
    S.att.lootFix.data = FIX();
    const opened = [];
    const realOpen = G.ui.openDialog, realRun = G.ui.runDialog;
    G.ui.openDialog = html => { opened.push(html); return null; };
    G.ui.runDialog = (form, promise, ok) => promise.then(ok);
    G.handlers.click['lf-delete'](el({ 'data-aid': 'lo_d2' }));
    assert(opened[0].includes('data-submit="lf-delete-form"') && opened[0].includes('data-aid="lo_d2"'));
    s = stub((m) => Promise.resolve(m === 'del' ? { ok: true } : { team: { id: 't1', name: 'Team KJ' }, duplicates: [], unknown: [] }));
    G.handlers.submit['lf-delete-form']({ getAttribute: () => 'lo_d2' });
    await tick();
    s.restore(); G.ui.openDialog = realOpen; G.ui.runDialog = realRun;
    assert.deepEqual(s.calls.map(c => c.m + ' ' + c.url), ['del /api/guild/g1/loot/lo_d2', 'get /api/guild/g1/loot/fix?team=t1']);
    out = G.pages.lootFix.main(fixRoute, S.guilds.g1);
    assert(out.includes('id="lf-empty"') && stripTags(out).includes('Nothing needs fixing'));
    s = stub(() => Promise.reject(new G.api.ApiError(403, { error: 'forbidden' })));
    await G.pages.lootFix.load(fixRoute, S.guilds.g1);
    s.restore(); G.app.teamFor = realFor;
    assert(stripTags(G.pages.lootFix.main(fixRoute, S.guilds.g1)).includes('Only Team Leads and above can fix loot.'));
  }));

  // ── Import preview: conflict and deleted rows ──
  const R = G.pages.raidLoot;
  const row = (over) => Object.assign({ checksum: 'c1', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: 1791681160000, winnerName: 'Drenna', winnerRealm: 'Firemaw', winnerClass: 'MAGE',
    match: { kind: 'character', personId: 'p_dr', personName: 'Drenna', characterName: 'Drenna' }, tag: 'MS', flags: [], rollType: 'MS', status: 'new' }, over || {});
  const ROWS = [
    row({ checksum: 'n1', status: 'new' }),
    row({ checksum: 'x1', status: 'conflict', awardId: 'lo_1', conflicts: [{ field: 'winner', export: 'Drenna', officer: 'Healthas' }] }),
    row({ checksum: 'd1', status: 'deleted', itemName: 'Blessed Band of Karabor', deleted: { at: 1, raidId: 'r1' } }),
    row({ checksum: 'x2', status: 'conflict', awardId: 'lo_2', conflicts: [{ field: 'item', export: 'Warp Slicer', officer: 'Eye of Gruul' }, { field: 'raid', export: '2026-09-18', officer: '2026-09-25' }] }),
  ];
  const COUNTS = { new: 1, update: 0, same: 0, otherRaid: 0, otherDay: 0, conflict: 2, deleted: 1 };
  const uiOf = (over) => Object.assign(R.freshUi(), { open: true, stage: 'preview', parsed: { awards: [{}], skipped: [], rows: 1 }, preview: { rows: ROWS, counts: COUNTS } }, over || {});
  const panel = (ui) => R.importPanelHtml(ui, gd(OFFICER_CAN));

  await check('import preview: conflict and deleted rows come first with Keep officer\'s / Keep deleted selected; the counts show', () => {
    const out = panel(uiOf());
    const text = stripTags(out);
    assert(out.includes('id="gl-decisions"') && text.includes('3 awards need your decision') && text.includes('Keep all officer changes'));
    assert(out.indexOf('id="gl-decisions"') < out.indexOf('Preview of the import'), 'the decisions are listed before the other rows');
    assert(text.includes("Keep officer's (Healthas)") && text.includes('Use export (Drenna)'));
    assert(text.includes("Keep officer's (Eye of Gruul, 2026-09-25)") && text.includes('Use export (Warp Slicer, 2026-09-18)'));
    assert(text.includes('Keep deleted') && text.includes('Add back'));
    assert(text.includes('Winner: an officer set Healthas, the export says Drenna.'));
    assert(text.includes('Conflicts') && text.includes('Deleted by an officer'));
    for (const id of ['x1', 'x2', 'd1']) {
      assert(new RegExp('id="gl-res-' + id + '-officer"[^>]*checked').test(out), id + ' defaults to the officer');
      assert(!new RegExp('id="gl-res-' + id + '-export"[^>]*checked').test(out));
    }
    assert(!out.includes('data-checksum="n1"'), 'a plain new row is not a decision');
    assert(text.includes('3 changed or deleted awards keep the officer'));
  });

  await check('import preview: choosing the export, then Keep all officer changes resets every row', withState(async (S) => {
    S.att.raid = { gid: 'g1', rid: 'r1', data: { raid: { id: 'r1', team: { id: 't1' } } } };
    const ui = uiOf();
    S.att.raidLoot = { gid: 'g1', rid: 'r1', status: 'ok', data: { awards: [], canEdit: true }, ui };
    G.handlers.change['loot-resolve'](el({ 'data-checksum': 'x1', 'data-key': 'k' }, { checked: true, value: 'export' }));
    G.handlers.change['loot-resolve'](el({ 'data-checksum': 'd1', 'data-key': 'k' }, { checked: true, value: 'export' }));
    assert.deepEqual(plain(ui.resolutions), { x1: 'export', d1: 'export' });
    const out = panel(ui);
    assert(/id="gl-res-x1-export"[^>]*checked/.test(out) && /id="gl-res-d1-export"[^>]*checked/.test(out) && /id="gl-res-x2-officer"[^>]*checked/.test(out));
    assert(stripTags(out).includes('3 awards will be imported.'), '1 new + 2 taken from the export');
    G.handlers.change['loot-resolve'](el({ 'data-checksum': 'x1', 'data-key': 'k' }, { checked: true, value: 'officer' }));
    assert.deepEqual(plain(ui.resolutions), { d1: 'export' });
    G.handlers.click['loot-keep-all']();
    assert.deepEqual(plain(ui.resolutions), {});
    assert(/id="gl-res-d1-officer"[^>]*checked/.test(panel(ui)));
  }));

  await check('import preview: Import sends resolutions for the export rows only, and the result line counts conflicts and deleted awards', withState(async (S) => {
    S.att.raid = { gid: 'g1', rid: 'r1', data: { raid: { id: 'r1', team: { id: 't1' } } } };
    const ui = uiOf({ resolutions: { x2: 'export', d1: 'export' } });
    ui.parsed = { awards: [{ itemId: 1 }, { itemId: 2 }], skipped: [], rows: 2 };
    S.att.raidLoot = { gid: 'g1', rid: 'r1', status: 'ok', data: { awards: [], canEdit: true }, ui };
    const s = stub((m) => Promise.resolve(m === 'post' ? { inserted: 2, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 0, conflicts: { kept: 1, exported: 1 }, deleted: { kept: 0, readded: 1 }, awards: [] } : { awards: [], canEdit: true }));
    G.handlers.click['loot-commit']();
    await tick();
    s.restore();
    const post = s.calls.filter(c => c.m === 'post');
    assert.equal(post.length, 1);
    assert.deepEqual(post[0].body.resolutions, { x2: 'export', d1: 'export' });
    assert.equal(ui.stage, 'done');
    assert.deepEqual(plain(ui.result.conflicts), { kept: 1, exported: 1 });
    const text = stripTags(panel(ui));
    assert(text.includes('Conflicts: 1 kept as the officer\'s, 1 taken from the export.') && text.includes('Deleted awards: 0 kept deleted, 1 added back.'));
    // Nothing chosen: no resolutions key at all.
    ui.stage = 'preview'; ui.resolutions = {}; ui.parsed = { awards: [{ itemId: 1 }], skipped: [], rows: 1 }; ui.busy = false;
    const s2 = stub((m) => Promise.resolve(m === 'post' ? { inserted: 0, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 0, conflicts: { kept: 2, exported: 0 }, deleted: { kept: 1, readded: 0 }, awards: [] } : { awards: [], canEdit: true }));
    G.handlers.click['loot-commit']();
    await tick();
    s2.restore();
    assert(!('resolutions' in s2.calls.filter(c => c.m === 'post')[0].body));
  }));

  await check('phones: the loot pages use cards on a phone and the Save bar sits above the tab bar (CSS markers)', () => {
    const css = fs.readFileSync(path.join(ROOT, 'guild.css'), 'utf8');
    for (const sel of ['.gs-loot-award', '.gs-la-form', '.gs-lf-group', '.gs-loot-decide']) assert(css.includes(sel), sel + ' is styled');
    assert(/@media[^{]*max-width:\s*(7\d\d|6\d\d|5\d\d)px[\s\S]*?\.gs-lf-award/.test(css), 'the Needs fixing award rows have a phone rule');
    assert(/\.gs-savebar[^{]*\{[^}]*position:\s*sticky/.test(css) || /\.gs-savebar[^{]*\{[^}]*position:\s*fixed/.test(css), 'the Save bar sticks');
  });

  // F5: the award record, Edit details and Needs fixing are on Forge: gs-forge root, gs-hd-panel sections, the tag a word, chips only for exceptions.
  await check('F5: award record, Edit details and Needs fixing have a gs-forge root and gs-hd-panel sections; states too', withState(async (S) => {
    const root = html => (html.match(/^<div class="([^"]*)"/) || [])[1] || '';
    const s = stub(routes());
    await G.pages.lootAward.load(route(), S.guilds.g1);
    const read = page(S);
    X(S).editing = true;
    await G.pages.lootAward.load(route({ edit: true }), S.guilds.g1);
    const edit = page(S);
    s.restore();
    S.att.lootAward = { gid: 'g1', aid: 'lo_1', status: 'denied' };
    const denied = page(S);
    S.att.lootAward = { gid: 'g1', aid: 'lo_1', status: 'none' };
    const none = page(S);
    const realFor = G.app.teamFor; G.app.teamFor = () => 't1';
    const s2 = stub(() => Promise.resolve(FIX()));
    await G.pages.lootFix.load(fixRoute, S.guilds.g1);
    s2.restore(); G.app.teamFor = realFor;
    const fix = G.pages.lootFix.main(fixRoute, S.guilds.g1);
    S.att.lootFix.data = { team: { name: 'Team KJ' }, duplicates: [], unknown: [] };
    const fixEmpty = G.pages.lootFix.main(fixRoute, S.guilds.g1);
    S.att.lootFix = { gid: 'g1', teamId: 't1', status: 'denied' };
    const fixDenied = G.pages.lootFix.main(fixRoute, S.guilds.g1);
    const loading = G.pages.lootAward.main(route({ aid: 'lo_other' }), S.guilds.g1);
    const all = { read, edit, denied, none, fix, fixEmpty, fixDenied, loading };
    Object.keys(all).forEach(name => {
      assert(/\bgs-forge\b/.test(root(all[name])), name + ' root has gs-forge: ' + root(all[name]));
      assert(!/gs-osection(?!-bare)|gs-empty-card|gs-card-sec|gs-chip-tag|gs-chip-flag/.test(all[name]), name + ' uses no old card, section or chip look');
    });
    ['read', 'edit', 'fix'].forEach(name => assert(/<section class="gs-hd-panel gs-pr-panel/.test(all[name]), name + ' sections are gs-hd-panel'));
    ['denied', 'none', 'fixDenied', 'fixEmpty'].forEach(name => assert(/<section class="gs-hd-panel gs-rs-state/.test(all[name]), name + ' state is a gs-hd-panel'));
    assert(all.loading.includes('aria-busy="true"') && all.loading.includes('gs-hd-sk'));
    assert(/class="gs-lt-tag"/.test(read) && !/gs-hd-chip/.test(read), 'the tag is a word and a clean award carries no chip');
    assert(/<span class="gs-hd-chip is-(rose|grey)">(Not on roster|Guest)<\/span>/.test(fix) || !/Not on roster|Guest/.test(fix), 'a winner chip is a Forge chip');
    assert(/data-action="la-edit-open"/.test(read) && (read.match(/gs-btn-molten/g) || []).length === 1, 'one primary on the record');
  }));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
