// ── PAGE PIECE: RECRUITING > APPLICATIONS (the inbox, the left column of the Recruiting tab) ─────────────────────
// What people sent through the guild's apply page (#/apply/:gid), for officers and team leads (roster.edit): segments New | Reviewing | Closed (accepted
// and declined), a card per application with the character, what it wants, when it came and the contact, and the decisions. "Accept as Trial" makes a person
// on Trial for the team's trial length (Guild settings > Teams) whose Main is the applicant's character, and links the applicant's account when they signed
// in; the rest (Mark reviewing, Accept with options, notes, Decline, Delete) sits under More. The page around it is pages-recruiting.js.
// GET /applications?status=&team=, PATCH /applications/:apid, POST /applications/:apid/accept, DELETE /applications/:apid. The switch and the
// questions are Guild settings > Applications (pages-settings-applications.js).
(function (G) {
  'use strict';

  const SEGMENTS = [['new', 'New'], ['reviewing', 'Reviewing'], ['closed', 'Closed']];
  const STATUS_LABELS = { new: 'New', reviewing: 'Reviewing', accepted: 'Accepted', declined: 'Declined' };
  const STATUS_TONE = { new: 'grey', reviewing: 'blue', accepted: 'green', declined: 'grey' };
  const NOTES_MAX = 2000;

  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }

  // The number beside a segment: Closed is the accepted and the declined together.
  function countFor(counts, seg) {
    const c = counts || {};
    if (seg === 'closed') return (c.accepted || 0) + (c.declined || 0);
    return c[seg] || 0;
  }

  function inSegment(app, seg) {
    return seg === 'closed' ? app.status === 'accepted' || app.status === 'declined' : app.status === seg;
  }

  // ── data: every application of the guild once; the segments filter it here ──
  function load(r, gd) {
    const gid = gd.guild.id;
    const prev = a().applications;
    const seg = prev && prev.gid === gid ? prev.seg : 'new';
    return G.api.applications.list(gid, null, null).then(function (data) {
      a().applications = { gid: gid, seg: seg, data: data, note: '' };
      return null;
    });
  }

  function reload(x) {
    return G.api.applications.list(x.gid, null, null).then(function (data) { x.data = data; return data; });
  }

  // ── the section ──
  function answersHtml(answers) {
    const list = Array.isArray(answers) ? answers : [];
    if (!list.length) return '';
    return '<dl class="gs-app-answers">' + list.map(function (item) {
      return '<dt>' + esc(item.label) + '</dt><dd>' + esc(item.answer).replace(/\n/g, '<br>') + '</dd>';
    }).join('') + '</dl>';
  }

  function actionsHtml(app) {
    const data = function (action) { return { action: action, apid: app.id }; };
    const open = app.status === 'new' || app.status === 'reviewing';
    const items = [
      app.status === 'new' ? { label: 'Mark reviewing', data: data('app-status-reviewing'), key: 'app-status-reviewing-' + app.id } : null,
      app.status === 'declined' ? { label: 'Reopen', data: data('app-status-reviewing'), key: 'app-reopen-' + app.id } : null,
      open ? { label: 'Accept with options', data: data('app-accept'), key: 'app-accept-' + app.id } : null,
      { label: app.notes ? 'Edit notes' : 'Add notes', data: data('app-notes'), key: 'app-notes-' + app.id },
      open ? { label: 'Decline', data: data('app-status-declined'), key: 'app-status-declined-' + app.id } : null,
      { separator: true },
      { label: 'Delete', data: data('app-delete'), key: 'app-delete-' + app.id, danger: true },
    ];
    return '<div class="gs-rc-appacts">' + (open ? '<button type="button" class="gs-btn" data-action="app-accept-trial" data-apid="' + esc(app.id) + '" data-key="app-accept-trial-' + esc(app.id) +
      '" aria-label="' + esc('Accept as Trial: ' + app.name) + '">Accept as Trial</button>' : '') +
      G.ui.menuHtml({ id: 'app-more-' + app.id, key: 'app-more-' + app.id, label: 'More', ariaLabel: 'More for ' + app.name, align: 'left', items: items }) + '</div>';
  }

  function itemHtml(gd, app) {
    const meta = ['wants ' + (app.teamName || 'the team')];
    if (app.realm) meta.push(app.realm);
    meta.push('sent ' + G.ui.formatDateTime(app.createdAt, G.ui.guildZone()));
    if (app.applicant) meta.push('signed in as ' + app.applicant.displayName);
    return '<li class="gs-hd-panel gs-app-item gs-rc-app" id="app-' + esc(app.id) + '"><div class="gs-rc-apphead">' + G.ui.specIconHtml(app.class, app.spec, 20) +
      '<div class="gs-rc-appwho"><div class="gs-rc-appname">' + G.ui.classNameHtml(app.name, app.class) +
      ' <span class="gs-rc-appspec">' + esc(G.ui.className(app.class) + (app.spec ? ' - ' + app.spec : '')) + '</span></div>' +
      '<span class="gs-rc-appmeta">' + esc(meta.join(' - ')) + '</span>' +
      (app.contact ? '<span class="gs-fg-mut gs-app-contact">Contact: ' + esc(app.contact) + '</span>' : '') + '</div>' +
      '<div class="gs-rc-appside"><span class="gs-hd-chip is-' + STATUS_TONE[app.status] + '">' + esc(STATUS_LABELS[app.status]) + '</span>' + actionsHtml(app) + '</div></div>' +
      (app.onRoster ? '<p class="gs-notice gs-app-onroster" role="status"><span>' + esc(app.name) + ' is on the roster already, as a character of <a href="' + esc(G.router.format({ name: 'person', gid: gd.guild.id, pid: app.onRoster.personId })) + '">' + esc(app.onRoster.name) + '</a>.</span></p>' : '') +
      answersHtml(app.answers) +
      (app.notes ? '<p class="gs-app-notes"><span class="gs-fg-gh">Officer notes</span><br>' + esc(app.notes).replace(/\n/g, '<br>') + '</p>' : '') +
      (app.status === 'accepted' && app.personId ? '<p class="gs-fg-mut"><a class="gs-fg-u" href="' + esc(G.router.format({ name: 'person', gid: gd.guild.id, pid: app.personId })) + '">Open the person</a></p>' : '') +
      '</li>';
  }

  function segmentsHtml(x) {
    return '<div class="gs-fg-segs" role="group" aria-label="Application status">' + SEGMENTS.map(function (f) {
      return '<button type="button" class="gs-fg-seg" data-action="apps-filter" data-filter="' + f[0] + '" data-key="apps-' + f[0] + '" aria-pressed="' + (x.seg === f[0] ? 'true' : 'false') + '">' +
        esc(f[1]) + ' <span class="gs-fg-segn">' + esc(countFor(x.data.counts, f[0])) + '</span></button>';
    }).join('') + '</div>';
  }

  // The left column of the Recruiting tab. x: a().applications.
  function sectionHtml(gd, x) {
    const all = Array.isArray(x.data.applications) ? x.data.applications : [];
    const list = all.filter(function (app) { return inSegment(app, x.seg); });
    const canSettings = G.shell.hasAction(gd.me && gd.me.can, 'guild.teams');
    const settingsLink = canSettings ? ' <a class="gs-fg-u" href="' + esc(G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'applications' })) + '">Applications settings</a>' : '';
    const empty = !all.length
      ? '<p class="gs-empty">No applications yet.' + settingsLink + '</p>'
      : '<p class="gs-empty">Nothing in this list.</p>';
    return '<section class="gs-rc-apps" aria-label="Applications"><h2 class="gs-hd-sl">Applications</h2>' + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '') + segmentsHtml(x) +
      (list.length ? '<ul class="gs-app-list" aria-label="Applications">' + list.map(function (app) { return itemHtml(gd, app); }).join('') + '</ul>' : empty) + '</section>';
  }

  // ── dialogs ──
  // The team's trial length (Guild settings > Teams); 14 for a team the guild data does not list.
  function trialDaysOf(gd, teamId) {
    const team = ((gd && gd.teams) || []).filter(function (t) { return t.id === teamId; })[0];
    const n = Number(team && team.trialDays);
    return n >= 1 && n <= 90 ? Math.floor(n) : 14;
  }

  function acceptDialogHtml(gd, app) {
    const teams = G.shell.activeTeams(gd.teams).filter(function (t) { return G.shell.allowsTeam(gd.me && gd.me.can, 'roster.edit', t.id); });
    return '<form class="gs-dialog-form" data-submit="app-accept-form" data-apid="' + esc(app.id) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">Accept ' + esc(app.name) + '</h2>' +
      '<p class="gs-fine" id="dlg-text">' + esc(app.name) + ' joins the roster on Trial with ' + esc(G.ui.className(app.class)) + (app.spec ? ' ' + esc(app.spec) : '') + ' as their Main.' + (app.applicant ? ' Their account is linked to them.' : '') + '</p>' +
      '<div class="gs-field"><label class="gs-label" for="aa-team">Team</label><select class="gs-input" id="aa-team" name="teamId" data-field="teamId">' + G.ui.optionsHtml(teams.map(function (t) { return { value: t.id, label: t.name }; }), app.teamId) + '</select><p class="gs-field-error" id="dlg-err-teamId" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="aa-days">Trial length (days)</label><input class="gs-input gs-input-num" type="number" inputmode="numeric" min="1" max="90" step="1" id="aa-days" name="trialDays" value="' + esc(trialDaysOf(gd, app.teamId)) + '" data-field="trialDays"><p class="gs-field-error" id="dlg-err-trialDays" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Accept</button></div></form>';
  }

  function notesDialogHtml(app) {
    return '<form class="gs-dialog-form" data-submit="app-notes-form" data-apid="' + esc(app.id) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">Notes on ' + esc(app.name) + '</h2>' +
      '<div class="gs-field"><label class="gs-label" for="an-notes">Officer notes</label><textarea class="gs-input gs-textarea" id="an-notes" name="notes" rows="6" maxlength="' + NOTES_MAX + '" data-field="notes">' + esc(app.notes || '') + '</textarea>' +
      '<p class="gs-fine">Only officers see these notes.</p><p class="gs-field-error" id="dlg-err-notes" role="alert" hidden></p></div><p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save</button></div></form>';
  }

  function deleteDialogHtml(app) {
    return '<form class="gs-dialog-form" data-submit="app-delete-form" data-apid="' + esc(app.id) + '"><h2 class="gs-dialog-title" id="dlg-title">Delete this application?</h2>' +
      '<p class="gs-fine" id="dlg-text">The application of ' + esc(app.name) + ' is removed for good.' + (app.status === 'accepted' ? ' The person made from it stays on the roster.' : '') + '</p><p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Delete</button></div></form>';
  }

  // ── handlers ──
  function cur() {
    const x = a().applications;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id && x.data ? { x: x, gd: gd } : null;
  }

  function appOf(c, apid) {
    return (c.x.data.applications || []).filter(function (item) { return item.id === apid; })[0] || null;
  }

  G.handlers.click['apps-filter'] = function (el) {
    const c = cur();
    if (!c) return;
    const seg = el.getAttribute('data-filter');
    if (!SEGMENTS.some(function (f) { return f[0] === seg; })) return;
    c.x.seg = seg;
    c.x.note = '';
    G.app.render();
  };

  function setStatus(el, status) {
    const c = cur();
    if (!c) return;
    const app = appOf(c, el.getAttribute('data-apid'));
    if (!app) return;
    el.disabled = true;
    G.api.applications.update(c.x.gid, app.id, { status: status }).then(function () {
      c.x.note = status === 'declined' ? app.name + ' was declined.' : app.name + ' is under review.';
      G.app.refreshGuild(c.x.gid);
      return reload(c.x);
    }).then(function () { G.app.render(); }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  }
  G.handlers.click['app-status-reviewing'] = function (el) { setStatus(el, 'reviewing'); };
  G.handlers.click['app-status-declined'] = function (el) { setStatus(el, 'declined'); };

  G.handlers.click['app-accept'] = function (el) {
    const c = cur();
    const app = c ? appOf(c, el.getAttribute('data-apid')) : null;
    if (app) G.ui.openDialog(acceptDialogHtml(c.gd, app), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };
  // One click: the application's own team and that team's trial length (the Worker's defaults).
  G.handlers.click['app-accept-trial'] = function (el) {
    const c = cur();
    const app = c ? appOf(c, el.getAttribute('data-apid')) : null;
    if (!app) return;
    el.disabled = true;
    G.api.applications.accept(c.x.gid, app.id, { teamId: app.teamId }).then(function (res) {
      acceptedNote(c, app, res);
      return reload(c.x);
    }).then(function () { G.app.render(); }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };
  G.handlers.click['app-notes'] = function (el) {
    const c = cur();
    const app = c ? appOf(c, el.getAttribute('data-apid')) : null;
    if (app) G.ui.openDialog(notesDialogHtml(app), { labelledBy: 'dlg-title' });
  };
  G.handlers.click['app-delete'] = function (el) {
    const c = cur();
    const app = c ? appOf(c, el.getAttribute('data-apid')) : null;
    if (app) G.ui.openDialog(deleteDialogHtml(app), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  function acceptedNote(c, app, res) {
    c.x.note = app.name + ' joined on Trial' + (res.person && res.person.trialEnd ? ' until ' + G.ui.formatDay(res.person.trialEnd) : '') + '.' +
      (res.accountLinked ? ' Their account is linked.' : res.accountSkipped ? ' Their account already belongs to a person of this guild, so it was not linked.' : '');
    G.app.refreshGuild(c.x.gid);
    if (G.pages.recruiting && G.pages.recruiting.refresh) G.pages.recruiting.refresh();
  }

  G.handlers.submit['app-accept-form'] = function (form) {
    const c = cur();
    const app = c ? appOf(c, form.getAttribute('data-apid')) : null;
    if (!app) return;
    const days = Number(form.elements.trialDays.value);
    if (!isFinite(days) || days < 1 || days > 90 || Math.floor(days) !== days) { G.ui.setText('dlg-err-trialDays', 'The trial is 1 to 90 days.'); return; }
    G.ui.runDialog(form, G.api.applications.accept(c.x.gid, app.id, { teamId: form.elements.teamId.value, trialDays: days }), function (res) {
      acceptedNote(c, app, res);
      reload(c.x).then(function () { G.app.render(); }, function () { G.app.render(); });
    });
  };

  G.handlers.submit['app-notes-form'] = function (form) {
    const c = cur();
    const app = c ? appOf(c, form.getAttribute('data-apid')) : null;
    if (!app) return;
    const notes = String(form.elements.notes.value || '');
    if (Array.from(notes).length > NOTES_MAX) { G.ui.setText('dlg-err-notes', 'Notes are at most ' + NOTES_MAX + ' characters.'); return; }
    G.ui.runDialog(form, G.api.applications.update(c.x.gid, app.id, { notes: notes }), function () {
      c.x.note = 'Notes saved.';
      reload(c.x).then(function () { G.app.render(); }, function () { G.app.render(); });
    });
  };

  G.handlers.submit['app-delete-form'] = function (form) {
    const c = cur();
    const app = c ? appOf(c, form.getAttribute('data-apid')) : null;
    if (!app) return;
    G.ui.runDialog(form, G.api.applications.remove(c.x.gid, app.id), function () {
      c.x.note = 'The application was deleted.';
      reload(c.x).then(function () { G.app.render(); }, function () { G.app.render(); });
    });
  };

  G.pages.applications = {
    SEGMENTS: SEGMENTS, countFor: countFor, load: load, sectionHtml: sectionHtml, itemHtml: itemHtml, trialDaysOf: trialDaysOf,
    acceptDialogHtml: acceptDialogHtml, notesDialogHtml: notesDialogHtml, deleteDialogHtml: deleteDialogHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
