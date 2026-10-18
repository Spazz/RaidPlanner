// ── PAGES: IMPORT FROM RAID-HELPER, IMPORT FROM WARCRAFT LOGS ───
// Two preview-then-commit pages. The Raid-Helper page turns sign-ups into people (an editable Main name, Alt
// suggestions from the nickname, people already on the roster in a collapsed section, an other-server confirm).
// The Warcraft Logs page adds characters from a report (a decision per unknown name). The Worker never gets a
// Discord ID from the browser: a Raid-Helper commit names rows by `signupId` only.
// Pure parts: rhInitRows, rhCounts, rhCommitBody, wclInitChoices, wclCounts, wclCommitBody, and the *Html builders.
(function (G) {
  'use strict';

  const SHOW_FIRST = 8;
  const START_STATUSES = ['raider', 'trial', 'reserve'];
  const OTHER_SERVER_CONFIRM = 'This event is from a different Discord server. Import anyway?';
  const MAIN_NOTES = {
    tentative: 'Tentative sign-up',
    absence: 'Absence: the sign-up has no class',
    late: 'Late sign-up',
    bench: 'Bench sign-up',
    no_class: 'The sign-up has no class',
  };

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function rosterHref(gid) { return G.router.format({ name: 'section', gid: gid, section: 'roster' }); }
  function sid(row) { return String(row.signupId); }

  // ── Raid-Helper: pure state helpers ──
  // One UI record per row: the Main name box, the class picker (only for a sign-up without one), the tick, the Alts.
  function rhInitRows(preview) {
    const out = {};
    ((preview && preview.rows) || []).forEach(function (row) {
      out[sid(row)] = {
        ticked: !!row.ticked && !(row.main && row.main.taken),
        name: row.main && row.main.name ? row.main.name : '',
        class: row.main && row.main.class ? row.main.class : '',
        alts: (row.alts || []).map(function (a) { return { ticked: false, class: '' }; }),
      };
    });
    return out;
  }

  function isNewKind(row) { return row.kind === 'new' || row.kind === 'no_discord'; }

  // The Main's name is taken only while it still equals the suggestion the Worker marked.
  function mainTaken(row, ui) {
    return !!(row.main && row.main.taken) && ui.name.trim().toLowerCase() === String(row.main.name || '').toLowerCase();
  }

  function rowReady(row, ui) {
    return isNewKind(row) && ui.ticked && !!ui.name.trim() && !!ui.class && !mainTaken(row, ui);
  }

  function includedAlts(row, ui) {
    const alts = [];
    (row.alts || []).forEach(function (a, i) {
      const u = ui.alts[i];
      if (u && u.ticked && u.class && !a.taken) alts.push({ name: a.name, class: u.class });
    });
    return alts;
  }

  // Counts for the footer. people: rows that could be added; ready: ticked with a name and a class;
  // needs: ticked things still missing a name or class; alts: Alts that will be added.
  function rhCounts(preview, rows) {
    const out = { people: 0, ready: 0, needs: 0, needsName: false, alts: 0, altsOnRoster: 0 };
    ((preview && preview.rows) || []).forEach(function (row) {
      const ui = rows[sid(row)];
      if (!ui) return;
      if (isNewKind(row)) {
        out.people++;
        const ready = rowReady(row, ui);
        if (ready) {
          out.ready++;
          out.alts += includedAlts(row, ui).length;
        } else if (ui.ticked && !mainTaken(row, ui)) {
          out.needs++;
          if (!ui.name.trim()) out.needsName = true;
        }
        if (ui.ticked) {
          (row.alts || []).forEach(function (a, i) {
            if (ui.alts[i] && ui.alts[i].ticked && !ui.alts[i].class && !a.taken) out.needs++;
          });
        }
      } else if (row.kind === 'on_roster' && row.canAddAlts) {
        const n = includedAlts(row, ui).length;
        out.altsOnRoster += n;
        (row.alts || []).forEach(function (a, i) {
          if (ui.alts[i] && ui.alts[i].ticked && !ui.alts[i].class && !a.taken) out.needs++;
        });
      }
    });
    return out;
  }

  // The commit body, or the list of signup ids in the order sent (error `index` points into it).
  function rhCommitBody(teamId, preview, rows, defaultStatus, acceptOtherServer) {
    const sent = [];
    const body = [];
    ((preview && preview.rows) || []).forEach(function (row) {
      const ui = rows[sid(row)];
      if (!ui) return;
      if (isNewKind(row)) {
        if (!rowReady(row, ui)) return;
        body.push({
          signupId: row.signupId,
          main: { name: ui.name.trim(), class: ui.class, spec: row.main && row.main.class === ui.class ? (row.main.spec || null) : null },
          alts: includedAlts(row, ui),
        });
        sent.push(sid(row));
      } else if (row.kind === 'on_roster' && row.canAddAlts) {
        const alts = includedAlts(row, ui);
        if (!alts.length) return;
        body.push({ signupId: row.signupId, alts: alts });
        sent.push(sid(row));
      }
    });
    return { body: { teamId: teamId, eventId: preview.event.id, acceptOtherServer: !!acceptOtherServer, defaultStatus: defaultStatus, rows: body }, sent: sent };
  }

  // ── Raid-Helper: markup ──
  function rowNotes(row, ui) {
    const notes = [];
    if (row.kind === 'no_discord') notes.push('No Discord account on the sign-up');
    if (row.signedIn) notes.push('Signed in: links to their account now');
    if (row.main && row.main.note && Object.prototype.hasOwnProperty.call(MAIN_NOTES, row.main.note)) notes.push(MAIN_NOTES[row.main.note]);
    if (mainTaken(row, ui)) notes.push(row.main.taken.name ? esc(row.main.name) + ' is already ' + esc(row.main.taken.name) + '\'s character' : esc(row.main.name) + ' is already on the roster');
    return notes;
  }

  function altHtml(row, ui, i, ro, disabledAll) {
    const a = row.alts[i];
    const u = ui.alts[i];
    const id = 'rh-alt-' + sid(row) + '-' + i;
    const off = disabledAll || !!a.taken;
    const needsClass = u.ticked && !u.class && !off;
    return '<div class="gs-alt"><input type="checkbox" id="' + id + '" data-change="rh-alt-tick" data-signup="' + esc(sid(row)) + '" data-alt="' + i + '" data-key="' + id + '" aria-label="Offer ' + esc(a.name) + ' as an Alt"' + (u.ticked && !off ? ' checked' : '') + (off ? ' disabled' : '') + '>' +
      '<label for="' + id + '">' + esc(a.name) + '</label>' +
      '<select class="gs-input gs-input-sm" id="' + id + '-class" data-change="rh-alt-class" data-signup="' + esc(sid(row)) + '" data-alt="' + i + '" aria-label="Class for ' + esc(a.name) + '"' + (off ? ' disabled' : '') + (needsClass ? ' aria-invalid="true"' : '') + '>' +
      G.ui.classOptionsHtml(ro, u.class, 'Class') + '</select>' +
      (a.taken ? '<span class="gs-fine">Already ' + esc(a.taken.name) + '\'s character</span>' : '') + '</div>';
  }

  function altsCellHtml(row, ui, ro) {
    if (!row.alts || !row.alts.length) return '<span class="gs-muted">-</span>';
    return '<div class="gs-alts">' + row.alts.map(function (a, i) { return altHtml(row, ui, i, ro, false); }).join('') + '</div>';
  }

  function mainCellHtml(row, ui, ro) {
    const id = sid(row);
    const spec = row.main && row.main.class && ui.class === row.main.class ? row.main.spec : null;
    const dot = G.ui.roleDotHtml(G.ui.roleOfSpec(ro, ui.class, spec));
    const classPart = row.main && row.main.class
      ? '<span class="gs-fine">' + G.ui.specLineHtml(row.main.class, spec, null) + '</span>'
      : '<select class="gs-input gs-input-sm" id="rh-class-' + esc(id) + '" data-change="rh-class" data-signup="' + esc(id) + '" data-key="rh-class-' + esc(id) + '" aria-label="Class for ' + esc(ui.name || 'this sign-up') + '"' + (ui.ticked && !ui.class ? ' aria-invalid="true"' : '') + '>' +
        G.ui.classOptionsHtml(ro, ui.class, 'Pick a class') + '</select>';
    return '<div class="gs-main-cell">' + dot + '<div class="gs-main-fields"><input class="gs-input gs-input-sm" type="text" id="rh-name-' + esc(id) + '" data-input="rh-name" data-signup="' + esc(id) + '" data-key="rh-name-' + esc(id) + '" maxlength="40" autocomplete="off" aria-label="Main name for ' + esc(row.nickname) + '" value="' + esc(ui.name) + '">' + classPart + '</div></div>';
  }

  function newRowHtml(row, ui, ro, rowError) {
    const id = sid(row);
    const taken = mainTaken(row, ui);
    const notes = rowNotes(row, ui);
    return '<tr><td data-label="Add"><label class="gs-tick"><input type="checkbox" id="rh-add-' + esc(id) + '" data-change="rh-tick" data-signup="' + esc(id) + '" data-key="rh-add-' + esc(id) + '" aria-label="Add ' + esc(ui.name || row.nickname) + '"' + (ui.ticked && !taken ? ' checked' : '') + (taken ? ' disabled' : '') + '></label></td>' +
      '<td data-label="Discord nickname" class="gs-cell-strong">' + esc(row.nickname) + '</td><td data-label="Main">' + mainCellHtml(row, ui, ro) + '</td><td data-label="Alts from the nickname">' + altsCellHtml(row, ui, ro) + '</td>' +
      '<td data-label="Note">' + (notes.length ? notes.map(function (n) { return '<span class="gs-note-line">' + n + '</span>'; }).join('') : '') + (rowError ? '<span class="gs-note-line gs-note-error">' + esc(rowError) + '</span>' : '') + '</td></tr>';
  }

  function tableHtml(rows, state, ro) {
    const newRows = rows.filter(isNewKind);
    const shown = state.showAll ? newRows : newRows.slice(0, SHOW_FIRST);
    if (!newRows.length) return '<p class="gs-empty">No new people in this event.</p>';
    return '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-import" aria-label="Sign-ups to add"><thead><tr><th scope="col">Add</th><th scope="col">Discord nickname</th><th scope="col">Main</th><th scope="col">Alts from the nickname</th><th scope="col">Note</th></tr></thead><tbody>' +
      shown.map(function (r) { return newRowHtml(r, state.rows[sid(r)], ro, state.rowErrors && state.rowErrors[sid(r)]); }).join('') + '</tbody></table></div>' +
      (newRows.length > shown.length || state.showAll && newRows.length > SHOW_FIRST
        ? '<div class="gs-showing"><span class="gs-fine">Showing ' + shown.length + ' of ' + newRows.length + '</span><button type="button" class="gs-btn gs-btn-sm" data-action="rh-show-all" data-key="rh-show-all">' + (state.showAll ? 'Show fewer' : 'Show all') + '</button></div>'
        : '');
  }

  function onRosterHtml(gid, rows, state, ro) {
    const list = rows.filter(function (r) { return r.kind === 'on_roster'; });
    if (!list.length) return '';
    const open = !!state.foldOpen;
    return '<section class="gs-fold" aria-labelledby="rh-roster-h"><h3 class="gs-h3" id="rh-roster-h"><button type="button" class="gs-fold-btn" data-action="rh-fold" data-key="rh-fold" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="rh-roster-list">' +
      'Already on the roster (' + list.length + ')' + G.icons.icon('chevronDown', 16) + '</button></h3>' +
      '<ul class="gs-fold-list" id="rh-roster-list"' + (open ? '' : ' hidden') + '>' + list.map(function (r) {
        const ui = state.rows[sid(r)];
        const alts = r.alts && r.alts.length
          ? '<div class="gs-alts">' + r.alts.map(function (a, i) { return altHtml(r, ui, i, ro, !r.canAddAlts); }).join('') + '</div>' + (r.canAddAlts ? '' : '<p class="gs-fine">You cannot add characters to this person.</p>')
          : '<p class="gs-fine">No new Alt names in this nickname.</p>';
        const name = r.person ? '<a href="' + esc(G.router.format({ name: 'person', gid: gid, pid: r.person.id })) + '">' + esc(r.person.name) + '</a>' : esc(r.nickname);
        return '<li class="gs-fold-item"><div class="gs-fold-who"><span class="gs-cell-strong">' + name + '</span><span class="gs-fine">Nickname: ' + esc(r.nickname) + '</span></div>' + alts + '</li>';
      }).join('') + '</ul></section>';
  }

  function summaryText(counts) {
    let t = plural(counts.people, 'person', 'people') + ' &middot; ' + counts.ready + ' ready';
    if (counts.needs) t += ' &middot; ' + counts.needs + (counts.needsName ? ' need a name and class' : ' need a class') + ' before they can be added';
    return t;
  }

  function addLabel(counts, confirming) {
    if (confirming) return OTHER_SERVER_CONFIRM;
    if (counts.ready > 0) return 'Add ' + plural(counts.ready, 'person', 'people');
    if (counts.altsOnRoster > 0) return 'Add ' + plural(counts.altsOnRoster, 'Alt', 'Alts');
    return 'Add 0 people';
  }

  function footerHtml(gid, preview, state) {
    const counts = rhCounts(preview, state.rows);
    const confirming = !!(preview.event.otherServer && state.confirmOtherServer);
    const nothing = counts.ready === 0 && counts.altsOnRoster === 0;
    return '<div class="gs-import-bar" id="rh-footer"><p class="gs-import-sum" role="status">' + summaryText(counts) + '</p><div class="gs-actions"><a class="gs-btn" href="' + esc(rosterHref(gid)) + '">Cancel</a>' +
      '<button type="button" class="gs-btn gs-btn-molten" data-action="rh-commit" data-key="rh-commit"' + (nothing || state.status === 'saving' ? ' disabled' : '') + '>' + esc(addLabel(counts, confirming)) + '</button></div></div>';
  }

  function loadFormHtml(idPrefix, label, placeholder, value, buttonLabel, action, busy) {
    return '<form class="gs-import-form" data-submit="' + action + '" novalidate><div class="gs-field"><label class="gs-label" for="' + idPrefix + '-link">' + esc(label) + '</label>' +
      '<input class="gs-input" type="text" id="' + idPrefix + '-link" name="link" data-input="' + idPrefix + '-link" autocomplete="off" spellcheck="false" placeholder="' + esc(placeholder) + '" value="' + esc(value) + '"></div>' +
      '<button type="submit" class="gs-btn gs-btn-molten"' + (busy ? ' disabled' : '') + '>' + esc(buttonLabel) + '</button></form>';
  }

  function errorHtml(state, reloadAction) {
    if (!state.error) return '';
    return '<div class="gs-alert gs-import-alert" role="alert" id="gs-page-alert"><span>' + esc(state.error) + '</span>' +
      (state.offerReload ? '<button type="button" class="gs-btn gs-btn-sm" data-action="' + reloadAction + '" data-key="' + reloadAction + '">Load the event again</button>' : '') + '</div>';
  }

  // opts: { guildData, rh } where rh is the page state (see ensureState).
  function raidHelperHtml(opts) {
    const gd = opts.guildData;
    const s = opts.rh;
    const gid = gd.guild.id;
    const ro = G.ui.rosterOptions(gd);
    let result = '';
    if (s.preview) {
      const ev = s.preview.event;
      const date = ev.startTime ? G.ui.formatDate(ev.startTime) : '';
      const members = (s.preview.rows || []).length;
      result = '<section aria-labelledby="rh-result" class="gs-import-result"><div class="gs-import-result-head"><h2 class="gs-h2" id="rh-result">' + esc(ev.title) + (date ? ' &middot; ' + esc(date) : '') + ' &middot; ' + esc(plural(members, 'sign-up', 'sign-ups')) + '</h2>' +
        (ev.otherServer ? '<div class="gs-warn" id="rh-other-server" role="status">This event was posted in a different Discord server than the ' + esc(gd.guild.name) + ' server.</div>' : '') +
        '<p class="gs-fine">The first name in each nickname becomes the Main, with the class and spec they signed up with. Other names in the nickname are offered as Alts: tick the ones that are characters and pick their class.</p>' +
        '<div class="gs-field gs-field-inline"><label class="gs-label" for="rh-start">New people start as</label><select class="gs-input" id="rh-start" data-change="rh-start" data-key="rh-start">' +
        G.ui.optionsHtml(START_STATUSES.map(function (v) { return { value: v, label: G.ui.statusLabel(v) }; }), s.defaultStatus) + '</select></div></div>' +
        tableHtml(s.preview.rows || [], s, ro) + onRosterHtml(gid, s.preview.rows || [], s, ro) + '</section>';
    }
    return '<div class="gs-page gs-import-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Import from Raid-Helper</h1>' +
      '<p class="gs-lead gs-lead-sm">Everyone who signed up becomes a person on the roster, linked by their Discord account.</p></div>' +
      loadFormHtml('rh', 'Raid-Helper event link', 'https://raid-helper.dev/event/...', s.link, 'Load sign-ups', 'rh-load', s.status === 'loading') +
      errorHtml(s, 'rh-reload') + result + (s.preview ? footerHtml(gid, s.preview, s) : '') + '</div>';
  }

  // ── Warcraft Logs: pure state helpers ──
  function wclInitChoices(preview) {
    const out = {};
    ((preview && preview.toDecide) || []).forEach(function (d) {
      if (!d.otherRealm && d.suggestion) out[d.key] = { action: 'alt', personId: d.suggestion.personId || d.suggestion.id || '', status: 'trial' };
      else out[d.key] = { action: 'skip', personId: '', status: 'trial' };
    });
    return out;
  }

  function wclCounts(preview, choices) {
    const out = { alts: 0, news: 0, skipped: 0, incomplete: 0 };
    ((preview && preview.toDecide) || []).forEach(function (d) {
      const c = choices[d.key] || { action: 'skip' };
      if (c.action === 'new') out.news++;
      else if (c.action === 'alt' || c.action === 'other') {
        if (c.personId) out.alts++; else out.incomplete++;
      } else out.skipped++;
    });
    return out;
  }

  function wclCommitBody(teamId, preview, choices) {
    const decisions = [];
    ((preview && preview.toDecide) || []).forEach(function (d) {
      const c = choices[d.key] || { action: 'skip' };
      const base = { key: d.key, name: d.name, realm: d.realm == null ? null : d.realm, class: d.class };
      if (c.action === 'new') decisions.push(Object.assign(base, { action: 'new', status: c.status || 'trial' }));
      else if ((c.action === 'alt' || c.action === 'other') && c.personId) decisions.push(Object.assign(base, { action: 'alt', personId: c.personId }));
    });
    return { teamId: teamId, report: { code: preview.report.code, flavour: preview.report.flavour }, decisions: decisions };
  }

  // ── Warcraft Logs: markup ──
  // The select value for a choice: alt:<personId> for the suggested person, other, new or skip.
  function choiceValue(d, c) {
    if (c.action === 'alt' && d.suggestion && c.personId === (d.suggestion.personId || d.suggestion.id)) return 'alt:' + c.personId;
    if (c.action === 'alt' || c.action === 'other') return 'other';
    return c.action;
  }

  // Element ids from a decision key (name|realm): letters and digits only, with the position-free key kept unique by a hash.
  function idSafe(key) {
    let h = 0;
    const s = String(key);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return s.replace(/[^A-Za-z0-9]/g, '').slice(0, 20) + '-' + h.toString(36);
  }

  function choiceSelectHtml(d, c, people, rowError) {
    const items = [];
    if (d.suggestion) items.push({ value: 'alt:' + (d.suggestion.personId || d.suggestion.id), label: 'Add as Alt of ' + d.suggestion.name });
    items.push({ value: 'other', label: 'Add as Alt of someone else...' });
    items.push({ value: 'new', label: 'New person' });
    items.push({ value: 'skip', label: 'Skip (not a guild member)' });
    const value = choiceValue(d, c);
    let extra = '';
    const sid = 'wcl-' + idSafe(d.key);
    if (value === 'other') {
      const opts = [{ value: '', label: 'Choose a person' }].concat((people || []).map(function (p) { return { value: p.id, label: p.main.name }; }));
      extra = '<label class="gs-sr" for="' + sid + '-person">Which person owns ' + esc(d.name) + '</label><select class="gs-input gs-input-sm" id="' + sid + '-person" data-change="wcl-person" data-key="wcl-person-' + esc(d.key) + '" data-choice="' + esc(d.key) + '">' + G.ui.optionsHtml(opts, c.personId) + '</select>';
    } else if (value === 'new') {
      extra = '<label class="gs-sr" for="' + sid + '-status">Starting status for ' + esc(d.name) + '</label><select class="gs-input gs-input-sm" id="' + sid + '-status" data-change="wcl-status" data-key="wcl-status-' + esc(d.key) + '" data-choice="' + esc(d.key) + '">' +
        G.ui.optionsHtml(START_STATUSES.map(function (v) { return { value: v, label: G.ui.statusLabel(v) }; }), c.status) + '</select>';
    }
    return '<div class="gs-choice"><label class="gs-sr" for="' + sid + '-choice">What to do with ' + esc(d.name) + '</label><select class="gs-input gs-input-sm" id="' + sid + '-choice" data-change="wcl-choice" data-key="wcl-choice-' + esc(d.key) + '" data-choice="' + esc(d.key) + '">' + G.ui.optionsHtml(items, value) + '</select>' + extra + '</div>' + (rowError ? '<span class="gs-note-line gs-note-error">' + esc(rowError) + '</span>' : '');
  }

  function decideRowHtml(d, c, people, rowError) {
    return '<tr><th scope="row" class="gs-cell-strong">' + G.ui.classNameHtml(d.name, d.class) + '</th><td data-label="In the log">' + esc(G.ui.className(d.class)) +
      (d.otherRealm ? '<span class="gs-char-sub">From ' + esc(d.realm) + '</span>' : '') + '</td><td data-label="Match">' +
      (d.suggestion ? 'In ' + esc(d.suggestion.name) + '\'s Discord nickname' : 'No match') + '</td><td data-label="What to do">' + choiceSelectHtml(d, c, people, rowError) + '</td></tr>';
  }

  function wclSummary(counts) {
    const changes = counts.alts + counts.news;
    if (!changes) return 'No changes yet' + (counts.skipped ? ' &middot; ' + counts.skipped + ' skipped' : '');
    const parts = [];
    if (counts.alts) parts.push(plural(counts.alts, 'Alt', 'Alts'));
    if (counts.news) parts.push(plural(counts.news, 'new person', 'new people'));
    return plural(changes, 'change', 'changes') + ': ' + parts.join(', ') + (counts.skipped ? ' &middot; ' + counts.skipped + ' skipped' : '');
  }

  // opts: { guildData, wcl, people } where people are the roster list's people whose home team is the team.
  function wclHtml(opts) {
    const gd = opts.guildData;
    const s = opts.wcl;
    const gid = gd.guild.id;
    let result = '';
    let footer = '';
    if (s.preview) {
      const pv = s.preview;
      const matched = pv.matched || [];
      const decide = pv.toDecide || [];
      const date = pv.report.startTime ? G.ui.formatDate(pv.report.startTime) : '';
      const counts = wclCounts(pv, s.choices);
      const changes = counts.alts + counts.news;
      result = '<section aria-labelledby="wcl-result" class="gs-import-result"><div class="gs-import-result-head"><h2 class="gs-h2" id="wcl-result">' + esc(pv.report.title) + (date ? ' &middot; ' + esc(date) : '') + ' &middot; ' + esc(plural(matched.length + decide.length, 'player', 'players')) + '</h2>' +
        '<div class="gs-chips"><span class="gs-chip">' + matched.length + ' on the roster</span><span class="gs-chip">' + decide.length + ' to decide</span></div></div>' +
        (matched.length
          ? '<div class="gs-known"><span id="wcl-known">' + esc(plural(matched.length, 'character', 'characters')) + ' already on the roster</span><button type="button" class="gs-btn gs-btn-sm" data-action="wcl-known" data-key="wcl-known" aria-expanded="' + (s.knownOpen ? 'true' : 'false') + '" aria-controls="wcl-known-list" aria-describedby="wcl-known">' + (s.knownOpen ? 'Hide' : 'Show') + '</button></div>' +
            '<ul class="gs-known-list" id="wcl-known-list"' + (s.knownOpen ? '' : ' hidden') + '>' + matched.map(function (m) {
              return '<li>' + G.ui.classNameHtml(m.name, m.class) + ' <span class="gs-fine">' + esc(G.ui.className(m.class)) + ' &middot; ' + esc(m.person && m.person.name) + '</span></li>';
            }).join('') + '</ul>'
          : '') +
        (decide.length
          ? '<h3 class="gs-h3">' + esc(decide.length + ' to decide') + '</h3><div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-import" aria-label="' + esc(decide.length + ' to decide') + '"><thead><tr><th scope="col">Character</th><th scope="col">In the log</th><th scope="col">Match</th><th scope="col">What to do</th></tr></thead><tbody>' +
            decide.map(function (d) { return decideRowHtml(d, s.choices[d.key] || { action: 'skip', status: 'trial' }, opts.people, s.rowErrors && s.rowErrors[d.key]); }).join('') + '</tbody></table></div>'
          : '<p class="gs-empty">Everyone in this report is already on the roster.</p>') + '</section>';
      footer = '<div class="gs-import-bar" id="wcl-footer"><p class="gs-import-sum" role="status">' + wclSummary(counts) + '</p><div class="gs-actions"><a class="gs-btn" href="' + esc(rosterHref(gid)) + '">Cancel</a>' +
        '<button type="button" class="gs-btn gs-btn-molten" data-action="wcl-commit" data-key="wcl-commit"' + (!changes || s.status === 'saving' ? ' disabled' : '') + '>Save ' + esc(plural(changes, 'change', 'changes')) + '</button></div></div>';
    }
    return '<div class="gs-page gs-import-page"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Import from Warcraft Logs</h1>' +
      '<p class="gs-lead gs-lead-sm">Adds the characters in a report to the roster. Names already on the roster are skipped; you decide the rest.</p></div>' +
      loadFormHtml('wcl', 'Warcraft Logs report link', 'https://fresh.warcraftlogs.com/reports/...', s.link, 'Load players', 'wcl-load', s.status === 'loading') +
      errorHtml(s, 'wcl-reload') + result + footer + '</div>';
  }

  // ── behaviour ──
  function st() { return G.app.state; }
  function apiBase(gid) { return '/api/guild/' + encodeURIComponent(gid) + '/roster/import/'; }

  // Page state lives in app state, one record per source, reset when the guild or team changes.
  function ensureState(kind, gid, teamId) {
    const s = st();
    if (!s.imports) s.imports = {};
    const cur = s.imports[kind];
    if (cur && cur.gid === gid && cur.teamId === teamId) return cur;
    s.imports[kind] = kind === 'rh'
      ? { gid: gid, teamId: teamId, link: '', status: 'idle', error: '', offerReload: false, preview: null, rows: {}, defaultStatus: 'raider', showAll: false, foldOpen: false, confirmOtherServer: false, rowErrors: {} }
      : { gid: gid, teamId: teamId, link: '', status: 'idle', error: '', offerReload: false, preview: null, choices: {}, knownOpen: false, rowErrors: {} };
    return s.imports[kind];
  }

  function cur(kind) {
    const s = st();
    const i = s.imports && s.imports[kind];
    return i && i.gid === s.currentGid ? i : null;
  }

  // The error text for a failed request; sign-in and message views are handled by the app.
  function failure(state, err, offerReload) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return false; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return false; }
    state.error = c.text;
    state.offerReload = !!offerReload;
    return true;
  }

  function loadPreview(kind, form) {
    const state = cur(kind);
    if (!state) return;
    const link = (state.link || '').trim();
    if (!link) { state.error = kind === 'rh' ? 'Paste a Raid-Helper event link.' : 'Paste a Warcraft Logs report link.'; state.offerReload = false; G.app.render(); return; }
    state.status = 'loading';
    state.error = '';
    state.offerReload = false;
    G.app.render();
    G.api.post(apiBase(state.gid) + (kind === 'rh' ? 'raid-helper' : 'wcl') + '/preview', { teamId: state.teamId, source: link }).then(function (res) {
      state.status = 'ready';
      state.preview = res;
      if (kind === 'rh') {
        state.rows = rhInitRows(res);
        state.rowErrors = {};
        state.showAll = false;
        state.confirmOtherServer = false;
      } else {
        state.choices = wclInitChoices(res);
        state.knownOpen = false;
      }
      G.app.render();
    }, function (err) {
      state.status = 'idle';
      state.preview = null;
      if (failure(state, err, false)) G.app.render();
    });
  }

  G.handlers.submit['rh-load'] = function () { loadPreview('rh'); };
  G.handlers.submit['wcl-load'] = function () { loadPreview('wcl'); };
  G.handlers.click['rh-reload'] = function () { loadPreview('rh'); };
  G.handlers.click['wcl-reload'] = function () { loadPreview('wcl'); };
  G.handlers.input['rh-link'] = function (el) { const s = cur('rh'); if (s) s.link = el.value; };
  G.handlers.input['wcl-link'] = function (el) { const s = cur('wcl'); if (s) s.link = el.value; };

  // ── Raid-Helper events ──
  function rhRow(el) {
    const s = cur('rh');
    return s ? { s: s, ui: s.rows[el.getAttribute('data-signup')] } : null;
  }

  function refreshFooter() {
    const s = cur('rh');
    const host = document.getElementById('rh-footer');
    const gd = st().guilds[st().currentGid];
    if (!s || !s.preview || !host || !gd) return;
    host.outerHTML = footerHtml(gd.guild.id, s.preview, s);
  }

  G.handlers.change['rh-tick'] = function (el) {
    const r = rhRow(el);
    if (!r || !r.ui) return;
    r.ui.ticked = el.checked;
    G.app.render();
  };
  G.handlers.input['rh-name'] = function (el) {
    const r = rhRow(el);
    if (!r || !r.ui) return;
    r.ui.name = el.value;
    refreshFooter();
  };
  G.handlers.change['rh-class'] = function (el) {
    const r = rhRow(el);
    if (!r || !r.ui) return;
    r.ui.class = el.value;
    G.app.render();
  };
  G.handlers.change['rh-alt-tick'] = function (el) {
    const r = rhRow(el);
    const a = r && r.ui ? r.ui.alts[Number(el.getAttribute('data-alt'))] : null;
    if (!a) return;
    a.ticked = el.checked;
    G.app.render();
  };
  G.handlers.change['rh-alt-class'] = function (el) {
    const r = rhRow(el);
    const a = r && r.ui ? r.ui.alts[Number(el.getAttribute('data-alt'))] : null;
    if (!a) return;
    a.class = el.value;
    G.app.render();
  };
  G.handlers.change['rh-start'] = function (el) {
    const s = cur('rh');
    if (!s || START_STATUSES.indexOf(el.value) < 0) return;
    s.defaultStatus = el.value;
  };
  G.handlers.click['rh-show-all'] = function () { const s = cur('rh'); if (s) { s.showAll = !s.showAll; G.app.render(); } };
  G.handlers.click['rh-fold'] = function () { const s = cur('rh'); if (s) { s.foldOpen = !s.foldOpen; G.app.render(); } };

  function finish(state, text, res) {
    G.app.applyFlags(state.gid, res);
    st().rosterNotice = text;
    st().imports[state === st().imports.rh ? 'rh' : 'wcl'] = null;
    G.app.go(rosterHref(state.gid));
  }

  G.handlers.click['rh-commit'] = function () {
    const s = cur('rh');
    if (!s || !s.preview || s.status === 'saving') return;
    const counts = rhCounts(s.preview, s.rows);
    if (counts.ready === 0 && counts.altsOnRoster === 0) return;
    if (s.preview.event.otherServer && !s.confirmOtherServer) { s.confirmOtherServer = true; G.app.render(); return; }
    const built = rhCommitBody(s.teamId, s.preview, s.rows, s.defaultStatus, !!s.preview.event.otherServer);
    s.status = 'saving';
    s.error = '';
    s.rowErrors = {};
    G.app.render();
    G.api.post(apiBase(s.gid) + 'raid-helper/commit', built.body).then(function (res) {
      s.status = 'ready';
      const people = res && typeof res.people === 'number' ? res.people : counts.ready;
      const chars = res && typeof res.characters === 'number' ? res.characters : null;
      finish(s, 'Added ' + plural(people, 'person', 'people') + (chars != null ? ' and ' + plural(chars, 'character', 'characters') : (counts.alts + counts.altsOnRoster ? ' and ' + plural(counts.alts + counts.altsOnRoster, 'Alt', 'Alts') : '')) + ' from ' + s.preview.event.title + '.', res);
    }, function (err) {
      s.status = 'ready';
      if (err && err.code === 'other_server') {
        s.preview.event.otherServer = true;
        s.confirmOtherServer = true;
        s.error = err.message;
        G.app.render();
        return;
      }
      // Commit-time races (no index) offer a fresh preview; a row error (index) marks its row.
      const reload = err && (err.code === 'event_changed' || err.index == null && ['name_taken', 'already_on_roster', 'person_limit', 'character_limit'].indexOf(err.code) >= 0);
      if (err && err.code !== 'event_changed' && err.index != null && built.sent[err.index] != null) {
        s.rowErrors[built.sent[err.index]] = err.message;
        s.error = 'One row could not be added. Fix it and try again.';
        s.offerReload = false;
        G.app.render();
        return;
      }
      if (failure(s, err, reload)) G.app.render();
    });
  };

  // ── Warcraft Logs reports ──
  function wclChoice(el) {
    const s = cur('wcl');
    return s ? { s: s, c: s.choices[el.getAttribute('data-choice')] } : null;
  }

  function refreshWclFooter() { G.app.render(); }

  G.handlers.change['wcl-choice'] = function (el) {
    const r = wclChoice(el);
    if (!r || !r.c) return;
    const v = el.value;
    if (v.indexOf('alt:') === 0) { r.c.action = 'alt'; r.c.personId = v.slice(4); }
    else if (v === 'other') { r.c.action = 'other'; r.c.personId = ''; }
    else if (v === 'new') { r.c.action = 'new'; r.c.personId = ''; }
    else { r.c.action = 'skip'; r.c.personId = ''; }
    refreshWclFooter();
  };
  G.handlers.change['wcl-person'] = function (el) {
    const r = wclChoice(el);
    if (!r || !r.c) return;
    r.c.personId = el.value;
    refreshWclFooter();
  };
  G.handlers.change['wcl-status'] = function (el) {
    const r = wclChoice(el);
    if (!r || !r.c || START_STATUSES.indexOf(el.value) < 0) return;
    r.c.status = el.value;
  };
  G.handlers.click['wcl-known'] = function () { const s = cur('wcl'); if (s) { s.knownOpen = !s.knownOpen; G.app.render(); } };

  G.handlers.click['wcl-commit'] = function () {
    const s = cur('wcl');
    if (!s || !s.preview || s.status === 'saving') return;
    const counts = wclCounts(s.preview, s.choices);
    if (!counts.alts && !counts.news) return;
    s.status = 'saving';
    s.error = '';
    s.rowErrors = {};
    G.app.render();
    const built = wclCommitBody(s.teamId, s.preview, s.choices);
    G.api.post(apiBase(s.gid) + 'wcl/commit', built).then(function (res) {
      s.status = 'ready';
      finish(s, 'Saved ' + plural(counts.alts + counts.news, 'change', 'changes') + ' from the Warcraft Logs report.', res);
    }, function (err) {
      s.status = 'ready';
      const row = err && err.index != null ? built.decisions[err.index] : null;
      if (row) {
        s.rowErrors[row.key] = err.message;
        s.error = 'One row could not be saved. Fix it and try again.';
        s.offerReload = false;
        G.app.render();
        return;
      }
      if (failure(s, err, err && ['name_taken', 'already_on_roster', 'person_limit', 'character_limit'].indexOf(err.code) >= 0)) G.app.render();
    });
  };

  G.pages.import = {
    SHOW_FIRST: SHOW_FIRST,
    OTHER_SERVER_CONFIRM: OTHER_SERVER_CONFIRM,
    MAIN_NOTES: MAIN_NOTES,
    ensureState: ensureState,
    rhInitRows: rhInitRows,
    rhCounts: rhCounts,
    rhCommitBody: rhCommitBody,
    raidHelperHtml: raidHelperHtml,
    wclInitChoices: wclInitChoices,
    wclCounts: wclCounts,
    wclCommitBody: wclCommitBody,
    wclHtml: wclHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
