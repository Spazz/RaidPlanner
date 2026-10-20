// ── PAGE: ROSTER > RECRUITING (applications and recruitment needs; #/roster/recruiting and the old #/roster/applications) ───────────────
// The left column is the applications inbox (pages-applications.js). The right column, for the team on screen: how many tanks, healers, melee and ranged DPS the active roster (Raider and Trial mains) has against officer-set targets (the
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
    return Promise.all([G.api.recruiting.get(gid, teamId), G.pages.applications.load(r, gd)]).then(function (res) {
      a().recruiting = makeState(gid, teamId, res[0], prev && prev.gid === gid && prev.teamId === teamId ? prev.useIntent : null);
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
  function gapChip(need) {
    if (need > 0) return '<span class="gs-hd-chip is-rose">Need ' + esc(need) + '</span>';
    if (need < 0) return '<span class="gs-hd-chip is-blue">' + esc(Math.abs(need)) + ' over</span>';
    return '<span class="gs-hd-chip is-green">Full</span>';
  }

  // The Recruiting needs panel: a row per role (on the roster / target), the spec poll toggle, Edit targets (a dialog).
  function needsHtml(data, x) {
    const section = sectionOf(data, x.useIntent);
    const rows = ROLE_ORDER.map(function (role) {
      return '<div class="gs-rc-need"><span class="gs-rc-role">' + esc(ROLE_LABELS[role]) + '</span><span class="gs-rc-n">' + esc(section.counts[role]) +
        '<span class="gs-rc-d"> / ' + esc(data.targets[role]) + '</span></span>' + gapChip(section.gaps[role]) + '</div>';
    }).join('');
    const toggle = data.intent
      ? '<div class="gs-rc-foot"><div class="gs-check"><input type="checkbox" id="rt-intent" data-change="recruiting-intent" data-key="rt-intent"' + (x.useIntent ? ' checked' : '') + '><label for="rt-intent">Count the open spec poll (' + esc(data.intent.title) + ')</label></div>' +
        '<span class="gs-fg-mut">' + esc(plural(data.intent.replaced, 'main', 'mains')) + ' replaced by a spec poll pick.</span></div>'
      : '';
    const note = (data.customTargets ? '' : 'The usual targets for a ' + data.team.size + '-man raid. ') + (section.unknown ? plural(section.unknown, 'main has', 'mains have') + ' no spec set and ' + (section.unknown === 1 ? 'is' : 'are') + ' not counted.' : '');
    return '<section class="gs-hd-panel gs-rc-panel" aria-labelledby="rt-h"><div class="gs-rc-ph"><h2 class="gs-rc-h2" id="rt-h">Recruiting needs</h2>' +
      '<button type="button" class="gs-btn gs-btn-ghost" data-action="recruiting-edit" data-key="rt-edit"' + (x.busy ? ' disabled' : '') + '>Edit targets</button></div>' + rows +
      (note.trim() ? '<p class="gs-rc-note gs-fg-mut">' + esc(note.trim()) + '</p>' : '') + toggle + '</section>';
  }

  function namesOf(entries) { return entries.map(function (e) { return e.name; }).join(', '); }

  // Missing buffs and debuffs in the panel's words; what is covered stays folded away.
  function missingHtml(cov, x, data) {
    const head = function (tail) { return '<div class="gs-rc-ph"><h2 class="gs-rc-h2" id="rt-cov-h">Missing buffs and debuffs</h2>' + (tail || '') + '</div>'; };
    if (!cov) return '<section class="gs-hd-panel gs-rc-panel" aria-labelledby="rt-cov-h">' + head() + '<p class="gs-rc-body gs-fg-mut">Buff coverage is not available for this game version here.</p></section>';
    if (!cov.seated) return '<section class="gs-hd-panel gs-rc-panel" aria-labelledby="rt-cov-h">' + head() + '<p class="gs-rc-body gs-fg-mut">Nobody is planned yet, so nothing is covered.</p></section>';
    const groups = [['Buffs', cov.buffs || []], ['Debuffs', cov.debuffs || []]];
    const s = G.coverage.summary(cov);
    const body = groups.map(function (g) {
      const miss = g[1].filter(function (e) { return !e.covered; });
      return '<div class="gs-rc-grp"><h3 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(g[0]) + '</span><span class="gs-fg-ghn">' + esc(miss.length + ' of ' + g[1].length + ' missing') + '</span></h3>' +
        '<p class="gs-rc-names">' + (miss.length ? esc(namesOf(miss)) : 'None missing.') + '</p></div>';
    }).join('');
    const covered = groups.map(function (g) {
      const ok = g[1].filter(function (e) { return e.covered; });
      return ok.length ? '<div class="gs-rc-grp"><h3 class="gs-fg-gh"><span class="gs-fg-ght">' + esc(g[0]) + '</span><span class="gs-fg-ghn">' + esc(ok.length + ' covered') + '</span></h3><p class="gs-rc-names">' + esc(namesOf(ok)) + '</p></div>' : '';
    }).join('');
    return '<section class="gs-hd-panel gs-rc-panel" id="rt-cov" aria-labelledby="rt-cov-h">' + head('<span class="gs-rc-miss">' + esc(s.missing) + ' missing</span>') +
      '<div class="gs-rc-body"><p class="gs-fg-mut">' + esc(x.useIntent && data.intent ? 'The roster with the spec poll picks laid over it.' : 'The active roster.') + '</p>' + body +
      (covered ? '<details class="gs-rc-covered"><summary>Covered (' + esc(s.buffs + s.debuffs) + ')</summary>' + covered + '</details>' : '') + '</div></section>';
  }

  function postHtml(data, x, gd) {
    const text = postText(data, x.cov, G.ui.pageOrigin(), { realmLine: G.ui.realmLine(gd.guild), timeZone: gd.guild.timeZone, useIntent: x.useIntent });
    return '<section class="gs-hd-panel gs-rc-panel" aria-labelledby="rt-post-h"><div class="gs-rc-ph"><h2 class="gs-rc-h2" id="rt-post-h">Recruiting post</h2></div><div class="gs-rc-body">' +
      '<label class="gs-sr" for="rt-post">Recruiting post, plain text to paste into Discord or a forum</label>' +
      '<textarea class="gs-input gs-textarea gs-rc-post" id="rt-post" rows="7" readonly data-key="rt-post">' + esc(text) + '</textarea>' +
      '<div class="gs-rc-postacts"><button type="button" class="gs-btn" data-action="recruiting-copy" data-key="rt-copy">Copy recruiting post</button>' +
      '<span class="gs-fg-mut" id="rt-copy-status" role="status"></span></div>' +
      (data.guild.applyEnabled ? '' : '<p class="gs-fg-mut">Applications are off, so the post has no apply link. Turn them on in <a class="gs-fg-u" href="' + esc(G.router.format({ name: 'settings', gid: gd.guild.id, tab: 'applications' })) + '">Guild settings</a>.</p>') +
      '</div></section>';
  }

  // opts: { guildData, state: a().recruiting, apps: a().applications (the left column), alert }
  function recruitingHtml(opts) {
    const gd = opts.guildData;
    const x = opts.state;
    const data = x.data;
    const head = G.pages.rosterTabs.headHtml(gd, 'recruiting', data.team.name);
    const apps = opts.apps && opts.apps.data ? G.pages.applications.sectionHtml(gd, opts.apps) : '<section class="gs-rc-apps" aria-label="Applications"><h2 class="gs-hd-sl">Applications</h2><p class="gs-empty">Loading applications...</p></section>';
    return '<div class="gs-page gs-forge gs-rc-page">' + head + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + (x.note ? '<div class="gs-notice" role="status"><span>' + esc(x.note) + '</span></div>' : '') +
      '<div class="gs-rc-grid">' + apps + '<div class="gs-rc-side">' + needsHtml(data, x) + missingHtml(x.cov, x, data) + postHtml(data, x, gd) + '</div></div></div>';
  }

  function main(r, gd) {
    const x = a().recruiting;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    if (!x.teamId) return G.pages.roster.noTeamHtml(G.shell.hasAction(gd.me && gd.me.can, 'guild.teams'), gd.guild.id);
    const apps = a().applications;
    return recruitingHtml({ guildData: gd, state: x, apps: apps && apps.gid === gd.guild.id ? apps : null, alert: G.app.state.pageAlert });
  }

  // ── the targets dialog ──
  function targetsDialogHtml(data) {
    const inputs = ROLE_ORDER.map(function (role) {
      return '<div class="gs-field"><label class="gs-label" for="rt-' + role + '">' + esc(ROLE_LABELS[role]) + '</label><input class="gs-input gs-input-num" type="number" inputmode="numeric" min="0" max="99" step="1" id="rt-' + role + '" name="' + role +
        '" value="' + esc(data.targets[role]) + '" data-field="' + role + '" data-key="rt-' + role + '"></div>';
    }).join('');
    return '<form class="gs-dialog-form" data-submit="recruiting-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">Recruiting targets</h2>' +
      '<p class="gs-fine" id="dlg-text">How many of each role ' + esc(data.team.name) + ' wants on the roster. The Roster counts Raider and Trial mains against them.</p>' + inputs +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions">' + (data.customTargets ? '<button type="button" class="gs-btn gs-btn-ghost" data-action="recruiting-reset" data-key="rt-reset">Use the ' + esc(data.team.size) + '-man defaults</button>' : '') +
      '<button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" data-key="rt-save">Save targets</button></div></form>';
  }

  // ── handlers ──
  function cur() {
    const x = a().recruiting;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id && x.data ? { x: x, gd: gd } : null;
  }

  // Reads the right column again (someone was accepted, so the roster counts moved); a failed read leaves what is shown.
  function refresh() {
    const c = cur();
    if (!c) return Promise.resolve(null);
    return G.api.recruiting.get(c.x.gid, c.x.teamId).then(function (data) {
      if (a().recruiting !== c.x) return null;
      a().recruiting = makeState(c.x.gid, c.x.teamId, data, c.x.useIntent);
      G.app.render();
      return null;
    }, function () { return null; });
  }

  G.handlers.change['recruiting-intent'] = function (el) {
    const c = cur();
    if (!c) return;
    c.x.useIntent = !!el.checked;
    c.x.cov = coverageOf(c.x);
    G.app.render();
  };

  G.handlers.click['recruiting-edit'] = function () {
    const c = cur();
    if (!c) return;
    G.ui.openDialog(targetsDialogHtml(c.x.data), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
  };

  // Saves the targets (null: back to the defaults) from the dialog; the answer is the new page data.
  function save(c, form, targets) {
    G.ui.runDialog(form, G.api.recruiting.saveTargets(c.x.gid, c.x.teamId, targets), function (data) {
      a().recruiting = makeState(c.x.gid, c.x.teamId, data, c.x.useIntent);
      a().recruiting.note = targets === null ? 'Back to the defaults.' : 'Targets saved.';
      G.app.render();
    });
  }

  G.handlers.submit['recruiting-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const targets = {};
    for (let i = 0; i < ROLE_ORDER.length; i++) {
      const role = ROLE_ORDER[i];
      const raw = String(form.elements[role].value).trim();
      const n = Number(raw);
      if (!isFinite(n) || n < 0 || n > 99 || Math.floor(n) !== n || raw === '') {
        G.ui.setText('dlg-error', ROLE_LABELS[role] + ' must be a whole number from 0 to 99.');
        return;
      }
      targets[role] = n;
    }
    save(c, form, targets);
  };

  G.handlers.click['recruiting-reset'] = function (el) {
    const c = cur();
    const form = el && el.closest ? el.closest('form') : null;
    if (!c || !form) return;
    save(c, form, null);
  };

  G.handlers.click['recruiting-copy'] = function () {
    const input = typeof document !== 'undefined' ? document.getElementById('rt-post') : null;
    G.ui.copyInput(input).then(function (copied) {
      G.ui.announce('rt-copy-status', copied ? 'Copied.' : 'Press Ctrl+C to copy the selected text.');
    });
  };

  G.pages.recruiting = {
    ROLE_ORDER: ROLE_ORDER, ROLE_LABELS: ROLE_LABELS, timeLabel: timeLabel, postText: postText, load: load, main: main, recruitingHtml: recruitingHtml, makeState: makeState,
    targetsDialogHtml: targetsDialogHtml, refresh: refresh,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
