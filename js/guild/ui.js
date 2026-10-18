// ── UI HELPERS ──────────────────────────────────────────────────
// Escaped-HTML building blocks shared by every page, plus the handler registry the delegated
// listeners in app.js dispatch to, and the native <dialog> helper. Anything built from data goes through esc().
(function (G) {
  'use strict';

  const ui = G.ui = G.ui || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };
  G.pages = G.pages || {};

  const SERVER_ACCESS_LABELS = { owner: 'Owner', administrator: 'Administrator', manage_server: 'Manage Server' };
  const GAME_VERSIONS = { tbc: 'TBC Anniversary', classic: 'Classic Era', forever: 'WoW Forever' };

  ui.esc = function (s) { return esc(s); };

  ui.initials = function (name) {
    const words = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  };

  ui.gameVersionLabel = function (v) { return Object.prototype.hasOwnProperty.call(GAME_VERSIONS, v) ? GAME_VERSIONS[v] : String(v == null ? '' : v); };
  // The realm line under a guild name: the realm, or "<Ruleset> ruleset" for a ruleset (WoW Forever).
  ui.realmLine = function (guild) {
    const g = guild || {};
    const realm = String(g.realm == null ? '' : g.realm);
    return g.realmKind === 'ruleset' ? realm + ' ruleset' : realm;
  };
  ui.serverAccessLabel = function (a) { return Object.prototype.hasOwnProperty.call(SERVER_ACCESS_LABELS, a) ? SERVER_ACCESS_LABELS[a] : String(a == null ? '' : a); };

  // A person's avatar: the initials always render; the Discord image (when the server sent one) sits over them.
  ui.avatarHtml = function (person, sizeClass) {
    const p = person || {};
    const cls = 'gs-avatar ' + (sizeClass || 'gs-avatar-md');
    const initials = p.initials || ui.initials(p.displayName || p.username);
    const img = (typeof p.avatarUrl === 'string' && p.avatarUrl.indexOf('https://') === 0) ? '<img class="gs-avatar-img" src="' + esc(p.avatarUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '';
    return '<span class="' + cls + '" aria-hidden="true">' + esc(initials) + img + '</span>';
  };

  ui.formatDate = function (ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    try { return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; }
  };

  ui.formatDateTime = function (ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '';
    try { return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  };

  // Calendar-day difference in the viewer's time zone: Today, Yesterday, N days ago, then a date.
  ui.relativeTime = function (ms, now) {
    if (typeof ms !== 'number' || !isFinite(ms)) return 'Not yet';
    const n = new Date(typeof now === 'number' ? now : Date.now());
    const d = new Date(ms);
    const startNow = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const startThen = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startNow - startThen) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 14) return days + ' days ago';
    return ui.formatDate(ms);
  };

  // "A", "A and B", "A, B and C" as escaped <strong> names.
  ui.joinNames = function (items) {
    const names = (Array.isArray(items) ? items : []).map(function (g) { return '<strong>' + esc(g && g.name) + '</strong>'; });
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  };

  ui.roleChipsHtml = function (roles, teams) {
    return G.peopleSort.roleLabels(roles, teams).map(function (r) {
      return '<span class="gs-chip gs-chip-' + esc(r.kind) + '">' + esc(r.label) + '</span>';
    }).join('');
  };

  ui.alertHtml = function (text, id) {
    return '<p class="gs-alert" role="alert"' + (id ? ' id="' + esc(id) + '"' : '') + (text ? '' : ' hidden') + '>' + esc(text) + '</p>';
  };

  // ── roster helpers: class colours, trial copy, status, sign-in, calendar days ──
  const CLASS_IDS = ['WARRIOR', 'PALADIN', 'HUNTER', 'ROGUE', 'PRIEST', 'SHAMAN', 'MAGE', 'WARLOCK', 'DRUID'];
  const STATUS_LABELS = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve', inactive: 'Inactive' };
  const LEFT_REASONS = { left: 'Left guild', kicked: 'Kicked', break: 'Break', other: 'Other' };
  const SIGN_IN_LABELS = { signed_in: 'Signed in', not_yet: 'Not yet', no_discord: 'No Discord' };
  const ROLE_LABELS = { tank: 'Tank', healer: 'Healer', dps: 'DPS' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  ui.CLASS_IDS = CLASS_IDS;
  ui.STATUS_LABELS = STATUS_LABELS;
  ui.LEFT_REASONS = LEFT_REASONS;

  // "WARRIOR" -> "Warrior"; anything else is shown as given.
  ui.className = function (id) {
    const s = String(id == null ? '' : id);
    return CLASS_IDS.indexOf(s) >= 0 ? s.charAt(0) + s.slice(1).toLowerCase() : s;
  };
  // The CSS class that colours a character name; '' for anything that is not one of the nine classes.
  const CLASS_CSS = {
    WARRIOR: 'gs-class-warrior', PALADIN: 'gs-class-paladin', HUNTER: 'gs-class-hunter', ROGUE: 'gs-class-rogue', PRIEST: 'gs-class-priest',
    SHAMAN: 'gs-class-shaman', MAGE: 'gs-class-mage', WARLOCK: 'gs-class-warlock', DRUID: 'gs-class-druid',
  };
  ui.classClass = function (id) {
    return Object.prototype.hasOwnProperty.call(CLASS_CSS, id) ? CLASS_CSS[id] : '';
  };
  // A character name in its class colour. The spec text next to it always names the class too.
  ui.classNameHtml = function (name, classId) {
    const c = ui.classClass(classId);
    return '<span class="gs-char-name' + (c ? ' ' + c : '') + '">' + esc(name) + '</span>';
  };
  // "Paladin - Protection / Holy" with the separator as an HTML dot; the off spec only when there is one.
  ui.specLineHtml = function (classId, mainSpec, offSpec) {
    let out = esc(ui.className(classId));
    if (mainSpec) out += ' &middot; ' + esc(mainSpec) + (offSpec ? ' / ' + esc(offSpec) : '');
    return out;
  };

  ui.statusLabel = function (s) { return Object.prototype.hasOwnProperty.call(STATUS_LABELS, s) ? STATUS_LABELS[s] : String(s == null ? '' : s); };
  // The status as text; an inactive person (p = { status, leftReason, leftOn }) gets the reason and the day: "Inactive - Kicked, left Oct 12, 2026".
  ui.statusText = function (p) {
    const label = ui.statusLabel(p && p.status);
    if (!p || p.status !== 'inactive') return label;
    const reason = Object.prototype.hasOwnProperty.call(LEFT_REASONS, p.leftReason) ? LEFT_REASONS[p.leftReason] : '';
    const day = ui.formatDay(p.leftOn);
    return label + (reason ? ' - ' + reason : '') + (day ? ', left ' + day : '');
  };
  // detail (optional) = the person, so an inactive chip carries the reason and the day.
  ui.statusChipHtml = function (s, detail) {
    const kind = Object.prototype.hasOwnProperty.call(STATUS_LABELS, s) ? s : 'raider';
    return '<span class="gs-chip gs-chip-status gs-status-' + kind + '">' + esc(detail ? ui.statusText(detail) : ui.statusLabel(s)) + '</span>';
  };
  ui.signInLabel = function (s) { return Object.prototype.hasOwnProperty.call(SIGN_IN_LABELS, s) ? SIGN_IN_LABELS[s] : ''; };
  ui.roleLabel = function (r) { return Object.prototype.hasOwnProperty.call(ROLE_LABELS, r) ? ROLE_LABELS[r] : ''; };
  ui.roleDotHtml = function (role) {
    if (!Object.prototype.hasOwnProperty.call(ROLE_LABELS, role)) return '';
    return '<span class="gs-role-dot gs-role-' + role + '" role="img" aria-label="' + ROLE_LABELS[role] + '"></span>';
  };

  // trialFlag = { kind: 'ends' | 'ended', days } from the Worker: 0 "Ends today", 1 "Ends tomorrow", n "Ends in n days",
  // -1 "Ended yesterday", -n "Ended n days ago". null means no flag, so no words.
  ui.trialCopy = function (flag) {
    if (!flag || typeof flag !== 'object') return '';
    const days = Number(flag.days);
    if (!isFinite(days)) return '';
    if (flag.kind === 'ended') {
      const n = Math.abs(days);
      return n === 1 ? 'Ended yesterday' : 'Ended ' + n + ' days ago';
    }
    if (flag.kind !== 'ends') return '';
    if (days === 0) return 'Ends today';
    if (days === 1) return 'Ends tomorrow';
    return 'Ends in ' + days + ' days';
  };
  ui.trialChipHtml = function (flag) {
    const t = ui.trialCopy(flag);
    if (!t) return '';
    return '<span class="gs-chip gs-chip-trial ' + (flag.kind === 'ended' ? 'gs-trial-ended' : 'gs-trial-ends') + '">' + esc(t) + '</span>';
  };

  // 'YYYY-MM-DD' -> 'Oct 13, 2026' with no time zone maths (the date is already the guild's calendar date).
  ui.formatDay = function (s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
    if (!m) return '';
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return '';
    return MONTHS[mo - 1] + ' ' + Number(m[3]) + ', ' + m[1];
  };
  // 'YYYY-MM-DD' plus n days.
  ui.addDays = function (s, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  };

  // 'YYYY-MM-DD' -> 'Oct 10' and 'Sat Oct 10' (weekday from the calendar date, no time zone maths).
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  ui.shortDay = function (s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
    return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]);
  };
  ui.weekdayDay = function (s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
    if (!m) return '';
    const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
    return WEEKDAYS[wd] + ' ' + ui.shortDay(s);
  };
  // A percentage 0..100 (teamMetrics gives one decimal) as '88%'; null / not a number as '-'.
  ui.percent = function (v) {
    if (typeof v !== 'number' || !isFinite(v)) return '-';
    return Math.round(v) + '%';
  };
  ui.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  // <option> list from [{ value, label }] with one selected value.
  ui.optionsHtml = function (items, selected) {
    return items.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (String(o.value) === String(selected == null ? '' : selected) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  };

  // GET /api/guild/:gid -> rosterOptions { classes, specs, roles }; the nine classes stand in when it is missing.
  ui.rosterOptions = function (gd) {
    const ro = (gd && gd.rosterOptions) || {};
    return {
      classes: Array.isArray(ro.classes) && ro.classes.length ? ro.classes : CLASS_IDS.map(function (id) { return { id: id, name: ui.className(id) }; }),
      specs: ro.specs && typeof ro.specs === 'object' ? ro.specs : {},
      roles: ro.roles && typeof ro.roles === 'object' ? ro.roles : {},
    };
  };
  ui.specsFor = function (options, classId) {
    const list = options && options.specs && Object.prototype.hasOwnProperty.call(options.specs, classId) ? options.specs[classId] : [];
    return Array.isArray(list) ? list : [];
  };
  ui.roleOfSpec = function (options, classId, spec) {
    const byClass = options && options.roles && Object.prototype.hasOwnProperty.call(options.roles, classId) ? options.roles[classId] : null;
    return byClass && spec && Object.prototype.hasOwnProperty.call(byClass, spec) ? byClass[spec] : null;
  };
  ui.classOptionsHtml = function (options, selected, placeholder) {
    const items = [{ value: '', label: placeholder }].concat(options.classes.map(function (c) { return { value: c.id, label: c.name }; }));
    return ui.optionsHtml(items, selected);
  };
  ui.specOptionsHtml = function (options, classId, selected, noneLabel) {
    const items = [{ value: '', label: noneLabel }].concat(ui.specsFor(options, classId).map(function (s) { return { value: s, label: s }; }));
    return ui.optionsHtml(items, selected);
  };

  // ── DOM-only helpers (runtime, not used by the pure render functions) ──
  ui.setText = function (id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  };

  // Writes into a live region (role="status") that is already on the page, so a screen reader announces the change; a re-render alone
  // replaces the region and is not reliably announced.
  ui.announce = function (id, text) {
    const el = typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
    if (el) el.textContent = text || '';
  };

  // opts.preventScroll: a re-render puts focus back where it was without scrolling the page to it.
  ui.focusByKey = function (key, opts) {
    if (!key) return false;
    const nodes = document.querySelectorAll('[data-key]');
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-key') !== key) continue;
      nodes[i].focus(opts && opts.preventScroll ? { preventScroll: true } : undefined);
      if (document.activeElement === nodes[i]) return true;
    }
    return false;
  };

  // Opens a native modal <dialog>. Escape closes it; focus returns to the opener (or its data-key after a re-render).
  ui.openDialog = function (html, opts) {
    const o = opts || {};
    const host = document.getElementById('guild-dialogs');
    if (!host || typeof HTMLDialogElement === 'undefined') return null;
    const opener = (G.app && G.app.lastActionEl && G.app.lastActionEl.isConnected) ? G.app.lastActionEl : document.activeElement;
    const returnKey = o.returnKey || (opener && opener.getAttribute ? opener.getAttribute('data-key') : null);
    const dlg = document.createElement('dialog');
    dlg.className = 'gs-dialog';
    if (o.labelledBy) dlg.setAttribute('aria-labelledby', o.labelledBy);
    if (o.describedBy) dlg.setAttribute('aria-describedby', o.describedBy);
    dlg.innerHTML = html;
    dlg.addEventListener('close', function () {
      dlg.remove();
      if (opener && opener.isConnected && opener.focus) {
        opener.focus();
        if (document.activeElement === opener) return;
      }
      if (ui.focusByKey(returnKey)) return;
      const h = document.querySelector('#gs-main h1');
      if (h) h.focus();
    });
    host.appendChild(dlg);
    dlg.showModal();
    return dlg;
  };

  ui.closeDialogOf = function (el) {
    const dlg = el && el.closest ? el.closest('dialog') : null;
    if (dlg && dlg.open) dlg.close();
  };

  // Shows a server error next to the field it names (`dlg-err-<field>` when the form has one), else in `dlg-error`.
  ui.showFormError = function (form, err) {
    const c = G.api.classify(err);
    const fieldId = err && err.field ? 'dlg-err-' + err.field : '';
    const sink = fieldId && form.querySelector('#' + fieldId) ? fieldId : 'dlg-error';
    ui.setText(sink, c.text);
    if (sink !== 'dlg-error' && err.field) {
      const input = form.querySelector('[data-field="' + err.field + '"]');
      if (input) { input.setAttribute('aria-invalid', 'true'); if (input.focus) input.focus(); }
    }
  };

  // Runs one request from a dialog form: busy while it runs, closes the dialog on success (after onOk(res)),
  // sends a lost race (409 conflict) to onConflict(err) or the page-wide handler, and shows other errors in the form.
  ui.runDialog = function (form, promise, onOk, onConflict) {
    ui.setBusy(form, true);
    return promise.then(function (res) {
      ui.closeDialogOf(form);
      if (onOk) onOk(res);
    }, function (err) {
      ui.setBusy(form, false);
      const c = G.api.classify(err);
      if (err && err.code === 'conflict') {
        ui.closeDialogOf(form);
        if (onConflict) onConflict(err); else G.app.handleError(err);
        return;
      }
      if (c.view === 'signin') { ui.closeDialogOf(form); G.app.requireSignin(); return; }
      if (c.view === 'message') { ui.closeDialogOf(form); G.app.showFailure(c.title, c.text); return; }
      ui.showFormError(form, err);
    });
  };

  ui.setBusy = function (form, busy) {
    const btns = form.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      if (busy) { btns[i].setAttribute('data-was-disabled', btns[i].disabled ? '1' : '0'); btns[i].disabled = true; }
      else if (btns[i].getAttribute('data-was-disabled') === '0') { btns[i].disabled = false; }
    }
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
