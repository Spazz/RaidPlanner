// ── PAGE PIECE: THE SIGN-UPS PANEL OF A RAID ────────────────────
// Native Raidsmith sign-ups. GET /raids/:rid/signups answers with the merged list (a person's Raidsmith sign-up replaces their
// Raid-Helper row), the viewer's own part (`me`) and, for officers, the team's people (`roster`). A member signs themselves up with
// four big buttons (Sign up, Late, Tentative, Can't come) and a small form for the character, spec and a note, until the raid starts or
// an officer closes sign-ups or the team's deadline (hours before the start) passes; officers edit or remove anyone's, add one for someone without
// Discord, and close or reopen sign-ups. The counts read "expected / size" against the raid's size. A fifth button, Standby ("happy to sit out if
// needed"), has its own group; a person away by notice is a virtual Absent entry (source 'away', "Away (notice)": nothing to edit, a real sign-up
// replaces it), and Late / Leaving notices show as "Late 21:00" / "Leaves 22:00".
// pages-raid.js draws the panel and loads its data; the state lives in the attendance state bag (a().raidSignups).
(function (G) {
  'use strict';

  const NOTE_MAX = 120;
  const KIND_LABELS = { signed: 'Signed up', late: 'Late', standby: 'Standby', tentative: 'Tentative', bench: 'Bench', absence: 'Absent' };
  // The five a member picks, with the words on the buttons.
  const MY_KINDS = [['signed', 'Sign up'], ['late', 'Late'], ['standby', 'Standby'], ['tentative', 'Tentative'], ['absence', 'Can\'t come']];
  const OFFICER_KINDS = [['signed', 'Signed up'], ['late', 'Late'], ['standby', 'Standby'], ['tentative', 'Tentative'], ['bench', 'Bench'], ['absence', 'Absent']];
  const ROLE_ORDER = ['tank', 'healer', 'melee', 'ranged', 'none'];
  const ROLE_LABELS = { tank: 'Tanks', healer: 'Healers', melee: 'Melee', ranged: 'Ranged', none: 'No role yet' };
  const OTHER_ORDER = ['standby', 'tentative', 'bench', 'absence'];
  const OTHER_LABELS = { standby: 'Standby', tentative: 'Tentative', bench: 'Bench', absence: 'Absent' };
  const STANDBY_HINT = 'Standby: Happy to sit out if needed.';
  const CLASS_IDS = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'];

  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }

  // The state of the panel on the open raid page, or null while it is not loaded for that raid.
  function stateFor(gid, rid) {
    const x = a().raidSignups;
    return x && x.gid === gid && x.rid === rid ? x : null;
  }

  function cur() {
    const gd = currentGd();
    const r = a().raid;
    const x = gd && r ? stateFor(gd.guild.id, r.rid) : null;
    return x && x.status === 'ok' ? { gid: gd.guild.id, gd: gd, rid: r.rid, x: x, detail: r.data } : null;
  }

  // ── the form of my sign-up ──
  function specOf(character, wanted) {
    const specs = character && Array.isArray(character.specs) ? character.specs : [];
    if (wanted && specs.indexOf(wanted) >= 0) return wanted;
    if (character && character.mainSpec && specs.indexOf(character.mainSpec) >= 0) return character.mainSpec;
    return specs[0] || '';
  }

  // The form's starting values from the view: the character and spec of the viewer's current sign-up (a Raid-Helper one is matched
  // to the character it was named by), else their default character and its main spec.
  function formFrom(view) {
    const me = view && view.me;
    if (!me) return null;
    const chars = Array.isArray(me.characters) ? me.characters : [];
    const sig = me.signup;
    let ch = null;
    if (sig && sig.characterId) ch = chars.filter(function (c) { return c.id === sig.characterId; })[0] || null;
    if (!ch && sig && sig.name) ch = chars.filter(function (c) { return c.name === sig.name; })[0] || null;
    if (!ch) ch = chars.filter(function (c) { return c.id === me.defaultCharacterId; })[0] || chars[0] || null;
    return { characterId: ch ? ch.id : null, spec: specOf(ch, sig && sig.spec), note: sig && sig.note ? sig.note : '' };
  }

  function freshUi(view) {
    return { form: formFrom(view), error: '', busy: false, dialog: null };
  }

  function myCharacter(view, ui) {
    const chars = view.me && Array.isArray(view.me.characters) ? view.me.characters : [];
    return chars.filter(function (c) { return ui.form && c.id === ui.form.characterId; })[0] || chars[0] || null;
  }

  // ── view helpers ──
  function whenOf(detail, gd) {
    const r = detail && detail.raid ? detail.raid : {};
    return G.pages.raids.whenText({ raidOn: r.raidOn, startsAt: r.startsAt, timeKnown: r.timeKnown }, gd);
  }

  function hoursText(n) { return plural(n, 'hour', 'hours'); }

  // The pill text is long once a deadline is in it, so it may wrap (gs-su-status) instead of running off a phone's edge.
  function statusPillHtml(view, detail, gd) {
    const v = view.raid;
    if (v.closed === 'locked') return '<span class="gs-pill gs-pill-warn gs-su-status">Closed by an officer</span>';
    if (v.closed === 'started') return '<span class="gs-pill gs-pill-muted gs-su-status">The raid has started</span>';
    if (v.closed === 'deadline') return '<span class="gs-pill gs-pill-warn gs-su-status">Closed' + (typeof v.closesAt === 'number' ? ' ' + esc(G.pages.raids.momentText(v.closesAt, gd)) : '') + '</span>';
    if (v.closeHours > 0 && typeof v.closesAt === 'number') {
      return '<span class="gs-pill gs-pill-ok gs-su-status">Open until ' + esc(G.pages.raids.momentText(v.closesAt, gd)) + ' (sign-ups close ' + esc(hoursText(v.closeHours)) + ' before the start)</span>';
    }
    return '<span class="gs-pill gs-pill-ok gs-su-status">Open until ' + esc(whenOf(detail, gd)) + '</span>';
  }

  function closedText(view) {
    if (view.raid.closed === 'locked') return 'An officer has closed sign-ups. Ask an officer if you need to change yours.';
    if (view.raid.closed === 'deadline') return 'Sign-ups closed ' + hoursText(view.raid.closeHours) + ' before the start. Ask an officer if you need to change yours.';
    return 'The raid has started, so sign-ups can no longer be changed here. Ask an officer if you need to change yours.';
  }

  // "Late 21:00" / "Leaves 22:00": what a Late or Leaving early notice says about a raid.
  function noticeNote(n) {
    if (!n || !n.atTime) return '';
    return (n.kind === 'leaving' ? 'Leaves ' : 'Late ') + n.atTime;
  }

  function sourceNoteHtml(sig, notice) {
    const own = notice && noticeNote(notice) ? '<p class="gs-fine">Your notice for this raid: ' + esc(noticeNote(notice)) + '.</p>' : '';
    if (!sig) return '<p class="gs-fine">You have not signed up yet.</p>' + own;
    if (sig.source === 'away') return '<p class="gs-fine">You are away (notice). Choosing a status here overrides it.</p>' + own;
    if (sig.source === 'raid_helper') {
      return '<p class="gs-fine">You are down as ' + esc(String(KIND_LABELS[sig.kind] || sig.kind).toLowerCase()) + ' on Raid-Helper. Choosing a status here saves a sign-up in Raidsmith that replaces it.</p>' + own;
    }
    return '<p class="gs-fine">You are down as <strong>' + esc(String(KIND_LABELS[sig.kind] || sig.kind).toLowerCase()) + '</strong>' +
      (sig.name ? ' with ' + esc(sig.name) : '') + (sig.spec ? ' (' + esc(sig.spec) + ')' : '') + '.</p>' +
      (sig.standing ? '<p class="gs-fine">This sign-up comes from your standing sign-up. Skip this week marks you absent for this raid only.</p>' : '') + own;
  }

  // The viewer's own part: four status buttons, then the character / spec / note form.
  function mineHtml(view, ui) {
    const me = view.me;
    if (!me) return '';
    const sig = me.signup;
    const open = !!me.canChange;
    const chars = Array.isArray(me.characters) ? me.characters : [];
    const form = ui.form || { characterId: null, spec: '', note: '' };
    const ch = myCharacter(view, ui);
    // A person away by notice has not chosen a status: no button is pressed.
    const buttons = MY_KINDS.map(function (k) {
      const on = sig && sig.source !== 'away' && sig.kind === k[0];
      return '<button type="button" class="gs-btn gs-su-kind' + (k[0] === 'signed' && !on ? ' gs-btn-molten' : '') + '" data-action="su-kind" data-kind="' + k[0] + '" data-key="su-kind-' + k[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (k[0] === 'standby' ? ' aria-describedby="su-standby-hint"' : '') + (open && !ui.busy ? '' : ' disabled') + '>' + esc(k[1]) + '</button>';
    }).join('');
    const charField = chars.length > 1
      ? '<div class="gs-field"><label class="gs-label" for="su-char">Character</label><select class="gs-input" id="su-char" data-change="su-char" data-key="su-char"' + (open ? '' : ' disabled') + '>' +
        G.ui.optionsHtml(chars.map(function (c) { return { value: c.id, label: c.name + ' (' + G.ui.className(c.class) + ')' }; }), form.characterId) + '</select></div>'
      : '';
    const specField = ch
      ? '<div class="gs-field"><label class="gs-label" for="su-spec">Spec</label><select class="gs-input" id="su-spec" data-change="su-spec" data-key="su-spec"' + (open ? '' : ' disabled') + '>' +
        G.ui.optionsHtml([{ value: '', label: 'No spec' }].concat((ch.specs || []).map(function (s) { return { value: s, label: s }; })), form.spec) + '</select></div>'
      : '';
    const noteField = '<div class="gs-field"><label class="gs-label" for="su-note">Note (optional)</label><input class="gs-input" type="text" id="su-note" data-input="su-note" data-key="su-note" maxlength="' + NOTE_MAX + '" autocomplete="off" value="' + esc(form.note) + '"' + (open ? '' : ' disabled') + '></div>';
    const save = sig && sig.source !== 'away' && open
      ? '<div class="gs-row-actions"><button type="submit" class="gs-btn gs-btn-sm" data-key="su-save"' + (ui.busy ? ' disabled' : '') + '>Save details</button>' +
        (sig.source === 'raidsmith' ? '<button type="button" class="gs-btn gs-btn-sm" data-action="su-withdraw" data-key="su-withdraw"' + (ui.busy ? ' disabled' : '') + '>' + (sig.standing ? 'Skip this week' : 'Remove my sign-up') + '</button>' : '') + '</div>'
      : '';
    return '<div class="gs-su-me" role="group" aria-labelledby="su-me-h"><h3 class="gs-h3" id="su-me-h">Your sign-up</h3>' + sourceNoteHtml(sig, me.notice) +
      (open ? '' : '<p class="gs-notice" role="status">' + esc(closedText(view)) + '</p>') +
      '<div class="gs-su-kinds" role="group" aria-label="Your status">' + buttons + '</div><p class="gs-fine" id="su-standby-hint">' + esc(STANDBY_HINT) + '</p>' +
      '<form class="gs-su-form" data-submit="su-details-form" novalidate><div class="gs-su-fields">' + charField + specField + noteField + '</div>' + save + '</form>' +
      '<p class="gs-alert" id="su-error" role="alert"' + (ui.error ? '' : ' hidden') + '>' + esc(ui.error) + '</p></div>';
  }

  // "Signed 23 (2 late), Tentative 1 ..." as a row of numbers, then the class counts.
  function countsHtml(view) {
    const c = view.counts;
    if (!c) return '';
    // The people expected (signed up and late) against the raid's size, first.
    const sized = typeof view.raid.size === 'number' && view.raid.size > 0 && typeof c.expected === 'number';
    const items = (sized ? [['Expected', c.expected + ' / ' + view.raid.size]] : []).concat([['Signed', c.signed], ['Late', c.late]]).concat(typeof c.standby === 'number' ? [['Standby', c.standby]] : [], [['Tentative', c.tentative], ['Bench', c.bench], ['Absent', c.absence]]);
    const classes = CLASS_IDS.filter(function (id) { return c.byClass && c.byClass[id] > 0; }).map(function (id) {
      return '<li class="gs-su-class">' + G.ui.classNameHtml(G.ui.className(id), id) + ' <span class="gs-su-count">' + esc(c.byClass[id]) + '</span></li>';
    }).join('');
    return '<dl class="gs-summary">' + items.map(function (i) { return '<div class="gs-summary-item"><dt>' + esc(i[0]) + '</dt><dd>' + esc(i[1]) + '</dd></div>'; }).join('') + '</dl>' +
      (classes ? '<ul class="gs-su-classes" aria-label="Signed up and late, by class">' + classes + '</ul>' : '');
  }

  function toolsHtml(entry, edit) {
    if (!edit || !entry.personId || entry.source === 'away') return ''; // an away notice is not a sign-up to change: a real sign-up replaces it
    return '<span class="gs-row-actions gs-su-tools"><button type="button" class="gs-btn gs-btn-sm" data-action="su-edit" data-pid="' + esc(entry.personId) + '" data-key="su-edit-' + esc(entry.personId) + '">Edit</button>' +
      (entry.source === 'raidsmith' ? '<button type="button" class="gs-btn gs-btn-sm" data-action="su-remove" data-pid="' + esc(entry.personId) + '" data-key="su-remove-' + esc(entry.personId) + '">Remove</button>' : '') + '</span>';
  }

  function entryHtml(entry, edit) {
    const name = entry.name ? G.ui.classNameHtml(entry.name, entry.classId) : '<span class="gs-muted">Unmatched sign-up</span>';
    // A row nobody may name still says what was signed up (its class is not coloured: there is no name to colour).
    const specText = entry.name ? (entry.spec || '') : [entry.className, entry.spec].filter(Boolean).join(' - ');
    return '<li class="gs-su-item' + (entry.isMe ? ' is-me' : '') + '"><span class="gs-su-who">' + name + (entry.isMe ? ' <span class="gs-chip gs-chip-main">You</span>' : '') + '</span>' +
      (specText ? '<span class="gs-su-spec">' + esc(specText) + '</span>' : '') +
      (entry.kind === 'late' ? '<span class="gs-chip gs-chip-signup">Late</span>' : '') +
      (entry.source === 'away' ? '<span class="gs-chip gs-chip-signup">Away (notice)</span>' : '') +
      (entry.standing ? '<span class="gs-chip gs-chip-src">standing</span>' : '') +
      (entry.notice && noticeNote(entry.notice) ? '<span class="gs-chip gs-chip-signup">' + esc(noticeNote(entry.notice)) + '</span>' : '') +
      (entry.source === 'raid_helper' ? '<span class="gs-chip gs-chip-src">Raid-Helper</span>' : '') +
      (entry.nickname ? '<span class="gs-fine">' + esc(entry.nickname) + '</span>' : '') + toolsHtml(entry, edit) +
      (entry.note ? '<span class="gs-su-note">' + esc(entry.note) + '</span>' : '') + '</li>';
  }

  function groupHtml(title, id, entries, edit) {
    return '<section class="gs-su-group" aria-labelledby="su-g-' + id + '"><h3 class="gs-su-group-h" id="su-g-' + id + '">' + esc(title) + ' <span class="gs-su-count">' + entries.length + '</span></h3>' +
      '<ul class="gs-su-list">' + entries.map(function (e) { return entryHtml(e, edit); }).join('') + '</ul></section>';
  }

  // The Late / Leaving notices of people the list does not already show them on (they have no sign-up yet): one group, a line each.
  function noticesGroupHtml(view, entries) {
    const shown = {};
    entries.forEach(function (e) { if (e.notice && e.personId) shown[e.personId] = true; });
    const rest = (Array.isArray(view.notices) ? view.notices : []).filter(function (n) { return noticeNote(n) && !shown[n.personId]; });
    if (!rest.length) return '';
    return '<section class="gs-su-group" aria-labelledby="su-g-notices"><h3 class="gs-su-group-h" id="su-g-notices">Notices <span class="gs-su-count">' + rest.length + '</span></h3><ul class="gs-su-list">' +
      rest.map(function (n) { return '<li class="gs-su-item"><span class="gs-su-who">' + esc(n.name) + '</span><span class="gs-chip gs-chip-signup">' + esc(noticeNote(n)) + '</span></li>'; }).join('') + '</ul></section>';
  }

  // Signed and Late by role, then Standby, Tentative, Bench and Absent (people away by notice are in Absent). Empty groups are left out.
  function listHtml(view) {
    const entries = Array.isArray(view.entries) ? view.entries : [];
    const edit = !!view.can.edit;
    if (!entries.length) return '<p class="gs-empty">No sign-ups yet.</p>' + (noticesGroupHtml(view, entries) ? '<div class="gs-su-groups">' + noticesGroupHtml(view, entries) + '</div>' : '');
    const coming = entries.filter(function (e) { return e.kind === 'signed' || e.kind === 'late'; });
    const groups = ROLE_ORDER.map(function (role) {
      const list = coming.filter(function (e) { return (e.role || 'none') === role; });
      return list.length ? groupHtml(ROLE_LABELS[role], role, list, edit) : '';
    });
    OTHER_ORDER.forEach(function (kind) {
      const list = entries.filter(function (e) { return e.kind === kind; });
      if (list.length) groups.push(groupHtml(OTHER_LABELS[kind], kind, list, edit));
    });
    groups.push(noticesGroupHtml(view, entries));
    return '<div class="gs-su-groups">' + groups.join('') + '</div>';
  }

  function officerBarHtml(view) {
    if (!view.can.edit) return '';
    const locked = !!view.raid.locked;
    return '<span class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="su-add" data-key="su-add">Add a sign-up</button>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="su-lock" data-lock="' + (locked ? '0' : '1') + '" data-key="su-lock">' + (locked ? 'Reopen sign-ups' : 'Close sign-ups') + '</button></span>';
  }

  function errorCardHtml(x) {
    return '<section class="gs-card-sec" aria-labelledby="su-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="su-h">Sign-ups</h2></div><div class="gs-card-sec-body">' +
      '<p class="gs-alert" role="alert">' + esc(x.message || 'Could not load the sign-ups.') + '</p><div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="su-retry" data-key="su-retry">Try again</button></div></div></section>';
  }

  // opts: { guildData, data (the raid detail), state (stateFor) }
  function panelHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    if (x && x.status === 'error') return errorCardHtml(x);
    if (!x || x.status !== 'ok' || !x.data) return '';
    const view = x.data;
    const detail = opts.data;
    const upcoming = !!(detail.raid && detail.raid.upcoming);
    // After the start the panel is for officers and for reading what was signed up.
    if (!upcoming && !view.can.edit && !(Array.isArray(view.entries) && view.entries.length)) return '';
    const body = view.can.seeList
      ? countsHtml(view) + listHtml(view)
      : '<p class="gs-empty">Sign-ups are visible to the team\'s members.</p>';
    return '<section class="gs-card-sec gs-su" aria-labelledby="su-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="su-h">Sign-ups</h2>' + statusPillHtml(view, detail, gd) + officerBarHtml(view) + '</div>' +
      '<div class="gs-card-sec-body">' + mineHtml(view, x.ui || freshUi(view)) + body + '</div></section>';
  }

  // ── officer dialog: add or change one person's sign-up ──
  function personEntry(view, personId) {
    return (Array.isArray(view.entries) ? view.entries : []).filter(function (e) { return e.personId === personId; })[0] || null;
  }

  function rosterPerson(view, personId) {
    return (Array.isArray(view.roster) ? view.roster : []).filter(function (p) { return p.personId === personId; })[0] || null;
  }

  function characterLabel(c) { return c.name + ' (' + G.ui.className(c.class) + ')'; }

  function charOptionsHtml(person, selectedId) {
    return G.ui.optionsHtml((person ? person.characters : []).map(function (c) { return { value: c.id, label: characterLabel(c) }; }), selectedId);
  }

  function specOptionsHtml(character, selected) {
    return G.ui.optionsHtml([{ value: '', label: 'No spec' }].concat(((character && character.specs) || []).map(function (s) { return { value: s, label: s }; })), selected);
  }

  // The starting values for a person: their sign-up, else their default character and its main spec.
  function dialogDefaults(view, person) {
    if (!person) return { characterId: '', spec: '', kind: 'signed', note: '' };
    const found = personEntry(view, person.personId);
    const entry = found && found.source === 'away' ? null : found;
    const ch = (entry && entry.characterId ? person.characters.filter(function (c) { return c.id === entry.characterId; })[0] : null) ||
      (entry && entry.name ? person.characters.filter(function (c) { return c.name === entry.name; })[0] : null) || person.characters[0] || null;
    return { characterId: ch ? ch.id : '', spec: specOf(ch, entry && entry.spec), kind: entry ? entry.kind : 'signed', note: entry && entry.note ? entry.note : '' };
  }

  // opts: { view, personId | null (null = adding: pick a person) }
  function editDialogHtml(opts) {
    const view = opts.view;
    const person = opts.personId ? rosterPerson(view, opts.personId) : (Array.isArray(view.roster) ? view.roster[0] : null);
    const adding = !opts.personId;
    const d = dialogDefaults(view, person);
    const ch = person ? person.characters.filter(function (c) { return c.id === d.characterId; })[0] : null;
    const people = (Array.isArray(view.roster) ? view.roster : []).map(function (p) { return { value: p.personId, label: p.name + (personEntry(view, p.personId) ? ' - ' + (personEntry(view, p.personId).source === 'away' ? 'Away (notice)' : KIND_LABELS[personEntry(view, p.personId).kind] || '') : '') }; });
    return '<form class="gs-dialog-form" data-submit="su-edit-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">' + (adding ? 'Add a sign-up' : 'Change a sign-up') + '</h2>' +
      '<p class="gs-fine" id="dlg-help">' + (adding ? 'For someone who has not signed up themselves, or has no Discord.' : esc(person ? person.name : '')) + '</p>' +
      (adding
        ? '<div class="gs-field"><label class="gs-label" for="su-d-person">Person</label><select class="gs-input" id="su-d-person" name="person" data-change="su-dlg-person">' + G.ui.optionsHtml(people, person ? person.personId : '') + '</select></div>'
        : '<input type="hidden" name="person" value="' + esc(opts.personId) + '">') +
      '<div class="gs-field"><label class="gs-label" for="su-d-kind">Status</label><select class="gs-input" id="su-d-kind" name="kind" data-field="kind">' + G.ui.optionsHtml(OFFICER_KINDS.map(function (k) { return { value: k[0], label: k[1] }; }), d.kind) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="su-d-char">Character</label><select class="gs-input" id="su-d-char" name="character" data-change="su-dlg-char" data-field="characterId">' + charOptionsHtml(person, d.characterId) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="su-d-spec">Spec</label><select class="gs-input" id="su-d-spec" name="spec" data-field="spec">' + specOptionsHtml(ch, d.spec) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="su-d-note">Note (optional)</label><input class="gs-input" type="text" id="su-d-note" name="note" maxlength="' + NOTE_MAX + '" autocomplete="off" data-field="note" value="' + esc(d.note) + '"><p class="gs-field-error" id="dlg-err-note" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="dlg-submit">Save sign-up</button></div></form>';
  }

  function removeDialogHtml(personId, name) {
    return '<form class="gs-dialog-form" data-submit="su-remove-form" data-pid="' + esc(personId) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">Remove this sign-up?</h2>' +
      '<p class="gs-confirm-text" id="dlg-text">' + esc(name || 'This person') + '\'s Raidsmith sign-up is removed. A Raid-Helper sign-up of theirs, if there is one, shows again.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove sign-up</button></div></form>';
  }

  // ── data ──
  function loadFor(gd, detail) {
    const gid = gd.guild.id;
    const raid = detail && detail.raid;
    if (!raid) { a().raidSignups = { gid: gid, rid: null, status: 'none' }; return Promise.resolve(null); }
    const prev = a().raidSignups;
    return G.api.signups.view(gid, raid.id).then(function (view) {
      const same = prev && prev.gid === gid && prev.rid === raid.id && prev.ui;
      a().raidSignups = { gid: gid, rid: raid.id, status: 'ok', data: view, ui: same ? Object.assign({}, prev.ui, { form: formFrom(view), error: '', busy: false }) : freshUi(view) };
      return null;
    }, function (err) {
      // A lost sign-in goes to the route's handler; anything else is a card with a retry.
      if (G.api.classify(err).view !== 'inline') throw err;
      a().raidSignups = { gid: gid, rid: raid.id, status: 'error', message: G.api.classify(err).text };
      return null;
    });
  }

  function setView(c, view) {
    c.x.data = view;
    c.x.ui = Object.assign(freshUi(view), { dialog: null });
    G.app.render();
    // A past raid's results depend on its sign-ups: the page's own detail is read again.
    if (c.detail && c.detail.raid && !c.detail.raid.upcoming && G.pages.raid && G.pages.raid.reload) G.pages.raid.reload();
  }

  function showError(c, err) {
    const cl = G.api.classify(err);
    if (cl.view === 'signin') { G.app.requireSignin(); return Promise.resolve(); }
    if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return Promise.resolve(); }
    c.x.ui.busy = false;
    c.x.ui.error = cl.text;
    // The window closed or the sign-up changed under the page: show what is true now, with the reason.
    if (err && (err.code === 'signups_closed' || err.status === 404)) {
      return G.api.signups.view(c.gid, c.rid).then(function (view) { c.x.data = view; c.x.ui.form = formFrom(view); G.app.render(); }, function () { G.app.render(); });
    }
    G.app.render();
    return Promise.resolve();
  }

  function run(c, promise) {
    c.x.ui.busy = true;
    c.x.ui.error = '';
    G.app.render();
    return promise.then(function (view) { setView(c, view); }, function (err) { return showError(c, err); });
  }

  // The body a status button or Save details sends: the form as it stands.
  function bodyFor(c, kind) {
    const form = c.x.ui.form || {};
    const body = { kind: kind };
    if (form.characterId) body.characterId = form.characterId;
    body.spec = form.spec ? form.spec : null;
    body.note = form.note ? form.note : null;
    return body;
  }

  // ── handlers ──
  G.handlers.click['su-kind'] = function (el) {
    const c = cur();
    if (!c || !c.x.data.me) return;
    return run(c, G.api.signups.save(c.gid, c.rid, bodyFor(c, el.getAttribute('data-kind'))));
  };

  G.handlers.submit['su-details-form'] = function () {
    const c = cur();
    if (!c || !c.x.data.me || !c.x.data.me.signup) return;
    return run(c, G.api.signups.save(c.gid, c.rid, bodyFor(c, c.x.data.me.signup.kind)));
  };

  G.handlers.click['su-withdraw'] = function () {
    const c = cur();
    if (!c) return;
    return run(c, G.api.signups.withdraw(c.gid, c.rid));
  };

  G.handlers.change['su-char'] = function (el) {
    const c = cur();
    if (!c) return;
    const chars = c.x.data.me ? c.x.data.me.characters : [];
    const ch = chars.filter(function (x) { return x.id === el.value; })[0];
    if (!ch) return;
    c.x.ui.form.characterId = ch.id;
    c.x.ui.form.spec = specOf(ch, null);
    G.app.render();
  };

  G.handlers.change['su-spec'] = function (el) {
    const c = cur();
    if (c && c.x.ui.form) c.x.ui.form.spec = el.value;
  };

  G.handlers.input['su-note'] = function (el) {
    const c = cur();
    if (c && c.x.ui.form) c.x.ui.form.note = el.value;
  };

  G.handlers.click['su-lock'] = function (el) {
    const c = cur();
    if (!c) return;
    return run(c, G.api.signups.lock(c.gid, c.rid, el.getAttribute('data-lock') === '1'));
  };

  G.handlers.click['su-retry'] = function () {
    const gd = currentGd();
    const r = a().raid;
    if (!gd || !r || !r.data) return;
    loadFor(gd, r.data).then(function () { G.app.render(); });
  };

  G.handlers.click['su-add'] = function () {
    const c = cur();
    if (!c || !c.x.data.roster || !c.x.data.roster.length) return;
    G.ui.openDialog(editDialogHtml({ view: c.x.data, personId: null }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.click['su-edit'] = function (el) {
    const c = cur();
    const pid = el.getAttribute('data-pid');
    if (!c || !rosterPerson(c.x.data, pid)) return;
    G.ui.openDialog(editDialogHtml({ view: c.x.data, personId: pid }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.click['su-remove'] = function (el) {
    const c = cur();
    const pid = el.getAttribute('data-pid');
    if (!c) return;
    const entry = personEntry(c.x.data, pid);
    G.ui.openDialog(removeDialogHtml(pid, entry ? entry.name : ''), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  // The person in the Add dialog changed: their characters and the starting values replace the rest of the form.
  G.handlers.change['su-dlg-person'] = function (el) {
    const c = cur();
    const form = el.closest('form');
    if (!c || !form) return;
    const person = rosterPerson(c.x.data, el.value);
    const d = dialogDefaults(c.x.data, person);
    form.elements.kind.value = d.kind;
    form.elements.character.innerHTML = charOptionsHtml(person, d.characterId);
    const ch = person ? person.characters.filter(function (x) { return x.id === d.characterId; })[0] : null;
    form.elements.spec.innerHTML = specOptionsHtml(ch, d.spec);
    form.elements.note.value = d.note;
  };

  // The character in the dialog changed: the specs of that class, its main spec chosen.
  G.handlers.change['su-dlg-char'] = function (el) {
    const c = cur();
    const form = el.closest('form');
    if (!c || !form) return;
    const person = rosterPerson(c.x.data, form.elements.person.value);
    const ch = person ? person.characters.filter(function (x) { return x.id === el.value; })[0] : null;
    form.elements.spec.innerHTML = specOptionsHtml(ch, specOf(ch, null));
  };

  G.handlers.submit['su-edit-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const body = { kind: form.elements.kind.value, characterId: form.elements.character.value || undefined, spec: form.elements.spec.value || null, note: String(form.elements.note.value || '').trim() || null };
    G.ui.setText('dlg-error', '');
    G.ui.setText('dlg-err-note', '');
    return G.ui.runDialog(form, G.api.signups.savePerson(c.gid, c.rid, form.elements.person.value, body), function (view) { setView(c, view); });
  };

  G.handlers.submit['su-remove-form'] = function (form) {
    const c = cur();
    if (!c) return;
    return G.ui.runDialog(form, G.api.signups.removePerson(c.gid, c.rid, form.getAttribute('data-pid')), function (view) { setView(c, view); });
  };

  G.pages.raidSignups = {
    KIND_LABELS: KIND_LABELS,
    MY_KINDS: MY_KINDS,
    ROLE_ORDER: ROLE_ORDER,
    stateFor: stateFor,
    freshUi: freshUi,
    formFrom: formFrom,
    panelHtml: panelHtml,
    mineHtml: mineHtml,
    listHtml: listHtml,
    countsHtml: countsHtml,
    editDialogHtml: editDialogHtml,
    removeDialogHtml: removeDialogHtml,
    bodyFor: bodyFor,
    loadFor: loadFor,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
