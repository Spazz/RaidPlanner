// The team-roster predicate (user-hierarchy build, lane B1a-2; U R6-Q2 and U R8-Q2).
//
// A character is on a TEAM ROSTER when it is
//   placed         characters.team_id IS NOT NULL
//   still here     characters.left_on IS NULL
//   a raiding rank characters.core_rank IN ('raider', 'trial', 'reserve')      (Social and Former are never on a team roster)
// It reads the CHARACTER columns, which migration 0030 added and the dual write (worker/person-legacy.js) keeps current from R1 on.
//
// Used by every view that lists a team's people and by the rule that turns a character into team access:
//   the Roster read (roster-view.js), the public page and guest links (viewer.js), the API-key feeds (api-data.js), the public attendance and loot
//   sections, ownTeamIds (permissions.js: a placed Social or Former character grants no team scope, another visible character of the person still does).
// One definition in two forms (SQL fragment and row test) so the two cannot drift; tests/guild/guild-team-roster-tests.js runs both over every combination.

import { winnerNameKeySql } from './name-alias.js';

export const TEAM_ROSTER_RANKS = Object.freeze(['raider', 'trial', 'reserve']);

const RANK_LIST = TEAM_ROSTER_RANKS.map((rank) => `'${rank}'`).join(', ');

// SQL: the predicate on a characters row, alias given ("c" -> "(c.team_id IS NOT NULL AND c.left_on IS NULL AND c.core_rank IN (...))"). Fixed text.
export const teamRosterSql = (alias) => `(${alias}.team_id IS NOT NULL AND ${alias}.left_on IS NULL AND ${alias}.core_rank IN (${RANK_LIST}))`;

// SQL: on the roster of ONE team (teamExpr is an expression, never a bare `?` used twice).
export const onTeamRosterSql = (alias, teamExpr) => `(${alias}.team_id = ${teamExpr} AND ${teamRosterSql(alias)})`;

// The same test on a character as the Worker shapes it: { teamId, leftOn, coreRank } (worker/person-rank.js characterOfRow makes it from a row).
export const isTeamRosterCharacter = (character) => !!character && character.teamId !== null && character.teamId !== undefined
  && (character.leftOn === null || character.leftOn === undefined) && TEAM_ROSTER_RANKS.includes(character.coreRank);

// The same test on a raw characters row (snake_case columns).
export const isTeamRosterRow = (row) => !!row && row.team_id !== null && row.team_id !== undefined
  && (row.left_on === null || row.left_on === undefined) && TEAM_ROSTER_RANKS.includes(row.core_rank);

// SQL for the public loot lists (public page, guest links, API-key feed): an award is left out when its winner is a character of this guild that is NOT on a
// team roster (Social, Former or teamless). A winner who matches no character (a guest, an unknown name) and a disenchant (no winner) stay; so does a winner
// who is on ANY team's roster (a fill-in winning on another team's raid). The winner's name is read through the alias helper (worker/name-alias.js), dated at the award.
export const notWonOffRosterSql = (alias = 'a') => `NOT EXISTS (SELECT 1 FROM characters wc
        WHERE wc.guild_id = ${alias}.guild_id AND wc.name_key = ${winnerNameKeySql(alias)} AND wc.realm_key = ${alias}.winner_realm_key
          AND NOT ${teamRosterSql('wc')})`;
