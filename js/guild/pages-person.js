// ── PAGE: PERSON RECORD (T2 object page, the Roster redesign "record") ─────────────────────────────────────
// Head: spec icon, the name in its class colour, ONE chip (the exception only: a trial to decide, Trial, Reserve, Inactive, else You), the context line
// "Class - Spec / Off - Alts - Joined - Account", and More (Edit details, Add character, Add an away notice, then Delete person). A Trial an editor may
// decide leads with the decision panel (pages-person-trial.js). Below: two columns from 1024 px (2fr / 1fr): left Attendance (pages-person-attendance.js),
// Loot (pages-person-loot.js), Characters; right Details, Officer notes, Away notices. Details and the notes are read-only until Edit (the Save bar holds
// the changes); the trial dates show only while the status is Trial. Account is ONE row: who the person is on Raidsmith, with one action (Link account or
// Unlink). On the viewer's own page the You line leads (with a "Who can see this page" disclosure). A member gets the read-only record.
// The dialogs (Add / Edit character, Extend trial, Delete) live here too. Every mutation answers with the whole person record, which replaces the page's
// copy; a 409 conflict re-renders from ApiError.body.current.
(function (G) {
  'use strict';

  const CONFLICT_TEXT = 'Someone else changed this person. The page now shows their version.';
  const MEMBER_NOTE = 'Officers keep your status and characters up to date. Ask one of them if something is wrong.';
  const NOTES_HINT = 'Only officers and team leads see notes.';
  const OWN_SEES = 'Who can see this page: everyone in the guild sees your name, characters and status. Your team and your officers see your attendance, and your guild\'s loot setting decides who sees your loot. Only officers and team leads see officer notes.';
  const ALTS_SHOWN = 4;

  // Which parts of the open record are in edit mode: { gid, pid, details, notes }. A page change or a saved edit puts it back to read-only.
  let editing = null;

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function mainOf(record) {
    const list = Array.isArray(record.characters) ? record.characters : [];
    return list.filter(function (c) { return c.isMain; })[0] || list[0] || null;
  }
  function altsOf(record) {
    const main = mainOf(record);
    return (Array.isArray(record.characters) ? record.characters : []).filter(function (c) { return c !== main && !c.isMain; });
  }
  function severalTeams(gd, record) {
    const ids = {};
    (record.characters || []).forEach(function (c) { if (c.team) ids[c.team.id] = true; });
    return G.shell.activeTeams(gd && gd.teams).length > 1 || Object.keys(ids).length > 1;
  }
  function isEditing(gd, record, part) {
    return !!editing && editing.gid === gd.guild.id && editing.pid === record.person.id && !!editing[part];
  }
  function setEditing(gid, pid, part, on) {
    const same = editing && editing.gid === gid && editing.pid === pid;
    editing = same ? editing : { gid: gid, pid: pid, details: false, notes: false };
    editing[part] = !!on;
  }

  // ── the account row (D6): one row, one action ──
  // "Mendra (via Discord)" (the Discord ID matches), "Name (linked by an officer)" (an officer or an approved claim linked it), or "Not linked".
  function accountText(record) {
    const a = (record.person && record.person.account) || {};
    if (!a.user) return 'Not linked';
    return a.user.displayName + (a.via === 'link' ? ' (linked by an officer)' : ' (via Discord)');
  }

  function accountActionHtml(record, can) {
    if (!can.edit) return '';
    const a = (record.person && record.person.account) || {};
    return a.user
      ? G.ui.buttonHtml({ label: 'Unlink', variant: 'ghost', ariaLabel: 'Unlink ' + a.user.displayName, attrs: { 'data-action': 'account-unlink-open', 'data-key': 'account-unlink' } })
      : G.ui.buttonHtml({ label: 'Link account', variant: 'ghost', attrs: { 'data-action': 'account-link-open', 'data-key': 'account-link' } });
  }

  // ── panels (the record's one section recipe: .gs-hd-panel with a head row) ──
  // s: { id, title, metaHtml (muted text in the head), actionsHtml, bodyHtml, flush (the body draws its own rows), bare (the section draws itself) }
  function panelHtml(s) {
    if (!s) return '';
    if (s.bare) return G.ui.objectSectionHtml(s);
    const id = esc(s.id);
    return '<section class="gs-hd-panel gs-pr-panel" id="' + id + '" tabindex="-1" aria-labelledby="' + id + '-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="' + id + '-h">' + esc(s.title) + '</h2>' +
      (s.metaHtml ? '<span class="gs-pr-mut">' + s.metaHtml + '</span>' : '') + (s.actionsHtml ? '<span class="gs-pr-acts">' + s.actionsHtml + '</span>' : '') + '</div>' +
      (s.flush ? s.bodyHtml || '' : '<div class="gs-pr-body">' + (s.bodyHtml || '') + '</div>') + '</section>';
  }

  // ── header ──
  // "Alt: Foo" / "Alts: Foo, Bar and 2 more" / "No alts": the alts' names in their class colours.
  function altsHtml(record) {
    const alts = altsOf(record);
    if (!alts.length) return 'No alts';
    const shown = alts.slice(0, ALTS_SHOWN).map(function (c) { return G.ui.classNameHtml(c.name, c.class); }).join(', ');
    return (alts.length === 1 ? 'Alt: ' : 'Alts: ') + shown + (alts.length > ALTS_SHOWN ? ' and ' + (alts.length - ALTS_SHOWN) + ' more' : '');
  }

  // The one context line: "Warlock - Affliction - No alts - Joined Oct 8, 2026 - Account: Not linked". The account only for the person and their editors.
  function contextHtml(record, can) {
    const main = mainOf(record) || {};
    const p = record.person;
    const parts = [G.ui.specLineHtml(main.class, main.mainSpec, main.offSpec), altsHtml(record)];
    if (p.joinedOn) parts.push('Joined ' + esc(G.ui.formatDay(p.joinedOn)));
    if (p.isMe || (can && can.edit)) parts.push('Account: ' + esc(accountText(record)));
    return parts.map(function (x) { return '<span>' + x + '</span>'; }).join('<span class="gs-sumsep" aria-hidden="true"></span>');
  }

  // ONE chip, only for the exception: rose = a trial to decide, blue = Trial, grey = Reserve, Inactive, or You on your own page.
  function headChipHtml(o) {
    const chip = function (tone, label) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(label) + '</span>'; };
    if (o.trialFlag && G.ui.trialCopy(o.trialFlag)) return chip('rose', G.ui.trialCopy(o.trialFlag));
    if (o.status === 'trial') return chip('blue', 'Trial');
    if (o.status === 'reserve') return chip('grey', 'Reserve');
    if (o.status === 'inactive') return chip('grey', 'Inactive');
    if (o.isMe) return chip('grey', 'You');
    return '';
  }

  // The head options of the attendance and loot history pages: the name with You, the status chip, a back link.
  //   opts: { name, status, person (for an inactive person's reason and day), isMe, trialFlag, joinedOn, contextHtml, back: { href, label } }
  function headOpts(opts) {
    const o = opts || {};
    const chips = (o.isMe ? '<span class="gs-you">You</span>' : '') + (o.status ? G.ui.statusChipHtml(o.status, o.person) : '') + (o.trialFlag ? G.ui.trialChipHtml(o.trialFlag) : '') +
      (o.joinedOn ? '<span class="gs-chip gs-chip-plain">Joined ' + esc(G.ui.formatDay(o.joinedOn)) + '</span>' : '');
    return { title: o.name || 'Person', back: o.back, chipsHtml: chips ? '<span class="gs-sumchips">' + chips + '</span>' : '', contextHtml: o.contextHtml };
  }

  // The head options of the record itself.
  //   opts: { name, status, isMe, trialFlag (editors), contextHtml, back: { href, label }, more, mainChar ({ class, mainSpec }: the icon and the colour) }
  function recordHeadOpts(opts) {
    const o = opts || {};
    const chip = headChipHtml(o);
    const m = o.mainChar || null;
    return { title: o.name || 'Person', back: o.back, chipsHtml: chip, contextHtml: o.contextHtml, more: o.more || null,
      iconHtml: m ? G.ui.specIconHtml(m.class, m.mainSpec, 28) : '', titleClass: m ? G.ui.classClass(m.class) : '' };
  }

  // More: Edit details, Add character, Add an away notice, a rule, Delete person (each only for who may).
  function moreOf(gd, record, can) {
    const pid = record.person.id;
    const away = G.pages.away && G.pages.away.canEditPerson ? G.pages.away.canEditPerson(gd, record) : can.edit;
    const items = [
      can.edit ? { label: 'Edit details', key: 'mi-edit-details', data: { action: 'person-edit-open' } } : null,
      can.addCharacter ? { label: 'Add character', key: 'mi-char-add', data: { action: 'char-add' } } : null,
      can.edit && away ? { label: 'Add an away notice', key: 'mi-away-add', data: { action: 'away-add', ctx: 'person', pid: pid } } : null,
    ].filter(Boolean);
    if (can.delete) items.push(items.length ? { separator: true } : null, { label: 'Delete person', key: 'person-delete', danger: true, data: { action: 'person-delete' } });
    return items.length ? { id: 'person-more', key: 'person-more', items: items.filter(Boolean) } : null;
  }

  function headOf(gd, record, can) {
    const main = mainOf(record) || {};
    const p = record.person;
    return recordHeadOpts({
      name: main.name, status: p.status, isMe: p.isMe, trialFlag: can.edit && p.status === 'trial' ? p.trialFlag : null, mainChar: main,
      contextHtml: contextHtml(record, can), back: { href: G.router.format({ name: 'section', gid: gd.guild.id, section: 'roster' }), label: 'Roster' },
      more: moreOf(gd, record, can),
    });
  }

  // The You line of the viewer's own page: a plain sentence, the link to their away notices, and "Who can see this page" as a disclosure.
  function youOf(gd, record, can) {
    const p = record.person;
    if (!p.isMe) return '';
    const away = G.ui.buttonHtml({ label: 'Away notices', href: G.router.format({ name: 'away', gid: gd.guild.id }), attrs: { 'data-key': 'you-away' } });
    const see = G.ui.buttonHtml({ label: 'Who can see this page', variant: 'ghost', attrs: { 'data-action': 'you-sees-toggle', 'data-key': 'you-sees', 'aria-expanded': 'false', 'aria-controls': 'you-sees' } });
    return '<span class="gs-youline-label">You</span> This is your own record.' + (can.edit ? '' : ' ' + esc(MEMBER_NOTE)) +
      ' <span class="gs-youline-act">' + away + see + '</span><span class="gs-youline-sub" id="you-sees" hidden>' + esc(OWN_SEES) + '</span>';
  }

  // ── characters ──
  // One inline action (Edit) and the rest behind a More icon named for the character; a Main cannot be removed or made Main again, so it has Edit only.
  function charActionsHtml(c, can) {
    if (!can.edit) return '';
    const edit = G.ui.buttonHtml({ label: 'Edit', ariaLabel: 'Edit ' + c.name, attrs: { 'data-action': 'char-edit', 'data-cid': c.id, 'data-key': 'char-edit-' + c.id } });
    if (c.isMain) return edit;
    const more = G.ui.menuHtml({ id: 'char-more-' + c.id, icon: 'more', ariaLabel: 'More actions for ' + c.name, key: 'char-more-' + c.id, items: [
      { label: 'Make Main', key: 'char-main-' + c.id, data: { action: 'char-main', cid: c.id } },
      { separator: true },
      { label: 'Remove character', key: 'char-remove-' + c.id, danger: true, data: { action: 'char-remove', cid: c.id } },
    ] });
    return edit + more;
  }

  function characterRowHtml(c, can, showTeam) {
    const team = showTeam && c.team ? ' &middot; ' + esc(c.team.name) + (c.team.archived ? ' (archived)' : '') : '';
    return '<div class="gs-pr-row gs-pr-char" data-cid="' + esc(c.id) + '">' + G.ui.specIconHtml(c.class, c.mainSpec, 20) + '<span class="gs-pr-cname">' + G.ui.classNameHtml(c.name, c.class) + '</span>' +
      '<span class="gs-pr-what">' + G.ui.specLineHtml(c.class, c.mainSpec, c.offSpec) + team + (c.realm ? ' &middot; ' + esc(c.realm) : '') + '</span>' +
      '<span class="gs-hd-chip is-grey">' + (c.isMain ? 'Main' : 'Alt') + '</span>' + (can.edit ? '<span class="gs-pr-end">' + charActionsHtml(c, can) + '</span>' : '') + '</div>';
  }

  function charactersBodyHtml(record, can, showTeam) {
    const list = Array.isArray(record.characters) ? record.characters : [];
    return list.map(function (c) { return characterRowHtml(c, can, showTeam); }).join('');
  }

  function charactersSection(record, can, showTeam) {
    const add = can.addCharacter ? G.ui.buttonHtml({ label: 'Add character', variant: 'ghost', attrs: { 'data-action': 'char-add', 'data-key': 'char-add' } }) : '';
    return { id: 'characters', title: 'Characters', flush: true, actionsHtml: add, bodyHtml: charactersBodyHtml(record, can, showTeam) };
  }

  // The Attendance card (pages-person-attendance.js): figures and the last raids, a link to the full history.
  function attendanceSection(record, gid, state) {
    return G.pages.personAtt.sectionOf({ gid: gid, pid: record.person.id, record: record, state: state });
  }

  // The Trial review panel (pages-person-trial.js): it decides for itself whether this person gets one (null when not).
  function trialSection(opts) {
    if (!G.pages.personTrial || !G.pages.personTrial.sectionOf) return null;
    return G.pages.personTrial.sectionOf({ guildData: opts.guildData, gid: opts.guildData.guild.id, pid: opts.record.person.id, record: opts.record, state: opts.trial });
  }

  // ── details: read-only key-values, the form after Edit ──
  function kvHtml(label, valueHtml, actionHtml) {
    return '<div class="gs-pr-kv"><span class="gs-pr-k">' + esc(label) + '</span><span class="gs-pr-v">' + valueHtml + '</span>' + (actionHtml ? '<span class="gs-pr-end">' + actionHtml + '</span>' : '') + '</div>';
  }

  // "Saved at 8:14 PM ET" in the panel head after a save (the guild's zone); nothing before.
  function savedHtml(saved, zone) {
    if (!saved || typeof saved.ms !== 'number') return G.ui.savedStatusHtml('');
    const when = G.ui.timeInZone(saved.ms, zone);
    return G.ui.savedStatusHtml(when ? 'Saved at ' + when : 'Saved', 'saved');
  }

  function readDetailsRows(record, can) {
    const p = record.person;
    const rows = [kvHtml('Status', esc(G.ui.statusText(p)))];
    if (p.joinedOn) rows.push(kvHtml('Joined', esc(G.ui.formatDay(p.joinedOn))));
    if (p.status === 'trial' && (p.trialStart || p.trialEnd)) {
      rows.push(kvHtml('Trial', esc(p.trialStart && p.trialEnd ? G.ui.formatDay(p.trialStart) + ' - ' + G.ui.formatDay(p.trialEnd) : G.ui.formatDay(p.trialStart || p.trialEnd))));
    }
    if (p.isMe || can.edit) rows.push(kvHtml('Account', esc(accountText(record)), accountActionHtml(record, can)));
    return rows.join('');
  }

  function detailsFormHtml(record, can) {
    const p = record.person;
    const inactive = p.status === 'inactive';
    const reasonOpts = [{ value: '', label: 'No reason' }].concat(Object.keys(G.ui.LEFT_REASONS).map(function (k) { return { value: k, label: G.ui.LEFT_REASONS[k] }; }));
    const a = p.account || {};
    return '<form class="gs-details-form gs-pr-form" data-submit="person-details-form" id="details-form" novalidate' + G.ui.dirtyFormAttrs() + '>' +
      G.ui.fieldHtml({ id: 'det-status', name: 'status', label: 'Status', kind: 'select', value: p.status, attrs: { 'data-change': 'person-status-change' },
        options: ['raider', 'trial', 'reserve', 'inactive'].map(function (s) { return { value: s, label: G.ui.statusLabel(s) }; }) }) +
      '<div id="det-reason-field"' + (inactive ? '' : ' hidden') + '>' + G.ui.fieldHtml({ id: 'det-reason', name: 'leftReason', label: 'Reason', kind: 'select', value: p.leftReason || '', options: reasonOpts }) + '</div>' +
      '<div id="det-lefton-field"' + (inactive ? '' : ' hidden') + '>' + G.ui.fieldHtml({ id: 'det-lefton', name: 'leftOn', label: 'Left on', kind: 'date', value: inactive ? p.leftOn || '' : record.today || '' }) + '</div>' +
      G.ui.fieldHtml({ id: 'det-joined', name: 'joinedOn', label: 'Joined', kind: 'date', value: p.joinedOn || '' }) +
      '<div id="det-trial-fields" class="gs-pr-trialfields"' + (p.status === 'trial' ? '' : ' hidden') + '>' +
      G.ui.fieldHtml({ id: 'det-tstart', name: 'trialStart', label: 'Trial start', kind: 'date', value: p.trialStart || '' }) +
      G.ui.fieldHtml({ id: 'det-tend', name: 'trialEnd', label: 'Trial end', kind: 'date', value: p.trialEnd || '' }) + '</div>' +
      '<div class="gs-field" id="det-account-field"><span class="gs-label" id="det-account-label">Account</span><div class="gs-pr-acct" role="group" aria-labelledby="det-account-label">' +
      '<span class="gs-pr-acctname' + (a.user ? '' : ' is-none') + '" id="det-account-current">' + esc(accountText(record)) + '</span>' + accountActionHtml(record, can) + '</div></div>' +
      '<p class="gs-alert" id="det-error" role="alert" hidden></p>' +
      G.ui.saveBarHtml({ saveLabel: 'Save details' }) + '</form>';
  }

  function detailsSection(record, can, gd, saved) {
    const edit = can.edit && isEditing(gd, record, 'details');
    const toggle = can.edit ? G.ui.buttonHtml(edit ? { label: 'Cancel', variant: 'ghost', attrs: { 'data-action': 'person-edit-close', 'data-key': 'details-cancel' } }
      : { label: 'Edit', variant: 'ghost', ariaLabel: 'Edit details', attrs: { 'data-action': 'person-edit-open', 'data-key': 'details-edit' } }) : '';
    return { id: 'details', title: 'Details', flush: true, actionsHtml: (edit ? '' : savedHtml(saved, gd.guild.timeZone)) + toggle,
      bodyHtml: edit ? '<div class="gs-pr-body">' + detailsFormHtml(record, can) + '</div>' : readDetailsRows(record, can) };
  }

  // ── notes (only when the Worker sent them: officers and team leads) ──
  function notesSection(record, can, gd) {
    const n = record.notes;
    if (!n) return null;
    const by = n.updatedBy && n.updatedBy.displayName ? n.updatedBy.displayName : '';
    const when = n.updatedAt ? G.ui.formatDateTime(n.updatedAt, G.ui.guildZone()) : '';
    const edited = by || when ? '<p class="gs-fine" id="notes-edited">Edited' + (by ? ' by ' + esc(by) : '') + (when ? ', ' + esc(when) : '') + '</p>' : '';
    const edit = can.notesEdit && isEditing(gd, record, 'notes');
    const toggle = can.notesEdit ? G.ui.buttonHtml(edit ? { label: 'Cancel', variant: 'ghost', attrs: { 'data-action': 'person-notes-close', 'data-key': 'notes-cancel' } }
      : { label: 'Edit', variant: 'ghost', ariaLabel: 'Edit officer notes', attrs: { 'data-action': 'person-notes-edit', 'data-key': 'notes-edit' } }) : '';
    const body = edit
      ? '<form data-submit="person-notes-form" novalidate><p class="gs-fine">' + esc(NOTES_HINT) + '</p>' +
        G.ui.fieldHtml({ id: 'officer-note', name: 'text', label: 'Officer notes', kind: 'textarea', value: n.text, rows: 4, maxlength: 4000 }) +
        edited + '<p class="gs-alert" id="notes-error" role="alert" hidden></p><div class="gs-actions">' + G.ui.buttonHtml({ label: 'Save note', type: 'submit' }) + '</div></form>'
      : (n.text ? '<p class="gs-pr-note" id="officer-note-text">' + esc(n.text) + '</p>' : '<p class="gs-fine">No notes yet.</p>') + edited;
    return { id: 'notes', title: 'Officer notes', actionsHtml: toggle, bodyHtml: body };
  }

  // opts: { guildData, record (GET /roster/p_...), alert, attendance (card state), trial (Trial review state), away (the officers' Away notices section: { id, title, ... } or ''),
  //         saved ({ ms }: the details were just saved) }
  function personHtml(opts) {
    const record = opts.record;
    const gd = opts.guildData;
    const can = Object.assign({ edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false }, record.can || {});
    const gid = gd.guild.id;
    if (editing && (editing.gid !== gid || editing.pid !== record.person.id)) editing = null; // another person: back to read-only
    const attendance = attendanceSection(record, gid, opts.attendance);
    const loot = G.pages.personLoot.sectionFor(gd, record, record.person.id);
    const characters = charactersSection(record, can, severalTeams(gd, record));
    const away = opts.away && typeof opts.away === 'object' ? opts.away : null;
    const left = [attendance, loot, characters].filter(Boolean).map(panelHtml).join('');
    const right = [detailsSection(record, can, gd, opts.saved), notesSection(record, can, gd), away].filter(Boolean).map(panelHtml).join('');
    const cols = '<div class="gs-pr-cols"><div class="gs-pr-left">' + left + '</div><div class="gs-pr-right">' + right + '</div></div>';
    return G.ui.objectPageHtml({
      head: headOf(gd, record, can),
      noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + panelHtml(trialSection(opts)),
      youHtml: youOf(gd, record, can),
      pageClass: 'gs-person-page gs-forge gs-pr' + (record.person.isMe ? ' is-own' : ''),
      sections: [{ id: 'person-cols', bare: true, bodyHtml: cols }],
    });
  }

  // ── dialogs ──
  function charTeamFieldHtml(gd, selectedId, character) {
    const active = G.shell.activeTeams(gd.teams);
    if (active.length < 2) return '';
    const items = active.map(function (t) { return { value: t.id, label: t.name }; });
    if (character && character.team && !items.some(function (i) { return i.value === character.team.id; })) {
      items.push({ value: character.team.id, label: character.team.name + ' (archived)' });
    }
    return '<div class="gs-field"><label class="gs-label" for="dlg-team">Team</label><select class="gs-input" id="dlg-team" name="teamId" data-field="teamId">' + G.ui.optionsHtml(items, selectedId) + '</select>' +
      '<p class="gs-field-error" id="dlg-err-teamId" role="alert" hidden></p></div>';
  }

  // opts: { guildData, record, character (edit) | null, defaultTeamId }
  function characterDialogHtml(opts) {
    const gd = opts.guildData;
    const ro = G.ui.rosterOptions(gd);
    const c = opts.character;
    const edit = !!c;
    const person = mainOf(opts.record) || {};
    const cls = c ? c.class : '';
    const modeFields = edit ? '' :
      '<fieldset class="gs-fieldset"><legend class="gs-legend">Main or Alt</legend><div class="gs-radios">' +
      '<div class="gs-check"><input type="radio" id="dlg-kind-alt" name="mainOrAlt" value="alt" checked><label for="dlg-kind-alt">Alt</label></div>' +
      '<div class="gs-check"><input type="radio" id="dlg-kind-main" name="mainOrAlt" value="main" aria-describedby="dlg-kind-help"><label for="dlg-kind-main">Main</label></div></div>' +
      '<p class="gs-fine" id="dlg-kind-help">Choosing Main makes ' + esc(person.name) + ' an Alt.</p></fieldset>';
    const fields =
      '<div class="gs-field"><label class="gs-label" for="dlg-name">Character name</label><input class="gs-input" type="text" id="dlg-name" name="name" data-field="name" maxlength="40" autocomplete="off" required value="' + esc(c ? c.name : '') + '">' +
      '<p class="gs-field-error" id="dlg-err-name" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-class">Class</label><select class="gs-input" id="dlg-class" name="class" data-field="class" data-change="roster-class-change">' + G.ui.classOptionsHtml(ro, cls, 'Choose a class') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-class" role="alert" hidden></p></div>' +
      '<div class="gs-grid gs-grid-2"><div class="gs-field"><label class="gs-label" for="dlg-mainspec">Main spec</label><select class="gs-input" id="dlg-mainspec" name="mainSpec" data-field="mainSpec">' + G.ui.specOptionsHtml(ro, cls, c ? c.mainSpec : '', 'Not set') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-mainSpec" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-offspec">Off spec</label><select class="gs-input" id="dlg-offspec" name="offSpec" data-field="offSpec">' + G.ui.specOptionsHtml(ro, cls, c ? c.offSpec : '', 'None') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-offSpec" role="alert" hidden></p></div></div>' +
      charTeamFieldHtml(gd, edit ? c.team.id : opts.defaultTeamId, c) + modeFields;
    return G.ui.dialogHtml({
      kind: 'form', title: edit ? 'Edit ' + c.name : 'Add a character for ' + person.name, bodyHtml: fields,
      primary: { label: edit ? 'Save' : 'Add character' }, formAttrs: { 'data-submit': 'char-form', 'data-mode': edit ? 'edit' : 'add', 'data-cid': edit ? c.id : null },
    });
  }

  function removeCharDialogHtml(record, character) {
    const person = (mainOf(record) || {}).name;
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Remove character', text: 'Remove ' + character.name + ' from ' + person + '\'s characters?',
      primary: { label: 'Remove' }, formAttrs: { 'data-submit': 'remove-char-form', 'data-cid': character.id },
    });
  }

  // Found accounts as rows: opts.accounts [{ id, displayName, avatarUrl, initials, battletag, matchedBy }], opts.query ('' = the claimants list).
  function accountResultsHtml(accounts, query) {
    const list = Array.isArray(accounts) ? accounts : [];
    if (!list.length) {
      return query
        ? '<p class="gs-empty" id="dlg-acct-empty">No account has exactly that BattleTag or name. Type the whole BattleTag (like Name#1234) or the name exactly as the account shows it.</p>'
        : '<p class="gs-empty" id="dlg-acct-empty">Nobody has sent a character claim that is waiting for a person. Type a whole BattleTag or an account name to look one up.</p>';
    }
    const how = { claim: 'Sent a character claim', battletag: 'BattleTag match', name: 'Name match' };
    return '<ul class="gs-account-results" aria-label="Accounts found">' + list.map(function (a) {
      // A display name is free text: when several accounts show the same one there is no telling them apart here, so none can be linked from it.
      const action = a.ambiguous
        ? '<span class="gs-fine gs-account-ambiguous">Several accounts show this name. Ask for the BattleTag.</span>'
        : G.ui.buttonHtml({ label: 'Link', size: 'sm', ariaLabel: 'Link ' + a.displayName, attrs: { 'data-action': 'account-pick', 'data-uid': a.id, 'data-key': 'account-pick-' + a.id } });
      return '<li class="gs-account-row">' + G.ui.avatarHtml(a, 'gs-avatar-md') + '<span class="gs-account-text"><span class="gs-account-name">' + esc(a.displayName) + '</span>' +
        '<span class="gs-fine">' + esc(how[a.matchedBy] || '') + (a.battletag ? ' &middot; ' + esc(a.battletag) : '') + '</span></span>' + action + '</li>';
    }).join('') + '</ul>';
  }

  function accountLinkDialogHtml(record, accounts) {
    const name = (mainOf(record) || {}).name;
    const body = '<p class="gs-fine" id="dlg-help">Pick someone who sent a character claim, or type their whole BattleTag (like Name#1234) or the name their account shows. Raidsmith never lists accounts.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-acct-q">BattleTag or name</label><input class="gs-input" type="text" id="dlg-acct-q" name="q" data-field="q" maxlength="64" autocomplete="off" aria-describedby="dlg-help">' +
      '<p class="gs-field-error" id="dlg-err-q" role="alert" hidden></p></div>' +
      '<div id="dlg-acct-results" aria-live="polite">' + accountResultsHtml(accounts, '') + '</div>';
    return G.ui.dialogHtml({
      kind: 'form', title: 'Link an account to ' + name, bodyHtml: body, cancel: { label: 'Close' },
      primary: { label: 'Find', variant: 'secondary' }, formAttrs: { 'data-submit': 'account-find-form' },
    });
  }

  // An officer's link (PUT /account) or the Discord link (PATCH linkUserId null) is what gets cleared; data-via tells the submit which.
  function accountUnlinkDialogHtml(record) {
    const a = (record.person && record.person.account) || {};
    const name = (mainOf(record) || {}).name;
    const who = a.user ? a.user.displayName : 'this account';
    const text = a.via === 'link'
      ? 'Unlink ' + who + ' from ' + name + '? They keep their Raidsmith account, but they can no longer open this guild unless they are in its Discord server, and ' + name + ' is no longer theirs.'
      : 'Unlink ' + who + ' from ' + name + '? They keep their Raidsmith account, and ' + name + ' is no longer theirs.';
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Unlink account', text: text,
      primary: { label: 'Unlink account' }, formAttrs: { 'data-submit': 'account-unlink-form', 'data-via': a.via === 'link' ? 'link' : 'discord' },
    });
  }

  function deleteDialogHtml(record) {
    const name = (mainOf(record) || {}).name;
    const n = (record.characters || []).length;
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Delete person',
      text: 'Delete ' + name + '? This removes them and their ' + plural(n, 'character', 'characters') + ' from the roster. It can\'t be undone. Their account is not affected. Once they have attendance, set them to Inactive instead.',
      primary: { label: 'Delete person' }, formAttrs: { 'data-submit': 'delete-person-form' },
    });
  }

  // ── behaviour ──
  function st() { return G.app.state; }
  function cur() {
    const s = st();
    const gd = s.currentGid ? s.guilds[s.currentGid] : null;
    return s.person && gd && s.person.gid === s.currentGid ? { gid: s.currentGid, gd: gd, rec: s.person.record, pid: s.person.pid } : null;
  }
  function base(c) { return '/api/guild/' + encodeURIComponent(c.gid) + '/roster/' + encodeURIComponent(c.pid); }
  function accountsUrl(c) { return '/api/guild/' + encodeURIComponent(c.gid) + '/accounts'; }

  function applyRecord(c, res) {
    G.app.applyFlags(c.gid, res);
    G.app.setPerson(c.gid, res);
    st().pageAlert = '';
    G.app.render();
  }

  // A 409 conflict: show the server's current copy (a whole record, or just { notes } from a notes save).
  function conflict(c, err) {
    const current = err && err.body && err.body.current;
    if (current && current.person) {
      G.app.setPerson(c.gid, current);
    } else if (current && current.notes && c.rec) {
      c.rec.notes = current.notes;
    }
    st().pageAlert = CONFLICT_TEXT;
    G.app.render();
  }

  function pageError(c, err) {
    if (err && err.code === 'conflict') { conflict(c, err); return; }
    G.app.handleError(err, { pageAlert: true });
  }

  // The Reason and Left on fields belong to Inactive only; the trial dates to Trial only.
  G.handlers.change['person-status-change'] = function (el) {
    [['det-reason-field', 'inactive'], ['det-lefton-field', 'inactive'], ['det-trial-fields', 'trial']].forEach(function (pair) {
      const field = document.getElementById(pair[0]);
      if (field) field.hidden = el.value !== pair[1];
    });
    // The select has its own change handler, so the form's own (the Save bar) is told here.
    const form = el && el.closest ? el.closest('form') : null;
    if (form) G.ui.saveBar.update(form);
  };

  G.handlers.submit['person-details-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const p = c.rec.person;
    const body = {};
    const date = function (name) { return form.elements[name].value || null; };
    if (form.elements.status.value !== p.status) body.status = form.elements.status.value;
    (form.elements.status.value === 'trial' ? ['joinedOn', 'trialStart', 'trialEnd'] : ['joinedOn']).forEach(function (k) {
      if (date(k) !== (p[k] || null)) body[k] = date(k);
    });
    if (form.elements.status.value === 'inactive' && form.elements.leftOn && form.elements.leftReason) {
      const entering = p.status !== 'inactive';
      if (entering || date('leftOn') !== (p.leftOn || null)) body.leftOn = date('leftOn');
      if (entering || date('leftReason') !== (p.leftReason || null)) body.leftReason = date('leftReason');
    }
    G.ui.setText('det-error', '');
    if (!Object.keys(body).length) { G.ui.setText('det-error', 'Nothing to save: no detail was changed.'); return; }
    G.ui.setBusy(form, true);
    G.api.patch(base(c), Object.assign({ expectedVersion: p.version }, body)).then(function (res) {
      setEditing(c.gid, c.pid, 'details', false);
      st().personSaved = { gid: c.gid, pid: c.pid, ms: Date.now() }; // the Details head says "Saved at 8:14 PM ET" on the page that comes next
      applyRecord(c, res);
    }, function (err) {
      G.ui.setBusy(form, false);
      if (err && err.code === 'conflict') { conflict(c, err); return; }
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      G.ui.setText('det-error', cl.text);
    });
  };

  G.handlers.submit['person-notes-form'] = function (form) {
    const c = cur();
    if (!c || !c.rec.notes) return;
    G.ui.setText('notes-error', '');
    G.ui.setBusy(form, true);
    G.api.put(base(c) + '/notes', { text: form.elements.text.value, expectedNotesVersion: c.rec.notes.version }).then(function (res) {
      G.app.applyFlags(c.gid, res);
      if (res && res.notes) c.rec.notes = res.notes;
      setEditing(c.gid, c.pid, 'notes', false);
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      G.ui.setBusy(form, false);
      if (err && err.code === 'conflict') { conflict(c, err); return; }
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      G.ui.setText('notes-error', cl.text);
    });
  };

  // The Raidsmith account link (officers): a dialog finds the account, a click on one links it, Unlink asks first.
  G.handlers.click['account-link-open'] = function () {
    const c = cur();
    if (!c) return;
    // The claimants list (accounts that sent a claim and belong to no person yet) is what the dialog opens with.
    G.api.get(accountsUrl(c)).then(function (res) {
      return res && Array.isArray(res.accounts) ? res.accounts : [];
    }, function () { return []; }).then(function (accounts) {
      if (!cur()) return;
      G.ui.openDialog(accountLinkDialogHtml(c.rec, accounts), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const input = document.getElementById('dlg-acct-q');
      if (input) input.focus();
    });
  };

  G.handlers.submit['account-find-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const q = String(form.elements.q.value || '').trim();
    G.ui.setText('dlg-err-q', '');
    G.ui.setText('dlg-error', '');
    const host = document.getElementById('dlg-acct-results');
    G.ui.setBusy(form, true);
    G.api.get(accountsUrl(c) + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (res) {
      G.ui.setBusy(form, false);
      if (host) host.innerHTML = accountResultsHtml(res && res.accounts, q);
    }, function (err) {
      G.ui.setBusy(form, false);
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.ui.closeDialogOf(form); G.app.showFailure(cl.title, cl.text); return; }
      G.ui.setText(err && err.field === 'q' ? 'dlg-err-q' : 'dlg-error', cl.text);
    });
  };

  G.handlers.click['account-pick'] = function (el) {
    const c = cur();
    const form = el.closest ? el.closest('form') : null;
    if (!c || !form || el.disabled) return;
    G.ui.runDialog(form, G.api.put(base(c) + '/account', { userId: el.getAttribute('data-uid') }), function (res) { applyRecord(c, res); }, function (err) { conflict(c, err); });
  };

  G.handlers.click['account-unlink-open'] = function () {
    const c = cur();
    if (!c) return;
    G.ui.openDialog(accountUnlinkDialogHtml(c.rec), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['account-unlink-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const viaDiscord = form.getAttribute('data-via') === 'discord';
    const call = viaDiscord ? G.api.patch(base(c), { expectedVersion: c.rec.person.version, linkUserId: null }) : G.api.put(base(c) + '/account', { userId: null });
    G.ui.runDialog(form, call, function (res) { applyRecord(c, res); }, function (err) { conflict(c, err); });
  };

  // Edit / Cancel on Details and Officer notes, and the You line's "Who can see this page" disclosure.
  function toggleEdit(part, on) {
    const c = cur();
    if (!c) return;
    setEditing(c.gid, c.pid, part, on);
    G.app.render();
    const first = document.getElementById(part === 'notes' ? 'officer-note' : 'det-status');
    if (on && first && first.focus) first.focus();
  }
  G.handlers.click['person-edit-open'] = function () { toggleEdit('details', true); };
  G.handlers.click['person-edit-close'] = function () { toggleEdit('details', false); };
  G.handlers.click['person-notes-edit'] = function () { toggleEdit('notes', true); };
  G.handlers.click['person-notes-close'] = function () { toggleEdit('notes', false); };
  G.handlers.click['you-sees-toggle'] = function (el) {
    const box = document.getElementById('you-sees');
    if (!box) return;
    const open = box.hidden;
    box.hidden = !open;
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  // characters
  function charById(c, cid) { return (c.rec.characters || []).filter(function (x) { return x.id === cid; })[0] || null; }

  G.handlers.click['char-add'] = function () {
    const c = cur();
    if (!c) return;
    G.ui.openDialog(characterDialogHtml({ guildData: c.gd, record: c.rec, character: null, defaultTeamId: G.app.teamFor(c.gd) }), { labelledBy: 'dlg-title' });
    const input = document.getElementById('dlg-name');
    if (input) input.focus();
  };

  G.handlers.click['char-edit'] = function (el) {
    const c = cur();
    const ch = c ? charById(c, el.getAttribute('data-cid')) : null;
    if (!ch) return;
    G.ui.openDialog(characterDialogHtml({ guildData: c.gd, record: c.rec, character: ch, defaultTeamId: ch.team && ch.team.id }), { labelledBy: 'dlg-title' });
    const input = document.getElementById('dlg-name');
    if (input) { input.focus(); input.select(); }
  };

  G.handlers.submit['char-form'] = function (form) {
    const c = cur();
    if (!c) return;
    G.ui.setText('dlg-error', '');
    const ch = G.pages.roster.readCharacter(form);
    if (!ch) return;
    const edit = form.getAttribute('data-mode') === 'edit';
    const teamId = form.elements.teamId ? form.elements.teamId.value : null;
    let promise;
    if (edit) {
      const body = Object.assign({}, ch);
      if (teamId) body.teamId = teamId;
      promise = G.api.patch(base(c) + '/characters/' + encodeURIComponent(form.getAttribute('data-cid')), body);
    } else {
      const sole = G.app.teamFor(c.gd);
      const checked = form.querySelector('input[name="mainOrAlt"]:checked');
      promise = G.api.post(base(c) + '/characters', Object.assign({}, ch, { teamId: teamId || sole, makeMain: !!checked && checked.value === 'main' }));
    }
    G.ui.runDialog(form, promise, function (res) { applyRecord(c, res); }, function (err) { conflict(c, err); });
  };

  G.handlers.click['char-main'] = function (el) {
    const c = cur();
    if (!c) return;
    el.disabled = true;
    G.api.post(base(c) + '/characters/' + encodeURIComponent(el.getAttribute('data-cid')) + '/main', {}).then(function (res) {
      applyRecord(c, res);
    }, function (err) { el.disabled = false; pageError(c, err); });
  };

  G.handlers.click['char-remove'] = function (el) {
    const c = cur();
    const ch = c ? charById(c, el.getAttribute('data-cid')) : null;
    if (!ch) return;
    G.ui.openDialog(removeCharDialogHtml(c.rec, ch), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['remove-char-form'] = function (form) {
    const c = cur();
    if (!c) return;
    G.ui.runDialog(form, G.api.del(base(c) + '/characters/' + encodeURIComponent(form.getAttribute('data-cid')), {}), function (res) { applyRecord(c, res); }, function (err) { conflict(c, err); });
  };

  // delete person
  G.handlers.click['person-delete'] = function () {
    const c = cur();
    if (!c) return;
    G.ui.openDialog(deleteDialogHtml(c.rec), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['delete-person-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const name = (mainOf(c.rec) || {}).name;
    G.ui.runDialog(form, G.api.del(base(c), {}), function (res) {
      G.app.applyFlags(c.gid, res);
      st().person = null;
      st().rosterNotice = 'Deleted ' + name + ' from the roster.';
      G.app.go(G.router.format({ name: 'section', gid: c.gid, section: 'roster' }));
    }, function (err) { conflict(c, err); });
  };

  G.pages.person = {
    // The open record and the ways to change it, for the Trial review card (its buttons patch the same record with the same conflict handling).
    ops: { cur: cur, applyRecord: applyRecord, conflict: conflict },
    CONFLICT_TEXT: CONFLICT_TEXT,
    MEMBER_NOTE: MEMBER_NOTE,
    NOTES_HINT: NOTES_HINT,
    mainOf: mainOf,
    altsOf: altsOf,
    headOpts: headOpts,
    headChipHtml: headChipHtml,
    accountText: accountText,
    panelHtml: panelHtml,
    setEditing: setEditing,
    contextHtml: contextHtml,
    youOf: youOf,
    OWN_SEES: OWN_SEES,
    personHtml: personHtml,
    characterDialogHtml: characterDialogHtml,
    deleteDialogHtml: deleteDialogHtml,
    accountLinkDialogHtml: accountLinkDialogHtml,
    accountResultsHtml: accountResultsHtml,
    accountUnlinkDialogHtml: accountUnlinkDialogHtml,
    removeCharDialogHtml: removeCharDialogHtml,
    charactersBodyHtml: charactersBodyHtml,
    charactersSection: charactersSection,
    detailsSection: detailsSection,
    notesSection: notesSection,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
