// ── UI TEMPLATES: the five page skeletons ───────────────────────
// Page-level helpers built from the parts in ui-kit.js. A page fills a template with its own content instead of laying out its own header,
// actions and sections, so every page of one kind has the same shape. Each returns markup (the arguments named ...Html are markup the caller
// already built and escaped); the classes are styled in guild.css under "Design framework". Page widths: list and object pages 1200, form and
// settings detail 760, matrices full width; message cards (sign-in, create guild) are the only centred pages.
//
//   ui.pageHeadHtml({ title, context, contextHtml, chipsHtml, back, more, primary })      the header every template starts with
//   ui.listPageHtml({ head, barHtml, bodyHtml, footHtml })                                  T1 list page: head, segment / filter bar, table, footer line
//   ui.objectPageHtml({ head, stages, nextStep, youHtml, sections })                        T2 object page: head, stage strip, next-step bar, You line, sections
//   ui.settingsPageHtml({ groups, activeKey, view, listHref, title, purpose, savedHtml, bodyHtml, saveBarHtml })   T3 settings: group list + detail
//   ui.homePageHtml({ head, noticesHtml, attention, cards, pageClass })  /  ui.attentionRowsHtml(items)   T4 home: needs-attention list first, then cards
//   ui.flowPageHtml({ head, steps, current, bodyHtml, commitBarHtml })  /  ui.stepperHtml / ui.commitBarHtml     T5 flow: paste -> preview -> commit
(function (G) {
  'use strict';

  const ui = G.ui = G.ui || {};
  const icon = function (name, size) { return G.icons.icon(name, size); };

  // The page header. One primary, rightmost; the one overflow menu is always labelled More (a dots icon button on a phone, where the primary moves
  // to a full-width button under the context line). Nothing else belongs here.
  //   title            the h1 (gold, one per page); titleId defaults to 'page-title'
  //   context / contextHtml   the one line under it: team, schedule, counts (contextHtml is trusted markup, e.g. with a time and its zone)
  //   chipsHtml        a state chip next to the title (ui.chipHtml)
  //   back             { href, label } a back link above the title
  //   more             { id, items } for ui.menuHtml (label "More")
  //   primary          ui.buttonHtml options for the page's one primary action
  ui.pageHeadHtml = function (opts) {
    const o = opts || {};
    const titleId = o.titleId || 'page-title';
    const back = o.back && o.back.href ? '<a class="gs-back-link" href="' + esc(o.back.href) + '">' + icon('arrow', 16) + '<span>' + esc(o.back.label || 'Back') + '</span></a>' : '';
    const more = o.more ? ui.menuHtml(Object.assign({ label: 'More', phoneIcon: true, triggerClass: 'gs-btn' }, o.more)) : '';
    const primary = o.primary ? ui.buttonHtml(Object.assign({ variant: 'primary' }, o.primary)) : '';
    const context = o.contextHtml || (o.context ? esc(o.context) : '');
    return '<header class="gs-pagehead">' + back + '<div class="gs-pagehead-row"><div class="gs-pagehead-title">' +
      '<div class="gs-pagehead-h"><h1 class="gs-h1" id="' + esc(titleId) + '" tabindex="-1">' + esc(o.title) + '</h1>' + (o.chipsHtml || '') + '</div>' +
      (context ? '<p class="gs-sub gs-pagehead-context">' + context + '</p>' : '') + '</div>' +
      (more || primary ? '<div class="gs-pagehead-actions">' + more + primary + '</div>' : '') + '</div></header>';
  };

  // T1 - list page (Raids, Roster, Loot, Review queue, Applications, Away notices). The segment bar filters the same table and stays when the table is
  // empty (pass ui.emptyStateHtml as bodyHtml); the first column is the link; times carry the zone; the footer line says what the list is.
  ui.listPageHtml = function (opts) {
    const o = opts || {};
    return '<div class="gs-page gs-list-page">' + ui.pageHeadHtml(o.head) + (o.barHtml ? '<div class="gs-listbar">' + o.barHtml + '</div>' : '') +
      '<div class="gs-listbody" aria-live="polite">' + (o.bodyHtml || '') + '</div>' + (o.footHtml ? '<p class="gs-listfoot">' + o.footHtml + '</p>' : '') + '</div>';
  };

  // T2 - object page (a raid, later a person). Header (no primary there), the stage strip, the next-step bar (the page's one primary), the viewer's own line
  // ("You are in Group 2 as Enhancement Shaman"), then the sections in the same order for every object. A locked section says when it opens.
  //   stages     ui.stageStripHtml options          nextStep   ui.nextStepHtml options (omit for none)
  //   noticesHtml  banners and notes between the header and the stage strip      afterYouHtml  a card that belongs right under the You line (a member's seat)
  //   pageClass  an extra class on the page
  //   sections   [{ id, title, chipHtml, bodyHtml, locked (text: when it opens), actionsHtml, bare }]; the id is the stage tile's jump target. A bare section is
  //              only the jump target around bodyHtml, for a card that draws its own heading and tools.
  ui.objectPageHtml = function (opts) {
    const o = opts || {};
    const sections = (Array.isArray(o.sections) ? o.sections : []).filter(Boolean).map(function (s) {
      const id = esc(s.id);
      if (s.bare) return '<div class="gs-osection-bare" id="' + id + '" tabindex="-1">' + (s.bodyHtml || '') + '</div>';
      return '<section class="gs-osection' + (s.locked ? ' is-locked' : '') + '" id="' + id + '" tabindex="-1" aria-labelledby="' + id + '-h"><div class="gs-osection-head"><h2 class="gs-h2" id="' + id + '-h">' + esc(s.title) + '</h2>' +
        (s.chipHtml || '') + (s.actionsHtml ? '<span class="gs-osection-actions">' + s.actionsHtml + '</span>' : '') + '</div>' +
        '<div class="gs-osection-body">' + (s.locked ? '<p class="gs-fine">' + esc(s.locked) + '</p>' : (s.bodyHtml || '')) + '</div></section>';
    }).join('');
    return '<div class="gs-page gs-object-page' + (o.pageClass ? ' ' + esc(o.pageClass) : '') + '">' + ui.pageHeadHtml(o.head) + (o.noticesHtml || '') + (o.stages ? ui.stageStripHtml(o.stages) : '') + (o.nextStep ? ui.nextStepHtml(o.nextStep) : '') +
      (o.youHtml ? '<div class="gs-youline">' + o.youHtml + '</div>' : '') + (o.afterYouHtml || '') + sections + '</div>';
  };

  // T3 - settings: a grouped list of pages on the left and one page at a time (760 wide) beside it. On a phone the list is the first screen and the page
  // opens with a Back link; the Save bar sits above the tab bar. Every page has a heading and a one-line purpose, and the save status in its head.
  //   groups   [{ label, items: [{ key, label, href, isNew }] }]      activeKey  the open page
  //   view     'list' | 'detail' (phone: which pane shows; desktop shows both)       listHref  where the phone Back link goes
  //   heading / subline   the page's h1 and its one line ("Vindicated - 16 pages in 5 groups"); on a phone it shows with the list only
  ui.settingsPageHtml = function (opts) {
    const o = opts || {};
    const groups = (Array.isArray(o.groups) ? o.groups : []).filter(Boolean).map(function (g, i) {
      const headId = 'sg-' + i;
      return '<div class="gs-sgroup"><h2 class="gs-sgroup-h" id="' + headId + '">' + esc(g.label) + '</h2><ul class="gs-sgroup-list" aria-labelledby="' + headId + '">' + (Array.isArray(g.items) ? g.items : []).filter(Boolean).map(function (it) {
        const active = it.key === o.activeKey;
        return '<li><a class="gs-sitem' + (active ? ' is-active' : '') + '" href="' + esc(it.href) + '"' + (active ? ' aria-current="page"' : '') + '>' + esc(it.label) + (it.isNew ? ui.newBadgeHtml() : '') + '</a></li>';
      }).join('') + '</ul></div>';
    }).join('');
    const view = o.view === 'list' ? 'list' : 'detail';
    const head = o.heading ? '<header class="gs-shead"><h1 class="gs-h1" id="page-title" tabindex="-1">' + esc(o.heading) + '</h1>' + (o.subline ? '<p class="gs-sub">' + esc(o.subline) + '</p>' : '') + '</header>' : '';
    return '<div class="gs-page gs-settings-page is-view-' + view + '">' + head + '<div class="gs-sgrid"><nav class="gs-slist" aria-label="Guild settings sections">' + groups + '</nav>' +
      '<div class="gs-sdetail">' + (o.listHref ? '<a class="gs-back-link gs-sback" href="' + esc(o.listHref) + '">' + icon('arrow', 16) + '<span>Settings</span></a>' : '') +
      '<header class="gs-sdetail-head"><div><h2 class="gs-h1 gs-sdetail-h" id="settings-title" tabindex="-1">' + esc(o.title) + '</h2>' + (o.purpose ? '<p class="gs-sub">' + esc(o.purpose) + '</p>' : '') + '</div>' +
      (o.savedHtml || ui.savedStatusHtml('')) + '</header><div class="gs-sdetail-body">' + (o.bodyHtml || '') + '</div>' + (o.saveBarHtml || '') + '</div></div></div>';
  };

  // The rows of an attention list (T4): a tone mark, a title with an optional muted line, and one secondary button. Used by Needs attention and by the
  // officer Home's "For your information" card. items: [{ tone (warning | danger | info), title, text, action: buttonOpts }].
  ui.attentionRowsHtml = function (items) {
    const list = (Array.isArray(items) ? items : []).filter(Boolean);
    return '<ul class="gs-attn2-list">' + list.map(function (it) {
      const tone = it.tone === 'danger' || it.tone === 'info' ? it.tone : 'warning';
      return '<li class="gs-attn2-item"><span class="gs-attn2-mark is-' + tone + '">' + icon(tone === 'info' ? 'info' : 'alert', 20) + '</span><div class="gs-attn2-text"><p class="gs-attn2-title">' + esc(it.title) + '</p>' +
        (it.text ? '<p class="gs-attn2-line">' + esc(it.text) + '</p>' : '') + '</div>' + (it.action ? ui.buttonHtml(Object.assign({ variant: 'secondary' }, it.action)) : '') + '</li>';
    }).join('') + '</ul>';
  };

  // T4 - home. Officer: "Needs attention" first whenever it has items (one secondary button per row); with none it shrinks to one line. Member: the next
  // raid and my attendance. attention: { title, items, count (the badge; defaults to the rows shown), goodText }; cards: [{ id, title, bodyHtml, className }] or [{ html }] for a card that
  // draws its own frame.
  ui.homePageHtml = function (opts) {
    const o = opts || {};
    const a = o.attention;
    let attention = '';
    if (a) {
      const items = (Array.isArray(a.items) ? a.items : []).filter(Boolean);
      const count = Number.isFinite(a.count) && a.count >= items.length ? Math.floor(a.count) : items.length;
      attention = items.length
        ? '<section class="gs-attn2" aria-labelledby="attn-h"><div class="gs-attn2-head"><h2 class="gs-h2" id="attn-h">' + esc(a.title || 'Needs attention') + '</h2>' +
          ui.countBadgeHtml(count, count + (count === 1 ? ' item needs' : ' items need') + ' attention') + '</div>' + ui.attentionRowsHtml(items) + '</section>'
        : ui.emptyStateHtml({ kind: 'good', text: a.goodText || 'Nothing needs you.' });
    }
    const cards = (Array.isArray(o.cards) ? o.cards : []).filter(Boolean).map(function (c) {
      if (c.html) return c.html; // a card that draws its own frame (the setup checklist)
      const id = esc(c.id || 'card-' + String(c.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
      return '<section class="gs-hcard' + (c.className ? ' ' + esc(c.className) : '') + '" id="' + id + '" aria-labelledby="' + id + '-h"><h2 class="gs-h2" id="' + id + '-h">' + esc(c.title) + '</h2><div class="gs-hcard-body">' + (c.bodyHtml || '') + '</div></section>';
    }).join('');
    return '<div class="gs-page gs-home-page' + (o.pageClass ? ' ' + esc(o.pageClass) : '') + '">' + ui.pageHeadHtml(o.head) + (o.noticesHtml || '') + attention + cards + '</div>';
  };

  // T5 - flow (imports, New raid): source -> preview -> commit. The stepper names the steps; the preview leads with a summary sentence; the sticky commit
  // bar says how many will be imported and that nothing is saved yet (Back keeps the input, Cancel leaves). The result is an INLINE success banner with
  // counts and one next step, never a toast. Up to about ten rows and no per-row choices fit a dialog instead; anything longer is this page.
  //   steps ['Source', 'Preview', 'Import']; current 1..3 (4 = all done)
  ui.stepperHtml = function (opts) {
    const o = opts || {};
    const steps = Array.isArray(o.steps) && o.steps.length ? o.steps : ['Source', 'Preview', 'Import'];
    const current = Math.max(1, Math.min(steps.length + 1, Math.floor(Number(o.current)) || 1));
    return '<ol class="gs-stepper" aria-label="' + esc(o.label || 'Steps') + '">' + steps.map(function (label, i) {
      const n = i + 1;
      const state = n < current ? 'done' : n === current ? 'current' : 'later';
      return '<li class="gs-step is-' + state + '"' + (state === 'current' ? ' aria-current="step"' : '') + '><span class="gs-step-no" aria-hidden="true">' + (state === 'done' ? icon('check', 14) : n) + '</span>' +
        '<span class="gs-step-name">' + esc(label) + '</span><span class="gs-sr">' + (state === 'done' ? ', done' : state === 'current' ? ', current step' : '') + '</span></li>';
    }).join('') + '</ol>';
  };

  // opts: { text ("23 of 24 will be imported."), note (default "Nothing is saved yet."), back, cancel, commit: buttonOpts (the primary) }
  ui.commitBarHtml = function (opts) {
    const o = opts || {};
    const back = o.back ? ui.buttonHtml(Object.assign({ variant: 'ghost', label: 'Back' }, o.back)) : '';
    const cancel = o.cancel ? ui.buttonHtml(Object.assign({ variant: 'secondary', label: 'Cancel' }, o.cancel)) : '';
    const commit = o.commit ? ui.buttonHtml(Object.assign({ variant: 'primary' }, o.commit)) : '';
    return '<div class="gs-commitbar" role="region" aria-label="Import"><p class="gs-commitbar-text"><strong>' + esc(o.text) + '</strong> <span class="gs-fine">' + esc(o.note === undefined ? 'Nothing is saved yet.' : o.note) + '</span></p>' +
      '<span class="gs-commitbar-actions">' + back + cancel + commit + '</span></div>';
  };

  ui.flowPageHtml = function (opts) {
    const o = opts || {};
    const stepper = Array.isArray(o.steps) ? ui.stepperHtml({ steps: o.steps, current: o.current, label: o.stepsLabel }) : '';
    return '<div class="gs-page gs-flow-page">' + ui.pageHeadHtml(o.head) + stepper + '<div class="gs-flowbody">' + (o.bodyHtml || '') + '</div>' + (o.commitBarHtml || '') + '</div>';
  };

  ui.TEMPLATES = ['list', 'object', 'settings', 'home', 'flow'];
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
