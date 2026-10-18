// ── PAGE: HOME (T4: what needs attention) ───────────────────────
// The guild's landing page, in two variants. The officer variant (anyone who can act on one of the items; GET /attention) leads with "Needs attention" whenever
// it has items, one secondary button per row, then "For your information", then the setup checklist: the whole list until the guild has a raid, one line
// ("Setup 4 of 6 steps done. Next: ...") after, with "All steps" to open it again. The member variant (everyone else) is pages-home-member.js; this file picks
// between them in load() and main().
// GET /attention -> { today, total, items: [ { id, kind, severity, teamId, teamName, link, ...kind fields } ], more: { <kind>: <n hidden by the cap> }, onboarding }:
// the open work across the viewer's teams in one list, each item a link to the page where it gets done. Items with severity 'action' come first,
// grouped by kind in a fixed order; the 'info' items follow under "For your information". The count in the sidebar's Home badge is `total`; app.js keeps
// the last answer per guild.
(function (G) {
  'use strict';

  // Display order, with the heading of each group (the "and N more" line names it) and the label of the button on each row. 'unlocked' is the one info kind.
  const KINDS = [
    { id: 'review', severity: 'action', heading: 'Raids to review', action: 'Review' },
    { id: 'loot_unmatched', severity: 'action', heading: 'Loot winners nobody matches', action: 'Link winners' },
    { id: 'signup_unmatched', severity: 'action', heading: 'Sign-ups not linked to a person', action: 'Link sign-ups' },
    { id: 'claims', severity: 'action', heading: 'Character claims', action: 'Review claims' },
    { id: 'applications', severity: 'action', heading: 'New applications', action: 'Review' },
    { id: 'trial', severity: 'action', heading: 'Trials', action: 'Open' },
    { id: 'watch', severity: 'action', heading: 'Attendance watch list', action: 'Open' },
    { id: 'rank', severity: 'action', heading: 'Rank suggestions', action: 'Open' },
    { id: 'no_loot', severity: 'action', heading: 'Raids without loot', action: 'Add loot' },
    { id: 'low_signups', severity: 'action', heading: 'Raids short on sign-ups', action: 'Open raid' },
    { id: 'log_missing', severity: 'action', heading: 'Raids waiting for a log', action: 'Open raid' },
    { id: 'roster_declined', severity: 'action', heading: 'Line-up players who can\'t come', action: 'Open raid' },
    { id: 'roster_pending', severity: 'action', heading: 'Line-up players who haven\'t confirmed', action: 'Open raid' },
    { id: 'event_moved', severity: 'action', heading: 'Raid-Helper events on another day', action: 'Open raid' },
    { id: 'webhook_off', severity: 'action', heading: 'Discord webhooks switched off', action: 'Open settings' },
    { id: 'unlocked', severity: 'info', heading: 'Sign-ups still open', action: 'Open raid' },
  ];
  // Route names an item link may use (an address built from anything else falls back to the Roster).
  const LINK_NAMES = ['raid', 'review', 'person', 'personatt', 'applications', 'settings'];
  // Where "and N more" goes for each kind: the page where that kind of work is done.
  const MORE_LINKS = {
    review: { name: 'review' },
    loot_unmatched: { name: 'review' },
    signup_unmatched: { name: 'section', section: 'raids' },
    claims: { name: 'review' },
    applications: { name: 'applications' },
    trial: { name: 'section', section: 'roster' },
    watch: { name: 'section', section: 'attendance' },
    rank: { name: 'section', section: 'attendance' },
    no_loot: { name: 'section', section: 'raids' },
    low_signups: { name: 'section', section: 'raids' },
    roster_declined: { name: 'section', section: 'raids' },
    roster_pending: { name: 'section', section: 'raids' },
    log_missing: { name: 'section', section: 'raids' },
    event_moved: { name: 'section', section: 'raids' },
    webhook_off: { name: 'settings', tab: 'notifications' },
    unlocked: { name: 'section', section: 'raids' },
  };

  // The setup checklist (Phase 8): GET /attention sends onboarding: { steps: [{ id, done }], done, total } to the people who set the guild up, until it is
  // dismissed or every step is done. The steps tick themselves from the guild's data; this table is the wording and the page each step opens.
  const ONBOARDING = [
    { id: 'teams', title: 'Set up your teams', hint: 'Name your raid teams, or give a team a weekly schedule.', route: { name: 'settings', tab: 'teams' } },
    { id: 'roster', title: 'Import your roster', hint: 'From Raid-Helper, Warcraft Logs or Battle.net, or add people by hand.', route: { name: 'section', section: 'roster' } },
    { id: 'attendance', title: 'Set the attendance rules', hint: 'What counts as present, late or absent, and when someone is on the watch list.', route: { name: 'settings', tab: 'attendance' } },
    { id: 'raid', title: 'Add your first raid', hint: 'From a Warcraft Logs report, a Raid-Helper event or by hand.', route: { name: 'raidnew' } },
    { id: 'officers', title: 'Invite your officers', hint: 'Give officers their role, by hand or from a Discord role. Send them the invite message first.', route: { name: 'settings', tab: 'people' }, invite: true },
    { id: 'loot', title: 'Import loot', hint: 'Bring in a Gargul export for a raid.', route: { name: 'section', section: 'loot' } },
  ];

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
      case 'applications': return plural(n, 'new application', 'new applications') + ' waiting';
      case 'trial': {
        const days = Math.abs(num(it.days));
        const copy = G.ui.trialCopy({ kind: it.ended ? 'ended' : 'ends', days: days });
        return String(it.name == null ? '' : it.name) + '\'s trial ' + lowerFirst(copy);
      }
      case 'watch': {
        const drop = num(it.drop);
        return String(it.name == null ? '' : it.name) + ': ' + G.ui.percent(it.pct) + ' attendance' + (drop > 0 ? ', down ' + plural(Math.round(drop), 'point', 'points') : '');
      }
      case 'rank': {
        const who = String(it.name == null ? '' : it.name);
        const from = it.from && it.from.name ? it.from.name : 'the current rank';
        const to = it.to && it.to.name ? it.to.name : 'the next rank';
        return who + ': ' + (it.suggestion === 'review' ? 'suggested review (below ' + from + ')' : 'suggested promotion to ' + to);
      }
      case 'no_loot': return 'No loot imported for ' + dayOf(it.date);
      case 'low_signups': return dayOf(it.date) + ': ' + num(it.expected) + ' of ' + num(it.size) + ' signed up';
      case 'roster_declined': return dayOf(it.date) + ': ' + plural(n, 'line-up player', 'line-up players') + ' can\'t come';
      case 'roster_pending': return dayOf(it.date) + ': ' + plural(n, 'line-up player hasn\'t', 'line-up players haven\'t') + ' confirmed';
      case 'log_missing': return 'Upload the log for ' + dayOf(it.date) + (it.loggerName ? ' (Logger: ' + String(it.loggerName) + ')' : '');
      case 'event_moved': return dayOf(it.date) + ': Raid-Helper has the event on ' + dayOf(it.eventDate) + '; the raid was not moved';
      case 'webhook_off': return 'The Discord webhook of ' + String(it.teamName == null ? 'a team' : it.teamName) + ' was switched off' + (it.status ? ' (Discord answered ' + num(it.status) + ')' : '');
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

  // One row of the list: the sentence, the muted line, one secondary button named for the kind. The button's accessible name starts with its label.
  function rowOf(gid, item, kind, showTeam) {
    const title = itemText(item);
    return {
      tone: kind.severity === 'info' ? 'info' : 'warning',
      title: title,
      text: metaParts(item, showTeam).join(' - '),
      action: {
        label: kind.action, href: itemHref(gid, item), ariaLabel: kind.action + ' (' + title + ')',
        attrs: needsTeam(item) ? { 'data-action': 'attn-open', 'data-team': item.teamId } : null,
      },
    };
  }

  function moreRowOf(gid, kind, count) {
    const text = 'and ' + count + ' more: ' + lowerFirst(kind.heading);
    return {
      tone: kind.severity === 'info' ? 'info' : 'warning', title: text, text: '',
      action: { label: 'See all', href: G.router.format(Object.assign({ gid: gid }, MORE_LINKS[kind.id])), ariaLabel: 'See all (' + text + ')' },
    };
  }

  // The rows of one severity, in KINDS order. An item says its own severity; the hidden counts (data.more) have none, so a kind's own counts.
  function rowsOf(gid, severity, data, showTeam) {
    const items = Array.isArray(data.items) ? data.items : [];
    const more = data.more && typeof data.more === 'object' ? data.more : {};
    const rows = [];
    KINDS.forEach(function (kind) {
      items.filter(function (it) { return it && it.kind === kind.id && (it.severity === 'info' || it.severity === 'action' ? it.severity : kind.severity) === severity; })
        .forEach(function (it) { rows.push(rowOf(gid, it, kind, showTeam)); });
      const hidden = kind.severity === severity ? Math.floor(num(more[kind.id])) : 0;
      if (hidden > 0) rows.push(moreRowOf(gid, kind, hidden));
    });
    return rows;
  }

  // ── the setup checklist ──
  function onboardingStepOf(onboarding, id) {
    const steps = onboarding && Array.isArray(onboarding.steps) ? onboarding.steps : [];
    return steps.filter(function (s) { return s && s.id === id; })[0] || null;
  }

  function stepDone(onboarding, id) { const s = onboardingStepOf(onboarding, id); return !!(s && s.done); }

  // Whether the checklist shows whole: until the guild has a raid. The officer's own "All steps" / "Hide steps" choice (x.setupOpen) wins once made.
  function setupIsOpen(onboarding, choice) {
    if (typeof choice === 'boolean') return choice;
    return !stepDone(onboarding, 'raid');
  }

  function dotsHtml(onboarding) {
    return '<span class="gs-onboard-dots" aria-hidden="true">' + ONBOARDING.map(function (def) {
      return '<span class="gs-onboard-dot' + (stepDone(onboarding, def.id) ? ' is-done' : '') + '"></span>';
    }).join('') + '</span>';
  }

  // The address of the site, with a closing slash ("https://raidsmith.example/"); '' where the page does not know it.
  function siteAddress() {
    const loc = typeof window !== 'undefined' ? window.location : null;
    return loc && typeof loc.origin === 'string' && loc.origin !== 'null' ? loc.origin + '/' : '';
  }

  // The message an officer sends to the guild: where the site is and how to get in. Plain text, ready to paste into Discord.
  function inviteMessage(guildName, address) {
    const name = String(guildName == null ? '' : guildName).trim() || 'Our guild';
    const site = address ? 'Open ' + address + ' and sign in with Discord' : 'Open Raidsmith and sign in with Discord';
    return name + ' is on Raidsmith. ' + site + ' to see the raids, confirm your spot, and check your attendance and loot.';
  }

  // The button on step 5 and on Settings > Accounts. The status line is a live region for the result.
  function inviteButtonHtml(opts) {
    const o = opts || {};
    return G.ui.buttonHtml({ label: 'Copy invite message', variant: o.primary ? 'primary' : 'secondary', size: 'sm', attrs: { 'data-action': 'copy-invite', 'data-key': o.key || 'copy-invite' } });
  }

  // The card, whole: every step is a link to its page; a finished step is ticked and says so in words. '' when there is nothing to show.
  function onboardingFullHtml(gid, onboarding, busy, canHide) {
    const total = ONBOARDING.length;
    const done = ONBOARDING.filter(function (def) { return stepDone(onboarding, def.id); }).length;
    const items = ONBOARDING.map(function (def, i) {
      const isDone = stepDone(onboarding, def.id);
      const href = G.router.format(Object.assign({}, def.route, { gid: gid }));
      return '<li class="gs-onboard-step' + (isDone ? ' is-done' : '') + '"><span class="gs-onboard-mark" aria-hidden="true">' + (isDone ? G.icons.icon('check', 16) : esc(i + 1)) + '</span>' +
        '<a class="gs-onboard-link" href="' + esc(href) + '">' + esc(def.title) + (isDone ? '<span class="gs-sr"> (done)</span>' : '') + '</a>' +
        '<span class="gs-onboard-hint">' + esc(def.hint) + '</span>' + (def.invite && !isDone ? '<span class="gs-onboard-act">' + inviteButtonHtml({ key: 'copy-invite-step' }) + '</span>' : '') + '</li>';
    }).join('');
    return '<section class="gs-onboard" id="setup" aria-labelledby="onb-h"><div class="gs-onboard-head"><div><h2 class="gs-h2" id="onb-h">Set up your guild</h2>' +
      '<p class="gs-sub">' + dotsHtml(onboarding) + esc(done + ' of ' + total + ' steps done') + '</p></div><div class="gs-onboard-tools">' +
      (canHide ? G.ui.buttonHtml({ label: 'Hide steps', variant: 'secondary', size: 'sm', attrs: { 'data-action': 'setup-toggle', 'data-key': 'setup-toggle' } }) : '') +
      G.ui.buttonHtml({ label: 'Dismiss', variant: 'secondary', size: 'sm', disabled: !!busy, attrs: { 'data-action': 'onboarding-dismiss', 'data-key': 'onboarding-dismiss' } }) + '</div></div>' +
      '<ol class="gs-onboard-steps">' + items + '</ol></section>';
  }

  // The card, one line: "Setup  [dots]  4 of 6 steps done. Next: Invite your officers   [Copy invite message] [All steps]".
  function onboardingLineHtml(gid, onboarding) {
    const total = ONBOARDING.length;
    const done = ONBOARDING.filter(function (def) { return stepDone(onboarding, def.id); }).length;
    const next = ONBOARDING.filter(function (def) { return !stepDone(onboarding, def.id); })[0] || null;
    const nextHtml = next ? ' Next: <a class="gs-onboard-link" href="' + esc(G.router.format(Object.assign({}, next.route, { gid: gid }))) + '">' + esc(lowerFirst(next.title)) + '</a>.' : '';
    return '<section class="gs-onboard is-line" id="setup" aria-labelledby="onb-h"><h2 class="gs-h2" id="onb-h">Setup</h2>' + dotsHtml(onboarding) +
      '<p class="gs-onboard-line">' + esc(done + ' of ' + total + ' steps done.') + nextHtml + '</p><div class="gs-onboard-tools">' +
      (next && next.invite ? inviteButtonHtml({ key: 'copy-invite-line' }) : '') +
      G.ui.buttonHtml({ label: 'All steps', variant: 'secondary', size: 'sm', attrs: { 'data-action': 'setup-toggle', 'data-key': 'setup-toggle', 'aria-expanded': 'false', 'aria-controls': 'setup' } }) + '</div></section>';
  }

  // opts after (gid, onboarding): busy (Dismiss in flight), choice (x.setupOpen: true, false or undefined).
  function onboardingHtml(gid, onboarding, busy, choice) {
    if (!onboarding || !Array.isArray(onboarding.steps) || !onboarding.steps.length) return '';
    if (ONBOARDING.every(function (def) { return stepDone(onboarding, def.id); })) return ''; // nothing left (the Worker sends no card then)
    if (setupIsOpen(onboarding, choice)) return onboardingFullHtml(gid, onboarding, busy, stepDone(onboarding, 'raid'));
    return onboardingLineHtml(gid, onboarding);
  }

  // ── the page ──
  // opts: { guildData, data (GET /attention), refreshing, error, dismissing, setupOpen }
  function attentionHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || { items: [], more: {}, total: 0 };
    const showTeam = G.shell.activeTeams(gd.teams).length > 1;
    const total = Math.max(0, Math.floor(num(data.total)));
    const actionRows = rowsOf(gid, 'action', data, showTeam);
    const infoRows = rowsOf(gid, 'info', data, showTeam);
    const context = gd.guild.name + ' - ' + (total ? plural(total, 'item needs', 'items need') + ' you' : 'Nothing is waiting for you');
    const head = {
      title: 'Home', context: context,
      primary: { variant: 'secondary', label: 'Refresh', busy: !!opts.refreshing, busyLabel: 'Refreshing...', attrs: { 'data-action': 'attn-refresh', 'data-key': 'attn-refresh' } },
    };
    const below = [];
    if (infoRows.length) below.push({ id: 'attn-info', title: 'For your information', bodyHtml: G.ui.attentionRowsHtml(infoRows) });
    const setup = onboardingHtml(gid, data.onboarding, !!opts.dismissing, opts.setupOpen);
    if (setup) below.push({ html: setup });
    return G.ui.homePageHtml({
      head: head,
      noticesHtml: G.ui.alertHtml(opts.error || '', 'gs-page-alert') + '<p class="gs-sr" id="attn-status" role="status"></p><p class="gs-sr" id="invite-status" role="status"></p>',
      attention: { title: 'Needs attention', items: actionRows, count: total, goodText: 'Nothing needs you right now.' },
      cards: below,
    });
  }

  // ── data ──
  // Officers read GET /attention; everyone else gets the member Home, which has its own reads.
  function isOfficerHome(gd) { return !!gd && G.shell.canSeeAttention(gd.me && gd.me.can); }

  function load(r, gd) {
    if (!isOfficerHome(gd)) return G.pages.homeMember.load(r, gd);
    const gid = gd.guild.id;
    return G.api.attention.get(gid).then(function (data) {
      a().attention = { gid: gid, data: data, refreshing: false, error: '' };
      G.app.setAttention(gid, data);
      return null;
    });
  }

  function main(r, gd, ctx) {
    if (!isOfficerHome(gd)) return G.pages.homeMember.main(r, gd, ctx);
    const x = a().attention;
    if (!x || x.gid !== gd.guild.id) return G.pages.signin.loadingHtml();
    return attentionHtml({ guildData: gd, data: x.data, refreshing: x.refreshing, error: x.error, dismissing: x.dismissing, setupOpen: x.setupOpen });
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

  // Hides the checklist for everyone who sets the guild up (the Worker keeps it; the card does not come back).
  G.handlers.click['onboarding-dismiss'] = function () {
    const x = a().attention;
    if (!x || x.dismissing) return null;
    x.dismissing = true;
    x.error = '';
    G.app.render();
    return G.api.guildData.dismissOnboarding(x.gid).then(function () {
      x.dismissing = false;
      if (x.data) x.data.onboarding = null;
      G.app.render();
      G.ui.announce('attn-status', 'The setup checklist is hidden.');
      G.ui.focusByKey('attn-refresh', { preventScroll: true });
      return null;
    }, function (err) {
      x.dismissing = false;
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return null; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return null; }
      x.error = c.text;
      G.app.render();
      G.ui.focusByKey('onboarding-dismiss', { preventScroll: true });
      return null;
    });
  };

  // "All steps" opens the whole checklist, "Hide steps" folds it back to the line; the choice is kept for as long as the page's data is.
  G.handlers.click['setup-toggle'] = function () {
    const x = a().attention;
    if (!x || !x.data || !x.data.onboarding) return null;
    x.setupOpen = !setupIsOpen(x.data.onboarding, x.setupOpen);
    G.app.render();
    G.ui.focusByKey('setup-toggle', { preventScroll: true });
    return null;
  };

  // Copies the invite message (Home step 5 and Settings > Accounts). The planner's copyText does the copying and toasts; the live region says the result for
  // a screen reader. Without copyText (a page that does not load the planner's scripts) nothing is copied and the status says so.
  G.handlers.click['copy-invite'] = function () {
    const gid = st().currentGid;
    const gd = gid ? st().guilds[gid] : null;
    if (!gd) return null;
    const say = function (text) { G.ui.announce('invite-status', text); };
    if (typeof copyText !== 'function') { say('Copying is not available on this page.'); return null; }
    return Promise.resolve(copyText(inviteMessage(gd.guild.name, siteAddress()), 'Invite message copied')).then(function (copied) {
      say(copied === false ? 'Your browser would not copy it. The message is in a dialog, selected: press Ctrl+C.' : 'Invite message copied.');
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
    ONBOARDING: ONBOARDING,
    onboardingHtml: onboardingHtml,
    inviteMessage: inviteMessage,
    inviteButtonHtml: inviteButtonHtml,
    attentionHtml: attentionHtml,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
