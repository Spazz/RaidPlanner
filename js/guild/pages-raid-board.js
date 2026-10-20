// ── PAGE PIECE: THE LOOT PRIOS OF A RAID (+ the TMB / softres paste panels) ──
// Upcoming and past raids. GET /raids/:rid/loot-board lines the raid's pasted ThatsMyBIS (TMB) prios and softres.it soft-reserves up against the people
// expected on the raid: one row per item with who is in line (prio order first, then soft-reserve holders and pugs), roll-offs marked, items a player
// already got on an earlier raid greyed out, and, once the raid is over, where each award went. Editors (loot.edit) paste the export text: the browser
// decodes and normalizes it (js/guild/tmb.js, softres.js), the Worker keeps the rows (PUT /raids/:rid/loot-lists, a paste replaces that source's rows).
// pages-raid.js draws the side summary (summaryHtml: what was pasted, Remove, the paste buttons), the item list in the main column (listHtml, only once something
// is pasted) and, while a paste is open, panelHtml at the top of the main column, and loads the data; the state lives in the attendance state bag (a().raidBoard).
(function (G) {
  'use strict';

  const LISTS = {
    tmb: {
      short: 'TMB prios', paste: 'Paste TMB prios', parser: 'tmb', name: 'ThatsMyBIS',
      help: 'On ThatsMyBIS open the Gargul export ("Export Gargul") and copy the text. Paste it here or pick the saved file. Prios and wishlists are kept for this raid; pasting again replaces them.',
    },
    softres: {
      short: 'Soft-reserves', paste: 'Paste soft-reserves', parser: 'softres', name: 'softres.it',
      help: 'On softres.it open the raid, use "Gargul Export" and copy the text. Paste it here or pick the saved file. Pasting again replaces the soft-reserves of this raid.',
    },
  };
  const LIST_KEYS = ['tmb', 'softres'];
  const RESULT_TEXT = { top: 'Went to prio #1', topSr: 'Went to a soft-reserve holder', lower: 'Went to a lower prio', elsewhere: 'Went elsewhere', disenchanted: 'Disenchanted' };

  function L() { return G.pages.loot; }
  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }

  function freshUi() { return { list: null, stage: 'input', text: '', error: '', busy: false, parsed: null, note: '' }; }
  function freshView() { return { contested: false, player: '' }; }

  // The state of the card on the open raid page, or null while it is not loaded for that raid.
  function stateFor(gid, rid) {
    const x = a().raidBoard;
    return x && x.gid === gid && x.rid === rid ? x : null;
  }

  function canEdit(x) { return !!(x && x.status === 'ok' && x.data && x.data.canEdit); }

  // Whether the summary offers "Paste TMB prios" / "Paste soft-reserves" now: loaded, allowed to edit, that panel not open yet.
  function canPaste(x, list) { return canEdit(x) && !!x.ui && x.ui.list !== list; }

  function cur() {
    const gd = currentGd();
    const r = a().raid;
    const x = gd && r ? stateFor(gd.guild.id, r.rid) : null;
    return x && x.status === 'ok' ? { gid: gd.guild.id, gd: gd, rid: r.rid, x: x, raid: r.data && r.data.raid } : null;
  }

  // ── what the board shows ──
  // The items the filters leave: view = { contested, player (a name key, '' = everyone) }.
  function visibleItems(data, view) {
    const v = view || freshView();
    return (Array.isArray(data.items) ? data.items : []).filter(function (item) {
      if (v.contested && !item.contested) return false;
      if (v.player && !item.line.some(function (e) { return e.nameKey === v.player; })) return false;
      return true;
    });
  }

  // Everyone in line for anything: [{ key (name key), name }] by name.
  function playersOf(data) {
    const seen = {};
    (Array.isArray(data.items) ? data.items : []).forEach(function (item) {
      item.line.forEach(function (e) { if (!has(seen, e.nameKey)) seen[e.nameKey] = e.name; });
    });
    return Object.keys(seen).map(function (k) { return { key: k, name: seen[k] }; }).sort(function (x, y) { return x.name.localeCompare(y.name, 'en'); });
  }

  function entryLabel(e) {
    if (e.kind === 'sr') return e.copies > 1 ? 'SR x' + e.copies : 'SR';
    const n = e.prio === null || e.prio === undefined ? '' : ' #' + e.prio;
    return (e.kind === 'wish' ? 'Wish' : 'Prio') + n;
  }

  function entryHtml(e) {
    const cls = 'gs-board-entry' + (e.received ? ' is-received' : '') + (e.top && !e.received ? ' is-top' : '') + (e.kind === 'wish' ? ' is-wish' : '');
    return '<li class="' + cls + '"><span class="gs-board-tag">' + esc(entryLabel(e)) + '</span> ' + G.ui.classNameHtml(e.name, e.class) +
      (e.guest ? ' <span class="gs-hd-chip is-grey">Guest</span>' : '') +
      (e.received ? ' <span class="gs-hd-chip is-grey">Already got it</span>' : '') + '</li>';
  }

  function resultText(r) {
    if (r.result === 'top') return r.kind === 'sr' ? RESULT_TEXT.topSr : RESULT_TEXT.top;
    return RESULT_TEXT[r.result] || '';
  }

  function resultsHtml(item) {
    if (!item.results || !item.results.length) return '';
    return '<ul class="gs-board-results" aria-label="Where it went">' + item.results.map(function (r) {
      const good = r.result === 'top' || r.result === 'disenchanted';
      return '<li class="' + (good ? 'is-match' : 'is-miss') + '">' + esc(resultText(r)) + (r.winner ? ': ' + esc(r.winner) : '') + '</li>';
    }).join('') + '</ul>';
  }

  function rowHtml(gd, item) {
    const flags = (item.contested ? '<span class="gs-hd-chip is-grey">Roll-off</span>' : '') + (item.done ? '<span class="gs-hd-chip is-grey">All have it</span>' : '');
    const omitted = item.omitted > 0 ? '<span class="gs-fine">' + esc(plural(item.omitted, 'more is', 'more are')) + ' in line but not on this raid.</span>' : '';
    return '<li class="gs-board-row' + (item.contested ? ' is-contested' : '') + (item.done ? ' is-done' : '') + '" id="board-' + esc(item.itemId) + '">' +
      '<div class="gs-board-item">' + L().itemHtml({ itemId: item.itemId, itemName: item.itemName, quality: null }, gd.guild.gameVersion) + flags + '</div>' +
      '<ol class="gs-board-line" aria-label="In line">' + item.line.map(entryHtml).join('') + '</ol>' + omitted + resultsHtml(item) + '</li>';
  }

  // One summary line per list: what was pasted when (with Remove for an editor), or "not pasted".
  function sourceLineHtml(data, k, edit) {
    const l = (data.lists || {})[k];
    if (!l) return '<p class="gs-rpl-line">' + esc(LISTS[k].short + ': not pasted') + '</p>';
    const remove = edit
      ? '<button type="button" class="gs-btn gs-btn-sm" data-action="board-remove" data-list="' + k + '" data-key="board-remove-' + k + '" aria-label="Remove the ' + esc(LISTS[k].short) + ' of this raid">Remove</button>' : '';
    return '<div class="gs-rpl-trow"><span>' + esc(LISTS[k].short + ': ' + plural(l.rows, 'row', 'rows') + ', pasted ' + G.ui.relativeTime(l.importedAt).toLowerCase()) + '</span>' + remove + '</div>';
  }

  // Who the line is built from.
  function whoLine(data) {
    const roster = data.roster || {};
    return roster.source === 'team'
      ? 'Nobody is signed up or placed yet: everyone on the team (' + plural(roster.people || 0, 'person', 'people') + ') counts as coming.'
      : 'In line: the ' + plural(roster.people || 0, 'person', 'people') + ' signed up, placed or present on this raid.';
  }

  function filtersHtml(data, view) {
    if (!(data.items || []).length) return '';
    const players = playersOf(data);
    return '<div class="gs-roster-filters gs-board-filters"><div class="gs-check"><input type="checkbox" id="bd-contested" data-change="board-contested" data-key="bd-contested"' + (view.contested ? ' checked' : '') + '>' +
      '<label for="bd-contested">Roll-offs only</label></div>' +
      '<div class="gs-field gs-field-inline"><label class="gs-label" for="bd-player">Player</label><select class="gs-input gs-input-sm" id="bd-player" data-change="board-player" data-key="bd-player">' +
      '<option value="">Everyone</option>' + players.map(function (p) { return '<option value="' + esc(p.key) + '"' + (p.key === view.player ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select></div></div>';
  }

  // ── paste panel ──
  function skippedHtml(parsed) {
    const n = parsed.skippedCount || (parsed.skipped || []).length;
    if (!n) return '';
    return '<details class="gs-how"><summary>' + esc(plural(n, 'entry was', 'entries were')) + ' left out of the paste</summary><ul class="gs-bullets">' + (parsed.skipped || []).map(function (s) {
      return '<li>' + esc((s.label ? s.label + ': ' : '') + s.reason) + '</li>';
    }).join('') + (n > parsed.skipped.length ? '<li>' + esc('And ' + (n - parsed.skipped.length) + ' more.') + '</li>' : '') + '</ul></details>';
  }

  function readLine(list, parsed) {
    const s = parsed.stats || {};
    if (list === 'tmb') {
      return plural(s.prio || 0, 'prio row', 'prio rows') + ' and ' + plural(s.wish || 0, 'wishlist row', 'wishlist rows') + ' for ' + plural(s.items || 0, 'item', 'items') + ' and ' +
        plural(s.characters || 0, 'character', 'characters') + '.' + (s.wishLeftOut ? ' ' + plural(s.wishLeftOut, 'wishlist row', 'wishlist rows') + ' on items nobody has a prio on ' + (s.wishLeftOut === 1 ? 'was' : 'were') + ' left out.' : '');
    }
    return plural(s.reserves || 0, 'reserve', 'reserves') + ' on ' + plural(s.items || 0, 'item', 'items') + ' by ' + plural(s.characters || 0, 'character', 'characters') + '.' +
      (s.hardReserves ? ' ' + plural(s.hardReserves, 'hard-reserve is', 'hard-reserves are') + ' not used.' : '');
  }

  function inputStageHtml(ui, list) {
    return '<div class="gs-field"><label class="gs-label" for="bd-paste">' + esc(LISTS[list].name) + ' export</label>' +
      '<textarea class="gs-input gs-textarea gs-loot-paste" id="bd-paste" name="paste" rows="5" spellcheck="false" autocomplete="off" aria-describedby="bd-help" data-input="board-paste" data-key="bd-paste">' + esc(ui.text) + '</textarea></div>' +
      '<div class="gs-field"><label class="gs-label" for="bd-file">Or choose the saved file (.txt)</label>' +
      '<input class="gs-input" type="file" id="bd-file" accept=".txt,.json,text/plain,application/json" data-change="board-file" data-key="bd-file"></div>' +
      '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="board-read" data-key="board-read"' + (ui.busy ? ' disabled' : '') + '>' + (ui.busy ? 'Reading...' : 'Preview') + '</button>' +
      '<button type="button" class="gs-btn" data-action="board-close" data-key="board-close">Close</button></div>';
  }

  // The Preview step's content; the commit bar below it is previewCommit.
  function previewStageHtml(ui, data) {
    const list = ui.list;
    const parsed = ui.parsed || { entries: [], stats: {} };
    const existing = data.lists && data.lists[list];
    const replace = existing ? '<p class="gs-notice" role="status"><span>This replaces the ' + esc(plural(existing.rows, 'row', 'rows')) + ' pasted ' + esc(G.ui.relativeTime(existing.importedAt).toLowerCase()) + '.</span></p>' : '';
    return '<p class="gs-fine" id="bd-read">' + esc('Read ' + readLine(list, parsed)) + '</p>' + skippedHtml(parsed) + replace;
  }

  // The T5 commit bar: how many rows will be saved, Back (keeps the paste to read again), Close, and the Primary.
  function previewCommit(ui) {
    const parsed = ui.parsed || { entries: [], stats: {} };
    return {
      text: plural(parsed.entries.length, 'row', 'rows') + ' will be saved.',
      back: { attrs: { 'data-action': 'board-back', 'data-key': 'board-back' } }, cancel: { label: 'Close', attrs: { 'data-action': 'board-close', 'data-key': 'board-close' } },
      commit: { label: ui.busy ? 'Saving...' : 'Save ' + plural(parsed.entries.length, 'row', 'rows'), disabled: !!ui.busy, attrs: { 'data-action': 'board-save', 'data-key': 'board-save' } },
    };
  }

  // The TMB / softres paste is the T5 flow at the top of the raid's main column: Source (paste or file), Preview (what was read, commit bar), Import (inline result).
  function panelHtml(x) {
    const ui = x.ui;
    const list = ui.list;
    if (!list || !has(LISTS, list)) return '';
    return G.ui.importPanelHtml({
      id: 'bd-title', title: LISTS[list].paste, step: ui.stage === 'preview' ? 'preview' : (ui.stage === 'done' ? 'result' : 'source'),
      helpHtml: '<p class="gs-fine" id="bd-help">' + esc(LISTS[list].help) + '</p>', alertHtml: G.ui.alertHtml(ui.error, 'bd-error'),
      sourceHtml: inputStageHtml(ui, list), previewHtml: ui.stage === 'preview' ? previewStageHtml(ui, x.data) : '',
      resultHtml: ui.stage === 'done' ? G.ui.importResultHtml({ id: 'bd-result', title: ui.note, next: [{ label: 'Close', attrs: { 'data-action': 'board-close', 'data-key': 'board-close' } }] }) : '',
      commit: ui.stage === 'preview' ? previewCommit(ui) : null,
    });
  }

  // ── panels ──
  function pastedOf(data) { return LIST_KEYS.some(function (k) { return data.lists && data.lists[k]; }); }

  // The state of the board when it can show something: { data, edit, pasted }, else null (not loaded, denied, none, error).
  function readyOf(x) {
    if (!x || x.status !== 'ok' || !x.data) return null;
    return { data: x.data, edit: canEdit(x), pasted: pastedOf(x.data) };
  }

  // The item list in the main column: Loot prios with the filters and Print in its head. Only once something is pasted and some item has a line.
  // opts: { guildData, data (the raid detail), state (stateFor) }.
  function listHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const r = readyOf(x);
    if (!r || !r.pasted || !(r.data.items || []).length) return '';
    const data = r.data;
    const view = x.view || freshView();
    const shown = visibleItems(data, view);
    const head = '<div class="gs-rb-ph"><h2 class="gs-pr-h" id="board-h">Loot prios</h2><div class="gs-rb-acts">' + filtersHtml(data, view) +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="board-print" data-key="board-print">Print</button></div></div>';
    let list;
    if (!shown.length) {
      list = '<p class="gs-empty">No item matches these filters.</p>';
    } else {
      list = '<ul class="gs-board-list" aria-label="Items and who is in line">' + shown.map(function (item) { return rowHtml(gd, item); }).join('') + '</ul>' +
        (shown.length < data.items.length ? '<p class="gs-fine">' + esc('Showing ' + shown.length + ' of ' + data.items.length + ' items.') + '</p>' : '');
    }
    const unmatched = (data.unmatched || []).length
      ? '<details class="gs-how"><summary>' + esc(plural(data.unmatched.length, 'TMB name is', 'TMB names are')) + ' not on the roster</summary><p class="gs-fine">' + esc(data.unmatched.join(', ')) + '</p></details>' : '';
    return '<section class="gs-hd-panel gs-rb gs-rpl gs-rpl-prios" aria-labelledby="board-h">' + head + '<div class="gs-rpl-pb">' + list + unmatched + '<p class="gs-fine">' + esc(whoLine(data)) + '</p></div></section>';
  }

  function sidePanelHtml(bodyHtml) {
    return '<section class="gs-hd-panel gs-rpl gs-rpl-sum" aria-labelledby="board-sum-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="board-sum-h">Loot prios</h2></div><div class="gs-rpl-pb">' + bodyHtml + '</div></section>';
  }

  // The side summary: what was pasted when (Remove for an editor), the item and roll-off counts, the paste buttons. Nothing for a viewer the loot visibility keeps out,
  // or when nothing was pasted and the viewer cannot paste. opts: { state }.
  function summaryHtml(opts) {
    const x = opts.state;
    if (x && x.status === 'error') return errorPanelHtml(x);
    const r = readyOf(x);
    if (!r || (!r.pasted && !r.edit)) return '';
    const data = r.data;
    const items = data.items || [];
    const lines = LIST_KEYS.map(function (k) { return sourceLineHtml(data, k, r.edit); }).join('');
    let counts = '';
    if (!r.pasted) {
      counts = '<p class="gs-fine">Paste the ThatsMyBIS prios and the softres.it reserves of this raid to see who is in line for each item and which items need a roll-off.</p>';
    } else if (!items.length) {
      counts = '<p class="gs-fine">Nobody on this raid is in line for an item in the pasted lists.' + ((data.unmatched || []).length ? ' ' + esc(plural(data.unmatched.length, 'name in the TMB prios is', 'names in the TMB prios are')) + ' not on the roster: ' + esc(data.unmatched.join(', ')) + '.' : '') + '</p>';
    } else {
      counts = '<p class="gs-rpl-line">' + esc(plural(items.length, 'item', 'items') + ', ' + plural(items.filter(function (i) { return i.contested; }).length, 'roll-off', 'roll-offs')) + '</p>';
    }
    const paste = r.edit ? LIST_KEYS.map(function (k) {
      return canPaste(x, k) ? '<button type="button" class="gs-btn" data-action="board-open" data-list="' + k + '" data-key="board-open-' + k + '">' + esc(LISTS[k].paste) + '</button>' : '';
    }).join('') : '';
    return sidePanelHtml(lines + counts + (paste ? '<div class="gs-rpl-btns">' + paste + '</div>' : ''));
  }

  // The TMB / softres paste panel, drawn at the top of the main column while it is open (editors only); '' otherwise.
  function pasteFlowHtml(opts) {
    const x = opts.state;
    return canEdit(x) && x.ui ? panelHtml(x) : '';
  }

  function errorPanelHtml(x) {
    return sidePanelHtml(G.ui.alertHtml(x.error || 'Could not load the loot prios.', 'board-load-error') +
      '<div><button type="button" class="gs-btn gs-btn-sm" data-action="board-reload" data-key="board-reload">Try again</button></div>');
  }

  // The printable sheet (written into the page's #print-sheet): item, roll-off, who is in line. gd: the guild data; raid: the raid detail's raid.
  function printHtml(gd, raid, data, view) {
    const shown = visibleItems(data, view);
    const title = 'Loot prios - ' + (G.ui.weekdayDay(raid.raidOn) || raid.raidOn || '') + (raid.zone ? ' - ' + raid.zone : '');
    const rows = shown.map(function (item) {
      const line = item.line.map(function (e) {
        return entryLabel(e) + ' ' + e.name + (e.guest ? ' (guest)' : '') + (e.received ? ' (has it)' : '');
      }).join(', ');
      return '<tr><td>' + esc(item.itemName || 'Item ' + item.itemId) + '</td><td>' + (item.contested ? 'Roll-off' : '') + '</td><td>' + esc(line) + '</td></tr>';
    }).join('');
    return '<div class="ps-board"><h1>' + esc(title) + '</h1><p class="ps-meta">' + esc(gd.guild.name) + ' - ' + esc(plural(shown.length, 'item', 'items')) + (view && view.contested ? ' (roll-offs only)' : '') + '</p>' +
      '<table><thead><tr><th>Item</th><th>Roll-off</th><th>In line</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  // ── data ──
  // Opening the raid page starts the panel afresh (closed, nothing pasted) with the default filters. Only the card's own "Try again" (opts.keepUi) keeps them.
  function loadFor(gd, detail, opts) {
    const gid = gd.guild.id;
    const raid = detail && detail.raid;
    if (!raid) { a().raidBoard = { gid: gid, rid: null, status: 'none' }; return Promise.resolve(null); }
    const prev = a().raidBoard;
    const keep = !!(opts && opts.keepUi) && prev && prev.gid === gid && prev.rid === raid.id && prev.ui;
    const ui = keep ? prev.ui : freshUi();
    const view = keep && prev.view ? prev.view : freshView();
    return G.api.loot.board(gid, raid.id).then(function (res) {
      a().raidBoard = { gid: gid, rid: raid.id, status: 'ok', data: res, ui: ui, view: view };
      return null;
    }, function (err) {
      // 403: the loot visibility keeps this viewer out (nothing is drawn). 404: nothing to show. Anything else shows a retry.
      if (err && err.status === 403) { a().raidBoard = { gid: gid, rid: raid.id, status: 'denied' }; return null; }
      if (err && err.status === 404) { a().raidBoard = { gid: gid, rid: raid.id, status: 'none' }; return null; }
      a().raidBoard = { gid: gid, rid: raid.id, status: 'error', error: G.api.classify(err).text, ui: ui, view: view };
      return null;
    });
  }

  // Reads the board again behind the page (a sign-up or an award changed what it shows); the panel and filters stay as they are. Quiet on failure.
  function refresh() {
    const c = cur();
    if (!c) return Promise.resolve();
    return G.api.loot.board(c.gid, c.rid).then(function (res) {
      const again = cur();
      if (again && again.x === c.x) { c.x.data = res; G.app.render(); }
    }, function () { /* the old board stays */ });
  }

  function fail(err) { G.app.handleError(err, { pageAlert: true }); }

  // ── handlers ──
  G.handlers.click['board-reload'] = function () {
    const gd = currentGd();
    const r = a().raid;
    if (!gd || !r) return;
    loadFor(gd, r.data, { keepUi: true }).then(function () { G.app.render(); });
  };

  G.handlers.click['board-open'] = function (el) {
    const c = cur();
    const list = el && el.getAttribute ? el.getAttribute('data-list') : null;
    if (!c || !has(LISTS, list)) return;
    c.x.ui = freshUi();
    c.x.ui.list = list;
    G.app.render();
    G.ui.focusByKey('bd-paste');
  };

  G.handlers.click['board-close'] = function () {
    const c = cur();
    if (!c) return;
    const was = c.x.ui.list;
    c.x.ui = freshUi();
    G.app.render();
    G.ui.focusByKey(was ? 'board-open-' + was : 'raid-actions');
  };

  G.handlers.click['board-back'] = function () {
    const c = cur();
    if (!c) return;
    const list = c.x.ui.list;
    c.x.ui = freshUi();
    c.x.ui.list = list;
    G.app.render();
  };

  G.handlers.input['board-paste'] = function (el) {
    const c = cur();
    if (c) c.x.ui.text = String(el.value || '');
  };

  function pastedText() {
    const el = typeof document !== 'undefined' ? document.getElementById('bd-paste') : null;
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

  G.handlers.change['board-file'] = function (el) {
    const c = cur();
    const file = el && el.files && el.files[0];
    if (!c || !file) return;
    const ui = c.x.ui;
    if (file.size > G.tmb.MAX_TEXT_CHARS) { ui.error = 'That file is larger than 8 MB.'; G.app.render(); return; }
    readFile(file).then(function (text) {
      ui.text = text;
      ui.error = '';
      G.app.render();
    }, function () { ui.error = 'Could not read that file.'; G.app.render(); });
  };

  G.handlers.click['board-read'] = function () {
    const c = cur();
    if (!c || c.x.ui.busy || !has(LISTS, c.x.ui.list)) return;
    const ui = c.x.ui;
    const list = ui.list;
    const live = pastedText();
    if (live != null) ui.text = live;
    ui.busy = true;
    ui.error = '';
    G.app.render();
    G[LISTS[list].parser].parse(ui.text, { surname: c.gd.guild.gameVersion === 'forever' }).then(function (parsed) {
      ui.busy = false;
      if (!parsed.ok) { ui.error = parsed.error; G.app.render(); return; }
      if (!parsed.entries.length) {
        ui.error = parsed.rows ? 'Nothing in this export can be used.' + (parsed.skipped.length ? ' First problem: ' + parsed.skipped[0].reason + '.' : '') : 'The export holds no entries.';
        G.app.render();
        return;
      }
      ui.parsed = parsed;
      ui.stage = 'preview';
      ui.text = '';
      G.app.render();
    });
  };

  // The Worker refuses a paste for one bad row (400 with the row's index): name it.
  function describeError(err) {
    return G.api.classify(err).text;
  }

  G.handlers.click['board-save'] = function () {
    const c = cur();
    if (!c || c.x.ui.busy || !c.x.ui.parsed || !has(LISTS, c.x.ui.list)) return;
    const ui = c.x.ui;
    const list = ui.list;
    ui.busy = true;
    ui.error = '';
    G.app.render();
    G.api.loot.saveList(c.gid, c.rid, list, ui.parsed.entries).then(function (res) {
      c.x.data = res;
      ui.busy = false;
      ui.stage = 'done';
      ui.note = 'Saved ' + plural(ui.parsed.entries.length, 'row', 'rows') + ' of the ' + LISTS[list].short + '. The board is up to date.';
      ui.parsed = null;
      G.app.render();
    }, function (err) {
      ui.busy = false;
      ui.error = describeError(err);
      G.app.render();
    });
  };

  G.handlers.click['board-remove'] = function (el) {
    const c = cur();
    const list = el && el.getAttribute ? el.getAttribute('data-list') : null;
    if (!c || !has(LISTS, list)) return;
    G.ui.openDialog('<form class="gs-dialog-form" data-submit="board-remove-form" data-list="' + esc(list) + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Remove the ' + esc(LISTS[list].short) + '?</h2>' +
      '<p class="gs-confirm-text" id="dlg-text">The ' + esc(LISTS[list].short) + ' pasted for this raid are removed from the board. You can paste them again.</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove</button></div></form>', { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['board-remove-form'] = function (form) {
    const c = cur();
    const list = form.getAttribute('data-list');
    if (!c || !has(LISTS, list)) return;
    G.ui.runDialog(form, G.api.loot.saveList(c.gid, c.rid, list, []), function (res) {
      c.x.data = res;
      st().pageAlert = '';
      G.app.render();
    });
  };

  G.handlers.change['board-contested'] = function (el) {
    const c = cur();
    if (!c) return;
    c.x.view.contested = !!el.checked;
    G.app.render();
    G.ui.focusByKey('bd-contested');
  };

  G.handlers.change['board-player'] = function (el) {
    const c = cur();
    if (!c) return;
    c.x.view.player = String(el.value || '');
    G.app.render();
    G.ui.focusByKey('bd-player');
  };

  G.handlers.click['board-print'] = function () {
    const c = cur();
    const sheet = typeof document !== 'undefined' ? document.getElementById('print-sheet') : null;
    if (!c || !c.raid || !sheet || typeof window === 'undefined' || typeof window.print !== 'function') return;
    sheet.innerHTML = printHtml(c.gd, c.raid, c.x.data, c.x.view);
    window.addEventListener('afterprint', function clear() {
      window.removeEventListener('afterprint', clear);
      sheet.innerHTML = '';
    });
    window.print();
  };

  G.pages.raidBoard = {
    LISTS: LISTS,
    stateFor: stateFor,
    canPaste: canPaste,
    listHtml: listHtml,
    summaryHtml: summaryHtml,
    pasteFlowHtml: pasteFlowHtml,
    panelHtml: panelHtml,
    rowHtml: rowHtml,
    printHtml: printHtml,
    visibleItems: visibleItems,
    playersOf: playersOf,
    resultText: resultText,
    freshUi: freshUi,
    freshView: freshView,
    loadFor: loadFor,
    refresh: refresh,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
