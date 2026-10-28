// ── TEAM REQUESTS (user-hierarchy build, lane B3 UI; boards 1, 2, 4, 4b and 8a of the 2026-10-26 mockup, concept B) ──────────────────────────────────────────
// A person asks for one of their characters (on no team) to be put on a team; a Team Lead of that team, or an officer, decides. No message follows a decision:
// the requester sees their row change, nobody is told (user decision 4).
//   Requester (the person page, own record): the head's "Request team" button opens a dialog with the characters that can ask and the teams the person has no
//     character on (a team shows its name and "N people" only). A character with a request waiting says "Requested Team KJ" on its row, with Withdraw.
//     The button exists only while such a character AND such a team both exist (canRequest). The same team may be asked for twice (two teamless characters);
//     when one is approved the Worker withdraws the other, and that row is back to "No team".
//   Decider (Home's Guild panel and phone To do list, the Roster's Needs you panel, the top of the Roster's phone list): one row per request, Approve / Reject.
// GET /api/guild/:gid/team-requests -> { mine, pending, can: { decide } } is read per guild (read()) and kept in app state, att.teamRequests[gid]; the pages draw
// from it. Approve / Reject run here; the page that shows the row registers a hook (setHooks) for what happens next (Home re-reads its to-dos, the Roster its list).
(function (G) {
  'use strict';

  const REQUEST_TEXT = 'A Team Lead of the team decides. You can withdraw the request until then.';
  const DECIDED_TEXT = { approve: 'Approved', reject: 'Rejected' };
  const hooks = {};

  function st() { return G.app.state; }
  function slot() {
    const s = st();
    if (!s.att) s.att = {};
    if (!s.att.teamRequests) s.att.teamRequests = {};
    return s.att.teamRequests;
  }
  function url(gid, tail) { return '/api/guild/' + encodeURIComponent(gid) + '/team-requests' + (tail || ''); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function listOf(bucket, key) { return bucket && Array.isArray(bucket[key]) ? bucket[key] : []; }
  function bucketOf(gid) { return slot()[gid] || null; }
  function mineOf(gid) { return listOf(bucketOf(gid), 'mine'); }
  // The requests the viewer may decide, optionally of one team.
  function pendingOf(gid, teamId) {
    return listOf(bucketOf(gid), 'pending').filter(function (r) { return r && r.status === 'pending' && (!teamId || (r.team && r.team.id === teamId)); });
  }

  // The nav badge's request count per team (gd.teamRequestFlags) follows what was read, so the Roster badge is right without a second round trip.
  function syncFlags(gid, bucket) {
    const gd = st().guilds && st().guilds[gid];
    if (!gd || !gd.teamRequestFlags || !bucket || !bucket.can || !bucket.can.decide) return;
    const flags = Object.assign({}, gd.teamRequestFlags);
    Object.keys(flags).forEach(function (teamId) { flags[teamId] = 0; });
    listOf(bucket, 'pending').forEach(function (r) {
      if (r && r.team && Object.prototype.hasOwnProperty.call(flags, r.team.id)) flags[r.team.id]++;
    });
    gd.teamRequestFlags = flags;
  }

  // Reads the viewer's own requests and, for a decider, the pending ones. Never rejects: a page whose read failed shows what it can (the Home to-do falls back to
  // its count line). -> the kept bucket, or null.
  function read(gid) {
    return Promise.resolve().then(function () { return G.api.get(url(gid)); }).then(function (res) {
      const bucket = { mine: listOf(res, 'mine'), pending: listOf(res, 'pending'), can: { decide: !!(res && res.can && res.can.decide) } };
      slot()[gid] = bucket;
      syncFlags(gid, bucket);
      return bucket;
    }, function () {
      delete slot()[gid];
      return null;
    });
  }

  // ── the requester: person page ──
  function heldTeams(record) {
    const held = {};
    (record && Array.isArray(record.characters) ? record.characters : []).forEach(function (c) { if (c.team && c.team.id) held[c.team.id] = true; });
    return held;
  }

  // The request that shows on a character's row: open, for a character on no team, and for a team the person still has no character on.
  function requestFor(record, mine, characterId) {
    const held = heldTeams(record);
    const character = (record.characters || []).filter(function (c) { return c.id === characterId; })[0];
    if (!character || (character.team && character.team.id)) return null;
    return (Array.isArray(mine) ? mine : []).filter(function (r) {
      return r && r.status === 'pending' && r.character && r.character.id === characterId && r.team && !held[r.team.id];
    })[0] || null;
  }

  // Characters that can ask: on no team and with no request waiting.
  function askers(record, mine) {
    return (record.characters || []).filter(function (c) { return !(c.team && c.team.id) && !requestFor(record, mine, c.id); });
  }

  // Teams that can be asked for: active ones the person has no character on (one character per person per team).
  function freeTeams(gd, record) {
    const held = heldTeams(record);
    return G.shell.activeTeams(gd && gd.teams).filter(function (t) { return !held[t.id]; });
  }

  // The button exists only while a character that can ask and a team to ask for both exist (decision 2).
  function canRequest(gd, record, mine) {
    return !!(record && record.person && record.person.isMe) && askers(record, mine).length > 0 && freeTeams(gd, record).length > 0;
  }

  function headButtonHtml() {
    return G.ui.buttonHtml({ label: 'Request team', ariaLabel: 'Request a team for one of your characters', attrs: { 'data-action': 'team-request-open', 'data-key': 'team-request-open' } });
  }

  // What a character's row says instead of a team: "No team", or "Requested Team KJ" (the request waits; Withdraw sits at the row's end).
  function rowStatusHtml(request) {
    return request ? '<span class="gs-tr-now">Requested ' + esc(request.team.name) + '</span>' : 'No team';
  }
  function withdrawHtml(request, character) {
    return G.ui.buttonHtml({ label: 'Withdraw', variant: 'ghost', size: 'sm', ariaLabel: 'Withdraw the request for ' + character.name,
      attrs: { 'data-action': 'team-request-withdraw', 'data-trid': request.id, 'data-key': 'team-request-withdraw-' + character.id } });
  }

  function pickRowHtml(opts) {
    return '<li><label class="gs-tr-row"><input type="radio" class="gs-tr-radio" name="' + opts.name + '" value="' + esc(opts.value) + '" data-field="' + opts.name + '"' + (opts.checked ? ' checked' : '') + '>' +
      (opts.iconHtml || '') + '<span class="gs-tr-id"><span>' + opts.titleHtml + '</span><span class="gs-tr-sub">' + esc(opts.sub) + '</span></span></label></li>';
  }

  // The Request team dialog: a character (teamless, no request waiting) and a team (name and people only). The first of each is picked.
  // firstId (the Character page): that character leads the list, so it is the one picked; the others follow in their own order.
  function dialogHtml(gd, record, mine, firstId) {
    const chars = askers(record, mine).sort(function (a, b) { return (b.id === firstId) - (a.id === firstId); });
    const teams = freeTeams(gd, record);
    const characterRows = chars.map(function (c, i) {
      return pickRowHtml({ name: 'characterId', value: c.id, checked: i === 0, iconHtml: G.ui.specIconHtml(c.class, c.mainSpec, 20), titleHtml: G.ui.classNameHtml(c.name, c.class),
        sub: (c.mainSpec ? c.mainSpec + ' ' : '') + G.ui.className(c.class) });
    }).join('');
    const teamRows = teams.map(function (t, i) {
      const n = Math.max(0, Math.floor(Number(t.players) || 0));
      return pickRowHtml({ name: 'teamId', value: t.id, checked: i === 0, titleHtml: esc(t.name), sub: plural(n, 'person', 'people') });
    }).join('');
    const body = '<fieldset class="gs-fieldset gs-tr-group"><legend class="gs-fg-lbl">Character</legend><ul class="gs-tr-pick">' + characterRows + '</ul>' +
      '<p class="gs-field-error" id="dlg-err-characterId" role="alert" hidden></p></fieldset>' +
      '<fieldset class="gs-fieldset gs-tr-group"><legend class="gs-fg-lbl">Team</legend><ul class="gs-tr-pick">' + teamRows + '</ul>' +
      '<p class="gs-field-error" id="dlg-err-teamId" role="alert" hidden></p></fieldset>';
    return G.ui.dialogHtml({ kind: 'form', title: 'Request a team', text: REQUEST_TEXT, className: 'gs-forge', bodyHtml: body,
      primary: { label: 'Send request' }, formAttrs: { 'data-submit': 'team-request-form' } });
  }

  // ── the decider: the row on Home and on the Roster ──
  // opts: { gd, ctx ('home' | 'roster'), withTeam (the team's name on the row), now, prefix (keeps data-key unique where a page draws the row twice: Home's desktop and phone) }
  function rowHtml(r, opts) {
    const o = opts || {};
    const c = r.character || {};
    const team = r.team || {};
    const person = r.person || {};
    const teamRow = (o.gd && Array.isArray(o.gd.teams) ? o.gd.teams : []).filter(function (t) { return t.id === team.id; })[0];
    const days = teamRow && Number(teamRow.trialDays) > 0 ? Math.floor(Number(teamRow.trialDays)) : 0;
    const gid = o.gd && o.gd.guild ? o.gd.guild.id : '';
    const from = person.name && person.id
      ? '<a class="gs-fg-u" href="' + esc(G.router.format({ name: 'person', gid: gid, pid: person.id })) + '">' + esc(person.name) + '</a>' : '';
    const ago = r.createdAt ? G.ui.agoText(r.createdAt, o.now) : '';
    const sub = [from ? 'From ' + from : '', esc(ago)].filter(Boolean).join(' &middot; ');
    const attrs = function (verb) { return { 'data-action': 'team-request-' + verb, 'data-trid': r.id, 'data-gid': gid, 'data-ctx': o.ctx || '', 'data-key': 'tr-' + verb + '-' + (o.prefix || '') + r.id }; };
    return '<li class="gs-hd-todo gs-tr-ask" data-trid="' + esc(r.id) + '">' + (o.withTeam && team.name ? '<span class="gs-hd-todo-meta">' + esc(team.name) + '</span>' : '') +
      '<span class="gs-hd-todo-title gs-tr-t">' + G.ui.specIconHtml(c.class, c.mainSpec, 20) + '<span class="gs-tr-txt"><span class="gs-tr-lead">' + G.ui.classNameHtml(c.name, c.class) + ' asks to join</span>' +
      '<span class="gs-tr-line">' + esc((c.mainSpec ? c.mainSpec + ' ' : '') + G.ui.className(c.class)) + '</span>' +
      (sub ? '<span class="gs-tr-line">' + sub + '</span>' : '') +
      (c.startsTrial && days ? '<span class="gs-tr-line">Approving starts a ' + days + '-day trial.</span>' : '') + '</span></span>' +
      '<div class="gs-hd-todo-acts">' +
      G.ui.buttonHtml({ label: 'Approve', size: 'sm', ariaLabel: 'Approve ' + c.name + ' for ' + team.name, attrs: attrs('approve') }) +
      G.ui.buttonHtml({ label: 'Reject', variant: 'ghost', size: 'sm', ariaLabel: 'Reject ' + c.name + ' for ' + team.name, attrs: attrs('reject') }) + '</div></li>';
  }

  function listHtml(requests, opts) {
    return requests.length ? '<ul class="gs-hd-todos" aria-label="Team requests">' + requests.map(function (r) { return rowHtml(r, opts); }).join('') + '</ul>' : '';
  }

  // Home: the head with the gold count, then the rows.
  function blockHtml(requests, opts) {
    return requests.length ? '<h3 class="gs-hd-sl gs-hd-sl-sub gs-tr-hsl">Team requests <span class="gs-fg-cnt">' + requests.length + '</span></h3>' + listHtml(requests, opts) : '';
  }

  // ── behaviour ──
  function currentPerson() { return G.pages.person && G.pages.person.ops ? G.pages.person.ops.cur() : null; }
  // The Character page opens the same dialog for its own character (openFor): its context { gid, gd, rec (the person's characters as a record), firstId (the one that leads), after (what
  // follows a sent request) } is kept while that dialog is open, so the dialog's submit follows the page that opened it. The person page's button clears it.
  let opened = null;

  // The page that shows a request tells what follows a decision: hooks[ctx] = { done(gid, verb, request), fail(gid, text) }.
  function setHooks(ctx, h) { hooks[ctx] = h; }

  // A decided row is gone and its button took the keyboard with it: focus goes to the next ask that shows (a team request or a "This is me"), else the page title.
  function focusAfterDecision() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const asks = document.querySelectorAll('[data-action="team-request-approve"], [data-action="this-is-me-approve"]');
    for (let i = 0; i < asks.length; i++) {
      if (asks[i].offsetParent !== null && asks[i].focus) { asks[i].focus({ preventScroll: true }); return; }
    }
    const title = document.getElementById('page-title');
    if (title && title.focus) title.focus({ preventScroll: true });
  }

  function failed(err) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return null; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return null; }
    return c.text;
  }

  function decide(el, verb) {
    const gid = el.getAttribute('data-gid') || st().currentGid;
    const trid = el.getAttribute('data-trid');
    const ctx = el.getAttribute('data-ctx') || '';
    if (!gid || !trid || el.disabled) return null;
    const request = pendingOf(gid).filter(function (r) { return r.id === trid; })[0] || null;
    const row = el.closest ? el.closest('.gs-hd-todo-acts') : null;
    const buttons = row && row.querySelectorAll ? row.querySelectorAll('button') : [el];
    for (let i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    return G.api.post(url(gid, '/' + encodeURIComponent(trid) + '/' + verb), {}).then(function (res) {
      G.app.applyFlags(gid, res);
      const b = bucketOf(gid);
      if (b) b.pending = listOf(b, 'pending').filter(function (r) { return r.id !== trid; });
      const h = hooks[ctx];
      if (h && h.done) h.done(gid, verb, request); else G.app.render();
      return null;
    }, function (err) {
      for (let i = 0; i < buttons.length; i++) buttons[i].disabled = false;
      const text = failed(err);
      if (text === null) return null;
      // A request that was decided meanwhile (or whose character moved) is gone from the next read: show why, then the list as it is.
      return read(gid).then(function () {
        const h = hooks[ctx];
        if (h && h.fail) h.fail(gid, text); else { st().pageAlert = text; G.app.render(); }
        return null;
      });
    });
  }

  G.handlers.click['team-request-approve'] = function (el) { return decide(el, 'approve'); };
  G.handlers.click['team-request-reject'] = function (el) { return decide(el, 'reject'); };

  function openDialog(c) {
    if (!c || !canRequest(c.gd, c.rec, mineOf(c.gid))) return;
    G.ui.openDialog(dialogHtml(c.gd, c.rec, mineOf(c.gid), c.firstId), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    const first = typeof document !== 'undefined' ? document.querySelector('.gs-tr-radio') : null;
    if (first && first.focus) first.focus();
  }

  G.handlers.click['team-request-open'] = function () {
    opened = null;
    openDialog(currentPerson());
  };

  function openFor(c) {
    opened = c;
    openDialog(c);
  }

  G.handlers.submit['team-request-form'] = function (form) {
    const c = opened || currentPerson();
    if (!c) return;
    const character = form.querySelector('input[name="characterId"]:checked');
    const team = form.querySelector('input[name="teamId"]:checked');
    G.ui.setText('dlg-error', '');
    G.ui.setText('dlg-err-characterId', '');
    G.ui.setText('dlg-err-teamId', '');
    if (!character) { G.ui.setText('dlg-err-characterId', 'Pick a character.'); return; }
    if (!team) { G.ui.setText('dlg-err-teamId', 'Pick a team.'); return; }
    G.ui.runDialog(form, G.api.post(url(c.gid), { characterId: character.value, teamId: team.value }), function () {
      read(c.gid).then(function () { return c.after ? c.after() : G.app.render(); });
    });
  };

  G.handlers.click['team-request-withdraw'] = function (el) {
    const c = currentPerson();
    const trid = el.getAttribute('data-trid');
    if (!c || !trid || el.disabled) return null;
    el.disabled = true;
    return G.api.del(url(c.gid, '/' + encodeURIComponent(trid)), {}).then(function () {
      return read(c.gid).then(function () { G.app.render(); });
    }, function (err) {
      el.disabled = false;
      const text = failed(err);
      if (text === null) return null;
      // Decided meanwhile (409 request_decided): the row already changed on the next read.
      return read(c.gid).then(function () { st().pageAlert = text; G.app.render(); });
    });
  };

  G.pages.teamRequests = {
    REQUEST_TEXT: REQUEST_TEXT,
    DECIDED_TEXT: DECIDED_TEXT,
    read: read,
    bucketOf: bucketOf,
    mineOf: mineOf,
    pendingOf: pendingOf,
    requestFor: requestFor,
    askers: askers,
    freeTeams: freeTeams,
    canRequest: canRequest,
    openFor: openFor,
    headButtonHtml: headButtonHtml,
    rowStatusHtml: rowStatusHtml,
    withdrawHtml: withdrawHtml,
    dialogHtml: dialogHtml,
    rowHtml: rowHtml,
    listHtml: listHtml,
    blockHtml: blockHtml,
    setHooks: setHooks,
    focusAfterDecision: focusAfterDecision,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
