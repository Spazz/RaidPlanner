// ── PAGE PIECE: THE LOOT CARD OF A RAID (+ the Gargul import panel) ──
// Past raids only. GET /raids/:rid/loot lists the awards; editors re-tag them (PATCH /loot/:aid), add a note, delete one
// (DELETE /loot/:aid) and import a Gargul "Detailed (JSON)" export: the browser parses the text (js/guild/gargul.js), the
// Worker previews it against this raid (POST /raids/:rid/loot/preview, nothing is written) and then commits it
// (POST /raids/:rid/loot). A paste of more than 500 awards goes in several requests of 500. pages-raid.js draws the card
// and loads its data; the state lives in the attendance state bag (a().raidLoot).
(function (G) {
  'use strict';

  const NOTE_MAX = 200;
  const STATUS = {
    new: { label: 'New', cls: 'gs-pill-ok' },
    update: { label: 'Update', cls: 'gs-pill-info' },
    same: { label: 'Same', cls: 'gs-pill-muted' },
    otherRaid: { label: 'Other raid', cls: 'gs-pill-warn' },
    otherDay: { label: 'Other day', cls: 'gs-pill-warn' },
  };
  const COUNT_LABELS = [['new', 'New'], ['update', 'Updated'], ['same', 'Unchanged'], ['otherRaid', 'On other raids'], ['otherDay', 'On other days']];

  function L() { return G.pages.loot; }
  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }

  function freshUi() {
    return { open: false, stage: 'input', text: '', error: '', busy: false, parsed: null, preview: null, includeOtherDay: false, result: null };
  }

  // The state of the card on the open raid page, or null while it is not loaded for that raid.
  function stateFor(gid, rid) {
    const x = a().raidLoot;
    return x && x.gid === gid && x.rid === rid ? x : null;
  }

  // Whether the card offers "Import from Gargul" now (the raid page's More menu offers the same): loaded, allowed to edit, panel not open yet.
  function canImport(x) {
    return !!(x && x.status === 'ok' && x.data && x.data.canEdit && x.ui && !x.ui.open);
  }

  // Whether the card (and the raid page's More menu) offers "Add award" now: loaded and allowed to edit.
  function canAdd(x) {
    return !!(x && x.status === 'ok' && x.data && x.data.canEdit);
  }

  function cur() {
    const gd = currentGd();
    const r = a().raid;
    const x = gd && r ? stateFor(gd.guild.id, r.rid) : null;
    return x && x.status === 'ok' ? { gid: gd.guild.id, gd: gd, rid: r.rid, x: x, raid: r.data && r.data.raid } : null;
  }

  // ── view ──
  function statusChip(status) {
    const s = Object.prototype.hasOwnProperty.call(STATUS, status) ? STATUS[status] : { label: String(status), cls: 'gs-pill-muted' };
    return '<span class="gs-pill ' + s.cls + '">' + esc(s.label) + '</span>';
  }

  // A preview row (the normalized award + status + match + tag) as the award shape the row builder takes.
  function previewAward(row) {
    return {
      id: row.checksum, itemId: row.itemId, itemName: row.itemName, quality: row.quality, awardedAt: row.awardedAt,
      winner: { name: row.winnerName, realm: row.winnerRealm, class: row.winnerClass }, match: row.match, tag: row.tag, tagSetBy: null,
      flags: row.flags, rollType: row.rollType, note: null,
    };
  }

  function skippedHtml(skipped) {
    if (!skipped || !skipped.length) return '';
    return '<details class="gs-how"><summary>' + esc(plural(skipped.length, 'row was', 'rows were')) + ' left out of the paste</summary><ul class="gs-bullets">' + skipped.slice(0, 50).map(function (s) {
      return '<li>' + esc('Row ' + s.index + (s.label ? ' (' + s.label + ')' : '') + ': ' + s.reason) + '</li>';
    }).join('') + (skipped.length > 50 ? '<li>' + esc('And ' + (skipped.length - 50) + ' more.') + '</li>' : '') + '</ul></details>';
  }

  function inputStageHtml(ui) {
    return '<div class="gs-field"><label class="gs-label" for="gl-paste">Gargul export</label>' +
      '<textarea class="gs-input gs-textarea gs-loot-paste" id="gl-paste" name="paste" rows="5" spellcheck="false" autocomplete="off" aria-describedby="gl-help" data-input="loot-paste" data-key="gl-paste">' + esc(ui.text) + '</textarea></div>' +
      '<div class="gs-field"><label class="gs-label" for="gl-file">Or choose the saved file (.json or .txt)</label>' +
      '<input class="gs-input" type="file" id="gl-file" accept=".json,.txt,application/json,text/plain" data-change="loot-file" data-key="gl-file"></div>' +
      '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="loot-preview" data-key="loot-preview"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Reading...' : 'Preview') + '</button>' +
      '<button type="button" class="gs-btn" data-action="loot-import-close" data-key="loot-import-close">Close</button></div>';
  }

  // The Preview step's content (what was read, the counts, the rows); the commit bar below it is previewCommit.
  function previewStageHtml(ui, gd) {
    const p = ui.preview || { rows: [], counts: {} };
    const counts = p.counts || {};
    const parsed = ui.parsed || { awards: [], skipped: [], rows: 0 };
    const other = counts.otherDay > 0
      ? '<div class="gs-check"><input type="checkbox" id="gl-other" data-change="loot-other" data-key="gl-other"' + (ui.includeOtherDay ? ' checked' : '') + '><label for="gl-other">Include ' + esc(plural(counts.otherDay, 'award', 'awards')) + ' from other days</label></div>' : '';
    const summary = '<dl class="gs-summary">' + COUNT_LABELS.map(function (c) {
      return '<div class="gs-summary-item"><dt>' + esc(c[1]) + '</dt><dd>' + esc(counts[c[0]] || 0) + '</dd></div>';
    }).join('') + '</dl>';
    const rows = (Array.isArray(p.rows) ? p.rows : []).map(function (row) {
      return L().awardRowHtml(gd, previewAward(row), { when: 'datetime', status: statusChip(row.status) });
    }).join('');
    return '<p class="gs-fine" id="gl-read">' + esc(plural(parsed.awards.length, 'award', 'awards') + ' read from ' + plural(parsed.rows, 'row', 'rows') + '.') + '</p>' + skippedHtml(parsed.skipped) + summary + other +
      '<div class="gs-loot-preview" data-scroll-key="loot-preview"><ul class="gs-loot-list" aria-label="Preview of the import">' + rows + '</ul></div>';
  }

  // The T5 commit bar of the Gargul preview: how many awards will be imported, Back (keeps the paste), Close, and the Primary.
  function previewCommit(ui) {
    const counts = (ui.preview && ui.preview.counts) || {};
    const importable = (counts.new || 0) + (counts.update || 0) + (ui.includeOtherDay ? counts.otherDay || 0 : 0);
    return {
      text: importable > 0 ? plural(importable, 'award', 'awards') + ' will be imported.' : 'There is nothing new to import.',
      back: { attrs: { 'data-action': 'loot-back', 'data-key': 'loot-back' } }, cancel: { label: 'Close', attrs: { 'data-action': 'loot-import-close', 'data-key': 'loot-import-close' } },
      commit: { label: ui.busy ? 'Importing...' : 'Import ' + plural(importable, 'award', 'awards'), disabled: !(importable > 0 && !ui.busy), attrs: { 'data-action': 'loot-commit', 'data-key': 'loot-commit' } },
    };
  }

  function resultLine(r) {
    const parts = [];
    if (r.inserted) parts.push(plural(r.inserted, 'new award', 'new awards'));
    if (r.updated) parts.push(plural(r.updated, 'update', 'updates'));
    let text = parts.length ? 'Imported ' + parts.join(' and ') + '.' : 'Nothing new was imported.';
    if (r.unchanged) text += ' ' + plural(r.unchanged, 'was', 'were') + ' already here.';
    if (r.skippedOtherRaid) text += ' ' + plural(r.skippedOtherRaid, 'award', 'awards') + ' on other raids ' + (r.skippedOtherRaid === 1 ? 'was' : 'were') + ' left out.';
    if (r.skippedOtherDay) text += ' ' + plural(r.skippedOtherDay, 'award', 'awards') + ' from other days ' + (r.skippedOtherDay === 1 ? 'was' : 'were') + ' left out.';
    return text;
  }

  // The Gargul import is the T5 flow inside the raid's Loot card: Source (paste or file), Preview (the awards against this raid, commit bar), Import (inline result).
  function importPanelHtml(ui, gd) {
    return G.ui.importPanelHtml({
      id: 'gl-title', title: 'Import from Gargul', step: ui.stage === 'preview' ? 'preview' : (ui.stage === 'done' ? 'result' : 'source'),
      helpHtml: '<p class="gs-fine" id="gl-help">In game, open /gl export, choose "Detailed (JSON)" in its settings, and copy the text. Paste it here or pick the saved file. Everything goes to this raid; awards from other days are listed and left out unless you include them.</p>',
      alertHtml: G.ui.alertHtml(ui.error, 'gl-error'),
      sourceHtml: inputStageHtml(ui), previewHtml: ui.stage === 'preview' ? previewStageHtml(ui, gd) : '',
      resultHtml: ui.stage === 'done' ? G.ui.importResultHtml({ id: 'gl-result', title: resultLine(ui.result || {}), next: [
        { label: 'Import another export', attrs: { 'data-action': 'loot-back', 'data-key': 'loot-again' } }, { label: 'Close', attrs: { 'data-action': 'loot-import-close', 'data-key': 'loot-import-close' } }] }) : '',
      commit: ui.stage === 'preview' ? previewCommit(ui) : null,
    });
  }

  // The post-raid Loot card is a summary: the counts by tag and the first few awards (read-only), with a link to the night's loot page where awards are changed.
  const SUMMARY_ROWS = 5;
  function summaryHtml(gd, awards, rid) {
    const gid = gd.guild.id;
    const counts = L().TAGS.map(function (t) {
      return [t, awards.filter(function (w) { return w.tag === t; }).length];
    }).filter(function (c) { return c[1] > 0; });
    const countLine = '<p class="gs-fine" id="loot-counts">' + counts.map(function (c) { return esc(c[1] + ' ' + L().TAG_LABELS[c[0]]); }).join(' &middot; ') + '</p>';
    const rows = awards.slice(0, SUMMARY_ROWS).map(function (w) {
      return '<li class="gs-loot-subrow"><span class="gs-loot-item">' + L().itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + '</span>' +
        '<span class="gs-loot-who">' + L().winnerHtml(gid, w.winner, w.match) + '</span>' + L().tagChipHtml(w.tag, w.tagSetBy) + '</li>';
    }).join('');
    const more = awards.length > SUMMARY_ROWS ? '<p class="gs-fine">' + esc('And ' + (awards.length - SUMMARY_ROWS) + ' more.') + '</p>' : '';
    return countLine + '<ul class="gs-loot-sublist" aria-label="Loot awarded on this raid">' + rows + '</ul>' + more +
      '<p><a class="gs-btn gs-btn-sm" id="loot-open-night" href="' + esc(G.router.format({ name: 'lootnight', gid: gid, rid: rid })) + '">Open the night\'s loot</a></p>';
  }

  // opts: { guildData, data (the raid detail), state (stateFor) }
  function cardHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    if (x && x.status === 'denied') return deniedCardHtml();
    if (x && x.status === 'error') return errorCardHtml(x);
    if (!x || x.status !== 'ok' || !x.data) return '';
    const gid = gd.guild.id;
    const awards = Array.isArray(x.data.awards) ? x.data.awards : [];
    const edit = !!x.data.canEdit;
    const teamId = idOf(opts.data.raid.team);
    const unmatched = awards.filter(function (w) { return w.match && w.match.kind === 'unmatched'; }).length;
    const review = L().allows(gd, 'attendance.review', teamId);
    const head = '<div class="gs-card-sec-head"><h2 class="gs-h2" id="loot-h">Loot awards</h2><span class="gs-head-tools"><span class="gs-fine">' + esc(plural(awards.length, 'item', 'items')) + '</span>' +
      (canImport(x) ? '<button type="button" class="gs-btn gs-btn-sm" data-action="loot-import-open" data-key="loot-import-open">Import from Gargul</button>' : '') +
      (canAdd(x) ? '<button type="button" class="gs-btn gs-btn-sm" data-action="loot-add-open" data-key="loot-add-open">Add award</button>' : '') + '</span></div>';
    const list = awards.length ? summaryHtml(gd, awards, opts.data.raid.id) : '<p class="gs-empty">' + (edit ? 'No loot is recorded for this raid yet. Import a Gargul export to add it, or add an award by hand.' : 'No loot is recorded for this raid yet.') + '</p>';
    const note = unmatched > 0
      ? '<div class="gs-notice" role="status"><span>' + esc(plural(unmatched, 'award goes', 'awards go')) + ' to a winner who is not on the roster. ' + (review ? 'Link them in the Review queue so the loot counts for the right person.' : 'An officer can link them.') + '</span>' +
        (review ? '<a class="gs-btn gs-btn-sm" href="' + esc(G.router.format({ name: 'review', gid: gid })) + '">Review queue</a>' : '') + '</div>' : '';
    return '<section class="gs-card-sec gs-loot-sec" aria-labelledby="loot-h">' + head + '<div class="gs-card-sec-body">' +
      (edit && x.ui.open ? importPanelHtml(x.ui, gd) : '') + note + list + '</div></section>';
  }

  // ── data ──
  // Opening the raid page starts the import panel afresh (closed, nothing pasted, no old result). Only the card's own "Try again"
  // (opts.keepUi) keeps the panel the officer was working in while the awards load again.
  function loadFor(gd, detail, opts) {
    const gid = gd.guild.id;
    const raid = detail && detail.raid;
    if (!raid || raid.upcoming) { a().raidLoot = { gid: gid, rid: raid && raid.id, status: 'none' }; return Promise.resolve(null); }
    const prev = a().raidLoot;
    const keep = !!(opts && opts.keepUi) && prev && prev.gid === gid && prev.rid === raid.id && prev.ui;
    const ui = keep ? prev.ui : freshUi();
    return G.api.loot.raid(gid, raid.id).then(function (res) {
      a().raidLoot = { gid: gid, rid: raid.id, status: 'ok', data: res, ui: ui };
      return null;
    }, function (err) {
      // 403: the loot policy hides it from this viewer (a note). 404: nothing to show. Anything else shows a retry.
      if (err && err.status === 403) { a().raidLoot = { gid: gid, rid: raid.id, status: 'denied' }; return null; }
      if (err && err.status === 404) { a().raidLoot = { gid: gid, rid: raid.id, status: 'none' }; return null; }
      a().raidLoot = { gid: gid, rid: raid.id, status: 'error', error: G.api.classify(err).text, ui: ui };
      return null;
    });
  }

  // can['loot.view'] does not say who sees loot (the loot policy decides on the Worker), so a 403 is told here, not guessed before.
  function deniedCardHtml() {
    return '<section class="gs-card-sec gs-loot-sec" aria-labelledby="loot-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="loot-h">Loot awards</h2></div><div class="gs-card-sec-body">' +
      '<p class="gs-fine">You can\'t see this team\'s loot.</p></div></section>';
  }

  function errorCardHtml(x) {
    return '<section class="gs-card-sec gs-loot-sec" aria-labelledby="loot-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="loot-h">Loot awards</h2></div><div class="gs-card-sec-body">' +
      G.ui.alertHtml(x.error || 'Could not load the loot.', 'loot-load-error') +
      '<div><button type="button" class="gs-btn gs-btn-sm" data-action="loot-reload" data-key="loot-reload">Try again</button></div></div></section>';
  }

  function replaceAward(x, award) {
    if (!award || !x.data || !Array.isArray(x.data.awards)) return;
    x.data.awards = x.data.awards.map(function (w) { return w.id === award.id ? award : w; });
  }

  function fail(err) { G.app.handleError(err, { pageAlert: true }); }

  function reloadAwards(c) {
    return G.api.loot.raid(c.gid, c.rid).then(function (res) { c.x.data = res; }, function () { /* the old list stays */ });
  }

  // ── import ──
  function pastedText() {
    const el = typeof document !== 'undefined' ? document.getElementById('gl-paste') : null;
    return el && typeof el.value === 'string' ? el.value : null;
  }

  function readFile(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file);
    });
  }

  // Posts the awards in requests of at most 500 (the Worker's limit), in order, and merges the answers. A refused request
  // carries the position of its first award (err.chunkStart) so the row the Worker names can be found again.
  function inChunks(awards, send, merge, start) {
    let offset = 0;
    return G.gargul.chunk(awards, G.gargul.MAX_PER_REQUEST).reduce(function (chain, part) {
      const at = offset;
      offset += part.length;
      return chain.then(function (acc) {
        return send(part).then(function (res) { return merge(acc, res); }, function (err) { if (err && typeof err === 'object') err.chunkStart = at; throw err; });
      });
    }, Promise.resolve(start));
  }

  // The Worker refuses a request for one bad award (400 with the award's index in that request): name the row of the paste.
  function describeError(err, parsed) {
    const base = G.api.classify(err).text;
    const index = err && typeof err.index === 'number' && err.field === 'awards' ? err.index + (err.chunkStart || 0) : -1;
    if (!parsed || index < 0 || index >= parsed.awards.length) return base;
    const award = parsed.awards[index];
    const row = parsed.awardRows && parsed.awardRows[index];
    const who = award.winnerName ? ' to ' + award.winnerName : ' (disenchanted)';
    const label = (award.itemName || 'item ' + award.itemId) + who;
    return 'Row ' + (row || index + 1) + ' of the paste (' + label + ') was refused: ' + base.replace(/^Award \d+: /, '');
  }

  function mergePreview(acc, res) {
    const counts = Object.assign({}, acc.counts);
    Object.keys(res && res.counts ? res.counts : {}).forEach(function (k) { counts[k] = (counts[k] || 0) + (Number(res.counts[k]) || 0); });
    return { rows: acc.rows.concat(Array.isArray(res && res.rows) ? res.rows : []), counts: counts };
  }

  function mergeCommit(acc, res) {
    const r = res || {};
    return {
      inserted: acc.inserted + (r.inserted || 0), updated: acc.updated + (r.updated || 0), unchanged: acc.unchanged + (r.unchanged || 0),
      skippedOtherRaid: acc.skippedOtherRaid + (r.skippedOtherRaid || 0), skippedOtherDay: acc.skippedOtherDay + (r.skippedOtherDay || 0),
    };
  }

  G.handlers.click['loot-reload'] = function () {
    const gd = currentGd();
    const r = a().raid;
    if (!gd || !r) return;
    loadFor(gd, r.data, { keepUi: true }).then(function () { G.app.render(); });
  };

  G.handlers.click['loot-import-open'] = function () {
    const c = cur();
    if (!c) return;
    c.x.ui = freshUi();
    c.x.ui.open = true;
    G.app.render();
    G.ui.focusByKey('gl-paste');
  };

  G.handlers.click['loot-import-close'] = function () {
    const c = cur();
    if (!c) return;
    c.x.ui = freshUi();
    G.app.render();
    G.ui.focusByKey('loot-import-open');
  };

  G.handlers.click['loot-back'] = function () {
    const c = cur();
    if (!c) return;
    const open = freshUi();
    open.open = true;
    c.x.ui = open;
    G.app.render();
  };

  G.handlers.input['loot-paste'] = function (el) {
    const c = cur();
    if (c) c.x.ui.text = String(el.value || '');
  };

  G.handlers.change['loot-file'] = function (el) {
    const c = cur();
    const file = el && el.files && el.files[0];
    if (!c || !file) return;
    const ui = c.x.ui;
    if (file.size > G.gargul.MAX_FILE_CHARS) { ui.error = 'That file is larger than 8 MB. Export fewer dates in Gargul and try again.'; G.app.render(); return; }
    readFile(file).then(function (text) {
      ui.text = text;
      ui.error = '';
      G.app.render();
    }, function () { ui.error = 'Could not read that file.'; G.app.render(); });
  };

  G.handlers.click['loot-preview'] = function () {
    const c = cur();
    if (!c || c.x.ui.busy) return;
    const ui = c.x.ui;
    const live = pastedText();
    if (live != null) ui.text = live;
    const parsed = G.gargul.parse(ui.text, { surname: c.gd.guild.gameVersion === 'forever' });
    if (!parsed.ok) { ui.error = parsed.error; G.app.render(); return; }
    if (!parsed.awards.length) {
      ui.error = parsed.rows ? 'None of the ' + plural(parsed.rows, 'row', 'rows') + ' can be imported.' + (parsed.skipped.length ? ' First problem: ' + parsed.skipped[0].reason + '.' : '') : 'The export holds no awards.';
      G.app.render();
      return;
    }
    ui.busy = true;
    ui.error = '';
    G.app.render();
    inChunks(parsed.awards, function (part) { return G.api.loot.preview(c.gid, c.rid, part); }, mergePreview, { rows: [], counts: {} }).then(function (preview) {
      ui.busy = false;
      ui.parsed = parsed;
      ui.preview = preview;
      ui.stage = 'preview';
      ui.text = '';
      G.app.render();
    }, function (err) {
      ui.busy = false;
      ui.error = describeError(err, parsed);
      G.app.render();
    });
  };

  G.handlers.change['loot-other'] = function (el) {
    const c = cur();
    if (!c) return;
    c.x.ui.includeOtherDay = !!el.checked;
    G.app.render();
  };

  G.handlers.click['loot-commit'] = function () {
    const c = cur();
    if (!c || c.x.ui.busy || !c.x.ui.parsed) return;
    const ui = c.x.ui;
    ui.busy = true;
    ui.error = '';
    G.app.render();
    const include = !!ui.includeOtherDay;
    const start = { inserted: 0, updated: 0, unchanged: 0, skippedOtherRaid: 0, skippedOtherDay: 0 };
    inChunks(ui.parsed.awards, function (part) { return G.api.loot.commit(c.gid, c.rid, part, include); }, mergeCommit, start).then(function (result) {
      return reloadAwards(c).then(function () {
        ui.busy = false;
        ui.result = result;
        ui.stage = 'done';
        ui.parsed = null;
        ui.preview = null;
        G.app.render();
      });
    }, function (err) {
      // Some chunks may have been written: show what is on the raid now and say the import stopped.
      return reloadAwards(c).then(function () {
        ui.busy = false;
        ui.error = describeError(err, ui.parsed) + ' The import stopped; check the list below and run it again if awards are missing.';
        G.app.render();
      });
    });
  };

  // ── per-award edits ──
  // ── add an award by hand (PM wave 5) ──
  const ADD_TAGS = ['MS', 'OS', 'DE', 'BANK'];

  // The names of the raid team's roster (any character of any person there), for the winner box's suggestions. [] when the roster cannot be read.
  function rosterNames(gid, teamId) {
    return G.api.teamRoster(gid, teamId).then(function (res) {
      const seen = {};
      (res && Array.isArray(res.people) ? res.people : []).forEach(function (p) {
        (Array.isArray(p.names) ? p.names : []).concat([p.shown && p.shown.name, p.main && p.main.name]).forEach(function (n) { if (typeof n === 'string' && n) seen[n] = true; });
      });
      return Object.keys(seen).sort(function (x, y) { return x.localeCompare(y, 'en'); });
    }, function () { return []; });
  }

  function addDialogHtml(names) {
    const tags = ADD_TAGS.map(function (t) { return '<option value="' + t + '"' + (t === 'MS' ? ' selected' : '') + '>' + esc(L().TAG_NAMES[t]) + '</option>'; }).join('');
    return '<form class="gs-dialog-form" data-submit="loot-add-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Add a loot award</h2>' +
      '<p class="gs-fine" id="dlg-help">For an item that was handed out without Gargul. It counts in the balance like any other award.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-item">Item (id or Wowhead link)</label><input class="gs-input" type="text" id="dlg-item" name="itemRef" autocomplete="off" spellcheck="false" data-field="itemId" aria-describedby="dlg-help">' +
      '<p class="gs-field-error" id="dlg-err-itemId" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-itemname">Item name (optional)</label><input class="gs-input" type="text" id="dlg-itemname" name="itemName" maxlength="100" autocomplete="off" data-field="itemName">' +
      '<p class="gs-field-error" id="dlg-err-itemName" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-winner">Winner</label><input class="gs-input" type="text" id="dlg-winner" name="winner" list="dlg-winners" autocomplete="off" spellcheck="false" data-field="winnerName" aria-describedby="dlg-winner-help">' +
      '<datalist id="dlg-winners">' + names.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('') + '</datalist>' +
      '<p class="gs-fine" id="dlg-winner-help">Pick a roster character or type any name; a name that is not on the roster goes to the Review queue. Leave it empty for an item nobody won (tag it Disenchanted).</p>' +
      '<p class="gs-field-error" id="dlg-err-winnerName" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-tag">Tag</label><select class="gs-input" id="dlg-tag" name="tag" data-field="tag">' + tags + '</select>' +
      '<p class="gs-field-error" id="dlg-err-tag" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-note">Note (optional, up to ' + NOTE_MAX + ' characters)</label><input class="gs-input" type="text" id="dlg-note" name="note" maxlength="' + NOTE_MAX + '" autocomplete="off" data-field="note">' +
      '<p class="gs-field-error" id="dlg-err-note" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Add award</button></div></form>';
  }

  G.handlers.click['loot-add-open'] = function () {
    const c = cur();
    if (!c || !canAdd(c.x) || !c.raid) return;
    rosterNames(c.gid, idOf(c.raid.team)).then(function (names) {
      if (!G.ui.openDialog(addDialogHtml(names), { labelledBy: 'dlg-title', describedBy: 'dlg-help' })) return;
      const input = document.getElementById('dlg-item');
      if (input) input.focus();
    });
  };

  G.handlers.submit['loot-add-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const field = function (name) { return String(form.elements[name].value || '').trim(); };
    ['itemId', 'itemName', 'winnerName', 'tag', 'note'].forEach(function (f) { G.ui.setText('dlg-err-' + f, ''); });
    const ref = G.gargul.parseItemRef(field('itemRef'));
    if (!ref) { G.ui.setText('dlg-err-itemId', 'Enter the item id (a number), or paste its Wowhead link.'); form.elements.itemRef.focus(); return; }
    const tag = field('tag');
    const winner = field('winner');
    if (!winner && tag !== 'DE') { G.ui.setText('dlg-err-winnerName', 'Pick the winner, or tag the item Disenchanted when nobody won it.'); form.elements.winner.focus(); return; }
    const note = field('note');
    if (note.length > NOTE_MAX) { G.ui.setText('dlg-err-note', 'Keep the note to ' + NOTE_MAX + ' characters.'); form.elements.note.focus(); return; }
    const body = { itemId: ref.itemId, tag: tag };
    const name = field('itemName') || ref.itemName;
    if (name) body.itemName = name;
    if (winner) body.winnerName = winner;
    if (note) body.note = note;
    G.ui.runDialog(form, G.api.loot.manual(c.gid, c.rid, body), function (res) {
      if (res && res.award && c.x.data && Array.isArray(c.x.data.awards)) c.x.data.awards = c.x.data.awards.concat([res.award]);
      st().pageAlert = '';
      G.app.render();
      if (G.pages.raidBoard && G.pages.raidBoard.refresh) G.pages.raidBoard.refresh(); // the board compares what was awarded with who was in line
    });
  };

  G.handlers.change['loot-tag'] = function (sel) {
    const c = cur();
    if (!c) return;
    sel.disabled = true;
    G.api.loot.update(c.gid, sel.getAttribute('data-aid'), { tag: sel.value }).then(function (res) {
      replaceAward(c.x, res && res.award);
      st().pageAlert = '';
      G.app.render();
    }, function (err) { fail(err); });
  };

  function awardOf(c, aid) {
    return (c.x.data.awards || []).filter(function (w) { return w.id === aid; })[0] || null;
  }

  G.handlers.click['loot-note'] = function (el) {
    const c = cur();
    const award = c ? awardOf(c, el.getAttribute('data-aid')) : null;
    if (!award) return;
    G.ui.openDialog('<form class="gs-dialog-form" data-submit="loot-note-form" data-aid="' + esc(award.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Note on ' + esc(award.itemName || 'this award') + '</h2>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-note">Note (optional, up to ' + NOTE_MAX + ' characters)</label><input class="gs-input" type="text" id="dlg-note" name="note" maxlength="' + NOTE_MAX + '" autocomplete="off" data-field="note" value="' + esc(award.note || '') + '">' +
      '<p class="gs-field-error" id="dlg-err-note" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save note</button></div></form>', { labelledBy: 'dlg-title' });
    const input = document.getElementById('dlg-note');
    if (input) input.focus();
  };

  G.handlers.submit['loot-note-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const note = String(form.elements.note.value || '').trim();
    G.ui.setText('dlg-err-note', '');
    if (note.length > NOTE_MAX) { G.ui.setText('dlg-err-note', 'Keep the note to ' + NOTE_MAX + ' characters.'); form.elements.note.focus(); return; }
    G.ui.runDialog(form, G.api.loot.update(c.gid, form.getAttribute('data-aid'), { note: note }), function (res) {
      replaceAward(c.x, res && res.award);
      st().pageAlert = '';
      G.app.render();
    });
  };

  // The confirm dialog for deleting an award (the raid night and person pages use it too, with their own submit handler).
  function deleteDialogHtml(award, submit) {
    return '<form class="gs-dialog-form" data-submit="' + esc(submit || 'loot-delete-form') + '" data-aid="' + esc(award.id) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Delete this award?</h2>' +
      '<p class="gs-confirm-text" id="dlg-text">' + esc((award.itemName || 'This item') + (L().isDisenchanted(award) ? ' (disenchanted)' : ' awarded to ' + L().winnerText(award.winner))) + ' is removed from the raid and from the balance.' + (award.manual ? '' : ' Importing the same Gargul export again asks before it adds it back.') + '</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Delete award</button></div></form>';
  }

  G.handlers.click['loot-delete'] = function (el) {
    const c = cur();
    const award = c ? awardOf(c, el.getAttribute('data-aid')) : null;
    if (!award) return;
    G.ui.openDialog(deleteDialogHtml(award), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['loot-delete-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const aid = form.getAttribute('data-aid');
    G.ui.runDialog(form, G.api.loot.remove(c.gid, aid), function () {
      c.x.data.awards = (c.x.data.awards || []).filter(function (w) { return w.id !== aid; });
      st().pageAlert = '';
      G.app.render();
    });
  };

  G.pages.raidLoot = {
    STATUS: STATUS,
    stateFor: stateFor,
    canImport: canImport,
    canAdd: canAdd,
    cardHtml: cardHtml,
    addDialogHtml: addDialogHtml,
    deleteDialogHtml: deleteDialogHtml,
    summaryHtml: summaryHtml,
    importPanelHtml: importPanelHtml,
    resultLine: resultLine,
    previewAward: previewAward,
    mergePreview: mergePreview,
    mergeCommit: mergeCommit,
    describeError: describeError,
    freshUi: freshUi,
    loadFor: loadFor,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
