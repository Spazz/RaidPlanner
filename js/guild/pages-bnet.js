// ── PAGES: LINKED ACCOUNTS, MY CHARACTERS (Battle.net, Phase 5; accounts, Phase 7a) ──
// Linked accounts (#/linked) is a T3 form page: the name the account shows (a form with the Save bar) and Discord (pages-accounts.js), then connect or disconnect
// Battle.net. The last sign-in of an account cannot be disconnected: its button is off and says why. My characters (#/characters) is a T1 list page: the characters
// Battle.net lists for the person, grouped by the guilds they belong to, the ones already on their record first, each with a Claim button. A claim is a request to the
// officers; nothing reaches the roster until one approves it. Somebody who is already on a guild's roster is told what Battle.net adds (their alts, a second sign-in),
// never to connect it to "see" what the roster already shows. GET /auth/bnet -> { configured, link, guilds: [{ guildId, onRoster, status, characters }] }.
// Pure parts: linkedHtml, charactersHtml, characterRowHtml, stateText. Connecting is a plain link to /auth/bnet/login (a full-page redirect).
(function (G) {
  'use strict';

  const LINK_ERROR_TEXT = {
    denied: 'Battle.net was not connected: you did not allow access. Connect again when you are ready.',
    state: 'That Battle.net link expired. Connect again.',
    bnet: 'Battle.net could not finish connecting. Try again in a minute.',
    not_configured: 'Battle.net isn\'t set up on this server.',
    busy: 'You started the link a lot of times. Wait a few minutes, then connect again.',
    taken: 'That Battle.net account is already connected to another Raidsmith account. Accounts are never merged: sign in with that one instead.',
    discord: 'Discord could not finish connecting. Try again in a minute.',
    discord_taken: 'That Discord account is already connected to another Raidsmith account. Accounts are never merged: sign in with that one instead.',
    has_discord: 'A different Discord account is already connected here. Disconnect it first.',
    has_bnet: 'A different Battle.net account is already connected here. Disconnect it first, then connect the other one.',
    roster_conflict: 'That Discord account is already on another roster entry in a guild where one of your roster entries is linked to you. Ask an officer to sort out the roster first.',
  };
  const CONNECT_HREF = '/auth/bnet/login';
  const NOT_SET_UP = 'Battle.net isn\'t set up on this server.';

  function st() { return G.app.state; }
  function bnetState() { return st().bnet; }

  // A link to the Battle.net sign-in. Secondary unless the page has nothing else to do (primary), because connecting is never the only way to be in a guild.
  function connectButton(label, primary) {
    return G.ui.buttonHtml({ label: label, variant: primary ? 'primary' : 'secondary', href: CONNECT_HREF, icon: 'link', attrs: { 'data-key': 'bnet-connect' } });
  }

  // ── Linked accounts ──
  // opts.onlyIdentity: Battle.net is the account's only sign-in, so it cannot be disconnected.
  function battlenetCardHtml(data, opts) {
    const only = !!(opts && opts.onlyIdentity);
    const wrap = function (chip, body) {
      return G.ui.objectSectionHtml({ id: 'linked-bnet', title: 'Battle.net', chipHtml: chip, bodyHtml: body });
    };
    if (!data) return wrap('', G.pages.signin.loadingHtml());
    if (!data.configured) {
      return wrap(G.ui.chipHtml({ tone: 'neutral', label: 'Unavailable', icon: 'dash' }), '<p class="gs-warn" id="bnet-not-set-up" role="status">' + esc(NOT_SET_UP) + ' Ask the person who runs this server to add the Battle.net client.</p>');
    }
    const link = data.link;
    if (!link) {
      return wrap(G.ui.chipHtml({ tone: 'none', label: 'Not connected' }),
        '<p>Connect Battle.net to see your characters here and tell your officers which ones are yours. You can also sign in with it.</p>' +
        '<ul class="gs-bullets gs-bullets-plain"><li>Raidsmith reads your BattleTag and your list of characters: name, realm, class and level. It never sees your password.</li>' +
        '<li>Your BattleTag stays while Battle.net is connected: it is how you sign in. Raidsmith keeps that list for 30 days, then deletes it. Connect again to refresh it.</li>' +
        '<li>If this Battle.net account already has its own Raidsmith account, it cannot be connected here: accounts are never merged. Sign in with that one instead.</li>' +
        '<li>Disconnect any time to delete both at once.</li></ul>' +
        '<div class="gs-actions">' + connectButton('Connect Battle.net') + '</div>');
    }
    return wrap(G.ui.chipHtml({ tone: 'success', label: 'Connected' }),
      '<p id="bnet-connected">Connected as <strong>' + esc(link.battletag) + '</strong>.</p>' +
      (link.expired
        ? '<p class="gs-fine" id="bnet-keeps">Your character list was loaded ' + esc(G.ui.formatDate(link.fetchedAt)) + ' and deleted after 30 days. Connect again to load it.</p>'
        : '<p class="gs-fine" id="bnet-keeps">Your characters were loaded ' + esc(G.ui.formatDate(link.fetchedAt)) + '. Raidsmith deletes them on ' + esc(G.ui.formatDate(link.expiresAt)) + ' unless you connect again before then.</p>') +
      (only ? '<p class="gs-fine" id="bnet-only">Battle.net is the only way you sign in right now, so it cannot be disconnected. Connect Discord first, or delete your data on the privacy page.</p>' : '') +
      '<div class="gs-actions">' + (link.expired ? '' : G.ui.buttonHtml({ label: 'My characters', href: G.router.format({ name: 'characters' }), attrs: { 'data-key': 'bnet-characters' } })) +
      connectButton(link.expired ? 'Load my characters' : 'Refresh characters') +
      G.ui.buttonHtml({ label: 'Disconnect', variant: 'danger-outline', disabled: only, attrs: { 'data-action': 'bnet-disconnect-open', 'data-key': 'bnet-disconnect', 'aria-describedby': only ? 'bnet-only' : null } }) + '</div>');
  }

  // opts: { data (GET /auth/bnet or null), me (the /auth/me answer: adds the name and Discord cards), error (route error key), notice, alert }
  function linkedHtml(opts) {
    const o = opts || {};
    const err = o.error && Object.prototype.hasOwnProperty.call(LINK_ERROR_TEXT, o.error) ? '<p class="gs-alert" id="bnet-link-error" role="alert">' + esc(LINK_ERROR_TEXT[o.error]) + '</p>' : '';
    const ids = o.me && o.me.user ? G.pages.accounts.identitiesOf(o.me) : null;
    return G.ui.formPageHtml({
      head: { title: 'Linked accounts', context: 'How you sign in to Raidsmith. Your account can hold Discord and Battle.net; either one signs you in to the same account.' },
      noticesHtml: err + noticeHtml(o.notice) + G.ui.alertHtml(o.alert || '', 'gs-page-alert'),
      bodyHtml: (ids ? G.pages.accounts.profileCardsHtml(o.me) : '') + battlenetCardHtml(o.data, { onlyIdentity: !!ids && !ids.discord }) +
        '<p class="gs-fine">What Raidsmith keeps, and how to delete it: <a href="#/privacy">Privacy &amp; my data</a>.</p>',
    });
  }

  function noticeHtml(text) {
    return text ? G.ui.bannerHtml({ tone: 'success', text: text }) : '';
  }

  function disconnectDialogHtml() {
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Disconnect Battle.net?',
      bodyHtml: '<p class="gs-fine" id="dlg-help">This deletes your BattleTag and your character list from Raidsmith now. Claims you already sent stay with your officers; characters they approved stay on the roster.</p>',
      primary: { label: 'Disconnect' }, formAttrs: { 'data-submit': 'bnet-disconnect-form' },
    });
  }

  // ── My characters ──
  // state (the Worker's) -> the words next to a character
  const STATE_TEXT = {
    yours: 'On your record',
    taken: 'On someone else\'s record',
    other_realm: 'Another realm',
    on_roster: 'On the roster, not linked to anyone',
    new: '',
  };

  function stateText(c) {
    if (c.claim && c.claim.status === 'pending') return 'Waiting for officers';
    if (c.claim && c.claim.status === 'approved' && c.state === 'yours') return 'Approved';
    if (c.claim && c.claim.status === 'rejected' && c.claimable) return 'An officer turned this down before';
    return Object.prototype.hasOwnProperty.call(STATE_TEXT, c.state) ? STATE_TEXT[c.state] : '';
  }

  // The words as a status chip (icon + word + tint): yours and approved are green, waiting is amber, a refusal is red, the rest are plain facts.
  function stateChip(c) {
    const text = stateText(c);
    if (!text) return '';
    let tone = 'neutral';
    let icon;
    if (c.claim && c.claim.status === 'pending') { tone = 'warning'; icon = 'clock'; }
    else if (text === 'Approved' || c.state === 'yours') tone = 'success';
    else if (c.claim && c.claim.status === 'rejected' && c.claimable) tone = 'danger';
    else if (c.state === 'on_roster') { tone = 'info'; icon = 'info'; }
    else if (c.state === 'other_realm') { tone = 'none'; }
    return G.ui.chipHtml({ tone: tone, label: text, icon: icon });
  }

  function rowKey(gid, c) { return 'claim-' + gid + '-' + c.realmSlug + '-' + String(c.name).toLowerCase(); }

  // Claim (a quiet button: there can be dozens of rows) or Withdraw; nothing for a character that cannot be claimed.
  function characterActionHtml(gid, c) {
    const key = rowKey(gid, c);
    const attrs = { 'data-gid': gid, 'data-name': c.name, 'data-realm': c.realmSlug, 'data-key': key };
    if (c.claim && c.claim.status === 'pending') {
      return G.ui.buttonHtml({ label: 'Withdraw', size: 'sm', ariaLabel: 'Withdraw the claim on ' + c.name, attrs: Object.assign({ 'data-action': 'bnet-withdraw', 'data-claim': c.claim.id }, attrs) });
    }
    if (c.claimable) {
      return G.ui.buttonHtml({ label: 'Claim', size: 'sm', ariaLabel: 'Claim ' + c.name, attrs: Object.assign({ 'data-action': 'bnet-claim' }, attrs) });
    }
    return '';
  }

  // A character as a data-table row: the ones on the viewer's own record are flagged so the table can put them first.
  function characterRow(gid, c) {
    return {
      id: rowKey(gid, c), ariaLabel: c.name, mark: c.class,
      cells: {
        name: G.ui.classNameHtml(c.name, c.class), class: esc(G.ui.className(c.class)), realm: esc(c.realm),
        level: c.level == null ? '<span class="gs-muted gs-dash">-</span>' : esc(c.level), status: stateChip(c), actions: characterActionHtml(gid, c),
      },
    };
  }

  const CHARACTER_COLUMNS = [
    { key: 'name', label: 'Character', primary: true }, { key: 'class', label: 'Class' }, { key: 'realm', label: 'Realm' },
    { key: 'level', label: 'Level', align: 'right' }, { key: 'status', label: 'Status' }, { key: 'actions', label: 'Action', srLabel: true, hideLabel: true },
  ];

  // The viewer's own characters (already on their record) lead; the rest keep Battle.net's order (level, then name).
  function ownFirst(characters) {
    const list = Array.isArray(characters) ? characters : [];
    return list.filter(function (c) { return c.state === 'yours'; }).concat(list.filter(function (c) { return c.state !== 'yours'; }));
  }

  function guildBodyHtml(g) {
    const again = function (label) { return '<div class="gs-actions">' + connectButton(label) + '</div>'; };
    if (g.status === 'unsupported') return '<p class="gs-empty" data-status="unsupported">' + esc(g.message || ('Battle.net doesn\'t offer character data for ' + g.supportLabel + ' yet.')) + '</p>';
    if (g.status === 'not_linked') return g.onRoster
      ? '<p class="gs-empty" data-status="not_linked">You are already on this roster. Adding Battle.net lists your other characters here, so you can claim your alts.</p>' + again('Add Battle.net')
      : '<p class="gs-empty" data-status="not_linked">Connect Battle.net to see your characters here.</p>' + again('Connect Battle.net');
    if (g.status === 'expired') return '<p class="gs-empty" data-status="expired">Your character list was deleted after 30 days, as Battle.net\'s rules ask. Connect again to load it.</p>' + again('Connect again');
    if (g.status === 'needs_refresh') return '<p class="gs-empty" data-status="needs_refresh">You joined this guild after you connected Battle.net. Connect again to load your characters for it.</p>' + again('Connect again');
    if (g.status === 'unavailable') return '<p class="gs-empty" data-status="unavailable">Battle.net did not give your characters for this guild when you connected. Connect again to try once more.</p>' + again('Connect again');
    if (!g.characters.length) {
      return '<p class="gs-empty" data-status="empty">Battle.net lists no ' + esc(g.supportLabel) + ' characters for you. If you made one recently, log out of the game completely and connect again: Battle.net updates this list after a full log out.</p>';
    }
    return G.ui.dataTableHtml({ label: 'Your ' + g.supportLabel + ' characters', columns: CHARACTER_COLUMNS, rows: ownFirst(g.characters).map(function (c) { return characterRow(g.guildId, c); }), showAll: true, noun: 'characters' });
  }

  function guildCardHtml(g) {
    return G.ui.objectSectionHtml({
      id: 'chars-' + g.guildId, title: g.guildName,
      chipHtml: '<span class="gs-fine">' + esc(g.supportLabel) + ' &middot; ' + esc(G.ui.realmLine({ realm: g.realm, realmKind: g.realmKind })) + '</span>',
      bodyHtml: guildBodyHtml(g),
    });
  }

  // What the page says when Battle.net is not connected yet. Somebody on a roster already is told what Battle.net adds, not to connect it to see what is there.
  function notConnectedHtml(data) {
    const guilds = Array.isArray(data.guilds) ? data.guilds : [];
    const on = guilds.filter(function (g) { return g.onRoster; });
    const off = guilds.filter(function (g) { return !g.onRoster; });
    const names = function (list) { return list.map(function (g) { return g.guildName; }).join(', '); };
    if (on.length && !off.length) {
      return G.ui.emptyStateHtml({
        kind: 'first', icon: 'link', title: 'You are on the roster already',
        text: 'You are on the roster of ' + names(on) + ', so you do not need Battle.net to raid there. Adding it lists the other characters on your account, so you can claim your alts and your officers can approve them. It also gives you a second way to sign in.',
        actions: [{ label: 'Add Battle.net', variant: 'secondary', href: CONNECT_HREF, icon: 'link', attrs: { 'data-key': 'bnet-connect' } }],
      });
    }
    if (on.length) {
      return G.ui.emptyStateHtml({
        kind: 'first', icon: 'link', title: 'Find your characters with Battle.net',
        text: 'You are on the roster of ' + names(on) + '. In ' + names(off) + ', Battle.net finds your characters so you can claim them. For ' + names(on) + ' it adds your other characters (alts) and a second way to sign in.',
        actions: [{ label: 'Connect Battle.net', href: CONNECT_HREF, icon: 'link', attrs: { 'data-key': 'bnet-connect' } }],
      });
    }
    return G.ui.emptyStateHtml({
      kind: 'first', icon: 'link', title: 'Connect Battle.net to see your characters',
      text: 'Raidsmith lists the characters on your Battle.net account for each of your guilds. You pick the ones that are yours and your officers approve them.',
      actions: [{ label: 'Connect Battle.net', href: CONNECT_HREF, icon: 'link', attrs: { 'data-key': 'bnet-connect' } }],
    });
  }

  // opts: { data (GET /auth/bnet or null), notice, alert }
  function charactersHtml(opts) {
    const o = opts || {};
    const data = o.data;
    let body;
    let notices = '';
    if (!data) body = G.pages.signin.loadingHtml();
    else if (!data.configured) body = '<p class="gs-warn" id="bnet-not-set-up" role="status">' + esc(NOT_SET_UP) + '</p>';
    else if (!data.link) body = notConnectedHtml(data);
    else if (!data.guilds.length) {
      body = G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: 'You are not in a Raidsmith guild yet', text: 'There is nothing to claim a character in until you are in a guild.' });
    } else {
      notices = G.ui.bannerHtml({ tone: 'info', dismissible: false, id: 'chars-intro', text: 'Claim the characters that are yours. Your officers approve each claim before anything changes on the roster. Loaded ' + G.ui.formatDate(data.link.fetchedAt) +
        ' from Battle.net as ' + data.link.battletag + '; deleted on ' + G.ui.formatDate(data.link.expiresAt) + ' unless you connect again.',
        actions: [{ label: 'Refresh characters', href: CONNECT_HREF, attrs: { 'data-key': 'bnet-reconnect' } }] });
      body = '<div class="gs-chars-guilds">' + data.guilds.map(guildCardHtml).join('') + '</div>';
    }
    return G.ui.listPageHtml({
      head: { title: 'My characters', contextHtml: 'From Battle.net, for your guilds. <a href="' + esc(G.router.format({ name: 'linked' })) + '">Linked accounts</a>' },
      noticesHtml: noticeHtml(o.notice) + G.ui.alertHtml(o.alert || '', 'gs-page-alert') + notices,
      bodyHtml: body,
    });
  }

  // ── data and behaviour ──
  // GET /auth/bnet into app state; rejects with the ApiError (the route's catch shows it).
  function load() {
    const s = st();
    s.bnet = { data: null, notice: '', alert: '' };
    return G.api.get('/auth/bnet').then(function (data) {
      s.bnet = { data: data, notice: '', alert: '' };
      return data;
    });
  }

  function reload(notice) {
    const s = st();
    return G.api.get('/auth/bnet').then(function (data) {
      s.bnet = { data: data, notice: notice || '', alert: '' };
      G.app.render();
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  function fail(err) {
    const b = bnetState();
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
    if (b) b.alert = c.text;
    G.app.render();
  }

  G.handlers.click['bnet-claim'] = function (el) {
    if (el.disabled) return;
    const gid = el.getAttribute('data-gid');
    const name = el.getAttribute('data-name');
    el.disabled = true;
    G.api.post('/api/guild/' + encodeURIComponent(gid) + '/claims', { characters: [{ name: name, realmSlug: el.getAttribute('data-realm') }] }).then(function () {
      return reload('Claim sent: ' + name + ' is waiting for your officers. Nothing changes on the roster until one approves it.');
    }, function (err) { el.disabled = false; fail(err); });
  };

  G.handlers.click['bnet-withdraw'] = function (el) {
    if (el.disabled) return;
    const name = el.getAttribute('data-name');
    el.disabled = true;
    G.api.del('/api/guild/' + encodeURIComponent(el.getAttribute('data-gid')) + '/claims/' + encodeURIComponent(el.getAttribute('data-claim')), {}).then(function () {
      return reload('Claim on ' + name + ' withdrawn.');
    }, function (err) { el.disabled = false; fail(err); });
  };

  G.handlers.click['bnet-disconnect-open'] = function () {
    G.ui.openDialog(disconnectDialogHtml(), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.submit['bnet-disconnect-form'] = function (form) {
    G.ui.runDialog(form, G.api.del('/auth/bnet', {}), function () {
      // The account's sign-ins changed too (Discord may be its last one now), so /auth/me is read again with the page.
      G.pages.accounts.refresh('Battle.net disconnected. Your BattleTag and character list are deleted.');
    });
  };

  G.pages.bnet = {
    LINK_ERROR_TEXT: LINK_ERROR_TEXT,
    CONNECT_HREF: CONNECT_HREF,
    NOT_SET_UP: NOT_SET_UP,
    STATE_TEXT: STATE_TEXT,
    stateText: stateText,
    stateChip: stateChip,
    linkedHtml: linkedHtml,
    battlenetCardHtml: battlenetCardHtml,
    charactersHtml: charactersHtml,
    notConnectedHtml: notConnectedHtml,
    guildCardHtml: guildCardHtml,
    disconnectDialogHtml: disconnectDialogHtml,
    load: load,
    state: bnetState,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
