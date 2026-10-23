// ── PAGE PIECE: THE SIGN-UPS PANEL OF A RAID ────────────────────
// Native Raidsmith sign-ups. GET /raids/:rid/signups answers with the merged list (a person's Raidsmith sign-up replaces their
// Raid-Helper row), the viewer's own part (`me`) and, for officers, the team's people (`roster`). A member signs themselves up from the
// raid page's You bar (pages-raid-you.js: five status pills, and a dialog for the character, spec and a note; the pieces and the handlers are here), until the raid starts or
// an officer closes sign-ups or the team's deadline (hours before the start) passes; officers edit or remove anyone's, add one for someone without
// Discord, and close or reopen sign-ups. The counts read "expected / size" against the raid's size. A fifth button, Standby ("happy to sit out if
// needed"), has its own group; a person away by notice is a virtual Can't come entry (source 'away', "Away (notice)": nothing to edit, a real sign-up
// replaces it), and Late / Leaving notices show as "Late 21:00" / "Leaves 22:00".
// pages-raid.js draws the panel and loads its data; the state lives in the attendance state bag (a().raidSignups).
(function (G) {
  'use strict';

  const NOTE_MAX = 120;
  const KIND_LABELS = { signed: 'Signed up', late: 'Late', standby: 'Standby', tentative: 'Tentative', bench: 'Bench', absence: 'Can\'t come' };
  // The five a member picks, with the words on the buttons.
  const MY_KINDS = [['signed', 'Signed up'], ['late', 'Late'], ['standby', 'Standby'], ['tentative', 'Tentative'], ['absence', 'Can\'t come']];
  const OFFICER_KINDS = [['signed', 'Signed up'], ['late', 'Late'], ['standby', 'Standby'], ['tentative', 'Tentative'], ['bench', 'Bench'], ['absence', 'Can\'t come']];
  const ROLE_ORDER = ['tank', 'healer', 'melee', 'ranged', 'none'];
  const ROLE_LABELS = { tank: 'Tanks', healer: 'Healers', melee: 'Melee', ranged: 'Ranged', none: 'No role yet' };
  const OTHER_ORDER = ['standby', 'tentative', 'bench', 'absence'];
  const OTHER_LABELS = { standby: 'Standby', tentative: 'Tentative', bench: 'Bench', absence: 'Can\'t come' };
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
  function hoursText(n) { return plural(n, 'hour', 'hours'); }

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
      (sig.standing ? '<p class="gs-fine">This sign-up comes from your standing sign-up. Skip this week sets you to Can\'t come for this raid only.</p>' : '') + own;
  }

  // The viewer's own part lives in the raid page's You bar (pages-raid-you.js), which asks for these pieces: the five status pills and the dialog with the
  // character, spec and note (the old "Your sign-up" form).
  // opts.molten: the first pill is the page's one primary (a member who has not signed up and has no other primary on screen).
  function pillsHtml(view, ui, opts) {
    const me = view.me;
    if (!me) return '';
    const sig = me.signup;
    const open = !!me.canChange;
    const molten = !!(opts && opts.molten) && open;
    // A person away by notice has not chosen a status: no button is pressed.
    const buttons = MY_KINDS.map(function (k) {
      const on = sig && sig.source !== 'away' && sig.kind === k[0];
      return '<button type="button" class="gs-btn gs-su-kind' + (k[0] === 'signed' && !on && molten ? ' gs-btn-molten' : '') + '" data-action="su-kind" data-kind="' + k[0] + '" data-key="' + (opts && opts.keyPrefix ? opts.keyPrefix : 'su-kind-') + k[0] + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
        (k[0] === 'standby' ? ' aria-describedby="su-standby-hint"' : '') + (open && !ui.busy ? '' : ' disabled') + '>' + esc(k[1]) + '</button>';
    }).join('');
    return '<div class="gs-su-kinds" role="group" aria-label="Your status">' + buttons + '</div><span class="gs-sr" id="su-standby-hint">' + esc(STANDBY_HINT) + '</span>';
  }

  // The dialog behind "Change character or note" (and, while the viewer sits in a published line-up, "Change sign-up" with the pills on top): today's Character,
  // Spec and Note fields, Save details and Remove my sign-up / Skip this week. Nothing is sent from the fields until Save details.
  function detailsDialogHtml(view, ui, withPills) {
    const me = view.me;
    if (!me) return '';
    const sig = me.signup;
    const open = !!me.canChange;
    const chars = Array.isArray(me.characters) ? me.characters : [];
    const form = ui.form || { characterId: null, spec: '', note: '' };
    const ch = myCharacter(view, ui);
    const charField = chars.length > 1
      ? '<div class="gs-field"><label class="gs-label" for="su-char">Character</label><select class="gs-input" id="su-char" data-change="su-mine-char" data-key="su-char"' + (open ? '' : ' disabled') + '>' +
        G.ui.optionsHtml(chars.map(function (c) { return { value: c.id, label: c.name + ' (' + G.ui.className(c.class) + ')' }; }), form.characterId) + '</select></div>'
      : '';
    const specField = ch
      ? '<div class="gs-field"><label class="gs-label" for="su-spec">Spec</label><select class="gs-input" id="su-spec" data-change="su-spec" data-key="su-spec"' + (open ? '' : ' disabled') + '>' +
        G.ui.optionsHtml([{ value: '', label: 'No spec' }].concat((ch.specs || []).map(function (s) { return { value: s, label: s }; })), form.spec) + '</select></div>'
      : '';
    const noteField = '<div class="gs-field"><label class="gs-label" for="su-note">Note (optional)</label><input class="gs-input" type="text" id="su-note" data-input="su-note" data-key="su-note" maxlength="' + NOTE_MAX + '" autocomplete="off" value="' + esc(form.note) + '"' + (open ? '' : ' disabled') + '></div>';
    const saves = !!(sig && sig.source !== 'away'); // with a sign-up the details are sent; without one they wait in the form for the first status pill (Done)
    const withdraw = sig && sig.source === 'raidsmith' && open
      ? '<button type="button" class="gs-btn" data-action="su-withdraw" data-key="su-withdraw"' + (ui.busy ? ' disabled' : '') + '>' + (sig.standing ? 'Skip this week' : 'Remove my sign-up') + '</button>'
      : '';
    return '<form class="gs-dialog-form gs-forge" data-submit="su-details-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">' + (withPills ? 'Change sign-up' : 'Change character or note') + '</h2>' +
      '<div id="dlg-help">' + sourceNoteHtml(sig, me.notice) + (open ? '' : '<p class="gs-notice" role="status">' + esc(closedText(view)) + '</p>') + '</div>' +
      (withPills ? pillsHtml(view, ui, { keyPrefix: 'su-dlg-kind-' }) : '') +
      '<div class="gs-su-fields">' + charField + specField + noteField + '</div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions">' + withdraw + '<button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button>' +
      (open ? '<button type="submit" class="gs-btn gs-btn-molten" data-key="su-save"' + (ui.busy ? ' disabled' : '') + '>' + (saves ? 'Save details' : 'Done') + '</button>' : '') + '</div></form>';
  }

  // ── the people board (Forge panel: four role columns, then one line per extra group, then the class words) ──
  const BOARD_ROLES = ['tank', 'healer', 'melee', 'ranged'];
  const LINE_GROUPS = [['none', 'No role yet'], ['standby', 'Standby'], ['tentative', 'Tentative'], ['bench', 'Bench'], ['absence', 'Can\'t come']];

  function nameKey(e) { return String(e.name || '').toLowerCase(); }
  function byName(x, y) { return nameKey(x) < nameKey(y) ? -1 : nameKey(x) > nameKey(y) ? 1 : 0; }

  function groupHeadHtml(title, count, tag) {
    return '<' + tag + ' class="gs-fg-gh"><span class="gs-fg-ght">' + esc(title) + '</span><span class="gs-fg-ghn">' + esc(count) + '</span></' + tag + '>';
  }

  function greyChip(label) { return '<span class="gs-hd-chip is-grey">' + esc(label) + '</span>'; }

  // The button an officer presses on a name: a person's sign-up opens "Change a sign-up", a guest's opens the guest dialog. An away notice has no button.
  function nameActionOf(entry, edit) {
    if (!edit) return null;
    if (entry.guest && entry.signupId != null) return { action: 'su-guest-open', attrs: ' data-sid="' + esc(entry.signupId) + '" data-key="su-guest-' + esc(entry.signupId) + '"', label: 'Change the guest sign-up of ' };
    if (!entry.personId || entry.source === 'away') return null;
    return { action: 'su-edit', attrs: ' data-pid="' + esc(entry.personId) + '" data-key="su-edit-' + esc(entry.personId) + '"', label: 'Change the sign-up of ' };
  }

  function rowHtml(entry, edit) {
    const name = entry.name ? G.ui.classNameHtml(entry.name, entry.classId || entry.nameClassId) : '<span class="gs-muted">Unmatched sign-up</span>';
    const specText = entry.name ? (entry.spec || '') : [entry.className, entry.spec].filter(Boolean).join(' - ');
    const nick = entry.nickname && entry.nickname !== entry.name ? entry.nickname : '';
    const text = '<span class="gs-rb-nm">' + name + '</span>' + (specText ? '<span class="gs-rb-sp">' + esc(specText) + '</span>' : '') +
      (nick ? '<span class="gs-rb-sp">' + esc(nick) + '</span>' : '') + (entry.note ? '<span class="gs-rb-sp">' + esc(entry.note) + '</span>' : '');
    const act = nameActionOf(entry, edit);
    const id = act
      ? '<button type="button" class="gs-rb-id gs-rb-btn" data-action="' + act.action + '"' + act.attrs + ' aria-label="' + esc(act.label + (entry.name || 'this player')) + '">' + text + '</button>'
      : '<span class="gs-rb-id">' + text + '</span>';
    const chips = (entry.kind === 'late' ? greyChip('Late') : '') + (entry.guest ? greyChip('Guest') : '') + (entry.source === 'away' ? greyChip('Away (notice)') : '') +
      (entry.notice && noticeNote(entry.notice) ? greyChip(noticeNote(entry.notice)) : '');
    return '<li class="gs-rb-row' + (entry.isMe ? ' is-you' : '') + '">' + (entry.name ? G.ui.specIconHtml(entry.classId, entry.spec, 20) : '') + id +
      (chips ? '<span class="gs-rb-chips">' + chips + '</span>' : '') + (entry.isMe ? '<span class="gs-you">You</span>' : '') + '</li>';
  }

  function columnHtml(role, list, edit) {
    return '<section class="gs-rb-col" aria-label="' + esc(ROLE_LABELS[role]) + '">' + groupHeadHtml(ROLE_LABELS[role], list.length, 'h3') +
      '<ul class="gs-rb-list">' + list.map(function (e) { return rowHtml(e, edit); }).join('') + '</ul></section>';
  }

  // One name inside a group line: a button for an officer, plain text otherwise (class colour on the name only).
  function lineNameHtml(entry, edit) {
    const name = entry.name ? G.ui.classNameHtml(entry.name, entry.classId || entry.nameClassId) : '<span class="gs-muted">Unmatched sign-up</span>';
    const act = nameActionOf(entry, edit);
    const away = entry.source === 'away' ? ' <span class="gs-rb-mut">(away notice)</span>' : '';
    return '<li>' + (act
      ? '<button type="button" class="gs-rb-btn gs-rb-lbtn" data-action="' + act.action + '"' + act.attrs + ' aria-label="' + esc(act.label + (entry.name || 'this player')) + '">' + name + '</button>'
      : name + away) + (entry.isMe ? '<span class="gs-you">You</span>' : '') + '</li>';
  }

  function lineHtml(title, entries, edit) {
    return '<div class="gs-rb-line">' + groupHeadHtml(title, entries.length, 'h3') + '<ul class="gs-rb-names">' +
      entries.map(function (e) { return lineNameHtml(e, edit); }).join('') + '</ul></div>';
  }

  // The Late / Leaving notices of people the board does not already show them on (they have no sign-up yet): one line, plain names.
  function noticesLineHtml(view, entries) {
    const shown = {};
    entries.forEach(function (e) { if (e.notice && e.personId) shown[e.personId] = true; });
    const rest = (Array.isArray(view.notices) ? view.notices : []).filter(function (n) { return noticeNote(n) && !shown[n.personId]; });
    if (!rest.length) return '';
    return '<div class="gs-rb-line">' + groupHeadHtml('Notices', rest.length, 'h3') + '<ul class="gs-rb-names">' +
      rest.map(function (n) { return '<li>' + esc(n.name || 'Unknown') + ' <span class="gs-rb-mut">(' + esc(noticeNote(n)) + ')</span></li>'; }).join('') + '</ul></div>';
  }

  // "Druid 3 - Paladin 1": the class WORDS in muted text (a class colour is for a character name only).
  function classLineHtml(view) {
    const c = view.counts;
    const parts = CLASS_IDS.filter(function (id) { return c && c.byClass && c.byClass[id] > 0; }).map(function (id) { return G.ui.className(id) + ' ' + c.byClass[id]; });
    return parts.length ? '<p class="gs-rb-classes" aria-label="Signed up and late, by class">' + esc(parts.join(' - ')) + '</p>' : '';
  }

  function boardHtml(view) {
    const entries = Array.isArray(view.entries) ? view.entries : [];
    const edit = !!view.can.edit;
    const notices = noticesLineHtml(view, entries);
    if (!entries.length) return '<p class="gs-empty">No sign-ups yet.</p>' + notices;
    const coming = entries.filter(function (e) { return e.kind === 'signed' || e.kind === 'late'; }).sort(byName);
    const cols = BOARD_ROLES.map(function (role) {
      return columnHtml(role, coming.filter(function (e) { return e.role === role; }), edit);
    }).join('');
    const lines = LINE_GROUPS.map(function (g) {
      const list = (g[0] === 'none' ? coming.filter(function (e) { return BOARD_ROLES.indexOf(e.role) < 0; }) : entries.filter(function (e) { return e.kind === g[0]; })).sort(byName);
      return list.length ? lineHtml(g[1], list, edit) : '';
    }).join('');
    return '<div class="gs-rb-cols">' + cols + '</div>' + lines + notices + classLineHtml(view);
  }

  function headButtonsHtml(view) {
    if (!view.can.edit) return '';
    const locked = !!view.raid.locked;
    return '<span class="gs-rb-acts"><button type="button" class="gs-btn" data-action="su-add" data-key="su-add">Add a sign-up</button>' +
      '<button type="button" class="gs-btn" data-action="su-lock" data-lock="' + (locked ? '0' : '1') + '" data-key="su-lock">' + (locked ? 'Reopen sign-ups' : 'Close sign-ups') + '</button></span>';
  }

  function errorCardHtml(x) {
    return '<section class="gs-hd-panel gs-rb" aria-labelledby="su-h"><div class="gs-rb-ph"><h2 class="gs-pr-h" id="su-h">Sign-ups</h2></div><div class="gs-rb-pb">' +
      '<p class="gs-alert" role="alert">' + esc(x.message || 'Could not load the sign-ups.') + '</p><div class="gs-row-actions"><button type="button" class="gs-btn" data-action="su-retry" data-key="su-retry">Try again</button></div></div></section>';
  }

  // opts: { guildData, data (the raid detail), state (stateFor) }
  function panelHtml(opts) {
    const x = opts.state;
    if (x && x.status === 'error') return errorCardHtml(x);
    if (!x || x.status !== 'ok' || !x.data) return '';
    const view = x.data;
    const detail = opts.data;
    const upcoming = !!(detail.raid && detail.raid.upcoming);
    // After the start the panel is for officers and for reading what was signed up.
    if (!upcoming && !view.can.edit && !(Array.isArray(view.entries) && view.entries.length)) return '';
    const c = view.counts;
    const fig = view.can.seeList && c && typeof c.expected === 'number'
      ? '<span class="gs-rb-fig">' + esc(c.expected) + (typeof view.raid.size === 'number' && view.raid.size > 0 ? ' <span class="gs-rb-of">/ ' + esc(view.raid.size) + '</span>' : '') + '</span>'
      : '';
    const closed = view.raid.closed === 'locked' || view.raid.closed === 'deadline' ? '<p class="gs-rb-closed">' + esc(closedText(view)) + '</p>' : '';
    const body = view.can.seeList ? closed + boardHtml(view) : '<p class="gs-empty">Sign-ups are visible to the team\'s members.</p>';
    // The viewer's own status buttons and details are the raid page's You bar; after the start sign-ups are a record (no Add a sign-up or Close sign-ups).
    return '<section class="gs-hd-panel gs-rb gs-su" aria-labelledby="su-h"><div class="gs-rb-ph"><h2 class="gs-pr-h" id="su-h">Sign-ups</h2>' + fig + (upcoming ? headButtonsHtml(view) : '') + '</div>' +
      '<div class="gs-rb-pb">' + body + '</div></section>';
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
    // Remove sign-up lives here (a Raidsmith sign-up only); it asks first in today's confirm.
    const found = adding || !person ? null : personEntry(view, person.personId);
    const removeBtn = found && found.source === 'raidsmith'
      ? '<button type="button" class="gs-btn gs-btn-danger-outline" data-action="su-remove" data-pid="' + esc(person.personId) + '" data-key="su-remove-' + esc(person.personId) + '">Remove sign-up</button>'
      : '';
    return '<form class="gs-dialog-form gs-forge" data-submit="su-edit-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">' + (adding ? 'Add a sign-up' : 'Change a sign-up') + '</h2>' +
      '<p class="gs-fine" id="dlg-help">' + (adding ? 'For someone who has not signed up themselves, or has no Discord.' : esc(person ? person.name : '')) + '</p>' +
      (adding
        ? '<div class="gs-field"><label class="gs-label" for="su-d-person">Person</label><select class="gs-input" id="su-d-person" name="person" data-change="su-dlg-person">' + G.ui.optionsHtml(people, person ? person.personId : '') + '</select></div>'
        : '<input type="hidden" name="person" value="' + esc(opts.personId) + '">') +
      '<div class="gs-field"><label class="gs-label" for="su-d-kind">Status</label><select class="gs-input" id="su-d-kind" name="kind" data-field="kind">' + G.ui.optionsHtml(OFFICER_KINDS.map(function (k) { return { value: k[0], label: k[1] }; }), d.kind) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="su-d-char">Character</label><select class="gs-input" id="su-d-char" name="character" data-change="su-dlg-char" data-field="characterId">' + charOptionsHtml(person, d.characterId) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="su-d-spec">Spec</label><select class="gs-input" id="su-d-spec" name="spec" data-field="spec">' + specOptionsHtml(ch, d.spec) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="su-d-note">Note (optional)</label><input class="gs-input" type="text" id="su-d-note" name="note" maxlength="' + NOTE_MAX + '" autocomplete="off" data-field="note" value="' + esc(d.note) + '"><p class="gs-field-error" id="dlg-err-note" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions">' + removeBtn + '<button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="dlg-submit">Save sign-up</button></div></form>';
  }

  // A guest (signed up from a guest link, no person): the dialog behind their name; Remove guest takes the sign-up away.
  function guestDialogHtml(entry) {
    const who = [entry.className, entry.spec].filter(Boolean).join(' - ');
    return '<form class="gs-dialog-form gs-forge" data-submit="su-guest-form" data-sid="' + esc(entry.signupId) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">Guest sign-up</h2>' +
      '<p class="gs-confirm-text" id="dlg-text">' + esc((entry.name || 'This guest') + (who ? ' - ' + who : '')) + '. ' + (entry.importedGuest ? 'Remove guest restores the original unmatched Raid-Helper sign-up.' : 'Remove guest takes their sign-up off this raid.') + '</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove guest</button></div></form>';
  }

  function removeDialogHtml(personId, name) {
    return '<form class="gs-dialog-form gs-forge" data-submit="su-remove-form" data-pid="' + esc(personId) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">Remove this sign-up?</h2>' +
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
    // The loot board lines up the people signed up for the raid: it is read again behind the page.
    if (G.pages.raidBoard && G.pages.raidBoard.refresh) G.pages.raidBoard.refresh();
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
  // A status pill (the You bar's, or the one in the Change sign-up dialog, which closes first).
  G.handlers.click['su-kind'] = function (el) {
    const c = cur();
    if (!c || !c.x.data.me) return;
    G.ui.closeDialogOf(el);
    return run(c, G.api.signups.save(c.gid, c.rid, bodyFor(c, el.getAttribute('data-kind'))));
  };

  // Save details: with a sign-up the form is sent (its status kept); without one the values wait in the form for the first status pill.
  G.handlers.submit['su-details-form'] = function (form) {
    const c = cur();
    if (!c || !c.x.data.me) return;
    G.ui.closeDialogOf(form);
    if (!c.x.data.me.signup) { G.app.render(); return; }
    return run(c, G.api.signups.save(c.gid, c.rid, bodyFor(c, c.x.data.me.signup.kind)));
  };

  G.handlers.click['su-withdraw'] = function (el) {
    const c = cur();
    if (!c) return;
    G.ui.closeDialogOf(el);
    return run(c, G.api.signups.withdraw(c.gid, c.rid));
  };

  // The dialog's character changed: the specs of that character in place (a re-render must not swallow the open dialog), its main spec chosen.
  G.handlers.change['su-mine-char'] = function (el) {
    const c = cur();
    if (!c) return;
    const chars = c.x.data.me ? c.x.data.me.characters : [];
    const ch = chars.filter(function (x) { return x.id === el.value; })[0];
    if (!ch) return;
    c.x.ui.form.characterId = ch.id;
    c.x.ui.form.spec = specOf(ch, null);
    const form = el.closest ? el.closest('form') : null;
    const spec = form && form.elements ? form.elements.spec || (typeof document !== 'undefined' ? document.getElementById('su-spec') : null) : null;
    if (spec) spec.innerHTML = specOptionsHtml(ch, c.x.ui.form.spec);
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

  // The You bar's "Change character or note" and (while the viewer has a seat) "Change sign-up", which carries the status pills too.
  function openMine(withPills) {
    const c = cur();
    if (!c || !c.x.data.me) return;
    c.x.ui = c.x.ui || freshUi(c.x.data);
    G.ui.openDialog(detailsDialogHtml(c.x.data, c.x.ui, withPills), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  }
  G.handlers.click['su-details-open'] = function () { openMine(false); };
  G.handlers.click['su-signup-open'] = function () { openMine(true); };

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

  G.handlers.click['su-guest-open'] = function (el) {
    const c = cur();
    if (!c) return;
    const sid = el.getAttribute('data-sid');
    const entry = (Array.isArray(c.x.data.entries) ? c.x.data.entries : []).filter(function (e) { return e.guest && String(e.signupId) === String(sid); })[0];
    if (!entry) return;
    G.ui.openDialog(guestDialogHtml(entry), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['su-guest-form'] = function (form) {
    const c = cur();
    if (!c) return;
    return G.ui.runDialog(form, G.api.joinLinks.removeGuest(c.gid, c.rid, form.getAttribute('data-sid')), function (view) { setView(c, view); });
  };

  G.pages.raidSignups = {
    KIND_LABELS: KIND_LABELS,
    MY_KINDS: MY_KINDS,
    ROLE_ORDER: ROLE_ORDER,
    stateFor: stateFor,
    freshUi: freshUi,
    formFrom: formFrom,
    panelHtml: panelHtml,
    pillsHtml: pillsHtml,
    detailsDialogHtml: detailsDialogHtml,
    sourceNoteHtml: sourceNoteHtml,
    closedText: closedText,
    viewOf: function (state) { return state && state.status === 'ok' && state.data ? state.data : null; },
    boardHtml: boardHtml,
    groupHeadHtml: groupHeadHtml,
    guestDialogHtml: guestDialogHtml,
    editDialogHtml: editDialogHtml,
    removeDialogHtml: removeDialogHtml,
    bodyFor: bodyFor,
    loadFor: loadFor,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
