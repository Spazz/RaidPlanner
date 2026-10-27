// The in-game rank map and applyRankMap (user-hierarchy build, lane B4b; plan "Model" > Rank, "Former vs Social", U R7-Q2, U R5-Q6, U R6-Q3).
//
// THE MAP. source_rank_maps holds one row per in-game rank index (0-9, source_key '0'..'9') of a guild: a label (the map owns the labels; guilds.bnet_rank_labels is
// read once, to suggest them), the CORE RANK the rank carries (raider | trial | reserve | social), and the PERMISSION ROLE it gives (officer | team_lead |
// guild_master | one of the guild's own roles | none). Only rank 0 may map to Guild Master: this file refuses any other rank with a 400, and the table's CHECK
// is the backstop. Permission roles are DERIVED at read time (lane B6b); this lane stores them and writes core ranks.
//
// APPLY RANK MAP is the ONLY writer of characters.core_rank besides the officer rank edit of a manual / legacy guild (worker/routes/roster.js) and the status
// mapping of new people (worker/person-legacy.js). It runs in the roster-sync batch and in a map edit, only while guilds.rank_source = 'ingame' (inside the batch,
// not in JS), and sets every character of the guild in one set-based UPDATE:
//   on the stored roster ........ the core rank of its rank's map row; a rank index with NO map row = Social until it is mapped (and an Owner attention item)
//   not on the stored roster .... Social: a character the roster never listed (an alt in another guild, a hand-added one) has no rank of its own (U R6-Q3). A
//                                 character that WAS on the roster and left is Former = Social + left_on, which the sync's Former step sets before this runs.
//   a rank change clears the trial dates (entering Trial restarts the clock, leaving Trial ends it), sets updated_at, and marks the character's raids stale.
// A positive Blizzard answer is trusted: every change, up or down, applies at that one good sync, with no alert and no hold (U R5-Q6).
//
// THE GATE. rankMapGaps / assertRankMapComplete tell lane B9's flip which rank indexes on the stored roster have no map row.
import { HttpError } from './http.js';
import { HAS_EVIDENCE, weekFreeze, weekRunningSql } from './attendance-store.js';
import { RANK_COUNT, rankLabelOf } from './bnet-store.js';
import { hashToken } from './session.js';
import { trialClockStatement, zoneOffsetMinutes } from './trial-clock.js';

export const SOURCE_INGAME = 'ingame';
export const CORE_RANK_IDS = Object.freeze(['raider', 'trial', 'reserve', 'social']);
export const CORE_RANK_LABELS = Object.freeze({ raider: 'Raider', trial: 'Trial', reserve: 'Reserve', social: 'Social' });
// The permission roles a rank may give besides the guild's own: Officer, Team Lead (of the team the character is placed on) and, for rank 0 only, Guild Master.
export const MAPPABLE_BUILTIN_ROLES = Object.freeze(['officer', 'team_lead', 'guild_master']);
export const MAX_LABEL = 64;

// SQL: the guild's rank source is the in-game roster (inside a batch statement, so a sync that read the guild just before the flip cannot slip past).
export const INGAME_SQL = `EXISTS (SELECT 1 FROM guilds WHERE id = ? AND rank_source = 'ingame')`;
export const ingameGuard = (guildId) => ({ sql: INGAME_SQL, params: [guildId] });

const bad = (message, field, code = 'bad_request') => new HttpError(400, code, message, field ? { field } : {});

// ---------------------------------------------------------------------------
// Reading and checking a map

// Pure. body: the entries the client sends ([{ rank, label, coreRank, roleId }]); customRoleIds: the ids of the guild's own roles. -> the canonical map, by rank:
// [{ rank, label, coreRank, roleId }]. Throws 400 on the first problem (field names the entry: ranks[2].roleId).
export function normalizeRankMap(entries, customRoleIds = []) {
  if (!Array.isArray(entries)) throw bad('Send the rank map as a list of ranks.', 'ranks');
  if (entries.length > RANK_COUNT) throw bad(`A guild has at most ${RANK_COUNT} in-game ranks.`, 'ranks');
  const seen = new Set();
  const rows = entries.map((entry, index) => {
    const at = (name) => `ranks[${index}].${name}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw bad('Each rank is an object.', `ranks[${index}]`);
    if (!Number.isInteger(entry.rank) || entry.rank < 0 || entry.rank >= RANK_COUNT) throw bad(`The in-game rank is a number from 0 to ${RANK_COUNT - 1}.`, at('rank'));
    if (seen.has(entry.rank)) throw bad(`Rank ${entry.rank} is listed twice.`, at('rank'));
    seen.add(entry.rank);
    if (typeof entry.label !== 'string') throw bad('Give the rank a name.', at('label'));
    const label = entry.label.replace(/\s+/g, ' ').trim();
    if (!label || Array.from(label).length > MAX_LABEL || /[\u0000-\u001f\u007f]/.test(label)) throw bad(`A rank name is 1 to ${MAX_LABEL} characters of plain text.`, at('label'));
    if (!CORE_RANK_IDS.includes(entry.coreRank)) throw bad('Pick Raider, Trial, Reserve or Social.', at('coreRank'));
    const roleId = entry.roleId === undefined || entry.roleId === '' ? null : entry.roleId;
    if (roleId !== null) {
      if (roleId === 'guild_master' && entry.rank !== 0) {
        throw bad('Only the in-game Guild Master rank (rank 0) can map to Guild Master. Every other rank tops out at Officer.', at('roleId'), 'rank_zero_only');
      }
      if (typeof roleId !== 'string' || !(MAPPABLE_BUILTIN_ROLES.includes(roleId) || customRoleIds.includes(roleId))) {
        throw bad('Pick Officer, Team Lead, one of the guild\'s own roles, or no role.', at('roleId'));
      }
    }
    return { rank: entry.rank, label, coreRank: entry.coreRank, roleId };
  });
  return rows.sort((a, b) => a.rank - b.rank);
}

const rowOf = (row) => ({ rank: Number(row.source_key), label: row.label, coreRank: row.core_rank, roleId: row.role_id });

// -> the stored map of the guild, by rank (rows of the reserved ranks-set-team column are not part of this build and are not read).
export async function loadRankMap(db, guildId) {
  const result = await db.prepare(
    `SELECT source_key, label, core_rank, role_id FROM source_rank_maps WHERE guild_id = ? AND source = 'ingame' AND team_id IS NULL
      ORDER BY CAST(source_key AS INTEGER)`,
  ).bind(guildId).all();
  return result.results.map(rowOf);
}

// -> [{ rank, members }]: every rank index on the stored roster and how many members hold it.
export async function loadRosterRanks(db, guildId) {
  const result = await db.prepare('SELECT rank, COUNT(*) AS members FROM guild_roster WHERE guild_id = ? GROUP BY rank ORDER BY rank').bind(guildId).all();
  return result.results.map((row) => ({ rank: row.rank, members: row.members }));
}

// -> [{ rank, members }]: the rank indexes on the stored roster that have NO row in the guild's map. Their characters are Social until mapped.
export async function rankMapGaps(db, guildId) {
  const result = await db.prepare(
    `SELECT g.rank AS rank, COUNT(*) AS members FROM guild_roster g
      WHERE g.guild_id = ? AND NOT EXISTS (SELECT 1 FROM source_rank_maps m WHERE m.guild_id = g.guild_id AND m.source = 'ingame' AND m.source_key = CAST(g.rank AS TEXT))
      GROUP BY g.rank ORDER BY g.rank`,
  ).bind(guildId).all();
  return result.results.map((row) => ({ rank: row.rank, members: row.members }));
}

// The every-rank-mapped gate (lane B9's flip calls it): throws 409 rank_map_incomplete, listing the ranks, while any rank on the stored roster has no map row.
export async function assertRankMapComplete(db, guildId) {
  const gaps = await rankMapGaps(db, guildId);
  if (gaps.length) {
    const names = gaps.map((gap) => `rank ${gap.rank}`).join(', ');
    throw new HttpError(409, 'rank_map_incomplete', `Map every in-game rank first. Not mapped yet: ${names}.`, { ranks: gaps });
  }
}

// The same rank without a map row, against a PROPOSED map (the dry run's "still unmapped").
export const gapsOfMap = (rosterRanks, map) => rosterRanks.filter((entry) => !map.some((row) => row.rank === entry.rank));

// The labels to suggest for ranks nobody has mapped yet: the guild's Battle.net labels (guilds.bnet_rank_labels, read once at setup), else Blizzard's defaults.
export const suggestedLabels = (blizzardLabels) => Array.from({ length: RANK_COUNT }, (_, rank) => rankLabelOf(blizzardLabels, rank));

// ---------------------------------------------------------------------------
// The new core rank of a character: from the map and the stored roster

// Two sources of the map for the same expression: the stored table (an apply) or a proposed map sent as JSON (the dry run). One placeholder each.
const STORED_MAP_CTE = `rank_map AS (SELECT CAST(source_key AS INTEGER) AS rank, core_rank FROM source_rank_maps WHERE guild_id = ? AND source = 'ingame' AND team_id IS NULL)`;
const PROPOSED_MAP_CTE = `rank_map AS (SELECT json_extract(value, '$.rank') AS rank, json_extract(value, '$.coreRank') AS core_rank FROM json_each(?))`;

// SQL on a characters row (alias given; needs the rank_map CTE): its identity key on the stored roster -> that rank's core rank; Social when the rank has no row
// or the character is not on the roster (including a character with no identity key at all: the comparisons are NULL). Exported for the sign-in match (B6a).
export const newCoreRankSql = (c) => `COALESCE((SELECT COALESCE(m.core_rank, 'social') FROM guild_roster g LEFT JOIN rank_map m ON m.rank = g.rank
       WHERE g.guild_id = ${c}.guild_id AND g.namespace = ${c}.namespace AND g.blizzard_realm_id = ${c}.blizzard_realm_id AND g.blizzard_char_id = ${c}.blizzard_char_id), 'social')`;

// Raids to recalculate: every raid whose log names a character whose rank is about to change (by its name today or any old name), and every raid with evidence of
// the teams of the people they belong to whose week is still running (a rank change moves who is expected and the fill-in credit; a finished week keeps its result,
// worker/attendance-store.js THE FREEZE). Runs BEFORE the rank UPDATE, like the sync's own stale step.
const STALE_SQL = `WITH ${STORED_MAP_CTE},
     changed AS (SELECT c.id AS id, c.player_id AS player_id, c.name_key AS name_key FROM characters c WHERE c.guild_id = ? AND c.core_rank != ${newCoreRankSql('c')})
UPDATE raids SET policy_fp = '', version = version + 1
 WHERE guild_id = ?
   AND (id IN (SELECT rp.raid_id FROM raid_presence rp
                WHERE rp.guild_id = ? AND (rp.name_key IN (SELECT name_key FROM changed)
                      OR rp.name_key IN (SELECT a.name_key FROM character_name_aliases a WHERE a.guild_id = ? AND a.character_id IN (SELECT id FROM changed))))
        OR (team_id IN (SELECT t.team_id FROM characters t WHERE t.guild_id = ? AND t.team_id IS NOT NULL AND t.player_id IN (SELECT player_id FROM changed))
            AND ${HAS_EVIDENCE} AND ${weekRunningSql('?', '?')}))`;

const APPLY_SQL = `WITH ${STORED_MAP_CTE}
UPDATE characters SET core_rank = ${newCoreRankSql('characters')}, trial_start = NULL, trial_end = NULL, updated_at = ?
 WHERE guild_id = ? AND core_rank != ${newCoreRankSql('characters')}`;

// Position of the characters UPDATE inside the array rankMapApplyStatements returns (its meta.changes = the characters whose rank changed).
export const APPLY_UPDATE_INDEX = 1;

const withGuards = (sql, guards) => (guards.length ? `${sql} AND ${guards.map((guard) => guard.sql).join(' AND ')}` : sql);
const guardParams = (guards) => guards.flatMap((guard) => guard.params);

// THE ONE WRITER. -> [stale marking, the rank UPDATE, the Trial clock] for a db.batch, after the roster rows and the map are in place. guards: [{ sql, params }],
// every one appended with AND to every statement (a sync passes its two guards: the monotonic one and the in-game one; a map edit passes its marker and the in-game
// one). run: { guildId, now, timeZone }.
export function rankMapApplyStatements(db, run, guards) {
  if (!guards.some((guard) => guard.sql === INGAME_SQL)) throw new Error('applyRankMap needs the in-game guard');
  const extra = guardParams(guards);
  return [
    db.prepare(withGuards(STALE_SQL, guards)).bind(run.guildId, run.guildId, run.guildId, run.guildId, run.guildId, run.guildId, weekFreeze(run.timeZone, run.now).starts, run.guildId, ...extra),
    db.prepare(withGuards(APPLY_SQL, guards)).bind(run.guildId, run.now, run.guildId, ...extra),
    trialClockStatement(db, run.guildId, { offsetMinutes: zoneOffsetMinutes(run.timeZone, run.now), guards }),
  ];
}

// ---------------------------------------------------------------------------
// The dry run: what a proposed map would do to the guild's characters

const TRANSITIONS_SQL = `WITH ${PROPOSED_MAP_CTE}
SELECT from_rank, to_rank, COUNT(*) AS n
  FROM (SELECT c.core_rank AS from_rank, ${newCoreRankSql('c')} AS to_rank FROM characters c WHERE c.guild_id = ?)
 WHERE from_rank != to_rank GROUP BY from_rank, to_rank ORDER BY from_rank, to_rank`;

const SAMPLES_SQL = `WITH ${PROPOSED_MAP_CTE}
SELECT name, from_rank, to_rank
  FROM (SELECT c.name AS name, c.name_key AS name_key, c.core_rank AS from_rank, ${newCoreRankSql('c')} AS to_rank FROM characters c WHERE c.guild_id = ?)
 WHERE from_rank != to_rank ORDER BY to_rank, name_key LIMIT 25`;

export const SAMPLE_LIMIT = 25;

// -> { changed, becomesTrial, becomesSocial, transitions: [{ from, to, count }], samples: [{ name, from, to }] }: the characters whose rank would change if
// `map` (canonical rows) were the guild's map right now. Reads only; the same expression an apply uses.
export async function previewMap(db, guildId, map) {
  const json = JSON.stringify(map.map((row) => ({ rank: row.rank, coreRank: row.coreRank })));
  const [transitions, samples] = await db.batch([
    db.prepare(TRANSITIONS_SQL).bind(json, guildId),
    db.prepare(SAMPLES_SQL).bind(json, guildId),
  ]);
  const list = transitions.results.map((row) => ({ from: row.from_rank, to: row.to_rank, count: row.n }));
  const sum = (filter) => list.filter(filter).reduce((total, entry) => total + entry.count, 0);
  return {
    changed: sum(() => true),
    becomesTrial: sum((entry) => entry.to === 'trial'),
    becomesSocial: sum((entry) => entry.to === 'social'),
    transitions: list,
    samples: samples.results.map((row) => ({ name: row.name, from: row.from_rank, to: row.to_rank })),
  };
}

// The map rows that differ between the stored map and a proposed one: [{ rank, change: 'added' | 'removed' | 'changed', before, after }].
export function mapChanges(stored, proposed) {
  const same = (a, b) => a.label === b.label && a.coreRank === b.coreRank && a.roleId === b.roleId;
  const out = [];
  for (const after of proposed) {
    const before = stored.find((row) => row.rank === after.rank);
    if (!before) out.push({ rank: after.rank, change: 'added', before: null, after });
    else if (!same(before, after)) out.push({ rank: after.rank, change: 'changed', before, after });
  }
  for (const before of stored) {
    if (!proposed.some((row) => row.rank === before.rank)) out.push({ rank: before.rank, change: 'removed', before, after: null });
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// The characters the map would change, recomputed INSIDE the apply batch (review fix, B4b F4). The JS check of the token reads the state a moment before the batch runs;
// a character that changes in between would be moved without having been approved. The consume statement therefore carries this guard: the transitions of the proposed
// map over the guild's characters AT THE TIME OF THE BATCH, as one canonical text, must equal the text the dry run showed the Owner (`transitions`, the order of
// TRANSITIONS_SQL). Counts are what the approval binds (the same as mapStateHash), so a swap of one character for another in the same transition is the same approval.
// {sql, params}: true while they are equal; its placeholders: the proposed map (JSON), the guild, the approved text.
const TRANSITIONS_TEXT_SQL = `(WITH ${PROPOSED_MAP_CTE}
  SELECT COALESCE(json_group_array(json_array(from_rank, to_rank, n)), '[]')
    FROM (SELECT from_rank, to_rank, COUNT(*) AS n
            FROM (SELECT c.core_rank AS from_rank, ${newCoreRankSql('c')} AS to_rank FROM characters c WHERE c.guild_id = ?)
           WHERE from_rank != to_rank GROUP BY from_rank, to_rank ORDER BY from_rank, to_rank))`;
export function approvedTransitionsGuard(guildId, map, transitions) {
  const json = JSON.stringify(map.map((row) => ({ rank: row.rank, coreRank: row.coreRank })));
  return { sql: `${TRANSITIONS_TEXT_SQL} = ?`, params: [json, guildId, JSON.stringify(transitions.map((entry) => [entry.from, entry.to, entry.count]))] };
}

// What a token for a map change is bound to: the purpose, the map as stored now, the map proposed, and the characters it would change. A token minted for any
// other pair of maps, or after the characters moved under it, no longer matches (the apply recomputes this and refuses on a difference).
export async function mapStateHash(stored, proposed, preview) {
  const rows = (map) => map.map((row) => [row.rank, row.label, row.coreRank, row.roleId]);
  const state = { stored: rows(stored), proposed: rows(proposed), transitions: preview.transitions.map((entry) => [entry.from, entry.to, entry.count]) };
  return `rankmap:${await hashToken(JSON.stringify(state))}`;
}

// ---------------------------------------------------------------------------
// Writing the map (inside the apply batch)

// Two statements for a db.batch: replace the guild's in-game rows with `map`. guard: { sql, params } (the apply's marker).
export function replaceMapStatements(db, guildId, map, guard) {
  return [
    db.prepare(`DELETE FROM source_rank_maps WHERE guild_id = ? AND source = 'ingame' AND team_id IS NULL AND ${guard.sql}`).bind(guildId, ...guard.params),
    db.prepare(
      `INSERT INTO source_rank_maps (guild_id, source, source_key, label, core_rank, role_id, team_id)
       SELECT ?, 'ingame', CAST(json_extract(value, '$.rank') AS TEXT), json_extract(value, '$.label'), json_extract(value, '$.coreRank'), json_extract(value, '$.roleId'), NULL
         FROM json_each(?) WHERE ${guard.sql}`,
    ).bind(guildId, JSON.stringify(map), ...guard.params),
  ];
}
