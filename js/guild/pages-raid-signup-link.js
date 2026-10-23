// ── PAGE PIECE: UNMATCHED SIGN-UPS OF A RAID ─────────
// Design-spec 2, 4, 5 (Forge panel, the gs-rb* recipe of the people board). A Raid-Helper sign-up that no person on the roster owns (the Home to-do "Sign-ups not
// linked to a person") gets its own panel on the raid page, for upcoming and past raids: one row per sign-up with its Raid-Helper nickname, the class and spec as
// Raid-Helper gives them, a grey chip for Tentative / Bench / Late, a link button and a More menu:
//   Link to person...      pick a roster person; the person takes the sign-up's Discord ID (when they have none) and every sign-up with it follows
//   Add as new person...   the Add person dialog of the Roster, filled from the sign-up and linked to it
//   Add as Guest / Pug...  a raid-only character name, kept as a native guest override through source refreshes
// Only an officer with roster.edit on the raid's team gets the panel: the Worker sends the sign-up ids (entry.signupId) to those viewers only.
// POST /raids/:rid/signups/link { signupId, personId } -> the sign-ups view + relinked; the add path is POST /roster with fromSignup { raidId, signupId }.
(function (G) {
  'use strict';

  const esc = G.ui.esc;
  const KINDS = ['signed', 'late', 'bench', 'tentative'];
  const CHIP_WORDS = { late: 'Late', bench: 'Bench', tentative: 'Tentative' };
  const PANEL_ID = 's-signups-unmatched';

  function A() { return G.pages.attendance; }
  function a() { return A().attState(); }
  function st() { return G.app.state; }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }

  // The unmatched sign-ups of a loaded Sign-ups view (state = G.pages.raidSignups.stateFor): the ones an officer may link, by nickname.
  function unlinkedOf(state) {
    const view = state && state.status === 'ok' ? state.data : null;
    if (!view || !view.can || !view.can.seeNicknames || !Array.isArray(view.entries)) return [];
    return view.entries.filter(function (e) {
      return e.source === 'raid_helper' && !e.personId && e.signupId != null && KINDS.indexOf(e.kind) >= 0;
    }).sort(function (x, y) { return String(x.name || '').toLowerCase() < String(y.name || '').toLowerCase() ? -1 : 1; });
  }

  // "Shaman - Restoration": the class and the spec as Raid-Helper gives them.
  function wordsOf(entry) {
    return [entry.className, entry.spec].filter(Boolean).join(' - ');
  }

  function nickOf(entry) { return entry.name || entry.nickname || 'this sign-up'; }

  function rowHtml(entry, rid, canEdit) {
    const nick = nickOf(entry);
    const chip = CHIP_WORDS[entry.kind] ? '<span class="gs-rb-chips"><span class="gs-hd-chip is-grey">' + esc(CHIP_WORDS[entry.kind]) + '</span></span>' : '';
    const words = wordsOf(entry);
    const key = esc(rid + '-' + entry.signupId);
    return '<li class="gs-rb-row gs-rba-unmrow"><span class="gs-rb-id"><span class="gs-rb-nm">' + G.ui.classNameHtml(nick, entry.classId || entry.nameClassId) + '</span>' +
      (words ? '<span class="gs-rb-sp">' + esc(words) + '</span>' : '') + '</span>' + chip +
      '<span class="gs-rba-acts">' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="sul-link" data-sid="' + esc(entry.signupId) + '" data-key="sul-link-' + key + '" aria-label="' + esc('Link ' + nick + ' to a person') + '">Link to person...</button>' +
      G.ui.menuHtml({ id: 'sul-more-' + key, icon: 'more', ariaLabel: 'More actions for ' + nick, key: 'sul-more-' + key, items: (canEdit ? [
        { label: 'Add as Guest / Pug...', key: 'sul-guest-' + key, data: { action: 'sul-guest', sid: entry.signupId } },
      ] : []).concat([
        { label: 'Add as new person...', key: 'sul-person-' + key, data: { action: 'sul-person', sid: entry.signupId } },
      ]) }) +
      '</span></li>';
  }

  // opts: { data (the raid detail), state (G.pages.raidSignups.stateFor) } -> '' unless the viewer may link and there are such sign-ups.
  function panelHtml(opts) {
    const list = unlinkedOf(opts.state);
    if (!list.length || !opts.data || !opts.data.raid) return '';
    const rid = opts.data.raid.id;
    return '<section class="gs-hd-panel gs-rb gs-rba gs-rba-unm gs-rba-sul" id="' + PANEL_ID + '" tabindex="-1" aria-labelledby="sul-h"><div class="gs-rb-ph"><h2 class="gs-pr-h" id="sul-h">Unmatched sign-ups</h2>' +
      '<span class="gs-rb-mut">' + esc(list.length) + '</span></div><div class="gs-rb-pb"><ul class="gs-rb-list">' +
      list.map(function (e) { return rowHtml(e, rid, opts.state.data.can.edit); }).join('') + '</ul></div></section>';
  }

  // ── the dialogs ──
  function entryOf(sid) {
    const gd = currentGd();
    const x = a().raid;
    if (!gd || !x) return null;
    const list = unlinkedOf(G.pages.raidSignups.stateFor(gd.guild.id, x.rid));
    return list.filter(function (e) { return String(e.signupId) === String(sid); })[0] || null;
  }

  // people: the roster rows of the raid's team (GET /roster?team=).
  function guestDialogHtml(entry) {
    return '<form class="gs-dialog-form gs-forge" data-submit="sul-guest-form" data-sid="' + esc(entry.signupId) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Add as Guest / Pug</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc('From the sign-up "' + nickOf(entry) + '". Enter their character name. They stay outside the guild roster; their status, class and spec are kept.') + '</p>' +
      '<div class="gs-field"><label class="gs-label" for="sul-guest-name">Character name</label><input class="gs-input" id="sul-guest-name" name="name" data-field="name" maxlength="40" autocomplete="off" value="' + esc(entry.name || '') + '" required>' +
      '<p class="gs-field-error" id="dlg-err-name" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Add Guest / Pug</button></div></form>';
  }

  function linkDialogHtml(entry, people) {
    const list = (Array.isArray(people) ? people : []).map(function (p) {
      const shown = p.shown || {};
      const main = p.main || {};
      const name = main.name || shown.name || '';
      return '<li class="gs-pick-item" data-name="' + esc(String(name).toLowerCase()) + '"><div class="gs-check"><input type="radio" name="personId" id="sul-pick-' + esc(p.id) + '" value="' + esc(p.id) + '"><label for="sul-pick-' + esc(p.id) + '">' +
        G.ui.classNameHtml(name, main.class || shown.class) + ' <span class="gs-fine">' + esc(G.ui.statusLabel(p.status)) + (main.class ? ' &middot; ' + esc(G.ui.className(main.class)) : '') + '</span></label></div></li>';
    }).join('');
    const nick = nickOf(entry);
    const words = wordsOf(entry);
    return '<form class="gs-dialog-form gs-forge" data-submit="sul-link-form" data-sid="' + esc(entry.signupId) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Link ' + esc(nick) + ' to a person</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(words ? 'Raid-Helper sign-up, ' + words + '. ' : 'Raid-Helper sign-up. ') + 'Pick the person it belongs to. Their other sign-ups from the same Discord account are linked too.</p>' +
      '<div class="gs-field"><label class="gs-label" for="unm-search">Search people</label><input class="gs-input" type="search" id="unm-search" data-input="unm-search" autocomplete="off"></div>' +
      '<ul class="gs-pick-list" aria-label="People">' + (list || '<li class="gs-fine">No one on this roster yet.</li>') + '</ul>' +
      '<p class="gs-field-error" id="dlg-err-personId" role="alert" hidden></p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Link sign-up</button></div></form>';
  }

  G.handlers.click['sul-guest'] = function (el) {
    const entry = entryOf(el.getAttribute('data-sid'));
    if (!entry) return;
    G.ui.openDialog(guestDialogHtml(entry), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.submit['sul-guest-form'] = function (form) {
    const gd = currentGd();
    const x = a().raid;
    if (!gd || !x) return;
    const name = form.elements.name.value.trim();
    G.ui.setText('dlg-err-name', '');
    if (!name) { G.ui.setText('dlg-err-name', 'Enter their character name.'); return; }
    return G.ui.runDialog(form, G.api.signups.guest(gd.guild.id, x.rid, { signupId: Number(form.getAttribute('data-sid')), name: name }), function () {
      return afterLinked('Added ' + name + ' as a Guest / Pug.');
    });
  };

  G.handlers.click['sul-link'] = function (el) {
    const gd = currentGd();
    const x = a().raid;
    const entry = entryOf(el.getAttribute('data-sid'));
    if (!gd || !x || !entry) return;
    const teamId = x.data && x.data.raid ? (x.data.raid.teamId || (x.data.raid.team && x.data.raid.team.id)) : null;
    el.disabled = true;
    G.api.get(A().apiBase(gd.guild.id) + '/roster?team=' + encodeURIComponent(teamId || G.app.teamFor(gd))).then(function (res) {
      el.disabled = false;
      G.ui.openDialog(linkDialogHtml(entry, res && res.people), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const s = document.getElementById('unm-search');
      if (s) s.focus();
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  G.handlers.click['sul-person'] = function (el) {
    const gd = currentGd();
    const x = a().raid;
    const entry = entryOf(el.getAttribute('data-sid'));
    if (!gd || !x || !entry || !G.pages.roster || !G.pages.roster.addPersonDialogHtml) return;
    const raid = x.data && x.data.raid ? x.data.raid : {};
    const teamId = raid.teamId || (raid.team && raid.team.id) || G.app.teamFor(gd);
    const today = G.ui.dayKeyInZone(Date.now(), (gd.guild && gd.guild.timeZone) || G.ui.guildZone()) || raid.raidOn || '';
    el.disabled = true;
    G.pages.roster.loadLinkable(gd.guild.id).then(function (users) {
      el.disabled = false;
      G.ui.openDialog(G.pages.roster.addPersonDialogHtml({
        guildData: gd, teamId: teamId, team: null, today: today, linkable: users,
        prefill: { name: entry.name || '', nickname: nickOf(entry), classId: entry.classId || '', spec: entry.spec || '', raidId: x.rid, signupId: entry.signupId },
      }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const input = document.getElementById('dlg-name');
      if (input) input.focus();
    });
  };

  // After a link (either way): the sign-ups view and the raid are read again, and the page says what happened.
  function afterLinked(note) {
    const gd = currentGd();
    const x = a().raid;
    if (!gd || !x) return;
    a().note = note || '';
    st().pageAlert = '';
    const reread = G.pages.raidSignups.loadFor(gd, x.data).then(function () { G.app.render(); });
    if (G.pages.raid && G.pages.raid.reload) G.pages.raid.reload();
    if (G.pages.raidBoard && G.pages.raidBoard.refresh) G.pages.raidBoard.refresh();
    return reread;
  }

  G.handlers.submit['sul-link-form'] = function (form) {
    const gd = currentGd();
    const x = a().raid;
    if (!gd || !x) return;
    const picked = form.querySelector('input[name="personId"]:checked');
    G.ui.setText('dlg-err-personId', '');
    G.ui.setText('dlg-error', '');
    if (!picked) { G.ui.setText('dlg-err-personId', 'Pick the person this sign-up belongs to.'); return; }
    const body = { signupId: Number(form.getAttribute('data-sid')), personId: picked.value };
    const label = picked.parentNode && picked.parentNode.querySelector('label') ? picked.parentNode.querySelector('label').firstChild : null;
    const personName = label && label.textContent ? label.textContent.trim() : 'the person';
    G.ui.runDialog(form, G.api.signups.link(gd.guild.id, x.rid, body), function (res) {
      const n = res && res.relinked > 1 ? ' ' + res.relinked + ' sign-ups are linked to ' + personName + '.' : '';
      afterLinked('Linked the sign-up to ' + personName + '.' + n);
    });
  };

  // The Home to-do opens the raid page on this panel (route option focus = 'signups-unmatched'): scroll to it once, when it is on the page.
  function focusIfAsked(r) {
    if (!r || r.focus !== 'signups-unmatched' || typeof document === 'undefined') return;
    const x = a().raid;
    if (!x || x.focused === r.rid) return;
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    x.focused = r.rid;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    if (el.focus) el.focus({ preventScroll: true });
  }

  G.pages.raidSignupLink = { PANEL_ID: PANEL_ID, unlinkedOf: unlinkedOf, wordsOf: wordsOf, panelHtml: panelHtml, linkDialogHtml: linkDialogHtml, guestDialogHtml: guestDialogHtml, afterLinked: afterLinked, focusIfAsked: focusIfAsked };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
