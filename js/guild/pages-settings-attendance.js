// ── PAGE: GUILD SETTINGS > ATTENDANCE (the policy form) ─────────
// A stored policy is an OVERRIDE object: only the keys set at that level. This page edits one level at a time
// ("Guild default" or one team) as a draft override, says "Guild default" / "Changed for this team" (+ Reset) per key in a team scope, and
// saves with PUT /attendance/policy { teamId | null, policy, expectedVersion }. A Warcraft Logs card saves the guild ID
// and each team's uploader names with PUT /attendance/wcl. GET /attendance/policy feeds both.
// The Watch list group edits `watch: { below, dropBy }`: fractions 0..1 in the policy, typed as percent (blank = that check is off, stored as null).
// The Rank ladder group (PM wave 7, guild default only) edits `ladder: { ranks: [{ id, name, rules }] }`: ranks lowest first; each rank after the first has the
// rules for earning it (see worker/rank-ladder.js). A rank's id is made from its first name and never changes, since people carry it.
(function (G) {
  'use strict';

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const CREDIT_MIN = 2;
  const CREDIT_MAX = 5;
  const UPLOADERS_MAX = 10;
  const RANK_MIN = 2;
  const RANK_MAX = 6;
  const RANK_NAME_MAX = 20;
  // The number rules of a rank: the key, its label, and the largest number the Worker takes.
  const RANK_RULES = [
    { key: 'minRaids', label: 'Raids attended, at least', max: 1000 },
    { key: 'minWeeksAttended', label: 'Raid weeks attended, at least', max: 104 },
    { key: 'minWeeksSinceJoin', label: 'Weeks since joining, at least', max: 520 },
    { key: 'maxMissed', label: 'Missed without notice (main window), at most', max: 100 },
  ];
  const STARTER_LADDER = [
    { id: 'member', name: 'Member', rules: {} },
    { id: 'raider', name: 'Raider', rules: { minAttendance: 0.75, minWeeksAttended: 2, since: 'join' } },
  ];
  // Keys that change stored outcomes: a save touching one of these can leave raids stale.
  const CONSOLIDATION_ROOTS = ['expected', 'noSignup', 'tentative', 'absence', 'bench', 'lateSignup', 'detection', 'credit', 'fillIn', 'resetDay'];

  const RADIO = 'radio';
  // The page is three sections with anchors (design framework T3) and one Save bar; every group sits in one of them.
  const SECTIONS = [
    { id: 'att-present', title: 'What counts as attended', blurb: 'Who is expected at a raid, and how sign-ups and fill-ins count.' },
    { id: 'att-late', title: 'Late and bench rules', blurb: 'How late and early leavers and the bench are credited.' },
    { id: 'att-review', title: 'Review and watch list', blurb: 'The windows attendance is worked out over, who is flagged, ranks and the weekly reset.' },
  ];
  const GROUPS = [
    { id: 'expected', section: 'att-present', title: 'Who is expected', fields: [
      { path: 'expected.mode', type: RADIO, label: 'Expected to attend', options: [['signedUp', 'Signed-up only'], ['statuses', 'Roster statuses']] },
      { path: 'expected.statuses', type: 'checks', label: 'Roster statuses expected', options: [['raider', 'Raider'], ['trial', 'Trial'], ['reserve', 'Reserve']], when: function (v) { return v('expected.mode') === 'statuses'; },
        help: 'Someone with one of these statuses who did not sign up counts as Missed.' },
      { path: 'noSignup', type: RADIO, label: 'No sign-up', options: [['shown', 'Shown, not counted in %'], ['hidden', 'Not shown']], help: 'A roster person who is not expected, did not sign up and was not in the log.' },
    ] },
    { id: 'signups', section: 'att-present', title: 'Sign-up handling', fields: [
      { path: 'tentative', type: RADIO, label: 'Tentative', options: [['asNoSignup', 'Same as no sign-up'], ['asSignedUp', 'Counts as signed up']] },
      { path: 'absence', type: RADIO, label: 'Absence', options: [['missedWithNotice', 'Missed, with notice'], ['excused', 'Left out of the %']] },
      { path: 'lateSignup', type: RADIO, label: 'Late sign-up', options: [['fullCreditNoFlag', 'Full credit if they arrive late (leaving early is still flagged)'], ['flagLikeOthers', 'Flag for review like anyone else']] },
    ] },
    { id: 'fillin', section: 'att-present', title: 'Fill-ins', fields: [
      { path: 'fillIn', type: RADIO, label: 'Raiding with another team', options: [['always', 'Always credit the home team (replaces a missed cell that day)'], ['homeIfNoRaid', 'Credit the home team only if it had no raid that day'], ['recordOnly', 'Record only, never counted']] },
    ] },
    { id: 'bench', section: 'att-late', title: 'Bench', fields: [
      { path: 'bench', type: RADIO, label: 'Bench (plan or sign-up)', options: [['full', 'Full credit'], ['excluded', 'Left out of the %']] },
    ] },
    { id: 'late', section: 'att-late', title: 'Late and left early', fields: [
      { path: 'detection.mode', type: 'fixed', label: 'Detection', text: 'Missed the raid\'s first or last boss pull (wipes count, all of the raid\'s logs together). Other ways to detect it are not built yet.' },
    ] },
    { id: 'credit', section: 'att-late', title: 'Credit values', fields: [
      { path: 'credit.values', type: 'credits', label: 'Credit values the officer can pick for Late and Left early', help: '2 to 5 values. A value is 0 to 100 percent.' },
    ] },
    { id: 'windows', section: 'att-review', title: 'Windows', fields: [
      { path: 'window.defaultWeeks', type: 'number', label: 'Main window (full reset weeks)', min: 1, max: 52 },
      { path: 'window.switchWeeks', type: 'list', label: 'Window choices on the Attendance page', help: 'Up to 3 week counts, separated by commas. Must include the main window. "All time" is always offered.' },
      { path: 'effectiveStart', type: RADIO, label: 'When a person\'s raids start to count', options: [['laterOfJoinAndFirst', 'Later of join date and first attended raid'], ['joinDate', 'Join date']] },
      { path: 'streakFlagAt', type: 'number', label: 'Highlight a missed-raid streak of', min: 0, max: 20, help: '0 turns the highlight off.' },
    ] },
    { id: 'watch', section: 'att-review', title: 'Watch list', fields: [
      { path: 'watch.below', type: 'percent', label: 'Flag people below (percent)', min: 0, max: 100,
        help: 'The team\'s Attendance page lists people whose attendance in the main window is under this. Leave it empty to turn this check off.' },
      { path: 'watch.dropBy', type: 'percent', label: 'Flag a drop of (points)', min: 0, max: 100,
        help: 'Also lists people whose attendance fell by at least this many percentage points against the previous window of the same length. Leave it empty to turn this check off.' },
    ] },
    { id: 'ladder', section: 'att-review', title: 'Rank ladder', fields: [
      { path: 'ladder.ranks', type: 'ladder', label: 'Ranks, lowest first', guildOnly: true,
        guildNote: 'The rank ladder belongs to the whole guild, since a rank is a label on the person. Change it on the Guild default.',
        help: 'Optional. The ladder only suggests: the team\'s Attendance page and Home show "Suggested: promote" or "Suggested: review", and an officer accepts it with one click or dismisses it for 30 days. Everyone starts on the first rank. A rank with no rules is only given by hand.' },
    ] },
    { id: 'reset', section: 'att-review', title: 'Reset day', fields: [
      { path: 'resetDay', type: 'reset', label: 'Weekly reset', guildOnly: true },
    ] },
  ];

  function A() { return G.pages.attendance; }
  function st() { return G.app.state; }
  function a() { return A().attState(); }
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }
  function currentGd() { const s = st(); return s.currentGid ? s.guilds[s.currentGid] : null; }
  function fid(path) { return path.replace(/\./g, '-'); }
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function same(x, y) { return JSON.stringify(x) === JSON.stringify(y); }

  // ── override-object paths ──
  function getPath(o, path) {
    let cur = o;
    const keys = path.split('.');
    for (let i = 0; i < keys.length; i++) {
      if (!cur || typeof cur !== 'object' || !has(cur, keys[i])) return undefined;
      cur = cur[keys[i]];
    }
    return cur;
  }

  function setPath(o, path, v) {
    const keys = path.split('.');
    let cur = o;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object' || Array.isArray(cur[keys[i]])) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = v;
  }

  // Removes a key and any parent object left empty.
  function delPath(o, path) {
    const keys = path.split('.');
    const chain = [o];
    for (let i = 0; i < keys.length - 1; i++) {
      const next = chain[chain.length - 1][keys[i]];
      if (!next || typeof next !== 'object') return;
      chain.push(next);
    }
    delete chain[chain.length - 1][keys[keys.length - 1]];
    for (let i = chain.length - 1; i > 0; i--) {
      if (Object.keys(chain[i]).length) break;
      delete chain[i - 1][keys[i - 1]];
    }
  }

  // The guild default scope stores only what differs from the built-in defaults.
  function pruneToDifferences(draft, defaults) {
    const out = {};
    Object.keys(draft).forEach(function (k) {
      const v = draft[k];
      const d = defaults ? defaults[k] : undefined;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const sub = pruneToDifferences(v, d && typeof d === 'object' ? d : {});
        if (Object.keys(sub).length) out[k] = sub;
      } else if (!same(v, d)) {
        out[k] = v;
      }
    });
    return out;
  }

  function flattenPaths(o, prefix, out) {
    Object.keys(o || {}).forEach(function (k) {
      const p = prefix ? prefix + '.' + k : k;
      if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) flattenPaths(o[k], p, out); else out[p] = o[k];
    });
    return out;
  }

  // Whether going from override `before` to `after` can change stored outcomes (so raids may need recalculating).
  function changesConsolidation(before, after) {
    const x = flattenPaths(before, '', {});
    const y = flattenPaths(after, '', {});
    const paths = Object.keys(x).concat(Object.keys(y));
    return paths.some(function (p) {
      return CONSOLIDATION_ROOTS.indexOf(p.split('.')[0]) >= 0 && !same(x[p], y[p]);
    });
  }

  // Value of one key in the scope being edited, and whether this level sets it.
  function effective(view, scope, draft, path) {
    const own = getPath(draft, path);
    if (own !== undefined) return { value: own, overridden: true };
    let v;
    if (scope !== 'guild') v = getPath(view.guild || {}, path);
    if (v === undefined) v = getPath(view.defaults || {}, path);
    return { value: v, overridden: false };
  }

  function creditIdFor(label, taken) {
    let base = String(label || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);
    if (base.length < 2) base = 'value';
    let id = base;
    let n = 0;
    while (taken.indexOf(id) >= 0) { id = base.slice(0, 11) + String.fromCharCode(97 + (n % 26)); n++; if (n > 60) break; }
    return id;
  }

  // ── view ──
  // Where the value comes from, as muted text (no chip): the guild's, or changed for this team with its Reset (the same pol-reset action).
  function chipsOf(scope, eff, field) {
    if (scope === 'guild' || field.guildOnly) return '';
    if (!eff.overridden) return '<span class="gs-pol-src">Guild default</span>';
    return '<span class="gs-pol-src is-over">Changed for this team</span>' +
      '<button type="button" class="gs-btn gs-btn-ghost gs-btn-sm gs-pol-reset" data-action="pol-reset" data-path="' + esc(field.path) + '" data-key="pol-reset-' + esc(fid(field.path)) + '">Reset</button>';
  }

  function fieldShellHtml(field, scope, eff, inner) {
    const id = fid(field.path);
    return '<fieldset class="gs-fieldset gs-pol-field" id="pf-' + id + '"><legend class="gs-legend">' + esc(field.label) + '</legend>' +
      '<div class="gs-pol-markers">' + chipsOf(scope, eff, field) + '</div>' + inner +
      (field.help ? '<p class="gs-fine" id="phelp-' + id + '">' + esc(field.help) + '</p>' : '') + '<p class="gs-field-error" id="perr-' + id + '" role="alert" hidden></p></fieldset>';
  }

  function radioHtml(field, eff) {
    const id = fid(field.path);
    return '<div class="gs-radios">' + field.options.map(function (o, i) {
      return '<div class="gs-check"><input type="radio" id="p-' + id + '-' + i + '" name="p-' + id + '" value="' + esc(o[0]) + '"' + (eff.value === o[0] ? ' checked' : '') +
        ' data-change="pol-change" data-type="radio" data-path="' + esc(field.path) + '" data-key="p-' + id + '-' + i + '"><label for="p-' + id + '-' + i + '">' + esc(o[1]) + '</label></div>';
    }).join('') + '</div>';
  }

  function checksHtml(field, eff) {
    const id = fid(field.path);
    const set = Array.isArray(eff.value) ? eff.value : [];
    return '<div class="gs-radios">' + field.options.map(function (o, i) {
      return '<div class="gs-check"><input type="checkbox" id="p-' + id + '-' + i + '" value="' + esc(o[0]) + '"' + (set.indexOf(o[0]) >= 0 ? ' checked' : '') +
        ' data-change="pol-change" data-type="checks" data-path="' + esc(field.path) + '" data-key="p-' + id + '-' + i + '"><label for="p-' + id + '-' + i + '">' + esc(o[1]) + '</label></div>';
    }).join('') + '</div>';
  }

  function numberHtml(field, eff) {
    const id = fid(field.path);
    return '<input class="gs-input gs-input-short" type="number" id="p-' + id + '" min="' + field.min + '" max="' + field.max + '" step="1" value="' + esc(eff.value) + '" data-change="pol-change" data-type="number" data-path="' + esc(field.path) + '" data-key="p-' + id + '" aria-label="' + esc(field.label) + '"' + (field.help ? ' aria-describedby="phelp-' + id + '"' : '') + '>';
  }

  // A fraction in the policy (0.75) shown as percent (75); a blank box is null (the check is off). One decimal is kept (12.5).
  function percentOf(fraction) {
    return typeof fraction === 'number' && isFinite(fraction) ? Math.round(fraction * 1000) / 10 : '';
  }

  // The other way: typed percent -> fraction. Rounding through tenths of a percent keeps 75 as exactly 0.75 (no 0.7500000000000001).
  function fractionOf(text) {
    if (text === '' || text == null) return null;
    const n = Number(text);
    return isFinite(n) ? Math.round(n * 10) / 1000 : null;
  }

  function percentHtml(field, eff) {
    const id = fid(field.path);
    return '<input class="gs-input gs-input-short" type="number" id="p-' + id + '" min="' + field.min + '" max="' + field.max + '" step="0.1" placeholder="Off" value="' + esc(percentOf(eff.value)) + '" data-change="pol-change" data-type="percent" data-path="' + esc(field.path) + '" data-key="p-' + id + '" aria-label="' + esc(field.label) + '"' + (field.help ? ' aria-describedby="phelp-' + id + '"' : '') + '>';
  }

  function listHtml(field, eff) {
    const id = fid(field.path);
    return '<input class="gs-input gs-input-short" type="text" id="p-' + id + '" value="' + esc((Array.isArray(eff.value) ? eff.value : []).join(', ')) + '" data-change="pol-change" data-type="list" data-path="' + esc(field.path) + '" data-key="p-' + id + '" aria-label="' + esc(field.label) + '" aria-describedby="phelp-' + id + '">';
  }

  function creditsHtml(field, eff) {
    const values = Array.isArray(eff.value) ? eff.value : [];
    return '<ul class="gs-credit-list">' + values.map(function (v, i) {
      return '<li class="gs-credit-row"><label class="gs-sr" for="pc-l-' + i + '">Label ' + (i + 1) + '</label><input class="gs-input" type="text" id="pc-l-' + i + '" value="' + esc(v.label) + '" maxlength="12" data-change="pol-credit" data-idx="' + i + '" data-field="label" data-key="pc-l-' + i + '">' +
        '<label class="gs-sr" for="pc-v-' + i + '">Percent ' + (i + 1) + '</label><input class="gs-input gs-input-short" type="number" id="pc-v-' + i + '" min="0" max="100" step="5" value="' + esc(Math.round(v.value * 100)) + '" data-change="pol-credit" data-idx="' + i + '" data-field="value" data-key="pc-v-' + i + '"><span class="gs-fine">%</span>' +
        '<span class="gs-row-actions"><button type="button" class="gs-icon-btn" data-action="pol-credit-move" data-idx="' + i + '" data-dir="-1" data-key="pc-up-' + i + '" aria-label="Move ' + esc(v.label) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + G.icons.icon('chevronDown', 18).replace('class="gs-icon"', 'class="gs-icon gs-flip"') + '</button>' +
        '<button type="button" class="gs-icon-btn" data-action="pol-credit-move" data-idx="' + i + '" data-dir="1" data-key="pc-dn-' + i + '" aria-label="Move ' + esc(v.label) + ' down"' + (i === values.length - 1 ? ' disabled' : '') + '>' + G.icons.icon('chevronDown', 18) + '</button>' +
        '<button type="button" class="gs-icon-btn gs-icon-btn-danger" data-action="pol-credit-remove" data-idx="' + i + '" data-key="pc-rm-' + i + '" aria-label="Remove ' + esc(v.label) + '"' + (values.length <= CREDIT_MIN ? ' disabled' : '') + '>' + G.icons.icon('trash', 18) + '</button></span></li>';
    }).join('') + '</ul><div><button type="button" class="gs-btn gs-btn-sm" data-action="pol-credit-add" data-key="pc-add"' + (values.length >= CREDIT_MAX ? ' disabled' : '') + '>Add value</button></div>';
  }

  // ── the rank ladder editor ──
  function rankRowHtml(rank, i, count) {
    const rules = rank.rules && typeof rank.rules === 'object' ? rank.rules : {};
    const first = i === 0;
    const num = function (key, label, max) {
      const id = 'pr-' + key + '-' + i;
      return '<div class="gs-rank-rule"><label class="gs-label" for="' + id + '">' + esc(label) + '</label><input class="gs-input gs-input-short" type="number" id="' + id + '" min="0" max="' + max + '" step="1" placeholder="Off" value="' +
        esc(typeof rules[key] === 'number' ? rules[key] : '') + '" data-change="pol-rank" data-idx="' + i + '" data-field="' + key + '" data-key="' + id + '"></div>';
    };
    const percentId = 'pr-minAttendance-' + i;
    const since = rules.since === 'rank' ? 'rank' : 'join';
    const body = first
      ? '<p class="gs-fine">Everyone starts here.</p>'
      : '<div class="gs-rank-rules"><p class="gs-fine">To earn ' + esc(rank.name || 'this rank') + ', a person needs all of these that are set (leave a box empty to turn that rule off):</p>' +
        '<div class="gs-rank-rule"><label class="gs-label" for="' + percentId + '">Attendance in the main window, at least (percent)</label><input class="gs-input gs-input-short" type="number" id="' + percentId + '" min="0" max="100" step="0.1" placeholder="Off" value="' +
        esc(percentOf(rules.minAttendance)) + '" data-change="pol-rank" data-idx="' + i + '" data-field="minAttendance" data-key="' + percentId + '"></div>' +
        RANK_RULES.map(function (r) { return num(r.key, r.label, r.max); }).join('') +
        '<div class="gs-rank-rule"><label class="gs-label" for="pr-since-' + i + '">Count raids and weeks from</label><select class="gs-input" id="pr-since-' + i + '" data-change="pol-rank" data-idx="' + i + '" data-field="since" data-key="pr-since-' + i + '">' +
        G.ui.optionsHtml([{ value: 'join', label: 'When they joined' }, { value: 'rank', label: 'When they got the rank before this one' }], since) + '</select></div></div>';
    return '<li class="gs-rank-row"><div class="gs-rank-head"><label class="gs-sr" for="pr-n-' + i + '">Name of rank ' + (i + 1) + '</label>' +
      '<input class="gs-input" type="text" id="pr-n-' + i + '" value="' + esc(rank.name) + '" maxlength="' + RANK_NAME_MAX + '" data-change="pol-rank" data-idx="' + i + '" data-field="name" data-key="pr-n-' + i + '">' +
      '<span class="gs-row-actions"><button type="button" class="gs-icon-btn" data-action="pol-rank-move" data-idx="' + i + '" data-dir="-1" data-key="pr-up-' + i + '" aria-label="Move ' + esc(rank.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>' + G.icons.icon('chevronDown', 18).replace('class="gs-icon"', 'class="gs-icon gs-flip"') + '</button>' +
      '<button type="button" class="gs-icon-btn" data-action="pol-rank-move" data-idx="' + i + '" data-dir="1" data-key="pr-dn-' + i + '" aria-label="Move ' + esc(rank.name) + ' down"' + (i === count - 1 ? ' disabled' : '') + '>' + G.icons.icon('chevronDown', 18) + '</button>' +
      '<button type="button" class="gs-icon-btn gs-icon-btn-danger" data-action="pol-rank-remove" data-idx="' + i + '" data-key="pr-rm-' + i + '" aria-label="Remove ' + esc(rank.name) + '"' + (count <= RANK_MIN ? ' disabled' : '') + '>' + G.icons.icon('trash', 18) + '</button></span></div>' + body + '</li>';
  }

  function ladderHtml(field, eff) {
    const ranks = Array.isArray(eff.value) ? eff.value : [];
    if (!ranks.length) {
      return '<p class="gs-fine" id="pr-none">No ladder yet. Start with Member and Raider and add the ranks your guild uses.</p>' +
        '<div><button type="button" class="gs-btn gs-btn-sm" data-action="pol-rank-start" data-key="pr-start">Start a ladder</button></div>';
    }
    return '<ol class="gs-rank-list">' + ranks.map(function (r, i) { return rankRowHtml(r, i, ranks.length); }).join('') + '</ol>' +
      '<div class="gs-actions"><button type="button" class="gs-btn gs-btn-sm" data-action="pol-rank-add" data-key="pr-add"' + (ranks.length >= RANK_MAX ? ' disabled' : '') + '>Add rank</button>' +
      '<button type="button" class="gs-btn gs-btn-sm" data-action="pol-rank-off" data-key="pr-off">Turn the ladder off</button></div>';
  }

  function resetDayHtml(field, eff, view) {
    const derived = view.resetDayDerived;
    const derivedName = typeof derived === 'number' && WEEKDAYS[derived] ? WEEKDAYS[derived] : (derived != null ? String(derived) : '');
    const v = eff.value == null ? '' : String(eff.value);
    const opts = [{ value: '', label: 'From the guild\'s region' + (derivedName ? ' (' + derivedName + ')' : '') }].concat(WEEKDAYS.map(function (d, i) { return { value: String(i), label: d }; }));
    return '<select class="gs-input gs-input-short" id="p-resetDay" data-change="pol-change" data-type="resetday" data-path="resetDay" data-key="p-resetDay" aria-label="' + esc(field.label) + '">' + G.ui.optionsHtml(opts, v) + '</select>';
  }

  function fieldHtml(field, view, scope, draft) {
    const eff = effective(view, scope, draft, field.path);
    const get = function (p) { return effective(view, scope, draft, p).value; };
    if (field.when && !field.when(get)) return '';
    if (field.guildOnly && scope !== 'guild') {
      return fieldShellHtml(field, scope, eff, '<p class="gs-fine">' + esc(field.guildNote || 'Set for the whole guild, so a reset week means the same for every team. Change it on the Guild default.') + '</p>');
    }
    let inner;
    switch (field.type) {
      case RADIO: inner = radioHtml(field, eff); break;
      case 'checks': inner = checksHtml(field, eff); break;
      case 'number': inner = numberHtml(field, eff); break;
      case 'percent': inner = percentHtml(field, eff); break;
      case 'list': inner = listHtml(field, eff); break;
      case 'credits': inner = creditsHtml(field, eff); break;
      case 'reset': inner = resetDayHtml(field, eff, view); break;
      case 'ladder': inner = ladderHtml(field, eff); break;
      default: inner = '<p class="gs-fine">' + esc(field.text) + '</p>';
    }
    return fieldShellHtml(field, scope, eff, inner);
  }

  function groupHtml(g, view, scope, draft) {
    const fields = g.fields.map(function (f) { return fieldHtml(f, view, scope, draft); }).join('');
    return '<section class="gs-att-grp" aria-labelledby="pg-' + g.id + '"><h3 class="gs-att-gh" id="pg-' + g.id + '">' + esc(g.title) + '</h3>' + fields + '</section>';
  }

  // One headed section of the page: its blurb, then the group cards that belong to it (the section is a jump target of "On this page").
  function sectionHtml(sec, view, scope, draft) {
    const cards = GROUPS.filter(function (g) { return g.section === sec.id; }).map(function (g) { return groupHtml(g, view, scope, draft); }).join('');
    return '<section class="gs-att-section" id="' + sec.id + '" tabindex="-1" aria-labelledby="' + sec.id + '-h"><h2 class="gs-hd-sl" id="' + sec.id + '-h">' + esc(sec.title) + '</h2>' +
      '<p class="gs-fine">' + esc(sec.blurb) + '</p><div class="gs-hd-panel">' + cards + '</div></section>';
  }

  // "On this page": one jump link per section (and the Warcraft Logs card below the form).
  function onPageHtml() {
    const items = SECTIONS.concat([{ id: 'att-wcl', title: 'Warcraft Logs' }]);
    return '<nav class="gs-onpage-nav" aria-label="On this page"><ul class="gs-onpage"><li class="gs-onpage-label">On this page</li>' + items.map(function (sec) {
      return '<li><a href="#' + sec.id + '" data-action="jump" data-target="' + sec.id + '">' + esc(sec.title) + '</a></li>';
    }).join('') + '</ul></nav>';
  }

  function uploadersText(view, tid) {
    const list = view.wcl && view.wcl.uploaders && Array.isArray(view.wcl.uploaders[tid]) ? view.wcl.uploaders[tid] : [];
    return list.join('\n');
  }

  function wclCardHtml(gd, view, wclUi) {
    const teams = G.shell.activeTeams(gd.teams);
    const gid = view.wcl && view.wcl.guildId != null ? view.wcl.guildId : '';
    const fields = teams.map(function (t) {
      const val = wclUi && wclUi.uploaders && has(wclUi.uploaders, t.id) ? wclUi.uploaders[t.id] : uploadersText(view, t.id);
      return '<div class="gs-field"><label class="gs-label" for="wcl-up-' + esc(t.id) + '">Uploaders for ' + esc(t.name) + '</label><textarea class="gs-input gs-textarea" id="wcl-up-' + esc(t.id) + '" data-tid="' + esc(t.id) + '" rows="2" aria-describedby="wcl-up-help">' + esc(val) + '</textarea></div>';
    }).join('');
    return '<section class="gs-att-section gs-att-wcl" id="att-wcl" tabindex="-1" aria-labelledby="pg-wcl"><h2 class="gs-hd-sl" id="pg-wcl">Warcraft Logs</h2>' +
      '<form class="gs-hd-panel gs-att-grp gs-wcl-form" data-submit="wcl-form" novalidate>' +
      '<div class="gs-field"><label class="gs-label" for="wcl-guild">Warcraft Logs guild ID (optional)</label><input class="gs-input gs-input-short" type="text" inputmode="numeric" id="wcl-guild" value="' + esc(wclUi && wclUi.guildId != null ? wclUi.guildId : gid) + '" aria-describedby="wcl-guild-help">' +
      '<p class="gs-fine" id="wcl-guild-help">Leave it empty to look the guild up by its name and realm.</p></div>' + fields +
      '<p class="gs-fine" id="wcl-up-help">One character name per line, at most ' + UPLOADERS_MAX + ' per team. The backfill list can filter to reports these people uploaded.</p>' +
      '<p class="gs-alert" id="wcl-error" role="alert" hidden></p><p class="gs-fine" id="wcl-ok" role="status" hidden></p>' +
      '<div class="gs-actions"><button type="submit" class="gs-btn gs-btn-sm">Save Warcraft Logs settings</button></div><p class="gs-fine">Saved on its own, apart from the rules above.</p></form></section>';
  }

  // How many settings differ from what is saved at this level (the Save bar's count). The guild default stores only what differs from the built-in rules.
  function normalized(s, o) { return s.scope === 'guild' ? pruneToDifferences(o, s.view.defaults || {}) : o; }
  function changeCount(s) { return G.ui.saveBar.draftChanges(normalized(s, overrideFor(s.view, s.scope)), normalized(s, s.draft)); }

  // opts: { guildData, s: { view, scope, draft, wclUi, stale: n }, alert, notice, progress }
  function settingsHtml(opts) {
    const gd = opts.guildData;
    const s = opts.s;
    const view = s.view;
    const teams = G.shell.activeTeams(gd.teams);
    const scopeOpts = [{ value: 'guild', label: 'Guild default' }].concat(teams.map(function (t) { return { value: t.id, label: t.name + ' override' }; }));
    const scopeField = '<div class="gs-roster-status"><label class="gs-label" for="pol-scope">Applies to</label><select class="gs-input" id="pol-scope" data-change="pol-scope" data-key="pol-scope">' + G.ui.optionsHtml(scopeOpts, s.scope) + '</select></div>';
    const scopeNote = s.scope === 'guild'
      ? '<p class="gs-fine">These rules apply to every team unless a team has its own override.</p>'
      : '<p class="gs-fine">Only the rules marked "Changed for this team" differ from the guild default. Everything else follows it.</p>';
    return '<div class="gs-settings-att">' + scopeField + scopeNote + G.ui.alertHtml(opts.alert || '', 'gs-page-alert') +
      (opts.notice ? '<div class="gs-notice" role="status"><span>' + esc(opts.notice) + '</span></div>' : '') +
      (s.stale > 0 || (opts.progress && opts.progress.running)
        ? (opts.progress && opts.progress.running
          ? '<div class="gs-notice" role="status"><span>Recalculating ' + esc(opts.progress.done) + ' of ' + esc(opts.progress.total) + '...</span></div>'
          : '<div class="gs-notice gs-stale-banner" role="status"><span>The rules changed under ' + esc(A().plural(s.stale, 'raid', 'raids')) + '. Their stored results are from before the change.</span><button type="button" class="gs-btn gs-btn-sm" data-action="pol-recalc" data-key="pol-recalc">Recalculate ' + esc(A().plural(s.stale, 'raid', 'raids')) + '</button></div>') : '') +
      onPageHtml() +
      '<form class="gs-pol-form" id="pol-form" data-submit="pol-form" novalidate>' + SECTIONS.map(function (sec) { return sectionHtml(sec, view, s.scope, s.draft); }).join('') +
      '<p class="gs-fine">Changes apply to all raids; past officer decisions are kept.</p><p class="gs-alert" id="pol-error" role="alert" hidden></p>' +
      '<div class="gs-actions"><button type="button" class="gs-btn" data-action="pol-reset-all" data-key="pol-reset-all">' + (s.scope === 'guild' ? 'Reset to defaults' : 'Remove the team override') + '</button></div>' +
      G.ui.saveBarHtml({ count: changeCount(s), discardAttrs: { 'data-action': 'pol-discard', 'data-key': 'pol-discard' } }) + '</form>' +
      wclCardHtml(gd, view, s.wclUi) + '</div>';
  }

  // ── data ──
  function overrideFor(view, scope) {
    return clone(scope === 'guild' ? view.guild : (view.teams && view.teams[scope])) || {};
  }

  function versionFor(view, scope) {
    const v = scope === 'guild' ? view.versions && view.versions.guild : view.versions && view.versions.teams && view.versions.teams[scope];
    return typeof v === 'number' ? v : 0;
  }

  function adopt(gid, view, scope, keep) {
    const prev = a().settingsAtt;
    a().settingsAtt = { gid: gid, view: view, scope: scope, draft: overrideFor(view, scope), wclUi: null, stale: keep && prev ? prev.stale : 0 };
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    a().policy = a().policy || {};
    return G.api.get(A().apiBase(gid) + '/attendance/policy').then(function (view) {
      a().policy[gid] = view;
      const prev = a().settingsAtt;
      const scope = prev && prev.gid === gid && prev.scope && (prev.scope === 'guild' || (view.resolved && view.resolved[prev.scope])) ? prev.scope : 'guild';
      adopt(gid, view, scope, false);
      return null;
    });
  }

  function main(r, gd, ctx) {
    const s = a().settingsAtt;
    if (!s || s.gid !== gd.guild.id) return G.ui.settingsLoadingHtml();
    return G.shell.settingsFrameHtml(ctx, 'attendance', settingsHtml({ guildData: gd, s: s, alert: st().pageAlert, notice: a().polNotice, progress: a().recalc }));
  }

  function cur() { const s = a().settingsAtt; return s && currentGd() ? s : null; }

  // ── handlers ──
  G.handlers.change['pol-scope'] = function (el) {
    const s = cur();
    if (!s) return;
    s.scope = el.value;
    s.draft = overrideFor(s.view, s.scope);
    a().polNotice = '';
    st().pageAlert = '';
    G.app.render();
  };

  G.handlers.change['pol-change'] = function (el) {
    const s = cur();
    if (!s) return;
    const path = el.getAttribute('data-path');
    const type = el.getAttribute('data-type');
    let v;
    if (type === 'radio') v = el.value;
    else if (type === 'number') v = el.value === '' ? null : Number(el.value);
    else if (type === 'percent') v = fractionOf(el.value);
    else if (type === 'resetday') v = el.value === '' ? null : Number(el.value);
    else if (type === 'list') v = String(el.value).split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(Number);
    else if (type === 'checks') {
      const boxes = el.closest('fieldset').querySelectorAll('input[type="checkbox"]');
      v = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return b.value; });
    } else return;
    setPath(s.draft, path, v);
    G.app.render();
  };

  function effectiveCredits(s) {
    return clone(effective(s.view, s.scope, s.draft, 'credit.values').value) || [];
  }

  G.handlers.change['pol-credit'] = function (el) {
    const s = cur();
    if (!s) return;
    const values = effectiveCredits(s);
    const row = values[Number(el.getAttribute('data-idx'))];
    if (!row) return;
    if (el.getAttribute('data-field') === 'label') row.label = String(el.value).trim().slice(0, 12);
    else row.value = Math.max(0, Math.min(100, Number(el.value) || 0)) / 100;
    setPath(s.draft, 'credit.values', values);
    G.app.render();
  };

  G.handlers.click['pol-credit-add'] = function () {
    const s = cur();
    if (!s) return;
    const values = effectiveCredits(s);
    if (values.length >= CREDIT_MAX) return;
    values.push({ id: creditIdFor('extra', values.map(function (v) { return v.id; })), label: 'Extra', value: 0.5 });
    setPath(s.draft, 'credit.values', values);
    G.app.render();
    G.ui.focusByKey('pc-l-' + (values.length - 1));
  };

  G.handlers.click['pol-credit-remove'] = function (el) {
    const s = cur();
    if (!s) return;
    const values = effectiveCredits(s);
    if (values.length <= CREDIT_MIN) return;
    values.splice(Number(el.getAttribute('data-idx')), 1);
    setPath(s.draft, 'credit.values', values);
    G.app.render();
  };

  G.handlers.click['pol-credit-move'] = function (el) {
    const s = cur();
    if (!s) return;
    const values = effectiveCredits(s);
    const i = Number(el.getAttribute('data-idx'));
    const j = i + Number(el.getAttribute('data-dir'));
    if (j < 0 || j >= values.length) return;
    const tmp = values[i]; values[i] = values[j]; values[j] = tmp;
    setPath(s.draft, 'credit.values', values);
    G.app.render();
    G.ui.focusByKey(el.getAttribute('data-key').replace(/\d+$/, String(j)));
  };

  // The rank ladder: every edit rewrites the whole ranks list in the draft (the policy stores the list as one value).
  function effectiveRanks(s) {
    return clone(effective(s.view, s.scope, s.draft, 'ladder.ranks').value) || [];
  }

  function saveRanks(s, ranks) {
    setPath(s.draft, 'ladder.ranks', ranks);
    G.app.render();
  }

  G.handlers.click['pol-rank-start'] = function () {
    const s = cur();
    if (!s || s.scope !== 'guild') return;
    saveRanks(s, clone(STARTER_LADDER));
    G.ui.focusByKey('pr-n-0');
  };

  G.handlers.click['pol-rank-off'] = function () {
    const s = cur();
    if (!s || s.scope !== 'guild') return;
    saveRanks(s, []);
  };

  G.handlers.click['pol-rank-add'] = function () {
    const s = cur();
    if (!s || s.scope !== 'guild') return;
    const ranks = effectiveRanks(s);
    if (ranks.length >= RANK_MAX) return;
    ranks.push({ id: creditIdFor('rank', ranks.map(function (r) { return r.id; })), name: 'New rank', rules: { since: 'join' } });
    saveRanks(s, ranks);
    G.ui.focusByKey('pr-n-' + (ranks.length - 1));
  };

  G.handlers.click['pol-rank-remove'] = function (el) {
    const s = cur();
    if (!s || s.scope !== 'guild') return;
    const ranks = effectiveRanks(s);
    if (ranks.length <= RANK_MIN) return;
    ranks.splice(Number(el.getAttribute('data-idx')), 1);
    saveRanks(s, ranks);
  };

  G.handlers.click['pol-rank-move'] = function (el) {
    const s = cur();
    if (!s || s.scope !== 'guild') return;
    const ranks = effectiveRanks(s);
    const i = Number(el.getAttribute('data-idx'));
    const j = i + Number(el.getAttribute('data-dir'));
    if (j < 0 || j >= ranks.length) return;
    const tmp = ranks[i]; ranks[i] = ranks[j]; ranks[j] = tmp;
    saveRanks(s, ranks);
    G.ui.focusByKey(el.getAttribute('data-key').replace(/\d+$/, String(j)));
  };

  G.handlers.change['pol-rank'] = function (el) {
    const s = cur();
    if (!s || s.scope !== 'guild') return;
    const ranks = effectiveRanks(s);
    const rank = ranks[Number(el.getAttribute('data-idx'))];
    if (!rank) return;
    const field = el.getAttribute('data-field');
    if (field === 'name') {
      rank.name = String(el.value).trim().slice(0, RANK_NAME_MAX) || rank.name;
    } else {
      rank.rules = rank.rules && typeof rank.rules === 'object' ? rank.rules : {};
      if (field === 'since') rank.rules.since = el.value === 'rank' ? 'rank' : 'join';
      else if (field === 'minAttendance') rank.rules.minAttendance = fractionOf(el.value);
      else {
        const def = RANK_RULES.filter(function (r) { return r.key === field; })[0];
        if (!def) return;
        const n = el.value === '' ? null : Math.round(Number(el.value));
        rank.rules[field] = n === null || !isFinite(n) ? null : Math.max(0, Math.min(def.max, n));
      }
    }
    saveRanks(s, ranks);
  };

  G.handlers.click['pol-reset'] = function (el) {
    const s = cur();
    if (!s) return;
    delPath(s.draft, el.getAttribute('data-path'));
    G.app.render();
  };

  G.handlers.click['pol-discard'] = function () {
    const s = cur();
    if (!s) return;
    s.draft = overrideFor(s.view, s.scope);
    st().pageAlert = '';
    G.app.render();
  };

  G.handlers.click['pol-reset-all'] = function () {
    const s = cur();
    if (!s) return;
    s.draft = {};
    G.app.render();
  };

  function showPolicyError(form, err) {
    const c = G.api.classify(err);
    const slot = err && err.field ? document.getElementById('perr-' + fid(err.field)) : null;
    if (slot) {
      slot.textContent = c.text;
      slot.hidden = false;
      const input = form.querySelector('[data-path="' + err.field + '"]');
      if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
      return;
    }
    G.ui.setText('pol-error', c.text);
  }

  G.handlers.submit['pol-form'] = function (form) {
    const s = cur();
    const gd = currentGd();
    if (!s || !gd) return;
    const gid = gd.guild.id;
    const before = overrideFor(s.view, s.scope);
    const body = s.scope === 'guild' ? pruneToDifferences(s.draft, s.view.defaults || {}) : clone(s.draft);
    G.ui.setText('pol-error', '');
    Array.prototype.forEach.call(form.querySelectorAll('.gs-pol-field .gs-field-error'), function (e) { e.hidden = true; e.textContent = ''; });
    G.ui.setBusy(form, true);
    G.api.put(A().apiBase(gid) + '/attendance/policy', { teamId: s.scope === 'guild' ? null : s.scope, policy: body, expectedVersion: versionFor(s.view, s.scope) }).then(function (view) {
      a().policy[gid] = view;
      const scope = s.scope;
      adopt(gid, view, scope, false);
      a().polNotice = '';
      G.app.markSettingsSaved('attendance');
      st().pageAlert = '';
      const teamIds = scope === 'guild' ? G.shell.activeTeams(gd.teams).map(function (t) { return t.id; }) : [scope];
      const needs = changesConsolidation(before, body);
      if (!needs) { G.app.render(); return null; }
      return Promise.all(teamIds.map(function (t) { return A().staleIdsOf(gid, t); })).then(function (lists) {
        a().settingsAtt.stale = [].concat.apply([], lists).length;
        a().settingsAtt.staleTeams = teamIds;
        G.app.render();
      }, function () { G.app.render(); });
    }, function (err) {
      G.ui.setBusy(form, false);
      if (err && err.code === 'conflict') {
        const cur2 = err.body && err.body.current;
        if (cur2 && cur2.defaults) { a().policy[gid] = cur2; adopt(gid, cur2, s.scope, false); }
        st().pageAlert = 'Someone else changed these rules. The page now shows their version; make your change again.';
        if (!(cur2 && cur2.defaults)) { G.app.routeAll({ force: true }); return; }
        G.app.render();
        return;
      }
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      if (c.view === 'message') { G.app.showFailure(c.title, c.text); return; }
      showPolicyError(form, err);
    });
  };

  G.handlers.click['pol-recalc'] = function () {
    const s = cur();
    const gd = currentGd();
    if (!s || !gd) return;
    const gid = gd.guild.id;
    const teams = s.staleTeams || [];
    a().recalc = { running: true, done: 0, total: s.stale, failed: 0 };
    G.app.render();
    Promise.all(teams.map(function (t) { return A().staleIdsOf(gid, t); })).then(function (lists) {
      return A().recalcAll(gid, [].concat.apply([], lists), function (p) { a().recalc = p; if (p.running) G.app.render(); });
    }).then(function (res) {
      a().recalc = null;
      s.stale = 0;
      a().polNotice = res && res.failed ? 'Could not recalculate ' + A().plural(res.failed, 'raid', 'raids') + '.' : 'Raids recalculated.';
      G.app.render();
    }, function () { a().recalc = null; G.app.render(); });
  };

  // ── Warcraft Logs card ──
  function readUploaders(form, view) {
    const out = {};
    let problem = '';
    Array.prototype.forEach.call(form.querySelectorAll('textarea[data-tid]'), function (ta) {
      const names = ta.value.split(/[\n,]+/).map(function (n) { return n.trim(); }).filter(Boolean);
      if (names.length > UPLOADERS_MAX) problem = 'At most ' + UPLOADERS_MAX + ' uploader names per team.';
      names.forEach(function (n) { if (n.length < 2 || n.length > 24) problem = 'Uploader names are 2 to 24 characters.'; });
      out[ta.getAttribute('data-tid')] = names;
    });
    return { uploaders: out, problem: problem };
  }

  G.handlers.submit['wcl-form'] = function (form) {
    const s = cur();
    const gd = currentGd();
    if (!s || !gd) return;
    const gid = gd.guild.id;
    const raw = String(document.getElementById('wcl-guild').value || '').trim();
    const read = readUploaders(form, s.view);
    G.ui.setText('wcl-error', '');
    G.ui.setText('wcl-ok', '');
    if (raw && !/^[1-9][0-9]{0,9}$/.test(raw)) { G.ui.setText('wcl-error', 'The Warcraft Logs guild ID is a number.'); document.getElementById('wcl-guild').focus(); return; }
    if (read.problem) { G.ui.setText('wcl-error', read.problem); return; }
    G.ui.setBusy(form, true);
    G.api.put(A().apiBase(gid) + '/attendance/wcl', { wclGuildId: raw ? Number(raw) : null, uploaders: read.uploaders }).then(function (view) {
      a().policy[gid] = view;
      s.view = view;
      s.wclUi = null;
      G.ui.setBusy(form, false);
      G.app.render();
      G.ui.setText('wcl-ok', 'Warcraft Logs settings saved.');
    }, function (err) {
      G.ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (c.view === 'signin') { G.app.requireSignin(); return; }
      G.ui.setText('wcl-error', c.text);
    });
  };

  G.pages.settingsAtt = {
    GROUPS: GROUPS,
    SECTIONS: SECTIONS,
    changeCount: changeCount,
    getPath: getPath,
    setPath: setPath,
    delPath: delPath,
    pruneToDifferences: pruneToDifferences,
    changesConsolidation: changesConsolidation,
    effective: effective,
    percentOf: percentOf,
    fractionOf: fractionOf,
    creditIdFor: creditIdFor,
    settingsHtml: settingsHtml,
    wclCardHtml: wclCardHtml,
    overrideFor: overrideFor,
    versionFor: versionFor,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
