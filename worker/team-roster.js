// The team-roster predicate (user-hierarchy build, lane B1a-2; U R6-Q2 and U R8-Q2).
//
// A character is on a TEAM ROSTER when it is
//   placed         characters.team_id IS NOT NULL
//   still here     characters.left_on IS NULL
//   a raiding rank characters.core_rank IN ('raider', 'trial', 'reserve')      (Social and Former are never on a team roster)
// It reads the CHARACTER columns, which migration 0030 added and every writer of a person's rank keeps current (worker/person-legacy.js).
//
// Used by every view that lists a team's people (roster lists and attendance rows) and by the rule that turns a character into team access:
//   the Roster read (roster-view.js), the public page and guest links (viewer.js roster and attendance sections), the API-key feeds (api-data.js roster and
//   attendance), ownTeamIds (permissions.js: a placed Social or Former character grants no team scope, another visible character of the person still does).
// NOT used for loot: loot history is not a roster view, every award shows whoever won it (an alt with no team wins loot too).
// One definition in two forms (SQL fragment and row test) so the two cannot drift; tests/guild/guild-team-roster-tests.js runs both over every combination.

export const TEAM_ROSTER_RANKS = Object.freeze(['raider', 'trial', 'reserve']);

const RANK_LIST = TEAM_ROSTER_RANKS.map((rank) => `'${rank}'`).join(', ');

// SQL: the predicate on a characters row, alias given ("c" -> "(c.team_id IS NOT NULL AND c.left_on IS NULL AND c.core_rank IN (...))"). Fixed text.
export const teamRosterSql = (alias) => `(${alias}.team_id IS NOT NULL AND ${alias}.left_on IS NULL AND ${alias}.core_rank IN (${RANK_LIST}))`;

// SQL: on the roster of ONE team (teamExpr is an expression, never a bare `?` used twice).
export const onTeamRosterSql = (alias, teamExpr) => `(${alias}.team_id = ${teamExpr} AND ${teamRosterSql(alias)})`;

// SQL: the person (an expression for the player id, e.g. "p.id") has a character on the roster of ONE team. This is the question every team-scoped list asks
// (who may sign up, who gets reminded, who is in the funnel, who is counted on the Teams page): one rule, not a copy of it per page.
export const personOnTeamRosterSql = (playerExpr, teamExpr) =>
  `EXISTS (SELECT 1 FROM characters rc WHERE rc.player_id = ${playerExpr} AND ${onTeamRosterSql('rc', teamExpr)})`;

// SQL: the core rank of the person's character on the roster of ONE team (raider | trial | reserve), NULL when the person is not on that roster. With two
// characters on one team (data from before the one-per-team rule) the main's, then the lowest id.
export const rosterRankOnTeamSql = (playerExpr, teamExpr) =>
  `(SELECT rc.core_rank FROM characters rc WHERE rc.player_id = ${playerExpr} AND ${onTeamRosterSql('rc', teamExpr)} ORDER BY rc.is_main DESC, rc.id LIMIT 1)`;

// The same test on a character as the Worker shapes it: { teamId, leftOn, coreRank } (worker/person-rank.js characterOfRow makes it from a row).
export const isTeamRosterCharacter = (character) => !!character && character.teamId !== null && character.teamId !== undefined
  && (character.leftOn === null || character.leftOn === undefined) && TEAM_ROSTER_RANKS.includes(character.coreRank);

// The same test on a raw characters row (snake_case columns).
export const isTeamRosterRow = (row) => !!row && row.team_id !== null && row.team_id !== undefined
  && (row.left_on === null || row.left_on === undefined) && TEAM_ROSTER_RANKS.includes(row.core_rank);
