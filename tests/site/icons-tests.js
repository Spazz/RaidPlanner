/**
 * PartyPlanner Web - Self-hosted icon tests (Phase 2, G5 / P1)
 * Run: node tests/site/icons-tests.js
 *
 * Icons are served from icons/<slug>.jpg instead of wow.zamimg.com. This suite checks that:
 *   - every slug the rule tables can produce (buffs, debuffs, role markers, spec icons and
 *     class crests of every ruleset) has a real JPEG in icons/;
 *   - the app builds root-absolute /icons/ URLs and no source still points at the CDN;
 *   - the single capture-phase error listener degrades a failed icon (class crest, then text).
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('../load-app');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

const fakeDocument = { createElement: tag => makeEl(tag) };
function makeEl(tag, attrs = {}, parent = null) {
  const el = {
    tagName: tag.toUpperCase(), attrs: { ...attrs }, parentElement: parent, removed: false, replacement: null,
    classList: {
      classes: new Set((attrs.class || '').split(/\s+/).filter(Boolean)),
      contains(c) { return this.classes.has(c); },
      remove(c) { this.classes.delete(c); },
    },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = v; },
    removeAttribute(n) { delete this.attrs[n]; },
    remove() { this.removed = true; },
    replaceWith(node) { this.replacement = node; },
  };
  return el;
}

const extra = app.slice('const ROLE_ICONS = {', 'function getDominantRoleLabel');
const ctx = app.sandbox(['Config', 'Rulesets', 'ROLE_ICONS', 'getRoleIcon', 'getSpecIcon', 'handleIconError', 'State'],
  { extraSource: extra, globals: { document: fakeDocument } });
const { Config, Rulesets, ROLE_ICONS, getRoleIcon, getSpecIcon, handleIconError } = ctx.api;

// Every slug the rule tables name, by source (so a failure says where it came from).
const slugs = new Map();
const add = (slug, from) => { if (slug) slugs.set(slug, (slugs.get(slug) || []).concat(from)); };
Object.entries(Config.BuffIcons).forEach(([id, s]) => add(s, `BuffIcons.${id}`));
Object.entries(Config.DebuffIcons).forEach(([id, s]) => add(s, `DebuffIcons.${id}`));
Object.entries(ROLE_ICONS).forEach(([role, r]) => add(r.icon, `ROLE_ICONS.${role}`));
for (const [version, rules] of Object.entries(Rulesets)) {
  for (const cls of rules.classList) {
    add('classicon_' + cls.toLowerCase(), `${version} class crest ${cls}`);
    Object.entries(rules.specIcons[cls] || {}).forEach(([spec, s]) => add(s, `${version}.specIcons.${cls}.${spec}`));
  }
}

check('the rule tables name icons at all', () => {
  assert(slugs.size > 40, `only ${slugs.size} slugs found`);
});

check('every icon slug the rule tables reference exists in icons/ as a JPEG', () => {
  const missing = [];
  for (const [slug, from] of slugs) {
    const file = path.join(app.ROOT, 'icons', slug + '.jpg');
    if (!fs.existsSync(file)) { missing.push(`${slug} (${from[0]})`); continue; }
    const head = fs.readFileSync(file).subarray(0, 3);
    if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) missing.push(`${slug} is not a JPEG`);
  }
  assert.deepEqual(missing, []);
});

check('icon URLs are root-absolute /icons/ paths', () => {
  assert.equal(Config.IconURL('spell_holy_renew'), '/icons/spell_holy_renew.jpg');
  assert.equal(Config.IconURL(''), '');
  assert.equal(Config.BuffIconURL('WINDFURY'), '/icons/spell_nature_windfury.jpg');
  assert.equal(Config.BuffIconURL('NOPE'), '');
  assert.equal(Config.DebuffIconURL('SUNDER_ARMOR'), '/icons/' + Config.DebuffIcons.SUNDER_ARMOR + '.jpg');
  assert.match(getRoleIcon('healer'), /src="\/icons\/spell_holy_renew\.jpg"/);
  assert.match(getSpecIcon({ class: 'MAGE', spec: 'Fire', role: 'dps' }), /src="\/icons\/spell_fire_firebolt02\.jpg"/);
});

check('no app source or stylesheet loads images from the CDN', () => {
  // The one CDN reference allowed is Wowhead's item tooltip script (guild item pages, guild-item-tooltips-tests.js): a script, not an image.
  assert(!/zamimg/.test(app.script.split('https://wow.zamimg.com/js/tooltips.js').join('')), 'a script still references zamimg');
  assert(!/zamimg/.test(app.css), 'the stylesheet still references zamimg');
  assert(!/<img[^>]+src="https?:/i.test(app.html), 'index.html has a remote <img>');
});

check('a spec icon carries its class crest as the fallback; a class-less one has none', () => {
  assert.match(getSpecIcon({ class: 'MAGE', spec: 'Fire', role: 'dps' }), /data-fallback="\/icons\/classicon_mage\.jpg"/);
  assert.match(getSpecIcon({ class: 'MAGE', spec: 'Unknown', role: 'dps' }), /src="\/icons\/classicon_mage\.jpg"/);
  assert.doesNotMatch(getRoleIcon('tank'), /data-fallback/);
});

check('exactly one capture-phase error listener is registered for icons', () => {
  const registrations = app.script.match(/addEventListener\('error'.*true\)/g) || [];
  assert.equal(registrations.length, 1);
  assert.match(registrations[0], /handleIconError/);
  assert.equal((app.script.match(/addEventListener\('error'/g) || []).length, 1, 'no per-image error handlers');
});

check('a failed spec icon retries with the class crest, then drops out', () => {
  const span = makeEl('span');
  const img = makeEl('img', { src: '/icons/spell_fire_firebolt02.jpg', 'data-fallback': '/icons/classicon_mage.jpg' }, span);
  assert.equal(handleIconError(img), 'fallback');
  assert.equal(img.attrs.src, '/icons/classicon_mage.jpg');
  assert.equal(img.getAttribute('data-fallback'), null);
  assert.equal(img.removed, false);
  assert.equal(handleIconError(img), 'removed');
  assert.equal(img.removed, true);
});

check('a spec icon whose fallback is the failing image does not loop', () => {
  const img = makeEl('img', { src: '/icons/classicon_mage.jpg', 'data-fallback': '/icons/classicon_mage.jpg' }, makeEl('span'));
  assert.equal(handleIconError(img), 'removed');
});

check('a failed group buff icon loses has-icon so the text label shows', () => {
  const box = makeEl('div', { class: 'buff-icon buff-wf has-icon' });
  const img = makeEl('img', { src: '/icons/x.jpg' }, box);
  assert.equal(handleIconError(img), 'removed');
  assert.equal(img.removed, true);
  assert.equal(box.classList.contains('has-icon'), false);
  assert.equal(box.classList.contains('buff-wf'), true);
});

check('a failed catalog icon is replaced by its alt text', () => {
  const box = makeEl('div', { class: 'buff-row-icon' });
  const img = makeEl('img', { src: '/icons/x.jpg', alt: 'WF' }, box);
  assert.equal(handleIconError(img), 'text');
  assert.equal(img.replacement.textContent, 'WF');
});

check('a failed role icon is replaced by its alt text instead of leaving an empty span', () => {
  const span = makeEl('span', { class: 'role-icon tank' });
  const img = makeEl('img', { src: '/icons/x.jpg', alt: 'Tank' }, span);
  assert.equal(handleIconError(img), 'text');
  assert.equal(img.replacement.textContent, 'Tank');
});

check('non-image error targets are ignored', () => {
  assert.equal(handleIconError(null), 'ignored');
  assert.equal(handleIconError({}), 'ignored');
  assert.equal(handleIconError(makeEl('script')), 'ignored');
});

check('a spec icon says what it is on hover: spec, class and a role word, escaped', () => {
  const html = (p) => getSpecIcon(p);
  assert.match(html({ class: 'SHAMAN', spec: 'Enhancement', role: 'melee_dps' }), /^<span class="role-icon spec-icon role-dps" title="Enhancement Shaman, melee">/);
  assert.match(html({ class: 'PRIEST', spec: 'Holy', role: 'healer' }), /title="Holy Priest, healer"/);
  assert.match(html({ class: 'WARRIOR', spec: 'Protection', role: 'tank' }), /title="Protection Warrior, tank"/);
  assert.match(html({ class: 'HUNTER', spec: 'Marksmanship', role: 'ranged_dps' }), /title="Marksmanship Hunter, ranged"/);
  assert.match(html({ class: 'MAGE', spec: 'Fire', role: 'caster_dps' }), /title="Fire Mage, caster"/);
  assert.match(html({ class: 'MAGE', spec: 'Fire', role: 'dps' }), /title="Fire Mage"/, 'a role without a word adds none');
  const evil = html({ class: 'MAGE', spec: 'Fire"><img src=x onerror=alert(1)>', role: 'constructor' });
  assert.doesNotMatch(evil, /title="[^"]*[<>]/, evil);
  assert.match(evil, /title="Fire&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt; Mage"/);
});

console.log(`\n${passed} checks passed`);
