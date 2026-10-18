// ── PAGE PIECE: STANDING SIGN-UPS (the card on the Raids page) ──
// A member who can sign up says "I'm in" for the days of a team's weekly schedule (GET /standing, PUT /teams/:tid/standing); the Worker then signs them
// up for new raids on those days by itself (an Away notice wins; a sign-up they change themselves stays as they set it). The card is the one of the team
// on screen and loads itself after the Raids page is drawn (afterRender), so the Raids page reads exactly what it did before.
(function (G) {
  'use strict';

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']; // 0 = Sunday, as the Worker numbers them
  const KIND_CHOICES = [['signed', 'Signed up'], ['late', 'Late']];
  const EXPLAIN = 'You are signed up automatically for new raids on these days. An Away notice wins. Changing a sign-up yourself keeps it as you set it.';

  function A() { return G.pages.attendance; }
  function a() { return A().attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }

  // '20:00' -> '8:00 PM' (the schedule's time is the guild's wall-clock time already: no time zone maths).
  function timeLabel(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm == null ? '' : hhmm));
    if (!m) return String(hhmm == null ? '' : hhmm);
    const h = Number(m[1]);
    return ((h % 12) || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  // "Every Thursday 8:00 PM - Hyjal Summit".
  function slotText(slot) {
    return 'Every ' + (WEEKDAYS[slot.weekday] || '') + ' ' + timeLabel(slot.startTime) + [slot.zone, slot.title].filter(Boolean).map(function (t) { return ' - ' + t; }).join('');
  }

  function teamEntry(data, teamId) {
    return (data && Array.isArray(data.teams) ? data.teams : []).filter(function (t) { return t.teamId === teamId; })[0] || null;
  }

  // One row per schedule slot: ticked when the person has a standing sign-up for that day (null character = their usual one).
  function draftFrom(entry) {
    const mine = {};
    (Array.isArray(entry && entry.mine) ? entry.mine : []).forEach(function (m) { mine[m.weekday] = m; });
    return (Array.isArray(entry && entry.slots) ? entry.slots : []).map(function (s) {
      const m = mine[s.weekday];
      return { weekday: s.weekday, checked: !!m, kind: m && m.kind === 'late' ? 'late' : 'signed', characterId: m && m.characterId ? m.characterId : '' };
    });
  }

  // The body of PUT: only the ticked rows; no character key = the usual character.
  function bodyFrom(draft) {
    return {
      slots: draft.filter(function (r) { return r.checked; }).map(function (r) {
        const o = { weekday: r.weekday, kind: r.kind };
        if (r.characterId) o.characterId = r.characterId;
        return o;
      }),
    };
  }

  function rowHtml(slot, row, characters) {
    const wd = slot.weekday;
    const off = row.checked ? '' : ' disabled';
    const kind = '<div class="gs-field"><label class="gs-sr" for="st-kind-' + wd + '">Status for ' + esc(slotText(slot)) + '</label><select class="gs-input" id="st-kind-' + wd + '" data-change="st-kind" data-wd="' + wd + '" data-key="st-kind-' + wd + '"' + off + '>' +
      G.ui.optionsHtml(KIND_CHOICES.map(function (k) { return { value: k[0], label: k[1] }; }), row.kind) + '</select></div>';
    const chars = characters.length > 1
      ? '<div class="gs-field"><label class="gs-sr" for="st-char-' + wd + '">Character for ' + esc(slotText(slot)) + '</label><select class="gs-input" id="st-char-' + wd + '" data-change="st-char" data-wd="' + wd + '" data-key="st-char-' + wd + '"' + off + '>' +
        G.ui.optionsHtml([{ value: '', label: 'My usual character' }].concat(characters.map(function (c) { return { value: c.id, label: c.name + (c.mainSpec ? ' (' + c.mainSpec + ')' : '') }; })), row.characterId) + '</select></div>'
      : '';
    return '<li class="gs-st-row"><div class="gs-st-slot" role="group" aria-labelledby="st-slot-' + wd + '"><span class="gs-st-name" id="st-slot-' + wd + '">' + esc(slotText(slot)) + '</span>' +
      '<div class="gs-check"><input type="checkbox" id="st-in-' + wd + '" data-change="st-toggle" data-wd="' + wd + '" data-key="st-in-' + wd + '"' + (row.checked ? ' checked' : '') + '><label for="st-in-' + wd + '">I\'m in</label></div>' +
      kind + chars + '</div></li>';
  }

  // opts: { guildData, teamId, canSignUp (the Raids list's can.signup), state: a().standing }. Nothing while it loads, for a viewer who cannot sign up, or without a person.
  function cardHtml(opts) {
    const gd = opts.guildData;
    const s = opts.state;
    if (!opts.canSignUp || !s || s.gid !== gd.guild.id || s.teamId !== opts.teamId || s.status === 'loading' || s.status === 'denied') return '';
    const head = '<div class="gs-card-sec-head"><h2 class="gs-h2" id="st-h">Standing sign-ups</h2></div>';
    if (s.status === 'error') {
      return '<section class="gs-card-sec gs-st" aria-labelledby="st-h">' + head + '<div class="gs-card-sec-body"><p class="gs-alert" role="alert">' + esc(s.message || 'Could not load your standing sign-ups.') +
        '</p><div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="st-retry" data-key="st-retry">Try again</button></div></div></section>';
    }
    if (!s.data || !s.data.personId) return '';
    const entry = teamEntry(s.data, opts.teamId);
    if (!entry || !entry.slots.length) {
      return '<section class="gs-card-sec gs-st" aria-labelledby="st-h">' + head + '<div class="gs-card-sec-body"><p class="gs-fine">This team has no raid schedule yet. When your officers set one, you can sign up for its days here.</p></div></section>';
    }
    const draft = s.draft || draftFrom(entry);
    const rows = entry.slots.map(function (slot, i) { return rowHtml(slot, draft[i] || { weekday: slot.weekday, checked: false, kind: 'signed', characterId: '' }, entry.characters || []); }).join('');
    return '<section class="gs-card-sec gs-st" aria-labelledby="st-h">' + head + '<div class="gs-card-sec-body"><p class="gs-fine" id="st-explain">' + esc(EXPLAIN) + '</p>' +
      (s.note ? '<div class="gs-notice" role="status"><span>' + esc(s.note) + '</span></div>' : '') +
      '<form class="gs-st-form" data-submit="standing-form" novalidate aria-describedby="st-explain"><ul class="gs-st-list" aria-label="Days of the weekly schedule">' + rows + '</ul>' +
      '<p class="gs-alert" id="st-error" role="alert"' + (s.error ? '' : ' hidden') + '>' + esc(s.error || '') + '</p>' +
      '<div class="gs-row-actions"><button type="submit" class="gs-btn gs-btn-sm gs-btn-molten" data-key="st-save"' + (s.busy ? ' disabled' : '') + '>Save standing sign-ups</button></div></form></div></section>';
  }

  // ── data ──
  function load(gid, teamId, forList) {
    const s = a().standing = { gid: gid, teamId: teamId, status: 'loading', data: null, draft: null, busy: false, error: '', note: '', message: '', forList: forList || null };
    return G.api.standing.get(gid).then(function (data) {
      if (a().standing !== s) return null;
      s.status = 'ok';
      s.data = data;
      s.draft = draftFrom(teamEntry(data, teamId));
      G.app.render();
      return null;
    }, function (err) {
      if (a().standing !== s) return null;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return null; }
      s.status = err && (err.status === 403 || err.status === 404) ? 'denied' : 'error';
      s.message = cl.text;
      G.app.render();
      return null;
    });
  }

  // Called by the app after each render of a guild page: the Raids page of a member who can sign up loads its card once per list.
  function afterRender(r) {
    const gd = currentGd();
    if (!gd || !r || r.name !== 'section' || r.section !== 'raids') return;
    const x = a().raids;
    if (!x || x.gid !== gd.guild.id || !x.teamId || !x.data || !(x.data.can && x.data.can.signup)) return;
    if (a().standing && a().standing.forList === x) return;
    load(gd.guild.id, x.teamId, x);
  }

  function cur() {
    const s = a().standing;
    const gd = currentGd();
    return s && gd && s.gid === gd.guild.id && s.status === 'ok' ? s : null;
  }

  function rowOf(el) {
    const s = cur();
    const wd = Number(el.getAttribute('data-wd'));
    const row = s && s.draft ? s.draft.filter(function (r) { return r.weekday === wd; })[0] : null;
    return row ? { s: s, row: row } : null;
  }

  G.handlers.change['st-toggle'] = function (el) {
    const f = rowOf(el);
    if (!f) return;
    f.row.checked = !!el.checked;
    f.s.error = ''; f.s.note = '';
    G.app.render();
  };
  G.handlers.change['st-kind'] = function (el) {
    const f = rowOf(el);
    if (f) f.row.kind = el.value === 'late' ? 'late' : 'signed';
  };
  G.handlers.change['st-char'] = function (el) {
    const f = rowOf(el);
    if (f) f.row.characterId = el.value || '';
  };
  G.handlers.click['st-retry'] = function () {
    const s = a().standing;
    const gd = currentGd();
    if (!s || !gd) return;
    load(gd.guild.id, s.teamId, s.forList);
    G.app.render();
  };

  // Save: the Worker replaces my set for the team and answers with the team's entry; the Raids list is read again (new sign-ups carry the "standing" tag).
  G.handlers.submit['standing-form'] = function () {
    const s = cur();
    const gd = currentGd();
    if (!s || !gd || s.busy) return;
    const gid = gd.guild.id;
    const body = bodyFrom(s.draft);
    s.busy = true; s.error = ''; s.note = '';
    G.app.render();
    return G.api.standing.save(gid, s.teamId, body).then(function (entry) {
      s.busy = false;
      const teams = s.data.teams.filter(function (t) { return t.teamId !== s.teamId; });
      if (entry && entry.teamId) teams.push(entry);
      s.data.teams = teams;
      s.draft = draftFrom(teamEntry(s.data, s.teamId));
      s.note = 'Standing sign-ups saved.';
      const x = a().raids;
      if (!x || !x.data || x.gid !== gid || !G.pages.raids.reloadList) { G.app.render(); return null; }
      return G.pages.raids.reloadList(x).then(function () { G.app.render(); return null; }, function () { G.app.render(); return null; });
    }, function (err) {
      s.busy = false;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return null; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return null; }
      const ticked = s.draft.filter(function (r) { return r.checked; });
      const day = err && err.field === 'slots' && typeof err.index === 'number' && ticked[err.index] ? WEEKDAYS[ticked[err.index].weekday] + ': ' : '';
      s.error = day + cl.text;
      G.app.render();
      return null;
    });
  };

  G.pages.standing = {
    EXPLAIN: EXPLAIN,
    timeLabel: timeLabel,
    slotText: slotText,
    draftFrom: draftFrom,
    bodyFrom: bodyFrom,
    cardHtml: cardHtml,
    afterRender: afterRender,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
