// ── PAGE: ROSTER ────────────────────────────────────────────────
// The roster of one team (design: tasks/roster-redesign-brief.md, boards A1, R2-1, R2-6, R2-7). Officers see the team shape (tiles against the recruiting
// targets) and a "Needs you" line above the list; everyone sees the people, a role column each (a phone: one directory list), search and Active / Everyone.
// A person is a link to their record. Data comes from GET /roster?team= (people, with raidRole and trialFlag) and, for officers, GET /recruiting?team=
// (targets, counts and the buff coverage); every mutation goes through the person record page's handlers or the import pages. The Add person dialog is here.
(function (G) {
  'use strict';

  const ROLE_ORDER = ['tank', 'healer', 'melee', 'ranged'];
  const ROLE_TITLES = { tank: 'Tanks', healer: 'Healers', melee: 'Melee DPS', ranged: 'Ranged DPS', none: 'No spec' };
  const DEFAULT_TRIAL_DAYS = 14;
  const MISSING_SHOWN = 3;
  // The phone's segments for an officer; a member has Active and Everyone only.
  const PHONE_SEGMENTS = [['active', 'Active'], ['raider', 'Raiders'], ['trial', 'Trials'], ['reserve', 'Reserve'], ['applicants', 'Applicants'], ['inactive', 'Inactive']];
  const MEMBER_SEGMENTS = [['active', 'Active'], ['everyone', 'Everyone']];

  function personHref(gid, pid) { return G.router.format({ name: 'person', gid: gid, pid: pid }); }
  function importHref(gid, source) { return G.router.format({ name: 'import', gid: gid, source: source }); }
  function recruitingHref(gid) { return G.router.format({ name: 'recruiting', gid: gid }); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function shownOf(p) { return (p && p.shown) || {}; }
  function nameOf(p) { return String(shownOf(p).name == null ? '' : shownOf(p).name); }
  function byName(a, b) { return nameOf(a).localeCompare(nameOf(b), 'en') || String(a.id).localeCompare(String(b.id), 'en'); }
  // You first, then A-Z.
  function youFirst(list) {
    return list.slice().sort(function (a, b) { return (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0) || byName(a, b); });
  }

  // ── numbers ──
  function countsOf(people) {
    const out = { active: 0, everyone: 0, raider: 0, trial: 0, reserve: 0, inactive: 0 };
    (Array.isArray(people) ? people : []).forEach(function (p) {
      out.everyone++;
      if (p.status !== 'inactive') out.active++;
      if (Object.prototype.hasOwnProperty.call(out, p.status)) out[p.status]++;
    });
    return out;
  }

  function contextText(data) {
    const c = countsOf(data.people);
    const rt = c.raider + c.trial;
    const name = (data.team && data.team.name) || '';
    return [name, plural(rt, 'raider or trial', 'raiders and trials')].filter(Boolean).join(' \u00b7 ') + (c.reserve ? ' \u00b7 ' + c.reserve + ' reserve' : '');
  }

  // The team shape for the tiles and column heads: the recruiting answer's targets and counts per role, and the "Missing:" line from its buff coverage.
  // rec = GET /recruiting?team=; cov = G.coverage.compute(...) or null.
  function shapeOf(rec, cov) {
    if (!rec || !rec.roster || !rec.targets) return null;
    const roles = ROLE_ORDER.map(function (role) {
      const have = Number(rec.roster.counts[role]) || 0;
      const want = Number(rec.targets[role]) || 0;
      const gap = want - have;
      return { role: role, have: have, want: want, gap: gap };
    });
    return { roles: roles, missing: missingLine(cov) };
  }

  function listNames(names, noun) {
    if (!names.length) return '';
    const shown = names.slice(0, MISSING_SHOWN).join(', ');
    return names.length > MISSING_SHOWN ? shown + ' and ' + (names.length - MISSING_SHOWN) + ' more ' + noun : shown;
  }

  function missingLine(cov) {
    const lead = 'Counts Raider and Trial mains.';
    if (!cov || !Array.isArray(cov.buffs) || !Array.isArray(cov.debuffs)) return lead;
    const buffs = cov.buffs.filter(function (b) { return !b.covered; }).map(function (b) { return b.name; });
    const debuffs = cov.debuffs.filter(function (d) { return !d.covered; }).map(function (d) { return d.name; });
    if (!buffs.length && !debuffs.length) return lead + ' Every raid buff and debuff is covered.';
    return lead + ' Missing: ' + [listNames(buffs, buffs.length - MISSING_SHOWN === 1 ? 'buff' : 'buffs'), listNames(debuffs, debuffs.length - MISSING_SHOWN === 1 ? 'debuff' : 'debuffs')].filter(Boolean).join('; ') + '.';
  }

  // ── pieces ──
  // The Import choices and "Show inactive people" are items of the page's one More menu; Add person is the one primary.
  function importItems(gid) {
    return [
      { label: 'Import from a Raid-Helper event', href: importHref(gid, 'raid-helper'), key: 'mi-import-rh' },
      { label: 'Import from a Warcraft Logs report', href: importHref(gid, 'wcl'), key: 'mi-import-wcl' },
      { label: 'Import from the Battle.net guild roster', href: importHref(gid, 'bnet'), key: 'mi-import-bnet' },
      { label: 'Import from a CSV file', href: importHref(gid, 'csv'), key: 'mi-import-csv' },
    ];
  }

  function moreItems(gid, inactive, showing) {
    const items = importItems(gid);
    if (inactive > 0 && !showing) items.push({ separator: true }, { label: 'Show inactive people (' + inactive + ')', data: { action: 'roster-show-inactive' }, key: 'mi-show-inactive' });
    return items;
  }

  function headOpts(gd, data, m) {
    const canAdd = !!(data.can && data.can.edit) && !(data.team && data.team.archived);
    const empty = !m.people.length;
    return { title: 'Roster', context: empty ? '' : contextText(data),
      more: canAdd && !empty ? { id: 'roster-more', key: 'roster-more', items: moreItems(gd.guild.id, m.counts.inactive, m.status === 'everyone' || m.status === 'inactive') } : null,
      primary: canAdd && !empty ? { label: 'Add person', attrs: { 'data-action': 'roster-add', 'data-key': 'roster-add' } } : null };
  }

  function chipHtml(tone, label) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(label) + '</span>'; }

  // One status word per person, only for the exception: rose = a trial to decide (officers), blue = Trial, grey = Reserve, Inactive, You.
  function rowChipHtml(p, m) {
    const flag = m.canEdit && G.rosterSort.isFlaggedHere(p, m.teamId) ? p.trialFlag : null;
    if (flag) return chipHtml('rose', flag.kind === 'ended' ? 'Trial ended' : G.ui.trialCopy(flag));
    if (p.status === 'trial') return chipHtml('blue', 'Trial');
    if (p.status === 'reserve') return chipHtml('grey', 'Reserve');
    if (p.status === 'inactive') return chipHtml('grey', 'Inactive');
    if (p.isMe) return chipHtml('grey', 'You');
    return '';
  }

  // A person: spec icon, the character's name in its class colour, the spec and "1 alt" in neutral grey, one chip. The whole row is the link to the record.
  function rowHtml(p, m) {
    const s = shownOf(p);
    const main = p.main || {};
    const alt = p.shown && p.main && p.shown.id !== p.main.id ? '<span class="gs-rs-alt">Alt of ' + esc(main.name) + '</span>' : (p.altCount > 0 ? '<span class="gs-rs-alt">' + esc(plural(p.altCount, 'alt', 'alts')) + '</span>' : '');
    return '<a class="gs-rs-row' + (p.isMe ? ' is-you' : '') + '" href="' + esc(personHref(m.gid, p.id)) + '"' + (p.isMe ? ' data-you="true"' : '') + '>' + G.ui.specIconHtml(s.class, s.mainSpec, 20) +
      '<span class="gs-rs-id"><span class="gs-rs-name ' + G.ui.classClass(s.class) + '">' + esc(s.name) + '</span>' +
      '<span class="gs-rs-sub"><span class="gs-rs-spec">' + esc(s.mainSpec || G.ui.className(s.class)) + '</span>' + alt + '</span></span>' + rowChipHtml(p, m) + '</a>';
  }

  // ── desktop: the four role columns ──
  function columnHtml(role, people, m) {
    const main = people.filter(function (p) { return p.status === 'raider' || p.status === 'trial'; });
    const reserve = people.filter(function (p) { return p.status === 'reserve'; });
    const inactive = people.filter(function (p) { return p.status === 'inactive'; });
    const want = m.shape ? (m.shape.roles.filter(function (r) { return r.role === role; })[0] || {}).want : null;
    const head = '<h3 class="gs-fg-gh gs-rs-colhead">' + esc(ROLE_TITLES[role]) + ' <b>' + main.length + '</b>' + (m.canEdit && want != null ? '<span class="gs-rs-den">/ ' + want + '</span>' : '') + '</h3>';
    const label = function (text, list) { return list.length ? '<h4 class="gs-hd-sl gs-rs-sep">' + esc(text) + '</h4>' + youFirst(list).map(function (p) { return rowHtml(p, m); }).join('') : ''; };
    const body = (main.length ? youFirst(main).map(function (p) { return rowHtml(p, m); }).join('') : (reserve.length || inactive.length ? '' : '<p class="gs-rs-none">No one</p>')) + label('Reserve', reserve) + label('Inactive', inactive);
    return '<div class="gs-hd-panel gs-rs-col" data-role="' + role + '">' + head + body + '</div>';
  }

  function columnsHtml(rows, m) {
    const groups = { tank: [], healer: [], melee: [], ranged: [], none: [] };
    rows.forEach(function (p) { groups[Object.prototype.hasOwnProperty.call(groups, p.raidRole) ? p.raidRole : 'none'].push(p); });
    const order = groups.none.length ? ROLE_ORDER.concat(['none']) : ROLE_ORDER;
    return '<div class="gs-rs-cols' + (groups.none.length ? ' has-other' : '') + '">' + order.map(function (role) { return columnHtml(role, groups[role], m); }).join('') + '</div>';
  }

  // ── phone: the directory list ──
  function phoneListHtml(rows, m) {
    if (m.status === 'applicants') return applicantsHtml(m);
    const head = function (text) { return '<h2 class="gs-hd-sl gs-rs-pgroup">' + esc(text) + '</h2>'; };
    const rowsOf = function (list) { return list.map(function (p) { return rowHtml(p, m); }).join(''); };
    if (m.canEdit && m.status === 'active') {
      const me = rows.filter(function (p) { return p.isMe; });
      const flagged = G.rosterSort.trialsToDecide(rows.filter(function (p) { return !p.isMe; }), m.teamId);
      const rest = rows.filter(function (p) { return !p.isMe && flagged.indexOf(p) < 0; });
      if (flagged.length) {
        return rowsOf(me) + head('Needs a decision') + rowsOf(flagged.slice().sort(byName)) + (rest.length ? head('Everyone') + rowsOf(rest.slice().sort(byName)) : '');
      }
    }
    return rowsOf(youFirst(rows));
  }

  // The Applicants segment: the New applications for this team, read when the segment is picked.
  function applicantsHtml(m) {
    const x = m.apps;
    if (!x || x.status === 'loading') return '<p class="gs-rs-none" role="status">Loading applicants...</p>';
    if (x.status === 'error') return '<p class="gs-rs-none" role="alert">We could not load the applicants. Open Recruiting to see them.</p>';
    const list = (Array.isArray(x.list) ? x.list : []).filter(function (a) { return fold(a.name).indexOf(fold(m.query).trim()) >= 0; });
    if (!list.length) return '<p class="gs-rs-none">' + (m.query ? 'No applicant matches the search.' : 'No new applications.') + '</p>';
    return list.map(function (a) {
      return '<a class="gs-rs-row" href="' + esc(G.router.format({ name: 'applications', gid: m.gid })) + '">' + G.ui.specIconHtml(a.class, a.spec, 20) +
        '<span class="gs-rs-id"><span class="gs-rs-name ' + G.ui.classClass(a.class) + '">' + esc(a.name) + '</span><span class="gs-rs-sub"><span class="gs-rs-spec">' + esc(a.spec || G.ui.className(a.class)) + '</span></span></span>' +
        chipHtml('grey', 'New') + '</a>';
    }).join('');
  }

  function fold(s) { return G.rosterSort.fold(s); }

  // ── the results: both layouts are in the markup, CSS shows one (600 px and below: the list) ──
  function filteredOf(m, status) {
    return G.rosterSort.filterPeople(m.people, { status: status, query: m.query }, m.teamId);
  }

  function noMatchHtml(m) {
    const q = String(m.query || '').trim();
    return '<div class="gs-rs-card" role="status">' + (q ? '<h2 class="gs-rs-cardtitle">No one matches &quot;' + esc(q) + '&quot;.</h2><p class="gs-fg-mut">Try a character name or a different spelling.</p>' +
      '<button type="button" class="gs-btn gs-btn-ghost" data-action="roster-clear-search" data-key="roster-clear-search">Clear search</button>'
      : '<h2 class="gs-rs-cardtitle">No one in this view.</h2><p class="gs-fg-mut">Pick another filter above.</p>') + '</div>';
  }

  function resultsHtml(m) {
    const deskStatus = m.status === 'everyone' ? 'everyone' : 'active';
    const deskRows = filteredOf(m, deskStatus);
    const phoneRows = m.status === 'applicants' ? [] : filteredOf(m, m.status);
    const desk = deskRows.length ? columnsHtml(deskRows, m) : noMatchHtml(m);
    const phone = m.status === 'applicants' ? phoneListHtml([], m) : (phoneRows.length ? '<section class="gs-hd-panel gs-rs-plist" aria-label="People">' + phoneListHtml(phoneRows, m) + '</section>' : noMatchHtml(m));
    return '<div class="gs-rs-desk">' + desk + '</div><div class="gs-rs-phone">' + phone + '</div>';
  }

  // ── toolbar ──
  function searchHtml(m) {
    return '<div class="gs-rs-search"><label class="gs-sr" for="roster-search">Search people or characters</label>' + G.icons.icon('search', 16) +
      '<input class="gs-rs-input" type="search" id="roster-search" placeholder="Search people or characters" data-input="roster-search" autocomplete="off" value="' + esc(m.query) + '"></div>';
  }

  function deskSegsHtml(m) {
    const on = m.status === 'everyone' ? 'everyone' : 'active';
    return '<div class="gs-fg-segs gs-rs-dsegs" role="group" aria-label="Show">' + [['active', 'Active', m.counts.active], ['everyone', 'Everyone', m.counts.everyone]].map(function (s) {
      return '<button type="button" class="gs-fg-seg" data-action="roster-seg" data-seg="' + s[0] + '" data-key="dseg-' + s[0] + '" aria-pressed="' + (on === s[0] ? 'true' : 'false') + '">' + s[1] + ' <span class="gs-fg-segn">' + s[2] + '</span></button>';
    }).join('') + '</div>';
  }

  function phoneSegsHtml(m) {
    const list = m.canEdit ? PHONE_SEGMENTS : MEMBER_SEGMENTS;
    const countOf = function (id) { return id === 'applicants' ? m.applicationCount : m.counts[id]; };
    return '<div class="gs-rs-psegs' + (m.canEdit ? ' is-scroll' : '') + '"><div class="gs-fg-pills" role="group" aria-label="Filter people">' + list.map(function (s) {
      const badge = s[0] === 'applicants' && countOf('applicants') > 0;
      return '<button type="button" class="gs-fg-pill" data-action="roster-seg" data-seg="' + s[0] + '" data-key="pseg-' + s[0] + '" aria-pressed="' + (m.status === s[0] ? 'true' : 'false') + '">' + s[1] +
        (badge ? ' <span class="gs-fg-cnt">' + countOf('applicants') + '</span>' : ' <span class="gs-fg-segn">' + countOf(s[0]) + '</span>') + '</button>';
    }).join('') + '</div></div>';
  }

  // ── officer blocks ──
  function tilesHtml(m) {
    if (!m.canEdit || m.archived) return '';
    if (m.shapeState === 'error') return '';
    if (!m.shape) {
      return '<section class="gs-rs-shape" aria-label="Team shape" aria-busy="true"><h2 class="gs-hd-sl">Team shape</h2><div class="gs-rs-tiles">' +
        [0, 1, 2, 3].map(function () { return '<div class="gs-hd-panel gs-rs-tile"><span class="gs-hd-sk is-sm"></span><span class="gs-hd-sk is-tile"></span></div>'; }).join('') + '</div></section>';
    }
    const tiles = m.shape.roles.map(function (r) {
      const chip = r.gap > 0 ? chipHtml('rose', 'Need ' + r.gap) : r.gap < 0 ? chipHtml('grey', Math.abs(r.gap) + ' over') : chipHtml('green', 'Full');
      return '<div class="gs-hd-panel gs-rs-tile" data-role="' + r.role + '"><div class="gs-rs-tilehead"><span class="gs-fg-gh">' + esc(ROLE_TITLES[r.role]) + '</span>' + chip + '</div>' +
        '<span class="gs-rs-tilenum" data-have="' + r.have + '" data-want="' + r.want + '">' + r.have + '<span class="gs-rs-tileden"> / ' + r.want + '</span></span></div>';
    }).join('');
    return '<section class="gs-rs-shape" aria-label="Team shape"><h2 class="gs-hd-sl">Team shape</h2><div class="gs-rs-tiles">' + tiles + '</div>' +
      '<p class="gs-fg-mut">' + esc(m.shape.missing) + ' <a class="gs-fg-u" href="' + esc(recruitingHref(m.gid)) + '">See coverage</a></p></section>';
  }

  // "Fangrin's trial ended 3 days ago", "Hexen's trial ends in 4 days", "3 new applications": hidden when there is nothing to decide.
  function needsHtml(m) {
    if (!m.canEdit || m.archived) return '';
    const flagged = G.rosterSort.trialsToDecide(m.people, m.teamId).slice().sort(function (a, b) {
      const ka = a.trialFlag.kind === 'ended' ? 0 : 1;
      const kb = b.trialFlag.kind === 'ended' ? 0 : 1;
      return ka - kb || Number(a.trialFlag.days) - Number(b.trialFlag.days) || byName(a, b);
    });
    const items = flagged.map(function (p) {
      return '<span class="gs-rs-need"><a class="gs-fg-u" href="' + esc(personHref(m.gid, p.id)) + '">' + esc(nameOf(p)) + '</a>\'s trial ' + esc(G.ui.trialCopy(p.trialFlag).toLowerCase()) + '</span>';
    });
    if (m.applicationCount > 0) items.push('<a class="gs-fg-u gs-rs-need" href="' + esc(recruitingHref(m.gid)) + '">' + esc(plural(m.applicationCount, 'new application', 'new applications')) + '</a>');
    if (!items.length) return '';
    return '<section class="gs-hd-panel gs-rs-needs" aria-label="Needs you"><h2 class="gs-fg-gh">Needs you</h2><div class="gs-rs-needlist">' + items.join('<span class="gs-rs-vsep" aria-hidden="true"></span>') + '</div></section>';
  }

  // A member's own line above the list: their character and the two places they act (their record, their away notices).
  function youHtml(m) {
    if (m.canEdit) return '';
    const me = m.people.filter(function (p) { return p.isMe; })[0];
    if (!me) return '';
    const s = shownOf(me);
    return '<section class="gs-hd-panel gs-rs-you" aria-label="You"><h2 class="gs-fg-gh">You</h2>' + G.ui.specIconHtml(s.class, s.mainSpec, 20) +
      '<span class="gs-rs-name ' + G.ui.classClass(s.class) + '">' + esc(s.name) + '</span><span class="gs-rs-youspec">' + esc(G.ui.className(s.class) + (s.mainSpec ? ' \u00b7 ' + s.mainSpec : '')) + '</span><span class="gs-rs-grow"></span>' +
      '<a class="gs-fg-u" href="' + esc(personHref(m.gid, me.id)) + '">Your record</a><a class="gs-fg-u" href="' + esc(G.router.format({ name: 'away', gid: m.gid })) + '">Away notices</a></section>';
  }

  function footHtml(m) {
    if (!m.canEdit || m.counts.inactive < 1 || m.status === 'everyone' || m.status === 'inactive') return '';
    return '<p class="gs-fg-mut gs-rs-foot">' + esc(plural(m.counts.inactive, 'inactive person is', 'inactive people are')) + ' hidden. <button type="button" class="gs-fg-linkbtn" data-action="roster-show-inactive" data-key="roster-show-inactive">Show them</button></p>';
  }

  // ── states ──
  function stateCardHtml(opts) {
    return '<section class="gs-hd-panel gs-rs-state' + (opts.role ? '" role="' + opts.role : '') + '" aria-label="' + esc(opts.label) + '"><span class="gs-rs-tilebox" aria-hidden="true">' + G.icons.icon('roster', 28) + '</span>' +
      '<h2 class="gs-rs-cardtitle">' + esc(opts.title) + '</h2>' + (opts.text ? '<p class="gs-rs-statetext">' + esc(opts.text) + '</p>' : '') + (opts.actionsHtml ? '<div class="gs-rs-stateacts">' + opts.actionsHtml + '</div>' : '') + '</section>';
  }

  function emptyHtml(gd, data) {
    const canEdit = !!(data.can && data.can.edit) && !(data.team && data.team.archived);
    const gid = gd.guild.id;
    if (!canEdit) return stateCardHtml({ label: 'Empty roster', title: 'No one on the roster yet', text: 'Your officers haven\'t added anyone yet.' });
    return stateCardHtml({ label: 'Empty roster', title: 'No one on the roster yet',
      text: 'Add people one at a time, or import them from a Raid-Helper event, a Warcraft Logs report, the Battle.net guild roster or a CSV file.',
      actionsHtml: G.ui.buttonHtml({ label: 'Add person', variant: 'primary', attrs: { 'data-action': 'roster-add', 'data-key': 'roster-add' } }) +
        G.ui.menuHtml({ id: 'roster-import', key: 'roster-import', label: 'Import', items: importItems(gid) }) });
  }

  // A guild with no active team has no roster to show.
  function noTeamHtml(canManageTeams, gid) {
    return '<div class="gs-page gs-list-page gs-forge gs-roster-page"><header class="gs-pagehead"><div class="gs-pagehead-row"><div class="gs-pagehead-title"><div class="gs-pagehead-h"><h1 class="gs-h1" id="page-title" tabindex="-1">Roster</h1></div></div></div></header>' +
      stateCardHtml({ label: 'No active team', title: 'No active team', text: 'The roster belongs to a team, and this guild has no active team.' + (canManageTeams ? '' : ' Ask a Guild Master or Officer to add one.'),
        actionsHtml: canManageTeams ? G.ui.buttonHtml({ label: 'Open Teams', variant: 'primary', href: G.router.format({ name: 'settings', gid: gid, tab: 'teams' }) }) : '' }) + '</div>';
  }

  // The loading state: the heading, the tabs' place and grey blocks where the shape and the people will be.
  function skeletonHtml() {
    const sk = function (cls) { return '<span class="gs-hd-sk ' + cls + '"></span>'; };
    return '<div class="gs-page gs-list-page gs-forge gs-roster-page" aria-busy="true"><p class="gs-sr" role="status">Loading the roster</p>' +
      '<header class="gs-pagehead"><div class="gs-pagehead-row"><div class="gs-pagehead-title"><div class="gs-pagehead-h"><h1 class="gs-h1" id="page-title" tabindex="-1">Roster</h1></div></div></div></header>' +
      '<div class="gs-rs-tiles" aria-hidden="true">' + [0, 1, 2, 3].map(function () { return '<div class="gs-hd-panel gs-rs-tile">' + sk('is-sm') + sk('is-tile') + '</div>'; }).join('') + '</div>' +
      '<div class="gs-hd-panel gs-rs-skel" aria-hidden="true">' + [0, 1, 2, 3, 4, 5].map(function () { return sk('is-line'); }).join('') + '</div></div>';
  }

  // The load failed: the one region says so, with Try again; nothing the viewer saved is lost.
  function errorHtml(text) {
    return '<div class="gs-page gs-list-page gs-forge gs-roster-page"><header class="gs-pagehead"><div class="gs-pagehead-row"><div class="gs-pagehead-title"><div class="gs-pagehead-h"><h1 class="gs-h1" id="page-title" tabindex="-1">Roster</h1></div></div></div></header>' +
      G.ui.errorRegionHtml({ title: 'We couldn\'t load the roster.', text: text || 'The server didn\'t answer.', safe: 'Nothing you saved was lost.', retry: { variant: 'primary', size: undefined, attrs: { 'data-action': 'retry', 'data-key': 'roster-retry' } } }) + '</div>';
  }

  // ── the page ──
  // opts: { guildData, data (GET /roster?team=), view: { status, query }, notice, alert, shape (the recruiting read: { status, data, cov }), apps ({ status, list }) }
  function modelOf(opts) {
    const gd = opts.guildData;
    const data = opts.data || { people: [], team: {}, can: {} };
    const people = Array.isArray(data.people) ? data.people : [];
    const view = Object.assign({ status: 'active', query: '' }, opts.view || {});
    const teamId = data.team && data.team.id;
    const canEdit = !!(data.can && data.can.edit);
    const shapeRead = opts.shape && opts.shape.status === 'ready' ? opts.shape : null;
    const flags = gd.applicationFlags && teamId && Object.prototype.hasOwnProperty.call(gd.applicationFlags, teamId) ? Number(gd.applicationFlags[teamId]) : 0;
    return {
      gd: gd, gid: gd.guild.id, data: data, people: people, teamId: teamId, canEdit: canEdit, archived: !!(data.team && data.team.archived),
      status: view.status, query: String(view.query || ''), counts: countsOf(people),
      shape: canEdit && shapeRead ? shapeOf(shapeRead.data, shapeRead.cov) : null, shapeState: opts.shape ? opts.shape.status : 'loading',
      applicationCount: canEdit && isFinite(flags) && flags > 0 ? Math.floor(flags) : 0, apps: opts.apps || null,
    };
  }

  function rosterHtml(opts) {
    const gd = opts.guildData;
    const m = modelOf(opts);
    // A member has Active and Everyone only: a status only an officer's phone list knows falls back to Active.
    if (!m.canEdit && !MEMBER_SEGMENTS.some(function (s) { return s[0] === m.status; })) m.status = 'active';
    const notices = G.pages.rosterTabs.html(gd, 'roster') +
      (m.archived ? '<div class="gs-rs-note" role="note">' + G.icons.icon('info', 18) + '<span>' + esc((m.data.team.name || 'This team') + ' is archived. Its people stay listed, but no one can be added.') + '</span></div>' : '') +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span><button type="button" class="gs-linkbtn" data-action="dismiss-roster-notice" data-key="dismiss-roster-notice">Dismiss</button></div>' : '') +
      G.ui.alertHtml(opts.alert || '', 'gs-page-alert');
    if (!m.people.length) {
      return '<div class="gs-page gs-list-page gs-forge gs-roster-page">' + G.ui.pageHeadHtml(headOpts(gd, m.data, m)) + notices + emptyHtml(gd, m.data) + '</div>';
    }
    return '<div class="gs-page gs-list-page gs-forge gs-roster-page">' + G.ui.pageHeadHtml(headOpts(gd, m.data, m)) + notices + tilesHtml(m) + needsHtml(m) + youHtml(m) +
      '<section class="gs-rs-people" aria-label="People"><div class="gs-rs-bar">' + searchHtml(m) + deskSegsHtml(m) + phoneSegsHtml(m) + '</div>' +
      '<div id="roster-results" class="gs-rs-results" aria-live="off">' + resultsHtml(m) + '</div>' + footHtml(m) + '</section></div>';
  }

  // ── Add person dialog ──
  function selectHtml(id, name, label, optionsHtml, extra) {
    return '<div class="gs-field"><label class="gs-label" for="' + id + '">' + label + '</label><div class="gs-fg-selw"><select class="gs-input" id="' + id + '" name="' + name + '" data-field="' + name + '"' + (extra || '') + '>' + optionsHtml + '</select>' +
      G.icons.icon('chevronDown', 14) + '</div><p class="gs-field-error" id="dlg-err-' + name + '" role="alert" hidden></p></div>';
  }

  function teamFieldHtml(gd, selectedId, idPrefix) {
    const active = G.shell.activeTeams(gd.teams);
    if (active.length < 2) return '';
    return selectHtml(idPrefix + '-team', 'teamId', 'Team', G.ui.optionsHtml(active.map(function (t) { return { value: t.id, label: t.name }; }), selectedId), ' data-change="roster-team-change"');
  }

  function linkOptionsHtml(users, selected) {
    const items = [{ value: '', label: 'Not linked' }].concat((Array.isArray(users) ? users : []).map(function (u) {
      return { value: u.id, label: u.displayName + (u.username && u.username !== u.displayName ? ' (@' + u.username + ')' : '') };
    }));
    return G.ui.optionsHtml(items, selected);
  }

  // The team's trial length: the guild data's team first, then the team the roster read carried, else the default of 14.
  function trialDaysOf(gd, teamId, fallbackTeam) {
    const own = (gd.teams || []).filter(function (t) { return t.id === teamId; })[0];
    const candidates = [own, fallbackTeam];
    for (let i = 0; i < candidates.length; i++) {
      const n = Number(candidates[i] && candidates[i].trialDays);
      if (Number.isInteger(n) && n >= 1) return n;
    }
    return DEFAULT_TRIAL_DAYS;
  }

  function trialHelp(days, teamName) {
    return plural(days, 'day', 'days') + ' from today (' + teamName + '\'s trial length). Officers get a flag 7 days before.';
  }

  // opts: { guildData, teamId, team (the roster read's team), today, linkable: [person] }
  function addPersonDialogHtml(opts) {
    const gd = opts.guildData;
    const ro = G.ui.rosterOptions(gd);
    const teamRow = (gd.teams || []).filter(function (t) { return t.id === opts.teamId; })[0] || opts.team || {};
    const days = trialDaysOf(gd, opts.teamId, opts.team);
    const trialEnd = G.ui.addDays(opts.today, days);
    const statuses = ['raider', 'trial', 'reserve'];
    return '<form class="gs-dialog-form gs-forge gs-dialog-add" data-submit="add-person-form" data-gid="' + esc(gd.guild.id) + '" novalidate>' +
      '<div class="gs-dialog-head"><h2 class="gs-dialog-title" id="dlg-title">Add person</h2>' +
      '<p class="gs-fg-mut" id="dlg-help">Start with their Main character. Alts go on their record.</p></div>' +
      '<div class="gs-field"><label class="gs-label" for="dlg-name">Character name</label><input class="gs-input" type="text" id="dlg-name" name="name" data-field="name" maxlength="40" autocomplete="off" required>' +
      '<p class="gs-field-error" id="dlg-err-name" role="alert" hidden></p></div>' +
      '<div class="gs-rs-pair">' + selectHtml('dlg-class', 'class', 'Class', G.ui.classOptionsHtml(ro, '', 'Choose a class'), ' data-change="roster-class-change"') +
      selectHtml('dlg-mainspec', 'mainSpec', 'Main spec', G.ui.specOptionsHtml(ro, '', '', 'Not set'), ' data-change="roster-spec-change"') + '</div>' +
      '<p class="gs-fg-mut gs-rs-role" id="dlg-role" aria-live="polite" hidden></p>' +
      '<fieldset class="gs-fieldset gs-rs-status"><legend class="gs-label">Status</legend><div class="gs-fg-segs gs-rs-statusseg">' + statuses.map(function (s) {
        return '<input type="radio" class="gs-fg-radio" id="dlg-status-' + s + '" name="status" value="' + s + '"' + (s === 'trial' ? ' checked' : '') + ' data-change="roster-status-change"><label class="gs-fg-seg" for="dlg-status-' + s + '">' + esc(G.ui.statusLabel(s)) + '</label>';
      }).join('') + '</div></fieldset>' +
      '<div class="gs-field" id="dlg-trialend-field"><label class="gs-label" for="dlg-trialend">Trial ends</label><input class="gs-input" type="date" id="dlg-trialend" name="trialEnd" data-field="trialEnd" value="' + esc(trialEnd) + '" aria-describedby="dlg-trialend-help">' +
      '<p class="gs-fg-mut" id="dlg-trialend-help">' + esc(trialHelp(days, teamRow.name || '')) + '</p><p class="gs-field-error" id="dlg-err-trialEnd" role="alert" hidden></p></div>' +
      '<div class="gs-rs-more"><button type="button" class="gs-btn gs-btn-ghost gs-rs-morebtn" data-action="roster-more-details" data-key="roster-more-details" aria-expanded="false" aria-controls="dlg-more"><span>More details</span>' + G.icons.icon('chevronDown', 14) + '</button>' +
      '<div class="gs-rs-morebox" id="dlg-more" hidden>' +
      '<div class="gs-rs-pair">' + selectHtml('dlg-offspec', 'offSpec', 'Off spec', G.ui.specOptionsHtml(ro, '', '', 'None')) +
      '<div class="gs-field"><label class="gs-label" for="dlg-joined">Joined</label><input class="gs-input" type="date" id="dlg-joined" name="joinedOn" data-field="joinedOn" value="' + esc(opts.today) + '"><p class="gs-field-error" id="dlg-err-joinedOn" role="alert" hidden></p></div></div>' +
      '<div class="gs-rs-pair">' + teamFieldHtml(gd, opts.teamId, 'dlg') +
      selectHtml('dlg-link', 'linkUserId', 'Account', linkOptionsHtml(opts.linkable, ''), ' aria-describedby="dlg-link-help"') + '</div>' +
      '<p class="gs-fg-mut" id="dlg-link-help">Lists people who have signed in to Raidsmith and are not on the roster yet.</p></div></div>' +
      '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' +
      '<div class="gs-dialog-actions"><button type="button" class="gs-btn gs-btn-ghost" data-action="dialog-cancel">Cancel</button><button type="submit" class="gs-btn gs-btn-molten">Add person</button></div></form>';
  }

  // ── behaviour ──
  function st() { return G.app.state; }

  function rosterUi() {
    const s = st();
    if (!s.rosterUi) s.rosterUi = { status: 'active', query: '' };
    return s.rosterUi;
  }

  function currentGd() {
    const s = st();
    return s.currentGid ? s.guilds[s.currentGid] : null;
  }

  function isPhone() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 600px)').matches;
  }

  // The state's reads for the model: the recruiting answer (officers) and the applicants (the phone's segment) of the team on screen.
  function modelInputs() {
    const s = st();
    const gd = currentGd();
    if (!gd || !s.roster || !s.roster.data) return null;
    const teamId = s.roster.teamId;
    const shape = s.rosterShape && s.rosterShape.gid === gd.guild.id && s.rosterShape.teamId === teamId ? s.rosterShape : null;
    const apps = s.rosterApps && s.rosterApps.gid === gd.guild.id && s.rosterApps.teamId === teamId ? s.rosterApps : null;
    return { guildData: gd, data: s.roster.data, view: rosterUi(), shape: shape, apps: apps };
  }

  function refreshResults() {
    const host = typeof document !== 'undefined' ? document.getElementById('roster-results') : null;
    const inputs = modelInputs();
    if (!host || !inputs) return;
    host.innerHTML = resultsHtml(modelOf(inputs));
  }

  // GET /recruiting?team= for the officer's tiles and column targets: started with the page, drawn when it answers (a skeleton until then).
  function loadShape(gd, teamId, token, isCurrent) {
    const s = st();
    const gid = gd.guild.id;
    s.rosterShape = { gid: gid, teamId: teamId, status: 'loading' };
    return G.api.recruiting.get(gid, teamId).then(function (rec) {
      const cov = G.coverage.compute(rec.guild.gameVersion, rec.roster.specs, rec.team.size);
      if (s.rosterShape && s.rosterShape.gid === gid && s.rosterShape.teamId === teamId) s.rosterShape = { gid: gid, teamId: teamId, status: 'ready', data: rec, cov: cov };
    }, function () {
      if (s.rosterShape && s.rosterShape.gid === gid && s.rosterShape.teamId === teamId) s.rosterShape = { gid: gid, teamId: teamId, status: 'error' };
    }).then(function () {
      if (typeof isCurrent === 'function' && isCurrent(token)) G.app.render();
    });
  }

  function loadApplicants(gd, teamId) {
    const s = st();
    const gid = gd.guild.id;
    s.rosterApps = { gid: gid, teamId: teamId, status: 'loading', list: [] };
    return G.api.applications.list(gid, 'new', teamId).then(function (res) {
      if (s.rosterApps && s.rosterApps.gid === gid && s.rosterApps.teamId === teamId) s.rosterApps = { gid: gid, teamId: teamId, status: 'ready', list: Array.isArray(res && res.applications) ? res.applications : [] };
    }, function () {
      if (s.rosterApps && s.rosterApps.gid === gid && s.rosterApps.teamId === teamId) s.rosterApps = { gid: gid, teamId: teamId, status: 'error', list: [] };
    });
  }

  G.handlers.click['roster-seg'] = function (el) {
    const seg = el.getAttribute('data-seg');
    const known = PHONE_SEGMENTS.concat(MEMBER_SEGMENTS).some(function (s) { return s[0] === seg; });
    if (!known) return;
    const gd = currentGd();
    const s = st();
    rosterUi().status = seg;
    if (seg === 'applicants' && gd && s.roster && !(s.rosterApps && s.rosterApps.gid === gd.guild.id && s.rosterApps.teamId === s.roster.teamId && s.rosterApps.status === 'ready')) {
      loadApplicants(gd, s.roster.teamId).then(function () { G.app.render(); });
    }
    G.app.render();
  };
  G.handlers.input['roster-search'] = function (el) {
    rosterUi().query = el.value;
    refreshResults();
  };
  G.handlers.click['roster-clear-search'] = function () {
    rosterUi().query = '';
    G.app.render();
    if (typeof document !== 'undefined') { const input = document.getElementById('roster-search'); if (input) input.focus(); }
  };
  G.handlers.click['roster-show-inactive'] = function () {
    rosterUi().status = isPhone() ? 'inactive' : 'everyone';
    G.app.render();
  };
  G.handlers.click['dismiss-roster-notice'] = function () {
    st().rosterNotice = '';
    G.app.render();
  };

  function loadLinkable(gid) {
    const s = st();
    if (!s.linkable) s.linkable = {};
    if (s.linkable[gid]) return Promise.resolve(s.linkable[gid]);
    return G.api.get('/api/guild/' + encodeURIComponent(gid) + '/roster/linkable').then(function (res) {
      s.linkable[gid] = res && Array.isArray(res.users) ? res.users : [];
      return s.linkable[gid];
    }, function () { return []; });
  }
  G.pages.roster = G.pages.roster || {};
  G.pages.roster.loadLinkable = loadLinkable;

  G.handlers.click['roster-add'] = function () {
    const s = st();
    const gd = currentGd();
    if (!gd || !s.roster) return;
    loadLinkable(gd.guild.id).then(function (users) {
      if (G.router.parse(window.location.hash).name !== 'section') return; // the page changed while the list loaded
      G.ui.openDialog(addPersonDialogHtml({ guildData: gd, teamId: s.roster.data.team.id, team: s.roster.data.team, today: s.roster.data.today, linkable: users }), { labelledBy: 'dlg-title', describedBy: 'dlg-help' });
      const input = document.getElementById('dlg-name');
      if (input) input.focus();
    });
  };

  // The role line under Class and Main spec: "Role: Healer" once the spec is picked.
  function showRole(form) {
    const gd = currentGd();
    const line = document.getElementById('dlg-role');
    if (!gd || !form || !line) return;
    const label = G.ui.roleLabel(G.ui.roleOfSpec(G.ui.rosterOptions(gd), form.elements.class.value, form.elements.mainSpec.value));
    line.textContent = label ? 'Role: ' + label : '';
    line.hidden = !label;
  }

  // A class change resets both spec selects to the new class's specs.
  G.handlers.change['roster-class-change'] = function (el) {
    const gd = currentGd();
    const form = el.closest('form');
    if (!gd || !form) return;
    const ro = G.ui.rosterOptions(gd);
    form.elements.mainSpec.innerHTML = G.ui.specOptionsHtml(ro, el.value, '', 'Not set');
    form.elements.offSpec.innerHTML = G.ui.specOptionsHtml(ro, el.value, '', 'None');
    showRole(form);
  };
  G.handlers.change['roster-spec-change'] = function (el) { showRole(el.closest('form')); };

  G.handlers.change['roster-status-change'] = function (el) {
    const field = document.getElementById('dlg-trialend-field');
    if (field) field.hidden = el.value !== 'trial';
  };

  // Another team: the trial end follows that team's trial length.
  G.handlers.change['roster-team-change'] = function (el) {
    const gd = currentGd();
    const s = st();
    const form = el.closest('form');
    if (!gd || !form || !s.roster) return;
    const team = (gd.teams || []).filter(function (t) { return t.id === el.value; })[0];
    if (!team) return;
    const days = trialDaysOf(gd, team.id, team);
    form.elements.trialEnd.value = G.ui.addDays(s.roster.data.today, days);
    G.ui.announce('dlg-trialend-help', trialHelp(days, team.name));
  };

  G.handlers.click['roster-more-details'] = function (el) {
    const box = document.getElementById('dlg-more');
    if (!box) return;
    const open = el.getAttribute('aria-expanded') !== 'true';
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
    box.hidden = !open;
  };

  function openMore() {
    const btn = document.querySelector('[data-action="roster-more-details"]');
    if (btn && btn.getAttribute('aria-expanded') !== 'true') G.handlers.click['roster-more-details'](btn);
  }

  function dateOrNull(v) { return v ? v : null; }

  // The shared character fields (name, class, specs) as a request body piece, or an error string.
  function readCharacter(form) {
    const name = form.elements.name.value.trim();
    const cls = form.elements.class.value;
    const mainSpec = form.elements.mainSpec.value;
    const offSpec = form.elements.offSpec.value;
    G.ui.setText('dlg-err-name', '');
    G.ui.setText('dlg-err-class', '');
    G.ui.setText('dlg-err-offSpec', '');
    if (!name) { G.ui.setText('dlg-err-name', 'Enter a character name.'); form.elements.name.focus(); return null; }
    if (!cls) { G.ui.setText('dlg-err-class', 'Choose a class.'); form.elements.class.focus(); return null; }
    if (offSpec && offSpec === mainSpec) { openMore(); G.ui.setText('dlg-err-offSpec', 'Off spec must differ from main spec.'); form.elements.offSpec.focus(); return null; }
    return { name: name, class: cls, mainSpec: mainSpec || null, offSpec: offSpec || null };
  }

  G.pages.roster.readCharacter = readCharacter;

  G.handlers.submit['add-person-form'] = function (form) {
    const gid = form.getAttribute('data-gid');
    const s = st();
    G.ui.setText('dlg-error', '');
    const ch = readCharacter(form);
    if (!ch) return;
    const status = form.querySelector('input[name="status"]:checked').value;
    const body = Object.assign({}, ch, {
      teamId: form.elements.teamId ? form.elements.teamId.value : s.roster.data.team.id,
      status: status,
      joinedOn: dateOrNull(form.elements.joinedOn.value),
      trialEnd: status === 'trial' ? dateOrNull(form.elements.trialEnd.value) : null,
      linkUserId: form.elements.linkUserId.value || null,
    });
    G.ui.runDialog(form, G.api.post('/api/guild/' + encodeURIComponent(gid) + '/roster', body), function (res) {
      G.app.applyFlags(gid, res);
      if (s.linkable) delete s.linkable[gid];
      if (res && res.person && res.person.id) {
        G.app.setPerson(gid, res);
        G.app.go(personHref(gid, res.person.id));
      } else {
        G.app.go(G.router.format({ name: 'section', gid: gid, section: 'roster' }));
      }
    });
  };

  Object.assign(G.pages.roster, {
    DEFAULT_TRIAL_DAYS: DEFAULT_TRIAL_DAYS,
    ROLE_TITLES: ROLE_TITLES,
    rosterHtml: rosterHtml,
    resultsHtml: function (opts) { return resultsHtml(modelOf(opts)); },
    tilesHtml: function (opts) { return tilesHtml(modelOf(opts)); },
    needsHtml: function (opts) { return needsHtml(modelOf(opts)); },
    contextText: contextText,
    countsOf: countsOf,
    shapeOf: shapeOf,
    missingLine: missingLine,
    emptyHtml: emptyHtml,
    noTeamHtml: noTeamHtml,
    skeletonHtml: skeletonHtml,
    errorHtml: errorHtml,
    addPersonDialogHtml: addPersonDialogHtml,
    teamFieldHtml: teamFieldHtml,
    linkOptionsHtml: linkOptionsHtml,
    personHref: personHref,
    importHref: importHref,
    importItems: importItems,
    importMenuHtml: function (gid) { return G.ui.menuHtml({ id: 'roster-more', label: 'More', items: importItems(gid) }); },
    loadShape: loadShape,
    loadApplicants: loadApplicants,
  });
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
