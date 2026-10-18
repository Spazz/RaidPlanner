// ── PAGE: ROSTER > SPEC POLL (the class and spec poll; the route and API keep the name "intent") ────
// An officer opens a spec poll round for a team (a title, an optional close date); the people of the team say what they plan to play: one main pick (class
// and spec; the role follows from the spec), an optional alt pick, a note of up to 120 characters. The board adds the main picks up by role and class
// against the team's raid size and role targets, and reads which raid buffs and debuffs the picked roster covers with the Planner's rules for the guild's
// game version (coverage.js). Officers close the round; a closed round stays readable. GET /intent?team=&round=, POST /teams/:tid/intent,
// PATCH /intent/:iid, PUT / DELETE /intent/:iid/picks/:pid. Every write answers with the board, so the page just replaces its copy.
(function (G) {
  'use strict';

  const NOTE_MAX = 120;
  const ROLE_ORDER = ['tank', 'healer', 'melee', 'ranged'];
  const ROLE_LABELS = { tank: 'Tanks', healer: 'Healers', melee: 'Melee DPS', ranged: 'Ranged DPS' };
  const ROLE_ONE = { tank: 'Tank', healer: 'Healer', melee: 'Melee DPS', ranged: 'Ranged DPS' };

  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function mainPicks(board) { return board.picks.filter(function (p) { return p.kind === 'main'; }); }

  // The default title of a new round: the launch the guild is waiting for.
  function defaultTitle(gameVersion) { return gameVersion === 'forever' ? 'WoW Forever launch' : ''; }

  function specsOf(board) {
    return mainPicks(board).map(function (p) { return { class: p.class, spec: p.spec }; });
  }

  // ── data ──
  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().intent = { gid: gid, teamId: null, board: null }; return Promise.resolve(null); }
    const prev = a().intent;
    const keep = prev && prev.gid === gid && prev.teamId === teamId && prev.viewRound ? prev.viewRound : null;
    return G.api.intent.get(gid, teamId, keep).then(function (board) {
      a().intent = makeState(gid, teamId, board, keep);
      return null;
    }, function (err) {
      if (keep && err && err.status === 404) return G.api.intent.get(gid, teamId, null).then(function (board) { a().intent = makeState(gid, teamId, board, null); return null; });
      throw err;
    });
  }

  function makeState(gid, teamId, board, viewRound) {
    const x = { gid: gid, teamId: teamId, board: board, viewRound: viewRound, note: '', busy: false };
    x.cov = coverageOf(board);
    return x;
  }

  function coverageOf(board) {
    return G.coverage.compute(board.gameVersion, specsOf(board), board.team.size);
  }

  function setBoard(x, board) {
    x.board = board;
    x.cov = coverageOf(board);
    x.busy = false;
  }

  // ── the page ──
  function roundLine(board) {
    const r = board.round;
    const parts = ['Opened ' + G.ui.formatDate(r.createdAt)];
    if (r.status === 'closed' && r.closedAt) parts.push('closed ' + G.ui.formatDate(r.closedAt));
    else if (r.closesOn) parts.push('closes ' + G.ui.formatDay(r.closesOn));
    return parts.join(', ') + '.';
  }

  function historyHtml(board) {
    if (board.rounds.length < 2) return '';
    return '<div class="gs-field gs-intent-history"><label class="gs-label" for="intent-round">Round</label><select class="gs-input" id="intent-round" data-change="intent-round" data-key="intent-round">' +
      G.ui.optionsHtml(board.rounds.map(function (r) { return { value: r.id, label: r.title + (r.status === 'open' ? ' (open)' : ' (closed)') }; }), board.round ? board.round.id : '') + '</select></div>';
  }

  function emptyHtml(board, gd) {
    const edit = board.canEdit && !board.team.archived;
    return '<section class="gs-empty-card" aria-labelledby="intent-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('roster', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="intent-empty-h">No spec poll yet</h2>' +
      '<p class="gs-lead gs-lead-sm">' + (edit
        ? 'Open a round to ask the team what they plan to play. They pick a class and spec, and this page adds the picks up against the raid size and shows which buffs and debuffs the raid would cover.'
        : 'Your officers have not opened a spec poll for this team yet.') + '</p>' +
      (edit ? '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="intent-open" data-key="intent-open">Open a spec poll</button></div>' : '') + '</section>';
  }

  function roundHtml(board, x) {
    const r = board.round;
    const open = r.status === 'open';
    const mains = mainPicks(board).length;
    const total = mains + board.undecided.length;
    const acts = [];
    if (board.canPick) acts.push('<button type="button" class="gs-btn gs-btn-molten" data-action="intent-edit" data-pid="' + esc(board.myPersonId) + '" data-key="intent-mine">' + (board.picks.some(function (p) { return p.mine; }) ? 'Change my pick' : 'Set my pick') + '</button>');
    if (board.canEdit && open) acts.push('<button type="button" class="gs-btn" data-action="intent-close" data-key="intent-close">Close round</button>');
    if (board.canEdit && !open && !board.team.archived && !board.rounds.some(function (e) { return e.status === 'open'; })) acts.push('<button type="button" class="gs-btn" data-action="intent-open" data-key="intent-open">Open a new round</button>');
    return '<section class="gs-card-sec gs-intent-round" aria-labelledby="intent-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="intent-h">' + esc(r.title) + '</h2>' +
      '<span class="gs-pill gs-pill-' + (open ? 'ok' : 'muted') + '">' + (open ? 'Open' : 'Closed') + '</span></div>' +
      '<div class="gs-card-sec-body"><p class="gs-fine">' + esc(roundLine(board)) + ' ' + esc(open
        ? plural(mains, 'main pick', 'main picks') + (total > mains ? ', ' + plural(board.undecided.length, 'person has', 'people have') + ' not picked yet' : '') + '.'
        : plural(mains, 'main pick', 'main picks') + '.') + '</p>' +
      (open && !board.canPick && !board.canEdit ? '<p class="gs-fine">Only people on this team can pick. Ask an officer if you should be here.</p>' : '') +
      (acts.length || board.rounds.length > 1 ? '<div class="gs-actions gs-intent-actions">' + acts.join('') + historyHtml(board) + '</div>' : '') + '</div></section>';
  }

  function totalsHtml(board) {
    const t = board.totals;
    const size = board.team.size;
    const rows = ROLE_ORDER.map(function (role) {
      const want = board.targets ? board.targets[role] : null;
      const have = t.byRole[role] || 0;
      const diff = want === null ? '' : (have < want ? 'Need ' + (want - have) : have > want ? (have - want) + ' over' : 'Full');
      return '<tr><th scope="row" class="gs-cell-strong">' + esc(ROLE_LABELS[role]) + '</th><td class="gs-num" data-label="Picked">' + esc(have) + '</td>' +
        '<td class="gs-num" data-label="Target">' + (want === null ? '-' : esc(want)) + '</td><td data-label="Gap">' + esc(diff) + '</td></tr>';
    }).join('');
    const classes = Object.keys(t.byClass).filter(function (id) { return t.byClass[id] > 0; }).sort(function (x, y) { return t.byClass[y] - t.byClass[x] || (x < y ? -1 : 1); });
    return '<section class="gs-card-sec" aria-labelledby="intent-totals-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="intent-totals-h">Against a ' + esc(size) + '-man raid</h2>' +
      '<span class="gs-fine">' + esc(t.mains + ' of ' + size + ' spots picked') + '</span></div><div class="gs-card-sec-body">' +
      '<div class="gs-table-wrap"><table class="gs-table gs-table-stack" aria-label="Main picks by role"><thead><tr><th scope="col">Role</th><th scope="col">Picked</th><th scope="col">Target</th><th scope="col">Gap</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<h3 class="gs-h3">By class</h3>' +
      (classes.length ? '<ul class="gs-intent-classes" aria-label="Main picks by class">' + classes.map(function (id) {
        return '<li><span class="gs-chip ' + esc(G.ui.classClass(id)) + '">' + esc(G.ui.className(id)) + ' ' + esc(t.byClass[id]) + '</span></li>';
      }).join('') + '</ul>' : '<p class="gs-empty">No picks yet.</p>') + '</div></section>';
  }

  function pickText(p) {
    return G.ui.classNameHtml(G.ui.className(p.class) + ' ' + p.spec, p.class) + ' <span class="gs-fine">' + esc(ROLE_ONE[p.role] || '') + '</span>';
  }

  function personRows(board) {
    const by = {};
    const order = [];
    board.picks.forEach(function (p) {
      if (!by[p.personId]) { by[p.personId] = { personId: p.personId, name: p.name, main: null, alt: null }; order.push(p.personId); }
      by[p.personId][p.kind] = p;
    });
    return order.map(function (id) { return by[id]; }).sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
  }

  function picksHtml(board) {
    const people = personRows(board);
    const open = board.round.status === 'open';
    const editCol = board.canEdit && open;
    const rows = people.map(function (p) {
      const note = [p.main && p.main.note, p.alt && p.alt.note].filter(Boolean);
      return '<tr><th scope="row" class="gs-cell-strong">' + esc(p.name) + (p.main && p.main.mine ? ' <span class="gs-fine">(you)</span>' : '') + '</th>' +
        '<td data-label="Main">' + (p.main ? pickText(p.main) : '<span class="gs-muted">-</span>') + '</td>' +
        '<td data-label="Alt">' + (p.alt ? pickText(p.alt) : '<span class="gs-muted">-</span>') + '</td>' +
        '<td data-label="Note">' + (note.length ? esc(note.join(' / ')) : '<span class="gs-muted">-</span>') + '</td>' +
        (editCol ? '<td><button type="button" class="gs-btn gs-btn-sm" data-action="intent-edit" data-pid="' + esc(p.personId) + '" data-key="intent-edit-' + esc(p.personId) + '" aria-label="Change the pick of ' + esc(p.name) + '">Change</button></td>' : '') + '</tr>';
    }).join('');
    const undecided = board.undecided;
    return '<section class="gs-card-sec" aria-labelledby="intent-picks-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="intent-picks-h">Picks</h2></div><div class="gs-card-sec-body">' +
      (people.length
        ? '<div class="gs-table-wrap"><table class="gs-table gs-table-stack" aria-label="Picks"><thead><tr><th scope="col">Player</th><th scope="col">Main</th><th scope="col">Alt</th><th scope="col">Note</th>' +
          (editCol ? '<th scope="col"><span class="gs-sr">Actions</span></th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p class="gs-empty">Nobody has picked yet.</p>') +
      (open && undecided.length
        ? '<h3 class="gs-h3">Not picked yet (' + esc(undecided.length) + ')</h3><ul class="gs-intent-undecided">' + undecided.map(function (u) {
          return '<li>' + G.ui.classNameHtml(u.name, u.class) + (board.canEdit ? ' <button type="button" class="gs-btn gs-btn-sm" data-action="intent-edit" data-pid="' + esc(u.personId) + '" data-key="intent-edit-' + esc(u.personId) + '" aria-label="Set the pick of ' + esc(u.name) + '">Set pick</button>' : '') + '</li>';
        }).join('') + '</ul>' : '') + '</div></section>';
  }

  // opts: { guildData, state: a().intent, alert }
  function intentHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const board = x.board;
    const head = G.pages.rosterTabs.headHtml(gd, 'intent', board.team.name);
    const alert = G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '');
    if (!board.round) return '<div class="gs-page">' + head + alert + emptyHtml(board, gd) + '</div>';
    return '<div class="gs-page">' + head + alert + roundHtml(board, x) + totalsHtml(board) +
      G.coverage.panelHtml(x.cov, { id: 'intent-cov', heading: 'Buffs and debuffs of the planned raid', intro: 'What the main picks would cover.' }) + picksHtml(board) + '</div>';
  }

  function main(r, gd) {
    const x = a().intent;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return intentHtml({ guildData: gd, state: x, alert: G.app.state.pageAlert });
  }

  // ── dialogs ──
  function openDialogHtml(gd, board) {
    return '<form class="gs-dialog-form" data-submit="intent-open-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">Open a spec poll</h2>' +
      '<p class="gs-fine">' + esc(board.team.name) + ' picks what they plan to play. Only one round is open at a time.</p>' +
      '<div class="gs-field"><label class="gs-label" for="io-title">Title</label><input class="gs-input" type="text" id="io-title" name="title" maxlength="80" autocomplete="off" required data-field="title" value="' + esc(defaultTitle(gd.guild.gameVersion)) + '">' +
      '<p class="gs-field-error" id="dlg-err-title" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="io-closes">Close date (optional)</label><input class="gs-input" type="date" id="io-closes" name="closesOn" data-field="closesOn" aria-describedby="io-closes-help">' +
      '<p class="gs-fine" id="io-closes-help">A reminder shown on the board. The round stays open until an officer closes it.</p><p class="gs-field-error" id="dlg-err-closesOn" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Open round</button></div></form>';
  }

  function closeDialogHtml(board) {
    return '<form class="gs-dialog-form" data-submit="intent-close-form"><h2 class="gs-dialog-title" id="dlg-title">Close this round?</h2>' +
      '<p class="gs-fine" id="dlg-text">' + esc(board.round.title) + ' stays readable, but nobody can change a pick any more.</p><p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Close round</button></div></form>';
  }

  function roleText(board, classId, spec) {
    const byClass = board.roles && board.roles[classId];
    return byClass && spec && byClass[spec] ? 'Counts as: ' + ROLE_ONE[byClass[spec]] : '';
  }

  function pickFieldsHtml(prefix, label, options, board, pick, optional) {
    const classId = pick ? pick.class : '';
    return '<fieldset class="gs-fieldset"><legend class="gs-legend">' + esc(label) + '</legend>' +
      '<div class="gs-field"><label class="gs-label" for="ip-' + prefix + '-class">Class</label><select class="gs-input" id="ip-' + prefix + '-class" name="' + prefix + 'Class" data-change="intent-class" data-prefix="' + prefix + '" data-field="' + prefix + 'Class">' +
      G.ui.classOptionsHtml(options, classId, optional ? 'No ' + prefix + ' pick' : 'Choose a class') + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="ip-' + prefix + '-spec">Spec</label><select class="gs-input" id="ip-' + prefix + '-spec" name="' + prefix + 'Spec" data-change="intent-spec" data-prefix="' + prefix + '" data-field="' + prefix + 'Spec">' +
      G.ui.specOptionsHtml(options, classId, pick ? pick.spec : '', 'Choose a spec') + '</select><p class="gs-fine" id="ip-' + prefix + '-role" aria-live="polite">' + esc(pick ? roleText(board, pick.class, pick.spec) : '') + '</p>' +
      '<p class="gs-field-error" id="dlg-err-' + prefix + 'Spec" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="ip-' + prefix + '-note">Note (optional)</label><input class="gs-input" type="text" id="ip-' + prefix + '-note" name="' + prefix + 'Note" maxlength="' + NOTE_MAX + '" autocomplete="off" data-field="' + prefix + 'Note" value="' + esc(pick && pick.note ? pick.note : '') + '"></div></fieldset>';
  }

  // person: { id, name }; picks: { main, alt } (the current ones or null).
  function pickDialogHtml(gd, board, person, picks, mine) {
    const options = G.ui.rosterOptions(gd);
    return '<form class="gs-dialog-form" data-submit="intent-pick-form" data-pid="' + esc(person.id) + '" novalidate><h2 class="gs-dialog-title" id="dlg-title">' + (mine ? 'Your pick for ' : 'Pick for ') + esc(mine ? board.round.title : person.name) + '</h2>' +
      '<p class="gs-fine">What you plan to play. The role follows from the spec. An alt needs a main.</p>' +
      pickFieldsHtml('main', 'Main', options, board, picks.main, true) + pickFieldsHtml('alt', 'Alt (optional)', options, board, picks.alt, true) +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save</button></div></form>';
  }

  // ── handlers ──
  function cur() {
    const x = a().intent;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id && x.board ? { x: x, gd: gd } : null;
  }

  G.handlers.click['intent-open'] = function () {
    const c = cur();
    if (!c) return;
    G.ui.openDialog(openDialogHtml(c.gd, c.x.board), { labelledBy: 'dlg-title' });
  };

  G.handlers.submit['intent-open-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const title = String(form.elements.title.value || '').trim();
    if (!title) { G.ui.setText('dlg-err-title', 'Give the round a title.'); return; }
    const body = { title: title };
    if (form.elements.closesOn.value) body.closesOn = form.elements.closesOn.value;
    G.ui.runDialog(form, G.api.intent.open(c.x.gid, c.x.teamId, body), function (board) {
      c.x.viewRound = null;
      setBoard(c.x, board);
      c.x.note = 'The round is open.';
      G.app.render();
    });
  };

  G.handlers.click['intent-close'] = function () {
    const c = cur();
    if (!c || !c.x.board.round) return;
    G.ui.openDialog(closeDialogHtml(c.x.board), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['intent-close-form'] = function (form) {
    const c = cur();
    if (!c || !c.x.board.round) return;
    G.ui.runDialog(form, G.api.intent.close(c.x.gid, c.x.board.round.id), function (board) {
      setBoard(c.x, board);
      c.x.note = 'The round is closed.';
      G.app.render();
    });
  };

  G.handlers.change['intent-round'] = function (sel) {
    const c = cur();
    if (!c) return;
    c.x.viewRound = sel.value || null;
    G.api.intent.get(c.x.gid, c.x.teamId, c.x.viewRound).then(function (board) {
      setBoard(c.x, board);
      c.x.note = '';
      G.app.render();
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  };

  G.handlers.click['intent-edit'] = function (el) {
    const c = cur();
    if (!c || !c.x.board.round || c.x.board.round.status !== 'open') return;
    const pid = el.getAttribute('data-pid');
    const board = c.x.board;
    const mine = pid === board.myPersonId;
    const own = board.picks.filter(function (p) { return p.personId === pid; });
    const person = { id: pid, name: (own[0] && own[0].name) || (board.undecided.filter(function (u) { return u.personId === pid; })[0] || {}).name || 'this person' };
    const picks = { main: own.filter(function (p) { return p.kind === 'main'; })[0] || null, alt: own.filter(function (p) { return p.kind === 'alt'; })[0] || null };
    G.ui.openDialog(pickDialogHtml(c.gd, board, person, picks, mine), { labelledBy: 'dlg-title' });
  };

  // A class change fills the spec list of its own fieldset; a spec change shows what it counts as.
  G.handlers.change['intent-class'] = function (sel) {
    const c = cur();
    const form = sel.closest ? sel.closest('form') : null;
    if (!c || !form) return;
    const prefix = sel.getAttribute('data-prefix');
    const specSel = form.elements[prefix + 'Spec'];
    if (specSel) specSel.innerHTML = G.ui.specOptionsHtml(G.ui.rosterOptions(c.gd), sel.value, '', 'Choose a spec');
    G.ui.announce('ip-' + prefix + '-role', '');
  };
  G.handlers.change['intent-spec'] = function (sel) {
    const c = cur();
    const form = sel.closest ? sel.closest('form') : null;
    if (!c || !form) return;
    const prefix = sel.getAttribute('data-prefix');
    G.ui.announce('ip-' + prefix + '-role', roleText(c.x.board, form.elements[prefix + 'Class'].value, sel.value));
  };

  // The form's four fields per kind -> the calls that make the board match: set main, set / clear alt, or clear everything.
  function savePicks(c, pid, v) {
    const had = c.x.board.picks.filter(function (p) { return p.personId === pid; });
    const hadMain = had.some(function (p) { return p.kind === 'main'; });
    const hadAlt = had.some(function (p) { return p.kind === 'alt'; });
    const iid = c.x.board.round.id;
    const gid = c.x.gid;
    const body = function (kind) { return { kind: kind, class: v[kind + 'Class'], spec: v[kind + 'Spec'], note: v[kind + 'Note'] || null }; };
    let chain = Promise.resolve(null);
    if (v.mainClass) chain = chain.then(function () { return G.api.intent.pick(gid, iid, pid, body('main')); });
    else if (hadMain) chain = chain.then(function () { return G.api.intent.unpick(gid, iid, pid, 'main'); });
    if (v.mainClass && v.altClass) chain = chain.then(function () { return G.api.intent.pick(gid, iid, pid, body('alt')); });
    else if (v.mainClass && hadAlt) chain = chain.then(function () { return G.api.intent.unpick(gid, iid, pid, 'alt'); });
    return chain;
  }

  function readPickForm(form) {
    const v = {};
    ['main', 'alt'].forEach(function (k) {
      v[k + 'Class'] = form.elements[k + 'Class'].value;
      v[k + 'Spec'] = form.elements[k + 'Spec'].value;
      v[k + 'Note'] = String(form.elements[k + 'Note'].value || '').trim();
    });
    return v;
  }

  G.handlers.submit['intent-pick-form'] = function (form) {
    const c = cur();
    if (!c || !c.x.board.round) return;
    const v = readPickForm(form);
    if (v.mainClass && !v.mainSpec) { G.ui.setText('dlg-err-mainSpec', 'Choose a spec.'); return; }
    if (v.altClass && !v.altSpec) { G.ui.setText('dlg-err-altSpec', 'Choose a spec.'); return; }
    if (!v.mainClass && v.altClass) { G.ui.setText('dlg-error', 'Pick a main before an alt.'); return; }
    if (Array.from(v.mainNote).length > NOTE_MAX || Array.from(v.altNote).length > NOTE_MAX) { G.ui.setText('dlg-error', 'A note is at most ' + NOTE_MAX + ' characters.'); return; }
    G.ui.runDialog(form, savePicks(c, form.getAttribute('data-pid'), v), function (board) {
      if (board) setBoard(c.x, board);
      c.x.note = 'Saved.';
      G.app.render();
    });
  };

  G.pages.intent = {
    ROLE_LABELS: ROLE_LABELS, defaultTitle: defaultTitle, specsOf: specsOf, load: load, main: main, intentHtml: intentHtml,
    openDialogHtml: openDialogHtml, pickDialogHtml: pickDialogHtml, savePicks: savePicks, makeState: makeState,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
