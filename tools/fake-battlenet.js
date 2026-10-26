#!/usr/bin/env node
/**
 * A local fake of Battle.net's OAuth and the two Blizzard API calls Raidsmith makes, for the browser check. Everything it serves is
 * invented (no real BattleTags, characters or guilds). OAuth and the API share one port, like BNET_API_BASE expects.
 *   node tools/fake-battlenet.js [--port 8792] [--account-id 123456789] [--battletag "Tester#1234"]
 * Environment fallbacks: FAKE_BATTLENET_PORT, FAKE_BATTLENET_ACCOUNT_ID, FAKE_BATTLENET_BATTLETAG.
 *
 * Point the Worker at it with: npm run guild:dev -- --var BNET_API_BASE:http://127.0.0.1:8792
 *   plus --var BNET_CLIENT_ID:x --var BNET_CLIENT_SECRET:y --var BNET_REDIRECT_URI:http://localhost:<port>/auth/bnet/callback (any values; the fake accepts anything).
 *
 * Routes (the real ones' shapes):
 *   GET  /authorize                    -> 302 to redirect_uri with ?code= and the state (add &deny=1 to the fake's URL via /__fake/set?deny=1 to answer access_denied)
 *   POST /token                        -> authorization_code (needs a code) or client_credentials; both need HTTP Basic client credentials; { access_token, expires_in: 86399 }
 *   GET  /userinfo                     -> { sub, id, battletag } for a member token; 403 for a client-credentials token
 *   GET  /profile/user/wow?namespace=  -> { wow_accounts: [{ id, characters }] }; member token only.
 *        profile-classicann-{us,eu}    TBC Anniversary characters (US: Dreamscythe / Nightslayer, EU: Thunderstrike / Spineshatter)
 *        profile-classic1x-{us,eu}     Classic Era characters;  any other namespace answers 404 like Blizzard
 *   GET  /data/wow/guild/:realm/:guild/roster?namespace=
 *                                      -> { guild, members: [{ character, rank }] } for ANY realm and guild, so a guild created for the check just works,
 *                                         except the guild slugs "missing" (404) and "refused" (403, the fault Blizzard had on Anniversary). A member and client token both work.
 *                                         The members live on the requested realm, bar one on a realm no Raidsmith list has (the "other realm" row).
 *   GET  /__fake/set?id=&battletag=&deny=1|0   change the signed-in fake account (the next link uses it)
 *   GET  /__fake/requests              what was asked (method, path, namespace, token kind; never a token or a secret)
 * It listens on 127.0.0.1 only.
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

// Battle.net playable class ids: 1 Warrior, 2 Paladin, 3 Hunter, 4 Rogue, 5 Priest, 7 Shaman, 8 Mage, 9 Warlock, 11 Druid.
const REALMS = {
  us: [{ id: 4001, name: 'Dreamscythe', slug: 'dreamscythe' }, { id: 4002, name: 'Nightslayer', slug: 'nightslayer' }],
  eu: [{ id: 6409, name: 'Thunderstrike', slug: 'thunderstrike' }, { id: 6410, name: 'Spineshatter', slug: 'spineshatter' }],
};
const TBC_CHARACTERS = [
  // name, class id, level, realm index
  ['Aldric', 1, 70, 0], ['Brindle', 8, 70, 0], ['Cassia', 5, 68, 1], ['Dunmar', 3, 70, 0], ['Eliora', 2, 61, 0], ['Fenwick', 4, 12, 1],
  ['Galdor', 9, 70, 0], ['Quillfeather', 3, 70, 0],
];
const ERA_CHARACTERS = [['Aldric', 1, 60, 0], ['Hestia', 5, 60, 1], ['Ivarr', 7, 43, 0]];
// A character on a realm that is in no Raidsmith realm list.
const FAR_REALM = { id: 9999, name: 'Faraway Isle', slug: 'faraway-isle' };

const ROSTER = [
  // name, class id, level, rank
  ['Thornwick', 1, 70, 0], ['Pyrelo', 8, 70, 1], ['Mendra', 7, 70, 1], ['Quillfeather', 3, 70, 2], ['Lastcall', 4, 70, 2], ['Embertail', 11, 69, 2],
  ['Wanderfell', 11, 70, 3], ['Brewmaw', 11, 70, 3], ['Sunmark', 2, 70, 3], ['Lumenfall', 5, 70, 3], ['Ashgrove', 5, 64, 4], ['Zorgax', 9, 58, 4],
  ['Tinkerpop', 8, 22, 4], ['Newtooth', 4, 8, 4],
];

function characterEntry(name, classId, level, realm, id) {
  return {
    character: { key: { href: `https://x.invalid/profile/wow/character/${realm.slug}/${name.toLowerCase()}` }, name, id, realm: { key: { href: 'https://x.invalid/realm' }, id: realm.id, slug: realm.slug } },
    protected_character: { href: 'https://x.invalid/protected' },
    name,
    id,
    realm: { key: { href: 'https://x.invalid/realm' }, name: realm.name, id: realm.id, slug: realm.slug },
    playable_class: { key: { href: 'https://x.invalid/class' }, name: 'Class', id: classId },
    playable_race: { key: { href: 'https://x.invalid/race' }, name: 'Race', id: 1 },
    gender: { type: 'MALE', name: 'Male' },
    faction: { type: 'HORDE', name: 'Horde' },
    level,
  };
}

function createFakeBattlenet(options = {}) {
  const state = {
    account: { id: options.accountId || '123456789', battletag: options.battletag || 'Tester#1234' },
    deny: false,
    // The data it serves; a test (or you, in a node REPL) can replace any of these. Rows: [name, class id, level, realm index] and
    // [name, class id, level, rank, realm slug?] for the roster.
    data: { tbc: TBC_CHARACTERS.map((row) => row.slice()), era: ERA_CHARACTERS.map((row) => row.slice()), roster: ROSTER.map((row) => row.slice()), expiresIn: 86399 },
    // fail.<call> = an HTTP status makes that call answer with it (0 = no failure): token, userinfo, profile, roster.
    fail: { token: 0, userinfo: 0, profile: 0, roster: 0 },
    // override.profile / override.roster: a JSON body (or a function of { account, namespace } / { realmSlug, guildSlug, namespace } that returns one) served INSTEAD of the generated
    // answer, for a test that needs the account's characters and the guild's roster to name the same ids (the generated ones use 7000 + n and 8000 + n). Everything else (token
    // checks, the requests log) stays.
    override: { profile: null, roster: null },
    tokens: new Map(),
    requests: [],
    counter: 0,
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  async function readForm(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  const notFound = (res) => send(res, 404, { code: 404, type: 'BLZWEBAPI00000404', detail: 'Not Found' });
  const forbidden = (res) => send(res, 403, { code: 403, type: 'BLZWEBAPI00000403', detail: 'Forbidden' });

  function tokenOf(req) {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return match && state.tokens.has(match[1]) ? state.tokens.get(match[1]) : null;
  }

  function failed(res, which) {
    const status = state.fail[which];
    if (!status) return false;
    send(res, status, { code: status, type: `BLZWEBAPI0000${status}`, detail: 'Fake failure' });
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const token = tokenOf(req);
    if (!url.pathname.startsWith('/__fake/')) {
      state.requests.push({
        method: req.method, path: url.pathname, namespace: url.searchParams.get('namespace'),
        token: token ? token.kind : (req.headers.authorization ? (/^Basic /.test(req.headers.authorization) ? 'basic' : 'unknown') : 'none'),
      });
    }
    try {
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        if (!redirectUri || !url.searchParams.get('client_id')) return send(res, 400, { error: 'invalid_request' });
        const target = new URL(redirectUri);
        if (state.deny) target.searchParams.set('error', 'access_denied');
        else target.searchParams.set('code', `fakecode${++state.counter}`);
        if (url.searchParams.get('state')) target.searchParams.set('state', url.searchParams.get('state'));
        res.writeHead(302, { Location: target.toString() });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        if (failed(res, 'token')) return null;
        if (!/^Basic .+/.test(req.headers.authorization || '')) return send(res, 401, { error: 'invalid_client' });
        const form = await readForm(req);
        const grant = form.get('grant_type');
        let kind;
        if (grant === 'authorization_code' && form.get('code') && form.get('redirect_uri')) kind = 'member';
        else if (grant === 'client_credentials') kind = 'client';
        else return send(res, 400, { error: 'invalid_grant' });
        const value = `fake-${kind}-token-${++state.counter}`;
        state.tokens.set(value, { kind, account: { ...state.account } });
        return send(res, 200, { access_token: value, token_type: 'bearer', expires_in: state.data.expiresIn, ...(kind === 'member' ? { scope: 'openid wow.profile' } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/userinfo') {
        if (failed(res, 'userinfo')) return null;
        if (!token) return send(res, 401, { error: 'invalid_token' });
        if (token.kind !== 'member') return forbidden(res);
        return send(res, 200, { sub: token.account.id, id: Number(token.account.id), battletag: token.account.battletag });
      }
      if (req.method === 'GET' && url.pathname === '/profile/user/wow') {
        if (failed(res, 'profile')) return null;
        if (!token) return send(res, 401, { error: 'invalid_token' });
        if (token.kind !== 'member') return forbidden(res);
        const match = /^profile-(classicann|classic1x)-(us|eu)$/.exec(url.searchParams.get('namespace') || '');
        if (!match) return notFound(res);
        if (state.override.profile) {
          const body = typeof state.override.profile === 'function' ? state.override.profile({ account: token.account, namespace: url.searchParams.get('namespace') }) : state.override.profile;
          return send(res, 200, body);
        }
        const realms = REALMS[match[2]];
        const list = (match[1] === 'classicann' ? state.data.tbc : state.data.era).map(([name, classId, level, realm], i) => characterEntry(name, classId, level, realms[realm], 7000 + i));
        // One character the account owns on a realm no list names, and one of a class Raidsmith does not know (a Death Knight).
        list.push(characterEntry('Stranger', 8, 70, FAR_REALM, 7100), characterEntry('Gravewalk', 6, 70, realms[0], 7101));
        return send(res, 200, { id: Number(token.account.id), wow_accounts: [{ id: 555, characters: list }] });
      }
      const roster = /^\/data\/wow\/guild\/([^/]+)\/([^/]+)\/roster$/.exec(url.pathname);
      if (req.method === 'GET' && roster) {
        if (failed(res, 'roster')) return null;
        if (!token) return send(res, 401, { error: 'invalid_token' });
        if (!/^profile-(classicann|classic1x)-(us|eu|kr|tw)$/.test(url.searchParams.get('namespace') || '')) return notFound(res);
        const realmSlug = decodeURIComponent(roster[1]);
        const guildSlug = decodeURIComponent(roster[2]);
        if (guildSlug === 'missing') return notFound(res);
        if (guildSlug === 'refused') return forbidden(res);
        if (state.override.roster) {
          const body = typeof state.override.roster === 'function' ? state.override.roster({ realmSlug, guildSlug, namespace: url.searchParams.get('namespace') }) : state.override.roster;
          return send(res, 200, body);
        }
        const realm = { id: 4001, slug: realmSlug };
        const members = state.data.roster.map(([name, classId, level, rank, slug], i) => ({
          character: {
            key: { href: 'https://x.invalid/c' }, name, id: 8000 + i, realm: { key: { href: 'https://x.invalid/r' }, id: realm.id, slug: slug || realm.slug },
            level, playable_class: { key: { href: 'https://x.invalid/class' }, id: classId }, playable_race: { key: { href: 'https://x.invalid/race' }, id: 2 }, faction: { type: 'HORDE' },
          },
          rank,
        }));
        members.push({
          character: {
            name: 'Wayfarer', id: 8100, realm: { id: FAR_REALM.id, slug: FAR_REALM.slug }, level: 70, playable_class: { id: 3 }, playable_race: { id: 2 }, faction: { type: 'HORDE' },
          },
          rank: 4,
        });
        // A Death Knight cannot be in a TBC guild; it shows the class filter (Raidsmith drops the row).
        members.push({ character: { name: 'Gravewalk', id: 8101, realm: { id: realm.id, slug: realm.slug }, level: 70, playable_class: { id: 6 } }, rank: 5 });
        const guildName = guildSlug.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        return send(res, 200, { guild: { key: { href: 'https://x.invalid/g' }, name: guildName, id: 3000, realm: { id: realm.id, slug: realm.slug }, faction: { type: 'HORDE' } }, members });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/set') {
        if (url.searchParams.get('id')) state.account.id = url.searchParams.get('id');
        if (url.searchParams.get('battletag')) state.account.battletag = url.searchParams.get('battletag');
        if (url.searchParams.get('deny') !== null) state.deny = url.searchParams.get('deny') === '1';
        return send(res, 200, { account: state.account, deny: state.deny });
      }
      if (req.method === 'GET' && url.pathname === '/__fake/requests') return send(res, 200, state.requests);
      return notFound(res);
    } catch (error) {
      return send(res, 500, { message: String(error && error.message) });
    }
  });
  return { server, state };
}

if (require.main === module) {
  const args = readArgs(process.argv.slice(2));
  const env = process.env;
  const port = Number(args.port || env.FAKE_BATTLENET_PORT || 8792);
  const fake = createFakeBattlenet({
    accountId: args['account-id'] || env.FAKE_BATTLENET_ACCOUNT_ID,
    battletag: args.battletag || env.FAKE_BATTLENET_BATTLETAG,
  });
  fake.server.listen(port, '127.0.0.1', () => console.log(`fake Battle.net on http://127.0.0.1:${port} (account ${fake.state.account.id}, ${fake.state.account.battletag})`));
}

module.exports = { createFakeBattlenet, TBC_CHARACTERS, ERA_CHARACTERS, ROSTER };
