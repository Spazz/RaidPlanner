/**
 * Raidsmith guild tracker - dev "View as" role switcher, Worker tests
 * Run: node guild-viewas-worker-tests.js [name-filter]
 *
 * The Guild Master of a LOCAL run (DEV_VIEW_AS=1, host 127.0.0.1) can see every page with the rights of Officer, Team Lead, Member or one of the guild's
 * own roles. Covers the three gates (flag, host, real Guild Master), the cookie, the rights of each stand-in (also what a viewed Officer must NOT keep:
 * the Guild Master's own powers), a stale role, the guild payload's `dev` block, the guest / public preview against the real views, and two pins:
 * every loadGuildContext call for the signed-in user passes session.viewAs, and wrangler.jsonc never sets DEV_VIEW_AS.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { adminOf, memberOf, makeWorld, signIn, person } = require('./tests/guild-world');

const S1 = '900000000000000001';
const LOCAL = 'http://127.0.0.1:8790';
const ALICE = person(1, 'Alice');
const BOB = person(2, 'Bob');
const COOKIE = '__Host-rs_viewas';
const ROOT = __dirname;

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// A guild with two teams, a Guild Master (alice) and a plain member (bob); dev = whether DEV_VIEW_AS is on.
async function scenario({ dev = true } = {}) {
  const w = await makeWorld({ allowlist: [ALICE.id], env: dev ? { DEV_VIEW_AS: '1' } : {} });
  const alice = (await signIn(w, ALICE, [adminOf(S1)])).jar;
  const made = await w.call(alice, 'POST', '/api/guild', { serverId: S1, gameVersion: 'tbc', region: 'US', realm: 'Nightslayer', name: 'Ember', timeZone: 'America/New_York', multipleTeams: true, teamNames: ['Alpha', 'Bravo'] });
  assert.equal(made.status, 201, made.text);
  const bob = (await signIn(w, BOB, [memberOf(S1)])).jar;
  const s = { w, alice, bob, gid: made.json.guild.id, teamA: made.json.teams[0].id, teamB: made.json.teams[1].id };
  s.path = `/api/guild/${s.gid}`;
  // Calls on the LOCAL host (the dev gate), as alice with an optional hand-set view-as cookie.
  s.local = (method, urlPath, body, jar = alice) => w.call(jar, method, urlPath, body, { origin: LOCAL });
  s.viewAs = (body) => s.local('PUT', '/api/dev/view-as', { gid: s.gid, ...body });
  s.guild = (jar = alice) => s.local('GET', s.path, undefined, jar);
  s.makeRole = async (name, permissions) => {
    const res = await w.call(alice, 'POST', `${s.path}/roles`, { name, permissions });
    assert.equal(res.status, 201, res.text);
    return res.json.roles.find((role) => role.name === name).id;
  };
  return s;
}

// A copy of alice's jar with a hand-set view-as cookie (the cookie a PUT would have set).
const withCookie = (s, value) => ({ ...s.alice, [COOKIE]: value });

check('the flag is off: every dev route is a plain 404, the cookie is ignored and the payload has no dev block', async () => {
  const s = await scenario({ dev: false });
  assert.equal((await s.viewAs({ roleId: 'member' })).status, 404);
  assert.equal((await s.local('DELETE', '/api/dev/view-as', {})).status, 404);
  assert.equal((await s.local('GET', `/api/dev/guild/${s.gid}/viewer?role=guest`)).status, 404);
  const unknown = await s.local('GET', '/api/dev/nothing');
  const closed = await s.viewAs({ roleId: 'member' });
  assert.deepEqual(closed.json, unknown.json, 'the same shape as an unknown route');
  const jar = withCookie(s, `${s.gid}:member`);
  const res = await s.guild(jar);
  assert.equal(res.status, 200);
  assert.ok(res.json.me.can['raids.edit'], 'the hand-set cookie did nothing: still the Guild Master');
  assert.equal(res.json.dev, undefined);
});

check('a non-local host is ignored even with the flag on', async () => {
  const s = await scenario();
  const remote = (method, urlPath, body, jar = s.alice) => s.w.call(jar, method, urlPath, body);
  assert.equal((await remote('PUT', '/api/dev/view-as', { gid: s.gid, roleId: 'member' })).status, 404);
  const res = await remote('GET', s.path, undefined, withCookie(s, `${s.gid}:member`));
  assert.ok(res.json.me.can['raids.edit'], 'cookie ignored on raidsmith.test');
  assert.equal(res.json.dev, undefined);
  assert.equal((await s.w.call(s.alice, 'GET', s.path, undefined, { origin: 'http://localhost:8790' })).json.dev !== undefined, true, 'localhost counts as local');
});

check('only the real Guild Master may use it: a member gets 403, no dev block, and a hand-set cookie changes nothing', async () => {
  const s = await scenario();
  const put = await s.local('PUT', '/api/dev/view-as', { gid: s.gid, roleId: 'officer' }, s.bob);
  assert.equal(put.status, 403);
  assert.equal((await s.local('GET', `/api/dev/guild/${s.gid}/viewer?role=public`, undefined, s.bob)).status, 403);
  const jar = { ...s.bob, [COOKIE]: `${s.gid}:officer` };
  const res = await s.guild(jar);
  assert.equal(res.json.dev, undefined);
  assert.equal(res.json.me.can['guild.roles'], undefined, 'still a plain member');
  assert.equal((await s.local('GET', `${s.path}/attention`, undefined, jar)).status, 403, 'no officer rights from a forged cookie');
});

check('PUT validates: Guild Master / unknown roles, a Team Lead needs a team of this guild, bad ids carry a field', async () => {
  const s = await scenario();
  const bad = async (body, field) => {
    const res = await s.viewAs(body);
    assert.equal(res.status, 400, JSON.stringify(body) + res.text);
    assert.equal(res.json.field, field);
  };
  await bad({ roleId: 'guild_master' }, 'roleId');
  await bad({ roleId: 'nonsense' }, 'roleId');
  await bad({ roleId: 'cr_AAAAAAAAAAAAAAAAAAAAAA' }, 'roleId');
  await bad({ roleId: 'team_lead' }, 'teamId');
  await bad({ roleId: 'team_lead', teamId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, 'teamId');
  await bad({ roleId: 'officer', teamId: s.teamA }, 'teamId');
  assert.equal((await s.local('PUT', '/api/dev/view-as', { gid: 'nope', roleId: 'member' })).json.field, 'gid');
  const archived = await s.w.call(s.alice, 'PATCH', `${s.path}/teams/${s.teamB}`, { archived: true });
  assert.equal(archived.status, 200, archived.text);
  await bad({ roleId: 'team_lead', teamId: s.teamB }, 'teamId');
  const ok = await s.viewAs({ roleId: 'team_lead', teamId: s.teamA });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('Set-Cookie'), new RegExp(`^${COOKIE}=${s.gid}:team_lead:${s.teamA}; .*Path=/; HttpOnly.*SameSite=Lax`));
});

check('GM as Member: no attention, no raids.edit; DELETE gives the Guild Master back', async () => {
  const s = await scenario();
  assert.equal((await s.local('GET', `${s.path}/attention`)).status, 200);
  const put = await s.viewAs({ roleId: 'member' });
  assert.equal(put.status, 200, put.text);
  const jar = { ...s.alice };
  const cookie = put.headers.get('Set-Cookie').split(';')[0];
  const [name, value] = [cookie.slice(0, cookie.indexOf('=')), cookie.slice(cookie.indexOf('=') + 1)];
  jar[name] = value;
  const viewed = await s.guild(jar);
  assert.equal(viewed.json.me.can['raids.edit'], undefined);
  assert.equal(viewed.json.me.can['guild.roles'], undefined);
  assert.ok(viewed.json.me.can['roster.view'], 'a member still reads the roster');
  assert.deepEqual(viewed.json.dev.viewAs, { roleId: 'member', roleName: 'Member', teamId: null, teamName: null });
  assert.equal((await s.local('GET', `${s.path}/attention`, undefined, jar)).status, 403);
  const cleared = await s.local('DELETE', '/api/dev/view-as', {}, jar);
  assert.equal(cleared.status, 200);
  assert.match(cleared.headers.get('Set-Cookie'), /Max-Age=0/);
  delete jar[name];
  const back = await s.guild(jar);
  assert.ok(back.json.me.can['raids.edit']);
  assert.equal(back.json.dev.viewAs, null);
});

check('GM as Officer: officer rights, but none of the Guild Master\'s own powers (isGuildMaster follows the stand-in)', async () => {
  const s = await scenario();
  const jar = withCookie(s, `${s.gid}:officer`);
  const res = await s.guild(jar);
  assert.ok(res.json.me.can['guild.access'], 'an Officer holds guild.access');
  assert.equal(res.json.me.can['guild.roles'], undefined, "guild.roles is the Guild Master's unless a guild gives it to Officer");
  assert.equal(res.json.guild.discordServerId, undefined, 'the Discord server id is the Guild Master\'s');
  assert.equal(res.json.dev.viewAs.roleName, 'Officer');
  assert.equal((await s.local('PATCH', s.path, { name: 'Renamed' }, jar)).status, 403, 'only the real Guild Master renames the guild');
  assert.equal((await s.local('GET', s.path, undefined, jar)).json.guild.name, 'Ember');
  assert.equal((await s.local('GET', `${s.path}/roles`, undefined, jar)).status, 403);
  assert.equal((await s.local('GET', `${s.path}/roles`)).status, 200, 'unviewed: the Guild Master reads the roles');
  assert.equal((await s.local('PUT', `${s.path}/roles/officer`, { permissions: {} }, jar)).status, 403, "built-in roles are the Guild Master's");
  const handOver = await s.local('POST', `${s.path}/people/${(await s.w.call(s.bob, 'GET', '/auth/me')).json.user.id}/guild-master`, {}, jar);
  assert.equal(handOver.status, 403);
  assert.equal((await s.local('DELETE', s.path, {}, jar)).status, 403);
});

check('GM as Team Lead: rights reach only that team', async () => {
  const s = await scenario();
  const jar = withCookie(s, `${s.gid}:team_lead:${s.teamA}`);
  const res = await s.guild(jar);
  assert.deepEqual(res.json.me.can['raids.edit'], [s.teamA]);
  assert.equal(res.json.dev.viewAs.teamName, 'Alpha');
  assert.equal(res.json.me.can['guild.roles'], undefined);
  assert.equal((await s.local('GET', `${s.path}/attention`, undefined, jar)).status, 200, 'a Team Lead sees attention');
});

check('GM as a custom role (with and without a team); a viewed role with no rights has none', async () => {
  const s = await scenario();
  const loot = await s.makeRole('Loot council', { 'loot.edit': 'guild' });
  const raider = await s.makeRole('Team scribe', { 'roster.edit': 'team' });
  const nothing = await s.makeRole('Observer', {});
  const guildWide = await s.guild(withCookie(s, `${s.gid}:${loot}`));
  assert.equal(guildWide.json.me.can['loot.edit'], 'guild');
  assert.equal(guildWide.json.me.can['raids.edit'], undefined);
  assert.equal(guildWide.json.dev.viewAs.roleName, 'Loot council');
  const scoped = await s.guild(withCookie(s, `${s.gid}:${raider}:${s.teamB}`));
  assert.deepEqual(scoped.json.me.can['roster.edit'], [s.teamB]);
  assert.equal(scoped.json.dev.viewAs.teamName, 'Bravo');
  const none = await s.guild(withCookie(s, `${s.gid}:${nothing}`));
  assert.equal(none.json.me.can['loot.edit'], undefined);
  assert.equal(none.json.me.can['roster.edit'], undefined);
  assert.equal((await s.viewAs({ roleId: raider, teamId: s.teamA })).status, 200);
  assert.equal((await s.viewAs({ roleId: loot, teamId: s.teamA })).status, 200, 'a custom role may take an optional team');
});

check('a stale or foreign cookie falls back to the real rights, with no error', async () => {
  const s = await scenario();
  const loot = await s.makeRole('Soon gone', { 'loot.edit': 'guild' });
  const stale = withCookie(s, `${s.gid}:${loot}`);
  assert.equal((await s.guild(stale)).json.dev.viewAs.roleName, 'Soon gone');
  const gone = await s.w.call(s.alice, 'DELETE', `${s.path}/roles/${loot}`, {});
  assert.equal(gone.status, 200, gone.text);
  for (const value of [`${s.gid}:${loot}`, `${s.gid}:team_lead:${s.teamB}x`, `${s.gid}:team_lead`, 'garbage', `g_BBBBBBBBBBBBBBBBBBBBBB:member`, `${s.gid}:guild_master`, `${s.gid}:officer:${s.teamA}:x`]) {
    const res = await s.guild(withCookie(s, value));
    assert.equal(res.status, 200, value);
    assert.ok(res.json.me.can['raids.edit'], `real rights for ${value}`);
    assert.equal(res.json.dev.viewAs, null, value);
  }
  await s.w.call(s.alice, 'PATCH', `${s.path}/teams/${s.teamB}`, { archived: true });
  const archived = await s.guild(withCookie(s, `${s.gid}:team_lead:${s.teamB}`));
  assert.equal(archived.json.dev.viewAs, null, 'an archived team is stale too');
});

check('the guild payload: dev block lists the roles and teams from the REAL context, even while viewing as a Member', async () => {
  const s = await scenario();
  const loot = await s.makeRole('Loot council', { 'loot.edit': 'guild' });
  const scoped = await s.makeRole('Team scribe', { 'roster.edit': 'team' });
  const res = await s.guild(withCookie(s, `${s.gid}:member`));
  assert.deepEqual(res.json.dev.roles.map((role) => [role.id, role.name, role.teamScoped]), [
    ['officer', 'Officer', false], ['team_lead', 'Team Lead', true], ['member', 'Member', false], [loot, 'Loot council', false], [scoped, 'Team scribe', true],
  ]);
  assert.deepEqual(res.json.dev.teams.map((team) => team.name), ['Alpha', 'Bravo']);
  assert.equal((await s.guild(s.bob)).json.dev, undefined);
});

check('guest and public previews equal the real views for the same permissions, and say so', async () => {
  const s = await scenario();
  // The real guest view: a guest link for the whole guild.
  const link = await s.w.call(s.alice, 'POST', `${s.path}/guest-links`, { roleId: 'guest', expiresIn: '7d' });
  assert.equal(link.status, 201, link.text);
  const token = link.json.created.token;
  const guestJar = {};
  assert.equal((await s.w.call(guestJar, 'POST', '/auth/guest', { token })).status, 200);
  const realGuest = await s.w.call(guestJar, 'GET', '/api/guest');
  const guestPreview = await s.local('GET', `/api/dev/guild/${s.gid}/viewer?role=guest`);
  assert.equal(guestPreview.status, 200, guestPreview.text);
  assert.equal(guestPreview.json.viewer.preview, true);
  assert.equal(guestPreview.json.viewer.kind, 'guest');
  const { viewer: realViewer, ...realRest } = realGuest.json;
  const { viewer: previewViewer, ...previewRest } = guestPreview.json;
  assert.deepEqual(previewRest, realRest, 'the same sections as the real guest view');
  assert.equal(realViewer.kind, previewViewer.kind);

  // The public page: off, then on. The preview works while it is off and says so.
  const off = await s.local('GET', `/api/dev/guild/${s.gid}/viewer?role=public`);
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.publicEnabled, false);
  assert.equal(off.json.viewer.preview, true);
  assert.equal((await s.w.call({}, 'GET', `/api/public/${s.gid}`)).status, 404, 'the real page is off');
  const turnedOn = await s.w.call(s.alice, 'PUT', `${s.path}/public`, { enabled: true, sections: ['roster', 'raids'] });
  assert.equal(turnedOn.status, 200, turnedOn.text);
  const realPublic = await s.w.call({}, 'GET', `/api/public/${s.gid}`);
  const onPreview = await s.local('GET', `/api/dev/guild/${s.gid}/viewer?role=public`);
  assert.equal(onPreview.json.publicEnabled, true);
  const { viewer: v1, ...realPublicRest } = realPublic.json;
  const { viewer: v2, publicEnabled, ...previewPublicRest } = onPreview.json;
  assert.deepEqual(previewPublicRest, realPublicRest);
  assert.equal(v1.kind, v2.kind);
  assert.equal((await s.local('GET', `/api/dev/guild/${s.gid}/viewer?role=nobody`)).json.field, 'role');
});

check('writes while viewing as are limited by the stand-in rights, and the audit keeps the real user', async () => {
  const s = await scenario();
  const jar = withCookie(s, `${s.gid}:member`);
  const denied = await s.local('POST', `${s.path}/teams`, { name: 'Charlie' }, jar);
  assert.equal(denied.status, 403);
  const officer = withCookie(s, `${s.gid}:officer`);
  const allowed = await s.local('POST', `${s.path}/teams`, { name: 'Charlie' }, officer);
  assert.equal(allowed.status, 201, allowed.text);
  const aliceId = (await s.w.call(s.alice, 'GET', '/auth/me')).json.user.id;
  const rows = await s.w.rows("SELECT actor_user_id FROM audit_log WHERE guild_id = ? AND action = 'team.create' ORDER BY rowid DESC LIMIT 1", s.gid);
  assert.equal(rows[0].actor_user_id, aliceId);
});

check('pin: every loadGuildContext call made for the signed-in user passes session.viewAs; system lookups do not', () => {
  const dir = path.join(ROOT, 'worker', 'routes');
  const missing = [];
  let seen = 0;
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.js'))) {
    // The dev routes themselves ask for the REAL rights on purpose (a stand-in must never decide who may switch).
    if (file === 'dev-view-as.js') continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of text.matchAll(/loadGuildContext\(([^)]*)\)/g)) {
      const args = match[1];
      if (!/session\.user\.id/.test(args)) continue;
      seen++;
      if (!/session\.viewAs\s*$/.test(args.trim())) missing.push(`${file}: loadGuildContext(${args})`);
    }
  }
  assert.ok(seen >= 141, `scanned only ${seen} calls`);
  assert.deepEqual(missing, [], 'a signed-in call without the 4th argument would ignore the view-as');
});

check('pin: wrangler.jsonc never sets DEV_VIEW_AS (the flag is local-only, set per run)', () => {
  const text = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  assert.ok(!/DEV_VIEW_AS/.test(text), 'DEV_VIEW_AS in wrangler.jsonc would turn the switcher on in production');
  assert.ok(/DEV_VIEW_AS=/.test(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')), '.env.example names the variable');
});

(async () => {
  const filter = process.argv[2] || '';
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of checks) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(error && error.stack || error).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
