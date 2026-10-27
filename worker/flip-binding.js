// The flip's character-level lines (user-hierarchy build, lane B9): which id-less characters the flip BINDS to the stored roster by name, what every character's core rank becomes once
// it has, and which characters are not on the roster at all. The dry run reads them (sections `boundByName`, `ranks` and `notOnRoster` of worker/flip-preview.js) and the flip
// recomputes them INSIDE its batch (worker/flip.js), from the same SQL text, so what the Owner approved and what the batch applies cannot drift apart.
//
// BOUND BY NAME (plan "Identity key"; U architect round 7: hand-added characters never take part). An id-less character gets the identity key of the roster row that carries its
// name and realm, when
//   - it has no key yet (blizzard_char_id IS NULL), has not left (left_on IS NULL), is a visible character (not a retired placeholder) and its proof is not 'hand'
//     (a character a player added by hand binds only through the owner's own Battle.net proof; an 'officer' character or one whose proof was cleared qualifies),
//   - the guild's roster has a row with the same name key and the same realm (a ruleset guild has no realm: the name decides), and
//   - nobody holds that roster row's key already.
// A name match whose CLASS differs from the roster row's is not bound (a name reused after a delete, a rename or a transfer is a different character): it is counted apart so the
// Owner sees why a character of that name stays unkeyed. The realm test compares the character's realm key with the roster row's realm slug without its hyphens: realmKey()
// (worker/roster-data.js) drops spaces, apostrophes and hyphens from the display name, and a slug is that name lowercased with hyphens ("old-blanchy" / "Old Blanchy" -> oldblanchy).
// Only the identity key is written; name, class and proof stay as they are (the proof stays what an officer set).
//
// THE OWNER TICKS THE LIST. The dry run lists every candidate; the flip binds the ones the Owner confirmed (POST /flip confirmedCharacterIds, a subset of that list). Everything that
// depends on the binding (the ranks, the access lists, the characters off the roster) therefore has a second form that takes the confirmed ids as ONE more JSON parameter
// (`only`, an SQL expression such as '?2'); with no `only` every candidate counts, which is what the dry run shows.
//
// RANK CHANGES. The core rank every character will have after the flip's applyRankMap (worker/rank-map.js): the mapped rank of its roster row, Social when it is not on the roster or
// its rank has no map row, computed as if the (confirmed) binding had already happened.
//
// NOT ON THE ROSTER. The visible characters that have no roster row even after the binding. A character that has left (left_on) is Former, every other one is Social (plan "Former vs
// Social": the flip uses the left_on history for the split).
//
// Every fragment takes the guild as an SQL expression ('?1': numbered, so a statement can use it any number of times) and writes only SELECTs.
import { visibleCharacterSql } from './character-visibility.js';
import { personOnRosterSql } from './membership.js';

export const BINDING_SAMPLES = 25;

// Every id-less character that has a roster row with its name and realm (any class): the candidates. class_ok = 0 rows are the class mismatches. `only`: restrict to these ids.
export const nameMatchSql = (guild, only = null) => `SELECT c.id AS character_id, c.name AS name, c.name_key AS name_key, c.class AS class, c.player_id AS person_id, pl.user_id AS user_id,
       COALESCE(c.owner_proof, 'none') AS proof, CASE WHEN c.class = gr.class THEN 1 ELSE 0 END AS class_ok,
       gr.namespace AS namespace, gr.blizzard_realm_id AS realm_id, gr.blizzard_char_id AS char_id, gr.rank AS roster_rank
  FROM characters c
  JOIN guilds ng ON ng.id = c.guild_id
  JOIN players pl ON pl.id = c.player_id AND pl.guild_id = c.guild_id
  JOIN guild_roster gr ON gr.guild_id = c.guild_id AND gr.name_key = c.name_key AND (ng.realm_kind = 'ruleset' OR c.realm_key = replace(gr.realm_slug, '-', ''))
 WHERE c.guild_id = ${guild} AND c.blizzard_char_id IS NULL AND c.left_on IS NULL AND c.owner_proof IS NOT 'hand' AND ${visibleCharacterSql('c')}
   AND NOT EXISTS (SELECT 1 FROM characters h WHERE h.guild_id = c.guild_id AND h.namespace = gr.namespace AND h.blizzard_realm_id = gr.blizzard_realm_id AND h.blizzard_char_id = gr.blizzard_char_id)${only ? `
   AND c.id IN (SELECT value FROM json_each(${only}))` : ''}`;

// SQL (a boolean): the person will have a character on the roster once the flip has bound its id-less characters by name: it has one on the roster now (personOnRosterSql) or it has
// one the binding gives a key to. The 'ingame' membership rule reads keys only, so the dry run's access lists must count the binding or they would tell the Owner that an account
// loses access which the flip in fact keeps.
export const willBeOnRosterSql = (personExpr, guildExpr, only = null) =>
  `(${personOnRosterSql(personExpr, guildExpr)} OR EXISTS (SELECT 1 FROM (${nameMatchSql(guildExpr, only)}) wb WHERE wb.person_id = ${personExpr} AND wb.class_ok = 1))`;

// The rows the dry run lists, by character id (the order the hash and the in-batch text both use).
export const NAME_ROWS_SQL = `SELECT * FROM (${nameMatchSql('?1')}) ORDER BY character_id`;

// SQL (a scalar): the ids the flip would bind right now (every candidate), as one canonical JSON text. The batch compares it with the text the Owner approved.
export const boundIdsTextSql = (guild) => `(SELECT COALESCE(json_group_array(character_id), '[]')
    FROM (SELECT character_id FROM (${nameMatchSql(guild)}) WHERE class_ok = 1 ORDER BY character_id))`;

// ---------------------------------------------------------------------------
// Rank changes

const rankMapCte = (guild) => `rank_map AS (SELECT CAST(source_key AS INTEGER) AS rank, core_rank FROM source_rank_maps WHERE guild_id = ${guild} AND source = 'ingame' AND team_id IS NULL)`;
const boundCte = (guild, only) => `bound AS (SELECT character_id, namespace, realm_id, char_id FROM (${nameMatchSql(guild, only)}) WHERE class_ok = 1)`;

// Every character of the guild with its core rank today and the one the apply would give it (the same expression as newCoreRankSql in worker/rank-map.js, with the identity key
// a character has OR is about to get).
const changesSql = (guild) => `SELECT c.id AS character_id, c.name AS name, c.name_key AS name_key, c.class AS class, c.core_rank AS from_rank,
       COALESCE((SELECT COALESCE(m.core_rank, 'social') FROM guild_roster rg LEFT JOIN rank_map m ON m.rank = rg.rank
                  WHERE rg.guild_id = c.guild_id AND rg.namespace = COALESCE(c.namespace, b.namespace)
                    AND rg.blizzard_realm_id = COALESCE(c.blizzard_realm_id, b.realm_id) AND rg.blizzard_char_id = COALESCE(c.blizzard_char_id, b.char_id)), 'social') AS to_rank
  FROM characters c LEFT JOIN bound b ON b.character_id = c.id
 WHERE c.guild_id = ${guild}`;

export const transitionsSql = (guild, only = null) => `WITH ${rankMapCte(guild)}, ${boundCte(guild, only)}
SELECT from_rank, to_rank, COUNT(*) AS n FROM (${changesSql(guild)})
 WHERE from_rank != to_rank GROUP BY from_rank, to_rank ORDER BY from_rank, to_rank`;

export const rankSamplesSql = (guild, only = null) => `WITH ${rankMapCte(guild)}, ${boundCte(guild, only)}
SELECT name, class, from_rank, to_rank FROM (${changesSql(guild)})
 WHERE from_rank != to_rank ORDER BY to_rank, name_key, character_id LIMIT ${BINDING_SAMPLES}`;

// SQL (a scalar): the transitions as one canonical JSON text, [[from, to, count], ...] in the order of transitionsSql. `only`: the confirmed ids (the flip's batch passes them).
export const transitionsTextSql = (guild, only = null) => `(WITH ${rankMapCte(guild)}, ${boundCte(guild, only)}
  SELECT COALESCE(json_group_array(json_array(from_rank, to_rank, n)), '[]')
    FROM (SELECT from_rank, to_rank, COUNT(*) AS n FROM (${changesSql(guild)})
           WHERE from_rank != to_rank GROUP BY from_rank, to_rank ORDER BY from_rank, to_rank))`;

// The ranks on the stored roster that have no row in the guild's map (worker/rank-map.js rankMapGaps): the flip refuses while there are any.
export const RANK_GAPS_SQL = `SELECT rg.rank AS rank, COUNT(*) AS members FROM guild_roster rg
  WHERE rg.guild_id = ?1 AND NOT EXISTS (SELECT 1 FROM source_rank_maps m WHERE m.guild_id = rg.guild_id AND m.source = 'ingame' AND m.source_key = CAST(rg.rank AS TEXT))
  GROUP BY rg.rank ORDER BY rg.rank`;

// SQL (a boolean): every rank on the stored roster has a map row.
export const rankMapCompleteSql = (guild) => `NOT EXISTS (SELECT 1 FROM guild_roster rg WHERE rg.guild_id = ${guild}
    AND NOT EXISTS (SELECT 1 FROM source_rank_maps m WHERE m.guild_id = rg.guild_id AND m.source = 'ingame' AND m.source_key = CAST(rg.rank AS TEXT)))`;

// ---------------------------------------------------------------------------
// Characters that are not on the roster after the binding

export const notOnRosterSql = (only = null) => `WITH ${boundCte('?1', only)}
SELECT c.id AS character_id, c.name AS name, c.name_key AS name_key, c.class AS class, CASE WHEN c.left_on IS NOT NULL THEN 'former' ELSE 'social' END AS after_kind,
       (SELECT fm.name FROM characters fm WHERE fm.player_id = c.player_id AND fm.is_main = 1) AS person
  FROM characters c LEFT JOIN bound b ON b.character_id = c.id
 WHERE c.guild_id = ?1 AND ${visibleCharacterSql('c')}
   AND NOT EXISTS (SELECT 1 FROM guild_roster rg WHERE rg.guild_id = c.guild_id AND rg.namespace = COALESCE(c.namespace, b.namespace)
                     AND rg.blizzard_realm_id = COALESCE(c.blizzard_realm_id, b.realm_id) AND rg.blizzard_char_id = COALESCE(c.blizzard_char_id, b.char_id))
 ORDER BY c.id`;

// ---------------------------------------------------------------------------
// The dry run's sections (worker/flip-preview.js FLIP_SECTIONS). statements(db, guildId, options): options.confirmed = the ids the Owner confirmed (the flip's own second pass), else every
// candidate counts.

const tally = (rows, key) => rows.reduce((counts, row) => ({ ...counts, [row[key]]: (counts[row[key]] || 0) + 1 }), {});

// options.confirmed (the flip's second pass): the ids of the id-less characters the Owner confirmed for the name binding. Everything that depends on the binding then counts only
// those. -> { only: '?2' | null, values: [JSON] | [] }
export const restriction = (options) => (options && Array.isArray(options.confirmed) ? { only: '?2', values: [JSON.stringify(options.confirmed)] } : { only: null, values: [] });

export const boundByNameSection = {
  key: 'boundByName',
  statements: (db, guildId) => [db.prepare(NAME_ROWS_SQL).bind(guildId)],
  build([result]) {
    const rows = result.results;
    const bound = rows.filter((row) => row.class_ok === 1);
    const mismatched = rows.filter((row) => row.class_ok === 0);
    const byName = [...bound].sort((a, b) => (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : a.character_id < b.character_id ? -1 : 1));
    return {
      payload: {
        count: bound.length,
        // Every candidate's id (the samples are only the first 25): the Owner ticks from this list and POST /flip confirms a subset of it.
        ids: bound.map((row) => row.character_id),
        byProof: tally(bound, 'proof'),
        classMismatch: mismatched.length,
        samples: byName.slice(0, BINDING_SAMPLES).map((row) => ({
          characterId: row.character_id, name: row.name, class: row.class, rosterRank: row.roster_rank, personId: row.person_id, userId: row.user_id || null, proof: row.proof,
        })),
      },
      // The approval covers the whole list (ids, not only the samples) and the class mismatches the Owner was told about.
      hashPart: { ids: bound.map((row) => row.character_id), classMismatch: mismatched.map((row) => row.character_id) },
    };
  },
};

export const ranksSection = {
  key: 'ranks',
  statements(db, guildId, options) {
    const { only, values } = restriction(options);
    return [
      db.prepare(transitionsSql('?1', only)).bind(guildId, ...values),
      db.prepare(rankSamplesSql('?1', only)).bind(guildId, ...values),
      db.prepare(RANK_GAPS_SQL).bind(guildId),
    ];
  },
  build([transitionResult, sampleResult, gapResult]) {
    const transitions = transitionResult.results.map((row) => ({ from: row.from_rank, to: row.to_rank, count: row.n }));
    const sum = (filter) => transitions.filter(filter).reduce((total, entry) => total + entry.count, 0);
    const unmapped = gapResult.results.map((row) => ({ rank: row.rank, members: row.members }));
    return {
      payload: {
        changed: sum(() => true),
        becomesTrial: sum((entry) => entry.to === 'trial'),
        becomesSocial: sum((entry) => entry.to === 'social'),
        transitions,
        samples: sampleResult.results.map((row) => ({ name: row.name, class: row.class, from: row.from_rank, to: row.to_rank })),
        unmapped,
      },
      hashPart: { transitions: transitions.map((entry) => [entry.from, entry.to, entry.count]), unmapped: unmapped.map((entry) => [entry.rank, entry.members]) },
    };
  },
};

export const notOnRosterSection = {
  key: 'notOnRoster',
  statements(db, guildId, options) {
    const { only, values } = restriction(options);
    return [db.prepare(notOnRosterSql(only)).bind(guildId, ...values)];
  },
  build([result]) {
    const rows = result.results;
    // Former first, then by name.
    const ordered = [...rows].sort((a, b) => (a.after_kind === b.after_kind ? (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : a.character_id < b.character_id ? -1 : 1) : (a.after_kind === 'former' ? -1 : 1)));
    return {
      payload: {
        count: rows.length,
        former: rows.filter((row) => row.after_kind === 'former').length,
        social: rows.filter((row) => row.after_kind === 'social').length,
        samples: ordered.slice(0, BINDING_SAMPLES).map((row) => ({ character: row.name, class: row.class, person: row.person || null, after: row.after_kind })),
      },
      hashPart: { characters: rows.map((row) => [row.character_id, row.after_kind]) },
    };
  },
};
