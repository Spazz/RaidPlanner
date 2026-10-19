// ── PAGES: PERSON LOOT (the card on the roster person page, and the full loot page) ──
// GET /loot/person/:pid -> { person: { id, name, status }, awards: [award] (newest first), totals: { MS, OS, DE, BANK } }.
// The card shows the totals and the last five awards; the page groups every award by raid. A member whose loot policy is
// "own loot only" gets a 403 for anyone else, which the card shows as a short note and the page as a message.
(function (G) {
  'use strict';

  const CARD_AWARDS = 5;

  function L() { return G.pages.loot; }
  function a() { return G.pages.attendance.attState(); }

  function emptyLine(isMe) {
    return isMe ? 'Your loot shows here after your first award is imported.' : 'No loot is recorded for this person yet.';
  }

  // One award on a person page: date, item, the character that won it, tag and flags. Reuses the row of the raid card.
  function rowHtml(gd, award) {
    return L().awardRowHtml(gd, award, { when: 'date', raidLink: true, character: true });
  }

  // "MS 1 - OS 0 - DE 0 - Bank 0": the totals as one line in the panel head.
  function totalsText(totals) {
    const t = totals || {};
    return ['MS', 'OS', 'DE', 'BANK'].map(function (k) { return (k === 'BANK' ? 'Bank' : k) + ' ' + esc(Number(t[k]) || 0); }).join(' &middot; ');
  }

  // opts: { guildData, pid, record (the roster record), state: { data, denied } | null }  ->  the section of the person page (T2)
  function sectionOf(opts) {
    const s = opts.state;
    const gd = opts.guildData;
    const isMe = !!(opts.record && opts.record.person && opts.record.person.isMe);
    let body;
    let meta = '';
    if (!s) {
      body = '<p class="gs-fine">' + esc(emptyLine(isMe)) + '</p>';
    } else if (s.denied || !s.data) {
      body = '<p class="gs-fine">Loot for this person is not shown to you.</p>';
    } else {
      const awards = Array.isArray(s.data.awards) ? s.data.awards : [];
      body = awards.length
        ? '<ul class="gs-loot-list" aria-label="Latest loot">' + awards.slice(0, CARD_AWARDS).map(function (w) { return rowHtml(gd, w); }).join('') + '</ul>' +
          '<p class="gs-fine"><a class="gs-fg-u" href="' + esc(G.router.format({ name: 'lootperson', gid: gd.guild.id, pid: opts.pid })) + '">All loot</a></p>'
        : '<p class="gs-fine">' + esc(emptyLine(isMe)) + '</p>';
      if (awards.length) meta = totalsText(s.data.totals);
    }
    return { id: 'loot-card', title: 'Loot', metaHtml: meta, bodyHtml: body };
  }

  function cardHtml(opts) { return G.ui.objectSectionHtml(sectionOf(opts)); }

  // No pre-check on can['loot.view']: the loot policy (own / own teams / guild) decides on the Worker, so the card asks and
  // shows a short note on a 403.
  function loadCard(gid, pid) {
    return G.api.loot.person(gid, pid).then(function (data) {
      a().personLootCard = { gid: gid, pid: pid, data: data, denied: false };
      return null;
    }, function (err) {
      a().personLootCard = { gid: gid, pid: pid, data: null, denied: !!(err && (err.status === 403 || err.status === 404)) };
      return null;
    });
  }

  function cardState(gid, pid) {
    const c = a().personLootCard;
    return c && c.gid === gid && c.pid === pid ? c : null;
  }

  // The section for the roster person page; null while nothing is loaded.
  function sectionFor(gd, record, pid) {
    const c = cardState(gd.guild.id, pid);
    return c ? sectionOf({ guildData: gd, pid: pid, record: record, state: c }) : null;
  }

  function cardFor(gd, record, pid) {
    const section = sectionFor(gd, record, pid);
    return section ? G.ui.objectSectionHtml(section) : '';
  }

  // ── full page ──
  // The standing of this person in the team's balance (all time): { raids, perRaid, rank, of, mode } or null when the balance does not list them.
  function standingOf(balance, pid) {
    if (!balance || !Array.isArray(balance.people)) return null;
    const mode = balance.mode === 'count' ? 'count' : 'perRaid';
    const rows = L().balanceRows(balance, 'all').filter(function (r) { return r.status !== 'inactive' || r.id === pid; });
    const mine = rows.filter(function (r) { return r.id === pid; })[0];
    if (!mine) return null;
    const ordered = rows.slice().sort(function (p, q) { return L().compareDue(p, q, mode, 'asc'); });
    return { raids: mine.raids, perRaid: mine.perRaid, counted: mine.counted, mode: mode, rank: ordered.indexOf(mine) + 1, of: ordered.length };
  }

  function ordinal(n) {
    const m = n % 100;
    if (m >= 11 && m <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }

  function statsHtml(totals, standing) {
    const t = totals || {};
    const stat = function (label, value) { return '<div class="gs-summary-item"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>'; };
    return '<dl class="gs-summary">' + stat('Main spec', Number(t.MS) || 0) + stat('Off spec', Number(t.OS) || 0) +
      (standing ? stat('Raids', L().count(standing.raids)) + (standing.mode === 'perRaid' ? stat('Main spec per raid', L().fixed(standing.perRaid, 2)) : '') + stat('Due order', ordinal(standing.rank) + ' of ' + standing.of) : '') + '</dl>';
  }

  // opts: { guildData, pid, data (GET /loot/person/:pid), balance (the team's balance, or null) }  ->  T2: the person's header, the You line, the figures, one table of awards (newest first)
  function personLootHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || {};
    const p = data.person || {};
    const awards = Array.isArray(data.awards) ? data.awards : [];
    const standing = standingOf(opts.balance, opts.pid);
    const edit = awards.some(function (w) { return L().allows(gd, 'loot.edit', w.teamId); });
    const columns = [{ key: 'item', label: 'Item', primary: true }, { key: 'night', label: 'Raid night' }, { key: 'tag', label: 'Tag' }];
    if (edit) columns.push({ key: 'actions', label: 'More', srLabel: true, hideLabel: true });
    const rows = awards.map(function (w) {
      const mayEdit = L().allows(gd, 'loot.edit', w.teamId);
      return { id: w.id, cells: {
        item: L().itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + (w.note ? '<span class="gs-char-sub">Note: ' + esc(w.note) + '</span>' : ''),
        night: w.raidId ? '<a href="' + esc(G.router.format({ name: 'lootnight', gid: gid, rid: w.raidId })) + '">' + esc(G.ui.weekdayDay(w.raidOn) || w.raidOn || 'Raid night') + '</a>' : esc(G.ui.weekdayDay(w.raidOn) || w.raidOn || ''),
        tag: '<span class="gs-ln-tag">' + L().tagChipHtml(w.tag, w.tagSetBy) + (Array.isArray(w.editedFields) && w.editedFields.length ? '<span class="gs-chip gs-chip-plain" title="An officer corrected this award">Edited</span>' : '') + '</span>',
        actions: mayEdit && G.pages.lootNight ? G.pages.lootNight.moreMenuHtml(gd, w) : '' } };
    });
    const none = '<p class="gs-fine">' + esc(emptyLine(!!p.isMe)) + '</p>';
    const foot = (edit ? '' : '<p class="gs-fine">Awards are read-only for members. Ask an officer if something looks wrong.</p>') +
      (standing ? '<p class="gs-fine"><a class="gs-fg-u" href="' + esc(G.router.format({ name: 'lootstandings', gid: gid })) + '">See where you stand</a></p>' : '');
    const sections = [{ id: 'pl-totals', title: 'Loot received', bodyHtml: statsHtml(data.totals, standing) },
      { id: 'pl-awards', title: 'Loot awards', chipHtml: '<span class="gs-fine">' + esc(L().plural(awards.length, 'award', 'awards')) + ', newest first</span>',
        bodyHtml: awards.length ? G.ui.dataTableHtml({ label: 'Loot awards', columns: columns, rows: rows, limit: 1000, showAll: true, noun: 'awards' }) + foot : none }];
    return G.ui.objectPageHtml({
      head: G.pages.personAtt.subHead({ gd: gd, pid: opts.pid, person: p, kind: 'loot' }),
      youHtml: G.pages.personAtt.subYou(!!p.isMe, 'This is your loot. The guild\'s loot setting decides who else can see it.'),
      pageClass: 'gs-person-page gs-loot-person' + (p.isMe ? ' is-own' : ''),
      sections: sections,
    });
  }

  // The team whose balance ranks this person: the team of their newest award, else the team the viewer has picked.
  function load(r, gd) {
    const gid = gd.guild.id;
    return G.api.loot.person(gid, r.pid).then(function (data) {
      const state = { gid: gid, pid: r.pid, data: data, balance: null };
      a().personLoot = state;
      const awards = Array.isArray(data && data.awards) ? data.awards : [];
      const teamId = awards.length ? awards[0].teamId : G.app.teamFor(gd);
      if (!teamId || !G.api.loot.balance) return null;
      // The standings are optional: a 403 (the guild keeps them from members) or any other failure just leaves the figures out.
      return Promise.resolve().then(function () { return G.api.loot.balance(gid, teamId, null); }).then(function (b) { state.balance = b; return null; }, function () { return null; });
    });
  }

  function main(r, gd) {
    const x = a().personLoot;
    if (!x || x.gid !== gd.guild.id || x.pid !== r.pid) return G.pages.signin.loadingHtml();
    return personLootHtml({ guildData: gd, pid: r.pid, data: x.data, balance: x.balance });
  }

  function nameFor(r) {
    const x = a().personLoot;
    return x && x.pid === r.pid && x.data && x.data.person ? x.data.person.name || '' : '';
  }

  G.pages.personLoot = {
    CARD_AWARDS: CARD_AWARDS,
    sectionOf: sectionOf,
    sectionFor: sectionFor,
    cardHtml: cardHtml,
    cardFor: cardFor,
    cardState: cardState,
    standingOf: standingOf,
    personLootHtml: personLootHtml,
    loadCard: loadCard,
    nameFor: nameFor,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
