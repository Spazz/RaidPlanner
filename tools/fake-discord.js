#!/usr/bin/env node
/**
 * A local fake of Discord's OAuth and the two API calls the sign-in makes, for the browser check.
 *   node tools/fake-discord.js [--port 8790] [--user-id 111] [--username Tester] [--global-name "Test Er"]
 *                              [--servers '[{"id":"900000000000000001","name":"My Server","owner":true}]']
 * Environment fallbacks: FAKE_DISCORD_PORT, FAKE_DISCORD_USER_ID, FAKE_DISCORD_USERNAME,
 * FAKE_DISCORD_GLOBAL_NAME, FAKE_DISCORD_SERVERS (JSON array of { id, name, icon?, owner?, permissions? }).
 *
 * Point the Worker at it with: npm run guild:dev -- --var DISCORD_API_BASE:http://127.0.0.1:8790
 * Switch the signed-in fake user at runtime (the next sign-in uses it):
 *   GET /__fake/set?id=222&username=Second&servers=<url-encoded JSON>
 * It listens on 127.0.0.1 only and accepts any client id and secret.
 *
 * The bot (Phase 7, Discord role mapping). The Worker calls  GET /api/v10/guilds/:id/roles  and  GET /api/v10/guilds/:id/members/:user  as the bot
 * (Authorization: Bot <token>; the token must equal --bot-token, default "fake-bot-token", which the Worker reads from DISCORD_BOT_TOKEN).
 *   --bot-servers all|<id,id,...>   servers the bot is in (default all: every server answers). Opening the invite link
 *                                   /oauth2/authorize?scope=bot&guild_id=ID adds the bot to that server.
 *   --roles '{"<serverId>":[{"id":"1","name":"Officers","position":5,"color":16711680}]}'   the roles of each server
 *   --members '{"<serverId>":{"<userId>":["1","2"]}}'                                         each member's role ids (anyone else is Unknown Member, 404)
 * Change them at runtime: GET /__fake/roles?server=ID&roles=<url-encoded JSON array>, GET /__fake/member?server=ID&user=ID&roles=1,2 (roles= empty keeps
 * the member with no roles; &gone=1 removes the member), GET /__fake/bot?server=ID&in=1|0, GET /__fake/state.
 */
const http = require('node:http');

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return args;
}

function createFakeDiscord(options = {}) {
  const state = {
    user: {
      id: options.userId || '100000000000000001',
      username: options.username || 'tester',
      global_name: options.globalName || 'Test Er',
      avatar: options.avatar || null,
    },
    servers: options.servers || [{ id: '900000000000000001', name: 'Fake Server', icon: null, owner: true, permissions: '2147483647' }],
    tokens: new Map(),
    revoked: [],
    counter: 0,
    botToken: options.botToken || 'fake-bot-token',
    botServers: options.botServers === undefined || options.botServers === 'all' ? 'all' : new Set(options.botServers),
    roles: new Map(Object.entries(options.roles || {})),
    members: new Map(Object.entries(options.members || {}).map(([server, byUser]) => [server, new Map(Object.entries(byUser))])),
    botCalls: [],
  };
  const botIn = (server) => state.botServers === 'all' || state.botServers.has(server);

  function send(res, status, body, headers = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(text);
  }

  async function readForm(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  function bearer(req) {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return match && state.tokens.has(match[1]) ? state.tokens.get(match[1]) : null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/oauth2/authorize' && /(?:^|\s)bot(?:\s|$)/.test(url.searchParams.get('scope') || '') && !url.searchParams.get('redirect_uri')) {
        // The bot invite link: the officer "adds" the bot to the server.
        const server = url.searchParams.get('guild_id');
        if (!server) return send(res, 400, { error: 'guild_id required' });
        if (state.botServers !== 'all') state.botServers.add(server);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>Raidsmith bot added</title><p>The Raidsmith bot was added to server ' + server.replace(/[^0-9]/g, '') + ' (permissions ' + String(url.searchParams.get('permissions')).replace(/[^0-9]/g, '') + ').</p>');
      }
      if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        if (!redirectUri) return send(res, 400, { error: 'redirect_uri required' });
        const target = new URL(redirectUri);
        target.searchParams.set('code', `fakecode${++state.counter}`);
        const requestState = url.searchParams.get('state');
        if (requestState) target.searchParams.set('state', requestState);
        res.writeHead(302, { Location: target.toString() });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/oauth2/token') {
        const form = await readForm(req);
        if (!form.get('code')) return send(res, 400, { error: 'invalid_grant' });
        const token = `fake-token-${++state.counter}`;
        state.tokens.set(token, { user: { ...state.user }, servers: state.servers.map((entry) => ({ ...entry })) });
        return send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 604800, scope: 'identify guilds' });
      }
      if (req.method === 'POST' && url.pathname === '/api/oauth2/token/revoke') {
        const form = await readForm(req);
        state.revoked.push(form.get('token'));
        state.tokens.delete(form.get('token'));
        return send(res, 200, {});
      }
      if (req.method === 'GET' && url.pathname === '/api/v10/users/@me') {
        const session = bearer(req);
        return session ? send(res, 200, session.user) : send(res, 401, { message: '401: Unauthorized' });
      }
      if (req.method === 'GET' && url.pathname === '/api/v10/users/@me/guilds') {
        const session = bearer(req);
        return session ? send(res, 200, session.servers) : send(res, 401, { message: '401: Unauthorized' });
      }
      const botRoute = /^\/api\/v10\/guilds\/(\d+)\/(roles|members\/(\d+))$/.exec(url.pathname);
      if (req.method === 'GET' && botRoute) {
        const authorized = req.headers.authorization === 'Bot ' + state.botToken;
        state.botCalls.push({ path: url.pathname, authorized });
        if (!authorized) return send(res, 401, { message: '401: Unauthorized', code: 0 });
        const server = botRoute[1];
        if (!botIn(server)) return send(res, 403, { message: 'Missing Access', code: 50001 });
        if (botRoute[2] === 'roles') {
          const roles = state.roles.get(server) || [];
          // Every server has an @everyone role whose id is the server's.
          return send(res, 200, [{ id: server, name: '@everyone', position: 0, color: 0, managed: false }, ...roles]);
        }
        const roleIds = (state.members.get(server) || new Map()).get(botRoute[3]);
        if (!roleIds) return send(res, 404, { message: 'Unknown Member', code: 10007 });
        return send(res, 200, { user: { id: botRoute[3], username: 'member' + botRoute[3].slice(-4) }, roles: roleIds, nick: null });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/roles') {
        state.roles.set(url.searchParams.get('server'), JSON.parse(url.searchParams.get('roles') || '[]'));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/member') {
        const server = url.searchParams.get('server');
        if (!state.members.has(server)) state.members.set(server, new Map());
        if (url.searchParams.get('gone')) state.members.get(server).delete(url.searchParams.get('user'));
        else state.members.get(server).set(url.searchParams.get('user'), (url.searchParams.get('roles') || '').split(',').filter(Boolean));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/bot') {
        const server = url.searchParams.get('server');
        if (state.botServers === 'all') state.botServers = new Set(url.searchParams.get('in') === '0' ? [] : [server]);
        else if (url.searchParams.get('in') === '0') state.botServers.delete(server);
        else state.botServers.add(server);
        return send(res, 200, { ok: true, botServers: [...state.botServers] });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/state') {
        return send(res, 200, {
          botServers: state.botServers === 'all' ? 'all' : [...state.botServers],
          roles: Object.fromEntries(state.roles), members: Object.fromEntries([...state.members].map(([server, byUser]) => [server, Object.fromEntries(byUser)])),
          botCalls: state.botCalls.length,
        });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/set') {
        if (url.searchParams.get('id')) state.user.id = url.searchParams.get('id');
        if (url.searchParams.get('username')) state.user.username = url.searchParams.get('username');
        if (url.searchParams.get('globalName') !== null) state.user.global_name = url.searchParams.get('globalName') || null;
        if (url.searchParams.get('servers')) state.servers = JSON.parse(url.searchParams.get('servers'));
        return send(res, 200, { user: state.user, servers: state.servers });
      }
      return send(res, 404, { message: 'Unknown Route' });
    } catch (error) {
      return send(res, 500, { message: String(error && error.message) });
    }
  });
  return { server, state };
}

if (require.main === module) {
  const args = readArgs(process.argv.slice(2));
  const env = process.env;
  const port = Number(args.port || env.FAKE_DISCORD_PORT || 8790);
  let servers;
  const rawServers = args.servers || env.FAKE_DISCORD_SERVERS;
  if (rawServers) {
    try { servers = JSON.parse(rawServers); } catch { console.error('--servers must be JSON'); process.exit(1); }
  }
  const parseJson = (raw, name) => {
    if (!raw) return undefined;
    try { return JSON.parse(raw); } catch { console.error('--' + name + ' must be JSON'); process.exit(1); }
    return undefined;
  };
  const botServers = args['bot-servers'] || env.FAKE_DISCORD_BOT_SERVERS;
  const fake = createFakeDiscord({
    botToken: args['bot-token'] || env.FAKE_DISCORD_BOT_TOKEN,
    botServers: !botServers || botServers === 'all' ? 'all' : botServers.split(',').filter(Boolean),
    roles: parseJson(args.roles || env.FAKE_DISCORD_ROLES, 'roles'),
    members: parseJson(args.members || env.FAKE_DISCORD_MEMBERS, 'members'),
    userId: args['user-id'] || env.FAKE_DISCORD_USER_ID,
    username: args.username || env.FAKE_DISCORD_USERNAME,
    globalName: args['global-name'] || env.FAKE_DISCORD_GLOBAL_NAME,
    servers,
  });
  fake.server.listen(port, '127.0.0.1', () => console.log(`fake Discord on http://127.0.0.1:${port} (user ${fake.state.user.id})`));
}

module.exports = { createFakeDiscord };
