// -- PAGE: GUILD SETTINGS > DATA ACCESS --------------------------
// A data key opens CSV and JSON links to a team's (or the guild's) roster, attendance, loot and raids, read-only, for a spreadsheet (Google Sheets
// IMPORTDATA) or a script. A key reads what a member of its scope can read, minus notes and Discord / account data. Officers make keys (a name, a team or the
// whole guild, the datasets, an expiry) and turn them off. GET / POST /api/guild/:gid/api-keys, DELETE .../api-keys/:keyId. Needs guild.access.
// The token comes back once, from the create call: it is shown in a dialog with the links built from it and kept nowhere else. The list never has it.
(function (G) {
  'use strict';

  const EXPIRY_LABELS = { '30d': '30 days', '90d': '90 days', '365d': '365 days', never: 'Never' };
  const DEFAULT_EXPIRY = '90d';
  const NAME_LENGTH = 40;
  const DATASET_LABELS = { roster: 'Roster', attendance: 'Attendance', loot: 'Loot', raids: 'Raids' };
  const DATASET_HELP = {
    roster: 'Characters with class, role, spec and status.',
    attendance: 'Each person\'s attendance percentage, raids counted and streak.',
    loot: 'Who got which item, by date.',
    raids: 'Raid dates, zones, bosses killed and who came.',
  };
  const STATUS = { active: { text: 'Active', cls: 'gs-pill-ok' }, expired: { text: 'Expired', cls: 'gs-pill-warn' }, revoked: { text: 'Turned off', cls: 'gs-pill-muted' } };
  const INTRO = 'A data key opens read-only links to your roster, attendance, loot and raids, for a spreadsheet or a script. It reads what a member can see: no officer notes, no Discord or account data.';

  function st() { return G.app.state; }
  function xs() { return st().dataKeySettings; }
  function listOf(v) { return Array.isArray(v) ? v : []; }
  function keysOf(data) { return data && Array.isArray(data.keys) ? data.keys : []; }

  function datasetsText(datasets) {
    const names = listOf(datasets).map(function (d) { return Object.prototype.hasOwnProperty.call(DATASET_LABELS, d) ? DATASET_LABELS[d] : String(d); });
    return names.length ? names.join(', ') : 'Nothing';
  }

  function statusPillHtml(key) {
    const s = Object.prototype.hasOwnProperty.call(STATUS, key.status) ? STATUS[key.status] : { text: String(key.status), cls: 'gs-pill-muted' };
    return '<span class="gs-pill ' + s.cls + '">' + esc(s.text) + '</span>';
  }

  function usedText(key) {
    const n = Number(key.uses) || 0;
    return n === 0 ? 'Never used' : 'Used ' + G.ui.plural(n, 'time', 'times');
  }

  function endsText(key) {
    if (key.status === 'revoked') return 'Turned off ' + G.ui.formatDate(key.revokedAt);
    if (key.status === 'expired') return 'Expired ' + G.ui.formatDate(key.expiresAt);
    return typeof key.expiresAt === 'number' ? 'Expires ' + G.ui.formatDate(key.expiresAt) : 'Never expires';
  }

  function madeByText(key) {
    const by = key.createdBy && (key.createdBy.displayName || key.createdBy.username);
    return 'Made ' + G.ui.formatDate(key.createdAt) + (by ? ' by ' + by : '');
  }

  function offButtonHtml(key) {
    if (key.status !== 'active') return '';
    return '<button type="button" class="gs-btn gs-btn-sm gs-btn-danger-text" data-action="dkey-revoke" data-key-id="' + esc(key.id) + '" data-key="dkey-off-' + esc(key.id) + '" aria-label="Turn off key ' + esc(key.name) + '">Turn off</button>';
  }

  function keyRowHtml(key) {
    return '<tr><th scope="row" class="gs-cell-strong"><span class="gs-guest-title">' + esc(key.name) + '</span><span class="gs-fine gs-guest-by">' + esc(madeByText(key)) + '</span></th>' +
      '<td data-label="Reads"><span class="gs-guest-role">' + esc(key.team ? key.team.name : 'Whole guild') + '</span><span class="gs-fine gs-guest-sections">' + esc(datasetsText(key.datasets)) + '</span></td>' +
      '<td data-label="Status">' + statusPillHtml(key) + '</td>' +
      '<td data-label="Used">' + esc(usedText(key)) + (key.lastUsedAt ? '<span class="gs-fine gs-guest-last">Last used ' + esc(G.ui.formatDateTime(key.lastUsedAt, G.ui.guildZone())) + '</span>' : '') + '</td>' +
      '<td data-label="Ends">' + esc(endsText(key)) + '</td>' +
      '<td><div class="gs-row-actions">' + offButtonHtml(key) + '</div></td></tr>';
  }

  // opts: { guildData, data (GET /api-keys or null), alert, notice }
  function settingsHtml(opts) {
    const d = opts.data;
    let body;
    let head = '';
    if (!d) {
      body = G.pages.signin.loadingHtml();
    } else {
      head = '<button type="button" class="gs-btn gs-btn-molten" data-action="dkey-new" data-key="dkey-new">New key</button>';
      const keys = keysOf(d);
      const limits = d.limits || {};
      body = '<p class="gs-fine" id="dkeys-intro">' + esc(INTRO) + ' The key is shown once, when you make it. Turn a key off at any time and it stops working at once.' +
        (limits.perHour ? ' Each key can be used ' + esc(String(limits.perHour)) + ' times an hour.' : '') + '</p>' +
        (keys.length
          ? '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-guests" aria-label="Data keys"><thead><tr><th scope="col">Key</th><th scope="col">Reads</th><th scope="col">Status</th><th scope="col">Used</th><th scope="col">Ends</th>' +
            '<th scope="col"><span class="gs-sr">Actions</span></th></tr></thead><tbody>' + keys.map(keyRowHtml).join('') + '</tbody></table></div>'
          : '<p class="gs-empty" id="dkeys-empty">No data keys yet.</p>');
    }
    return '<section class="gs-section" aria-labelledby="dkeys-set-h"><div class="gs-section-head"><h2 class="gs-h2" id="dkeys-set-h">Data access</h2>' + head + '</div>' +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + body + '</section>';
  }

  // -- dialogs --
  function fieldErrorHtml(name) { return '<p class="gs-field-error" id="dlg-err-' + name + '" role="alert" hidden></p>'; }

  // data: the GET /api-keys answer; guildData: the guild (its active teams are the team choices).
  function createDialogHtml(data, guildData) {
    const d = data || {};
    const expiries = listOf(d.expiries).length ? d.expiries : Object.keys(EXPIRY_LABELS);
    const expiryItems = expiries.map(function (e) { return { value: e, label: Object.prototype.hasOwnProperty.call(EXPIRY_LABELS, e) ? EXPIRY_LABELS[e] : String(e) }; });
    const teamItems = [{ value: '', label: 'Whole guild' }].concat(G.shell.activeTeams(guildData && guildData.teams).map(function (t) { return { value: t.id, label: t.name }; }));
    const datasets = listOf(d.datasets);
    const checks = datasets.map(function (ds, i) {
      const id = 'dlg-dkey-ds-' + i;
      const help = ds.available ? (DATASET_HELP[ds.id] || '') : 'Members cannot see this in your guild, so a key cannot read it.';
      return '<div class="gs-check"><input type="checkbox" id="' + id + '" name="datasets" value="' + esc(ds.id) + '"' + (ds.available ? ' checked' : ' disabled') + ' data-key="' + id + '">' +
        '<label for="' + id + '">' + esc(ds.label || DATASET_LABELS[ds.id] || ds.id) + '</label><p class="gs-fine gs-public-why">' + esc(help) + '</p></div>';
    }).join('');
    return '<form class="gs-dialog-form" data-submit="dkey-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">New data key</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(INTRO) + ' The key is shown once, right after you make it.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-dkey-name">Name</label><input class="gs-input" type="text" id="dlg-dkey-name" name="name" maxlength="' + NAME_LENGTH + '" autocomplete="off" data-field="name">' +
      '<p class="gs-fine">Only officers see it. For example: Loot sheet, or Attendance for the website.</p>' + fieldErrorHtml('name') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-dkey-team">Reads</label><select class="gs-input" id="dlg-dkey-team" name="teamId" data-field="teamId">' + G.ui.optionsHtml(teamItems, '') + '</select>' + fieldErrorHtml('teamId') + '</div>' +
      '<fieldset class="gs-fieldset"><legend class="gs-legend">What it reads</legend><div class="gs-radios">' + checks + '</div>' + fieldErrorHtml('datasets') + '</fieldset>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-dkey-expiry">Works for</label><select class="gs-input" id="dlg-dkey-expiry" name="expiresIn" data-field="expiresIn">' +
      G.ui.optionsHtml(expiryItems, expiries.indexOf(DEFAULT_EXPIRY) >= 0 ? DEFAULT_EXPIRY : expiries[0]) + '</select>' + fieldErrorHtml('expiresIn') + '</div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Make key</button></div></form>';
  }

  // The links built from the key, for each dataset it reads: the CSV address (Google Sheets: =IMPORTDATA("...")) and the JSON address (send the key as a header).
  function linksFor(origin, token, datasets) {
    return listOf(datasets).map(function (id) {
      return { id: id, label: DATASET_LABELS[id] || id, csv: origin + '/api/v1/' + id + '.csv?key=' + token, json: origin + '/api/v1/' + id + '.json' };
    });
  }

  // origin + token: the only place the token is ever drawn.
  function createdDialogHtml(origin, token, datasets) {
    const links = linksFor(origin, token, datasets);
    const rows = links.map(function (l, i) {
      return '<div class="gs-field"><label class="gs-label" for="dkey-csv-' + i + '">' + esc(l.label) + ' (CSV link for Google Sheets)</label>' +
        '<div class="gs-copy-row"><input class="gs-input gs-code" type="text" id="dkey-csv-' + i + '" readonly autocomplete="off" spellcheck="false" value="' + esc(l.csv) + '">' +
        '<button type="button" class="gs-btn gs-btn-sm" data-action="dkey-copy" data-target="dkey-csv-' + i + '" data-key="dkey-copy-csv-' + i + '">Copy link</button></div>' +
        '<p class="gs-fine">In a sheet: <code>=IMPORTDATA("link")</code>. JSON: <code>' + esc(l.json) + '</code> with the header <code>Authorization: Bearer key</code>.</p></div>';
    }).join('');
    return '<div class="gs-dialog-form">' +
      '<h2 class="gs-dialog-title" id="dlg-title">Data key made</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-help">Copy it now. It is shown only once.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dkey-token">Key</label><div class="gs-copy-row"><input class="gs-input gs-code" type="text" id="dkey-token" readonly autocomplete="off" spellcheck="false" value="' + esc(token) + '">' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="dkey-copy" data-target="dkey-token" data-key="dkey-copy-token">Copy key</button></div>' +
      '<p class="gs-fine" id="dkey-copy-status" role="status"></p></div>' + rows +
      '<p class="gs-fine">Keep the links private: anyone with a link can read this data until you turn the key off.</p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="dialog-cancel">Done</button></div></div>';
  }

  function revokeDialogHtml(key) {
    const k = key || {};
    return '<form class="gs-dialog-form" data-submit="dkey-revoke-form" data-key-id="' + esc(k.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Turn off this key?</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Every sheet or script using <strong>' + esc(k.name) + '</strong> stops getting data at once. It cannot be turned back on: make a new key instead.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Keep it on</button><button type="submit" class="gs-btn gs-btn-danger">Turn off</button></div></form>';
  }

  function load(gid) {
    return G.api.dataKeys.list(gid).then(function (data) {
      st().dataKeySettings = { gid: gid, data: data, notice: '' };
      return data;
    });
  }

  // -- behaviour --
  G.handlers.click['dkey-new'] = function () {
    const x = xs();
    if (!x || !x.data) return;
    const gd = st().guilds ? st().guilds[x.gid] : null;
    G.ui.openDialog(createDialogHtml(x.data, gd), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.click['dkey-revoke'] = function (el) {
    const x = xs();
    if (!x || !x.data) return;
    const id = el.getAttribute('data-key-id');
    const key = keysOf(x.data).filter(function (k) { return k.id === id; })[0];
    if (!key || key.status !== 'active') return;
    G.ui.openDialog(revokeDialogHtml(key), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.click['dkey-copy'] = function (el) {
    const input = document.getElementById(el.getAttribute('data-target'));
    G.ui.copyInput(input).then(function (copied) {
      G.ui.setText('dkey-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected text.');
    });
  };

  // The new key: the list replaces the page's data (without the token), then the dialog with the links opens.
  function afterCreate(gid, res, datasets) {
    const created = res && res.created && typeof res.created.token === 'string' ? res.created : null;
    const list = Object.assign({}, res);
    delete list.created;
    const x = xs();
    if (x && x.gid === gid) { x.data = list; x.notice = 'Data key made.'; }
    st().pageAlert = '';
    G.app.render();
    if (!created) return;
    G.ui.openDialog(createdDialogHtml(G.ui.pageOrigin(), created.token, datasets), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    const input = document.getElementById('dkey-token');
    if (input && input.select) input.select();
  }

  G.handlers.submit['dkey-form'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    ['dlg-err-name', 'dlg-err-teamId', 'dlg-err-datasets', 'dlg-err-expiresIn', 'dlg-error'].forEach(function (id) { G.ui.setText(id, ''); });
    const boxes = form.querySelectorAll('input[name="datasets"]');
    const datasets = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return b.value; });
    const body = { name: form.elements.name.value.trim(), teamId: form.elements.teamId.value || null, datasets: datasets, expiresIn: form.elements.expiresIn.value };
    G.ui.runDialog(form, G.api.dataKeys.create(x.gid, body), function (res) { afterCreate(x.gid, res, datasets); });
  };

  G.handlers.submit['dkey-revoke-form'] = function (form) {
    const x = xs();
    if (!x || !x.data) return;
    const id = form.getAttribute('data-key-id');
    const key = keysOf(x.data).filter(function (k) { return k.id === id; })[0];
    G.ui.runDialog(form, G.api.dataKeys.revoke(x.gid, id), function (res) {
      const cur = xs();
      if (cur && cur.gid === x.gid) { cur.data = res; cur.notice = 'Turned off ' + (key ? key.name : 'the key') + '.'; }
      st().pageAlert = '';
      G.app.render();
    });
  };

  G.pages.settingsDataKeys = {
    EXPIRY_LABELS: EXPIRY_LABELS,
    DATASET_LABELS: DATASET_LABELS,
    INTRO: INTRO,
    settingsHtml: settingsHtml,
    createDialogHtml: createDialogHtml,
    createdDialogHtml: createdDialogHtml,
    revokeDialogHtml: revokeDialogHtml,
    linksFor: linksFor,
    load: load,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
