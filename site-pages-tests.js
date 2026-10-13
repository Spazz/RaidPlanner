/**
 * Raidsmith Web - static site pages tests
 * Run: node site-pages-tests.js
 *
 * faq.html and whats-new.html are plain pages under the same header and footer as the
 * planner's homepage. They load only the scripts they need (js/util.js, js/changelog.js,
 * js/site-pages.js, and js/storage.js for the FAQ's "Show tips again"). These checks pin:
 * the page shell (head, one h1, site header without version tabs, footer), no inline code
 * (strict CSP), the 16 FAQ questions, that the homepage lost its kicker, version note,
 * What's new banner and FAQ section, that every link to them is repointed, that the files are
 * whitelisted and deployed, and the behavior of js/site-pages.js: the header badge, the
 * dismissal by visiting What's new, the full release list and the tips reset.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = require('./tests/load-app');

const ROOT = app.ROOT;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SITE = 'https://raid-planner-theta.vercel.app';
const PAGES = {
  'faq.html': { title: 'FAQ - Raidsmith', h1: 'Frequently asked questions', scripts: ['/js/util.js', '/js/changelog.js', '/js/storage.js', '/js/site-pages.js'] },
  'whats-new.html': { title: "What's new - Raidsmith", h1: "What's new", scripts: ['/js/util.js', '/js/changelog.js', '/js/site-pages.js'] },
};
const indexHtml = app.html.replace(/\r\n/g, '\n');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const meta = (html, attrName, attrValue) => {
  const m = html.match(new RegExp('<meta\\s+' + attrName + '="' + attrValue + '"\\s+content="([^"]*)"'));
  return m ? m[1] : null;
};

for (const [file, spec] of Object.entries(PAGES)) {
  const html = read(file);

  check(`${file}: head has title, description, viewport, theme-color, og and twitter tags like index.html`, () => {
    assert(html.startsWith('<!DOCTYPE html>\n<html lang="en">'));
    assert.equal(html.match(/<title>([^<]*)<\/title>/)[1], spec.title);
    assert(meta(html, 'name', 'description').length > 40);
    assert.equal(meta(html, 'name', 'viewport'), meta(indexHtml, 'name', 'viewport'));
    assert.equal(meta(html, 'name', 'theme-color'), meta(indexHtml, 'name', 'theme-color'));
    assert.equal(meta(html, 'property', 'og:title'), spec.title);
    assert.equal(meta(html, 'property', 'og:url'), `${SITE}/${file}`);
    assert.equal(meta(html, 'property', 'og:image'), `${SITE}/og-image.png`);
    assert.equal(meta(html, 'name', 'twitter:image'), `${SITE}/og-image.png`);
    assert.equal(meta(html, 'property', 'og:site_name'), 'Raidsmith');
    assert.equal(meta(html, 'property', 'og:image:alt'), meta(indexHtml, 'property', 'og:image:alt'));
    assert(html.includes('<link rel="stylesheet" href="/app.css">'));
    assert(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Barlow:[^"]+" rel="stylesheet">/.test(html));
    assert(html.includes('<link rel="icon" href="data:image/svg+xml,'));
    assert(html.indexOf('rel="preconnect"') < html.indexOf('fonts.googleapis.com/css2'));
  });

  check(`${file}: one h1, a main landmark, the site header (brand + three links, no version tabs) and the footer`, () => {
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
    assert(html.includes(`<h1 class="page-title">${spec.h1}</h1>`));
    assert.equal((html.match(/<main[ >]/g) || []).length, 1);
    const band = html.slice(html.indexOf('<header class="game-header" id="era-band">'), html.indexOf('</header>'));
    assert(band.includes('<a href="/" class="game-header-brand" id="brand-home"'));
    assert(band.includes('<strong>Raidsmith</strong>') && band.includes('class="mark-svg"'));
    assert(!band.includes('game-version'), 'the version tabs belong to the planner');
    const nav = band.match(/<nav class="game-header-links" aria-label="Site">([\s\S]*?)<\/nav>/)[1];
    assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1]), ['/whats-new.html', '/#how-it-works', '/faq.html']);
    assert(nav.includes('id="whats-new-badge" hidden>New</span>'));
    const footer = html.match(/<footer class="landing-footer">[\s\S]*?<\/footer>/)[0];
    const indexFooter = indexHtml.match(/<footer class="landing-footer">[\s\S]*?<\/footer>/)[0];
    assert.equal(footer, indexFooter, 'the same footer as the homepage');
  });

  check(`${file}: loads only its scripts in order, nothing inline, every file exists and is whitelisted and deployed`, () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => {
      assert(/\bsrc="/.test(m[1]), 'inline script: ' + m[0]);
      return m[1].match(/src="([^"]+)"/)[1];
    });
    assert.deepEqual(scripts, spec.scripts);
    assert(!/<style\b/i.test(html) && !/\sstyle\s*=/.test(html) && !/\son[a-z]{3,}\s*=/i.test(html), 'no inline style or handler');
    const ignore = read('.gitignore').split('\n').map(l => l.trim());
    const vercelIgnore = read('.vercelignore').split('\n').map(l => l.trim());
    for (const rel of [file, ...scripts.map(s => s.slice(1))]) {
      assert(fs.statSync(path.join(ROOT, rel)).size > 0, rel);
      assert(ignore.includes('!' + rel), `.gitignore has no "!${rel}" line`);
      assert(!vercelIgnore.includes('/' + rel), `${rel} must not be excluded from the deploy`);
    }
  });
}

check('faq.html holds the 16 questions, each a details/summary with an answer, in the homepage order', () => {
  const html = read('faq.html');
  const questions = [...html.matchAll(/<details><summary>([^<]+)<\/summary><p>/g)].map(m => m[1]);
  assert.equal((html.match(/<details>/g) || []).length, 16);
  assert.deepEqual(questions, [
    'Is Raidsmith free?',
    'Where does my roster data go?',
    'How does it decide who goes where?',
    'What happens when more people sign up than the raid holds?',
    'Loading from URL failed. What now?',
    'People signed up after I built the groups. Do I start over?',
    'Where do Bench, Tentative, Late and Absent sign-ups go?',
    'Does it support 10-man raids?',
    'Does it support Classic Era?',
    'Does it support WoW Forever?',
    'How do I get the layout to my raid?',
    'Can I load the groups into MRT (Method Raid Tools)?',
    "Can I paste a roster that isn't from Raid-Helper?",
    'Are there keyboard shortcuts?',
    'Can I back up my data, or move it to another browser or device?',
    'I dismissed a feature tip and want to see it again',
  ]);
  assert(html.includes('<h2 class="section-title">'), 'the h2 under the h1');
  assert(html.includes('id="faq-show-tips-again"') && html.includes('id="faq-tips-status" role="status"'));
  assert(!html.includes('faq-shortcuts-link'), 'the shortcuts dialog lives in the planner; the FAQ links to it instead');
});

check('whats-new.html is an empty container that the script fills with the full change list', () => {
  const html = read('whats-new.html');
  assert(html.includes('<div id="whats-new-body"></div>'));
  assert(!/<ul class="whats-new-list">/.test(html) && !html.includes('<h3'));
  assert(html.includes('<h2 class="section-title">'));
});

check('the homepage lost the kicker, the version note, the What\'s new banner and the FAQ section', () => {
  for (const gone of ['hero-kicker', 'landing-version-note', 'id="whats-new"', 'id="whats-new-line"', 'id="app-version"', 'id="whats-new-title"',
    'btn-whats-new-toggle', 'id="whats-new-body"', 'id="faq"', 'class="faq"', 'faq-show-tips-again', 'faq-shortcuts-link', 'Frequently asked questions']) {
    assert(!indexHtml.includes(gone), gone);
  }
  assert(indexHtml.includes('id="how-it-works"'), 'How it works stays');
  assert(app.css.indexOf('.hero-kicker') < 0 && app.css.indexOf('#landing-version-note') < 0 && app.css.indexOf('.whats-line') < 0);
});

check('the homepage header links to the pages, the badge stays on the What\'s new link, and nothing points at the old anchors', () => {
  const band = indexHtml.slice(indexHtml.indexOf('<header class="game-header"'), indexHtml.indexOf('</header>'));
  assert(band.includes('<a href="/whats-new.html" id="nav-whats-new">What\'s new<span class="new-badge" id="whats-new-badge" hidden>New</span></a>'));
  assert(band.includes('<a href="/faq.html">FAQ</a>') && band.includes('<a href="#how-it-works">How it works</a>'));
  const sources = ['index.html', 'README.md', 'faq.html', 'whats-new.html', ...fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
  for (const rel of sources) assert(!/(?:href=|['"`])["']?#(?:faq|whats-new)["'`]/.test(read(rel)), `${rel} still points at a moved anchor`);
});

check('index.html loads util.js first and site-pages.js last; vercel.json only rewrites the plan links', () => {
  assert.equal(app.scripts[0], '/js/util.js');
  assert.equal(app.scripts[app.scripts.length - 1], '/js/site-pages.js');
  assert(app.scripts.indexOf('/js/util.js') < app.scripts.indexOf('/js/changelog.js'));
  const config = JSON.parse(read('vercel.json'));
  const re = /^\/(tbc|classic|forever)\/[^/]+$/;
  assert.deepEqual(config.rewrites.map(r => r.source), ['/:version(tbc|classic|forever)/:id']);
  assert(!re.test('/faq.html') && !re.test('/whats-new.html'), 'the pages are served as static files');
});

// ── js/site-pages.js behavior, on fake documents ─────────────────────
function fakeEl(extra = {}) {
  const attrs = {};
  const handlers = {};
  return Object.assign({ textContent: '', innerHTML: '', hidden: false, attrs, handlers,
    addEventListener(type, fn) { handlers[type] = fn; },
    getAttribute(k) { return k in attrs ? attrs[k] : null; } }, extra);
}

/** Runs a page's real scripts (in the order the page loads them) against a fake document and store. */
function openPage(file, data = {}, ids = {}) {
  const els = ids;
  const listeners = {};
  const store = {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
  const document = { getElementById: id => els[id] || null, defaultView: { addEventListener: (t, fn) => { listeners[t] = fn; } } };
  const ctx = vm.createContext({ document, localStorage: store, navigator: { userAgent: 'TestAgent' }, console });
  const scripts = [...read(file).matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  for (const src of scripts) vm.runInContext(read(src.slice(1)), ctx, { filename: src });
  return { els, data, listeners, ctx };
}

check('a page with the header badge shows it until the current release was seen, and hides it after', () => {
  const CH = app.sandbox(['APP_VERSION']).api;
  const fresh = openPage('faq.html', {}, { 'whats-new-badge': fakeEl({ hidden: true }) });
  assert.equal(fresh.els['whats-new-badge'].hidden, false, 'nothing stored: the badge shows');
  assert.deepEqual(fresh.data, {}, 'showing the badge stores nothing');
  const old = openPage('faq.html', { pp_whats_new_dismissed_v1: 'true' }, { 'whats-new-badge': fakeEl({ hidden: true }) });
  assert.equal(old.els['whats-new-badge'].hidden, false, 'the pre-versioned value covers nothing');
  const seen = openPage('faq.html', { pp_whats_new_dismissed_v1: CH.APP_VERSION }, { 'whats-new-badge': fakeEl() });
  assert.equal(seen.els['whats-new-badge'].hidden, true);
  const older = openPage('faq.html', { pp_whats_new_dismissed_v1: '0.0.1' }, { 'whats-new-badge': fakeEl({ hidden: true }) });
  assert.equal(older.els['whats-new-badge'].hidden, false, 'an older dismissal brings the badge back once');
});

check('visiting What\'s new lists every release, stores the current version under the original key and hides the badge', () => {
  const CH = app.sandbox(['APP_VERSION', 'CHANGELOG']).api;
  const page = openPage('whats-new.html', {}, { 'whats-new-badge': fakeEl({ hidden: true }), 'whats-new-body': fakeEl() });
  assert.equal((page.els['whats-new-body'].innerHTML.match(/<h3 /g) || []).length, CH.CHANGELOG.length);
  assert(page.els['whats-new-body'].innerHTML.includes(`v${CH.APP_VERSION}`));
  assert.equal(page.data.pp_whats_new_dismissed_v1, CH.APP_VERSION);
  assert.equal(page.els['whats-new-badge'].hidden, true);
  // The next page that has the badge no longer shows it.
  const home = openPage('faq.html', page.data, { 'whats-new-badge': fakeEl({ hidden: true }) });
  assert.equal(home.els['whats-new-badge'].hidden, true);
});

check('the page still works when localStorage throws, and Back from the cache refreshes a stale badge', () => {
  const CH = app.sandbox(['APP_VERSION']).api;
  const els = { 'whats-new-badge': fakeEl({ hidden: true }), 'whats-new-body': fakeEl() };
  const document = { getElementById: id => els[id] || null, defaultView: { addEventListener() {} } };
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  const ctx = vm.createContext({ document, localStorage: broken, navigator: { userAgent: 'x' }, console });
  for (const src of ['js/util.js', 'js/changelog.js', 'js/site-pages.js']) vm.runInContext(read(src), ctx);
  assert(els['whats-new-body'].innerHTML.includes('<h3 '), 'the list renders without storage');

  const data = {};
  const page = openPage('faq.html', data, { 'whats-new-badge': fakeEl({ hidden: true }) });
  assert.equal(page.els['whats-new-badge'].hidden, false);
  data.pp_whats_new_dismissed_v1 = CH.APP_VERSION; // another tab visited What's new
  page.listeners.pageshow({ persisted: false });
  assert.equal(page.els['whats-new-badge'].hidden, false, 'a normal load does not recheck');
  page.listeners.pageshow({ persisted: true });
  assert.equal(page.els['whats-new-badge'].hidden, true);
});

check('faq.html loads storage.js standalone, and "Show tips again" clears the one-time tips and says so', () => {
  const data = { pp_spotlight_seen_v1: '["menu-v2"]' };
  const page = openPage('faq.html', data, { 'faq-show-tips-again': fakeEl(), 'faq-tips-status': fakeEl() });
  assert.equal(vm.runInContext('typeof Spotlight', page.ctx), 'object');
  assert.equal(page.els['faq-tips-status'].textContent, '');
  page.els['faq-show-tips-again'].handlers.click();
  assert.equal('pp_spotlight_seen_v1' in data, false);
  assert(page.els['faq-tips-status'].textContent.includes('Feature tips will show again'));
});

check('the footer feedback link gets the version and browser on every page', () => {
  const CH = app.sandbox(['APP_VERSION']).api;
  for (const file of Object.keys(PAGES)) {
    const link = fakeEl();
    link.attrs.href = 'https://github.com/Spazz/RaidPlanner/issues/new';
    link.href = link.attrs.href;
    openPage(file, {}, { 'feedback-link': link });
    const body = `Raidsmith ${CH.APP_VERSION}\nBrowser: TestAgent\n\nWhat happened:\n`;
    assert.equal(link.href, 'https://github.com/Spazz/RaidPlanner/issues/new?body=' + encodeURIComponent(body), file);
  }
});

check('site-pages.js is the last script of the homepage and its auto-run is a no-op under Node', () => {
  const src = read('js/site-pages.js');
  assert(src.includes('try { initSitePage(document, localStorage, navigator); } catch {}'));
  vm.runInNewContext(src + '\nthis.ok = typeof initSitePage;', Object.assign(vm.createContext({}), {}));
});

console.log(`\nSite pages tests: ${passed} passed, 0 failed, ${passed} total`);
