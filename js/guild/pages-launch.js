// ── PAGE: ROSTER > LAUNCH (the launch readiness funnel) ────────
// For the launch of a new WoW version: a row per person of the team through four stages - intent picked (the intent board), character created (the roster),
// level band (typed, or from an approved Battle.net claim) and ready (a tick) - with the counts per stage and per role and the gap to the team's raid size.
// A WoW Forever guild always has it; any other guild turns it on for a team (Guild settings > Teams, or the button here). Officers fill every row; a member
// updates their own. GET /launch?team=, PUT /launch/:pid, PUT /teams/:tid/launch. Every write answers with the funnel, so the page just replaces its copy.
(function (G) {
  'use strict';

  const STAGES = [
    { id: 'intent', label: 'Spec poll picked' },
    { id: 'character', label: 'Character created' },
    { id: 'level', label: 'Level band' },
    { id: 'ready', label: 'Attuned / ready' },
  ];
  const ROLE_LABELS = { tank: 'Tanks', healer: 'Healers', melee: 'Melee DPS', ranged: 'Ranged DPS', none: 'No pick yet' };
  const ROLE_ONE = { tank: 'Tank', healer: 'Healer', melee: 'Melee DPS', ranged: 'Ranged DPS' };

  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // ── data ──
  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().launch = { gid: gid, teamId: null, data: null, note: '' }; return Promise.resolve(null); }
    return G.api.launch.get(gid, teamId).then(function (data) {
      a().launch = { gid: gid, teamId: teamId, data: data, note: '', busy: false };
      return null;
    });
  }

  // Whether the Roster's Launch tab is offered at all: a Forever guild, or a team marked as a launch team.
  function offered(gd) {
    if (!gd || !gd.guild) return false;
    if (gd.guild.gameVersion === 'forever') return true;
    return (gd.teams || []).some(function (t) { return t && t.launchTeam === true && !t.archived; });
  }

  // ── the page ──
  function stageCount(totals, id) { return totals.stages[id] || 0; }

  function summaryHtml(data) {
    const t = data.totals;
    const people = t.people;
    const size = data.team.size;
    const bars = STAGES.map(function (s) {
      const n = stageCount(t, s.id);
      return '<li class="gs-funnel-row"><span class="gs-funnel-label" id="fn-' + s.id + '">' + esc(s.label) + '</span>' +
        '<progress class="gs-funnel-bar" max="' + esc(Math.max(people, 1)) + '" value="' + esc(n) + '" aria-labelledby="fn-' + s.id + '"></progress>' +
        '<span class="gs-funnel-n">' + esc(n) + ' of ' + esc(people) + '</span></li>';
    }).join('');
    const gap = t.gap > 0 ? plural(t.gap, 'spot', 'spots') + ' short of the ' + size + '-man raid' : 'Enough people are ready for the ' + size + '-man raid';
    return '<section class="gs-card-sec" aria-labelledby="launch-sum-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="launch-sum-h">The funnel</h2>' +
      '<span class="gs-pill gs-pill-' + (t.gap > 0 ? 'warn' : 'ok') + '">' + esc(t.stages.ready + ' ready') + '</span></div><div class="gs-card-sec-body">' +
      '<ul class="gs-funnel" aria-label="People at each stage">' + bars + '</ul>' +
      '<p class="gs-fine" id="launch-gap">' + esc(gap) + '. ' + esc(plural(t.stages.topLevel, 'person is', 'people are')) + ' at the top level band.</p></div></section>';
  }

  function rolesHtml(data) {
    const rows = data.totals.roles.filter(function (r) { return r.role !== 'none' || r.people > 0; }).map(function (r) {
      const gap = r.gap === null ? '-' : (r.gap > 0 ? 'Need ' + r.gap : 'Covered');
      return '<tr><th scope="row" class="gs-cell-strong">' + esc(ROLE_LABELS[r.role]) + '</th><td class="gs-num" data-label="People">' + esc(r.people) + '</td>' +
        '<td class="gs-num" data-label="Spec poll">' + esc(r.intent) + '</td><td class="gs-num" data-label="Character">' + esc(r.character) + '</td>' +
        '<td class="gs-num" data-label="Level band">' + esc(r.level) + '</td><td class="gs-num" data-label="Ready">' + esc(r.ready) + '</td>' +
        '<td class="gs-num" data-label="Target">' + (r.target === null ? '-' : esc(r.target)) + '</td><td data-label="Gap">' + esc(gap) + '</td></tr>';
    }).join('');
    return '<section class="gs-card-sec" aria-labelledby="launch-roles-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="launch-roles-h">By role</h2></div><div class="gs-card-sec-body">' +
      '<div class="gs-table-wrap"><table class="gs-table gs-table-stack" aria-label="The funnel by role"><thead><tr><th scope="col">Role</th><th scope="col">People</th><th scope="col">Spec poll</th>' +
      '<th scope="col">Character</th><th scope="col">Level band</th><th scope="col">Ready</th><th scope="col">Target</th><th scope="col">Gap</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="gs-fine">Target is the team\'s recruitment target for the role; Gap is how many more ready people it still needs.</p></div></section>';
  }

  function yesNo(on) { return '<span class="gs-pill gs-pill-' + (on ? 'ok' : 'muted') + '">' + (on ? 'Yes' : 'No') + '</span>'; }

  function levelCell(data, row, canSet) {
    const band = row.level ? row.level.band : '';
    if (!canSet) return row.level ? esc(row.level.band) + (row.level.source === 'battlenet' ? ' <span class="gs-fine">(Battle.net)</span>' : '') : '<span class="gs-muted">-</span>';
    const typed = row.level && row.level.source === 'manual' ? row.level.band : '';
    const options = [{ value: '', label: row.level && row.level.source === 'battlenet' ? 'Battle.net: ' + band : 'Not set' }].concat(data.levelBands.map(function (b) { return { value: b, label: b }; }));
    return '<label class="gs-sr" for="lv-' + esc(row.personId) + '">Level band of ' + esc(row.name) + '</label><select class="gs-input gs-input-sm" id="lv-' + esc(row.personId) + '" data-change="launch-band" data-pid="' + esc(row.personId) +
      '" data-key="lv-' + esc(row.personId) + '">' + G.ui.optionsHtml(options, typed) + '</select>';
  }

  function rowsHtml(data) {
    const rows = data.rows.map(function (row) {
      const canSet = data.canEdit || row.mine;
      const pick = row.intent ? G.ui.classNameHtml(G.ui.className(row.intent.class) + ' ' + row.intent.spec, row.intent.class) + (row.role ? ' <span class="gs-fine">' + esc(ROLE_ONE[row.role] || '') + '</span>' : '') : '<span class="gs-muted">Not picked</span>';
      const ready = canSet
        ? '<button type="button" class="gs-btn gs-btn-sm" data-action="launch-ready" data-pid="' + esc(row.personId) + '" data-ready="' + (row.ready ? 'false' : 'true') + '" data-key="rd-' + esc(row.personId) +
          '" aria-pressed="' + (row.ready ? 'true' : 'false') + '" aria-label="' + esc((row.ready ? 'Take the ready tick off ' : 'Mark as ready: ') + row.name) + '">' + (row.ready ? 'Ready' : 'Not ready') + '</button>'
        : yesNo(row.ready);
      return '<tr><th scope="row" class="gs-cell-strong">' + G.ui.classNameHtml(row.name, row.class) + (row.mine ? ' <span class="gs-fine">(you)</span>' : '') + '</th>' +
        '<td data-label="Spec poll">' + pick + '</td><td data-label="Character">' + yesNo(row.flags.character) + '</td>' +
        '<td data-label="Level band">' + levelCell(data, row, canSet) + '</td><td data-label="Ready">' + ready + '</td></tr>';
    }).join('');
    if (!data.rows.length) return '<p class="gs-empty">Nobody on this team yet.</p>';
    return '<div class="gs-table-wrap"><table class="gs-table gs-table-stack" aria-label="Launch readiness by person"><thead><tr><th scope="col">Player</th><th scope="col">Spec poll</th>' +
      '<th scope="col">Character</th><th scope="col">Level band</th><th scope="col">Ready</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function offHtml(data) {
    return '<section class="gs-empty-card" aria-labelledby="launch-off-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('roster', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="launch-off-h">The Launch funnel is off for this team</h2>' +
      '<p class="gs-lead gs-lead-sm">It follows a team to a new game version: who has picked what to play, made the character, reached a level band and is ready. A WoW Forever guild has it for every team.</p>' +
      (data.canMark && !data.team.archived ? '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="launch-team" data-enabled="true" data-key="launch-on">Turn on the Launch funnel</button></div>' : '') + '</section>';
  }

  // opts: { guildData, state: a().launch, alert }
  function launchHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const data = x.data;
    const head = G.pages.rosterTabs.headHtml(gd, 'launch', data.team.name);
    const alert = G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '');
    if (!data.enabled) return '<div class="gs-page">' + head + alert + offHtml(data) + '</div>';
    const off = data.gameVersion !== 'forever' && data.canMark && !data.team.archived
      ? '<div class="gs-actions"><button type="button" class="gs-btn" data-action="launch-team" data-enabled="false" data-key="launch-off">Turn the funnel off for this team</button></div>' : '';
    return '<div class="gs-page">' + head + alert + summaryHtml(data) + rolesHtml(data) +
      '<section class="gs-card-sec" aria-labelledby="launch-rows-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="launch-rows-h">People</h2></div><div class="gs-card-sec-body">' +
      '<p class="gs-fine">' + (data.round ? 'The spec poll is "' + esc(data.round.title) + '". ' : 'No spec poll yet: open one on the Spec poll tab. ') +
      (data.canEdit ? 'You can set every row.' : 'You can set your own row.') + ' A level band set here wins over a Battle.net level.</p>' + rowsHtml(data) + off + '</div></section></div>';
  }

  function main(r, gd) {
    const x = a().launch;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return launchHtml({ guildData: gd, state: x, alert: G.app.state.pageAlert });
  }

  // ── handlers ──
  function cur() {
    const x = a().launch;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id && x.data && !x.busy ? { x: x, gd: gd } : null;
  }

  function apply(c, promise, note) {
    c.x.busy = true;
    promise.then(function (data) {
      c.x.data = data;
      c.x.busy = false;
      c.x.note = note || '';
      G.app.render();
    }, function (err) {
      c.x.busy = false;
      G.app.handleError(err, { pageAlert: true });
    });
  }

  G.handlers.click['launch-ready'] = function (el) {
    const c = cur();
    if (!c) return;
    apply(c, G.api.launch.set(c.x.gid, el.getAttribute('data-pid'), { teamId: c.x.teamId, ready: el.getAttribute('data-ready') === 'true' }));
  };

  G.handlers.change['launch-band'] = function (el) {
    const c = cur();
    if (!c) return;
    apply(c, G.api.launch.set(c.x.gid, el.getAttribute('data-pid'), { teamId: c.x.teamId, levelBand: el.value === '' ? null : el.value }));
  };

  G.handlers.click['launch-team'] = function (el) {
    const c = cur();
    if (!c) return;
    const on = el.getAttribute('data-enabled') === 'true';
    apply(c, G.api.launch.mark(c.x.gid, c.x.teamId, on), on ? 'The Launch funnel is on for this team.' : 'The Launch funnel is off for this team.');
  };

  G.pages.launch = { STAGES: STAGES, offered: offered, load: load, main: main, launchHtml: launchHtml, summaryHtml: summaryHtml, rowsHtml: rowsHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
