// ── PAGE: REVIEW QUEUE (+ the Decide and Unmatched dialogs the raid page shares) ──
// Flags grouped by raid, each a compact row with Decide (no show, late, left early) or the two unmatched actions
// (link the character as a new Alt, or mark it a guest). GET /attendance/review?team= . Loot winners nobody on the roster
// matches get a group per raid of their own ("Loot winners not on the roster"), with the same three actions; the review
// reply carries them as lootUnmatched: [{ raid: { id, raidOn, zone }, items: [{ kind: 'unmatched', key, name, realm, class,
// awards }] }] (empty unless the viewer has loot.edit on the team). A name whose class nobody knows makes the Link and Add dialogs ask
// for it (a required select, sent as `class` with the unmatched action). A decision is
// POST /raids/:rid/decisions with the flags the officer saw (expectedFlags): a 409 flags_changed reloads the data.
// The same page also carries the "Character claims" group (Battle.net, Phase 5): members' requests that a character is theirs, each
// with what approving it does; Approve and Reject go to /claims/:id/approve and /reject. GET /claims needs roster.edit.
(function (G) {
  'use strict';

  const LATE_TYPES = ['late', 'left_early', 'late_left'];
  const REASON_MIN = 3;
  const REASON_MAX = 200;
  const FILTERS = [
    { value: 'all', label: 'All flags' }, { value: 'no_show', label: 'No shows' },
    { value: 'late', label: 'Late or left early' }, { value: 'unmatched', label: 'Unmatched characters' },
    { value: 'loot', label: 'Loot winners' },
  ];

  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }
  function isUnmatched(item) { return !!item && !item.playerId && typeof item.key === 'string'; }
  function raidHref(gid, rid) { return G.router.format({ name: 'raid', gid: gid, rid: rid }); }

  // ── decide: options per flag (spec: Consolidation, officer decisions) ──
  function lateOutcomeFor(flags) {
    const late = flags.indexOf('late') >= 0;
    const left = flags.indexOf('left_early') >= 0;
    return late && left ? 'late_left' : late ? 'late' : 'left_early';
  }

  function decideOptions(row) {
    const flags = Array.isArray(row && row.flags) ? row.flags : [];
    if (flags.indexOf('no_show') >= 0) return ['missed', 'missed_notice', 'bench', 'present'];
    if (flags.indexOf('late') >= 0 || flags.indexOf('left_early') >= 0) return [lateOutcomeFor(flags), 'present'];
    return ['present', 'bench', 'missed', 'missed_notice'];
  }

  function needsCredit(outcome) { return LATE_TYPES.indexOf(outcome) >= 0; }

  function creditValuesOf(policyView, teamId) {
    const r = policyView && policyView.resolved && policyView.resolved[teamId];
    const v = r && r.credit && Array.isArray(r.credit.values) ? r.credit.values : null;
    return v && v.length ? v : A().DEFAULT_CREDITS;
  }

  // "In 8 of 17 pulls; missed the first pull." / "Signed up, not in the log."
  function evidenceText(row) {
    if (!row) return '';
    const p = row.pulls || {};
    const flags = Array.isArray(row.flags) ? row.flags : [];
    const parts = [];
    if (flags.indexOf('no_show') >= 0) {
      const kind = row.signup && row.signup !== 'signed' ? ' (' + (A().KIND_LABELS[row.signup] || row.signup).toLowerCase() + ')' : '';
      parts.push((row.signup ? 'Signed up' + kind : 'Expected') + ', not in the log');
    } else if (p.total > 0) {
      parts.push('In ' + p.present + ' of ' + p.total + ' pulls');
      if (p.missedFirst) parts.push('missed the first pull');
      if (p.missedLast) parts.push('missed the last pull');
    }
    return parts.join('; ');
  }

  function unmatchedEvidence(u) {
    const cls = u.class ? G.ui.className(u.class) + (u.realm ? ' on ' + u.realm : '') : (u.realm || '');
    const pulls = typeof u.pullsPresent === 'number' ? 'in ' + plural(u.pullsPresent, 'pull', 'pulls') : (typeof u.awards === 'number' ? 'won ' + plural(u.awards, 'item', 'items') : '');
    return [cls, pulls, 'no linked person'].filter(Boolean).join(', ');
  }

  // opts: { raid: {id, raidOn}, row, credits: [{id,label,value}], where: 'raid'|'review' }
  function decideDialogHtml(opts) {
    const row = opts.row;
    const options = decideOptions(row);
    const first = options[0];
    const credits = opts.credits || A().DEFAULT_CREDITS;
    const raidLabel = G.ui.weekdayDay(opts.raid && opts.raid.raidOn) || '';
    const undo = row.decision
      ? '<form class="gs-dialog-form gs-dialog-sub" data-submit="undo-decision-form" data-rid="' + esc(opts.raid.id) + '" data-pid="' + esc(row.playerId) + '" data-where="' + esc(opts.where) + '" novalidate>' +
        '<h3 class="gs-h3">Undo the earlier decision</h3>' + (row.decision.reason ? '<p class="gs-fine">Decided: ' + esc(row.decision.reason) + (row.decision.by ? ' (' + esc(row.decision.by) + ')' : '') + '</p>' : '') +
        '<div class="gs-field"><label class="gs-label" for="undo-reason">Reason (required)</label><input class="gs-input" type="text" id="undo-reason" name="reason" maxlength="' + REASON_MAX + '" autocomplete="off">' +
        '<p class="gs-field-error" id="undo-err" role="alert" hidden></p></div>' +
        '<div class="gs-dialog-actions"><button type="submit" class="gs-btn">Undo decision</button></div></form>' : '';
    return '<form class="gs-dialog-form" data-submit="decide-form" data-rid="' + esc(opts.raid.id) + '" data-pid="' + esc(row.playerId) + '" data-where="' + esc(opts.where) + '" data-flags="' + esc(JSON.stringify(row.flags || [])) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Decide: ' + esc(row.name) + '</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(raidLabel) + '. ' + esc(evidenceText(row)) + '</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-outcome">Outcome</label><select class="gs-input" id="dlg-outcome" name="outcome" data-change="decide-outcome">' +
      G.ui.optionsHtml(options.map(function (o) { return { value: o, label: A().labelOf(o) }; }), first) + '</select></div>' +
      '<div class="gs-field" id="dlg-credit-field"' + (needsCredit(first) ? '' : ' hidden') + '><label class="gs-label" for="dlg-credit">Credit</label><select class="gs-input" id="dlg-credit" name="creditId">' +
      G.ui.optionsHtml(credits.map(function (c) { return { value: c.id, label: c.label + ' ' + Math.round(c.value * 100) + '%' }; }), credits[0].id) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-reason">Reason (required)</label><textarea class="gs-input gs-textarea" id="dlg-reason" name="reason" rows="2" maxlength="' + REASON_MAX + '" data-field="reason"></textarea>' +
      '<p class="gs-field-error" id="dlg-err-reason" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save decision</button></div></form>' + undo;
  }

  // A loot winner can come without a class (Gargul only guesses it, and the log may not hold the name): the character cannot be
  // created without one, so these dialogs ask. Nothing is shown when the entry already carries a class. gd: the guild data (class list).
  function classFieldHtml(u, gd) {
    if (u.class) return '';
    return '<div class="gs-field"><label class="gs-label" for="unm-class">Class (required)</label><select class="gs-input" id="unm-class" name="class" data-field="class" aria-describedby="unm-class-help">' +
      G.ui.classOptionsHtml(G.ui.rosterOptions(gd), '', 'Pick a class') + '</select>' +
      '<p class="gs-fine" id="unm-class-help">Neither the loot nor the log says which class ' + esc(u.name) + ' plays.</p>' +
      '<p class="gs-field-error" id="dlg-err-class" role="alert" hidden></p></div>';
  }

  // The class the officer picked in a dialog that asks for one: { missing } when the select is there but empty, { value } otherwise
  // (null when the dialog has no class field, because the entry's class is known).
  function classChoice(form) {
    const select = form.elements && form.elements['class'];
    if (!select) return { missing: false, value: null };
    const value = String(select.value || '');
    return value ? { missing: false, value: value } : { missing: true, value: null };
  }

  // people: the roster rows of the raid's team (GET /roster?team=); unm: the unmatched entry; guildData: for the class list.
  function linkDialogHtml(opts) {
    const u = opts.unm;
    const people = Array.isArray(opts.people) ? opts.people : [];
    const list = people.map(function (p) {
      const shown = p.shown || {};
      const main = p.main || {};
      const name = main.name || shown.name || '';
      return '<li class="gs-pick-item" data-name="' + esc(String(name).toLowerCase()) + '"><div class="gs-check"><input type="radio" name="personId" id="pick-' + esc(p.id) + '" value="' + esc(p.id) + '" data-person-name="' + esc(name) + '"><label for="pick-' + esc(p.id) + '">' +
        G.ui.classNameHtml(name, main.class || shown.class) + ' <span class="gs-fine">' + esc(G.ui.statusLabel(p.status)) + (main.class ? ' &middot; ' + esc(G.ui.className(main.class)) : '') + '</span></label></div></li>';
    }).join('');
    return '<form class="gs-dialog-form" data-submit="unm-link-form" data-rid="' + esc(opts.raidId) + '" data-key="' + esc(u.key) + '" data-name="' + esc(u.name) + '" data-where="' + esc(opts.where) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Link ' + esc(u.name) + ' to a person</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(unmatchedEvidence(u)) + '. Pick the person this character belongs to; it is added to their record as an Alt, or as their Main.</p>' +
      classFieldHtml(u, opts.guildData) +
      '<div class="gs-field"><label class="gs-label" for="unm-search">Search people</label><input class="gs-input" type="search" id="unm-search" data-input="unm-search" autocomplete="off"></div>' +
      '<ul class="gs-pick-list" aria-label="People">' + (list || '<li class="gs-fine">No one on this roster yet.</li>') + '</ul>' +
      '<p class="gs-field-error" id="dlg-err-personId" role="alert" hidden></p>' +
      '<div class="gs-field"><div class="gs-check"><input type="checkbox" id="unm-make-main" name="makeMain" data-change="unm-make-main"><label for="unm-make-main">Make this their Main (their current Main becomes an Alt)</label></div></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="unm-link-submit">Add as Alt</button></div></form>';
  }

  // opts: { unm, raidId, raidOn, where, guildData }
  function personDialogHtml(opts) {
    const u = opts.unm;
    const statuses = ['raider', 'trial', 'reserve'].map(function (s) { return { value: s, label: G.ui.statusLabel(s) }; });
    return '<form class="gs-dialog-form" data-submit="unm-person-form" data-rid="' + esc(opts.raidId) + '" data-key="' + esc(u.key) + '" data-name="' + esc(u.name) + '" data-where="' + esc(opts.where) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Add ' + esc(u.name) + ' as a new person</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(unmatchedEvidence(u)) + '. They are added to the roster with this character as their Main.</p>' +
      classFieldHtml(u, opts.guildData) +
      '<div class="gs-field"><label class="gs-label" for="unm-status">Status</label><select class="gs-input" id="unm-status" name="status">' + G.ui.optionsHtml(statuses, 'raider') + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="unm-joined">Joined</label><input class="gs-input" type="date" id="unm-joined" name="joinedOn" value="' + esc(opts.raidOn || '') + '">' +
      '<p class="gs-field-error" id="dlg-err-joinedOn" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Add person</button></div></form>';
  }

  function guestDialogHtml(opts) {
    const u = opts.unm;
    return '<form class="gs-dialog-form" data-submit="unm-guest-form" data-rid="' + esc(opts.raidId) + '" data-key="' + esc(u.key) + '" data-name="' + esc(u.name) + '" data-where="' + esc(opts.where) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Mark ' + esc(u.name) + ' as a guest</h2>' +
      '<p class="gs-fine" id="dlg-text">Guests are ignored in attendance and in the loot balance on every raid, now and later. ' + esc(unmatchedEvidence(u)) + '.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Mark as guest</button></div></form>';
  }

  // ── review page ──
  function flagKind(item) {
    if (isUnmatched(item)) return 'unmatched';
    const flags = item.flags || [];
    return flags.indexOf('no_show') >= 0 ? 'no_show' : 'late';
  }

  function itemActionsHtml(raidId, item, where) {
    if (isUnmatched(item)) {
      return '<button type="button" class="gs-btn gs-btn-sm" data-action="unm-link" data-rid="' + esc(raidId) + '" data-ukey="' + esc(item.key) + '" data-where="' + esc(where) + '" data-key="unm-link-' + esc(raidId + item.key) + '">Link to person...</button>' +
        '<button type="button" class="gs-btn gs-btn-sm" data-action="unm-person" data-rid="' + esc(raidId) + '" data-ukey="' + esc(item.key) + '" data-where="' + esc(where) + '" data-key="unm-person-' + esc(raidId + item.key) + '">Add as new person...</button>' +
        '<button type="button" class="gs-btn gs-btn-sm" data-action="unm-guest" data-rid="' + esc(raidId) + '" data-ukey="' + esc(item.key) + '" data-where="' + esc(where) + '" data-key="unm-guest-' + esc(raidId + item.key) + '">Mark as guest</button>';
    }
    return '<button type="button" class="gs-btn gs-btn-sm" data-action="decide-open" data-rid="' + esc(raidId) + '" data-pid="' + esc(item.playerId) + '" data-where="' + esc(where) + '" data-key="decide-' + esc(raidId + item.playerId) + '">Decide</button>';
  }

  function itemHtml(gid, raidId, item) {
    if (isUnmatched(item)) {
      return '<li class="gs-review-item"><div class="gs-review-who">' + G.ui.classNameHtml(item.name, item.class) + A().flagChipsHtml(['unmatched']) +
        '<span class="gs-char-sub">' + esc(unmatchedEvidence(item)) + '</span></div><div class="gs-row-actions">' + itemActionsHtml(raidId, item, 'review') + '</div></li>';
    }
    return '<li class="gs-review-item"><div class="gs-review-who"><a class="gs-char-link ' + G.ui.classClass(item.class) + '" href="' + esc(G.router.format({ name: 'personatt', gid: gid, pid: item.playerId })) + '">' + esc(item.name) + '</a>' + A().flagChipsHtml(item.flags) +
      '<span class="gs-char-sub">' + esc(evidenceText(item)) + '</span></div><div class="gs-row-actions">' + itemActionsHtml(raidId, item, 'review') + '</div></li>';
  }

  function noteHtml(note) {
    return note ? '<div class="gs-notice" role="status"><span>' + esc(note) + '</span><button type="button" class="gs-linkbtn" data-action="att-note-dismiss" data-key="att-note-dismiss">Dismiss</button></div>' : '';
  }

  function lootGroupHtml(gid, g) {
    const r = g.raid || {};
    return '<section class="gs-card-sec" aria-labelledby="rvl-' + esc(r.id) + '"><div class="gs-card-sec-head"><h2 class="gs-h2" id="rvl-' + esc(r.id) + '">' + esc(G.ui.weekdayDay(r.raidOn) || '') + ' - Loot winners not on the roster</h2>' +
      '<span class="gs-head-tools"><span class="gs-fine">' + esc(plural(g.items.length, 'winner', 'winners')) + '</span><a class="gs-btn gs-btn-sm" href="' + esc(raidHref(gid, r.id)) + '">Open raid</a></span></div>' +
      '<ul class="gs-review-list">' + g.items.map(function (u) {
        return '<li class="gs-review-item"><div class="gs-review-who">' + G.ui.classNameHtml(u.name, u.class) + A().flagChipsHtml(['unmatched']) + '<span class="gs-char-sub">' + esc(unmatchedEvidence(u)) + '</span></div>' +
          '<div class="gs-row-actions">' + itemActionsHtml(r.id, u, 'review') + '</div></li>';
      }).join('') + '</ul></section>';
  }

  // ── character claims (Battle.net) ──
  const CLAIM_STATUSES = ['raider', 'trial', 'reserve'];

  function claimWords(claim) {
    const c = claim.character || {};
    const who = claim.claimant && claim.claimant.displayName ? claim.claimant.displayName : 'The member';
    const plan = claim.plan || {};
    const person = plan.person && plan.person.name ? plan.person.name : '';
    if (plan.kind === 'add_alt') return 'Approving adds ' + c.name + ' to ' + person + '\'s record as an Alt.';
    if (plan.kind === 'new_person') return 'Approving creates a new person with ' + c.name + ' as their Main, linked to ' + who + '\'s Discord account.';
    if (plan.kind === 'link_person') return c.name + ' is already on the roster on ' + person + '\'s record. Approving links ' + who + '\'s Discord account to ' + person + '.';
    if (plan.kind === 'already') return c.name + ' is already on ' + who + '\'s record. Approving only closes the claim.';
    return plan.message || 'This claim cannot be approved.';
  }

  function claimTeams(gd) {
    return G.shell.activeTeams(gd.teams).filter(function (t) { return G.shell.allowsTeam(gd.me && gd.me.can, 'roster.edit', t.id); });
  }

  function claimFormHtml(gd, claim) {
    const plan = claim.plan || {};
    const id = esc(claim.id);
    const reject = '<button type="button" class="gs-btn gs-btn-sm" data-action="claim-reject" data-claim="' + id + '" data-key="claim-reject-' + id + '" aria-label="Reject the claim on ' + esc(claim.character.name) + '">Reject</button>';
    if (plan.kind === 'blocked') return '<div class="gs-row-actions">' + reject + '</div>';
    if (!plan.canDecide) return '<div class="gs-row-actions"><span class="gs-fine">Another team\'s lead decides this one</span>' + reject + '</div>';
    const teams = claimTeams(gd);
    const needsTeam = plan.kind === 'add_alt' || plan.kind === 'new_person';
    const wanted = plan.defaultTeamId && teams.some(function (t) { return t.id === plan.defaultTeamId; }) ? plan.defaultTeamId : (teams[0] ? teams[0].id : '');
    const teamField = needsTeam
      ? '<label class="gs-sr" for="claim-team-' + id + '">Team for ' + esc(claim.character.name) + '</label><select class="gs-input gs-input-sm" id="claim-team-' + id + '" name="teamId" data-key="claim-team-' + id + '">' +
        G.ui.optionsHtml(teams.map(function (t) { return { value: t.id, label: t.name }; }), wanted) + '</select>'
      : '';
    const statusField = plan.kind === 'new_person'
      ? '<label class="gs-sr" for="claim-status-' + id + '">Starting status for ' + esc(claim.character.name) + '</label><select class="gs-input gs-input-sm" id="claim-status-' + id + '" name="status" data-key="claim-status-' + id + '">' +
        G.ui.optionsHtml(CLAIM_STATUSES.map(function (v) { return { value: v, label: G.ui.statusLabel(v) }; }), 'trial') + '</select>'
      : '';
    return '<form class="gs-cclaim-form" data-submit="claim-approve" data-claim="' + id + '" data-kind="' + esc(plan.kind) + '" novalidate>' + teamField + statusField +
      '<button type="submit" class="gs-btn gs-btn-sm gs-btn-molten" data-key="claim-approve-' + id + '" aria-label="Approve the claim on ' + esc(claim.character.name) + '">Approve</button>' + reject + '</form>';
  }

  function claimItemHtml(gd, claim) {
    const c = claim.character || {};
    const detail = [G.ui.className(c.class), c.level != null ? 'level ' + c.level : '', c.realm].filter(Boolean).join(', ');
    const by = claim.claimant && claim.claimant.displayName ? claim.claimant.displayName : 'A member';
    return '<li class="gs-review-item gs-cclaim-item"><div class="gs-review-who">' + G.ui.classNameHtml(c.name, c.class) +
      '<span class="gs-char-sub">' + esc(detail) + '</span>' +
      '<span class="gs-char-sub">Claimed by <strong>' + esc(by) + '</strong> ' + esc(G.ui.relativeTime(claim.claimedAt)) + '</span>' +
      '<span class="gs-char-sub gs-cclaim-plan' + (claim.plan && claim.plan.kind === 'blocked' ? ' is-blocked' : '') + '">' + esc(claimWords(claim)) + '</span></div>' +
      claimFormHtml(gd, claim) + '</li>';
  }

  // claims: GET /claims -> claims, or null when they could not be loaded.
  function claimsSectionHtml(gd, claims) {
    if (claims === null) return '<p class="gs-fine" id="claims-error">Character claims could not be loaded. Reload the page to try again.</p>';
    if (!claims || !claims.length) return '';
    return '<section class="gs-card-sec" id="claims-section" aria-labelledby="claims-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="claims-h">Character claims</h2>' +
      '<span class="gs-fine">' + esc(plural(claims.length, 'claim', 'claims')) + ' waiting</span></div>' +
      '<ul class="gs-review-list" aria-label="Character claims">' + claims.map(function (claim) { return claimItemHtml(gd, claim); }).join('') + '</ul></section>';
  }

  // opts: { guildData, teamId, data (GET /attendance/review), lootGroups: [{ raid, items }], filter, progress, alert, note,
  //         claims (GET /claims, null = not loaded, [] = none) }
  function reviewHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || { raids: [], stale: [] };
    const filter = opts.filter || 'all';
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const team = A().teamOf(gd, opts.teamId);
    const groups = filter === 'loot' ? [] : (Array.isArray(data.raids) ? data.raids : []).map(function (g) {
      return { raid: g.raid, items: (g.items || []).filter(function (i) { return filter === 'all' || flagKind(i) === filter; }) };
    }).filter(function (g) { return g.items.length; });
    const lootGroups = (Array.isArray(opts.lootGroups) ? opts.lootGroups : []).filter(function (g) { return g.items && g.items.length; });
    const shownLoot = filter === 'all' || filter === 'loot' ? lootGroups : [];
    const lootTotal = lootGroups.reduce(function (n, g) { return n + g.items.length; }, 0);
    const flagTotal = (data.raids || []).reduce(function (n, g) { return n + (g.items || []).length; }, 0);
    const total = flagTotal + lootTotal;
    const canEdit = G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', opts.teamId);
    const claims = Array.isArray(opts.claims) ? opts.claims : [];
    const sub = (several && team ? esc(team.name) + ' &middot; ' : '') + esc(plural(flagTotal, 'open flag', 'open flags')) + ' on ' + esc(plural((data.raids || []).length, 'raid', 'raids')) +
      (lootTotal ? ' &middot; ' + esc(plural(lootTotal, 'loot winner', 'loot winners')) + ' to link' : '') +
      (claims.length ? ' &middot; ' + esc(plural(claims.length, 'character claim', 'character claims')) : '');
    const filterField = total
      ? '<div class="gs-roster-status"><label class="gs-label" for="review-filter">Flag type</label><select class="gs-input" id="review-filter" data-change="review-filter" data-key="review-filter">' + G.ui.optionsHtml(FILTERS, filter) + '</select></div>' : '';
    let body;
    if (!total && claims.length) {
      body = '<p class="gs-empty" id="review-no-flags">No open attendance flags.</p>';
    } else if (!total) {
      body = '<section class="gs-empty-card" aria-labelledby="review-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('check', 28) + '</span><h2 class="gs-h2 gs-h2-lg" id="review-empty-h">Nothing to review</h2>' +
        '<p class="gs-lead gs-lead-sm">Every raid is reviewed. New flags show up here after a raid\'s log is added.</p></section>';
    } else if (!groups.length && !shownLoot.length) {
      body = '<p class="gs-empty">No flags of that type.</p>';
    } else {
      body = groups.map(function (g) {
        const r = g.raid || {};
        return '<section class="gs-card-sec" aria-labelledby="rv-' + esc(r.id) + '"><div class="gs-card-sec-head"><h2 class="gs-h2" id="rv-' + esc(r.id) + '">' + esc(G.ui.weekdayDay(r.raidOn) || '') + (r.zone ? ' - ' + esc(r.zone) : '') + '</h2>' +
          '<span class="gs-head-tools"><span class="gs-fine">' + esc(plural(g.items.length, 'flag', 'flags')) + '</span><a class="gs-btn gs-btn-sm" href="' + esc(raidHref(gid, r.id)) + '">Open raid</a></span></div>' +
          '<ul class="gs-review-list">' + g.items.map(function (i) { return itemHtml(gid, r.id, i); }).join('') + '</ul></section>';
      }).join('') + shownLoot.map(function (g) { return lootGroupHtml(gid, g); }).join('');
    }
    return '<div class="gs-page"><div class="gs-roster-head"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Review queue</h1><p class="gs-sub">' + sub + '</p></div>' + filterField + '</div>' +
      noteHtml(opts.note) + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + claimsSectionHtml(opts.guildData, opts.claims) + A().staleBannerHtml((data.stale || []).length, canEdit, opts.progress) + body + '</div>';
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    a().note = '';
    if (!teamId) { a().review = { gid: gid, teamId: null, data: null }; return null; }
    if (!G.shell.allowsTeam(gd.me && gd.me.can, 'attendance.review', teamId)) {
      return Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'The review queue is for the officers and team leads of this team.' }));
    }
    // The Character claims group needs roster.edit; a failure there must not take the attendance flags down with it (claims = null says so).
    const claims = G.shell.hasAction(gd.me && gd.me.can, 'roster.edit')
      ? G.api.get(A().apiBase(gid) + '/claims').then(function (res) { return Array.isArray(res && res.claims) ? res.claims : []; }, function () { return null; })
      : Promise.resolve([]);
    return Promise.all([G.api.get(A().apiBase(gid) + '/attendance/review?team=' + encodeURIComponent(teamId)), claims]).then(function (got) {
      const data = got[0];
      if (Array.isArray(got[1])) gd.pendingClaims = got[1].length; // the Attendance badge counts these: it is right again as soon as the queue is
      a().review = { gid: gid, teamId: teamId, data: data, claims: got[1], loot: Array.isArray(data && data.lootUnmatched) ? data.lootUnmatched : [], filter: a().review && a().review.gid === gid && a().review.teamId === teamId ? a().review.filter : 'all' };
      return null;
    });
  }

  function main(r, gd) {
    const x = a().review;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return reviewHtml({ guildData: gd, teamId: x.teamId, data: x.data, lootGroups: x.loot, filter: x.filter, progress: a().recalc, alert: st().pageAlert, note: a().note, claims: x.claims });
  }

  // ── behaviour shared by the review page and the raid page ──
  // Finds the row a Decide button belongs to: the raid page's people, or the review page's items.
  function findRow(where, rid, pid) {
    const s = a();
    if (where === 'raid') {
      const d = s.raid && s.raid.data;
      if (!d || !d.raid || d.raid.id !== rid) return null;
      const row = (d.people || []).filter(function (p) { return p.playerId === pid; })[0];
      return row ? { raid: d.raid, row: row } : null;
    }
    const rv = s.review && s.review.data;
    const g = rv ? (rv.raids || []).filter(function (x) { return x.raid && x.raid.id === rid; })[0] : null;
    const row = g ? (g.items || []).filter(function (i) { return i.playerId === pid; })[0] : null;
    return row ? { raid: g.raid, row: row } : null;
  }

  function findUnmatched(where, rid, key) {
    const s = a();
    if (where === 'raid') {
      const d = s.raid && s.raid.data;
      return d && d.raid && d.raid.id === rid ? (d.unmatched || []).filter(function (u) { return u.key === key; })[0] || null : null;
    }
    const rv = s.review && s.review.data;
    const g = rv ? (rv.raids || []).filter(function (x) { return x.raid && x.raid.id === rid; })[0] : null;
    const hit = g ? (g.items || []).filter(function (i) { return isUnmatched(i) && i.key === key; })[0] || null : null;
    if (hit) return hit;
    const lg = s.review ? (s.review.loot || []).filter(function (x) { return x.raid && x.raid.id === rid; })[0] : null;
    return lg ? (lg.items || []).filter(function (i) { return isUnmatched(i) && i.key === key; })[0] || null : null;
  }

  // The team the raid belongs to: the Worker creates the Alt on that team, so the people to pick from are that team's.
  function raidTeamOf(where, rid) {
    const s = a();
    if (where === 'raid') {
      const d = s.raid && s.raid.data;
      const r = d && d.raid && d.raid.id === rid ? d.raid : null;
      return r ? (r.teamId || idOf(r.team) || null) : null;
    }
    return s.review && s.review.teamId || null;
  }

  // The raid's date: a new person's Joined date starts there.
  function raidOnOf(where, rid) {
    const s = a();
    if (where === 'raid') {
      const d = s.raid && s.raid.data;
      return d && d.raid && d.raid.id === rid ? d.raid.raidOn || '' : '';
    }
    const rv = s.review && s.review.data;
    const g = rv ? (rv.raids || []).filter(function (x) { return x.raid && x.raid.id === rid; })[0] : null;
    const lg = !g && s.review ? (s.review.loot || []).filter(function (x) { return x.raid && x.raid.id === rid; })[0] : null;
    const hit = g || lg;
    return hit && hit.raid ? hit.raid.raidOn || '' : '';
  }

  function reloadReview() {
    const gd = currentGd();
    if (!gd) return Promise.resolve();
    // load() starts a page clean; the note the write just set (Approved, Rejected, ...) stays for the reload.
    const note = a().note;
    return load(null, gd).then(function () { a().note = note; G.app.render(); }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  // After a successful write: the raid page takes the new detail, the review page reloads its queue.
  function afterWrite(where, gid, res, note) {
    G.app.applyFlags(gid, res);
    a().note = note || '';
    st().pageAlert = '';
    if (where === 'raid') {
      const detail = res && res.raid && res.raid.raid ? res.raid : res;
      if (detail && detail.raid && a().raid) a().raid.data = detail;
      G.app.render();
      return;
    }
    reloadReview();
  }

  G.handlers.click['att-note-dismiss'] = function () { a().note = ''; G.app.render(); };
  G.handlers.change['review-filter'] = function (el) {
    if (a().review) a().review.filter = el.value;
    G.app.render();
  };

  G.handlers.click['decide-open'] = function (el) {
    const gd = currentGd();
    const where = el.getAttribute('data-where');
    const hit = findRow(where, el.getAttribute('data-rid'), el.getAttribute('data-pid'));
    if (!gd || !hit) return;
    const teamId = idOf(hit.raid.team) || G.app.teamFor(gd);
    A().loadPolicy(gd.guild.id).then(function (view) {
      G.ui.openDialog(decideDialogHtml({ raid: hit.raid, row: hit.row, credits: creditValuesOf(view, teamId), where: where }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const sel = document.getElementById('dlg-reason');
      if (sel) sel.focus();
    });
  };

  G.handlers.change['decide-outcome'] = function (el) {
    const field = document.getElementById('dlg-credit-field');
    if (field) field.hidden = !needsCredit(el.value);
  };

  // flags_changed means the row moved under the officer: treat it like a conflict (reload, say why).
  function asConflict(promise) {
    return promise.catch(function (err) {
      if (err && err.code === 'flags_changed') { err.code = 'conflict'; }
      throw err;
    });
  }

  function reasonOf(value) { return String(value == null ? '' : value).trim(); }

  G.handlers.submit['decide-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const where = form.getAttribute('data-where');
    const rid = form.getAttribute('data-rid');
    const outcome = form.elements.outcome.value;
    const reason = reasonOf(form.elements.reason.value);
    G.ui.setText('dlg-err-reason', '');
    G.ui.setText('dlg-error', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      G.ui.setText('dlg-err-reason', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.');
      form.elements.reason.focus();
      return;
    }
    const body = { playerId: form.getAttribute('data-pid'), outcome: outcome, reason: reason, expectedFlags: JSON.parse(form.getAttribute('data-flags') || '[]') };
    if (needsCredit(outcome)) body.creditId = form.elements.creditId.value;
    const onConflict = function (err) {
      a().note = '';
      st().pageAlert = (err && err.message) || 'This row changed while you were deciding. The page now shows the current state.';
      if (where === 'raid') { G.pages.raid.reload(); } else { reloadReview(); }
    };
    G.ui.runDialog(form, asConflict(G.api.post(A().apiBase(gid) + '/raids/' + encodeURIComponent(rid) + '/decisions', body)), function (res) {
      afterWrite(where, gid, res, 'Decision saved.');
    }, onConflict);
  };

  G.handlers.submit['undo-decision-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const where = form.getAttribute('data-where');
    const reason = reasonOf(form.elements.reason.value);
    G.ui.setText('undo-err', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      G.ui.setText('undo-err', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.');
      form.elements.reason.focus();
      return;
    }
    G.ui.runDialog(form, G.api.del(A().apiBase(gid) + '/raids/' + encodeURIComponent(form.getAttribute('data-rid')) + '/decisions/' + encodeURIComponent(form.getAttribute('data-pid')), { reason: reason }), function (res) {
      afterWrite(where, gid, res, 'Decision undone.');
    });
  };

  // ── unmatched ──
  G.handlers.click['unm-link'] = function (el) {
    const gd = currentGd();
    const where = el.getAttribute('data-where');
    const rid = el.getAttribute('data-rid');
    const unm = findUnmatched(where, rid, el.getAttribute('data-ukey'));
    if (!gd || !unm) return;
    const teamId = raidTeamOf(where, rid) || G.app.teamFor(gd);
    el.disabled = true;
    G.api.get(A().apiBase(gd.guild.id) + '/roster?team=' + encodeURIComponent(teamId)).then(function (res) {
      el.disabled = false;
      G.ui.openDialog(linkDialogHtml({ unm: unm, people: res && res.people, raidId: rid, where: where, guildData: gd }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const s = document.getElementById(unm.class ? 'unm-search' : 'unm-class') || document.getElementById('unm-search');
      if (s) s.focus();
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  G.handlers.input['unm-search'] = function (el) {
    const q = String(el.value || '').trim().toLowerCase();
    const items = el.closest('form').querySelectorAll('.gs-pick-item');
    for (let i = 0; i < items.length; i++) items[i].hidden = !!q && items[i].getAttribute('data-name').indexOf(q) < 0;
  };

  G.handlers.change['unm-make-main'] = function (el) {
    const submit = document.getElementById('unm-link-submit');
    if (submit) submit.textContent = el.checked ? 'Make Main' : 'Add as Alt';
  };

  G.handlers.click['unm-person'] = function (el) {
    const where = el.getAttribute('data-where');
    const rid = el.getAttribute('data-rid');
    const unm = findUnmatched(where, rid, el.getAttribute('data-ukey'));
    if (!unm) return;
    G.ui.openDialog(personDialogHtml({ unm: unm, raidId: rid, raidOn: raidOnOf(where, rid), where: where, guildData: currentGd() }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
  };

  G.handlers.click['unm-guest'] = function (el) {
    const where = el.getAttribute('data-where');
    const rid = el.getAttribute('data-rid');
    const unm = findUnmatched(where, rid, el.getAttribute('data-ukey'));
    if (!unm) return;
    G.ui.openDialog(guestDialogHtml({ unm: unm, raidId: rid, where: where }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  function unmatchedNote(res, text) {
    const n = res && res.staleRaids > 0 ? ' ' + plural(res.staleRaids, 'other raid needs', 'other raids need') + ' recalculating.' : '';
    return text + n;
  }

  G.handlers.submit['unm-link-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const picked = form.querySelector('input[name="personId"]:checked');
    G.ui.setText('dlg-err-personId', '');
    G.ui.setText('dlg-err-class', '');
    if (!picked) { G.ui.setText('dlg-err-personId', 'Pick the person this character belongs to.'); return; }
    const name = form.getAttribute('data-name');
    const where = form.getAttribute('data-where');
    const makeMain = !!(form.elements.makeMain && form.elements.makeMain.checked);
    const body = { key: form.getAttribute('data-key'), action: 'alt', personId: picked.value };
    if (makeMain) body.makeMain = true;
    const choice = classChoice(form);
    if (choice.missing) { G.ui.setText('dlg-err-class', 'Pick this character\'s class.'); form.elements['class'].focus(); return; }
    if (choice.value) body.class = choice.value;
    const personName = picked.getAttribute('data-person-name') || 'their';
    G.ui.runDialog(form, G.api.post(A().apiBase(gid) + '/raids/' + encodeURIComponent(form.getAttribute('data-rid')) + '/unmatched', body), function (res) {
      afterWrite(where, gid, res, unmatchedNote(res, makeMain ? name + ' is now ' + personName + "'s Main." : 'Added ' + name + ' as an Alt.'));
    });
  };

  G.handlers.submit['unm-person-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const joinedOn = String(form.elements.joinedOn.value || '').trim();
    G.ui.setText('dlg-err-joinedOn', '');
    if (!joinedOn) { G.ui.setText('dlg-err-joinedOn', 'Joined needs a date.'); form.elements.joinedOn.focus(); return; }
    const name = form.getAttribute('data-name');
    const where = form.getAttribute('data-where');
    const body = { key: form.getAttribute('data-key'), action: 'person', status: form.elements.status.value, joinedOn: joinedOn };
    G.ui.setText('dlg-err-class', '');
    const choice = classChoice(form);
    if (choice.missing) { G.ui.setText('dlg-err-class', 'Pick this character\'s class.'); form.elements['class'].focus(); return; }
    if (choice.value) body.class = choice.value;
    G.ui.runDialog(form, G.api.post(A().apiBase(gid) + '/raids/' + encodeURIComponent(form.getAttribute('data-rid')) + '/unmatched', body), function (res) {
      afterWrite(where, gid, res, unmatchedNote(res, 'Added ' + name + ' as a new person.'));
    });
  };

  G.handlers.submit['unm-guest-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const gid = gd.guild.id;
    const name = form.getAttribute('data-name');
    const where = form.getAttribute('data-where');
    G.ui.runDialog(form, G.api.post(A().apiBase(gid) + '/raids/' + encodeURIComponent(form.getAttribute('data-rid')) + '/unmatched', { key: form.getAttribute('data-key'), action: 'guest' }), function (res) {
      afterWrite(where, gid, res, unmatchedNote(res, 'Marked ' + name + ' as a guest.'));
    });
  };

  // ── character claims: approve and reject ──
  function claimBase(gid, id) { return A().apiBase(gid) + '/claims/' + encodeURIComponent(id); }

  function claimFailed(err) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
    // A lost race or a changed roster: say so and show the queue as it is now.
    reloadReview().then(function () { st().pageAlert = c.text; G.app.render(); });
  }

  function claimOf(id) {
    const x = a().review;
    return x && Array.isArray(x.claims) ? x.claims.filter(function (c) { return c.id === id; })[0] || null : null;
  }

  G.handlers.submit['claim-approve'] = function (form) {
    const gd = currentGd();
    const claim = claimOf(form.getAttribute('data-claim'));
    if (!gd || !claim) return;
    const body = { expectedKind: form.getAttribute('data-kind') };
    if (form.elements.teamId) body.teamId = form.elements.teamId.value;
    if (form.elements.status) body.status = form.elements.status.value;
    G.ui.setBusy(form, true);
    G.api.post(claimBase(gd.guild.id, claim.id) + '/approve', body).then(function (res) {
      const name = claim.character.name;
      const who = claim.claimant && claim.claimant.displayName ? claim.claimant.displayName : 'the member';
      const text = res.outcome === 'add_alt' ? 'Approved: ' + name + ' joined the roster as an Alt.'
        : res.outcome === 'new_person' ? 'Approved: ' + name + ' joined the roster as a new person.'
        : res.outcome === 'link_person' ? 'Approved: ' + who + ' is now linked to ' + name + '.'
        : 'Closed the claim on ' + name + '.';
      afterWrite('review', gd.guild.id, res, text);
    }, function (err) { G.ui.setBusy(form, false); claimFailed(err); });
  };

  G.handlers.click['claim-reject'] = function (el) {
    const gd = currentGd();
    const claim = claimOf(el.getAttribute('data-claim'));
    if (!gd || !claim || el.disabled) return;
    el.disabled = true;
    G.api.post(claimBase(gd.guild.id, claim.id) + '/reject', {}).then(function (res) {
      afterWrite('review', gd.guild.id, res, 'Rejected the claim on ' + claim.character.name + '.');
    }, function (err) { el.disabled = false; claimFailed(err); });
  };

  G.pages.review = {
    CLAIM_STATUSES: CLAIM_STATUSES,
    claimWords: claimWords,
    claimItemHtml: claimItemHtml,
    claimsSectionHtml: claimsSectionHtml,
    FILTERS: FILTERS,
    decideOptions: decideOptions,
    needsCredit: needsCredit,
    evidenceText: evidenceText,
    decideDialogHtml: decideDialogHtml,
    linkDialogHtml: linkDialogHtml,
    classFieldHtml: classFieldHtml,
    classChoice: classChoice,
    personDialogHtml: personDialogHtml,
    guestDialogHtml: guestDialogHtml,
    reviewHtml: reviewHtml,
    itemActionsHtml: itemActionsHtml,
    isUnmatched: isUnmatched,
    noteHtml: noteHtml,
    unmatchedEvidence: unmatchedEvidence,
    raidTeamOf: raidTeamOf,
    creditValuesOf: creditValuesOf,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
