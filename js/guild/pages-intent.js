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
    let keep = prev && prev.gid === gid && prev.teamId === teamId && prev.viewRound ? prev.viewRound : null;
    const board = G.api.intent.get(gid, teamId, keep).then(null, function (err) {
      if (keep && err && err.status === 404) return G.api.intent.get(gid, teamId, null).then(function (b) { keep = null; return b; });
      throw err;
    });
    // The Launch readiness panel's numbers, only for a team that follows a launch; a failed read just leaves the panel out.
    const launch = launchOn(gd, teamId) ? G.api.launch.get(gid, teamId).then(null, function () { return null; }) : Promise.resolve(null);
    return Promise.all([board, launch]).then(function (res) {
      const prev2 = prev && prev.gid === gid && prev.teamId === teamId ? prev : null;
      a().intent = makeState(gid, teamId, res[0], keep);
      a().intent.launch = res[1];
      a().intent.showCov = !!(prev2 && prev2.showCov);
      return null;
    });
  }

  // Whether the Launch readiness panel can show for the team: a WoW Forever guild always, any other guild for a team marked as a launch team.
  function launchOn(gd, teamId) {
    if (!gd || !gd.guild) return false;
    if (gd.guild.gameVersion === 'forever') return true;
    return (gd.teams || []).some(function (t) { return t && t.id === teamId && t.launchTeam === true && !t.archived; });
  }

  function makeState(gid, teamId, board, viewRound) {
    const x = { gid: gid, teamId: teamId, board: board, viewRound: viewRound, note: '', busy: false, launch: null, showCov: false };
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
  function myMainPick(board) {
    return board.picks.filter(function (p) { return p.mine && p.kind === 'main'; })[0] || null;
  }

  // "Opened Oct 18, closes Oct 25 - 7 of 23 picked - Your pick: Mage Fire" (the last part for people who can pick).
  function roundLine(board) {
    const r = board.round;
    const mains = mainPicks(board).length;
    const total = mains + board.undecided.length;
    const parts = ['Opened ' + G.ui.formatDate(r.createdAt) + (r.status === 'closed' && r.closedAt ? ', closed ' + G.ui.formatDate(r.closedAt) : (r.closesOn ? ', closes ' + G.ui.formatDay(r.closesOn) : ''))];
    parts.push(r.status === 'open' && total > mains ? mains + ' of ' + total + ' picked' : plural(mains, 'main pick', 'main picks'));
    if (board.canPick) {
      const mine = myMainPick(board);
      parts.push('Your pick: ' + (mine ? G.ui.className(mine.class) + ' ' + mine.spec : 'not set'));
    }
    return parts.join(' - ');
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

  function tilesHtml(board) {
    const t = board.totals;
    return '<div class="gs-sp-tiles" role="group" aria-label="Main picks against the targets">' + ROLE_ORDER.map(function (role) {
      const want = board.targets ? board.targets[role] : null;
      const have = t.byRole[role] || 0;
      const diff = want === null ? '' : (have < want ? 'Need ' + (want - have) : have > want ? (have - want) + ' over' : 'Full');
      return '<div class="gs-sp-tile"><span class="gs-fg-gh">' + esc(ROLE_LABELS[role]) + '</span><span class="gs-sp-tilerow"><span class="gs-sp-num">' + esc(have) +
        (want === null ? '' : '<span class="gs-sp-den"> / ' + esc(want) + '</span>') + '</span><span class="gs-fg-mut">' + esc(diff) + '</span></span></div>';
    }).join('') + '</div>';
  }

  function coverageLineHtml(x) {
    const cov = x.cov;
    if (!cov || !cov.seated) return '';
    const s = G.coverage.summary(cov);
    return '<p class="gs-fg-mut">Picks cover ' + esc(s.buffs + ' of ' + s.buffsTotal + ' buffs and ' + s.debuffs + ' of ' + s.debuffsTotal + ' debuffs') + '. ' +
      '<button type="button" class="gs-fg-linkbtn" data-action="intent-cov" data-key="intent-cov" aria-expanded="' + (x.showCov ? 'true' : 'false') + '" aria-controls="intent-cov">' + (x.showCov ? 'Hide coverage' : 'See coverage') + '</button></p>';
  }

  // The round panel: title and state, the one primary (Set my pick), Close round, the picks against the targets and a coverage line.
  function roundHtml(board, x) {
    const r = board.round;
    const open = r.status === 'open';
    const acts = [];
    if (board.canPick) acts.push('<button type="button" class="gs-btn gs-btn-molten" data-action="intent-edit" data-pid="' + esc(board.myPersonId) + '" data-key="intent-mine">' + (myMainPick(board) ? 'Change my pick' : 'Set my pick') + '</button>');
    if (board.canEdit && open) acts.push('<button type="button" class="gs-btn gs-btn-ghost gs-sp-close" data-action="intent-close" data-key="intent-close">Close round</button>');
    if (board.canEdit && !open && !board.team.archived && !board.rounds.some(function (e) { return e.status === 'open'; })) acts.push('<button type="button" class="gs-btn" data-action="intent-open" data-key="intent-open">Open a new round</button>');
    return '<section class="gs-hd-panel gs-sp-round" aria-labelledby="intent-h"><div class="gs-sp-top"><div class="gs-sp-title"><div class="gs-sp-h"><h2 class="gs-rc-h2 gs-sp-h2" id="intent-h">' + esc(r.title) + '</h2>' +
      '<span class="gs-hd-chip is-' + (open ? 'green' : 'grey') + '">' + (open ? 'Open' : 'Closed') + '</span></div><p class="gs-sp-sub">' + esc(roundLine(board)) + '</p>' +
      (open && !board.canPick && !board.canEdit ? '<p class="gs-fg-mut">Only people on this team can pick. Ask an officer if you should be here.</p>' : '') + '</div>' +
      (acts.length ? '<div class="gs-sp-acts">' + acts.join('') + '</div>' : '') + '</div>' + historyHtml(board) + tilesHtml(board) + coverageLineHtml(x) + '</section>';
  }

  function picksByRoleHtml(board) {
    const open = board.round.status === 'open';
    const editCol = board.canEdit && open;
    const alts = {};
    board.picks.forEach(function (p) { if (p.kind === 'alt') alts[p.personId] = p; });
    const cols = ROLE_ORDER.map(function (role) {
      const picks = mainPicks(board).filter(function (p) { return p.role === role; }).sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });
      const want = board.targets ? board.targets[role] : null;
      const rows = picks.map(function (p) {
        const alt = alts[p.personId];
        return '<div class="gs-rs-row gs-sp-row">' + G.ui.specIconHtml(p.class, p.spec, 20) + '<span class="gs-rs-id"><span class="gs-rs-name ' + esc(G.ui.classClass(p.class)) + '">' + esc(p.name) + (p.mine ? ' <span class="gs-rs-alt">(you)</span>' : '') + '</span>' +
          '<span class="gs-rs-sub"><span class="gs-rs-spec">' + esc(p.spec) + '</span>' + (alt ? '<span class="gs-rs-alt" title="' + esc(G.ui.className(alt.class) + ' ' + alt.spec) + '">1 alt</span>' : '') + '</span>' +
          (p.note ? '<span class="gs-rs-alt gs-sp-note">' + esc(p.note) + '</span>' : '') + '</span>' +
          (editCol ? '<button type="button" class="gs-btn gs-btn-ghost gs-sp-change" data-action="intent-edit" data-pid="' + esc(p.personId) + '" data-key="intent-edit-' + esc(p.personId) + '" aria-label="Change the pick of ' + esc(p.name) + '">Change</button>' : '') + '</div>';
      }).join('');
      return '<div class="gs-hd-panel gs-rs-col"><h3 class="gs-rs-colhead gs-fg-gh">' + esc(ROLE_LABELS[role]) + ' <b>' + picks.length + '</b>' + (want === null ? '' : '<span class="gs-rs-den">/ ' + esc(want) + '</span>') + '</h3>' +
        (rows || '<p class="gs-rs-none">Nobody yet</p>') + '</div>';
    }).join('');
    return '<section aria-label="Picks" class="gs-sp-picks"><h2 class="gs-hd-sl">Picks by role</h2><div class="gs-rs-cols gs-sp-cols">' + cols + '</div></section>';
  }

  function notPickedHtml(board) {
    const open = board.round.status === 'open';
    const list = board.undecided;
    if (!open || !list.length) return '';
    const names = list.map(function (u) {
      const name = G.ui.classNameHtml(u.name, u.class);
      return board.canEdit
        ? '<li><button type="button" class="gs-fg-linkbtn gs-sp-name" data-action="intent-edit" data-pid="' + esc(u.personId) + '" data-key="intent-edit-' + esc(u.personId) + '" aria-label="Set the pick of ' + esc(u.name) + '">' + name + '</button></li>'
        : '<li>' + name + '</li>';
    }).join('');
    return '<section aria-label="Not picked yet" class="gs-sp-undecided"><h2 class="gs-hd-sl">Not picked yet <b>' + esc(list.length) + '</b></h2><ul class="gs-intent-undecided">' + names + '</ul></section>';
  }

  // The Launch readiness panel (the team follows a launch): the four stages as counts and the way to the launch list.
  function launchHtml(gd, x) {
    const d = x.launch;
    if (!d || !d.enabled || !d.totals) return '';
    const t = d.totals;
    const people = t.people || 0;
    const steps = [['Picked', 'intent'], ['Character made', 'character'], ['Level band', 'level'], ['Ready', 'ready']].map(function (s, i) {
      return '<li class="gs-sp-step">' + (i ? '<span class="gs-sp-chev" aria-hidden="true">' + G.icons.icon('arrow', 18) + '</span>' : '') + '<span class="gs-sp-stepbody"><span class="gs-fg-gh">' + esc(s[0]) + '</span>' +
        '<span class="gs-sp-stepnum">' + esc(t.stages[s[1]] || 0) + '<span class="gs-sp-stepden"> / ' + esc(people) + '</span></span></span></li>';
    }).join('');
    return '<section aria-label="Launch readiness" class="gs-sp-launch"><h2 class="gs-hd-sl">Launch readiness</h2><div class="gs-hd-panel gs-sp-launchbox"><ol class="gs-sp-steps">' + steps + '</ol>' +
      '<a class="gs-btn" href="' + esc(G.router.format({ name: 'launch', gid: gd.guild.id })) + '" data-key="intent-launch">Open launch list</a></div></section>';
  }

  // opts: { guildData, state: a().intent, alert }
  function intentHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const board = x.board;
    const head = G.pages.rosterTabs.headHtml(gd, 'intent', board.team.name);
    const alert = G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '');
    if (!board.round) return '<div class="gs-page gs-forge gs-sp-page">' + head + alert + emptyHtml(board, gd) + launchHtml(gd, x) + '</div>';
    return '<div class="gs-page gs-forge gs-sp-page">' + head + alert + roundHtml(board, x) +
      (x.showCov ? '<div id="intent-cov">' + G.coverage.panelHtml(x.cov, { id: 'intent-cov-panel', heading: 'Buffs and debuffs of the planned raid', intro: 'What the main picks would cover.' }) + '</div>' : '') +
      picksByRoleHtml(board) + notPickedHtml(board) + launchHtml(gd, x) + '</div>';
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

  G.handlers.click['intent-cov'] = function () {
    const c = cur();
    if (!c) return;
    c.x.showCov = !c.x.showCov;
    G.app.render();
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
