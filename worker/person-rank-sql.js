// Person-level answers in SQL, from the CHARACTER columns (user-hierarchy build, lane B2). Before B2 every reader asked worker/person-legacy.js for a fragment over the
// players row (status, trial and left dates); since R2 those five fields live on the characters, so a reader that needs "the person's rank" asks here and a reader
// that needs "is this person on team T's roster" uses worker/team-roster.js (personOnTeamRosterSql, rosterRankOnTeamSql).
//
// A person has no rank of its own: the answer is the MAIN's core_rank, the rank the ladder reads (worker/person-rank.js). The main is unique per person
// (characters_one_main); the ORDER BY only keeps a person whose data has no main deterministic. All fragments take a SQL expression for the person id
// ("p.id", "?3", ...) and hold fixed text, never request data.

import { visibleCharacterSql } from './character-visibility.js';

// The core rank of the person's main: raider | trial | reserve | social, or NULL for a person without a character.
// (A retired placeholder, worker/character-visibility.js, never gives a person its rank: a person with nothing else has none.)
export const personRankSql = (playerExpr) =>
  `(SELECT mr.core_rank FROM characters mr WHERE mr.player_id = ${playerExpr} AND ${visibleCharacterSql('mr')} ORDER BY mr.is_main DESC, mr.id LIMIT 1)`;

// The status the API shows for the person: the main's core rank, 'social' as 'inactive' (the five-value vocabulary of the roster pages and exports).
export const personStatusSql = (playerExpr) =>
  `(SELECT CASE mr.core_rank WHEN 'social' THEN 'inactive' ELSE mr.core_rank END FROM characters mr WHERE mr.player_id = ${playerExpr} AND ${visibleCharacterSql('mr')} ORDER BY mr.is_main DESC, mr.id LIMIT 1)`;
