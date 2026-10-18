// ── PAGES: AWAY NOTICES ─────────────────────────────────────────
// A member tells the officers when they will miss a raid (Away), arrive late (Late) or leave early (Leaving early), for a date range or for one
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
  function rowHtml(n, o) {
    const id = n.id || n.noticeId;
    const text = noticeText(n, o.today);
    const who = o.who ? '<span class="gs-an-who"><a class="gs-char-link ' + G.ui.classClass(n.class) + '" href="' + esc(G.router.format({ name: 'person', gid: o.gid, pid: n.personId })) + '">' + esc(n.name) + '</a></span>' : '';
    const dates = o.who && n.weekday != null && Array.isArray(n.dates) && n.dates.length ? '<span class="gs-fine">' + esc(n.dates.map(dayText).join(', ')) + '</span>' : '';
    const attrs = ' data-ctx="' + esc(o.ctx) + '" data-nid="' + esc(id) + '"' + (o.pid ? ' data-pid="' + esc(o.pid) + '"' : '');
    const label = text + (o.who ? ' for ' + n.name : '');
    return '<li class="gs-an-item"><div class="gs-an-text">' + who + '<span class="gs-an-what">' + esc(text) + '</span>' + dates +
      (n.reason ? '<span class="gs-fine gs-an-reason">Reason: ' + esc(n.reason) + '</span>' : '') + '</div>' +
      '<div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="away-edit"' + attrs + ' data-key="an-edit-' + esc(id) + '" aria-label="Edit: ' + esc(label) + '">Edit</button>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="away-remove"' + attrs + ' data-key="an-remove-' + esc(id) + '" aria-label="Remove: ' + esc(label) + '">Remove</button></div></li>';
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

  // ── the page: my notices ──
  function pastHtml(past, o, open) {
    if (!past.length) return '';
    return '<section class="gs-fold" aria-labelledby="an-past-h"><h3 class="gs-h3" id="an-past-h"><button type="button" class="gs-fold-btn" data-action="away-past" data-key="an-past" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="an-past-list">' +
      '<span>Past (' + past.length + ')</span>' + G.icons.icon('chevronDown', 18) + '</button></h3>' +
      '<div id="an-past-list"' + (open ? '' : ' hidden') + '>' + listHtml(past, o, 'Past notices') + '</div></section>';
  }

  // opts: { guildData, state: { gid, data (GET /away/mine), showPast, note } , alert }
  function mineHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const d = x.data || {};
    const gid = gd.guild.id;
    const head = '<div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Away notices</h1><p class="gs-sub">Tell your officers when you will miss a raid, arrive late or leave early. Dates are the guild\'s calendar days' +
      (d.timeZone ? ' (' + esc(d.timeZone) + ')' : '') + '.</p></div>';
    if (!d.personId) {
      return '<div class="gs-page gs-page-narrow">' + head + '<section class="gs-empty-card" aria-labelledby="an-none-h"><h2 class="gs-h2 gs-h2-lg" id="an-none-h">No roster entry yet</h2>' +
        '<p class="gs-lead gs-lead-sm">Ask an officer to link your account to your roster entry. Away notices belong to your roster entry.</p></section></div>';
    }
    const parts = split(d.notices, d.today);
    const o = { ctx: 'mine', today: d.today, gid: gid };
    // The cap counts the notices that are current or still ahead (the Worker's `active`); without it, every notice in the list.
    const live = typeof d.active === 'number' ? d.active : (Array.isArray(d.notices) ? d.notices.length : 0);
    const full = Array.isArray(d.notices) && typeof d.max === 'number' && live >= d.max;
    const add = '<button type="button" class="gs-btn gs-btn-molten" data-action="away-add" data-ctx="mine" data-key="an-add"' + (full ? ' disabled' : '') + '>Add a notice</button>';
    const body = parts.current.length
      ? listHtml(parts.current, o, 'Current and upcoming notices')
      : '<p class="gs-empty">' + (parts.past.length ? 'No current or upcoming notices.' : 'You have no away notices.') + '</p>';
    return '<div class="gs-page gs-page-narrow">' + head + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '') +
      '<section class="gs-card-sec" aria-labelledby="an-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="an-h">Current and upcoming</h2>' + add + '</div><div class="gs-card-sec-body">' + body +
      (full ? '<p class="gs-fine">You have ' + d.max + ' notices, the most there can be. Remove one to add another.</p>' : '') + '</div></section>' +
      pastHtml(parts.past, o, !!x.showPast) + '</div>';
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

  // ── the officers' card on the Raids page ──
  // opts: { guildData, teamId, state: a().awayTeam }. Nothing while it loads or for anyone without raids.edit on the team.
  function teamCardHtml(opts) {
    const gd = opts.guildData;
    const s = opts.state;
    if (!s || s.gid !== gd.guild.id || s.teamId !== opts.teamId || !G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', opts.teamId)) return '';
    if (s.status === 'loading') return '';
    const add = '<button type="button" class="gs-btn gs-btn-sm" data-action="away-add" data-ctx="team" data-key="an-team-add">Add a notice</button>';
    let body;
    if (s.status === 'error') {
      body = '<p class="gs-alert" role="alert">' + esc(s.message || 'Could not load the away notices.') + '</p><div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="away-team-retry" data-key="an-team-retry">Try again</button></div>';
    } else {
      const d = s.data || {};
      const entries = Array.isArray(d.entries) ? d.entries : [];
      body = entries.length ? listHtml(entries, { ctx: 'team', today: d.today, who: true, gid: gd.guild.id }, 'Away notices of the next 4 weeks') : '<p class="gs-empty">No one has an away notice for the next 4 weeks.</p>';
    }
    return '<section class="gs-card-sec gs-an-team" aria-labelledby="an-team-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="an-team-h">Away, next 4 weeks</h2>' + (s.status === 'error' ? '' : add) + '</div><div class="gs-card-sec-body">' + body + '</div></section>';
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

  // opts: { guildData, record, state: a().awayPerson }
  function personCardHtml(opts) {
    const gd = opts.guildData;
    const record = opts.record;
    const s = opts.state;
    const pid = record && record.person ? record.person.id : null;
    if (!s || !pid || s.gid !== gd.guild.id || s.pid !== pid || !canEditPerson(gd, record) || s.status === 'loading' || s.status === 'denied') return '';
    let body;
    if (s.status === 'error') {
      body = '<p class="gs-alert" role="alert">' + esc(s.message || 'Could not load the away notices.') + '</p><div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="away-person-retry" data-key="an-person-retry">Try again</button></div>';
    } else {
      const d = s.data || {};
      const parts = split(d.notices, d.today);
      const all = parts.current.concat(parts.past);
      body = all.length ? listHtml(all, { ctx: 'person', today: d.today, pid: pid, gid: gd.guild.id }, 'Away notices of this person') : '<p class="gs-fine">No away notices.</p>';
    }
    return '<section class="gs-card-sec" aria-labelledby="an-person-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="an-person-h">Away notices</h2>' +
      (s.status === 'error' ? '' : '<button type="button" class="gs-btn gs-btn-sm" data-action="away-add" data-ctx="person" data-pid="' + esc(pid) + '" data-key="an-person-add">Add a notice</button>') + '</div><div class="gs-card-sec-body">' + body + '</div></section>';
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
    return '<form class="gs-dialog-form" data-submit="away-form" data-ctx="' + esc(opts.ctx) + '" data-mode="' + (opts.mode === 'edit' ? 'edit' : 'add') + '"' +
      (n ? ' data-nid="' + esc(opts.nid) + '"' : '') + (opts.personId ? ' data-pid="' + esc(opts.personId) + '"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + (opts.mode === 'edit' ? 'Change an away notice' : 'Add an away notice') + '</h2>' +
      '<p class="gs-fine" id="dlg-help">' + help + ' Dates are the guild\'s calendar days.</p>' + person +
      field('kind', '<label class="gs-label" for="an-kind">What</label>',
        '<select class="gs-input" id="an-kind" name="kind" data-field="kind" data-change="away-form-change" data-key="an-kind">' + G.ui.optionsHtml(KIND_CHOICES.map(function (k) { return { value: k[0], label: k[1] }; }), kind) + '</select>') +
      field('atTime', '<label class="gs-label" id="an-time-label" for="an-time">' + esc(labels.time) + '</label>',
        '<input class="gs-input" type="time" id="an-time" name="atTime" data-field="atTime" value="' + esc(n && n.atTime ? n.atTime : '') + '">', ' id="an-time-field"' + (kind === 'away' ? ' hidden' : '')) +
      field('repeat', '<label class="gs-label" for="an-repeat">When</label>',
        '<select class="gs-input" id="an-repeat" name="repeat" data-field="repeat" data-change="away-form-change" data-key="an-repeat">' + G.ui.optionsHtml([{ value: 'range', label: 'A date range' }, { value: 'weekly', label: 'Every week on one day' }], repeat) + '</select>') +
      field('weekday', '<label class="gs-label" for="an-weekday">Day of the week</label>',
        '<select class="gs-input" id="an-weekday" name="weekday" data-field="weekday">' + G.ui.optionsHtml(WEEKDAY_ORDER.map(function (d) { return { value: d, label: WEEKDAYS[d] }; }), weekday) + '</select>', ' id="an-weekday-field"' + (repeat === 'weekly' ? '' : ' hidden')) +
      field('from', '<label class="gs-label" id="an-from-label" for="an-from">' + esc(labels.from) + '</label>',
        '<input class="gs-input" type="date" id="an-from" name="from" data-field="from"' + (minDate ? ' min="' + esc(minDate) + '"' : '') + ' value="' + esc(from) + '">') +
      field('to', '<label class="gs-label" id="an-to-label" for="an-to">' + esc(labels.to) + '</label>',
        '<input class="gs-input" type="date" id="an-to" name="to" data-field="to" value="' + esc(n && n.to ? n.to : '') + '">') +
      field('reason', '<label class="gs-label" for="an-reason">Reason (optional)</label>',
        '<input class="gs-input" type="text" id="an-reason" name="reason" data-field="reason" maxlength="' + REASON_MAX + '" autocomplete="off" value="' + esc(n && n.reason ? n.reason : '') + '">') +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="dlg-submit">Save notice</button></div></form>';
  }

  function removeDialogHtml(text, ctx, nid, pid) {
    return '<form class="gs-dialog-form" data-submit="away-remove-form" data-ctx="' + esc(ctx) + '" data-nid="' + esc(nid) + '"' + (pid ? ' data-pid="' + esc(pid) + '"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Remove this notice?</h2><p class="gs-confirm-text" id="dlg-text">' + esc(text) + '</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove notice</button></div></form>';
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

  G.handlers.change['away-form-change'] = function (el) {
    const form = el && el.closest ? el.closest('form') : null;
    if (!form || !form.elements) return;
    applyForm(form.elements.kind.value, form.elements.repeat.value);
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
    if (v.repeat !== 'weekly' && !DATE.test(v.to)) return { field: 'to', text: 'Pick the last day, or choose "Every week on one day".' };
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
