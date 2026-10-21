// ── PAGE PIECE: THE RAID FACTS PANEL ────────────────────────────
// The side column's first panel on the raid page (design-spec 4, "Fact panel"): a `dl` of the facts about this raid, label left (muted), value right. An officer (raids.edit)
// gets one small secondary "Change" per row that opens that row's menu, so the head's More keeps page-level items only:
//   Sign-ups from  Raid-Helper event or "This page"   Link an event | Refresh sign-ups, Replace event, Remove event
//   Plan           the linked plan or Not planned     Plan settings: Open in Planner, Link a plan / Replace plan, Remove plan
//   Line-up        Not published / Published, X of Y  Publish line-up (disabled without a plan) | Re-publish line-up, Unpublish   (before the raid only)
//   Log            Warcraft Logs / by hand / None     Refresh and Remove per report, Add report | Edit or Remove the hand-entered attendance | Add report, Mark attendance by hand
//   Duties         who does what                      the Raid duties dialog (pages-raid-extras.js)
// A finished raid shows Log too and calls the plan "Skipped" when it had none; bossesHtml draws the Bosses panel under it. Every item is an existing handler: raid-op (pages-raid.js) and roster-publish
// (pages-raid-roster.js); this module only draws. The panel carries the phone order hook `gs-rpg-sp-facts` (see guild.css, "Raid page").
(function (G) {
  'use strict';

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function A() { return G.pages.attendance; }
  function rosterOf(state) { return state && state.status === 'ok' && state.data ? state.data : null; }
  function isManual(data) { return !!(data.raid && data.raid.state === 'manual') || !!(data.raid && data.raid.manual); }

  // A menu item that runs a raid-op (the dialogs and requests of pages-raid.js).
  function opItem(op, label, extra, danger) {
    return { label: label, danger: !!danger, key: 'fi-' + op + (extra && extra.code ? '-' + extra.code : ''), data: Object.assign({ action: 'raid-op', op: op }, extra || {}) };
  }

  function changeMenu(id, aria, items) {
    return G.ui.menuHtml({ id: 'fact-' + id, key: 'fact-' + id, label: 'Change', ariaLabel: aria, triggerClass: 'gs-btn gs-btn-sm', items: items });
  }

  // The Raids list reads the date Raid-Helper has an event on when it is not the raid's; the raid's own detail does not carry it.
  function movedOn(data) {
    const list = A().attState().raids;
    const rows = list && list.data && Array.isArray(list.data.upcoming) ? list.data.upcoming : [];
    const row = rows.filter(function (r) { return r && r.id === data.raid.id; })[0];
    return row && row.eventMovedOn ? row.eventMovedOn : '';
  }

  function sub(text) { return '<span class="gs-rpg-sub">' + esc(text) + '</span>'; }

  // ── the five rows: { id, label, valueHtml, subHtml, changeHtml } ──
  function eventRow(data, model, edit) {
    const ev = data.sources && data.sources.event;
    let value;
    let note = '';
    if (!model.upcoming) value = model.signed ? model.signed + ' signed' + (model.bench ? ', ' + model.bench + ' bench' : '') : 'None';
    else if (ev) value = 'Raid-Helper, ' + (ev.title || 'event') + ' (' + (ev.signups || 0) + (ev.syncedAt ? ', synced ' + G.ui.relativeTime(ev.syncedAt).toLowerCase() : '') + ')';
    else value = 'This page';
    if (ev && ev.otherServer) note += sub('The event is from another server.');
    const moved = ev ? movedOn(data) : '';
    if (moved) note += sub('Raid-Helper has this event on ' + (G.ui.weekdayDay(moved) || moved) + '. The raid was not moved.');
    const items = ev ? [opItem('event-refresh', 'Refresh sign-ups'), opItem('event-replace', 'Replace event'), { separator: true }, opItem('event-remove', 'Remove event', null, true)] : [opItem('event-replace', 'Link an event')];
    return { id: 's-signups-from', label: model.upcoming ? 'Sign-ups from' : 'Sign-ups', valueHtml: esc(value), subHtml: note, changeHtml: edit ? changeMenu('event', 'Change sign-ups source', items) : '' };
  }

  function planRow(data, model, edit) {
    const plan = data.sources && data.sources.plan;
    const value = plan ? (plan.label || 'Plan') + ', ' + plural(plan.players || 0, 'player', 'players') : (model.upcoming ? 'Not planned' : 'Skipped');
    const unmatched = plan && plan.unmatched && plan.unmatched.length ? sub(plural(plan.unmatched.length, 'planned name is', 'planned names are') + ' not on the roster.') : '';
    const items = [opItem('plan-in-planner', 'Open in Planner'), opItem('plan-replace', plan ? 'Replace plan' : 'Link a plan')];
    if (plan || (data.sources && data.sources.planDoc)) items.push({ separator: true }, opItem('plan-remove', 'Remove plan', null, true));
    return { id: 's-plan', label: 'Plan', valueHtml: esc(value), subHtml: unmatched, changeHtml: edit ? changeMenu('plan', 'Plan settings', items) : '' };
  }

  function lineupRow(data, parts, model, edit) {
    const roster = rosterOf(parts.roster);
    let value;
    if (roster && roster.published) {
      const c = roster.counts;
      const total = c ? (c.confirmed || 0) + (c.pending || 0) + (c.declined || 0) : 0;
      value = 'Published' + (c && total ? ', ' + (c.confirmed || 0) + ' of ' + total + ' confirmed' : '');
    } else value = model.upcoming && !roster ? 'Checking...' : 'Not published';
    let items = [];
    if (edit && model.upcoming && roster) {
      if (roster.published) items = [{ label: 'Re-publish line-up', key: 'fi-republish', data: { action: 'roster-publish', op: 'republish' } }, { label: 'Unpublish', key: 'fi-unpublish', danger: true, data: { action: 'roster-publish', op: 'unpublish' } }];
      else if (!(data.sources && data.sources.plan)) items = [{ label: 'Publish line-up', disabled: true, note: 'Needs a plan first' }];
      else items = [{ label: 'Publish line-up', key: 'fi-publish', data: { action: 'roster-publish', op: 'publish' } }];
    }
    return { id: 's-publish', label: 'Line-up', valueHtml: esc(value), subHtml: '', changeHtml: items.length ? changeMenu('lineup', 'Change line-up', items) : '' };
  }

  function logRow(data, edit) {
    const reports = data.sources && Array.isArray(data.sources.reports) ? data.sources.reports : [];
    const manual = isManual(data);
    let value;
    let note = '';
    let items;
    if (reports.length) {
      const pulls = reports.reduce(function (sum, r) { return sum + (r.pulls || 0); }, 0);
      value = 'Warcraft Logs - ' + plural(reports.length, 'report', 'reports') + ', ' + plural(pulls, 'pull', 'pulls');
      items = [];
      reports.forEach(function (r, i) {
        if (i) items.push({ separator: true });
        items.push(opItem('report-refresh', 'Refresh ' + r.code, { code: r.code }), opItem('report-remove', 'Remove ' + r.code, { code: r.code }, true));
      });
      if (!manual) items.push({ separator: true }, opItem('report-add', 'Add report'));
    } else if (manual) {
      const m = (data.raid && data.raid.manual) || {};
      // Who entered it and why are for reviewers; the Worker leaves them out for everyone else, and then the date goes too.
      const detailed = !!(m.by || m.reason);
      value = 'Entered by hand' + (detailed && m.by ? ' by ' + m.by : '') + (detailed && m.at ? ' on ' + G.ui.formatDate(m.at) : '');
      if (m.reason) note = sub('Reason: ' + m.reason + '.');
      items = [opItem('manual-edit', 'Edit attendance by hand'), opItem('manual-remove', 'Remove hand-entered attendance', null, true)];
    } else {
      value = 'None';
      items = [opItem('report-add', 'Add report'), opItem('manual-open', 'Mark attendance by hand')];
    }
    return { id: 's-logsource', label: 'Log', valueHtml: esc(value), subHtml: note, changeHtml: edit ? changeMenu('log', 'Change log', items) : '' };
  }

  function dutiesRow(data, edit) {
    const list = Array.isArray(data.duties) ? data.duties : [];
    const value = list.length ? list.map(function (d) { return esc(d.label) + ' ' + G.ui.classNameHtml(d.name, d.class); }).join(', ') : 'Not set';
    const change = edit ? '<button type="button" class="gs-btn gs-btn-sm" data-action="raid-extra" data-op="duties" data-key="fact-duties" aria-label="Change duties">Change</button>' : '';
    return { id: 'raid-duties', label: 'Duties', valueHtml: value, subHtml: '', changeHtml: change };
  }

  function rowHtml(r) {
    return '<div class="gs-rpg-fact" id="' + r.id + '" tabindex="-1"><dt>' + esc(r.label) + '</dt><dd><span class="gs-rpg-v">' + r.valueHtml + '</span>' + (r.subHtml || '') + (r.changeHtml ? '<div class="gs-rpg-chg">' + r.changeHtml + '</div>' : '') + '</dd></div>';
  }

  // o: { data (the raid detail), parts: { roster }, model (pages-raid.js stagesOf) }
  function factsHtml(o) {
    const data = o.data;
    const model = o.model;
    const edit = !!(data.can && data.can.edit);
    const rows = model.upcoming
      ? [eventRow(data, model, edit), planRow(data, model, edit), lineupRow(data, o.parts || {}, model, edit), dutiesRow(data, edit)]
      : [eventRow(data, model, edit), planRow(data, model, edit), lineupRow(data, o.parts || {}, model, edit), logRow(data, edit), dutiesRow(data, edit)];
    return '<section class="gs-hd-panel gs-rpg-facts gs-rpg-sp gs-rpg-sp-facts" id="raid-facts" tabindex="-1" aria-labelledby="raid-facts-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="raid-facts-h">Raid</h2></div>' +
      '<dl class="gs-rpg-dl">' + rows.map(rowHtml).join('') + '</dl></section>';
  }

  // ── Bosses (after the raid, only when the log has pulls): one row per encounter in first-pull order, name left, word right ──
  // "Kill" (killed with no wipe before the first kill), "Kill after N wipe(s)" (wipes before the first kill), "N wipe(s)" (never killed).
  function bossRows(pulls) {
    const order = [];
    const by = {};
    pulls.map(function (p, i) { return { p: p, i: i }; }).sort(function (x, y) {
      const sx = typeof x.p.startedAt === 'number' ? x.p.startedAt : Infinity;
      const sy = typeof y.p.startedAt === 'number' ? y.p.startedAt : Infinity;
      return sx === sy ? x.i - y.i : sx - sy;
    }).forEach(function (e) {
      const name = e.p && typeof e.p.encounter === 'string' ? e.p.encounter : '';
      if (!name) return;
      if (!Object.prototype.hasOwnProperty.call(by, name)) { by[name] = { name: name, killed: false, wipes: 0 }; order.push(by[name]); }
      const b = by[name];
      if (b.killed) return;
      if (e.p.kill) b.killed = true; else b.wipes += 1;
    });
    return order;
  }

  function bossWord(b) {
    if (!b.killed) return plural(b.wipes, 'wipe', 'wipes');
    return b.wipes ? 'Kill after ' + plural(b.wipes, 'wipe', 'wipes') : 'Kill';
  }

  // data: the raid detail. '' when the raid has no pulls (awaiting log, No log - by hand).
  function bossesHtml(data) {
    const pulls = Array.isArray(data.pulls) ? data.pulls : [];
    const rows = bossRows(pulls);
    if (!rows.length) return '';
    return '<section class="gs-hd-panel gs-rpl gs-rpl-bosses gs-rpg-sp gs-rpg-sp-bosses" id="raid-bosses" aria-labelledby="raid-bosses-h"><div class="gs-pr-ph"><h2 class="gs-pr-h" id="raid-bosses-h">Bosses</h2></div>' +
      '<ul class="gs-rpl-bl">' + rows.map(function (b) {
        return '<li class="gs-rpl-brow"><span class="gs-rpl-bn">' + esc(b.name) + '</span><span class="gs-rpl-bw' + (b.killed ? '' : ' is-wipe') + '">' + esc(bossWord(b)) + '</span></li>';
      }).join('') + '</ul></section>';
  }

  G.pages.raidFacts = { factsHtml: factsHtml, bossesHtml: bossesHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
