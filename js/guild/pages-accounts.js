// ── PAGES: ACCOUNT CARDS (Phase 7a) ─────────────────────────────
// The cards of the Linked accounts page that are about the account itself: the name it shows, and Discord as a linked sign-in.
// (The Battle.net card and the page frame are in pages-bnet.js, which puts these cards above its own.) A Raidsmith account holds one or
// more sign-ins, Discord and Battle.net today; either can be connected or disconnected, but never the last one.
// /auth/me gives { user, identities: { discord, bnet }, account: { customName, available } }.
// Pure parts: profileCardsHtml, nameCardHtml, discordCardHtml, disconnectDiscordDialogHtml, nameOf.
(function (G) {
  'use strict';

  const CONNECT_DISCORD_HREF = '/auth/login?mode=link';
  const MAX_NAME = 32;

  function st() { return G.app.state; }

  // The sign-ins this account has, from /auth/me (an older answer without them is a Discord account).
  function identitiesOf(me) {
    const i = me && me.identities ? me.identities : null;
    return i ? { discord: i.discord || null, bnet: i.bnet || null } : { discord: {}, bnet: null };
  }
  function availableOf(me) {
    const a = me && me.account && me.account.available ? me.account.available : null;
    return { discord: !a || a.discord !== false, bnet: !a || a.bnet !== false };
  }
  function customNameOf(me) {
    return me && me.account && typeof me.account.customName === 'string' ? me.account.customName : '';
  }

  // Where the shown name comes from, in words.
  function nameSourceText(me) {
    return identitiesOf(me).discord ? 'your Discord name' : 'your BattleTag without its number';
  }

  function nameCardHtml(me) {
    const custom = customNameOf(me);
    const shown = me && me.user ? me.user.displayName : '';
    return '<section class="gs-card-sec" aria-labelledby="linked-name"><div class="gs-card-sec-head"><h2 class="gs-h2" id="linked-name">Your name</h2></div>' +
      '<form class="gs-card-sec-body" data-submit="account-name-form" novalidate>' +
      '<p id="account-shown">Shown as <strong>' + esc(shown) + '</strong>' + (custom ? '' : ' (' + esc(nameSourceText(me)) + ')') + '.</p>' +
      '<div class="gs-field"><label class="gs-label" for="account-name">Display name</label>' +
      '<input class="gs-input" type="text" id="account-name" name="displayName" maxlength="' + MAX_NAME + '" autocomplete="off" value="' + esc(custom) + '" aria-describedby="account-name-help">' +
      '<p class="gs-fine" id="account-name-help">Up to ' + MAX_NAME + ' characters. Everyone in your guilds sees this name. Leave it empty to use ' + esc(nameSourceText(me)) + '.</p></div>' +
      '<p class="gs-alert" id="account-name-error" role="alert" hidden></p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten" data-key="account-name-save">Save name</button>' +
      (custom ? '<button type="button" class="gs-btn" data-action="account-name-reset" data-key="account-name-reset">Use ' + esc(nameSourceText(me)) + '</button>' : '') + '</div></form></section>';
  }

  function discordCardHtml(me) {
    const ids = identitiesOf(me);
    const avail = availableOf(me);
    const head = function (chip) {
      return '<div class="gs-card-sec-head"><h2 class="gs-h2" id="linked-discord">Discord</h2>' + chip + '</div>';
    };
    const wrap = function (chip, body) {
      return '<section class="gs-card-sec" aria-labelledby="linked-discord">' + head(chip) + '<div class="gs-card-sec-body">' + body + '</div></section>';
    };
    if (!ids.discord) {
      if (!avail.discord) {
        return wrap('<span class="gs-pill gs-pill-muted">Unavailable</span>', '<p class="gs-warn" id="discord-not-set-up" role="status">Discord isn\'t set up on this server.</p>');
      }
      return wrap('<span class="gs-pill gs-pill-muted">Not connected</span>',
        '<p>Connect Discord to join guilds through their Discord server, and to create a guild.</p>' +
        '<ul class="gs-bullets gs-bullets-plain"><li>Raidsmith reads your Discord username, avatar and the list of servers you are in, to find your guilds. It never reads or posts messages.</li>' +
        '<li>If this Discord account already has its own Raidsmith account, it cannot be connected here: accounts are never merged. Sign in with that one instead.</li></ul>' +
        '<div class="gs-actions"><a class="gs-btn gs-btn-molten" href="' + CONNECT_DISCORD_HREF + '" data-key="discord-connect">' + G.icons.icon('link', 18) + '<span>Connect Discord</span></a></div>');
    }
    const only = !ids.bnet;
    const who = ids.discord.username ? '<strong>@' + esc(ids.discord.username) + '</strong>' : 'Discord';
    return wrap('<span class="gs-pill gs-pill-ok">Connected</span>',
      '<p id="discord-connected">Connected as ' + who + '.</p>' +
      (only ? '<p class="gs-fine" id="discord-only">Discord is the only way you sign in right now, so it cannot be disconnected. Connect Battle.net first, or delete your data on the privacy page.</p>' : '') +
      '<div class="gs-actions"><a class="gs-btn" href="' + CONNECT_DISCORD_HREF + '" data-key="discord-refresh">Refresh my servers</a>' +
      '<button type="button" class="gs-btn gs-btn-danger-outline" data-action="discord-disconnect-open" data-key="discord-disconnect"' + (only ? ' disabled aria-describedby="discord-only"' : '') + '>Disconnect</button></div>');
  }

  function disconnectDiscordDialogHtml() {
    return '<form class="gs-dialog-form" data-submit="discord-disconnect-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Disconnect Discord?</h2>' +
      '<p class="gs-fine" id="dlg-help">You will sign in with Battle.net only. You stay in the guilds where your roster entry is linked to you; guilds that know you only through their Discord server will not show up until you connect Discord again or an officer links your account to your roster entry. Your roster entries and attendance are not touched.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Disconnect Discord</button></div></form>';
  }

  // The cards above Battle.net on the Linked accounts page. '' when the page has no /auth/me answer (older callers).
  function profileCardsHtml(me) {
    if (!me || !me.user) return '';
    return nameCardHtml(me) + discordCardHtml(me);
  }

  // ── behaviour ──
  // Reads /auth/me and /auth/bnet again and draws the Linked accounts page with a notice.
  function refresh(notice) {
    const s = st();
    return Promise.all([G.app.loadMe(), G.api.get('/auth/bnet')]).then(function (res) {
      s.bnet = { data: res[1], notice: notice || '', alert: '' };
      G.app.render();
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  function saveName(value, form) {
    G.ui.setText('account-name-error', '');
    if (form) G.ui.setBusy(form, true);
    return G.api.patch('/api/me', { displayName: value === '' ? null : value }).then(function () {
      return refresh(value === '' ? 'Name reset.' : 'Name saved.');
    }, function (err) {
      if (form) G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return null; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return null; }
      G.ui.setText('account-name-error', c.text);
      return null;
    });
  }

  G.handlers.submit['account-name-form'] = function (form) {
    saveName(String(form.elements.displayName.value || '').trim(), form);
  };

  G.handlers.click['account-name-reset'] = function (el) {
    if (el.disabled) return;
    el.disabled = true;
    saveName('', null);
  };

  G.handlers.click['discord-disconnect-open'] = function (el) {
    if (el.disabled) return;
    G.ui.openDialog(disconnectDiscordDialogHtml(), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.submit['discord-disconnect-form'] = function (form) {
    G.ui.runDialog(form, G.api.del('/auth/discord', {}), function () {
      refresh('Discord disconnected. You sign in with Battle.net now.');
    });
  };

  G.pages.accounts = {
    CONNECT_DISCORD_HREF: CONNECT_DISCORD_HREF,
    MAX_NAME: MAX_NAME,
    identitiesOf: identitiesOf,
    nameSourceText: nameSourceText,
    nameCardHtml: nameCardHtml,
    discordCardHtml: discordCardHtml,
    disconnectDiscordDialogHtml: disconnectDiscordDialogHtml,
    profileCardsHtml: profileCardsHtml,
    refresh: refresh,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
