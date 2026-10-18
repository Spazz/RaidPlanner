// ── PAGE PART: RANK PROGRESSION ─────────────────────────────────
// An optional per-guild ladder of ranks (Attendance settings), each earned by rules (attendance, raids attended, weeks since joining, misses). A rank is a
// label on the person, separate from the Raider / Trial / Reserve / Inactive status; the ladder only SUGGESTS ("Suggested: promote to Core", "Suggested:
// review (below Raider)") and an officer accepts it with one click or dismisses it for 30 days. The team attendance page (pages-attendance.js), the person's
// attendance page (pages-person-attendance.js) and the Home list (pages-attention.js) draw the pieces built here; PUT /roster/:pid/rank and
// POST /roster/:pid/rank/dismiss do the writes.
(function (G) {
  'use strict';

  function st() { return G.app.state; }
  function listOf(v) { return Array.isArray(v) ? v : []; }

  // "Suggested: promote to Core" / "Suggested: review (below Raider)" for a suggestion { kind, from: { name }, to: { name } }.
  function suggestionText(s) {
    if (!s) return '';
    const from = s.from && s.from.name ? s.from.name : 'the current rank';
    const to = s.to && s.to.name ? s.to.name : 'the next rank';
    return s.kind === 'review' ? 'Suggested: review (below ' + from + ')' : 'Suggested: promote to ' + to;
  }

  function rankChipHtml(rank) {
    if (!rank || !rank.name) return '';
    return '<span class="gs-chip gs-chip-plain gs-rank-chip"><span class="gs-sr">Rank: </span>' + esc(rank.name) + '</span>';
  }

  // The suggestion's chip with its Accept and Dismiss buttons. who: { pid, name, teamId, rank (the person's rank { id, set }) }. Only reviewers are sent a suggestion.
  function suggestionHtml(s, who) {
    if (!s || !who || !who.pid) return '';
    const base = ' data-pid="' + esc(who.pid) + '" data-team="' + esc(who.teamId) + '" data-kind="' + esc(s.kind) + '" data-to="' + esc(s.to && s.to.id) + '" data-from="' + esc(who.rank && who.rank.set ? who.rank.id : '') + '"';
    const reasons = listOf(s.reasons).join('; ');
    const acceptLabel = (s.kind === 'review' ? 'Move ' + who.name + ' down to ' : 'Promote ' + who.name + ' to ') + (s.to && s.to.name);
    return '<span class="gs-rank-suggest"><span class="gs-chip gs-chip-main gs-rank-suggest-chip"' + (reasons ? ' title="' + esc(reasons) + '"' : '') + '>' + esc(suggestionText(s)) + '</span>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="rank-accept"' + base + ' data-key="rank-accept-' + esc(who.pid) + '" aria-label="Accept: ' + esc(acceptLabel) + '">Accept</button>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="rank-dismiss"' + base + ' data-key="rank-dismiss-' + esc(who.pid) + '" aria-label="Dismiss for 30 days: ' + esc(suggestionText(s) + ' for ' + who.name) + '">Dismiss</button></span>' +
      (reasons ? '<span class="gs-fine gs-rank-why">' + esc(reasons) + '</span>' : '');
  }

  // The team page's rank line for one person p ({ id, name, rank, rankSuggestion }). '' while the guild has no ladder.
  function lineHtml(p, teamId) {
    if (!p || !p.rank) return '';
    return '<span class="gs-rank-line">' + rankChipHtml(p.rank) + suggestionHtml(p.rankSuggestion, { pid: p.id, name: p.name, teamId: teamId, rank: p.rank }) + '</span>';
  }

  // The person's attendance page: the rank, a way to set it by hand (for whoever reviews a team of theirs), and the suggestions with their reasons.
  // person: the Worker's person { id, name, rank, rankChoices, rankTeamId }; teams: the answer's teams ({ team: { id }, rankSuggestion? }).
  function personBoxSection(person, teams) {
    if (!person || !person.rank) return null;
    const choices = listOf(person.rankChoices);
    const suggested = listOf(teams).filter(function (t) { return t && t.rankSuggestion; })[0];
    const setter = person.rankTeamId && choices.length
      ? '<div class="gs-rank-set"><label class="gs-label" for="pa-rank">Rank</label><select class="gs-input gs-input-short" id="pa-rank" data-key="pa-rank">' +
        G.ui.optionsHtml(choices.map(function (c) { return { value: c.id, label: c.name }; }), person.rank.id) + '</select>' +
G.ui.buttonHtml({ label: 'Set rank', size: 'sm', attrs: { 'data-action': 'rank-set', 'data-pid': person.id, 'data-team': person.rankTeamId, 'data-from': person.rank.set ? person.rank.id : '', 'data-key': 'rank-set' } }) + '</div>'
      : '';
    return { id: 'pa-rank-box', title: 'Rank', chipHtml: rankChipHtml(person.rank), bodyHtml:
      (suggested ? '<div class="gs-rank-line">' + suggestionHtml(suggested.rankSuggestion, { pid: person.id, name: person.name, teamId: suggested.team && suggested.team.id, rank: person.rank }) + '</div>' : '') +
      setter + '<p class="gs-fine">A rank is a label. The ladder only suggests; an officer decides.</p><p class="gs-alert" id="rank-error" role="alert" hidden></p>' };
  }

  function personBoxHtml(person, teams) {
    const section = personBoxSection(person, teams);
    return section ? G.ui.objectSectionHtml(section) : '';
  }

  // -- behaviour --
  function currentGid() { return st().currentGid; }

  function done(gid) {
    if (st().attention) delete st().attention[gid];
    st().pageAlert = '';
    G.app.routeAll({ force: true });
  }

  function fail(err) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return; }
    // A rank somebody else changed meanwhile: look again at the fresh page.
    if (err && err.code === 'conflict') { st().pageAlert = c.text; G.app.routeAll({ force: true }); return; }
    G.app.handleError(err, { pageAlert: true });
  }

  function attrs(el) {
    return { pid: el.getAttribute('data-pid'), teamId: el.getAttribute('data-team'), kind: el.getAttribute('data-kind'), to: el.getAttribute('data-to'), from: el.getAttribute('data-from') };
  }

  // Accept: the person gets the rank the suggestion names (down one rank for a review).
  G.handlers.click['rank-accept'] = function (el) {
    const gid = currentGid();
    const x = attrs(el);
    if (!gid || !x.pid || !x.to) return null;
    el.disabled = true;
    return G.api.ranks.set(gid, x.pid, { teamId: x.teamId, rank: x.to, via: 'accept', expectedRank: x.from || null }).then(function () { done(gid); }, function (err) { el.disabled = false; fail(err); });
  };

  G.handlers.click['rank-dismiss'] = function (el) {
    const gid = currentGid();
    const x = attrs(el);
    if (!gid || !x.pid || !x.to) return null;
    el.disabled = true;
    return G.api.ranks.dismiss(gid, x.pid, { teamId: x.teamId, kind: x.kind, to: x.to }).then(function () { done(gid); }, function (err) { el.disabled = false; fail(err); });
  };

  // By hand, from the person's attendance page.
  G.handlers.click['rank-set'] = function (el) {
    const gid = currentGid();
    const x = attrs(el);
    const select = document.getElementById('pa-rank');
    if (!gid || !x.pid || !select) return null;
    el.disabled = true;
    return G.api.ranks.set(gid, x.pid, { teamId: x.teamId, rank: select.value, via: 'manual', expectedRank: x.from || null }).then(function () { done(gid); }, function (err) { el.disabled = false; fail(err); });
  };

  G.pages.ranks = { suggestionText: suggestionText, rankChipHtml: rankChipHtml, suggestionHtml: suggestionHtml, lineHtml: lineHtml, personBoxSection: personBoxSection, personBoxHtml: personBoxHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
