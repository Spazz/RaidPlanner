import { guestIdentityStatement, guestKeysFor } from './guest-identity.js';
// Loot I/O: the policy rows and resolver, the viewer's access to a team's loot, the match of an award's winner to a character,
// a guest or nobody (done on READ, so linking a name fixes past awards), and the award view every loot route answers with.
// The pure modules (loot-policy / loot-import / loot-metrics) never see the database.
import { displayCharacter, groupBy } from './attendance-view.js';
import { isPlainObject } from './attendance-store.js';
import { resolveLootPolicy } from './loot-policy.js';
import { ownPersonStatement } from './membership.js';
import { allows } from './permissions.js';

// The newest awards a team-wide list reads (By raid, By item): a guard on the response size, far above a real team's history.
export const LOOT_LIST_CAP = 10000;

// ---------------------------------------------------------------------------
// Policy rows -> resolved policies

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function lootPolicyRowsStatement(db, guildId) {
  return db.prepare('SELECT id, team_id, policy, version FROM loot_policies WHERE guild_id = ?').bind(guildId);
}

// rows: loot_policies rows of one guild -> { overrides, versions, ids, resolved(teamId) }
export function makeLootPolicyResolver(rows) {
  const overrides = { guild: {}, teams: {} };
  const versions = { guild: 0, teams: {} };
  const ids = { guild: null, teams: {} };
  for (const row of rows) {
    const value = parseJson(row.policy, {});
    const override = isPlainObject(value) ? value : {};
    if (row.team_id) {
      overrides.teams[row.team_id] = override;
      versions.teams[row.team_id] = row.version;
      ids.teams[row.team_id] = row.id;
    } else {
      overrides.guild = override;
      versions.guild = row.version;
      ids.guild = row.id;
    }
  }
  const cache = new Map();
  return {
    overrides,
    versions,
    ids,
    resolved(teamId) {
      if (!cache.has(teamId)) cache.set(teamId, resolveLootPolicy(overrides.guild, overrides.teams[teamId] || {}));
      return cache.get(teamId);
    },
  };
}

// ---------------------------------------------------------------------------
// Access

// What the viewer may see of a team's loot: { canEdit, level }. level 'full' = every award of the team, 'own' = only awards to
// the viewer's own person, 'none' = nothing. An editor of the team sees all; everyone else follows the team's resolved
// visibility.members: guild -> every team, ownTeams -> the teams in their loot.view grant (own teams), own -> their own loot.
export function lootAccess(guildContext, resolver, teamId) {
  const canEdit = allows(guildContext.can, 'loot.edit', teamId);
  if (canEdit) return { canEdit, level: 'full' };
  const members = resolver.resolved(teamId).visibility.members;
  if (members === 'guild') return { canEdit, level: 'full' };
  if (members === 'ownTeams') return { canEdit, level: allows(guildContext.can, 'loot.view', teamId) ? 'full' : 'none' };
  return { canEdit, level: 'own' };
}

// The person who is the signed-in user's (linked to the account, or carrying its Discord ID) is resolved in worker/membership.js.
export { ownPersonStatement };

// ---------------------------------------------------------------------------
// Awards and the match of their winners

// An award with its raid's date (the date every window and list uses).
export const AWARD_SELECT = `SELECT a.*, r.raid_on FROM loot_awards a JOIN raids r ON r.id = a.raid_id AND r.guild_id = a.guild_id`;

export const parseFlags = (text) => { const value = parseJson(text, []); return Array.isArray(value) ? value : []; };

const parseEdited = (text) => { const value = parseJson(text, []); return Array.isArray(value) ? value : []; };

const keyOf = (nameKeyValue, realmKeyValue) => `${nameKeyValue}|${realmKeyValue}`;

// Every character of every person who has a character named like one of these winners, and the guild's guests.
export function matchStatements(db, guildId, nameKeys) {
  return [
    db.prepare(
      `SELECT player_id, id, name, name_key, realm_key, class, team_id, is_main FROM characters
        WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT value FROM json_each(?2)))`,
    ).bind(guildId, JSON.stringify([...new Set(nameKeys.filter((key) => key !== null))])),
    guestIdentityStatement(db, guildId),
  ];
}

// -> (award row) => { match, characterClass }. match is the contract's { kind, personId?, personName?, characterId?, characterName?, isMain? };
// the person is shown as their character on the award's team (the Main there, else any there, else their Main).
// An award with no winner (a disenchant: winner_name_key NULL) is { kind: 'disenchanted' }: no person, never unmatched.
export function makeMatcher(characterRows, guestRows) {
  const byKey = new Map(characterRows.map((row) => [keyOf(row.name_key, row.realm_key), row]));
  const byPlayer = groupBy(characterRows, 'player_id');
  const guestsByRaid = new Map();
  return (award) => {
    if (award.winner_name_key === null) return { match: { kind: 'disenchanted' }, characterClass: null };
    const key = keyOf(award.winner_name_key, award.winner_realm_key);
    const character = byKey.get(key);
    if (character) {
      const person = displayCharacter(byPlayer.get(character.player_id), award.team_id);
      return {
        match: {
          kind: 'character', personId: character.player_id, personName: person.name, characterId: character.id, characterName: character.name, isMain: character.is_main === 1,
        },
        characterClass: character.class,
      };
    }
    if (!guestsByRaid.has(award.raid_id)) guestsByRaid.set(award.raid_id, guestKeysFor(guestRows, award.raid_id));
    return { match: { kind: guestsByRaid.get(award.raid_id).has(key) ? 'guest' : 'unmatched' }, characterClass: null };
  };
}

// The matcher for these award rows: one batch.
export async function loadMatcher(db, guildId, awardRows) {
  if (!awardRows.length) return makeMatcher([], []);
  const [characterResult, guestResult] = await db.batch(matchStatements(db, guildId, awardRows.map((row) => row.winner_name_key)));
  return makeMatcher(characterResult.results, guestResult.results);
}

// The contract's award view A. matched: what makeMatcher's function answered for the row.
export function awardView(row, matched) {
  return {
    id: row.id,
    raidId: row.raid_id,
    raidOn: row.raid_on,
    teamId: row.team_id,
    itemId: row.item_id,
    itemName: row.item_name,
    quality: row.item_quality,
    awardedAt: row.awarded_at,
    winner: { name: row.winner_name, realm: row.winner_realm, class: row.winner_class || matched.characterClass },
    match: matched.match,
    tag: row.tag,
    tagSetBy: row.tag_set_at === null ? null : 'officer',
    flags: parseFlags(row.flags),
    rollType: row.roll_type,
    note: row.note,
    awardedBy: row.awarded_by,
    updatedAt: row.updated_at,                              // the version a PATCH must send back (409 stale when someone saved since)
    editedFields: parseEdited(row.edited_fields),           // which of winner / item / raid an officer corrected by hand
    ...(row.manual === 1 ? { manual: true } : {}), // made by hand (PM wave 5); the key is only there then
  };
}

// The views of these rows, in order.
export async function viewAwards(db, guildId, awardRows) {
  const matcher = await loadMatcher(db, guildId, awardRows);
  return awardRows.map((row) => awardView(row, matcher(row)));
}
