// ── PAGE: #/fresh (where the fresh sign-in comes back to; lane B8a-base, board O3) ──
// The Worker's callbacks (worker/routes/auth.js, worker/routes/bnet.js) end every fresh sign-in at a FIXED address: #/fresh?done=<purpose> or #/fresh?error=<reason>[&purpose=<purpose>].
// A form-page card with one banner and the way on:
//   done=gm_claim          the claim's own answer (the callback already ran the claim): "You are the Owner of <guild>", the way on is the guild's Home (and the review of what the
//                          previous Owner set up, while that is open)
//   done=<other purpose>   the grant is on the session. A pending act of that purpose younger than 15 minutes (fresh.js: saved when the step started the sign-in) is repeated at once with
//                          the function its page registered (Guild.fresh.registerAct): the page shows "signed in again" for the moment the act takes, then goes on to the address the act
//                          answers (a hash address is a route change that replaces this entry, so Back never repeats the act). No pending act, an old one or an act nobody registered:
//                          a plain done card with the way back.
//   error=<reason>         every reason the callbacks name has its sentence: not_gm, conflict (the claim), mismatch, provider and busy (the sign-in did not finish), state and
//                          denied (cancelled), not_configured; any other reason gets the default. The way on is Try again (the same sign-in again, from the pending act) or the page the person came from.
// The pending act is taken (cleared) the moment it is used.
(function (G) {
  'use strict';

  const FRESH_ROUTE_PREFIX = '#/fresh';
  const OWNER_SEAT = 'Owner seat';
  const CONFIRM = 'Confirm it is you';
  // The sign-in's own word for an account ("Battle.net account"), where the page knows which provider the sign-in used.
  const WHO = { bnet: 'Battle.net account', discord: 'Discord account' };

  // { route, rec (the pending act that belongs to this landing, or null), gd (the guild payload), previous (the previous Owner's name), card, running (the repeat's promise) }
  let view = null;

  function st() { return G.app.state; }

  function providerOf(rec, purpose) {
    if (rec && rec.provider) return rec.provider;
    const spec = purpose && G.fresh.PURPOSES[purpose] ? G.fresh.PURPOSES[purpose] : null;
    return spec && spec.providers.length === 1 ? spec.providers[0] : null;
  }

  // The act that belongs to this landing: the saved one when its purpose is the one the address names (an error without a purpose takes whatever was saved).
  function recordFor(route) {
    const rec = G.fresh.pending();
    if (!rec) return null;
    const purpose = route.done || route.purpose;
    return purpose && rec.purpose !== purpose ? null : rec;
  }

  const HOME = '#/';
  // Where the person came from, when it is an app route (never this page, never anything else a stored value could name).
  function returnOf(rec) {
    return rec && typeof rec.returnTo === 'string' && /^#\/./.test(rec.returnTo) && rec.returnTo.indexOf(FRESH_ROUTE_PREFIX) !== 0 ? rec.returnTo : '';
  }
  function homeHref(gid) { return gid ? G.router.format({ name: 'section', gid: gid, section: 'home' }) : HOME; }

  // "Back to Linked accounts": the name of the page the person came from, from its address.
  function backLabel(hash) {
    const r = G.router.parse(hash);
    if (r.name === 'linked') return 'Back to Linked accounts';
    if (r.name === 'settings') return 'Back to Guild settings';
    if (r.name === 'setup') return 'Back to Guild setup';
    if (r.name === 'users' || r.name === 'user') return 'Back to Users';
    if (r.name === 'person') return 'Back to Roster';
    if (r.name === 'section') return 'Back to ' + ({ home: 'Home', roster: 'Roster', raids: 'Raids', attendance: 'Attendance', loot: 'Loot' }[r.section] || 'Home');
    return 'Go back';
  }

  // The buttons a card can end in. m: { gid, guildName, rec }
  function waysOn(m) {
    const open = m.guildName ? { label: 'Open ' + m.guildName, href: homeHref(m.gid) } : { label: 'Open Home', href: HOME };
    const back = returnOf(m.rec) ? { label: backLabel(returnOf(m.rec)), href: returnOf(m.rec) } : open;
    const retry = m.rec ? { label: 'Try again', attrs: { 'data-action': 'fresh-retry', 'data-key': 'fresh-retry' } } : open;
    return { open: open, back: back, retry: retry };
  }

  // The answer to a refused sign-in: { title, tone, bannerTitle, text, actions }.
  function errorCard(route, m) {
    const way = waysOn(m);
    const provider = providerOf(m.rec, route.purpose);
    const account = provider ? WHO[provider] : 'account';
    const named = provider ? G.fresh.PROVIDER_LABEL[provider] : 'The sign-in provider';
    const guild = m.guildName || 'the guild';
    const title = route.purpose === 'gm_claim' || route.error === 'not_gm' || route.error === 'conflict' ? OWNER_SEAT : CONFIRM;
    const warn = function (bannerTitle, text, actions) { return { title: title, tone: 'warning', bannerTitle: bannerTitle, text: text, actions: actions }; };
    switch (route.error) {
      case 'not_gm':
        return warn('This Battle.net account is not the Guild Master of ' + guild + '.', 'Only the character at rank 0 of the guild roster can take the Owner seat.', [way.open]);
      case 'conflict':
        return warn('The guild changed while you were signing in.', 'Nothing was changed. ' + (m.guildName ? 'Open ' + m.guildName : 'Open Home') + ' and try again.', [way.open]);
      case 'mismatch':
        return warn('That is not the ' + account + ' linked here.', 'Sign in with the ' + account + ' linked to your Raidsmith account.', [way.retry]);
      case 'provider':
      case 'busy':
        return warn('The sign-in did not finish.', named + ' did not answer, or there were too many sign-ins at once. Try again in a minute.', [way.retry]);
      case 'state':
      case 'denied':
        return warn('The sign-in was cancelled.', 'The link expired, was used already, or you did not allow Raidsmith to read your ' + account + '. Start again.', [way.retry]);
      case 'not_configured':
        return warn('Sign-in is not set up on this server.', named + ' sign-in is not available here. Ask the person who runs this server.', [way.back]);
      default:
        return warn('The sign-in did not work.', 'Raidsmith could not confirm it is you. Go back and try again.', [way.back]);
    }
  }

  // The claim's answer. m.reviewOpen: the review of what the previous Owner set up is still waiting (GET /api/guild/:gid owner.reviewOpen); m.previous: that Owner's name when known.
  function claimCard(m) {
    const way = waysOn(m);
    const actions = [];
    if (m.reviewOpen && m.gid) {
      actions.push({ label: m.previous ? 'Review what ' + m.previous + ' set up' : 'Review what was set up', href: G.router.format({ name: 'settings', gid: m.gid, tab: 'claimreview' }) });
    }
    actions.push(way.open);
    return {
      title: OWNER_SEAT, tone: 'success', bannerTitle: 'You are the Owner' + (m.guildName ? ' of ' + m.guildName : '') + '.',
      text: (m.previous ? m.previous + ' held the seat before you. What they set up' : 'What the previous Owner set up') + ' stays live; look it over when you are ready.', actions: actions,
    };
  }

  function workingCard() {
    return { title: CONFIRM, tone: 'info', bannerTitle: 'You are signed in again.', text: 'Finishing what you started...', actions: [] };
  }

  // A done with nothing to repeat: the way back (an old pending act is said to be too old).
  function plainDoneCard(m, tooOld) {
    return {
      title: CONFIRM, tone: 'success', bannerTitle: 'You are signed in again.',
      text: tooOld ? 'It was started too long ago to repeat on its own. Go back and start it again.' : 'Go back and repeat what you were doing. The confirmation lasts 15 minutes.', actions: [waysOn(m).back],
    };
  }

  function failedCard(m, err) {
    const text = G.fresh.isRequired(err) ? 'The sign-in did not count for this. Go back and try again.' : G.api.classify(err).text;
    return { title: CONFIRM, tone: 'warning', bannerTitle: G.fresh.isRequired(err) ? 'The sign-in did not count.' : 'That did not go through.', text: text, actions: [waysOn(m).back] };
  }

  function pageHtml(card) {
    return '<div class="gs-page gs-form-page gs-forge gs-fresh-page">' + G.ui.pageHeadHtml({ title: card.title }) +
      G.ui.bannerHtml({ tone: card.tone, title: card.bannerTitle, text: card.text, actions: card.actions, dismissible: false }) +
      '<p class="gs-alert" id="fresh-error" role="alert" hidden></p></div>';
  }

  function stillHere() {
    try { return typeof window !== 'undefined' && String(window.location.hash || '').indexOf(FRESH_ROUTE_PREFIX) === 0; } catch (e) { return false; }
  }

  // The act answered: on to its address. A hash address is a route (this entry is replaced, so Back does not repeat the act); anything else is a page load.
  function goOn(rec, address) {
    if (!stillHere()) return;
    const to = address || returnOf(rec) || HOME;
    if (to.charAt(0) === '#') G.app.go(to, true);
    else G.fresh.navigate(to);
  }

  function repeatNow(v, rec) {
    v.running = G.fresh.repeat(rec).then(function (address) {
      goOn(rec, address);
    }, function (err) {
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      if (view !== v) return;
      v.card = failedCard({ gid: rec.gid, guildName: guildNameOf(v), rec: rec }, err);
      G.app.render();
    });
    return v.running;
  }

  function guildNameOf(v) { return v && v.gd && v.gd.guild ? v.gd.guild.name : ''; }
  function modelOf(v) { return { gid: v.rec ? v.rec.gid : null, guildName: guildNameOf(v), rec: v.rec }; }

  // The route's read. The guild the act belonged to is read again (its name, and for a claim whether the review is open) and becomes the guild the nav shows.
  function load(route) {
    const v = view = { route: route, rec: recordFor(route), gd: null, previous: '', card: null, running: null };
    const s = st();
    const gid = v.rec ? v.rec.gid : null;
    if (gid && s.me && Array.isArray(s.me.guilds) && s.me.guilds.some(function (g) { return g.id === gid; })) s.lastGid = gid;
    const guildRead = gid ? G.app.fetchGuild(gid).then(function (gd) { v.gd = gd; }, function () { /* the card says "Home" instead of the guild's name */ }) : Promise.resolve();
    return guildRead.then(function () {
      if (view !== v) return null;
      if (!route.done) {
        v.card = route.error ? errorCard(route, modelOf(v)) : { title: CONFIRM, tone: 'info', bannerTitle: 'Nothing to confirm.', text: 'This is where a sign-in that confirms an action comes back to.', actions: [waysOn(modelOf(v)).open] };
        return null;
      }
      if (route.done === 'gm_claim') return landClaim(v);
      if (!v.rec) { v.card = plainDoneCard(modelOf(v), false); return null; }
      const rec = v.rec;
      G.fresh.clearPending();
      if (!G.fresh.isFreshEnough(rec)) { v.card = plainDoneCard(modelOf(v), true); return null; }
      if (!G.fresh.hasAct(rec.kind)) { v.card = plainDoneCard(modelOf(v), false); return null; }
      v.card = workingCard();
      repeatNow(v, rec);
      return null;
    });
  }

  // The claim ran inside the callback: nothing to repeat. The previous Owner's name comes from the claim review, read only while that review is open (the Owner's own call).
  function landClaim(v) {
    if (v.rec) G.fresh.clearPending();
    const gid = v.rec ? v.rec.gid : null;
    const reviewOpen = !!(v.gd && v.gd.owner && v.gd.owner.reviewOpen);
    const finish = function () { v.card = claimCard({ gid: gid, guildName: guildNameOf(v), rec: v.rec, reviewOpen: reviewOpen, previous: v.previous }); return null; };
    if (!gid || !reviewOpen) return finish();
    return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/claim-review').then(function (res) {
      const prev = res && res.claim && res.claim.previousOwner ? res.claim.previousOwner.name : '';
      v.previous = typeof prev === 'string' ? prev : '';
    }, function () { /* the card says "the previous Owner" */ }).then(finish);
  }

  function main() {
    if (!view || !view.card) return G.pages.signin.loadingHtml();
    return pageHtml(view.card);
  }

  // Try again: the same sign-in from the pending act (it is still saved on an error landing).
  G.handlers.click['fresh-retry'] = function (el) {
    const rec = view ? view.rec : null;
    if (!rec || (el && el.disabled)) return;
    if (el) el.disabled = true;
    G.ui.setText('fresh-error', '');
    G.fresh.start({ gid: rec.gid, purpose: rec.purpose, params: rec.params, provider: rec.provider, act: { kind: rec.kind, data: rec.data }, returnTo: rec.returnTo }).then(null, function (err) {
      if (el) el.disabled = false;
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      G.ui.setText('fresh-error', G.fresh.errorText(err, rec.purpose));
    });
  };

  // The page head's name for the breadcrumb (shell.js): what the card is about.
  function titleOf(route) {
    if (view && view.route === route && view.card) return view.card.title;
    return route && (route.purpose === 'gm_claim' || route.done === 'gm_claim' || route.error === 'not_gm' || route.error === 'conflict') ? OWNER_SEAT : CONFIRM;
  }

  G.pages.fresh = {
    load: load,
    main: main,
    titleOf: titleOf,
    errorCard: errorCard,
    claimCard: claimCard,
    plainDoneCard: plainDoneCard,
    failedCard: failedCard,
    pageHtml: pageHtml,
    view: function () { return view; },
    reset: function () { view = null; },
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
