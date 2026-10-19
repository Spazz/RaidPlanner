/**
 * Raidsmith guild UI - dev "View as" bar, preview routes and the preview banner
 * Run: node guild-viewas-ui-tests.js
 *
 * The guild scripts (tests/guild-scripts.js) load in a vm sandbox with no DOM; the bar and the page are HTML strings. The Worker side is in
 * guild-viewas-worker-tests.js.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { GUILD_SCRIPTS } = require('./tests/guild-scripts');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}
const ROOT = __dirname;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const sandbox = Object.assign({ console, Intl, Date, JSON, Math, Promise, Object, Array, String, Number, Error, setTimeout });
vm.createContext(sandbox);
for (const src of GUILD_SCRIPTS) vm.runInContext(read(src.replace(/^\//, '')), sandbox, { filename: src });
sandbox.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
const G = sandbox.Guild;
const GID = 'g_AAAAAAAAAAAAAAAAAAAAAA';
const TEAM = 't_AAAAAAAAAAAAAAAAAAAAAA';
const DEV = {
  viewAs: null,
  roles: [{ id: 'officer', name: 'Officer', teamScoped: false }, { id: 'team_lead', name: 'Team Lead', teamScoped: true }, { id: 'member', name: 'Member', teamScoped: false }],
  teams: [{ id: TEAM, name: 'Alpha' }],
};
const guildData = (dev) => ({ guild: { id: GID, name: 'Ember', realm: 'Nightslayer', realmKind: 'realm', region: 'US', gameVersion: 'tbc', timeZone: 'America/New_York' }, teams: [], me: { roles: [], can: {} }, ...(dev ? { dev } : {}) });
const ctxOf = (gd, extra) => ({ section: 'guild', page: 'app', me: { user: { id: 'u' } }, guildData: gd, route: { name: 'section', gid: GID, section: 'home' }, ...(extra || {}) });

(async () => {
  await check('the bar renders only with gd.dev, as a labelled region in info tones with a live region', () => {
    assert.equal(G.shell.devBarHtml(ctxOf(guildData(null))), '');
    assert.equal(G.shell.slots(ctxOf(guildData(null))).devbar, '');
    const html = G.shell.slots(ctxOf(guildData(DEV))).devbar;
    assert(html.includes('role="region"') && html.includes('aria-label="View as (development only)"'));
    assert(html.includes('<option value="" selected>Guild Master (me)</option>'));
    for (const name of ['Officer', 'Team Lead', 'Member']) assert(html.includes('>' + name + '</option>'), name);
    assert(html.includes('id="devbar-live"') && html.includes('role="status"') && html.includes('aria-live="polite"'));
    assert(!html.includes('devbar-reset'), 'no Back button while not viewing');
    assert(!html.includes('id="devbar-team"'), 'no team select for a role without a team');
    assert(html.includes('href="#/dev/viewer/' + GID + '/guest"') && html.includes('Guest link (preview)'));
    assert(html.includes('href="#/dev/viewer/' + GID + '/public"') && html.includes('Public page (preview)'));
    assert(!/molten/.test(html), 'the orange is the primary button only');
  });

  await check('viewing a team-scoped role shows the team select and the Back button; the live region carries the notice', () => {
    const dev = { ...DEV, viewAs: { roleId: 'team_lead', roleName: 'Team Lead', teamId: TEAM, teamName: 'Alpha' } };
    const html = G.shell.devBarHtml(ctxOf(guildData(dev), { devNotice: 'Now viewing as Team Lead.' }));
    assert(html.includes('<option value="team_lead" selected>Team Lead</option>'));
    assert(html.includes('id="devbar-team"') && html.includes('<option value="' + TEAM + '" selected>Alpha</option>'));
    assert(html.includes('data-action="devbar-reset"') && html.includes('Back to Guild Master'));
    assert(html.includes('>Now viewing as Team Lead.</span>'));
    const member = G.shell.devBarHtml(ctxOf(guildData({ ...DEV, viewAs: { roleId: 'member', roleName: 'Member', teamId: null, teamName: null } })));
    assert(!member.includes('id="devbar-team"') && member.includes('devbar-reset'));
  });

  await check('names are escaped and the bar is not drawn on other sections or without a guild', () => {
    const hostile = { ...DEV, roles: [{ id: 'cr_AAAAAAAAAAAAAAAAAAAAAA', name: '<img src=x onerror=1>', teamScoped: false }] };
    assert(!G.shell.devBarHtml(ctxOf(guildData(hostile))).includes('<img src=x'));
    assert.equal(G.shell.devBarHtml(ctxOf(guildData(DEV), { section: 'planner' })), '');
    assert.equal(G.shell.devBarHtml(ctxOf(null)), '');
  });

  await check('the preview routes parse, format and count as read-only pages', () => {
    for (const role of ['guest', 'public']) {
      const hash = '#/dev/viewer/' + GID + '/' + role;
      assert.deepEqual(JSON.parse(JSON.stringify(G.router.parse(hash))), { name: 'devview', gid: GID, role });
      assert.equal(G.router.format({ name: 'devview', gid: GID, role }), hash);
    }
    assert.equal(G.router.parse('#/dev/viewer/' + GID + '/admin').name, 'notfound');
    assert.equal(G.router.parse('#/dev/viewer/bad%20id/guest').name, 'notfound');
    assert.equal(G.router.isViewerRoute({ name: 'devview' }), true);
  });

  await check('the API wrappers call the dev routes', async () => {
    const calls = [];
    const record = (method) => (url, body) => { calls.push([method, url, body]); return Promise.resolve({ ok: true }); };
    G.api.get = record('GET'); G.api.put = record('PUT'); G.api.del = record('DELETE');
    await G.api.dev.setViewAs(GID, 'team_lead', TEAM);
    await G.api.dev.setViewAs(GID, 'member');
    await G.api.dev.clearViewAs();
    await G.api.dev.viewerPreview(GID, 'public');
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
      ['PUT', '/api/dev/view-as', { gid: GID, roleId: 'team_lead', teamId: TEAM }],
      ['PUT', '/api/dev/view-as', { gid: GID, roleId: 'member' }],
      ['DELETE', '/api/dev/view-as', {}],
      ['GET', '/api/dev/guild/' + GID + '/viewer?role=public', null],
    ]);
  });

  await check('the preview page carries a Preview banner and no Leave action; a switched-off public page says so', () => {
    const base = { guild: { name: 'Ember', realm: 'Nightslayer', realmKind: 'realm', region: 'US', gameVersion: 'tbc', timeZone: 'America/New_York' }, sections: {} };
    const guest = G.pages.view.viewHtml({ data: { ...base, viewer: { kind: 'guest', preview: true, role: { id: 'guest', name: 'Guest' }, team: null, expiresAt: null } }, kind: 'guest', gid: GID });
    assert(guest.includes('Preview: this is what a guest link'), 'banner');
    assert(guest.includes('href="#/g/' + GID + '"') && guest.includes('Back to the guild'));
    assert(!guest.includes('view-leave') && !guest.includes('Leave this link') && !guest.includes('Link works until') && !guest.includes('does not expire'));
    const off = G.pages.view.viewHtml({ data: { ...base, publicEnabled: false, viewer: { kind: 'public', preview: true } }, kind: 'public', gid: GID });
    assert(off.includes('Preview: this is what the public page shows.') && off.includes('switched off'));
    const real = G.pages.view.viewHtml({ data: { ...base, viewer: { kind: 'guest', role: { id: 'guest', name: 'Guest' }, team: null, expiresAt: null } }, kind: 'guest' });
    assert(!real.includes('Preview:') && real.includes('view-leave'), 'the real guest page is unchanged');
  });

  await check('the stylesheet: the bar uses info tokens, 44 px phone targets and never the orange', () => {
    const css = read('guild.css');
    const rules = css.split('\n').filter(line => /gs-devbar|gs-preview-banner/.test(line)).join('\n');
    assert(rules.includes('--status-info-bg') && rules.includes('--control-h-phone'));
    assert(!/molten/.test(rules));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
