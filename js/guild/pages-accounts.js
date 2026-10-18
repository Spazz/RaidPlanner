// ── PAGES: ACCOUNT CARDS (Phase 7a) ─────────────────────────────
// The sections of the Linked accounts form page (T3) that are about the account itself: the name it shows (a form with the Save bar), Discord as a linked sign-in
// and the reminder opt-out (a single toggle that saves on its own).
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
    const body = '<form data-submit="account-name-form" id="account-name-form" novalidate' + G.ui.dirtyFormAttrs() + '>' +
      '<p id="account-shown">Shown as <strong>' + esc(shown) + '</strong>' + (custom ? '' : ' (' + esc(nameSourceText(me)) + ')') + '.</p>' +
      G.ui.fieldHtml({ id: 'account-name', name: 'displayName', label: 'Display name', kind: 'text', value: custom, maxlength: MAX_NAME, autocomplete: 'off',
        help: 'Up to ' + MAX_NAME + ' characters. Everyone in your guilds sees this name. Leave it empty to use ' + nameSourceText(me) + '.' }) +
      '<p class="gs-alert" id="account-name-error" role="alert" hidden></p>' +
      (custom ? '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Use ' + nameSourceText(me), attrs: { 'data-action': 'account-name-reset', 'data-key': 'account-name-reset' } }) + '</div>' : '') +
      G.ui.saveBarHtml({ saveLabel: 'Save name' }) + '</form>';
    return G.ui.objectSectionHtml({ id: 'linked-name', title: 'Your name', bodyHtml: body });
  }

  function discordCardHtml(me) {
    const ids = identitiesOf(me);
    const avail = availableOf(me);
    const wrap = function (chip, body) {
      return G.ui.objectSectionHtml({ id: 'linked-discord', title: 'Discord', chipHtml: chip, bodyHtml: body });
    };
    if (!ids.discord) {
      if (!avail.discord) {
        return wrap(G.ui.chipHtml({ tone: 'neutral', label: 'Unavailable', icon: 'dash' }), '<p class="gs-warn" id="discord-not-set-up" role="status">Discord isn\'t set up on this server.</p>');
      }
      return wrap(G.ui.chipHtml({ tone: 'none', label: 'Not connected' }),
        '<p>Connect Discord to join guilds through their Discord server, and to create a guild.</p>' +
        '<ul class="gs-bullets gs-bullets-plain"><li>Raidsmith reads your Discord username, avatar and the list of servers you are in, to find your guilds. It never reads or posts messages.</li>' +
        '<li>If this Discord account already has its own Raidsmith account, it cannot be connected here: accounts are never merged. Sign in with that one instead.</li></ul>' +
        '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Connect Discord', href: CONNECT_DISCORD_HREF, icon: 'link', attrs: { 'data-key': 'discord-connect' } }) + '</div>');
    }
    const only = !ids.bnet;
    const who = ids.discord.username ? '<strong>@' + esc(ids.discord.username) + '</strong>' : 'Discord';
    return wrap(G.ui.chipHtml({ tone: 'success', label: 'Connected' }),
      '<p id="discord-connected">Connected as ' + who + '.</p>' +
      (only ? '<p class="gs-fine" id="discord-only">Discord is the only way you sign in right now, so it cannot be disconnected. Connect Battle.net first, or delete your data on the privacy page.</p>' : '') +
      '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Refresh my servers', href: CONNECT_DISCORD_HREF, attrs: { 'data-key': 'discord-refresh' } }) +
      G.ui.buttonHtml({ label: 'Disconnect', variant: 'danger-outline', disabled: only, attrs: { 'data-action': 'discord-disconnect-open', 'data-key': 'discord-disconnect', 'aria-describedby': only ? 'discord-only' : null } }) + '</div>');
  }

  function disconnectDiscordDialogHtml() {
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Disconnect Discord?',
      bodyHtml: '<p class="gs-fine" id="dlg-help">You will sign in with Battle.net only. Raidsmith deletes your Discord ID, nickname and server list from everything it holds, as Delete my data does for Discord, so your roster entries stop being matched to your Discord and guilds that know you only through their Discord server disappear. You stay in a guild if an officer has linked your account to your roster entry there. Your roster entries and attendance are not deleted.</p>',
      primary: { label: 'Disconnect Discord' }, formAttrs: { 'data-submit': 'discord-disconnect-form' },
    });
  }

  // "Don't mention me in reminders" (PM wave 4): the Discord channel reminders of a guild list people who haven't answered a raid or confirmed a roster, and ping
  // those with a Discord ID. Opting out lists this account by name only. /auth/me: account.reminderOptOut.
  function reminderOptOutOf(me) {
    return !!(me && me.account && me.account.reminderOptOut);
  }

  function reminderCardHtml(me) {
    return G.ui.objectSectionHtml({ id: 'linked-reminders', title: 'Discord reminders', bodyHtml:
      '<p>When your officers switch on reminders, Raidsmith posts in your team\'s Discord channel who hasn\'t signed up for a raid or confirmed their group in the line-up, and pings the people whose Discord account it knows.</p>' +
      G.ui.checkFieldHtml({ id: 'reminder-optout', name: 'reminderOptOut', label: 'Don\'t mention me in reminders', checked: reminderOptOutOf(me), attrs: { 'data-change': 'reminder-optout' } }) +
      '<p class="gs-fine" id="reminder-optout-help">You are still listed by name, without a ping.</p>' +
      '<p class="gs-alert" id="reminder-optout-error" role="alert" hidden></p>' });
  }

  // The cards above Battle.net on the Linked accounts page. '' when the page has no /auth/me answer (older callers).
  function profileCardsHtml(me) {
    if (!me || !me.user) return '';
    return nameCardHtml(me) + discordCardHtml(me) + reminderCardHtml(me);
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

  G.handlers.change['reminder-optout'] = function (el) {
    const want = !!el.checked;
    el.disabled = true;
    G.ui.setText('reminder-optout-error', '');
    G.api.reminders.optOut(want).then(function () {
      return refresh(want ? 'You won\'t be pinged in reminders.' : 'Reminders may ping you again.');
    }, function (err) {
      el.disabled = false;
      el.checked = !want;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      G.ui.setText('reminder-optout-error', c.text);
    });
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
    reminderCardHtml: reminderCardHtml,
    reminderOptOutOf: reminderOptOutOf,
    refresh: refresh,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
