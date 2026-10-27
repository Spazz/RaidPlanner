// ── PAGE: SIGN UP FOR A RAID THAT IS OPEN TO GUESTS (#/open/<gid>/<rid>; a T3 form page, signed-in accounts) ─
// A raid with the "Open to guests" check lets any signed-in account that is not in the guild sign up as a Guest, no link needed (worker/routes/open-raids.js).
// The route is { name: 'join', open: true, gid, rid } so the shell treats it as the join page; the state lives in the same slot (state.join, with open: true).
// Which form the guest sees is the Worker's call (data.signUp.mode):
//   'bnet'   the guild runs on the in-game roster: the guest must have Battle.net connected and picks one of THEIR Battle.net characters (radio rows) + a Spec + a note.
//            Not connected -> one Connect Battle.net empty state. A stale or empty list -> Refresh from Battle.net.
//   'typed'  every other guild: the join link's fields (character name, class, spec, note).
// Done = a banner, the character, and "Withdraw my sign-up" (no confirm: signing up again is one form away). A member of the guild is sent to the raid page; a signed-out
// visitor is asked to sign in and comes back here (rememberReturn / takeReturn: a short-lived sessionStorage marker, also set before a Battle.net round trip).
// GET / POST / DELETE /api/open/:gid/raids/:rid. The raid's start is written in the guild's zone, as on the join page.
(function (G) {
  'use strict';

  const CONNECT_HREF = '/auth/bnet/login';
  const RETURN_KEY = 'gs-open-return';
  const RETURN_TTL_MS = 15 * 60 * 1000;

  function st() { return G.app.state; }
  function join() { return G.pages.join; }
  function optionsOf(data) { return G.ui.rosterOptions({ rosterOptions: data.rosterOptions }); }
  function modeOf(data) { return data && data.signUp && data.signUp.mode === 'bnet' ? 'bnet' : 'typed'; }
  function bnetOf(data) { return data && data.signUp && data.signUp.mode === 'bnet' ? data.signUp : null; }

  // ── The way back (sign-in, Battle.net) ──
  function store() {
    try { return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null; } catch (err) { return null; }
  }
  function rememberReturn(hash) {
    const s = store();
    if (!s || !hash) return;
    try { s.setItem(RETURN_KEY, JSON.stringify({ hash: hash, at: Date.now() })); } catch (err) { /* storage may be blocked: the person finds the page again */ }
  }
  // The address to go back to, once: only an open-raid address, only within 15 minutes; the marker is gone either way.
  function takeReturn() {
    const s = store();
    if (!s) return '';
    let raw = null;
    try { raw = s.getItem(RETURN_KEY); s.removeItem(RETURN_KEY); } catch (err) { return ''; }
    if (!raw) return '';
    let found = null;
    try { found = JSON.parse(raw); } catch (err) { return ''; }
    if (!found || typeof found.hash !== 'string' || typeof found.at !== 'number' || Date.now() - found.at > RETURN_TTL_MS) return '';
    const r = G.router.parse(found.hash);
    return r.name === 'join' && r.open ? G.router.format(r) : '';
  }
  function hashOf(x) { return G.router.format({ name: 'join', open: true, gid: x.gid, rid: x.rid }); }

  // ── Pieces ──
  function spotsText(left) {
    if (typeof left !== 'number') return '';
    return left > 0 ? ' ' + G.ui.plural(left, 'spot', 'spots') + ' left.' : ' No spots left.';
  }

  function introHtml(data) {
    return '<p class="gs-lead gs-lead-sm" id="jn-intro">' + esc(data.guild.name) + ' opened this raid to guests.' + esc(spotsText(data.spotsLeft)) + '</p>';
  }

  function connectButtonHtml(label) {
    return G.ui.buttonHtml({ label: label, variant: 'primary', href: CONNECT_HREF, icon: 'link', attrs: { 'data-action': 'open-connect', 'data-key': 'bnet-connect' } });
  }

  // The one empty state of a Battle.net guild whose list is not usable. Not connected: connect; out of date or empty or failed: refresh.
  function connectHtml(x) {
    const data = x.data;
    const bnet = bnetOf(data);
    const guild = data.guild.name;
    const status = bnet ? bnet.status : 'not_linked';
    if (status === 'unsupported') {
      return G.ui.emptyStateHtml({ icon: 'alert', title: 'Battle.net has no characters for this game', text: guild + ' takes guests through Battle.net, which cannot list characters for this game yet.' });
    }
    if (status === 'not_linked') {
      return G.ui.emptyStateHtml({ icon: 'link', title: 'Connect Battle.net to sign up', text: guild + ' takes guests who have Battle.net connected. You pick your character from your list.', actions: [{ label: 'Connect Battle.net', href: CONNECT_HREF, icon: 'link', attrs: { 'data-action': 'open-connect', 'data-key': 'bnet-connect' } }] });
    }
    const why = status === 'unavailable' ? { title: 'Battle.net did not answer', text: 'Your characters could not be loaded just now. Try again in a moment.' }
      : status === 'ok' ? { title: 'No characters found', text: 'Battle.net lists no character for this game on ' + (bnet.battletag || 'your account') + '. If you made one recently, refresh the list.' }
        : { title: 'Load your characters from Battle.net', text: 'Your Battle.net character list is out of date. Refresh it to pick your character.' };
    return G.ui.emptyStateHtml({ icon: 'link', title: why.title, text: why.text, actions: [{ label: 'Refresh from Battle.net', href: CONNECT_HREF, icon: 'link', attrs: { 'data-action': 'open-connect', 'data-key': 'bnet-connect' } }] });
  }

  function characterKey(c) { return c.realmSlug + '|' + c.name; }
  function pickedOf(x, key) {
    const list = bnetOf(x.data) ? bnetOf(x.data).characters : [];
    return list.filter(function (c) { return characterKey(c) === key; })[0] || null;
  }
  // The character shown as picked: the draft's, else the first of the list (the highest level).
  function pickedKey(x) {
    const list = bnetOf(x.data).characters;
    return x.draft.pick && pickedOf(x, x.draft.pick) ? x.draft.pick : (list.length ? characterKey(list[0]) : '');
  }

  function characterRowHtml(c, checked) {
    const sub = [G.ui.className(c.class), c.level ? 'Level ' + c.level : '', c.realm].filter(Boolean).join(' - ');
    return '<li><label class="gs-pickrow' + (checked ? ' is-picked' : '') + '"><input type="radio" class="gs-pickradio" name="character" value="' + esc(characterKey(c)) + '"' + (checked ? ' checked' : '') + ' data-change="open-pick">' +
      G.ui.specIconHtml(c.class, '', 20) + '<span class="gs-pickid">' + G.ui.classNameHtml(c.name, c.class) + '<span class="gs-picksub">' + esc(sub) + '</span></span></label></li>';
  }

  // Character: the account's Battle.net list as radio rows, the account's BattleTag, and Refresh from Battle.net.
  function charactersFieldHtml(x) {
    const bnet = bnetOf(x.data);
    const key = pickedKey(x);
    return '<div class="gs-field gs-bnetpick"><span class="gs-label" id="jn-char-l">Character <span class="gs-req">(required)</span></span>' +
      '<ul class="gs-pick" id="jn-character" role="radiogroup" aria-required="true" tabindex="-1" aria-labelledby="jn-char-l" aria-describedby="jn-char-help jn-character-err">' +
      bnet.characters.map(function (c) { return characterRowHtml(c, characterKey(c) === key); }).join('') + '</ul>' +
      '<p class="gs-fine" id="jn-char-help">From your Battle.net' + (bnet.battletag ? ', ' + esc(bnet.battletag) : '') + '.</p>' +
      '<p class="gs-field-error" id="jn-character-err" role="alert" hidden></p>' +
      '<div class="gs-pickact">' + G.ui.buttonHtml({ label: 'Refresh from Battle.net', variant: 'ghost', size: 'sm', href: CONNECT_HREF, attrs: { 'data-action': 'open-connect', 'data-key': 'bnet-refresh' } }) + '</div></div>';
  }

  function formHtml(x) {
    if (modeOf(x.data) === 'typed') return join().formHtml(x, { submit: 'open-form' });
    const picked = pickedOf(x, pickedKey(x));
    return join().formHtml(x, { submit: 'open-form', identityHtml: charactersFieldHtml(x), specClass: picked ? picked.class : '' });
  }

  function doneHtml(x) {
    const data = x.data;
    const mine = data.mine;
    const what = [G.ui.className(mine.classId || String(mine.className || '').toUpperCase()), mine.spec].filter(Boolean).join(' - ');
    return G.ui.bannerHtml({ tone: 'success', dismissible: false, title: 'You are signed up', id: 'jn-done-h',
      text: 'The officers of ' + data.guild.name + ' can see you for ' + join().whenText(data.raid, data.guild.timeZone) + '. You do not need to do anything else.' }) +
      '<p class="gs-lead gs-lead-sm">Signed up as ' + G.ui.classNameHtml(mine.name, mine.classId || String(mine.className || '').toUpperCase()) + (what ? ', ' + esc(what) : '') + '.</p>' +
      '<p class="gs-alert" id="jn-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p>' +
      '<div class="gs-actions">' + G.ui.buttonHtml({ label: 'Withdraw my sign-up', variant: 'secondary', busy: !!x.busy, busyLabel: 'Withdrawing...', attrs: { 'data-action': 'open-withdraw', 'data-key': 'open-withdraw' } }) + '</div>';
  }

  function bodyOf(x) {
    const data = x.data;
    const mine = data.mine;
    if (mine) return doneHtml(x);
    const notice = x.notice ? G.ui.bannerHtml({ tone: 'info', dismissible: false, title: x.notice }) : '';
    if (typeof data.spotsLeft === 'number' && data.spotsLeft <= 0) {
      return notice + introHtml(data) + G.ui.emptyStateHtml({ kind: 'filtered', title: 'No guest spots left', text: data.guild.name + ' has filled the guest places for this raid.' });
    }
    if (modeOf(data) === 'bnet' && bnetOf(data).status !== 'ok') return notice + introHtml(data) + connectHtml(x);
    if (modeOf(data) === 'bnet' && !bnetOf(data).characters.length) return notice + introHtml(data) + connectHtml(x);
    return notice + introHtml(data) + formHtml(x);
  }

  function pageHtml(x, head, bodyHtml) {
    return G.ui.formPageHtml({ pageClass: 'gs-apply gs-open gs-forge', head: head, bodyHtml: bodyHtml });
  }

  // opts: { state } (st().join, open: true) -> the page.
  function openHtml(opts) {
    const x = opts.state;
    if (!x || x.status === 'loading') return G.pages.signin.loadingHtml();
    if (x.status === 'signin') {
      return pageHtml(x, { title: 'Sign up as a guest' }, G.ui.emptyStateHtml({ icon: 'login', title: 'Sign in to sign up',
        text: 'This raid is open to guests. Sign in or create an account, then pick your character. You come back to this page.',
        actions: [{ label: 'Sign in or sign up', href: G.router.format({ name: 'signin' }), icon: 'login', attrs: { 'data-action': 'open-signin', 'data-key': 'open-signin' } }] }));
    }
    if (x.status === 'gone') return G.pages.signin.messageHtml('This raid is not open to guests', x.message || 'It may have started, been closed to guests, or never existed. Ask an officer of the guild.', {});
    if (x.status === 'blocked') return G.pages.signin.messageHtml(x.title || 'You cannot sign up', x.message, {});
    if (x.status === 'error') return G.pages.signin.messageHtml('Could not open the sign-up', x.message || 'Something went wrong. Try again in a moment.', { retry: true });
    const data = x.data;
    if (x.status === 'member') {
      return pageHtml(x, { title: data.guild.name, context: join().raidLine(data) }, G.ui.emptyStateHtml({ icon: 'raids', title: 'You are in ' + data.guild.name,
        text: 'You sign up for this raid from its raid page, with your own character.',
        actions: [{ label: 'Open the raid', href: G.router.format({ name: 'raid', gid: x.gid, rid: x.rid }) }] }));
    }
    return pageHtml(x, { title: 'Sign up for ' + data.guild.name, context: join().raidLine(data) }, bodyOf(x));
  }

  // ── Loading ──
  function read(x) {
    return G.api.openRaid.view(x.gid, x.rid).then(function (data) {
      if (st().join !== x) return x;
      x.data = data;
      x.status = data && data.member ? 'member' : 'ok';
      if (x.status === 'member' && G.app && G.app.go) G.app.go(G.router.format({ name: 'raid', gid: x.gid, rid: x.rid }), true);
      return x;
    }, function (err) {
      if (st().join !== x) return x;
      const c = G.api.classify(err);
      if (c.view === 'signin') {
        x.status = 'signin';
        rememberReturn(hashOf(x));
      } else if (err && err.status === 404) {
        x.status = 'gone';
        x.message = c.text;
      } else if (c.view === 'message') {
        x.status = 'blocked'; x.title = c.title; x.message = c.text;
      } else {
        x.status = 'error'; x.message = c.text;
      }
      return x;
    });
  }

  // route: { name: 'join', open: true, gid, rid }.
  function load(route) {
    const x = st().join = { open: true, gid: route.gid, rid: route.rid, status: 'loading', data: null, draft: {}, busy: false, error: '', notice: '' };
    return read(x);
  }

  function cur() {
    const x = st().join;
    return x && x.open && x.status === 'ok' && x.data && !x.data.mine ? x : null;
  }
  function curDone() {
    const x = st().join;
    return x && x.open && x.status === 'ok' && x.data && x.data.mine ? x : null;
  }

  // ── Handlers ──
  // The way out to Battle.net (a plain link): remember the page, so the round trip ends back here.
  G.handlers.click['open-connect'] = function () {
    const x = st().join;
    if (x && x.open) rememberReturn(hashOf(x));
  };
  G.handlers.click['open-signin'] = function () {
    const x = st().join;
    if (x && x.open) rememberReturn(hashOf(x));
  };

  // Another character picked: mark its row, and list the specs of its class (the spec that is still valid stays chosen).
  G.handlers.change['open-pick'] = function (radio) {
    const x = cur();
    const form = radio && radio.closest ? radio.closest('form') : null;
    if (!x || !form || !radio.checked) return;
    x.draft.pick = radio.value;
    Array.prototype.forEach.call(form.querySelectorAll('.gs-pickrow'), function (row) {
      const input = row.querySelector('input');
      if (row.classList) row.classList.toggle('is-picked', !!(input && input.checked));
    });
    const picked = pickedOf(x, radio.value);
    const spec = form.elements ? form.elements.spec : null;
    if (picked && spec) {
      const keep = spec.value;
      spec.innerHTML = G.ui.specOptionsHtml(optionsOf(x.data), picked.class, '', 'Choose a spec');
      if (keep && G.ui.specsFor(optionsOf(x.data), picked.class).indexOf(keep) >= 0) spec.value = keep;
    }
    G.ui.setFieldError(form, 'jn-character', '');
  };

  function readForm(form, x) {
    const v = function (name) { return form.elements && form.elements[name] ? String(form.elements[name].value == null ? '' : form.elements[name].value) : ''; };
    const draft = { spec: v('spec'), note: v('note').trim() };
    if (modeOf(x.data) === 'bnet') {
      const checked = form.querySelector ? form.querySelector('input[name="character"]:checked') : null;
      draft.pick = checked ? checked.value : '';
    } else {
      draft.name = v('name').trim();
      draft.class = v('class');
    }
    return draft;
  }

  // The body of the POST: a note with nothing in it is left out; the hidden field travels as it is (empty for a person).
  function bodyFrom(x, draft, website) {
    const body = { spec: draft.spec, website: website || '' };
    if (modeOf(x.data) === 'bnet') {
      const c = pickedOf(x, draft.pick);
      body.character = { name: c.name, realmSlug: c.realmSlug };
    } else {
      body.name = draft.name;
      body.class = draft.class;
    }
    if (draft.note) body.note = draft.note;
    return body;
  }

  const blank = function (message) { return function (value) { return String(value == null ? '' : value).trim() ? '' : message; }; };
  function rulesFor(x) {
    return modeOf(x.data) === 'bnet' ? { 'jn-character': blank('Choose your character.'), 'jn-spec': join().RULES['jn-spec'] } : join().RULES;
  }
  function valuesFor(x, draft) {
    return modeOf(x.data) === 'bnet' ? { 'jn-character': draft.pick, 'jn-spec': draft.spec } : { 'jn-name': draft.name, 'jn-class': draft.class, 'jn-spec': draft.spec };
  }

  // The field slot that shows a refusal the Worker pinned on a field; a name the Worker refuses is the picked character in a Battle.net guild.
  function slotFor(x, field) {
    if (field === 'character') return 'jn-character';
    if (field === 'name') return modeOf(x.data) === 'bnet' ? 'jn-character' : 'jn-name';
    return field === 'spec' || field === 'class' || field === 'note' ? 'jn-' + field : '';
  }
  // Is there a message slot under that field? (A refusal that names a field nobody can see goes to the general line.)
  function hasSlot(form, id) {
    const inForm = form && form.querySelector ? form.querySelector('#' + id + '-err') : null;
    return !!(inForm || (typeof document !== 'undefined' && document.getElementById && document.getElementById(id + '-err')));
  }

  G.handlers.submit['open-form'] = function (form) {
    const x = cur();
    if (!x || x.busy) return;
    G.ui.setText('jn-error', '');
    x.error = '';
    x.draft = readForm(form, x);
    if (!G.ui.validateForm(form, rulesFor(x), valuesFor(x, x.draft)).ok) return;
    x.busy = true;
    const website = form.elements && form.elements.website ? form.elements.website.value : '';
    G.ui.setBusy(form, true);
    G.api.openRaid.submit(x.gid, x.rid, bodyFrom(x, x.draft, website)).then(function () {
      x.busy = false;
      x.notice = '';
      return read(x).then(function () { G.app.render(true); });
    }, function (err) {
      x.busy = false;
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      const code = err && err.code;
      if (c.view === 'signin') { x.status = 'signin'; rememberReturn(hashOf(x)); G.app.render(true); return; }
      // The page is out of date: read it again and draw what is true now (signed up already, full, not connected, not open any more, a member).
      if (code === 'already_signed_up' || code === 'raid_full' || code === 'bnet_not_linked' || code === 'bnet_refresh' || code === 'battlenet_only' || code === 'member' || (err && err.status === 404)) {
        return read(x).then(function () { G.app.render(true); });
      }
      const slot = slotFor(x, err && err.field);
      if (slot && hasSlot(form, slot)) { G.ui.setFieldError(form, slot, c.text); G.ui.focusFirstInvalid(form); return; }
      x.error = c.text;
      G.ui.setText('jn-error', c.text);
    });
  };

  // Withdraw my sign-up: no confirm. The page is read again, so the form (or the Battle.net state) comes back with the spot count up to date.
  G.handlers.click['open-withdraw'] = function (el) {
    const x = curDone();
    if (!x || x.busy) return;
    x.busy = true; x.error = '';
    if (el) el.disabled = true;
    G.api.openRaid.withdraw(x.gid, x.rid).then(function () {
      x.busy = false;
      x.notice = 'You are no longer signed up for this raid';
      x.draft = {};
      return read(x).then(function () { G.app.render(true); });
    }, function (err) {
      x.busy = false;
      if (el) el.disabled = false;
      const c = G.api.classify(err);
      if (c.view === 'signin') { x.status = 'signin'; G.app.render(true); return; }
      if (err && err.status === 404) { return read(x).then(function () { G.app.render(true); }); } // nothing left to withdraw: draw what is true
      x.error = c.text;
      G.ui.setText('jn-error', c.text);
    });
  };

  G.pages.openRaid = { openHtml: openHtml, formHtml: formHtml, load: load, bodyFrom: bodyFrom, rememberReturn: rememberReturn, takeReturn: takeReturn, spotsText: spotsText, CONNECT_HREF: CONNECT_HREF };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
