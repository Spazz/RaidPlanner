// ── UI HELPERS ──────────────────────────────────────────────────
// Escaped-HTML building blocks shared by every page, plus the handler registry the delegated
// listeners in app.js dispatch to, and the native <dialog> helper. Anything built from data goes through esc().
(function (G) {
  'use strict';

  const ui = G.ui = G.ui || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };
  G.pages = G.pages || {};

  const SERVER_ACCESS_LABELS = { owner: 'Owner', administrator: 'Administrator', manage_server: 'Manage Server' };
  const GAME_VERSIONS = { 'tbc-anniversary': 'TBC Anniversary' };

  ui.esc = function (s) { return esc(s); };

  ui.initials = function (name) {
    const words = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  };

  ui.gameVersionLabel = function (v) { return Object.prototype.hasOwnProperty.call(GAME_VERSIONS, v) ? GAME_VERSIONS[v] : String(v == null ? '' : v); };
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

  // ── DOM-only helpers (runtime, not used by the pure render functions) ──
  ui.setText = function (id, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  };

  ui.focusByKey = function (key) {
    if (!key) return false;
    const nodes = document.querySelectorAll('[data-key]');
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-key') !== key) continue;
      nodes[i].focus();
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

  ui.setBusy = function (form, busy) {
    const btns = form.querySelectorAll('button');
    for (let i = 0; i < btns.length; i++) {
      if (busy) { btns[i].setAttribute('data-was-disabled', btns[i].disabled ? '1' : '0'); btns[i].disabled = true; }
      else if (btns[i].getAttribute('data-was-disabled') === '0') { btns[i].disabled = false; }
    }
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
