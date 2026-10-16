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
 *   report code Fake000000000001  a TBC report with players, a pet and a duplicate actor; as a raid log (query with `fights`) it has
 *                                 6 boss pulls, with Quillfeather missing the first pull and Mendra leaving before the last
 *   report code Fake000000000002  a second report of the same night (2 hours later, 2 pulls) with Wanderfell, a fill-in character
 *   report code Fake000000000003  an older night (one week earlier), for the backfill list
 *   report code Priv000000000001  answers a permission error
 *   anything else                 { report: null }
 *   A `reports(...)` query (the backfill list) answers the three reports above, two per page, owner "Fakeuploader" (the first) and
 *   "Otheruploader"; `guildName` / `guildID` are accepted but not checked.
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
  { id: 1, name: 'Thornwick', type: 'Player', subType: 'Warrior', server: 'Dreamscythe' },
  { id: 2, name: 'Pyrelo', type: 'Player', subType: 'Mage', server: 'Dreamscythe' },
  { id: 3, name: 'Mendra', type: 'Player', subType: 'Shaman', server: 'Dreamscythe' },
  { id: 4, name: 'Wanderfell', type: 'Player', subType: 'Druid', server: 'Nightslayer' },
  { id: 5, name: 'Embertail', type: 'Player', subType: 'Pet', server: null },
  { id: 6, name: 'Pyrelo', type: 'Player', subType: 'Mage', server: 'Dreamscythe' },
  { id: 7, name: 'Quillfeather', type: 'Player', subType: 'Hunter', server: 'Dreamscythe' },
];

// Fight offsets are ms from the report start, like Warcraft Logs. friendlyPlayers are actor ids.
function fight(id, name, encounterID, kill, start, seconds, players) {
  return { id, name, encounterID, kill, startTime: start, endTime: start + seconds * 1000, friendlyPlayers: players };
}
const FULL = [1, 2, 3, 5, 7];
const RAID_REPORTS = {
  Fake000000000001: {
    startTime: EVENT_START * 1000,
    endTime: EVENT_START * 1000 + 3 * 3600 * 1000,
    owner: { name: 'Fakeuploader' },
    zone: { name: 'Gruul / Magtheridon' },
    fights: [
      fight(1, 'Trash', 0, false, 0, 120, FULL),
      fight(2, 'High King Maulgar', 649, false, 300_000, 200, [1, 2, 3, 5]),
      fight(3, 'High King Maulgar', 649, true, 700_000, 240, FULL),
      fight(4, 'Gruul the Dragonkiller', 650, false, 1_200_000, 150, FULL),
      fight(5, 'Gruul the Dragonkiller', 650, true, 1_600_000, 300, FULL),
      fight(6, 'Magtheridon', 651, null, 2_400_000, 90, FULL),
      fight(7, 'Magtheridon', 651, false, 2_600_000, 220, [1, 2, 5, 7]),
    ],
  },
  Fake000000000002: {
    startTime: (EVENT_START + 2 * 3600) * 1000,
    endTime: (EVENT_START + 3 * 3600) * 1000,
    owner: { name: 'Fakeuploader' },
    zone: { name: 'Gruul / Magtheridon' },
    fights: [fight(1, 'Magtheridon', 651, true, 60_000, 260, [1, 2, 3, 4, 5, 7])],
  },
  Fake000000000003: {
    startTime: (EVENT_START - 7 * 86_400) * 1000,
    endTime: (EVENT_START - 7 * 86_400 + 3600) * 1000,
    owner: { name: 'Otheruploader' },
    zone: { name: 'Karazhan' },
    fights: [fight(1, 'Attumen the Huntsman', 652, true, 30_000, 180, FULL)],
  },
};
const REPORT_LIST = ['Fake000000000001', 'Fake000000000002', 'Fake000000000003'];

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
        const query = String(payload && payload.query);
        if (/reports\s*\(/.test(query)) {
          const page = Number(payload.variables && payload.variables.page) || 1;
          const codes = REPORT_LIST.slice((page - 1) * 2, page * 2);
          return send(res, 200, { data: { reportData: { reports: {
            data: codes.map((id) => ({ code: id, title: `Fake report ${id.slice(-1)}`, startTime: RAID_REPORTS[id].startTime, endTime: RAID_REPORTS[id].endTime,
              zone: RAID_REPORTS[id].zone, owner: RAID_REPORTS[id].owner })),
            has_more_pages: page * 2 < REPORT_LIST.length,
          } } } });
        }
        if (RAID_REPORTS[code] && /fights/.test(query)) {
          const raid = RAID_REPORTS[code];
          // Quillfeather (7) is late to Maulgar's first pull; Mendra (3) is gone for the last Magtheridon pull.
          const fights = raid.fights.map((entry) => (entry.id === 2 && code === 'Fake000000000001' ? { ...entry, friendlyPlayers: [1, 2, 3, 5] } : entry));
          return send(res, 200, { data: { reportData: { report: { ...raid, fights, masterData: { actors: WCL_ACTORS } } } } });
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
