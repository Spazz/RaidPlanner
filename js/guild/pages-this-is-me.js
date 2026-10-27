// ── THIS IS ME (user-hierarchy build, lane B3 UI; boards 9, 9b and 8c of the 2026-10-26 mockup, decision 8) ─────────────────────────────────────────────────
// A member whose character is already on the roster (an officer or an import added it, nobody linked it) says "this one is mine". Battle.net would prove it, but
// a guild that is not in-game may have no Battle.net at all, so the claim goes to an officer.
//   Member (My characters, a block at the top of each guild card whose characters are not decided by Battle.net - also with Battle.net not connected):
//     "Find your character on the roster": type a name; GET /roster/unlinked?q= lists the matching roster records nobody has linked (name, class, spec, team);
//     This is me on one POSTs /me/characters with that name, which makes a pending claim (a typed name never links an account by itself). The row then moves to
//     "Waiting for an officer" with Withdraw (DELETE /claims/:id). A name no record has offers a new character (class + Add character, applied at once, as before).
//     The outcome is the row changing - there is no message when an officer decides (decision 9, the same rule as team requests).
//   Officer (Home's Guild panel): each pending claim that links a roster record to an account is a to-do, "<account> says <character> is theirs", with Approve /
//     Reject (POST /claims/:clid/approve with expectedKind link_person, or /reject). The count is on Home only, never on the Attendance badge.
// Pure parts: blockHtml, resultsHtml, matchRowHtml, askRowHtml, asksOf, noticeSent. State (app state att.thisIsMe): per guild { query, status, matches, more, waiting, error }.
(function (G) {
  'use strict';

  const SEARCH_PAUSE_MS = 350;
  const MIN_CHARS = 2;
  const HELP = 'Characters on the roster that nobody has linked yet. An officer confirms it is you.';
  const timers = {};
  const hooks = {};
  let searchSeq = 0;

  function st() { return G.app.state; }
  function slot(name) {
    const s = st();
    if (!s.att) s.att = {};
    if (!s.att[name]) s.att[name] = {};
    return s.att[name];
  }
  function stateOf(gid) {
    const all = slot('thisIsMe');
    if (!all[gid]) all[gid] = { query: '', status: 'idle', matches: [], more: false, waiting: [], error: '' };
    return all[gid];
  }
  function base(gid) { return '/api/guild/' + encodeURIComponent(gid); }
  function foldName(s) { return String(s == null ? '' : s).normalize('NFC').toLowerCase(); }
  function typedOf(s) { return String(s && s.query ? s.query : '').trim(); }

  // What the page says after a claim was sent / a character was added (the row changing is the only answer to a decision).
  function noticeSent(name) { return name + ' is on the roster and nobody has linked it, so an officer has to confirm it is yours. Nothing changes until one does.'; }
  function noticeAdded(name) { return 'Added ' + name + ' to your characters.'; }

  // ── the member's block ──
  function subOf(m) {
    const spec = (m.mainSpec ? m.mainSpec + ' ' : '') + G.ui.className(m.class);
    return spec + (m.team && m.team.name ? ' - ' + m.team.name : '');
  }

  // One roster record: spec icon, name in the class colour, "Frost Mage - Team KJ", and its action (This is me, or the waiting chip + Withdraw).
  function matchRowHtml(m, gid, mode) {
    const end = mode === 'waiting'
      ? G.ui.chipHtml({ tone: 'warning', label: 'Needs an officer', icon: 'clock' }) +
        G.ui.buttonHtml({ label: 'Withdraw', size: 'sm', ariaLabel: 'Withdraw the request for ' + m.name, attrs: { 'data-action': 'tim-withdraw', 'data-gid': gid, 'data-claim': m.id, 'data-name': m.name, 'data-key': 'tim-withdraw-' + gid + '-' + m.id } })
      : G.ui.buttonHtml({ label: 'This is me', size: 'sm', ariaLabel: 'This is me: ' + m.name,
        attrs: { 'data-action': 'tim-claim', 'data-gid': gid, 'data-name': m.name, 'data-class': m.class, 'data-spec': m.mainSpec || '', 'data-realm': m.realm || '', 'data-key': 'tim-claim-' + gid + '-' + foldName(m.name) } });
    return '<li class="gs-tim-row">' + G.ui.specIconHtml(m.class, m.mainSpec, 20) + '<span class="gs-tim-id">' + G.ui.classNameHtml(m.name, m.class) +
      '<span class="gs-tim-sub">' + esc(subOf(m)) + '</span></span><span class="gs-tim-end">' + end + '</span></li>';
  }

  // The results under the field: the matching records, or (no record has that name) a new character; nothing before two letters are typed.
  function resultsHtml(gid, s) {
    const q = typedOf(s);
    if (Array.from(q).length < MIN_CHARS) return '';
    if (s.status === 'loading') return '<p class="gs-fine gs-tim-status">Looking...</p>';
    if (s.status === 'error') return '';
    const matches = Array.isArray(s.matches) ? s.matches : [];
    if (matches.length) {
      return '<ul class="gs-tim-list" aria-label="Characters on the roster that nobody has linked">' + matches.map(function (m) { return matchRowHtml(m, gid, 'claim'); }).join('') + '</ul>' +
        (s.more ? '<p class="gs-fine">There are more. Type more of the name.</p>' : '');
    }
    if (s.status !== 'ready') return '';
    // A name that already waits for an officer is not "nobody": the Waiting list above shows it.
    const waits = (s.waiting || []).some(function (w) { return foldName(w.name) === foldName(q); });
    if (waits) return '';
    return '<p class="gs-tim-nomatch">Nobody on the roster by that name. Add it as a new character:</p><div class="gs-tim-addnew">' +
      G.ui.fieldHtml({ id: 'tim-class-' + gid, name: 'class', label: 'Class', kind: 'select', value: '', options: G.ui.classChoices(G.ui.rosterOptions(null), 'Choose a class') }) +
      '<div class="gs-tim-addnew-act">' + G.ui.buttonHtml({ label: 'Add character', attrs: { 'data-action': 'tim-add', 'data-gid': gid, 'data-key': 'tim-add-' + gid } }) + '</div></div>';
  }

  // The "Find your character on the roster" block of one guild card (g: that guild of GET /auth/bnet).
  function blockHtml(g) {
    const gid = g.guildId;
    const s = stateOf(gid);
    const waiting = Array.isArray(s.waiting) && s.waiting.length
      ? '<h3 class="gs-tim-h">Waiting for an officer</h3><ul class="gs-tim-list" aria-label="Waiting for an officer">' + s.waiting.map(function (w) { return matchRowHtml(w, gid, 'waiting'); }).join('') + '</ul>' : '';
    const field = '<form class="gs-tim-form" data-submit="tim-search" data-gid="' + esc(gid) + '" novalidate>' +
      G.ui.fieldHtml({ id: 'tim-name-' + gid, name: 'name', label: 'Character name', kind: 'text', value: s.query || '', autocomplete: 'off', maxlength: 40, help: HELP,
        attrs: { 'data-input': 'tim-search', 'data-gid': gid, enterkeyhint: 'search' } }) + '</form>';
    return '<section class="gs-tim" aria-label="Find your character on the roster" data-gid="' + esc(gid) + '">' + waiting + '<h3 class="gs-tim-h">Find your character on the roster</h3>' + field +
      '<p class="gs-alert" id="tim-error-' + esc(gid) + '" role="alert"' + (s.error ? '' : ' hidden') + '>' + esc(s.error || '') + '</p>' +
      '<div class="gs-tim-results" id="tim-results-' + esc(gid) + '" aria-live="polite">' + resultsHtml(gid, s) + '</div></section>';
  }

  // The line an in-game guild's card carries instead of the block: its characters come from Battle.net only.
  function battlenetOnlyHtml(guildName) {
    return '<p class="gs-fine gs-tim-ingame">' + esc(guildName) + ' adds characters from Battle.net only.</p>';
  }

  // ── the officer's to-do rows ──
  // Pending claims an officer can approve with one click: the character sits on a roster record nobody linked, and the claimant has no person yet.
  function asksOf(claims) {
    return (Array.isArray(claims) ? claims : []).filter(function (c) { return c && c.plan && c.plan.kind === 'link_person' && c.plan.canDecide; });
  }

  // opts: { gd, withTeam, now, prefix (keeps data-key unique where Home draws the row twice: desktop and phone) }
  function askRowHtml(claim, opts) {
    const o = opts || {};
    const gid = o.gd && o.gd.guild ? o.gd.guild.id : '';
    const c = claim.character || {};
    const record = (claim.plan && claim.plan.record) || {};
    const who = claim.claimant && claim.claimant.displayName ? claim.claimant.displayName : 'Someone';
    const team = record.team && record.team.name ? record.team.name : '';
    const statusWord = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve' }[record.status] || '';
    const spec = (record.mainSpec ? record.mainSpec + ' ' : '') + G.ui.className(c.class) + (statusWord ? ' - ' + statusWord : '');
    const ago = claim.claimedAt ? G.ui.agoText(claim.claimedAt, o.now) : '';
    const attrs = function (verb) { return { 'data-action': 'this-is-me-' + verb, 'data-claim': claim.id, 'data-gid': gid, 'data-key': 'tim-' + verb + '-' + (o.prefix || '') + claim.id }; };
    return '<li class="gs-hd-todo gs-tr-ask" data-claim="' + esc(claim.id) + '">' + (o.withTeam && team ? '<span class="gs-hd-todo-meta">' + esc(team) + '</span>' : '') +
      '<span class="gs-hd-todo-title gs-tr-t">' + G.ui.specIconHtml(c.class, record.mainSpec, 20) + '<span class="gs-tr-txt"><span class="gs-tr-lead"><span class="gs-tim-acct">' + esc(who) + '</span> says ' +
      G.ui.classNameHtml(c.name, c.class) + ' is theirs</span><span class="gs-tr-line">' + esc(spec) + '</span>' +
      '<span class="gs-tr-line">' + (ago ? esc(ago) + '. ' : '') + 'Approving links this record to ' + esc(who) + '\'s account.</span></span></span><div class="gs-hd-todo-acts">' +
      G.ui.buttonHtml({ label: 'Approve', size: 'sm', ariaLabel: 'Approve: ' + c.name + ' is ' + who + '\'s', attrs: attrs('approve') }) +
      G.ui.buttonHtml({ label: 'Reject', variant: 'ghost', size: 'sm', ariaLabel: 'Reject: ' + c.name + ' is ' + who + '\'s', attrs: attrs('reject') }) + '</div></li>';
  }

  function asksBlockHtml(asks, opts) {
    return asks.length ? '<h3 class="gs-hd-sl gs-hd-sl-sub gs-tr-hsl">This is me <span class="gs-fg-cnt">' + asks.length + '</span></h3><ul class="gs-hd-todos" aria-label="This is me">' +
      asks.map(function (c) { return askRowHtml(c, opts); }).join('') + '</ul>' : '';
  }

  // ── data ──
  // GET /roster/unlinked?q=: the records that match and the viewer's own waiting claims. Never rejects.
  function lookup(gid, q) {
    const s = stateOf(gid);
    const seq = ++searchSeq;
    s.seq = seq;
    return Promise.resolve().then(function () { return G.api.get(base(gid) + '/roster/unlinked' + (q ? '?q=' + encodeURIComponent(q) : '')); }).then(function (res) {
      if (s.seq !== seq) return s;
      s.matches = Array.isArray(res && res.matches) ? res.matches : [];
      s.more = !!(res && res.more);
      s.waiting = Array.isArray(res && res.waiting) ? res.waiting : [];
      s.status = 'ready';
      s.error = '';
      return s;
    }, function (err) {
      if (s.seq !== seq) return s;
      s.matches = [];
      s.status = 'error';
      const c = G.api.classify(err);
      // The read that opens the page (no name typed) fails quietly: the block still works. A search says why it failed, under the field.
      s.error = q && c.view !== 'signin' ? c.text : '';
      if (q && c.view === 'signin') G.app.requireSignin();
      return s;
    });
  }

  // The guilds of GET /auth/bnet that take a typed name: their waiting claims are read with the page. Nothing for an in-game guild.
  function loadFor(data) {
    const guilds = data && Array.isArray(data.guilds) ? data.guilds : [];
    return Promise.all(guilds.filter(function (g) { return !g.battlenetOnly; }).map(function (g) { return lookup(g.guildId, ''); }));
  }

  // GET /claims for an officer's Home: the pending claims, kept per guild (null when the read failed: Home then keeps its count line).
  function readAsks(gid) {
    return Promise.resolve().then(function () { return G.api.get(base(gid) + '/claims'); }).then(function (res) {
      const all = Array.isArray(res && res.claims) ? res.claims : [];
      slot('thisIsMeAsks')[gid] = { all: all, asks: asksOf(all) };
      return slot('thisIsMeAsks')[gid];
    }, function () {
      delete slot('thisIsMeAsks')[gid];
      return null;
    });
  }
  function asksFor(gid) { return slot('thisIsMeAsks')[gid] || null; }

  // ── behaviour: the member ──
  function paintResults(gid) {
    const host = typeof document !== 'undefined' && document.getElementById ? document.getElementById('tim-results-' + gid) : null;
    if (host) host.innerHTML = resultsHtml(gid, stateOf(gid));
    G.ui.setText('tim-error-' + gid, stateOf(gid).error);
  }

  function search(gid, value) {
    const s = stateOf(gid);
    s.query = String(value == null ? '' : value);
    clearTimeout(timers[gid]);
    const q = typedOf(s);
    s.error = '';
    if (Array.from(q).length < MIN_CHARS) { s.matches = []; s.status = 'idle'; s.seq = ++searchSeq; paintResults(gid); return null; }
    s.status = 'loading';
    paintResults(gid);
    return lookup(gid, q).then(function () { if (typedOf(stateOf(gid)) === q) paintResults(gid); });
  }

  G.handlers.input['tim-search'] = function (el) {
    const gid = el.getAttribute('data-gid');
    if (!gid) return;
    const s = stateOf(gid);
    s.query = el.value;
    clearTimeout(timers[gid]);
    timers[gid] = setTimeout(function () { search(gid, el.value); }, SEARCH_PAUSE_MS);
  };

  G.handlers.submit['tim-search'] = function (form) {
    const gid = form.getAttribute('data-gid');
    if (gid && form.elements && form.elements.name) search(gid, form.elements.name.value);
  };

  // A claim was sent or a character added: the waiting list and the Battle.net table are read again, and the page says what happened.
  function after(gid, notice) {
    const s = stateOf(gid);
    s.query = ''; s.matches = []; s.more = false; s.status = 'idle'; s.error = '';
    return lookup(gid, '').then(function () { return G.pages.bnet.reload(notice); });
  }

  function failBlock(gid, err) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return null; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return null; }
    const s = stateOf(gid);
    s.error = c.text;
    paintResults(gid);
    return null;
  }

  function addByHand(gid, body, el, done) {
    el.disabled = true;
    return G.api.post(base(gid) + '/me/characters', body).then(function (res) {
      const r = res && Array.isArray(res.claims) ? res.claims[0] : null;
      return after(gid, done(r));
    }, function (err) { el.disabled = false; return failBlock(gid, err); });
  }

  G.handlers.click['tim-claim'] = function (el) {
    if (el.disabled) return null;
    const gid = el.getAttribute('data-gid');
    const name = el.getAttribute('data-name');
    const body = { name: name, class: el.getAttribute('data-class') };
    if (el.getAttribute('data-spec')) body.mainSpec = el.getAttribute('data-spec');
    if (el.getAttribute('data-realm')) body.realm = el.getAttribute('data-realm');
    return addByHand(gid, body, el, function (r) { return r && r.status === 'applied' ? noticeAdded(name) : noticeSent(name); });
  };

  G.handlers.click['tim-add'] = function (el) {
    if (el.disabled) return null;
    const gid = el.getAttribute('data-gid');
    const s = stateOf(gid);
    const select = typeof document !== 'undefined' && document.getElementById ? document.getElementById('tim-class-' + gid) : null;
    const name = typedOf(s);
    if (!select || !select.value) { s.error = 'Choose the class of ' + (name || 'the character') + '.'; paintResults(gid); if (select && select.focus) select.focus(); return null; }
    return addByHand(gid, { name: name, class: select.value }, el, function (r) { return r && r.status === 'pending' ? noticeSent(name) : noticeAdded(name); });
  };

  G.handlers.click['tim-withdraw'] = function (el) {
    if (el.disabled) return null;
    const gid = el.getAttribute('data-gid');
    el.disabled = true;
    return G.api.del(base(gid) + '/claims/' + encodeURIComponent(el.getAttribute('data-claim')), {}).then(function () {
      return after(gid, '');
    }, function (err) { el.disabled = false; return failBlock(gid, err); });
  };

  // ── behaviour: the officer ──
  function setHooks(ctx, h) { hooks[ctx] = h; }

  function decide(el, verb) {
    const gid = el.getAttribute('data-gid') || st().currentGid;
    const id = el.getAttribute('data-claim');
    if (!gid || !id || el.disabled) return null;
    const known = asksFor(gid);
    const claim = known ? known.asks.filter(function (c) { return c.id === id; })[0] || null : null;
    const acts = el.closest ? el.closest('.gs-hd-todo-acts') : null;
    const buttons = acts && acts.querySelectorAll ? acts.querySelectorAll('button') : [el];
    for (let i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    const call = verb === 'approve'
      ? G.api.post(base(gid) + '/claims/' + encodeURIComponent(id) + '/approve', { expectedKind: 'link_person' })
      : G.api.post(base(gid) + '/claims/' + encodeURIComponent(id) + '/reject', {});
    return call.then(function (res) {
      G.app.applyFlags(gid, res);
      if (known) { known.all = known.all.filter(function (c) { return c.id !== id; }); known.asks = asksOf(known.all); }
      const h = hooks.home;
      if (h && h.done) h.done(gid, verb, claim); else G.app.render();
      return null;
    }, function (err) {
      for (let i = 0; i < buttons.length; i++) buttons[i].disabled = false;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return null; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return null; }
      return readAsks(gid).then(function () {
        const h = hooks.home;
        if (h && h.fail) h.fail(gid, c.text); else { st().pageAlert = c.text; G.app.render(); }
        return null;
      });
    });
  }

  G.handlers.click['this-is-me-approve'] = function (el) { return decide(el, 'approve'); };
  G.handlers.click['this-is-me-reject'] = function (el) { return decide(el, 'reject'); };

  G.pages.thisIsMe = {
    HELP: HELP,
    noticeSent: noticeSent,
    noticeAdded: noticeAdded,
    blockHtml: blockHtml,
    resultsHtml: resultsHtml,
    matchRowHtml: matchRowHtml,
    battlenetOnlyHtml: battlenetOnlyHtml,
    askRowHtml: askRowHtml,
    asksBlockHtml: asksBlockHtml,
    asksOf: asksOf,
    asksFor: asksFor,
    readAsks: readAsks,
    lookup: lookup,
    loadFor: loadFor,
    stateOf: stateOf,
    setHooks: setHooks,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
