/**
 * Raidsmith guild tracker - PM wave 5 CONTRACT tests (Worker <-> pages): the pre-raid loot board and manual loot awards
 * Run: node tests/guild/guild-wave5-contract-tests.js [name-filter]
 *
 * guild-wave5-worker-tests.js and guild-wave5-ui-tests.js each work with hand-made data on the other side. This suite joins them, the way
 * guild-wave4-contract-tests.js does: the real pages (tests/guild-scripts.js in a vm, no DOM) call the real Worker (worker/index.js over the node:sqlite D1
 * stand-in) through G.api, their real handlers run - the TMB and softres text is decoded by the real parsers - and what they draw from the real answers is
 * checked next to what the Worker stored. Discord is never called.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');
const { GUILD_SCRIPTS } = require('../guild-scripts');

const ROOT = require('path').join(__dirname, '..', '..');
const ORIGIN = 'https://raidsmith.test';
const SERVER = '900000000000000061';
const PEOPLE = {
  alice: { id: '110000000000000601', username: 'alice', globalName: 'Alice A' },
  erin: { id: '110000000000000605', username: 'erin', globalName: 'Erin E' },
};
const NOW = Date.parse('2026-10-17T16:00:00Z');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));
const stripTags = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const ctrl = (value, extra) => Object.assign({ value, checked: false, focus() {}, setAttribute() {} }, extra || {});
// The form of the add-award dialog: its fields by control name, and the two lookups a refused field uses (the error line under it and the input).
const addForm = (values) => ({
  elements: Object.fromEntries(Object.entries(Object.assign({ itemRef: '', itemName: '', winner: '', tag: 'MS', note: '' }, values)).map(([k, v]) => [k, ctrl(v)])),
  querySelector: (sel) => (/^#dlg-err-|^\[data-field=/.test(sel) ? ctrl('') : null),
});
const el = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), disabled: false }, extra || {});
const settle = async () => { for (let i = 0; i < 24; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };
const encode = (value) => zlib.deflateSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');

// ---------------------------------------------------------------------------
// The Worker side

async function makeWorld() {
  const { createApp } = await import(pathToFileURL(path.join(ROOT, 'worker/index.js')).href);
  const db = createD1Fake();
  const discord = { next: null, tokens: new Map(), calls: 0 };
  const fakeFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    discord.calls++;
    if (u.pathname === '/api/oauth2/token') {
      const token = `tok${discord.calls}`;
      discord.tokens.set(token, discord.next);
      return Response.json({ access_token: token, token_type: 'Bearer' });
    }
    if (u.pathname === '/api/oauth2/token/revoke') return Response.json({});
    const bearer = /^Bearer (.+)$/.exec((init.headers && init.headers.Authorization) || '');
    const session = bearer && discord.tokens.get(bearer[1]);
    if (!session) return new Response('{}', { status: 401 });
    if (u.pathname === '/api/v10/users/@me') return Response.json(session.user);
    if (u.pathname === '/api/v10/users/@me/guilds') return Response.json(session.servers);
    return new Response('{}', { status: 404 });
  };
  const clock = { now: NOW };
  let counter = 0;
  const randomBytes = (length) => {
    counter++;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i < 4 ? (counter >> (8 * i)) & 255 : (i * 37 + 11) & 255;
    return bytes;
  };
  const env = { DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'client-secret', DISCORD_REDIRECT_URI: `${ORIGIN}/auth/callback`, GUILD_CREATOR_ALLOWLIST: PEOPLE.alice.id };
  const app = createApp({ db, env, fetch: fakeFetch, now: () => clock.now, randomBytes, log: () => {} });
  return { db, clock, discord, app, env };
}

function absorb(jar, response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';').map((part) => part.trim());
    const index = pair.indexOf('=');
    if (attrs.some((attr) => /^Max-Age=0$/i.test(attr))) delete jar[pair.slice(0, index)];
    else jar[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

const fetchFor = (world, jar) => async (urlPath, init = {}) => {
  const headers = { ...(init.headers || {}) };
  if (Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const response = await world.app.handle(new Request(`${ORIGIN}${urlPath}`, { method: init.method, headers, body: init.body }));
  absorb(jar, response);
  return response;
};

async function signIn(world, person, servers) {
  const jar = {};
  world.discord.next = { user: { id: person.id, username: person.username, global_name: person.globalName, avatar: null }, servers };
  const login = await fetchFor(world, jar)('/auth/login', { method: 'GET' });
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  await fetchFor(world, jar)(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, { method: 'GET' });
  return jar;
}

// ---------------------------------------------------------------------------
// The pages side

function loadPages(world, jar) {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout, Uint8Array, atob, TextDecoder, DecompressionStream };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  const G = sandbox.Guild;
  const f = fetchFor(world, jar);
  for (const [name, method] of [['get', 'GET'], ['post', 'POST'], ['put', 'PUT'], ['patch', 'PATCH'], ['del', 'DELETE']]) {
    G.api[name] = (urlPath, body) => G.api.request(method, urlPath, body, f);
  }
  G.texts = {};
  G.errors = [];
  G.dialogs = [];
  G.ui.setText = (id, text) => { G.texts[id] = text; };
  G.ui.setBusy = () => {};
  G.ui.openDialog = (html) => { G.dialogs.push(html); return {}; };
  G.app.render = () => {};
  G.app.handleError = (err) => { G.errors.push(err); };
  G.app.go = () => {};
  return G;
}

const MEMBER_SERVER = [{ id: SERVER, name: 'Server', icon: null, owner: false, permissions: '0' }];
const OFFICER_SERVER = [{ id: SERVER, name: 'Server', icon: null, owner: true, permissions: '8' }];
const SPEC_OF = { WARRIOR: 'Arms', MAGE: 'Fire', PRIEST: 'Holy' };

async function scenario() {
  const world = await makeWorld();
  const A = loadPages(world, await signIn(world, PEOPLE.alice, OFFICER_SERVER));
  const created = await A.api.post('/api/guild', { serverId: SERVER, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: false });
  const gid = created.guild.id;
  const teamId = created.teams[0].id;
  const base = `/api/guild/${gid}`;
  const E = loadPages(world, await signIn(world, PEOPLE.erin, MEMBER_SERVER));
  const erinUser = (await E.api.get('/auth/me')).user.id;
  const s = { world, A, E, gid, teamId, base };
  s.person = async (name, cls = 'WARRIOR', link = null) => {
    const res = await A.api.post(`${base}/roster`, { teamId, name, class: cls, mainSpec: SPEC_OF[cls], offSpec: null, status: 'raider', ...(link ? { linkUserId: link } : {}) });
    return res.person.id;
  };
  s.erinUser = erinUser;
  s.rows = (sql, ...values) => world.db.prepare(sql).bind(...values).all().then((r) => r.results);
  s.refresh = async () => { for (const G of [A, E]) G.guildData = await G.api.get(base); };
  return s;
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function pageState(s, G) {
  const S = G.app.state;
  S.att = {};
  S.guilds = { [s.gid]: G.guildData };
  S.currentGid = s.gid;
  S.pageAlert = '';
  G.app.teamFor = () => s.teamId;
  return S;
}
const openRaid = async (s, G, rid) => {
  const S = pageState(s, G);
  const route = { name: 'raid', gid: s.gid, rid };
  await G.pages.raid.load(route, G.guildData);
  return { S, route, html: () => G.pages.raid.main(route, G.guildData) };
};
const menuLabels = (html) => {
  const at = html.indexOf('id="raid-actions-list"');
  if (at < 0) return [];
  const menu = html.slice(at, html.indexOf('</div></div>', at));
  return [...menu.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map((m) => m[1]);
};
// The Loot prios summary in the side column (what was pasted, the paste buttons).
const summaryText = (html) => {
  const at = html.indexOf('id="board-sum-h"');
  return at < 0 ? '' : stripTags(html.slice(at, html.indexOf('</section>', at)));
};
// The Loot prios item list in the main column, then the summary.
const boardText = (html) => {
  const at = html.indexOf('id="board-h"');
  return (at < 0 ? '' : stripTags(html.slice(at, html.indexOf('</section>', at)))) + ' ' + summaryText(html);
};
const paste = (G, list, text) => {
  G.handlers.click['board-open'](el({ 'data-list': list }));
  G.handlers.input['board-paste'](ctrl(text));
};

// ---------------------------------------------------------------------------

check('Loot board: an officer pastes the TMB and softres exports through the real panels; the board lines the roster up, marks roll-offs and greys what an earlier raid gave; a member sees it but cannot paste', async () => {
  const s = await scenario();
  const { A, E } = s;
  const aldric = await s.person('Aldric');
  const brindle = await s.person('Brindle', 'MAGE', s.erinUser);
  const cassia = await s.person('Cassia', 'PRIEST');
  await s.refresh();
  // An earlier raid where Aldric got the sword (a Gargul award), then the upcoming raid with three sign-ups.
  const old = (await A.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn: '2026-10-10', startTime: '20:00', zone: "Gruul's Lair" })).raid.id;
  await A.api.post(`${s.base}/raids/${old}/loot`, { awards: [{ checksum: 'GARG000000000001', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: Date.parse('2026-10-10T20:30:00-04:00'), winnerName: 'Aldric', winnerRealm: 'Nightslayer', winnerClass: 'WARRIOR', rollType: 'MS', flags: [], awardedBy: 'Lead-Nightslayer' }] });
  const up = (await A.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn: '2026-10-24', startTime: '20:00', zone: "Gruul's Lair" })).raid.id;
  for (const pid of [aldric, brindle, cassia]) await A.api.put(`${s.base}/raids/${up}/signups/${pid}`, { kind: 'signed' });
  await A.api.put(`${s.base}/raids/${up}/signups/${cassia}`, { kind: 'absence' });

  const page = await openRaid(s, A, up);
  assert.equal(page.S.att.raidBoard.status, 'ok');
  assert.deepEqual(menuLabels(page.html()), ['Open in Planner', 'Raid settings', 'Guest sign-up link', 'Delete raid']);
  assert(summaryText(page.html()).includes('Paste the ThatsMyBIS prios and the softres.it reserves of this raid'), 'nothing pasted yet');

  // TMB: Aldric and Brindle share prio 1 on the sword (Aldric already got it), Brindle is alone on the staff, Cassia (absent) and a stranger are on other items.
  const TMB = encode({ wishlists: {
    28770: ['aldric|1|1|1', 'brindle|1|1|1', 'cassia|2|2|1'],
    30311: ['brindle|1|1|1', 'zorgax|1|1|1'],
    29000: ['cassia|1|1|1'],
  } });
  paste(A, 'tmb', TMB);
  A.handlers.click['board-read']();
  await settle();
  const x = page.S.att.raidBoard;
  assert.equal(x.ui.stage, 'preview', x.ui.error);
  assert(stripTags(A.pages.raidBoard.panelHtml(x)).includes('Read 5 prio rows and 1 wishlist row for 3 items and 4 characters.'));
  A.handlers.click['board-save']();
  await settle();
  assert.equal(x.ui.stage, 'done', x.ui.error);
  assert.deepEqual((await s.rows('SELECT source, kind, name_key, item_id, prio FROM raid_loot_lists ORDER BY source, position')).map((r) => `${r.kind}:${r.name_key}:${r.item_id}:${r.prio}`),
    ['prio:aldric:28770:1', 'prio:brindle:28770:1', 'wish:cassia:28770:2', 'prio:cassia:29000:1', 'prio:brindle:30311:1', 'prio:zorgax:30311:1']);

  let text = boardText(page.html());
  assert(text.includes('Loot prios') && text.includes('2 items'), text.slice(0, 300));
  assert(/TMB prios\s*:\s*6 rows, pasted/.test(text) && /Soft-reserves\s*:\s*not pasted/.test(text));
  assert(text.includes('In line: the 2 people signed up, placed or present on this raid.'));
  assert(text.includes('Prio #1 Aldric') && text.includes('Already got it'), 'the sword Aldric got on 2026-10-10 is greyed');
  assert(text.includes('Nathrezim Mindblade'), 'the item is named from the guild\'s own award history');
  assert(text.includes('Item 30311') && text.includes('Prio #1 Brindle'));
  assert(text.includes('2 TMB names are not on the roster') === false && text.includes('1 TMB name is not on the roster') && text.includes('Zorgax'), text);
  assert(!page.html().includes('is-contested'), 'Aldric already has it, so Brindle is alone at the top');

  // softres: a pug reserves the sword and the staff; Brindle also reserved the staff.
  paste(A, 'softres', encode({ metadata: { id: 'abc' }, softreserves: [{ name: 'Pugone', items: [{ id: 28770 }, { id: 28770 }, { id: 30311 }] }, { name: 'Brindle', items: [{ id: 30311 }] }], hardreserves: [] }));
  A.handlers.click['board-read']();
  await settle();
  A.handlers.click['board-save']();
  await settle();
  text = boardText(page.html());
  assert(/Soft-reserves\s*:\s*3 rows, pasted/.test(text));
  const html = page.html();
  const rows = html.split('<li class="gs-board-row').slice(1);
  assert.equal(rows.length, 2);
  const sword = rows.find((r) => r.includes('Nathrezim Mindblade'));
  const staff = rows.find((r) => r.includes('Item 30311'));
  assert(sword.includes('is-contested') && stripTags(sword).includes('Roll-off'), 'Brindle (prio 1) and a pug on the sword: a roll-off');
  assert(stripTags(sword).includes('Prio #1 Aldric Already got it Prio #1 Brindle SR x2 Pugone Guest'));
  assert(staff.includes('is-contested') && stripTags(staff).includes('Prio #1 Brindle SR Brindle SR Pugone Guest'), 'Brindle on both lists counts once, the pug makes the second');

  // A member of the team sees the board, but no paste controls; the Worker refuses her paste.
  const memberPage = await openRaid(s, E, up);
  const mHtml = memberPage.html();
  assert(mHtml.includes('id="board-h"') && boardText(mHtml).includes('Nathrezim Mindblade'));
  assert(!mHtml.includes('data-action="board-open"') && !mHtml.includes('data-action="board-remove"') && !mHtml.includes('bd-paste'));
  assert.deepEqual(menuLabels(mHtml), []);
  await assert.rejects(E.api.loot.saveList(s.gid, up, 'tmb', []), (err) => err.status === 403);

  // Removing the softres list through the real dialog draws the board without it.
  A.handlers.click['board-remove'](el({ 'data-list': 'softres' }));
  assert(A.dialogs[A.dialogs.length - 1].includes('Remove the Soft-reserves?'));
  A.handlers.submit['board-remove-form']({ getAttribute: (k) => ({ 'data-list': 'softres' })[k] });
  await settle();
  assert.equal(await s.rows("SELECT COUNT(*) AS n FROM raid_loot_lists WHERE source = 'softres'").then((r) => r[0].n), 0);
  assert(/Soft-reserves\s*:\s*not pasted/.test(boardText(page.html())));

  // The Activity log says what happened in words.
  const log = await A.api.get(`${s.base}/audit?group=loot`);
  const sentences = log.rows.filter((r) => r.action === 'loot.list').map((r) => r.text);
  assert.equal(sentences.length, 3);
  assert(sentences.includes('Cleared the soft-reserves of the raid on ' + A.ui.weekdayDay('2026-10-24')), sentences.join(' | '));
  assert(sentences.some((t) => t.startsWith('Pasted the TMB loot prios for the raid on ') && t.endsWith('(6 rows for 3 items)')), sentences.join(' | '));
});

check('Loot board after the raid: the Gargul import is compared with the line, an award made by hand through the real dialog joins the list, the balance and the comparison', async () => {
  const s = await scenario();
  const { A } = s;
  const aldric = await s.person('Aldric');
  const brindle = await s.person('Brindle', 'MAGE');
  await s.refresh();
  const past = (await A.api.post(`${s.base}/raids`, { teamId: s.teamId, raidOn: '2026-10-10', startTime: '20:00', zone: "Gruul's Lair" })).raid.id;
  await A.api.put(`${s.base}/raids/${past}/manual`, { reason: 'No log kept', presentPlayerIds: [aldric, brindle] });
  const page = await openRaid(s, A, past);
  assert(page.html().includes('data-action="loot-add-open"') && !menuLabels(page.html()).includes('Add loot award'), 'Add award is in the Loot panel, not in More');
  paste(A, 'tmb', encode({ wishlists: { 28770: ['aldric|1|1|1', 'brindle|2|1|1'], 30311: ['brindle|1|1|1'], 30312: ['aldric|1|1|1'] } }));
  A.handlers.click['board-read']();
  await settle();
  A.handlers.click['board-save']();
  await settle();
  assert(boardText(page.html()).includes('3 items'));

  // Gargul gave the sword to Brindle (prio 2); the staff is still open.
  await A.api.post(`${s.base}/raids/${past}/loot`, { awards: [{ checksum: 'GARG000000000001', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: Date.parse('2026-10-10T20:30:00-04:00'), winnerName: 'Brindle', winnerRealm: 'Nightslayer', winnerClass: 'MAGE', rollType: 'MS', flags: [], awardedBy: 'Lead-Nightslayer' }] });
  await A.pages.raidLoot.loadFor(A.guildData, page.S.att.raid.data);
  await A.pages.raidBoard.refresh();
  let text = boardText(page.html());
  assert(text.includes('Went to a lower prio: Brindle'), text);

  // The staff, by hand: through the real dialog (a roster name, a tag, a note).
  A.handlers.click['loot-add-open']();
  await settle();
  const dialog = A.dialogs[A.dialogs.length - 1];
  assert(dialog.includes('<option value="Aldric"></option>') && dialog.includes('<option value="Brindle"></option>'), 'the roster names are offered');
  A.handlers.submit['loot-add-form'](addForm({ itemRef: 'https://www.wowhead.com/tbc/item=30311/the-staff', itemName: 'The Staff', winner: 'Brindle', note: 'Handed out after the raid' }));
  await settle();
  const award = (await s.rows('SELECT * FROM loot_awards WHERE manual = 1'))[0];
  assert.deepEqual([award.item_id, award.item_name, award.winner_name, award.tag, award.note, award.source, award.checksum.length], [30311, 'The Staff', 'Brindle', 'MS', 'Handed out after the raid', 'gargul', 38]);
  const listHtml = A.pages.raidLoot.panelHtml({ guildData: A.guildData, data: page.S.att.raid.data, state: page.S.att.raidLoot });
  assert(stripTags(listHtml).includes('The Staff') && stripTags(listHtml).includes('All 2 items'), stripTags(listHtml).slice(0, 400));
  const nightRoute = { name: 'lootnight', gid: A.guildData.guild.id, rid: page.S.att.raid.rid };
  await A.pages.lootNight.load(nightRoute, A.guildData);
  const loot = stripTags(A.pages.lootNight.main(nightRoute, A.guildData));
  assert(loot.includes('The Staff') && loot.includes('Manual') && loot.includes('Handed out after the raid') && loot.includes('2 awards'), loot.slice(0, 400));
  await settle();
  text = boardText(page.html());
  assert(text.includes('Went to prio #1: Brindle'), 'the board read again: Brindle was first in line for the staff');
  assert(text.includes('Went to a lower prio: Brindle'));

  // It counts in the balance next to the imported award.
  const balance = await A.api.get(`${s.base}/loot/balance?team=${s.teamId}`);
  assert.equal(balance.people.find((p) => p.personId === brindle).items.MS.all, 2);

  // A name nobody has goes to the Review queue; no winner is a disenchant.
  A.handlers.submit['loot-add-form'](addForm({ itemRef: '30313', winner: 'Visitor', tag: 'OS' }));
  A.handlers.submit['loot-add-form'](addForm({ itemRef: '30314', tag: 'DE' }));
  await settle();
  const stored = await s.rows('SELECT item_id, winner_name, tag FROM loot_awards WHERE manual = 1 ORDER BY item_id');
  assert.deepEqual(plain(stored), [{ item_id: 30311, winner_name: 'Brindle', tag: 'MS' }, { item_id: 30313, winner_name: 'Visitor', tag: 'OS' }, { item_id: 30314, winner_name: null, tag: 'DE' }]);
  const review = await A.api.get(`${s.base}/attendance/review?team=${s.teamId}`);
  assert(JSON.stringify(review).includes('Visitor'), 'the unmatched winner is in the Review queue');

  // A refusal from the Worker lands under the field it names.
  A.handlers.submit['loot-add-form'](addForm({ itemRef: '30315', winner: 'R2' }));
  await settle();
  assert.match(A.texts['dlg-err-winnerName'], /character name/);
  assert.equal(await s.rows('SELECT COUNT(*) AS n FROM loot_awards WHERE manual = 1').then((r) => r[0].n), 3);

  // Deleting a manual award says nothing about re-importing.
  const row = (await s.rows('SELECT id FROM loot_awards WHERE item_id = 30313'))[0];
  await A.pages.lootNight.load({ name: 'lootnight', gid: A.guildData.guild.id, rid: page.S.att.raid.rid }, A.guildData); // the night page lists the award the dialog deletes
  A.handlers.click['ln-delete'](el({ 'data-aid': row.id }));
  const confirm = A.dialogs[A.dialogs.length - 1];
  assert(confirm.includes('is removed from the raid and from the balance.') && !confirm.includes('Importing the same Gargul export'));
});

// ---------------------------------------------------------------------------

async function main() {
  const filter = process.argv[2] || '';
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${(error && error.stack ? error.stack : String(error)).split('\n').slice(0, 10).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
