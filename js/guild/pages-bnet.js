// ── PAGES: LINKED ACCOUNTS, MY CHARACTERS (Battle.net, Phase 5; accounts, Phase 7a; My characters on Forge, B8b boards MC1-MC5) ──
// Linked accounts (#/linked) is a T3 form page: the name the account shows (a form with the Save bar) and Discord (pages-accounts.js), then connect or disconnect
// Battle.net. The last sign-in of an account cannot be disconnected: its button is off and says why. My characters (#/characters) is a T1 list page: one gold group head per
// guild (version and realm, the Request team button), then the characters on the viewer's profile as equal cards (Main = a tag and first; a card has no buttons and is one
// link to the Character page), then "Waiting for an officer" (the conflicts: another account or roster entry holds the character; Withdraw), then one quiet line that
// opens the Add dialog for the Battle.net characters that did not join by themselves. The Worker adds the characters at the version's level cap when Battle.net connects and
// at every refresh (worker/bnet-auto-add.js); the member picks the lower ones ("N characters below 70 - Add"). The page's one Battle.net link is the line at its foot.
// Battle.net is proof the character is theirs, so Add puts it on their record at once (even a roster entry nobody had linked); only a conflict (another account holds it, or
// another roster entry of theirs) is "Needs an officer", with Withdraw (user decisions 2026-10-26, board 7). Somebody who is already on a guild's roster is told what Battle.net
// adds (their alts, a second sign-in), never to connect it to "see" what the roster already shows.
// In a guild whose characters are not decided by Battle.net sits "Find your character on the roster" (pages-this-is-me.js, board 9): a roster entry that nobody linked is claimed
// by name, and an officer confirms it. It renders without Battle.net too. An in-game guild says its characters come from Battle.net only.
// GET /auth/bnet -> { configured, link, guilds: [{ guildId, onRoster, battlenetOnly, status, maxLevel, profile, characters }] } (tasks/open/b8b-mychars-contract.md).
// Pure parts: linkedHtml, charactersHtml, cardHtml, guildSectionHtml, addDialogHtml, stateText. Connecting is a plain link to /auth/bnet/login (a full-page redirect).
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
    fresh_required: 'Confirm it is you first: sign in again, then connect.',
  };
  // The sign-in a protected account (Owner, Officer, Team Lead) must confirm before it links a first Discord or Battle.net (identity_change; the Worker sends the browser to
  // #/linked?error=fresh_required): the change is the identity the account lacks, the sign-in is the one it has. fresh.js keeps the act and the callback repeats the connect.
  const LINK_CHANGES = { link_discord: { label: 'Discord', kind: 'discord_link' }, link_bnet: { label: 'Battle.net', kind: 'bnet_link' } };
  const CONNECT_HREF = '/auth/bnet/login';
  const NOT_SET_UP = 'Battle.net isn\'t set up on this server.';

  function st() { return G.app.state; }
  function bnetState() { return st().bnet; }

  // A notice for the next Linked accounts page (an act that finished on #/fresh sends the person here; the page's own load reads it once).
  let flashNotice = '';
  function setFlash(text) { flashNotice = text || ''; }

  // The change a refused link wants confirmed, from the identities the account holds: it links the one it lacks. null when it lacks neither.
  function linkChangeOf(me) {
    const ids = me && me.user ? G.pages.accounts.identitiesOf(me) : null;
    if (!ids) return null;
    if (!ids.bnet) return 'link_bnet';
    if (!ids.discord) return 'link_discord';
    return null;
  }

  // The banner of #/linked?error=fresh_required: one button, the sign-in the account has (Battle.net or Discord), then the connect goes on by itself.
  function freshRequiredHtml(me) {
    const change = linkChangeOf(me);
    const options = change ? G.fresh.optionsFor('identity_change', G.fresh.linkedOf(me)) : [];
    const what = change ? LINK_CHANGES[change].label : '';
    if (!options.length) return '<p class="gs-alert" id="bnet-link-error" role="alert">' + esc(LINK_ERROR_TEXT.fresh_required) + '</p>';
    const actions = options.map(function (p) {
      return { label: 'Sign in with ' + G.fresh.PROVIDER_LABEL[p], attrs: { 'data-action': 'identity-fresh-start', 'data-key': 'identity-fresh-' + p, 'data-change': change, 'data-provider': p } };
    });
    return G.ui.bannerHtml({ tone: 'warning', dismissible: false, id: 'fresh-required-banner', title: 'Confirm it is you first.',
      text: 'Connecting ' + what + ' changes how you sign in, so Raidsmith asks you to sign in again first. Then ' + what + ' connects.', actions: actions }) +
      '<p class="gs-alert" id="fresh-start-error" role="alert" hidden></p>';
  }

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
    const err = o.error === 'fresh_required' ? freshRequiredHtml(o.me)
      : (o.error && Object.prototype.hasOwnProperty.call(LINK_ERROR_TEXT, o.error) ? '<p class="gs-alert" id="bnet-link-error" role="alert">' + esc(LINK_ERROR_TEXT[o.error]) + '</p>' : '');
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
  // The Worker's words for a Battle.net character's standing, used on the lists below (state: new | on_roster | yours | taken | other_realm).
  const STATE_TEXT = {
    yours: 'On your record',
    taken: 'On someone else\'s record',
    other_realm: 'Another realm',
    on_roster: 'On the roster, not linked to anyone',
    new: '',
  };

  function stateText(c) {
    if (c.claim && c.claim.status === 'pending') return 'Needs an officer';
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

  // One POST /claims takes at most this many characters (the Worker's CLAIM_BATCH_MAX); the Add dialog sends longer picks in several requests.
  const MAX_PER_REQUEST = 10;
  const WHY = { taken: 'On another account', on_roster: 'On a different roster entry than yours' };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function guildOf(gid) {
    const data = bnetState() ? bnetState().data : null;
    return data && Array.isArray(data.guilds) ? data.guilds.filter(function (g) { return g.guildId === gid; })[0] || null : null;
  }
  function profileOf(g) { return Array.isArray(g.profile) ? g.profile : []; }
  function listedOf(g) { return Array.isArray(g.characters) ? g.characters : []; }
  // The Battle.net characters waiting for an officer (a conflict: another account or another roster entry holds them) and the ones that can be added now.
  function waitingOf(g) { return listedOf(g).filter(function (c) { return c.claim && c.claim.status === 'pending'; }); }
  function addableOf(g) { return listedOf(g).filter(function (c) { return c.claimable; }); }
  // True while every character to add is known to be below the version's level cap (the usual case: the ones at the cap joined by themselves).
  function allBelowMax(g, list) {
    return !!g.maxLevel && list.length > 0 && list.every(function (c) { return typeof c.level === 'number' && c.level < g.maxLevel; });
  }
  // "Oct 27", with the year when it is not this year.
  function shortDate(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    try {
      const same = new Date(ms).getFullYear() === new Date().getFullYear();
      return new Date(ms).toLocaleDateString('en-US', same ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) { return ''; }
  }

  // ── the cards (board MC1, concept 1B): equal size, tinted by class, no buttons; the whole card is the link to the Character page ──
  function ccClass(classId) {
    const css = G.ui.classClass(classId);
    return css ? ' gs-chars-cc-' + css.replace('gs-class-', '') : '';
  }

  function cardHtml(c) {
    const spec = (c.mainSpec ? c.mainSpec + ' ' : '') + G.ui.className(c.class);
    const level = typeof c.level === 'number' ? '<span class="gs-hd-chip is-grey gs-chars-lvl" aria-label="Level ' + esc(c.level) + '">' + esc(c.level) + '</span>' : '';
    let chips = c.isMain ? '<span class="gs-hd-chip is-grey">Main</span>' : '';
    if (c.team && c.team.name) chips += '<span class="gs-hd-chip is-grey">' + esc(c.team.name) + '</span>';
    else if (c.request) {
      const ago = G.ui.agoText(c.request.createdAt);
      chips += '<span class="gs-hd-chip is-todo">Requested</span><span class="gs-chars-note">' + esc(c.request.team.name) + (ago ? ' &middot; ' + esc(ago) : '') + '</span>';
    } else chips += '<span class="gs-hd-chip is-grey gs-chars-chip-none">No team</span>';
    return '<a class="gs-hd-panel gs-chars-card' + ccClass(c.class) + '" href="' + esc(G.router.format({ name: 'character', cid: c.id })) + '" aria-label="Open ' + esc(c.name) + '" data-key="chars-card-' + esc(c.id) + '">' +
      '<span class="gs-chars-card-h">' + G.ui.specIconHtml(c.class, c.mainSpec, 40) + '<span class="gs-chars-card-id"><span class="gs-chars-card-name ' + G.ui.classClass(c.class) + '">' + esc(c.name) + '</span><span class="gs-chars-card-sub">' + esc(spec) + '</span></span>' + level + '</span>' +
      '<span class="gs-chars-card-b">' + chips + '</span></a>';
  }

  function cardsHtml(g) {
    const list = profileOf(g);
    return list.length ? '<div class="gs-chars-cards">' + list.map(cardHtml).join('') + '</div>' : '';
  }

  // ── Request team (board MC3): the head button opens the built dialog (pages-team-requests.js) with this guild's characters ──
  // The person's record in the shape that dialog reads (the person page's): the characters on no team can ask, the teams they hold are not offered.
  function recordOf(g) {
    return { person: { isMe: true }, characters: profileOf(g).map(function (c) { return { id: c.id, name: c.name, class: c.class, mainSpec: c.mainSpec, team: c.team }; }) };
  }
  function requestsOf(g) {
    return profileOf(g).filter(function (c) { return c.request; }).map(function (c) { return { id: c.request.id, status: 'pending', character: { id: c.id }, team: c.request.team }; });
  }
  function guildData(gid) { const s = st(); return s.guilds && s.guilds[gid] ? s.guilds[gid] : null; }
  function canAsk(g) {
    const tr = G.pages.teamRequests;
    const gd = guildData(g.guildId);
    return !!(tr && gd && profileOf(g).length && tr.canRequest(gd, recordOf(g), requestsOf(g)));
  }
  // The built dialog, its form handed to this page's own submit (the built one reads the person page's record, which this page does not have).
  function requestDialogHtml(g) {
    const html = G.pages.teamRequests.dialogHtml(guildData(g.guildId), recordOf(g), requestsOf(g));
    return html.replace('data-submit="team-request-form"', 'data-submit="chars-request-form" data-gid="' + esc(g.guildId) + '"');
  }

  // ── the guild section ──
  function guildHeadHtml(g) {
    const n = profileOf(g).length;
    const ask = canAsk(g) ? G.ui.buttonHtml({ label: 'Request team', ariaLabel: 'Request a team for one of your characters in ' + g.guildName,
      attrs: { 'data-action': 'chars-request-open', 'data-gid': g.guildId, 'data-key': 'chars-request-' + g.guildId } }) : '';
    return '<div class="gs-chars-gh"><h2 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(g.guildName) + '</span>' + (n ? '<span class="gs-fg-ghn">' + n + '</span>' : '') + '</h2>' +
      '<span class="gs-fg-mut gs-chars-gline">' + esc(g.supportLabel) + ' &middot; ' + esc(G.ui.realmLine({ realm: g.realm, realmKind: g.realmKind })) + '</span>' +
      (ask ? '<span class="gs-chars-gact">' + ask + '</span>' : '') + '</div>';
  }

  // "Waiting for an officer": the characters Battle.net proves are yours but that another account or roster entry holds (the usual conflict row, with Withdraw).
  function waitingRowHtml(gid, c) {
    const sub = [G.ui.className(c.class)].concat(typeof c.level === 'number' ? ['level ' + c.level] : [], Object.prototype.hasOwnProperty.call(WHY, c.state) ? [WHY[c.state]] : []);
    return '<li class="gs-tim-row">' + G.ui.specIconHtml(c.class, null, 20) + '<span class="gs-tim-id">' + G.ui.classNameHtml(c.name, c.class) + '<span class="gs-tim-sub">' + sub.map(esc).join(' &middot; ') + '</span></span>' +
      '<span class="gs-tim-end"><span class="gs-hd-chip is-rose">Needs an officer</span>' +
      G.ui.buttonHtml({ label: 'Withdraw', variant: 'ghost', size: 'sm', ariaLabel: 'Withdraw the request for ' + c.name,
        attrs: { 'data-action': 'bnet-withdraw', 'data-gid': gid, 'data-name': c.name, 'data-claim': c.claim.id, 'data-key': 'claim-' + gid + '-' + c.realmSlug + '-' + String(c.name).toLowerCase() } }) + '</span></li>';
  }

  function waitingHtml(g) {
    const list = waitingOf(g);
    return list.length ? '<h3 class="gs-tim-h">Waiting for an officer</h3><ul class="gs-tim-list" aria-label="Waiting for an officer">' + list.map(function (c) { return waitingRowHtml(g.guildId, c); }).join('') + '</ul>' : '';
  }

  // The quiet line under the cards: the Battle.net characters that did not join by themselves, and the one way to add them (the Add dialog).
  function addAttrs(g) { return { 'data-action': 'chars-add-open', 'data-gid': g.guildId, 'data-key': 'chars-add-' + g.guildId }; }
  function addLabelOf(g, list) { return allBelowMax(g, list) ? 'Add characters below ' + g.maxLevel : 'Add characters from Battle.net'; }

  function quietLineHtml(g, list) {
    const below = allBelowMax(g, list);
    const words = below ? plural(list.length, 'character', 'characters') + ' below ' + g.maxLevel + ' on your Battle.net' : plural(list.length, 'character', 'characters') + ' on your Battle.net not on your profile yet';
    const attrs = addAttrs(g);
    return '<p class="gs-fine gs-chars-quiet">' + esc(words) + ' &middot; <button type="button" class="gs-linkbtn" aria-label="' + esc(addLabelOf(g, list)) + ' (' + esc(g.guildName) + ')" data-action="' + attrs['data-action'] +
      '" data-gid="' + esc(g.guildId) + '" data-key="' + esc(attrs['data-key']) + '">Add</button></p>';
  }

  function connectAgain(label) { return '<div class="gs-actions">' + connectButton(label) + '</div>'; }

  // What a guild says about its Battle.net list when it cannot show one (and, connected, what it says when there is nothing to add).
  function statusBodyHtml(g, connected) {
    if (g.status === 'unsupported') return '<p class="gs-empty" data-status="unsupported">' + esc(g.message || ('Battle.net doesn\'t offer character data for ' + g.supportLabel + ' yet.')) + '</p>';
    if (!connected) return '';
    if (g.status === 'expired') return '<p class="gs-empty" data-status="expired">Your character list was deleted after 30 days, as Battle.net\'s rules ask. Connect again to load it.</p>' + connectAgain('Connect again');
    if (g.status === 'needs_refresh') return '<p class="gs-empty" data-status="needs_refresh">You joined this guild after you connected Battle.net. Connect again to load your characters for it.</p>' + connectAgain('Connect again');
    if (g.status === 'unavailable') return '<p class="gs-empty" data-status="unavailable">Battle.net did not give your characters for this guild when you connected. Connect again to try once more.</p>' + connectAgain('Connect again');
    const addable = addableOf(g);
    const profile = profileOf(g);
    const waiting = waitingHtml(g);
    if (addable.length && !profile.length && allBelowMax(g, addable)) {
      // Nothing joined by itself (none is at the cap): the quiet line becomes the action.
      return waiting + G.ui.emptyStateHtml({
        kind: 'first', icon: 'roster', title: 'None of your characters is level ' + g.maxLevel + ' yet',
        text: 'Characters at ' + g.maxLevel + ' join your profile when you connect or refresh. Pick lower ones to add them now.',
        actions: [{ label: addLabelOf(g, addable), variant: 'secondary', attrs: addAttrs(g) }],
      });
    }
    if (addable.length) return waiting + quietLineHtml(g, addable);
    if (profile.length || waiting) return waiting;
    if (!listedOf(g).length) {
      return '<p class="gs-empty" data-status="empty">Battle.net lists no ' + esc(g.supportLabel) + ' characters for you. If you made one recently, log out of the game completely and connect again: Battle.net updates this list after a full log out.</p>';
    }
    return '<p class="gs-empty" data-status="nothing_to_add">None of the characters Battle.net lists for you can be added to this guild.</p>';
  }

  // The line an in-game guild carries (its characters come from Battle.net only) or, where somebody types a character in, "Find your character on the roster".
  function findHtml(g) { return g.battlenetOnly ? G.pages.thisIsMe.battlenetOnlyHtml(g.guildName) : G.pages.thisIsMe.blockHtml(g); }

  function guildSectionHtml(g, connected) {
    return '<section class="gs-chars-guild" id="chars-' + esc(g.guildId) + '" aria-label="' + esc(g.guildName) + '">' + guildHeadHtml(g) + findHtml(g) + cardsHtml(g) + statusBodyHtml(g, connected) + '</section>';
  }

  function sectionsHtml(guilds, connected) {
    return guilds.length ? '<div class="gs-chars-guilds">' + guilds.map(function (g) { return guildSectionHtml(g, connected); }).join('') + '</div>' : '';
  }

  // The words for the level cap a version has, for what Battle.net adds at once: "level 70", or "the level cap (70 in TBC Anniversary, 60 in Classic Era)" when the guilds differ.
  function capWords(guilds) {
    const seen = {};
    const caps = [];
    guilds.forEach(function (g) {
      if (g.status === 'unsupported' || !g.maxLevel || seen[g.maxLevel + '|' + g.supportLabel]) return;
      seen[g.maxLevel + '|' + g.supportLabel] = true;
      caps.push({ level: g.maxLevel, label: g.supportLabel });
    });
    if (!caps.length) return 'the level cap';
    if (caps.every(function (c) { return c.level === caps[0].level; })) return 'level ' + caps[0].level;
    return 'the level cap (' + caps.map(function (c) { return c.level + ' in ' + c.label; }).join(', ') + ')';
  }

  // What the page says when Battle.net is not connected yet (board MC4). Somebody on a roster already is told what Battle.net adds, not to connect it to see what is there.
  function notConnectedHtml(data) {
    const guilds = Array.isArray(data.guilds) ? data.guilds : [];
    const on = guilds.filter(function (g) { return g.onRoster; });
    const off = guilds.filter(function (g) { return !g.onRoster; });
    const names = function (list) { return list.map(function (g) { return g.guildName; }).join(', '); };
    const cap = capWords(guilds);
    const rule = 'Characters at ' + cap + ' join your profile when you connect; you pick the lower ones.';
    if (on.length && !off.length) {
      return G.ui.emptyStateHtml({
        kind: 'first', icon: 'link', title: 'You are on the roster already',
        text: 'You are on the roster of ' + names(on) + ', so you do not need Battle.net to raid there. Adding it brings your other characters (alts) onto your profile: those at ' + cap + ' join when you connect, you pick the lower ones. It also gives you a second way to sign in.',
        actions: [{ label: 'Add Battle.net', variant: 'secondary', href: CONNECT_HREF, icon: 'link', attrs: { 'data-key': 'bnet-connect' } }],
      });
    }
    if (on.length) {
      return G.ui.emptyStateHtml({
        kind: 'first', icon: 'link', title: 'Find your characters with Battle.net',
        text: 'You are on the roster of ' + names(on) + '. In ' + names(off) + ', Battle.net finds your characters: those at ' + cap + ' join your profile when you connect, you pick the lower ones. For ' + names(on) + ' it brings your other characters (alts) and a second way to sign in.',
        actions: [{ label: 'Connect Battle.net', href: CONNECT_HREF, icon: 'link', attrs: { 'data-key': 'bnet-connect' } }],
      });
    }
    return G.ui.emptyStateHtml({
      kind: 'first', icon: 'link', title: 'Connect Battle.net to see your characters',
      text: 'Raidsmith lists the characters on your Battle.net account for each of your guilds. ' + rule,
      actions: [{ label: 'Connect Battle.net', href: CONNECT_HREF, icon: 'link', attrs: { 'data-key': 'bnet-connect' } }],
    });
  }

  // The one Battle.net line of the page, at its foot: where the list came from, and the one way to load it again.
  function footHtml(link) {
    const again = '<a class="gs-fg-u" href="' + esc(CONNECT_HREF) + '" data-key="bnet-reconnect">' + (link.expired ? 'Load from Battle.net' : 'Refresh from Battle.net') + '</a>';
    return '<p class="gs-fine gs-chars-foot" id="chars-foot">' + (link.expired
      ? 'Battle.net is connected as ' + esc(link.battletag) + '; the list was deleted after 30 days. ' + again
      : 'From Battle.net as ' + esc(link.battletag) + ', loaded ' + esc(shortDate(link.fetchedAt)) + '. ' + again) + '</p>';
  }

  // opts: { data (GET /auth/bnet or null), notice, alert }
  function charactersHtml(opts) {
    const o = opts || {};
    const data = o.data;
    let body;
    if (!data) body = G.pages.signin.loadingHtml();
    else {
      const guilds = Array.isArray(data.guilds) ? data.guilds : [];
      if (!data.configured) body = '<p class="gs-warn" id="bnet-not-set-up" role="status">' + esc(NOT_SET_UP) + '</p>' + sectionsHtml(guilds, false);
      else if (!data.link) body = sectionsHtml(guilds, false) + notConnectedHtml(data);
      else if (!guilds.length) body = G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: 'You are not in a Raidsmith guild yet', text: 'There is nothing to add a character to until you are in a guild.' });
      else body = sectionsHtml(guilds, true) + footHtml(data.link);
    }
    return G.ui.listPageHtml({
      head: { title: 'My characters', contextHtml: 'From Battle.net, for your guilds. <a href="' + esc(G.router.format({ name: 'linked' })) + '">Linked accounts</a>' },
      pageClass: 'gs-forge gs-chars-page',
      noticesHtml: noticeHtml(o.notice) + G.ui.alertHtml(o.alert || '', 'gs-page-alert'),
      bodyHtml: body,
    });
  }

  // ── Add below the cap (board MC2): one list of the Battle.net characters to add, a box each ──
  function addLabel(n) { return n > 0 ? 'Add ' + plural(n, 'character', 'characters') : 'Add characters'; }

  function pickRowHtml(g, c) {
    const sub = G.ui.className(c.class) + (c.claim && c.claim.status === 'rejected' ? ' \u00b7 An officer turned this down before' : '');
    return '<li><label class="gs-tr-row"><input type="checkbox" class="gs-chars-chk" name="pick" value="' + esc(c.realmSlug + '|' + c.name) + '" data-name="' + esc(c.name) + '" data-realm="' + esc(c.realmSlug) + '" data-change="chars-pick">' +
      G.ui.specIconHtml(c.class, null, 20) + '<span class="gs-tr-id"><span>' + G.ui.classNameHtml(c.name, c.class) + '</span><span class="gs-tr-sub">' + esc(sub) + '</span></span>' +
      '<span class="gs-chars-picklvl">' + (typeof c.level === 'number' ? 'Level ' + esc(c.level) : 'Level unknown') + '</span></label></li>';
  }

  function addDialogHtml(g) {
    const list = addableOf(g);
    const below = allBelowMax(g, list);
    return G.ui.dialogHtml({
      kind: 'form', title: below ? 'Add characters below ' + g.maxLevel : 'Add characters from Battle.net', className: 'gs-forge',
      text: below ? 'Characters at level ' + g.maxLevel + ' join your profile by themselves. Tick the lower ones you want on it.' : 'Tick the characters you want on your profile.',
      bodyHtml: '<ul class="gs-tr-pick gs-chars-pick" aria-label="' + esc(below ? 'Characters below ' + g.maxLevel : 'Characters to add') + '">' + list.map(function (c) { return pickRowHtml(g, c); }).join('') + '</ul>',
      primary: { label: addLabel(0), attrs: { 'data-key': 'chars-add-submit' } },
      formAttrs: { 'data-submit': 'chars-add-form', 'data-gid': g.guildId },
    });
  }

  // What the page says after the Add dialog: one line per kind of answer (an officer decides the conflicts; a change under the request is tried again).
  function addedNotice(claims) {
    const list = Array.isArray(claims) ? claims : [];
    if (list.length === 1) return claimNotice(list[0].name, list[0]);
    const done = list.filter(function (r) { return r && r.status === 'applied'; }).length;
    const waiting = list.filter(function (r) { return r && r.status === 'pending'; }).length;
    const failed = list.filter(function (r) { return r && r.status === 'failed'; }).length;
    const parts = [];
    if (done) parts.push('Added ' + plural(done, 'character', 'characters') + ' to your profile.');
    if (waiting) parts.push(plural(waiting, 'character is', 'characters are') + ' held by someone else, so an officer has to decide. Nothing changes until one does.');
    if (failed) parts.push(plural(failed, 'character', 'characters') + ' changed while you were adding. Try again.');
    return parts.join(' ');
  }

  // ── data and behaviour ──
  // GET /auth/bnet into app state; rejects with the ApiError (the route's catch shows it).
  // The teams of each guild that has a character able to ask for one (GET /api/guild/:gid, kept in app state): the Request team button needs them. Never rejects.
  function loadTeams(data) {
    const fetchGuild = G.app && G.app.fetchGuild;
    const guilds = data && Array.isArray(data.guilds) ? data.guilds : [];
    if (!fetchGuild) return Promise.resolve(null);
    const wanted = guilds.filter(function (g) { return !guildData(g.guildId) && profileOf(g).some(function (c) { return !(c.team && c.team.id) && !c.request; }); });
    return Promise.all(wanted.map(function (g) {
      return Promise.resolve().then(function () { return fetchGuild(g.guildId); }).then(null, function () { /* the Request team button stays away */ });
    })).then(function () { return null; });
  }

  function load() {
    const s = st();
    const notice = flashNotice;
    flashNotice = '';
    s.bnet = { data: null, notice: notice, alert: '' };
    return G.api.get('/auth/bnet').then(function (data) {
      s.bnet = { data: data, notice: notice, alert: '' };
      return loadTeams(data).then(function () { return data; });
    });
  }

  function reload(notice) {
    const s = st();
    return G.api.get('/auth/bnet').then(function (data) {
      s.bnet = { data: data, notice: notice || '', alert: '' };
      return loadTeams(data).then(function () { G.app.render(); });
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

  // What the page says after POST /claims (board 7): the result is one of added (at once, Battle.net being proof), linked (a roster entry nobody had linked is theirs
  // now), needs an officer (a conflict), or changed (the roster moved under it).
  const CONFLICT_WHERE = { other_person: 'on a different roster entry than yours', hand_added: 'on someone else\'s record' };
  function claimNotice(name, r) {
    if (r && r.status === 'pending') return name + ' is ' + (Object.prototype.hasOwnProperty.call(CONFLICT_WHERE, r.reason) ? CONFLICT_WHERE[r.reason] : 'on another account') + ', so an officer has to decide. Nothing changes until one does.';
    if (r && r.status === 'failed') return name + ' changed while you were adding it. Try again.';
    return r && r.outcome === 'link_person' ? 'Added ' + name + '. It was on the roster already and is linked to you now.' : 'Added ' + name + ' to your characters.';
  }

  // The Add dialog (board MC2): the primary says how many are ticked; the picks go to POST /claims, ten to a request.
  G.handlers.click['chars-add-open'] = function (el) {
    const g = guildOf(el.getAttribute('data-gid'));
    if (!g || !addableOf(g).length) return;
    G.ui.openDialog(addDialogHtml(g), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.change['chars-pick'] = function (el) {
    const form = el && (el.form || (el.closest ? el.closest('form') : null));
    if (!form) return;
    const label = form.querySelector('[data-key="chars-add-submit"] span');
    if (label) label.textContent = addLabel(form.querySelectorAll('input[name="pick"]:checked').length);
  };

  // POST /claims for the picks, MAX_PER_REQUEST at a time, in order. -> the answers of every request; a request that fails after earlier ones worked ends the run with what was added.
  function postPicks(gid, picks) {
    const chunks = [];
    for (let i = 0; i < picks.length; i += MAX_PER_REQUEST) chunks.push(picks.slice(i, i + MAX_PER_REQUEST));
    const claims = [];
    return chunks.reduce(function (done, chunk) {
      return done.then(function (stop) {
        if (stop) return stop;
        return G.api.post('/api/guild/' + encodeURIComponent(gid) + '/claims', { characters: chunk }).then(function (res) {
          Array.prototype.push.apply(claims, res && Array.isArray(res.claims) ? res.claims : []);
          return null;
        }, function (err) {
          if (!claims.length) throw err;
          return err;
        });
      });
    }, Promise.resolve(null)).then(function (stopped) { return { claims: claims, stopped: stopped }; });
  }

  G.handlers.submit['chars-add-form'] = function (form) {
    const gid = form.getAttribute('data-gid');
    const boxes = Array.prototype.slice.call(form.querySelectorAll('input[name="pick"]:checked'));
    G.ui.setText('dlg-error', '');
    if (!boxes.length) { G.ui.setText('dlg-error', 'Tick at least one character.'); return; }
    const picks = boxes.map(function (box) { return { name: box.getAttribute('data-name'), realmSlug: box.getAttribute('data-realm') }; });
    G.ui.runDialog(form, postPicks(gid, picks), function (res) {
      const text = addedNotice(res.claims) + (res.stopped ? ' The rest did not go through: ' + G.api.classify(res.stopped).text : '');
      reload(text);
    });
  };

  // Request team (board MC3): the built dialog, sent from here (the built submit reads the person page's record).
  G.handlers.click['chars-request-open'] = function (el) {
    const g = guildOf(el.getAttribute('data-gid'));
    if (!g || !canAsk(g)) return;
    G.ui.openDialog(requestDialogHtml(g), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    const first = typeof document !== 'undefined' ? document.querySelector('.gs-tr-radio') : null;
    if (first && first.focus) first.focus();
  };

  G.handlers.submit['chars-request-form'] = function (form) {
    const gid = form.getAttribute('data-gid');
    const g = guildOf(gid);
    if (!g) return;
    const character = form.querySelector('input[name="characterId"]:checked');
    const team = form.querySelector('input[name="teamId"]:checked');
    G.ui.setText('dlg-error', '');
    G.ui.setText('dlg-err-characterId', '');
    G.ui.setText('dlg-err-teamId', '');
    if (!character) { G.ui.setText('dlg-err-characterId', 'Pick a character.'); return; }
    if (!team) { G.ui.setText('dlg-err-teamId', 'Pick a team.'); return; }
    const gd = guildData(gid);
    const picked = profileOf(g).filter(function (c) { return c.id === character.value; })[0];
    const named = gd && Array.isArray(gd.teams) ? gd.teams.filter(function (t) { return t.id === team.value; })[0] : null;
    G.ui.runDialog(form, G.api.post('/api/guild/' + encodeURIComponent(gid) + '/team-requests', { characterId: character.value, teamId: team.value }), function () {
      reload('Asked for ' + (named ? named.name : 'the team') + ' for ' + (picked ? picked.name : 'your character') + '. A Team Lead decides; you can withdraw the request until then.');
    });
  };

  G.handlers.click['bnet-withdraw'] = function (el) {
    if (el.disabled) return;
    const name = el.getAttribute('data-name');
    el.disabled = true;
    G.api.del('/api/guild/' + encodeURIComponent(el.getAttribute('data-gid')) + '/claims/' + encodeURIComponent(el.getAttribute('data-claim')), {}).then(function () {
      return reload('Request for ' + name + ' withdrawn.');
    }, function (err) { el.disabled = false; fail(err); });
  };

  G.handlers.click['bnet-disconnect-open'] = function () {
    G.ui.openDialog(disconnectDialogHtml(), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  const BNET_DISCONNECTED = 'Battle.net disconnected. Your BattleTag and character list are deleted.';
  G.handlers.submit['bnet-disconnect-form'] = function (form) {
    // A protected account is asked to sign in again first (403 fresh_required, purpose identity_change): the dialog's second step.
    G.fresh.runDialog(form, G.api.del('/auth/bnet', {}), { act: { kind: 'bnet_unlink' }, stepLabel: 'Disconnect Battle.net - step 2 of 2', primaryLabel: 'Sign in and disconnect', returnTo: G.router.format({ name: 'linked' }) }, function () {
      // The account's sign-ins changed too (Discord may be its last one now), so /auth/me is read again with the page.
      G.pages.accounts.refresh(BNET_DISCONNECTED);
    });
  };

  // Repeats after the fresh sign-in (#/fresh?done=identity_change): the disconnect, then the Linked accounts page with its notice; or the connect, which is a page load.
  G.fresh.registerAct('bnet_unlink', function () {
    return G.api.del('/auth/bnet', {}).then(function () { setFlash(BNET_DISCONNECTED); return G.router.format({ name: 'linked' }); });
  });
  G.fresh.registerAct('bnet_link', function () { return Promise.resolve(CONNECT_HREF); });
  G.fresh.registerAct('discord_link', function () { return Promise.resolve(G.pages.accounts.CONNECT_DISCORD_HREF); });

  // The banner's button on #/linked?error=fresh_required: start the sign-in for the link the account was refused.
  G.handlers.click['identity-fresh-start'] = function (el) {
    if (el.disabled) return;
    const change = el.getAttribute('data-change');
    const provider = el.getAttribute('data-provider');
    if (!Object.prototype.hasOwnProperty.call(LINK_CHANGES, change)) return;
    el.disabled = true;
    G.ui.setText('fresh-start-error', '');
    G.fresh.start({ purpose: 'identity_change', params: { change: change }, provider: provider, act: { kind: LINK_CHANGES[change].kind }, returnTo: G.router.format({ name: 'linked' }) }).then(null, function (err) {
      el.disabled = false;
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      G.ui.setText('fresh-start-error', G.fresh.errorText(err, 'identity_change', 1));
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
    guildSectionHtml: guildSectionHtml,
    cardHtml: cardHtml,
    footHtml: footHtml,
    addDialogHtml: addDialogHtml,
    requestDialogHtml: requestDialogHtml,
    addedNotice: addedNotice,
    claimNotice: claimNotice,
    MAX_PER_REQUEST: MAX_PER_REQUEST,
    disconnectDialogHtml: disconnectDialogHtml,
    freshRequiredHtml: freshRequiredHtml,
    setFlash: setFlash,
    load: load,
    reload: reload,
    state: bnetState,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
