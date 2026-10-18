// ── PAGES: PERSON TRIAL REVIEW (the card on the roster person page) ──
// GET /roster/:pid/trial -> { today, person, since, attendance: null | { team, raids, pct, present, missed, missedNotice, late, leftEarly, fillIns, pending },
// loot: null | { total, ms, os, de, bank, items }, notes: null | { excerpt, truncated } }: what a Trial did since the trial started, with the three
// ways to decide (Promote to Raider, Extend trial, End trial). Only trial editors get the card (the Worker answers 403 / 404 to anyone else, which is
// "no card", not an error page). The buttons change the person through the same PATCH the rest of the person page uses (G.pages.person.ops).
(function (G) {
  'use strict';

  const NOTE_MAX = 300;
  const LOOT_LISTED = 10;
  const EXTEND_DAYS = 14;
  const TAG_LABELS = { MS: 'Main spec', OS: 'Off spec', DE: 'Disenchanted', BANK: 'Bank' };
  const NOTE_FAILED = 'The trial was ended, but the note could not be saved.';

  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function ops() { return G.pages.person.ops; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function nameOf(record) { return String((G.pages.person.mainOf(record) || {}).name || 'this person'); }

  // The card is for a Trial whose record the viewer may edit.
  function shows(record) {
    return !!(record && record.person && record.person.status === 'trial' && record.can && record.can.edit);
  }

  // ── view ──
  // "Trial Oct 3, 2026 - Oct 24, 2026", from the record (it follows an Extend without another read of the card).
  function datesText(p) {
    const start = G.ui.formatDay(p.trialStart);
    const end = G.ui.formatDay(p.trialEnd);
    if (start && end) return 'Trial ' + start + ' - ' + end;
    if (start) return 'Trial started ' + start + '. No end date is set.';
    if (end) return 'Trial ends ' + end + '.';
    return 'No trial dates are set.';
  }

  function tileHtml(label, value) {
    return '<div class="gs-summary-item"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
  }

  function attendanceHtml(att, showTeam) {
    if (!att) return '<p class="gs-fine">Attendance is not available for this person yet.</p>';
    return (showTeam && att.team && att.team.name ? '<p class="gs-fine">Attendance on ' + esc(att.team.name) + '</p>' : '') +
      '<dl class="gs-summary gs-trial-stats">' +
      tileHtml('Raids counted', num(att.raids)) + tileHtml('Attendance', G.ui.percent(att.pct)) + tileHtml('Missed', num(att.missed)) +
      tileHtml('Missed with notice', num(att.missedNotice)) + tileHtml('Late / left early', num(att.late) + ' / ' + num(att.leftEarly)) +
      tileHtml('Filled in elsewhere', num(att.fillIns)) + '</dl>' +
      (num(att.pending) > 0 ? '<p class="gs-fine">' + esc(plural(num(att.pending), 'raid is', 'raids are')) + ' awaiting review and not counted yet.</p>' : '');
  }

  // "2 main spec, 1 off spec": the tags that have any.
  function lootSplit(loot) {
    return [[loot.ms, 'main spec'], [loot.os, 'off spec'], [loot.de, 'disenchanted'], [loot.bank, 'bank']]
      .filter(function (x) { return num(x[0]) > 0; }).map(function (x) { return num(x[0]) + ' ' + x[1]; }).join(', ');
  }

  function lootRowHtml(it) {
    const tag = String(it && it.tag == null ? '' : it.tag);
    const label = Object.prototype.hasOwnProperty.call(TAG_LABELS, tag) ? TAG_LABELS[tag] : tag;
    return '<li class="gs-trial-loot-row"><span class="gs-item">' + esc(it.itemName) + '</span>' + (label ? '<span class="gs-chip gs-chip-tag' + (tag && tag !== 'MS' ? ' is-' + esc(tag.toLowerCase()) : '') + '">' + esc(label) + '</span>' : '') +
      (it.raidOn ? '<span class="gs-fine">' + esc(G.ui.shortDay(it.raidOn) || it.raidOn) + '</span>' : '') + '</li>';
  }

  function lootHtml(loot) {
    if (!loot) return '';
    const total = num(loot.total);
    const items = Array.isArray(loot.items) ? loot.items : [];
    if (!total) return '<div class="gs-trial-block"><h3 class="gs-h3">Loot</h3><p class="gs-fine">No loot yet</p></div>';
    const split = lootSplit(loot);
    const shown = items.slice(0, LOOT_LISTED);
    return '<div class="gs-trial-block"><h3 class="gs-h3">Loot</h3><p class="gs-trial-sum">Loot received: ' + esc(total) + (split ? ' (' + esc(split) + ')' : '') + '</p>' +
      (shown.length ? '<ul class="gs-trial-loot" aria-label="Loot received">' + shown.map(lootRowHtml).join('') + '</ul>' : '') +
      (total > shown.length ? '<p class="gs-fine">and ' + esc(total - shown.length) + ' more</p>' : '') + '</div>';
  }

  function notesHtml(notes) {
    if (!notes) return '';
    return '<div class="gs-trial-block"><h3 class="gs-h3">Officer notes</h3>' +
      (notes.excerpt ? '<p class="gs-trial-note">' + esc(notes.excerpt) + '</p>' : '<p class="gs-fine">No notes yet.</p>') +
      (notes.truncated ? '<p class="gs-fine">Shortened. The full text is under Officer notes on this page.</p>' : '') + '</div>';
  }

  function actionsHtml() {
    return '<div class="gs-actions gs-trial-actions">' + G.ui.buttonHtml({ label: 'Promote to Raider', variant: 'primary', attrs: { 'data-action': 'trial-promote', 'data-key': 'trial-card-promote' } }) +
      G.ui.buttonHtml({ label: 'Extend trial', attrs: { 'data-action': 'trial-extend', 'data-key': 'trial-card-extend' } }) +
      G.ui.buttonHtml({ label: 'End trial', variant: 'danger-outline', attrs: { 'data-action': 'trial-end', 'data-key': 'trial-card-end' } }) + '</div>';
  }

  // opts: { guildData, gid, pid, record (GET /roster/p_...), state: { data, error } | null }  ->  the Trial review section of the person page, or null
  function sectionOf(opts) {
    const s = opts.state;
    const record = opts.record;
    if (!s || s.none || !shows(record)) return null;
    const p = record.person;
    let body;
    if (s.error || !s.data) {
      body = '<p class="gs-alert" role="alert">' + esc(s.error || 'Could not load the trial review.') + '</p><div class="gs-actions">' + G.ui.buttonHtml({ label: 'Try again', attrs: { 'data-action': 'trial-retry', 'data-key': 'trial-card-retry' } }) + '</div>';
    } else {
      const d = s.data;
      const showTeam = G.shell.activeTeams(opts.guildData && opts.guildData.teams).length > 1;
      body = '<p class="gs-trial-dates">' + esc(datesText(p)) + '</p>' +
        '<p class="gs-fine">' + (d.since ? 'Since ' + esc(G.ui.formatDay(d.since)) + ' (trial start)' : 'No trial start date is set.') + '</p>' +
        attendanceHtml(d.attendance, showTeam) + lootHtml(d.loot) + notesHtml(d.notes) + actionsHtml();
    }
    return { id: 'trial-card', title: 'Trial review', chipHtml: G.ui.trialChipHtml(p.trialFlag), bodyHtml: body };
  }

  function cardHtml(opts) {
    const section = sectionOf(opts);
    return section ? G.ui.objectSectionHtml(section) : '';
  }

  // ── dialogs ──
  function promoteDialogHtml(record) {
    const name = nameOf(record);
    return G.ui.dialogHtml({ kind: 'confirm', title: 'Promote ' + name + ' to Raider?', text: name + ' becomes a Raider and the trial is over.', primary: { label: 'Promote to Raider' }, formAttrs: { 'data-submit': 'trial-promote-form' } });
  }

  // The date starts 14 days after the later of the current end and today; it must be after today.
  function extendDialogHtml(record, today) {
    const p = record.person;
    const t = today || record.today || '';
    const start = p.trialEnd && p.trialEnd > t ? p.trialEnd : t;
    const body = '<div class="gs-field"><label class="gs-label" for="dlg-tend">New trial end date</label><input class="gs-input" type="date" id="dlg-tend" name="trialEnd" data-field="trialEnd" min="' + esc(G.ui.addDays(t, 1)) + '" value="' + esc(G.ui.addDays(start, EXTEND_DAYS)) + '" aria-describedby="dlg-tend-help">' +
      '<p class="gs-fine" id="dlg-tend-help">The date must be after today. Officers get a flag 7 days before it.</p><p class="gs-field-error" id="dlg-err-trialEnd" role="alert" hidden></p></div>';
    return G.ui.dialogHtml({ kind: 'form', title: 'Extend ' + nameOf(record) + '\'s trial', bodyHtml: body, primary: { label: 'Extend trial' }, formAttrs: { 'data-submit': 'trial-extend-form' } });
  }

  // The note field is there only for people who may edit the officer notes: the note is saved into them.
  function endDialogHtml(record) {
    const name = nameOf(record);
    const canNotes = !!(record.can && record.can.notesEdit);
    const body = canNotes ? '<div class="gs-field"><label class="gs-label" for="dlg-note">Note (optional)</label><textarea class="gs-input gs-textarea" id="dlg-note" name="note" data-field="note" rows="3" maxlength="' + NOTE_MAX + '" aria-describedby="dlg-note-help"></textarea>' +
      '<p class="gs-fine" id="dlg-note-help">Added to the officer notes as "Trial ended" with today\'s date. ' + NOTE_MAX + ' characters at most.</p></div>' : '';
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'End ' + name + '\'s trial?', text: name + ' is set to Inactive with the reason Other. Their attendance and loot stay on record.', bodyHtml: body,
      primary: { label: 'End trial' }, formAttrs: { 'data-submit': 'trial-end-form' },
    });
  }

  // ── data ──
  // Reads the card for a Trial the viewer may edit; anything else has no card (and no request). A 403 / 404 is "no card" too.
  function loadCard(gid, pid, gd, record) {
    const open = st().person;
    const rec = record || (open && open.gid === gid && open.pid === pid ? open.record : null);
    if (!shows(rec)) { a().personTrialCard = { gid: gid, pid: pid, none: true }; return Promise.resolve(null); }
    return G.api.trial.get(gid, pid).then(function (data) {
      a().personTrialCard = { gid: gid, pid: pid, data: data, error: '' };
      return null;
    }, function (err) {
      const gone = !!(err && (err.status === 403 || err.status === 404));
      a().personTrialCard = gone ? { gid: gid, pid: pid, none: true } : { gid: gid, pid: pid, data: null, error: G.api.classify(err).text };
      return null;
    });
  }

  function cardState(gid, pid) {
    const c = a().personTrialCard;
    return c && c.gid === gid && c.pid === pid && !c.none ? c : null;
  }

  // ── behaviour ──
  // The open person record, when it is a Trial this viewer edits.
  function openTrial() {
    const c = ops().cur();
    return c && shows(c.rec) ? c : null;
  }

  function todayOf(c) {
    const s = cardState(c.gid, c.pid);
    return (s && s.data && s.data.today) || c.rec.today || '';
  }

  function focusId(id) {
    const el = typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
    if (el && el.focus) el.focus();
  }

  G.handlers.click['trial-promote'] = function () {
    const c = openTrial();
    if (!c) return;
    G.ui.openDialog(promoteDialogHtml(c.rec), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['trial-promote-form'] = function (form) {
    const c = openTrial();
    if (!c) return;
    return G.ui.runDialog(form, G.api.trial.update(c.gid, c.pid, { expectedVersion: c.rec.person.version, status: 'raider' }),
      function (res) { ops().applyRecord(c, res); }, function (err) { ops().conflict(c, err); });
  };

  G.handlers.click['trial-extend'] = function () {
    const c = openTrial();
    if (!c) return;
    G.ui.openDialog(extendDialogHtml(c.rec, todayOf(c)), { labelledBy: 'dlg-title' });
    focusId('dlg-tend');
  };

  G.handlers.submit['trial-extend-form'] = function (form) {
    const c = openTrial();
    if (!c) return;
    G.ui.setText('dlg-err-trialEnd', '');
    const v = form.elements.trialEnd.value;
    if (!v) { G.ui.setText('dlg-err-trialEnd', 'Choose the new end date.'); form.elements.trialEnd.focus(); return; }
    if (v <= todayOf(c)) { G.ui.setText('dlg-err-trialEnd', 'Choose a date after today.'); form.elements.trialEnd.focus(); return; }
    return G.ui.runDialog(form, G.api.trial.update(c.gid, c.pid, { expectedVersion: c.rec.person.version, trialEnd: v }),
      function (res) { ops().applyRecord(c, res); }, function (err) { ops().conflict(c, err); });
  };

  G.handlers.click['trial-end'] = function () {
    const c = openTrial();
    if (!c) return;
    G.ui.openDialog(endDialogHtml(c.rec), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    focusId('dlg-note');
  };

  // After the trial ended: one line goes onto the end of the officer notes. Best effort: the person is Inactive either way, so a failure
  // is a message on the page, not an error that undoes anything.
  function appendNote(gid, pid, record, note, today) {
    const notes = record && record.notes;
    const fail = function () { st().pageAlert = NOTE_FAILED; G.app.render(); };
    if (!notes) { fail(); return Promise.resolve(null); }
    const line = 'Trial ended ' + today + ': ' + note;
    const text = (notes.text ? String(notes.text).replace(/\s+$/, '') + '\n' : '') + line;
    return G.api.trial.saveNotes(gid, pid, { text: text, expectedNotesVersion: notes.version }).then(function (res) {
      const c = ops().cur();
      if (c && c.rec.notes && res && res.notes) c.rec.notes = res.notes;
      G.app.render();
      return null;
    }, fail);
  }

  G.handlers.submit['trial-end-form'] = function (form) {
    const c = openTrial();
    if (!c) return;
    const note = String(form.elements.note ? form.elements.note.value : '').trim().slice(0, NOTE_MAX);
    const today = todayOf(c);
    return G.ui.runDialog(form, G.api.trial.update(c.gid, c.pid, { expectedVersion: c.rec.person.version, status: 'inactive', leftReason: 'other' }), function (res) {
      ops().applyRecord(c, res);
      const rec = res && res.person ? res : c.rec;
      if (note && rec.can && rec.can.notesEdit) appendNote(c.gid, c.pid, rec, note, today);
    }, function (err) { ops().conflict(c, err); });
  };

  G.handlers.click['trial-retry'] = function () {
    const c = ops().cur();
    if (!c) return null;
    return loadCard(c.gid, c.pid, c.gd, c.rec).then(function () { G.app.render(); });
  };

  G.pages.personTrial = {
    NOTE_MAX: NOTE_MAX,
    NOTE_FAILED: NOTE_FAILED,
    shows: shows,
    sectionOf: sectionOf,
    cardHtml: cardHtml,
    cardState: cardState,
    loadCard: loadCard,
    promoteDialogHtml: promoteDialogHtml,
    extendDialogHtml: extendDialogHtml,
    endDialogHtml: endDialogHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
