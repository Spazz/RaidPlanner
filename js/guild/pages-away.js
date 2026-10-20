// ── PAGES: AWAY NOTICES ─────────────────────────────────────────
// T1 list page (Away notices, the viewer's own notices) and a form dialog. A member tells the officers when they will miss a raid (Away), arrive late (Late) or leave early (Leaving early), for a date range or for one
// weekday every week. Three places draw the same notices: the page "Away notices" (#/g/:gid/away, GET /away/mine: my own), the officers' card
// "Away, next 4 weeks" on the Raids page (GET /away?team=) and the officers' section on a person's record (GET /away?person=). Add and Edit are one
// dialog (POST /away, PUT /away/:nid), Remove asks first (DELETE /away/:nid). The officers' card and section load themselves after the page is
// drawn (afterRender), so the pages they sit on read exactly what they did before.
(function (G) {
  'use strict';

  const REASON_MAX = 120;
  const KIND_CHOICES = [['away', 'Away'], ['late', 'Late'], ['leaving', 'Leaving early']];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; // 0 = Sunday, as the Worker numbers them
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // the week reads Monday first
  const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const FIELDS = ['personId', 'kind', 'atTime', 'weekday', 'from', 'to', 'reason'];

  function A() { return G.pages.attendance; }
  function a() { return A().attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }

  // ── words ──
  function dayText(d) { return G.ui.shortDay(d) || String(d == null ? '' : d); }

  function weekdayOfDate(s) {
    const m = DATE.exec(String(s == null ? '' : s));
    return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() : 1;
  }

  // One notice as a plain sentence: "Away Oct 20 - Oct 27", "Away every Thursday from Oct 20", "Late, arriving 21:00, every Tuesday until Dec 1".
  // today (the guild's date) only decides whether a weekly notice says when it starts. n: { kind, atTime, from, to, weekday }.
  function noticeText(n, today) {
    const head = n.kind === 'late' ? 'Late, arriving ' + (n.atTime || '') : n.kind === 'leaving' ? 'Leaving early, at ' + (n.atTime || '') : 'Away';
    let when;
    if (n.weekday == null) {
      when = n.to && n.to !== n.from ? dayText(n.from) + ' - ' + dayText(n.to) : dayText(n.from);
    } else {
      when = 'every ' + (WEEKDAYS[n.weekday] || '') + (today && n.from > today ? ' from ' + dayText(n.from) : '') + (n.to ? ' until ' + dayText(n.to) : '');
    }
    return head + (n.kind === 'away' ? ' ' : ', ') + when;
  }

  // A notice that has ended (its last day is before today); an open-ended weekly one never has.
  function isPast(n, today) { return !!today && !!n.to && n.to < today; }

  // ── one notice in a list ──
  // o: { ctx ('mine' | 'team' | 'person'), today, pid (person ctx), who (team ctx: show the name) }
  function noticeAttrs(n, o, action, keyPrefix) {
    const id = n.id || n.noticeId;
    const attrs = { 'data-action': action, 'data-ctx': o.ctx, 'data-nid': id, 'data-key': keyPrefix + id };
    if (o.pid) attrs['data-pid'] = o.pid;
    return attrs;
  }

  function noticeActionsHtml(n, o) {
    const label = noticeText(n, o.today) + (o.who ? ' for ' + n.name : '');
    return '<div class="gs-row-actions">' + G.ui.buttonHtml({ label: 'Edit', size: 'sm', ariaLabel: 'Edit: ' + label, attrs: noticeAttrs(n, o, 'away-edit', 'an-edit-') }) +
      G.ui.buttonHtml({ label: 'Remove', size: 'sm', variant: o.ctx === 'team' ? 'secondary' : 'ghost', ariaLabel: 'Remove: ' + label, attrs: noticeAttrs(n, o, 'away-remove', 'an-remove-') }) + '</div>';
  }

  function rowHtml(n, o) {
    const text = noticeText(n, o.today);
    const who = o.who ? '<span class="gs-an-who"><a class="gs-char-link ' + G.ui.classClass(n.class) + '" href="' + esc(G.router.format({ name: 'person', gid: o.gid, pid: n.personId })) + '">' + esc(n.name) + '</a></span>' : '';
    const dates = o.who && n.weekday != null && Array.isArray(n.dates) && n.dates.length ? '<span class="gs-fine">' + esc(n.dates.map(dayText).join(', ')) + '</span>' : '';
    return '<li class="gs-an-item"><div class="gs-an-text">' + who + '<span class="gs-an-what">' + esc(text) + '</span>' + dates +
      (n.reason ? '<span class="gs-fine gs-an-reason">Reason: ' + esc(n.reason) + '</span>' : '') + '</div>' + noticeActionsHtml(n, o) + '</li>';
  }

  function listHtml(items, o, label) {
    return '<ul class="gs-an-list" aria-label="' + esc(label) + '">' + items.map(function (n) { return rowHtml(n, o); }).join('') + '</ul>';
  }

  // Not ended first (soonest start first), ended ones apart (latest end first).
  function split(notices, today) {
    const list = Array.isArray(notices) ? notices : [];
    const current = list.filter(function (n) { return !isPast(n, today); }).sort(function (x, y) { return x.from < y.from ? -1 : x.from > y.from ? 1 : 0; });
    const past = list.filter(function (n) { return isPast(n, today); }).sort(function (x, y) { return x.to < y.to ? 1 : x.to > y.to ? -1 : 0; });
    return { current: current, past: past };
  }

  // ── the page: my notices (T1) ──
  // The notices as the data table (cards on a phone): the sentence is the row, then the reason, then Edit and Remove. They are all the viewer's own.
  function tableHtml(items, o, label) {
    const rows = items.map(function (n) {
      return { id: n.id || n.noticeId, ariaLabel: noticeText(n, o.today), cells: {
        what: esc(noticeText(n, o.today)), reason: n.reason ? esc(n.reason) : '', actions: noticeActionsHtml(n, o),
      } };
    });
    return G.ui.dataTableHtml({ label: label, limit: 100, columns: [
      { key: 'what', label: 'Notice', primary: true }, { key: 'reason', label: 'Reason' }, { key: 'actions', label: 'Row actions', srLabel: true, hideLabel: true },
    ], rows: rows, noun: 'notices' });
  }

  function pastHtml(past, o, open) {
    if (!past.length) return '';
    return '<section class="gs-fold" aria-labelledby="an-past-h"><h3 class="gs-h3" id="an-past-h"><button type="button" class="gs-fold-btn" data-action="away-past" data-key="an-past" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="an-past-list">' +
      '<span>Past (' + past.length + ')</span>' + G.icons.icon('chevronDown', 18) + '</button></h3>' +
      '<div id="an-past-list"' + (open ? '' : ' hidden') + '>' + tableHtml(past, o, 'Past notices') + '</div></section>';
  }

  // opts: { guildData, state: { gid, data (GET /away/mine), showPast, note } , alert }
  function mineHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const d = x.data || {};
    const gid = gd.guild.id;
    const zone = d.timeZone || gd.guild.timeZone || '';
    const context = 'Tell your officers when you will miss a raid, arrive late or leave early. Dates are the guild\'s calendar days' + (zone ? ' (' + zone + ')' : '') + '.';
    const note = x.note ? G.ui.bannerHtml({ tone: 'success', text: x.note }) : '';
    if (!d.personId) {
      return G.ui.listPageHtml({
        head: { title: 'Away notices', context: context },
        noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert'),
        bodyHtml: G.ui.emptyStateHtml({ kind: 'first', icon: 'roster', title: 'No roster entry yet', text: 'Ask an officer to link your account to your roster entry. Away notices belong to your roster entry.' }),
      });
    }
    const parts = split(d.notices, d.today);
    const o = { ctx: 'mine', today: d.today, gid: gid };
    // The cap counts the notices that are current or still ahead (the Worker's `active`); without it, every notice in the list.
    const live = typeof d.active === 'number' ? d.active : (Array.isArray(d.notices) ? d.notices.length : 0);
    const full = Array.isArray(d.notices) && typeof d.max === 'number' && live >= d.max;
    const body = parts.current.length
      ? tableHtml(parts.current, o, 'Current and upcoming notices')
      : G.ui.emptyStateHtml({ kind: parts.past.length ? 'filtered' : 'first', icon: 'roster', title: parts.past.length ? 'No current or upcoming notices' : 'You have no away notices',
        text: parts.past.length ? 'Past notices are listed below.' : 'Add one when you will miss a raid, arrive late or leave early. Your officers see it on the Raids page.' });
    return G.ui.listPageHtml({
      head: { title: 'Away notices', context: context, primary: { label: 'Add a notice', disabled: full, attrs: { 'data-action': 'away-add', 'data-ctx': 'mine', 'data-key': 'an-add' } } },
      noticesHtml: G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + note,
      bodyHtml: body + (full ? '<p class="gs-fine">You have ' + d.max + ' notices, the most there can be. Remove one to add another.</p>' : '') + pastHtml(parts.past, o, !!x.showPast),
      footHtml: 'Only you and your officers see these notices and their reasons.',
    });
  }

  function loadMine(r, gd) {
    const gid = gd.guild.id;
    return G.api.away.mine(gid).then(function (data) {
      const prev = a().away;
      a().away = { gid: gid, data: data, showPast: !!(prev && prev.gid === gid && prev.showPast), note: '' };
      return null;
    });
  }

  function mainMine(r, gd) {
    const x = a().away;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return mineHtml({ guildData: gd, state: x, alert: G.app.state.pageAlert });
  }

  // ── the officers' panel in the Raids list's rail ──
  // opts: { guildData, teamId, state: a().awayTeam, footHtml (a button under the list: Create upcoming raids) }. Nothing for anyone without raids.edit on the team,
  // and nothing while it loads unless there is a footHtml to show.
  function teamCardHtml(opts) {
    const gd = opts.guildData;
    const s = opts.state;
    if (!G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', opts.teamId)) return '';
    const foot = opts.footHtml || '';
    const ready = s && s.gid === gd.guild.id && s.teamId === opts.teamId && s.status !== 'loading';
    const panel = function (headExtra, body) {
      return '<section class="gs-hd-panel gs-rl-panel gs-an-team" aria-labelledby="an-team-h"><div class="gs-rl-head"><h2 class="gs-hd-sl" id="an-team-h">Away in the next 4 weeks</h2>' + headExtra + '</div><div class="gs-rl-body">' + body + foot + '</div></section>';
    };
    if (!ready) return foot ? panel('', '') : '';
    const add = G.ui.buttonHtml({ label: 'Add a notice', size: 'sm', attrs: { 'data-action': 'away-add', 'data-ctx': 'team', 'data-key': 'an-team-add' } });
    let body;
    if (s.status === 'error') {
      body = '<p class="gs-alert" role="alert">' + esc(s.message || 'Could not load the away notices.') + '</p><div class="gs-row-actions">' + G.ui.buttonHtml({ label: 'Try again', size: 'sm', attrs: { 'data-action': 'away-team-retry', 'data-key': 'an-team-retry' } }) + '</div>';
    } else {
      const d = s.data || {};
      const entries = Array.isArray(d.entries) ? d.entries : [];
      body = entries.length ? listHtml(entries, { ctx: 'team', today: d.today, who: true, gid: gd.guild.id }, 'Away notices of the next 4 weeks') : '<p class="gs-fine">No one has an away notice for the next 4 weeks.</p>';
    }
    return panel(s.status === 'error' ? '' : add, body);
  }

  // A member's line in the rail: "You're away Nov 4 - Add a notice" when their own notices were already read (GET /away/mine, the Away notices page), else just the
  // link to that page. The link is the way to add a notice; the Raids list makes no call of its own for it.
  // opts: { guildData, state: a().away }
  function memberLineHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const href = esc(G.router.format({ name: 'away', gid: gd.guild.id }));
    const d = x && x.gid === gd.guild.id && x.data && x.data.personId ? x.data : null;
    const mine = d ? split(d.notices, d.today).current.filter(function (n) { return n.kind === 'away'; })[0] : null;
    const text = mine ? "You're away " + (mine.weekday != null ? 'every ' + WEEKDAYS[mine.weekday] : (mine.to && mine.to !== mine.from ? dayText(mine.from) + ' - ' + dayText(mine.to) : dayText(mine.from))) + ' - ' : '';
    return '<section class="gs-hd-panel gs-rl-panel gs-an-mine" aria-label="Away notice"><div class="gs-rl-body"><p class="gs-rl-line gs-rl-away">' + esc(text) +
      '<a class="gs-rl-link" href="' + href + '">' + (mine ? 'Add a notice' : 'Add an away notice') + '</a></p></div></section>';
  }

  function loadTeam(gid, teamId, forList) {
    const s = a().awayTeam = { gid: gid, teamId: teamId, status: 'loading', data: null, message: '', forList: forList || null };
    return G.api.away.team(gid, teamId).then(function (data) {
      if (a().awayTeam !== s) return null;
      s.status = 'ok';
      s.data = data;
      G.app.render();
      return null;
    }, function (err) {
      if (a().awayTeam !== s) return null;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return null; }
      s.status = 'error';
      s.message = cl.text;
      G.app.render();
      return null;
    });
  }

  // ── the officers' section on a person's record ──
  // May this viewer edit the notices of the person? (raids.edit on a team the person has a character on; the Worker decides in the end.)
  function canEditPerson(gd, record) {
    const can = gd && gd.me && gd.me.can;
    return (record && Array.isArray(record.characters) ? record.characters : []).some(function (c) { return c.team && G.shell.allowsTeam(can, 'raids.edit', c.team.id); });
  }

  // opts: { guildData, record, state: a().awayPerson }  ->  the Away notices section of the person page (T2), or null
  function personSectionOf(opts) {
    const gd = opts.guildData;
    const record = opts.record;
    const s = opts.state;
    const pid = record && record.person ? record.person.id : null;
    if (!s || !pid || s.gid !== gd.guild.id || s.pid !== pid || !canEditPerson(gd, record) || s.status === 'loading' || s.status === 'denied') return null;
    let body;
    if (s.status === 'error') {
      body = '<p class="gs-alert" role="alert">' + esc(s.message || 'Could not load the away notices.') + '</p><div class="gs-row-actions">' + G.ui.buttonHtml({ label: 'Try again', size: 'sm', attrs: { 'data-action': 'away-person-retry', 'data-key': 'an-person-retry' } }) + '</div>';
    } else {
      const d = s.data || {};
      const parts = split(d.notices, d.today);
      const all = parts.current.concat(parts.past);
      body = all.length ? listHtml(all, { ctx: 'person', today: d.today, pid: pid, gid: gd.guild.id }, 'Away notices of this person') : '<p class="gs-fine">No away notices.</p>';
    }
    return { id: 'away', title: 'Away notices', bodyHtml: body,
      actionsHtml: s.status === 'error' ? '' : G.ui.buttonHtml({ label: 'Add a notice', size: 'sm', attrs: { 'data-action': 'away-add', 'data-ctx': 'person', 'data-pid': pid, 'data-key': 'an-person-add' } }) };
  }

  function personCardHtml(opts) {
    const section = personSectionOf(opts);
    return section ? G.ui.objectSectionHtml(section) : '';
  }

  function loadPerson(gid, pid, forPerson) {
    const s = a().awayPerson = { gid: gid, pid: pid, status: 'loading', data: null, message: '', forPerson: forPerson || null };
    return G.api.away.person(gid, pid).then(function (data) {
      if (a().awayPerson !== s) return null;
      s.status = 'ok';
      s.data = data;
      G.app.render();
      return null;
    }, function (err) {
      if (a().awayPerson !== s) return null;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return null; }
      s.status = err && (err.status === 403 || err.status === 404) ? 'denied' : 'error';
      s.message = cl.text;
      G.app.render();
      return null;
    });
  }

  // Called by the app after each render of a guild page: the Raids page (officers) and the person record load their away data once.
  function afterRender(r) {
    const gd = currentGd();
    if (!gd || !r) return;
    const gid = gd.guild.id;
    if (r.name === 'section' && r.section === 'raids') {
      const x = a().raids;
      if (!x || x.gid !== gid || !x.teamId || !x.data || !(x.data.can && x.data.can.edit)) return;
      if (a().awayTeam && a().awayTeam.forList === x) return;
      loadTeam(gid, x.teamId, x);
    } else if (r.name === 'person') {
      const p = G.app.state.person;
      if (!p || p.gid !== gid || p.pid !== r.pid || !p.record || !canEditPerson(gd, p.record)) return;
      if (a().awayPerson && a().awayPerson.forPerson === p) return;
      loadPerson(gid, r.pid, p);
    }
  }

  // ── the Add / Edit dialog ──
  function labelsFor(kind, repeat) {
    return {
      time: kind === 'late' ? 'Arriving at' : 'Leaving at',
      from: repeat === 'weekly' ? 'Starting' : 'From',
      to: repeat === 'weekly' ? 'Until (optional)' : 'To',
    };
  }

  // opts: { mode ('add' | 'edit'), ctx, nid (edit), personId (add for someone else), people [{ id, name }] (team: the picker), notice (edit), today, minToday, who (name shown in the help) }
  function dialogHtml(opts) {
    const n = opts.notice || null;
    const kind = n ? n.kind : 'away';
    const repeat = n && n.weekday != null ? 'weekly' : 'range';
    const labels = labelsFor(kind, repeat);
    const weekday = n && n.weekday != null ? n.weekday : weekdayOfDate(opts.today);
    const from = n ? n.from : (opts.today || '');
    const minDate = opts.minToday && opts.today ? (n && n.from < opts.today ? n.from : opts.today) : '';
    const field = function (name, label, control, extra) {
      return '<div class="gs-field"' + (extra || '') + '>' + label + control + '<p class="gs-field-error" id="dlg-err-' + name + '" role="alert" hidden></p></div>';
    };
    const person = opts.people
      ? field('personId', '<label class="gs-label" for="an-person">Person</label>',
        '<select class="gs-input" id="an-person" name="person" data-field="personId"><option value="">Choose a person</option>' + G.ui.optionsHtml(opts.people.map(function (p) { return { value: p.id, label: p.name }; }), '') + '</select>')
      : '';
    const help = opts.who ? 'For ' + esc(opts.who) + '.' : 'Only you and your officers see the reason.';
    const body = '<p class="gs-fine" id="dlg-help">' + help + ' Dates are the guild\'s calendar days.</p>' + person +
      field('kind', '<label class="gs-label" for="an-kind">What</label>',
        '<select class="gs-input" id="an-kind" name="kind" data-field="kind" data-change="away-form-change" data-key="an-kind">' + G.ui.optionsHtml(KIND_CHOICES.map(function (k) { return { value: k[0], label: k[1] }; }), kind) + '</select>') +
      field('atTime', '<label class="gs-label" id="an-time-label" for="an-time">' + esc(labels.time) + '</label>',
        '<input class="gs-input" type="time" id="an-time" name="atTime" data-field="atTime" value="' + esc(n && n.atTime ? n.atTime : '') + '">', ' id="an-time-field"' + (kind === 'away' ? ' hidden' : '')) +
      field('repeat', '<label class="gs-label" for="an-repeat">When</label>',
        '<select class="gs-input" id="an-repeat" name="repeat" data-field="repeat" data-change="away-form-change" data-key="an-repeat">' + G.ui.optionsHtml([{ value: 'range', label: 'A date range' }, { value: 'weekly', label: 'Every week on one day' }], repeat) + '</select>') +
      field('weekday', '<label class="gs-label" for="an-weekday">Day of the week</label>',
        '<select class="gs-input" id="an-weekday" name="weekday" data-field="weekday">' + G.ui.optionsHtml(WEEKDAY_ORDER.map(function (d) { return { value: d, label: WEEKDAYS[d] }; }), weekday) + '</select>', ' id="an-weekday-field"' + (repeat === 'weekly' ? '' : ' hidden')) +
      field('from', '<label class="gs-label" id="an-from-label" for="an-from">' + esc(labels.from) + '</label>',
        '<input class="gs-input" type="date" id="an-from" name="from" data-field="from" data-change="away-from-change" data-key="an-from"' + (minDate ? ' min="' + esc(minDate) + '"' : '') + ' value="' + esc(from) + '">') +
      field('to', '<label class="gs-label" id="an-to-label" for="an-to">' + esc(labels.to) + '</label>',
        '<input class="gs-input" type="date" id="an-to" name="to" data-field="to" value="' + esc(n ? (n.to || '') : (repeat === 'range' ? from : '')) + '">') +
      field('reason', '<label class="gs-label" for="an-reason">Reason (optional)</label>',
        '<input class="gs-input" type="text" id="an-reason" name="reason" data-field="reason" maxlength="' + REASON_MAX + '" autocomplete="off" value="' + esc(n && n.reason ? n.reason : '') + '">');
    return G.ui.dialogHtml({
      kind: 'form', title: opts.mode === 'edit' ? 'Change an away notice' : 'Add an away notice', bodyHtml: body, primary: { label: 'Save notice', attrs: { id: 'dlg-submit' } },
      formAttrs: { 'data-submit': 'away-form', 'data-ctx': opts.ctx, 'data-mode': opts.mode === 'edit' ? 'edit' : 'add', 'data-nid': n ? opts.nid : null, 'data-pid': opts.personId || null },
    });
  }

  function removeDialogHtml(text, ctx, nid, pid) {
    return G.ui.dialogHtml({
      kind: 'destructive', title: 'Remove this notice?', text: text, primary: { label: 'Remove notice' },
      formAttrs: { 'data-submit': 'away-remove-form', 'data-ctx': ctx, 'data-nid': nid, 'data-pid': pid || null },
    });
  }

  // The fields that depend on the kind and on "When" show or hide in place (a re-render would drop what was typed).
  function applyForm(kind, repeat) {
    if (typeof document === 'undefined') return;
    const labels = labelsFor(kind, repeat);
    const hide = function (id, hidden) { const e = document.getElementById(id); if (e) e.hidden = hidden; };
    const text = function (id, t) { const e = document.getElementById(id); if (e) e.textContent = t; };
    hide('an-time-field', kind === 'away');
    hide('an-weekday-field', repeat !== 'weekly');
    text('an-time-label', labels.time);
    text('an-from-label', labels.from);
    text('an-to-label', labels.to);
  }

  // A date range's To starts as its From (one day is the usual notice) and follows From when From moves past it; a weekly notice's Until stays empty.
  function followFrom(form) {
    const e = form.elements;
    if (!e.from || !e.to || !e.repeat || e.repeat.value === 'weekly' || !e.from.value) return;
    if (!e.to.value || e.to.value < e.from.value) e.to.value = e.from.value;
  }

  G.handlers.change['away-form-change'] = function (el) {
    const form = el && el.closest ? el.closest('form') : null;
    if (!form || !form.elements) return;
    applyForm(form.elements.kind.value, form.elements.repeat.value);
    followFrom(form);
  };

  G.handlers.change['away-from-change'] = function (el) {
    const form = el && el.closest ? el.closest('form') : null;
    if (form && form.elements) followFrom(form);
  };

  // ── finding the notice a button belongs to ──
  function noticeFor(ctxName, nid) {
    let list = [];
    if (ctxName === 'mine') list = a().away && a().away.data ? a().away.data.notices : [];
    else if (ctxName === 'team') list = a().awayTeam && a().awayTeam.data ? a().awayTeam.data.entries : [];
    else if (ctxName === 'person') list = a().awayPerson && a().awayPerson.data ? a().awayPerson.data.notices : [];
    return (Array.isArray(list) ? list : []).filter(function (n) { return (n.id || n.noticeId) === nid; })[0] || null;
  }

  function todayFor(ctxName) {
    const s = ctxName === 'mine' ? a().away : ctxName === 'team' ? a().awayTeam : a().awayPerson;
    return s && s.data ? s.data.today : '';
  }

  function openDialog(html, firstId) {
    G.ui.openDialog(html, { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
    const first = typeof document !== 'undefined' ? document.getElementById(firstId) : null;
    if (first) first.focus();
  }

  // People the officers' card can add a notice for: the team's roster, not the inactive ones.
  function pickerPeople(rosterReply) {
    return (rosterReply && Array.isArray(rosterReply.people) ? rosterReply.people : []).filter(function (p) { return p.status !== 'inactive'; }).map(function (p) {
      const main = p.main || p.shown || {};
      return { id: p.id, name: main.name || 'Unnamed' };
    }).sort(function (x, y) { return String(x.name).localeCompare(String(y.name), 'en'); });
  }

  G.handlers.click['away-add'] = function (el) {
    const gd = currentGd();
    if (!gd) return;
    const ctxName = el.getAttribute('data-ctx');
    const today = todayFor(ctxName);
    if (ctxName === 'mine') {
      openDialog(dialogHtml({ mode: 'add', ctx: 'mine', today: today, minToday: true }), 'an-kind');
    } else if (ctxName === 'person') {
      const pid = el.getAttribute('data-pid');
      const rec = G.app.state.person && G.app.state.person.record;
      const who = rec && rec.person && rec.characters && rec.characters.length ? (rec.characters.filter(function (c) { return c.isMain; })[0] || rec.characters[0]).name : '';
      openDialog(dialogHtml({ mode: 'add', ctx: 'person', personId: pid, today: today, who: who }), 'an-kind');
    } else if (ctxName === 'team') {
      const s = a().awayTeam;
      if (!s) return;
      G.api.get('/api/guild/' + encodeURIComponent(gd.guild.id) + '/roster?team=' + encodeURIComponent(s.teamId)).then(function (reply) {
        openDialog(dialogHtml({ mode: 'add', ctx: 'team', people: pickerPeople(reply), today: today }), 'an-person');
      }, function (err) { G.app.handleError(err, { pageAlert: true }); });
    }
  };

  G.handlers.click['away-edit'] = function (el) {
    const ctxName = el.getAttribute('data-ctx');
    const nid = el.getAttribute('data-nid');
    const n = noticeFor(ctxName, nid);
    if (!n) return;
    openDialog(dialogHtml({ mode: 'edit', ctx: ctxName, nid: nid, notice: n, today: todayFor(ctxName), minToday: ctxName === 'mine', who: ctxName === 'team' ? n.name : '' }), 'an-kind');
  };

  G.handlers.click['away-remove'] = function (el) {
    const ctxName = el.getAttribute('data-ctx');
    const nid = el.getAttribute('data-nid');
    const n = noticeFor(ctxName, nid);
    if (!n) return;
    const text = noticeText(n, todayFor(ctxName)) + (ctxName === 'team' ? ' for ' + n.name : '');
    G.ui.openDialog(removeDialogHtml(text, ctxName, nid, el.getAttribute('data-pid')), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  G.handlers.click['away-past'] = function () {
    const x = a().away;
    if (!x) return;
    x.showPast = !x.showPast;
    G.app.render();
  };

  G.handlers.click['away-team-retry'] = function () {
    const s = a().awayTeam;
    const gd = currentGd();
    if (!s || !gd) return;
    loadTeam(gd.guild.id, s.teamId, s.forList).then(function () { return null; });
    G.app.render();
  };

  G.handlers.click['away-person-retry'] = function () {
    const s = a().awayPerson;
    const gd = currentGd();
    if (!s || !gd) return;
    loadPerson(gd.guild.id, s.pid, s.forPerson).then(function () { return null; });
    G.app.render();
  };

  // ── the form's values -> the request ──
  function readForm(form) {
    const e = form.elements;
    const v = function (name) { return e[name] && e[name].value != null ? String(e[name].value) : ''; };
    return { kind: v('kind') || 'away', repeat: v('repeat') || 'range', weekday: v('weekday'), from: v('from'), to: v('to'), atTime: v('atTime'), reason: v('reason'), person: v('person') };
  }

  // The body of POST / PUT: a range has no weekday and needs its end; a weekly notice has a weekday and may have an end; Late and Leaving have a time.
  // Keys with nothing to say are left out. personId only when an officer adds for someone else.
  function bodyFrom(v, personId) {
    const body = { kind: v.kind, from: v.from };
    if (v.repeat === 'weekly') {
      body.weekday = Number(v.weekday);
      if (v.to) body.to = v.to;
    } else {
      body.to = v.to;
    }
    if (v.kind !== 'away') body.atTime = v.atTime;
    const reason = String(v.reason || '').trim();
    if (reason) body.reason = reason;
    if (personId) body.personId = personId;
    return body;
  }

  // The first thing the Worker would refuse that can be seen here: { field, text } or null.
  function problemOf(v, needsPerson) {
    if (needsPerson && !v.person) return { field: 'personId', text: 'Choose a person.' };
    if (!DATE.test(v.from)) return { field: 'from', text: v.repeat === 'weekly' ? 'Pick the day it starts.' : 'Pick the first day.' };
    if (v.repeat !== 'weekly' && !DATE.test(v.to)) return { field: 'to', text: 'Add a To date, or choose Every week on one day.' };
    if (v.to && !DATE.test(v.to)) return { field: 'to', text: 'Pick a date.' };
    if (v.to && v.to < v.from) return { field: 'to', text: 'The end cannot be before the start.' };
    if (v.kind !== 'away' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.atTime)) return { field: 'atTime', text: v.kind === 'late' ? 'Say what time you arrive.' : 'Say what time you leave.' };
    if (Array.from(String(v.reason || '').trim()).length > REASON_MAX) return { field: 'reason', text: 'A reason is at most ' + REASON_MAX + ' characters.' };
    return null;
  }

  function clearErrors() {
    FIELDS.concat(['repeat']).forEach(function (f) { G.ui.setText('dlg-err-' + f, ''); });
    G.ui.setText('dlg-error', '');
  }

  // What a successful write does to the page it came from.
  function afterWrite(ctxName, res, text) {
    const gd = currentGd();
    if (!gd) return;
    if (ctxName === 'mine' && a().away) {
      if (res && Array.isArray(res.notices)) a().away.data.notices = res.notices;
      a().away.note = text;
      G.app.state.pageAlert = '';
      G.app.render();
    } else if (ctxName === 'person' && a().awayPerson) {
      if (res && Array.isArray(res.notices) && a().awayPerson.data) a().awayPerson.data.notices = res.notices;
      G.app.render();
    } else if (ctxName === 'team' && a().awayTeam) {
      const s = a().awayTeam;
      loadTeam(gd.guild.id, s.teamId, s.forList);
    }
  }

  G.handlers.submit['away-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const ctxName = form.getAttribute('data-ctx');
    const nid = form.getAttribute('data-nid');
    const pid = form.getAttribute('data-pid');
    const v = readForm(form);
    const forTeam = ctxName === 'team' && !nid;
    clearErrors();
    const problem = problemOf(v, forTeam);
    if (problem) {
      G.ui.setText('dlg-err-' + problem.field, problem.text);
      const input = form.querySelector ? form.querySelector('[data-field="' + problem.field + '"]') : null;
      if (input) { input.setAttribute('aria-invalid', 'true'); if (input.focus) input.focus(); }
      return;
    }
    const gid = gd.guild.id;
    // An officer adding on the card names the person in the picker; on a person's record the page names them; Edit never sends a person.
    const body = bodyFrom(v, nid ? null : (forTeam ? v.person : pid));
    const call = nid ? G.api.away.save(gid, nid, body) : G.api.away.add(gid, body);
    return G.ui.runDialog(form, call, function (res) { afterWrite(ctxName, res, 'Notice saved.'); });
  };

  G.handlers.submit['away-remove-form'] = function (form) {
    const gd = currentGd();
    if (!gd) return;
    const ctxName = form.getAttribute('data-ctx');
    return G.ui.runDialog(form, G.api.away.remove(gd.guild.id, form.getAttribute('data-nid')), function (res) { afterWrite(ctxName, res, 'Notice removed.'); });
  };

  G.pages.away = {
    noticeText: noticeText,
    isPast: isPast,
    split: split,
    mineHtml: mineHtml,
    teamCardHtml: teamCardHtml,
    memberLineHtml: memberLineHtml,
    personSectionOf: personSectionOf,
    personCardHtml: personCardHtml,
    dialogHtml: dialogHtml,
    removeDialogHtml: removeDialogHtml,
    bodyFrom: bodyFrom,
    problemOf: problemOf,
    pickerPeople: pickerPeople,
    canEditPerson: canEditPerson,
    afterRender: afterRender,
    load: loadMine,
    main: mainMine,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
