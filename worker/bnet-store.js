// Battle.net data: the settings a guild keeps, the snapshot a member's link keeps, and the plan an officer's approval of a character claim
// would carry out. D1 I/O only; the Blizzard calls are in battlenet.js.
import { isOwnPlayer, memberSql } from './membership.js';
import { REALMS } from './realms.js';

// Blizzard's terms: stored Battle.net data is refreshed or deleted within 30 days.
export const DATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RANK_COUNT = 10;
export const MAX_RANK_LABEL = 24;
// Characters one request may claim.
export const CLAIM_BATCH_MAX = 10;

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function parseSnapshot(text) {
  const value = parseJson(text, {});
  return isPlainObject(value) ? value : {};
}

// ten strings, '' for a rank with no label
export function parseRankLabels(text) {
  const value = parseJson(text, []);
  const list = Array.isArray(value) ? value : [];
  return Array.from({ length: RANK_COUNT }, (_, i) => (typeof list[i] === 'string' ? list[i] : ''));
}

// Battle.net gives rank numbers only: 0 is the guild master, the rest are whatever the guild named them.
export function rankLabelOf(labels, rank) {
  if (labels[rank]) return labels[rank];
  return rank === 0 ? 'Guild Master' : `Rank ${rank}`;
}

export async function loadBnetSettings(db, guildId) {
  const row = await db.prepare('SELECT bnet_guild_name, bnet_realm_slug, bnet_rank_labels FROM guilds WHERE id = ?').bind(guildId).first();
  return {
    guildName: row ? row.bnet_guild_name : null,
    realmSlug: row ? row.bnet_realm_slug : null,
    rankLabels: parseRankLabels(row ? row.bnet_rank_labels : '[]'),
  };
}

// The realm a Battle.net slug names, for a game version and region: the realms list, else the API's own name, else the slug in words.
export function realmDisplayName(gameVersion, region, slug, apiName) {
  const list = REALMS[gameVersion] && REALMS[gameVersion][region];
  const listed = Array.isArray(list) ? list.find((realm) => realm.slug === slug) : null;
  if (listed) return listed.name;
  if (typeof apiName === 'string' && apiName) return apiName;
  return slug.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// The guilds a person belongs to (worker/membership.js: in the guild's Discord server or linked to one of its people, and not blocked).
export async function loadMemberGuilds(db, userId) {
  const result = await db.prepare(
    `SELECT g.id, g.name, g.realm, g.realm_kind, g.realm_slug, g.region, g.game_version FROM guilds g, (SELECT ? AS uid) c
      WHERE ${memberSql('c.uid', 'g.id', 'g.discord_server_id')}
      ORDER BY g.name, g.id`,
  ).bind(userId).all();
  return result.results;
}

// ---------------------------------------------------------------------------
// Claims

// What approving a pending claim would do, decided from the roster as it is now.
//   add_alt      the claimant already has a person: the character joins them as an Alt (the officer picks the team)
//   new_person   the claimant has no person and the character is on no roster: a new person with it as Main (team and status picked)
//   link_person  the character is on a person nobody has linked yet and the claimant has no person: the claimant's Discord account links to that person
//   already      the character is already on the claimant's own person: approving only closes the claim
//   blocked      cannot be approved: reason not_member | taken (on a person linked to someone else) | other_person (on an unlinked person, but the claimant has their own)
// claims: character_claims rows (user_id, name_key, realm_key). -> Map(claim id -> { kind, reason, person: { id, name } | null, homeTeamId, defaultTeamId })
export async function planClaims(db, guild, claims) {
  const plans = new Map();
  if (!claims.length) return plans;
  const userIds = JSON.stringify([...new Set(claims.map((claim) => claim.user_id))]);
  const names = JSON.stringify([...new Set(claims.map((claim) => claim.name_key))]);
  const [userResult, personResult, ownerResult] = await db.batch([
    db.prepare(
      `SELECT u.id, u.discord_id, ${memberSql('u.id', 'gc.gid', 'gc.sid')} AS member
         FROM users u, (SELECT ? AS gid, ? AS sid) gc WHERE u.id IN (SELECT value FROM json_each(?))`,
    ).bind(guild.id, guild.discord_server_id, userIds),
    // The claimants' own people: linked to the account, or carrying its Discord ID.
    db.prepare(
      `SELECT p.id, p.discord_user_id, p.user_id, m.name, m.team_id FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE p.guild_id = ? AND (p.user_id IN (SELECT value FROM json_each(?))
                                  OR p.discord_user_id IN (SELECT u.discord_id FROM users u WHERE u.id IN (SELECT value FROM json_each(?))))`,
    ).bind(guild.id, userIds, userIds),
    db.prepare(
      `SELECT c.name_key, c.realm_key, p.id AS player_id, p.discord_user_id, p.user_id, m.name AS main_name, m.team_id AS home_team_id
         FROM characters c JOIN players p ON p.id = c.player_id JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE c.guild_id = ? AND c.name_key IN (SELECT value FROM json_each(?))`,
    ).bind(guild.id, names),
  ]);
  const users = new Map(userResult.results.map((row) => [row.id, row]));
  const owners = new Map(ownerResult.results.map((row) => [`${row.name_key}|${row.realm_key}`, row]));
  for (const claim of claims) {
    const user = users.get(claim.user_id);
    const viewer = user ? { userId: user.id, discordId: user.discord_id } : null;
    const own = viewer ? personResult.results.find((row) => isOwnPlayer(row, viewer)) || null : null;
    const owner = owners.get(`${claim.name_key}|${claim.realm_key}`) || null;
    const blocked = (reason) => ({ kind: 'blocked', reason, person: owner ? { id: owner.player_id, name: owner.main_name } : null, homeTeamId: null, defaultTeamId: null });
    let plan;
    if (!user || user.member !== 1) plan = blocked('not_member');
    else if (owner && isOwnPlayer(owner, viewer)) {
      plan = { kind: 'already', reason: null, person: { id: owner.player_id, name: owner.main_name }, homeTeamId: owner.home_team_id, defaultTeamId: null };
    } else if (owner && (owner.discord_user_id || owner.user_id)) plan = blocked('taken');
    else if (owner && own) plan = blocked('other_person');
    else if (owner) {
      plan = { kind: 'link_person', reason: null, person: { id: owner.player_id, name: owner.main_name }, homeTeamId: owner.home_team_id, defaultTeamId: null };
    } else if (own) {
      plan = { kind: 'add_alt', reason: null, person: { id: own.id, name: own.name }, homeTeamId: own.team_id, defaultTeamId: own.team_id };
    } else {
      plan = { kind: 'new_person', reason: null, person: null, homeTeamId: null, defaultTeamId: null };
    }
    plans.set(claim.id, plan);
  }
  return plans;
}

export const CLAIM_BLOCKED_TEXT = {
  not_member: 'This person is no longer in the guild (they left its Discord server or were unlinked from the roster), so the claim cannot be approved.',
  taken: 'That character is already on a person linked to someone else. Reject the claim, or fix the roster first.',
  other_person: 'That character is on a person nobody has linked, but the claimant already has their own person. Merge them by hand on the roster, then reject this claim.',
};
