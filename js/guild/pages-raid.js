// ── PAGE: RAID DETAIL ───────────────────────────────────────────
// One raid on the T2 object template, Forge look (design-spec 2-4; raids revamp round 3, concept A "one board"): the head (back link, "<Fri Oct 23> - <title, zone or
// size>", ONE chip, one context line, More for raids.edit with page-level items only), the next-step bar with the page's one primary (nextStepOf, the stage model
// stagesOf stays but no strip is drawn), the You bar (pages-raid-you.js: the viewer's sign-up, seat or result), then two columns from 1024 px (main 2fr, side 1fr).
// Before the raid the main column holds the Sign-ups panel, the Line-up card (officers, once published) and the Loot prios list; after it, the Attendance board
// (pages-raid-attendance.js) with the Unmatched characters panel, the sign-ups record behind "Show sign-ups" and the Loot prios list. The Gargul import and the TMB / softres
// paste open at the top of the main column while they are open. The side column is the Raid facts panel (pages-raid-facts.js: event, plan, line-up, log, duties, each with an
// officer's Change menu), after the raid the Bosses and Loot panels, then the Loot prios summary. Raid settings is a form dialog from More.
// The dialogs that change the raid (event, report, plan, manual attendance, delete) are as they were. The menus are ui.menuHtml / ui.menu. GET /raids/:rid; every write answers with the detail.
// The Decide and Unmatched dialogs live in pages-review.js and work here too (where = 'raid').
// A raid that has not started (raid.upcoming) shows its start time ("Time not set" for a date-only raid); the Raid settings dialog sets the raid's own size and, until
// it starts, its sign-up deadline (PATCH /raids/:rid). The Sign-ups panel (pages-raid-signups.js; a past raid's only for officers or when there are sign-ups) and a past
// raid's Loot panel (pages-raid-loot.js) and the Loot prios (pages-raid-board.js) are loaded with the detail.
(function (G) {
  'use strict';

  const REASON_MIN = 3;
  const REASON_MAX = 200;
  const MAX_PRESENT = 80;
  const OK_MANUAL = ['present', 'fill_in'];

  function A() { return G.pages.attendance; }
  function R() { return G.pages.review; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function plural(n, one, many) { return A().plural(n, one, many); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function idOf(x) { return x && typeof x === 'object' ? x.id : x; }
  function raidBase(gid, rid) { return A().apiBase(gid) + '/raids/' + encodeURIComponent(rid); }
  function cur() {
    const x = a().raid;
    const gd = currentGd();
    return x && gd && x.gid === gd.guild.id && x.data ? { gid: gd.guild.id, gd: gd, rid: x.rid, data: x.data, x: x } : null;
  }

  // ── pure view helpers ──
  function bossCounts(data) {
    const pulls = Array.isArray(data.pulls) ? data.pulls : [];
    return { kills: pulls.filter(function (p) { return p.kill; }).length, pulls: pulls.length };
  }

  function isUpcoming(data) { return !!(data.raid && data.raid.upcoming); }

  // The Sign-ups panel (native Raidsmith sign-ups merged with Raid-Helper's); nothing while its data is not loaded.
  function signupsPanelHtml(gd, data, signups) {
    return G.pages.raidSignups ? G.pages.raidSignups.panelHtml({ guildData: gd, data: data, state: signups }) : '';
  }

  function isManual(data) { return !!(data.raid && data.raid.state === 'manual') || !!(data.raid && data.raid.manual); }

  function hasReports(data) { return !!(data.sources && Array.isArray(data.sources.reports) && data.sources.reports.length); }

  // Flagged rows first (they need a decision), then by name.
  function sortedPeople(people) {
    return people.slice().sort(function (x, y) {
      const fx = needsReview(x) ? 0 : 1;
      const fy = needsReview(y) ? 0 : 1;
      return fx - fy || String(x.name).localeCompare(String(y.name), 'en');
    });
  }

  // The Worker sends needsReview; decided rows keep their flags, so flags alone do not mean "open".
  function needsReview(row) { return !!(row && (row.needsReview || row.pending)); }

  // Attended (fill-ins too), Bench and Missed (with notice too), counted from the people list.
  function countsOf(people) {
    const count = function (f) { return people.filter(f).length; };
    return {
      present: count(function (p) { return p.outcome === 'present' || p.outcome === 'fill_in'; }),
      bench: count(function (p) { return p.outcome === 'bench'; }),
      missed: count(function (p) { return p.outcome === 'missed' || p.outcome === 'missed_notice'; }),
    };
  }

  // The Loot side panel of a past raid; nothing while its data is not loaded (or the viewer does not see loot).
  function lootPanelHtml(gd, data, loot) {
    return G.pages.raidLoot ? G.pages.raidLoot.panelHtml({ guildData: gd, data: data, state: loot }) : '';
  }

  // ── Raid settings (officers): the raid's own size and sign-up deadline ──
  const MAX_CLOSE_HOURS = 72;
  const AUTO_SIZE = 'Automatic - from the zone, else the team\'s size';

  function hoursText(n) { return plural(n, 'hour', 'hours'); }

  // The team's own deadline: the raid's when it has no override of its own; else the Raids list's copy of the team (it carries it), else unknown.
  function teamCloseHours(data) {
    const r = data.raid;
    if (r.closeHoursOverride == null) return typeof r.closeHours === 'number' ? r.closeHours : null;
    const list = a().raids;
    const team = list && list.data && list.data.team;
    return team && team.id === idOf(r.team) && typeof team.signupCloseHours === 'number' ? team.signupCloseHours : null;
  }

  // What is in effect now, in a sentence each.
  function sizeInEffectText(r) {
    if (typeof r.size !== 'number') return '';
    return 'In effect: ' + plural(r.size, 'player', 'players') + (r.sizeOverride != null ? ', set for this raid.' : ', picked from the zone, else the team\'s size.');
  }

  function deadlineInEffectText(r, gd) {
    if (typeof r.closeHours !== 'number') return '';
    const own = r.closeHoursOverride != null;
    const source = own ? ', set for this raid.' : ', the team\'s setting.';
    // A raid with only a date has no start to count from: the Worker says when it closes instead, and why.
    if (r.closesSource && typeof r.closesAt === 'number') {
      return 'In effect: members can change their sign-up until ' + G.pages.raids.momentText(r.closesAt, gd) + ' (' + G.pages.raids.closeNoteText(r) + ')' + source;
    }
    if (!(r.closeHours > 0)) return 'In effect: members can change their sign-up until the raid starts' + source;
    const when = typeof r.closesAt === 'number' ? G.pages.raids.momentText(r.closesAt, gd) : '';
    return 'In effect: members can change their sign-up until ' + hoursText(r.closeHours) + ' before the start' + (when ? ' (' + when + ')' : '') + source;
  }

  // The "Raid settings" form dialog (More > Raid settings): the raid's own size and, until it starts, its sign-up deadline. Same fields, same PATCH as the card it replaced.
  function settingsDialogHtml(gd, data) {
    const r = data.raid;
    const own = r.closeHoursOverride != null;
    const teamHours = teamCloseHours(data);
    const sizeField = '<div class="gs-field"><label class="gs-label" for="rs-size">Raid size</label><select class="gs-input" id="rs-size" name="size" data-key="rs-size" aria-describedby="rs-size-help">' +
      G.ui.optionsHtml(G.ui.sizeChoices(AUTO_SIZE), r.sizeOverride == null ? '' : r.sizeOverride) + '</select>' +
      '<p class="gs-fine" id="rs-size-help">' + esc(sizeInEffectText(r)) + '</p><p class="gs-field-error" id="rs-err-size" role="alert" hidden></p></div>';
    // The deadline only means something until the raid starts.
    const hoursField = !isUpcoming(data) ? '' :
      '<div class="gs-field"><label class="gs-label" for="rs-hours-mode">Sign-up deadline</label><select class="gs-input" id="rs-hours-mode" name="hoursMode" data-change="rs-hours-mode" data-key="rs-hours-mode" aria-describedby="rs-hours-help">' +
      G.ui.optionsHtml([{ value: '', label: 'Team default' + (teamHours == null ? '' : ' (' + hoursText(teamHours) + ')') }, { value: 'custom', label: 'Set for this raid' }], own ? 'custom' : '') + '</select>' +
      '<div class="gs-field" id="rs-hours-field"' + (own ? '' : ' hidden') + '><label class="gs-label" for="rs-hours">Hours before the start (0 = when the raid starts)</label>' +
      '<input class="gs-input" type="number" id="rs-hours" name="hours" data-key="rs-hours" min="0" max="' + MAX_CLOSE_HOURS + '" step="1" inputmode="numeric" autocomplete="off" value="' + (own ? esc(r.closeHoursOverride) : '') + '"></div>' +
      '<p class="gs-fine" id="rs-hours-help">' + esc(deadlineInEffectText(r, gd)) + '</p><p class="gs-field-error" id="rs-err-hours" role="alert" hidden></p></div>';
    return '<form class="gs-dialog-form gs-forge gs-rs" data-submit="raid-settings-form" novalidate><h2 class="gs-dialog-title" id="dlg-title">Raid settings</h2>' +
      '<div class="gs-su-fields">' + sizeField + hoursField + '</div>' +
      '<p class="gs-alert" id="rs-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" data-key="rs-save">Save settings</button></div></form>';
  }

  // The Line-up card (officers) of the published line-up (pages-raid-roster.js); nothing while its data is not loaded. A member's own group is the You bar.
  function rosterCardHtml(gd, data, roster, signups) {
    const sv = G.pages.raidSignups ? G.pages.raidSignups.viewOf(signups) : null;
    return G.pages.raidRoster ? G.pages.raidRoster.cardHtml({ guildData: gd, data: data, state: roster, myPersonId: sv && sv.me ? sv.me.personId : null }) : '';
  }

  // ── the raid page (design framework T2: object page with a stage strip) ──
  // Stage strip (Sign-ups, Plan, Publish, Log, Loot) worked out from the raid's own data, the next-step bar with the page's ONE primary action, the viewer's own line
  // ("You: ..."), then sections in the same order for every raid. Before the raid starts: Sign-ups, Plan and line-up, Loot prios, After the raid (locked, says when it
  // opens). After it starts (post-raid mode) the page leads with what is left to do: the log and the attendance review, then the loot awards, then the plan, line-up
  // and sign-ups as summaries; Add a sign-up, Close sign-ups and the status form are gone, and Everyone lists only the people who were on the roster that day.
  // `parts` is { signups, roster, loot, board }: the states of the pieces that load by themselves (each module's stateFor).
  function signupsViewOf(state) { return state && state.status === 'ok' && state.data ? state.data : null; }
  function rosterViewOf(state) { return state && state.status === 'ok' && state.data ? state.data : null; }
  function awardsOf(state) { return state && state.status === 'ok' && state.data && Array.isArray(state.data.awards) ? state.data.awards : null; }
  function reviewCount(data) { return Array.isArray(data.people) ? data.people.filter(needsReview).length : 0; }
  function hasLog(data) { return hasReports(data) || isManual(data); }

  // The five stages, each done / current / later / skipped with the line under its name. Pure. The one current stage is the first that still needs someone.
  function stagesOf(data, parts) {
    const p = parts || {};
    const upcoming = isUpcoming(data);
    const src = data.sources || {};
    const plan = src.plan || null;
    const view = signupsViewOf(p.signups);
    const roster = rosterViewOf(p.roster);
    const awards = awardsOf(p.loot);
    const flags = reviewCount(data);
    const logged = hasLog(data);
    const counts = view && view.counts ? view.counts : null;
    let signed = null;
    if (counts) signed = typeof counts.expected === 'number' ? counts.expected : (counts.signed || 0) + (counts.late || 0);
    else if (src.event) signed = src.event.signups || 0;
    const bench = counts ? counts.bench || 0 : 0;
    const published = !!(roster && roster.published);
    const signupsDone = !upcoming || (signed !== null && signed > 0) || !!plan || published;

    const signups = { key: 'signups', state: signupsDone ? 'done' : 'current', line: signed ? signed + ' signed up' + (bench ? ', ' + bench + ' bench' : '') : (upcoming ? 'No sign-ups yet' : 'None') };
    const planned = { key: 'plan', state: plan ? 'done' : (!upcoming ? 'skipped' : (signupsDone ? 'current' : 'later')), line: plan ? plural(plan.players || 0, 'player', 'players') : (upcoming ? 'Not planned yet' : '') };
    const publish = { key: 'publish', state: 'later', line: '' };
    if (published) {
      const c = roster.counts;
      const total = c ? (c.confirmed || 0) + (c.pending || 0) + (c.declined || 0) : 0;
      Object.assign(publish, { state: 'done', line: c && total ? (c.confirmed || 0) + ' of ' + total + ' confirmed' : 'Published' });
    } else if (!upcoming) {
      Object.assign(publish, { state: 'skipped' });
    } else if (!plan) {
      Object.assign(publish, { line: 'After Plan' });
    } else if (!roster) {
      Object.assign(publish, { line: 'Checking...' });
    } else {
      Object.assign(publish, { state: 'current', line: 'Not published' });
    }
    const log = { key: 'log', state: 'later', line: 'After the raid' };
    const loot = { key: 'loot', state: 'later', line: 'After the raid' };
    if (!upcoming) {
      const logLine = hasReports(data) ? plural(src.reports.length, 'report', 'reports') : 'Entered by hand';
      if (!logged) Object.assign(log, { state: 'current', line: 'No log yet' });
      else if (flags) Object.assign(log, { state: 'current', line: flags + ' to review' });
      else Object.assign(log, { state: 'done', line: logLine });
      if (awards && awards.length) Object.assign(loot, { state: 'done', line: plural(awards.length, 'item', 'items') });
      else if (logged && !flags) Object.assign(loot, { state: 'current', line: 'No loot yet' });
      else Object.assign(loot, { line: 'After the log' });
    }
    const stages = [signups, planned, publish, log, loot].map(function (s) { s.target = 's-' + s.key; return s; });
    const current = stages.filter(function (s) { return s.state === 'current'; })[0];
    return { stages: stages, current: current ? current.key : null, flags: flags, logged: logged, published: published, planned: !!plan, signed: signed, bench: bench, rosterKnown: !!roster, upcoming: upcoming };
  }

  // The next-step bar: the page's one primary action for the current stage, for whoever may take it; everyone else reads what the officers are waiting for.
  // Returns ui.nextStepHtml options, or null while the line-up is still being read (so a Publish button never flashes up for a raid that is already published).
  function nextStepOf(gd, data, parts, model) {
    const p = parts || {};
    const edit = !!(data.can && data.can.edit);
    const review = !!(data.can && data.can.review);
    const roster = G.pages.raidRoster;
    const loot = G.pages.raidLoot;
    const op = function (name, label, key, extra) { return { label: label, attrs: Object.assign({ 'data-action': 'raid-op', 'data-op': name, 'data-key': key }, extra || {}) }; };
    const stages = model.stages;
    const lineOf = function (key) { return stages.filter(function (s) { return s.key === key; })[0].line; };
    switch (model.current) {
      case 'signups':
        return { title: 'Collect sign-ups', text: data.sources && data.sources.event ? 'Members sign up on this page or in Raid-Helper. The Planner opens once there are some.' : 'Members sign up on this page. Link a Raid-Helper event if your sign-ups live there.',
          secondary: edit && !(data.sources && data.sources.event) ? op('event-replace', 'Link an event', 'ns-secondary') : null };
      case 'plan': {
        const text = (model.signed ? lineOf('signups') + '. ' : '') + 'The Planner arranges the groups for you and saves the plan on this raid.';
        return edit ? { title: 'Plan this raid', text: text, primary: op('plan-in-planner', 'Plan in Planner', 'ns-primary') } : { title: 'Plan this raid', text: 'Waiting for an officer to plan this raid.' };
      }
      case 'publish': {
        if (!edit) return { title: 'Publish the line-up', text: 'Waiting for an officer to publish the line-up.' };
        const text = 'Raiders see their group and can confirm or say they can\'t come. You are asked who is told before it goes out.';
        return roster && roster.canPublish(data, p.roster) ? { title: 'Publish the line-up', text: text, primary: { label: 'Publish line-up', attrs: { 'data-action': 'roster-publish', 'data-op': 'publish', 'data-key': 'ns-primary' } } } : { title: 'Publish the line-up', text: text };
      }
      case 'log':
        if (!model.logged) {
          return edit ? { title: 'Add the Warcraft Logs report', text: 'Attendance and the review flags come from the log. Paste the report link.', primary: op('report-add', 'Add log', 'ns-primary'), secondary: op('manual-open', 'Mark attendance by hand', 'ns-secondary') }
            : { title: 'Add the Warcraft Logs report', text: 'Waiting for an officer to add the log.' };
        }
        return review ? { title: 'Review attendance', text: plural(model.flags, 'player needs', 'players need') + ' a decision before the attendance is final.', primary: { label: 'Review attendance', attrs: { 'data-action': 'raid-review', 'data-key': 'ns-primary' } },
          secondary: { variant: 'secondary', label: 'Open review queue', href: G.router.format({ name: 'review', gid: gd.guild.id }) } }
          : { title: 'Review attendance', text: 'Waiting for an officer to review attendance.' };
      case 'loot': {
        if (!loot || !loot.canImport(p.loot)) return { title: 'Record the loot', text: 'Waiting for an officer to record the loot.' };
        return { title: 'Record the loot', text: 'Import the Gargul export of this raid, or add awards by hand.', primary: { label: 'Import loot awards', attrs: { 'data-action': 'loot-import-open', 'data-key': 'ns-primary' } },
          secondary: loot.canAdd(p.loot) ? { label: 'Add loot award', attrs: { 'data-action': 'loot-add-open', 'data-key': 'ns-secondary' } } : null };
      }
      default:
        if (model.upcoming) return model.published ? { title: 'The line-up is out', text: 'Members have been asked to confirm their group. The log, the attendance review and the loot awards open when the raid starts.' } : null;
        if (model.stages.every(function (s) { return s.state === 'done' || s.state === 'skipped'; })) return { title: 'This raid is complete', text: 'Attendance is reviewed and the loot is recorded.' };
        return null;
    }
  }

  // Everyone = the people on the roster that day: someone who joined the guild after the raid is left out unless they signed up, were in the log or were decided on.
  function onRosterThatDay(row) {
    return !row.joinedAfter || !!row.signup || !!(row.pulls && row.pulls.present > 0) || !!row.decision;
  }

  // The Attendance panel (id raid-people) and the Unmatched characters panel under it: pages-raid-attendance.js. The log source, the hand-entered line and the plan /
  // line-up rows are facts in the side panel; "Open review queue" lives in the next-step bar while a review is due.
  function attendanceHtml(gd, data, opts) {
    const att = G.pages.raidAttendance;
    const b = bossCounts(data);
    const summary = b.pulls ? [G.pages.raids.bossesText(b), plural(b.pulls, 'pull', 'pulls')].filter(function (x) { return x && x !== '-'; }).join(', ') : '';
    return att.panelHtml({ guildData: gd, data: data, filter: opts.filter, signups: opts.signups, summary: summary }) + att.unmatchedHtml(data);
  }

  // The stale banner stays a page notice (above the columns); its button recalculates this raid.
  function staleNoticeHtml(data, edit, progress) {
    if (!(data.raid && data.raid.stale)) return '';
    return A().staleBannerHtml(1, edit, progress).replace('data-action="att-recalc"', 'data-action="raid-op" data-op="recompute"');
  }

  // ── the columns (design-spec 3, T2: main 2fr, side 1fr from 1024 px; one column below, the side panels after the main column) ──
  function bareSection(id, html) { return html ? G.ui.objectSectionHtml({ id: id, bare: true, bodyHtml: html }) : ''; }

  // The import and paste flows (Gargul awards after the raid, TMB / softres prios any time) open at the TOP of the main column while they are open, full width.
  function flowsHtml(data, opts, model) {
    const loot = !model.upcoming && G.pages.raidLoot ? G.pages.raidLoot.importFlowHtml({ guildData: opts.guildData, state: opts.loot }) : '';
    const board = G.pages.raidBoard ? G.pages.raidBoard.pasteFlowHtml({ state: opts.board }) : '';
    return loot + board;
  }

  // The Loot prios item list in the main column (only once something is pasted and has items); its anchor is s-board.
  function prioListHtml(gd, data, opts) {
    return G.pages.raidBoard ? G.pages.raidBoard.listHtml({ guildData: gd, data: data, state: opts.board }) : '';
  }

  // Before the raid: the open flows, the Sign-ups panel, the Line-up card (officers, once published), the Loot prios list.
  function mainBefore(gd, data, opts, model) {
    const roster = rosterViewOf(opts.roster);
    const lineup = rosterCardHtml(gd, data, opts.roster, opts.signups);
    return flowsHtml(data, opts, model) + bareSection('s-signups', signupsPanelHtml(gd, data, opts.signups)) +
      bareSection('s-lineup', roster && roster.published ? lineup : (opts.roster && opts.roster.status === 'error' ? lineup : '')) +
      bareSection('s-board', prioListHtml(gd, data, opts));
  }

  // After the raid: the open flows, the Attendance board (+ Unmatched characters), the sign-ups record behind "Show sign-ups", the Loot prios list.
  function mainAfter(gd, data, opts, model) {
    const signups = signupsPanelHtml(gd, data, opts.signups);
    const record = signups ? '<details class="gs-srow-more gs-rpg-record" id="s-signups" tabindex="-1"><summary>Show sign-ups</summary><div class="gs-srow-body">' + signups + '</div></details>' : '';
    return flowsHtml(data, opts, model) + attendanceHtml(gd, data, opts) + record + bareSection('s-board', prioListHtml(gd, data, opts));
  }

  // The side column. Desktop order: Raid facts, then after the raid Bosses and Loot, then the Loot prios summary. Each side panel carries a phone order class
  // (gs-rpg-sp-loot, -bosses, -facts, -prios) that guild.css turns into the order on one column (Loot, Bosses, Raid facts, prio summary). The Loot panel has its own
  // locked / reading placeholders until the log is attached. The summary takes the anchor s-board when the main column has no prio list.
  function sideHtml(gd, data, opts, model) {
    const facts = G.pages.raidFacts ? G.pages.raidFacts.factsHtml({ data: data, parts: { roster: opts.roster }, model: model }) : '';
    const board = G.pages.raidBoard ? G.pages.raidBoard : null;
    const summary = board ? board.summaryHtml({ state: opts.board }) : '';
    const anchored = !prioListHtml(gd, data, opts);
    const prios = summary ? '<div class="gs-rpg-sp gs-rpg-sp-prios"' + (anchored ? ' id="s-board" tabindex="-1"' : '') + '>' + summary + '</div>' : '';
    if (model.upcoming) return facts + prios;
    const bosses = G.pages.raidFacts ? G.pages.raidFacts.bossesHtml(data) : '';
    const loot = lootPanelHtml(gd, data, opts.loot);
    const lootStage = model.stages.filter(function (s) { return s.key === 'loot'; })[0];
    const placeholder = function (text) { return G.pages.raidLoot ? G.pages.raidLoot.placeholderHtml(text) : ''; };
    let lootHtml;
    if (loot) lootHtml = loot;
    else if (lootStage.state === 'later') lootHtml = placeholder('Opens after the log is attached. Then import the Gargul export here.');
    else lootHtml = placeholder('Reading the loot awards...');
    return facts + bosses + '<div class="gs-rpg-sp gs-rpg-sp-loot" id="s-loot" tabindex="-1">' + lootHtml + '</div>' + prios;
  }

  function columnsHtml(gd, data, opts, model) {
    const main = model.upcoming ? mainBefore(gd, data, opts, model) : mainAfter(gd, data, opts, model);
    return '<div class="gs-rpg-cols"><div class="gs-rpg-main">' + main + '</div><div class="gs-rpg-side">' + sideHtml(gd, data, opts, model) + '</div></div>';
  }

  // The more menu of the page, for those who may edit the raid: page-level items only (what belongs to the event, plan, line-up, log or duties is a Change menu in the
  // Raid facts panel; the loot and prio actions live in the Loot and Loot prios panels). ctx is unused now.
  function moreItemsOf(data, ctx) {
    if (!(data.can && data.can.edit)) return [];
    const upcoming = isUpcoming(data);
    const extras = G.pages.raidExtras ? G.pages.raidExtras.menuItems(data) : []; // Guest sign-up link (before) / Paste raid roster (after, no WCL report)
    const settings = { label: 'Raid settings', key: 'mi-raid-settings', data: { action: 'raid-op', op: 'settings' } };
    const items = [{ label: 'Open in Planner', key: 'mi-plan-in-planner', data: { action: 'raid-op', op: 'plan-in-planner' } }];
    if (upcoming) {
      items.push(settings);
      extras.forEach(function (item) { items.push(item); });
    } else {
      items.push({ label: 'Recalculate attendance', key: 'mi-recompute', data: { action: 'raid-op', op: 'recompute' } });
      if (!isManual(data) && !hasReports(data)) items.push({ label: 'Mark as No log', key: 'mi-manual-open', data: { action: 'raid-op', op: 'manual-open' } });
      extras.forEach(function (item) { items.push(item); });
      items.push(settings);
    }
    items.push({ separator: true }, { label: 'Delete raid', key: 'mi-raid-delete', danger: true, data: { action: 'raid-op', op: 'raid-delete' } });
    return items;
  }

  // ── the head ──
  // Closed by an officer, by the deadline or by the start: the sign-ups view says which (view.raid.closed); until it is read only an officer's lock is known.
  function signupsClosed(data, signups) {
    const view = signupsViewOf(signups);
    if (view && view.raid) return !!view.raid.closed;
    return !!data.raid.signupsLocked;
  }

  function isComplete(model) {
    return !model.upcoming && model.stages.every(function (s) { return s.state === 'done' || s.state === 'skipped'; });
  }

  // ONE chip (G11). Before: Sign-ups open / closed, Needs recalculation (rose) wins. After: Complete when the next-step bar says so, else the state word.
  function headChipHtml(data, model, signups) {
    const chip = function (tone, text) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(text) + '</span>'; };
    const r = data.raid;
    if (r.stale || r.state === 'stale') return chip('rose', 'Needs recalculation');
    if (model.upcoming) return signupsClosed(data, signups) ? chip('grey', 'Sign-ups closed') : chip('green', 'Sign-ups open');
    if (isComplete(model)) return chip('green', 'Complete');
    const flags = r.openFlags > 0 ? r.openFlags : reviewCount(data);
    switch (r.state) {
      case 'awaiting_log': return chip('grey', 'Awaiting log');
      case 'manual': return flags ? chip('rose', flags + ' to review') : chip('grey', 'No log - by hand');
      case 'to_review': return chip('rose', flags + ' to review');
      case 'reviewed': return chip('grey', 'Reviewed');
      default: return chip('grey', String(r.state == null ? '' : r.state).replace(/_/g, ' '));
    }
  }

  // The one context line. Before: "[Team - ]7:00 PM ET - Black Temple, 25-player - sign-ups close Fri 6:00 PM ET". After: "[Team - ]3 kills, 1 wipe - 20 attended, 3 missed - 4 items".
  function contextOf(gd, data, parts, model) {
    const r = data.raid;
    const team = A().teamOf(gd, idOf(r.team));
    const several = G.shell.activeTeams(gd.teams).length > 1;
    const out = [];
    if (several && team) out.push(esc(team.name));
    if (model.upcoming) {
      out.push(r.timeKnown === false ? '<span class="gs-time-unset">Time not set</span>' : esc(G.ui.timeInZone(r.startsAt, gd.guild.timeZone)));
      const size = typeof r.size === 'number' && r.size > 0 ? r.size + '-player' : '';
      const where = [r.zone, size].filter(Boolean).join(', ');
      if (where) out.push(esc(where));
      if (signupsClosed(data, parts.signups)) out.push('sign-ups closed');
      else if (typeof r.closesAt === 'number') out.push('sign-ups close ' + esc(G.pages.raids.momentText(r.closesAt, gd)));
    } else {
      const people = Array.isArray(data.people) ? data.people.filter(onRosterThatDay) : null; // the totals count the people who were on the roster that day
      const bosses = G.pages.raids.bossesText(bossCounts(data));
      if (bosses !== '-') out.push(esc(bosses));
      if (people && people.length) { const c = countsOf(people); out.push(esc(c.present + ' attended, ' + c.missed + ' missed')); }
      const awards = awardsOf(parts.loot);
      if (awards && awards.length) out.push(esc(plural(awards.length, 'item', 'items')));
    }
    return out.map(function (x) { return '<span>' + x + '</span>'; }).join('<span class="gs-sumsep" aria-hidden="true"></span>');
  }

  // The header: back link, "<Fri Oct 23> - <title, else zone, else size>", the one chip, the context line and the More menu. No primary here.
  function headOf(gd, data, parts, model, ctx) {
    const r = data.raid;
    const size = typeof r.size === 'number' && r.size > 0 ? r.size + '-player' : '';
    const what = r.title || r.zone || size;
    const items = moreItemsOf(data, ctx);
    return {
      title: (G.ui.weekdayDay(r.raidOn) || r.raidOn) + (what ? ' - ' + what : ''),
      back: { href: G.router.format({ name: 'section', gid: gd.guild.id, section: 'raids' }), label: 'Raids' },
      contextHtml: contextOf(gd, data, parts, model), chipsHtml: headChipHtml(data, model, parts.signups),
      more: items.length ? { id: 'raid-actions', label: 'More', key: 'raid-actions', items: items } : null,
    };
  }

  // opts: { guildData, data (GET /raids/:rid), filter: 'review'|'all'|null, alert, note, progress, loot (G.pages.raidLoot.stateFor), signups (G.pages.raidSignups.stateFor), roster (G.pages.raidRoster.stateFor), board }
  function raidHtml(opts) {
    const gd = opts.guildData;
    const data = opts.data;
    const edit = !!(data.can && data.can.edit);
    const parts = { signups: opts.signups, roster: opts.roster, loot: opts.loot, board: opts.board };
    const model = stagesOf(data, parts);
    const next = nextStepOf(gd, data, parts, model);
    const lootEdit = !!(G.pages.loot && G.pages.loot.allows && G.pages.loot.allows(gd, 'loot.edit', data.raid && data.raid.team && typeof data.raid.team === 'object' ? data.raid.team.id : data.raid && data.raid.team));
    const officer = edit || !!(data.can && data.can.review) || lootEdit;
    const notices = G.pages.review.noteHtml(opts.note) + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') + staleNoticeHtml(data, edit, opts.progress);
    const you = G.pages.raidYou ? G.pages.raidYou.youBarHtml({ guildData: gd, data: data, parts: parts, nextHasPrimary: !!(next && next.primary) }) : '';
    return G.ui.objectPageHtml({
      head: headOf(gd, data, parts, model, opts),
      noticesHtml: notices,
      nextStep: officer ? next : null, // a member's next step is the You bar
      afterYouHtml: you,
      pageClass: 'gs-raid-page gs-forge gs-rpg ' + (model.upcoming ? 'is-before' : 'is-after'),
      sections: [{ id: 'raid-cols', bare: true, bodyHtml: columnsHtml(gd, data, opts, model) }],
    });
  }

  // ── dialogs ──
  function sourceDialogHtml(o) {
    return '<form class="gs-dialog-form gs-forge" data-submit="' + o.submit + '" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + esc(o.title) + '</h2>' + (o.help ? '<p class="gs-fine" id="dlg-help">' + esc(o.help) + '</p>' : '') +
      '<div class="gs-field"><label class="gs-label" for="dlg-source">' + esc(o.label) + '</label>' + (o.multiline
        ? '<textarea class="gs-input gs-textarea" id="dlg-source" name="source" rows="3" data-field="source" autocomplete="off"></textarea>'
        : '<input class="gs-input" type="text" id="dlg-source" name="source" data-field="source" autocomplete="off">') +
      '<p class="gs-field-error" id="dlg-err-source" role="alert" hidden></p></div>' +
      '<input type="hidden" name="confirm" value="">' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten" id="dlg-submit">' + esc(o.button) + '</button></div></form>';
  }

  function confirmDialogHtml(o) {
    return '<form class="gs-dialog-form gs-forge" data-submit="raid-confirm-form" data-op="' + esc(o.op) + '"' + (o.code ? ' data-code="' + esc(o.code) + '"' : '') + ' novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + esc(o.title) + '</h2><p class="gs-confirm-text" id="dlg-text">' + esc(o.text) + '</p>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn ' + (o.danger ? 'gs-btn-danger' : 'gs-btn-molten') + '">' + esc(o.button) + '</button></div></form>';
  }

  // Candidates for the manual dialog: this raid's people (sign-ups, plan), the team roster, and, found by search, anyone else.
  // rosters: [{ teamId, people: [GET /roster rows] }]. ticked: ids already present.
  function manualCandidates(data, rosters, ticked) {
    const byId = {};
    const order = [];
    function put(id, name, cls, tags, extra) {
      if (!id) return;
      if (!byId[id]) { byId[id] = { id: id, name: name, class: cls, tags: [], extra: !!extra }; order.push(id); }
      const c = byId[id];
      if (!extra) c.extra = false;
      (tags || []).forEach(function (t) { if (t && c.tags.indexOf(t) < 0) c.tags.push(t); });
    }
    (Array.isArray(data.people) ? data.people : []).forEach(function (p) {
      const tags = [];
      if (p.signup) tags.push(A().KIND_LABELS[p.signup] || p.signup);
      if (p.plan) tags.push(p.plan === 'bench' ? 'Plan: bench' : 'Plan: ' + p.plan);
      put(p.playerId, p.name, p.class, tags, false);
    });
    const teamId = idOf(data.raid.team);
    (rosters || []).forEach(function (r) {
      (Array.isArray(r.people) ? r.people : []).forEach(function (p) {
        const main = p.main || p.shown || {};
        if (p.status === 'inactive' && r.teamId === teamId) return;
        put(p.id, main.name, main.class, [], r.teamId !== teamId);
      });
    });
    return order.map(function (id) { byId[id].ticked = !!ticked[id]; return byId[id]; }).sort(function (x, y) {
      return (x.extra ? 1 : 0) - (y.extra ? 1 : 0) || (y.tags.length ? 1 : 0) - (x.tags.length ? 1 : 0) || String(x.name).localeCompare(String(y.name), 'en');
    });
  }

  function manualTicked(data) {
    const m = data.raid && data.raid.manual;
    const ids = {};
    if (m && Array.isArray(m.presentPlayerIds)) { m.presentPlayerIds.forEach(function (id) { ids[id] = true; }); return ids; }
    if (isManual(data)) (Array.isArray(data.people) ? data.people : []).forEach(function (p) { if (OK_MANUAL.indexOf(p.outcome) >= 0) ids[p.playerId] = true; });
    return ids;
  }

  // opts: { data, candidates, reason, edit }
  function manualDialogHtml(opts) {
    const r = opts.data.raid;
    const list = opts.candidates.map(function (c) {
      return '<li class="gs-pick-item' + (c.extra ? ' is-extra' : '') + '" data-name="' + esc(String(c.name).toLowerCase()) + '"' + (c.extra ? ' hidden' : '') + '><div class="gs-check"><input type="checkbox" name="present" id="mp-' + esc(c.id) + '" value="' + esc(c.id) + '"' + (c.ticked ? ' checked' : '') + '><label for="mp-' + esc(c.id) + '">' +
        G.ui.classNameHtml(c.name, c.class) + c.tags.map(function (t) { return ' <span class="gs-chip gs-chip-signup">' + esc(t) + '</span>'; }).join('') + '</label></div></li>';
    }).join('');
    return '<form class="gs-dialog-form gs-forge gs-dialog-wide" data-submit="manual-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">' + (opts.edit ? 'Edit' : 'Enter') + ' attendance by hand</h2>' +
      '<p class="gs-fine" id="dlg-help">' + esc(G.ui.weekdayDay(r.raidOn)) + '. Tick everyone who was present. Everyone not ticked is handled as if absent from a log: signed up and not ticked is Missed, Bench stays Bench, Absence stays Missed with notice.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-reason">Reason there is no log (required)</label><input class="gs-input" type="text" id="dlg-reason" name="reason" maxlength="' + REASON_MAX + '" autocomplete="off" data-field="reason" value="' + esc(opts.reason || '') + '">' +
      '<p class="gs-field-error" id="dlg-err-reason" role="alert" hidden></p></div>' +
      '<div class="gs-field"><label class="gs-label" for="mp-search">Find a person</label><input class="gs-input" type="search" id="mp-search" data-input="manual-search" autocomplete="off" placeholder="Search to add someone from another team"></div>' +
      '<ul class="gs-pick-list" aria-label="People">' + (list || '<li class="gs-fine">No one to list yet.</li>') + '</ul>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Save attendance</button></div></form>';
  }

  function manualRemoveDialogHtml() {
    return '<form class="gs-dialog-form gs-forge" data-submit="manual-remove-form" novalidate>' +
      '<h2 class="gs-dialog-title" id="dlg-title">Remove the hand-entered attendance</h2><p class="gs-fine" id="dlg-help">The raid goes back to Awaiting log. Decisions stay on file.</p>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-reason">Reason (required)</label><input class="gs-input" type="text" id="dlg-reason" name="reason" maxlength="' + REASON_MAX + '" autocomplete="off" data-field="reason"><p class="gs-field-error" id="dlg-err-reason" role="alert" hidden></p></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-danger">Remove</button></div></form>';
  }

  // ── data ──
  function setDetail(c, res, note) {
    G.app.applyFlags(c.gid, res);
    if (res && res.raid && res.sources) c.x.data = res;
    a().note = note || '';
    st().pageAlert = '';
    if (G.pages.raidRoster) G.pages.raidRoster.invalidate(); // a new plan: the line-up is read again after the draw ("The plan changed since you published")
    G.app.render();
    // The event, the plan or the results changed: the sign-ups panel reads its list again.
    if (G.pages.raidSignups && res && res.raid) {
      G.pages.raidSignups.loadFor(c.gd, res).then(function () { G.app.render(); }, pageError);
    }
  }

  function fetchDetail(gid, rid) {
    return G.api.get(raidBase(gid, rid)).then(function (data) {
      a().raid = { gid: gid, rid: rid, data: data, filter: a().raid && a().raid.rid === rid ? a().raid.filter : null, auto: a().openManual === rid };
      if (a().openManual === rid) a().openManual = null;
      return data;
    });
  }

  function load(r, gd) {
    a().note = '';
    return fetchDetail(gd.guild.id, r.rid).then(function (data) {
      const signups = G.pages.raidSignups ? G.pages.raidSignups.loadFor(gd, data) : Promise.resolve(null);
      return signups.then(function () { return G.pages.raidLoot ? G.pages.raidLoot.loadFor(gd, data) : null; }).then(function () { return G.pages.raidBoard ? G.pages.raidBoard.loadFor(gd, data) : null; });
    }).then(function () { return null; });
  }

  function reload() {
    const gd = currentGd();
    const x = a().raid;
    if (!gd || !x) return Promise.resolve();
    return fetchDetail(gd.guild.id, x.rid).then(function () { G.app.render(); }, function (err) { G.app.handleError(err, { pageAlert: true }); });
  }

  function main(r, gd) {
    const x = a().raid;
    if (!x || x.gid !== gd.guild.id || x.rid !== r.rid) return G.pages.signin.loadingHtml();
    return raidHtml({ guildData: gd, data: x.data, filter: x.filter, alert: st().pageAlert, note: a().note, progress: a().recalc, loot: G.pages.raidLoot ? G.pages.raidLoot.stateFor(gd.guild.id, r.rid) : null, board: G.pages.raidBoard ? G.pages.raidBoard.stateFor(gd.guild.id, r.rid) : null, signups: G.pages.raidSignups ? G.pages.raidSignups.stateFor(gd.guild.id, r.rid) : null, roster: G.pages.raidRoster ? G.pages.raidRoster.stateFor(gd.guild.id, r.rid) : null });
  }

  function openManualDialog(c) {
    const data = c.data;
    const teams = G.shell.activeTeams(c.gd.teams);
    Promise.all(teams.map(function (t) {
      return G.api.get(A().apiBase(c.gid) + '/roster?team=' + encodeURIComponent(t.id)).then(function (res) { return { teamId: t.id, people: res && res.people }; }, function () { return { teamId: t.id, people: [] }; });
    })).then(function (rosters) {
      const m = data.raid.manual || {};
      G.ui.openDialog(manualDialogHtml({ data: data, candidates: manualCandidates(data, rosters, manualTicked(data)), reason: m.reason || '', edit: isManual(data) }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const input = document.getElementById('dlg-reason');
      if (input) input.focus();
    });
  }

  // Called by the app after each render: the New raid page asks for the manual dialog to open on the new raid.
  function afterRender() {
    const x = a().raid;
    if (!x || !x.auto) return;
    const c = cur();
    if (!c || typeof document === 'undefined' || !document.getElementById('guild-dialogs')) return;
    x.auto = false;
    openManualDialog(c);
  }

  // ── operations ──
  function pageError(err) { G.app.handleError(err, { pageAlert: true }); }

  // A cancelled move question (see G.pages.raids.putEvent) changes nothing: the button just comes back.
  function runDirect(el, promise, c) {
    if (el) el.disabled = true;
    return promise.then(function (res) {
      if (res === G.pages.raids.MOVE_CANCELLED) { if (el) el.disabled = false; return; }
      setDetail(c, res);
    }, function (err) { if (el) el.disabled = false; pageError(err); });
  }

  G.handlers.click['raid-filter'] = function (el) {
    const c = cur();
    if (!c) return;
    c.x.filter = el.getAttribute('data-filter');
    G.app.render();
  };

  // The next-step bar's Review attendance: the people list shows what needs a decision and the page scrolls to it.
  G.handlers.click['raid-review'] = function () {
    const c = cur();
    if (!c) return;
    c.x.filter = 'review';
    G.app.render();
    const target = typeof document !== 'undefined' && document.getElementById ? document.getElementById('raid-people') : null;
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'start' });
  };

  G.handlers.click['raid-op'] = function (el) {
    const c = cur();
    if (!c) return;
    const op = el.getAttribute('data-op');
    const code = el.getAttribute('data-code');
    const base = raidBase(c.gid, c.rid);
    const ev = c.data.sources && c.data.sources.event;
    switch (op) {
      case 'recompute': runDirect(el, G.api.post(base + '/recompute', {}), c); break;
      case 'event-refresh': if (ev) runDirect(el, G.pages.raids.putEvent(c.gid, c.rid, ev.id, ev.otherServer), c); break;
      case 'plan-in-planner':
        el.disabled = true;
        G.pages.raids.planInPlanner(c.gid, c.rid, isUpcoming(c.data) ? ev : null).then(function (opened) { if (!opened) el.disabled = false; }, function (err) { el.disabled = false; pageError(err); });
        break;
      case 'report-refresh': runDirect(el, G.api.put(base + '/reports', { source: code }), c); break;
      case 'event-replace':
        G.ui.openDialog(sourceDialogHtml({ submit: 'event-form', title: ev ? 'Replace the Raid-Helper event' : 'Link a Raid-Helper event', label: 'Event link or ID', button: ev ? 'Replace event' : 'Link event', help: 'The sign-ups are read from the event. Decisions already made are kept.' }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        focusSource();
        break;
      case 'report-add':
        G.ui.openDialog(sourceDialogHtml({ submit: 'report-form', title: 'Add a Warcraft Logs report', label: 'Report link or code', button: 'Add report', help: 'Only who was present in each boss pull is kept, never the report.' }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        focusSource();
        break;
      case 'plan-replace':
        G.ui.openDialog(sourceDialogHtml({ submit: 'plan-form', title: c.data.sources && c.data.sources.plan ? 'Replace the plan' : 'Link a plan', label: 'Plan link or share code', button: 'Save plan', multiline: true, help: 'Paste a Raidsmith plan link or share code. Only names and groups are sent to Raidsmith; the link itself is not kept.' }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        focusSource();
        break;
      case 'event-remove':
        G.ui.openDialog(confirmDialogHtml({ op: op, title: 'Remove the Raid-Helper event?', text: 'Its sign-ups are removed from this raid and the attendance is recalculated. Decisions are kept.', button: 'Remove event', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'report-remove':
        G.ui.openDialog(confirmDialogHtml({ op: op, code: code, title: 'Remove this report?', text: 'Its boss pulls and who was present are removed from this raid and the attendance is recalculated.', button: 'Remove report', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'plan-remove':
        G.ui.openDialog(confirmDialogHtml({ op: op, title: 'Remove the plan?', text: 'Plan placements stop counting as sign-ups on this raid.', button: 'Remove plan', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'raid-delete':
        G.ui.openDialog(confirmDialogHtml({ op: op, title: 'Delete this raid?', text: 'Removes the raid with its sign-ups, presence, plan and attendance, including decisions. This cannot be undone.', button: 'Delete raid', danger: true }), { labelledBy: 'dlg-title', describedBy: 'dlg-text' });
        break;
      case 'settings':
        G.ui.openDialog(settingsDialogHtml(c.gd, c.data), { labelledBy: 'dlg-title' });
        break;
      case 'manual-open':
      case 'manual-edit': openManualDialog(c); break;
      case 'manual-remove':
        G.ui.openDialog(manualRemoveDialogHtml(), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
        break;
      default: break;
    }
  };

  function focusSource() {
    const input = typeof document !== 'undefined' ? document.getElementById('dlg-source') : null;
    if (input) input.focus();
  }

  // The deadline's mode select shows the hours box only for "Set for this raid" (in place: a re-render could swallow the click on Save).
  G.handlers.change['rs-hours-mode'] = function (el) {
    if (typeof document === 'undefined') return;
    const custom = el.value === 'custom';
    const field = document.getElementById('rs-hours-field');
    if (field) field.hidden = !custom;
    const input = document.getElementById('rs-hours');
    if (custom && input) input.focus();
  };

  // Raid settings: only what changed is sent (a key left out is kept by the Worker, so two officers changing different settings do not undo each other);
  // Automatic and Team default send null, which clears the raid's own value.
  G.handlers.submit['raid-settings-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const r = c.data.raid;
    ['rs-err-size', 'rs-err-hours', 'rs-error'].forEach(function (id) { G.ui.setText(id, ''); });
    const body = {};
    const size = form.elements.size.value === '' ? null : Number(form.elements.size.value);
    if (size !== null && G.ui.RAID_SIZES.indexOf(size) < 0) { G.ui.setText('rs-err-size', 'Choose Automatic or one of the sizes.'); form.elements.size.focus(); return; }
    if (size !== (r.sizeOverride == null ? null : r.sizeOverride)) body.size = size;
    if (form.elements.hoursMode) {
      let hours = null;
      if (form.elements.hoursMode.value === 'custom') {
        const text = String(form.elements.hours.value == null ? '' : form.elements.hours.value).trim();
        if (!/^\d{1,2}$/.test(text) || Number(text) > MAX_CLOSE_HOURS) { G.ui.setText('rs-err-hours', 'Enter whole hours from 0 to ' + MAX_CLOSE_HOURS + '.'); form.elements.hours.focus(); return; }
        hours = Number(text);
      }
      if (hours !== (r.closeHoursOverride == null ? null : r.closeHoursOverride)) body.signupCloseHours = hours;
    }
    if (!Object.keys(body).length) { G.ui.setText('rs-error', 'Nothing to save: the settings are already as shown.'); return; }
    G.ui.setBusy(form, true);
    G.api.patch(raidBase(c.gid, c.rid), body).then(function (res) {
      G.ui.closeDialogOf(form);
      setDetail(c, res, 'Raid settings saved.');
    }, function (err) {
      G.ui.setBusy(form, false);
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.app.showFailure(cl.title, cl.text); return; }
      if (err && err.code === 'conflict') { G.app.handleError(err); return; }
      const sink = err && err.field === 'size' ? 'rs-err-size' : err && err.field === 'signupCloseHours' ? 'rs-err-hours' : 'rs-error';
      G.ui.setText(sink, cl.text);
      const input = sink === 'rs-err-size' ? form.elements.size : sink === 'rs-err-hours' ? (form.elements.hours || form.elements.hoursMode) : null;
      if (input && input.focus) input.focus();
    });
  };

  G.handlers.submit['raid-confirm-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const op = form.getAttribute('data-op');
    const base = raidBase(c.gid, c.rid);
    let promise;
    if (op === 'event-remove') promise = G.api.del(base + '/event', {});
    else if (op === 'report-remove') promise = G.api.del(base + '/reports/' + encodeURIComponent(form.getAttribute('data-code')), {});
    else if (op === 'plan-remove') promise = G.api.del(base + '/plan', {});
    else if (op === 'raid-delete') {
      G.ui.runDialog(form, G.api.del(base, {}), function (res) {
        G.app.applyFlags(c.gid, res);
        a().raid = null;
        a().raids = null;
        G.app.go(G.router.format({ name: 'section', gid: c.gid, section: 'raids' }));
      });
      return;
    } else return;
    G.ui.runDialog(form, promise, function (res) { setDetail(c, res); });
  };

  // Whether the form's own dialog is still open: the Move question replaces it (dialogs never stack), and then nothing is left to show an error in.
  function dialogStillOpen(form) {
    const dlg = form && form.closest ? form.closest('dialog') : null;
    if (!dlg) return true; // not inside a dialog element (a test's stand-in): treat it as open
    return dlg.open !== false && dlg.isConnected !== false;
  }

  // The dialogs that take one source string. A second try after other_server / report_not_same_night confirms it.
  // notLinked (optional): what the page says when the officer answers Cancel to "Move this raid?" (the link dialog is gone by then).
  function sourceSubmit(form, build, notLinked) {
    const c = cur();
    if (!c) return;
    const src = String(form.elements.source.value || '').trim();
    G.ui.setText('dlg-err-source', '');
    G.ui.setText('dlg-error', '');
    if (!src) { G.ui.setText('dlg-err-source', 'Enter a link or code.'); form.elements.source.focus(); return; }
    const confirmed = form.elements.confirm.value === '1';
    const call = build(c, src, confirmed);
    if (!call) return;
    G.ui.setBusy(form, true);
    call.then(function (res) {
      if (res === G.pages.raids.MOVE_CANCELLED) {
        // The officer said no to moving the raid: nothing changed. The link dialog closed when the question opened, so the page says it.
        G.ui.setBusy(form, false);
        G.ui.closeDialogOf(form);
        if (notLinked) { a().note = notLinked; st().pageAlert = ''; G.app.render(); }
        return;
      }
      G.ui.closeDialogOf(form);
      setDetail(c, res);
    }, function (err) {
      G.ui.setBusy(form, false);
      if (!dialogStillOpen(form)) { pageError(err); return; } // an error after the Move question: no dialog left for it, so the page shows it
      const cl = G.api.classify(err);
      if (cl.view === 'signin') { G.ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (cl.view === 'message') { G.ui.closeDialogOf(form); G.app.showFailure(cl.title, cl.text); return; }
      G.ui.setText('dlg-error', cl.text);
      if (err && (err.code === 'other_server' || err.code === 'report_not_same_night')) {
        form.elements.confirm.value = '1';
        const b = document.getElementById('dlg-submit');
        if (b) b.textContent = err.code === 'other_server' ? 'Import anyway' : 'Add anyway';
      }
    });
  }

  G.handlers.submit['event-form'] = function (form) {
    sourceSubmit(form, function (c, src, confirmed) {
      return G.pages.raids.putEvent(c.gid, c.rid, src, confirmed);
    }, 'Not linked. The event is on another day than the raid, and the raid was not moved.');
  };

  G.handlers.submit['report-form'] = function (form) {
    sourceSubmit(form, function (c, src, confirmed) {
      return G.api.put(raidBase(c.gid, c.rid) + '/reports', confirmed ? { source: src, confirmFar: true } : { source: src });
    });
  };

  G.handlers.submit['plan-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const text = String(form.elements.source.value || '').trim();
    G.ui.setText('dlg-err-source', '');
    G.ui.setText('dlg-error', '');
    if (!text) { G.ui.setText('dlg-err-source', 'Paste a plan link or share code.'); form.elements.source.focus(); return; }
    G.ui.setBusy(form, true);
    G.planSource.read(text, { surname: currentGd() && currentGd().guild.gameVersion === 'forever' }).then(function (read) {
      if (!read.ok) { G.ui.setBusy(form, false); G.ui.setText('dlg-err-source', read.error); form.elements.source.focus(); return null; }
      return G.api.put(raidBase(c.gid, c.rid) + '/plan', { label: read.label, players: read.players, live: read.live }).then(function (res) {
        G.ui.closeDialogOf(form);
        setDetail(c, res, read.skippedText);
      }, function (err) {
        const planText = G.planSource.describeError(err, read.players);
        if (planText) { const e = new Error(planText); e.planText = planText; throw e; }
        throw err;
      });
    }).catch(function (err) {
      G.ui.setBusy(form, false);
      G.ui.setText('dlg-error', err && err.planText ? err.planText : G.api.classify(err).text);
    });
  };

  G.handlers.submit['manual-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const reason = String(form.elements.reason.value || '').trim();
    const ids = Array.prototype.map.call(form.querySelectorAll('input[name="present"]:checked'), function (i) { return i.value; });
    G.ui.setText('dlg-err-reason', '');
    G.ui.setText('dlg-error', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) { G.ui.setText('dlg-err-reason', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.'); form.elements.reason.focus(); return; }
    if (ids.length > MAX_PRESENT) { G.ui.setText('dlg-error', 'At most ' + MAX_PRESENT + ' people can be ticked.'); return; }
    G.ui.runDialog(form, G.api.put(raidBase(c.gid, c.rid) + '/manual', { reason: reason, presentPlayerIds: ids }), function (res) { setDetail(c, res); });
  };

  G.handlers.submit['manual-remove-form'] = function (form) {
    const c = cur();
    if (!c) return;
    const reason = String(form.elements.reason.value || '').trim();
    G.ui.setText('dlg-err-reason', '');
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) { G.ui.setText('dlg-err-reason', 'Give a reason of ' + REASON_MIN + ' to ' + REASON_MAX + ' characters.'); form.elements.reason.focus(); return; }
    G.ui.runDialog(form, G.api.del(raidBase(c.gid, c.rid) + '/manual', { reason: reason }), function (res) { setDetail(c, res); });
  };

  // Search in the manual dialog: filters the list by name; people from other teams show only while the query matches.
  G.handlers.input['manual-search'] = function (el) {
    const q = String(el.value || '').trim().toLowerCase();
    const items = el.closest('form').querySelectorAll('.gs-pick-item');
    for (let i = 0; i < items.length; i++) {
      const extra = items[i].classList.contains('is-extra');
      const hit = !q || items[i].getAttribute('data-name').indexOf(q) >= 0;
      items[i].hidden = extra ? (!q || !hit) : !hit;
    }
  };

  G.pages.raid = {
    raidHtml: raidHtml,
    stagesOf: stagesOf,
    nextStepOf: nextStepOf,
    headChipHtml: headChipHtml,
    contextOf: contextOf,
    moreItemsOf: moreItemsOf,
    onRosterThatDay: onRosterThatDay,
    settingsDialogHtml: settingsDialogHtml,
    columnsHtml: columnsHtml,
    manualDialogHtml: manualDialogHtml,
    manualCandidates: manualCandidates,
    manualTicked: manualTicked,
    sourceDialogHtml: sourceDialogHtml,
    confirmDialogHtml: confirmDialogHtml,
    sortedPeople: sortedPeople,
    needsReview: needsReview,
    reload: reload,
    setDetail: setDetail,
    current: cur,
    afterRender: afterRender,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
