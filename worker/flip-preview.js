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
//           owner_exemption (the Owner of a 'manual' guild, a member only through the Owner exemption membership.js gives that source: no person of the guild is theirs; after
//           the flip they are a member only while the Owner is live),
//           no_roster_character (their person has no character on the in-game roster; unkeyedCharacters counts the characters with no identity key yet, the ones
//           the flip's name binding could still match), all_former (every character of their person is Former)
//   gains   not a member today, one after the flip. Reasons: owner (the Owner exemption), discord_owned_person (their person is the one the flip links, and it is on the roster)
// The DISCORD-OWNED section lists the persons the flip would link, and whether the Owner's own person is one of them.
// The PERMISSIONS section (lane B6b part 3a) lists who gains and who loses a permission role at the flip: the roles the proposed rank map derives from each account's Battle.net-proven
// characters on the stored roster, set against what the accounts hold today (stored hand and Discord rows, the Owner row); the stored Discord-given rows, which the flip makes
// hand-set rows ('manual'), are listed apart. The OWNER section says who becomes the Owner (the Owner row today: the stored Guild Master of a legacy guild, the seat holder otherwise)
// and whether they will be LIVE, a Battle.net-proven character on the stored roster, or suspended. The ACCESS section counts the Owner in only when they will be live
// (membership.js: the Owner exemption ends with suspension), because the Owner view of a guild before the flip never suspends anybody.
// Both read the STORED roster (guild_roster), the roster the approval token binds to (roster sync id): a roster that moves between the dry run and the flip makes the token stale.
// Nothing returned carries a Discord ID or a BattleTag.
import { memberSql, personOnRosterSql, rankSourceSql, unsuspendedOwnerSql, blockedSql } from './membership.js';
import { serverIdIsDiscordSql } from './discord-guard.js';
import { ownerCandidatesSql, seatHolderSql } from './owner.js';
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

// The valid Battle.net-proven characters of the guild's linked accounts as the 'ingame' rule will see them once the guild is flipped: the view ingame_proven_characters (migration
// 0035) WITHOUT its rank_source test (the guild is not in-game yet). owner_proof 'bnet', the proof belongs to the account that holds the person NOW, the identity key is a
// guild_roster row, and the account's CURRENT Battle.net link is the one that proved it. Same joins in the same forced order as the view; tests/guild/guild-b6b-p3a-tests.js
// runs both against a guild flipped by hand and finds the same roles and the same Owner liveness. A person only a Discord ID owns has no proof to count.
const PROVEN_AFTER = `SELECT pp.user_id AS user_id, pc.id AS character_id, pc.name AS name, pc.team_id AS team_id, pr.rank AS roster_rank, pc.left_on AS left_on
  FROM players pp
  CROSS JOIN characters pc ON pc.player_id = pp.id AND pc.guild_id = pp.guild_id
                          AND pc.owner_proof = 'bnet' AND pc.proof_user_id IS NOT NULL AND pc.proof_user_id = pp.user_id
  CROSS JOIN guild_roster pr ON pr.guild_id = pp.guild_id AND pr.namespace = pc.namespace
                            AND pr.blizzard_realm_id = pc.blizzard_realm_id AND pr.blizzard_char_id = pc.blizzard_char_id
  CROSS JOIN bnet_links pb ON pb.user_id = pp.user_id AND pb.bnet_account_id = pc.proof_bnet_account_id
 WHERE pp.guild_id = ${GUILD} AND pp.user_id IS NOT NULL`;

// What an account is called in the lists: its person's Main, else the name it chose, else (a Discord account) its Discord display name or handle. Never an ID.
const NAME_OF = (userExpr) => `COALESCE((SELECT fm.name FROM players fp JOIN characters fm ON fm.player_id = fp.id AND fm.is_main = 1 WHERE fp.guild_id = ${GUILD} AND fp.user_id = ${userExpr}),
       (SELECT nu.display_name FROM users nu WHERE nu.id = ${userExpr}),
       (SELECT CASE WHEN nu.discord_id IS NOT NULL THEN COALESCE(nu.global_name, nu.username) END FROM users nu WHERE nu.id = ${userExpr}))`;
const PERSON_OF = (userExpr) => `(SELECT lp.id FROM players lp WHERE lp.guild_id = ${GUILD} AND lp.user_id = ${userExpr})`;

// One row per account of the universe that is not blocked: what it is today, and what it would be after the flip.
const PERSON = 'COALESCE(b.linked_person, b.discord_person)';
const ACCOUNTS_CTE = `WITH proven AS (${PROVEN_AFTER}), base AS (
  SELECT u.id AS user_id, u.discord_id, u.display_name, u.global_name, u.username,
         ${memberSql('u.id', GUILD, SERVER)} AS today,
         ${unsuspendedOwnerSql('u.id', GUILD)} AS is_owner,
         CASE WHEN ${unsuspendedOwnerSql('u.id', GUILD)} THEN EXISTS (SELECT 1 FROM proven pv WHERE pv.user_id = u.id) ELSE 0 END AS owner_live,
         (SELECT lp.id FROM players lp WHERE lp.guild_id = ${GUILD} AND lp.user_id = u.id) AS linked_person,
         (SELECT dp.id FROM players dp WHERE dp.guild_id = ${GUILD} AND dp.user_id IS NULL AND u.discord_id IS NOT NULL AND dp.discord_user_id = u.discord_id) AS discord_person
    FROM users u
   WHERE u.id IN (${UNIVERSE_SQL}) AND NOT ${blockedSql('u.id', GUILD)}
), acc AS (
  SELECT b.*, ${PERSON} AS person_id,
         CASE WHEN b.owner_live = 1 THEN 1
              WHEN ${PERSON} IS NOT NULL AND ${personOnRosterSql(PERSON, GUILD)} THEN 1
              ELSE 0 END AS after_member
    FROM base b
)`;

// loses / gains rows, every one (ids and reasons are hashed; the names are display only).
const ACCESS_ROWS_SQL = `${ACCOUNTS_CTE}
SELECT CASE WHEN a.today = 1 THEN 'loses' ELSE 'gains' END AS kind,
       CASE WHEN a.today = 1 THEN
              CASE WHEN a.person_id IS NULL THEN (CASE WHEN a.is_owner = 1 AND ${rankSourceSql(GUILD)} = 'manual' THEN 'owner_exemption' ELSE 'discord_only' END)
                   WHEN EXISTS (SELECT 1 FROM characters fc WHERE fc.player_id = a.person_id AND ${visibleCharacterSql('fc')})
                        AND NOT EXISTS (SELECT 1 FROM characters fc WHERE fc.player_id = a.person_id AND fc.left_on IS NULL AND ${visibleCharacterSql('fc')}) THEN 'all_former'
                   ELSE 'no_roster_character' END
            WHEN a.owner_live = 1 THEN 'owner'
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

// ---------------------------------------------------------------------------
// PERMISSIONS (lane B6b part 3a). Tuples (account, role, team) the account holds today and after the flip; the difference is the answer.
//   today   effective_roles of the guild (the stored hand and Discord rows, and the Owner row)
//   after   the stored rows but the Guild Master row (the flip deletes it: the seat replaces it; Discord-given rows become hand-set rows and keep their tuple), the roles DERIVED
//           from the rank map (a mirror of the view effective_roles_ingame over PROVEN_AFTER: the best-ranked valid, not-Former character of an account wins, every tie counts, the
//           map row gives the role, Guild Master only for rank 0, a Team Lead for the character's team and not at all without one) and the Owner's Guild Master row when they will be LIVE
//   gains   after and not today. Reason: rank (derived from the in-game rank)
//   loses   today and not after. Reasons: owner_not_live (the Owner's Guild Master row: a suspended Owner keeps the seat and nothing else), guild_master_row_removed (a second stored
//           Guild Master row, which the flip deletes)
// An account that is blocked here is out of every list, like in the ACCESS section.
const PERMISSIONS_CTE = `WITH proven AS (${PROVEN_AFTER}),
derived AS (
  SELECT DISTINCT iv.user_id AS user_id, im.role_id AS role_id, CASE WHEN im.role_id = 'team_lead' THEN iv.team_id END AS team_id
    FROM proven iv
    CROSS JOIN source_rank_maps im ON im.guild_id = ${GUILD} AND im.source = 'ingame' AND im.team_id IS NULL AND im.source_key = CAST(iv.roster_rank AS TEXT)
   WHERE im.role_id IS NOT NULL
     AND (im.role_id <> 'guild_master' OR im.source_key = '0')
     AND (im.role_id <> 'team_lead' OR iv.team_id IS NOT NULL)
     AND iv.left_on IS NULL
     AND NOT EXISTS (SELECT 1 FROM proven ib WHERE ib.user_id = iv.user_id AND ib.left_on IS NULL AND ib.roster_rank < iv.roster_rank)
), owner_row AS (
  SELECT eo.user_id AS user_id FROM effective_roles_owner eo WHERE eo.guild_id = ${GUILD} ORDER BY eo.user_id LIMIT 1
), today AS (
  SELECT DISTINCT er.user_id AS user_id, er.role_id AS role_id, er.team_id AS team_id FROM effective_roles er WHERE er.guild_id = ${GUILD}
), after AS (
  SELECT sa.user_id AS user_id, sa.role_id AS role_id, sa.team_id AS team_id FROM effective_roles_stored sa WHERE sa.guild_id = ${GUILD} AND sa.role_id <> 'guild_master'
  UNION SELECT d.user_id, d.role_id, d.team_id FROM derived d
  UNION SELECT ow.user_id, 'guild_master', NULL FROM owner_row ow WHERE EXISTS (SELECT 1 FROM proven pv WHERE pv.user_id = ow.user_id)
)`;
const SAME_TUPLE = (left, right) => `${left}.user_id = ${right}.user_id AND ${left}.role_id = ${right}.role_id AND COALESCE(${left}.team_id, '') = COALESCE(${right}.team_id, '')`;
const PERMISSION_ROWS_SQL = `${PERMISSIONS_CTE}
SELECT d.kind AS kind, d.user_id AS user_id, d.role_id AS role_id, d.team_id AS team_id, ${PERSON_OF('d.user_id')} AS person_id, ${NAME_OF('d.user_id')} AS name,
       (SELECT r.name FROM roles r WHERE r.id = d.role_id) AS role_name,
       (SELECT t.name FROM teams t WHERE t.id = d.team_id AND t.guild_id = ${GUILD}) AS team_name,
       CASE WHEN d.kind = 'gains' THEN 'rank'
            WHEN d.user_id = (SELECT user_id FROM owner_row) AND d.role_id = 'guild_master' THEN 'owner_not_live'
            ELSE 'guild_master_row_removed' END AS reason
  FROM (
    SELECT 'gains' AS kind, a.user_id AS user_id, a.role_id AS role_id, a.team_id AS team_id FROM after a
     WHERE NOT EXISTS (SELECT 1 FROM today t WHERE ${SAME_TUPLE('t', 'a')}) AND NOT ${blockedSql('a.user_id', GUILD)}
    UNION ALL
    SELECT 'loses', t.user_id, t.role_id, t.team_id FROM today t
     WHERE NOT EXISTS (SELECT 1 FROM after a WHERE ${SAME_TUPLE('t', 'a')}) AND NOT ${blockedSql('t.user_id', GUILD)}
  ) d
 ORDER BY d.kind, d.role_id, name, d.user_id, d.team_id`;

// The stored Discord-given rows: the flip converts them to hand-set rows (UPDATE OR IGNORE, then DELETE the leftovers that already had a hand-set twin: the unique index
// idx_role_assignments_unique includes the source) and lists them for the Owner. twin = the account already holds the same role by hand, so the converted row is dropped.
const DISCORD_ROLES_SQL = `SELECT ra.user_id AS user_id, ra.role_id AS role_id, ra.team_id AS team_id, ${PERSON_OF('ra.user_id')} AS person_id, ${NAME_OF('ra.user_id')} AS name,
       (SELECT r.name FROM roles r WHERE r.id = ra.role_id) AS role_name,
       (SELECT t.name FROM teams t WHERE t.id = ra.team_id AND t.guild_id = ${GUILD}) AS team_name,
       EXISTS (SELECT 1 FROM effective_roles_stored m WHERE m.guild_id = ra.guild_id AND m.user_id = ra.user_id AND m.role_id = ra.role_id
                 AND COALESCE(m.team_id, '') = COALESCE(ra.team_id, '') AND m.source = 'manual') AS twin
  FROM effective_roles_stored ra WHERE ra.guild_id = ${GUILD} AND ra.source = 'discord'
 ORDER BY ra.role_id, name, ra.user_id, ra.team_id`;

const permissionSample = (row, extra = {}) => ({
  userId: row.user_id, personId: row.person_id, name: row.name, roleId: row.role_id, roleName: row.role_name, teamId: row.team_id, teamName: row.team_name, ...extra,
});

const permissionsSection = {
  key: 'permissions',
  statements: (db, guildId) => [db.prepare(PERMISSION_ROWS_SQL).bind(guildId), db.prepare(DISCORD_ROLES_SQL).bind(guildId)],
  build([changeResult, discordResult]) {
    const rows = changeResult.results;
    const list = (kind) => {
      const own = rows.filter((row) => row.kind === kind);
      return { count: own.length, byRole: tally(own, 'role_id'), reasons: tally(own, 'reason'), samples: own.slice(0, FLIP_SAMPLES).map((row) => permissionSample(row, { reason: row.reason })) };
    };
    const discord = discordResult.results;
    const key = (row) => [row.user_id, row.role_id, row.team_id];
    return {
      payload: {
        gains: list('gains'),
        loses: list('loses'),
        // Stored Discord-given rows that become hand-set at the flip (the Discord role sync stops writing roles once the guild has a rank source).
        discordRoles: {
          count: discord.length,
          withHandTwin: discord.filter((row) => row.twin === 1).length,
          samples: discord.slice(0, FLIP_SAMPLES).map((row) => permissionSample(row, { handTwin: row.twin === 1 })),
        },
      },
      hashPart: {
        gains: rows.filter((row) => row.kind === 'gains').map(key),
        loses: rows.filter((row) => row.kind === 'loses').map(key),
        discordRoles: discord.map((row) => [...key(row), row.twin]),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// OWNER (lane B6b part 3a): the Owner row of the guild today, and whether that account will be LIVE after the flip. The seat the flip writes is the Owner row's account (the stored Guild
// Master of a legacy guild, the seat holder otherwise); it is live only with a valid Battle.net-proven character on the stored roster, else it is SUSPENDED (it keeps the seat and
// holds only the rank its own characters give), and the flip (lane B9) is refused until it is live. A guild without an Owner answers `exists: false`.
const OWNER_SQL = `WITH proven AS (${PROVEN_AFTER})
SELECT o.user_id AS user_id, ${NAME_OF('o.user_id')} AS name, ${PERSON_OF('o.user_id')} AS person_id,
       (${seatHolderSql(GUILD)} IS NOT NULL) AS has_seat,
       EXISTS (SELECT 1 FROM proven pv WHERE pv.user_id = o.user_id) AS live,
       (SELECT pv.name FROM proven pv WHERE pv.user_id = o.user_id ORDER BY pv.roster_rank, pv.name LIMIT 1) AS via_name,
       (SELECT pv.roster_rank FROM proven pv WHERE pv.user_id = o.user_id ORDER BY pv.roster_rank, pv.name LIMIT 1) AS via_rank
  FROM effective_roles_owner o WHERE o.guild_id = ${GUILD} ORDER BY o.user_id LIMIT 1`;
const ROSTER_STATE_SQL = `SELECT EXISTS (SELECT 1 FROM guild_roster gr WHERE gr.guild_id = ${GUILD}) AS stored, (SELECT fg.last_good_fetched_at FROM guilds fg WHERE fg.id = ${GUILD}) AS fetched_at`;

const ownerSection = {
  key: 'owner',
  statements: (db, guildId) => [db.prepare(OWNER_SQL).bind(guildId), db.prepare(ROSTER_STATE_SQL).bind(guildId)],
  build([ownerResult, rosterResult]) {
    const row = ownerResult.results[0];
    const roster = rosterResult.results[0];
    const rosterStored = roster.stored === 1;
    if (!row) {
      return { payload: { exists: false, live: false, willBeSuspended: false, reason: 'no_owner', rosterStored, rosterFetchedAt: roster.fetched_at }, hashPart: [null, 0] };
    }
    const live = row.live === 1;
    return {
      payload: {
        exists: true,
        userId: row.user_id,
        personId: row.person_id,
        name: row.name,
        source: row.has_seat === 1 ? 'seat' : 'stored_guild_master',
        live,
        willBeSuspended: !live,
        reason: live ? 'live' : (rosterStored ? 'no_proven_character' : 'no_roster'),
        via: live ? { characterName: row.via_name, rank: row.via_rank } : null,
        rosterStored,
        rosterFetchedAt: roster.fetched_at,
      },
      hashPart: [row.user_id, live ? 1 : 0],
    };
  },
};

// The sections, in order. Lane B9 pushes its own (the name-binding confirmations).
export const FLIP_SECTIONS = [accessSection, discordOwnedSection, permissionsSection, ownerSection];

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
