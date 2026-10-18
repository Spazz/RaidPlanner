// ── BUFF AND DEBUFF COVERAGE OF A PLANNED ROSTER (intent board, recruitment needs) ──
// The Planner's own rules, reached through js/analysis.js rosterBuffCoverage(roster, gameVersion, raidSize): the roster is laid out the way Optimize would
// lay it out and read with the functions the coverage rail uses. The guild page loads the Planner's scripts, so the function is there; where it is
// not (a page without them) every call answers null and the panels say coverage is not available.
//   G.coverage.compute(gameVersion, specs, raidSize) -> coverage | null     specs: [{ class, spec }] in the guild's spec labels
//   G.coverage.summary(coverage) -> { buffs, buffsTotal, debuffs, debuffsTotal, missing }
//   G.coverage.missingByClass(coverage) -> [{ class, names: [..] }]          what each class would add
//   G.coverage.panelHtml(coverage, opts) -> the card; opts: { id, heading, intro }
(function (G) {
  'use strict';

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function compute(gameVersion, specs, raidSize) {
    if (typeof rosterBuffCoverage !== 'function') return null;
    try {
      return rosterBuffCoverage(Array.isArray(specs) ? specs : [], gameVersion, raidSize);
    } catch (e) {
      return null;
    }
  }

  function summary(cov) {
    const c = cov || { buffs: [], debuffs: [] };
    const buffs = c.buffs.filter(function (b) { return b.covered; }).length;
    const debuffs = c.debuffs.filter(function (d) { return d.covered; }).length;
    return { buffs: buffs, buffsTotal: c.buffs.length, debuffs: debuffs, debuffsTotal: c.debuffs.length, missing: (c.buffs.length - buffs) + (c.debuffs.length - debuffs) };
  }

  // The missing buffs and debuffs grouped by the class that casts them, in class order of first appearance.
  function missingByClass(cov) {
    const order = [];
    const byClass = {};
    ((cov && cov.buffs) || []).concat((cov && cov.debuffs) || []).forEach(function (entry) {
      if (entry.covered || !entry.sourceClass) return;
      if (!byClass[entry.sourceClass]) { byClass[entry.sourceClass] = []; order.push(entry.sourceClass); }
      if (byClass[entry.sourceClass].indexOf(entry.name) < 0) byClass[entry.sourceClass].push(entry.name);
    });
    return order.map(function (id) { return { class: id, names: byClass[id] }; });
  }

  function rowHtml(entry) {
    const who = entry.sourceClass ? G.ui.className(entry.sourceClass) + (entry.sourceSpec ? ' (' + entry.sourceSpec + ')' : '') : '';
    return '<li class="gs-cov-item"><span class="gs-pill gs-pill-' + (entry.covered ? 'ok' : 'warn') + '">' + (entry.covered ? 'Covered' : 'Missing') + '</span>' +
      '<span class="gs-cov-name">' + esc(entry.name) + '</span>' + (who ? '<span class="gs-fine">' + esc(who) + '</span>' : '') + '</li>';
  }

  function listHtml(label, entries) {
    // Missing first: they are what the reader is looking for.
    const sorted = entries.filter(function (e) { return !e.covered; }).concat(entries.filter(function (e) { return e.covered; }));
    return '<div class="gs-cov-col"><h3 class="gs-h3">' + esc(label) + '</h3>' +
      (sorted.length ? '<ul class="gs-cov-list" aria-label="' + esc(label) + '">' + sorted.map(rowHtml).join('') + '</ul>' : '<p class="gs-empty">None for this game version.</p>') + '</div>';
  }

  // opts: { id (default 'cov'), heading, intro }. cov null: the card says coverage is not available; cov.seated 0: it says nobody is planned yet.
  function panelHtml(cov, opts) {
    const o = opts || {};
    const id = o.id || 'cov';
    const heading = o.heading || 'Buffs and debuffs';
    const head = '<div class="gs-card-sec-head"><h2 class="gs-h2" id="' + esc(id) + '-h">' + esc(heading) + '</h2>';
    if (!cov) {
      return '<section class="gs-card-sec gs-cov" aria-labelledby="' + esc(id) + '-h">' + head + '</div><div class="gs-card-sec-body"><p class="gs-fine">Buff coverage is not available for this game version here.</p></div></section>';
    }
    if (!cov.seated) {
      return '<section class="gs-card-sec gs-cov" aria-labelledby="' + esc(id) + '-h">' + head + '</div><div class="gs-card-sec-body"><p class="gs-empty">Nobody is planned yet, so nothing is covered.</p></div></section>';
    }
    const s = summary(cov);
    return '<section class="gs-card-sec gs-cov" aria-labelledby="' + esc(id) + '-h">' + head +
      '<span class="gs-fine">' + esc(s.buffs + ' of ' + s.buffsTotal + ' buffs, ' + s.debuffs + ' of ' + s.debuffsTotal + ' debuffs') + '</span></div>' +
      '<div class="gs-card-sec-body">' + (o.intro ? '<p class="gs-fine">' + esc(o.intro) + '</p>' : '') +
      '<div class="gs-cov-cols">' + listHtml('Raid buffs', cov.buffs) + listHtml('Raid debuffs', cov.debuffs) + '</div>' +
      '<p class="gs-fine">Read with the Planner\'s rules for ' + esc(G.ui.gameVersionLabel(cov.gameVersion)) + ', the ' + esc(plural(cov.seated, 'player', 'players')) +
      ' arranged the way Optimize would arrange them.</p></div></section>';
  }

  G.coverage = { compute: compute, summary: summary, missingByClass: missingByClass, panelHtml: panelHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
