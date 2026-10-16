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
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

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
    'guild.css', 'js/app.js', 'js/rules/tbc.js', 'js/guild/api.js', 'icons/warrior.jpg'];
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
  assert(!/_API_BASE/.test(raw), 'no *_API_BASE (DISCORD, RAID_HELPER, WCL) is ever config: they are dev-only --vars for local fakes');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.main, 'worker/index.js');
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(config.assets, {
    directory: '.', binding: 'ASSETS', run_worker_first: ['/guild', '/guild/', '/api/guild', '/api/guild/*', '/auth/*'],
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
  for (const name of used) assert(names.includes(name) || /^(?:DISCORD|RAID_HELPER|WCL)_API_BASE$/.test(name) || name === 'DB', `${name} is read by the Worker`);
  assert(used.has('RAID_HELPER_API_BASE') && used.has('WCL_API_BASE') && !names.some((name) => name.endsWith('_API_BASE')), 'the API bases are dev-only vars, not secrets');
});

check('every guild-tracker file is whitelisted in .gitignore (so it can be committed)', () => {
  const git = spawnSync('git', ['--version'], { cwd: ROOT });
  if (git.status !== 0) return; // no git on this machine: the whitelist cannot be probed
  const files = new Set([
    'wrangler.jsonc', '.assetsignore', '_headers', '.env.example', 'guild.css', 'js/guild/api.js', 'js/guild/shell.js',
    'guild-ui-tests.js', 'guild-worker-tests.js', 'guild-config-tests.js', 'tests/d1-fake.js', 'tools/guild-dev.js', 'tools/fake-discord.js',
    'guild-roster-worker-tests.js', 'guild-roster-ui-tests.js', 'guild-shell-tests.js', 'tests/guild-scripts.js', 'tools/fake-sources.js', 'migrations/0002_roster.sql',
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
  for (const kept of ['guild.css', 'js/guild']) assert(!entries.some((entry) => entry.replace(/^\//, '').replace(/\/$/, '') === kept), `${kept} is not ignored`);
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

check('worker/realms.js: the data shape, dated header with sources, the three versions and four regions', async () => {
  const source = read('worker/realms.js');
  assert(/^\/\/ Realm lists as of 2026-10-14\./.test(source), 'dated header');
  for (const needle of ['Warcraft Logs', '2024-11-21', 'warcraft.wiki.gg', 'may be stale', 'WoW Forever has no realms']) assert(source.includes(needle), needle);
  assert(!source.includes('Годовщина'), 'the unverified Russian entry is left out');
  const realms = await import('./worker/realms.js');
  assert.deepEqual(realms.GAME_VERSIONS, [
    { key: 'tbc', label: 'TBC Anniversary' }, { key: 'classic', label: 'Classic Era' }, { key: 'forever', label: 'WoW Forever' },
  ]);
  assert.deepEqual(realms.FOREVER_RULESETS, ['Normal', 'PvP', 'RP', 'Hardcore']);
  assert.deepEqual(Object.keys(realms.REALMS), ['tbc', 'classic', 'forever']);
  for (const version of Object.keys(realms.REALMS)) {
    assert.deepEqual(Object.keys(realms.REALMS[version]), ['US', 'EU', 'KR', 'TW'], version);
    for (const [region, list] of Object.entries(realms.REALMS[version])) {
      assert(Array.isArray(list), `${version} ${region}`);
      for (const realm of list) {
        assert(typeof realm.name === 'string' && realm.name.trim() === realm.name && realm.name.length >= 1 && realm.name.length <= 64, `${version} ${region} name`);
        assert(typeof realm.slug === 'string' && realm.slug, `${version} ${region} ${realm.name}: slug`);
        assert(realm.type === undefined || (typeof realm.type === 'string' && realm.type), `${version} ${region} ${realm.name}: type`);
        assert.deepEqual(Object.keys(realm).filter((key) => !['name', 'slug', 'type'].includes(key)), [], `${realm.name}: only name, slug, type`);
      }
    }
  }
  assert.deepEqual(realms.REALMS.forever, { US: [], EU: [], KR: [], TW: [] }, 'Forever has no realms');
});

check('worker/realms.js: no duplicate names or slugs per version + region, and no realm is listed under two versions in one region', async () => {
  const { REALMS } = await import('./worker/realms.js');
  for (const [version, regions] of Object.entries(REALMS)) {
    for (const [region, list] of Object.entries(regions)) {
      const names = list.map((realm) => realm.name.toLowerCase());
      assert.equal(new Set(names).size, names.length, `${version} ${region}: duplicate name`);
      const slugs = list.map((realm) => realm.slug);
      assert.equal(new Set(slugs).size, slugs.length, `${version} ${region}: duplicate slug`);
    }
  }
  for (const region of ['US', 'EU', 'KR', 'TW']) {
    const tbc = new Set(REALMS.tbc[region].map((realm) => realm.name.toLowerCase()));
    for (const realm of REALMS.classic[region]) assert(!tbc.has(realm.name.toLowerCase()), `${region} ${realm.name} is in both TBC and Classic Era`);
  }
});

check('worker/realms.js: TBC Anniversary realms are exactly the approved list; Anniversary Hardcore realms sit under Classic Era', async () => {
  const { REALMS, findRealm, isVersion } = await import('./worker/realms.js');
  const brief = (list) => list.map(({ name, type }) => [name, type]);
  assert.deepEqual(brief(REALMS.tbc.US), [['Dreamscythe', 'PvE'], ['Nightslayer', 'PvP'], ['Maladath (AU)', 'PvP']]);
  assert.deepEqual(brief(REALMS.tbc.EU), [['Thunderstrike', 'PvE'], ['Spineshatter', 'PvP']]);
  assert.deepEqual(REALMS.tbc.KR, []);
  assert.deepEqual(REALMS.tbc.TW, []);
  assert(REALMS.classic.US.some((realm) => realm.name === 'Doomhowl' && realm.type === 'Hardcore'));
  assert(REALMS.classic.EU.some((realm) => realm.name === 'Soulseeker' && realm.type === 'Hardcore'));
  assert(!JSON.stringify(REALMS.tbc).includes('Hardcore'));
  for (const region of ['US', 'EU', 'KR', 'TW']) assert(REALMS.classic[region].length > 0, `Classic Era ${region} has realms`);
  assert.equal(findRealm('tbc', 'US', ' NIGHTslayer ').slug, 'nightslayer');
  assert.equal(findRealm('tbc', 'US', 'Doomhowl'), null);
  assert.equal(findRealm('classic', 'US', 'doomhowl').name, 'Doomhowl');
  assert.equal(findRealm('forever', 'US', 'Normal'), null);
  assert.equal(findRealm('nope', 'US', 'x'), null);
  assert.equal(findRealm('tbc', 'US', 5), null);
  assert(isVersion('tbc') && isVersion('classic') && isVersion('forever'));
  assert(!isVersion('tbc-anniversary') && !isVersion(undefined) && !isVersion('toString'));
});

check('migration 0001: guilds carry game_version (tbc / classic / forever, no default), realm_kind and a nullable realm_slug', () => {
  const sql = read('migrations/0001_foundation.sql');
  const table = sql.slice(sql.indexOf('CREATE TABLE guilds'), sql.indexOf(');', sql.indexOf('CREATE TABLE guilds')));
  assert(/game_version\s+TEXT NOT NULL CHECK \(game_version IN \('tbc', 'classic', 'forever'\)\),/.test(table));
  assert(!/game_version[^\n]*DEFAULT/.test(table), 'no default version');
  assert(/realm_kind\s+TEXT NOT NULL CHECK \(realm_kind IN \('realm', 'ruleset'\)\)/.test(table));
  assert(/realm_slug\s+TEXT,/.test(table) && !/realm_slug\s+TEXT NOT NULL/.test(table));
  assert(!sql.includes('tbc-anniversary'));
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

check('migration 0002: dates are checked with IS (a NULL date() must not pass), the Main and name indexes, both cap triggers', () => {
  const sql = read('migrations/0002_roster.sql');
  for (const column of ['joined_on', 'trial_start', 'trial_end']) {
    assert(sql.includes(`${column} IS NULL OR date(${column}) IS ${column}`), column);
  }
  assert(/CREATE UNIQUE INDEX characters_one_main ON characters\(player_id\) WHERE is_main = 1;/.test(sql));
  assert(/CREATE UNIQUE INDEX characters_guild_name ON characters\(guild_id, name_key, realm_key\);/.test(sql));
  assert(/CREATE UNIQUE INDEX players_guild_discord ON players\(guild_id, discord_user_id\) WHERE discord_user_id IS NOT NULL;/.test(sql));
  assert(/FOREIGN KEY \(guild_id, team_id\) REFERENCES teams\(guild_id, id\) ON DELETE RESTRICT/.test(sql));
  assert(/FOREIGN KEY \(guild_id, player_id\) REFERENCES players\(guild_id, id\) ON DELETE CASCADE/.test(sql));
  assert(/>= 1000[\s\S]*RAISE\(ABORT, 'person_limit'\)/.test(sql) && />= 20[\s\S]*RAISE\(ABORT, 'character_limit'\)/.test(sql));
});

check('worker/roster-data.js agrees with js/rules/catalog.js: classes, spec names (bar the Feral split), roles, Raid-Helper maps', async () => {
  const context = {};
  vm.runInNewContext(read('js/rules/catalog.js'), context, { filename: 'catalog.js' });
  const catalog = JSON.parse(JSON.stringify(context.RulesData.catalog)); // plain objects of this realm
  const data = await import(pathToFileURL(path.join(ROOT, 'worker', 'roster-data.js')).href);
  assert.deepEqual(data.CLASSES.map((entry) => entry.id), catalog.classes, 'same classes, same order');
  for (const entry of data.CLASSES) assert.equal(entry.name, entry.id[0] + entry.id.slice(1).toLowerCase());
  const toRole = (role) => (role === 'tank' ? 'tank' : role === 'healer' ? 'healer' : 'dps');
  for (const id of catalog.classes) {
    const catalogSpecs = Object.values(catalog.specs[id]);
    const expected = catalogSpecs.flatMap((spec) => (id === 'DRUID' && spec.name === 'Feral' ? ['Feral (DPS)', 'Feral (Tank)'] : [spec.name]));
    assert.deepEqual(data.SPECS[id], expected, `${id} specs`);
    for (const spec of catalogSpecs) {
      if (id === 'DRUID' && spec.name === 'Feral') continue;
      assert.equal(data.SPEC_ROLE[id][spec.name], toRole(spec.role), `${id} ${spec.name} role`);
    }
  }
  assert.equal(data.SPEC_ROLE.DRUID['Feral (DPS)'], 'dps');
  assert.equal(data.SPEC_ROLE.DRUID['Feral (Tank)'], 'tank');
  for (const [key, entry] of Object.entries(catalog.raidHelperSpecMap)) {
    const ours = data.RAID_HELPER_SPEC[key];
    assert(ours, `RAID_HELPER_SPEC lacks ${key}`);
    assert.equal(ours.class, entry.class, key);
    const split = { Feral: 'Feral (DPS)', Guardian: 'Feral (Tank)' };
    assert.equal(ours.spec, split[key] || entry.spec, key);
    assert(data.SPECS[ours.class].includes(ours.spec), `${key} maps to a real spec`);
  }
  for (const key of Object.keys(data.RAID_HELPER_SPEC)) assert(key in catalog.raidHelperSpecMap, `${key} is not in the catalog`);
  for (const [name, id] of Object.entries(catalog.raidHelperClassMap)) {
    if (id) assert.equal(data.RAID_HELPER_CLASS[name], id, name);
    else assert(!(name in data.RAID_HELPER_CLASS), `${name} carries no class`);
  }
  for (const meta of ['Tank', 'Bench', 'Tentative', 'Absence', 'Late']) assert(data.RAID_HELPER_META.includes(meta));
  assert.deepEqual(Object.values(data.WCL_CLASS).sort(), [...catalog.classes].sort());
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
