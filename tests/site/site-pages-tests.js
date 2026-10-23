/**
 * Raidsmith Web - static site pages tests
 * Run: node tests/site/site-pages-tests.js
 *
 * faq.html and whats-new.html are plain pages that draw the same shell (rail, sidebar, top bar; js/guild/)
 * and footer as the planner's homepage. They load the scripts they need (js/util.js, js/changelog.js,
 * js/site-pages.js, and js/storage.js for the FAQ's "Show tips again") followed by the guild shell scripts
 * (tests/guild-scripts.js). These checks pin: the page shell (head, one h1, the shell skeleton ids, footer),
 * no inline code (strict CSP), the 16 FAQ questions, that the homepage lost its kicker, version note,
 * What's new banner and FAQ section, that every link to them is repointed, that the files are
 * whitelisted and deployed, and the behavior of js/site-pages.js: the dismissal by visiting What's new,
 * the full release list and the tips reset (the New pill itself belongs to the shell).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = require('../load-app');
const { GUILD_LOADER, GUILD_MANIFEST, guildScriptsOf } = require('../guild-scripts');
// Each page ends with the one guild loader tag; it loads the scripts js/guild/manifest.js lists (util.js is each page's first script).
// The ids lane S renders into (spec section 3); the planner's own slot and root exist on index.html only.
const SHELL_IDS = ['guild-root', 'shell-rail', 'shell-sidebar', 'shell-topbar', 'shell-topbar-lead', 'shell-topbar-account', 'shell-banner', 'gs-main', 'shell-tabs', 'shell-drawer', 'guild-dialogs'];

const ROOT = app.ROOT;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { SITE } = require('../site-host');
const PAGES = {
  'faq.html': { title: 'FAQ - Raidsmith', h1: 'Frequently asked questions', scripts: ['/js/util.js', '/js/changelog.js', '/js/storage.js', '/js/site-pages.js', GUILD_LOADER] },
  'whats-new.html': { title: "What's new - Raidsmith", h1: "What's new", scripts: ['/js/util.js', '/js/changelog.js', '/js/site-pages.js', GUILD_LOADER] },
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
    assert(html.includes('<link rel="stylesheet" href="/app.css">\n<link rel="stylesheet" href="/planner-forge.css">\n<link rel="stylesheet" href="/guild.css">'));
    assert(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Barlow:[^"]+" rel="stylesheet">/.test(html));
    assert(html.includes('<link rel="icon" href="data:image/svg+xml,'));
    assert(html.indexOf('rel="preconnect"') < html.indexOf('fonts.googleapis.com/css2'));
  });

  check(`${file}: one h1, the shell skeleton (no era band), the page's own main, and the footer`, () => {
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
    assert(html.includes(`<h1 class="page-title">${spec.h1}</h1>`));
    // The page's own <main class="landing"> plus the shell's hidden #gs-main.
    assert.equal((html.match(/<main[ >]/g) || []).length, 2);
    assert(html.includes('<main class="landing">') && html.includes('<main class="gs-main" id="gs-main" hidden></main>'));
    assert(html.includes(`<body class="site-page guild-page shell-pending" data-page="${file.replace('.html', '')}">`), 'body classes and data-page');
    for (const id of SHELL_IDS) assert(html.includes(`id="${id}"`), id + ' in the skeleton');
    assert(!html.includes('shell-topbar-plan') && !html.includes('planner-root'), 'the planner pieces belong to index.html');
    assert(!/era-band|game-header|whats-new-badge|brand-home|game-version/.test(html), 'no era band, header badge or version tabs');
    const footer = html.match(/<footer class="landing-footer">[\s\S]*?<\/footer>/)[0];
    const indexFooter = indexHtml.match(/<footer class="gs-ph-foot">[\s\S]*?<\/footer>/)[0];
    const feedback = f => f.match(/<a [^>]*id="feedback-link"[^>]*>[^<]*<\/a>/)[0].replace(/ class="footer-link"/, '');
    assert.equal(feedback(footer), feedback(indexFooter), 'the same feedback link as the homepage');
    assert(footer.includes('Raidsmith &middot; forged for raid night') && indexFooter.includes('Raidsmith &middot; forged for raid night'), 'both carry the brand line');
  });

  check(`${file}: loads only its scripts in order, nothing inline, every file exists and is whitelisted and deployed`, () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => {
      assert(/\bsrc="/.test(m[1]), 'inline script: ' + m[0]);
      return m[1].match(/src="([^"]+)"/)[1];
    });
    assert.deepEqual(scripts, spec.scripts);
    assert.deepEqual(guildScriptsOf(html), GUILD_MANIFEST, 'the guild scripts come from the manifest alone');
    assert(!/<style\b/i.test(html) && !/\sstyle\s*=/.test(html) && !/\son[a-z]{3,}\s*=/i.test(html), 'no inline style or handler');
    const ignore = read('.gitignore').split('\n').map(l => l.trim());
    const assetsIgnore = read('.assetsignore').split('\n').map(l => l.trim());
    // js/guild/*.js is whitelisted as a glob, the other files one by one.
    const whitelisted = rel => ignore.includes('!' + rel) || (/^js\/guild\/[\w-]+\.js$/.test(rel) && ignore.includes('!js/guild/*.js'));
    for (const rel of [file, 'planner-forge.css', 'guild.css', ...scripts.map(s => s.slice(1)), 'js/guild/manifest.js', ...GUILD_MANIFEST.map(s => s.slice(1))]) {
      assert(fs.statSync(path.join(ROOT, rel)).size > 0, rel);
      assert(whitelisted(rel), `.gitignore has no "!${rel}" line`);
      assert(!assetsIgnore.includes('/' + rel), `${rel} must not be excluded from the deploy`);
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

check('the homepage has no era band; the shell\'s sidebar owns the links to the pages, and nothing points at the old anchors', () => {
  assert(!/era-band|game-header-links|whats-new-badge|nav-whats-new/.test(indexHtml), 'the header links moved to the shell');
  assert(!indexHtml.includes('New to Raidsmith?'), 'the compact home has no How it works link of its own: the sidebar Help carries it (shell.js)');
  assert(read('js/guild/shell.js').includes("action: 'how-it-works'"), 'the sidebar Help links to How it works');
  const sources = ['index.html', 'README.md', 'faq.html', 'whats-new.html', ...fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
  for (const rel of sources) assert(!/(?:href=|['"`])["']?#(?:faq|whats-new)["'`]/.test(read(rel)), `${rel} still points at a moved anchor`);
});

check('index.html carries the shell skeleton: every id, in order, with the planner inside #planner-root', () => {
  const at = id => { const i = indexHtml.indexOf('id="' + id + '"'); assert(i > 0, id + ' missing'); return i; };
  for (const id of SHELL_IDS) at(id);
  const order = ['guild-root', 'shell-rail', 'shell-sidebar', 'shell-topbar', 'shell-topbar-lead', 'shell-topbar-plan', 'shell-topbar-account', 'shell-banner', 'gs-main', 'planner-root', 'shell-tabs', 'shell-drawer', 'guild-dialogs'].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the slots come in the spec order');
  assert(indexHtml.includes('<body class="guild-page shell-pending" data-page="app">'));
  assert(indexHtml.includes('<main class="gs-main" id="gs-main" hidden></main>'));
  const rootStart = indexHtml.indexOf('<div id="planner-root" class="planner-root">');
  const rootEnd = indexHtml.indexOf('<div id="shell-tabs">');
  const root = indexHtml.slice(rootStart, rootEnd);
  for (const part of ['id="landing-view"', 'id="app"', '<dialog id="share-dialog"', '<dialog id="confirm-dialog"', 'id="planner-notice"']) assert(root.includes(part), part + ' inside #planner-root');
  const plan = indexHtml.slice(at('shell-topbar-plan'), at('shell-topbar-account'));
  assert(plan.includes('class="game-version-nav gs-fg-segs"'), 'the version tabs stay in the planner top bar for the landing');
  for (const part of ['class="title-bar"', 'id="roster-name"', 'id="btn-share-menu"', 'id="btn-settings-menu"', 'phone-summary', 'phone-version-slot']) assert(!plan.includes(part), part + ' left the planner top bar: the plan head lives in main#app');
  const appMain = indexHtml.slice(indexHtml.indexOf('<main class="addon-frame gs-forge" id="app"'));
  for (const part of ['<header class="gs-pb-planhead" id="plan-head">', 'id="btn-back-plans"', 'id="roster-name"', 'id="plan-chip"', 'id="plan-context"', 'id="btn-undo"', 'id="btn-redo"', 'id="btn-share-menu"', 'id="btn-settings-menu"', 'id="btn-optimize"']) assert(appMain.includes(part), part + ' in the plan head');
  assert(!plan.includes('phone-home-slot') && !plan.includes('planner-home'));
  // The planner's other body-level pieces stay outside the shell.
  const afterShell = indexHtml.slice(indexHtml.indexOf('<div id="guild-dialogs">'));
  for (const id of ['drag-ghost', 'toast', 'sr-status', 'print-sheet', 'buff-tooltip-portal']) assert(afterShell.includes('id="' + id + '"'), id + ' stays at body level');
  // Planner home: the banner slot, the head with its context line, the notice slot.
  assert(/<div id="planner-banner"><\/div>/.test(indexHtml));
  assert(/<div id="planner-notice"><\/div>/.test(indexHtml));
  assert(/<h1 class="gs-ph-h1" tabindex="-1">Planner<\/h1>\s*<p class="gs-ph-context" id="planner-context"><\/p>/.test(indexHtml), 'the landing h1 can take focus');
  assert(!indexHtml.includes('Import sign-ups or open a saved plan. Plans save in this browser.'), 'the old intro line is cut');
  assert.equal((indexHtml.match(/<h1 class="gs-ph-h1" tabindex="-1">/g) || []).length, 1);
  assert.equal((indexHtml.match(/<h1 class="gs-pb-h1 plan-only" tabindex="-1">/g) || []).length, 1, 'the plan name is the plan view h1 and can take focus');
});

check('index.html loads util.js first, site-pages.js after the planner scripts, then the guild tail; the Worker serves the plan links', () => {
  assert.equal(app.scripts[0], '/js/util.js');
  assert.equal(app.scripts[app.scripts.length - 1], '/js/guild/app.js');
  const guildAt = app.scripts.indexOf(GUILD_LOADER); // the loader tag stands for the loader, the manifest and the manifest's scripts
  assert.deepEqual(app.scripts.slice(guildAt), [GUILD_LOADER, '/js/guild/manifest.js', ...GUILD_MANIFEST], 'the page ends with the guild loader and what it runs');
  assert.deepEqual(guildScriptsOf(app.html), GUILD_MANIFEST);
  assert.equal(app.scripts[guildAt - 1], '/js/site-pages.js');
  assert.equal(guildAt, 19, 'the 19 planner scripts (18 plus js/plansync.js after livesync.js), in page order');
  assert.equal(app.scripts[app.scripts.indexOf('/js/livesync.js') + 1], '/js/plansync.js');
  assert.deepEqual(app.stylesheets, ['/app.css', '/planner-forge.css', '/guild.css']);
  assert(app.scripts.indexOf('/js/util.js') < app.scripts.indexOf('/js/changelog.js'));
  const re = /^\/(tbc|classic|forever)\/[^/]+$/;
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
  // The page's own scripts only: the guild shell has its own suites and needs a real document.
  const scripts = [...read(file).matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !s.startsWith('/js/guild/'));
  for (const src of scripts) vm.runInContext(read(src.slice(1)), ctx, { filename: src });
  return { els, data, listeners, ctx };
}

check('site-pages.js leaves the New pill to the shell: it never looks for #whats-new-badge or listens for pageshow', () => {
  const src = read('js/site-pages.js');
  assert(!/whats-new-badge|pageshow|whatsNewSeen/.test(src));
  const fresh = openPage('faq.html', {}, { 'whats-new-badge': fakeEl({ hidden: true }) });
  assert.equal(fresh.els['whats-new-badge'].hidden, true, 'untouched');
  assert.deepEqual(fresh.data, {}, 'opening the FAQ stores nothing');
  assert.equal(fresh.listeners.pageshow, undefined);
});

check('visiting What\'s new lists every release and stores the current version under the original key', () => {
  const CH = app.sandbox(['APP_VERSION', 'CHANGELOG']).api;
  const page = openPage('whats-new.html', {}, { 'whats-new-body': fakeEl() });
  assert.equal((page.els['whats-new-body'].innerHTML.match(/<h3 /g) || []).length, CH.CHANGELOG.length);
  assert(page.els['whats-new-body'].innerHTML.includes(`v${CH.APP_VERSION}`));
  assert.equal(page.data.pp_whats_new_dismissed_v1, CH.APP_VERSION);
});

check('the page still works when localStorage throws', () => {
  const els = { 'whats-new-body': fakeEl() };
  const document = { getElementById: id => els[id] || null, defaultView: { addEventListener() {} } };
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  const ctx = vm.createContext({ document, localStorage: broken, navigator: { userAgent: 'x' }, console });
  for (const src of ['js/util.js', 'js/changelog.js', 'js/site-pages.js']) vm.runInContext(read(src), ctx);
  assert(els['whats-new-body'].innerHTML.includes('<h3 '), 'the list renders without storage');
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

check('site-pages.js is the last planner script of the homepage and its auto-run is a no-op under Node', () => {
  const src = read('js/site-pages.js');
  assert(src.includes('try { initSitePage(document, localStorage, navigator); } catch {}'));
  vm.runInNewContext(src + '\nthis.ok = typeof initSitePage;', Object.assign(vm.createContext({}), {}));
});

console.log(`\nSite pages tests: ${passed} passed, 0 failed, ${passed} total`);
