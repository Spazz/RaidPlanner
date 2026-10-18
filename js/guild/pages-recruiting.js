// ── PAGE: ROSTER > RECRUITING (recruitment needs) ───────────────
// For the team on screen: how many tanks, healers, melee and ranged DPS the active roster (Raider and Trial mains) has against officer-set targets (the
// defaults of the team's raid size until an officer sets them), the open spec poll laid over the roster when there is one, which raid buffs and
// debuffs that roster misses (coverage.js, the Planner's rules), and a plain-text recruiting post to copy: guild, realm or ruleset, raid days from the
// weekly schedule, the roles and classes the team needs and the apply link. GET /recruiting?team=, PUT /teams/:tid/recruiting.
(function (G) {
  'use strict';

  const ROLE_ORDER = ['tank', 'healer', 'melee', 'ranged'];
  const ROLE_LABELS = { tank: 'Tanks', healer: 'Healers', melee: 'Melee DPS', ranged: 'Ranged DPS' };
  const ROLE_ONE = { tank: 'Tank', healer: 'Healer', melee: 'Melee DPS', ranged: 'Ranged DPS' };
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // 0 = Sunday, as the Worker numbers them
  const POST_CLASSES = 4;
  const POST_NAMES = 3;

  function a() { return G.pages.attendance.attState(); }
  function currentGd() { const s = G.app.state; return s.currentGid ? s.guilds[s.currentGid] : null; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // The part of the answer the page reads: the roster with the open spec poll laid over it, or the roster alone.
  function sectionOf(data, useIntent) { return useIntent && data.intent ? data.intent : data.roster; }

  // ── the post ──
  // '8:00 PM' of '20:00'; the schedule's time is the guild's wall-clock time already.
  function timeLabel(hhmm) {
    const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm == null ? '' : hhmm));
    if (!m) return String(hhmm == null ? '' : hhmm);
    const h = Number(m[1]);
    return ((h % 12) || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  // The recruiting post as plain ASCII text (the fonts and Discord posts of a recruiting channel do not need anything fancier).
  // data: GET /recruiting; cov: the coverage of the section the page shows (or null); origin: the address the page is served from;
  // facts: { realmLine, timeZone, useIntent } (all optional; useIntent defaults to counting an open intent round).
  function postText(data, cov, origin, guildFacts) {
    const guild = data.guild;
    const section = sectionOf(data, !guildFacts || guildFacts.useIntent !== false);
    const lines = [];
    lines.push(guild.name + ' is recruiting for ' + data.team.name + '!');
    const where = guildFacts && guildFacts.realmLine ? guildFacts.realmLine : guild.realm;
    lines.push(G.ui.gameVersionLabel(guild.gameVersion) + ' - ' + where + (guild.realmKind === 'ruleset' || !guild.region ? '' : ' (' + guild.region + ')'));
    if (data.schedule.length) {
      const zone = guildFacts && guildFacts.timeZone ? ' (' + guildFacts.timeZone + ')' : '';
      lines.push('Raid days: ' + data.schedule.map(function (s) { return WEEKDAYS[s.weekday] + ' ' + timeLabel(s.startTime); }).join(', ') + zone);
    }
    const needs = ROLE_ORDER.filter(function (role) { return section.gaps[role] > 0; }).map(function (role) { return section.gaps[role] + ' ' + (section.gaps[role] === 1 ? ROLE_ONE : ROLE_LABELS)[role]; });
    lines.push(needs.length ? 'Looking for: ' + needs.join(', ') : 'Looking for: no set roles right now, strong players of any role are welcome');
    const classes = G.coverage.missingByClass(cov).slice(0, POST_CLASSES).map(function (entry) {
      return G.ui.className(entry.class) + ' (' + entry.names.slice(0, POST_NAMES).join(', ') + ')';
    });
    if (classes.length) lines.push('Classes that bring buffs we lack: ' + classes.join(', '));
    lines.push(guild.applyEnabled ? 'Apply: ' + (origin || '') + guild.applyPath : 'To apply, message an officer on Discord.');
    return lines.join('\n');
  }

  // ── data ──
  function load(r, gd) {
    const gid = gd.guild.id;
    const teamId = G.app.teamFor(gd);
    if (!teamId) { a().recruiting = { gid: gid, teamId: null, data: null }; return Promise.resolve(null); }
    const prev = a().recruiting;
    return G.api.recruiting.get(gid, teamId).then(function (data) {
      a().recruiting = makeState(gid, teamId, data, prev && prev.gid === gid && prev.teamId === teamId ? prev.useIntent : null);
      return null;
    });
  }

  function makeState(gid, teamId, data, useIntent) {
    const x = { gid: gid, teamId: teamId, data: data, useIntent: useIntent === null || useIntent === undefined ? !!data.intent : !!useIntent && !!data.intent, note: '', error: '', busy: false };
    x.cov = coverageOf(x);
    return x;
  }

  function coverageOf(x) {
    const section = sectionOf(x.data, x.useIntent);
    return G.coverage.compute(x.data.guild.gameVersion, section.specs, x.data.team.size);
  }

  // ── the page ──
  function countsHtml(data, x) {
    const showIntent = !!data.intent;
    const section = sectionOf(data, x.useIntent);
    const rows = ROLE_ORDER.map(function (role) {
      const need = section.gaps[role];
      const gap = need > 0 ? 'Need ' + need : need < 0 ? Math.abs(need) + ' over' : 'Full';
      return '<tr><th scope="row" class="gs-cell-strong">' + esc(ROLE_LABELS[role]) + '</th>' +
        '<td class="gs-num" data-label="On the roster">' + esc(data.roster.counts[role]) + '</td>' +
        (showIntent ? '<td class="gs-num" data-label="With spec poll picks">' + esc(data.intent.counts[role]) + '</td>' : '') +
        '<td data-label="Target"><label class="gs-sr" for="rt-' + role + '">Target ' + esc(ROLE_LABELS[role]) + '</label><input class="gs-input gs-input-num" type="number" inputmode="numeric" min="0" max="99" step="1" id="rt-' + role + '" name="' + role + '" value="' + esc(data.targets[role]) + '" data-key="rt-' + role + '"></td>' +
        '<td data-label="Gap"><span class="gs-pill gs-pill-' + (need > 0 ? 'warn' : 'ok') + '">' + esc(gap) + '</span></td></tr>';
    }).join('');
    return '<table class="gs-table gs-table-stack" aria-label="Roles against targets"><thead><tr><th scope="col">Role</th><th scope="col">On the roster</th>' + (showIntent ? '<th scope="col">With spec poll picks</th>' : '') +
      '<th scope="col">Target</th><th scope="col">Gap</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function needsHtml(data, x) {
    const section = sectionOf(data, x.useIntent);
    const toggle = data.intent
      ? '<div class="gs-check"><input type="checkbox" id="rt-intent" data-change="recruiting-intent" data-key="rt-intent"' + (x.useIntent ? ' checked' : '') + '><label for="rt-intent">Count the open spec poll (' + esc(data.intent.title) + ')</label></div>' +
        '<p class="gs-fine">' + esc(plural(data.intent.replaced, 'main', 'mains')) + ' replaced by a spec poll pick.</p>'
      : '';
    return '<section class="gs-card-sec" aria-labelledby="rt-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="rt-h">Roles against the targets</h2>' +
      '<span class="gs-fine">' + esc(data.team.size + '-man, ' + plural(section.people, 'person', 'people')) + '</span></div><div class="gs-card-sec-body">' +
      '<p class="gs-fine">Counts the Raider and Trial mains of this team' + (data.customTargets ? '.' : ', against the usual targets for a ' + data.team.size + '-man raid.') + (section.unknown ? ' ' + plural(section.unknown, 'main has', 'mains have') + ' no spec set and ' + (section.unknown === 1 ? 'is' : 'are') + ' not counted.' : '') + '</p>' +
      toggle +
      '<form class="gs-rt-form" data-submit="recruiting-form" novalidate><div class="gs-table-wrap">' + countsHtml(data, x) + '</div>' +
      '<p class="gs-alert" id="rt-error" role="alert"' + (x.error ? '' : ' hidden') + '>' + esc(x.error || '') + '</p>' +
      '<div class="gs-row-actions"><button type="submit" class="gs-btn gs-btn-sm gs-btn-molten" data-key="rt-save"' + (x.busy ? ' disabled' : '') + '>Save targets</button>' +
      (data.customTargets ? '<button type="button" class="gs-btn gs-btn-sm" data-action="recruiting-reset" data-key="rt-reset"' + (x.busy ? ' disabled' : '') + '>Use the ' + esc(data.team.size) + '-man defaults</button>' : '') + '</div></form></div></section>';
  }

  function postHtml(data, x, gd) {
    const text = postText(data, x.cov, G.ui.pageOrigin(), { realmLine: G.ui.realmLine(gd.guild), timeZone: gd.guild.timeZone, useIntent: x.useIntent });
    return '<section class="gs-card-sec" aria-labelledby="rt-post-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="rt-post-h">Recruiting post</h2></div><div class="gs-card-sec-body">' +
      '<label class="gs-label" for="rt-post">Plain text to paste into Discord or a forum</label>' +
      '<textarea class="gs-input gs-textarea" id="rt-post" rows="7" readonly data-key="rt-post">' + esc(text) + '</textarea>' +
      '<div class="gs-row-actions"><button type="button" class="gs-btn gs-btn-sm gs-btn-molten" data-action="recruiting-copy" data-key="rt-copy">Copy recruiting post</button>' +
      '<span class="gs-fine" id="rt-copy-status" role="status"></span></div>' +
      (data.guild.applyEnabled ? '' : '<p class="gs-fine">Applications are off, so the post has no apply link. Turn them on in <a href="' + esc(G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'applications' })) + '">Guild settings</a>.</p>') +
      '</div></section>';
  }

  // opts: { guildData, state: a().recruiting, alert }
  function recruitingHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const data = x.data;
    const head = '<div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Roster</h1><p class="gs-sub">' + esc(data.team.name) + ' &middot; Recruiting needs</p></div>' + G.pages.rosterTabs.html(gd, 'recruiting');
    return '<div class="gs-page">' + head + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '') +
      needsHtml(data, x) + G.coverage.panelHtml(x.cov, { id: 'rt-cov', heading: 'Buffs and debuffs the roster misses', intro: x.useIntent && data.intent ? 'The roster with the spec poll picks laid over it.' : 'The active roster.' }) +
      postHtml(data, x, gd) + '</div>';
  }

  function main(r, gd) {
    const x = a().recruiting;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    return recruitingHtml({ guildData: gd, state: x, alert: G.app.state.pageAlert });
  }

  // ── handlers ──
  function cur() {
    const x = a().recruiting;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id && x.data ? { x: x, gd: gd } : null;
  }

  G.handlers.change['recruiting-intent'] = function (el) {
    const c = cur();
    if (!c) return;
    c.x.useIntent = !!el.checked;
    c.x.cov = coverageOf(c.x);
    G.app.render();
  };

  function save(c, targets) {
    c.x.busy = true; c.x.error = ''; c.x.note = '';
    G.app.render();
    return G.api.recruiting.saveTargets(c.x.gid, c.x.teamId, targets).then(function (data) {
      a().recruiting = makeState(c.x.gid, c.x.teamId, data, c.x.useIntent);
      a().recruiting.note = targets === null ? 'Back to the defaults.' : 'Targets saved.';
      G.app.render();
    }, function (err) {
      c.x.busy = false;
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      c.x.error = cl.text;
      G.app.render();
    });
  }

  G.handlers.submit['recruiting-form'] = function (form) {
    const c = cur();
    if (!c || c.x.busy) return;
    const targets = {};
    for (let i = 0; i < ROLE_ORDER.length; i++) {
      const role = ROLE_ORDER[i];
      const n = Number(form.elements[role].value);
      if (!isFinite(n) || n < 0 || n > 99 || Math.floor(n) !== n || String(form.elements[role].value).trim() === '') {
        c.x.error = ROLE_LABELS[role] + ' must be a whole number from 0 to 99.';
        G.app.render();
        return;
      }
      targets[role] = n;
    }
    save(c, targets);
  };

  G.handlers.click['recruiting-reset'] = function () {
    const c = cur();
    if (!c || c.x.busy) return;
    save(c, null);
  };

  G.handlers.click['recruiting-copy'] = function () {
    const input = typeof document !== 'undefined' ? document.getElementById('rt-post') : null;
    G.ui.copyInput(input).then(function (copied) {
      G.ui.announce('rt-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected text.');
    });
  };

  G.pages.recruiting = {
    ROLE_ORDER: ROLE_ORDER, ROLE_LABELS: ROLE_LABELS, timeLabel: timeLabel, postText: postText, load: load, main: main, recruitingHtml: recruitingHtml, makeState: makeState,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
