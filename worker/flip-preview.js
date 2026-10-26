// The flip dry run, membership part (user-hierarchy build, lane B5; plan "Dry run (flip)"). The flip (lane B9) switches a guild's rank_source to 'ingame', and with it
// the membership rule (worker/membership.js). Before anyone presses it, the Owner reads what that rule would do to the guild's accounts, set against the rule the guild
// runs today. The computation lives here, as a list of SECTIONS, so the lanes that add lines (B6b: rank changes, permission gains and losses, the Owner line; B9: the
// name-binding confirmations) push one more section instead of editing this one:
//
//   section = { key, statements(db, guildId) -> prepared statements (reads only),
//               build(results, ctx) -> { payload, hashPart } }
//     payload   what the response shows under `key`
//     hashPart  what the approval token covers: the FULL previewed lists (ids and reasons, not only the samples), so a change of who loses or gains access between the
//               dry run and the flip makes the token stale. Names are display only and never hashed.
//   previewFlip(db, guildId) runs every section's statements in ONE db.batch (one snapshot of the database) next to the guild row, and returns the payload, the state hash
//   ('flip:' + hash of every hashPart: the purpose prefix keeps a rank-map token from ever approving a flip, worker/dry-run.js) and the roster sync id the token binds to.
//
// The ACCESS section compares, per account, today's rule (the one memberSql applies now: the guild's current rank_source) with the 'ingame' rule as the flip would leave it.
// The flip first LINKS the persons that only a Discord ID owns (players.user_id NULL, the account whose users.discord_id equals players.discord_user_id; "Account of a
// person", todo.md), so the 'ingame' side is judged on the person each account would have after that link. An account that is blocked here is out of every list (a block wins
// in every source).
//   loses   today a member, not one after the flip. Reasons: discord_only (a member only through the Discord server: no person of the guild is theirs),
//           no_roster_character (their person has no character on the in-game roster; unkeyedCharacters counts the characters with no identity key yet, the ones
//           the flip's name binding could still match), all_former (every character of their person is Former)
//   gains   not a member today, one after the flip. Reasons: owner (the Owner exemption), discord_owned_person (their person is the one the flip links, and it is on the roster)
// The DISCORD-OWNED section lists the persons the flip would link, and whether the Owner's own person is one of them.
// Nothing returned carries a Discord ID or a BattleTag.
import { memberSql, personOnRosterSql, unsuspendedOwnerSql, blockedSql } from './membership.js';
import { serverIdIsDiscordSql } from './discord-guard.js';
import { ownerCandidatesSql } from './owner.js';
import { hashToken } from './session.js';
import { visibleCharacterSql } from './character-visibility.js';

export const FLIP_SAMPLES = 25;
export const FLIP_PURPOSE = 'flip';

const GUILD = '?1';
const SERVER = '(SELECT fg.discord_server_id FROM guilds fg WHERE fg.id = ?1)';
const MAIN_NAME = (personExpr) => `(SELECT fm.name FROM characters fm WHERE fm.player_id = ${personExpr} AND fm.is_main = 1)`;

// The accounts that matter to the flip, whatever the current source: the Discord server's members, everyone linked to a person, the accounts a Discord ID alone owns a
// person for, and the Owner candidates. Four terms (D1 allows five).
const UNIVERSE_SQL = `SELECT us.user_id FROM user_servers us WHERE us.server_id = ${SERVER} AND ${serverIdIsDiscordSql('us.server_id')}
   UNION SELECT lp.user_id FROM players lp WHERE lp.guild_id = ${GUILD} AND lp.user_id IS NOT NULL
   UNION SELECT du.id FROM players dp JOIN users du ON du.discord_id = dp.discord_user_id WHERE dp.guild_id = ${GUILD} AND dp.user_id IS NULL
   UNION SELECT user_id FROM (${ownerCandidatesSql(GUILD)})`;

// One row per account of the universe that is not blocked: what it is today, and what it would be after the flip.
const PERSON = 'COALESCE(b.linked_person, b.discord_person)';
const ACCOUNTS_CTE = `WITH base AS (
  SELECT u.id AS user_id, u.discord_id, u.display_name, u.global_name, u.username,
         ${memberSql('u.id', GUILD, SERVER)} AS today,
         ${unsuspendedOwnerSql('u.id', GUILD)} AS is_owner,
         (SELECT lp.id FROM players lp WHERE lp.guild_id = ${GUILD} AND lp.user_id = u.id) AS linked_person,
         (SELECT dp.id FROM players dp WHERE dp.guild_id = ${GUILD} AND dp.user_id IS NULL AND u.discord_id IS NOT NULL AND dp.discord_user_id = u.discord_id) AS discord_person
    FROM users u
   WHERE u.id IN (${UNIVERSE_SQL}) AND NOT ${blockedSql('u.id', GUILD)}
), acc AS (
  SELECT b.*, ${PERSON} AS person_id,
         CASE WHEN b.is_owner = 1 THEN 1
              WHEN ${PERSON} IS NOT NULL AND ${personOnRosterSql(PERSON, GUILD)} THEN 1
              ELSE 0 END AS after_member
    FROM base b
)`;

// loses / gains rows, every one (ids and reasons are hashed; the names are display only).
const ACCESS_ROWS_SQL = `${ACCOUNTS_CTE}
SELECT CASE WHEN a.today = 1 THEN 'loses' ELSE 'gains' END AS kind,
       CASE WHEN a.today = 1 THEN
              CASE WHEN a.person_id IS NULL THEN 'discord_only'
                   WHEN EXISTS (SELECT 1 FROM characters fc WHERE fc.player_id = a.person_id AND ${visibleCharacterSql('fc')})
                        AND NOT EXISTS (SELECT 1 FROM characters fc WHERE fc.player_id = a.person_id AND fc.left_on IS NULL AND ${visibleCharacterSql('fc')}) THEN 'all_former'
                   ELSE 'no_roster_character' END
            WHEN a.is_owner = 1 THEN 'owner'
            ELSE 'discord_owned_person' END AS reason,
       a.user_id, a.person_id,
       COALESCE(${MAIN_NAME('a.person_id')}, a.display_name, CASE WHEN a.discord_id IS NOT NULL THEN COALESCE(a.global_name, a.username) END) AS name,
       (SELECT COUNT(*) FROM characters fu WHERE fu.player_id = a.person_id AND fu.left_on IS NULL AND fu.blizzard_char_id IS NULL AND ${visibleCharacterSql('fu')}) AS unkeyed
  FROM acc a
 WHERE a.today != a.after_member
 ORDER BY kind, reason, name, a.user_id`;

const ACCESS_TOTALS_SQL = `${ACCOUNTS_CTE}
SELECT COALESCE(SUM(a.today), 0) AS today_members, COALESCE(SUM(a.after_member), 0) AS after_members FROM acc a`;

// The persons that only a Discord ID owns, and the account that ID belongs to. An account that already has another person of the guild cannot be linked to this one
// (players_guild_user is unique): it is counted as a conflict, not as a link.
const DISCORD_OWNED_SQL = `SELECT dp.id AS person_id, du.id AS user_id, ${personOnRosterSql('dp.id', GUILD)} AS on_roster,
       ${unsuspendedOwnerSql('du.id', GUILD)} AS is_owner,
       EXISTS (SELECT 1 FROM players xp WHERE xp.guild_id = ${GUILD} AND xp.user_id = du.id) AS conflict,
       ${MAIN_NAME('dp.id')} AS name
  FROM players dp JOIN users du ON du.discord_id = dp.discord_user_id
 WHERE dp.guild_id = ${GUILD} AND dp.user_id IS NULL AND NOT ${blockedSql('du.id', GUILD)}
 ORDER BY dp.id`;

const tally = (rows, key) => rows.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] || 0) + 1 }), {});

const accessSection = {
  key: 'access',
  statements: (db, guildId) => [db.prepare(ACCESS_ROWS_SQL).bind(guildId), db.prepare(ACCESS_TOTALS_SQL).bind(guildId)],
  build([rowResult, totalResult]) {
    const rows = rowResult.results;
    const list = (kind, label) => {
      const own = rows.filter((row) => row.kind === kind);
      return {
        count: own.length,
        reasons: tally(own, 'reason'),
        samples: own.slice(0, FLIP_SAMPLES).map((row) => ({
          reason: row.reason, userId: row.person_id ? undefined : row.user_id, personId: row.person_id, name: row.name,
          ...(kind === 'loses' ? { unkeyedCharacters: row.unkeyed } : {}),
        })),
        label,
      };
    };
    const totals = totalResult.results[0];
    const loses = list('loses', 'loses');
    const gains = list('gains', 'gains');
    // `label` was only a helper for the readers of this function; the payload does not carry it.
    delete loses.label;
    delete gains.label;
    const hash = (kind) => rows.filter((row) => row.kind === kind).map((row) => [row.user_id, row.person_id, row.reason]);
    return {
      payload: { members: { today: totals.today_members, afterFlip: totals.after_members }, loses, gains },
      hashPart: { loses: hash('loses'), gains: hash('gains') },
    };
  },
};

const discordOwnedSection = {
  key: 'discordOwned',
  statements: (db, guildId) => [db.prepare(DISCORD_OWNED_SQL).bind(guildId)],
  build([result]) {
    const rows = result.results;
    const linkable = rows.filter((row) => row.conflict !== 1);
    return {
      payload: {
        count: linkable.length,
        // The Owner's own person is one of them: the flip links it too (and the Owner then holds it by account, not by Discord ID).
        ownerIncluded: linkable.some((row) => row.is_owner === 1),
        conflicts: rows.length - linkable.length,
        onRoster: linkable.filter((row) => row.on_roster === 1).length,
        samples: linkable.slice(0, FLIP_SAMPLES).map((row) => ({ personId: row.person_id, name: row.name, onRoster: row.on_roster === 1 })),
      },
      hashPart: linkable.map((row) => [row.person_id, row.user_id]),
    };
  },
};

// The sections, in order. Lane B6b and lane B9 push theirs here.
export const FLIP_SECTIONS = [accessSection, discordOwnedSection];

// 'flip:' + the hash of the parts. The prefix is the purpose (worker/dry-run.js): a token minted here is never valid for a rank-map change, and the other way round.
export async function flipStateHash(hashParts) {
  return `${FLIP_PURPOSE}:${await hashToken(JSON.stringify(hashParts))}`;
}

const GUILD_ROW_SQL = 'SELECT id, rank_source, last_good_sync_id FROM guilds WHERE id = ?';

// -> { guild: { id, rankSource, rosterSyncId } | null, payload, stateHash }. One batch: the guild row and every section's reads come from the same snapshot.
export async function previewFlip(db, guildId, sections = FLIP_SECTIONS) {
  const statements = [db.prepare(GUILD_ROW_SQL).bind(guildId)];
  const spans = sections.map((section) => {
    const own = section.statements(db, guildId);
    const span = { start: statements.length, length: own.length };
    statements.push(...own);
    return span;
  });
  const results = await db.batch(statements);
  const row = results[0].results[0];
  if (!row) return { guild: null, payload: {}, stateHash: null };
  const guild = { id: row.id, rankSource: row.rank_source, rosterSyncId: row.last_good_sync_id || '' };
  const payload = {};
  const hashParts = {};
  sections.forEach((section, index) => {
    const { start, length } = spans[index];
    const built = section.build(results.slice(start, start + length), guild);
    payload[section.key] = built.payload;
    hashParts[section.key] = built.hashPart;
  });
  return { guild, payload, stateHash: await flipStateHash(hashParts) };
}
