/**
 * PartyPlanner Web - share label drift tests (4.3.0, package L2-2)
 * Run: node tests/planner/labels-tests.js
 *
 * One canonical label per share action, checked on every surface that carries it:
 * the Share menu item (text without its kbd), the Share dialog button, the shortcuts help
 * entry and the menu aria-label. Also pins the MRT / live link toast and status copy.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('../load-app');

const html = app.html.replace(/\r\n/g, '\n');
const script = app.script.replace(/\r\n/g, '\n');
const chunk = app.slice('const SHORTCUT_BUTTONS', '// ── INITIALIZE');
const help = app.sandbox(['SHORTCUTS_HELP'], { globals: { document: { getElementById: () => null, addEventListener() {}, querySelector: () => null } }, extraSource: chunk }).api.SHORTCUTS_HELP;

const decode = (text) => text.replace(/<kbd[^>]*>.*?<\/kbd>/g, '').replace(/<[^>]+>/g, '').replace(/&hellip;/g, '\u2026').trim();
const menuItem = (id) => html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>[^]*?</button>'))[0];
const dialogButton = (id) => {
  const m = html.match(new RegExp('<button[^>]*data-share-action="' + id + '"[^>]*>([^]*?)</button>'));
  return m ? decode(m[1]) : null;
};

// id, menu label, aria-label, dialog label (null: not in the dialog), help key + label (null: no shortcut)
const ACTIONS = [
  { id: 'btn-share', label: 'Copy live link', aria: 'Copy live link: everyone with it sees and edits this plan', dialog: 'Copy live link', help: ['L', 'Copy live link'] },
  { id: 'btn-copy-mrt', label: 'Copy for MRT', aria: 'Copy for MRT: the seated groups as an MRT Raid Groups import string', dialog: 'Copy for MRT', help: ['G', 'Copy for MRT'] },
  { id: 'btn-copy-mrt-note', label: 'Copy MRT note', aria: 'Copy MRT note: the assignments as an MRT note', dialog: 'Copy MRT note', help: ['M', 'Copy MRT note'] },
  { id: 'btn-copy-chat', label: 'Copy raid chat text', aria: 'Copy raid chat text: the groups as plain text for Discord or raid chat', dialog: 'Copy raid chat text', help: ['C', 'Copy raid chat text'] },
  { id: 'btn-copy-chat-compact', label: 'Copy compact chat text', aria: 'Copy compact chat text: sized for in-game raid chat', dialog: 'Copy compact chat text', help: null },
  { id: 'btn-print-sheet', label: 'Print raid sheet', aria: 'Print raid sheet: opens a printable sheet', dialog: 'Print raid sheet', help: null },
  { id: 'btn-share-main', label: 'Share and export\u2026', title: 'Share and export (E)', aria: null, dialog: null, help: ['E', 'Share and export'] },
];

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS  ' + name); }

for (const a of ACTIONS) {
  check(a.id + ' carries the same label on every surface', () => {
    const tag = menuItem(a.id);
    assert.equal(decode(tag), a.label, 'menu text');
    if (a.aria) assert(tag.includes('aria-label="' + a.aria + '"'), 'aria-label');
    if (a.title) assert(tag.includes('title="' + a.title + '"'), 'title');
    if (a.dialog) assert.equal(dialogButton(a.id), a.dialog, 'dialog text');
    if (a.help) assert(help.some(([k, l]) => k === a.help[0] && l === a.help[1]), 'help entry ' + a.help.join(' / '));
  });
}

check('the dialog-only JSON buttons keep their labels', () => {
  assert.equal(dialogButton('btn-export-json'), 'Download JSON');
  assert.equal(dialogButton('btn-copy-json'), 'Copy JSON');
});

check('no share surface keeps a retired label', () => {
  for (const old of ['Copy share link', 'Share / Export', 'Share/Export', 'Copy compact raid chat', 'Print sheet', 'shared raid']) {
    assert(!html.replace(/<!--[\s\S]*?-->/g, '').includes(old), old + ' in index.html');
    assert(!script.includes(old), old + ' in app.js');
  }
  // "share link" is gone from the page text (ids, classes and attributes aside).
  const pageText = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s(?:id|class|for|href|data-[a-z-]+)="[^"]*"/g, '');
  assert(!/share link/i.test(pageText), 'share link in index.html text');
});

check('shared-plan toasts say plan, not raid', () => {
  for (const text of ['Opening shared plan...', 'Opened live plan "${State.rosterName}"', 'Opened live plan "${State.rosterName}" (its link had expired', 'Loaded shared plan "${State.rosterName}"'])
    assert(script.includes(text), text);
  assert(!/Opened live raid/.test(script));
});

check('the FAQ and the Share dialog name the real Share path', () => {
  const faq = fs.readFileSync(path.join(app.ROOT, 'faq.html'), 'utf8').replace(/\r\n/g, '\n');
  assert(faq.includes('use Share and export&hellip;, then Download JSON under More export formats'));
  assert(faq.includes('Share &gt; Copy live link'));
  assert(html.includes('<p>Send your plan to the raid or bring it into the game.</p>'));
});

check('help lists G (Copy for MRT) right after L', () => {
  const keys = help.map(([k]) => k);
  assert.equal(keys.indexOf('G'), keys.indexOf('L') + 1);
});

check('the phone relabel stays "Share" and the desktop label is the canonical one', () => {
  assert(/isPhone \? 'Share' : 'Share and export\u2026'/.test(script));
});

check('MRT and live link copy toasts and statuses say what happens', () => {
  for (const text of [
    'MRT string copied (seated groups only). In MRT: Raid Groups > Import > "From ExRT export string"',
    'Live link copied. Anyone with it can see and edit this plan; it expires 30 days after the last change.',
    'Live links are down right now, so this is a snapshot link: it will not update when the plan changes.',
    "'Live link not saved: ' + this.rejected.reason + '. Your changes are safe on this device.'",
    'Live link not saved yet, retrying. Your changes are safe on this device.',
    'Saving to the live link...',
    'Shared plan, changes sync to everyone with the link',
  ]) assert(script.includes(text), text);
});

console.log(`\nLabel tests: ${passed} passed, 0 failed, ${passed} total`);
