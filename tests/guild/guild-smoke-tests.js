/**
 * Raidsmith guild tracker - smoke harness tests
 * Run: node tests/guild/guild-smoke-tests.js
 *
 * tools/guild-smoke.js starts an isolated, seeded copy of the tracker for API and DOM checks. Starting Wrangler is not something a unit suite does, so
 * these checks pin the parts that keep it isolated and predictable: the argument parsing, the state dir and port rules (never 8787, never the live
 * database, only chk-<name> folders are ever deleted), the Worker variables (placeholders only, a fake that is off points at a refused port), and the
 * client helper `run` hands to a script.
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const smoke = require('../../tools/guild-smoke.js');
const dev = require('../../tools/guild-dev.js');

let passed = 0;
let failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

const usageError = (argv, pattern) => assert.throws(() => smoke.parseArgs(argv), (error) => error.usage === true && pattern.test(error.message), argv.join(' '));

check('up: a name alone gives the defaults (first free port later, discord + sources)', () => {
  assert.deepEqual(smoke.parseArgs(['up', '--name', 'proof']), { command: 'up', name: 'proof', port: null, fakes: ['discord', 'sources'], open: false, pinOpen: false, ownerOnRoster: false, script: null, scriptArgs: [] });
});

check('up: --port and --with, also in the --flag=value form; discord is always on and the order is fixed', () => {
  const options = smoke.parseArgs(['up', '--name=a-1', '--port=8793', '--with', 'bnet,sources']);
  assert.equal(options.port, 8793);
  assert.deepEqual(options.fakes, ['discord', 'sources', 'bnet']);
  assert.deepEqual(smoke.parseArgs(['up', '--name', 'x', '--with', 'discord']).fakes, ['discord']);
  assert.deepEqual(smoke.parseArgs(['up', '--with', 'bnet', '--name', 'x', '--port', '8790']).fakes, ['discord', 'bnet']);
});

check('up: --open means no creator allowlist and takes no value, only on up; the variable is still passed (a comma, nobody listed), so a local .env cannot fill it', () => {
  assert.equal(smoke.parseArgs(['up', '--name', 'x', '--open']).open, true);
  assert.equal(smoke.parseArgs(['up', '--open', '--name', 'x', '--port', '8792']).port, 8792);
  usageError(['up', '--name', 'x', '--open=1'], /--open takes no value/);
  usageError(['down', '--name', 'x', '--open'], /unknown option --open/);
  const value = (args) => Object.fromEntries(args.filter((_, index) => index % 2 === 1).map((arg) => [arg.slice(0, arg.indexOf(':')), arg.slice(arg.indexOf(':') + 1)])).GUILD_CREATOR_ALLOWLIST;
  assert.equal(value(smoke.workerVars(8792, ['discord'], '110000000000000001')), '110000000000000001');
  assert.equal(value(smoke.workerVars(8792, ['discord'], '110000000000000001', true)), ',');
});

check('up: --pin-open opens the setup pin for the seeded guild (SETUP_PIN_GUILDS '*': the guild id does not exist when the Worker starts), takes no value, only on up; without it the pin stays closed (a comma, nobody)', () => {
  const pin = (args) => Object.fromEntries(args.filter((_, index) => index % 2 === 1).map((arg) => [arg.slice(0, arg.indexOf(':')), arg.slice(arg.indexOf(':') + 1)])).SETUP_PIN_GUILDS;
  assert.equal(smoke.parseArgs(['up', '--name', 'x']).pinOpen, false);
  assert.equal(smoke.parseArgs(['up', '--name', 'x', '--pin-open']).pinOpen, true);
  assert.equal(smoke.parseArgs(['up', '--pin-open', '--name', 'x', '--open', '--port', '8792']).pinOpen, true, 'with the other flags');
  usageError(['up', '--name', 'x', '--pin-open=1'], /--pin-open takes no value/);
  usageError(['down', '--name', 'x', '--pin-open'], /unknown option --pin-open/);
  usageError(['run', '--name', 'x', '--pin-open', 'a.js'], /unknown option --pin-open/);
  assert.equal(pin(smoke.workerVars(8792, ['discord'], '1')), ',', 'closed by default');
  assert.equal(pin(smoke.workerVars(8792, ['discord'], '1', false, false)), ',');
  assert.equal(pin(smoke.workerVars(8792, ['discord'], '1', false, true)), '*');
  assert.equal(pin(smoke.workerVars(8792, ['discord'], '1', true, true)), '*', 'independent of --open');
  const header = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'tools', 'guild-smoke.js'), 'utf8').split('*/')[0];
  assert(header.includes('--pin-open') && header.includes('SETUP_PIN_GUILDS'), 'the header documents it');
});

check('up: the port must be 8790-8799, so 8787 (the live localhost) and anything else is refused', () => {
  for (const port of ['8787', '8789', '8800', '80', '-1', 'abc', '8790.5', '']) usageError(['up', '--name', 'x', '--port', port], /--port must be 8790-8799|needs a value/);
  for (const port of [8790, 8795, 8799]) assert.equal(smoke.parseArgs(['up', '--name', 'x', '--port', String(port)]).port, port);
});

check('--name: required, lower-case letters, digits and dashes only (it becomes a folder name)', () => {
  usageError(['up'], /--name is required/);
  usageError(['down'], /--name is required/);
  for (const name of ['', 'Proof', 'a b', '../x', 'a/b', 'a\\b', '-x', 'x'.repeat(25), 'é']) {
    assert.throws(() => smoke.parseArgs(['up', '--name', name]), (error) => error.usage === true, JSON.stringify(name));
  }
  usageError(['up', '--name'], /needs a value/);
  usageError(['up', '--name', '--port', '8790'], /needs a value/);
});

check('--with: only discord, sources, bnet; empty and unknown names are errors', () => {
  usageError(['up', '--name', 'x', '--with', 'redis'], /unknown fake "redis"/);
  usageError(['up', '--name', 'x', '--with', ''], /needs a value|at least one/);
  usageError(['up', '--name', 'x', '--with', 'discord,,wcl'], /unknown fake "wcl"/);
});

check('unknown commands and options, repeated options and stray arguments are errors', () => {
  usageError([], /unknown command/);
  usageError(['start', '--name', 'x'], /unknown command "start"/);
  usageError(['up', '--name', 'x', '--bogus', '1'], /unknown option --bogus/);
  usageError(['down', '--name', 'x', '--port', '8790'], /unknown option --port for down/);
  usageError(['down', '--name', 'x', '--with', 'bnet'], /unknown option --with for down/);
  usageError(['up', '--name', 'x', '--name', 'y'], /--name was given twice/);
  usageError(['up', '--name', 'x', 'extra'], /unexpected argument "extra"/);
  usageError(['down', '--name', 'x', 'script.js'], /unexpected argument/);
});

check('run: needs a script; everything after the script goes to it untouched', () => {
  usageError(['run', '--name', 'x'], /run needs a script/);
  const options = smoke.parseArgs(['run', '--name', 'x', 'check.js', '--name', 'inner', '--port', '1', 'file']);
  assert.equal(options.script, 'check.js');
  assert.deepEqual(options.scriptArgs, ['--name', 'inner', '--port', '1', 'file']);
  assert.equal(options.name, 'x');
  assert.equal(smoke.parseArgs(['run', '--name', 'x', 'a.js']).script, 'a.js');
  assert.equal(smoke.stateDirFor('wrangler-state').endsWith('chk-wrangler-state'), true, 'a name can never select the live wrangler-state folder');
});

check('state dir: <home>/.raidsmith-dev/chk-<name>, short, and never the live wrangler-state', () => {
  const home = path.join(os.tmpdir(), 'home');
  const dir = smoke.stateDirFor('proof', home);
  assert.equal(dir, path.join(home, '.raidsmith-dev', 'chk-proof'));
  assert.notEqual(path.basename(dir), 'wrangler-state');
  assert.notEqual(dir, dev.stateDir({}));
  assert(smoke.stateDirFor('x'.repeat(24), 'C:\\Users\\someone').length < 80, 'short enough for workerd');
  assert.equal(path.dirname(smoke.stateDirFor('proof')), path.dirname(dev.stateDir({})), 'same parent as the live state, different folder');
});

check('delete guard: only <home>/.raidsmith-dev/chk-<name> can be deleted', () => {
  const home = path.join(os.tmpdir(), 'home');
  const root = path.join(home, '.raidsmith-dev');
  assert.equal(smoke.isDeletableStateDir(path.join(root, 'chk-proof'), home), true);
  assert.equal(smoke.isDeletableStateDir(smoke.stateDirFor('a-b-9', home), home), true);
  for (const bad of [path.join(root, 'wrangler-state'), root, home, path.join(root, 'chk-'), path.join(root, 'chk-Proof'), path.join(root, 'chk-proof', 'logs'),
    path.join(root, '..', 'chk-proof'), path.join(root, 'chk-proof', '..', 'wrangler-state'), path.join(os.tmpdir(), 'chk-proof'), path.parse(home).root, '']) {
    assert.equal(smoke.isDeletableStateDir(bad, home), false, bad);
  }
  assert.equal(smoke.isDeletableStateDir(dev.stateDir({}), os.homedir()), false, 'the live dev database');
});

check('ports: each fake sits at a fixed offset from the Worker port, none is 8787, and ranges of different Worker ports never overlap', () => {
  assert.equal(smoke.fakePort('discord', 8793), 18793);
  assert.equal(smoke.fakePort('sources', 8793), 19793);
  assert.equal(smoke.fakePort('bnet', 8793), 20793);
  const all = [];
  for (let port = smoke.PORT_MIN; port <= smoke.PORT_MAX; port++) for (const fake of smoke.FAKES) all.push(smoke.fakePort(fake, port));
  assert.equal(new Set(all).size, all.length, 'no two runs share a fake port');
  assert(!all.includes(8787) && all.every((port) => port > 8799 && port < 65536));
  assert.equal(smoke.fakeUrl('discord', 8790), 'http://127.0.0.1:18790');
});

check('Worker variables: placeholders only, loopback only, the redirect URIs follow the port, the allowlist is the Guild Master', () => {
  const args = smoke.workerVars(8793, ['discord', 'sources'], '110000000000000001');
  assert(args.every((arg, index) => (index % 2 === 0 ? arg === '--var' : /^[A-Z_]+:\S+$/.test(arg))));
  const vars = Object.fromEntries(args.filter((_, index) => index % 2 === 1).map((arg) => [arg.slice(0, arg.indexOf(':')), arg.slice(arg.indexOf(':') + 1)]));
  assert.equal(vars.DISCORD_API_BASE, 'http://127.0.0.1:18793');
  assert.equal(vars.WCL_API_BASE, 'http://127.0.0.1:19793');
  assert.equal(vars.RAID_HELPER_API_BASE, 'http://127.0.0.1:19793');
  assert.equal(vars.BNET_API_BASE, 'http://127.0.0.1:9', 'a fake that is off points at a refused port, never a real service');
  assert.equal(vars.DISCORD_REDIRECT_URI, 'http://127.0.0.1:8793/auth/callback');
  assert.equal(vars.BNET_REDIRECT_URI, 'http://127.0.0.1:8793/auth/bnet/callback');
  assert.equal(vars.GUILD_CREATOR_ALLOWLIST, '110000000000000001');
  for (const [key, value] of Object.entries(vars)) {
    if (/_API_BASE$|_REDIRECT_URI$/.test(key)) assert(value.startsWith('http://127.0.0.1:'), `${key} stays on loopback`);
    else if (!['GUILD_CREATOR_ALLOWLIST', 'DEV_VIEW_AS', 'TOMBSTONE_KEY_VERSION', 'TOMBSTONE_OLD_KEYS', 'SETUP_PIN_GUILDS'].includes(key)) assert(/^(smoke-|fake-)/.test(value), `${key} is a placeholder`);
  }
  assert(!args.join(' ').includes(':8787'), 'never the live port');
  assert.equal(smoke.workerVars(8793, ['discord', 'sources', 'bnet'], '1').includes('BNET_API_BASE:http://127.0.0.1:20793'), true);
});

check('Worker variables cover every name the Worker reads from env, so a local .env can never fill one in', () => {
  const fs = require('node:fs');
  const names = new Set();
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (full.endsWith('.js')) for (const m of fs.readFileSync(full, 'utf8').matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]); } };
  walk(path.join(__dirname, '..', '..', 'worker'));
  names.delete('DB'); names.delete('ASSETS');
  const given = new Set(smoke.workerVars(8790, ['discord'], '1').filter((_, index) => index % 2 === 1).map((arg) => arg.slice(0, arg.indexOf(':'))));
  assert.deepEqual([...names].filter((name) => !given.has(name)).sort(), [], 'add these to workerVars in tools/guild-smoke.js');
});

check('fromEnv / fromJson: api(who, ...) sends that person\'s cookie and the Origin header; an unknown person is an error; no JSON in the environment is an error', async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, cookie: request.headers.cookie, origin: request.headers.origin, body });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const data = { base, cookies: { gm: '__Host-rs_session=aaa', member: '__Host-rs_session=bbb' }, ids: { guildId: 'g_1' } };
    const client = smoke.fromEnv({ GUILD_SMOKE_JSON: JSON.stringify(data) });
    assert.equal(client.ids.guildId, 'g_1');
    const res = await client.api('member', 'POST', '/api/x', { a: 1 });
    assert.deepEqual([res.status, res.json], [200, { ok: true }]);
    assert.deepEqual(seen[0], { method: 'POST', url: '/api/x', cookie: '__Host-rs_session=bbb', origin: base, body: '{"a":1}' });
    await client.api('gm', 'GET', '/auth/me');
    assert.equal(seen[1].cookie, '__Host-rs_session=aaa');
    assert.equal(seen[1].body, '');
    await assert.rejects(() => client.api('nobody', 'GET', '/x'), /no cookie for "nobody"/);
  } finally {
    server.close();
  }
  assert.throws(() => smoke.fromEnv({}), /GUILD_SMOKE_JSON is not set/);
});

check('up: --owner-on-roster makes the Owner a character on the roster; it takes no value, only on up, brings the Battle.net fake along (fixed order) and is documented in the header', () => {
  assert.equal(smoke.parseArgs(['up', '--name', 'x']).ownerOnRoster, false);
  const on = smoke.parseArgs(['up', '--name', 'x', '--owner-on-roster']);
  assert.equal(on.ownerOnRoster, true);
  assert.deepEqual(on.fakes, ['discord', 'sources', 'bnet'], 'implies bnet; the default fakes stay');
  assert.deepEqual(smoke.parseArgs(['up', '--name', 'x', '--with', 'discord', '--owner-on-roster']).fakes, ['discord', 'bnet']);
  assert.deepEqual(smoke.parseArgs(['up', '--owner-on-roster', '--name', 'x', '--with', 'discord,sources,bnet', '--pin-open', '--port', '8799']).fakes, ['discord', 'sources', 'bnet'], 'with the other flags, nothing doubled');
  assert.equal(smoke.parseArgs(['up', '--owner-on-roster', '--name', 'x', '--pin-open', '--open']).pinOpen, true);
  usageError(['up', '--name', 'x', '--owner-on-roster=1'], /--owner-on-roster takes no value/);
  usageError(['down', '--name', 'x', '--owner-on-roster'], /unknown option --owner-on-roster/);
  usageError(['run', '--name', 'x', '--owner-on-roster', 'a.js'], /unknown option --owner-on-roster/);
  usageError(['up', '--name', 'x', '--owner-on-roster', '--owner-on-roster'], /--owner-on-roster was given twice/);
  const header = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'tools', 'guild-smoke.js'), 'utf8').split('*/')[0];
  assert(header.includes('--owner-on-roster') && /founding/i.test(header) && header.includes('8000') && header.includes('--with bnet'), 'the header documents it and says why it works');
  assert(/\[--owner-on-roster\]/.test(header.slice(0, header.indexOf('up    migrates'))), 'the usage lines name it');
});

// One JSON call with a throw-away connection (agent: false): fetch's keep-alive pool left a handle that made Node on Windows abort ("UV_HANDLE_CLOSING") when the suite exited.
function callJson(base, route, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(route, base), { method, headers: { ...headers, Connection: 'close' }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The fake Battle.net over HTTP: the account's profile characters and the generated roster's members, for the checks below.
async function fakeBnetAnswers(options) {
  const { createFakeBattlenet } = require('../../tools/fake-battlenet.js');
  const fake = createFakeBattlenet(options);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  try {
    const basic = { Authorization: `Basic ${Buffer.from('id:secret').toString('base64')}` };
    const token = await callJson(base, '/token', {
      method: 'POST', headers: { ...basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'http://127.0.0.1/cb' }).toString(),
    });
    const bearer = { Authorization: `Bearer ${token.access_token}` };
    const profile = await callJson(base, '/profile/user/wow?namespace=profile-classicann-us', { headers: bearer });
    const roster = await callJson(base, '/data/wow/guild/dreamscythe/smoke-guard/roster?namespace=profile-classicann-us', { headers: bearer });
    return { profile: profile.wow_accounts[0].characters, roster: roster.members };
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }
}

check('fake Battle.net --owner-on-roster: the account\'s profile holds Thornwick with the roster\'s own id, class, level and realm; the stock fake has no such character (its ids never match)', async () => {
  const stock = await fakeBnetAnswers();
  assert(!stock.profile.some((entry) => entry.name === 'Thornwick'), 'the stock profile has no Thornwick');
  const stockIds = new Set(stock.profile.map((entry) => entry.id));
  assert(stock.roster.every((member) => !stockIds.has(member.character.id)), 'no stock profile id is a roster id: that is why the option exists');
  const on = await fakeBnetAnswers({ ownerOnRoster: true });
  const mine = on.profile.filter((entry) => entry.name === 'Thornwick');
  assert.equal(mine.length, 1);
  const row = on.roster.find((member) => member.character.name === 'Thornwick');
  assert(row, 'the roster has him');
  assert.equal(mine[0].id, row.character.id, 'the same id');
  assert.equal(mine[0].id, 8000);
  assert.equal(mine[0].realm.id, row.character.realm.id, 'the same realm');
  assert.equal(mine[0].realm.slug, row.character.realm.slug);
  assert.equal(mine[0].playable_class.id, row.character.playable_class.id, 'the same class');
  assert.equal(mine[0].level, row.character.level);
  assert.equal(row.rank, 0, 'the guild master of the generated roster');
  // Everything else of the stock answer is unchanged.
  assert.deepEqual(on.profile.filter((entry) => entry.name !== 'Thornwick').map((entry) => [entry.name, entry.id]), stock.profile.map((entry) => [entry.name, entry.id]));
  assert.deepEqual(on.roster, stock.roster);
});

check('tools/fake-battlenet.js: the --owner-on-roster flag and its environment fallback are documented and read', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'tools', 'fake-battlenet.js'), 'utf8');
  const header = source.split('*/')[0];
  assert(header.includes('--owner-on-roster') && header.includes('8000'));
  assert(/args\['owner-on-roster'\] === 'true'/.test(source) && source.includes('FAKE_BATTLENET_OWNER_ON_ROSTER'));
});

(async () => {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
