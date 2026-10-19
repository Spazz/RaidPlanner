// ── PAGE PIECES OF THE RAID: DUTIES, PASTE RAID ROSTER, GUEST SIGN-UP LINK ──
// Three things an officer does from the raid page's More menu (pages-raid.js asks menuItems() and draws dutiesLineHtml()):
//   Set raid duties          who is Raid leader, Loot master, Logger and Plan maker for this raid, and one duty in the officer's own words.
//                            The raid header shows them and the Discord roster post lists them; the Logger is nudged when no log arrives.
//   Paste raid roster        a raid with no log: paste who was there (names, /who, a raid frame), check who matched, save it as hand-entered attendance.
//                            Names that match nobody wait in the review queue. Two steps in one button: Check names, then Save attendance.
//   Guest sign-up link       an upcoming raid: a link for people with no guild account to sign up as Guests (expires at the raid's start, revocable).
// GET / PUT /raids/:rid/duties, POST /raids/:rid/manual/paste[/preview], GET / POST / DELETE /raids/:rid/join-links.
(function (G) {
  'use strict';

  const FIXED = [['leader', 'Raid leader'], ['loot', 'Loot master'], ['logger', 'Logger'], ['planner', 'Plan maker']];
  const EXTRA_MAX = 40;
  const PASTE_ACTION = { check: 'Check names', save: 'Save attendance' };

  function A() { return G.pages.attendance; }
  function R() { return G.pages.raid; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function hasReports(data) { return !!(data.sources && Array.isArray(data.sources.reports) && data.sources.reports.length); }
  function isManual(data) { return !!(data.raid && data.raid.state === 'manual') || !!(data.raid && data.raid.manual); }

  // ── the header and the menu ──
  function dutiesLineHtml(data) {
    const list = Array.isArray(data.duties) ? data.duties : [];
    if (!list.length) return '';
    return '<p class="gs-duties-line" id="raid-duties">' + list.map(function (d) {
      return '<span><strong>' + esc(d.label) + ':</strong> ' + G.ui.classNameHtml(d.name, d.class) + '</span>';
    }).join(' ') + '</p>';
  }

  // The More menu's extra items for this raid (empty for anyone who may not edit it).
  function menuItems(data) {
    if (!(data && data.can && data.can.edit)) return [];
    const upcoming = !!(data.raid && data.raid.upcoming);
    const items = [{ label: 'Set raid duties', key: 'mi-duties', data: { action: 'raid-extra', op: 'duties' } }];
    if (upcoming) items.push({ label: 'Guest sign-up link', key: 'mi-join', data: { action: 'raid-extra', op: 'join' } });
    else if (!hasReports(data)) items.push({ label: isManual(data) ? 'Paste raid roster (replaces who is present)' : 'Paste raid roster', key: 'mi-paste', data: { action: 'raid-extra', op: 'paste' } });
    return items;
  }

  // ── duties ──
  function peopleOptions(rosters, teamId) {
    const seen = {};
    const out = [];
    (rosters || []).forEach(function (r) {
      (Array.isArray(r.people) ? r.people : []).forEach(function (p) {
        const main = p.main || p.shown || {};
        if (!p.id || seen[p.id] || !main.name) return;
        if (p.status === 'inactive') return;
        seen[p.id] = true;
        out.push({ value: p.id, label: main.name + (r.teamId !== teamId ? ' (other team)' : ''), name: main.name });
      });
    });
    return out.sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'en'); });
  }

  function personSelect(id, name, options, current) {
    return '<select class="gs-input" id="' + id + '" name="' + name + '" data-field="' + name + '">' + G.ui.optionsHtml([{ value: '', label: 'Nobody' }].concat(options), current || '') + '</select>';
  }

  function dutyOf(list, id) { return (list || []).filter(function (d) { return d.duty === id; })[0] || null; }

  // o: { duties, previous, options }
  function dutiesDialogHtml(o) {
    const rows = FIXED.map(function (f) {
      const d = dutyOf(o.duties, f[0]);
      return '<div class="gs-duty-row"><label class="gs-label" for="du-' + f[0] + '">' + esc(f[1]) + '</label>' + personSelect('du-' + f[0], f[0], o.options, d ? d.personId : '') + '</div>';
    }).join('');
    const extra = dutyOf(o.duties, 'extra');
    return '<form class="gs-dialog-form gs-dialog-wide" data-submit="duties-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Raid duties</h2>' +
      '<p class="gs-fine" id="dlg-help">Who does what on this raid. They show on the raid page and in the Discord roster post. The Logger is reminded when no Warcraft Logs report is on the raid five hours after it started.</p>' +
      '<div class="gs-duty-rows">' + rows +
      '<div class="gs-duty-row"><label class="gs-label" for="du-extra-label">Your own duty</label><input class="gs-input" type="text" id="du-extra-label" name="extraLabel" maxlength="' + EXTRA_MAX + '" autocomplete="off" placeholder="For example: Bring flasks" data-field="extraLabel" value="' + esc(extra ? extra.label : '') + '"></div>' +
      '<div class="gs-duty-row"><label class="gs-label" for="du-extra">Given to</label>' + personSelect('du-extra', 'extra', o.options, extra ? extra.personId : '') + '</div></div>' +
      '<p class="gs-field-error" id="dlg-err-duties" role="alert" hidden></p><p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button>' +
      (o.previous && o.previous.length ? '<button type="button" class="gs-btn" data-action="duties-copy" data-key="duties-copy">Same as the last raid</button>' : '') +
      '<button type="submit" class="gs-btn gs-btn-molten">Save duties</button></div></form>';
  }

  let previousDuties = [];

  function fetchRosters(c) {
    const teams = G.shell.activeTeams(c.gd.teams);
    return Promise.all(teams.map(function (t) {
      return G.api.get(A().apiBase(c.gid) + '/roster?team=' + encodeURIComponent(t.id)).then(function (res) { return { teamId: t.id, people: res && res.people }; }, function () { return { teamId: t.id, people: [] }; });
    }));
  }

  function openDuties(c) {
    Promise.all([G.api.duties.get(c.gid, c.rid), fetchRosters(c)]).then(function (got) {
      previousDuties = got[0].previous || [];
      const options = peopleOptions(got[1], c.data.raid.teamId || (c.data.raid.team && c.data.raid.team.id));
      G.ui.openDialog(dutiesDialogHtml({ duties: got[0].duties, previous: previousDuties, options: options }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  G.handlers.click['duties-copy'] = function (el) {
    const form = el.closest ? el.closest('form') : null;
    if (!form) return;
    const set = function (name, value) { if (form.elements[name]) form.elements[name].value = value || ''; };
    FIXED.forEach(function (f) { const d = dutyOf(previousDuties, f[0]); set(f[0], d ? d.personId : ''); });
    const extra = dutyOf(previousDuties, 'extra');
    set('extraLabel', extra ? extra.label : '');
    set('extra', extra ? extra.personId : '');
  };

  // The duties the form holds, or { error }.
  function readDuties(form) {
    const duties = [];
    FIXED.forEach(function (f) {
      const v = form.elements[f[0]] ? form.elements[f[0]].value : '';
      if (v) duties.push({ duty: f[0], personId: v });
    });
    const label = String(form.elements.extraLabel.value || '').trim();
    const who = form.elements.extra.value;
    if (label && !who) return { error: 'Pick who gets "' + label + '", or clear its name.' };
    if (!label && who) return { error: 'Name your own duty, or set the person to Nobody.' };
    if (label) duties.push({ duty: 'extra', personId: who, label: label });
    return { duties: duties };
  }

  G.handlers.submit['duties-form'] = function (form) {
    const c = R().current();
    if (!c) return;
    G.ui.setText('dlg-err-duties', '');
    const read = readDuties(form);
    if (read.error) { const sink = document.getElementById('dlg-err-duties'); if (sink) { sink.textContent = read.error; sink.hidden = false; } return; }
    return G.ui.runDialog(form, G.api.duties.save(c.gid, c.rid, read.duties), function (res) { R().setDetail(c, res, read.duties.length ? 'Raid duties saved.' : 'Raid duties cleared.'); });
  };

  // ── paste raid roster ──
  let paste = { previewFor: null };

  function pasteDialogHtml(data) {
    const replacing = isManual(data);
    return '<form class="gs-dialog-form gs-dialog-wide" data-submit="paste-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Paste raid roster</h2><div id="pr-steps">' + G.ui.stepperHtml({ steps: G.ui.IMPORT_STEPS, current: 1, label: 'Import steps' }) + '</div>' +
      '<p class="gs-fine" id="dlg-help">Paste who was in the raid: one name per line or separated by commas, the in-game /who list, or a raid frame copied from an addon. Names are matched like the ones in a Warcraft Logs report. ' +
      (replacing ? 'This replaces who is marked attended on the raid now.' : 'The raid becomes hand-entered attendance with these people attended.') + ' Names that match nobody wait in the review queue.</p>' +
      '<div class="gs-field"><label class="gs-label" for="pr-text">Names</label><textarea class="gs-input gs-textarea gs-paste-box" id="pr-text" name="text" rows="8" data-input="paste-text" data-field="text" autocomplete="off" spellcheck="false"></textarea>' +
      '<p class="gs-field-error" id="dlg-err-text" role="alert" hidden></p></div>' +
      '<div id="pr-result" aria-live="polite"></div><p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="pr-go" data-key="pr-go">' + PASTE_ACTION.check + '</button></div></form>';
  }

  function chips(list, title, empty) {
    if (!list.length) return empty ? '<p class="gs-fine">' + esc(empty) + '</p>' : '';
    return '<h3 class="gs-h3">' + esc(title) + ' (' + esc(list.length) + ')</h3><ul class="gs-paste-list">' + list.map(function (e) {
      return '<li>' + (e.class ? G.ui.classNameHtml(e.name, e.class) : '<span class="gs-chip gs-chip-signup">' + esc(e.name) + '</span>') + '</li>';
    }).join('') + '</ul>';
  }

  function previewHtml(res) {
    const lines = res.ignoredCount > 0
      ? '<p class="gs-fine">' + esc(plural(res.ignoredCount, 'line was', 'lines were') + ' not a name and ' + (res.ignoredCount === 1 ? 'is' : 'are') + ' left out' +
        (res.ignored && res.ignored.length ? ': ' + res.ignored.map(function (i) { return '"' + i.text + '"'; }).join(', ') + (res.ignoredCount > res.ignored.length ? ' and more' : '') : '') + '.') + '</p>' : '';
    const sum = res.matched.length || res.unmatched.length
      ? '<p class="gs-commit-line"><strong>' + esc(plural(res.matched.length, 'person', 'people') + ' will be marked attended.') + '</strong> <span class="gs-fine">Nothing is saved yet.</span></p>' : '';
    return sum + chips(res.matched, 'Attended', 'Nobody matched a person on the roster.') +
      chips(res.unmatched, 'Matched nobody (they go to the review queue)') + chips(res.guests, 'Known guests (not counted)') + lines +
      (res.tooLong ? '<p class="gs-fine">Only the first 80 names are read.</p>' : '');
  }

  function setPasteButton(label) {
    const b = typeof document !== 'undefined' ? document.getElementById('pr-go') : null;
    if (b) b.textContent = label;
  }

  // The dialog walks the same three beats as every import: Source while the names are typed, Preview once they are checked.
  function setPasteStep(n) {
    const host = typeof document !== 'undefined' ? document.getElementById('pr-steps') : null;
    if (host) host.innerHTML = G.ui.stepperHtml({ steps: G.ui.IMPORT_STEPS, current: n, label: 'Import steps' });
  }

  G.handlers.input['paste-text'] = function () {
    if (paste.previewFor === null) return;
    paste.previewFor = null;
    setPasteButton(PASTE_ACTION.check);
    setPasteStep(1);
    const sink = document.getElementById('pr-result');
    if (sink) sink.innerHTML = '';
  };

  G.handlers.submit['paste-form'] = function (form) {
    const c = R().current();
    if (!c) return;
    G.ui.setText('dlg-err-text', '');
    G.ui.setText('dlg-error', '');
    const text = String(form.elements.text.value || '');
    if (!text.trim()) { const sink = document.getElementById('dlg-err-text'); if (sink) { sink.textContent = 'Paste the names first.'; sink.hidden = false; } form.elements.text.focus(); return; }
    // The second press saves what the first one showed; a changed text starts over (the input handler cleared previewFor).
    if (paste.previewFor === text) {
      return G.ui.runDialog(form, G.api.pasteRoster.save(c.gid, c.rid, text), function (res) { R().setDetail(c, res, 'Attendance saved from the pasted roster.'); });
    }
    G.ui.setBusy(form, true);
    G.api.pasteRoster.preview(c.gid, c.rid, text).then(function (res) {
      G.ui.setBusy(form, false);
      const sink = document.getElementById('pr-result');
      if (sink) sink.innerHTML = previewHtml(res);
      if (!res.matched.length && !res.unmatched.length) { setPasteButton(PASTE_ACTION.check); return; }
      paste.previewFor = text;
      setPasteButton(PASTE_ACTION.save);
      setPasteStep(2);
    }, function (err) {
      G.ui.setBusy(form, false);
      G.ui.showFormError(form, err);
    });
  };

  // ── guest sign-up link ──
  function statusPill(link) {
    const map = { active: ['ok', 'Works'], revoked: ['muted', 'Turned off'], started: ['muted', 'Raid started'], full: ['warn', 'Used up'] };
    const m = map[link.status] || ['muted', link.status];
    return '<span class="gs-pill gs-pill-' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  function joinDialogHtml(data) {
    const rows = data.links.map(function (l, i) {
      return '<li>' + statusPill(l) + '<span>' + esc(plural(l.uses, 'guest', 'guests') + ' of ' + l.maxUses) + '</span>' +
        '<span class="gs-fine">Made ' + esc(G.ui.formatDate(l.createdAt)) + '</span>' +
        (l.status === 'active' ? '<button type="button" class="gs-btn gs-btn-sm" data-action="join-revoke" data-jid="' + esc(l.id) + '" data-key="join-off-' + i + '" aria-label="Turn off this sign-up link">Turn off</button>' : '') + '</li>';
    }).join('');
    const room = data.links.filter(function (l) { return l.status === 'active'; }).length < data.limits.perRaid;
    return '<div class="gs-dialog-form gs-dialog-wide">' +
      '<h2 class="gs-dialog-title" id="dlg-title">Guest sign-up link</h2>' +
      '<p class="gs-fine" id="dlg-help">Someone with no guild account, or from another guild, opens the link and signs up as a Guest: character, class, spec and a note. It stops working when the raid starts, when you turn it off, or after the number of guests you allow.</p>' +
      (rows ? '<ul class="gs-join-rows" aria-label="Sign-up links of this raid">' + rows + '</ul>' : '<p class="gs-empty">No link yet.</p>') +
      (room
        ? '<form data-submit="join-make-form" novalidate><div class="gs-field"><label class="gs-label" for="jl-uses">Guests it allows</label><input class="gs-input" type="number" id="jl-uses" name="maxUses" min="1" max="' + esc(data.limits.maxUses) + '" value="' + esc(data.limits.defaultUses) + '" data-field="maxUses">' +
          '<p class="gs-field-error" id="dlg-err-maxUses" role="alert" hidden></p></div><p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
          '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Done</button><button type="submit" class="gs-btn gs-btn-molten">Make a link</button></div></form>'
        : '<p class="gs-fine">A raid can have ' + esc(data.limits.perRaid) + ' links that work. Turn one off to make another.</p><div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Done</button></div>') + '</div>';
  }

  function createdDialogHtml(url) {
    return '<div class="gs-dialog-form">' +
      '<h2 class="gs-dialog-title" id="dlg-title">Sign-up link made</h2>' +
      '<p class="gs-lead gs-lead-sm" id="dlg-help">Copy it now. It is shown only once; turn it off here if it gets out.</p>' +
      '<div class="gs-field"><label class="gs-label" for="join-url">Guest sign-up link</label>' +
      '<input class="gs-input gs-code" type="text" id="join-url" readonly autocomplete="off" spellcheck="false" value="' + esc(url) + '">' +
      '<p class="gs-fine" id="join-copy-status" role="status"></p></div>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-molten" data-action="join-copy" data-key="join-copy">Copy link</button>' +
      '<button type="button" class="gs-btn" data-action="dialog-cancel">Done</button></div></div>';
  }

  function openJoin(c) {
    G.api.joinLinks.list(c.gid, c.rid).then(function (data) {
      G.ui.openDialog(joinDialogHtml(data), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  G.handlers.click['join-copy'] = function () {
    const input = document.getElementById('join-url');
    G.ui.copyInput(input).then(function (copied) { G.ui.setText('join-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected link.'); });
  };

  G.handlers.click['join-revoke'] = function (el) {
    const c = R().current();
    if (!c || el.disabled) return;
    el.disabled = true;
    G.api.joinLinks.revoke(c.gid, c.rid, el.getAttribute('data-jid')).then(function (data) {
      G.ui.closeDialogOf(el);
      G.ui.openDialog(joinDialogHtml(data), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    }, function (err) { el.disabled = false; G.app.handleError(err, { pageAlert: true }); });
  };

  G.handlers.submit['join-make-form'] = function (form) {
    const c = R().current();
    if (!c) return;
    G.ui.setText('dlg-err-maxUses', '');
    const n = Number(form.elements.maxUses.value);
    if (!Number.isInteger(n) || n < 1) { const sink = document.getElementById('dlg-err-maxUses'); if (sink) { sink.textContent = 'Allow at least one guest.'; sink.hidden = false; } return; }
    return G.ui.runDialog(form, G.api.joinLinks.create(c.gid, c.rid, { maxUses: n }), function (res) {
      if (!res || !res.created || typeof res.created.path !== 'string') return;
      G.ui.openDialog(createdDialogHtml(G.ui.pageOrigin() + res.created.path), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const input = document.getElementById('join-url');
      if (input && input.select) input.select();
    });
  };

  // ── the menu's one action ──
  G.handlers.click['raid-extra'] = function (el) {
    const c = R().current();
    if (!c) return;
    const op = el.getAttribute('data-op');
    if (op === 'duties') openDuties(c);
    else if (op === 'join') openJoin(c);
    else if (op === 'paste') {
      paste = { previewFor: null };
      G.ui.openDialog(pasteDialogHtml(c.data), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const box = document.getElementById('pr-text');
      if (box) box.focus();
    }
  };

  G.pages.raidExtras = {
    FIXED: FIXED, menuItems: menuItems, dutiesLineHtml: dutiesLineHtml, dutiesDialogHtml: dutiesDialogHtml, peopleOptions: peopleOptions,
    pasteDialogHtml: pasteDialogHtml, previewHtml: previewHtml, joinDialogHtml: joinDialogHtml, createdDialogHtml: createdDialogHtml, readDuties: readDuties,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
