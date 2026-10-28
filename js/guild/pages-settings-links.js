// ── PAGE: GUILD SETTINGS > LINKS AND KEYS ──────────────────────
// One settings page (template T3) for every link or key that opens the guild's data without a sign-in: API keys (read-only CSV / JSON links for a spreadsheet or a
// script), guest links (a read-only view for someone without an account) and raid join links (a guest signs up to one raid). It replaced Guest links and Data access.
// For whoever holds guild.access. GET / POST /api/guild/:gid/api-keys, DELETE .../api-keys/:keyId; GET / POST /api/guild/:gid/guest-links, DELETE .../guest-links/:linkId;
// GET /api/guild/:gid/join-links (the guild's, every link of a raid that has not started, whoever made it) and DELETE .../join-links/:jid. Anyone with guild.access turns
// off any link or key. A join link is made on its raid (pages-raid-extras.js), so this page has no New button for it.
// The token of a key or guest link comes back once, from the create call: it is shown in a dialog and kept nowhere else. The lists never have it.
// State: G.app.state.linksSettings = { gid, keys: GET /api-keys, guests: GET /guest-links, joins: GET /join-links, notice }.
// Rows: three groups on one slim grid (Link, Opens, Used, Ends); a status chip after the name (Turned off, Full, Expired; a working link shows none, design spec 2.3);
// below 600 px the table is the Roster's phone list (line 1 name and chip, line 2 what it opens, used and ends, Turn off in the row).
(function (G) {
  'use strict';

  const esc = G.ui.esc;
  const plural = G.ui.plural;
  const DOT = ' \u00b7 ';

  // ── API keys ──
  const KEY_EXPIRY_LABELS = { '30d': '30 days', '90d': '90 days', '365d': '365 days', never: 'Never' };
  const KEY_DEFAULT_EXPIRY = '90d';
  const KEY_NAME_LENGTH = 40;
  const DATASET_LABELS = { roster: 'Roster', attendance: 'Attendance', loot: 'Loot', raids: 'Raids' };
  const DATASET_HELP = {
    roster: 'Characters with class, role, spec and status.',
    attendance: 'Each person\'s attendance percentage, raids counted and streak.',
    loot: 'Who got which item, by date.',
    raids: 'Raid dates, zones, bosses killed and who came.',
  };
  const KEY_INTRO = 'An API key opens read-only links to your roster, attendance, loot and raids, for a spreadsheet or a script. It reads what a member can see: no officer notes, no Discord or account data.';

  // ── guest links ──
  const SECTION_LABELS = { roster: 'Roster', raids: 'Raids', attendance: 'Attendance', loot: 'Loot' };
  const GUEST_EXPIRY_LABELS = { '1d': '1 day', '7d': '7 days', '30d': '30 days', never: 'Never' };
  const GUEST_DEFAULT_EXPIRY = '7d';
  const GUEST_LABEL_LENGTH = 40;
  const GUEST_INTRO = 'A guest link lets someone without an account read part of the guild. It never lets them change anything.';

  // A working link or key shows no chip; the others say why they do not work. 'started' (the raid began) never reaches the guild list: the Worker leaves those links out.
  const CHIPS = { revoked: { text: 'Turned off', cls: 'is-grey' }, full: { text: 'Full', cls: 'is-grey' }, expired: { text: 'Expired', cls: 'is-rose' } };

  function st() { return G.app.state; }
  function xs() { return st().linksSettings; }
  function listOf(v) { return Array.isArray(v) ? v : []; }
  function itemsOf(data, name) { return data && Array.isArray(data[name]) ? data[name] : []; }
  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function find(list, id) { return list.filter(function (item) { return item.id === id; })[0]; }
  function zoneOf(opts) {
    const gd = opts && opts.guildData;
    return (gd && gd.guild && typeof gd.guild.timeZone === 'string' && gd.guild.timeZone) || G.ui.guildZone();
  }

  // ── times: short dates in the guild's zone, the year only when it is not the current one ("Oct 27", "Jan 24, 2027") ──
  function shortDate(ms, f) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    const now = f && typeof f.now === 'number' ? f.now : Date.now();
    const zone = f && f.zone ? { timeZone: f.zone } : {};
    const attempt = function (extra) {
      const year = function (t) { return new Date(t).toLocaleDateString('en-US', Object.assign({ year: 'numeric' }, extra)); };
      return new Date(ms).toLocaleDateString('en-US', Object.assign({ month: 'short', day: 'numeric' }, year(ms) !== year(now) ? { year: 'numeric' } : {}, extra));
    };
    try { return attempt(zone); } catch (e) { /* a zone this browser does not know: the viewer's own */ }
    try { return attempt({}); } catch (e) { return ''; }
  }

  function personName(p) { return p && (p.displayName || p.username) || ''; }
  function madeLine(createdAt, by, f) {
    const who = personName(by);
    return 'Made ' + shortDate(createdAt, f) + (who ? ' by ' + who : '');
  }

  function chipHtml(status) {
    if (status === 'active') return '';
    const c = has(CHIPS, status) ? CHIPS[status] : { text: String(status), cls: 'is-grey' };
    return '<span class="gs-hd-chip ' + c.cls + '">' + esc(c.text) + '</span>';
  }

  // ── row models: one shape for the three kinds, so the table and the phone list draw them the same way ──
  //   { id, name, status, made, opens: [line 1, line 2], used, ends: [line 1, (line 2)], endsPhone, off: { action, attrs, label } | null, sort: { link, opens, used, ends } }
  // Ends: a link or key that works says when it stops; an expired one when it did; a turned-off one when it was turned off.
  function endsOf(item, f) {
    if (item.status === 'revoked') return { text: shortDate(item.revokedAt, f), phone: 'turned off ' + shortDate(item.revokedAt, f), at: item.revokedAt };
    if (item.status === 'expired') return { text: shortDate(item.expiresAt, f), phone: 'ended ' + shortDate(item.expiresAt, f), at: item.expiresAt };
    if (typeof item.expiresAt === 'number') return { text: shortDate(item.expiresAt, f), phone: 'ends ' + shortDate(item.expiresAt, f), at: item.expiresAt };
    return { text: 'Never', phone: 'never ends', at: null };
  }

  function datasetsText(datasets) {
    const names = listOf(datasets).map(function (d) { return has(DATASET_LABELS, d) ? DATASET_LABELS[d] : String(d); });
    return names.length ? names.join(', ') : 'Nothing';
  }

  function sectionsText(sections) {
    const names = listOf(sections).map(function (s) { return has(SECTION_LABELS, s) ? SECTION_LABELS[s] : String(s); });
    return names.length ? names.join(', ') : 'Nothing yet';
  }

  function guestTitle(link) { return link.label || 'Untitled'; }

  function keyModel(k, f) {
    const n = Number(k.uses) || 0;
    const ends = endsOf(k, f);
    const reads = k.team ? k.team.name : 'Whole guild';
    return {
      id: k.id, name: k.name, status: k.status, made: madeLine(k.createdAt, k.createdBy, f),
      opens: [reads, datasetsText(k.datasets)],
      used: n === 0 ? 'Never used' : plural(n, 'use', 'uses') + (k.lastUsedAt ? DOT + 'last ' + shortDate(k.lastUsedAt, f) : ''),
      ends: [ends.text], endsPhone: ends.phone,
      off: k.status === 'active' ? { action: 'lk-key-off', attrs: { 'data-key-id': k.id }, label: 'Turn off key ' + k.name } : null,
      sort: { link: k.name, opens: reads, used: n, ends: ends.at },
    };
  }

  function guestModel(l, f) {
    const n = Number(l.uses) || 0;
    const ends = endsOf(l, f);
    const shows = (l.role && l.role.name ? l.role.name + ', ' : '') + (l.team ? l.team.name + ' only' : 'whole guild');
    return {
      id: l.id, name: guestTitle(l), status: l.status, made: madeLine(l.createdAt, l.createdBy, f),
      opens: [shows, sectionsText(l.sections)],
      used: n === 0 ? 'Never opened' : plural(n, 'open', 'opens') + (l.lastUsedAt ? DOT + 'last ' + shortDate(l.lastUsedAt, f) : ''),
      ends: [ends.text], endsPhone: ends.phone,
      off: l.status === 'active' ? { action: 'lk-guest-off', attrs: { 'data-link': l.id }, label: 'Turn off guest link ' + guestTitle(l) } : null,
      sort: { link: guestTitle(l), opens: shows, used: n, ends: ends.at },
    };
  }

  function joinName(l) { const raid = l.raid || {}; return raid.title || raid.zone || 'Raid'; }

  // A join link ends when its raid starts (the Worker leaves the links of raids that have begun out of the list).
  function joinModel(l, f) {
    const raid = l.raid || {};
    const day = shortDate(raid.startsAt, f);
    const time = G.ui.timeInZone(raid.startsAt, f.zone);
    return {
      id: l.id, name: joinName(l), status: l.status, made: madeLine(l.createdAt, l.createdBy, f),
      opens: ['Guest sign-up', raid.teamName || ''],
      used: (Number(l.uses) || 0) + ' of ' + plural(Number(l.maxUses) || 0, 'sign-up', 'sign-ups'),
      ends: time ? [day, time] : [day], endsPhone: 'ends ' + day + (time ? ' ' + time : ''),
      off: l.status === 'active' ? { action: 'lk-join-off', attrs: { 'data-join-id': l.id }, label: 'Turn off sign-up link ' + joinName(l) } : null,
      sort: { link: joinName(l), opens: raid.teamName || '', used: Number(l.uses) || 0, ends: raid.startsAt },
    };
  }

  const SORTERS = {
    link: function (m) { return m.sort.link; },
    opens: function (m) { return m.sort.opens; },
    used: function (m) { return m.sort.used; },
    ends: function (m) { return m.sort.ends; },
  };

  // ── the groups ──
  function offButtonHtml(m) {
    if (!m.off) return '';
    const attrs = Object.assign({ 'data-action': m.off.action, 'data-key': m.off.action + '-' + m.id, 'aria-label': m.off.label }, m.off.attrs);
    return '<button type="button" class="gs-btn gs-btn-ghost"' + G.ui.attrsHtml(attrs) + '>Turn off</button>';
  }

  function linesHtml(lines) {
    return lines.length > 1 ? lines.filter(Boolean).map(function (t, i) { return '<span class="' + (i ? 'gs-fine' : 'gs-lk-l1') + '">' + esc(t) + '</span>'; }).join('') : esc(lines[0]);
  }

  function rowHtml(m) {
    return '<tr><th scope="row" class="gs-cell-strong"><span class="gs-lk-name"><span class="gs-lk-title">' + esc(m.name) + '</span>' + chipHtml(m.status) + '</span><span class="gs-fine">' + esc(m.made) + '</span></th>' +
      '<td>' + linesHtml(m.opens) + '</td><td>' + esc(m.used) + '</td><td>' + linesHtml(m.ends) + '</td><td><div class="gs-row-actions">' + offButtonHtml(m) + '</div></td></tr>';
  }

  function phoneRowHtml(m) {
    return '<div class="gs-rs-row gs-lk-row"><span class="gs-rs-id"><span class="gs-lk-l1row"><span class="gs-rs-name">' + esc(m.name) + '</span>' + chipHtml(m.status) + '</span>' +
      '<span class="gs-rs-sub">' + esc(m.opens.filter(Boolean).join(', ') + DOT + m.used + DOT + m.endsPhone) + '</span></span>' + offButtonHtml(m) + '</div>';
  }

  // g: { id, title, tableKey, openLabel, models, button (html), empty (text) }
  function groupHtml(g) {
    const headId = 'lk-h-' + g.id;
    const head = '<div class="gs-lk-head"><h3 class="gs-fg-gh" id="' + headId + '"><span class="gs-fg-ght">' + esc(g.title) + '</span><span class="gs-fg-ghn">' + g.models.length + '</span></h3>' + (g.button || '') + '</div>';
    if (!g.models.length) return '<section class="gs-lk-group" aria-labelledby="' + headId + '">' + head + '<p class="gs-empty gs-hd-panel" id="lk-' + g.id + '-empty">' + esc(g.empty) + '</p></section>';
    const rows = G.ui.sortItems(g.tableKey, g.models, SORTERS);
    const heads = G.ui.sortThHtml(g.tableKey, 'link', 'Link') + G.ui.sortThHtml(g.tableKey, 'opens', g.openLabel) + G.ui.sortThHtml(g.tableKey, 'used', 'Used') + G.ui.sortThHtml(g.tableKey, 'ends', 'Ends') +
      '<th scope="col"><span class="gs-sr">Actions</span></th>';
    return '<section class="gs-lk-group" aria-labelledby="' + headId + '">' + head +
      '<div class="gs-rs-desk"><div class="gs-table-wrap gs-hd-panel"><table class="gs-table gs-table-links" aria-label="' + esc(g.title) + '"><thead><tr>' + heads + '</tr></thead><tbody>' + rows.map(rowHtml).join('') + '</tbody></table></div></div>' +
      '<div class="gs-rs-phone"><section class="gs-hd-panel gs-rs-plist" aria-label="' + esc(g.title) + '">' + rows.map(phoneRowHtml).join('') + '</section></div></section>';
  }

  function newButtonHtml(label, action) { return G.ui.buttonHtml({ label: label, variant: 'secondary', attrs: { 'data-action': action, 'data-key': action } }); }

  // opts: { guildData, data ({ keys, guests, joins }: the three answers, or null while they load), alert, notice, now }
  function settingsHtml(opts) {
    const o = opts || {};
    const d = o.data;
    const f = { zone: zoneOf(o), now: o.now };
    const body = !d ? G.ui.settingsLoadingHtml()
      : '<div class="gs-lk">' +
        groupHtml({ id: 'keys', title: 'API keys', tableKey: 'lk-keys', openLabel: 'Reads', models: itemsOf(d.keys, 'keys').map(function (k) { return keyModel(k, f); }), button: newButtonHtml('New key', 'lk-key-new'), empty: 'No API keys yet.' }) +
        groupHtml({ id: 'guests', title: 'Guest links', tableKey: 'lk-guests', openLabel: 'Shows', models: itemsOf(d.guests, 'links').map(function (l) { return guestModel(l, f); }), button: newButtonHtml('New guest link', 'lk-guest-new'), empty: 'No guest links yet.' }) +
        groupHtml({ id: 'joins', title: 'Raid join links', tableKey: 'lk-joins', openLabel: 'Opens', models: itemsOf(d.joins, 'links').map(function (l) { return joinModel(l, f); }), empty: 'No raid join links yet. Make one from a raid.' }) + '</div>';
    return '<section class="gs-section" aria-labelledby="settings-title">' +
      (o.notice ? '<div class="gs-notice" role="status"><span>' + esc(o.notice) + '</span></div>' : '') +
      G.ui.alertHtml(o.alert || '', 'gs-page-alert') + body + '</section>';
  }

  // ── dialogs ──
  function fieldErrorHtml(name) { return '<p class="gs-field-error" id="dlg-err-' + name + '" role="alert" hidden></p>'; }
  function teamItems(guildData) { return [{ value: '', label: 'Whole guild' }].concat(G.shell.activeTeams(guildData && guildData.teams).map(function (t) { return { value: t.id, label: t.name }; })); }

  // data: the GET /api-keys answer; guildData: the guild (its active teams are the team choices).
  function keyCreateDialogHtml(data, guildData) {
    const d = data || {};
    const expiries = listOf(d.expiries).length ? d.expiries : Object.keys(KEY_EXPIRY_LABELS);
    const expiryItems = expiries.map(function (e) { return { value: e, label: has(KEY_EXPIRY_LABELS, e) ? KEY_EXPIRY_LABELS[e] : String(e) }; });
    const perHour = d.limits && d.limits.perHour;
    const checks = listOf(d.datasets).map(function (ds, i) {
      const id = 'dlg-key-ds-' + i;
      const help = ds.available ? (DATASET_HELP[ds.id] || '') : 'Members cannot see this in your guild, so a key cannot read it.';
      return '<div class="gs-check"><input type="checkbox" id="' + id + '" name="datasets" value="' + esc(ds.id) + '"' + (ds.available ? ' checked' : ' disabled') + ' data-key="' + id + '">' +
        '<label for="' + id + '">' + esc(ds.label || DATASET_LABELS[ds.id] || ds.id) + '</label><p class="gs-fine gs-public-why">' + esc(help) + '</p></div>';
    }).join('');
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings" data-submit="lk-key-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">New API key</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(KEY_INTRO) + ' The key is shown once, right after you make it. Turn it off at any time and it stops working at once.' + (perHour ? ' Each key can be used ' + esc(String(perHour)) + ' times an hour.' : '') + '</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-key-name">Name</label><input class="gs-input" type="text" id="dlg-key-name" name="name" maxlength="' + KEY_NAME_LENGTH + '" autocomplete="off" data-field="name">' +
      '<p class="gs-fine">Only officers see it. For example: Loot sheet, or Attendance for the website.</p>' + fieldErrorHtml('name') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-key-team">Reads</label><select class="gs-input" id="dlg-key-team" name="teamId" data-field="teamId">' + G.ui.optionsHtml(teamItems(guildData), '') + '</select>' + fieldErrorHtml('teamId') + '</div>' +
      '<fieldset class="gs-fieldset"><legend class="gs-legend">What it reads</legend><div class="gs-radios">' + checks + '</div>' + fieldErrorHtml('datasets') + '</fieldset>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-key-expiry">Works for</label><select class="gs-input" id="dlg-key-expiry" name="expiresIn" data-field="expiresIn">' +
      G.ui.optionsHtml(expiryItems, expiries.indexOf(KEY_DEFAULT_EXPIRY) >= 0 ? KEY_DEFAULT_EXPIRY : expiries[0]) + '</select>' + fieldErrorHtml('expiresIn') + '</div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Make key</button></div></form>';
  }

  // The links built from the key, for each dataset it reads: the CSV address (Google Sheets: =IMPORTDATA("...")) and the JSON address (send the key as a header).
  function keyLinksFor(origin, token, datasets) {
    return listOf(datasets).map(function (id) {
      return { id: id, label: DATASET_LABELS[id] || id, csv: origin + '/api/v1/' + id + '.csv?key=' + token, json: origin + '/api/v1/' + id + '.json' };
    });
  }

  // origin + token: the only place the token is ever drawn.
  function keyCreatedDialogHtml(origin, token, datasets) {
    const rows = keyLinksFor(origin, token, datasets).map(function (l, i) {
      return '<div class="gs-field"><label class="gs-label" for="key-csv-' + i + '">' + esc(l.label) + ' (CSV link for Google Sheets)</label>' +
        '<div class="gs-copy-row"><input class="gs-input gs-code" type="text" id="key-csv-' + i + '" readonly autocomplete="off" spellcheck="false" value="' + esc(l.csv) + '">' +
        '<button type="button" class="gs-btn" data-action="lk-key-copy" data-target="key-csv-' + i + '" data-key="lk-key-copy-csv-' + i + '">Copy link</button></div>' +
        '<p class="gs-fine">In a sheet: <code>=IMPORTDATA("link")</code>. JSON: <code>' + esc(l.json) + '</code> with the header <code>Authorization: Bearer key</code>.</p></div>';
    }).join('');
    return '<div class="gs-dialog-form gs-forge gs-dialog-settings">' +
      '<h2 class="gs-dialog-title" id="dlg-title">API key made</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-help">Copy it now. It is shown only once.</p>' +
      '<div class="gs-field"><label class="gs-label" for="key-token">Key</label><div class="gs-copy-row"><input class="gs-input gs-code" type="text" id="key-token" readonly autocomplete="off" spellcheck="false" value="' + esc(token) + '">' +
      '<button type="button" class="gs-btn" data-action="lk-key-copy" data-target="key-token" data-key="lk-key-copy-token">Copy key</button></div>' +
      '<p class="gs-fine" id="key-copy-status" role="status"></p></div>' + rows +
      '<p class="gs-fine">Keep the links private: anyone with a link can read this data until you turn the key off.</p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="dialog-cancel">Done</button></div></div>';
  }

  function keyRevokeDialogHtml(key) {
    const k = key || {};
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings" data-submit="lk-key-off-form" data-key-id="' + esc(k.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Turn off this key?</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Every sheet or script using <strong>' + esc(k.name) + '</strong> stops getting data at once. It cannot be turned back on: make a new key instead.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Keep it on</button><button type="submit" class="gs-btn gs-btn-danger">Turn off</button></div></form>';
  }

  // data: the GET /guest-links answer; guildData: the guild (its active teams are the team choices).
  function guestCreateDialogHtml(data, guildData) {
    const d = data || {};
    const roleItems = listOf(d.roles).map(function (r) { return { value: r.id, label: r.name + ' - Shows: ' + (listOf(r.sections).length ? sectionsText(r.sections) : 'nothing yet') }; });
    const expiries = listOf(d.expiries).length ? d.expiries : Object.keys(GUEST_EXPIRY_LABELS);
    const expiryItems = expiries.map(function (e) { return { value: e, label: has(GUEST_EXPIRY_LABELS, e) ? GUEST_EXPIRY_LABELS[e] : String(e) }; });
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings" data-submit="lk-guest-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">New guest link</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(GUEST_INTRO) + ' The address is shown once, right after you make it. Turn it off at any time and it stops working at once.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-role">Role</label><select class="gs-input" id="dlg-guest-role" name="roleId" data-field="roleId">' +
      G.ui.optionsHtml(roleItems, 'guest') + '</select>' + fieldErrorHtml('roleId') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-team">Team</label><select class="gs-input" id="dlg-guest-team" name="teamId" data-field="teamId">' +
      G.ui.optionsHtml(teamItems(guildData), '') + '</select>' + fieldErrorHtml('teamId') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-expiry">Works for</label><select class="gs-input" id="dlg-guest-expiry" name="expiresIn" data-field="expiresIn">' +
      G.ui.optionsHtml(expiryItems, expiries.indexOf(GUEST_DEFAULT_EXPIRY) >= 0 ? GUEST_DEFAULT_EXPIRY : expiries[0]) + '</select>' + fieldErrorHtml('expiresIn') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-guest-label">Label (optional)</label><input class="gs-input" type="text" id="dlg-guest-label" name="label" maxlength="' + GUEST_LABEL_LENGTH + '" autocomplete="off" data-field="label">' +
      '<p class="gs-fine">Only officers see it. For example: Recruits, or Visitors from the other guild.</p>' + fieldErrorHtml('label') + '</div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Make link</button></div></form>';
  }

  // url: the full address (origin + the path the Worker sent). It is the only place the token is ever drawn.
  function guestCreatedDialogHtml(url) {
    return '<div class="gs-dialog-form gs-forge gs-dialog-settings">' +
      '<h2 class="gs-dialog-title" id="dlg-title">Guest link made</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-help">Copy it now. It is shown only once.</p>' +
      '<div class="gs-field"><label class="gs-label" for="guest-url">Guest link</label>' +
      '<input class="gs-input gs-code" type="text" id="guest-url" readonly autocomplete="off" spellcheck="false" value="' + esc(url) + '">' +
      '<p class="gs-fine" id="guest-copy-status" role="status"></p></div>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="lk-guest-copy" data-key="lk-guest-copy">Copy link</button>' +
      '<button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Done</button></div></div>';
  }

  function guestRevokeDialogHtml(link) {
    const l = link || {};
    return '<form class="gs-dialog-form gs-forge gs-dialog-settings" data-submit="lk-guest-off-form" data-link="' + esc(l.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Turn off this guest link?</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Anyone using <strong>' + esc(guestTitle(l)) + '</strong> loses access at once. It cannot be turned back on: make a new link instead.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Keep it on</button><button type="submit" class="gs-btn gs-btn-danger">Turn off</button></div></form>';
  }

  // What turning a join link off does (worker/routes/join.js revokeGuildJoinLink, findWorkingLink): the link answers 410 link_revoked to a visitor, and the guests who already signed up
  // (raid_signups) are left on the raid. `uses` counts the sign-ups made through the link.
  function joinRevokeDialogHtml(link) {
    const l = link || {};
    const uses = Number(l.uses) || 0;
    const kept = uses === 1 ? ' The guest who already signed up stays on the raid.' : (uses > 1 ? ' The ' + uses + ' guests who already signed up stay on the raid.' : '');
    return G.ui.dialogHtml({
      kind: 'confirm', title: 'Turn off this sign-up link?', className: 'gs-forge',
      text: 'Anyone who opens the link for ' + joinName(l) + ' sees that it no longer works.' + kept + ' It cannot be turned back on: make a new link on the raid instead.',
      primary: { label: 'Turn off', variant: 'danger' }, formAttrs: { 'data-submit': 'lk-join-off-form', 'data-join-id': l.id },
    });
  }

  // ── reading ──
  // r: the route ({ gid }) or the guild id. Three reads at once; a failed one fails the page (the route's catch shows it).
  function load(r) {
    const gid = typeof r === 'string' ? r : r.gid;
    return Promise.all([G.api.dataKeys.list(gid), G.api.guests.list(gid), G.api.joinLinks.guildList(gid)]).then(function (got) {
      st().linksSettings = { gid: gid, keys: got[0], guests: got[1], joins: got[2], notice: '' };
      return null;
    });
  }

  function main(r, gd, ctx) {
    const x = xs();
    if (!x || x.gid !== gd.guild.id) return G.ui.settingsLoadingHtml();
    return G.shell.settingsFrameHtml(ctx, 'links', settingsHtml({ guildData: gd, data: x, alert: st().pageAlert, notice: x.notice }));
  }

  // ── behaviour ──
  function openCreate(html) { G.ui.openDialog(html, { labelledBy: 'dlg-title', describedBy: 'dlg-help' }); }

  G.handlers.click['lk-key-new'] = function () {
    const x = xs();
    if (!x || !x.keys) return;
    openCreate(keyCreateDialogHtml(x.keys, st().guilds ? st().guilds[x.gid] : null));
  };

  G.handlers.click['lk-guest-new'] = function () {
    const x = xs();
    if (!x || !x.guests) return;
    openCreate(guestCreateDialogHtml(x.guests, st().guilds ? st().guilds[x.gid] : null));
  };

  // The turn-off questions open for a link or key that still works, and for nothing else.
  G.handlers.click['lk-key-off'] = function (el) {
    const x = xs();
    const key = x && find(itemsOf(x.keys, 'keys'), el.getAttribute('data-key-id'));
    if (!key || key.status !== 'active') return;
    G.ui.openDialog(keyRevokeDialogHtml(key), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.click['lk-guest-off'] = function (el) {
    const x = xs();
    const link = x && find(itemsOf(x.guests, 'links'), el.getAttribute('data-link'));
    if (!link || link.status !== 'active') return;
    G.ui.openDialog(guestRevokeDialogHtml(link), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.click['lk-join-off'] = function (el) {
    const x = xs();
    const link = x && find(itemsOf(x.joins, 'links'), el.getAttribute('data-join-id'));
    if (!link || link.status !== 'active') return;
    G.ui.openDialog(joinRevokeDialogHtml(link), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.click['lk-key-copy'] = function (el) {
    G.ui.copyInput(document.getElementById(el.getAttribute('data-target'))).then(function (copied) {
      G.ui.setText('key-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected text.');
    });
  };

  G.handlers.click['lk-guest-copy'] = function () {
    G.ui.copyInput(document.getElementById('guest-url')).then(function (copied) {
      G.ui.setText('guest-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected link.');
    });
  };

  // The answer of a create or a turn-off replaces what the page holds for that kind (the list the Worker sent, without the token), says so, and redraws.
  function adopt(gid, field, list, notice) {
    const x = xs();
    if (x && x.gid === gid) { x[field] = list; x.notice = notice; }
    st().pageAlert = '';
    G.app.render();
  }

  function withoutCreated(res) {
    const list = Object.assign({}, res);
    delete list.created;
    return list;
  }

  G.handlers.submit['lk-key-form'] = function (form) {
    const x = xs();
    if (!x || !x.keys) return;
    ['dlg-err-name', 'dlg-err-teamId', 'dlg-err-datasets', 'dlg-err-expiresIn', 'dlg-error'].forEach(function (id) { G.ui.setText(id, ''); });
    const boxes = form.querySelectorAll('input[name="datasets"]');
    const datasets = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return b.value; });
    const body = { name: form.elements.name.value.trim(), teamId: form.elements.teamId.value || null, datasets: datasets, expiresIn: form.elements.expiresIn.value };
    G.ui.runDialog(form, G.api.dataKeys.create(x.gid, body), function (res) {
      const created = res && res.created && typeof res.created.token === 'string' ? res.created : null;
      adopt(x.gid, 'keys', withoutCreated(res), 'API key made.');
      if (!created) return;
      openCreate(keyCreatedDialogHtml(G.ui.pageOrigin(), created.token, datasets));
      const input = document.getElementById('key-token');
      if (input && input.select) input.select();
    });
  };

  G.handlers.submit['lk-guest-form'] = function (form) {
    const x = xs();
    if (!x || !x.guests) return;
    ['dlg-err-roleId', 'dlg-err-teamId', 'dlg-err-expiresIn', 'dlg-err-label', 'dlg-error'].forEach(function (id) { G.ui.setText(id, ''); });
    const body = { roleId: form.elements.roleId.value, teamId: form.elements.teamId.value || null, expiresIn: form.elements.expiresIn.value };
    const label = form.elements.label.value.trim();
    if (label) body.label = label;
    G.ui.runDialog(form, G.api.guests.create(x.gid, body), function (res) {
      const created = res && res.created && typeof res.created.path === 'string' ? res.created : null;
      adopt(x.gid, 'guests', withoutCreated(res), 'Guest link made.');
      if (!created) return;
      openCreate(guestCreatedDialogHtml(G.ui.pageOrigin() + created.path));
      const input = document.getElementById('guest-url');
      if (input && input.select) input.select();
    });
  };

  G.handlers.submit['lk-key-off-form'] = function (form) {
    const x = xs();
    if (!x || !x.keys) return;
    const id = form.getAttribute('data-key-id');
    const key = find(itemsOf(x.keys, 'keys'), id);
    G.ui.runDialog(form, G.api.dataKeys.revoke(x.gid, id), function (res) { adopt(x.gid, 'keys', res, 'Turned off ' + (key ? key.name : 'the key') + '.'); });
  };

  G.handlers.submit['lk-guest-off-form'] = function (form) {
    const x = xs();
    if (!x || !x.guests) return;
    const id = form.getAttribute('data-link');
    const link = find(itemsOf(x.guests, 'links'), id);
    G.ui.runDialog(form, G.api.guests.revoke(x.gid, id), function (res) { adopt(x.gid, 'guests', res, 'Turned off ' + (link ? guestTitle(link) : 'the guest link') + '.'); });
  };

  G.handlers.submit['lk-join-off-form'] = function (form) {
    const x = xs();
    if (!x || !x.joins) return;
    const id = form.getAttribute('data-join-id');
    const link = find(itemsOf(x.joins, 'links'), id);
    G.ui.runDialog(form, G.api.joinLinks.guildRevoke(x.gid, id), function (res) { adopt(x.gid, 'joins', res, 'Turned off the sign-up link' + (link ? ' for ' + joinName(link) : '') + '.'); });
  };

  G.pages.settingsLinks = {
    KEY_EXPIRY_LABELS: KEY_EXPIRY_LABELS,
    DATASET_LABELS: DATASET_LABELS,
    SECTION_LABELS: SECTION_LABELS,
    GUEST_EXPIRY_LABELS: GUEST_EXPIRY_LABELS,
    shortDate: shortDate,
    settingsHtml: settingsHtml,
    keyCreateDialogHtml: keyCreateDialogHtml,
    keyCreatedDialogHtml: keyCreatedDialogHtml,
    keyRevokeDialogHtml: keyRevokeDialogHtml,
    keyLinksFor: keyLinksFor,
    guestCreateDialogHtml: guestCreateDialogHtml,
    guestCreatedDialogHtml: guestCreatedDialogHtml,
    guestRevokeDialogHtml: guestRevokeDialogHtml,
    joinRevokeDialogHtml: joinRevokeDialogHtml,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
