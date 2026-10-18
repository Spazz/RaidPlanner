// ── PLANNER LANDING FOR GUILD MEMBERS: "Upcoming raids to plan" ─
// The Planner's landing (#/planner) is the public import page. For a signed-in viewer who holds raids.edit in a guild it leads with the guild's upcoming raids
// instead: the date in the guild's zone, the sign-up count, whether the raid is planned, and a Plan button that is the Raids list's own "Plan in Planner" (it
// opens #/planner?raid=<gid>.<rid>). The saved plans of this browser follow under "Other plans on this device" (the import card's second tab, relabelled by
// body.has-planner-guild in app.css). Nothing new on the Worker: each guild's own payload says what the viewer may edit, and GET /raids?team= lists the
// team's upcoming raids, so a guild or a team the viewer cannot plan for is never read. Drawn into #planner-notice by app.js (render), which asks refresh()
// when the planner section opens or its landing shows again.
(function (G) {
  'use strict';

  const MAX_ROWS = 6;
  const MAX_GUILDS = 5;
  const FRESH_MS = 20000; // the list is read again on a landing visit once it is older than this

  // rows: [{ gid, guildName, teamId, teamName, showTeam, raid }] soonest first; null until the first read ends. canEdit: the viewer can plan for a team.
  const model = { rows: null, canEdit: false, multiGuild: false, at: 0, reading: null, error: '', hidden: 0 };

  function st() { return G.app.state; }
  function guildsOf(me) { return me && Array.isArray(me.guilds) ? me.guilds : []; }

  // The teams of a guild the viewer may plan for: raids.edit on the team, and the team is not archived.
  function planTeams(gd) {
    const can = gd && gd.me && gd.me.can;
    return G.shell.activeTeams(gd && gd.teams).filter(function (t) { return G.shell.allowsTeam(can, 'raids.edit', t.id); });
  }

  // The guild's payload: the one the app already holds, else read it (and kept, so the guild pages start from it).
  function guildData(gid) {
    const have = st().guilds[gid];
    return have ? Promise.resolve(have) : G.app.fetchGuild(gid);
  }

  // One guild's rows. A guild whose payload or lists cannot be read adds none (the Raids page says why when the person opens it).
  function rowsOfGuild(entry) {
    return guildData(entry.id).then(function (gd) {
      const teams = planTeams(gd);
      if (!teams.length) return { canEdit: false, rows: [] };
      const showTeam = G.shell.activeTeams(gd.teams).length > 1;
      return Promise.all(teams.map(function (t) {
        return G.api.get('/api/guild/' + encodeURIComponent(gd.guild.id) + '/raids?team=' + encodeURIComponent(t.id)).then(function (res) {
          return (res && Array.isArray(res.upcoming) ? res.upcoming : []).map(function (raid) {
            return { gid: gd.guild.id, guildName: gd.guild.name, gd: gd, teamId: t.id, teamName: t.name, showTeam: showTeam, raid: raid };
          });
        }, function () { return []; });
      })).then(function (lists) {
        return { canEdit: true, rows: lists.reduce(function (all, list) { return all.concat(list); }, []) };
      });
    }, function () { return { canEdit: false, rows: [] }; });
  }

  // Reads every guild of the viewer. Resolves when the rows are in; a second call during a read joins it. { force: true } skips the freshness check.
  function refresh(opts) {
    const me = st().me;
    const guilds = guildsOf(me).slice(0, MAX_GUILDS);
    if (!guilds.length) { model.rows = null; model.canEdit = false; return Promise.resolve(false); }
    if (model.reading) return model.reading;
    if (!(opts && opts.force) && model.rows && Date.now() - model.at < FRESH_MS) return Promise.resolve(false);
    const read = Promise.all(guilds.map(rowsOfGuild)).then(function (parts) {
      const all = parts.reduce(function (rows, p) { return rows.concat(p.rows); }, []).sort(function (x, y) { return x.raid.startsAt - y.raid.startsAt; });
      model.canEdit = parts.some(function (p) { return p.canEdit; });
      model.multiGuild = parts.filter(function (p) { return p.rows.length; }).length > 1;
      model.hidden = Math.max(0, all.length - MAX_ROWS);
      model.rows = all.slice(0, MAX_ROWS);
      model.at = Date.now();
      model.error = '';
      model.reading = null;
      return true;
    }, function () { model.reading = null; return false; });
    model.reading = read;
    return read;
  }

  function reset() { model.rows = null; model.canEdit = false; model.reading = null; model.error = ''; model.at = 0; }

  function planState(raid) {
    return raid.planned ? G.ui.chipHtml({ tone: 'success', label: 'Planned' }) : G.ui.chipHtml({ tone: 'neutral', label: 'Not planned' });
  }

  // The second line of a row: the title and zone of the raid, then the team and the guild where there are several.
  function detailText(row) {
    const r = row.raid;
    const parts = [r.title, r.zone].filter(function (s, i, all) { return s && all.indexOf(s) === i; });
    if (row.showTeam) parts.push(row.teamName);
    if (model.multiGuild) parts.push(row.guildName);
    return parts.join(' - ');
  }

  function rowHtml(row) {
    const r = row.raid;
    const detail = detailText(row);
    const label = 'Plan ' + G.pages.raids.whenText(r, row.gd);
    return '<li class="gs-pl-row"><div class="gs-pl-main"><a class="gs-pl-when" href="' + esc(G.router.format({ name: 'raid', gid: row.gid, rid: r.id })) + '">' + esc(G.pages.raids.whenText(r, row.gd)) + '</a>' +
      (detail ? '<span class="gs-fine">' + esc(detail) + '</span>' : '') + '</div>' +
      '<span class="gs-pl-count">' + esc(G.pages.raids.signupsText(r.signups, r.size)) + '</span>' + planState(r) +
      G.ui.buttonHtml({ label: 'Plan', ariaLabel: label, attrs: { 'data-action': 'pl-plan', 'data-gid': row.gid, 'data-rid': r.id, 'data-key': 'pl-' + r.id } }) + '</li>';
  }

  // The panel, or '' while nothing is known and for a viewer who cannot plan for any team (they see the Planner as it always was).
  function html() {
    if (!model.rows || !model.canEdit) return '';
    const head = '<h2 class="gs-h2" id="pl-h">Upcoming raids to plan</h2>';
    const error = '<p class="gs-alert" id="pl-error" role="alert"' + (model.error ? '' : ' hidden') + '>' + esc(model.error) + '</p>';
    if (!model.rows.length) {
      return '<section class="gs-pl" aria-labelledby="pl-h">' + head + '<p class="gs-fine">No upcoming raids to plan. Add one on the <a href="' + esc(G.router.format({ name: 'section', gid: chromeGid(), section: 'raids' })) + '">Raids page</a>.</p></section>';
    }
    const more = model.hidden > 0 ? '<p class="gs-fine">' + esc('and ' + model.hidden + ' more on the Raids page') + '</p>' : '';
    return '<section class="gs-pl" aria-labelledby="pl-h">' + head + '<ul class="gs-pl-list">' + model.rows.map(rowHtml).join('') + '</ul>' + more + error +
      '<p class="gs-fine">Plans you start here, or import below, are saved on this device only.</p></section>';
  }

  // The guild the "Raids page" link of the empty panel names: the first that lets the viewer plan.
  function chromeGid() {
    const guilds = guildsOf(st().me);
    const planning = guilds.filter(function (g) { const gd = st().guilds[g.id]; return gd && planTeams(gd).length; })[0];
    return (planning || guilds[0] || {}).id;
  }

  G.handlers.click['pl-plan'] = function (el) {
    const gid = el.getAttribute('data-gid');
    const rid = el.getAttribute('data-rid');
    const row = (model.rows || []).filter(function (x) { return x.gid === gid && x.raid.id === rid; })[0];
    if (!row) return null;
    const r = row.raid;
    el.disabled = true;
    return G.pages.raids.planInPlanner(gid, rid, r.eventSourced && r.eventId ? { id: r.eventId, otherServer: !!r.otherServer } : null).then(function (opened) {
      if (!opened) el.disabled = false;
    }, function (err) {
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      el.disabled = false;
      model.error = c.text;
      G.app.render();
    });
  };

  G.pages.plannerLanding = {
    MAX_ROWS: MAX_ROWS,
    model: model,
    planTeams: planTeams,
    detailText: detailText,
    refresh: refresh,
    reset: reset,
    html: html,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
