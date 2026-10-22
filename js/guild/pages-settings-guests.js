// -- PAGE: GUILD SETTINGS > GUEST LINKS --------------------------
// A guest link lets someone without an account read part of the guild, read-only. Officers make links (a role, a team or the whole guild, an expiry) and
// turn them off. GET / POST /api/guild/:gid/guest-links, DELETE .../guest-links/:linkId. Needs guild.access.
// The token comes back once, from the create call: it is shown in a dialog (as a full address to copy) and kept nowhere else. The list never has it.
(function (G) {
  'use strict';

  const SECTION_LABELS = { roster: 'Roster', raids: 'Raids', attendance: 'Attendance', loot: 'Loot' };
  const EXPIRY_LABELS = { '1d': '1 day', '7d': '7 days', '30d': '30 days', never: 'Never' };
  const DEFAULT_EXPIRY = '7d';
  const LABEL_LENGTH = 40;
  const STATUS = { active: { text: 'Active', cls: 'is-green' }, expired: { text: 'Expired', cls: 'is-rose' }, revoked: { text: 'Turned off', cls: 'is-grey' } };
  const INTRO = 'A guest link lets someone without an account read part of the guild. It never lets them change anything.';

  function st() { return G.app.state; }
  function xs() { return st().guestSettings; }
  function listOf(v) { return Array.isArray(v) ? v : []; }
  function linksOf(data) { return data && Array.isArray(data.links) ? data.links : []; }

  function sectionsText(sections) {
    const names = listOf(sections).map(function (s) { return Object.prototype.hasOwnProperty.call(SECTION_LABELS, s) ? SECTION_LABELS[s] : String(s); });
    return names.length ? 'Shows: ' + names.join(', ') : 'Shows: nothing yet';
  }

  function statusPillHtml(link) {
    const s = Object.prototype.hasOwnProperty.call(STATUS, link.status) ? STATUS[link.status] : { text: String(link.status), cls: 'is-grey' };
    return '<span class="gs-hd-chip ' + s.cls + '">' + esc(s.text) + '</span>';
  }

  function usedText(link) {
    const n = Number(link.uses) || 0;
    return n === 0 ? 'Never opened' : 'Opened ' + G.ui.plural(n, 'time', 'times');
  }

  function lastUsedText(link) {
    const when = G.ui.formatDateTime(link.lastUsedAt, G.ui.guildZone());
    return when ? 'Last opened ' + when : '';
  }

  // Active: when it ends. Expired / turned off: when it did.
  function endsText(link) {
    if (link.status === 'revoked') return 'Turned off ' + G.ui.formatDate(link.revokedAt);
    if (link.status === 'expired') return 'Expired ' + G.ui.formatDate(link.expiresAt);
    return typeof link.expiresAt === 'number' ? 'Expires ' + G.ui.formatDate(link.expiresAt) : 'Never expires';
  }

  function titleOf(link) { return link.label || 'Untitled'; }

  function madeByText(link) {
    const by = link.createdBy && (link.createdBy.displayName || link.createdBy.username);
    return 'Made ' + G.ui.formatDate(link.createdAt) + (by ? ' by ' + by : '');
  }

  function offButtonHtml(link) {
    if (link.status !== 'active') return '';
    return '<button type="button" class="gs-btn gs-btn-ghost" data-action="guest-revoke" data-link="' + esc(link.id) + '" data-key="guest-off-' + esc(link.id) + '" aria-label="Turn off guest link ' + esc(titleOf(link)) + '">Turn off</button>';
  }

  function linkRowHtml(link) {
    return '<tr><th scope="row" class="gs-cell-strong"><span class="gs-guest-title">' + esc(titleOf(link)) + '</span><span class="gs-fine gs-guest-by">' + esc(madeByText(link)) + '</span></th>' +
      '<td data-label="Shows"><span class="gs-guest-role">' + esc(link.role && link.role.name) + '</span>' +
      '<span class="gs-fine gs-guest-team">' + esc(link.team ? link.team.name + ' only' : 'Whole guild') + '</span>' +
      '<span class="gs-fine gs-guest-sections">' + esc(sectionsText(link.sections)) + '</span></td>' +
      '<td data-label="Status">' + statusPillHtml(link) + '</td>' +
      '<td data-label="Used">' + esc(usedText(link)) + (lastUsedText(link) ? '<span class="gs-fine gs-guest-last">' + esc(lastUsedText(link)) + '</span>' : '') + '</td>' +
      '<td data-label="Ends">' + esc(endsText(link)) + '</td>' +
      '<td><div class="gs-row-actions">' + offButtonHtml(link) + '</div></td></tr>';
  }

  // opts: { guildData, data (GET /guest-links or null), alert, notice }
  function settingsHtml(opts) {
    const d = opts.data;
    let body;
    let head = '';
    if (!d) {
      body = G.ui.settingsLoadingHtml();
    } else {
      head = '<button type="button" class="gs-btn gs-btn-molten" data-action="guest-new" data-key="guest-new">New guest link</button>';
      const links = linksOf(d);
      body = '<p class="gs-fine" id="guests-intro">' + esc(INTRO) + ' The address is shown once, when you make it. Turn a link off at any time and it stops working at once.</p>' +
        (links.length
          ? '<div class="gs-table-wrap gs-hd-panel"><table class="gs-table gs-table-stack gs-table-guests" aria-label="Guest links"><thead><tr><th scope="col">Link</th><th scope="col">Shows</th><th scope="col">Status</th><th scope="col">Used</th><th scope="col">Ends</th>' +
            '<th scope="col"><span class="gs-sr">Actions</span></th></tr></thead><tbody>' + links.map(linkRowHtml).join('') + '</tbody></table></div>'
          : '<p class="gs-empty gs-hd-panel" id="guests-empty">No guest links yet.</p>');
    }
    return '<section class="gs-section" aria-labelledby="settings-title"><div class="gs-section-head gs-section-head-actions">' + head + '</div>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  // -- dialogs --
  function fieldErrorHtml(name) { return '<p class="gs-field-error" id="dlg-err-' + name + '" role="alert" hidden></p>'; }

  // data: the GET /guest-links answer; guildData: the guild (its active teams are the team choices).
  function createDialogHtml(data, guildData) {
    const d = data || {};
    const roleItems = listOf(d.roles).map(function (r) {
      return { value: r.id, label: r.name + ' - ' + sectionsText(r.sections) };
    });
    const expiries = listOf(d.expiries).length ? d.expiries : Object.keys(EXPIRY_LABELS);
    const expiryItems = expiries.map(function (e) { return { value: e, label: Object.prototype.hasOwnProperty.call(EXPIRY_LABELS, e) ? EXPIRY_LABELS[e] : String(e) }; });
    const teamItems = [{ value: '', label: 'Whole guild' }].concat(G.shell.activeTeams(guildData && guildData.teams).map(function (t) { return { value: t.id, label: t.name }; }));
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings" data-submit="guest-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">New guest link</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(INTRO) + ' The address is shown once, right after you make it.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-role">Role</label><select class="gs-input" id="dlg-guest-role" name="roleId" data-field="roleId">' +
      G.ui.optionsHtml(roleItems, 'guest') + '</select>' + fieldErrorHtml('roleId') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-team">Team</label><select class="gs-input" id="dlg-guest-team" name="teamId" data-field="teamId">' +
      G.ui.optionsHtml(teamItems, '') + '</select>' + fieldErrorHtml('teamId') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-expiry">Works for</label><select class="gs-input" id="dlg-guest-expiry" name="expiresIn" data-field="expiresIn">' +
      G.ui.optionsHtml(expiryItems, expiries.indexOf(DEFAULT_EXPIRY) >= 0 ? DEFAULT_EXPIRY : expiries[0]) + '</select>' + fieldErrorHtml('expiresIn') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-label">Label (optional)</label><input class="gs-input" type="text" id="dlg-guest-label" name="label" maxlength="' + LABEL_LENGTH + '" autocomplete="off" data-field="label">' +
      '<p class="gs-fine">Only officers see it. For example: Recruits, or Visitors from the other guild.</p>' + fieldErrorHtml('label') + '</div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Make link</button></div></form>';
  }

  // url: the full address (origin + the path the Worker sent). It is the only place the token is ever drawn.
  function createdDialogHtml(url) {
    return '<div class="gs-dialog-form gs-forge gs-dialog-settings">' +
      '<h2 class="gs-dialog-title" id="dlg-title">Guest link made</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-help">Copy it now. It is shown only once.</p>' +
      '<div class="gs-field"><label class="gs-label" for="guest-url">Guest link</label>' +
      '<input class="gs-input gs-code" type="text" id="guest-url" readonly autocomplete="off" spellcheck="false" value="' + esc(url) + '">' +
      '<p class="gs-fine" id="guest-copy-status" role="status"></p></div>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="guest-copy" data-key="guest-copy">Copy link</button>' +
      '<button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Done</button></div></div>';
  }

  function revokeDialogHtml(link) {
    const l = link || {};
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings" data-submit="guest-revoke-form" data-link="' + esc(l.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Turn off this guest link?</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Anyone using <strong>' + esc(titleOf(l)) + '</strong> loses access at once. It cannot be turned back on: make a new link instead.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Keep it on</button><button type="submit" class="gs-btn gs-btn-danger">Turn off</button></div></form>';
  }

  function load(gid) {
    return G.api.guests.list(gid).then(function (data) {
      st().guestSettings = { gid: gid, data: data, notice: '' };
      return data;
    });
  }

  // -- behaviour --
  G.handlers.click['guest-new'] = function () {
    const x = xs();
    if (!x || !x.data) return;
    const gd = st().guilds ? st().guilds[x.gid] : null;
    G.ui.openDialog(createDialogHtml(x.data, gd), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.click['guest-revoke'] = function (el) {
    const x = xs();
    if (!x || !x.data) return;
    const id = el.getAttribute('data-link');
    const link = linksOf(x.data).filter(function (l) { return l.id === id; })[0];
    if (!link || link.status !== 'active') return;
    G.ui.openDialog(revokeDialogHtml(link), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.click['guest-copy'] = function () {
    const input = document.getElementById('guest-url');
    G.ui.copyInput(input).then(function (copied) {
      G.ui.setText('guest-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected link.');
    });
  };

  // The new link: the list replaces the page's data (without the token), then the dialog with the address opens.
  function afterCreate(gid, res) {
    const created = res && res.created && typeof res.created.path === 'string' ? res.created : null;
    const list = Object.assign({}, res);
    delete list.created;
    const x = xs();
    if (x && x.gid === gid) { x.data = list; x.notice = 'Guest link made.'; }
    st().pageAlert = '';
    G.app.render();
    if (!created) return;
    G.ui.openDialog(createdDialogHtml(G.ui.pageOrigin() + created.path), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    const input = document.getElementById('guest-url');
    if (input && input.select) input.select();
  }

  G.handlers.submit['guest-form'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    ['dlg-err-roleId', 'dlg-err-teamId', 'dlg-err-expiresIn', 'dlg-err-label', 'dlg-error'].forEach(function (id) { G.ui.setText(id, ''); });
    const body = { roleId: form.elements.roleId.value, teamId: form.elements.teamId.value || null, expiresIn: form.elements.expiresIn.value };
    const label = form.elements.label.value.trim();
    if (label) body.label = label;
    G.ui.runDialog(form, G.api.guests.create(x.gid, body), function (res) { afterCreate(x.gid, res); });
  };

  G.handlers.submit['guest-revoke-form'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    const id = form.getAttribute('data-link');
    const link = linksOf(x.data).filter(function (l) { return l.id === id; })[0];
    G.ui.runDialog(form, G.api.guests.revoke(x.gid, id), function (res) {
      const cur = xs();
      if (cur && cur.gid === x.gid) { cur.data = res; cur.notice = 'Turned off ' + (link ? titleOf(link) : 'the guest link') + '.'; }
      st().pageAlert = '';
      G.app.render();
    });
  };

  G.pages.settingsGuests = {
    SECTION_LABELS: SECTION_LABELS,
    EXPIRY_LABELS: EXPIRY_LABELS,
    INTRO: INTRO,
    settingsHtml: settingsHtml,
    createDialogHtml: createDialogHtml,
    createdDialogHtml: createdDialogHtml,
    revokeDialogHtml: revokeDialogHtml,
    load: load,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
