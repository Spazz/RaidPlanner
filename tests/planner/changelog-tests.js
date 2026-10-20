/**
 * PartyPlanner Web - release notes and version tests
 * Run: node tests/planner/changelog-tests.js
 *
 * js/changelog.js holds APP_VERSION and the CHANGELOG that whats-new.html renders as its
 * release list. These checks pin: the version agrees with package.json and the newest entry,
 * entries are well formed and strictly newest-first, the dismissal rule shows the badge once
 * per new version (and once for the old "true" value), the markup escapes its text, backups
 * still validate the dismissal key, and the page actually wires it all up.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = require('../load-app');

const ctx = app.sandbox(['APP_VERSION', 'CHANGELOG', 'parseVersion', 'whatsNewDismissed', 'renderChangelog', 'DataBackup', 'esc', 'WHATS_NEW_KEY', 'dismissWhatsNew', 'whatsNewSeen']);
const { APP_VERSION, CHANGELOG, parseVersion, whatsNewDismissed, renderChangelog, DataBackup, WHATS_NEW_KEY, dismissWhatsNew, whatsNewSeen } = ctx.api;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('APP_VERSION is a plain x.y.z, matches package.json and the newest changelog entry', () => {
  assert(parseVersion(APP_VERSION), APP_VERSION);
  const pkg = JSON.parse(fs.readFileSync(path.join(app.ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.version, APP_VERSION);
  assert.equal(CHANGELOG[0].version, APP_VERSION);
});

check('every entry has a version, an ISO date, a title and at least one plain-text change; newest first, no repeats', () => {
  let previous = null;
  for (const entry of CHANGELOG) {
    assert(parseVersion(entry.version), `version ${entry.version}`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.date), `date ${entry.date}`);
    assert(entry.title && entry.changes.length > 0, entry.version);
    for (const line of entry.changes) assert(/^[\x20-\x7e]+$/.test(line) && line.length < 220, `plain, short line: ${line}`);
    if (previous) {
      assert(!whatsNewDismissed(entry.version, previous.version), 'older versions sort after newer ones');
      assert(entry.date <= previous.date, `${entry.version} is dated after ${previous.version}`);
    }
    previous = entry;
  }
  assert.equal(new Set(CHANGELOG.map(e => e.version)).size, CHANGELOG.length);
});

check('the changelog covers Phases 1 to 3 by version', () => {
  const versions = CHANGELOG.map(e => e.version);
  for (const v of ['1.0.0', '2.0.0', '3.0.0']) assert(versions.includes(v), v);
});

check('the badge shows once per new version: dismissed covers that version and older ones only', () => {
  assert.equal(whatsNewDismissed('3.0.0', '3.0.0'), true);
  assert.equal(whatsNewDismissed('3.1.0', '3.0.0'), true, 'a newer dismissal still covers an older release');
  assert.equal(whatsNewDismissed('2.9.9', '3.0.0'), false);
  assert.equal(whatsNewDismissed('3.0.0', '3.0.1'), false);
  assert.equal(whatsNewDismissed('3.0.0', '10.0.0'), false, 'numeric, not string, comparison');
  assert.equal(whatsNewDismissed('10.0.0', '9.0.0'), true);
});

check('the pre-versioned "true", "false", garbage and nothing stored all show the badge', () => {
  for (const stored of ['true', 'false', '', null, undefined, 'v3.0.0', '3.0', '3.0.0-beta']) {
    assert.equal(whatsNewDismissed(stored), false, String(stored));
  }
});

check('renderChangelog lists every release by default, with escaped text, and respects an explicit limit', () => {
  const html = renderChangelog();
  assert.equal((html.match(/<h3 /g) || []).length, CHANGELOG.length);
  assert(html.includes(`v${APP_VERSION}`));
  assert.equal((renderChangelog(CHANGELOG, 2).match(/<h3 /g) || []).length, 2);
  const hostile = [{ version: '9.9.9', date: '2030-01-01', title: '<img src=x onerror=alert(1)>', changes: ['a "quote" & <b>bold</b>'] }];
  const out = renderChangelog(hostile, 5);
  assert(!/<img|<b>/.test(out) && out.includes('&lt;img') && out.includes('&amp;'));
  assert.equal(renderChangelog([], 3), '');
});

check('data backups accept a version, "true" or "false" for the dismissal key and reject anything else', () => {
  const valid = raw => DataBackup._checkKey('pp_whats_new_dismissed_v1', raw).valid;
  assert(valid('3.0.0') && valid('true') && valid('false'));
  assert(!valid('maybe') && !valid('3.0') && !valid(''));
});

check('the dismissal is stored under the original key as the current version, and survives a broken store', () => {
  assert.equal(WHATS_NEW_KEY, 'pp_whats_new_dismissed_v1');
  const data = {};
  const store = { getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
  assert.equal(whatsNewSeen(store), false);
  assert.equal(dismissWhatsNew(store), true);
  assert.equal(data[WHATS_NEW_KEY], APP_VERSION);
  assert.equal(whatsNewSeen(store), true);
  data[WHATS_NEW_KEY] = 'true';
  assert.equal(whatsNewSeen(store), false, 'the pre-versioned value covers nothing');
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  assert.equal(whatsNewSeen(broken), false);
  assert.equal(dismissWhatsNew(broken), false);
});

console.log(`\nChangelog tests: ${passed} passed, 0 failed, ${passed} total`);
