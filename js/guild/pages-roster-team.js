// ── PAGE: ROSTER > TEAM CHANGES (lane roster of B8b; boards TC1 to TC6) ─────────────────────────────────────────────────────────────────────────────────────
// Who is on a team is changed here and on the person record, never by editing a field:
//   Add to team       the Roster head's primary: a dialog listing the characters on no team that can go on this team (Social and Former ones and the people who already have a character
//                     on it are left out by the Worker), the core rank the character becomes, the trial that starts and the waiting request the placement approves. PUT .../characters/:cid/team.
//   Manage team       the tick mode of the Roster (head More): a checkbox per row (no links), the Off the roster group (the team's placed Social and Former characters), a bar with the
//                     count, Remove from team and Done. Remove asks each time which sign-ups go too (GET .../team-signups per character), then sends ONE release per character
//                     (DELETE .../team) so each can be refused on its own (the Seniority guard); the answer lists who left and who was skipped, with the API's message.
//   Person record     Remove from team in the head More for the characters the viewer may release (record.characters[].mayRelease): the same confirm for one character, a tick list for several.
// Reads and writes go through G.api.teamChanges. The tick mode lives in G.app.state.rosterManage ({ gid, teamId, ticked: { [characterId]: entry }, off: { status, list } }); pages-roster.js draws
// the rows and asks this file for the pieces.
(function (G) {
  'use strict';

  const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  const plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };
  const RANK_LABELS = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve', social: 'Social' };
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const SEARCH_MS = 250;
  const SIGNUPS_SHOWN = 4;

  function st() { return G.app.state; }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function byId(id) { return typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null; }
  function rankLabel(rank) { return has(RANK_LABELS, rank) ? RANK_LABELS[rank] : String(rank == null ? '' : rank); }
  function teamNameOf(gd, teamId, fallback) {
    const t = (gd && gd.teams || []).filter(function (x) { return x.id === teamId; })[0];
    return t ? t.name : fallback || 'the team';
  }
  function fold(s) { return G.rosterSort.fold(s); }

  // ── one line per character: the upcoming sign-ups a release can take with it ──
  // read = GET .../team-signups ({ signups: [{ raidOn, zone, title }], standing: [{ weekday }] }) or null when the read failed.
  function signupsText(read) {
    if (!read) return 'The upcoming sign-ups could not be read';
    const raids = (Array.isArray(read.signups) ? read.signups : []).map(function (r) { return G.ui.weekdayDay(r.raidOn) + ' ' + (r.zone || r.title || ''); }).map(function (t) { return t.trim(); });
    const shown = raids.slice(0, SIGNUPS_SHOWN).join(', ') + (raids.length > SIGNUPS_SHOWN ? ' and ' + (raids.length - SIGNUPS_SHOWN) + ' more' : '');
    const days = (Array.isArray(read.standing) ? read.standing : []).map(function (x) { return has(WEEKDAYS, x.weekday) ? WEEKDAYS[x.weekday] : ''; }).filter(Boolean);
    const standing = days.length ? 'Standing sign-up: ' + days.join(', ') : '';
    return [shown, standing].filter(Boolean).join(' \u00b7 ') || 'No upcoming sign-ups';
  }

  function listItemHtml(e, sub) {
    return '<li>' + G.ui.specIconHtml(e.class, e.mainSpec, 20) + '<span class="gs-pickid"><span class="gs-char-name ' + G.ui.classClass(e.class) + '">' + esc(e.name) + '</span><span class="gs-picksub">' + esc(sub) + '</span></span></li>';
  }

  // ── Manage team: the pieces pages-roster.js draws ──
  // A row in the tick mode: a label (no link), the checkbox first, the row's own content after it.
  function pickRowHtml(o) {
    return '<label class="gs-rs-row gs-rs-pickable' + (o.ticked ? ' is-ticked' : '') + '"' + (o.titleAttr || '') + '><span class="gs-us-chkbox"><input type="checkbox" class="gs-us-chk" data-change="roster-tick" data-cid="' + esc(o.cid) +
      '" aria-label="Select ' + esc(o.name) + '"' + (o.ticked ? ' checked' : '') + '></span>' + o.innerHtml + '</label>';
  }

  function hintHtml(teamName) {
    return '<p class="gs-fg-mut gs-us-hint">Tick the people to remove from ' + esc(teamName || 'the team') + '.</p>';
  }

  // Why a placed character is on no roster view: Former (it left the guild or was removed) or Social, and the in-game rank it holds, if any.
  function offReasonText(c) {
    if (c.kind === 'former') return c.leftReason === 'kicked' ? 'Removed from the guild' : 'Left the guild';
    return c.inGameRank ? c.inGameRank + ' in game' : '';
  }

  // The team's placed Social / Former characters (GET /roster/off-roster): the same boxes as the people below, unticked until the officer ticks them.
  function offGroupHtml(off, ticked) {
    if (!off || off.status === 'loading') return '';
    if (off.status === 'error') return '<p class="gs-fg-mut gs-us-hint" role="alert">We could not read who is off the roster.</p>';
    const list = Array.isArray(off.list) ? off.list : [];
    if (!list.length) return '';
    const rows = list.map(function (c) {
      const on = !!(ticked && ticked[c.id]);
      const reason = offReasonText(c);
      const inner = G.ui.specIconHtml(c.class, c.mainSpec, 20) + '<span class="gs-rs-id"><span class="gs-rs-name ' + G.ui.classClass(c.class) + '">' + esc(c.name) + '</span>' +
        '<span class="gs-rs-sub"><span class="gs-rs-spec">' + esc(c.mainSpec || G.ui.className(c.class)) + '</span>' + (reason ? '<span class="gs-rs-alt">' + esc(reason) + '</span>' : '') + '</span></span>' +
        '<span class="gs-hd-chip is-rose">' + (c.kind === 'former' ? 'Former' : 'Social') + '</span>';
      return pickRowHtml({ cid: c.id, name: c.name, innerHtml: inner, ticked: on });
    }).join('');
    return '<section class="gs-hd-panel gs-rs-off" aria-label="Off the roster"><h2 class="gs-fg-gh"><span class="gs-fg-ght">Off the roster</span><span class="gs-fg-ghn">' + list.length + '</span></h2><div class="gs-rs-offrows">' + rows + '</div></section>';
  }

  function tickedList(manage) { return manage ? Object.keys(manage.ticked).map(function (k) { return manage.ticked[k]; }) : []; }

  function barInner(manage) {
    const n = tickedList(manage).length;
    return '<span class="gs-us-selcount" role="status">' + n + ' selected</span><span class="gs-us-selacts">' +
      G.ui.buttonHtml({ label: 'Remove from team', size: 'sm', disabled: n === 0, attrs: { 'data-action': 'roster-remove-open', 'data-key': 'roster-remove-open' } }) +
      G.ui.buttonHtml({ label: 'Done', size: 'sm', attrs: { 'data-action': 'roster-done', 'data-key': 'roster-done' } }) + '</span>';
  }

  function barHtml(manage) {
    return '<div class="gs-hd-panel gs-us-selbar" id="roster-selbar" role="region" aria-label="Selected people">' + barInner(manage) + '</div>';
  }

  // ── Manage team: behaviour ──
  function manageOf() {
    const s = st();
    const gd = currentGd();
    const m = s.rosterManage;
    return m && gd && s.roster && m.gid === gd.guild.id && m.teamId === s.roster.teamId ? m : null;
  }

  // The thing a tick stands for: the character, its person, and where it was listed. null when the character is on no list the page holds.
  function entryFor(m, cid) {
    const s = st();
    const people = s.roster && s.roster.data && Array.isArray(s.roster.data.people) ? s.roster.data.people : [];
    const row = people.filter(function (p) { return p.shown && p.shown.id === cid; })[0];
    if (row) return { cid: cid, pid: row.id, name: row.shown.name, class: row.shown.class, mainSpec: row.shown.mainSpec, teamId: m.teamId };
    const off = m.off && Array.isArray(m.off.list) ? m.off.list.filter(function (c) { return c.id === cid; })[0] : null;
    return off ? { cid: cid, pid: off.person.id, name: off.name, class: off.class, mainSpec: off.mainSpec, teamId: m.teamId } : null;
  }

  function loadOff(m) {
    return G.api.teamChanges.offRoster(m.gid, m.teamId).then(function (res) {
      if (st().rosterManage === m) m.off = { status: 'ready', list: Array.isArray(res && res.characters) ? res.characters : [] };
    }, function () {
      if (st().rosterManage === m) m.off = { status: 'error', list: [] };
    }).then(function () { if (st().rosterManage === m) G.app.render(); });
  }

  G.handlers.click['roster-manage'] = function () {
    const s = st();
    const gd = currentGd();
    if (!gd || !s.roster || !s.roster.teamId) return;
    const m = { gid: gd.guild.id, teamId: s.roster.teamId, ticked: {}, off: { status: 'loading', list: [] } };
    s.rosterManage = m;
    G.app.render();
    loadOff(m);
  };

  G.handlers.click['roster-done'] = function () {
    st().rosterManage = null;
    G.app.render();
  };

  G.handlers.change['roster-tick'] = function (el) {
    const m = manageOf();
    if (!m) return;
    const cid = el.getAttribute('data-cid');
    const entry = cid ? entryFor(m, cid) : null;
    if (!entry) return;
    if (el.checked) m.ticked[cid] = entry; else delete m.ticked[cid];
    // The same person is in the desktop columns and the phone list (CSS shows one), and the row is tinted while ticked: all of them say the same.
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      const twins = document.querySelectorAll('[data-cid="' + cid + '"]');
      for (let i = 0; i < twins.length; i++) {
        twins[i].checked = !!el.checked;
        const row = twins[i].closest ? twins[i].closest('label') : null;
        if (row && row.classList) row.classList.toggle('is-ticked', !!el.checked);
      }
    }
    const bar = byId('roster-selbar');
    if (bar) bar.innerHTML = barInner(m);
  };

  // ── Remove from team: the confirm, the releases, the answer ──
  // entries: [{ cid, pid, name, class, mainSpec, teamId, teamName?, read }] (read = the team-signups answer or null).
  function removeDialogHtml(o) {
    const entries = o.entries;
    const n = entries.length;
    const one = n === 1 ? entries[0].name : '';
    const team = o.teamName;
    const body = '<div class="gs-hd-panel gs-rs-joins"><h3 class="gs-fg-lbl">Upcoming sign-ups for ' + esc(team) + ' raids</h3><ul class="gs-us-leave">' +
      entries.map(function (e) { return listItemHtml(e, signupsText(e.read)); }).join('') + '</ul></div>' +
      '<div class="gs-check gs-rs-alsochk"><input type="checkbox" id="rm-also" name="removeSignups"><label for="rm-also">' + (n === 1 ? 'Also remove ' + esc(one) + ' from these upcoming raids' : 'Also remove them from these upcoming raids') + '</label></div>';
    return G.ui.dialogHtml({
      kind: 'destructive', title: n === 1 ? 'Remove ' + one + ' from ' + team + '?' : 'Remove ' + n + ' people from ' + team + '?',
      text: (n === 1 ? one + ' leaves' : 'They leave') + ' the ' + team + ' roster. Past raids, attendance and loot stay. Ticking the box frees ' + (n === 1 ? 'their seat' : 'their seats') + ' in those plans.',
      bodyHtml: body, primary: { label: 'Remove from team' }, formAttrs: { 'data-submit': 'roster-remove-form' }, className: 'gs-forge',
    });
  }

  // The answer: who left and who was skipped, with the API's own sentence. done: [entry]; skipped: [{ entry, message }].
  function resultDialogHtml(o) {
    const total = o.done.length + o.skipped.length;
    const title = !o.done.length ? 'No one was removed' : o.skipped.length ? 'Removed ' + o.done.length + ' of ' + total + ' people' : total === 1 ? 'Removed ' + o.done[0].name + ' from ' + o.teamName : 'Removed ' + plural(total, 'person', 'people');
    const rows = o.done.map(function (e) { return listItemHtml(e, 'Removed from ' + (e.teamName || o.teamName)); }).join('') +
      o.skipped.map(function (x) { return listItemHtml(x.entry, x.message || 'Skipped.'); }).join('');
    return G.ui.dialogHtml({
      kind: 'form', title: title, text: o.skipped.length ? (o.skipped.length === 1 ? '1 person was skipped.' : o.skipped.length + ' people were skipped.') : '',
      bodyHtml: '<div class="gs-hd-panel gs-rs-joins"><ul class="gs-us-leave">' + rows + '</ul></div>',
      cancel: false, primary: { label: 'Done' }, formAttrs: { 'data-submit': 'roster-remove-done' }, className: 'gs-forge',
    });
  }

  function readSignups(gid, entries) {
    return Promise.all(entries.map(function (e) {
      return G.api.teamChanges.signups(gid, e.pid, e.cid).then(function (read) { return Object.assign({}, e, { read: read }); }, function (err) {
        if (G.api.classify(err).view === 'signin') throw err;
        return Object.assign({}, e, { read: null });
      });
    }));
  }

  // One release per character, one after the other: the answer of each stands on its own. A sign-out stops everything; any other refusal is that character's skip.
  // -> { done: [entry], skipped: [{ entry, message }], last: the last reply that worked }
  function releaseAll(gid, entries, removeSignups) {
    const out = { done: [], skipped: [], last: null };
    return entries.reduce(function (p, e) {
      return p.then(function () {
        return G.api.teamChanges.release(gid, e.pid, e.cid, { fromTeamId: e.teamId, removeSignups: !!removeSignups }).then(function (res) {
          out.done.push(e);
          out.last = res;
        }, function (err) {
          if (G.api.classify(err).view === 'signin') throw err;
          out.skipped.push({ entry: e, message: G.api.classify(err).text });
        });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  let removeTarget = null; // what the open Remove dialog removes: { mode: 'roster' | 'person', gid, teamName, entries }

  G.handlers.click['roster-remove-open'] = function () {
    const m = manageOf();
    const gd = currentGd();
    const entries = tickedList(m);
    if (!m || !gd || !entries.length) return;
    const teamName = (st().roster.data.team && st().roster.data.team.name) || teamNameOf(gd, m.teamId);
    readSignups(gd.guild.id, entries).then(function (withReads) {
      if (manageOf() !== m) return;
      removeTarget = { mode: 'roster', gid: gd.guild.id, teamName: teamName, entries: withReads };
      G.ui.openDialog(removeDialogHtml({ teamName: teamName, entries: withReads }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    }, function (err) { if (G.api.classify(err).view === 'signin') G.app.requireSignin(); });
  };

  // The release calls from the open dialog (the Roster's tick list, or the person record's one character); the dialog turns into the answer.
  function signedOut(form) { G.ui.closeDialogOf(form); G.app.requireSignin(); }

  function showResult(form, target, out) {
    const dlg = form.closest ? form.closest('dialog') : null;
    const html = resultDialogHtml({ teamName: target.teamName, done: out.done, skipped: out.skipped });
    if (dlg) G.ui.replaceDialogBody(dlg, html); else G.ui.openDialog(html, { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    return afterReleases(target, out);
  }

  function submitRemove(form, entries) {
    const target = removeTarget;
    if (!target || !entries.length) return;
    const also = form.querySelector('input[name="removeSignups"]');
    G.ui.setText('dlg-error', '');
    G.ui.setBusy(form, true);
    releaseAll(target.gid, entries, !!(also && also.checked)).then(function (out) {
      // From the person record, a clean run just closes the dialog and the record shows it; anything skipped is told first.
      if (target.mode === 'person' && !out.skipped.length) { G.ui.closeDialogOf(form); return afterReleases(target, out); }
      return showResult(form, target, out);
    }, function () { signedOut(form); });
  }

  G.handlers.submit['roster-remove-form'] = function (form) { if (removeTarget) submitRemove(form, removeTarget.entries); };

  G.handlers.submit['roster-remove-done'] = function (form) { G.ui.closeDialogOf(form); };

  // Every release that worked leaves the selection (the skipped stay ticked); the pages that show the person are read again.
  function afterReleases(target, out) {
    const s = st();
    if (out.last) G.app.applyFlags(target.gid, out.last);
    if (target.mode === 'person') {
      if (out.last) G.app.setPerson(target.gid, out.last);
      G.app.render();
      return null;
    }
    const m = manageOf();
    if (m) {
      out.done.forEach(function (e) { delete m.ticked[e.cid]; });
      if (!Object.keys(m.ticked).length && !out.skipped.length) s.rosterManage = null;
    }
    const teamId = m ? m.teamId : (s.roster && s.roster.teamId);
    return G.app.refreshRoster(target.gid, teamId).then(function () { return m && s.rosterManage === m ? loadOff(m) : null; });
  }

  // ── the person record: Remove from team ──
  // The characters of this record the viewer may take off their team: the Worker's answer per character (mayRelease: roster.edit on the team and the Seniority guard).
  function releasableOf(record) {
    return (record && Array.isArray(record.characters) ? record.characters : []).filter(function (c) { return c.mayRelease === true && c.team && c.team.id; });
  }

  // One character: the same confirm as the Roster's. Several: a tick list, the primary waits for a tick.
  function personRemoveDialogHtml(entries) {
    if (entries.length === 1) return removeDialogHtml({ teamName: entries[0].teamName, entries: entries });
    const rows = entries.map(function (e) {
      return '<li><label class="gs-pickrow"><input type="checkbox" class="gs-us-chk" name="release" value="' + esc(e.cid) + '" data-change="person-remove-pick">' + G.ui.specIconHtml(e.class, e.mainSpec, 20) +
        '<span class="gs-pickid"><span class="gs-char-name ' + G.ui.classClass(e.class) + '">' + esc(e.name) + '</span><span class="gs-picksub">' + esc(e.teamName + ' \u00b7 ' + signupsText(e.read)) + '</span></span></label></li>';
    }).join('');
    const body = '<ul class="gs-pick" aria-label="Characters on a team">' + rows + '</ul>' +
      '<div class="gs-check gs-rs-alsochk"><input type="checkbox" id="rm-also" name="removeSignups"><label for="rm-also">Also remove them from their upcoming raids</label></div>';
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Remove from a team', text: 'Tick the characters to take off their team. Past raids, attendance and loot stay.',
      bodyHtml: body, primary: { label: 'Remove from team', disabled: true, attrs: { id: 'person-remove-go' } }, formAttrs: { 'data-submit': 'person-remove-form' }, className: 'gs-forge',
    });
  }

  G.handlers.change['person-remove-pick'] = function (el) {
    const form = el.closest ? el.closest('form') : null;
    if (!form) return;
    const ticked = form.querySelectorAll('input[name="release"]:checked');
    const go = form.querySelector('#person-remove-go');
    if (go) go.disabled = !ticked.length;
  };

  G.handlers.click['person-remove-team'] = function () {
    const s = st();
    const gd = currentGd();
    const record = s.person && s.person.record;
    const chars = releasableOf(record);
    if (!gd || !record || !chars.length) return;
    const entries = chars.map(function (c) { return { cid: c.id, pid: record.person.id, name: c.name, class: c.class, mainSpec: c.mainSpec, teamId: c.team.id, teamName: c.team.name }; });
    readSignups(gd.guild.id, entries).then(function (withReads) {
      removeTarget = { mode: 'person', gid: gd.guild.id, teamName: withReads[0].teamName, entries: withReads };
      G.ui.openDialog(personRemoveDialogHtml(withReads), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    }, function (err) { if (G.api.classify(err).view === 'signin') G.app.requireSignin(); });
  };

  // The tick list of a person with several characters on teams: only the ticked ones are released.
  G.handlers.submit['person-remove-form'] = function (form) {
    if (!removeTarget) return;
    const picked = {};
    const boxes = form.querySelectorAll('input[name="release"]:checked');
    for (let i = 0; i < boxes.length; i++) picked[boxes[i].value] = true;
    submitRemove(form, removeTarget.entries.filter(function (e) { return picked[e.cid]; }));
  };

  // ── Add to team ──
  // state: { gid, teamId, teamName, trialDays, today, status ('loading' | 'ready' | 'error'), list: [character], more, q, picked (character id), error }
  let add = null;
  let addTimer = null;
  let addSeq = 0;

  function visibleOf(a) {
    const q = fold(a.q).trim();
    return a.list.filter(function (c) { return !q || fold(c.name).indexOf(q) >= 0; });
  }

  function subText(c, a) {
    const parts = [(c.mainSpec ? c.mainSpec + ' ' : '') + G.ui.className(c.class)];
    if (c.inGameRank) parts.push('in-game ' + c.inGameRank);
    if (c.requestedTeamId && c.requestedTeamId === a.teamId) parts.push('asked for ' + a.teamName);
    return parts.join(' \u00b7 ');
  }

  function pickRowsHtml(a) {
    if (a.status === 'loading') return '<p class="gs-fg-mut" role="status">Loading characters...</p>';
    if (a.status === 'error') return '<p class="gs-alert" role="alert">' + esc(a.error || 'We could not load the characters.') + '</p>';
    const list = visibleOf(a);
    if (!list.length) return '<p class="gs-fg-mut" role="status">' + (a.q.trim() ? 'No character matches "' + esc(a.q.trim()) + '".' : 'No characters to add.') + '</p>';
    return '<ul class="gs-pick" role="radiogroup" aria-label="Characters with no team">' + list.map(function (c) {
      const on = a.picked === c.id;
      return '<li><label class="gs-pickrow' + (on ? ' is-picked' : '') + '"><input type="radio" class="gs-fg-radio" name="pick" value="' + esc(c.id) + '" data-change="team-add-pick"' + (on ? ' checked' : '') + '>' +
        G.ui.specIconHtml(c.class, c.mainSpec, 20) + '<span class="gs-pickid"><span class="gs-char-name ' + G.ui.classClass(c.class) + '">' + esc(c.name) + '</span><span class="gs-picksub">' + esc(subText(c, a)) + '</span></span>' +
        '<span class="gs-pickrank">' + esc(rankLabel(c.status)) + '</span></label></li>';
    }).join('') + '</ul>' + (a.more ? '<p class="gs-fine gs-us-pickmore">Showing the first ' + a.list.length + '. Search to narrow the list.</p>' : '');
  }

  // What the placement does to the picked character: the rank it holds, the trial it starts, the request it settles.
  function whatHappensHtml(a) {
    const c = a.list.filter(function (x) { return x.id === a.picked; })[0];
    if (!c) return '';
    const kv = function (k, v, sub) { return '<div class="gs-pr-kv"><span class="gs-pr-k">' + esc(k) + '</span><span class="gs-pr-v">' + esc(v) + (sub ? ' <span class="gs-fine gs-rs-kvsub">' + esc(sub) + '</span>' : '') + '</span></div>'; };
    const rows = [kv('Rank', rankLabel(c.status) + (c.inGameRank ? ' (in-game ' + c.inGameRank + ')' : ''), c.status === 'trial' && c.inGameRank ? 'A promotion in game ends the trial.' : '')];
    if (c.status === 'trial') {
      if (c.trialEnd) rows.push(kv('Trial', 'Ends ' + G.ui.shortDay(c.trialEnd)));
      else rows.push(kv('Trial', 'Starts today, ends ' + G.ui.shortDay(G.ui.addDays(a.today, a.trialDays)), a.trialDays + ' days, ' + a.teamName + '\'s trial length.'));
    }
    if (c.requestedTeamId && c.requestedTeamId === a.teamId) rows.push(kv('Request', c.name + '\'s request for ' + a.teamName + ' is approved'));
    return '<h3 class="gs-fg-lbl">What happens</h3>' + rows.join('');
  }

  function addDialogHtml(a) {
    const picked = a.list.filter(function (x) { return x.id === a.picked; })[0];
    return G.ui.dialogHtml({
      kind: 'form', title: 'Add to ' + a.teamName, text: 'Pick a guild member\'s character.',
      bodyHtml: '<div class="gs-rs-search gs-us-picksearch"><label class="gs-sr" for="team-add-search">Search characters</label>' + G.icons.icon('search', 16) +
        '<input class="gs-rs-input" type="search" id="team-add-search" placeholder="Search characters" data-input="team-add-search" autocomplete="off" value="' + esc(a.q) + '"></div>' +
        '<div id="team-add-list" aria-live="polite">' + pickRowsHtml(a) + '</div><div class="gs-hd-panel gs-rs-joins" id="team-add-what"' + (picked ? '' : ' hidden') + '>' + whatHappensHtml(a) + '</div>',
      primary: { label: picked ? 'Add ' + picked.name : 'Add', disabled: !picked, attrs: { id: 'team-add-go' } }, formAttrs: { 'data-submit': 'team-add-form' }, className: 'gs-forge gs-dialog-add',
    });
  }

  // The list, the panel and the primary drawn again in place: the search box keeps its focus.
  function redrawAdd() {
    if (!add) return;
    const list = byId('team-add-list');
    const what = byId('team-add-what');
    const go = byId('team-add-go');
    const picked = add.list.filter(function (x) { return x.id === add.picked; })[0];
    if (list) list.innerHTML = pickRowsHtml(add);
    if (what) { what.innerHTML = whatHappensHtml(add); what.hidden = !picked; }
    if (go) {
      go.disabled = !picked;
      const label = go.querySelector ? go.querySelector('span') : null;
      if (label) label.textContent = picked ? 'Add ' + picked.name : 'Add';
    }
  }

  function loadAdd(a, q) {
    const mine = ++addSeq;
    return G.api.teamChanges.unassigned(a.gid, a.teamId, q).then(function (res) {
      if (add !== a || mine !== addSeq) return;
      a.status = 'ready';
      a.list = Array.isArray(res && res.characters) ? res.characters : [];
      a.more = !!(res && res.more);
      if (a.picked && !a.list.some(function (c) { return c.id === a.picked; })) a.picked = null;
    }, function (err) {
      if (add !== a || mine !== addSeq) return;
      if (G.api.classify(err).view === 'signin') { G.app.requireSignin(); return; }
      a.status = 'error';
      a.error = G.api.classify(err).text;
    }).then(function () { redrawAdd(); });
  }

  G.handlers.click['roster-add-team'] = function () {
    const s = st();
    const gd = currentGd();
    if (!gd || !s.roster || !s.roster.data || !s.roster.data.team) return;
    const team = s.roster.data.team;
    const days = Number(team.trialDays);
    add = { gid: gd.guild.id, teamId: team.id, teamName: team.name, trialDays: Number.isInteger(days) && days >= 1 ? days : G.pages.roster.DEFAULT_TRIAL_DAYS, today: s.roster.data.today,
      status: 'loading', list: [], more: false, q: '', picked: null, error: '' };
    G.ui.openDialog(addDialogHtml(add), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
    const input = byId('team-add-search');
    if (input && input.focus) input.focus();
    loadAdd(add, '');
  };

  G.handlers.input['team-add-search'] = function (el) {
    if (!add) return;
    add.q = el.value;
    redrawAdd();
    if (!add.more) return;
    // More than one page of characters: the Worker narrows the list by the start of the name.
    if (addTimer) clearTimeout(addTimer);
    const a = add;
    addTimer = setTimeout(function () { if (add === a) loadAdd(a, a.q.trim()); }, SEARCH_MS);
  };

  G.handlers.change['team-add-pick'] = function (el) {
    if (!add) return;
    add.picked = el.value;
    const rows = typeof document !== 'undefined' && document.querySelectorAll ? document.querySelectorAll('#team-add-list .gs-pickrow') : [];
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('is-picked', !!rows[i].querySelector('input:checked'));
    redrawAdd();
  };

  G.handlers.submit['team-add-form'] = function (form) {
    const a = add;
    if (!a) return;
    const c = a.list.filter(function (x) { return x.id === a.picked; })[0];
    G.ui.setText('dlg-error', '');
    if (!c) { G.ui.setText('dlg-error', 'Pick a character.'); return; }
    G.ui.runDialog(form, G.api.teamChanges.place(a.gid, c.person.id, c.id, a.teamId), function (res) {
      const s = st();
      G.app.applyFlags(a.gid, res);
      s.rosterNotice = 'Added ' + c.name + ' to ' + a.teamName + (res && res.approvedRequestId ? ' and approved their request.' : '.');
      add = null;
      // The list and the waiting requests are read again; the request the placement settled leaves Needs you.
      return G.pages.teamRequests.read(a.gid).then(function () { return G.app.refreshRoster(a.gid, a.teamId); });
    });
  };

  G.pages.rosterTeam = {
    pickRowHtml: pickRowHtml,
    hintHtml: hintHtml,
    offGroupHtml: offGroupHtml,
    barHtml: barHtml,
    signupsText: signupsText,
    addDialogHtml: addDialogHtml,
    removeDialogHtml: removeDialogHtml,
    resultDialogHtml: resultDialogHtml,
    personRemoveDialogHtml: personRemoveDialogHtml,
    releasableOf: releasableOf,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
