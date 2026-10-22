/**
 * Raidsmith guild - item icons and tooltips from Wowhead (js/guild/ui-kit.js "ITEM LINKS" and "ITEM TOOLTIPS")
 * Run: node tests/guild/guild-item-tooltips-tests.js
 *
 * Pins:
 *   - the one link helper: href and data-wowhead per game version (tbc, classic, forever), the name or "Item <id>", escaping, plain text where there is no link
 *   - the pages that show items go through it (award rows, the loot board, the public / guest view, the trial card)
 *   - the lazy loader on a fake document: nothing loads without an item link, one async script (never twice, never again after a failure) with the
 *     whTooltips config set from this self-hosted code, and a rescan only when the script is there
 *   - the CSP in _headers (the only one) allows exactly Wowhead's hosts for it, and nothing else of the policy moved
 *   - the privacy page says it, guild.css keeps the item icons tidy, and the Planner pages never carry the script
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

const ROOT = require('path').join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { GUILD_SCRIPTS } = require('../guild-scripts');

function loadGuild() {
  const sandbox = { console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, RegExp, setTimeout };
  vm.createContext(sandbox);
  for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
  return sandbox;
}

// A document that records the script elements added to its head, and a root whose querySelector answers for a.data-wowhead links.
function fakeDocument() {
  const added = [];
  return {
    added,
    createElement: tag => ({ tag }),
    head: { appendChild: el => { added.push(el); return el; } },
    documentElement: { appendChild: el => { added.push(el); return el; } },
    querySelector: () => null,
  };
}
const rootWith = hasLink => ({ querySelector: sel => (hasLink && sel === 'a[data-wowhead]' ? { tag: 'a' } : null) });

const HOSTILE = '<img src=x onerror=1>';
const QUOTES = '"\' onfocus="alert(1)" x=\'';

(async () => {
  const ctx = loadGuild();
  ctx.document = fakeDocument();
  const G = ctx.Guild;
  const ui = G.ui;

  // ── the helper ──
  await check('itemLinkHtml: href, data-wowhead and class per game version, quality colour, safe link attributes', () => {
    const cases = { tbc: 'tbc', classic: 'classic', forever: 'forever' };
    for (const [version, site] of Object.entries(cases)) {
      const out = ui.itemLinkHtml({ itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4 }, version);
      assert.equal(out,
        `<a class="gs-item gs-q-4" href="https://www.wowhead.com/${site}/item=28770" data-wowhead="item=28770&amp;domain=${site}" target="_blank" rel="noopener noreferrer">Nathrezim Mindblade</a>`, version);
    }
    assert.equal(ui.itemUrl('tbc', 28770), 'https://www.wowhead.com/tbc/item=28770');
    assert.equal(ui.itemUrl('forever', 19019), 'https://www.wowhead.com/forever/item=19019');
  });

  await check('itemLinkHtml: the stored name is the text, "Item <id>" when there is none, "Unknown item" with no id; an unknown quality has no colour class', () => {
    assert(ui.itemLinkHtml({ itemId: 28770 }, 'tbc').includes('>Item 28770</a>'));
    assert(ui.itemLinkHtml({}, 'tbc').includes('Unknown item') && !ui.itemLinkHtml({}, 'tbc').includes('<a '), 'no id: nothing to link');
    for (const q of [null, undefined, 9, -1, 1.5, '4']) assert(!ui.itemLinkHtml({ itemId: 5, itemName: 'X', quality: q }, 'tbc').includes('gs-q-'), String(q));
    assert(ui.itemLinkHtml({ itemId: 5, itemName: 'X', quality: 0 }, 'tbc').includes('class="gs-item gs-q-0"'));
  });

  await check('itemLinkHtml: no link (plain text) for a version Wowhead is not asked about or an id that is not a positive whole number', () => {
    for (const version of ['retail', '', null, undefined, '__proto__', 'tbc ']) {
      const out = ui.itemLinkHtml({ itemId: 5, itemName: 'X', quality: 4 }, version);
      assert.equal(out, '<span class="gs-item gs-q-4">X</span>', String(version));
    }
    for (const id of [0, -3, 1.5, NaN, 'abc', '5<x>', '5&domain=classic', null, undefined]) {
      const out = ui.itemLinkHtml({ itemId: id, itemName: 'X' }, 'tbc');
      assert(!out.includes('<a ') && !out.includes('data-wowhead'), String(id));
      assert.equal(ui.itemUrl('tbc', id), null, String(id));
    }
  });

  await check('itemLinkHtml: escapes the name and cannot be broken out of through the id or the version', () => {
    const out = ui.itemLinkHtml({ itemId: 5, itemName: HOSTILE + QUOTES, quality: 4 }, 'tbc');
    assert(!out.includes('<img src=x') && !out.includes(' onfocus="alert(1)"') && !/<script/i.test(out));
    assert(out.includes('&lt;img src=x onerror=1&gt;'));
    for (const tag of out.match(/<[a-z][^<>]*>/gi) || []) assert(!/\sstyle=|\son[a-z]+=/i.test(tag.replace(/="[^"]*"/g, '=""')), tag);
    assert(!ui.itemLinkHtml({ itemId: '5"><b>', itemName: 'X' }, 'tbc').includes('<b>'));
  });

  // ── pages that show items ──
  const gd = { guild: { id: 'g1', name: 'Ravens', timeZone: 'America/Chicago', gameVersion: 'tbc' }, teams: [], me: { roles: [], can: {} } };

  await check('award rows (Loot, the raid page, the person loot page and card) and the loot board link their items through the helper', () => {
    const row = G.pages.loot.awardRowHtml(gd, { id: 'a1', itemId: 28770, itemName: 'Nathrezim Mindblade', quality: 4, awardedAt: 1, winner: { name: 'Thornwick', class: 'WARRIOR' }, match: { kind: 'guest' }, tag: 'MS' }, { when: 'time' });
    assert(row.includes('href="https://www.wowhead.com/tbc/item=28770"') && row.includes('data-wowhead="item=28770&amp;domain=tbc"'));
    const forever = G.pages.loot.awardRowHtml(Object.assign({}, gd, { guild: Object.assign({}, gd.guild, { gameVersion: 'forever' }) }), { id: 'a1', itemId: 19019, itemName: 'Thunderfury', quality: 5, awardedAt: 1, winner: { name: 'T' }, match: { kind: 'guest' }, tag: 'MS' }, { when: 'time' });
    assert(forever.includes('data-wowhead="item=19019&amp;domain=forever"'));
    const board = G.pages.raidBoard.rowHtml(gd, { itemId: 28770, itemName: null, contested: false, done: false, line: [], omitted: 0, results: [] });
    assert(board.includes('data-wowhead="item=28770&amp;domain=tbc"') && board.includes('>Item 28770</a>'), 'a board item with no stored name');
  });

  await check('the public / guest view links its items, and the trial card shows loot as a figure, with the guild\'s game version', () => {
    const data = {
      guild: { name: 'Ember', realm: 'Dreamscythe', realmKind: 'realm', region: 'US', gameVersion: 'classic', timeZone: 'America/New_York' },
      viewer: { kind: 'public' }, teams: [{ id: 't1', name: 'Alpha' }],
      sections: { loot: [{ team: { id: 't1', name: 'Alpha' }, awards: [{ itemId: 19019, itemName: 'Thunderfury', quality: 5, winner: 'Thoren', winnerClass: 'PALADIN', disenchanted: false, awardedAt: 1 }] }] },
    };
    const view = G.pages.view.viewHtml({ data, kind: 'public' });
    assert(view.includes('href="https://www.wowhead.com/classic/item=19019"') && view.includes('data-wowhead="item=19019&amp;domain=classic"') && view.includes('gs-q-5'));
    const trial = G.pages.personTrial.sectionOf({
      guildData: gd, record: { person: { status: 'trial', trialFlag: 'trial', trialStartedOn: '2026-10-01', trialEndsOn: '2026-10-31' }, can: { edit: true } },
      state: { data: { since: '2026-10-01', loot: { total: 1, ms: 1, os: 0, de: 0, bank: 0, items: [{ itemId: 28770, itemName: 'Nathrezim Mindblade', tag: 'MS', raidOn: '2026-10-10' }] } } },
    });
    // The decision panel keeps the figures ("1 MS"); the items and their links are the record's Loot panel (the award rows above).
    assert(trial && trial.bodyHtml.includes('>1 MS<') && !trial.bodyHtml.includes('Nathrezim'), 'trial card');
  });

  // ── the lazy loader ──
  await check('a render with no item link loads nothing and sets no config', () => {
    const c = loadGuild(); c.document = fakeDocument();
    assert.equal(c.Guild.ui.refreshItemTooltips(rootWith(false)), false);
    assert.equal(c.Guild.ui.refreshItemTooltips(null), false, 'the document stands in for the root: no link in it');
    assert.equal(c.document.added.length, 0);
    assert.equal(c.whTooltips, undefined);
    assert.equal(c.Guild.ui.itemTooltipsState(), 'idle');
  });

  await check('the first render with an item link adds ONE async script from wow.zamimg.com, with the config set first; later renders add nothing', () => {
    const c = loadGuild(); c.document = fakeDocument();
    const u = c.Guild.ui;
    assert.equal(u.refreshItemTooltips(rootWith(true)), true);
    assert.equal(c.document.added.length, 1);
    const el = c.document.added[0];
    assert.equal(el.tag, 'script');
    assert.equal(el.src, 'https://wow.zamimg.com/js/tooltips.js');
    assert.equal(el.async, true);
    assert.deepEqual(JSON.parse(JSON.stringify(c.whTooltips)), { colorLinks: true, iconizeLinks: true, renameLinks: true });
    assert.equal(u.itemTooltipsState(), 'loading');
    u.refreshItemTooltips(rootWith(true)); u.refreshItemTooltips(rootWith(true));
    assert.equal(c.document.added.length, 1, 'injected once while loading');
    el.onload();
    assert.equal(u.itemTooltipsState(), 'ready');
    u.refreshItemTooltips(rootWith(true));
    assert.equal(c.document.added.length, 1, 'and once it has loaded');
  });

  await check('once loaded, every render with item links asks Wowhead to rescan them (WH.Tooltips.refreshLinks, else $WowheadPower.refreshLinks); a page without links does not', () => {
    const c = loadGuild(); c.document = fakeDocument();
    const u = c.Guild.ui;
    let calls = 0;
    u.refreshItemTooltips(rootWith(true));
    c.WH = { Tooltips: { refreshLinks: () => { calls++; } } };
    c.document.added[0].onload();
    assert.equal(calls, 1, 'on load');
    u.refreshItemTooltips(rootWith(true));
    assert.equal(calls, 2);
    u.refreshItemTooltips(rootWith(false));
    assert.equal(calls, 2, 'no item link: no rescan');
    let legacy = 0;
    c.WH = undefined; c.$WowheadPower = { refreshLinks: () => { legacy++; } };
    u.refreshItemTooltips(rootWith(true));
    assert.equal(legacy, 1);
  });

  await check('the rescan is a no-op when Wowhead\'s globals are missing or throw; a script that fails to load is not retried and the links stay plain links', () => {
    const c = loadGuild(); c.document = fakeDocument();
    const u = c.Guild.ui;
    u.refreshItemTooltips(rootWith(true));
    c.document.added[0].onerror();
    assert.equal(u.itemTooltipsState(), 'failed');
    assert.doesNotThrow(() => u.refreshItemTooltips(rootWith(true)));
    assert.equal(c.document.added.length, 1, 'no retry on every render');
    const d = loadGuild(); d.document = fakeDocument();
    d.Guild.ui.refreshItemTooltips(rootWith(true));
    d.WH = { Tooltips: { refreshLinks: () => { throw new Error('wowhead is having a day'); } } };
    assert.doesNotThrow(() => d.document.added[0].onload());
    assert.doesNotThrow(() => d.Guild.ui.refreshItemTooltips(rootWith(true)));
    const e = loadGuild();
    assert.equal(e.Guild.ui.refreshItemTooltips(rootWith(true)), true, 'no document (a non-browser run): the check still answers');
    assert.equal(e.Guild.ui.itemTooltipsState(), 'idle');
  });

  await check('the guild page render calls the loader on the page body only; the Planner pages and the loader files never name the Wowhead script', () => {
    const app = read('js/guild/app.js');
    assert.equal((app.match(/refreshItemTooltips\(/g) || []).length, 1);
    assert(app.includes('G.ui.refreshItemTooltips(main);'));
    for (const page of ['index.html', 'faq.html', 'whats-new.html']) assert(!/zamimg|wowhead/i.test(read(page)), page + ' carries no Wowhead script tag');
    const named = fs.readdirSync(path.join(ROOT, 'js'), { recursive: true }).filter(f => f.endsWith('.js'))
      .filter(f => /wow\.zamimg\.com\/js|tooltips\.js/.test(read('js/' + f.replace(/\\/g, '/')))).map(f => f.replace(/\\/g, '/'));
    assert.deepEqual(named, ['guild/ui-kit.js'], 'the script is named in exactly one place');
    const kit = read('js/guild/ui-kit.js');
    assert(!/<script|setAttribute\(\s*['"]on/.test(kit.replace(/\/\/.*$/gm, '')), 'no inline script is written');
  });

  // ── the CSP ──
  function policyOf(text) {
    const out = {};
    for (const part of text.split(';').map(p => p.trim()).filter(Boolean)) { const [name, ...sources] = part.split(/\s+/); out[name] = sources; }
    return out;
  }
  // The one inline style attribute Wowhead's tooltip markup carries (the header table of an item with a phase label); every other tooltip style is a class.
  const TOOLTIP_STYLE_HASH = require('node:crypto').createHash('sha256').update('display:inline-table; vertical-align:inherit').digest('base64');
  const headersLine = read('_headers').split('\n').find(l => l.trim().startsWith('Content-Security-Policy:'));
  const cloudflare = headersLine.slice(headersLine.indexOf(':') + 1).trim();

  await check('CSP (_headers): Wowhead\'s script and stylesheet host, icon host and tooltip-data host are allowed, minimal and nothing else', () => {
    for (const [label, text] of [['_headers', cloudflare]]) {
      const p = policyOf(text);
      assert.deepEqual(p['script-src'], ["'self'", 'https://wow.zamimg.com'], label);
      assert.deepEqual(p['style-src'], ["'self'", 'https://fonts.googleapis.com', 'https://wow.zamimg.com'], label);
      assert.deepEqual(p['connect-src'], ["'self'", 'https://raid-helper.dev', 'https://raid-helper.xyz', 'https://nether.wowhead.com'], label);
      assert.deepEqual(p['default-src'], ["'self'"], label);
      assert.deepEqual(p['font-src'], ['https://fonts.gstatic.com'], label);
      assert.deepEqual(p['object-src'], ["'none'"], label);
      assert.deepEqual(p['frame-ancestors'], ["'none'"], label);
      assert.deepEqual(p['base-uri'], ["'self'"], label);
      assert(!/'unsafe-inline'|unsafe-eval|\*/.test(text), label + ': still no inline code, eval or wildcard');
      assert.deepEqual(p['style-src-attr'], ["'unsafe-hashes'", "'sha256-" + TOOLTIP_STYLE_HASH + "'"], label + ': exactly one inline style value, by hash');
      assert(!('script-src-elem' in p) && !('script-src-attr' in p) && !('style-src-elem' in p) && !('frame-src' in p), label + ': no other extra directive');
    }
    assert.deepEqual(policyOf(cloudflare)['img-src'], ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://wow.zamimg.com']);
  });

  await check('the host the loader injects is the one script-src allows', () => {
    const kit = read('js/guild/ui-kit.js');
    const url = (kit.match(/const WOWHEAD_SCRIPT = '([^']+)'/) || [])[1];
    assert.equal(url, 'https://wow.zamimg.com/js/tooltips.js');
    assert(policyOf(cloudflare)['script-src'].includes(new URL(url).origin));
  });

  // ── privacy and styling ──
  await check('the privacy page says that pages showing items load Wowhead\'s tooltip script, which may track visits', () => {
    const out = G.pages.privacy.privacyHtml({ me: null });
    assert(out.includes('id="privacy-wowhead"'));
    const text = out.replace(/<[^>]*>/g, '');
    assert(text.includes('Pages that show items load Wowhead\'s tooltip script, which Wowhead may use to track visits.') || text.includes('Pages that show items load Wowhead&#39;s tooltip script, which Wowhead may use to track visits.'));
  });

  await check('guild.css keeps item icons tidy: the icon class is inline-block with a hanging icon, and Wowhead\'s quality classes repeat the page palette', () => {
    const css = read('guild.css');
    assert(/\.guild-page a\.gs-item\.icontinyl\s*\{[^}]*display:\s*inline-block[^}]*max-width:\s*100%/.test(css));
    for (let q = 0; q <= 7; q++) {
      const own = css.match(new RegExp('\\.gs-q-' + q + ',\\s*\\.guild-page a\\.gs-q-' + q + '\\s*\\{\\s*color:\\s*(#[0-9a-f]{6})', 'i'));
      const wh = css.match(new RegExp('\\.guild-page a\\.gs-item\\.q' + q + '\\s*\\{\\s*color:\\s*(#[0-9a-f]{6}) !important', 'i'));
      assert(own && wh && own[1].toLowerCase() === wh[1].toLowerCase(), 'q' + q);
    }
  });

  console.log(`\nItem tooltip tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed ? 1 : 0);
})();
