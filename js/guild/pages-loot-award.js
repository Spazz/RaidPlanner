// ── PAGE: ONE LOOT AWARD (#/g/:gid/loot/a/:aid[?edit=1]) - the record (T2) and Edit details ──
// GET /loot/a/:aid gives { award, raid, origin, history, canEdit } to Team Leads and above (members get 403: a plain "only Team Leads and above" state).
// Edit details holds a DRAFT in state (winner or Disenchanted, item, raid night, tag, note), counts what differs from the saved award for the sticky Save bar,
// and sends only the changed fields plus `updatedAt` in one PATCH /loot/:aid. A 409 `stale` says "Someone changed this award. Reload to see it." with a Reload
// action; a field error from the Worker shows at its field. Delete award goes back to the raid night. Safe to load alone: nothing here runs at load time.
(function (G) {
  'use strict';

  G.pages = G.pages || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  const NOTE_MAX = 200;
  const STALE_TEXT = 'Someone changed this award. Reload to see it.';
  const FIELD_OF = { winnerName: 'winner', winnerRealm: 'winner', disenchanted: 'winner', itemId: 'item', itemName: 'item', raidId: 'raid', tag: 'tag', note: 'note' };
  const TAG_OPTIONS = ['MS', 'OS', 'DE', 'BANK'];

  function L() { return G.pages.loot; }
  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function href(route) { return G.router.format(route); }
  function dayText(raidOn) { return G.ui.weekdayDay(raidOn) || raidOn || 'Raid night'; }
  function cur() { const x = a().lootAward; return x && currentGd() ? x : null; }

  // ── the draft ──
  function winnerBase(award, gd) {
    if (L().isDisenchanted(award)) return '';
    const w = award.winner || {};
    const guildRealm = String(gd && gd.guild && gd.guild.realm ? gd.guild.realm : '').toLowerCase();
    return String(w.name == null ? '' : w.name) + (w.realm && String(w.realm).toLowerCase() !== guildRealm ? '-' + w.realm : '');
  }

  function itemBase(award) { return award.itemName || String(award.itemId); }

  function draftFrom(award, gd) {
    return { winnerName: winnerBase(award, gd), disenchanted: L().isDisenchanted(award), item: itemBase(award), raidId: award.raidId, tag: award.tag, note: award.note || '' };
  }

  // The names of the fields that differ from the saved award, in the page's order.
  function changedFields(x) {
    const d = x.draft;
    const base = draftFrom(x.data.award, currentGd());
    const out = [];
    if (d.disenchanted !== base.disenchanted || (!d.disenchanted && d.winnerName.trim() !== base.winnerName)) out.push('winner');
    if (d.item.trim() !== base.item) out.push('item');
    if (d.raidId !== base.raidId) out.push('raid');
    if (d.tag !== base.tag && !d.disenchanted) out.push('tag');
    if (d.note.trim() !== base.note) out.push('note');
    return out;
  }

  function changeCount(x) { return changedFields(x).length; }

  // The PATCH body: only what changed, plus the version it was read at.
  function bodyOf(x) {
    const d = x.draft;
    const award = x.data.award;
    const changed = changedFields(x);
    const body = { updatedAt: award.updatedAt };
    if (changed.indexOf('winner') >= 0) { if (d.disenchanted) body.disenchanted = true; else body.winnerName = d.winnerName.trim(); }
    if (changed.indexOf('item') >= 0) {
      const ref = G.gargul.parseItemRef(d.item);
      if (ref) { if (ref.itemId !== award.itemId) { body.itemId = ref.itemId; if (ref.itemName) body.itemName = ref.itemName; } else if (ref.itemName && ref.itemName !== award.itemName) body.itemName = ref.itemName; }
      else body.itemName = d.item.trim();
    }
    if (changed.indexOf('raid') >= 0) body.raidId = d.raidId;
    if (changed.indexOf('tag') >= 0) body.tag = d.tag;
    else if (changed.indexOf('winner') >= 0 && !d.disenchanted && L().isDisenchanted(award)) body.tag = d.tag === 'DE' ? 'MS' : d.tag; // a winner on a disenchanted award needs a real tag
    if (changed.indexOf('note') >= 0) body.note = d.note.trim();
    return body;
  }

  // A problem the Worker would refuse, found first so it shows at the field: { field: text } or {}.
  function problemsOf(x) {
    const d = x.draft;
    const out = {};
    if (!d.disenchanted && !d.winnerName.trim()) out.winner = 'Pick the winner, or tick Nobody won it (disenchanted).';
    if (!d.item.trim()) out.item = 'Enter the item name, its item ID, or paste its Wowhead link.';
    else if (/^\d+$/.test(d.item.trim()) && !G.gargul.parseItemRef(d.item)) out.item = 'That item ID does not look right.';
    if (!d.disenchanted && d.tag === 'DE') out.tag = 'A winner needs a tag other than Disenchanted. Tick Nobody won it instead.';
    if (d.note.trim().length > NOTE_MAX) out.note = 'Keep the note to ' + NOTE_MAX + ' characters.';
    return out;
  }

  // ── view ──
  function kv(label, valueHtml) {
    return '<div class="gs-pr-kv"><span class="gs-pr-k">' + esc(label) + '</span><span class="gs-pr-v">' + valueHtml + '</span></div>';
  }

  function nightText(raid) {
    return [dayText(raid.raidOn), raid.title || raid.zone || ''].filter(Boolean).join(' - ');
  }

  function readRowsHtml(gd, d) {
    const award = d.award;
    const raid = d.raid;
    const edited = Array.isArray(award.editedFields) && award.editedFields.length > 0;
    return kv('Raid night', '<a href="' + esc(href({ name: 'lootnight', gid: gd.guild.id, rid: raid.id })) + '">' + esc(nightText(raid)) + '</a>') +
      kv('Item', L().itemHtml({ itemId: award.itemId, itemName: award.itemName, quality: award.quality }, gd.guild.gameVersion)) +
      kv('Winner', L().winnerHtml(gd.guild.id, award.winner, award.match, true)) +
      kv('Tag', L().tagTextHtml(award.tag, award.tagSetBy) + (edited ? ' ' + L().editedChipHtml(award) : '')) +
      kv('Note', award.note ? esc(award.note) : '<span class="gs-muted">No note</span>') +
      kv('Source', esc(d.origin && d.origin.text ? d.origin.text : ''));
  }

  function changedHelp(changed, text) { return changed ? 'Changed from ' + text + '.' : ''; }

  function formHtml(gd, x) {
    const d = x.draft;
    const base = draftFrom(x.data.award, gd);
    const changed = changedFields(x);
    const err = x.errors || {};
    const isChanged = function (f) { return changed.indexOf(f) >= 0; };
    const names = x.names || [];
    const raidOptions = (x.raidOptions || []).map(function (r) { return { value: r.id, label: r.label }; });
    const winnerText = L().isDisenchanted(x.data.award) ? 'Disenchanted' : (base.winnerName || 'nobody');
    const winnerField = d.disenchanted ? '' : G.ui.fieldHtml({ id: 'la-winner', name: 'winner', label: 'Winner', value: d.winnerName, maxlength: 40, autocomplete: 'off', error: err.winner,
      help: isChanged('winner') ? changedHelp(true, winnerText) + ' Start typing to pick from the roster.' : 'Start typing to pick from the roster. A name that is not on the roster is kept as a guest or an unknown name.',
      attrs: { list: 'la-names', 'data-input': 'la-winner', 'data-key': 'la-winner' } }) +
      '<datalist id="la-names">' + names.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join('') + '</datalist>';
    const deField = G.ui.checkFieldHtml({ id: 'la-de', name: 'de', label: 'Nobody won it (disenchanted)', checked: d.disenchanted, attrs: { 'data-change': 'la-de', 'data-key': 'la-de' } }) +
      (d.disenchanted && err.winner ? G.ui.fieldErrorHtml('la-de', err.winner) : '');
    const tagField = G.ui.fieldHtml({ id: 'la-tag', name: 'tag', label: 'Tag', kind: 'select', value: d.disenchanted ? 'DE' : d.tag, disabled: d.disenchanted, error: err.tag,
      reason: d.disenchanted ? 'A disenchanted item is always tagged DE.' : '', help: !d.disenchanted && isChanged('tag') ? changedHelp(true, L().TAG_NAMES[base.tag] || base.tag) : '',
      options: TAG_OPTIONS.map(function (t) { return { value: t, label: L().TAG_NAMES[t] + (t === 'BANK' ? '' : ' (' + t + ')') }; }), attrs: { 'data-change': 'la-tag', 'data-key': 'la-tag' } });
    return '<form class="gs-details-form gs-pr-form gs-la-form" id="la-form" data-submit="la-form" novalidate>' +
      G.ui.fieldHtml({ id: 'la-raid', name: 'raid', label: 'Raid night', kind: 'select', value: d.raidId, options: raidOptions, error: err.raid,
        help: isChanged('raid') ? 'Moves the award to that night.' : 'Only raid nights that have started, on teams you can edit loot for.', attrs: { 'data-change': 'la-raid', 'data-key': 'la-raid' } }) +
      G.ui.fieldHtml({ id: 'la-item', name: 'item', label: 'Item', value: d.item, maxlength: 200, autocomplete: 'off', error: err.item,
        help: isChanged('item') ? changedHelp(true, base.item) + ' Item name, item ID or Wowhead link.' : 'Item name, item ID or Wowhead link.', attrs: { 'data-input': 'la-item', 'data-key': 'la-item' } }) +
      winnerField + deField + tagField +
      G.ui.fieldHtml({ id: 'la-note', name: 'note', label: 'Note', value: d.note, maxlength: NOTE_MAX, autocomplete: 'off', placeholder: 'Up to ' + NOTE_MAX + ' characters', error: err.note,
        attrs: { 'data-input': 'la-note', 'data-key': 'la-note' } }) +
      G.ui.alertHtml(x.error || '', 'la-error') +
      G.ui.saveBarHtml({ count: changeCount(x), busy: x.busy, saveLabel: 'Save details', discardAttrs: { 'data-action': 'la-discard', 'data-key': 'la-discard' } }) + '</form>';
  }

  function historyHtml(gd, d) {
    const list = Array.isArray(d.history) ? d.history : [];
    if (!list.length) return '<p class="gs-lt-pad gs-fine">Nothing has been recorded for this award.</p>';
    return '<ol class="gs-la-history" aria-label="History of this award">' + list.map(function (h) {
      const who = h.by && h.by.displayName ? 'by ' + h.by.displayName + ', ' : '';
      return '<li class="gs-pr-row gs-la-hrow"><span class="gs-la-htext">' + esc(h.text) + '</span><span class="gs-lt-sub">' + esc(who + L().dateText(h.at, gd.guild.timeZone)) + '</span></li>';
    }).join('') + '</ol>';
  }

  function savedHtml(x, gd) {
    if (!x.savedAt) return G.ui.savedStatusHtml('');
    const when = G.ui.timeInZone(x.savedAt, gd.guild.timeZone);
    return G.ui.savedStatusHtml(when ? 'Saved at ' + when : 'Saved', 'saved');
  }

  function stateCard(gd, title, text) {
    return G.ui.listPageHtml({ head: { title: 'Award', back: { href: href({ name: 'section', gid: gd.guild.id, section: 'loot' }), label: 'Loot' } }, pageClass: 'gs-forge gs-loot-page gs-loot-award',
      bodyHtml: L().stateHtml({ title: title, text: text }) });
  }

  // opts: { guildData, state, alert }
  function awardHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    if (x.status === 'denied') return stateCard(gd, 'Only Team Leads and above can open an award.', 'Awards are changed by the officers of the team. You can see what was awarded on the raid night page.');
    if (x.status === 'none') return stateCard(gd, 'Award not found', 'That award does not exist any more. It may have been deleted.');
    const d = x.data;
    const award = d.award;
    const raid = d.raid;
    const editing = !!x.editing;
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const context = [nightText(raid), several ? raid.teamName : ''].filter(Boolean).join(' - ');
    const staleHtml = x.stale ? '<div class="gs-notice" role="alert" id="la-stale"><span>' + esc(STALE_TEXT) + '</span>' + G.ui.buttonHtml({ label: 'Reload', variant: 'secondary', size: 'sm', attrs: { 'data-action': 'la-reload', 'data-key': 'la-reload' } }) + '</div>' : '';
    const toggle = editing
      ? G.ui.buttonHtml({ label: 'Cancel', variant: 'ghost', attrs: { 'data-action': 'la-edit-close', 'data-key': 'la-cancel' } })
      : '';
    return G.ui.objectPageHtml({
      head: {
        title: award.itemName || 'Item ' + award.itemId, context: context, back: { href: href({ name: 'lootnight', gid: gd.guild.id, rid: raid.id }), label: dayText(raid.raidOn) },
        more: { id: 'la-more', label: 'More', items: [{ label: 'Delete award', danger: true, key: 'la-delete', data: { action: 'la-delete' } }] },
        primary: editing ? null : { label: 'Edit details', attrs: { 'data-action': 'la-edit-open', 'data-key': 'la-edit' } },
      },
      pageClass: 'gs-forge gs-loot-page gs-loot-award', noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + staleHtml,
      sections: [{ id: 'la-cols', bare: true, bodyHtml: '<div class="gs-pr-cols"><div class="gs-pr-left">' +
        L().panelHtml({ id: 'la-details', title: editing ? 'Edit details' : 'Details', flush: true, actionsHtml: (editing ? '' : savedHtml(x, gd)) + toggle,
          bodyHtml: editing ? '<div class="gs-pr-body">' + formHtml(gd, x) + '</div>' : readRowsHtml(gd, d) }) +
        '</div><div class="gs-pr-right">' + L().panelHtml({ id: 'la-history', title: 'History', metaHtml: 'Newest first', flush: true, bodyHtml: historyHtml(gd, d) }) + '</div></div>' }],
    });
  }

  // ── data ──
  function adopt(gid, aid, res, keep) {
    const prev = a().lootAward;
    const same = prev && prev.gid === gid && prev.aid === aid;
    const x = Object.assign({ gid: gid, aid: aid, status: 'ok', data: res, editing: false, draft: draftFrom(res.award, currentGd()), errors: {}, error: '', stale: false, busy: false,
      names: same ? prev.names : null, raidOptions: same ? prev.raidOptions : null, savedAt: 0 }, keep || {});
    a().lootAward = x;
    return x;
  }

  function raidLabel(r, team, several) {
    return nightText({ raidOn: r.raidOn, title: r.title, zone: r.zone }) + (several && team ? ' - ' + team.name : '');
  }

  // Started raids of the teams the viewer edits loot for (the first page of each team's past raids), and the award's own raid whatever its age.
  function loadRaidOptions(x, gd) {
    const gid = gd.guild.id;
    const teams = G.shell.activeTeams(gd.teams).filter(function (t) { return L().allows(gd, 'loot.edit', t.id); });
    const own = x.data.raid;
    const ownOption = { id: own.id, label: raidLabel(own, null, false) + (teams.length > 1 ? ' - ' + own.teamName : ''), raidOn: own.raidOn };
    return Promise.all(teams.map(function (t) {
      return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/raids?team=' + encodeURIComponent(t.id)).then(function (res) {
        return (res && Array.isArray(res.raids) ? res.raids : []).map(function (r) { return { id: r.id, label: raidLabel(r, t, teams.length > 1), raidOn: r.raidOn }; });
      }, function () { return []; });
    })).then(function (lists) {
      const seen = {};
      const all = [ownOption].concat([].concat.apply([], lists)).filter(function (o) { if (seen[o.id]) return false; seen[o.id] = true; return true; });
      all.sort(function (p, q) { return String(q.raidOn).localeCompare(String(p.raidOn)); });
      x.raidOptions = all;
    });
  }

  function loadChoices(x, gd) {
    const jobs = [];
    if (!x.raidOptions) jobs.push(loadRaidOptions(x, gd));
    if (!x.names && G.pages.raidLoot && G.pages.raidLoot.rosterNames) jobs.push(G.pages.raidLoot.rosterNames(gd.guild.id, x.data.raid.teamId).then(function (names) { x.names = names; }));
    return Promise.all(jobs);
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    return G.api.loot.award(gid, r.aid).then(function (res) {
      const x = adopt(gid, r.aid, res, { editing: !!r.edit && res.canEdit !== false });
      return x.editing ? loadChoices(x, gd).then(function () { return null; }) : null;
    }, function (err) {
      if (err && err.status === 403) { a().lootAward = { gid: gid, aid: r.aid, status: 'denied' }; return null; }
      if (err && err.status === 404) { a().lootAward = { gid: gid, aid: r.aid, status: 'none' }; return null; }
      throw err;
    });
  }

  function main(r, gd) {
    const x = a().lootAward;
    if (!x || x.gid !== gd.guild.id || x.aid !== r.aid) return L().loadingHtml('Award');
    return awardHtml({ guildData: gd, state: x, alert: st().pageAlert });
  }

  function nameFor(r) {
    const x = a().lootAward;
    return x && x.aid === r.aid && x.status === 'ok' ? x.data.award.itemName || 'Item ' + x.data.award.itemId : '';
  }

  // ── handlers ──
  function openEdit() {
    const x = cur();
    const gd = currentGd();
    if (!x || x.status !== 'ok' || x.editing) return;
    x.editing = true;
    x.draft = draftFrom(x.data.award, gd);
    x.errors = {};
    x.error = '';
    loadChoices(x, gd).then(function () { G.app.render(); G.ui.focusByKey('la-raid'); });
    G.app.render();
  }
  G.handlers.click['la-edit-open'] = openEdit;

  function closeEdit() {
    const x = cur();
    if (!x || x.status !== 'ok') return;
    x.editing = false;
    x.draft = draftFrom(x.data.award, currentGd());
    x.errors = {};
    x.error = '';
    G.app.render();
    G.ui.focusByKey('la-edit');
  }
  G.handlers.click['la-edit-close'] = closeEdit;
  G.handlers.click['la-discard'] = function () {
    const x = cur();
    if (!x || x.status !== 'ok') return;
    x.draft = draftFrom(x.data.award, currentGd());
    x.errors = {};
    x.error = '';
    G.app.render();
  };

  function afterField(x) { G.ui.saveBar.setCount(null, changeCount(x)); }
  function setter(field, read) {
    return function (el) {
      const x = cur();
      if (!x || x.status !== 'ok' || !x.editing) return;
      x.draft[field] = read(el);
      afterField(x);
    };
  }
  G.handlers.input['la-winner'] = setter('winnerName', function (el) { return String(el.value || ''); });
  G.handlers.input['la-item'] = setter('item', function (el) { return String(el.value || ''); });
  G.handlers.input['la-note'] = setter('note', function (el) { return String(el.value || ''); });
  G.handlers.change['la-raid'] = setter('raidId', function (el) { return String(el.value || ''); });
  G.handlers.change['la-tag'] = setter('tag', function (el) { return String(el.value || 'MS'); });

  G.handlers.change['la-de'] = function (el) {
    const x = cur();
    if (!x || x.status !== 'ok' || !x.editing) return;
    x.draft.disenchanted = !!el.checked;
    if (!x.draft.disenchanted && x.draft.tag === 'DE') x.draft.tag = 'MS';
    x.errors = {};
    G.app.render();
    G.ui.focusByKey(x.draft.disenchanted ? 'la-de' : 'la-winner');
  };

  // Field errors from the Worker: its `field` names the PATCH key; the page shows it at the matching field.
  function showError(x, err) {
    const field = err && err.field ? FIELD_OF[err.field] : null;
    x.errors = {};
    x.error = '';
    if (field) x.errors[field] = err.message; else x.error = G.api.classify(err).text;
  }

  G.handlers.submit['la-form'] = function () {
    const x = cur();
    const gd = currentGd();
    if (!x || x.status !== 'ok' || !x.editing || x.busy || !gd) return;
    const problems = problemsOf(x);
    if (Object.keys(problems).length) { x.errors = problems; x.error = ''; G.app.render(); return; }
    if (changeCount(x) === 0) { closeEdit(); return; }
    x.errors = {};
    x.error = '';
    x.busy = true;
    G.app.render();
    G.api.loot.update(gd.guild.id, x.aid, bodyOf(x)).then(function () {
      return G.api.loot.award(gd.guild.id, x.aid);
    }).then(function (res) {
      const fresh = adopt(gd.guild.id, x.aid, res, { savedAt: Date.now(), raidOptions: null });
      fresh.editing = false;
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      x.busy = false;
      if (err && err.code === 'stale') { x.stale = true; x.error = ''; x.errors = {}; G.app.render(); return; }
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      showError(x, err);
      G.app.render();
      G.ui.focusFirstInvalid(document.getElementById('la-form'));
    });
  };

  G.handlers.click['la-reload'] = function () {
    const x = cur();
    const gd = currentGd();
    if (!x || !gd) return;
    G.api.loot.award(gd.guild.id, x.aid).then(function (res) {
      adopt(gd.guild.id, x.aid, res, { editing: x.editing });
      st().pageAlert = '';
      G.app.render();
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  };

  G.handlers.click['la-delete'] = function () {
    const x = cur();
    if (!x || x.status !== 'ok' || !G.pages.raidLoot) return;
    G.ui.openDialog(G.pages.raidLoot.deleteDialogHtml(x.data.award, 'la-delete-form'), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.submit['la-delete-form'] = function (form) {
    const x = cur();
    const gd = currentGd();
    if (!x || !gd) return;
    const rid = x.data.raid.id;
    G.ui.runDialog(form, G.api.loot.remove(gd.guild.id, x.aid), function () {
      G.ui.unsaved.clear();
      a().lootAward = null;
      st().pageAlert = '';
      window.location.hash = href({ name: 'lootnight', gid: gd.guild.id, rid: rid });
    });
  };

  G.pages.lootAward = { awardHtml: awardHtml, draftFrom: draftFrom, changedFields: changedFields, changeCount: changeCount, bodyOf: bodyOf, problemsOf: problemsOf, load: load, main: main, nameFor: nameFor };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
