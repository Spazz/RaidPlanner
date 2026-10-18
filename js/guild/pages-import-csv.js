// ── PAGE: IMPORT FROM A CSV FILE ────────────────────────────────
// An officer pastes or uploads a CSV (name, class, spec, realm, team, main/alt, status, joined, owner), sees what each line would do, answers the questions
// the file leaves (an alt with no main in the file: alt of whom, or a person of its own) and saves. At most 500 rows. The Worker reads the text
// (worker/csv-roster.js), says which lines have problems, which characters are on the roster already and how the rest group into people; the page only
// holds the decisions. POST /roster/import/csv/preview and /commit.
// Pure parts: csvInitChoices, csvPlan, csvCommitBody, csvSummary and the *Html builders.
(function (G) {
  'use strict';

  const START_STATUSES = ['raider', 'trial', 'reserve'];
  const MAX_ROWS = 500;
  const HELP = 'Columns: name, class, spec, realm, team, main/alt, status, joined (2026-10-18). A header row is found by itself; without one the columns are read in that order. ' +
    'Add an owner column (player, discord or username) to group a person\'s characters. ThatsMyBIS character exports work as they are.';

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function rosterHref(gid) { return G.router.format({ name: 'section', gid: gid, section: 'roster' }); }
  function st() { return G.app.state; }

  // ── pure state helpers ──
  // One choice per row: ticked (include it), and for a row that needs a decision, what to do with it.
  function csvInitChoices(preview) {
    const out = {};
    ((preview && preview.rows) || []).forEach(function (row) {
      const usable = !row.problems.length && !row.taken;
      let pick = 'new';
      let personId = '';
      if (row.needsDecision) {
        if (row.suggestion) { pick = 'alt'; personId = row.suggestion.personId; }
      }
      out[row.line] = { ticked: usable, pick: pick, personId: personId };
    });
    return out;
  }

  // What each row will do under the choices: { rows: [{ row, action: 'new' | 'alt' | 'skip', personId, withLine, incomplete }], people, alts, needs, skipped }.
  function csvPlan(preview, choices) {
    const rows = ((preview && preview.rows) || []).map(function (row) {
      const c = choices[row.line] || { ticked: false, pick: 'new', personId: '' };
      let action = 'skip';
      let personId = null;
      let withLine = null;
      let incomplete = false;
      if (c.ticked && !row.problems.length && !row.taken) {
        if (row.needsDecision) {
          if (c.pick === 'new') action = 'new';
          else if (c.pick === 'skip') action = 'skip';
          else if (c.personId) { action = 'alt'; personId = c.personId; }
          else { action = 'alt'; incomplete = true; }
        } else if (row.action === 'alt') {
          action = 'alt';
          withLine = row.withLine;
        } else {
          action = row.action === 'new' ? 'new' : 'skip';
        }
      }
      return { row: row, action: action, personId: personId, withLine: withLine, incomplete: incomplete };
    });
    const newLines = {};
    rows.forEach(function (r) { if (r.action === 'new') newLines[r.row.line] = true; });
    rows.forEach(function (r) { if (r.action === 'alt' && r.withLine && !newLines[r.withLine]) r.incomplete = true; });
    return {
      rows: rows,
      people: rows.filter(function (r) { return r.action === 'new'; }).length,
      alts: rows.filter(function (r) { return r.action === 'alt' && !r.incomplete; }).length,
      needs: rows.filter(function (r) { return r.incomplete; }).length,
      skipped: rows.filter(function (r) { return r.action === 'skip'; }).length,
    };
  }

  function csvSummary(plan) {
    const changes = plan.people + plan.alts;
    if (!changes) return 'Nothing to save yet' + (plan.skipped ? ' - ' + plan.skipped + ' skipped' : '');
    const parts = [];
    if (plan.people) parts.push(plural(plan.people, 'new person', 'new people'));
    if (plan.alts) parts.push(plural(plan.alts, 'Alt', 'Alts'));
    return parts.join(', ') + (plan.skipped ? ' - ' + plan.skipped + ' skipped' : '') + (plan.needs ? ' - ' + plural(plan.needs, 'row needs', 'rows need') + ' an answer' : '');
  }

  // The body of POST /commit: only the rows that do something.
  function csvCommitBody(teamId, preview, choices, defaultStatus) {
    const plan = csvPlan(preview, choices);
    const rows = [];
    plan.rows.forEach(function (r) {
      if (r.action === 'skip' || r.incomplete) return;
      const row = r.row;
      const out = { line: row.line, action: r.action, name: row.name, class: row.class, spec: row.spec || null, realm: row.realm || null, teamId: row.teamId, status: row.status || defaultStatus };
      if (row.joinedOn) out.joinedOn = row.joinedOn;
      if (r.action === 'alt') { if (r.personId) out.personId = r.personId; else out.withLine = r.withLine; }
      rows.push(out);
    });
    return { teamId: teamId, rows: rows };
  }

  // ── html ──
  function resultCell(r) {
    const row = r.row;
    if (row.problems.length) return '<span class="gs-pill gs-pill-warn">Skipped</span> <span class="gs-note-line">' + esc(row.problems.join(' ')) + '</span>';
    if (row.taken) return '<span class="gs-pill gs-pill-muted">On the roster</span> <span class="gs-note-line">Already ' + esc(row.taken.name) + '\'s character.</span>';
    return '';
  }

  function decisionHtml(row, c, people) {
    const id = 'csv-' + row.line;
    const items = [];
    if (row.suggestion) items.push({ value: 'alt:' + row.suggestion.personId, label: 'Alt of ' + row.suggestion.name });
    items.push({ value: 'other', label: 'Alt of someone else...' });
    items.push({ value: 'new', label: 'New person' });
    items.push({ value: 'skip', label: 'Skip' });
    const value = c.pick === 'alt' && c.personId && row.suggestion && c.personId === row.suggestion.personId ? 'alt:' + c.personId : (c.pick === 'alt' ? 'other' : c.pick);
    let extra = '';
    if (value === 'other') {
      extra = '<label class="gs-sr" for="' + id + '-person">Which person owns ' + esc(row.name) + '</label><select class="gs-input gs-input-sm" id="' + id + '-person" data-change="csv-person" data-key="csv-person-' + row.line + '" data-line="' + row.line + '">' +
        G.ui.optionsHtml([{ value: '', label: 'Choose a person' }].concat((people || []).map(function (p) { return { value: p.id, label: p.main.name }; })), c.personId) + '</select>';
    }
    return '<div class="gs-choice"><label class="gs-sr" for="' + id + '-choice">What to do with ' + esc(row.name) + '</label><select class="gs-input gs-input-sm" id="' + id + '-choice" data-change="csv-choice" data-key="csv-choice-' + row.line + '" data-line="' + row.line + '">' +
      G.ui.optionsHtml(items, value) + '</select>' + extra + '</div>';
  }

  // names: line -> the character name on it, for "Alt of <name>".
  function rowHtml(r, choices, people, rowErrors, names) {
    const row = r.row;
    const c = choices[row.line] || { ticked: false };
    const usable = !row.problems.length && !row.taken;
    const tick = usable
      ? '<div class="gs-check"><input type="checkbox" id="csv-tick-' + row.line + '" data-change="csv-tick" data-line="' + row.line + '" data-key="csv-tick-' + row.line + '"' + (c.ticked ? ' checked' : '') + '><label for="csv-tick-' + row.line + '"><span class="gs-sr">Include </span>' + esc(row.name) + '</label></div>'
      : '<span class="gs-cell-strong">' + esc(row.name || '(no name)') + '</span>';
    let what = '';
    if (usable && c.ticked) {
      if (row.needsDecision) what = decisionHtml(row, c, people);
      else if (row.action === 'alt') what = r.incomplete ? '<span class="gs-note-line gs-note-error">Its main is not included.</span>' : 'Alt of ' + esc((r.row.withLine && names[r.row.withLine]) || 'the main in the file');
      else what = 'New person (Main)';
    } else if (usable) what = '<span class="gs-muted">Not included</span>';
    return '<tr><th scope="row" class="gs-cell-strong">' + tick + (row.class ? '<span class="gs-char-sub ' + esc(G.ui.classClass(row.class)) + '">' + esc(G.ui.className(row.class) + (row.spec ? ' - ' + row.spec : '')) + '</span>' : '') + '</th>' +
      '<td data-label="Team">' + esc(row.teamName || '-') + (row.realm ? '<span class="gs-char-sub">' + esc(row.realm) + '</span>' : '') + '</td>' +
      '<td data-label="Status">' + esc(G.ui.statusLabel(row.status || 'raider')) + (row.joinedOn ? '<span class="gs-char-sub">Joined ' + esc(G.ui.formatDay(row.joinedOn)) + '</span>' : '') + '</td>' +
      '<td data-label="What happens">' + (resultCell(r) || what) + (row.notes && row.notes.length ? '<span class="gs-note-line">' + esc(row.notes.join(' ')) + '</span>' : '') +
      (rowErrors && rowErrors[row.line] ? '<span class="gs-note-line gs-note-error">' + esc(rowErrors[row.line]) + '</span>' : '') + '</td></tr>';
  }

  function errorHtml(s) {
    return s.error ? '<div class="gs-alert gs-import-alert" role="alert" id="gs-page-alert"><span>' + esc(s.error) + '</span></div>' : '';
  }

  function inputFormHtml(s) {
    return '<form class="gs-import-form" data-submit="csv-load" novalidate>' +
      '<div class="gs-field"><label class="gs-label" for="csv-text">CSV text</label>' +
      '<textarea class="gs-input gs-textarea gs-code" id="csv-text" name="text" rows="9" spellcheck="false" data-input="csv-text" aria-describedby="csv-help" placeholder="name,class,spec,team,main/alt\nThornwick,Warrior,Protection,Main team,main">' + esc(s.text) + '</textarea>' +
      '<p class="gs-fine" id="csv-help">' + esc(HELP) + '</p></div>' +
      '<div class="gs-field"><label class="gs-label" for="csv-file">Or choose a file</label><input class="gs-input" type="file" id="csv-file" accept=".csv,.tsv,.txt,text/csv,text/plain" data-change="csv-file" data-key="csv-file">' +
      (s.fileName ? '<p class="gs-fine" id="csv-file-name">Loaded ' + esc(s.fileName) + '.</p>' : '') + '</div>' +
      '<div class="gs-field"><label class="gs-label" for="csv-status">Starting status when the file has none</label><select class="gs-input" id="csv-status" data-change="csv-start" data-key="csv-start">' +
      G.ui.optionsHtml(START_STATUSES.map(function (v) { return { value: v, label: G.ui.statusLabel(v) }; }), s.defaultStatus) + '</select></div>' +
      '<button type="submit" class="gs-btn gs-btn-molten"' + (s.status === 'loading' ? ' disabled' : '') + '>Preview import</button></form>' +
      '<p class="gs-fine">Nothing is saved until you press the button on the next step.</p>';
  }

  // opts: { guildData, csv (the page state), people (the roster list's people whose home team is the team) }
  function csvHtml(opts) {
    const gd = opts.guildData;
    const s = opts.csv;
    const gid = gd.guild.id;
    let result = '';
    let footer = '';
    if (s.preview) {
      const pv = s.preview;
      const plan = csvPlan(pv, s.choices);
      const names = {};
      pv.rows.forEach(function (row) { if (row.name) names[row.line] = row.name; });
      const changes = plan.people + plan.alts;
      result = '<section aria-labelledby="csv-result" class="gs-import-result"><div class="gs-import-result-head"><h2 class="gs-h2" id="csv-result">' + esc(plural(pv.totals.rows, 'row', 'rows')) + ' read</h2>' +
        '<div class="gs-chips"><span class="gs-chip">' + pv.totals.people + ' new ' + (pv.totals.people === 1 ? 'person' : 'people') + '</span><span class="gs-chip">' + plural(pv.totals.alts, 'Alt', 'Alts') + '</span>' +
        '<span class="gs-chip">' + pv.totals.taken + ' on the roster</span><span class="gs-chip">' + plural(pv.totals.problems, 'problem', 'problems') + '</span></div></div>' +
        '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-import" aria-label="Rows of the file"><thead><tr><th scope="col">Character</th><th scope="col">Team</th><th scope="col">Status</th><th scope="col">What happens</th></tr></thead><tbody>' +
        plan.rows.map(function (r) { return rowHtml(r, s.choices, opts.people, s.rowErrors, names); }).join('') + '</tbody></table></div></section>';
      footer = {
        id: 'csv-footer', text: csvSummary(plan),
        back: { attrs: { 'data-action': 'csv-back', 'data-key': 'csv-back' } }, cancel: { href: rosterHref(gid) },
        commit: { label: 'Save ' + plural(changes, 'change', 'changes'), disabled: !changes || !!plan.needs || s.status === 'saving', attrs: { 'data-action': 'csv-commit', 'data-key': 'csv-commit' } },
      };
    }
    const team = G.pages.attendance ? G.pages.attendance.teamOf(gd, s.teamId) : null;
    return G.ui.importFlowHtml({
      title: 'Import from a CSV file', context: gd.guild.name + (team ? ' - ' + team.name : ''), back: { href: rosterHref(gid), label: 'Roster' },
      step: s.result ? 'result' : (s.preview ? 'preview' : 'source'),
      alertHtml: errorHtml(s), sourcesHtml: G.ui.importSourcesHtml(gid, 'csv'),
      sourceHtml: '<p class="gs-lead gs-lead-sm">Adds the characters in a spreadsheet to the roster, at most ' + MAX_ROWS + ' at a time. Names already on the roster are skipped; you decide what the file leaves open.</p>' + inputFormHtml(s),
      previewHtml: result, resultHtml: s.result ? G.ui.importResultHtml({ id: 'csv-result-banner', title: s.result.title, text: s.result.text, next: [
        { label: 'Open roster', href: rosterHref(gid) }, { label: 'Import another', attrs: { 'data-action': 'csv-again', 'data-key': 'csv-again' } }] }) : '',
      commit: footer || null,
    });
  }

  // ── behaviour ──
  function ensureState(gid, teamId) {
    const s = st();
    if (!s.imports) s.imports = {};
    const cur = s.imports.csv;
    if (cur && cur.gid === gid && cur.teamId === teamId) return cur;
    s.imports.csv = { gid: gid, teamId: teamId, text: '', fileName: '', defaultStatus: 'raider', status: 'idle', error: '', preview: null, result: null, choices: {}, rowErrors: {} };
    return s.imports.csv;
  }

  function cur() {
    const s = st();
    const i = s.imports && s.imports.csv;
    return i && i.gid === s.currentGid ? i : null;
  }

  function failure(s, err) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return false; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return false; }
    s.error = c.text;
    return true;
  }

  G.handlers.input['csv-text'] = function (el) { const s = cur(); if (s) { s.text = el.value; s.fileName = ''; } };
  G.handlers.change['csv-start'] = function (el) { const s = cur(); if (s && START_STATUSES.indexOf(el.value) >= 0) s.defaultStatus = el.value; };

  G.handlers.change['csv-file'] = function (el) {
    const s = cur();
    const file = el.files && el.files[0];
    if (!s || !file) return;
    if (file.size > 200 * 1024) { s.error = 'That file is too large (at most 200 KB).'; G.app.render(); return; }
    const read = typeof file.text === 'function' ? file.text() : Promise.reject(new Error('no file reader'));
    read.then(function (text) {
      s.text = text; s.fileName = file.name; s.error = ''; s.preview = null;
      G.app.render();
    }, function () { s.error = 'Could not read that file.'; G.app.render(); });
  };

  G.handlers.submit['csv-load'] = function () {
    const s = cur();
    if (!s) return;
    if (!s.text.trim()) { s.error = 'Paste a CSV or choose a file first.'; G.app.render(); return; }
    s.status = 'loading'; s.error = ''; s.result = null;
    G.app.render();
    G.api.csvImport.preview(s.gid, { teamId: s.teamId, text: s.text, defaultStatus: s.defaultStatus }).then(function (res) {
      s.status = 'ready'; s.preview = res; s.choices = csvInitChoices(res); s.rowErrors = {};
      G.app.render();
    }, function (err) {
      s.status = 'idle'; s.preview = null;
      if (failure(s, err)) G.app.render();
    });
  };

  // Back keeps the text and the chosen file; Import another starts the page afresh.
  G.handlers.click['csv-back'] = function () {
    const s = cur();
    if (!s) return;
    s.preview = null; s.status = 'idle'; s.error = ''; s.rowErrors = {};
    G.app.render();
  };
  G.handlers.click['csv-again'] = function () {
    const s = cur();
    if (!s) return;
    st().imports.csv = null;
    ensureState(s.gid, s.teamId);
    G.app.render();
  };

  G.handlers.change['csv-tick'] = function (el) {
    const s = cur();
    const c = s ? s.choices[el.getAttribute('data-line')] : null;
    if (!c) return;
    c.ticked = !!el.checked;
    G.app.render();
  };
  G.handlers.change['csv-choice'] = function (el) {
    const s = cur();
    const c = s ? s.choices[el.getAttribute('data-line')] : null;
    if (!c) return;
    const v = el.value;
    if (v.indexOf('alt:') === 0) { c.pick = 'alt'; c.personId = v.slice(4); }
    else if (v === 'other') { c.pick = 'alt'; c.personId = ''; }
    else { c.pick = v === 'skip' ? 'skip' : 'new'; c.personId = ''; }
    G.app.render();
  };
  G.handlers.change['csv-person'] = function (el) {
    const s = cur();
    const c = s ? s.choices[el.getAttribute('data-line')] : null;
    if (!c) return;
    c.personId = el.value;
    G.app.render();
  };

  G.handlers.click['csv-commit'] = function () {
    const s = cur();
    if (!s || !s.preview || s.status === 'saving') return;
    const plan = csvPlan(s.preview, s.choices);
    if (!(plan.people + plan.alts) || plan.needs) return;
    const body = csvCommitBody(s.teamId, s.preview, s.choices, s.defaultStatus);
    s.status = 'saving'; s.error = ''; s.rowErrors = {};
    G.app.render();
    G.api.csvImport.commit(s.gid, body).then(function (res) {
      s.status = 'ready';
      G.app.applyFlags(s.gid, res);
      s.result = { title: 'Added ' + plural(res.people, 'person', 'people') + ' and ' + plural(res.characters, 'character', 'characters') + ' from the CSV file.', text: plan.skipped ? plural(plan.skipped, 'row was', 'rows were') + ' left out.' : '' };
      s.preview = null;
      G.app.render();
    }, function (err) {
      s.status = 'ready';
      const sent = err && err.index != null ? body.rows[err.index] : null;
      if (sent) {
        s.rowErrors[sent.line] = err.message;
        s.error = 'One row could not be saved. Fix it and try again.';
        G.app.render();
        return;
      }
      if (failure(s, err)) G.app.render();
    });
  };

  G.pages.importCsv = {
    START_STATUSES: START_STATUSES, MAX_ROWS: MAX_ROWS, HELP: HELP, ensureState: ensureState, csvInitChoices: csvInitChoices, csvPlan: csvPlan,
    csvSummary: csvSummary, csvCommitBody: csvCommitBody, csvHtml: csvHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
