// ── UI TEMPLATES: the five page skeletons ───────────────────────
// Page-level helpers built from the parts in ui-kit.js. A page fills a template with its own content instead of laying out its own header,
// actions and sections, so every page of one kind has the same shape. Each returns markup (the arguments named ...Html are markup the caller
// already built and escaped); the classes are styled in guild.css under "Design framework". Page widths: list and object pages 1200, form and
// settings detail 760, matrices full width; message cards (sign-in, create guild) are the only centred pages.
//
//   ui.pageHeadHtml({ title, context, contextHtml, chipsHtml, back, more, primary })      the header every template starts with
//   ui.listPageHtml({ head, barHtml, bodyHtml, footHtml })                                  T1 list page: head, segment / filter bar, table, footer line
//   ui.objectPageHtml({ head, stages, nextStep, youHtml, sections })                        T2 object page: head, stage strip, next-step bar, You line, sections
//   ui.formPageHtml({ head, noticesHtml, bodyHtml, pageClass })  /  ui.docPageHtml(...)             T3 form page (one form, 760 wide) and the reading page
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
  //   iconHtml         markup before the title block (a person's spec icon)      titleClass   a class on the h1 (a character's class colour)
  //   more             { id, items } for ui.menuHtml (label "More")
  //   primary          ui.buttonHtml options for the page's one primary action
  ui.pageHeadHtml = function (opts) {
    const o = opts || {};
    const titleId = o.titleId || 'page-title';
    const back = o.back && o.back.href ? '<a class="gs-back-link" href="' + esc(o.back.href) + '">' + icon('arrow', 16) + '<span>' + esc(o.back.label || 'Back') + '</span></a>' : '';
    const more = o.more ? ui.menuHtml(Object.assign({ label: 'More', phoneIcon: true, triggerClass: 'gs-btn' }, o.more)) : '';
    const primary = o.primary ? ui.buttonHtml(Object.assign({ variant: 'primary' }, o.primary)) : '';
    const context = o.contextHtml || (o.context ? esc(o.context) : '');
    return '<header class="gs-pagehead">' + back + '<div class="gs-pagehead-row">' + (o.iconHtml ? '<span class="gs-pagehead-icon">' + o.iconHtml + '</span>' : '') + '<div class="gs-pagehead-title">' +
      '<div class="gs-pagehead-h"><h1 class="gs-h1' + (o.titleClass ? ' ' + esc(o.titleClass) : '') + '" id="' + esc(titleId) + '" tabindex="-1">' + esc(o.title) + '</h1>' + (o.chipsHtml || '') + '</div>' +
      (context ? '<p class="gs-sub gs-pagehead-context">' + context + '</p>' : '') + '</div>' +
      (more || primary ? '<div class="gs-pagehead-actions">' + more + primary + '</div>' : '') + '</div></header>';
  };

  // T1 - list page (Raids, Roster, Loot, Review queue, Applications, Away notices). The segment bar filters the same table and stays when the table is
  // empty (pass ui.emptyStateHtml as bodyHtml); the first column is the link; times carry the zone; the footer line says what the list is.
  //   noticesHtml  banners and notes between the header and the segment bar      pageClass  an extra class on the page (e.g. the attendance matrix's full width)
  ui.listPageHtml = function (opts) {
    const o = opts || {};
    return '<div class="gs-page gs-list-page' + (o.pageClass ? ' ' + esc(o.pageClass) : '') + '">' + ui.pageHeadHtml(o.head) + (o.noticesHtml || '') + (o.barHtml ? '<div class="gs-listbar">' + o.barHtml + '</div>' : '') +
      '<div class="gs-listbody" aria-live="polite">' + (o.bodyHtml || '') + '</div>' + (o.footHtml ? '<p class="gs-listfoot">' + o.footHtml + '</p>' : '') + '</div>';
  };

  // One section of an object page (the pieces that draw their own section, like a person's Attendance card, call this too, so every object's sections look the same).
  ui.objectSectionHtml = function (s) {
    if (!s) return '';
    const id = esc(s.id);
    if (s.bare) return '<div class="gs-osection-bare" id="' + id + '" tabindex="-1">' + (s.bodyHtml || '') + '</div>';
    return '<section class="gs-osection' + (s.locked ? ' is-locked' : '') + '" id="' + id + '" tabindex="-1" aria-labelledby="' + id + '-h"><div class="gs-osection-head"><h2 class="gs-h2" id="' + id + '-h">' + esc(s.title) + '</h2>' +
      (s.chipHtml || '') + (s.actionsHtml ? '<span class="gs-osection-actions">' + s.actionsHtml + '</span>' : '') + '</div>' +
      '<div class="gs-osection-body">' + (s.locked ? '<p class="gs-fine">' + esc(s.locked) + '</p>' : (s.bodyHtml || '')) + '</div></section>';
  };

  // T2 - object page (a raid, a person). Header (no primary there), the stage strip, the next-step bar (the page's one primary), the viewer's own line
  // ("You are in Group 2 as Enhancement Shaman"), then the sections in the same order for every object. A locked section says when it opens.
  //   stages     ui.stageStripHtml options          nextStep   ui.nextStepHtml options (omit for none)
  //   noticesHtml  banners and notes between the header and the stage strip      afterYouHtml  a card that belongs right under the You line (a member's seat)
  //   pageClass  an extra class on the page      footHtml  what closes the page after the last section (a person's Delete row)
  //   sections   [{ id, title, chipHtml, bodyHtml, locked (text: when it opens), actionsHtml, bare }]; the id is the stage tile's jump target. A bare section is
  //              only the jump target around bodyHtml, for a card that draws its own heading and tools.
  ui.objectPageHtml = function (opts) {
    const o = opts || {};
    const sections = (Array.isArray(o.sections) ? o.sections : []).filter(Boolean).map(ui.objectSectionHtml).join('');
    return '<div class="gs-page gs-object-page' + (o.pageClass ? ' ' + esc(o.pageClass) : '') + '">' + ui.pageHeadHtml(o.head) + (o.noticesHtml || '') + (o.stages ? ui.stageStripHtml(o.stages) : '') + (o.nextStep ? ui.nextStepHtml(o.nextStep) : '') +
      (o.youHtml ? '<div class="gs-youline">' + o.youHtml + '</div>' : '') + (o.afterYouHtml || '') + sections + (o.footHtml || '') + '</div>';
  };

  // T3 form page (one form on its own page, 760 wide): the header, notices, the form (fields from ui.fieldHtml, 44 px on a phone, inline validation) and, when the form
  // has several fields, the Save bar inside the <form> (bodyHtml is then the whole <form>). Apply, the guest sign-up, Linked accounts and New raid are this page.
  //   head ui.pageHeadHtml options   noticesHtml   bodyHtml   pageClass
  ui.formPageHtml = function (opts) {
    const o = opts || {};
    return '<div class="gs-page gs-form-page gs-page-narrow' + (o.pageClass ? ' ' + esc(o.pageClass) : '') + '">' + ui.pageHeadHtml(o.head) + (o.noticesHtml || '') + (o.bodyHtml || '') + '</div>';
  };

  // The reading page (Privacy, Future enhancements, Help): 760 wide, the same header, text sections, nothing to change. chipsHtml in the head can say Read-only.
  ui.docPageHtml = function (opts) {
    const o = opts || {};
    return '<div class="gs-page gs-doc-page gs-page-narrow' + (o.pageClass ? ' ' + esc(o.pageClass) : '') + '">' + ui.pageHeadHtml(o.head) + (o.noticesHtml || '') + (o.bodyHtml || '') + '</div>';
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

  // opts: { text ("23 of 24 will be imported."), note (default "Nothing is saved yet."), back, cancel, commit: buttonOpts (the primary), id (so a page can redraw the bar
  //         as the person ticks rows), inline (inside a panel on a page: not sticky) }
  ui.commitBarHtml = function (opts) {
    const o = opts || {};
    const back = o.back ? ui.buttonHtml(Object.assign({ variant: 'ghost', label: 'Back' }, o.back)) : '';
    const cancel = o.cancel ? ui.buttonHtml(Object.assign({ variant: 'secondary', label: 'Cancel' }, o.cancel)) : '';
    const commit = o.commit ? ui.buttonHtml(Object.assign({ variant: 'primary' }, o.commit)) : '';
    return '<div class="gs-commitbar' + (o.inline ? ' is-inline' : '') + '"' + (o.id ? ' id="' + esc(o.id) + '"' : '') + ' role="region" aria-label="Import"><p class="gs-commitbar-text" role="status"><strong>' + esc(o.text) + '</strong> <span class="gs-fine">' + esc(o.note === undefined ? 'Nothing is saved yet.' : o.note) + '</span></p>' +
      '<span class="gs-commitbar-actions">' + back + cancel + commit + '</span></div>';
  };

  ui.flowPageHtml = function (opts) {
    const o = opts || {};
    const stepper = Array.isArray(o.steps) ? ui.stepperHtml({ steps: o.steps, current: o.current, label: o.stepsLabel }) : '';
    return '<div class="gs-page gs-flow-page' + (o.pageClass ? ' ' + esc(o.pageClass) : '') + '">' + ui.pageHeadHtml(o.head) + stepper + '<div class="gs-flowbody">' + (o.bodyHtml || '') + '</div>' + (o.commitBarHtml || '') + '</div>';
  };

  // ── T5 for the imports ──
  // Every import (the four roster sources on their own pages; Gargul, TMB, softres and the pasted raid roster inside the raid page) walks the same three beats
  // with the same words: Source (give it, press Preview; the error is one human sentence), Preview (what will happen, the row choices that import has, the commit
  // bar that says how many will be imported and that nothing is saved yet), Import (an inline success banner with counts and one next step, never a toast).
  // What each import shows in its Source and Preview is its own: it passes that markup in and keeps its own server calls.
  ui.IMPORT_STEPS = ['Source', 'Preview', 'Import'];
  const IMPORT_STEP_NUMBER = { source: 1, preview: 2, result: 4 };
  const IMPORT_SOURCES = [
    { key: 'raid-helper', label: 'Raid-Helper event' }, { key: 'wcl', label: 'Warcraft Logs' }, { key: 'csv', label: 'CSV file' }, { key: 'bnet', label: 'Battle.net' },
  ];
  ui.IMPORT_SOURCES = IMPORT_SOURCES;

  function importStepOf(step) { return IMPORT_STEP_NUMBER[step] ? step : 'source'; }

  // The roster imports' source switch: where is the roster? Links to the four import pages (the paste is the raid page's, the CSV text box covers a pasted list).
  ui.importSourcesHtml = function (gid, active) {
    return '<nav class="gs-import-sources" aria-label="Where is your roster?"><p class="gs-import-sources-label">Where is your roster?</p><div class="gs-segs">' + IMPORT_SOURCES.map(function (s) {
      const here = s.key === active;
      return '<a class="gs-seg gs-seg-link" href="' + esc(G.router.format({ name: 'import', gid: gid, source: s.key })) + '"' + (here ? ' aria-current="page"' : '') + '>' + esc(s.label) + '</a>';
    }).join('') + '</div></nav>';
  };

  // The inline result of an import: a success banner with the counts, what was left alone, and one next step (buttonOpts; the first is the next step).
  //   opts: { title ("Imported 23 people."), text ("20 new, 3 updated."), next: [buttonOpts], id }
  ui.importResultHtml = function (opts) {
    const o = opts || {};
    return ui.bannerHtml({ tone: 'success', title: o.title, text: o.text, actions: o.next, dismissible: false, id: o.id });
  };

  // A whole page for one roster import.
  //   opts: { title, context, back ({ href, label }), step ('source' | 'preview' | 'result'), alertHtml, sourcesHtml, sourceHtml, previewHtml, resultHtml,
  //           commit (ui.commitBarHtml options, shown on the Preview step), pageClass }
  ui.importFlowHtml = function (opts) {
    const o = opts || {};
    const step = importStepOf(o.step);
    const body = (o.alertHtml || '') + (step === 'source' ? (o.sourcesHtml || '') + (o.sourceHtml || '') : (step === 'preview' ? (o.previewHtml || '') : (o.resultHtml || '')));
    return ui.flowPageHtml({
      head: { title: o.title, context: o.context, back: o.back }, steps: ui.IMPORT_STEPS, current: IMPORT_STEP_NUMBER[step], stepsLabel: 'Import steps',
      bodyHtml: body, pageClass: 'gs-import-page' + (o.pageClass ? ' ' + o.pageClass : ''), commitBarHtml: step === 'preview' && o.commit ? ui.commitBarHtml(o.commit) : '',
    });
  };

  // The same three beats as a panel inside another page (the raid page's Gargul, TMB, softres panels). The commit bar is part of the panel, not sticky.
  //   opts: { id (the title's id; defaults to import-title), title, step, helpHtml (the Source step's help), alertHtml, sourceHtml, previewHtml, resultHtml, commit }
  ui.importPanelHtml = function (opts) {
    const o = opts || {};
    const step = importStepOf(o.step);
    const id = o.id || 'import-title';
    const body = step === 'source' ? (o.helpHtml || '') + (o.alertHtml || '') + (o.sourceHtml || '') : (o.alertHtml || '') + (step === 'preview' ? (o.previewHtml || '') : (o.resultHtml || ''));
    return '<div class="gs-loot-import gs-import-panel" role="group" aria-labelledby="' + esc(id) + '"><h3 class="gs-h3" id="' + esc(id) + '">' + esc(o.title) + '</h3>' +
      ui.stepperHtml({ steps: ui.IMPORT_STEPS, current: IMPORT_STEP_NUMBER[step], label: 'Import steps' }) + body +
      (step === 'preview' && o.commit ? ui.commitBarHtml(Object.assign({ inline: true }, o.commit)) : '') + '</div>';
  };

  ui.TEMPLATES = ['list', 'object', 'settings', 'home', 'flow'];
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
