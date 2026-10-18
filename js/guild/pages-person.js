// ── PAGE: PERSON RECORD (R1 A, a full page) ─────────────────────
// Header and chips, the trial bar (text only), the Trial review card (pages-person-trial.js, trial editors only), Characters, Attendance (the card from pages-person-attendance.js), Loot (pages-person-loot.js), Details (with the Discord
// and Raidsmith account fields: an officer links the person to an account, found by a character claim or an exact BattleTag or name), Officer notes, Delete person.
// Editors get the forms; a member gets a read-only record. The dialogs (Add / Edit character, Extend trial,
// Delete) live here too. Every mutation answers with the whole person record, which replaces the page's copy;
// a 409 conflict re-renders from ApiError.body.current.
(function (G) {
  'use strict';

  const CONFLICT_TEXT = 'Someone else changed this person. The page now shows their version.';
  const MEMBER_NOTE = 'Officers keep your status and characters up to date. Ask one of them if something is wrong.';
  const NOTES_HINT = 'Only officers and team leads see notes.';
  const CHANGE_NOTE = 'The flag clears when the status changes or the trial end date moves.';

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function mainOf(record) {
    const list = Array.isArray(record.characters) ? record.characters : [];
    return list.filter(function (c) { return c.isMain; })[0] || list[0] || null;
  }
  function severalTeams(gd, record) {
    const ids = {};
    (record.characters || []).forEach(function (c) { if (c.team) ids[c.team.id] = true; });
    return G.shell.activeTeams(gd && gd.teams).length > 1 || Object.keys(ids).length > 1;
  }

  // ── header ──
  function discordLineHtml(record) {
    const d = record.person.discord || {};
    const a = record.person.account || {};
    let line;
    if (d.signIn === 'signed_in') {
      const u = d.user || {};
      line = 'Discord: ' + esc(u.username || u.displayName || '') + ' &middot; Signed in';
    } else if (d.signIn === 'not_yet') {
      line = 'Discord: ' + (d.nickname ? esc(d.nickname) + ' &middot; ' : '') + 'Not signed in yet';
    } else {
      line = 'No Discord account';
    }
    // An account an officer linked (it may have no Discord at all) gets its own words, unless it is the Discord account already named.
    const sameAsDiscord = d.signIn === 'signed_in' && d.user && a.user && d.user.id === a.user.id;
    if (a.user && a.via === 'link' && !sameAsDiscord) {
      const account = 'Account: ' + esc(a.user.displayName) + ' &middot; Signed in';
      return d.signIn === 'no_discord' ? account : line + ' &middot; ' + account;
    }
    return line;
  }

  function headHtml(record, can) {
    const main = mainOf(record) || {};
    const p = record.person;
    const chips = G.ui.statusChipHtml(p.status, p) + (can.edit ? G.ui.trialChipHtml(p.trialFlag) : '') +
      (can.edit ? '' : (p.joinedOn ? '<span class="gs-chip gs-chip-plain">Joined ' + esc(G.ui.formatDay(p.joinedOn)) + '</span>' : ''));
    return '<div class="gs-person-head"><div class="gs-person-title"><div class="gs-person-h1">' + G.ui.roleDotHtml(main.role) +
      '<h1 class="gs-h1" tabindex="-1">' + esc(main.name) + '</h1>' + (p.isMe ? '<span class="gs-you">You</span>' : '') + '</div>' +
      '<p class="gs-sub">' + G.ui.specLineHtml(main.class, main.mainSpec, main.offSpec) + '</p>' +
      '<div class="gs-chips">' + chips + '</div></div>' +
      '<p class="gs-person-discord">' + discordLineHtml(record) + '</p></div>';
  }

  // ── trial bar ──
  function trialWhen(flag) {
    const days = Math.abs(Number(flag.days));
    if (flag.kind === 'ended') return days === 1 ? 'yesterday' : days + ' days ago';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return 'in ' + days + ' days';
  }

  function trialBarHtml(record, can) {
    const p = record.person;
    if (!can.edit || !p.trialFlag || p.status !== 'trial') return '';
    const main = mainOf(record) || {};
    const flag = p.trialFlag;
    const verb = flag.kind === 'ended' ? 'ended' : 'ends';
    const text = esc(main.name) + '\'s trial ' + verb + ' on ' + esc(G.ui.formatDay(p.trialEnd)) + ' (' + esc(trialWhen(flag)) + ').';
    // Text only: Promote / Extend / End live on the Trial review card below (pages-person-trial.js), the one set of trial buttons.
    return '<div class="gs-trial-bar ' + (flag.kind === 'ended' ? 'is-ended' : 'is-ends') + '" role="status"><p class="gs-trial-bar-text">' + text + '</p></div>' +
      '<p class="gs-fine">' + esc(CHANGE_NOTE) + '</p>';
  }

  // ── characters ──
  function typeChipHtml(c) {
    return c.isMain ? '<span class="gs-chip gs-chip-main">Main</span>' : '<span class="gs-chip">Alt</span>';
  }

  function charActionsHtml(c, can) {
    if (!can.edit) return '';
    return '<button type="button" class="gs-btn gs-btn-sm" data-action="char-edit" data-cid="' + esc(c.id) + '" data-key="char-edit-' + esc(c.id) + '" aria-label="Edit ' + esc(c.name) + '">Edit</button>' +
      (c.isMain ? '' : '<button type="button" class="gs-btn gs-btn-sm" data-action="char-main" data-cid="' + esc(c.id) + '" data-key="char-main-' + esc(c.id) + '" aria-label="Make ' + esc(c.name) + ' the Main">Make Main</button>' +
        '<button type="button" class="gs-icon-btn gs-icon-btn-danger" data-action="char-remove" data-cid="' + esc(c.id) + '" data-key="char-remove-' + esc(c.id) + '" aria-label="Remove ' + esc(c.name) + '">' + G.icons.icon('trash', 18) + '</button>');
  }

  function charactersHtml(record, can, showTeam) {
    const list = Array.isArray(record.characters) ? record.characters : [];
    const rows = list.map(function (c) {
      return '<tr><th scope="row" class="gs-cell-strong">' + G.ui.classNameHtml(c.name, c.class) + (c.realm ? '<span class="gs-char-sub">' + esc(c.realm) + '</span>' : '') + '</th><td>' + esc(G.ui.className(c.class)) + '</td><td>' + (c.mainSpec ? esc(c.mainSpec) : '<span class="gs-muted">-</span>') + '</td><td>' +
        (c.offSpec ? esc(c.offSpec) : '<span class="gs-muted">-</span>') + '</td>' + (showTeam ? '<td>' + esc(c.team && c.team.name) + (c.team && c.team.archived ? ' (archived)' : '') + '</td>' : '') + '<td>' + typeChipHtml(c) + '</td>' +
        (can.edit ? '<td><div class="gs-row-actions">' + charActionsHtml(c, can) + '</div></td>' : '') + '</tr>';
    }).join('');
    const cards = list.map(function (c) {
      return '<li class="gs-char-card"><div class="gs-card-top"><span class="gs-char-cell">' + G.ui.roleDotHtml(c.role) + '<span class="gs-char-text">' + G.ui.classNameHtml(c.name, c.class) + '</span></span>' + typeChipHtml(c) + '</div>' +
        '<div class="gs-card-line">' + G.ui.specLineHtml(c.class, c.mainSpec, c.offSpec) + '</div>' + (showTeam ? '<div class="gs-fine">' + esc(c.team && c.team.name) + '</div>' : '') +
        (can.edit ? '<div class="gs-row-actions">' + charActionsHtml(c, can) + '</div>' : '') + '</li>';
    }).join('');
    return '<section class="gs-card-sec" aria-labelledby="characters-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="characters-h">Characters</h2>' +
      (can.addCharacter ? '<button type="button" class="gs-btn gs-btn-sm" data-action="char-add" data-key="char-add">Add character</button>' : '') + '</div>' +
      '<div class="gs-table-wrap gs-flush gs-char-table"><table class="gs-table gs-table-chars" aria-label="Characters"><thead><tr><th scope="col">Name</th><th scope="col">Class</th><th scope="col">Main spec</th><th scope="col">Off spec</th>' +
      (showTeam ? '<th scope="col">Team</th>' : '') + '<th scope="col"><span class="gs-sr">Type</span></th>' + (can.edit ? '<th scope="col"><span class="gs-sr">Actions</span></th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<ul class="gs-char-cards" aria-label="Characters">' + cards + '</ul></section>';
  }

  // The Attendance card (pages-person-attendance.js): window and all-time %, the last raids, a link to the full history.
  function attendanceHtml(record, gid, state) {
    return G.pages.personAtt.cardHtml({ gid: gid, pid: record.person.id, record: record, state: state });
  }

  // The Trial review card (pages-person-trial.js): it decides for itself whether this person gets one.
  function trialCardHtml(opts) {
    if (!G.pages.personTrial) return '';
    return G.pages.personTrial.cardHtml({ guildData: opts.guildData, gid: opts.guildData.guild.id, pid: opts.record.person.id, record: opts.record, state: opts.trial });
  }

  // ── details form ──
  function detailsHtml(record, linkable) {
    const p = record.person;
    const d = p.discord || {};
    const users = [];
    if (d.user && d.user.id) users.push(d.user);
    (Array.isArray(linkable) ? linkable : []).forEach(function (u) { if (!d.user || u.id !== d.user.id) users.push(u); });
    const statusOpts = G.ui.optionsHtml(['raider', 'trial', 'reserve', 'inactive'].map(function (s) { return { value: s, label: G.ui.statusLabel(s) }; }), p.status);
    const inactive = p.status === 'inactive';
    const reasonOpts = G.ui.optionsHtml([{ value: '', label: 'No reason' }].concat(Object.keys(G.ui.LEFT_REASONS).map(function (k) { return { value: k, label: G.ui.LEFT_REASONS[k] }; })), p.leftReason || '');
    return '<section class="gs-card-sec" aria-labelledby="details-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="details-h">Details</h2></div>' +
      '<form class="gs-card-sec-body gs-details-form" data-submit="person-details-form" novalidate>' +
      '<div class="gs-field"><label class="gs-label" for="det-status">Status</label><select class="gs-input" id="det-status" name="status" data-change="person-status-change">' + statusOpts + '</select></div>' +
      '<div class="gs-field" id="det-reason-field"' + (inactive ? '' : ' hidden') + '><label class="gs-label" for="det-reason">Reason</label><select class="gs-input" id="det-reason" name="leftReason">' + reasonOpts + '</select></div>' +
      '<div class="gs-field" id="det-lefton-field"' + (inactive ? '' : ' hidden') + '><label class="gs-label" for="det-lefton">Left on</label><input class="gs-input" type="date" id="det-lefton" name="leftOn" value="' + esc(inactive ? p.leftOn || '' : record.today || '') + '"></div>' +
      '<div class="gs-field"><label class="gs-label" for="det-joined">Joined</label><input class="gs-input" type="date" id="det-joined" name="joinedOn" value="' + esc(p.joinedOn || '') + '"></div>' +
      '<div class="gs-field"><label class="gs-label" for="det-tstart">Trial start</label><input class="gs-input" type="date" id="det-tstart" name="trialStart" value="' + esc(p.trialStart || '') + '"></div>' +
      '<div class="gs-field"><label class="gs-label" for="det-tend">Trial end</label><input class="gs-input" type="date" id="det-tend" name="trialEnd" value="' + esc(p.trialEnd || '') + '"></div>' +
      '<div class="gs-field"><label class="gs-label" for="det-link">Discord account</label><select class="gs-input" id="det-link" name="linkUserId" aria-describedby="det-link-help">' + G.pages.roster.linkOptionsHtml(users, d.user ? d.user.id : '') + '</select>' +
      '<p class="gs-fine" id="det-link-help">' + (d.nickname ? 'Nickname on the Raid-Helper sign-up: ' + esc(d.nickname) + '. ' : '') + 'Lists members who have signed in to Raidsmith and are not on the roster yet.</p></div>' +
      accountFieldHtml(record) +
      '<p class="gs-alert" id="det-error" role="alert" hidden></p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-molten">Save changes</button></div></form></section>';
  }

  // The Raidsmith account field: who this person is on Raidsmith besides the Discord account above. An officer's link can be changed here; one that
  // comes through the Discord account is changed on the Discord field.
  function accountFieldHtml(record) {
    const a = (record.person && record.person.account) || {};
    let body;
    if (a.user && a.via === 'link') {
      body = '<p class="gs-account-line" id="det-account-current"><strong>' + esc(a.user.displayName) + '</strong> <span class="gs-muted">linked by an officer</span></p>' +
        '<div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="account-unlink-open" data-key="account-unlink">Unlink account</button></div>';
    } else if (a.user) {
      body = '<p class="gs-account-line" id="det-account-current"><strong>' + esc(a.user.displayName) + '</strong> <span class="gs-muted">through the Discord account above</span></p>';
    } else {
      body = '<p class="gs-account-line gs-muted" id="det-account-current">Not linked</p>' +
        '<div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="account-link-open" data-key="account-link">Link account</button></div>';
    }
    return '<div class="gs-field" id="det-account-field"><span class="gs-label" id="det-account-label">Raidsmith account</span>' + body +
      '<p class="gs-fine" id="det-account-help">For a member who signs in with Battle.net, or is not in the Discord server: linking their account lets them in to this guild and shows them their own record.</p></div>';
  }

  // A member's read-only Details: the dates, no form.
  function readOnlyDetailsHtml(record) {
    const p = record.person;
    const rows = [['Joined', p.joinedOn], ['Trial start', p.trialStart], ['Trial end', p.trialEnd]].filter(function (r) { return !!r[1]; });
    if (!rows.length) return '';
    return '<section class="gs-card-sec" aria-labelledby="details-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="details-h">Details</h2></div><dl class="gs-card-sec-body gs-dates">' +
      rows.map(function (r) { return '<div class="gs-date-row"><dt>' + esc(r[0]) + '</dt><dd>' + esc(G.ui.formatDay(r[1])) + '</dd></div>'; }).join('') + '</dl></section>';
  }

  // ── notes ──
  function notesHtml(record, can) {
    const n = record.notes;
    if (!n) return '';
    const by = n.updatedBy && n.updatedBy.displayName ? n.updatedBy.displayName : '';
    const when = n.updatedAt ? G.ui.formatDate(n.updatedAt) : '';
    const edited = by || when ? '<p class="gs-fine" id="notes-edited">Last edited' + (by ? ' by ' + esc(by) : '') + (when ? ' on ' + esc(when) : '') + '</p>' : '';
    return '<section class="gs-card-sec" aria-labelledby="notes-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="notes-h">Officer notes</h2></div>' +
      '<form class="gs-card-sec-body" data-submit="person-notes-form" novalidate><p class="gs-fine">' + esc(NOTES_HINT) + '</p>' +
      '<div class="gs-field"><label class="gs-label" for="officer-note">Officer notes</label><textarea class="gs-input gs-textarea" id="officer-note" name="text" rows="4" maxlength="4000"' + (can.notesEdit ? '' : ' readonly') + '>' + esc(n.text) + '</textarea></div>' +
      edited + '<p class="gs-alert" id="notes-error" role="alert" hidden></p>' +
      (can.notesEdit ? '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-sm">Save note</button></div>' : '') + '</form></section>';
  }

  function deleteHtml(record, can) {
    if (!can.delete) return '';
    const name = (mainOf(record) || {}).name;
    return '<div class="gs-delete-row"><button type="button" class="gs-btn gs-btn-danger-outline" data-action="person-delete" data-key="person-delete">Delete person</button>' +
      '<p class="gs-fine">Removes ' + esc(name) + ' and their characters from the roster. Their Discord sign-in is not affected. Once they have attendance, set them to Inactive instead.</p></div>';
  }

  // opts: { guildData, record (GET /roster/p_...), linkable: [person] | null, alert, attendance (card state), trial (Trial review card state) }
  function personHtml(opts) {
    const record = opts.record;
    const can = Object.assign({ edit: false, notesView: false, notesEdit: false, delete: false, addCharacter: false }, record.can || {});
    const showTeam = severalTeams(opts.guildData, record);
    const readOnly = !can.edit;
    return '<div class="gs-page gs-person-page">' + headHtml(record, can) +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      trialBarHtml(record, can) +
      trialCardHtml(opts) +
      (readOnly && record.person.isMe ? '<p class="gs-fine gs-member-note">' + esc(MEMBER_NOTE) + '</p>' : '') +
      '<div class="gs-person-cols"><div class="gs-person-main">' + charactersHtml(record, can, showTeam) + attendanceHtml(record, opts.guildData.guild.id, opts.attendance) + G.pages.personLoot.cardFor(opts.guildData, record, record.person.id) + '</div>' +
      '<div class="gs-person-side">' + (can.edit ? detailsHtml(record, opts.linkable) : readOnlyDetailsHtml(record)) + notesHtml(record, can) + '</div></div>' +
      deleteHtml(record, can) + '</div>';
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
    return '<form class="gs-dialog-form" data-submit="char-form" data-mode="' + (edit ? 'edit' : 'add') + '"' + (edit ? ' data-cid="' + esc(c.id) + '"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + (edit ? 'Edit ' + esc(c.name) : 'Add a character for ' + esc(person.name)) + '</h2>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-name">Character name</label><input class="gs-input" type="text" id="dlg-name" name="name" data-field="name" maxlength="40" autocomplete="off" required value="' + esc(c ? c.name : '') + '">' +
      '<p class="gs-field-error" id="dlg-err-name" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-class">Class</label><select class="gs-input" id="dlg-class" name="class" data-field="class" data-change="roster-class-change">' + G.ui.classOptionsHtml(ro, cls, 'Choose a class') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-class" role="alert" hidden></p></div>' +
      '<div class="gs-grid gs-grid-2"><div class="gs-field"><label class="gs-label" for="dlg-mainspec">Main spec</label><select class="gs-input" id="dlg-mainspec" name="mainSpec" data-field="mainSpec">' + G.ui.specOptionsHtml(ro, cls, c ? c.mainSpec : '', 'Not set') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-mainSpec" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-offspec">Off spec</label><select class="gs-input" id="dlg-offspec" name="offSpec" data-field="offSpec">' + G.ui.specOptionsHtml(ro, cls, c ? c.offSpec : '', 'None') + '</select>' +
      '<p class="gs-field-error" id="dlg-err-offSpec" role="alert" hidden></p></div></div>' +
      charTeamFieldHtml(gd, edit ? c.team.id : opts.defaultTeamId, c) + modeFields +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">' + (edit ? 'Save' : 'Add character') + '</button></div></form>';
  }

  function removeCharDialogHtml(record, character) {
    const person = (mainOf(record) || {}).name;
    return '<form class="gs-dialog-form" data-submit="remove-char-form" data-cid="' + esc(character.id) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">Remove character</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Remove ' + esc(character.name) + ' from ' + esc(person) + "'s characters?</p>" +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove</button></div></form>';
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
        : '<button type="button" class="gs-btn gs-btn-sm gs-btn-molten" data-action="account-pick" data-uid="' + esc(a.id) + '" data-key="account-pick-' + esc(a.id) + '" aria-label="Link ' + esc(a.displayName) + '">Link</button>';
      return '<li class="gs-account-row">' + G.ui.avatarHtml(a, 'gs-avatar-md') + '<span class="gs-account-text"><span class="gs-account-name">' + esc(a.displayName) + '</span>' +
        '<span class="gs-fine">' + esc(how[a.matchedBy] || '') + (a.battletag ? ' &middot; ' + esc(a.battletag) : '') + '</span></span>' + action + '</li>';
    }).join('') + '</ul>';
  }

  function accountLinkDialogHtml(record, accounts) {
    const name = (mainOf(record) || {}).name;
    return '<form class="gs-dialog-form" data-submit="account-find-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Link an account to ' + esc(name) + '</h2>' +
      '<p class="gs-fine" id="dlg-help">Pick someone who sent a character claim, or type their whole BattleTag (like Name#1234) or the name their account shows. Raidsmith never lists accounts.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-acct-q">BattleTag or name</label><input class="gs-input" type="text" id="dlg-acct-q" name="q" data-field="q" maxlength="64" autocomplete="off" aria-describedby="dlg-help">' +
      '<p class="gs-field-error" id="dlg-err-q" role="alert" hidden></p></div>' +
      '<div id="dlg-acct-results" aria-live="polite">' + accountResultsHtml(accounts, '') + '</div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Close</button><button type="submit" class="gs-btn">Find</button></div></form>';
  }

  function accountUnlinkDialogHtml(record) {
    const a = (record.person && record.person.account) || {};
    const name = (mainOf(record) || {}).name;
    return '<form class="gs-dialog-form" data-submit="account-unlink-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">Unlink account</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Unlink ' + esc(a.user ? a.user.displayName : 'this account') + ' from ' + esc(name) + '? They keep their Raidsmith account, but they can no longer open this guild unless they are in its Discord server, and ' + esc(name) + ' is no longer theirs.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Unlink account</button></div></form>';
  }

  function deleteDialogHtml(record) {
    const name = (mainOf(record) || {}).name;
    const n = (record.characters || []).length;
    return '<form class="gs-dialog-form" data-submit="delete-person-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">Delete person</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-text">Delete ' + esc(name) + '? This removes them and their ' + esc(plural(n, 'character', 'characters')) + ' from the roster. It can\'t be undone.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Delete person</button></div></form>';
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

  // The Reason and Left on fields belong to Inactive only.
  G.handlers.change['person-status-change'] = function (el) {
    ['det-reason-field', 'det-lefton-field'].forEach(function (id) {
      const field = document.getElementById(id);
      if (field) field.hidden = el.value !== 'inactive';
    });
  };

  G.handlers.submit['person-details-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const p = c.rec.person;
    const body = {};
    const date = function (name) { return form.elements[name].value || null; };
    if (form.elements.status.value !== p.status) body.status = form.elements.status.value;
    ['joinedOn', 'trialStart', 'trialEnd'].forEach(function (k) {
      if (date(k) !== (p[k] || null)) body[k] = date(k);
    });
    if (form.elements.status.value === 'inactive' && form.elements.leftOn && form.elements.leftReason) {
      const entering = p.status !== 'inactive';
      if (entering || date('leftOn') !== (p.leftOn || null)) body.leftOn = date('leftOn');
      if (entering || date('leftReason') !== (p.leftReason || null)) body.leftReason = date('leftReason');
    }
    const linked = p.discord && p.discord.user ? p.discord.user.id : '';
    if (form.elements.linkUserId.value !== linked) body.linkUserId = form.elements.linkUserId.value || null;
    G.ui.setText('det-error', '');
    if (!Object.keys(body).length) { G.ui.setText('det-error', 'Nothing to save: no detail was changed.'); return; }
    G.ui.setBusy(form, true);
    G.api.patch(base(c), Object.assign({ expectedVersion: p.version }, body)).then(function (res) {
      if (st().linkable) delete st().linkable[c.gid];
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
    G.ui.runDialog(form, G.api.put(base(c) + '/account', { userId: null }), function (res) { applyRecord(c, res); }, function (err) { conflict(c, err); });
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
    personHtml: personHtml,
    characterDialogHtml: characterDialogHtml,
    deleteDialogHtml: deleteDialogHtml,
    accountFieldHtml: accountFieldHtml,
    accountLinkDialogHtml: accountLinkDialogHtml,
    accountResultsHtml: accountResultsHtml,
    accountUnlinkDialogHtml: accountUnlinkDialogHtml,
    removeCharDialogHtml: removeCharDialogHtml,
    readOnlyDetailsHtml: readOnlyDetailsHtml,
    trialBarHtml: trialBarHtml,
    charactersHtml: charactersHtml,
    detailsHtml: detailsHtml,
    notesHtml: notesHtml,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
