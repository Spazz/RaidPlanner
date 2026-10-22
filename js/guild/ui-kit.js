// ── UI KIT: the design framework's components ───────────────────
// Escaped-HTML builders (and the little runtime behind some of them) for the parts every page is made of, so a page picks a part instead of
// writing markup: buttons, status chips and tags, count and "New" badges, segmented controls, the next-step bar, the data table
// (cards on a phone), form fields with inline validation, the sticky Save bar with its unsaved-changes guard, inline banners and toasts, the empty /
// loading / error states and the dialog layout. The page templates that put them together are in ui-templates.js. Rules: tasks/design-spec.md;
// the classes are styled in guild.css under "Design framework", and the page look under "Forge".
// Every helper returns a string and escapes what it is given, except the arguments named ...Html, which are markup the caller already built.
// No inline style or event-handler attributes are written (the CSP forbids them): looks come from classes, behaviour from data-action /
// data-change / data-input attributes the delegated listeners in app.js dispatch to (G.handlers).
//
//   ui.buttonHtml({ label, variant, size, block, href, attrs, ariaLabel, disabled, busy, icon })     variant: primary | secondary | ghost | danger-outline | danger | link
//   ui.iconButtonHtml({ icon, ariaLabel, attrs, danger })                                           an icon-only button; the aria-label (naming the object) is required
//   ui.chipHtml({ tone, label, icon })  /  ui.signupChipHtml(kind)  /  ui.tagHtml(label, mark)     status = icon + word + tint; tag = neutral outline
//   ui.readOnlyChipHtml()                                                                           the "Read-only" chip of the guest, public and other reading pages
//   ui.countBadgeHtml(n, label)  /  ui.newBadgeHtml()  /  ui.badgeHtml({ count, label, isNew })     gold count (gone at 0) vs neutral "New" (never both)
//   ui.segmentsHtml({ label, items, selected, action })                                              joined buttons that change which rows show
//   ui.nextStepHtml({ title, text, primary, secondary })
//   ui.dataTableHtml({ label, columns, rows, limit, showAll, noun, showAllAction, emptyHtml })        a table that turns into cards on a phone
//   ui.fieldHtml({ id, name, label, kind, value, required, help, error, readonly, options, ... })  /  ui.checkFieldHtml(...)  /  ui.fieldErrorHtml(id, text)
//   ui.setFieldError(root, id, text) / ui.clearFieldError / ui.focusFirstInvalid / ui.validateValues(values, rules) / ui.validateForm(form, rules)
//   ui.saveBarHtml(opts) + ui.saveBar.{snapshot,diff,count,bind,update,markSaved}  /  ui.unsaved.{set,isDirty,clear,guardClick,install}
//     a page that keeps a draft in state and redraws after every change: ui.saveBarHtml({ count, discardAttrs }) + ui.saveBar.{draftChanges,setCount,sync,paintStatus}
//   ui.bannerHtml({ tone, title, text, actions, dismissible })  /  ui.toastHtml(text)  /  ui.toast(text, opts)
//   ui.emptyStateHtml({ kind, icon, title, text, actions })  /  ui.loadingHtml({ label, rows })  /  ui.errorRegionHtml({ title, text, retry })
//   ui.dialogHtml({ kind, title, text, bodyHtml, primary, cancel, back, step })                      form | confirm | destructive | step
//   ui.itemLinkHtml({ itemId, itemName, quality }, gameVersion)  /  ui.itemUrl(gameVersion, itemId)  an item as a Wowhead link (data-wowhead hook), the ONE place items are written
//   ui.refreshItemTooltips(root)                                                                    after a render: lazily loads Wowhead's tooltip script if root holds an item link
(function (G) {
  'use strict';

  const ui = G.ui = G.ui || {};
  G.handlers = G.handlers || { click: {}, submit: {}, change: {}, input: {} };

  const has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  const ATTR_NAME = /^[a-z][a-z0-9-]*$/;

  // { 'data-action': 'x', disabled: true } -> ' data-action="x" disabled'. Event-handler, style and class attributes are never written from here.
  function attrsHtml(attrs) {
    if (!attrs || typeof attrs !== 'object') return '';
    return Object.keys(attrs).filter(function (k) { return ATTR_NAME.test(k) && !/^on/.test(k) && k !== 'style' && k !== 'class'; }).map(function (k) {
      const v = attrs[k];
      if (v === false || v == null) return '';
      return v === true ? ' ' + k : ' ' + k + '="' + esc(v) + '"';
    }).join('');
  }
  ui.attrsHtml = attrsHtml;

  const icon = function (name, size) { return G.icons.icon(name, size); };

  // ── BUTTONS ──
  // One molten primary per screen or dialog; Cancel is secondary or ghost, left of the primary; danger outline opens a destructive dialog and danger
  // filled is only the confirm button of that dialog. Labels are verb first, one to three words, sentence case (the style uppercases them).
  const BUTTON_CLASS = {
    primary: 'gs-btn gs-btn-molten',
    secondary: 'gs-btn',
    ghost: 'gs-btn gs-btn-ghost',
    'danger-outline': 'gs-btn gs-btn-danger-outline',
    danger: 'gs-btn gs-btn-danger',
    link: 'gs-linkbtn',
  };
  ui.BUTTON_VARIANTS = Object.keys(BUTTON_CLASS);

  // opts: { label, variant (default secondary), size ('sm' desktop table rows | 'lg' phone block), block (full width), href (renders a link),
  //         attrs ({ 'data-action': ... }), ariaLabel, disabled, busy (keeps the label, adds "...", aria-busy), busyLabel, icon (icon name), type }
  ui.buttonHtml = function (opts) {
    const o = opts || {};
    const variant = has(BUTTON_CLASS, o.variant) ? o.variant : 'secondary';
    const cls = BUTTON_CLASS[variant] + (o.size === 'sm' ? ' gs-btn-sm' : o.size === 'lg' ? ' gs-btn-lg' : '') + (o.block ? ' gs-btn-wide' : '') + (o.busy ? ' is-busy' : '');
    const text = o.busy ? (o.busyLabel || String(o.label == null ? '' : o.label) + '...') : o.label;
    const inner = (o.icon ? icon(o.icon, 18) : '') + '<span>' + esc(text) + '</span>';
    const aria = (o.ariaLabel ? ' aria-label="' + esc(o.ariaLabel) + '"' : '') + (o.busy ? ' aria-busy="true"' : '');
    if (o.href) {
      return '<a class="' + cls + '" href="' + esc(o.href) + '"' + aria + (o.disabled ? ' aria-disabled="true" tabindex="-1"' : '') + attrsHtml(o.attrs) + '>' + inner + '</a>';
    }
    return '<button type="' + (o.type === 'submit' ? 'submit' : 'button') + '" class="' + cls + '"' + aria + (o.disabled || o.busy ? ' disabled' : '') + attrsHtml(o.attrs) + '>' + inner + '</button>';
  };

  // An icon-only button. It always carries an aria-label naming the object ("More actions for Naturesgrasp"); without one nothing is rendered.
  ui.iconButtonHtml = function (opts) {
    const o = opts || {};
    if (!o.ariaLabel || !o.icon) return '';
    return '<button type="button" class="gs-icon-btn' + (o.danger ? ' gs-icon-btn-danger' : '') + '" aria-label="' + esc(o.ariaLabel) + '"' + attrsHtml(o.attrs) + '>' + icon(o.icon, o.size || 20) + '</button>';
  };

  // ── STATUS CHIPS AND TAGS ──
  // A status chip says where something stands: a tinted fill, an icon and a word (colour is never the only signal), 24 high, one per cell.
  // A tag is a neutral outline in sentence case with no icon ("where is it from", "what is it"). Neither is a control; filters are segments.
  const CHIP_ICONS = {
    check: 'M3 8.5l3.2 3.2L13 4.5',
    clock: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM8 5v3.2l2.2 1.3',
    x: 'M4 4l8 8M12 4l-8 8',
    pause: 'M6 4v8M10 4v8',
    help: 'M6 6.2a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6M8 11.7v.1',
    dash: 'M4 8h8',
    alert: 'M8 3v6M8 12v.1',
    info: 'M8 7v5M8 4.2v.1',
    plus: 'M8 4v8M4 8h8',
    refresh: 'M3 8a5 5 0 0 1 9-3M13 8a5 5 0 0 1-9 3',
    arrow: 'M3 8h9M8.5 4.5L12 8l-3.5 3.5',
  };
  const TONE_ICON = { success: 'check', warning: 'clock', danger: 'x', info: 'info', neutral: 'help', none: 'dash' };
  ui.CHIP_TONES = Object.keys(TONE_ICON);

  // opts: { tone (success | warning | danger | info | neutral | none), label, icon (a CHIP_ICONS key; each tone has a default), title }
  ui.chipHtml = function (opts) {
    const o = opts || {};
    const tone = has(TONE_ICON, o.tone) ? o.tone : 'neutral';
    const path = has(CHIP_ICONS, o.icon) ? CHIP_ICONS[o.icon] : CHIP_ICONS[TONE_ICON[tone]];
    return '<span class="gs-schip gs-schip-' + tone + '"' + (o.title ? ' title="' + esc(o.title) + '"' : '') + '><svg class="gs-schip-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" aria-hidden="true" focusable="false"><path d="' + path + '"/></svg>' + esc(o.label) + '</span>';
  };

  // The sign-up statuses as chips (the words D3 settled: Can't come, everywhere).
  const SIGNUP_CHIPS = {
    signed: { tone: 'success', label: 'Signed' },
    late: { tone: 'warning', label: 'Late', icon: 'clock' },
    tentative: { tone: 'neutral', label: 'Tentative' },
    bench: { tone: 'info', label: 'Bench', icon: 'pause' },
    cant_come: { tone: 'danger', label: 'Can\'t come' },
    none: { tone: 'none', label: 'No sign-up' },
  };
  ui.SIGNUP_CHIPS = SIGNUP_CHIPS;
  ui.signupChipHtml = function (kind) {
    return has(SIGNUP_CHIPS, kind) ? ui.chipHtml(SIGNUP_CHIPS[kind]) : '';
  };

  // The chip on a page that can only be read (the guest view, the public page): grey, a dash and the word, so it is never a colour alone.
  ui.readOnlyChipHtml = function () {
    return ui.chipHtml({ tone: 'neutral', label: 'Read-only', icon: 'dash' });
  };

  // A neutral outline tag with an optional 6 px mark: a source, team or role colour. mark: info | success | gold | muted | tank | healer | dps, or a class
  // id (WARRIOR ...). Colour comes from a class, never an inline style.
  const TAG_MARKS = ['info', 'success', 'gold', 'muted', 'tank', 'healer', 'dps'];
  ui.tagHtml = function (label, mark) {
    let m = '';
    if (typeof mark === 'string' && mark) {
      const key = TAG_MARKS.indexOf(mark) >= 0 ? mark : (ui.CLASS_IDS && ui.CLASS_IDS.indexOf(mark) >= 0 ? mark.toLowerCase() : '');
      if (key) m = '<span class="gs-tag-mark is-' + key + '" aria-hidden="true"></span>';
    }
    return '<span class="gs-tag gs-tag-plain">' + m + esc(label) + '</span>';
  };

  // The 6 px bar that carries a class or role colour beside a name (the name itself stays in the primary text colour).
  ui.markBarHtml = function (classOrRole) {
    const key = ui.CLASS_IDS && ui.CLASS_IDS.indexOf(classOrRole) >= 0 ? String(classOrRole).toLowerCase() : (['tank', 'healer', 'dps'].indexOf(classOrRole) >= 0 ? classOrRole : '');
    return key ? '<span class="gs-markbar is-' + key + '" aria-hidden="true"></span>' : '';
  };

  // ── BADGES ──
  // Count (solid gold): work waiting for you; gone at 0, "99+" past 99, its words in the accessible name. New (neutral outline): a feature
  // announcement; clears after the first visit. A count and New never sit on the same item (the count wins).
  ui.countBadgeHtml = function (n, label) {
    const count = Math.floor(Number(n));
    if (!isFinite(count) || count <= 0) return '';
    const shown = count > 99 ? '99+' : String(count);
    return '<span class="gs-cbadge"><span aria-hidden="true">' + esc(shown) + '</span><span class="gs-sr">' + esc(label || count + ' waiting') + '</span></span>';
  };
  ui.newBadgeHtml = function () { return '<span class="gs-nbadge">New</span>'; };
  ui.badgeHtml = function (opts) {
    const o = opts || {};
    const count = ui.countBadgeHtml(o.count, o.label);
    return count || (o.isNew ? ui.newBadgeHtml() : '');
  };

  // ── SEGMENTED CONTROL ──
  // Which rows of the same list show (Upcoming / Past / All). Two to five items; more should be a select. opts: { label (the group's accessible name),
  // items: [{ key, label, count }], selected (a key), action (the data-action; the pressed key is data-value) }.
  ui.segmentsHtml = function (opts) {
    const o = opts || {};
    const items = (Array.isArray(o.items) ? o.items : []).filter(Boolean);
    if (!items.length) return '';
    return '<div class="gs-segs" role="group" aria-label="' + esc(o.label || 'Filter') + '">' + items.map(function (it) {
      const on = String(it.key) === String(o.selected);
      return '<button type="button" class="gs-seg" aria-pressed="' + (on ? 'true' : 'false') + '" data-action="' + esc(o.action || 'seg-pick') + '" data-value="' + esc(it.key) + '"' + (it.dataKey ? ' data-key="' + esc(it.dataKey) + '"' : '') + '>' +
        esc(it.label) + (it.count != null ? ' <span class="gs-seg-count">' + esc(it.count) + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  };

  // The next-step bar: the page's one primary action, directly under the page head. A bar without a primary names what the
  // officers are waiting for and carries no buttons. opts: { title, text, primary: buttonOpts, secondary: buttonOpts }.
  ui.nextStepHtml = function (opts) {
    const o = opts || {};
    const id = esc(o.id || 'nextstep');
    const secondary = o.secondary ? ui.buttonHtml(Object.assign({ variant: 'secondary' }, o.secondary)) : '';
    const primary = o.primary ? ui.buttonHtml(Object.assign({ variant: 'primary' }, o.primary)) : '';
    return '<section class="gs-nextstep' + (primary || secondary ? '' : ' is-waiting') + '" aria-labelledby="' + id + '-t"><div class="gs-nextstep-body"><h2 class="gs-nextstep-title" id="' + id + '-t">' + esc(o.title) + '</h2>' +
      (o.text ? '<p class="gs-nextstep-text">' + esc(o.text) + '</p>' : '') + '</div>' +
      (primary || secondary ? '<div class="gs-nextstep-actions">' + secondary + primary + '</div>' : '') + '</section>';
  };

  // Scrolls to a section and focuses it (a link or the phone select); the section needs tabindex="-1" (the templates add it).
  function jumpTo(id) {
    const el = id && typeof document !== 'undefined' && document.getElementById ? document.getElementById(id) : null;
    if (!el) return false;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'start' });
    if (el.focus) el.focus({ preventScroll: true });
    return true;
  }
  G.handlers.click.jump = function (el, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    jumpTo(el.getAttribute('data-target'));
  };

  // ── DATA TABLE ──
  // Head: 12 px caps muted; a sortable column says so (aria-sort) and its head is a button. Rows 52 high. The viewer's own row keeps its place in the page's sort order (never moved to the top): tinted, gold
  // edge and the tag YOU. The first column is the row's link. Numbers right-aligned, at most 7 columns. Over 10 rows show 10 and "Show all N"
  // (no pagination). Below 760 px the table becomes cards (every cell carries its column name in data-label; an empty cell is dropped), with no
  // text under 12 px and no sideways scroll.
  //   columns: [{ key, label, align ('right'), primary (the row header cell), sort ('ascending' | 'descending' | true), sortAction, hideLabel (no label on a card),
  //             srLabel (the head is read aloud but not drawn: a column of row actions), sortKey (the sort button's data-key; default sort-<key>),
  //             headNote (a short muted count under the label, e.g. "24 not signed in") }]
  //   rows:    [{ id, you, cells: { <key>: html }, mark (a class id or role: the card edge), ariaLabel }]
  //   opts:    { label (the table's accessible name), limit (default 10), showAll (true: all rows), noun ('sign-ups'), showAllAction, emptyHtml }
  ui.dataTableHtml = function (opts) {
    const o = opts || {};
    const columns = (Array.isArray(o.columns) ? o.columns : []).filter(Boolean);
    const all = (Array.isArray(o.rows) ? o.rows : []).filter(Boolean);
    if (!columns.length) return '';
    if (!all.length) return o.emptyHtml || '';
    const sorted = all;
    const limit = o.limit > 0 ? o.limit : 10;
    const shown = o.showAll || sorted.length <= limit ? sorted : sorted.slice(0, limit);
    const primaryKey = (columns.filter(function (c) { return c.primary; })[0] || columns[0]).key;
    const head = columns.map(function (c) {
      const dir = c.sort === 'ascending' || c.sort === 'descending' ? c.sort : '';
      const note = c.headNote ? '<span class="gs-th-note">' + esc(c.headNote) + '</span>' : '';
      const inner = c.sort ? '<button type="button" class="gs-sort" data-action="' + esc(c.sortAction || 'table-sort') + '" data-sort="' + esc(c.key) + '" data-key="' + esc(c.sortKey || 'sort-' + c.key) + '"' + (dir ? ' data-dir="' + (dir === 'ascending' ? 'asc' : 'desc') + '"' : '') + '>' + esc(c.label) + note + '<span class="gs-sort-ind" aria-hidden="true"></span></button>' : esc(c.label) + note;
      return '<th scope="col" class="' + (c.align === 'right' ? 'is-right' : '') + '"' + (c.sort ? ' aria-sort="' + (dir || 'none') + '"' : '') + '>' + (c.srLabel ? '<span class="gs-sr">' + inner + '</span>' : inner) + '</th>';
    }).join('');
    const body = shown.map(function (r) {
      const cells = columns.map(function (c) {
        const html = r.cells && has(r.cells, c.key) && r.cells[c.key] != null ? String(r.cells[c.key]) : '';
        if (c.key === primaryKey) return '<th scope="row" class="gs-dtable-primary">' + html + (r.you ? ' <span class="gs-you">You</span>' : '') + '</th>';
        return '<td class="' + (c.align === 'right' ? 'is-right' : '') + '"' + (c.hideLabel ? '' : ' data-label="' + esc(c.label) + '"') + '>' + html + '</td>';
      }).join('');
      const markKey = r.mark && ui.CLASS_IDS && ui.CLASS_IDS.indexOf(r.mark) >= 0 ? String(r.mark).toLowerCase() : (['tank', 'healer', 'dps'].indexOf(r.mark) >= 0 ? r.mark : '');
      return '<tr class="gs-dtable-row' + (r.you ? ' is-you' : '') + (markKey ? ' has-mark is-' + markKey : '') + '"' + (r.id != null ? ' data-row="' + esc(r.id) + '"' : '') + (r.ariaLabel ? ' aria-label="' + esc(r.ariaLabel) + '"' : '') + '>' + cells + '</tr>';
    }).join('');
    const noun = o.noun || 'rows';
    const foot = !o.showAll && sorted.length > limit
      ? '<div class="gs-dtable-foot"><span class="gs-fine">Showing ' + shown.length + ' of ' + sorted.length + ' ' + esc(noun) + '</span>' +
        '<button type="button" class="gs-linkbtn" data-action="' + esc(o.showAllAction || 'table-show-all') + '">Show all ' + sorted.length + '</button></div>'
      : '';
    return '<div class="gs-dtable-wrap"><table class="gs-dtable"' + (o.label ? ' aria-label="' + esc(o.label) + '"' : '') + '><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>' + foot + '</div>';
  };

  // ── FORM FIELDS WITH INLINE VALIDATION ──
  // Label above the field (14 px, 600); required says "(required)" in words; help text under it (14 px muted). Validate on leaving a field and on Save:
  // the message says what to do ("Add a To date, or choose Every week"), with an icon, under the field, and the field edge turns danger. Save focuses
  // the first error; only three or more errors get a summary at the top. A read-only or disabled field always says why, in its help text.
  // opts: { id, name, label, kind ('text' default | 'email' | 'number' | 'date' | 'search' | 'password' | 'select' | 'textarea'), value, required, help, error,
  //         readonly, disabled, reason (why it is read-only or disabled), options ([{ value, label }] for a select), selected, placeholder, maxlength,
  //         autocomplete, rows, attrs (extra attributes on the control, e.g. data-field) }
  const FIELD_KINDS = ['text', 'email', 'number', 'date', 'search', 'password', 'url', 'tel', 'time'];
  ui.fieldErrorHtml = function (id, text) {
    return '<p class="gs-field-error" id="' + esc(id) + '-err" role="alert"' + (text ? '' : ' hidden') + '>' + (text ? icon('alert', 16) + esc(text) : '') + '</p>';
  };

  ui.fieldHtml = function (opts) {
    const o = opts || {};
    if (!o.id) return '';
    const id = esc(o.id);
    const locked = !!(o.readonly || o.disabled);
    const help = o.help || (locked ? (o.reason || 'This can\'t be changed here.') : '');
    const reason = locked && o.reason && o.help ? o.reason : '';
    const describedBy = [help || reason ? id + '-help' : '', id + '-err'].filter(Boolean).join(' ');
    const common = ' id="' + id + '"' + (o.name ? ' name="' + esc(o.name) + '"' : '') + (o.required ? ' required aria-required="true"' : '') +
      (o.error ? ' aria-invalid="true"' : '') + ' aria-describedby="' + describedBy + '"' + (o.readonly ? ' readonly' : '') + (o.disabled ? ' disabled' : '') + attrsHtml(o.attrs);
    let control;
    if (o.kind === 'select') {
      control = '<select class="gs-input"' + common + '>' + ui.optionsHtml(Array.isArray(o.options) ? o.options : [], o.selected != null ? o.selected : o.value) + '</select>';
    } else if (o.kind === 'textarea') {
      control = '<textarea class="gs-input gs-textarea"' + common + (o.rows ? ' rows="' + esc(o.rows) + '"' : '') + (o.maxlength ? ' maxlength="' + esc(o.maxlength) + '"' : '') + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + '>' + esc(o.value) + '</textarea>';
    } else {
      const type = FIELD_KINDS.indexOf(o.kind) >= 0 ? o.kind : 'text';
      control = '<input class="gs-input' + (type === 'search' ? ' gs-input-search' : '') + '" type="' + type + '"' + common + ' value="' + esc(o.value) + '"' + (o.maxlength ? ' maxlength="' + esc(o.maxlength) + '"' : '') +
        (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + (o.autocomplete ? ' autocomplete="' + esc(o.autocomplete) + '"' : '') + '>';
    }
    return '<div class="gs-field' + (locked ? ' is-locked' : '') + '"><label class="gs-label" for="' + id + '">' + esc(o.label) + (o.required ? ' <span class="gs-req">(required)</span>' : '') + '</label>' + control +
      (help || reason ? '<p class="gs-fine" id="' + id + '-help">' + esc(help) + (reason ? ' ' + esc(reason) : '') + '</p>' : '') + ui.fieldErrorHtml(o.id, o.error) + '</div>';
  };

  // A checkbox or radio with its label (20 px box, 44 px row on a phone). opts: { id, name, label, type ('checkbox' | 'radio'), value, checked, disabled, attrs }
  ui.checkFieldHtml = function (opts) {
    const o = opts || {};
    if (!o.id) return '';
    const type = o.type === 'radio' ? 'radio' : 'checkbox';
    return '<div class="gs-check"><input type="' + type + '" id="' + esc(o.id) + '"' + (o.name ? ' name="' + esc(o.name) + '"' : '') + (o.value != null ? ' value="' + esc(o.value) + '"' : '') +
      (o.checked ? ' checked' : '') + (o.disabled ? ' disabled' : '') + attrsHtml(o.attrs) + '><label for="' + esc(o.id) + '">' + esc(o.label) + '</label></div>';
  };

  // Runtime: shows (or, with no text, clears) the message under a field. root is the form (or the document); id is the control's id.
  function fieldParts(root, id) {
    const scope = root && root.querySelector ? root : (typeof document !== 'undefined' ? document : null);
    if (!scope) return { input: null, err: null };
    // The form first, then the page by id (a form that is not in the page yet, or a page drawn without a form element, still finds its fields).
    const find = function (elementId) {
      const inForm = scope.querySelector ? scope.querySelector('#' + elementId) : null;
      return inForm || (typeof document !== 'undefined' && document.getElementById ? document.getElementById(elementId) : null);
    };
    return { input: find(id), err: find(id + '-err') };
  }
  ui.setFieldError = function (root, id, text) {
    const p = fieldParts(root, id);
    if (p.err) {
      p.err.innerHTML = text ? icon('alert', 16) + esc(text) : '';
      p.err.hidden = !text;
    }
    if (p.input) {
      if (text) p.input.setAttribute('aria-invalid', 'true'); else if (p.input.removeAttribute) p.input.removeAttribute('aria-invalid');
    }
    return p.input;
  };
  ui.clearFieldError = function (root, id) { return ui.setFieldError(root, id, ''); };
  ui.focusFirstInvalid = function (root) {
    const first = root && root.querySelector ? root.querySelector('[aria-invalid="true"]') : null;
    if (first && first.focus) { first.focus(); return true; }
    return false;
  };

  // Pure: rules is { <field id>: function (value, values) -> message ('' = fine) }; returns [{ id, message }] in the order of the rules.
  ui.validateValues = function (values, rules) {
    const v = values || {};
    const out = [];
    Object.keys(rules || {}).forEach(function (id) {
      const rule = rules[id];
      const message = typeof rule === 'function' ? rule(v[id], v) : '';
      if (message) out.push({ id: id, message: String(message) });
    });
    return out;
  };

  // "3 things to fix" with a link to each field. Only shown from three errors on (one or two are visible under their fields).
  ui.errorSummaryHtml = function (errors) {
    const list = Array.isArray(errors) ? errors : [];
    if (list.length < 3) return '';
    return '<div class="gs-errsum" role="alert" tabindex="-1" data-error-summary><h2 class="gs-errsum-title">' + list.length + ' things to fix</h2><ul>' +
      list.map(function (e) { return '<li><a href="#' + esc(e.id) + '" data-action="jump" data-target="' + esc(e.id) + '">' + esc(e.message) + '</a></li>'; }).join('') + '</ul></div>';
  };

  // Runtime: reads a form's named controls by id (or takes the values it is given, { <field id>: value }), applies the rules, shows each message, fills the summary
  // slot ([data-error-summary-slot]) and focuses the first invalid field. Returns { ok, errors }.
  ui.validateForm = function (form, rules, given) {
    const values = {};
    Object.keys(rules || {}).forEach(function (id) {
      if (given && has(given, id)) { values[id] = given[id]; return; }
      const el = form && form.querySelector ? form.querySelector('#' + id) : null;
      values[id] = el ? (el.type === 'checkbox' ? !!el.checked : el.value) : '';
    });
    const errors = ui.validateValues(values, rules);
    Object.keys(rules || {}).forEach(function (id) {
      const hit = errors.filter(function (e) { return e.id === id; })[0];
      ui.setFieldError(form, id, hit ? hit.message : '');
    });
    const slot = form && form.querySelector ? form.querySelector('[data-error-summary-slot]') : null;
    if (slot) slot.innerHTML = ui.errorSummaryHtml(errors);
    ui.focusFirstInvalid(form);
    return { ok: errors.length === 0, errors: errors };
  };

  // ── SAVE BAR (the default save model) ──
  // Edits are held until the person presses Save. The bar appears only when something changed, sticks to the bottom of the content (above the phone
  // tab bar), and leaves after Save, which writes "Saved at 8:14 PM ET" in the page head. Leaving with changes asks: Stay or Leave and discard.
  // Inline autosave is the exception: one independent, reversible control (a toggle, a select on one row) that says Saving..., then Saved.
  // Markup: put the bar inside the <form> (the Save button submits it) and give the form ui.dirtyFormAttrs(); the delegated listeners keep it current.
  ui.dirtyFormAttrs = function () { return ' data-dirty-form data-input="dirty-form" data-change="dirty-form"'; };

  // opts: { text, saveLabel, saveVariant ('secondary' when several bars can show at once; default primary), discardLabel, busy, busyLabel } for a form whose values are read from its controls (ui.dirtyFormAttrs). A page that keeps a
  // DRAFT in state and draws itself again after every change passes { count } (how many things differ from what is saved: 0 hides the bar) and
  // { discardAttrs } (the data-action that puts the draft back); ui.saveBar.sync then keeps the leave guard in step after each draw.
  ui.saveBarHtml = function (opts) {
    const o = opts || {};
    const stateful = typeof o.count === 'number';
    const n = stateful ? Math.max(0, Math.floor(o.count)) : 0;
    const discardAttrs = Object.assign({ 'data-action': 'savebar-discard', 'data-key': 'savebar-discard' }, o.discardAttrs || {});
    return '<div class="gs-savebar" role="region" aria-label="Unsaved changes" data-savebar' + (stateful ? ' data-savebar-count="' + n + '"' : '') + (stateful && n > 0 ? '' : ' hidden') + '><span class="gs-savebar-text" role="status" data-savebar-text>' + esc(stateful ? ui.saveBar.text(n || 1) : (o.text || '1 unsaved change')) + '</span>' +
      '<span class="gs-savebar-actions">' + ui.buttonHtml({ label: o.discardLabel || 'Discard', variant: 'ghost', attrs: discardAttrs }) +
      ui.buttonHtml({ label: o.saveLabel || 'Save changes', variant: o.saveVariant === 'secondary' ? 'secondary' : 'primary', type: 'submit', busy: !!o.busy, busyLabel: o.busyLabel || 'Saving...', attrs: { 'data-key': 'savebar-save' } }) + '</span></div>';
  };

  // The save status in the page head: "Saved at 8:14 PM ET" (success ink) or "Unsaved changes" (warning ink).
  ui.savedStatusHtml = function (text, kind) {
    if (!text) return '<span class="gs-saved-status" data-saved-status></span>';
    return '<span class="gs-saved-status is-' + (kind === 'unsaved' ? 'unsaved' : 'saved') + '" data-saved-status role="status">' + esc(text) + '</span>';
  };

  function namedControls(form) {
    const list = form && form.elements ? Array.prototype.slice.call(form.elements) : [];
    return list.filter(function (el) { return el && el.name && !el.disabled && el.type !== 'submit' && el.type !== 'button' && el.type !== 'hidden'; });
  }

  ui.saveBar = {
    // { name: value } for every named control of a form (a checkbox is its checked state, a radio group its checked value).
    snapshot: function (form) {
      const out = {};
      namedControls(form).forEach(function (el) {
        if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; else if (!has(out, el.name)) out[el.name] = ''; return; }
        if (el.type === 'checkbox') { out[el.value && el.value !== 'on' ? el.name + ':' + el.value : el.name] = el.checked ? 'on' : ''; return; }
        out[el.name] = String(el.value == null ? '' : el.value);
      });
      return out;
    },
    // The names whose values differ between two snapshots.
    diff: function (a, b) {
      const x = a || {}, y = b || {};
      const names = Object.keys(x).concat(Object.keys(y).filter(function (k) { return !has(x, k); }));
      return names.filter(function (k) { return String(x[k] == null ? '' : x[k]) !== String(y[k] == null ? '' : y[k]); });
    },
    count: function (a, b) { return ui.saveBar.diff(a, b).length; },
    text: function (n) { return n === 1 ? '1 unsaved change' : n + ' unsaved changes'; },
    // How many settings differ between two plain JSON drafts (a saved override and the edited one): every changed leaf counts once, and an item added to
    // or removed from a list of objects counts once as a whole. Lists of plain values compare as one leaf.
    draftChanges: function (saved, draft) {
      const isObj = function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); };
      const hasObj = function (v) { return Array.isArray(v) && v.some(isObj); };
      let n = 0;
      (function walk(a, b) {
        if (isObj(a) || isObj(b)) {
          const x = isObj(a) ? a : {}, y = isObj(b) ? b : {};
          Object.keys(x).concat(Object.keys(y).filter(function (k) { return !has(x, k); })).forEach(function (k) { walk(x[k], y[k]); });
        } else if (hasObj(a) || hasObj(b)) {
          const x = Array.isArray(a) ? a : [], y = Array.isArray(b) ? b : [];
          for (let i = 0; i < Math.max(x.length, y.length); i++) { if (i >= x.length || i >= y.length) n += 1; else walk(x[i], y[i]); }
        } else if (JSON.stringify(a === undefined ? null : a) !== JSON.stringify(b === undefined ? null : b)) {
          n += 1;
        }
      })(saved, draft);
      return n;
    },
    // A draft page's bar after a change that does not redraw the page: shows or hides it for n changes and keeps the leave guard in step.
    setCount: function (root, n) {
      const scope = root || (typeof document !== 'undefined' ? document : null);
      const bar = scope && scope.querySelector ? scope.querySelector('[data-savebar]') : null;
      if (bar) {
        bar.hidden = n === 0;
        bar.setAttribute('data-savebar-count', String(n));
        const text = bar.querySelector ? bar.querySelector('[data-savebar-text]') : null;
        if (text && n > 0) text.textContent = ui.saveBar.text(n);
      }
      ui.unsaved.set('draft', n > 0);
      ui.saveBar.paintStatus(n);
      return n;
    },
    // After a page is drawn: every held-back form takes its values as saved, and a draft page's bar tells the leave guard whether it has changes.
    sync: function (root) {
      if (!root || !root.querySelectorAll) return;
      const forms = root.querySelectorAll('form[data-dirty-form]');
      for (let i = 0; i < forms.length; i++) ui.saveBar.bind(forms[i]);
      const bars = root.querySelectorAll('[data-savebar-count]');
      for (let i = 0; i < bars.length; i++) {
        const n = Number(bars[i].getAttribute('data-savebar-count')) || 0;
        ui.unsaved.set('draft', n > 0);
        ui.saveBar.paintStatus(n);
      }
    },
    // The head's save status follows the bar: "Unsaved changes" while there are some, what it said ("Saved at 8:14 PM ET") when there are none.
    paintStatus: function (n) {
      const doc = typeof document !== 'undefined' ? document : null;
      const slot = doc && doc.querySelector ? doc.querySelector('[data-saved-status]') : null;
      if (!slot) return;
      if (n > 0) {
        if (!slot.getAttribute('data-was')) slot.setAttribute('data-was', slot.textContent || '-');
        slot.textContent = 'Unsaved changes';
        slot.className = 'gs-saved-status is-unsaved';
      } else if (slot.getAttribute('data-was')) {
        const was = slot.getAttribute('data-was');
        slot.setAttribute('data-was', '');
        slot.textContent = was === '-' ? '' : was;
        slot.className = 'gs-saved-status' + (was !== '-' ? ' is-saved' : '');
      }
    },
    // Takes the form's current values as "saved" (call after a render and after a Save).
    bind: function (form) {
      if (!form) return;
      form.__gsSaved = ui.saveBar.snapshot(form);
      ui.saveBar.update(form);
    },
    // Shows or hides the bar for the number of changes; keeps the leave guard in step. Returns the count.
    update: function (form) {
      if (!form) return 0;
      const n = ui.saveBar.count(form.__gsSaved || {}, ui.saveBar.snapshot(form));
      const bar = form.querySelector ? form.querySelector('[data-savebar]') : null;
      if (bar) {
        bar.hidden = n === 0;
        const text = bar.querySelector ? bar.querySelector('[data-savebar-text]') : null;
        if (text) text.textContent = ui.saveBar.text(n);
      }
      ui.unsaved.set(form.id || 'form', n > 0);
      ui.saveBar.paintStatus(n);
      return n;
    },
    // After a successful Save: the new values are the saved ones, the bar leaves, the head says when (guild zone).
    markSaved: function (form, ms, timeZone) {
      if (!form) return;
      ui.saveBar.bind(form);
      const doc = typeof document !== 'undefined' ? document : null;
      const slot = doc && doc.querySelector ? doc.querySelector('[data-saved-status]') : null;
      if (slot) {
        const when = ui.timeInZone(typeof ms === 'number' ? ms : Date.now(), timeZone);
        slot.textContent = when ? 'Saved at ' + when : 'Saved';
        slot.className = 'gs-saved-status is-saved';
      }
    },
  };

  G.handlers.input['dirty-form'] = function (form) { ui.saveBar.update(form); };
  G.handlers.change['dirty-form'] = function (form) { ui.saveBar.update(form); };
  G.handlers.click['savebar-discard'] = function (el) {
    const form = el && el.closest ? el.closest('form') : null;
    if (!form) return;
    if (form.reset) form.reset();
    const flagged = form.querySelectorAll ? form.querySelectorAll('[aria-invalid="true"]') : [];
    for (let i = 0; i < flagged.length; i++) ui.clearFieldError(form, flagged[i].id);
    ui.saveBar.update(form);
  };

  // ── LEAVING WITH UNSAVED CHANGES ──
  // A page with a held-back form registers it (the save bar does this); a click on an in-app link then asks "Stay or Leave and discard" instead of
  // navigating, and closing or reloading the tab uses the browser's own prompt (beforeunload). Back / Forward cannot be held back by a page.
  const dirtyForms = {};
  let pendingLeave = '';
  ui.unsaved = {
    set: function (key, dirty) { if (dirty) dirtyForms[key] = true; else delete dirtyForms[key]; },
    isDirty: function () { return Object.keys(dirtyForms).length > 0; },
    clear: function () { Object.keys(dirtyForms).forEach(function (k) { delete dirtyForms[k]; }); pendingLeave = ''; },
    pendingHref: function () { return pendingLeave; },
    leaveDialogHtml: function () {
      return ui.dialogHtml({ kind: 'confirm', title: 'Leave this page?', text: 'You have changes that are not saved. If you leave now they are discarded.',
        cancel: { label: 'Stay', attrs: { 'data-action': 'unsaved-stay' } }, primary: { label: 'Leave and discard', variant: 'danger', attrs: { 'data-action': 'unsaved-leave' } }, formless: true });
    },
    // Capture-phase click: true when it held the click back and opened the question. Only plain clicks on in-app links (#/...) are held.
    guardClick: function (ev) {
      if (!ui.unsaved.isDirty() || !ev || !ev.target || !ev.target.closest) return false;
      if (ev.defaultPrevented || (ev.button !== undefined && ev.button !== 0) || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return false;
      const link = ev.target.closest('a[href]');
      if (!link || link.getAttribute('target') === '_blank') return false;
      const href = link.getAttribute('href') || '';
      if (href.indexOf('#/') !== 0) return false;
      if (typeof location !== 'undefined' && location && location.hash === href) return false;
      if (ev.preventDefault) ev.preventDefault();
      if (ev.stopPropagation) ev.stopPropagation();
      pendingLeave = href;
      ui.openDialog(ui.unsaved.leaveDialogHtml(), { labelledBy: 'dlg-title' });
      return true;
    },
    install: function (win) {
      if (!win || !win.addEventListener) return;
      win.addEventListener('beforeunload', function (ev) {
        if (!ui.unsaved.isDirty()) return undefined;
        if (ev && ev.preventDefault) ev.preventDefault();
        if (ev) ev.returnValue = '';
        return '';
      });
    },
  };
  G.handlers.click['unsaved-stay'] = function (el) { pendingLeave = ''; ui.closeDialogOf(el); };
  G.handlers.click['unsaved-leave'] = function (el) {
    const href = pendingLeave;
    ui.unsaved.clear();
    ui.closeDialogOf(el);
    if (href && typeof location !== 'undefined' && location) location.hash = href.slice(1);
  };

  // ── INLINE BANNERS AND TOASTS ──
  // Default feedback is INLINE: a banner at the top of the region that changed; it stays until dismissed or replaced, so an officer who looked away
  // can still read what happened. Results say what happened, to whom, with numbers; errors say what failed, what is safe and the next step. Banner actions
  // are secondary buttons, never the primary; Dismiss is always present. Success and info are role=status, warning and danger role=alert.
  // A toast is only for a local, reversible action with no follow-up (Copied, Link copied, Filter cleared): one line, 4 s, never an error, never the
  // only record of something sent.
  const BANNER_ICON = { success: 'check', info: 'info', warning: 'alert', danger: 'circleX' };
  ui.BANNER_TONES = Object.keys(BANNER_ICON);

  // opts: { tone, title, text, actions: [buttonOpts], dismissible (default true), id }
  ui.bannerHtml = function (opts) {
    const o = opts || {};
    const tone = has(BANNER_ICON, o.tone) ? o.tone : 'info';
    const role = tone === 'warning' || tone === 'danger' ? 'alert' : 'status';
    const actions = (Array.isArray(o.actions) ? o.actions : []).filter(Boolean).map(function (a, i) {
      return ui.buttonHtml(Object.assign({ variant: i === 0 ? 'secondary' : 'ghost', size: 'sm' }, a));
    }).join('');
    return '<div class="gs-banner gs-banner-' + tone + '" role="' + role + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + '>' + icon(BANNER_ICON[tone], 22) +
      '<div class="gs-banner-body">' + (o.title ? '<p class="gs-banner-title">' + esc(o.title) + '</p>' : '') + (o.text ? '<p class="gs-banner-text">' + esc(o.text) + '</p>' : '') +
      (actions ? '<div class="gs-banner-actions">' + actions + '</div>' : '') + '</div>' +
      (o.dismissible === false ? '' : '<button type="button" class="gs-icon-btn gs-banner-x" aria-label="Dismiss message" data-action="banner-dismiss">' + icon('close', 18) + '</button>') + '</div>';
  };
  G.handlers.click['banner-dismiss'] = function (el) {
    const banner = el && el.closest ? el.closest('.gs-banner') : null;
    if (banner && banner.remove) banner.remove();
  };

  ui.toastHtml = function (text) {
    return '<div class="gs-toast" role="status">' + icon('check', 18) + '<span class="gs-toast-text">' + esc(text) + '</span><button type="button" class="gs-toast-x" data-action="toast-dismiss">Dismiss</button></div>';
  };
  const TOAST_MS = 4000;
  let toastTimer = null;
  // Shows one toast for 4 s; opts.tone 'warning' / 'danger' is refused (false): an error goes inline. Returns true when shown.
  ui.toast = function (text, opts) {
    const o = opts || {};
    if (!text || o.tone === 'danger' || o.tone === 'warning' || o.tone === 'error') return false;
    if (typeof document === 'undefined' || !document.getElementById || !document.body) return false;
    let host = document.getElementById('gs-toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'gs-toasts';
      host.className = 'gs-toasts gs-scope';
      document.body.appendChild(host);
    }
    host.innerHTML = ui.toastHtml(text);
    if (toastTimer && typeof clearTimeout === 'function') clearTimeout(toastTimer);
    if (typeof setTimeout === 'function') toastTimer = setTimeout(function () { host.innerHTML = ''; toastTimer = null; }, o.ms || TOAST_MS);
    return true;
  };
  G.handlers.click['toast-dismiss'] = function (el) {
    const host = el && el.closest ? el.closest('#gs-toasts') : null;
    if (host) host.innerHTML = '';
  };

  // ── EMPTY, LOADING AND ERROR STATES ──
  // Empty: the reason, then the next step as one button; filters and segments stay visible above it. Three kinds: first use (explain and offer the
  // action), filtered (offer to clear the filter), good news (a check and one line, no button, small). Loading: skeleton rows shown after 300 ms
  // (CSS delay), aria-busy and the words "Loading raids..."; no page spinners. Error in one region: a danger banner inside that region with Try again,
  // the rest of the page stays usable; always says what is safe.
  ui.emptyStateHtml = function (opts) {
    const o = opts || {};
    const actions = (Array.isArray(o.actions) ? o.actions : []).filter(Boolean).map(function (a, i) { return ui.buttonHtml(Object.assign({ variant: i === 0 ? 'primary' : 'secondary' }, a)); }).join('');
    if (o.kind === 'good') {
      return '<div class="gs-empty-good" role="status">' + icon('check', 20) + '<span>' + esc(o.text || o.title) + '</span></div>';
    }
    if (o.kind === 'filtered') {
      return '<div class="gs-empty2 is-filtered"><h2 class="gs-empty2-title">' + esc(o.title) + '</h2>' + (o.text ? '<p class="gs-empty2-text">' + esc(o.text) + '</p>' : '') +
        (actions ? '<div class="gs-empty2-actions">' + actions.replace(/gs-btn gs-btn-molten/g, 'gs-btn') + '</div>' : '') + '</div>';
    }
    return '<div class="gs-empty2 is-first"><div class="gs-empty-icon">' + icon(o.icon || 'raids', 26) + '</div><h2 class="gs-empty2-title">' + esc(o.title) + '</h2>' +
      (o.text ? '<p class="gs-empty2-text">' + esc(o.text) + '</p>' : '') + (actions ? '<div class="gs-empty2-actions">' + actions + '</div>' : '') + '</div>';
  };

  ui.loadingHtml = function (opts) {
    const o = opts || {};
    const n = Math.max(1, Math.min(8, Math.floor(Number(o.rows)) || 4));
    let rows = '';
    for (let i = 0; i < n; i++) rows += '<div class="gs-skel-row" aria-hidden="true"><span></span><span></span><span></span></div>';
    return '<div class="gs-skeleton" aria-busy="true"><p class="gs-skeleton-label">' + esc(o.label || 'Loading') + '...</p>' + rows + '</div>';
  };

  // opts: { title, text, safe (what is safe; default "Your data is safe."), retry: { label, attrs } }
  ui.errorRegionHtml = function (opts) {
    const o = opts || {};
    const retry = o.retry ? '<div class="gs-banner-actions">' + ui.buttonHtml(Object.assign({ label: 'Try again', variant: 'secondary', size: 'sm' }, o.retry)) + '</div>' : '';
    return '<div class="gs-banner gs-banner-danger gs-errregion" role="alert"><div class="gs-banner-body"><p class="gs-banner-title">' + esc(o.title) + '</p><p class="gs-banner-text">' +
      esc((o.text ? o.text + ' ' : '') + (o.safe === undefined ? 'Your data is safe.' : o.safe)) + '</p>' + retry + '</div></div>';
  };

  // ── ITEM LINKS (Wowhead) ──
  // The one place an item becomes markup. The link carries Wowhead's data-wowhead hook, so Wowhead's tooltip script (loaded the first time a rendered
  // page holds such a link) adds the icon, the quality colour and the hover tooltip. Without the script (offline, blocked) it stays a plain link to the
  // item's Wowhead page. Path and domain are the same word per game version: Wowhead's own tooltips.js (checked 2026-10-18) names WoW Forever
  // "forever" (page path /forever/, data domain forever; the item pages and nether.wowhead.com tooltip data answer for it), TBC Classic "tbc" and Classic "classic".
  const WOWHEAD_SITE = { tbc: 'tbc', classic: 'classic', forever: 'forever' };
  const WOWHEAD_SCRIPT = 'https://wow.zamimg.com/js/tooltips.js';
  const WOWHEAD_CONFIG = { colorLinks: true, iconizeLinks: true, renameLinks: true };

  function itemIdOf(itemId) {
    const n = Number(itemId);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  // The Wowhead page of an item for this guild's game version; null for an unknown version or item id (no link then).
  ui.itemUrl = function (gameVersion, itemId) {
    const id = itemIdOf(itemId);
    return id && has(WOWHEAD_SITE, gameVersion) ? 'https://www.wowhead.com/' + WOWHEAD_SITE[gameVersion] + '/item=' + id : null;
  };

  ui.qualityClass = function (q) { return typeof q === 'number' && q >= 0 && q <= 7 && Math.floor(q) === q ? ' gs-q-' + q : ''; };

  // The item name in its quality colour, linked to Wowhead where the game version allows. item: { itemId, itemName, quality }. The name is data: escaped.
  // With no stored name the text is "Item <id>"; Wowhead's script renames the link to the real name once it has loaded.
  ui.itemLinkHtml = function (item, gameVersion) {
    const it = item || {};
    const label = it.itemName || (it.itemId ? 'Item ' + it.itemId : 'Unknown item');
    const cls = 'gs-item' + ui.qualityClass(it.quality);
    const url = ui.itemUrl(gameVersion, it.itemId);
    if (!url) return '<span class="' + cls + '">' + esc(label) + '</span>';
    return '<a class="' + cls + '" href="' + esc(url) + '" data-wowhead="' + esc('item=' + itemIdOf(it.itemId) + '&domain=' + WOWHEAD_SITE[gameVersion]) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
  };

  // ── ITEM TOOLTIPS (Wowhead's script, loaded lazily) ──
  // Nothing loads at start-up and no other page ever loads it: ui.refreshItemTooltips(root) is called after a render that may have added item links and
  // does nothing unless root holds one. The first such call adds the script once (async); its config is set here, from this self-hosted file, because the
  // CSP allows no inline script. Later calls only ask the script to scan the links again. If the script cannot load the links stay plain links.
  let tooltipScript = 'idle'; // idle | loading | ready | failed

  function rescanWowheadLinks() {
    const w = typeof globalThis !== 'undefined' ? globalThis : null;
    if (!w) return false;
    try {
      if (w.WH && w.WH.Tooltips && typeof w.WH.Tooltips.refreshLinks === 'function') { w.WH.Tooltips.refreshLinks(); return true; }
      if (w.$WowheadPower && typeof w.$WowheadPower.refreshLinks === 'function') { w.$WowheadPower.refreshLinks(); return true; }
    } catch (e) { /* a Wowhead-side error never breaks a page */ }
    return false;
  }

  function loadWowheadScript() {
    if (tooltipScript !== 'idle') return;
    if (typeof document === 'undefined' || !document.createElement) return;
    const host = document.head || document.documentElement;
    if (!host || !host.appendChild) return;
    globalThis.whTooltips = Object.assign({}, WOWHEAD_CONFIG);
    const el = document.createElement('script');
    el.async = true;
    el.src = WOWHEAD_SCRIPT;
    el.onload = function () { tooltipScript = 'ready'; rescanWowheadLinks(); };
    el.onerror = function () { tooltipScript = 'failed'; };
    tooltipScript = 'loading';
    host.appendChild(el);
  }

  ui.refreshItemTooltips = function (root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelector !== 'function' || !scope.querySelector('a[data-wowhead]')) return false;
    loadWowheadScript();
    if (tooltipScript === 'ready') rescanWowheadLinks();
    return true;
  };
  ui.itemTooltipsState = function () { return tooltipScript; };

  // ── DIALOGS ──
  // Four kinds: form, confirm, destructive and step. Native <dialog> (ui.openDialog): Esc closes, focus is trapped and returns to the opener. Width 520
  // (760 for previews), padding 24, title 24 px, actions right-aligned, the primary last. Initial focus: the first field; for confirm and destructive
  // dialogs, Cancel (it gets autofocus). Dialogs never stack: opening one replaces the open one, and a second decision is the "step 2" body of the
  // same dialog with Back (ui.replaceDialogBody). A confirm names the consequence and who is told; a destructive one names the object and says it can't
  // be undone. On a phone it is a bottom sheet with stacked 48 px buttons, the primary on top.
  //   opts: { kind, title, titleId, text, bodyHtml, step ('Link a Raid-Helper event - step 2 of 2'), primary: buttonOpts, cancel: buttonOpts | false, back: buttonOpts,
  //           formAttrs (e.g. { 'data-submit': 'x' }), formless (no <form>: the primary is a plain button), wide (760 wide, for previews) }
  ui.dialogHtml = function (opts) {
    const o = opts || {};
    const kind = ['form', 'confirm', 'destructive', 'step'].indexOf(o.kind) >= 0 ? o.kind : 'form';
    const titleId = esc(o.titleId || 'dlg-title');
    const quiet = kind === 'confirm' || kind === 'destructive';
    const back = o.back ? ui.buttonHtml(Object.assign({ variant: 'ghost' }, o.back, { label: o.back.label || 'Back' })) : '';
    const cancel = o.cancel === false ? '' : ui.buttonHtml(Object.assign({ variant: 'secondary', label: 'Cancel', attrs: { 'data-action': 'dialog-cancel' } }, o.cancel || {}, {
      attrs: Object.assign({ 'data-action': 'dialog-cancel' }, (o.cancel && o.cancel.attrs) || {}, quiet ? { autofocus: true } : {}) }));
    const primary = o.primary ? ui.buttonHtml(Object.assign({ variant: kind === 'destructive' ? 'danger' : 'primary', type: o.formless ? 'button' : 'submit' }, o.primary)) : '';
    const head = (o.step ? '<p class="gs-dialog-step">' + esc(o.step) + '</p>' : '') + '<h2 class="gs-dialog-title" id="' + titleId + '">' + esc(o.title) + '</h2>';
    const body = (o.text ? '<p class="gs-confirm-text" id="dlg-text">' + esc(o.text) + '</p>' : '') + (o.bodyHtml || '');
    const actions = '<div class="gs-dialog-actions">' + back + cancel + primary + '</div>';
    const cls = 'gs-dialog-form gs-dialog-' + kind + (o.wide ? ' gs-dialog-preview' : '') + (o.className ? ' ' + esc(o.className) : '');
    if (o.formless) return '<div class="' + cls + '">' + head + body + actions + '</div>';
    return '<form class="' + cls + '"' + attrsHtml(o.formAttrs) + ' novalidate>' + head + body + '<p class="gs-alert" id="dlg-error" role="alert" hidden></p>' + actions + '</form>';
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
