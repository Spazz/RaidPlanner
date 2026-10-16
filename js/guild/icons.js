// ── ICONS ───────────────────────────────────────────────────────
// Inline SVG strings (stroke icons from the mockup boards). Static markup only; no data goes through here.
(function (G) {
  'use strict';

  const PATHS = {
    roster: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    raids: '<rect x="3" y="4" width="18" height="18"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    attendance: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    loot: '<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M11 3L8 9l4 12 4-12-3-6"/><path d="M2 9h20"/>',
    planner: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    lock: '<rect x="3" y="11" width="18" height="11"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    collapse: '<path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/>',
    expand: '<path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
    whatsnew: '<path d="M12 3l2.1 5.9L20 11l-5.9 2.1L12 19l-2.1-5.9L4 11l5.9-2.1z"/>',
    guide: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    faq: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6"/><path d="M10 11v6M14 11v6"/>',
  };

  const LOGO = '<svg class="gs-logo" viewBox="0 0 48 48" width="30" height="30" aria-hidden="true" focusable="false"><g class="gs-logo-dots"><circle cx="9" cy="14" r="3"/><circle cx="16.5" cy="9" r="3"/><circle cx="24" cy="7" r="3"/><circle cx="31.5" cy="9" r="3"/><circle cx="39" cy="14" r="3"/></g><path d="M5 26c0-2 1.6-3.6 3.6-3.6H42V30c0 2.2-1.8 4-4 4h-5.5l2.6 5H37v5H13v-5h4l2.6-5H17c-6.6 0-12-3.6-12-8Z" transform="translate(0 -1)" class="gs-logo-anvil"/></svg>';

  function icon(name, size) {
    const body = Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name] : '';
    const s = size || 20;
    return '<svg class="gs-icon" viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  G.icons = { icon: icon, logo: LOGO, names: Object.keys(PATHS) };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
