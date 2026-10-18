// ── PAGES: LINKED ACCOUNTS, MY CHARACTERS (Battle.net, Phase 5; accounts, Phase 7a) ──
// Linked accounts (#/linked): the name the account shows and Discord (pages-accounts.js), then connect or disconnect Battle.net. The last
// sign-in of an account cannot be disconnected: its button is off and says why. My characters (#/characters): the characters Battle.net lists for the
// person, grouped by the guilds they belong to, each with a Claim button. A claim is a request to the officers; nothing reaches the roster
// until one approves it. GET /auth/bnet -> { configured, link, guilds: [{ guildId, status, characters }] }.
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

  function connectButton(label, molten) {
    return '<a class="gs-btn' + (molten ? ' gs-btn-molten' : '') + '" href="' + CONNECT_HREF + '" data-key="bnet-connect">' + G.icons.icon('link', 18) + '<span>' + esc(label) + '</span></a>';
  }

  // ── Linked accounts ──
  // opts.onlyIdentity: Battle.net is the account's only sign-in, so it cannot be disconnected.
  function battlenetCardHtml(data, opts) {
    const only = !!(opts && opts.onlyIdentity);
    const head = function (chip) {
      return '<div class="gs-card-sec-head"><h2 class="gs-h2" id="linked-bnet">Battle.net</h2>' + chip + '</div>';
    };
    const wrap = function (chip, body) {
      return '<section class="gs-card-sec" aria-labelledby="linked-bnet">' + head(chip) + '<div class="gs-card-sec-body">' + body + '</div></section>';
    };
    if (!data) return wrap('', G.pages.signin.loadingHtml());
    if (!data.configured) {
      return wrap('<span class="gs-pill gs-pill-muted">Unavailable</span>', '<p class="gs-warn" id="bnet-not-set-up" role="status">' + esc(NOT_SET_UP) + ' Ask the person who runs this server to add the Battle.net client.</p>');
    }
    const link = data.link;
    if (!link) {
      return wrap('<span class="gs-pill gs-pill-muted">Not connected</span>',
        '<p>Connect Battle.net to see your characters here and tell your officers which ones are yours. You can also sign in with it.</p>' +
        '<ul class="gs-bullets gs-bullets-plain"><li>Raidsmith reads your BattleTag and your list of characters: name, realm, class and level. It never sees your password.</li>' +
        '<li>Your BattleTag stays while Battle.net is connected: it is how you sign in. Raidsmith keeps that list for 30 days, then deletes it. Connect again to refresh it.</li>' +
        '<li>If this Battle.net account already has its own Raidsmith account, it cannot be connected here: accounts are never merged. Sign in with that one instead.</li>' +
        '<li>Disconnect any time to delete both at once.</li></ul>' +
        '<div class="gs-actions">' + connectButton('Connect Battle.net', true) + '</div>');
    }
    return wrap('<span class="gs-pill gs-pill-ok">Connected</span>',
      '<p id="bnet-connected">Connected as <strong>' + esc(link.battletag) + '</strong>.</p>' +
      (link.expired
        ? '<p class="gs-fine" id="bnet-keeps">Your character list was loaded ' + esc(G.ui.formatDate(link.fetchedAt)) + ' and deleted after 30 days. Connect again to load it.</p>'
        : '<p class="gs-fine" id="bnet-keeps">Your characters were loaded ' + esc(G.ui.formatDate(link.fetchedAt)) + '. Raidsmith deletes them on ' + esc(G.ui.formatDate(link.expiresAt)) + ' unless you connect again before then.</p>') +
      (only ? '<p class="gs-fine" id="bnet-only">Battle.net is the only way you sign in right now, so it cannot be disconnected. Connect Discord first, or delete your data on the privacy page.</p>' : '') +
      '<div class="gs-actions">' + (link.expired ? '' : '<a class="gs-btn gs-btn-molten" href="' + esc(G.router.format({ name: 'characters' })) + '" data-key="bnet-characters">My characters</a>') +
      connectButton(link.expired ? 'Load my characters' : 'Refresh characters', !!link.expired) +
      '<button type="button" class="gs-btn gs-btn-danger-outline" data-action="bnet-disconnect-open" data-key="bnet-disconnect"' + (only ? ' disabled aria-describedby="bnet-only"' : '') + '>Disconnect</button></div>');
  }

  // opts: { data (GET /auth/bnet or null), me (the /auth/me answer: adds the name and Discord cards), error (route error key), notice, alert }
  function linkedHtml(opts) {
    const o = opts || {};
    const err = o.error && Object.prototype.hasOwnProperty.call(LINK_ERROR_TEXT, o.error) ? '<p class="gs-alert" id="bnet-link-error" role="alert">' + esc(LINK_ERROR_TEXT[o.error]) + '</p>' : '';
    const ids = o.me && o.me.user ? G.pages.accounts.identitiesOf(o.me) : null;
    return '<div class="gs-page gs-page-narrow"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Linked accounts</h1>' +
      '<p class="gs-sub">How you sign in to Raidsmith. Your account can hold Discord and Battle.net; either one signs you in to the same account.</p></div>' +
      err + noticeHtml(o.notice) + G.ui.alertHtml(o.alert || '', 'gs-page-alert') + (ids ? G.pages.accounts.profileCardsHtml(o.me) : '') +
      battlenetCardHtml(o.data, { onlyIdentity: !!ids && !ids.discord }) +
      '<p class="gs-fine">What Raidsmith keeps, and how to delete it: <a href="#/privacy">Privacy &amp; my data</a>.</p></div>';
  }

  function noticeHtml(text) {
    return text ? '<div class="gs-notice" role="status"><span>' + esc(text) + '</span></div>' : '';
  }

  function disconnectDialogHtml() {
    return '<form class="gs-dialog-form" data-submit="bnet-disconnect-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Disconnect Battle.net?</h2>' +
      '<p class="gs-fine" id="dlg-help">This deletes your BattleTag and your character list from Raidsmith now. Claims you already sent stay with your officers; characters they approved stay on the roster.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Disconnect</button></div></form>';
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

  function rowKey(gid, c) { return 'claim-' + gid + '-' + c.realmSlug + '-' + String(c.name).toLowerCase(); }

  function characterActionHtml(gid, c) {
    const key = rowKey(gid, c);
    const attrs = ' data-gid="' + esc(gid) + '" data-name="' + esc(c.name) + '" data-realm="' + esc(c.realmSlug) + '" data-key="' + esc(key) + '"';
    if (c.claim && c.claim.status === 'pending') {
      return '<button type="button" class="gs-btn gs-btn-sm" data-action="bnet-withdraw" data-claim="' + esc(c.claim.id) + '"' + attrs + ' aria-label="Withdraw the claim on ' + esc(c.name) + '">Withdraw</button>';
    }
    if (c.claimable) {
      return '<button type="button" class="gs-btn gs-btn-sm gs-btn-molten" data-action="bnet-claim"' + attrs + ' aria-label="Claim ' + esc(c.name) + '">Claim</button>';
    }
    return '';
  }

  function characterRowHtml(gid, c) {
    const text = stateText(c);
    return '<tr><th scope="row" class="gs-cell-strong">' + G.ui.classNameHtml(c.name, c.class) + '</th>' +
      '<td data-label="Class">' + esc(G.ui.className(c.class)) + '</td>' +
      '<td data-label="Realm">' + esc(c.realm) + '</td>' +
      '<td data-label="Level">' + (c.level == null ? '<span class="gs-muted">-</span>' : esc(c.level)) + '</td>' +
      '<td data-label="Status">' + (text ? '<span class="gs-bnet-state gs-bnet-' + esc(c.state) + '">' + esc(text) + '</span>' : '') + '</td>' +
      '<td data-label="">' + characterActionHtml(gid, c) + '</td></tr>';
  }

  function guildBodyHtml(g) {
    if (g.status === 'unsupported') return '<p class="gs-empty" data-status="unsupported">' + esc(g.message || ('Battle.net doesn\'t offer character data for ' + g.supportLabel + ' yet.')) + '</p>';
    if (g.status === 'not_linked') return '<p class="gs-empty" data-status="not_linked">Connect Battle.net to see your characters here.</p><div class="gs-actions">' + connectButton('Connect Battle.net', true) + '</div>';
    if (g.status === 'expired') return '<p class="gs-empty" data-status="expired">Your character list was deleted after 30 days, as Battle.net\'s rules ask. Connect again to load it.</p><div class="gs-actions">' + connectButton('Connect again', true) + '</div>';
    if (g.status === 'needs_refresh') return '<p class="gs-empty" data-status="needs_refresh">You joined this guild after you connected Battle.net. Connect again to load your characters for it.</p><div class="gs-actions">' + connectButton('Connect again', true) + '</div>';
    if (g.status === 'unavailable') return '<p class="gs-empty" data-status="unavailable">Battle.net did not give your characters for this guild when you connected. Connect again to try once more.</p><div class="gs-actions">' + connectButton('Connect again', true) + '</div>';
    if (!g.characters.length) {
      return '<p class="gs-empty" data-status="empty">Battle.net lists no ' + esc(g.supportLabel) + ' characters for you. If you made one recently, log out of the game completely and connect again: Battle.net updates this list after a full log out.</p>';
    }
    return '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-bnet" aria-label="Your ' + esc(g.supportLabel) + ' characters"><thead><tr><th scope="col">Character</th><th scope="col">Class</th><th scope="col">Realm</th><th scope="col">Level</th><th scope="col">Status</th><th scope="col"><span class="gs-sr">Action</span></th></tr></thead><tbody>' +
      g.characters.map(function (c) { return characterRowHtml(g.guildId, c); }).join('') + '</tbody></table></div>';
  }

  function guildCardHtml(g) {
    return '<section class="gs-card-sec" aria-labelledby="chars-' + esc(g.guildId) + '"><div class="gs-card-sec-head"><h2 class="gs-h2" id="chars-' + esc(g.guildId) + '">' + esc(g.guildName) + '</h2>' +
      '<span class="gs-fine">' + esc(g.supportLabel) + ' &middot; ' + esc(G.ui.realmLine({ realm: g.realm, realmKind: g.realmKind })) + '</span></div>' +
      '<div class="gs-card-sec-body">' + guildBodyHtml(g) + '</div></section>';
  }

  // opts: { data (GET /auth/bnet or null), notice, alert }
  function charactersHtml(opts) {
    const o = opts || {};
    const data = o.data;
    let body;
    if (!data) body = G.pages.signin.loadingHtml();
    else if (!data.configured) body = '<p class="gs-warn" id="bnet-not-set-up" role="status">' + esc(NOT_SET_UP) + '</p>';
    else if (!data.link) {
      body = '<section class="gs-empty-card" aria-labelledby="chars-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('link', 28) + '</span>' +
        '<h2 class="gs-h2 gs-h2-lg" id="chars-empty-h">Connect Battle.net to see your characters</h2>' +
        '<p class="gs-lead gs-lead-sm">Raidsmith lists the characters on your Battle.net account for each of your guilds. You pick the ones that are yours and your officers approve them.</p>' +
        '<div class="gs-actions">' + connectButton('Connect Battle.net', true) + '</div></section>';
    } else if (!data.guilds.length) {
      body = '<p class="gs-empty">You are not in a Raidsmith guild yet, so there is nothing to claim a character in.</p>';
    } else {
      body = '<p class="gs-fine" id="chars-intro">Claim the characters that are yours. Your officers approve each claim before anything changes on the roster. Loaded ' + esc(G.ui.formatDate(data.link.fetchedAt)) +
        ' from Battle.net as ' + esc(data.link.battletag) + '; deleted on ' + esc(G.ui.formatDate(data.link.expiresAt)) + ' unless you <a href="' + CONNECT_HREF + '">connect again</a>.</p>' +
        data.guilds.map(guildCardHtml).join('');
    }
    return '<div class="gs-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">My characters</h1>' +
      '<p class="gs-sub">From Battle.net, for your guilds. <a href="' + esc(G.router.format({ name: 'linked' })) + '">Linked accounts</a></p></div>' +
      noticeHtml(o.notice) + G.ui.alertHtml(o.alert || '', 'gs-page-alert') + body + '</div>';
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
    linkedHtml: linkedHtml,
    battlenetCardHtml: battlenetCardHtml,
    charactersHtml: charactersHtml,
    characterRowHtml: characterRowHtml,
    guildCardHtml: guildCardHtml,
    disconnectDialogHtml: disconnectDialogHtml,
    load: load,
    state: bnetState,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
