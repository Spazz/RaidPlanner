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

  // opts: { guildData, pid, record (the roster record), state: { data, denied } | null }
  function cardHtml(opts) {
    const s = opts.state;
    const gd = opts.guildData;
    const isMe = !!(opts.record && opts.record.person && opts.record.person.isMe);
    let body;
    if (!s) {
      body = '<p class="gs-fine">' + esc(emptyLine(isMe)) + '</p>';
    } else if (s.denied || !s.data) {
      body = '<p class="gs-fine">Loot for this person is not shown to you.</p>';
    } else {
      const awards = Array.isArray(s.data.awards) ? s.data.awards : [];
      body = awards.length
        ? L().totalsHtml(s.data.totals) + '<ul class="gs-loot-list" aria-label="Latest loot">' + awards.slice(0, CARD_AWARDS).map(function (w) { return rowHtml(gd, w); }).join('') + '</ul>' +
          '<p class="gs-fine"><a href="' + esc(G.router.format({ name: 'lootperson', gid: gd.guild.id, pid: opts.pid })) + '">All loot</a></p>'
        : '<p class="gs-fine">' + esc(emptyLine(isMe)) + '</p>';
    }
    return '<section class="gs-card-sec" aria-labelledby="loot-card-h"><div class="gs-card-sec-head"><h2 class="gs-h2" id="loot-card-h">Loot</h2></div><div class="gs-card-sec-body">' + body + '</div></section>';
  }

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

  // The card HTML for the roster person page; '' while nothing is loaded.
  function cardFor(gd, record, pid) {
    const c = cardState(gd.guild.id, pid);
    return c ? cardHtml({ guildData: gd, pid: pid, record: record, state: c }) : '';
  }

  // ── full page ──
  // Awards (newest first) in runs of one raid.
  function groupByRaid(awards) {
    const groups = [];
    (Array.isArray(awards) ? awards : []).forEach(function (w) {
      const last = groups[groups.length - 1];
      if (last && last.raidId === w.raidId) last.awards.push(w);
      else groups.push({ raidId: w.raidId, raidOn: w.raidOn, awards: [w] });
    });
    return groups;
  }

  // opts: { guildData, pid, data (GET /loot/person/:pid) }
  function personLootHtml(opts) {
    const gd = opts.guildData;
    const gid = gd.guild.id;
    const data = opts.data || {};
    const p = data.person || {};
    const awards = Array.isArray(data.awards) ? data.awards : [];
    const head = '<div class="gs-person-head"><div class="gs-person-title"><div class="gs-person-h1"><h1 class="gs-h1" tabindex="-1">' + esc(p.name || 'Person') + '</h1></div>' +
      '<p class="gs-sub">Loot history</p>' + (p.status ? '<div class="gs-chips">' + G.ui.statusChipHtml(p.status) + '</div>' : '') + '</div>' +
      '<p class="gs-person-discord"><a href="' + esc(G.router.format({ name: 'person', gid: gid, pid: opts.pid })) + '">Open in Roster</a></p></div>';
    const groups = groupByRaid(awards).map(function (g, i) {
      return '<section class="gs-card-sec" aria-labelledby="pl-raid-' + i + '"><div class="gs-card-sec-head"><h2 class="gs-h2" id="pl-raid-' + i + '"><a href="' + esc(G.router.format({ name: 'raid', gid: gid, rid: g.raidId })) + '">' + esc(G.ui.weekdayDay(g.raidOn) || g.raidOn || 'Raid') + '</a></h2>' +
        '<span class="gs-fine">' + esc(L().plural(g.awards.length, 'item', 'items')) + '</span></div><div class="gs-card-sec-body"><ul class="gs-loot-list" aria-label="Loot of this raid">' +
        g.awards.map(function (w) { return L().awardRowHtml(gd, w, { when: 'time', character: true }); }).join('') + '</ul></div></section>';
    }).join('');
    return '<div class="gs-page gs-person-page">' + head + L().totalsHtml(data.totals) +
      (groups || '<section class="gs-empty-card"><h2 class="gs-h2 gs-h2-lg">No loot yet</h2><p class="gs-lead gs-lead-sm">' + esc(emptyLine(false)) + '</p></section>') + '</div>';
  }

  function load(r, gd) {
    const gid = gd.guild.id;
    return G.api.loot.person(gid, r.pid).then(function (data) {
      a().personLoot = { gid: gid, pid: r.pid, data: data };
      return null;
    });
  }

  function main(r, gd) {
    const x = a().personLoot;
    if (!x || x.gid !== gd.guild.id || x.pid !== r.pid) return G.pages.signin.loadingHtml();
    return personLootHtml({ guildData: gd, pid: r.pid, data: x.data });
  }

  function nameFor(r) {
    const x = a().personLoot;
    return x && x.pid === r.pid && x.data && x.data.person ? x.data.person.name || '' : '';
  }

  G.pages.personLoot = {
    CARD_AWARDS: CARD_AWARDS,
    cardHtml: cardHtml,
    cardFor: cardFor,
    cardState: cardState,
    groupByRaid: groupByRaid,
    personLootHtml: personLootHtml,
    loadCard: loadCard,
    nameFor: nameFor,
    load: load,
    main: main,
  };
})(typeof window !== 'undefined' ? (window.Guild = window.Guild || {}) : (globalThis.Guild = globalThis.Guild || {}));
