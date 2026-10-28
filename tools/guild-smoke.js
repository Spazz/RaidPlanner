#!/usr/bin/env node
/**
 * An isolated, seeded copy of the guild tracker for API and DOM checks. Nothing here touches port 8787 or the dev database
 * (~/.raidsmith-dev/wrangler-state): every run lives in its own state dir and its own ports, on 127.0.0.1 only.
 *
 *   node tools/guild-smoke.js up   --name <x> [--port 8790-8799] [--with discord,sources,bnet] [--open] [--pin-open] [--owner-on-roster]
 *   node tools/guild-smoke.js down --name <x>
 *   node tools/guild-smoke.js run  --name <x> <script.js> [script args]
 *
 * up    migrates a fresh state under <home>/.raidsmith-dev/chk-<x>, starts the fakes and the Worker (wrangler dev) in the background, seeds a guild
 *       through the real API and prints ONE JSON object on stdout (progress goes to stderr):
 *         { base, port, open, pinOpen, cookies: { gm, member, member2 }, ids: { guildId, teamId, people, altId, pastRaidId, upcomingRaidId, users },
 *           fakes: { discord, sources, bnet }, signIn: { gm, member, member2 }, state, logs }
 *       The seed: a Guild Master (gm) and two members signed in with the fake Discord (each cookie is a ready "Cookie:" header value), one team,
 *       three people with characters (Thornwick, Mendra, Quillfeather, linked to gm, member, member2; Thornwick also has an Alt), a past raid built
 *       from the fake Warcraft Logs report Fake000000000001 (or, without `sources`, a hand-entered one), and an upcoming raid member has signed up for.
 *       --with picks the optional fakes (default discord,sources; discord is always on because sign-in needs it; bnet adds the Battle.net fake).
 *       --open starts the Worker with NO creator allowlist (Phase 8: any Discord server administrator may create a guild); the seed still comes from
 *       the Guild Master user. Without it GUILD_CREATOR_ALLOWLIST is the Guild Master's Discord ID, as in the pilot.
 *       --pin-open opens the setup pin (Guild setup, POST .../bnet/pin) for the seeded guild: the Worker reads SETUP_PIN_GUILDS when it starts, before the guild and its id
 *       exist, so it is set to '*' (every guild; the isolated state holds only the seeded one). Without it the pin is closed (a lone comma: nobody).
 *       --owner-on-roster makes the seeded Owner (gm, the person Thornwick) a character that Battle.net proves AND that the in-game roster holds, so a check can run Guild setup from the
 *       pin to the switch-over without hand-made rows. It implies --with bnet. The stock fake cannot do this alone: its profile characters carry ids 7000 + n and its roster ids 8000 + n,
 *       and the Worker matches by id. Two things are done: the fake Battle.net is started with --owner-on-roster (tools/fake-battlenet.js: the account's profile holds Thornwick with the
 *       roster's id 8000), and gm links that Battle.net account through the real flow (login -> fake authorize -> callback) (1) right after the first sign-in, BEFORE the guild exists - a
 *       first link of an account that holds a staff role needs a fresh grant, so it cannot come later - which makes it the account's FOUNDING identity (linked within 60 s of the account's
 *       creation: worker/fresh.js rule (a) accepts it for the Owner acts without the 7 days) and (2) once more after the seed, which is what stamps Thornwick's key and Battle.net proof
 *       (the sign-in match of a legacy guild). Pin (--pin-open) then finds him on the roster and the flip dry run says the Owner is live. No clock is moved and no database is written.
 *       --port is the Worker's port (8790-8799, default the first free one); the fakes sit on port+10000 (Discord), +11000 (sources), +12000 (Battle.net).
 *       Every Worker secret is a placeholder passed with --var, so a local .env is never read for them and no real service is called.
 *       Each background process (the fakes, the Worker) runs behind tools/guild-smoke-host.js, the only thing started detached: it keeps the
 *       whole tree in a console without a window, so no console window ever opens on Windows. The pids in the JSON are the hosts'.
 *   down  stops everything `up` started (process trees) and deletes the state dir. Safe to run twice.
 *   run   runs a node script with the `up` values injected: environment GUILD_SMOKE_JSON (the JSON above) plus GUILD_SMOKE_BASE; in the script,
 *           const smoke = require('<repo>/tools/guild-smoke.js').fromEnv();   // { base, cookies, ids, ..., api(who, method, route, body) }
 *           const res = await smoke.api('gm', 'GET', '/auth/me');            // { status, json, text }
 *         For a browser, open signIn.<who> (switches the fake Discord user), then <base>/auth/login: the session cookie is set for 127.0.0.1.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const dev = require('./guild-dev.js');

const REPO_ROOT = path.join(__dirname, '..');
const HOST_SCRIPT = path.join(__dirname, 'guild-smoke-host.js');
const COMMANDS = ['up', 'down', 'run'];
const FAKES = ['discord', 'sources', 'bnet'];
const DEFAULT_FAKES = ['discord', 'sources'];
const PORT_MIN = 8790;
const PORT_MAX = 8799;
const FAKE_PORT_OFFSET = { discord: 10000, sources: 11000, bnet: 12000 };
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const STATE_FILE = 'smoke.json';
const SESSION_COOKIE = '__Host-rs_session';
const DISCORD_SERVER_ID = '900000000000000001';
const WCL_REPORT = 'Fake000000000001';
const USAGE = [
  'usage: node tools/guild-smoke.js up   --name <x> [--port 8790-8799] [--with discord,sources,bnet] [--open] [--pin-open] [--owner-on-roster]',
  '       node tools/guild-smoke.js down --name <x>',
  '       node tools/guild-smoke.js run  --name <x> <script.js> [script args]',
].join('\n');

// ── Arguments and paths (pure: tested in guild-smoke-tests.js) ───────────────

function fail(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

// -> { command, name, port | null, fakes: [...], open, pinOpen, ownerOnRoster, script, scriptArgs }
function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw fail(`unknown command "${command || ''}"\n${USAGE}`);
  const out = { command, name: null, port: null, fakes: DEFAULT_FAKES.slice(), open: false, pinOpen: false, ownerOnRoster: false, script: null, scriptArgs: [] };
  const seen = new Set();
  let index = 0;
  const value = (flag) => {
    if (index + 1 >= rest.length || rest[index + 1].startsWith('--')) throw fail(`${flag} needs a value`);
    return rest[++index];
  };
  for (; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      if (command !== 'run' || out.script !== null) throw fail(`unexpected argument "${arg}"\n${USAGE}`);
      out.script = arg;
      out.scriptArgs = rest.slice(index + 1);
      break;
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (seen.has(flag)) throw fail(`${flag} was given twice`);
    seen.add(flag);
    const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : null;
    const take = () => (inline !== null ? inline : value(flag));
    if (flag === '--name') out.name = take();
    else if (flag === '--port' && command === 'up') out.port = readPort(take());
    else if (flag === '--with' && command === 'up') out.fakes = readFakes(take());
    else if (flag === '--open' && command === 'up') {
      if (inline !== null) throw fail('--open takes no value');
      out.open = true;
    }
    else if (flag === '--pin-open' && command === 'up') {
      if (inline !== null) throw fail('--pin-open takes no value');
      out.pinOpen = true;
    }
    else if (flag === '--owner-on-roster' && command === 'up') {
      if (inline !== null) throw fail('--owner-on-roster takes no value');
      out.ownerOnRoster = true;
    }
    else throw fail(`unknown option ${flag} for ${command}\n${USAGE}`);
  }
  if (out.name === null) throw fail(`--name is required\n${USAGE}`);
  if (!NAME_PATTERN.test(out.name)) throw fail(`--name must be 1-24 lower-case letters, digits or dashes (got "${out.name}")`);
  if (command === 'run' && !out.script) throw fail(`run needs a script to run\n${USAGE}`);
  // The Owner's Battle.net character lives in the Battle.net fake: the option brings it along (discord, sources, bnet keep their fixed order).
  if (out.ownerOnRoster && !out.fakes.includes('bnet')) out.fakes = FAKES.filter((fake) => fake === 'bnet' || out.fakes.includes(fake));
  return out;
}

function readPort(text) {
  const port = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(port >= PORT_MIN && port <= PORT_MAX)) throw fail(`--port must be ${PORT_MIN}-${PORT_MAX} (8787 is the live localhost, never used here)`);
  return port;
}

// Always includes discord (sign-in needs it); an unknown name is an error.
function readFakes(text) {
  const names = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (!names.length) throw fail('--with needs at least one of discord, sources, bnet');
  for (const name of names) if (!FAKES.includes(name)) throw fail(`--with: unknown fake "${name}" (discord, sources, bnet)`);
  return FAKES.filter((name) => name === 'discord' || names.includes(name));
}

const smokeRoot = (home = os.homedir()) => path.join(home, '.raidsmith-dev');
const stateDirFor = (name, home = os.homedir()) => path.join(smokeRoot(home), `chk-${name}`);

// The only directories `down` may delete: <home>/.raidsmith-dev/chk-<name>. The live state (wrangler-state) can never match.
function isDeletableStateDir(dir, home = os.homedir()) {
  const root = path.resolve(smokeRoot(home));
  const target = path.resolve(dir);
  return path.dirname(target) === root && /^chk-[a-z0-9][a-z0-9-]{0,23}$/.test(path.basename(target));
}

const fakePort = (fake, workerPort) => workerPort + FAKE_PORT_OFFSET[fake];
const fakeUrl = (fake, workerPort) => `http://127.0.0.1:${fakePort(fake, workerPort)}`;

// The --var arguments for the Worker. Placeholders only: the fakes accept any client id and secret. A fake that is not started points at a refused
// port, so nothing can reach a real service even with real credentials in .env.
// open: no creator allowlist (any server administrator may create a guild). The variable is still passed, as a lone comma the Worker reads as nobody
// listed, so a local .env can never fill it in.
// pinOpen: the setup pin is open for the guild the seed creates after the Worker has started ('*': every guild; a lone comma, nobody, otherwise).
function workerVars(workerPort, fakes, gmDiscordId, open = false, pinOpen = false) {
  const refused = 'http://127.0.0.1:9';
  const base = (fake) => (fakes.includes(fake) ? fakeUrl(fake, workerPort) : refused);
  const vars = {
    DISCORD_API_BASE: base('discord'),
    DISCORD_CLIENT_ID: 'smoke-client',
    DISCORD_CLIENT_SECRET: 'smoke-secret',
    DISCORD_REDIRECT_URI: `http://127.0.0.1:${workerPort}/auth/callback`,
    DISCORD_BOT_TOKEN: 'fake-bot-token',
    GUILD_CREATOR_ALLOWLIST: open ? ',' : gmDiscordId,
    // Dev "View as": off unless the caller asks (GUILD_SMOKE_VIEW_AS=1); never filled from a local .env.
    DEV_VIEW_AS: process.env.GUILD_SMOKE_VIEW_AS === '1' ? '1' : '0',
    RAID_HELPER_API_BASE: base('sources'),
    WCL_API_BASE: base('sources'),
    WCL_CLIENT_ID: 'smoke-client',
    WCL_CLIENT_SECRET: 'smoke-secret',
    BNET_API_BASE: base('bnet'),
    BNET_CLIENT_ID: 'smoke-client',
    BNET_CLIENT_SECRET: 'smoke-secret',
    BNET_REDIRECT_URI: `http://127.0.0.1:${workerPort}/auth/bnet/callback`,
    // Block tombstones: a fixed throwaway key (a local .env key never reaches an isolated run); no retired keys (a lone comma reads as none).
    TOMBSTONE_KEY: 'smoke-tombstone-key-0123456789abcdef',
    TOMBSTONE_KEY_VERSION: '1',
    TOMBSTONE_OLD_KEYS: ',',
    // The setup pin (lane B6b): closed (a lone comma lists nobody) unless --pin-open opens it; a local .env can never fill it in.
    SETUP_PIN_GUILDS: pinOpen ? '*' : ',',
  };
  return Object.entries(vars).flatMap(([key, val]) => ['--var', `${key}:${val}`]);
}

// ── Processes ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stderr.write(`[guild-smoke] ${message}\n`);

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

// Starts plan in the background so it outlives this process. Only the HOST is detached: on Windows a detached process has no console, so every
// console program it starts (workerd, esbuild) would open its own visible window. The host runs the plan inside a console without a window
// (see guild-smoke-host.js); the host's own stdout/stderr go to the log too, next to the plan's output. The PID is the host's: kill its tree.
function startDetached(plan, logFile, extraEnv = {}) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [HOST_SCRIPT, '--log', logFile, ...(plan.shell ? ['--shell'] : []), '--', plan.command, ...plan.args], {
    cwd: REPO_ROOT, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', ...extraEnv },
  });
  fs.closeSync(fd);
  let exited = null;
  child.on('exit', (code) => { exited = code === null ? 1 : code; });
  child.unref();
  return { pid: child.pid, exited: () => exited };
}

function nodePlan(script, args) {
  return { command: process.execPath, args: [path.join(__dirname, script), ...args], shell: false };
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGTERM');
  } catch { /* already gone */ }
}

function tail(file, lines = 15) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return '(no log)'; }
}

async function waitFor(url, { timeout = 120000, label, dead = () => null, logFile } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (dead() !== null) throw new Error(`${label} exited early (code ${dead()}):\n${tail(logFile)}`);
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${label} did not answer ${url} in ${Math.round(timeout / 1000)}s:\n${tail(logFile)}`);
}

// ── The Worker's API, as a cookie-carrying client ────────────────────────────

function fromJson(data) {
  const api = async (who, method, route, body) => {
    const cookie = data.cookies[who];
    if (!cookie) throw new Error(`no cookie for "${who}" (have: ${Object.keys(data.cookies).join(', ')})`);
    return request(data.base, cookie, method, route, body);
  };
  return Object.assign({}, data, { api });
}

// Reads the values `run` injects.
function fromEnv(env = process.env) {
  if (!env.GUILD_SMOKE_JSON) throw new Error('GUILD_SMOKE_JSON is not set: run this script with `node tools/guild-smoke.js run --name <x> <script>`');
  return fromJson(JSON.parse(env.GUILD_SMOKE_JSON));
}

async function request(base, cookie, method, route, body) {
  const headers = { Origin: base };
  if (cookie) headers.Cookie = cookie;
  const init = { method, headers, redirect: 'manual' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(base + route, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

function cookieOf(res) {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';')[0].trim();
    if (pair.startsWith(`${SESSION_COOKIE}=`) && !/;\s*Max-Age=0/i.test(line)) return pair;
  }
  return null;
}

// Discord sign-in through the fake: pick the fake user, then Worker login -> fake authorize -> Worker callback. -> { cookie, userId }
async function signIn(base, discord, person, servers) {
  const query = new URLSearchParams({ id: person.id, username: person.username, globalName: person.globalName, servers: JSON.stringify(servers) });
  const set = await fetch(`${discord}/__fake/set?${query}`);
  if (set.status !== 200) throw new Error(`fake Discord /__fake/set answered ${set.status}`);
  const login = await request(base, null, 'GET', '/auth/login');
  if (login.status !== 302) throw new Error(`/auth/login answered ${login.status}`);
  const authorize = await fetch(login.headers.get('Location'), { redirect: 'manual' });
  if (authorize.status !== 302) throw new Error(`fake authorize answered ${authorize.status}`);
  const stateCookie = login.headers.getSetCookie().map((line) => line.split(';')[0].trim()).join('; ');
  const callback = await request(base, stateCookie, 'GET', new URL(authorize.headers.get('Location')).pathname + new URL(authorize.headers.get('Location')).search);
  if (callback.status !== 302) throw new Error(`/auth/callback answered ${callback.status}: ${callback.text.slice(0, 120)}`);
  const cookie = cookieOf(callback);
  if (!cookie) throw new Error('/auth/callback set no session cookie');
  const me = await request(base, cookie, 'GET', '/auth/me');
  if (me.status !== 200 || !me.json || !me.json.user) throw new Error(`/auth/me answered ${me.status}`);
  return { cookie, userId: me.json.user.id };
}

// ── Seed ─────────────────────────────────────────────────────────────────────

const PEOPLE = {
  gm: { id: '110000000000000001', username: 'smoke-gm', globalName: 'Smoke Guildmaster' },
  member: { id: '110000000000000002', username: 'smoke-member', globalName: 'Smoke Member' },
  member2: { id: '110000000000000003', username: 'smoke-member-two', globalName: 'Smoke Member Two' },
};
const MANAGE_SERVER = [{ id: DISCORD_SERVER_ID, name: 'Smoke Server', icon: null, owner: true, permissions: '2147483647' }];
const PLAIN_SERVER = [{ id: DISCORD_SERVER_ID, name: 'Smoke Server', icon: null, owner: false, permissions: '0' }];
const dayText = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

// Battle.net link of the signed-in account through the real flow and the fake: login -> the fake's authorize -> the Worker's callback. Throws on anything but a clean redirect.
async function linkBattlenet(base, cookie) {
  const login = await request(base, cookie, 'GET', '/auth/bnet/login');
  const location = login.headers.get('Location') || '';
  if (login.status !== 302 || !/^https?:/.test(location)) throw new Error(`/auth/bnet/login did not start the Battle.net sign-in: ${login.status} ${location}`);
  const authorize = await fetch(location, { redirect: 'manual' });
  if (authorize.status !== 302) throw new Error(`fake Battle.net authorize answered ${authorize.status}`);
  const stateCookie = login.headers.getSetCookie().map((line) => line.split(';')[0].trim()).join('; ');
  const target = new URL(authorize.headers.get('Location'));
  const callback = await request(base, `${cookie}; ${stateCookie}`, 'GET', target.pathname + target.search);
  const where = callback.headers.get('Location') || '';
  if (callback.status !== 302 || /error=/.test(where)) throw new Error(`/auth/bnet/callback answered ${callback.status} ${where}`);
}

// ownerOnRoster: see the header. The first link has to be made within this long of the account's creation to be its founding identity (worker/fresh.js FOUNDING_WINDOW_MS is 60 s).
const FOUNDING_LINK_MS = 45 * 1000;

async function seed(base, fakes, discord, { ownerOnRoster = false } = {}) {
  const need = async (who, cookie, method, route, body, status = [200, 201]) => {
    const res = await request(base, cookie, method, route, body);
    if (!status.includes(res.status)) throw new Error(`seed: ${who} ${method} ${route} -> ${res.status} ${res.text.slice(0, 200)}`);
    return res.json;
  };
  const founded = Date.now();
  const gm = await signIn(base, discord, PEOPLE.gm, MANAGE_SERVER);
  if (ownerOnRoster) {
    // Before the guild exists: gm holds no role yet, so this first link needs no fresh grant; and it is made within seconds of the account's creation.
    await linkBattlenet(base, gm.cookie);
    if (Date.now() - founded > FOUNDING_LINK_MS) throw new Error('seed: the Battle.net link came more than 45 s after the account was created, so it is not the founding identity; run it again');
  }
  const created = await need('gm', gm.cookie, 'POST', '/api/guild', {
    serverId: DISCORD_SERVER_ID, gameVersion: 'tbc', region: 'US', realm: 'Dreamscythe', name: 'Smoke Guard', timeZone: 'America/New_York', multipleTeams: false,
  });
  const guildId = created.guild.id;
  const teamId = created.teams[0].id;
  // The members sign in after the guild exists: a Discord server is recorded for a guild's server only.
  const member = await signIn(base, discord, PEOPLE.member, PLAIN_SERVER);
  const member2 = await signIn(base, discord, PEOPLE.member2, PLAIN_SERVER);
  const root = `/api/guild/${guildId}`;

  const people = {};
  for (const [key, name, cls, spec] of [['thornwick', 'Thornwick', 'WARRIOR', 'Arms'], ['mendra', 'Mendra', 'SHAMAN', 'Enhancement'], ['quillfeather', 'Quillfeather', 'HUNTER', 'Marksmanship']]) {
    const made = await need('gm', gm.cookie, 'POST', `${root}/roster`, { teamId, name, class: cls, mainSpec: spec, offSpec: null, status: 'raider' });
    people[key] = made.person.id;
  }
  const alt = await need('gm', gm.cookie, 'POST', `${root}/roster/${people.thornwick}/characters`, {
    name: 'Thornmage', class: 'MAGE', mainSpec: 'Fire', offSpec: null, teamId, makeMain: false,
  });
  const altCharacter = (alt.characters || []).find((character) => character.name === 'Thornmage');
  if (!altCharacter) throw new Error('seed: the Alt character was not created');
  const altId = altCharacter.id;
  // Each account owns its person the way a player does it since the identity split: a claim on the person's Main by hand, approved by the Guild Master (that claim
  // links the account AND records its Discord ID). The officer's Link account / the Discord field only record a Discord ID, which is bookkeeping, not ownership.
  for (const [who, name, cls, spec, user] of [['gm', 'Thornwick', 'WARRIOR', 'Arms', gm], ['member', 'Mendra', 'SHAMAN', 'Enhancement', member], ['member2', 'Quillfeather', 'HUNTER', 'Marksmanship', member2]]) {
    const asked = await need(who, user.cookie, 'POST', `${root}/me/characters`, { name, class: cls, mainSpec: spec, offSpec: null });
    await need('gm', gm.cookie, 'POST', `${root}/claims/${asked.claims[0].id}/approve`, { expectedKind: 'link_person' });
  }

  let past;
  if (fakes.includes('sources')) {
    past = await need('gm', gm.cookie, 'POST', `${root}/raids`, { teamId, reportSource: WCL_REPORT });
  } else {
    past = await need('gm', gm.cookie, 'POST', `${root}/raids`, { teamId, raidOn: dayText(-7), startTime: '20:00', zone: 'Karazhan' });
    await need('gm', gm.cookie, 'PUT', `${root}/raids/${past.raid.id}/manual`, { reason: 'Smoke seed', presentPlayerIds: [people.thornwick, people.mendra, people.quillfeather] });
  }
  const upcoming = await need('gm', gm.cookie, 'POST', `${root}/raids`, { teamId, raidOn: dayText(3), startTime: '20:00', zone: 'Gruul\'s Lair', title: 'Smoke night' });
  await need('member', member.cookie, 'PUT', `${root}/raids/${upcoming.raid.id}/signup`, { kind: 'signed' });
  // The same Battle.net account again ("Re-verify"): now the guild and gm's person exist, so the sign-in match gives Thornwick the roster's key (id 8000) and the Battle.net proof.
  if (ownerOnRoster) await linkBattlenet(base, gm.cookie);

  return {
    cookies: { gm: gm.cookie, member: member.cookie, member2: member2.cookie },
    ids: {
      guildId, teamId, people, altId, pastRaidId: past.raid.id, upcomingRaidId: upcoming.raid.id,
      users: { gm: gm.userId, member: member.userId, member2: member2.userId },
      discordIds: { gm: PEOPLE.gm.id, member: PEOPLE.member.id, member2: PEOPLE.member2.id },
    },
  };
}

function signInLinks(discord) {
  const link = (person, servers) => `${discord}/__fake/set?${new URLSearchParams({ id: person.id, username: person.username, globalName: person.globalName, servers: JSON.stringify(servers) })}`;
  return { gm: link(PEOPLE.gm, MANAGE_SERVER), member: link(PEOPLE.member, PLAIN_SERVER), member2: link(PEOPLE.member2, PLAIN_SERVER) };
}

// ── Commands ─────────────────────────────────────────────────────────────────

const stateFileOf = (stateDir) => path.join(stateDir, STATE_FILE);
const readState = (stateDir) => { try { return JSON.parse(fs.readFileSync(stateFileOf(stateDir), 'utf8')); } catch { return null; } };

async function pickPort(wanted, fakes) {
  const candidates = wanted !== null ? [wanted] : Array.from({ length: PORT_MAX - PORT_MIN + 1 }, (_, i) => PORT_MIN + i);
  for (const port of candidates) {
    const ports = [port, ...fakes.map((fake) => fakePort(fake, port))];
    const free = await Promise.all(ports.map(portIsFree));
    if (free.every(Boolean)) return port;
    if (wanted !== null) throw new Error(`port ${port} or one of its fake ports (${ports.slice(1).join(', ')}) is already in use`);
  }
  throw new Error(`no free Worker port in ${PORT_MIN}-${PORT_MAX}`);
}

async function up(options) {
  const stateDir = stateDirFor(options.name);
  if (fs.existsSync(stateDir)) throw new Error(`${stateDir} exists: run \`node tools/guild-smoke.js down --name ${options.name}\` first`);
  const port = await pickPort(options.port, options.fakes);
  const base = `http://127.0.0.1:${port}`;
  const logs = path.join(stateDir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const pids = {};
  const started = [];
  const stop = () => { for (const pid of started.reverse()) killTree(pid); };
  try {
    log(`migrating a fresh database in ${stateDir}`);
    const migrate = dev.buildCommand('migrate', ['--state', stateDir], {});
    const migrated = spawnSync(migrate.command, migrate.args, { cwd: REPO_ROOT, shell: !!migrate.shell, encoding: 'utf8', windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    fs.writeFileSync(path.join(logs, 'migrate.log'), `${migrated.stdout || ''}\n${migrated.stderr || ''}`);
    if (migrated.status !== 0) throw new Error(`migrations failed:\n${tail(path.join(logs, 'migrate.log'))}`);

    for (const fake of options.fakes) {
      const file = { discord: 'fake-discord.js', sources: 'fake-sources.js', bnet: 'fake-battlenet.js' }[fake];
      const args = ['--port', String(fakePort(fake, port))];
      if (fake === 'discord') args.push('--user-id', PEOPLE.gm.id, '--username', PEOPLE.gm.username, '--global-name', PEOPLE.gm.globalName, '--servers', JSON.stringify(MANAGE_SERVER));
      if (fake === 'sources') args.push('--server-id', DISCORD_SERVER_ID);
      if (fake === 'bnet' && options.ownerOnRoster) args.push('--owner-on-roster');
      const child = startDetached(nodePlan(file, args), path.join(logs, `${fake}.log`));
      pids[fake] = child.pid;
      started.push(child.pid);
      log(`fake ${fake} on ${fakePort(fake, port)}`);
    }
    await sleep(600);

    const plan = dev.buildCommand('dev', ['--state', stateDir, '--port', String(port), '--ip', '127.0.0.1', ...workerVars(port, options.fakes, PEOPLE.gm.id, options.open, options.pinOpen)], {});
    const worker = startDetached(plan, path.join(logs, 'worker.log'));
    pids.worker = worker.pid;
    started.push(worker.pid);
    log(`starting the Worker on ${base} (a first start can take a minute)`);
    await waitFor(`${base}/auth/providers`, { label: 'the Worker', dead: worker.exited, logFile: path.join(logs, 'worker.log') });

    log('seeding through the API');
    const discord = fakeUrl('discord', port);
    const seeded = await seed(base, options.fakes, discord, { ownerOnRoster: options.ownerOnRoster });
    const result = {
      name: options.name, base, port, open: options.open, pinOpen: options.pinOpen, ownerOnRoster: options.ownerOnRoster, cookies: seeded.cookies, ids: seeded.ids,
      fakes: Object.fromEntries(options.fakes.map((fake) => [fake, fakeUrl(fake, port)])),
      signIn: signInLinks(discord), state: stateDir, logs, pids,
    };
    fs.writeFileSync(stateFileOf(stateDir), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    stop();
    await sleep(500);
    removeDir(stateDir, 'a failed start');
    throw error;
  }
}

function removeDir(stateDir, why) {
  if (!isDeletableStateDir(stateDir)) throw new Error(`refusing to delete ${stateDir}`);
  for (let attempt = 0; attempt < 8; attempt++) {
    try { fs.rmSync(stateDir, { recursive: true, force: true }); return true; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},700)'], { windowsHide: true }); }
  }
  log(`could not delete ${stateDir} after ${why} (a process still holds a file); delete it by hand`);
  return false;
}

async function down(options) {
  const stateDir = stateDirFor(options.name);
  const state = readState(stateDir);
  if (state && state.pids) for (const pid of Object.values(state.pids).reverse()) killTree(pid);
  if (state && state.port) {
    for (let i = 0; i < 20 && !(await portIsFree(state.port)); i++) await sleep(300);
    if (!(await portIsFree(state.port))) log(`port ${state.port} is still in use after the stop; check for a leftover workerd process`);
  }
  if (!fs.existsSync(stateDir)) { log(`nothing to stop for "${options.name}"`); return; }
  await sleep(500);
  if (removeDir(stateDir, 'down')) log(`stopped "${options.name}" and deleted ${stateDir}`);
}

function run(options) {
  const state = readState(stateDirFor(options.name));
  if (!state) throw new Error(`"${options.name}" is not up: run \`node tools/guild-smoke.js up --name ${options.name}\` first`);
  const { pids, ...injected } = state;
  const result = spawnSync(process.execPath, [path.resolve(options.script), ...options.scriptArgs], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, GUILD_SMOKE_JSON: JSON.stringify(injected), GUILD_SMOKE_BASE: state.base },
  });
  return result.status === null ? 1 : result.status;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  try {
    if (options.command === 'up') {
      const result = await up(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (options.command === 'down') { await down(options); return 0; }
    return run(options);
  } catch (error) {
    process.stderr.write(`guild-smoke ${options.command}: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = {
  parseArgs, readPort, readFakes, stateDirFor, isDeletableStateDir, fakePort, fakeUrl, workerVars, fromEnv, fromJson, signIn, startDetached, killTree,
  PORT_MIN, PORT_MAX, DEFAULT_FAKES, FAKES, STATE_FILE,
};
