// ── PAGE PART: THE TEAM PROGRESS BOARD ─────────────────────────
// Raids > Progress: per zone, each boss the team has pulled with its first kill date, the wipes before that kill, the kills since, and the quickest night
// (first pull to last kill). GET /api/guild/:gid/teams/:tid/progress. Built by the Worker only from the pulls already stored (no report content). The same
// board, minus the raid links, is the "Progress" section of the public page (pages-view.js).
(function (G) {
  'use strict';

  function plural(n, one, many) { return G.ui.plural(n, one, many); }
  function listOf(v) { return Array.isArray(v) ? v : []; }

  // 3h 12m, 45m, 0m.
  function duration(ms) {
    const minutes = Math.max(0, Math.round((Number(ms) || 0) / 60000));
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? h + 'h ' + (m < 10 ? '0' : '') + m + 'm' : m + 'm';
  }

  function dayText(date) { return date ? G.ui.weekdayDay(date) : '-'; }

  function bossRowHtml(boss) {
    const status = boss.killed
      ? '<span class="gs-pill gs-pill-ok">Down</span>'
      : '<span class="gs-pill gs-pill-warn">Progressing</span>';
    return '<tr><th scope="row" class="gs-cell-strong">' + esc(boss.name) + '</th>' +
      '<td data-label="Status">' + status + '</td>' +
      '<td data-label="First kill">' + (boss.killed ? esc(dayText(boss.firstKillOn)) : '<span class="gs-muted">-</span>') + '</td>' +
      '<td data-label="Wipes' + (boss.killed ? ' before the kill' : '') + '" class="gs-num">' + esc(String(boss.killed ? boss.wipesBeforeKill : boss.wipes)) + '</td>' +
      '<td data-label="Kills since" class="gs-num">' + (boss.killed ? esc(String(boss.killsSince)) : '<span class="gs-muted">-</span>') + '</td></tr>';
  }

  function nightRowHtml(night, gid, links) {
    const date = links && night.raidId
      ? '<a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: night.raidId })) + '">' + esc(dayText(night.raidOn)) + '</a>'
      : esc(dayText(night.raidOn));
    return '<tr><th scope="row" class="gs-cell-strong">' + date + '</th><td data-label="Bosses killed" class="gs-num">' + esc(String(night.bosses)) + '</td>' +
      '<td data-label="Wipes" class="gs-num">' + esc(String(night.wipes)) + '</td><td data-label="Time" class="gs-num">' + esc(duration(night.durationMs)) + '</td></tr>';
  }

  function zoneHtml(zone, index, ctx) {
    const id = ctx.idPrefix + '-z' + index;
    const bosses = listOf(zone.bosses);
    const best = zone.bestClear;
    const bestLine = best
      ? '<p class="gs-fine gs-prog-best" id="' + id + '-best">Best clear: ' + esc(plural(best.bosses, 'boss', 'bosses')) + ' in ' + esc(duration(best.durationMs)) + ' on ' + esc(dayText(best.raidOn)) + '.</p>'
      : '<p class="gs-fine gs-prog-best" id="' + id + '-best">No night with a boss kill yet.</p>';
    const nights = listOf(zone.nights);
    return '<section class="gs-card-sec gs-prog-zone" aria-labelledby="' + id + '-h"><div class="gs-card-sec-head"><h' + ctx.level + ' class="gs-h' + ctx.level + '" id="' + id + '-h">' + esc(zone.zone) + '</h' + ctx.level + '>' +
      '<span class="gs-fine">' + esc(zone.bossesKilled + ' of ' + plural(bosses.length, 'boss', 'bosses') + ' down') + '</span></div><div class="gs-card-sec-body">' + bestLine +
      '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-prog" aria-label="Bosses in ' + esc(zone.zone) + '"><thead><tr><th scope="col">Boss</th><th scope="col">Status</th><th scope="col">First kill</th>' +
      '<th scope="col">Wipes before the kill</th><th scope="col">Kills since</th></tr></thead><tbody>' + bosses.map(bossRowHtml).join('') + '</tbody></table></div>' +
      (nights.length
        ? '<h' + (ctx.level + 1) + ' class="gs-view-sub">Nights with a kill' + (zone.nightCount > nights.length ? ' (newest ' + nights.length + ' of ' + zone.nightCount + ')' : '') + '</h' + (ctx.level + 1) + '>' +
          '<div class="gs-table-wrap"><table class="gs-table gs-table-stack gs-table-prog" aria-label="Nights in ' + esc(zone.zone) + '"><thead><tr><th scope="col">Night</th><th scope="col">Bosses killed</th><th scope="col">Wipes</th>' +
          '<th scope="col">First pull to last kill</th></tr></thead><tbody>' + nights.map(function (n) { return nightRowHtml(n, ctx.gid, ctx.links); }).join('') + '</tbody></table></div>'
        : '') +
      '</div></section>';
  }

  // data: { zones: [...] } (the Worker's answer, or one entry of the public view's progress section). opts: { gid, links (night dates link to their raid), level (heading level), idPrefix }
  function zonesHtml(data, opts) {
    const o = Object.assign({ gid: null, links: false, level: 2, idPrefix: 'prog' }, opts || {});
    const zones = listOf(data && data.zones);
    if (!zones.length) return '<p class="gs-empty" id="' + o.idPrefix + '-empty">No boss pulls yet. Bosses appear here once a raid with a Warcraft Logs report is added.</p>';
    return zones.map(function (zone, i) { return zoneHtml(zone, i, o); }).join('');
  }

  // The Raids page's Progress tab: opts { gid, data (or null while it loads), error }
  function boardHtml(opts) {
    if (opts.error) return '<p class="gs-alert" role="alert">' + esc(opts.error) + '</p>';
    if (!opts.data) return G.pages.signin.loadingHtml();
    return '<div class="gs-prog-board" id="prog-board">' + zonesHtml(opts.data, { gid: opts.gid, links: true, level: 2, idPrefix: 'prog' }) + '</div>';
  }

  // The read-only view's block for one team (pages-view.js).
  function blockHtml(entry, idPrefix) {
    return zonesHtml(entry, { links: false, level: 4, idPrefix: idPrefix || 'vprog' });
  }

  // Reads the board of the team the Raids list shows. x: the Raids list's state ({ gid, teamId, ... }); stored on x.progress.
  function load(x) {
    if (!x || !x.teamId) return Promise.resolve(null);
    x.progress = { teamId: x.teamId, data: null, error: '' };
    return G.api.progress.get(x.gid, x.teamId).then(function (data) {
      if (x.progress && x.progress.teamId === x.teamId) x.progress.data = data;
      return data;
    }, function (err) {
      if (x.progress && x.progress.teamId === x.teamId) x.progress.error = G.api.classify(err).text;
      return null;
    });
  }

  // The Raids list's section for its state x: '' unless the Progress tab is open.
  function tabHtml(x) {
    if (!x || x.tab !== 'progress') return '';
    const p = x.progress && x.progress.teamId === x.teamId ? x.progress : null;
    return boardHtml({ gid: x.gid, data: p ? p.data : null, error: p ? p.error : '' });
  }

  G.pages.progress = { duration: duration, zonesHtml: zonesHtml, boardHtml: boardHtml, blockHtml: blockHtml, tabHtml: tabHtml, load: load };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
