// ── PAGE: HOME (what needs attention) ───────────────────────────
// GET /attention -> { today, total, items: [ { id, kind, severity, teamId, teamName, link, ...kind fields } ], more: { <kind>: <n hidden by the cap> } }:
// the open work across the viewer's teams in one list, each item a link to the page where it gets done. Items with severity 'action' come first,
// grouped by kind in a fixed order; the 'info' items follow under "For your information". Open for people who can act on one of the items (the
// shell sends everyone else to Roster). The count in the sidebar's Home badge is `total`; app.js keeps the last answer per guild.
(function (G) {
  'use strict';

  // Display order, with the heading of each group and the chip on each row. 'unlocked' is the one info kind.
  const KINDS = [
    { id: 'review', severity: 'action', heading: 'Raids to review', chip: 'Review' },
    { id: 'loot_unmatched', severity: 'action', heading: 'Loot winners nobody matches', chip: 'Loot' },
    { id: 'signup_unmatched', severity: 'action', heading: 'Sign-ups not linked to a person', chip: 'Sign-ups' },
    { id: 'claims', severity: 'action', heading: 'Character claims', chip: 'Claims' },
    { id: 'trial', severity: 'action', heading: 'Trials', chip: 'Trial' },
    { id: 'watch', severity: 'action', heading: 'Attendance watch list', chip: 'Watch list' },
    { id: 'no_loot', severity: 'action', heading: 'Raids without loot', chip: 'No loot' },
    { id: 'low_signups', severity: 'action', heading: 'Raids short on sign-ups', chip: 'Low sign-ups' },
    { id: 'roster_declined', severity: 'action', heading: 'Rostered players who can\'t make it', chip: 'Roster' },
    { id: 'unlocked', severity: 'info', heading: 'Sign-ups still open', chip: 'Open' },
  ];
  // Route names an item link may use (an address built from anything else falls back to the Roster).
  const LINK_NAMES = ['raid', 'review', 'person', 'personatt'];
  // Where "and N more" goes for each kind: the page where that kind of work is done.
  const MORE_LINKS = {
    review: { name: 'review' },
    loot_unmatched: { name: 'review' },
    signup_unmatched: { name: 'section', section: 'raids' },
    claims: { name: 'review' },
    trial: { name: 'section', section: 'roster' },
    watch: { name: 'section', section: 'attendance' },
    no_loot: { name: 'section', section: 'raids' },
    low_signups: { name: 'section', section: 'raids' },
    roster_declined: { name: 'section', section: 'raids' },
    unlocked: { name: 'section', section: 'raids' },
  };

  function st() { return G.app.state; }
  function a() { return G.pages.attendance.attState(); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function dayOf(date) { return G.ui.weekdayDay(date) || String(date == null ? '' : date); }
  function kindOf(id) { return KINDS.filter(function (k) { return k.id === id; })[0] || null; }
  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  // ── one item ──
  // The sentence of an item, as plain text (the page escapes it).
  function itemText(item) {
    const it = item || {};
    const n = num(it.count);
    switch (it.kind) {
      case 'review': return 'Review ' + dayOf(it.date) + ': ' + n + ' to decide';
      case 'loot_unmatched': return plural(n, 'loot winner', 'loot winners') + ' on ' + dayOf(it.date) + (n === 1 ? ' matches' : ' match') + ' nobody';
      case 'signup_unmatched': return plural(n, 'sign-up', 'sign-ups') + ' on ' + dayOf(it.date) + (n === 1 ? ' is' : ' are') + ' not linked to a person';
      case 'claims': return plural(n, 'character claim', 'character claims') + (n === 1 ? ' is' : ' are') + ' waiting';
      case 'trial': {
        const days = Math.abs(num(it.days));
        const copy = G.ui.trialCopy({ kind: it.ended ? 'ended' : 'ends', days: days });
        return String(it.name == null ? '' : it.name) + '\'s trial ' + lowerFirst(copy);
      }
      case 'watch': {
        const drop = num(it.drop);
        return String(it.name == null ? '' : it.name) + ': ' + G.ui.percent(it.pct) + ' attendance' + (drop > 0 ? ', down ' + plural(Math.round(drop), 'point', 'points') : '');
      }
      case 'no_loot': return 'No loot imported for ' + dayOf(it.date);
      case 'low_signups': return dayOf(it.date) + ': ' + num(it.expected) + ' of ' + num(it.size) + ' signed up';
      case 'roster_declined': return dayOf(it.date) + ': ' + plural(n, 'rostered person', 'rostered people') + ' can\'t make it';
      case 'unlocked': return 'Sign-ups for ' + dayOf(it.date) + ' are still open and the raid starts in ' + plural(Math.round(num(it.minutes)), 'minute', 'minutes');
      default: return String(it.kind == null ? 'Needs attention' : it.kind).replace(/_/g, ' ');
    }
  }

  // The address of an item's link (item.link is a route without the guild id).
  function itemHref(gid, item) {
    const link = item && item.link && typeof item.link === 'object' ? item.link : null;
    if (!link || LINK_NAMES.indexOf(link.name) < 0) return G.router.format({ name: 'section', gid: gid, section: 'roster' });
    return G.router.format(Object.assign({}, link, { gid: gid }));
  }

  // The muted line under the sentence: the team (only when the guild has several), and the raid's zone and title where there are any.
  function metaParts(item, showTeam) {
    const parts = [];
    if (showTeam && item.teamName) parts.push(String(item.teamName));
    if (item.zone) parts.push(String(item.zone));
    if (item.title && item.title !== item.zone) parts.push(String(item.title));
    return parts;
  }

  // A link whose page works on the SELECTED team (the review queue) first selects the item's team: see the attn-open handler.
  function needsTeam(item) { return !!(item && item.link && item.link.name === 'review' && item.teamId); }

  function itemHtml(gid, item, showTeam) {
    const kind = kindOf(item.kind);
    const meta = metaParts(item, showTeam);
    return '<li><a class="gs-attn-item" href="' + esc(itemHref(gid, item)) + '"' + (needsTeam(item) ? ' data-action="attn-open" data-team="' + esc(item.teamId) + '"' : '') + '>' +
      '<span class="gs-chip gs-chip-attn">' + esc(kind ? kind.chip : 'Item') + '</span>' +
      '<span class="gs-attn-text"><span class="gs-attn-line">' + esc(itemText(item)) + '</span>' +
      (meta.length ? '<span class="gs-attn-meta">' + meta.map(esc).join(' &middot; ') + '</span>' : '') + '</span>' +
      G.icons.icon('arrow', 18) + '</a></li>';
  }

  function moreHtml(gid, kind, count) {
    const link = Object.assign({ gid: gid }, MORE_LINKS[kind.id]);
    return '<li class="gs-attn-more"><a href="' + esc(G.router.format(link)) + '">and ' + esc(count) + ' more<span class="gs-sr"> ' + esc(kind.heading.toLowerCase()) + '</span></a></li>';
  }

  // One group per kind that has items (or hidden ones) in this severity.
  function groupHtml(gid, kind, items, more, showTeam) {
    const id = 'attn-h-' + kind.id;
    return '<section class="gs-attn-group" aria-labelledby="' + id + '"><h3 class="gs-h3" id="' + id + '">' + esc(kind.heading) + '</h3><ul class="gs-attn-list">' +
      items.map(function (it) { return itemHtml(gid, it, showTeam); }).join('') + (more > 0 ? moreHtml(gid, kind, more) : '') + '</ul></section>';
  }

  // The groups of one severity, in KINDS order. An item says its own severity; the hidden counts (data.more) have none, so a kind's own counts.
  function severityHtml(gid, severity, data, showTeam) {
    const items = Array.isArray(data.items) ? data.items : [];
    const more = data.more && typeof data.more === 'object' ? data.more : {};
    return KINDS.map(function (kind) {
      const list = items.filter(function (it) { return it && it.kind === kind.id && (it.severity === 'info' || it.severity === 'action' ? it.severity : kind.severity) === severity; });
      const hidden = kind.severity === severity ? Math.floor(num(more[kind.id])) : 0;
      return list.length || hidden > 0 ? groupHtml(gid, kind, list, hidden, showTeam) : '';
    }).join('');
  }

  // opts: { guildData, data (GET /attention), refreshing, error }
  function attentionHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || { items: [], more: {}, total: 0 };
    const showTeam = G.shell.activeTeams(gd.teams).length > 1;
    const total = Math.max(0, Math.floor(num(data.total)));
    const actions = severityHtml(gid, 'action', data, showTeam);
    const info = severityHtml(gid, 'info', data, showTeam);
    const sub = esc(gd.guild.name) + ' &middot; ' + (total ? esc(plural(total, 'item needs', 'items need')) + ' you' : 'Nothing is waiting for you');
    const head = '<div class="gs-roster-head"><div class="gs-page-head"><h1 class="gs-h1" tabindex="-1">Home</h1><p class="gs-sub">' + sub + '</p></div>' +
      '<div class="gs-roster-actions"><button type="button" class="gs-btn" data-action="attn-refresh" data-key="attn-refresh"' + (opts.refreshing ? ' disabled' : '') + '>' + (opts.refreshing ? 'Refreshing...' : 'Refresh') + '</button></div></div>';
    const empty = actions ? '' : '<section class="gs-empty-card" aria-labelledby="attn-empty-h"><span class="gs-empty-icon" aria-hidden="true">' + G.icons.icon('check', 28) + '</span>' +
      '<h2 class="gs-h2 gs-h2-lg" id="attn-empty-h">Nothing needs you right now</h2><p class="gs-lead gs-lead-sm">Reviews, claims, trials and sign-ups that need an officer show up here.</p></section>';
    return '<div class="gs-page gs-attn-page">' + head + G.ui.alertHtml(opts.error || '', 'gs-page-alert') +
      '<p class="gs-sr" id="attn-status" role="status"></p>' +
      (actions ? '<section class="gs-attn-section" aria-labelledby="attn-todo-h"><h2 class="gs-h2" id="attn-todo-h">Needs attention</h2>' + actions + '</section>' : '') + empty +
      (info ? '<section class="gs-attn-section" aria-labelledby="attn-info-h"><h2 class="gs-h2" id="attn-info-h">For your information</h2>' + info + '</section>' : '') + '</div>';
  }

  // ── data ──
  function load(r, gd) {
    const gid = gd.guild.id;
    return G.api.attention.get(gid).then(function (data) {
      a().attention = { gid: gid, data: data, refreshing: false, error: '' };
      G.app.setAttention(gid, data);
      return null;
    });
  }

  function main(r, gd) {
    const x = a().attention;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return attentionHtml({ guildData: gd, data: x.data, refreshing: x.refreshing, error: x.error });
  }

  // ── handlers ──
  G.handlers.click['attn-refresh'] = function () {
    const x = a().attention;
    if (!x || x.refreshing) return null;
    x.refreshing = true;
    x.error = '';
    G.app.render();
    return G.api.attention.get(x.gid).then(function (data) {
      x.data = data;
      x.refreshing = false;
      G.app.setAttention(x.gid, data);
      G.app.render();
      G.ui.focusByKey('attn-refresh', { preventScroll: true }); // the button was disabled while it ran, so the keyboard had left it
      G.ui.announce('attn-status', num(data && data.total) > 0 ? 'Updated. ' + plural(Math.floor(num(data.total)), 'item needs', 'items need') + ' you.' : 'Updated. Nothing needs you right now.');
      return null;
    }, function (err) {
      x.refreshing = false;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return null; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return null; }
      x.error = c.text;
      G.app.render();
      G.ui.focusByKey('attn-refresh', { preventScroll: true });
      return null;
    });
  };

  // The review queue shows the selected team's raids: choose the item's team, then let the link navigate as it would anyway.
  G.handlers.click['attn-open'] = function (el) {
    const gid = st().currentGid;
    const teamId = el.getAttribute('data-team');
    if (gid && teamId) G.app.selectTeam(gid, teamId);
  };

  G.pages.attention = {
    KINDS: KINDS,
    itemText: itemText,
    itemHref: itemHref,
    attentionHtml: attentionHtml,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
