#!/usr/bin/env node
/**
 * A local fake of the two roster import sources, for the browser check: the Raid-Helper v4 events API and the
 * Warcraft Logs token + GraphQL endpoints. Everything it serves is invented (no real nicknames or Discord IDs).
 *   node tools/fake-sources.js [--port 8791] [--server-id 900000000000000001]
 * Environment fallbacks: FAKE_SOURCES_PORT, FAKE_SOURCES_SERVER_ID.
 *
 * Point the Worker at it with (both bases are the same URL):
 *   npm run guild:dev -- --var RAID_HELPER_API_BASE:http://127.0.0.1:8791 --var WCL_API_BASE:http://127.0.0.1:8791
 *
 * Raid-Helper events (GET /api/v4/events/<id>):
 *   111111111111111111  the main event, posted in --server-id (the fake Discord server): new people, an Absence,
 *                       a Tentative, a member with two sign-ups, a nickname with a repeated alt token
 *   222222222222222222  the same shape, posted in a different Discord server (other-server confirm)
 *   333333333333333333  answers 403 (private)
 *   444444444444444444  answers 200 with something that is not an event
 *   anything else       404
 * Warcraft Logs (POST /oauth/token, POST /api/v2/client; any client id and secret are accepted):
 *   report code Fake000000000001  a TBC report with players, a pet and a duplicate actor
 *   report code Priv000000000001  answers a permission error
 *   anything else                 { report: null }
 * GET /__fake/requests lists what was asked; it listens on 127.0.0.1 only.
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

const EVENT_START = 1_800_100_000; // epoch seconds

function signUp(id, userId, name, className, specName, position) {
  return { id, userId, name, className, specName, status: 'primary', position, entryTime: EVENT_START - 86_400 };
}

function buildEvent(id, serverId, title) {
  return {
    id,
    serverId,
    title,
    startTime: EVENT_START,
    signUps: [
      signUp(5001, '200000000000000001', 'Thornwick/Mendra', 'Warrior', 'Arms', 1),
      signUp(5002, '200000000000000002', 'Pyrelo (Quinn)', 'Mage', 'Fire', 2),
      signUp(5003, '200000000000000003', 'Sølvhand', 'Paladin', 'Holy1', 3),
      signUp(5004, '200000000000000004', 'Brewmaw/Brewmaw', 'Tank', 'Guardian', 4),
      signUp(5005, '200000000000000005', 'Ashgrove', 'Tentative', 'Shadow', 5),
      signUp(5006, '200000000000000006', 'Nobody Home', 'Absence', undefined, 6),
      signUp(5007, '200000000000000007', 'Kestrel/Vexa', 'Bench', undefined, 7),
      // One member with two sign-ups: the one with a class wins, the other nickname joins the Alt suggestions.
      signUp(5008, '200000000000000008', 'Lumenfall', 'Late', undefined, 8),
      signUp(5009, '200000000000000008', 'Lumenfall/Dawnreach', 'Priest', 'Discipline', 9),
      signUp(5010, null, 'Guest Raider', 'Rogue', 'Combat', 10),
    ].map((entry) => (entry.userId === null ? { ...entry, userId: undefined } : entry)),
  };
}

const WCL_ACTORS = [
  { name: 'Thornwick', type: 'Player', subType: 'Warrior', server: 'Dreamscythe' },
  { name: 'Pyrelo', type: 'Player', subType: 'Mage', server: 'Dreamscythe' },
  { name: 'Mendra', type: 'Player', subType: 'Shaman', server: 'Dreamscythe' },
  { name: 'Wanderfell', type: 'Player', subType: 'Druid', server: 'Nightslayer' },
  { name: 'Embertail', type: 'Player', subType: 'Pet', server: null },
  { name: 'Pyrelo', type: 'Player', subType: 'Mage', server: 'Dreamscythe' },
  { name: 'Quillfeather', type: 'Player', subType: 'Hunter', server: 'Dreamscythe' },
];

function createFakeSources(options = {}) {
  const serverId = options.serverId || '900000000000000001';
  const state = {
    requests: [],
    tokens: new Set(),
    counter: 0,
    events: {
      '111111111111111111': buildEvent('111111111111111111', serverId, 'Fake Gruul and Magtheridon'),
      '222222222222222222': buildEvent('222222222222222222', '900000000000000099', 'Fake Event From Elsewhere'),
    },
  };

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function readText(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ method: req.method, path: url.pathname });
    try {
      const event = /^\/api\/v4\/events\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && event) {
        if (event[1] === '333333333333333333') return send(res, 403, { status: 'failed', reason: 'private' });
        if (event[1] === '444444444444444444') return send(res, 200, { hello: 'world' });
        return state.events[event[1]] ? send(res, 200, state.events[event[1]]) : send(res, 404, { status: 'failed', reason: 'not found' });
      }
      if (req.method === 'POST' && url.pathname === '/oauth/token') {
        const form = new URLSearchParams(await readText(req));
        if (form.get('grant_type') !== 'client_credentials' || !/^Basic /.test(req.headers.authorization || '')) {
          return send(res, 401, { error: 'invalid_client' });
        }
        const token = `fake-wcl-token-${++state.counter}`;
        state.tokens.add(token);
        return send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
      }
      if (req.method === 'POST' && url.pathname === '/api/v2/client') {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (!bearer || !state.tokens.has(bearer[1])) return send(res, 401, { error: 'unauthenticated' });
        const payload = JSON.parse(await readText(req));
        const code = payload && payload.variables && payload.variables.code;
        if (code === 'Priv000000000001') {
          return send(res, 200, { errors: [{ message: 'You do not have permission to view this report.' }], data: { reportData: { report: null } } });
        }
        if (code !== 'Fake000000000001') return send(res, 200, { data: { reportData: { report: null } } });
        return send(res, 200, {
          data: {
            reportData: {
              report: { title: 'Fake Gruul Clear', startTime: EVENT_START * 1000, zone: { name: 'Gruul / Magtheridon' }, masterData: { actors: WCL_ACTORS } },
            },
          },
        });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/requests') return send(res, 200, state.requests);
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
  const port = Number(args.port || env.FAKE_SOURCES_PORT || 8791);
  const fake = createFakeSources({ serverId: args['server-id'] || env.FAKE_SOURCES_SERVER_ID });
  fake.server.listen(port, '127.0.0.1', () => console.log(`fake Raid-Helper + Warcraft Logs on http://127.0.0.1:${port}`));
}

module.exports = { createFakeSources };
