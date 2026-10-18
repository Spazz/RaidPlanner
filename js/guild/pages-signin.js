// ── PAGES: SIGN IN, NO GUILD, MESSAGES ──────────────────────────
// Sign in (signed out), No guild (signed in, none yet; also as a planner notice), and the plain-words message/loading pages.
// Signing in and signing up are one step: "Continue with Discord" or "Continue with Battle.net" (the latter only where the server has it set
// up, GET /auth/providers). An identity nobody holds makes a new account; a known one signs into its account.
(function (G) {
  'use strict';

  const SIGNIN_ERROR_TEXT = {
    denied: 'Sign-in was cancelled. Try again when you are ready.',
    state: 'That sign-in link expired. Try again.',
    discord: 'Discord could not finish the sign-in. Try again in a minute.',
    bnet: 'Battle.net could not finish the sign-in. Try again in a minute.',
    not_configured: 'That sign-in isn\'t set up on this server.',
  };
  const DISCORD_HREF = '/auth/login';
  const BNET_HREF = '/auth/bnet/login?mode=signin';

  function card(inner) {
    return '<div class="gs-card-wrap"><div class="gs-card">' + inner + '</div></div>';
  }

  // The signed-out sign-in card (the shell draws the header around it). opts.providers: { discord, bnet } from GET /auth/providers; until it
  // is known only Discord is offered (the sign-in that always exists).
  function signinHtml(opts) {
    const o = opts || {};
    const providers = o.providers && typeof o.providers === 'object' ? o.providers : { discord: true, bnet: false };
    const err = o.error && Object.prototype.hasOwnProperty.call(SIGNIN_ERROR_TEXT, o.error) ? '<p class="gs-alert" role="alert">' + esc(SIGNIN_ERROR_TEXT[o.error]) + '</p>' : '';
    const notice = o.notice ? '<p class="gs-notice" role="status">' + esc(o.notice) + '</p>' : '';
    const buttons = [];
    if (providers.discord !== false) {
      buttons.push('<a class="gs-btn gs-btn-molten gs-btn-block" href="' + DISCORD_HREF + '">' + G.icons.icon('login', 22) + '<span>Continue with Discord</span></a>');
    }
    if (providers.bnet === true) {
      buttons.push('<a class="gs-btn' + (providers.discord === false ? ' gs-btn-molten' : '') + ' gs-btn-block" href="' + BNET_HREF + '">' + G.icons.icon('login', 22) + '<span>Continue with Battle.net</span></a>');
    }
    const reads = (providers.discord !== false ? 'Discord: Raidsmith reads your username, avatar and the list of servers you\'re in, to find your guild. It never reads or posts messages. ' : '') +
      (providers.bnet === true ? 'Battle.net: it reads your BattleTag, and your character list if you choose to share it.' : '');
    const fresh = (providers.discord !== false && providers.bnet === true
        ? 'New here? Either one makes your account the first time; connect the other later under Linked accounts.'
        : 'New here? Signing in makes your account the first time.');
    return card(
      '<h1 class="gs-h1 gs-h1-lg" tabindex="-1">Your guild\'s roster and attendance</h1>' +
      '<p class="gs-lead">Sign in to see your guild\'s roster, raids and attendance.</p>' + notice + err +
      '<div class="gs-signin-buttons">' + buttons.join('') + '</div>' +
      '<p class="gs-fine" id="signin-fine">' + esc(reads.trim()) + '</p><p class="gs-fine" id="signin-new">' + esc(fresh) + '</p>' +
      '<ul class="gs-link-list"><li><a href="#/privacy">Privacy &amp; my data</a></li>' +
      '<li class="gs-link-list-note">Planning a raid? The planner works without signing in. <a href="/" data-action="open-planner">Open the planner</a></li></ul>');
  }

  // The pieces the no-guild card and the planner notice share (signed in, no guild yet).
  // removedFrom (guilds that blocked this person) replaces the "no guild on your servers" claim; claimable
  // (guilds with no Guild Master on a server they manage) adds a line linking to Create guild.
  function hasDiscord(me) {
    return !me.identities || !!me.identities.discord;
  }

  function noGuildParts(me) {
    const canCreate = !!(me.create && me.create.allowed);
    const removed = Array.isArray(me.removedFrom) ? me.removedFrom : [];
    const claimable = G.pages.create ? G.pages.create.claimableList(me) : [];
    const discord = hasDiscord(me);
    return {
      canCreate: canCreate,
      discord: discord,
      // A guild belongs to a Discord server, so an account with Battle.net alone cannot create one until Discord is connected.
      createNote: discord ? '' : '<p class="gs-fine" id="create-needs-discord">A guild of your own needs Discord too, because it belongs to a Discord server. <a href="#/linked">Connect Discord to create a guild.</a></p>',
      removedNote: removed.length
        ? '<p class="gs-warn gs-removed-note" id="removed-note" role="status">An officer removed your access to ' + G.ui.joinNames(removed) + '.</p>'
        : '',
      lead: removed.length
        ? 'Ask an officer to restore your access, then sign in again to check.'
        : (discord
          ? 'None of your Discord servers has a guild on Raidsmith. If your guild is setting one up, ask an officer, then sign in again to check.'
          : 'Your account isn\'t linked to a roster entry yet. Ask an officer of your guild to link it: send them your BattleTag (the whole thing, like Name#1234), or send a character claim. Or connect Discord to join through your guild\'s Discord server.'),
      claimNote: claimable.length && canCreate
        ? '<p class="gs-lead gs-claim-note"><a href="#/new">A guild on one of your servers has no Guild Master. You can claim it.</a></p>'
        : '',
    };
  }

  // Main area for a signed-in user with no guild yet.
  function noGuildHtml(me) {
    const u = me.user;
    const p = noGuildParts(me);
    return '<div class="gs-card-wrap"><div class="gs-card">' +
      '<h1 class="gs-h1 gs-h1-lg" tabindex="-1">You\'re not in a Raidsmith guild yet</h1>' + p.removedNote +
      '<p class="gs-lead">' + p.lead + '</p>' + p.claimNote + p.createNote +
      '<div class="gs-actions">' + (p.discord ? '<a class="gs-btn" href="/auth/login">Sign in again</a>' : '<a class="gs-btn gs-btn-molten" href="#/linked">Connect Discord</a>') +
      (p.canCreate ? '<a class="gs-btn gs-btn-molten" href="#/new">Create a guild</a>' : '') +
      '<a class="gs-btn' + (p.canCreate || !p.discord ? '' : ' gs-btn-molten') + '" href="/" data-action="open-planner">Open the planner</a></div>' +
      '<p class="gs-card-foot"><span>Signed in as ' + esc(u.displayName || u.username) + '</span><button type="button" class="gs-linkbtn" data-action="sign-out">Sign out</button></p>' +
      '</div></div>';
  }

  // The same message as a notice above the compact planner home (#planner-notice).
  function noGuildNoticeHtml(me) {
    const p = noGuildParts(me);
    return '<div class="gs-notice gs-noguild-notice" role="status"><div class="gs-notice-body">' +
      '<h2 class="gs-notice-title">You\'re not in a Raidsmith guild yet</h2>' + p.removedNote +
      '<p class="gs-notice-text">' + p.lead + '</p>' + p.claimNote + p.createNote + '</div>' +
      (p.discord ? '<a class="gs-btn gs-btn-sm" href="/auth/login">Sign in again</a>' : '<a class="gs-btn gs-btn-sm" href="#/linked">Connect Discord</a>') + '</div>';
  }

  // A plain page that says why (access removed, not a member, forbidden, load failure). opts.actionsHtml: buttons to put before Back to start.
  function messageHtml(title, text, opts) {
    const o = opts || {};
    return card('<h1 class="gs-h1 gs-h1-lg" tabindex="-1">' + esc(title) + '</h1><p class="gs-lead">' + esc(text) + '</p>' +
      '<div class="gs-actions">' + (o.actionsHtml || '') + (o.retry ? '<button type="button" class="gs-btn" data-action="retry">Try again</button>' : '') +
      '<a class="gs-btn' + (o.retry || o.actionsHtml ? '' : ' gs-btn-molten') + '" href="#/">Back to start</a></div>');
  }

  function loadingHtml() {
    return '<div class="gs-loading" role="status">Loading...</div>';
  }

  G.pages.signin = { SIGNIN_ERROR_TEXT: SIGNIN_ERROR_TEXT, DISCORD_HREF: DISCORD_HREF, BNET_HREF: BNET_HREF, signinHtml: signinHtml, noGuildHtml: noGuildHtml, noGuildNoticeHtml: noGuildNoticeHtml, messageHtml: messageHtml, loadingHtml: loadingHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
