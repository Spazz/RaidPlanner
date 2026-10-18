// ── PAGE: ROSTER > APPLICATIONS (the inbox) ─────────────────────
// What people sent through the guild's apply page (#/apply/:gid), for officers and team leads (roster.edit): a list with New / Reviewing / Accepted /
// Declined, each application's character, answers and contact, notes the officers write, and the decisions. Accept makes a person on Trial (14 days
// unless the officer says otherwise) whose Main is the applicant's character on the chosen team, and links the applicant's account when they signed in.
// GET /applications?status=&team=, PATCH /applications/:apid, POST /applications/:apid/accept, DELETE /applications/:apid. The switch and the
// questions are Guild settings > Applications (pages-settings-applications.js).
(function (G) {
  'use strict';

  const FILTERS = [['open', 'Open'], ['new', 'New'], ['reviewing', 'Reviewing'], ['accepted', 'Accepted'], ['declined', 'Declined'], ['all', 'All']];
  const STATUS_LABELS = { new: 'New', reviewing: 'Reviewing', accepted: 'Accepted', declined: 'Declined' };
  const STATUS_KIND = { new: 'info', reviewing: 'warn', accepted: 'ok', declined: 'muted' };
  const NOTES_MAX = 2000;

  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function countFor(counts, filter) {
    const c = counts || {};
    if (filter === 'open') return (c.new || 0) + (c.reviewing || 0);
    if (filter === 'all') return (c.new || 0) + (c.reviewing || 0) + (c.accepted || 0) + (c.declined || 0);
    return c[filter] || 0;
  }

  // ── data ──
  function load(r, gd) {
    const gid = gd.guild.id;
    const prev = a().applications;
    const filter = prev && prev.gid === gid ? prev.filter : 'open';
    return G.api.applications.list(gid, filter === 'all' ? null : filter, null).then(function (data) {
      a().applications = { gid: gid, filter: filter, data: data, note: '' };
      return null;
    });
  }

  function reload(x) {
    return G.api.applications.list(x.gid, x.filter === 'all' ? null : x.filter, null).then(function (data) { x.data = data; return data; });
  }

  // ── the page ──
  function answersHtml(answers) {
    const list = Array.isArray(answers) ? answers : [];
    if (!list.length) return '';
    return '<dl class="gs-app-answers">' + list.map(function (item) {
      return '<dt>' + esc(item.label) + '</dt><dd>' + esc(item.answer).replace(/\n/g, '<br>') + '</dd>';
    }).join('') + '</dl>';
  }

  function actionsHtml(app) {
    const attrs = ' data-apid="' + esc(app.id) + '"';
    const btn = function (action, label, extra) {
      return '<button type="button" class="gs-btn gs-btn-sm' + (extra || '') + '" data-action="' + action + '"' + attrs + ' data-key="' + action + '-' + esc(app.id) + '" aria-label="' + esc(label + ': ' + app.name) + '">' + esc(label) + '</button>';
    };
    const open = app.status === 'new' || app.status === 'reviewing';
    return '<div class="gs-row-actions">' +
      (open ? btn('app-accept', 'Accept', ' gs-btn-molten') : '') +
      (app.status === 'new' ? btn('app-status-reviewing', 'Mark reviewing') : '') +
      (open ? btn('app-status-declined', 'Decline') : '') +
      (app.status === 'declined' ? btn('app-status-reviewing', 'Reopen') : '') +
      btn('app-notes', app.notes ? 'Edit notes' : 'Add notes') + btn('app-delete', 'Delete') + '</div>';
  }

  function itemHtml(gd, app, showTeam) {
    const meta = [];
    if (showTeam) meta.push('Wants ' + app.teamName);
    if (app.realm) meta.push(app.realm);
    meta.push('Sent ' + G.ui.formatDateTime(app.createdAt, G.ui.guildZone()));
    if (app.applicant) meta.push('Signed in as ' + app.applicant.displayName);
    return '<li class="gs-app-item" id="app-' + esc(app.id) + '"><div class="gs-app-head"><span class="gs-app-who">' + G.ui.classNameHtml(app.name, app.class) +
      ' <span class="gs-fine">' + esc(G.ui.className(app.class) + (app.spec ? ' - ' + app.spec : '')) + '</span></span>' +
      '<span class="gs-pill gs-pill-' + STATUS_KIND[app.status] + '">' + esc(STATUS_LABELS[app.status]) + '</span></div>' +
      '<p class="gs-fine">' + esc(meta.join(' - ')) + '</p>' +
      (app.contact ? '<p class="gs-app-contact">Contact: ' + esc(app.contact) + '</p>' : '') +
      (app.onRoster ? '<p class="gs-notice gs-app-onroster" role="status"><span>' + esc(app.name) + ' is on the roster already, as a character of <a href="' + esc(G.router.format({ name: 'person', gid: gd.guild.id, pid: app.onRoster.personId })) + '">' + esc(app.onRoster.name) + '</a>.</span></p>' : '') +
      answersHtml(app.answers) +
      (app.notes ? '<p class="gs-app-notes"><span class="gs-fine">Officer notes</span><br>' + esc(app.notes).replace(/\n/g, '<br>') + '</p>' : '') +
      (app.status === 'accepted' && app.personId ? '<p class="gs-fine"><a href="' + esc(G.router.format({ name: 'person', gid: gd.guild.id, pid: app.personId })) + '">Open the person</a></p>' : '') +
      actionsHtml(app) + '</li>';
  }

  function filtersHtml(x) {
    return '<div class="gs-segs" role="group" aria-label="Filter applications">' + FILTERS.map(function (f) {
      return '<button type="button" class="gs-seg" data-action="apps-filter" data-filter="' + f[0] + '" data-key="apps-' + f[0] + '" aria-pressed="' + (x.filter === f[0] ? 'true' : 'false') + '">' +
        esc(f[1]) + ' <span class="gs-seg-count">' + esc(countFor(x.data.counts, f[0])) + '</span></button>';
    }).join('') + '</div>';
  }

  // opts: { guildData, state: a().applications, alert }
  function applicationsHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const list = Array.isArray(x.data.applications) ? x.data.applications : [];
    const showTeam = G.shell.activeTeams(gd.teams).length > 1;
    const head = G.pages.rosterTabs.headHtml(gd, 'applications', gd.guild.name);
    const canSettings = G.shell.hasAction(gd.me && gd.me.can, 'guild.teams');
    const settingsLink = canSettings ? ' <a href="' + esc(G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'applications' })) + '">Applications settings</a>' : '';
    const empty = x.filter === 'open' && !countFor(x.data.counts, 'all')
      ? '<p class="gs-empty">No applications yet.' + settingsLink + '</p>'
      : '<p class="gs-empty">Nothing in this list.</p>';
    return '<div class="gs-page">' + head + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '') +
      '<div class="gs-roster-filters">' + filtersHtml(x) + '</div>' +
      (list.length ? '<ul class="gs-app-list" aria-label="Applications">' + list.map(function (app) { return itemHtml(gd, app, showTeam); }).join('') + '</ul>' : empty) + '</div>';
  }

  function main(r, gd) {
    const x = a().applications;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return applicationsHtml({ guildData: gd, state: x, alert: G.app.state.pageAlert });
  }

  // ── dialogs ──
  function acceptDialogHtml(gd, app) {
    const teams = G.shell.activeTeams(gd.teams).filter(function (t) { return G.shell.allowsTeam(gd.me && gd.me.can, 'roster.edit', t.id); });
    return '<form class="gs-dialog-form" data-submit="app-accept-form" data-apid="' + esc(app.id) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">Accept ' + esc(app.name) + '</h2>' +
      '<p class="gs-fine" id="dlg-text">' + esc(app.name) + ' joins the roster on Trial with ' + esc(G.ui.className(app.class)) + (app.spec ? ' ' + esc(app.spec) : '') + ' as their Main.' + (app.applicant ? ' Their account is linked to them.' : '') + '</p>' +
      '<div class="gs-field"><label class="gs-label" for="aa-team">Team</label><select class="gs-input" id="aa-team" name="teamId" data-field="teamId">' + G.ui.optionsHtml(teams.map(function (t) { return { value: t.id, label: t.name }; }), app.teamId) + '</select><p class="gs-field-error" id="dlg-err-teamId" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="aa-days">Trial length (days)</label><input class="gs-input gs-input-num" type="number" inputmode="numeric" min="1" max="90" step="1" id="aa-days" name="trialDays" value="14" data-field="trialDays"><p class="gs-field-error" id="dlg-err-trialDays" role="alert" hidden></p></div>' +
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
    const filter = el.getAttribute('data-filter');
    if (!FILTERS.some(function (f) { return f[0] === filter; })) return;
    c.x.filter = filter;
    c.x.note = '';
    reload(c.x).then(function () { G.app.render(); }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  };

  function setStatus(el, status) {
    const c = cur();
    if (!c) return;
    const app = appOf(c, el.getAttribute('data-apid'));
    if (!app) return;
    el.disabled = true;
    G.api.applications.update(c.x.gid, app.id, { status: status }).then(function () {
      c.x.note = status === 'declined' ? app.name + ' was declined.' : app.name + ' is back in the open list.';
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

  G.handlers.submit['app-accept-form'] = function (form) {
    const c = cur();
    const app = c ? appOf(c, form.getAttribute('data-apid')) : null;
    if (!app) return;
    const days = Number(form.elements.trialDays.value);
    if (!isFinite(days) || days < 1 || days > 90 || Math.floor(days) !== days) { G.ui.setText('dlg-err-trialDays', 'The trial is 1 to 90 days.'); return; }
    G.ui.runDialog(form, G.api.applications.accept(c.x.gid, app.id, { teamId: form.elements.teamId.value, trialDays: days }), function (res) {
      c.x.note = app.name + ' joined on Trial' + (res.person && res.person.trialEnd ? ' until ' + G.ui.formatDay(res.person.trialEnd) : '') + '.' +
        (res.accountLinked ? ' Their account is linked.' : res.accountSkipped ? ' Their account already belongs to a person of this guild, so it was not linked.' : '');
      G.app.refreshGuild(c.x.gid);
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
    FILTERS: FILTERS, countFor: countFor, load: load, main: main, applicationsHtml: applicationsHtml, itemHtml: itemHtml,
    acceptDialogHtml: acceptDialogHtml, notesDialogHtml: notesDialogHtml, deleteDialogHtml: deleteDialogHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
