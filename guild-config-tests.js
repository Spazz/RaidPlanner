/**
 * Raidsmith guild tracker - configuration tests
 * Run: node guild-config-tests.js
 *
 * Pins the files that decide what is served and what is kept out: .assetsignore (secrets and Worker
 * source never reach the static-asset bucket), _headers (same CSP as vercel.json plus the Discord CDN),
 * wrangler.jsonc, .env.example (names only), the .gitignore whitelist, .vercelignore, the pinned
 * Wrangler version, and the rules the Worker's source files follow.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const lines = (rel) => read(rel).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));

let passed = 0;
let failed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// The gitignore subset .assetsignore uses: a leading "/" anchors to the root, a trailing "/" is a
// directory, "*" matches within one path segment.
function toRegex(pattern) {
  assert(!pattern.startsWith('!'), `unsupported negation: ${pattern}`);
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  const dir = pattern.endsWith('/');
  const body = pattern.replace(/^\//, '').replace(/\/$/, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${dir ? '/.*' : '(?:/.*)?'}$`);
}

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, found);
    else found.push(rel);
  }
  return found;
}

check('.assetsignore hides secrets, Worker source and dev files, but not anything the site serves', () => {
  const patterns = lines('.assetsignore');
  assert(patterns.length > 10);
  const matchers = patterns.map(toRegex);
  const ignored = (file) => matchers.some((re) => re.test(file));

  for (const required of ['/.env*', '/.dev.vars*', '/.wrangler/', '/node_modules/', '/worker/', '/migrations/', '/wrangler.jsonc',
    '/package.json', '/api/', '/tests/', '/tools/', '/.github/', '/*-tests.js', '/tests.js', '/*-scenarios.js', '/*.md',
    '/gruul_dps_data.txt', '/.git*', '/.vercelignore', '/vercel.json']) {
    assert(patterns.includes(required), `.assetsignore must list ${required}`);
  }
  for (const secret of ['.env', '.env.local', '.env.production', '.dev.vars', '.dev.vars.staging', '.wrangler/tmp/x.js',
    '.wrangler/state/v3/d1/db.sqlite', 'node_modules/wrangler/package.json', 'worker/index.js', 'worker/routes/auth.js',
    'migrations/0001_foundation.sql', 'wrangler.jsonc', 'package.json', 'api/share.js', 'tests/run-all.js', 'tools/guild-dev.js',
    'share-tests.js', 'guild-worker-tests.js', 'tests.js', 'classic-forever-scenarios.js', 'README.md', 'gruul_dps_data.txt',
    '.git/config', '.gitignore', '.github/workflows/test.yml', '.vercelignore', 'vercel.json']) {
    assert(ignored(secret), `${secret} must not be served`);
  }
  const served = ['index.html', 'faq.html', 'whats-new.html', 'buff-priorities.html', 'app.css', 'scenarios.js', 'og-image.png',
    'guild.html', 'guild.css', 'js/app.js', 'js/rules/tbc.js', 'js/guild/api.js', 'icons/warrior.jpg'];
  for (const file of served) assert(!ignored(file), `${file} must be served`);
  for (const file of fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js'))) assert(!ignored(`js/${file}`), `js/${file}`);
  for (const rule of patterns) assert(!rule.includes('scenarios.js') || rule === '/*-scenarios.js', 'scenarios.js stays served');
});

check('_headers carries the vercel.json CSP plus the Discord CDN for avatars, nosniff and Referrer-Policy', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const expected = Object.fromEntries(vercel.headers[0].headers.map((header) => [header.key, header.value]));
  const text = read('_headers');
  const block = text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));
  assert.equal(block[0], '/*');
  const actual = Object.fromEntries(block.slice(1).map((line) => {
    const index = line.indexOf(':');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
  assert.equal(
    actual['Content-Security-Policy'],
    expected['Content-Security-Policy'].replace("img-src 'self' data:", "img-src 'self' data: https://cdn.discordapp.com"),
  );
  assert(actual['Content-Security-Policy'].includes("connect-src 'self' https://raid-helper.dev https://raid-helper.xyz"));
  assert.equal(actual['X-Content-Type-Options'], 'nosniff');
  assert.equal(actual['Referrer-Policy'], expected['Referrer-Policy']);
  assert.deepEqual(Object.keys(actual).sort(), ['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options']);
  assert(!/https:\/\/cdn\.discordapp\.com/.test(expected['Content-Security-Policy']), 'the planner CSP itself is unchanged');
});

check('wrangler.jsonc: Worker entry, assets, run_worker_first, D1 binding, and no DISCORD_API_BASE or vars', () => {
  const raw = read('wrangler.jsonc');
  assert(!/DISCORD_API_BASE/.test(raw), 'DISCORD_API_BASE is a dev-only --var, never config');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.main, 'worker/index.js');
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(config.assets, {
    directory: '.', binding: 'ASSETS', run_worker_first: ['/api/guild', '/api/guild/*', '/auth/*'],
  });
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'raidsmith', database_id: 'local-raidsmith', migrations_dir: 'migrations' }]);
  assert.equal(config.vars, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, 'worker', 'index.js')), true);
  assert.deepEqual(JSON.parse(read('worker/package.json')), { type: 'module' });
});

check('.env.example lists names only and covers every secret the Worker reads', () => {
  const entries = lines('.env.example');
  assert(entries.length >= 5);
  for (const entry of entries) assert.match(entry, /^[A-Z][A-Z0-9_]*=$/, `names only: ${entry}`);
  const names = entries.map((entry) => entry.slice(0, -1));
  for (const name of ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI', 'GUILD_CREATOR_ALLOWLIST', 'WCL_CLIENT_ID', 'WCL_CLIENT_SECRET']) {
    assert(names.includes(name), name);
  }
  assert(!names.includes('DISCORD_API_BASE'));
  const used = new Set();
  for (const file of walk('worker')) {
    for (const match of read(file).matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) used.add(match[1]);
  }
  for (const name of used) assert(names.includes(name) || name === 'DISCORD_API_BASE' || name === 'DB', `${name} is read by the Worker`);
});

check('every guild-tracker file is whitelisted in .gitignore (so it can be committed)', () => {
  const git = spawnSync('git', ['--version'], { cwd: ROOT });
  if (git.status !== 0) return; // no git on this machine: the whitelist cannot be probed
  const files = new Set([
    'wrangler.jsonc', '.assetsignore', '_headers', '.env.example', 'guild.html', 'guild.css', 'js/guild/api.js', 'js/guild/shell.js',
    'guild-ui-tests.js', 'guild-worker-tests.js', 'guild-config-tests.js', 'tests/d1-fake.js', 'tools/guild-dev.js', 'tools/fake-discord.js',
    'migrations/0001_foundation.sql', 'worker/package.json',
    ...walk('worker'), ...walk('migrations'),
  ]);
  const ignored = [...files].filter((file) => spawnSync('git', ['check-ignore', '-q', '--no-index', '--', file], { cwd: ROOT }).status === 0);
  assert.deepEqual(ignored, [], 'add a ! line for these to .gitignore');
  for (const secret of ['.env', '.dev.vars', '.wrangler/state/x', 'node_modules/x/index.js']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', '--no-index', '--', secret], { cwd: ROOT }).status, 0, `${secret} stays ignored`);
  }
});

check('.vercelignore keeps the Worker files off Vercel and uses no negation', () => {
  const entries = lines('.vercelignore');
  for (const required of ['/worker/', '/migrations/', '/wrangler.jsonc', '/_headers', '/.assetsignore', '/.env.example',
    '/.env*', '/.dev.vars*', '/.wrangler/']) {
    assert(entries.includes(required), required);
  }
  assert(entries.every((entry) => !entry.startsWith('!')));
  for (const kept of ['guild.html', 'guild.css', 'js/guild']) assert(!entries.some((entry) => entry.replace(/^\//, '').replace(/\/$/, '') === kept), `${kept} is not ignored`);
});

check('package.json: version and name untouched, guild scripts run tools/guild-dev.js', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'raidsmith-web');
  assert.equal(pkg.version, '4.4.2');
  assert.equal(pkg.scripts.test, 'node tests/run-all.js');
  assert.equal(pkg.scripts['guild:dev'], 'node tools/guild-dev.js dev');
  assert.equal(pkg.scripts['guild:migrate'], 'node tools/guild-dev.js migrate');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

check('the Wrangler pin in the README equals the one in tools/guild-dev.js; the state dir is outside the repo', () => {
  const dev = require('./tools/guild-dev.js');
  assert.match(dev.WRANGLER_VERSION, /^\d+\.\d+\.\d+$/);
  const readme = read('README.md');
  assert(readme.includes('## Guild tracker (local)'));
  const pins = [...readme.matchAll(/wrangler@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  assert(pins.length >= 1);
  assert(pins.every((pin) => pin === dev.WRANGLER_VERSION), `README pins ${pins} vs ${dev.WRANGLER_VERSION}`);
  assert(readme.includes('/api/share') && readme.includes('/tbc/'), 'README says share links do not work under wrangler dev');

  assert(dev.stateDir().startsWith(os.homedir()));
  assert(path.relative(ROOT, dev.stateDir()).startsWith('..'), 'the local D1 lives outside the repo (and OneDrive)');
  const dir = dev.buildCommand('dev', ['--var', 'A:B'], {});
  const from = dir.args.indexOf('--yes');
  assert(from >= 0);
  assert.deepEqual(dir.args.slice(from, from + 3), ['--yes', `wrangler@${dev.WRANGLER_VERSION}`, 'dev']);
  assert(dir.args.includes('--persist-to') && dir.args.includes(dev.stateDir({})));
  assert.deepEqual(dir.args.slice(-2), ['--var', 'A:B']);
  const migrate = dev.buildCommand('migrate', [], {});
  const at = migrate.args.indexOf('d1');
  assert.deepEqual(migrate.args.slice(at, at + 5), ['d1', 'migrations', 'apply', 'DB', '--local']);
  assert.throws(() => dev.buildCommand('deploy'), /usage/);
  assert(!/--remote/.test(read('tools/guild-dev.js').replace(/^\s*\/?\*.*$/gm, '')), 'the tool never talks to Cloudflare');
});

check('guild-dev: a state dir with spaces stays one argument; --state / RAIDSMITH_DEV_STATE override it; --persist-to is passed once', () => {
  const dev = require('./tools/guild-dev.js');
  const persistCount = (plan) => plan.args.filter((arg) => arg === '--persist-to' || arg.startsWith('--persist-to=') || arg === '"--persist-to"').length;
  const spaced = path.join(os.tmpdir(), 'dir with spaces', 'state');

  const viaArg = dev.buildCommand('dev', ['--state', spaced, '--port', '8788'], {});
  assert.equal(persistCount(viaArg), 1);
  assert(!viaArg.args.includes('--state'), '--state is consumed here, not passed to Wrangler');
  const value = viaArg.args[viaArg.args.indexOf('--persist-to') + 1];
  if (viaArg.shell) assert.equal(value, `"${path.resolve(spaced)}"`, 'quoted for cmd.exe');
  else assert.equal(value, path.resolve(spaced), 'one argv element, no shell splitting');
  assert.deepEqual(viaArg.args.slice(-2), ['--port', '8788']);

  const viaEquals = dev.buildCommand('migrate', [`--state=${spaced}`], {});
  assert.equal(persistCount(viaEquals), 1);

  const viaEnv = dev.buildCommand('dev', [], { RAIDSMITH_DEV_STATE: spaced });
  assert.equal(persistCount(viaEnv), 1);
  assert(viaEnv.args.some((arg) => arg.includes('dir with spaces')));
  assert.equal(dev.stateDir({ RAIDSMITH_DEV_STATE: spaced }), path.resolve(spaced));

  const argBeatsEnv = dev.buildCommand('dev', ['--state', os.tmpdir()], { RAIDSMITH_DEV_STATE: spaced });
  assert(!argBeatsEnv.args.some((arg) => arg.includes('dir with spaces')));

  const own = dev.buildCommand('dev', ['--persist-to', os.tmpdir(), '--port', '1'], {});
  assert.equal(persistCount(own), 1, 'a --persist-to you pass replaces ours instead of doubling it');
  assert.throws(() => dev.buildCommand('dev', ['--state'], {}), /needs a directory/);

  assert.equal(dev.quoteForShell('a b'), '"a b"');
  assert.equal(dev.quoteForShell('plain'), 'plain');
  if (!dev.buildCommand('dev', [], {}).shell) assert.equal(dev.buildCommand('dev', [], {}).command, process.execPath, 'no shell: node runs npx-cli.js');
  const readme = read('README.md');
  assert(readme.includes('--state') && readme.includes('RAIDSMITH_DEV_STATE'), 'README documents the override');
});

check('Worker source follows the rules: ES modules, explicit ./x.js imports, Web APIs only', () => {
  const files = walk('worker').filter((file) => file.endsWith('.js'));
  assert(files.length >= 12, `found ${files.length} worker files`);
  for (const file of files) {
    const source = read(file);
    assert(!/\bfrom\s+['"]node:/.test(source) && !/\brequire\(/.test(source), `${file}: no node: imports or require`);
    assert(!/\bprocess\./.test(source) && !/\bBuffer\b/.test(source), `${file}: no Node globals`);
    assert(!/\bmodule\.exports\b/.test(source), `${file}: ES module`);
    for (const match of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
      const spec = match[1];
      assert(/^\.{1,2}\/.+\.js$/.test(spec), `${file}: import ${spec} must be a relative path with .js`);
      assert(fs.existsSync(path.join(ROOT, path.dirname(file), spec)), `${file}: ${spec} does not exist`);
    }
    assert(!/\bimport\s*\(/.test(source), `${file}: no dynamic import`);
    assert(!/DISCORD_API_BASE\s*=\s*['"]/.test(source));
  }
});

check('Worker SQL binds values and never concatenates them into SQL text', () => {
  for (const file of walk('worker').filter((f) => f.endsWith('.js'))) {
    for (const match of read(file).matchAll(/prepare\(\s*`([^`]*)`/g)) {
      const placeholders = [...match[1].matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
      for (const expression of placeholders) {
        assert(/^(userByDiscordId|guard\.sql|targetIsMaster\.sql|stillBlocked\.sql|inserted.sql|COLUMNS|OTHERS_SQL|SUCCESSOR_SQL|ACTIVE_TEAM_COUNT|MAX_ACTIVE_TEAMS|currentMemberSql\('[^']*', '[^']*', '[^']*'\)|teamId \? [^}]*)$/.test(expression.trim()),
          `${file}: interpolated SQL ${expression}`);
      }
    }
  }
});

check('tools/fake-discord.js answers the OAuth and API calls the Worker makes', async () => {
  const { createFakeDiscord } = require('./tools/fake-discord.js');
  const fake = createFakeDiscord({ userId: '4242', username: 'fakey', servers: [{ id: '777', name: 'S', owner: true, permissions: '8' }] });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.server.address().port}`;
  try {
    const authorize = await fetch(`${base}/oauth2/authorize?redirect_uri=${encodeURIComponent('http://localhost:8787/auth/callback')}&state=abc&prompt=none`, { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const target = new URL(authorize.headers.get('location'));
    assert.equal(target.origin + target.pathname, 'http://localhost:8787/auth/callback');
    assert.equal(target.searchParams.get('state'), 'abc');
    assert(target.searchParams.get('code'));
    const token = await (await fetch(`${base}/api/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${target.searchParams.get('code')}&grant_type=authorization_code`,
    })).json();
    const auth = { headers: { Authorization: `Bearer ${token.access_token}` } };
    assert.equal((await (await fetch(`${base}/api/v10/users/@me`, auth)).json()).id, '4242');
    assert.deepEqual((await (await fetch(`${base}/api/v10/users/@me/guilds?limit=200`, auth)).json()).map((server) => server.id), ['777']);
    assert.equal((await fetch(`${base}/api/v10/users/@me`)).status, 401);
    const revoke = await fetch(`${base}/api/oauth2/token/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${token.access_token}`,
    });
    assert.equal(revoke.status, 200);
    assert.equal((await fetch(`${base}/api/v10/users/@me`, auth)).status, 401, 'a revoked token stops working');
    await fetch(`${base}/__fake/set?id=9&username=second&servers=${encodeURIComponent('[]')}`);
    assert.equal(fake.state.user.id, '9');
  } finally {
    // Wait for the server to finish closing, then let the keep-alive sockets undici's fetch
    // opened drain, so nothing is still closing when the process ends.
    const closed = new Promise((resolve) => fake.server.close(resolve));
    fake.server.closeAllConnections();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

async function main() {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}`);
      console.log(String(error && error.stack || error).split('\n').slice(0, 8).map((line) => `      ${line}`).join('\n'));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
