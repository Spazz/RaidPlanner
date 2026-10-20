// ── PAGE PIECE: THE YOU BAR OF A RAID ───────────────────────────
// One bar under the next-step bar for any viewer who has a person on the team (an officer who raids too gets it): where they stand on this raid and the one thing
// they can do about it. It replaces the old "You" line, the "Your group" card and the "Your sign-up" form (#su-me, which the bar keeps as its id).
//   Before the raid, no seat   "Signed up - Zzaps, Balance", the five status pills (Signed up, Late, Standby, Tentative, Can't come) and "Change character or note"
//                              (a form dialog: Character, Spec, Note, Save details, Remove my sign-up / Skip this week). Closed sign-ups: the pills are disabled and
//                              the reason sits next to them.
//   Before the raid, a seat    "Group 2 - Balance Druid (Zzaps)" or "Bench", then Are you coming? + Confirm + Can't come (waiting), the chip Confirmed + Can't come,
//                              or the chip Can't come + Confirm after all. The pills move into the "Change sign-up" dialog. Confirm is the page's one molten button
//                              only when the next-step bar has no primary; otherwise it is a secondary.
//   After the raid             "Attended - 8 of 9 pulls - won Warp Slicer (MS)": the outcome, the pulls and the loot, read from data the page already holds. No buttons.
// The status words, the details form state and the pill handler live in pages-raid-signups.js; Confirm and Can't come in pages-raid-roster.js.
(function (G) {
  'use strict';

  function A() { return G.pages.attendance; }
  function S() { return G.pages.raidSignups; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function okData(state) { return state && state.status === 'ok' && state.data ? state.data : null; }

  function chip(tone, label) { return '<span class="gs-hd-chip is-' + tone + '">' + esc(label) + '</span>'; }

  function barHtml(lineHtml, actHtml, errorHtml) {
    return '<section class="gs-hd-panel gs-rpg-you" id="su-me" tabindex="-1" aria-labelledby="rpg-you-l"><span class="gs-fg-lbl" id="rpg-you-l">You</span>' +
      '<div class="gs-rpg-you-body"><p class="gs-rpg-you-line">' + lineHtml + '</p>' + (actHtml ? '<div class="gs-rpg-you-act">' + actHtml + '</div>' : '') + '</div>' + (errorHtml || '') + '</section>';
  }

  function linkBtn(label, action, key) {
    return '<button type="button" class="gs-linkbtn gs-rpg-link" data-action="' + action + '" data-key="' + key + '">' + esc(label) + '</button>';
  }

  // ── after the raid ──
  // "Attended - 8 of 9 pulls - won Warp Slicer (MS)": the viewer's row of the people list, and their awards when the loot is loaded.
  function wonHtml(gd, me, lootState) {
    const awards = okData(lootState) && Array.isArray(lootState.data.awards) ? lootState.data.awards : [];
    const mine = awards.filter(function (w) { return w && w.match && w.match.kind === 'character' && w.match.personId === me.personId; });
    if (!mine.length || !G.pages.loot) return '';
    return ' - won ' + mine.map(function (w) {
      return G.pages.loot.itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + ' (' + esc(G.pages.loot.TAG_LABELS[w.tag] || w.tag) + ')';
    }).join(', ');
  }

  function afterHtml(gd, data, me, lootState) {
    const row = (Array.isArray(data.people) ? data.people : []).filter(function (x) { return x.playerId === me.personId; })[0];
    if (!row) return '';
    const label = A().OUTCOME_LABELS[row.outcome] || String(row.outcome == null ? '' : row.outcome);
    const p = row.pulls || {};
    const pulls = p.total > 0 ? ' - ' + esc(p.present + ' of ' + plural(p.total, 'pull', 'pulls')) : '';
    return barHtml('<strong>' + esc(label) + '</strong>' + (row.pending ? ' (awaiting review)' : '') + pulls + wonHtml(gd, me, lootState));
  }

  // ── before the raid ──
  function characterOf(me, sig) {
    const chars = Array.isArray(me.characters) ? me.characters : [];
    return (sig && sig.characterId ? chars.filter(function (c) { return c.id === sig.characterId; })[0] : null) || (sig && sig.name ? chars.filter(function (c) { return c.name === sig.name; })[0] : null) || null;
  }

  // "Signed up - Zzaps, Balance"; the words of a person away by notice or who has not signed up.
  function standingHtml(me, sig) {
    if (!sig) return me.canChange ? 'You have not signed up yet.' : 'You have not signed up, and sign-ups are closed.';
    if (sig.source === 'away') return '<strong>Away (notice)</strong>';
    const word = S().KIND_LABELS[sig.kind] || String(sig.kind);
    const ch = characterOf(me, sig);
    const name = sig.name ? G.ui.classNameHtml(sig.name, ch ? ch.class : '') + (sig.spec ? ', ' + esc(sig.spec) : '') : '';
    return '<strong>' + esc(word) + '</strong>' + (name ? ' - ' + name : '');
  }

  function signupActionsHtml(view, ui, molten) {
    const me = view.me;
    const open = !!me.canChange;
    return S().pillsHtml(view, ui, { molten: molten }) + (open ? linkBtn('Change character or note', 'su-details-open', 'you-details') : '<span class="gs-fine gs-rpg-why">' + esc(S().closedText(view)) + '</span>');
  }

  // The seat of a published line-up: "Group 2 - Balance Druid (Zzaps)" / "Bench" (the character in its class colour).
  function seatHtml(mine) {
    const role = [mine.spec, mine.class ? G.ui.className(mine.class) : ''].filter(Boolean).join(' ');
    const who = (role ? esc(role) + ' ' : '') + (mine.name ? '(' + G.ui.classNameHtml(mine.name, mine.class) + ')' : '');
    return '<strong>' + (mine.group ? 'Group ' + esc(mine.group) : 'Bench') + '</strong>' + (who.trim() ? ' - ' + who.trim() : '');
  }

  function seatedActionsHtml(mine, seat, view, molten) {
    const busy = seat.busy ? ' disabled' : '';
    const confirmClass = 'gs-btn' + (molten ? ' gs-btn-molten' : '');
    const confirmBtn = function (label) { return '<button type="button" class="' + confirmClass + '" data-action="seat-confirm" data-key="seat-confirm"' + busy + '>' + label + '</button>'; };
    const decline = '<button type="button" class="gs-btn" data-action="seat-decline" data-key="seat-decline"' + busy + '>Can\'t come</button>';
    const change = view && view.me && view.me.canChange ? linkBtn('Change sign-up', 'su-signup-open', 'you-signup') : '';
    if (mine.status === 'declined') return chip('rose', 'Can\'t come') + confirmBtn('Confirm after all') + change;
    if (mine.status === 'confirmed') return chip('grey', 'Confirmed') + decline + change;
    return '<span class="gs-rpg-you-q">Are you coming?</span>' + confirmBtn('Confirm') + decline + change;
  }

  // o: { guildData, data (the raid detail), parts: { signups, roster, loot }, nextHasPrimary }. '' when the viewer has no person on the team (a seat in the line-up
  // still shows, without the sign-up tools, when the sign-ups could not be read).
  function youBarHtml(o) {
    const data = o.data;
    const parts = o.parts || {};
    const view = okData(parts.signups);
    const me = view && view.me ? view.me : null;
    const upcoming = !!(data.raid && data.raid.upcoming);
    if (!upcoming) return me ? afterHtml(o.guildData, data, me, parts.loot) : '';
    const roster = okData(parts.roster);
    const mine = roster && roster.published && roster.mine ? roster.mine : null;
    if (!me && !mine) return '';
    const error = '<p class="gs-alert" id="su-error" role="alert"' + (view && parts.signups.ui && parts.signups.ui.error ? '' : ' hidden') + '>' + esc((view && parts.signups.ui && parts.signups.ui.error) || '') + '</p>' +
      '<p class="gs-alert" id="seat-error" role="alert"' + (parts.roster && parts.roster.error ? '' : ' hidden') + '>' + esc((parts.roster && parts.roster.error) || '') + '</p>';
    const molten = !o.nextHasPrimary;
    if (mine) return barHtml(seatHtml(mine), seatedActionsHtml(mine, parts.roster, view, molten), error);
    const ui = parts.signups.ui || S().freshUi(view);
    return barHtml(standingHtml(me, me.signup), signupActionsHtml(view, ui, molten && !me.signup), error);
  }

  G.pages.raidYou = { youBarHtml: youBarHtml, standingHtml: standingHtml, seatHtml: seatHtml };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
