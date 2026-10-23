// ── PLANNER LANDING FOR GUILD MEMBERS: "Upcoming raids to plan" ─
// The Planner's landing (#/planner) is the import page. For a signed-in viewer who holds raids.edit in a guild it is the officer home (body.has-planner-home):
// raid cards in the main column (date in the guild's zone, title, zone - size, sign-ups, Planned / Not planned; the whole card opens #/planner?raid=<gid>.<rid>
// through the Raids list's own "Plan in Planner"; the soonest card carries the one molten button), and the import form and the device plans as two panels in a
// right column. Nothing new on the Worker: each guild's own payload says what the viewer may edit, and GET /raids?team= lists the
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

  function planChip(raid) {
    return raid.planned ? '<span class="gs-hd-chip is-green">Planned</span>' : '<span class="gs-hd-chip is-grey">Not planned</span>';
  }

  function sizeText(raid) { return typeof raid.size === 'number' && raid.size > 0 ? raid.size + '-man' : ''; }

  // The card's name: the raid's own title, else "zone - size".
  function titleText(row) {
    const r = row.raid;
    return r.title || [r.zone, sizeText(r)].filter(Boolean).join(' - ') || 'Raid';
  }

  // The card's second line: "zone - size" when the raid has a title, then the team and the guild where there are several.
  function detailText(row) {
    const r = row.raid;
    const parts = r.title ? [[r.zone, sizeText(r)].filter(Boolean).join(' - ')] : [];
    if (row.showTeam) parts.push(row.teamName);
    if (model.multiGuild) parts.push(row.guildName);
    return parts.filter(Boolean).join(' - ');
  }

  // "Thu Oct 23 - 8:00 PM ET": the day in the guild's zone, the time only when the raid has one.
  function dateHtml(row) {
    const r = row.raid;
    const day = G.ui.weekdayDay(r.raidOn) || r.raidOn;
    const zone = row.gd && row.gd.guild ? row.gd.guild.timeZone : '';
    const time = r.timeKnown === false ? '' : G.ui.timeInZone(r.startsAt, zone);
    return esc(day) + (time ? ' <span>- ' + esc(time) + '</span>' : '');
  }

  // One raid card (design-spec 4, clickable card): the title is the stretched link (its ::after covers the card); the molten button of the soonest card sits above it.
  function cardHtml(row, soonest) {
    const r = row.raid;
    const detail = detailText(row);
    const title = titleText(row);
    const day = G.ui.weekdayDay(r.raidOn) || r.raidOn;
    const attrs = ' data-action="pl-plan" data-gid="' + esc(row.gid) + '" data-rid="' + esc(r.id) + '"';
    const button = soonest
      ? '<div class="gs-ph-cardr"><button type="button" class="gs-btn gs-btn-molten"' + attrs + ' data-key="pl-' + esc(r.id) + '">' + (r.planned ? 'Open plan' : 'Plan raid') + '</button></div>'
      : '';
    return '<li class="gs-hd-panel gs-ph-rcard"><div class="gs-ph-cardtop"><p class="gs-ph-date">' + dateHtml(row) + '</p>' + planChip(r) + '</div>' +
      '<h3 class="gs-ph-ctitle"><a class="gs-ph-cardlink" href="' + esc(G.router.format({ name: 'planner', gid: row.gid, rid: r.id })) + '"' + attrs + ' data-key="pl-link-' + esc(r.id) + '" aria-label="' +
      esc(title + ', ' + day + ', ' + (r.planned ? 'planned' : 'not planned')) + '">' + esc(title) + '</a></h3>' +
      (detail ? '<p class="gs-ph-csub">' + esc(detail) + '</p>' : '') +
      '<p class="gs-ph-su">' + esc(G.pages.raids.signupsText(r.signups, r.size)) + '</p>' + button + '</li>';
  }

  // The cards, or '' while nothing is known and for a viewer who cannot plan for any team (they see the member home).
  function html() {
    if (!model.rows || !model.canEdit) return '';
    const total = model.rows.length + model.hidden;
    const head = '<h2 class="gs-hd-sl" id="pl-h"><span class="gs-ph-sl">Upcoming' + (total ? '<span class="gs-ph-count">' + total + '</span>' : '') + '</span></h2>';
    const error = '<p class="gs-alert" id="pl-error" role="alert"' + (model.error ? '' : ' hidden') + '>' + esc(model.error) + '</p>';
    const raidsLink = '<a href="' + esc(G.router.format({ name: 'section', gid: chromeGid(), section: 'raids' })) + '">Raids page</a>';
    if (!model.rows.length) {
      return '<section class="gs-ph-raids" aria-labelledby="pl-h">' + head + '<p class="gs-ph-none">No upcoming raids to plan. Add one on the ' + raidsLink + '.</p></section>';
    }
    const more = model.hidden > 0 ? '<p class="gs-ph-morer">and ' + model.hidden + ' more on the ' + raidsLink + '</p>' : '';
    return '<section class="gs-ph-raids" aria-labelledby="pl-h">' + head + '<ul class="gs-ph-cards">' + model.rows.map(function (row, i) { return cardHtml(row, i === 0); }).join('') + '</ul>' + more + error + '</section>';
  }

  // True while the officer home (cards + right column) is the page: the viewer may plan for a team.
  function active() { return !!(model.rows && model.canEdit); }

  // The guild the "Raids page" link of the empty panel names: the first that lets the viewer plan.
  function chromeGid() {
    const guilds = guildsOf(st().me);
    const planning = guilds.filter(function (g) { const gd = st().guilds[g.id]; return gd && planTeams(gd).length; })[0];
    return (planning || guilds[0] || {}).id;
  }

  G.handlers.click['pl-plan'] = function (el, ev) {
    const gid = el.getAttribute('data-gid');
    const rid = el.getAttribute('data-rid');
    const row = (model.rows || []).filter(function (x) { return x.gid === gid && x.raid.id === rid; })[0];
    if (!row) return null;
    // A new-tab click (modifier or middle button) on the card link keeps the browser's own behaviour.
    if (ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey || (typeof ev.button === 'number' && ev.button > 0))) return null;
    if (ev && ev.preventDefault && el.tagName === 'A') ev.preventDefault();
    const r = row.raid;
    const busy = function (on) { if (el.tagName === 'A') { if (on) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy'); } else el.disabled = on; };
    busy(true);
    return G.pages.raids.planInPlanner(gid, rid, r.eventSourced && r.eventId ? { id: r.eventId, otherServer: !!r.otherServer } : null).then(function (opened) {
      if (!opened) busy(false);
    }, function (err) {
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      busy(false);
      model.error = c.text;
      G.app.render();
    });
  };

  // "Show all" in the On this device panel: the Your plans dialog. The panel's own list, Saved copies and Recent imports move into it while it is open (same
  // nodes, so every handler and id stays single) and go back when it closes.
  function openAllPlans() {
    if (document.getElementById('pl-all-body')) return null;
    const nodes = ['landing-saved-list', 'landing-copies-wrap', 'landing-history-wrap'].map(function (id) { return document.getElementById(id); });
    if (nodes.some(function (n) { return !n; })) return null;
    const html = G.ui.dialogHtml({ kind: 'form', formless: true, title: 'Your plans', titleId: 'pl-all-title', bodyHtml: '<div class="gs-ph-dlgbody" id="pl-all-body"></div>', cancel: { label: 'Close' }, className: 'gs-forge gs-ph-dlg' });
    G.app.lastActionEl = document.getElementById('btn-landing-showall');
    const dlg = G.ui.openDialog(html, { labelledBy: 'pl-all-title' });
    if (!dlg) return null;
    const body = dlg.querySelector('#pl-all-body');
    const marks = nodes.map(function (n) { const m = document.createComment(''); n.parentNode.replaceChild(m, n); return m; });
    nodes.forEach(function (n) { body.appendChild(n); });
    const restore = function () { marks.forEach(function (m, i) { if (m.parentNode) m.parentNode.replaceChild(nodes[i], m); }); };
    // Restore synchronously before the planner opens a confirmation/history dialog or renders
    // a plan. Native close events are queued; waiting for one can strand these live nodes.
    dlg.addEventListener('click', function (ev) {
      if (ev.target.closest && ev.target.closest('.saved-open, [data-history-open], [data-delete-plan], [data-delete-copy], [data-history-delete], .history-more')) {
        restore();
        if (dlg.open) dlg.close();
      }
    }, true);
    dlg.addEventListener('close', restore);
    return dlg;
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('click', function (ev) {
      const t = ev.target;
      if (t && t.closest && t.closest('#btn-landing-showall')) openAllPlans();
    });
  }

  G.pages.plannerLanding = {
    MAX_ROWS: MAX_ROWS,
    model: model,
    planTeams: planTeams,
    detailText: detailText,
    refresh: refresh,
    reset: reset,
    html: html,
    active: active,
    openAllPlans: openAllPlans,
    titleText: titleText,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
