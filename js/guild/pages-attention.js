// ── PAGE: HOME (T4: what needs attention) ───────────────────────
// The guild's landing page, in two variants. The officer variant (anyone who can act on one of the items; GET /attention) is the Week on a screen wider than
// 600 px and the Briefing on a phone (home redesign, round 4: both are in the markup, guild.css shows one); the setup checklist stays below them: the whole
// list until the guild has a raid, one line ("Setup 4 of 6 steps done. Next: ...") after, with "All steps" to open it again. The member variant (everyone else)
// is pages-home-member.js; this file picks between them in load() and main().
// GET /attention -> { today, total, items, more, hidden, counts, week, onboarding }:
//   items   the open, unhidden to-dos ({ id, kind, teamId, teamName, link, raidId?, ...kind fields }); items with `readiness: true` are facts about a raid,
//           not to-dos (they feed the raid's sentence through `week`), `more` counts what the per-kind cap left out
//   week    { offset, start, end, resetDay, autoAdvanced, raids }: the guild's reset week (7 days from `start`); each raid has its readiness facts, a status
//           (done | todo | short | ready | open) and the Roles grid's `people` + `openSeats`: the strip, the selected day, the sentence and the Coming up rows are
//           built from it and from nothing else. The arrows read GET /attention/week?offset=N ({ week }); that answer replaces `week` on the page until it is left.
//   hidden  what a shared Hide / Snooze hides now, with who did it (Restore); counts { teamId: { watchOpen, rankOpen } } feed the Guild box and More links
// The count in the sidebar's Home badge is `total`; app.js keeps the last answer per guild. Hide / Snooze (More menu) and Restore go through
// POST / DELETE /attention/dismissals: the client names the item, the Worker decides what hiding it means.
(function (G) {
  'use strict';

  // Display order, with the heading of each group (the "and N more" line names it) and the label of the button on each row. 'unlocked' is the one info kind.
  // The attendance watch list and the rank suggestions are not Home to-dos (they live on the Attendance and Ranks pages; Home only counts them).
  const KINDS = [
    { id: 'review', severity: 'action', heading: 'Raids to review', action: 'Review' },
    { id: 'loot_unmatched', severity: 'action', heading: 'Loot winners nobody matches', action: 'Link winners' },
    { id: 'signup_unmatched', severity: 'action', heading: 'Sign-ups not linked to a person', action: 'Link sign-ups' },
    { id: 'claims', severity: 'action', heading: 'Character claims', action: 'Review claims' },
    { id: 'applications', severity: 'action', heading: 'New applications', action: 'Review' },
    { id: 'trial', severity: 'action', heading: 'Trials', action: 'Open roster' },
    { id: 'no_loot', severity: 'action', heading: 'Raids without loot', action: 'Add loot' },
    { id: 'low_signups', severity: 'action', heading: 'Raids short on sign-ups', action: 'Open raid' },
    { id: 'log_missing', severity: 'action', heading: 'Raids waiting for a log', action: 'Open raid' },
    { id: 'roster_declined', severity: 'action', heading: 'Line-up players who can\'t come', action: 'Open raid' },
    { id: 'roster_pending', severity: 'action', heading: 'Line-up players who haven\'t confirmed', action: 'Open raid' },
    { id: 'event_moved', severity: 'action', heading: 'Raid-Helper events on another day', action: 'Re-link event' },
    { id: 'webhook_off', severity: 'action', heading: 'Discord webhooks switched off', action: 'Open notifications' },
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
    { id: 'attendance', title: 'Set the attendance rules', hint: 'What counts as attended, late or absent, and when someone is on the watch list.', route: { name: 'settings', tab: 'attendance' } },
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

  // A link whose page works on the SELECTED team (the review queue) first selects the item's team: see the attn-open handler.
  function needsTeam(item) { return !!(item && item.link && item.link.name === 'review' && item.teamId); }


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

  // ── Home, round 4: the Week (desktop) and the Briefing (phone) ──
  // Both are drawn from the same GET /attention answer and both are in the markup: guild.css shows the Week above 600 px and the Briefing at 600 px and
  // below. Only the one primary button of the visible variant counts: "Open raid" (or "Add raid" with no raid this week).

  // Which to-dos can be hidden, and what the More menu says. The Worker decides the mode and the snooze length (DISMISS_RULES in worker/attention.js);
  // the numbers of days below only word the menu, they are never sent.
  const HIDE_MENU = {
    loot_unmatched: { note: 'Ignore these names' },
    signup_unmatched: { note: 'Leave them unlinked' },
    event_moved: { note: 'The date is right' },
    no_loot: { note: 'No loot for this raid' },
    log_missing: { note: 'No log for this raid' },
    trial: { snoozeDays: 3 },
    webhook_off: { snoozeDays: 7 },
  };

  // Raid zones: the short name on a tile and its tint class (guild.css, .gs-hd-tile.is-<tint>), and `art`: the key of the loading-screen crop in
  // icons/raids/<art>-sm.webp (192x108) and -md.webp (480x270). Any other zone gets the first letters, a neutral tile and no art.
  const ZONE_TILES = {
    'karazhan': { abbr: 'KARA', tint: 'kara', art: 'kara' },
    'gruul\'s lair': { abbr: 'GRUUL', tint: 'gruul', art: 'gruul' },
    'magtheridon\'s lair': { abbr: 'MAG', tint: 'mag', art: 'mag' },
    'serpentshrine cavern': { abbr: 'SSC', tint: 'ssc', art: 'ssc' },
    'tempest keep': { abbr: 'TK', tint: 'tk', art: 'tk' },
    'hyjal summit': { abbr: 'HYJAL', tint: 'hyjal', art: 'hyjal' },
    'black temple': { abbr: 'BT', tint: 'bt', art: 'bt' },
    'zul\'aman': { abbr: 'ZA', tint: 'za', art: 'za' },
    'sunwell plateau': { abbr: 'SWP', tint: 'swp', art: 'swp' },
  };
  const ART_SIZES = { sm: { w: 192, h: 108 }, md: { w: 480, h: 270 } };
  // The Roles grid: columns in order; people whose role is null go to a fifth "Other" column that exists only when it has someone.
  const ROLE_COLS = [['tank', 'Tanks'], ['healer', 'Healers'], ['melee', 'Melee'], ['ranged', 'Ranged']];
  const STATE_TEXT = { confirmed: 'Confirmed', no_answer: 'No answer', cant_come: 'Can\'t come', signed: 'Signed up', late: 'Late', tentative: 'Tentative', standby: 'Standby', listed: 'In the raid' };
  const MUTED_STATES = ['no_answer', 'cant_come', 'standby'];
  const MAX_OFFSET = 8;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY_MS = 86400000;
  const UPCOMING = ['short', 'ready', 'open'];
  const PHONE_TODOS = 3;
  const COMING_UP = 2;
  const TOAST_MS = 8000;
  const STATUS_LABELS = { done: 'Done', todo: 'To do', short: 'Short', ready: 'Ready', open: 'Open' };

  function splitZones(zone) {
    return String(zone == null ? '' : zone).split(/\s*(?:\+|&|\/|;)\s*|,\s+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function tileOf(name) {
    const known = ZONE_TILES[String(name).toLowerCase()];
    if (known) return known;
    const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
    const abbr = words.length > 1 ? words.slice(0, 4).map(function (w) { return w.charAt(0); }).join('') : (words[0] || '').slice(0, 3);
    return { abbr: abbr.toUpperCase() || '?', tint: 'other' };
  }

  function tileHtml(name, big) {
    const t = tileOf(name);
    return '<span class="gs-hd-tile is-' + t.tint + (big ? ' is-big' : '') + '" aria-hidden="true">' + esc(t.abbr) + '</span>';
  }

  // The tiles of a raid: every zone (the panel and the Briefing) or the first one plus "+N" (the strip and the Coming up rows).
  function tilesHtml(zone, mode) {
    const names = splitZones(zone);
    if (!names.length) return '';
    if (mode === 'short' && names.length > 1) return '<span class="gs-hd-tiles">' + tileHtml(names[0], false) + '<span class="gs-hd-tile is-more" aria-hidden="true">+' + (names.length - 1) + '</span></span>';
    return '<span class="gs-hd-tiles">' + names.map(function (n) { return tileHtml(n, mode === 'big'); }).join('') + '</span>';
  }

  // The art of a raid: up to two halves side by side (a raid in two zones), centred crops. '' when no zone of the raid has art (the caller then uses the
  // tiles). A zone without art among zones with art gets a plain filler half. opts: { size: 'sm' | 'md', lazy, label (the initials on the art) }.
  function artZones(zone) { return splitZones(zone).slice(0, 2).map(function (name) { return { name: name, tile: tileOf(name) }; }); }
  function hasArt(zone) { return artZones(zone).some(function (z) { return !!z.tile.art; }); }
  function artImagesHtml(zone, size, lazy) {
    const dim = ART_SIZES[size];
    return artZones(zone).map(function (z) {
      return z.tile.art
        ? '<img class="gs-hd-artimg" src="/icons/raids/' + z.tile.art + '-' + size + '.webp" alt="' + esc(z.name) + '" width="' + dim.w + '" height="' + dim.h + '"' + (lazy ? ' loading="lazy"' : '') + '>'
        : '<span class="gs-hd-artimg is-fill" aria-hidden="true"></span>';
    }).join('');
  }
  function artLabelHtml(zone) {
    return '<span class="gs-hd-artlabel" aria-hidden="true">' + esc(artZones(zone).map(function (z) { return z.tile.abbr; }).join(' + ')) + '</span>';
  }

  // ── dates (a guild day is a plain YYYY-MM-DD) ──
  function dateParts(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date == null ? '' : date));
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(t);
    return { t: t, weekday: WEEKDAYS[d.getUTCDay()], month: MONTHS[d.getUTCMonth()], day: d.getUTCDate() };
  }
  function shiftDay(date, n) { const p = dateParts(date); return p ? new Date(p.t + n * DAY_MS).toISOString().slice(0, 10) : ''; }
  function dayText(date) { const p = dateParts(date); return p ? p.weekday + ' ' + p.month + ' ' + p.day : String(date == null ? '' : date); }
  function capsText(date) { const p = dateParts(date); return p ? p.weekday + ' - ' + p.month + ' ' + p.day : String(date == null ? '' : date); }

  // "Oct 16" of a moment, in the guild's zone.
  function monthDay(ms, tz) {
    const text = G.ui.dayInZone(ms, tz);
    return text ? text.replace(/^\S+\s+/, '') : '';
  }

  // ── the model: everything the two variants show, worked out once ──
  function zoneOfGuild(gd) { return (gd && gd.guild && typeof gd.guild.timeZone === 'string' && gd.guild.timeZone) || G.ui.guildZone(); }

  function sumCounts(counts, field) {
    const c = counts && typeof counts === 'object' ? counts : {};
    return Object.keys(c).reduce(function (n, k) { return n + Math.max(0, Math.floor(num(c[k] && c[k][field]))); }, 0);
  }

  // The week's raids, by start. opts.sel: a raid id, 'day:YYYY-MM-DD' or nothing (the next upcoming raid).
  function modelOf(opts) {
    const gd = opts.guildData;
    const data = opts.data || {};
    const tz = zoneOfGuild(gd);
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const today = typeof data.today === 'string' && dateParts(data.today) ? data.today : (G.ui.dayKeyInZone(now, tz) || '');
    const shown = opts.week && typeof opts.week === 'object' ? opts.week : (data.week && typeof data.week === 'object' ? data.week : {}); // an arrow's answer wins
    const weekRaids = Array.isArray(shown.raids) ? shown.raids : [];
    const offset = Math.floor(num(shown.offset));
    const start = dateParts(shown.start) ? shown.start : (today ? shiftDay(today, -1) : '');
    const raids = weekRaids.filter(function (w) { return w && w.raidId; })
      .sort(function (p, q) { return (num(p.startsAt) - num(q.startsAt)) || (String(p.raidId) < String(q.raidId) ? -1 : 1); });
    const items = (Array.isArray(data.items) ? data.items : []).filter(function (it) { return it && !it.readiness && !!kindOf(it.kind); });
    const weekIds = {};
    raids.forEach(function (w) { weekIds[w.raidId] = true; });
    const todosOf = function (raidId) { return items.filter(function (it) { return it.raidId === raidId; }); };
    const upcoming = raids.filter(function (w) { return UPCOMING.indexOf(w.status) >= 0; });
    const next = upcoming[0] || null;
    const past = raids.filter(function (w) { return UPCOMING.indexOf(w.status) < 0; });
    const sel = typeof opts.sel === 'string' ? opts.sel : '';
    const selDay = sel.indexOf('day:') === 0 ? sel.slice(4) : '';
    let selected = null;
    if (!selDay) selected = raids.filter(function (w) { return w.raidId === sel; })[0] || next || raids[raids.length - 1] || null;
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = start ? shiftDay(start, i) : '';
      days.push({ date: date, isToday: !!date && date === today, raids: raids.filter(function (w) { return w.date === date; }) });
    }
    const hidden = (Array.isArray(data.hidden) ? data.hidden : []).filter(function (h) { return h && h.item; });
    const counts = data.counts && typeof data.counts === 'object' ? data.counts : {};
    const nextTodos = next ? todosOf(next.raidId) : [];
    const phoneList = nextTodos.concat(items.filter(function (it) { return nextTodos.indexOf(it) < 0; }));
    return {
      gd: gd, gid: gd.guild.id, data: data, tz: tz, now: now, today: today, raids: raids, days: days, next: next, selected: selected,
      offset: offset, autoAdvanced: !!shown.autoAdvanced, resetDay: typeof shown.resetDay === 'number' && WEEKDAYS[shown.resetDay] ? shown.resetDay : null,
      busy: !!opts.weekBusy, pick: typeof opts.pick === 'string' ? opts.pick : '',
      selDay: selDay || (selected ? selected.date : ''), items: items, todosOf: todosOf, hidden: hidden,
      guildTodos: items.filter(function (it) { return !it.raidId; }),
      earlier: items.filter(function (it) { return it.raidId && !weekIds[it.raidId]; }),
      phoneList: phoneList,
      coming: upcoming.filter(function (w) { return w !== next; }).slice(0, COMING_UP),
      lastRaid: past[past.length - 1] || null,
      rankCount: sumCounts(counts, 'rankOpen'),
      watchCount: sumCounts(counts, 'watchOpen'),
      hasCounts: Object.keys(counts).length > 0,
      total: Math.max(0, Math.floor(num(data.total))),
      more: data.more && typeof data.more === 'object' ? data.more : {},
      showTeam: G.shell.activeTeams(gd.teams).length > 1,
      opts: opts,
    };
  }

  // ── pieces ──
  function statusLabel(w, nTodos) { return w.status === 'todo' && nTodos > 0 ? 'To do ' + nTodos : (STATUS_LABELS[w.status] || 'Open'); }
  function statusChipHtml(w, nTodos) {
    const tone = STATUS_LABELS[w.status] ? w.status : 'open';
    return '<span class="gs-hd-chip is-' + tone + '">' + esc(statusLabel(w, nTodos)) + '</span>';
  }
  function countHtml(w, cls) {
    const size = num(w.size);
    return '<span class="' + cls + '">' + esc(num(w.signed)) + (size > 0 ? '<span class="gs-hd-den"> / ' + esc(size) + '</span>' : '') + '</span>';
  }
  function raidTitle(w) { return String(w.zone || w.title || ''); }
  function raidLine(w) { return [w.teamName, raidTitle(w)].filter(Boolean).join(' - '); }
  function raidHref(m, w) { return G.router.format({ name: 'raid', gid: m.gid, rid: w.raidId }); }
  function headingOf(m, w) { return G.ui.dateTimeInZone(w.startsAt, m.tz, { year: 'auto', now: m.now }) || dayText(w.date); }

  // "This week" / "Last week" / "Next week" (further away: "3 weeks ago" / "In 3 weeks").
  function weekTitle(offset) {
    if (offset === 0) return 'This week';
    if (offset === -1) return 'Last week';
    if (offset === 1) return 'Next week';
    return offset < 0 ? (-offset) + ' weeks ago' : 'In ' + offset + ' weeks';
  }

  // ── the Roles grid (desktop panel and phone card) ──
  const MARK_SVG = {
    x: '<svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1 1l6 6M7 1L1 7"></path></svg>',
    clock: '<svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="5" cy="5" r="4"></circle><path d="M5 2.8V5l1.6 1"></path></svg>',
  };
  function markOf(p) {
    if (p.state === 'cant_come') return 'x';
    if (p.state === 'late' || typeof p.lateAt === 'number') return 'clock';
    if (p.state === 'no_answer' || p.state === 'tentative') return 'q';
    if (p.state === 'standby') return 's';
    return '';
  }
  function markHtml(kind) {
    if (!kind) return '';
    const inner = kind === 'q' ? '?' : kind === 's' ? 'S' : MARK_SVG[kind];
    return '<span class="gs-hd-mk is-' + kind + '" aria-hidden="true">' + inner + '</span>';
  }
  // "Confirmed", "Late 9:00 PM ET", "Confirmed, Late 9:00 PM ET": the state as words (the guild's zone for the time).
  function stateTextOf(m, p) {
    const base = STATE_TEXT[p.state] || '';
    const late = typeof p.lateAt === 'number' ? 'Late' + (G.ui.timeInZone(p.lateAt, m.tz) ? ' ' + G.ui.timeInZone(p.lateAt, m.tz) : '') : '';
    if (p.state === 'late') return late || base;
    return [base, late].filter(Boolean).join(', ');
  }
  function personWho(p) { return [p.name, G.ui.className(p.classId), p.spec].filter(Boolean); }

  function rolesHtml(m, w, prefix) {
    const people = Array.isArray(w.people) ? w.people : []; // indexes are the pick keys: no filtering, bad entries are skipped below
    const valid = function (p) { return !!(p && p.name); };
    const known = ROLE_COLS.map(function (c) { return c[0]; });
    const cols = ROLE_COLS.map(function (c) { return { id: c[0], title: c[1] }; });
    if (people.some(function (p) { return valid(p) && known.indexOf(p.role) < 0; })) cols.push({ id: 'other', title: 'Other' });
    const key = function (i) { return w.raidId + ':' + i; };
    const colsHtml = cols.map(function (c) {
      const mine = people.map(function (p, i) { return { p: p, i: i }; }).filter(function (e) { return valid(e.p) && (c.id === 'other' ? known.indexOf(e.p.role) < 0 : e.p.role === c.id); });
      const names = mine.map(function (e) {
        const p = e.p;
        const state = stateTextOf(m, p);
        const mark = markOf(p);
        const cls = 'gs-hd-gn' + (MUTED_STATES.indexOf(p.state) >= 0 ? ' is-muted' : '') + (p.state === 'cant_come' ? ' is-out' : '');
        return '<button type="button" class="' + cls + '" data-action="home-pick" data-pick="' + esc(key(e.i)) + '" data-key="home-pick-' + prefix + '-' + safeId(w.raidId) + '-' + e.i + '" aria-pressed="' + (m.pick === key(e.i) ? 'true' : 'false') +
          '" aria-label="' + esc(personWho(p).concat(state ? [state] : []).join(', ')) + '">' + G.ui.classNameHtml(p.name, p.classId) + markHtml(mark) + '</button>';
      }).join('');
      return '<div class="gs-hd-rolecol"><h3 class="gs-fg-gh gs-hd-gh"><span class="gs-fg-ght">' + esc(c.title) + '</span><span class="gs-fg-ghn">' + mine.length + '</span></h3>' + (mine.length ? names : '<span class="gs-hd-muted">None</span>') + '</div>';
    }).join('');
    const open = Math.max(0, Math.floor(num(w.openSeats)));
    const picked = people.filter(function (p, i) { return valid(p) && m.pick === key(i); })[0];
    const caption = picked ? personWho(picked).join(', ') + (stateTextOf(m, picked) ? ' - ' + stateTextOf(m, picked) : '') : 'Select a name for spec and state.';
    return '<div class="gs-hd-roles"><div class="gs-hd-rolegrid' + (cols.length > 4 ? ' has-other' : '') + '" role="group" aria-label="Sign-ups by role">' + colsHtml + '</div>' +
      (open > 0 ? '<span class="gs-hd-openline">' + plural(open, 'open seat', 'open seats') + '</span>' : '') +
      '<span class="gs-hd-cap" aria-live="polite">' + esc(caption) + '</span></div>';
  }

  // The sentence under the heading, built only from facts the payload carries: signed of size, whether the line-up is published, how it stands (confirmed,
  // Can't come, no answer) and when sign-ups close. A raid that is over says how many to-dos are left on it.
  function sentenceOf(m, w) {
    const todos = m.todosOf(w.raidId).length;
    if (UPCOMING.indexOf(w.status) < 0) {
      const what = w.zone ? 'The ' + String(w.zone) + ' raid' : 'The raid';
      return what + ' is over. ' + (todos > 0 ? todos + (todos === 1 ? ' thing is' : ' things are') + ' left to review.' : 'Nothing is left to do.');
    }
    const size = num(w.size);
    const parts = [size > 0 ? num(w.signed) + ' of ' + size + ' signed.' : num(w.signed) + ' signed.'];
    if (w.lineupPublished) {
      parts.push('Line-up published.');
      parts.push(num(w.confirmed) + ' confirmed, ' + num(w.cantCome) + ' Can\'t come, ' + num(w.noAnswer) + ' no answer.');
    } else {
      parts.push('Line-up not published.');
    }
    if (w.signupsLocked) {
      parts.push('Sign-ups are locked.');
    } else if (typeof w.signupsCloseAt === 'number') {
      if (w.signupsCloseAt <= m.now) {
        parts.push('Sign-ups are closed.');
      } else {
        const time = G.ui.timeInZone(w.signupsCloseAt, m.tz);
        const sameDay = G.ui.dayKeyInZone(w.signupsCloseAt, m.tz) === m.today;
        parts.push('Sign-ups close ' + (sameDay ? '' : String(G.ui.dayInZone(w.signupsCloseAt, m.tz)).split(' ')[0] + ' ') + time + '.');
      }
    }
    return parts.join(' ');
  }

  function safeId(s) { return String(s).replace(/[^A-Za-z0-9_-]+/g, '-'); }

  // The More menu of a to-do: "Hide for all officers" (with what hiding it means) or "Snooze N days". '' for the kinds that clear when handled.
  function moreMenuHtml(item, title, prefix) {
    const rule = HIDE_MENU[item.kind];
    if (!rule || !item.id) return '';
    const entry = rule.snoozeDays
      ? { label: 'Snooze ' + rule.snoozeDays + ' days', data: { action: 'home-hide', item: item.id } }
      : { label: 'Hide for all officers', note: rule.note, data: { action: 'home-hide', item: item.id } };
    return G.ui.menuHtml({ id: prefix + '-more-' + safeId(item.id), label: 'More', ariaLabel: 'More for ' + title, triggerClass: 'gs-btn gs-btn-ghost gs-btn-sm', align: 'left', items: [entry] });
  }

  // One to-do: the sentence, its action button and (where it can be hidden) More.
  function todoHtml(m, item, prefix) {
    const kind = kindOf(item.kind) || { action: 'Open' };
    const title = itemText(item);
    const meta = m.showTeam && item.teamName ? '<span class="gs-hd-todo-meta">' + esc(item.teamName) + '</span>' : '';
    const action = G.ui.buttonHtml({
      label: kind.action, variant: 'secondary', size: 'sm', href: itemHref(m.gid, item), ariaLabel: kind.action + ' (' + title + ')',
      attrs: needsTeam(item) ? { 'data-action': 'attn-open', 'data-team': item.teamId } : null,
    });
    return '<li class="gs-hd-todo"><span class="gs-hd-todo-title">' + esc(title) + '</span>' + meta + '<div class="gs-hd-todo-acts">' + action + moreMenuHtml(item, title, prefix) + '</div></li>';
  }

  function todoListHtml(m, items, prefix, label) {
    return items.length ? '<ul class="gs-hd-todos" aria-label="' + esc(label) + '">' + items.map(function (it) { return todoHtml(m, it, prefix); }).join('') + '</ul>' : '';
  }

  // "and 3 more: raids without loot" for the to-dos a kind's cap left out of the list.
  function moreLinesHtml(m) {
    return KINDS.filter(function (k) { return k.severity === 'action' && num(m.more[k.id]) > 0 && k.id !== 'low_signups' && k.id !== 'roster_declined' && k.id !== 'roster_pending'; }).map(function (k) {
      const text = 'and ' + Math.floor(num(m.more[k.id])) + ' more: ' + lowerFirst(k.heading);
      return '<li class="gs-hd-todo"><span class="gs-hd-todo-title">' + esc(text) + '</span><div class="gs-hd-todo-acts">' +
        G.ui.buttonHtml({ label: 'See all', variant: 'secondary', size: 'sm', href: G.router.format(Object.assign({ gid: m.gid }, MORE_LINKS[k.id])), ariaLabel: 'See all (' + text + ')' }) + '</div></li>';
    }).join('');
  }

  function errorPanelHtml(opts) {
    if (!opts.error) return '';
    return '<div class="gs-hd-error" role="alert"><p class="gs-hd-error-title">' + esc(opts.errorTitle || 'Could not update Home') + '</p><p class="gs-hd-error-text">' + esc(opts.error) +
      ' What loaded is still shown.</p>' + G.ui.buttonHtml({ label: 'Try again', variant: 'secondary', size: 'sm', busy: !!opts.refreshing, busyLabel: 'Trying again...', attrs: { 'data-action': 'attn-refresh', 'data-key': 'attn-refresh' } }) + '</div>';
  }

  // Hidden (N) and, when open, what is hidden with Restore. A hidden row says who hid it and when, or how long it is snoozed.
  function hiddenHtml(m, prefix) {
    const open = !!m.opts.hiddenOpen;
    const toggle = '<button type="button" class="gs-hd-sl gs-hd-slb" data-action="home-hidden-toggle" data-key="home-hidden-' + prefix + '" aria-expanded="' + (open ? 'true' : 'false') + '">Hidden (' + m.hidden.length + ')</button>';
    if (!open) return toggle;
    const rows = m.hidden.map(function (h) {
      const title = itemText(h.item);
      const how = h.mode === 'snooze' && typeof h.until === 'number'
        ? 'Snoozed until ' + (monthDay(h.until, m.tz) || '')
        : 'Hidden by ' + String(h.by && h.by.name ? h.by.name : 'an officer') + (typeof h.at === 'number' ? ', ' + monthDay(h.at, m.tz) : '');
      return '<li class="gs-hd-hidden"><span class="gs-hd-hidden-text"><span class="gs-hd-hidden-title">' + esc(title) + '</span><span class="gs-hd-muted">' + esc(how) + '</span></span>' +
        G.ui.buttonHtml({ label: 'Restore', variant: 'secondary', size: 'sm', ariaLabel: 'Restore ' + title, busy: m.opts.busyItem === h.item.id, busyLabel: 'Restoring...', attrs: { 'data-action': 'home-restore', 'data-item': h.item.id, 'data-key': 'home-restore-' + prefix + '-' + safeId(h.item.id) } }) + '</li>';
    }).join('');
    return toggle + '<div class="gs-hd-hiddenbox">' + (rows ? '<ul class="gs-hd-hiddenlist">' + rows + '</ul>' : '<p class="gs-hd-muted gs-hd-center">Nothing is hidden.</p>') + '</div>';
  }

  // The links to the pages that hold the rest: a number or a summary only where the payload already has it.
  function moreNavHtml(m) {
    const links = [];
    const last = m.lastRaid;
    links.push({
      label: last ? 'Last raid: ' + (dateParts(last.date) ? dateParts(last.date).weekday : '') + (raidTitle(last) ? ', ' + raidTitle(last) : '') : 'Last raid',
      href: last ? raidHref(m, last) : G.router.format({ name: 'section', gid: m.gid, section: 'raids' }),
    });
    links.push({
      label: m.hasCounts ? 'Attendance: ' + (m.watchCount ? m.watchCount + ' on the watch list' : 'nobody on the watch list') : 'Attendance',
      href: G.router.format({ name: 'section', gid: m.gid, section: 'attendance' }),
    });
    links.push({ label: 'Recruiting needs', href: G.router.format({ name: 'recruiting', gid: m.gid }) });
    links.push({ label: 'Progress', href: G.router.format({ name: 'section', gid: m.gid, section: 'raids' }) });
    if (m.opts.phone && m.rankCount > 0) links.push({ label: plural(m.rankCount, 'rank suggestion', 'rank suggestions'), href: G.router.format({ name: 'section', gid: m.gid, section: 'attendance' }) });
    return '<nav class="gs-hd-more" aria-label="More"><h2 class="gs-hd-sl">More</h2><ul class="gs-hd-links">' +
      links.map(function (l) { return '<li><a class="gs-hd-link" href="' + esc(l.href) + '">' + esc(l.label) + '</a></li>'; }).join('') + '</ul></nav>';
  }

  // The primary button: Open raid for a raid, Add raid when the week has none.
  function openRaidHtml(m, w) {
    return G.ui.buttonHtml({ label: 'Open raid', variant: 'primary', href: raidHref(m, w), ariaLabel: 'Open raid (' + headingOf(m, w) + ')' });
  }
  function addRaidHtml(m) {
    return G.ui.buttonHtml({ label: 'Add raid', variant: 'primary', href: G.router.format({ name: 'raidnew', gid: m.gid }) });
  }

  // ── desktop: the Week ──
  function dayCardHtml(m, day) {
    const selected = day.raids.some(function (w) { return m.selected && w.raidId === m.selected.raidId; }) || (!m.selected && m.selDay === day.date);
    const caps = '<span class="gs-hd-daydate">' + esc(capsText(day.date)) + '</span><span class="gs-hd-today">' + (day.isToday ? 'Today' : '') + '</span>';
    let body;
    if (!day.raids.length) {
      body = '<button type="button" class="gs-hd-pick" data-action="home-select" data-day="' + esc(day.date) + '" data-key="home-day-' + esc(day.date) + '" aria-pressed="' + (selected ? 'true' : 'false') + '" aria-label="' +
        esc(dayText(day.date) + ', no raid') + '"><span class="gs-hd-pickbody">' + caps + '<span class="gs-hd-muted">No raid</span></span></button>';
    } else {
      body = day.raids.map(function (w, i) {
        const n = m.todosOf(w.raidId).length;
        const on = !!m.selected && m.selected.raidId === w.raidId;
        const label = [headingOf(m, w), w.teamName, raidTitle(w), statusLabel(w, n)].filter(Boolean).join(', ');
        const art = hasArt(w.zone);
        return '<button type="button" class="gs-hd-pick' + (i > 0 ? ' is-stacked' : '') + '" data-action="home-select" data-raid="' + esc(w.raidId) + '" data-key="home-raid-' + esc(w.raidId) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '">' +
          (art ? '<span class="gs-hd-art is-strip">' + artImagesHtml(w.zone, 'sm', true) + artLabelHtml(w.zone) + '</span>' : '') +
          '<span class="gs-hd-pickbody">' + (i === 0 ? caps : '') + '<span class="gs-hd-daybody">' + (art ? '' : tilesHtml(w.zone, 'short')) + '<span class="gs-hd-team">' + esc(w.teamName || '') + '</span>' + countHtml(w, 'gs-hd-cnt') + statusChipHtml(w, n) + '</span></span></button>';
      }).join('');
    }
    return '<div class="gs-hd-day' + (selected ? ' is-selected' : '') + (day.raids.length ? '' : ' is-empty') + '">' + body + '</div>';
  }

  function selectedPanelHtml(m) {
    const w = m.selected;
    if (!w) {
      const empty = !m.raids.length;
      return '<section class="gs-hd-panel gs-hd-main" aria-label="Selected day"><div class="gs-hd-selbody"><h2 class="gs-hd-h2">' + esc(empty ? (m.offset === 0 ? 'No raid this week' : 'No raid that week') : dayText(m.selDay)) + '</h2>' +
        '<p class="gs-hd-sentence">' + esc(empty ? 'No raid is scheduled from ' + dayText(m.days[0].date) + ' to ' + dayText(m.days[m.days.length - 1].date) + '.' : 'No raid on this day.') + '</p>' +
        (empty ? '<div class="gs-hd-cta">' + addRaidHtml(m) + '</div>' : '') + '</div></section>';
    }
    const n = m.todosOf(w.raidId);
    const title = '<div class="gs-hd-sel-title"><h2 class="gs-hd-h2">' + esc(headingOf(m, w)) + '</h2><span class="gs-hd-sub">' + esc(raidLine(w)) + '</span></div>' +
      '<div class="gs-hd-bigcnt">' + countHtml(w, 'gs-hd-bignum') + '<span class="gs-hd-caps">Signed</span></div>';
    const chip = statusChipHtml(w, n.length);
    // With art the header is the picture, a scrim and the text on it (the chip on an opaque backing); without, the tile row of round 4.
    const head = hasArt(w.zone)
      ? '<div class="gs-hd-art is-panel">' + artImagesHtml(w.zone, 'md', false) + '<div class="gs-hd-scrim"></div><div class="gs-hd-arttext">' + title + '<span class="gs-hd-chipbox">' + chip + '</span></div></div><div class="gs-hd-selbody">'
      : '<div class="gs-hd-selbody"><div class="gs-hd-sel-head">' + tilesHtml(w.zone, 'big') + title + chip + '</div>';
    return '<section class="gs-hd-panel gs-hd-main" aria-label="Selected day">' + head +
      '<p class="gs-hd-sentence">' + esc(sentenceOf(m, w)) + '</p>' + rolesHtml(m, w, 'd') + '<div class="gs-hd-cta">' + openRaidHtml(m, w) + '</div>' +
      '<div class="gs-hd-todosec"><h2 class="gs-hd-sl">To do</h2>' + (n.length ? todoListHtml(m, n, 'd', 'To do for this raid') : '<p class="gs-hd-muted gs-hd-center">Nothing to do.</p>') + '</div></div></section>';
  }

  function guildBoxHtml(m, opts) {
    const rank = m.rankCount > 0
      ? '<li class="gs-hd-todo"><span class="gs-hd-todo-title">' + esc(plural(m.rankCount, 'rank suggestion', 'rank suggestions')) + '</span><div class="gs-hd-todo-acts">' +
        G.ui.buttonHtml({ label: 'Open Ranks', variant: 'secondary', size: 'sm', href: G.router.format({ name: 'section', gid: m.gid, section: 'attendance' }), ariaLabel: 'Open Ranks (' + plural(m.rankCount, 'rank suggestion', 'rank suggestions') + ')' }) + '</div></li>'
      : '';
    const guild = todoListHtml(m, m.guildTodos, 'g', 'Guild to-dos');
    const earlier = m.earlier.length ? '<div class="gs-hd-earlier"><h3 class="gs-hd-sl gs-hd-sl-sub">Earlier raids</h3>' + todoListHtml(m, m.earlier, 'e', 'Earlier raids') + '</div>' : '';
    const rest = moreLinesHtml(m);
    const none = !m.guildTodos.length && !rank && !m.earlier.length && !rest;
    return '<section class="gs-hd-panel gs-hd-side" aria-label="Guild"><h2 class="gs-hd-sl">Guild</h2>' + errorPanelHtml(opts) +
      (none ? '<p class="gs-hd-muted gs-hd-center">Nothing to do.</p>' : '') + guild + (rank || rest ? '<ul class="gs-hd-todos">' + rank + rest + '</ul>' : '') + earlier +
      hiddenHtml(m, 'd') + moreNavHtml(m) + '</section>';
  }

  function weekHtml(m, opts) {
    return '<div class="gs-hd-desk"><section class="gs-hd-weeksec" aria-label="' + esc(weekTitle(m.offset)) + '"><div class="gs-hd-strip gs-hd-panel' + (m.busy ? ' is-loading' : '') + '">' +
      m.days.map(function (d) { return dayCardHtml(m, d); }).join('') + '</div></section>' +
      '<div class="gs-hd-cols">' + selectedPanelHtml(m) + guildBoxHtml(m, opts) + '</div></div>';
  }

  // ── phone: the Briefing ──
  // The top of the next-raid card, up to the opening of its body (the caller closes it): art with the label, chip, heading and team line over it, or the round 4 tile row.
  function nextHeadHtml(m, w) {
    const chip = statusChipHtml(w, m.todosOf(w.raidId).length);
    const heading = '<h2 class="gs-hd-h2">' + esc(headingOf(m, w)) + '</h2><span class="gs-hd-sub">' + esc(raidLine(w)) + '</span>';
    if (hasArt(w.zone)) {
      return '<div class="gs-hd-art is-card">' + artImagesHtml(w.zone, 'md', false) + '<div class="gs-hd-scrim"></div><div class="gs-hd-arttext"><div class="gs-hd-nextrow"><span class="gs-hd-caps">Next raid</span>' +
        '<span class="gs-hd-chipbox">' + chip + '</span></div>' + heading + '</div></div><div class="gs-hd-nextbody">';
    }
    return '<div class="gs-hd-nextbody"><div class="gs-hd-nextrow">' + tilesHtml(w.zone, 'big') + chip + '</div><span class="gs-hd-caps">Next raid</span>' + heading;
  }

  function briefingHtml(m, opts) {
    const w = m.next;
    const card = w
      ? '<section class="gs-hd-panel gs-hd-nextcard' + (hasArt(w.zone) ? ' has-art' : '') + '" aria-label="Next raid">' + nextHeadHtml(m, w) +
        '<p class="gs-hd-sentence">' + esc(sentenceOf(m, w)) + '</p>' + rolesHtml(m, w, 'p') + '<div class="gs-hd-cta is-block">' + openRaidHtml(m, w) + '</div></div></section>'
      : '<section class="gs-hd-panel gs-hd-nextcard" aria-label="Next raid"><div class="gs-hd-nextbody"><h2 class="gs-hd-h2">No raid this week</h2><p class="gs-hd-sentence">' +
        esc('No raid is scheduled from ' + dayText(m.days[0].date) + ' to ' + dayText(m.days[m.days.length - 1].date) + '.') + '</p><div class="gs-hd-cta is-block">' + addRaidHtml(m) + '</div></div></section>';
    const all = !!opts.seeAll;
    const shown = all ? m.phoneList : m.phoneList.slice(0, PHONE_TODOS);
    const rest = moreLinesHtml(m);
    const hasMore = m.phoneList.length > PHONE_TODOS;
    const todo = '<section class="gs-hd-todosec" aria-label="To do"><h2 class="gs-hd-sl">To do</h2>' + errorPanelHtml(opts) +
      (m.phoneList.length || (all && rest) ? '<div class="gs-hd-panel gs-hd-listpanel">' + todoListHtml(m, shown, 'p', 'To do') + (all && rest ? '<ul class="gs-hd-todos">' + rest + '</ul>' : '') + '</div>'
        : '<p class="gs-hd-muted gs-hd-center">Nothing to do.</p>') +
      (hasMore ? G.ui.buttonHtml({ label: all ? 'Show fewer' : 'See all ' + Math.max(m.total, m.phoneList.length), variant: 'secondary', block: true, attrs: { 'data-action': 'home-seeall', 'data-key': 'home-seeall' } }) : '') +
      hiddenHtml(m, 'p') + '</section>';
    const coming = '<section class="gs-hd-comingsec" aria-label="Coming up"><h2 class="gs-hd-sl">Coming up</h2>' + (m.coming.length
      ? '<ul class="gs-hd-panel gs-hd-coming">' + m.coming.map(function (c) {
        return '<li class="gs-hd-comingrow">' + (hasArt(c.zone) ? '<span class="gs-hd-art is-thumb">' + artImagesHtml(c.zone, 'sm', true) + '</span>' : tilesHtml(c.zone, 'short')) + '<span class="gs-hd-comingtext"><span class="gs-hd-when">' + esc(headingOf(m, c)) + '</span><span class="gs-hd-muted">' + esc(c.teamName || '') + '</span></span>' +
          '<span class="gs-hd-comingend">' + countHtml(c, 'gs-hd-cnt') + statusChipHtml(c, m.todosOf(c.raidId).length) + '</span></li>';
      }).join('') + '</ul>' : '<p class="gs-hd-muted gs-hd-center">No other raid this week.</p>') + '</section>';
    return '<div class="gs-hd-phone">' + card + todo + coming + moreNavHtml(Object.assign({}, m, { opts: Object.assign({}, m.opts, { phone: true }) })) + '</div>';
  }

  // The undo toast. It lives in a polite live region that is always in the page, so its arrival is announced.
  function toastHtml(toast) {
    const inner = toast ? '<div class="gs-hd-toast"><span class="gs-hd-toast-text"><span class="gs-hd-toast-main">Hidden for everyone</span><span class="gs-hd-muted">' + esc(toast.title) + '</span></span>' +
      G.ui.buttonHtml({ label: 'Undo', variant: 'secondary', size: 'sm', attrs: { 'data-action': 'home-undo', 'data-key': 'home-undo' } }) +
      '<button type="button" class="gs-hd-toast-x" data-action="home-toast-close" data-key="home-toast-close" aria-label="Close message">Close</button></div>' : '';
    return '<div class="gs-hd-toastwrap" role="status" aria-live="polite">' + inner + '</div>';
  }

  // ── states ──
  function skeletonHtml() {
    const sk = function (cls) { return '<span class="gs-hd-sk ' + cls + '"></span>'; };
    const days = [0, 1, 2, 3, 4, 5, 6].map(function () { return '<div class="gs-hd-day is-skel">' + sk('is-sm') + sk('is-tile') + sk('is-line') + sk('is-chip') + '</div>'; }).join('');
    return '<div class="gs-page gs-home-page gs-home gs-forge" aria-busy="true"><p class="gs-sr" role="status">Loading this week</p>' +
      '<div class="gs-hd-desk"><div class="gs-hd-strip gs-hd-panel">' + days + '</div><div class="gs-hd-cols"><div class="gs-hd-panel gs-hd-main">' + sk('is-wide') + sk('is-line') + sk('is-btn') + '</div>' +
      '<div class="gs-hd-panel gs-hd-side">' + sk('is-line') + sk('is-btn') + sk('is-line') + '</div></div></div>' +
      '<div class="gs-hd-phone"><div class="gs-hd-panel gs-hd-nextcard">' + sk('is-tile') + sk('is-wide') + sk('is-line') + sk('is-btn') + '</div><div class="gs-hd-panel gs-hd-listpanel">' + sk('is-line') + sk('is-line') + sk('is-line') + '</div></div></div>';
  }

  // The title of the reset week, its dates, the day it resets, "Back to this week" (any other week, and the week opened by the auto-jump) and the square arrows.
  // An arrow stays in the page while a week loads (aria-disabled, not removed) so the keyboard keeps its place; the buttons are desktop only.
  function headHtml(m) {
    const chevron = function (d) { return '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"></path></svg>'; };
    const arrow = function (dir, label, d) {
      const target = m.offset + dir;
      const off = m.busy || Math.abs(target) > MAX_OFFSET;
      return '<button type="button" class="gs-hd-sq" data-action="home-week" data-offset="' + target + '" data-key="home-week-' + (dir < 0 ? 'prev' : 'next') + '" aria-label="' + label + '" aria-disabled="' + (off ? 'true' : 'false') + '">' + chevron(d) + '</button>';
    };
    const range = m.days[0].date ? dayText(m.days[0].date) + ' - ' + dayText(m.days[m.days.length - 1].date) : '';
    return '<header class="gs-hd-head"><div class="gs-hd-headtxt"><h1 class="gs-h1 gs-hd-h1" id="page-title" tabindex="-1">' + esc(weekTitle(m.offset)) + '</h1>' +
      '<span class="gs-hd-range">' + esc(range) + '</span>' + (m.resetDay === null ? '' : '<span class="gs-hd-muted">Resets ' + WEEKDAYS[m.resetDay] + '</span>') + '</div>' +
      '<div class="gs-hd-weeknav">' + (m.offset !== 0 ? '<button type="button" class="gs-hd-back" data-action="home-week" data-offset="0" data-key="home-week-back" aria-disabled="' + (m.busy ? 'true' : 'false') + '">Back to this week</button>' : '') +
      arrow(-1, 'Previous week', 'M15 5l-7 7 7 7') + arrow(1, 'Next week', 'M9 5l7 7-7 7') + '</div></header>';
  }

  // ── the page ──
  // opts: { guildData, data (GET /attention), week (an arrow's answer), weekBusy, pick, now, refreshing, error, errorTitle, dismissing, setupOpen, sel, hiddenOpen, seeAll, toast, busyItem }
  function attentionHtml(opts) {
    const gd = opts.guildData;
    const m = modelOf(opts);
    const head = headHtml(m);
    const setup = onboardingHtml(gd.guild.id, m.data.onboarding, !!opts.dismissing, opts.setupOpen);
    return '<div class="gs-page gs-home-page gs-home gs-forge">' + head + '<p class="gs-sr" id="attn-status" role="status"></p><p class="gs-sr" id="invite-status" role="status"></p>' +
      weekHtml(m, opts) + briefingHtml(m, opts) + setup + toastHtml(opts.toast) + '</div>';
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
    if (!x || x.gid !== gd.guild.id) return skeletonHtml();
    return attentionHtml({
      guildData: gd, data: x.data, week: x.weekOverride, weekBusy: x.weekBusy, pick: x.pick, refreshing: x.refreshing, error: x.error, errorTitle: x.errorTitle, dismissing: x.dismissing, setupOpen: x.setupOpen,
      sel: x.sel, hiddenOpen: x.hiddenOpen, seeAll: x.seeAll, toast: x.toast, busyItem: x.busyItem,
    });
  }

  // ── handlers ──
  // A failed call: a sign-in or a full-page message goes where it always goes; anything else is the error panel of the page, with what loaded kept.
  function failed(x, err, title, focusKey) {
    const c = G.api.classify(err);
    if (c.view === 'signin') { G.app.requireSignin(); return null; }
    if (c.view === 'message') { G.app.showFailure(c.title, c.text); return null; }
    x.error = c.text;
    x.errorTitle = title || '';
    G.app.render();
    if (focusKey) G.ui.focusByKey(focusKey, { preventScroll: true });
    return null;
  }

  function reread(x) {
    return G.api.attention.get(x.gid).then(function (data) {
      x.data = data;
      G.app.setAttention(x.gid, data);
      return data;
    });
  }

  function itemById(x, id) {
    const items = x && x.data && Array.isArray(x.data.items) ? x.data.items : [];
    return items.filter(function (it) { return it && it.id === id; })[0] || null;
  }

  function armToast(x, toast) {
    x.toast = toast;
    if (typeof setTimeout !== 'function') return;
    const timer = setTimeout(function () {
      if (x.toast !== toast) return;
      x.toast = null;
      if (a().attention === x) G.app.render();
    }, TOAST_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  G.handlers.click['attn-refresh'] = function () {
    const x = a().attention;
    if (!x || x.refreshing) return null;
    x.refreshing = true;
    x.error = '';
    G.app.render();
    return reread(x).then(function (data) {
      x.refreshing = false;
      G.app.render();
      G.ui.focusByKey('attn-refresh', { preventScroll: true }); // the button was disabled while it ran, so the keyboard had left it
      G.ui.announce('attn-status', num(data && data.total) > 0 ? 'Updated. ' + plural(Math.floor(num(data.total)), 'item needs', 'items need') + ' you.' : 'Updated. Nothing needs you right now.');
      return null;
    }, function (err) {
      x.refreshing = false;
      return failed(x, err, 'Could not refresh Home', 'attn-refresh');
    });
  };

  // A day or a raid of the strip becomes the selected one.
  G.handlers.click['home-select'] = function (el) {
    const x = a().attention;
    if (!x) return null;
    const raid = el.getAttribute('data-raid');
    const day = el.getAttribute('data-day');
    x.sel = raid || (day ? 'day:' + day : '');
    G.app.render();
    G.ui.focusByKey(raid ? 'home-raid-' + raid : 'home-day-' + day, { preventScroll: true });
    return null;
  };

  // A name of the Roles grid becomes the picked one; the caption says who it is. The caption is a live region, but the page is drawn again, so the status line says it too.
  // (pick = "<raidId>:<index into the raid's people>")
  G.handlers.click['home-pick'] = function (el) {
    const x = a().attention;
    const pick = el.getAttribute('data-pick');
    if (!x || !pick) return null;
    x.pick = pick;
    G.app.render();
    G.ui.focusByKey(el.getAttribute('data-key'), { preventScroll: true });
    const shown = x.weekOverride || (x.data && x.data.week) || {};
    const cut = pick.lastIndexOf(':');
    const raidOf = (Array.isArray(shown.raids) ? shown.raids : []).filter(function (w) { return w && w.raidId === pick.slice(0, cut); })[0];
    const person = raidOf && Array.isArray(raidOf.people) ? raidOf.people[Number(pick.slice(cut + 1))] : null;
    if (person && person.name) {
      const state = stateTextOf({ tz: zoneOfGuild(st().guilds[x.gid]) }, person);
      G.ui.announce('attn-status', personWho(person).join(', ') + (state ? ' - ' + state : ''));
    }
    return null;
  };

  // The arrows and "Back to this week": read another reset week. The week on the page stays until the answer is in; a failure keeps it (and says so).
  G.handlers.click['home-week'] = function (el) {
    const x = a().attention;
    const target = Number(el.getAttribute('data-offset'));
    if (!x || x.weekBusy || !isFinite(target) || target % 1 !== 0 || Math.abs(target) > MAX_OFFSET) return null;
    const key = el.getAttribute('data-key') || 'home-week-next';
    x.weekBusy = true;
    x.error = '';
    G.app.render();
    G.ui.focusByKey(key, { preventScroll: true });
    G.ui.announce('attn-status', 'Loading the week.');
    return G.api.attention.week(x.gid, target).then(function (res) {
      x.weekBusy = false;
      const week = res && res.week;
      if (!week || !Array.isArray(week.raids)) return failed(x, new Error('Unexpected answer'), 'Could not load that week', key);
      x.weekOverride = week;
      x.sel = '';
      x.pick = '';
      G.app.render();
      if (!G.ui.focusByKey(key, { preventScroll: true })) G.ui.focusByKey('home-week-next', { preventScroll: true });
      G.ui.announce('attn-status', weekTitle(Math.floor(num(week.offset))) + '.');
      return null;
    }, function (err) {
      x.weekBusy = false;
      return failed(x, err, 'Could not load that week', key);
    });
  };

  G.handlers.click['home-hidden-toggle'] = function (el) {
    const x = a().attention;
    if (!x) return null;
    x.hiddenOpen = !x.hiddenOpen;
    G.app.render();
    G.ui.focusByKey(el.getAttribute('data-key'), { preventScroll: true });
    return null;
  };

  G.handlers.click['home-seeall'] = function () {
    const x = a().attention;
    if (!x) return null;
    x.seeAll = !x.seeAll;
    G.app.render();
    G.ui.focusByKey('home-seeall', { preventScroll: true });
    return null;
  };

  // More -> Hide / Snooze: the Worker decides the mode and the length; the page names the item, reads the list again and offers Undo.
  G.handlers.click['home-hide'] = function (el) {
    const x = a().attention;
    const id = el.getAttribute('data-item');
    if (!x || !id || x.busyItem) return null;
    const found = itemById(x, id);
    const title = found ? itemText(found) : 'This to-do';
    x.busyItem = id;
    x.error = '';
    return G.api.attention.dismiss(x.gid, id).then(function () { return reread(x); }).then(function () {
      x.busyItem = null;
      armToast(x, { itemId: id, title: title });
      G.app.render();
      G.ui.focusByKey('home-undo', { preventScroll: true });
      G.ui.announce('attn-status', 'Hidden for everyone. ' + title);
      return null;
    }, function (err) {
      x.busyItem = null;
      return failed(x, err, 'Could not hide that to-do');
    });
  };

  function restore(x, id, fromToast) {
    if (!x || !id || x.busyItem) return null;
    x.busyItem = id;
    x.error = '';
    if (fromToast) G.app.render();
    return G.api.attention.restore(x.gid, id).then(function () { return reread(x); }).then(function () {
      x.busyItem = null;
      if (x.toast && x.toast.itemId === id) x.toast = null;
      G.app.render();
      G.ui.announce('attn-status', 'Restored.');
      return null;
    }, function (err) {
      x.busyItem = null;
      return failed(x, err, 'Could not restore that to-do');
    });
  }

  G.handlers.click['home-restore'] = function (el) { return restore(a().attention, el.getAttribute('data-item'), false); };

  G.handlers.click['home-undo'] = function () {
    const x = a().attention;
    return x && x.toast ? restore(x, x.toast.itemId, true) : null;
  };

  G.handlers.click['home-toast-close'] = function () {
    const x = a().attention;
    if (!x) return null;
    x.toast = null;
    G.app.render();
    return null;
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
    skeletonHtml: skeletonHtml,
    zoneTile: tileOf,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
