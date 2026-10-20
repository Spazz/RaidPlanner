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
    return L().figsHtml([{ label: 'Main spec', value: Number(t.MS) || 0 }, { label: 'Off spec', value: Number(t.OS) || 0 }].concat(standing
      ? [{ label: 'Raids', value: L().count(standing.raids) }].concat(standing.mode === 'perRaid' ? [{ label: 'Main spec per raid', value: L().fixed(standing.perRaid, 2) }] : []).concat([{ label: 'Due order', value: ordinal(standing.rank) + ' of ' + standing.of }]) : []));
  }

  // The head of the page: the person's name in their class colour with the spec icon, ONE status chip (the person page's rule), a back link to the record.
  function headOf(gd, pid, p) {
    const cls = p.class ? G.ui.className(p.class) : '';
    return G.pages.person.recordHeadOpts({
      name: p.name || 'Person', status: p.status, isMe: !!p.isMe, mainChar: p.class ? { class: p.class } : null,
      contextHtml: '<span>Loot history</span>' + (cls ? '<span class="gs-sumsep" aria-hidden="true"></span><span>Main: ' + G.ui.classNameHtml(cls, p.class) + '</span>' : ''),
      back: { href: G.router.format({ name: 'person', gid: gd.guild.id, pid: pid }), label: 'Roster record' },
    });
  }

  // opts: { guildData, pid, data (GET /loot/person/:pid), balance (the team's balance, or null) }  ->  T2: the person's header, the You line, the awards (left) and the figures (right)
  function personLootHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || {};
    const p = data.person || {};
    const awards = Array.isArray(data.awards) ? data.awards : [];
    const standing = standingOf(opts.balance, opts.pid);
    const edit = awards.some(function (w) { return L().allows(gd, 'loot.edit', w.teamId); });
    // One panel per raid night, newest first (the incoming order); an award without a raid groups by its date.
    const nights = [];
    awards.forEach(function (w) {
      const key = w.raidId ? 'r:' + w.raidId : 'd:' + (w.raidOn || '');
      let n = nights.find(function (x) { return x.key === key; });
      if (!n) { n = { key: key, raidId: w.raidId || null, raidOn: w.raidOn, awards: [] }; nights.push(n); }
      n.awards.push(w);
    });
    const nightPanels = nights.map(function (n, i) {
      const day = G.ui.weekdayDay(n.raidOn) || n.raidOn || 'Raid night';
      const hid = 'pl-n-' + (n.raidId || 'd' + i);
      const title = n.raidId ? '<a class="gs-fg-ght" href="' + esc(G.router.format({ name: 'lootnight', gid: gid, rid: n.raidId })) + '">' + esc(day) + '</a>' : '<span class="gs-fg-ght">' + esc(day) + '</span>';
      const rows = n.awards.map(function (w) {
        const mayEdit = L().allows(gd, 'loot.edit', w.teamId);
        return '<li class="gs-lt-arow" id="loot-' + esc(w.id) + '"><span class="gs-lt-aitem">' + L().itemHtml({ itemId: w.itemId, itemName: w.itemName, quality: w.quality }, gd.guild.gameVersion) + (w.note ? '<span class="gs-lt-sub">Note: ' + esc(w.note) + '</span>' : '') + '</span>' +
          '<span class="gs-lt-awho"><span class="gs-sr">Winner: </span>' + L().characterHtml(w) + '</span>' +
          '<span class="gs-lt-tagcell">' + L().tagTextHtml(w.tag, w.tagSetBy) + L().editedChipHtml(w) + '</span>' +
          '<span class="gs-lt-amore">' + (mayEdit && G.pages.lootNight ? G.pages.lootNight.moreMenuHtml(gd, w) : '') + '</span></li>';
      }).join('');
      return '<section class="gs-hd-panel gs-lt-nightpanel" aria-labelledby="' + esc(hid) + '"><div class="gs-lt-nighthead"><h3 class="gs-fg-gh" id="' + esc(hid) + '">' + title + '<span class="gs-fg-ghn">' + esc(L().plural(n.awards.length, 'item', 'items')) + '</span></h3></div>' +
        '<ul class="gs-lt-list" aria-label="Awards on ' + esc(day) + '">' + rows + '</ul></section>';
    }).join('');
    const readOnly = edit ? '' : '<p class="gs-fine">Awards are read-only for members. Ask an officer if something looks wrong.</p>';
    const awardsPanel = awards.length ? nightPanels + readOnly
      : L().panelHtml({ id: 'pl-awards', title: 'Loot awards', metaHtml: esc(L().plural(0, 'award', 'awards')) + ', newest first', bodyHtml: '<p class="gs-fine">' + esc(emptyLine(!!p.isMe)) + '</p>' });
    const totalsPanel = L().panelHtml({ id: 'pl-totals', title: 'Loot received', flush: true,
      bodyHtml: statsHtml(data.totals, standing) + (standing ? '<p class="gs-pr-linkrow"><a class="gs-fg-u" href="' + esc(G.router.format({ name: 'lootstandings', gid: gid })) + '">See where you stand</a></p>' : '') });
    return G.ui.objectPageHtml({
      head: headOf(gd, opts.pid, p),
      youHtml: G.pages.personAtt.subYou(!!p.isMe, 'This is your loot. The guild\'s loot setting decides who else can see it.'),
      pageClass: 'gs-forge gs-pr gs-person-page gs-loot-page gs-loot-person' + (p.isMe ? ' is-own' : ''),
      sections: [{ id: 'pl-cols', bare: true, bodyHtml: '<div class="gs-pr-cols gs-lt-cols-rev"><div class="gs-pr-right">' + totalsPanel + '</div><div class="gs-pr-left">' + awardsPanel + '</div></div>' }], // figures first on a phone; the awards take the wide column from 1024 px
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
    if (!x || x.gid !== gd.guild.id || x.pid !== r.pid) return L().loadingHtml('Loot history');
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
