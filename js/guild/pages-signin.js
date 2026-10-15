// ── PAGES: SIGN IN, NO GUILD, MESSAGES ──────────────────────────
// Sign in (signed out), No guild (signed in, none yet), and the plain-words message/loading pages.
(function (G) {
  'use strict';

  const SIGNIN_ERROR_TEXT = {
    denied: 'Discord sign-in was cancelled. Try again when you are ready.',
    state: 'That sign-in link expired. Try again.',
    discord: 'Discord could not finish the sign-in. Try again in a minute.',
  };

  function card(inner) {
    return '<div class="gs-card-wrap"><div class="gs-card">' + inner + '</div></div>';
  }

  // The whole signed-out page (own header, no shell).
  function signinHtml(opts) {
    const o = opts || {};
    const err = o.error && Object.prototype.hasOwnProperty.call(SIGNIN_ERROR_TEXT, o.error) ? '<p class="gs-alert" role="alert">' + esc(SIGNIN_ERROR_TEXT[o.error]) + '</p>' : '';
    const notice = o.notice ? '<p class="gs-notice" role="status">' + esc(o.notice) + '</p>' : '';
    return G.shell.publicHeaderHtml() + '<main class="gs-main gs-main-center" id="gs-main">' + card(
      '<h1 class="gs-h1 gs-h1-lg" tabindex="-1">Your guild\'s roster and attendance</h1>' +
      '<p class="gs-lead">Sign in with Discord to see your guild\'s roster, raid nights and attendance.</p>' + notice + err +
      '<a class="gs-btn gs-btn-molten gs-btn-block" href="/auth/login">' + G.icons.icon('login', 22) + '<span>Sign in with Discord</span></a>' +
      '<p class="gs-fine">Raidsmith reads your Discord username, avatar and the list of servers you\'re in, to find your guild. It never reads or posts messages.</p>' +
      '<ul class="gs-link-list"><li><a href="#/privacy">Privacy &amp; my data</a></li>' +
      '<li class="gs-link-list-note">Planning a raid? The planner works without signing in. <a href="/">Open the planner</a></li></ul>') + '</main>';
  }

  // Main area for a signed-in user with no guild yet.
  // removedFrom (guilds that blocked this person) replaces the "no guild on your servers" claim; claimable
  // (guilds with no Guild Master on a server they manage) adds a line linking to Create guild.
  function noGuildHtml(me) {
    const u = me.user;
    const canCreate = !!(me.create && me.create.allowed);
    const removed = Array.isArray(me.removedFrom) ? me.removedFrom : [];
    const claimable = G.pages.create ? G.pages.create.claimableList(me) : [];
    const removedNote = removed.length
      ? '<p class="gs-warn gs-removed-note" id="removed-note" role="status">An officer removed your access to ' + G.ui.joinNames(removed) + '.</p>'
      : '';
    const lead = removed.length
      ? 'Ask an officer to restore your access, then sign in again to check.'
      : 'None of your Discord servers has a guild on Raidsmith. If your guild is setting one up, ask an officer, then sign in again to check.';
    const claimNote = claimable.length && canCreate
      ? '<p class="gs-lead gs-claim-note"><a href="#/new">A guild on one of your servers has no Guild Master. You can claim it.</a></p>'
      : '';
    return '<div class="gs-card-wrap"><div class="gs-card">' +
      '<h1 class="gs-h1 gs-h1-lg" tabindex="-1">You\'re not in a Raidsmith guild yet</h1>' + removedNote +
      '<p class="gs-lead">' + lead + '</p>' + claimNote +
      '<div class="gs-actions"><a class="gs-btn" href="/auth/login">Sign in again</a>' +
      (canCreate ? '<a class="gs-btn gs-btn-molten" href="#/new">Create a guild</a>' : '') +
      '<a class="gs-btn' + (canCreate ? '' : ' gs-btn-molten') + '" href="/">Open the planner</a></div>' +
      '<p class="gs-card-foot"><span>Signed in as ' + esc(u.username) + '</span><button type="button" class="gs-linkbtn" data-action="sign-out">Sign out</button></p>' +
      '</div></div>';
  }

  // A plain page that says why (access removed, not a member, forbidden, load failure).
  function messageHtml(title, text, opts) {
    const o = opts || {};
    return card('<h1 class="gs-h1 gs-h1-lg" tabindex="-1">' + esc(title) + '</h1><p class="gs-lead">' + esc(text) + '</p>' +
      '<div class="gs-actions">' + (o.retry ? '<button type="button" class="gs-btn" data-action="retry">Try again</button>' : '') +
      '<a class="gs-btn' + (o.retry ? '' : ' gs-btn-molten') + '" href="#/">Back to start</a></div>');
  }

  function loadingHtml() {
    return '<div class="gs-loading" role="status">Loading...</div>';
  }

  G.pages.signin = { SIGNIN_ERROR_TEXT: SIGNIN_ERROR_TEXT, signinHtml: signinHtml, noGuildHtml: noGuildHtml, messageHtml: messageHtml, loadingHtml: loadingHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
