/**
 * Raidsmith guild UI, Phase 7a (accounts with linked sign-ins) - tests for the sign-in choice, the Linked accounts cards, the person page's
 * Raidsmith account field and the privacy text.
 * Run: node guild-accounts-ui-tests.js
 *
 * Same approach as guild-bnet-ui-tests.js: the shared guild script list (tests/guild-scripts.js) is loaded in a vm sandbox with no DOM, the
 * render functions return HTML strings, and handlers that talk to the API run against a stubbed G.api. The routes through the real router and
 * the shell around the pages are driven in guild-shell-tests.js against fake documents.
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

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}
const ctx = loadGuild();
const fields = {};
ctx.document = { getElementById: id => fields[id] || null, querySelector: () => null, querySelectorAll: () => [] };
const G = ctx.Guild;
const plain = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&middot;/g, '-').replace(/\s+/g, ' ');

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';
function assertEscaped(out, label) {
  assert(!out.includes('<img src=x'), `${label}: raw tag leaked`);
  assert(!out.includes(' onfocus="alert(1)"'), `${label}: attribute break-out leaked`);
  assert(!/<script/i.test(out), `${label}: script tag leaked`);
}
function assertNoRawAttrs(out) {
  for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) {
    const names = tag.replace(/="[^"]*"/g, '=""');
    assert(!/\sstyle=/i.test(names), 'inline style attribute: ' + tag.slice(0, 80));
    assert(!/\son[a-z]+=/i.test(names), 'inline event handler attribute: ' + tag.slice(0, 80));
  }
}

// ── fixtures (the Worker's response shapes) ──────────────────────
const person = (id, displayName, extra) => Object.assign({ id, username: displayName.toLowerCase().split(' ')[0], displayName, avatarUrl: null, initials: displayName.slice(0, 2).toUpperCase() }, extra || {});
function me(extra) {
  return Object.assign({
    user: Object.assign(person('u1', 'Gale G'), { prefs: {} }),
    identities: { discord: { username: 'gale', globalName: 'Gale G' }, bnet: { battletag: 'Gale#0009', linkedAt: 1, refreshedAt: 1 } },
    account: { customName: null, available: { discord: true, bnet: true } },
    guilds: [], create: { allowed: false }, deleteImpact: { handOverFirst: [], guildsDeleted: [], autoPromote: [] }, removedFrom: [],
  }, extra || {});
}
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 17, 12);
function bnetData(extra) {
  return Object.assign({ configured: true, link: { battletag: 'Gale#0009', linkedAt: T0, fetchedAt: T0, expiresAt: T0 + 30 * DAY, expired: false }, guilds: [] }, extra || {});
}
function onlyBnet() { return me({ user: Object.assign(person('u2', 'Holly'), { prefs: {} }), identities: { discord: null, bnet: { battletag: 'Holly#1111', linkedAt: 1, refreshedAt: 1 } } }); }
function onlyDiscord() { return me({ identities: { discord: { username: 'gale', globalName: 'Gale G' }, bnet: null } }); }

function withApi(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = G.api[k]; G.api[k] = stubs[k]; }
  const savedGo = G.app.go;
  const hashes = [];
  G.app.go = h => hashes.push(h);
  return Promise.resolve(fn(hashes)).finally(() => { for (const k of Object.keys(saved)) G.api[k] = saved[k]; G.app.go = savedGo; });
}

(async () => {
  // ── router ─────────────────────────────────────────────────────
  await check('router: every reason a sign-in or a link can come back with parses, formats back, and has words', () => {
    assert.deepEqual(plain(G.router.parse('#/signin?error=bnet')), { name: 'signin', error: 'bnet' });
    assert.deepEqual(plain(G.router.parse('#/signin?error=not_configured')), { name: 'signin', error: 'not_configured' });
    assert.deepEqual(plain(G.router.parse('#/signin?error=<script>')), { name: 'signin', error: null });
    assert.equal(G.router.format({ name: 'signin', error: 'bnet' }), '#/signin?error=bnet');
    for (const key of ['denied', 'state', 'discord', 'bnet', 'not_configured']) {
      assert(G.pages.signin.SIGNIN_ERROR_TEXT[key], key);
      assert(G.pages.signin.signinHtml({ error: key }).includes('role="alert"'), key);
    }
    for (const key of G.router.LINKED_ERRORS) {
      assert.equal(G.router.parse('#/linked?error=' + key).error, key, key);
      assert.equal(G.router.format({ name: 'linked', error: key }), '#/linked?error=' + key, key);
      assert(G.pages.bnet.LINK_ERROR_TEXT[key], 'words for ' + key);
    }
    for (const key of ['discord_taken', 'has_discord', 'has_bnet', 'roster_conflict', 'discord']) assert(G.router.LINKED_ERRORS.includes(key), key);
  });

  // ── the sign-in card ───────────────────────────────────────────
  await check('sign in: the choice depends on what the server offers, Discord first, one account either way, and every string is escaped', () => {
    const both = G.pages.signin.signinHtml({ providers: { discord: true, bnet: true } });
    assert(both.includes('class="gs-signin-buttons"'));
    assert(/<a class="gs-btn gs-btn-molten gs-btn-block" href="\/auth\/login">[\s\S]*Continue with Discord/.test(both));
    assert(/<a class="gs-btn gs-btn-block" href="\/auth\/bnet\/login\?mode=signin">[\s\S]*Continue with Battle\.net/.test(both));
    const t = text(both);
    for (const s of ['Sign in to see your guild', 'Discord: Raidsmith reads your username', 'Battle.net: it reads your BattleTag', 'Either one makes your account the first time', 'Privacy & my data']) assert(t.includes(s), s);
    assert(!both.includes('Sign in with Discord'));
    const discordOnly = G.pages.signin.signinHtml({});
    assert(discordOnly.includes('Continue with Discord') && !discordOnly.includes('Battle.net') && text(discordOnly).includes('Signing in makes your account the first time'));
    assert(G.pages.signin.signinHtml({ providers: { discord: true, bnet: false } }).includes('Continue with Discord'));
    const bnetOnly = G.pages.signin.signinHtml({ providers: { discord: false, bnet: true } });
    assert(!bnetOnly.includes('/auth/login') && bnetOnly.includes('gs-btn gs-btn-molten gs-btn-block'));
    assert(G.pages.signin.signinHtml({ providers: { discord: true, bnet: true }, error: 'bnet' }).includes('Battle.net could not finish the sign-in'));
    assertEscaped(G.pages.signin.signinHtml({ providers: { discord: true, bnet: true }, notice: HOSTILE + QUOTES }), 'notice');
    assertNoRawAttrs(both);
  });

  await check('no guild: an account without Discord is not told to "sign in again"; it is told how an officer links it, and offered Connect Discord', () => {
    const noDiscord = me({ identities: { discord: null, bnet: { battletag: 'Holly#1111' } }, user: Object.assign(person('u2', 'Holly'), { prefs: {} }) });
    const card = G.pages.signin.noGuildHtml(noDiscord);
    const t = text(card);
    assert(t.includes('isn\'t linked to a roster entry yet') && t.includes('the whole thing, like Name#1234') && t.includes('Or connect Discord'));
    assert(card.includes('href="#/linked"') && t.includes('Connect Discord') && !card.includes('Sign in again') && !card.includes('href="/auth/login"'));
    assert(t.includes('Signed in as Holly'));
    assert(card.includes('class="gs-btn" href="/" data-action="open-planner"'), 'one primary button: Connect Discord, not the planner too');
    assert(G.pages.signin.noGuildHtml(me()).includes('class="gs-btn gs-btn-molten" href="/" data-action="open-planner"'), 'a Discord account with nothing to create keeps the planner as its primary button');
    const notice = G.pages.signin.noGuildNoticeHtml(noDiscord);
    assert(notice.includes('Connect Discord') && !notice.includes('Sign in again'));
    // A Discord account (or an answer without identities, from before accounts) keeps today's card.
    for (const m of [me(), me({ identities: undefined })]) {
      const c = G.pages.signin.noGuildHtml(m);
      assert(c.includes('Sign in again') && c.includes('href="/auth/login"') && text(c).includes('None of your Discord servers has a guild on Raidsmith'));
    }
    assertEscaped(G.pages.signin.noGuildHtml(me({ user: Object.assign(person('u3', HOSTILE + QUOTES), { prefs: {} }) })), 'name');
  });

  // ── Linked accounts: the name and Discord cards ────────────────
  await check('Linked accounts: with the /auth/me answer the page leads with the name and Discord cards, then Battle.net, in that order', () => {
    const out = G.pages.bnet.linkedHtml({ data: bnetData(), me: me() });
    const order = ['id="linked-name"', 'id="linked-discord"', 'id="linked-bnet"'].map(s => out.indexOf(s));
    assert(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], JSON.stringify(order));
    assert(text(out).includes('either one signs you in to the same account'));
    // Without it (older callers, a failed read) the page is the Battle.net page it was.
    const old = G.pages.bnet.linkedHtml({ data: bnetData() });
    assert(!old.includes('linked-name') && !old.includes('linked-discord') && old.includes('linked-bnet'));
    assertNoRawAttrs(out);
  });

  await check('Linked accounts: the name card shows where the name comes from, saves a custom one and can go back', () => {
    const plainName = G.pages.accounts.nameCardHtml(me());
    assert(text(plainName).includes('Shown as Gale G (your Discord name)'));
    assert(/<input class="gs-input" type="text" id="account-name" name="displayName" maxlength="32"[^>]* value=""/.test(plainName));
    assert(plainName.includes('data-submit="account-name-form"') && !plainName.includes('account-name-reset'), 'nothing to reset');
    assert(text(plainName).includes('Up to 32 characters') && text(plainName).includes('Leave it empty to use your Discord name'));
    const custom = G.pages.accounts.nameCardHtml(me({ account: { customName: 'Ember Gale', available: { discord: true, bnet: true } }, user: Object.assign(person('u1', 'Ember Gale'), { prefs: {} }) }));
    assert(text(custom).includes('Shown as Ember Gale .') && custom.includes('value="Ember Gale"') && custom.includes('data-action="account-name-reset"') && text(custom).includes('Use your Discord name'));
    const bn = G.pages.accounts.nameCardHtml(onlyBnet());
    assert(text(bn).includes('Shown as Holly (your BattleTag without its number)') && text(bn).includes('Leave it empty to use your BattleTag without its number'));
    assertEscaped(G.pages.accounts.nameCardHtml(me({ account: { customName: HOSTILE + QUOTES } , user: Object.assign(person('u1', HOSTILE + QUOTES), { prefs: {} }) })), 'name');
  });

  await check('Linked accounts: the Discord card - not connected (Connect, what it reads, accounts are never merged), connected, the only sign-in, and a server without Discord', () => {
    const off = G.pages.accounts.discordCardHtml(onlyBnet());
    assert(text(off).includes('Not connected') && off.includes('href="/auth/login?mode=link"') && text(off).includes('Connect Discord') && text(off).includes('accounts are never merged'));
    assert(!off.includes('discord-disconnect-open'));
    const on = G.pages.accounts.discordCardHtml(me());
    assert(text(on).includes('Connected') && text(on).includes('Connected as @gale .') && on.includes('data-action="discord-disconnect-open"') && !/data-action="discord-disconnect-open"[^>]*disabled/.test(on));
    assert(on.includes('href="/auth/login?mode=link"') && text(on).includes('Refresh my servers'));
    const only = G.pages.accounts.discordCardHtml(onlyDiscord());
    assert(/data-action="discord-disconnect-open"[^>]*disabled/.test(only) && only.includes('aria-describedby="discord-only"') && text(only).includes('Discord is the only way you sign in right now'));
    const unavailable = G.pages.accounts.discordCardHtml(me({ identities: { discord: null, bnet: { battletag: 'X#1' } }, account: { customName: null, available: { discord: false, bnet: true } } }));
    assert(text(unavailable).includes('Unavailable') && unavailable.includes('id="discord-not-set-up"') && !unavailable.includes('mode=link'));
    assertEscaped(G.pages.accounts.discordCardHtml(me({ identities: { discord: { username: HOSTILE + QUOTES }, bnet: null } })), 'username');
  });

  await check('Linked accounts: Battle.net cannot be disconnected while it is the only sign-in, and an expired character list says so', () => {
    const only = G.pages.bnet.linkedHtml({ data: bnetData({ link: { battletag: 'Holly#1111', linkedAt: T0, fetchedAt: T0, expiresAt: T0 + 30 * DAY, expired: false } }), me: onlyBnet() });
    assert(/data-action="bnet-disconnect-open"[^>]*disabled/.test(only) && only.includes('aria-describedby="bnet-only"') && text(only).includes('Battle.net is the only way you sign in right now'));
    const both = G.pages.bnet.linkedHtml({ data: bnetData(), me: me() });
    assert(!/data-action="bnet-disconnect-open"[^>]*disabled/.test(both) && !both.includes('bnet-only'));
    const withoutMe = G.pages.bnet.linkedHtml({ data: bnetData() });
    assert(!/data-action="bnet-disconnect-open"[^>]*disabled/.test(withoutMe), 'unknown = not the last one');
    const expired = G.pages.bnet.linkedHtml({ data: bnetData({ link: { battletag: 'Gale#0009', linkedAt: T0, fetchedAt: T0, expiresAt: T0 + 30 * DAY, expired: true } }), me: me() });
    const t = text(expired);
    assert(t.includes('deleted after 30 days. Connect again to load it') && t.includes('Load my characters') && !expired.includes('data-key="bnet-characters"'));
    assert(!t.includes('Raidsmith deletes them on'));
    const card = G.pages.bnet.guildCardHtml({ guildId: 'g1', guildName: 'Ember', supportLabel: 'TBC Anniversary', realm: 'Dreamscythe', realmKind: 'realm', status: 'expired', characters: [] });
    assert(card.includes('data-status="expired"') && text(card).includes('deleted after 30 days') && card.includes('href="/auth/bnet/login"'));
    const notConnected = text(G.pages.bnet.linkedHtml({ data: bnetData({ link: null }), me: onlyDiscord() }));
    assert(notConnected.includes('You can also sign in with it') && notConnected.includes('accounts are never merged') && notConnected.includes('Your BattleTag stays while Battle.net is connected'));
  });

  await check('Linked accounts: saving the name sends displayName (null clears it) and reloads /auth/me and /auth/bnet with a notice; a refusal shows next to the field', async () => {
    const s = G.app.state;
    s.bnet = { data: bnetData(), notice: '', alert: '' };
    const calls = [];
    const answers = { '/auth/me': me({ account: { customName: 'Ember Gale', available: { discord: true, bnet: true } } }), '/auth/bnet': bnetData() };
    const stubs = {
      patch: (url, body) => { calls.push(['PATCH', url, plain(body)]); return Promise.resolve({ customName: body.displayName }); },
      get: url => { calls.push(['GET', url]); return Promise.resolve(answers[url]); },
    };
    await withApi(stubs, async () => {
      G.handlers.submit['account-name-form']({ elements: { displayName: { value: '  Ember Gale ' } }, querySelectorAll: () => [] });
      await tick(); await tick(); await tick();
    });
    assert.deepEqual(calls, [['PATCH', '/api/me', { displayName: 'Ember Gale' }], ['GET', '/auth/me'], ['GET', '/auth/bnet']]);
    assert.equal(s.bnet.notice, 'Name saved.');
    assert.equal(s.me.account.customName, 'Ember Gale');
    calls.length = 0;
    await withApi(stubs, async () => {
      const el = { disabled: false };
      G.handlers.click['account-name-reset'](el);
      await tick(); await tick(); await tick();
      assert.equal(el.disabled, true, 'busy while it runs');
    });
    assert.deepEqual(calls[0], ['PATCH', '/api/me', { displayName: null }]);
    assert.equal(s.bnet.notice, 'Name reset.');
    // A refusal.
    fields['account-name-error'] = { textContent: '', hidden: true };
    await withApi({ patch: () => Promise.reject(new G.api.ApiError(400, { error: 'bad_request', message: 'displayName must be 1 to 32 characters of plain text.', field: 'displayName' })) }, async () => {
      G.handlers.submit['account-name-form']({ elements: { displayName: { value: 'x'.repeat(40) } }, querySelectorAll: () => [] });
      await tick(); await tick();
    });
    assert.equal(fields['account-name-error'].textContent, 'displayName must be 1 to 32 characters of plain text.');
    assert.equal(fields['account-name-error'].hidden, false);
    delete fields['account-name-error'];
  });

  await check('Linked accounts: Disconnect Discord asks first, sends DELETE /auth/discord and reloads; a refusal (last sign-in, a guild it would orphan) stays in the dialog', async () => {
    const dialog = G.pages.accounts.disconnectDiscordDialogHtml();
    const t = text(dialog);
    assert(dialog.includes('data-submit="discord-disconnect-form"') && t.includes('You will sign in with Battle.net only') && t.includes('deletes your Discord ID, nickname and server list') && t.includes('Your roster entries and attendance are not deleted') && t.includes('an officer has linked your account'));
    assert(dialog.includes('id="dlg-error"') && dialog.includes('data-action="dialog-cancel"'));
    G.app.state.bnet = { data: bnetData(), notice: '', alert: '' };
    const calls = [];
    const closed = [];
    const realClose = G.ui.closeDialogOf;
    G.ui.closeDialogOf = f => closed.push(f);
    await withApi({
      del: (url, body) => { calls.push(['DELETE', url, plain(body)]); return Promise.resolve({ ok: true, removed: true }); },
      get: url => { calls.push(['GET', url]); return Promise.resolve(url === '/auth/me' ? onlyBnet() : bnetData()); },
    }, async () => {
      G.handlers.submit['discord-disconnect-form']({ querySelectorAll: () => [], elements: {} });
      await tick(); await tick(); await tick();
    });
    assert.deepEqual(calls, [['DELETE', '/auth/discord', {}], ['GET', '/auth/me'], ['GET', '/auth/bnet']]);
    assert.equal(closed.length, 1);
    assert.equal(G.app.state.bnet.notice, 'Discord disconnected. You sign in with Battle.net now.');
    assert.equal(G.app.state.me.identities.discord, null);
    // Refused: the dialog stays and shows the Worker's words.
    fields['dlg-error'] = { textContent: '', hidden: true };
    closed.length = 0;
    await withApi({ del: () => Promise.reject(new G.api.ApiError(409, { error: 'leads_guild', message: 'You are the Guild Master of a guild you would lose access to without Discord.' })) }, async () => {
      G.handlers.submit['discord-disconnect-form']({ querySelectorAll: () => [], elements: {} });
      await tick(); await tick();
    });
    G.ui.closeDialogOf = realClose;
    assert.equal(closed.length, 0);
    assert.equal(fields['dlg-error'].textContent, 'You are the Guild Master of a guild you would lose access to without Discord.');
    delete fields['dlg-error'];
    // A disabled button does nothing.
    let opened = 0;
    const realOpen = G.ui.openDialog;
    G.ui.openDialog = () => { opened++; };
    G.handlers.click['discord-disconnect-open']({ disabled: true });
    G.handlers.click['discord-disconnect-open']({ disabled: false });
    G.ui.openDialog = realOpen;
    assert.equal(opened, 1);
  });

  // ── the person page: the Raidsmith account ─────────────────────
  const record = (personExtra, extra) => Object.assign({
    today: '2026-10-17',
    can: { edit: true, notesView: true, notesEdit: true, delete: true, addCharacter: true },
    person: Object.assign({
      id: 'p1', status: 'raider', joinedOn: '2026-09-01', trialStart: null, trialEnd: null, leftOn: null, leftReason: null, trialFlag: null, isMe: false, version: 3,
      discord: { signIn: 'no_discord', user: null, nickname: null }, account: { user: null, via: null, linked: false }, homeTeam: { id: 't1', name: 'Alpha' },
    }, personExtra || {}),
    characters: [{ id: 'c1', name: 'Aldric', realm: 'Dreamscythe', class: 'WARRIOR', mainSpec: 'Arms', offSpec: null, role: 'dps', isMain: true, team: { id: 't1', name: 'Alpha', archived: false } }],
    notes: null,
  }, extra || {});
  const holly = person('u2', 'Holly');
  const gd = { guild: { id: 'g1', name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', region: 'US', gameVersion: 'tbc' }, teams: [{ id: 't1', name: 'Alpha', size: 25, archived: false }], me: { roles: [{ role: 'officer' }], can: { 'roster.edit': 'guild' } } };

  await check('person page: the header names a linked account, and the Details field shows Not linked + Link, an officer\'s link + Unlink, or the Discord one without a button', () => {
    const none = record();
    assert.equal(text(G.pages.person.personHtml({ guildData: gd, record: none, linkable: [] }).match(/<p class="gs-person-discord">[\s\S]*?<\/p>/)[0]).trim(), 'No Discord account');
    const html0 = G.pages.person.personHtml({ guildData: gd, record: none, linkable: [] });
    assert(html0.includes('id="det-account-field"') && html0.includes('Not linked') && html0.includes('data-action="account-link-open"') && !html0.includes('account-unlink-open'));
    assert(html0.includes('Raidsmith account'));
    const linked = record({ account: { user: holly, via: 'link', linked: true } });
    const html1 = G.pages.person.personHtml({ guildData: gd, record: linked, linkable: [] });
    assert.equal(text(html1.match(/<p class="gs-person-discord">[\s\S]*?<\/p>/)[0]).trim(), 'Account: Holly - Signed in');
    assert(text(html1).includes('Holly linked by an officer') && html1.includes('data-action="account-unlink-open"') && !html1.includes('data-action="account-link-open"'));
    // A Discord member whose account also carries the officer's link: the Discord line is not repeated as an account.
    const both = record({ discord: { signIn: 'signed_in', user: person('u9', 'Gale'), nickname: null }, account: { user: person('u9', 'Gale'), via: 'link', linked: true } });
    assert.equal(text(G.pages.person.personHtml({ guildData: gd, record: both, linkable: [] }).match(/<p class="gs-person-discord">[\s\S]*?<\/p>/)[0]).trim(), 'Discord: gale - Signed in');
    // Through the Discord ID: shown, with no Unlink (that is the Discord field's).
    const viaDiscord = record({ discord: { signIn: 'signed_in', user: person('u9', 'Gale'), nickname: null }, account: { user: person('u9', 'Gale'), via: 'discord', linked: false } });
    const html2 = G.pages.person.personHtml({ guildData: gd, record: viaDiscord, linkable: [] });
    assert(text(html2).includes('Gale through the Discord account above') && !html2.includes('account-unlink-open') && !html2.includes('account-link-open'));
    // Discord not signed in yet, plus an account an officer linked: both lines.
    const mixed = record({ discord: { signIn: 'not_yet', user: null, nickname: 'Ally' }, account: { user: holly, via: 'link', linked: true } });
    assert.equal(text(G.pages.person.personHtml({ guildData: gd, record: mixed, linkable: [] }).match(/<p class="gs-person-discord">[\s\S]*?<\/p>/)[0]).trim(), 'Discord: Ally - Not signed in yet - Account: Holly - Signed in');
    // A member's read-only record has no field and no buttons.
    const member = record({ isMe: true }, { can: { edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false } });
    const html3 = G.pages.person.personHtml({ guildData: gd, record: member, linkable: null });
    assert(!html3.includes('det-account-field') && !html3.includes('account-link-open'));
    assertEscaped(G.pages.person.personHtml({ guildData: gd, record: record({ account: { user: person('u5', HOSTILE + QUOTES), via: 'link', linked: true } }), linkable: [] }), 'account name');
    assertNoRawAttrs(html1);
  });

  await check('person page: the link dialog lists claimants at first, a look-up by exact BattleTag or name next, with a way to say nothing matched', () => {
    const rec = record();
    const claimants = [{ id: 'u5', username: 'erin', displayName: 'Erin E', avatarUrl: null, initials: 'EE', battletag: null, matchedBy: 'claim' }];
    const dialog = G.pages.person.accountLinkDialogHtml(rec, claimants);
    const t = text(dialog);
    assert(dialog.includes('data-submit="account-find-form"') && t.includes('Link an account to Aldric') && t.includes('whole BattleTag (like Name#1234)') && t.includes('Raidsmith never lists accounts'));
    assert(dialog.includes('id="dlg-acct-q"') && dialog.includes('maxlength="64"') && dialog.includes('id="dlg-err-q"') && dialog.includes('id="dlg-error"') && dialog.includes('id="dlg-acct-results"'));
    assert(t.includes('Erin E') && t.includes('Sent a character claim') && dialog.includes('data-action="account-pick" data-uid="u5"') && dialog.includes('aria-label="Link Erin E"'));
    const found = G.pages.person.accountResultsHtml([
      { id: 'u6', displayName: 'Holly', avatarUrl: null, initials: 'HO', battletag: 'Holly#1111', matchedBy: 'battletag' },
      { id: 'u7', displayName: 'Ivan', avatarUrl: null, initials: 'IV', battletag: null, matchedBy: 'name' },
    ], 'Holly#1111');
    assert(text(found).includes('BattleTag match - Holly#1111') && text(found).includes('Name match') && (found.match(/data-action="account-pick"/g) || []).length === 2);
    const twins = G.pages.person.accountResultsHtml([
      { id: 'u6', displayName: 'Hollyhock', initials: 'HO', battletag: null, matchedBy: 'name', ambiguous: true },
      { id: 'u7', displayName: 'Hollyhock', initials: 'HO', battletag: null, matchedBy: 'name', ambiguous: true },
    ], 'Hollyhock');
    assert(!twins.includes('data-action="account-pick"') && (twins.match(/Several accounts show this name\. Ask for the BattleTag\./g) || []).length === 2, 'no Link for look-alike names');
    assert(text(G.pages.person.accountResultsHtml([], 'Nobody#1')).includes('No account has exactly that BattleTag or name'));
    assert(text(G.pages.person.accountResultsHtml([], '')).includes('Nobody has sent a character claim that is waiting for a person'));
    assertEscaped(G.pages.person.accountResultsHtml([{ id: 'u8', displayName: HOSTILE + QUOTES, battletag: HOSTILE, matchedBy: 'name' }], 'x'), 'results');
    assertNoRawAttrs(dialog);
    const unlink = G.pages.person.accountUnlinkDialogHtml(record({ account: { user: holly, via: 'link', linked: true } }));
    assert(unlink.includes('data-submit="account-unlink-form"') && text(unlink).includes('Unlink Holly from Aldric?') && text(unlink).includes('can no longer open this guild unless they are in its Discord server'));
  });

  await check('person page: opening the dialog reads the claimants, Find looks up the typed text, Link sends PUT /account with the account, Unlink sends null; the record replaces the page\'s copy', async () => {
    const s = G.app.state;
    s.currentGid = 'g1';
    s.guilds = { g1: gd };
    s.person = { gid: 'g1', pid: 'p1', record: record() };
    const rendered = [];
    const realRender = G.app.render;
    G.app.render = () => rendered.push(1);
    const calls = [];
    const opened = [];
    const realOpen = G.ui.openDialog;
    G.ui.openDialog = (html, o) => { opened.push([html, o]); return null; };
    const closed = [];
    const realClose = G.ui.closeDialogOf;
    G.ui.closeDialogOf = f => closed.push(f);
    const linkedRecord = record({ account: { user: holly, via: 'link', linked: true }, version: 4 }, { rosterFlags: {} });
    await withApi({
      get: url => {
        calls.push(['GET', url]);
        if (/\?q=/.test(url)) return Promise.resolve({ accounts: [{ id: 'u6', displayName: 'Holly', initials: 'HO', avatarUrl: null, battletag: 'Holly#1111', matchedBy: 'battletag' }] });
        return Promise.resolve({ accounts: [{ id: 'u5', displayName: 'Erin E', initials: 'EE', avatarUrl: null, battletag: null, matchedBy: 'claim' }] });
      },
      put: (url, body) => { calls.push(['PUT', url, plain(body)]); return Promise.resolve(body.userId ? linkedRecord : record({ version: 5 })); },
    }, async () => {
      G.handlers.click['account-link-open']();
      await tick(); await tick();
      assert.equal(opened.length, 1);
      assert(opened[0][0].includes('Erin E') && opened[0][0].includes('data-uid="u5"'));
      // Find
      fields['dlg-acct-results'] = { innerHTML: '' };
      fields['dlg-err-q'] = { textContent: '', hidden: true };
      fields['dlg-error'] = { textContent: '', hidden: true };
      G.handlers.submit['account-find-form']({ elements: { q: { value: ' Holly#1111 ' } }, querySelectorAll: () => [] });
      await tick(); await tick();
      assert(fields['dlg-acct-results'].innerHTML.includes('Holly#1111') && fields['dlg-acct-results'].innerHTML.includes('data-uid="u6"'));
      // Link
      G.handlers.click['account-pick']({ disabled: false, getAttribute: k => (k === 'data-uid' ? 'u6' : null), closest: () => ({ querySelectorAll: () => [] }) });
      await tick(); await tick();
      assert.equal(s.person.record.person.account.user.displayName, 'Holly');
      assert.equal(closed.length, 1);
      // Unlink
      G.handlers.submit['account-unlink-form']({ querySelectorAll: () => [] });
      await tick(); await tick();
      assert.equal(s.person.record.person.account.user, null);
    });
    G.app.render = realRender;
    G.ui.openDialog = realOpen;
    G.ui.closeDialogOf = realClose;
    assert.deepEqual(calls, [
      ['GET', '/api/guild/g1/accounts'], ['GET', '/api/guild/g1/accounts?q=Holly%231111'],
      ['PUT', '/api/guild/g1/roster/p1/account', { userId: 'u6' }], ['PUT', '/api/guild/g1/roster/p1/account', { userId: null }],
    ]);
    assert(rendered.length >= 2);
    for (const id of ['dlg-acct-results', 'dlg-err-q', 'dlg-error']) delete fields[id];
  });

  await check('person page: a refused look-up or link shows the Worker\'s words in the dialog and leaves it open', async () => {
    const s = G.app.state;
    s.currentGid = 'g1';
    s.guilds = { g1: gd };
    s.person = { gid: 'g1', pid: 'p1', record: record() };
    fields['dlg-err-q'] = { textContent: '', hidden: true };
    fields['dlg-error'] = { textContent: '', hidden: true };
    fields['dlg-acct-results'] = { innerHTML: 'kept' };
    const closed = [];
    const realClose = G.ui.closeDialogOf;
    G.ui.closeDialogOf = f => closed.push(f);
    await withApi({ get: () => Promise.reject(new G.api.ApiError(400, { error: 'bad_request', message: 'Type the whole BattleTag or name: 3 to 64 characters.', field: 'q' })) }, async () => {
      G.handlers.submit['account-find-form']({ elements: { q: { value: 'ab' } }, querySelectorAll: () => [] });
      await tick(); await tick();
    });
    assert.equal(fields['dlg-err-q'].textContent, 'Type the whole BattleTag or name: 3 to 64 characters.');
    assert.equal(fields['dlg-acct-results'].innerHTML, 'kept');
    await withApi({ put: () => Promise.reject(new G.api.ApiError(409, { error: 'discord_linked', message: 'This person is linked to a Discord account.', field: 'userId' })) }, async () => {
      G.handlers.click['account-pick']({ disabled: false, getAttribute: () => 'u6', closest: () => ({ querySelectorAll: () => [], querySelector: () => null }) });
      await tick(); await tick();
    });
    G.ui.closeDialogOf = realClose;
    assert.equal(closed.length, 0);
    assert.equal(fields['dlg-error'].textContent, 'This person is linked to a Discord account.');
    for (const id of ['dlg-acct-results', 'dlg-err-q', 'dlg-error']) delete fields[id];
  });

  // ── the shell, privacy, CSS and files ──────────────────────────
  await check('shell: the top bar opens the sign-in page; the menu names an account without Discord by its BattleTag name, not @username', () => {
    const signedOut = G.shell.slots({ section: 'guild', page: 'app', me: null, signedOut: true, route: { name: 'signin' } });
    assert(signedOut.account.includes('href="#/signin"') && signedOut.account.includes('Sign in or sign up') && signedOut.account.includes('>Sign in<') && !signedOut.account.includes('/auth/login'));
    const staticPage = G.shell.slots({ section: 'page', page: 'faq', me: null, signedOut: true });
    assert(staticPage.account.includes('href="/#/signin"'), 'a static page links the app\'s hash route absolutely');
    const menu = ctxMe => G.shell.accountMenuHtml({ section: 'guild', page: 'app', me: ctxMe, guildData: null, route: { name: 'section', section: 'roster' } });
    assert(menu(me()).includes('>@gale<') && menu(onlyBnet()).includes('>holly<') && !menu(onlyBnet()).includes('>@holly<'));
    assert(menu(me({ identities: undefined })).includes('>@gale<'), 'an answer without identities is a Discord account');
  });

  await check('privacy: accounts, the BattleTag kept as a sign-in, the roster link and the lookup rule are in the policy; Delete my data names the display name', () => {
    const out = G.pages.privacy.privacyHtml({ me: { user: {}, deleteImpact: { handOverFirst: [], guildsDeleted: [] } } });
    const t = text(out);
    for (const s of [
      'Your Raidsmith account is made the first time you sign in, with Discord or with Battle.net', 'Raidsmith never merges two accounts', 'up to 32 characters',
      'They are how you sign in, so they stay while Battle.net is connected, and are refreshed every time you sign in with it',
      'it is deleted 30 days after you load it unless you load it again; your BattleTag stays until you disconnect',
      'an officer can link your account to your roster entry', 'there is no list of accounts', 'whose account an officer has linked to a roster entry',
      'Deletes your account, the name you chose and every sign-in linked to it', 'Disconnecting Discord deletes the Discord ID and nickname on roster entries and Raid-Helper sign-ups',
    ]) assert(t.toLowerCase().includes(s.toLowerCase()), s);
    assert(!t.includes('Sign in with Discord'));
  });

  await check('guild.css and files: the account classes exist with the phone rules the buttons need, nothing sets inline styles, no non-ASCII text, scripts load in order', () => {
    for (const c of ['.gs-signin-buttons', '.gs-account-line', '.gs-account-results', '.gs-account-row', '.gs-account-text', '.gs-account-name']) assert(css.includes(c), c);
    assert(/\.gs-signin-buttons \.gs-btn-block \{ margin-top: 0; \}/.test(css), 'stacked buttons do not carry the lone button\'s top margin');
    const phone = css.split('@media (max-width: 600px)').slice(1).join('');
    assert(/\.gs-btn, \.gs-btn-sm \{ min-height: 44px; \}/.test(phone), 'the Link buttons are 44px on a phone');
    const files = ['js/guild/pages-accounts.js', 'js/guild/pages-signin.js', 'js/guild/pages-person.js', 'worker/membership.js', 'worker/identities.js', 'worker/routes/accounts.js', 'migrations/0012_accounts.sql'];
    for (const f of files) {
      read(f).split('\n').forEach((line, i) => assert(!/[\s`'"]style\s*=\s*["'`\\]/.test(line), `${f}:${i + 1} inline style`));
    }
    for (const f of ['js/guild/pages-accounts.js', 'worker/membership.js', 'worker/identities.js', 'worker/routes/accounts.js', 'migrations/0012_accounts.sql', 'guild-accounts-worker-tests.js', 'guild-accounts-ui-tests.js']) {
      // (the section dividers, the box-drawing line U+2500, are the one non-ASCII character the guild files use)
      assert(!/[^\x00-\x7f]/.test(read(f).replace(new RegExp(String.fromCharCode(0x2500), 'g'), '')), f + ' has non-ASCII text');
    }
    const at = n => GUILD_SCRIPTS.indexOf('/js/guild/' + n + '.js');
    assert(at('pages-accounts') > at('ui') && at('pages-accounts') < at('pages-bnet') && at('pages-bnet') < at('app'), 'pages-accounts.js loads before pages-bnet.js, which uses it');
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert(read(page).includes('<script src="/js/guild/pages-accounts.js"></script>'), page);
    const order = page => [...read(page).matchAll(/<script src="(\/js\/guild\/[^"]+)"><\/script>/g)].map(m => m[1]);
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert.deepEqual(order(page), GUILD_SCRIPTS.filter(s => s.indexOf('/js/guild/') === 0), page);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
