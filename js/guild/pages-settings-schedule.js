// ── PAGE: GUILD SETTINGS > RAID SCHEDULE ────────────────────────
// A team's weekly raids: one slot per weekday (day, start time in the guild's time zone, an optional zone and title), how many
// weeks "Create upcoming raids" fills (1 to 8), whether it runs by itself when an officer opens Raids, and how many hours before the start
// the team's members stop being able to change their sign-ups (0 to 72; 0 = at the start). The page edits a draft
// of the saved schedule and saves it with PUT /teams/:tid/schedule; "Create upcoming raids" is POST /teams/:tid/schedule/raids and
// uses the saved schedule. Everyone with raids.edit on a team may edit that team's schedule.
(function (G) {
  'use strict';

  const WEEKDAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];
  const MAX_SLOTS = 7;
  const DEFAULT_TIME = '20:00';
  const TITLE_MAX = 100;
  const WEEK_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];
  const MAX_CLOSE_HOURS = 72;

  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function weekdayName(n) { return (WEEKDAYS.filter(function (w) { return w[0] === n; })[0] || [n, String(n)])[1]; }

  // The teams this viewer may set a schedule for: active teams where they can edit raids.
  function editableTeams(gd) {
    return G.shell.activeTeams(gd.teams).filter(function (t) { return G.shell.allowsTeam(gd.me && gd.me.can, 'raids.edit', t.id); });
  }

  // Monday first, as the week reads; Sunday last.
  function weekdayRank(n) { return n === 0 ? 7 : n; }

  function draftFrom(data) {
    const slots = (data.slots || []).map(function (x) { return { weekday: x.weekday, startTime: x.startTime, zone: x.zone || '', title: x.title || '' }; });
    slots.sort(function (p, q) { return weekdayRank(p.weekday) - weekdayRank(q.weekday); });
    // The deadline is kept as typed (a string) so a half-typed value survives a re-render; null = the Worker did not send one (it is then left alone).
    const hours = typeof data.signupCloseHours === 'number' ? String(data.signupCloseHours) : null;
    return { slots: slots, weeks: data.weeks, auto: !!data.auto, signupCloseHours: hours };
  }

  // The weekday a new slot starts on: Tuesday (the US reset) when it is free, else the first free day, Monday first.
  function nextFreeWeekday(slots) {
    const used = slots.map(function (x) { return x.weekday; });
    if (used.indexOf(2) < 0) return 2;
    const free = WEEKDAYS.filter(function (w) { return used.indexOf(w[0]) < 0; })[0];
    return free ? free[0] : null;
  }

  function slotRowHtml(slot, i, zones) {
    const n = i + 1;
    return '<div class="gs-sched-row" role="group" aria-label="Slot ' + n + '">' +
      '<div class="gs-field"><label class="gs-label" for="sched-day-' + i + '">Day</label><select class="gs-input" id="sched-day-' + i + '" data-change="sched-field" data-idx="' + i + '" data-field="weekday" data-key="sched-day-' + i + '">' +
      G.ui.optionsHtml(WEEKDAYS.map(function (w) { return { value: w[0], label: w[1] }; }), slot.weekday) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="sched-time-' + i + '">Start time</label><input class="gs-input" type="time" id="sched-time-' + i + '" data-input="sched-field" data-idx="' + i + '" data-field="startTime" data-key="sched-time-' + i + '" value="' + esc(slot.startTime) + '"></div>' +
      '<div class="gs-field"><label class="gs-label" for="sched-zone-' + i + '">Zone (optional)</label><select class="gs-input" id="sched-zone-' + i + '" data-change="sched-field" data-idx="' + i + '" data-field="zone" data-key="sched-zone-' + i + '">' +
      G.ui.optionsHtml([{ value: '', label: 'No zone' }].concat(zones.map(function (z) { return { value: z, label: z }; })), slot.zone) + '</select></div>' +
      '<div class="gs-field"><label class="gs-label" for="sched-title-' + i + '">Title (optional)</label><input class="gs-input" type="text" id="sched-title-' + i + '" data-input="sched-field" data-idx="' + i + '" data-field="title" data-key="sched-title-' + i + '" maxlength="' + TITLE_MAX + '" autocomplete="off" value="' + esc(slot.title) + '"></div>' +
      '<button type="button" class="gs-btn gs-btn-sm gs-sched-remove" data-action="sched-remove" data-idx="' + i + '" data-key="sched-remove-' + i + '" aria-label="Remove slot ' + n + ' (' + esc(weekdayName(slot.weekday)) + ')">Remove</button></div>';
  }

  // The "Close sign-ups" field: whole hours, 0 to 72, with its one-line hint and the field's own error.
  function closeFieldHtml(s) {
    if (s.draft.signupCloseHours === null) return '';
    const bad = !!s.closeError;
    return '<div class="gs-field"><label class="gs-label" for="sched-close">Close sign-ups this many hours before the start</label>' +
      '<input class="gs-input gs-sched-hours" type="number" id="sched-close" data-input="sched-close" data-key="sched-close" min="0" max="' + MAX_CLOSE_HOURS + '" step="1" inputmode="numeric" autocomplete="off" value="' + esc(s.draft.signupCloseHours) + '"' +
      (bad ? ' aria-invalid="true"' : '') + ' aria-describedby="sched-close-hint' + (bad ? ' sched-close-error' : '') + '">' +
      '<p class="gs-fine" id="sched-close-hint">Members can change their sign-up until then. 0 = until the raid starts (72 at most). Officers are never locked out, and a raid can set its own.</p>' +
      '<p class="gs-field-error" id="sched-close-error" role="alert"' + (bad ? '' : ' hidden') + '>' + esc(s.closeError || '') + '</p></div>';
  }

  // How many things differ from what is saved (the Save bar's count).
  function changeCount(s) { return G.ui.saveBar.draftChanges(bodyOf(draftFrom(s.data)), bodyOf(s.draft)); }

  // opts: { guildData, s: { teamId, data, draft, error, closeError, note, busy }, alert }
  function scheduleHtml(opts) {
    const gd = opts.guildData;
    const s = opts.s;
    const teams = editableTeams(gd);
    const zones = Array.isArray(s.data.zones) ? s.data.zones : [];
    const slots = s.draft.slots;
    const teamField = teams.length > 1
      ? '<div class="gs-roster-status"><label class="gs-label" for="sched-team">Team</label><select class="gs-input" id="sched-team" data-change="sched-team" data-key="sched-team">' +
        G.ui.optionsHtml(teams.map(function (t) { return { value: t.id, label: t.name }; }), s.teamId) + '</select></div>'
      : '';
    const rows = slots.length
      ? slots.map(function (slot, i) { return slotRowHtml(slot, i, zones); }).join('')
      : '<p class="gs-empty">No weekly slots yet. Add one for each day this team raids.</p>';
    return '<div class="gs-sched">' + teamField +
      '<p class="gs-fine">The days this team raids each week, in the guild\'s time (' + esc(s.data.timeZone) + '). Create upcoming raids makes a raid for each of those days in the next weeks, skipping days that already have one, so it is safe to press again.</p>' +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (s.note ? '<div class="gs-notice" role="status"><span>' + esc(s.note) + '</span></div>' : '') +
      '<form class="gs-sched-form" id="sched-form" data-submit="sched-form" novalidate>' +
      '<div class="gs-hd-panel gs-set-body gs-sched-panel"><div class="gs-sched-slots">' + rows + '</div>' +
      '<div class="gs-row-actions"><button type="button" class="gs-btn" data-action="sched-add" data-key="sched-add"' + (slots.length >= MAX_SLOTS ? ' disabled' : '') + '>Add a slot</button></div></div>' +
      '<div class="gs-hd-panel gs-set-body"><div class="gs-field"><label class="gs-label" for="sched-weeks">Create raids for the next</label><select class="gs-input gs-sched-weeks" id="sched-weeks" data-change="sched-weeks" data-key="sched-weeks">' +
      G.ui.optionsHtml(WEEK_CHOICES.map(function (n) { return { value: n, label: plural(n, 'week', 'weeks') }; }), s.draft.weeks) + '</select></div>' +
      '<div class="gs-check"><input type="checkbox" id="sched-auto" data-change="sched-auto" data-key="sched-auto"' + (s.draft.auto ? ' checked' : '') + '><label for="sched-auto">Create them by themselves when an officer opens Raids</label></div>' +
      closeFieldHtml(s) + '</div>' +
      '<p class="gs-alert" id="sched-error" role="alert"' + (s.error ? '' : ' hidden') + '>' + esc(s.error || '') + '</p>' +
      '<div class="gs-actions"><button type="button" class="gs-btn" data-action="sched-fill" data-key="sched-fill"' + (s.busy || !s.data.slots.length ? ' disabled' : '') + '>Create upcoming raids now</button></div>' +
      '<p class="gs-fine">Create upcoming raids uses the saved schedule.</p>' +
      G.ui.saveBarHtml({ count: changeCount(s), busy: s.busy, saveLabel: 'Save schedule', discardAttrs: { 'data-action': 'sched-discard', 'data-key': 'sched-discard' } }) + '</form></div>';
  }

  // ── data ──
  function adopt(gid, teamId, data, keep) {
    a().settingsSchedule = Object.assign({ gid: gid, teamId: teamId, data: data, draft: draftFrom(data), error: '', closeError: '', note: '', busy: false }, keep || {});
  }

  function pickTeam(gd, prev) {
    const teams = editableTeams(gd);
    if (prev && prev.gid === gd.guild.id && teams.some(function (t) { return t.id === prev.teamId; })) return prev.teamId;
    const picked = G.app.teamFor(gd);
    if (picked && teams.some(function (t) { return t.id === picked; })) return picked;
    return teams.length ? teams[0].id : null;
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = pickTeam(gd, a().settingsSchedule);
    if (!teamId) return Promise.reject(new G.api.ApiError(403, { error: 'forbidden', message: 'Setting a raid schedule is for the officers and team leads of a team.' }));
    return G.api.signups.schedule(gid, teamId).then(function (data) { adopt(gid, teamId, data); return null; });
  }

  function main(r, gd, ctx) {
    const s = a().settingsSchedule;
    if (!s || s.gid !== gd.guild.id) return G.ui.settingsLoadingHtml();
    return G.shell.settingsFrameHtml(ctx, 'schedule', scheduleHtml({ guildData: gd, s: s, alert: st().pageAlert }));
  }

  function cur() { const s = a().settingsSchedule; return s && currentGd() ? s : null; }

  // The draft as the Worker takes it: HH:MM, null for no zone / title; the deadline only when the Worker sent one.
  function bodyOf(draft) {
    const body = {
      slots: draft.slots.map(function (x) { return { weekday: x.weekday, startTime: x.startTime, zone: x.zone || null, title: String(x.title || '').trim() || null }; }),
      weeks: draft.weeks,
      auto: !!draft.auto,
    };
    if (draft.signupCloseHours !== null && draft.signupCloseHours !== undefined) body.signupCloseHours = Number(draft.signupCloseHours);
    return body;
  }

  // The deadline field's problem, or '': whole hours from 0 to 72.
  function closeProblemOf(draft) {
    if (draft.signupCloseHours === null || draft.signupCloseHours === undefined) return '';
    const text = String(draft.signupCloseHours).trim();
    if (!/^\d{1,2}$/.test(text) || Number(text) > MAX_CLOSE_HOURS) return 'Enter whole hours from 0 to ' + MAX_CLOSE_HOURS + ' (0 closes sign-ups when the raid starts).';
    return '';
  }

  // A problem the Worker would refuse, found first so the message can name the slot.
  function problemOf(draft) {
    const seen = {};
    for (let i = 0; i < draft.slots.length; i++) {
      const x = draft.slots[i];
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(x.startTime || '')) return 'Slot ' + (i + 1) + ': enter a start time like 20:00.';
      if (seen[x.weekday]) return 'Slot ' + (i + 1) + ': a team has one raid per day, so each day can be used once (' + weekdayName(x.weekday) + ' comes twice).';
      seen[x.weekday] = true;
    }
    return '';
  }

  function describeError(err) {
    if (err && err.field === 'slots' && typeof err.index === 'number') return 'Slot ' + (err.index + 1) + ': ' + err.message;
    return G.api.classify(err).text;
  }

  // ── handlers ──
  G.handlers.change['sched-team'] = function (el) {
    const gd = currentGd();
    const s = cur();
    if (!gd || !s) return;
    const teamId = el.value;
    return G.api.signups.schedule(gd.guild.id, teamId).then(function (data) {
      adopt(gd.guild.id, teamId, data);
      st().pageAlert = '';
      G.app.render();
    }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  };

  function setField(el) {
    const s = cur();
    if (!s) return;
    const slot = s.draft.slots[Number(el.getAttribute('data-idx'))];
    const field = el.getAttribute('data-field');
    if (!slot || !field) return;
    slot[field] = field === 'weekday' ? Number(el.value) : el.value;
    G.ui.saveBar.setCount(null, changeCount(s));
  }
  G.handlers.change['sched-field'] = setField;
  G.handlers.input['sched-field'] = setField;

  G.handlers.click['sched-add'] = function () {
    const s = cur();
    if (!s || s.draft.slots.length >= MAX_SLOTS) return;
    const weekday = nextFreeWeekday(s.draft.slots);
    if (weekday === null) return;
    s.draft.slots.push({ weekday: weekday, startTime: DEFAULT_TIME, zone: '', title: '' });
    s.draft.slots.sort(function (p, q) { return weekdayRank(p.weekday) - weekdayRank(q.weekday); });
    s.error = '';
    G.app.render();
    G.ui.focusByKey('sched-time-' + s.draft.slots.map(function (x) { return x.weekday; }).indexOf(weekday));
  };

  G.handlers.click['sched-remove'] = function (el) {
    const s = cur();
    if (!s) return;
    s.draft.slots.splice(Number(el.getAttribute('data-idx')), 1);
    s.error = '';
    G.app.render();
    G.ui.focusByKey('sched-add');
  };

  G.handlers.change['sched-weeks'] = function (el) {
    const s = cur();
    if (!s) return;
    s.draft.weeks = Number(el.value);
    G.ui.saveBar.setCount(null, changeCount(s));
  };

  G.handlers.click['sched-discard'] = function () {
    const s = cur();
    if (!s) return;
    s.draft = draftFrom(s.data);
    s.error = '';
    s.closeError = '';
    G.app.render();
  };

  G.handlers.change['sched-auto'] = function (el) {
    const s = cur();
    if (!s) return;
    s.draft.auto = !!el.checked;
    G.ui.saveBar.setCount(null, changeCount(s));
  };

  G.handlers.input['sched-close'] = function (el) {
    const s = cur();
    if (!s) return;
    s.draft.signupCloseHours = el.value;
    G.ui.saveBar.setCount(null, changeCount(s));
  };

  G.handlers.submit['sched-form'] = function () {
    const s = cur();
    const gd = currentGd();
    if (!s || !gd) return;
    const problem = problemOf(s.draft);
    const closeProblem = closeProblemOf(s.draft);
    s.note = '';
    s.closeError = closeProblem;
    if (problem || closeProblem) {
      s.error = problem;
      G.app.render();
      if (closeProblem && !problem) G.ui.focusByKey('sched-close');
      return;
    }
    s.error = '';
    s.busy = true;
    G.app.render();
    const teamId = s.teamId;
    return G.api.signups.saveSchedule(gd.guild.id, teamId, bodyOf(s.draft)).then(function (data) {
      adopt(gd.guild.id, teamId, data);
      G.app.markSettingsSaved('schedule');
      st().pageAlert = '';
      G.app.render();
    }, function (err) {
      s.busy = false;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      // The deadline's own 400 sits next to the field; anything else is the form's message.
      if (err && err.field === 'signupCloseHours' && s.draft.signupCloseHours !== null) {
        s.closeError = cl.text;
        G.app.render();
        G.ui.focusByKey('sched-close');
        return;
      }
      s.error = describeError(err);
      G.app.render();
    });
  };

  G.handlers.click['sched-fill'] = function () {
    const s = cur();
    const gd = currentGd();
    if (!s || !gd) return;
    s.busy = true;
    s.error = '';
    s.note = '';
    G.app.render();
    return G.api.signups.fill(gd.guild.id, s.teamId).then(function (res) {
      s.busy = false;
      s.note = G.pages.raids.fillText(res);
      // The Raids page reads its list again when it opens; a list kept from before is dropped.
      a().raids = null;
      G.app.render();
    }, function (err) {
      s.busy = false;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      s.error = cl.text;
      G.app.render();
    });
  };

  G.pages.settingsSchedule = {
    WEEKDAYS: WEEKDAYS,
    scheduleHtml: scheduleHtml,
    draftFrom: draftFrom,
    bodyOf: bodyOf,
    problemOf: problemOf,
    closeProblemOf: closeProblemOf,
    nextFreeWeekday: nextFreeWeekday,
    editableTeams: editableTeams,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
