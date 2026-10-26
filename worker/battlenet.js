// Battle.net OAuth and the two Blizzard API calls Phase 5 makes (the account's characters, a guild's roster). The fetch is injected
// (ctx.fetch); nothing here touches the database. The access token a member's OAuth code buys is used inside the callback and dropped.
//
// RESEARCH, 2026-10-17 (re-check before trusting a row; every fact here is one edit in the tables below if Blizzard changes it)
//   OAuth: authorize https://oauth.battle.net/authorize, token https://oauth.battle.net/token (POST, form body, client id + secret as HTTP
//     Basic), user info https://oauth.battle.net/userinfo (Bearer; answers { sub, id, battletag }; needs the `openid` scope and a token
//     from the authorization-code grant, a client-credentials token gets 403). Scopes: `openid` (account id + BattleTag), `wow.profile`
//     (the account's WoW characters). Access tokens live 24 hours (expires_in 86399) and the code flow gives no refresh token, so a
//     refresh means connecting again. Region is a host name, not a parameter: {us,eu,kr,tw}.api.blizzard.com (China has its own gateway, out of
//     scope). OAuth itself has one host for US/EU/APAC.
//       https://community.developer.battle.net/documentation/guides/using-oauth (dev portal is a script-rendered page: values above
//       cross-checked on https://us.forums.blizzard.com/en/blizzard/t/userinfo-endpoint-403/2756 and the portal's own
//       "try it now" oauth host setting, https://oauth.battle.net)
//   Account profile: GET https://{region}.api.blizzard.com/profile/user/wow?namespace={profile namespace}&locale=en_US with the member's token
//     (scope wow.profile) -> { wow_accounts: [{ id, characters: [{ character, protected_character, name, id, realm: { key, name, id, slug },
//     playable_class: { key, name, id }, playable_race, gender, faction, level }] }] }. playable_class/playable_race/gender/faction/level were added to
//     this endpoint in 2020 (data refreshes only after an account-wide log out of the game).
//       https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-api-patch-notes-20200303/3872/1
//       https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-api-update-visions-of-nzoth/3461 (first said "not available for Classic")
//     For Classic namespaces the community reports (EU only) say it works and lists characters: "I get all my characters for both Classic and
//     Classic1x namespaces" (2025-02), while the protected-character route 403s. Level may be absent on some characters, so level is optional here.
//       https://us.forums.blizzard.com/en/blizzard/t/403-404-classic-classic1x/53959
//       https://us.forums.blizzard.com/en/blizzard/t/classic-protected-character-profile-summary-returns-403/54512
//   Guild roster: GET https://{region}.api.blizzard.com/data/wow/guild/{realm slug}/{guild slug}/roster?namespace={profile namespace}&locale=en_US
//     with a client-credentials token (no member involved) -> { guild: { name, id, realm, faction }, members: [{ character: { name, id,
//     level, realm: { id, slug }, playable_class: { id }, playable_race: { id }, faction }, rank }] }. Seen live on Anniversary 2026-05-25
//     (rank 4, level 70, playable_class 9 = Warlock, realm slug "thunderstrike", namespace profile-classicann-eu).
//       https://us.forums.blizzard.com/en/blizzard/t/404-retrieving-character-profile-on-anniversary/58401
//     CAVEAT: this endpoint answered 403 for EXISTING guilds on Era and Anniversary from Sept 2024; Era was fixed 2025-01-31, Anniversary was
//     reported working again 2025-07-13 (Dreamscythe). A 403 here is treated as "Blizzard would not show this guild", not as our bug.
//       https://us.forums.blizzard.com/en/blizzard/t/403-forbidden-guild-api/52667
//       https://us.forums.blizzard.com/en/wow/t/era-guild-and-guild-roster-api-no-longer-works/1969144?page=3
//   Namespaces (profile family, region appended): TBC Anniversary and the other Anniversary realms -> profile-classicann-{region}; Classic Era
//     -> profile-classic1x-{region}; Cataclysm/MoP "Progression" -> profile-classic-{region} (not a Raidsmith version). Era's classic1x
//     naming is Blizzard's own (Korakk, 2021-06-08, https://us.forums.blizzard.com/en/blizzard/t/wow-classic-era-realm-apis/16812); classicann
//     is the third-party-confirmed name (https://gist.github.com/branneman/684767197dc50b932e6f4a6ba38b3bf2, the 2026-05 forum thread above,
//     and https://github.com/aechavarris/wow-roster/pull/6, 2026-10, which also maps Forever to "none yet").
//   WoW Forever (launch 2026-11-04): NO documented API namespace. Forum threads of 2026-09-18/29 ask and get no Blizzard answer ("Blizzard has
//     never provided an API for beta or PTR"). Raidsmith therefore shows "Battle.net doesn't offer character data for WoW Forever yet" and
//     changes nothing else: to switch it on, set `profile` for `forever` in NAMESPACES below once Blizzard publishes the name.
//       https://us.forums.blizzard.com/en/blizzard/t/world-of-warcraft-forever-api-namespace/59774
//       https://us.forums.blizzard.com/en/blizzard/t/when-will-we-gain-api-access-to-forever-apis/59595
//   IDENTITY PROBE (P0, 2026-10-25, Vindicated): IDS MATCH. The account profile and the guild roster name a character with the SAME numbers: 4 of 4
//     characters had equal character ids and equal realm ids in both, the roster held 506 members and every one carried an integer character.id and
//     realm.id, and the roster's guild.id equals the guild id on a character profile. So the identity key (namespace, realm id, character id) is the
//     same fact from both endpoints: account profile entry `id` + `realm.id`, roster member `character.id` + `character.realm.id`. The response also
//     carries the guild's own ids (`guild.id`, `guild.realm.id`); a pinned guild's fetch must match both (worker/roster-sync.js).
//   Class ids (playable class): 1 Warrior, 2 Paladin, 3 Hunter, 4 Rogue, 5 Priest, 6 Death Knight, 7 Shaman, 8 Mage, 9 Warlock, 10 Monk,
//     11 Druid, 12 Demon Hunter, 13 Evoker (https://warcraft.wiki.gg/wiki/ClassId). Only the nine TBC classes map; others are dropped.
//   Slugs: realm slug = lower case, spaces to hyphens, apostrophes dropped ("Sul'thraze" -> sulthraze, "Dragon's Call" -> dragons-call,
//     "Old Blanchy" -> old-blanchy; ASCII even for Russian/Korean/Taiwanese realms, e.g. chromie, shimmering-flats). Guild slug: the guild name
//     lower-cased with spaces to hyphens (/data/wow/guild/thunderstrike/dah-boo/roster for "Dah Boo"); letters outside a-z are kept.
//   Terms: stored Blizzard data must be refreshed or deleted within 30 days, and deleted when the person disconnects (plan section 11).
import { HttpError } from './http.js';
import { nameKey } from './roster-data.js';
import { fetchWithTimeout, readCapped } from './sources.js';

const LOCAL_BASE = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/;
const OAUTH_HOST = 'https://oauth.battle.net';
const SCOPE = 'openid wow.profile';
const SMALL_BODY = 64 * 1024;
const ROSTER_BODY = 2 * 1024 * 1024;
const PROFILE_BODY = 1024 * 1024;
const MAX_CHARACTERS = 300;
const MAX_MEMBERS = 1200;

// One row per Raidsmith game version. `profile` is the namespace family (null = Battle.net has no API for it yet); `label` is the
// version's name in messages. This table is the only place the namespaces live.
export const NAMESPACES = {
  tbc: { label: 'TBC Anniversary', profile: 'profile-classicann' },
  classic: { label: 'Classic Era', profile: 'profile-classic1x' },
  forever: { label: 'WoW Forever', profile: null },
};

// Region key -> API host name part ({region}.api.blizzard.com).
export const API_REGIONS = { US: 'us', EU: 'eu', KR: 'kr', TW: 'tw' };

// Battle.net playable class id -> the roster's class id.
export const CLASS_BY_ID = {
  1: 'WARRIOR', 2: 'PALADIN', 3: 'HUNTER', 4: 'ROGUE', 5: 'PRIEST', 7: 'SHAMAN', 8: 'MAGE', 9: 'WARLOCK', 11: 'DRUID',
};

// -> { supported, label, namespace | null, message | null }. `namespace` includes the region ("profile-classicann-eu").
export function bnetSupport(gameVersion, region) {
  const row = Object.prototype.hasOwnProperty.call(NAMESPACES, gameVersion) ? NAMESPACES[gameVersion] : null;
  const label = row ? row.label : String(gameVersion);
  const host = Object.prototype.hasOwnProperty.call(API_REGIONS, region) ? API_REGIONS[region] : null;
  if (!row || !row.profile || !host) {
    return { supported: false, label, namespace: null, message: `Battle.net doesn't offer character data for ${label} yet.` };
  }
  return { supported: true, label, namespace: `${row.profile}-${host}`, message: null };
}

// BNET_API_BASE (OAuth and API in one place) is honoured only for a local fake (http://localhost:<port>), like DISCORD_API_BASE.
function localBase(env) {
  const raw = typeof env.BNET_API_BASE === 'string' ? env.BNET_API_BASE.trim().replace(/\/+$/, '') : '';
  return LOCAL_BASE.test(raw) ? raw : null;
}

const oauthUrl = (env, path) => `${localBase(env) || OAUTH_HOST}${path}`;
const apiUrl = (env, region, path) => `${localBase(env) || `https://${API_REGIONS[region]}.api.blizzard.com`}${path}`;

export function redirectUri(env) {
  try {
    return new URL(env.BNET_REDIRECT_URI).toString();
  } catch {
    return null;
  }
}

// The origin the link must run on (the sign-in cookies are host-bound), taken from BNET_REDIRECT_URI.
export function canonicalOrigin(env) {
  try {
    return new URL(env.BNET_REDIRECT_URI).origin;
  } catch {
    return null;
  }
}

export function isConfigured(env) {
  return !!(env.BNET_CLIENT_ID && env.BNET_CLIENT_SECRET && canonicalOrigin(env));
}

// FRESH-AUTH (worker/fresh.js) and FORCED RE-AUTHENTICATION. Battle.net's OAuth documentation (develop.battle.net, "Authorization code flow") lists no parameter that makes
// the /authorize step ask for the password again (no `prompt`, no `max_age`, no `approval_prompt`), and the OpenID discovery document at oauth.battle.net publishes no
// prompt_values_supported; the lane could not verify one, and an unknown parameter might be rejected by Blizzard, so NONE is sent (FRESH_AUTHORIZE_PARAMS is empty on purpose:
// a verified parameter is added there and nowhere else). The guarantee is therefore weaker than "the password was typed just now": the callback proves that the browser
// that started the fresh-auth (the state cookie and the MAC'd state bound to the user and session) came back from Blizzard within 10 minutes holding the Battle.net account that is
// linked to the signed-in account, so a session stolen WITHOUT the owner's live Battle.net login cannot pass it, but a browser that still has a Blizzard login cookie passes
// without a prompt. That is why hand-over and guild delete also accept Discord (prompt=consent, worker/discord.js) and why identity-change protection (worker/fresh.js) exists.
export const FRESH_AUTHORIZE_PARAMS = Object.freeze({});

export function authorizeUrl(env, state, { fresh = false } = {}) {
  const query = new URLSearchParams({
    client_id: env.BNET_CLIENT_ID,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: SCOPE,
    state,
    ...(fresh ? FRESH_AUTHORIZE_PARAMS : {}),
  });
  return `${oauthUrl(env, '/authorize')}?${query}`;
}

const basic = (env) => `Basic ${btoa(`${env.BNET_CLIENT_ID}:${env.BNET_CLIENT_SECRET}`)}`;

export class BnetError extends Error {
  // kind: 'denied' (401/403), 'not_found' (404), 'unavailable' (anything else). status: the HTTP status Blizzard answered with, when there was one.
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

const down = (what) => () => new BnetError('unavailable', `${what} did not answer`);

async function readJson(response, maxBytes, what) {
  let text;
  try { text = await readCapped(response, maxBytes); } catch { throw new BnetError('unavailable', `${what} broke off`); }
  if (text === null) throw new BnetError('unavailable', `${what} was too large`);
  try { return JSON.parse(text); } catch { throw new BnetError('unavailable', `${what} was not JSON`); }
}

function statusError(response, what) {
  if (response.status === 401 || response.status === 403) return new BnetError('denied', `${what} refused (${response.status})`, response.status);
  if (response.status === 404) return new BnetError('not_found', `${what} not found`, response.status);
  return new BnetError('unavailable', `${what} failed (${response.status})`, response.status);
}

// The member's OAuth code -> an access token. Throws a BnetError.
export async function exchangeCode(ctx, code) {
  const response = await fetchWithTimeout(ctx, oauthUrl(ctx.env, '/token'), {
    method: 'POST',
    headers: { Authorization: basic(ctx.env), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(ctx.env) }).toString(),
  }, down('the token endpoint'));
  if (!response.ok) throw statusError(response, 'token exchange');
  const body = await readJson(response, SMALL_BODY, 'the token answer');
  if (!body || typeof body.access_token !== 'string' || !body.access_token) throw new BnetError('unavailable', 'no access token');
  return body.access_token;
}

// -> { id (digits), battletag }.
export async function fetchUserInfo(ctx, accessToken) {
  const response = await fetchWithTimeout(ctx, oauthUrl(ctx.env, '/userinfo'), {
    method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  }, down('user info'));
  if (!response.ok) throw statusError(response, 'user info');
  const body = await readJson(response, SMALL_BODY, 'user info');
  const id = body && (body.id ?? body.sub);
  const battletag = body && typeof body.battletag === 'string' ? body.battletag.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim() : '';
  if (!/^\d{1,20}$/.test(String(id)) || !battletag || battletag.length > 64) throw new BnetError('unavailable', 'unexpected user info');
  return { id: String(id), battletag };
}

const lines = (value, max) => Array.from(String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, max).join('');

// Realm slugs are ASCII; anything else in a slug is refused (it goes into a URL path).
const REALM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isRealmSlug = (value) => typeof value === 'string' && value.length <= 50 && REALM_SLUG.test(value);

// "Sul'thraze" -> "sulthraze"; "Old Blanchy" -> "old-blanchy". Letters and digits only, in lower case; a result that is not an ASCII
// realm slug is returned as ''. For a guild name use guildSlug.
export function realmSlugOf(name) {
  if (typeof name !== 'string') return '';
  const slug = name.normalize('NFC').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return isRealmSlug(slug) ? slug : '';
}

// A guild name -> its URL slug: lower case, apostrophes dropped, runs of anything but letters and digits become one hyphen.
export function guildSlug(name) {
  if (typeof name !== 'string') return '';
  const slug = name.normalize('NFC').toLowerCase().replace(/['\u2019]/g, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return Array.from(slug).length <= 60 ? slug : '';
}

function levelOf(value) {
  const level = Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 100 ? level : null;
}

function slugOf(realm) {
  return realm && typeof realm.slug === 'string' && isRealmSlug(realm.slug) ? realm.slug : null;
}

const positiveInteger = (value) => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null);

// The account's characters in one profile namespace -> [{ name, realmName | null, realmSlug, class, level | null, characterId | null, realmId | null,
// namespace }] (the nine classes only). characterId + realmId + namespace are the identity key (the same numbers as the guild roster, see the P0
// note in the header); null when Blizzard sent no usable id. The existing callers read only the first five fields.
export async function fetchAccountCharacters(ctx, accessToken, region, namespace) {
  if (!Object.prototype.hasOwnProperty.call(API_REGIONS, region)) throw new Error('fetchAccountCharacters needs a known region');
  const query = new URLSearchParams({ namespace, locale: 'en_US' });
  const response = await fetchWithTimeout(ctx, apiUrl(ctx.env, region, `/profile/user/wow?${query}`), {
    method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  }, down('the account profile'));
  if (response.status === 404) return [];
  if (!response.ok) throw statusError(response, 'the account profile');
  const body = await readJson(response, PROFILE_BODY, 'the account profile');
  const accounts = body && Array.isArray(body.wow_accounts) ? body.wow_accounts : null;
  if (!accounts) throw new BnetError('unavailable', 'unexpected account profile');
  const seen = new Set();
  const out = [];
  for (const account of accounts) {
    for (const entry of account && Array.isArray(account.characters) ? account.characters : []) {
      if (!entry || typeof entry.name !== 'string') continue;
      const realmSlug = slugOf(entry.realm);
      const classId = entry.playable_class ? CLASS_BY_ID[entry.playable_class.id] : undefined;
      if (!realmSlug || !classId) continue;
      const name = lines(entry.name, 12);
      const key = `${name.toLowerCase()}|${realmSlug}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({
        name, realmName: typeof entry.realm.name === 'string' && entry.realm.name.trim() ? lines(entry.realm.name, 40) : null,
        realmSlug, class: classId, level: levelOf(entry.level),
        characterId: positiveInteger(entry.id), realmId: positiveInteger(entry.realm.id), namespace,
      });
      if (out.length >= MAX_CHARACTERS) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guild roster (client credentials)

const clientTokens = new Map();

// Tests reset the module-level token cache.
export function resetBnetTokenCache() {
  clientTokens.clear();
}

async function clientToken(ctx, forceNew = false) {
  const cacheKey = `${ctx.env.BNET_CLIENT_ID}|${localBase(ctx.env) || ''}`;
  const cached = clientTokens.get(cacheKey);
  if (!forceNew && cached && cached.expiresAt > ctx.now()) return cached.token;
  const response = await fetchWithTimeout(ctx, oauthUrl(ctx.env, '/token'), {
    method: 'POST',
    headers: { Authorization: basic(ctx.env), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials',
  }, down('the token endpoint'));
  if (!response.ok) throw statusError(response, 'client token');
  const body = await readJson(response, SMALL_BODY, 'the token answer');
  if (!body || typeof body.access_token !== 'string' || !body.access_token) throw new BnetError('unavailable', 'no access token');
  const lifetime = Number(body.expires_in);
  const seconds = Number.isFinite(lifetime) ? Math.min(Math.max(lifetime - 120, 0), 6 * 3600) : 0;
  clientTokens.set(cacheKey, { token: body.access_token, expiresAt: ctx.now() + seconds * 1000 });
  return body.access_token;
}

async function rosterRequest(ctx, region, path, token) {
  return fetchWithTimeout(ctx, apiUrl(ctx.env, region, path), {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  }, down('the guild roster'));
}

// ---------------------------------------------------------------------------
// The fetch contract. fetchGuildRoster / fetchGuildRosterBySlug report what Blizzard SAID, row by row, without guessing: a value that is not what the
// contract names is counted in `problems`, never coerced (the old `Number(entry.rank)` turned a null rank into rank 0) and never dropped without a
// trace (the old loop skipped bad rows and cut the list at MAX_MEMBERS silently). assessRoster() then decides GOOD; only a GOOD roster may replace
// the stored one (worker/roster-sync.js).
//
// -> { membersPresent, guildName, guildId | null, guildRealmId | null, namespace, truncated, entries, members, nonTbc, problems }
//   members: [{ characterId, realmId, namespace, name, nameKey, realmSlug, class, level | null, rank }]   (the nine classes, every field valid)
//   truncated: the response listed more than MAX_MEMBERS members and only the first MAX_MEMBERS were read
//   entries: how many members the response listed; nonTbc: rows left out for a class the roster does not know (the only allowed rejection)
//   problems: { <kind>: count } for every other row that was left out (kinds: shape, class, rank, ids, realm, name, duplicate_id, duplicate_name)

export const ROSTER_FETCH_LIMIT = MAX_MEMBERS;
const MAX_RANK = 9;

// 'tbc' (one of the nine), 'other' (a real class id the roster does not know, e.g. Death Knight), null (no usable class id).
function classOf(character) {
  const id = character.playable_class && character.playable_class.id;
  if (positiveInteger(id) === null) return { kind: null };
  return CLASS_BY_ID[id] ? { kind: 'tbc', classId: CLASS_BY_ID[id] } : { kind: 'other' };
}

// One roster entry -> { member } | { skip: 'class' } | { problem: kind }. The class is judged first: a class the roster does not know is never a problem.
function readRosterEntry(entry, namespace) {
  const character = entry && typeof entry === 'object' ? entry.character : null;
  if (!character || typeof character !== 'object') return { problem: 'shape' };
  const cls = classOf(character);
  if (cls.kind === 'other') return { skip: 'class' };
  if (cls.kind === null) return { problem: 'class' };
  const rank = entry.rank;
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0 || rank > MAX_RANK) return { problem: 'rank' };
  const characterId = positiveInteger(character.id);
  const realmId = character.realm && typeof character.realm === 'object' ? positiveInteger(character.realm.id) : null;
  if (characterId === null || realmId === null) return { problem: 'ids' };
  const realmSlug = slugOf(character.realm);
  if (!realmSlug) return { problem: 'realm' };
  const name = typeof character.name === 'string' ? lines(character.name, 12) : '';
  if (!name) return { problem: 'name' };
  return { member: { characterId, realmId, namespace, name, nameKey: nameKey(name), realmSlug, class: cls.classId, level: levelOf(character.level), rank } };
}

// The parsed body of a 200 answer (pure: the tests feed it fixtures).
export function parseGuildRoster(body, namespace, fallbackName = '') {
  const membersPresent = !!body && Array.isArray(body.members);
  const guild = body && typeof body.guild === 'object' && body.guild ? body.guild : {};
  const named = typeof guild.name === 'string' ? lines(guild.name, 32) : '';
  const result = {
    membersPresent,
    guildName: named || String(fallbackName),
    guildId: positiveInteger(guild.id),
    guildRealmId: guild.realm && typeof guild.realm === 'object' ? positiveInteger(guild.realm.id) : null,
    namespace,
    truncated: false,
    entries: membersPresent ? body.members.length : 0,
    members: [],
    nonTbc: 0,
    problems: {},
  };
  if (!membersPresent) return result;
  result.truncated = body.members.length > MAX_MEMBERS;
  const problem = (kind) => { result.problems[kind] = (result.problems[kind] || 0) + 1; };
  const ids = new Set();
  const names = new Set();
  for (const entry of body.members.slice(0, MAX_MEMBERS)) {
    const read = readRosterEntry(entry, namespace);
    if (read.skip) { result.nonTbc += 1; continue; }
    if (read.problem) { problem(read.problem); continue; }
    const { member } = read;
    const idKey = `${member.realmId}:${member.characterId}`;
    const nameSlot = `${member.nameKey}|${member.realmSlug}`;
    if (ids.has(idKey)) { problem('duplicate_id'); continue; }
    if (names.has(nameSlot)) { problem('duplicate_name'); continue; }
    ids.add(idKey);
    names.add(nameSlot);
    result.members.push(member);
  }
  return result;
}

// GOOD = the roster may replace the stored one. -> { good: true } | { good: false, reason }. `pin` is { guildId, realmId } (a pinned guild: the response
// must name exactly that Blizzard guild and realm) or null (an unpinned legacy guild's officer import: no pin to compare with, every other rule holds).
export function assessRoster(roster, pin = null) {
  const bad = (reason) => ({ good: false, reason });
  if (!roster.membersPresent) return bad('members_missing');
  if (pin) {
    if (roster.guildId !== pin.guildId) return bad('guild_id_mismatch');
    if (roster.guildRealmId !== pin.realmId) return bad('realm_id_mismatch');
  }
  if (roster.truncated) return bad('truncated');
  const kind = Object.keys(roster.problems).sort()[0];
  if (kind) return bad(kind.startsWith('duplicate_') ? kind : `${kind}_invalid`);
  const leaders = roster.members.filter((member) => member.rank === 0).length;
  if (leaders === 0) return bad('no_rank_zero');
  if (leaders > 1) return bad('several_rank_zero');
  return { good: true };
}

// One roster fetch by the guild's URL slug (a pinned guild: the stored slug, never derived from a display name). Throws a BnetError for a refused,
// missing or broken answer; a 200 answer is parsed, and assessRoster() decides whether it is good.
export async function fetchGuildRosterBySlug(ctx, region, namespace, realmSlug, slug, fallbackName = '') {
  if (!Object.prototype.hasOwnProperty.call(API_REGIONS, region) || !isRealmSlug(realmSlug)) throw new Error('fetchGuildRoster needs a known region and a realm slug');
  if (typeof slug !== 'string' || !slug) throw new BnetError('not_found', 'no guild name');
  const query = new URLSearchParams({ namespace, locale: 'en_US' });
  const path = `/data/wow/guild/${realmSlug}/${encodeURIComponent(slug)}/roster?${query}`;
  let response = await rosterRequest(ctx, region, path, await clientToken(ctx));
  if (response.status === 401) response = await rosterRequest(ctx, region, path, await clientToken(ctx, true));
  if (!response.ok) throw statusError(response, 'the guild roster');
  const body = await readJson(response, ROSTER_BODY, 'the guild roster');
  return parseGuildRoster(body, namespace, fallbackName || slug);
}

// The same fetch for an unpinned guild, whose in-game name an officer typed (the officer roster import).
export async function fetchGuildRoster(ctx, region, namespace, realmSlug, guildName) {
  const slug = guildSlug(guildName);
  if (!slug) throw new BnetError('not_found', 'no guild name');
  return fetchGuildRosterBySlug(ctx, region, namespace, realmSlug, slug, guildName);
}

// The HttpError for a roster Blizzard answered but that is not GOOD (assessRoster's reason): the officer import refuses it rather than trust it.
export function rosterInvalidHttpError(reason) {
  return new HttpError(502, 'bnet_roster_invalid', 'Battle.net sent a guild roster that looks incomplete or inconsistent, so nothing was read from it. Try again later.', { reason });
}

// The HttpError a roster failure becomes (the roster routes' response to the officer).
export function rosterHttpError(error) {
  if (!(error instanceof BnetError)) return error;
  if (error.kind === 'not_found') return new HttpError(404, 'bnet_guild_not_found', 'Battle.net has no guild with that name on that realm. Check the guild name and realm in Guild settings > Battle.net.');
  if (error.kind === 'denied') return new HttpError(502, 'bnet_guild_refused', 'Battle.net would not show this guild\'s roster. Blizzard has had this fault on some realms before; try again later.');
  return new HttpError(502, 'bnet_unavailable', 'Battle.net did not answer. Try again in a moment.');
}
