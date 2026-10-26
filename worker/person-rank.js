// Person-level reads of a per-character rank (user-hierarchy build, lane B1a-2). Pure: no database, no clock.
//
// Rank lives on the CHARACTER (characters.core_rank, left_on, trial_start, trial_end), a person has several, and the answers attendance needs are about the
// PERSON. This module is the one place that turns a person's characters into those answers, so nothing reads "the person's status" off whichever row a
// query returned first. There is deliberately no `status` scalar on a person object: every function below sorts or aggregates over ALL the characters,
// so the result never depends on the order the rows arrived in (tests/guild/guild-person-rank-tests.js runs every case with the rows reversed).
//
//   person    { playerId, characters: [ character ] }
//   character { id, key, teamId, isMain, coreRank, leftOn, leftReason, trialStart, trialEnd }   (characterOfRow(row) shapes a characters row)
//
//   expectedOnTeam(person, T, ranks)  the person's character placed on T is on the team roster (worker/team-roster.js) and its core_rank is in the
//                                     policy's expected set (ranks): "Raider main on A + teamless Social alt" is expected on A only
//   isOnTeamRoster(person, T)         the same without the policy set: a roster character on T
//   homeTeamId(person)                the team of the person's MAIN (null when the main is teamless, or there is none); the rank ladder reads the main too
//   leftOn(person)                    the person "left" when EVERY character has left_on; the latest date wins; else null
//   isGoneOn(person, day)             no character is still here on `day`: a character with a left_on date is here up to and including that day, a
//                                     character without one is here while its rank is a raiding rank (Social without a date is not)
//   hasCharacterHereOn(person, T, day) a character placed on T that is still here on `day` (the "No sign-up" row)
//   trialReviews(person)              one entry per roster character in Trial, each on its own team: "Raider main on A + Trial alt on B" lists B only
//   personFields(person)              the five fields the API still shows on a person (status, trial and left dates), worked out from the characters
//                                     (lane B2: the readers no longer look at the players row)
import { TEAM_ROSTER_RANKS, isTeamRosterCharacter } from './team-roster.js';

const text = (value) => (value === null || value === undefined ? '' : String(value));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byIdentity = (a, b) => byText(text(a.id), text(b.id)) || byText(text(a.key), text(b.key)) || byText(text(a.teamId), text(b.teamId));

// A characters row (snake_case, as the queries return it) -> the character shape above. `key` (name_key|realm_key) is the caller's to add.
export function characterOfRow(row) {
  return {
    id: row.id === undefined ? null : row.id,
    teamId: row.team_id === undefined ? null : row.team_id,
    isMain: row.is_main === 1 || row.is_main === true,
    coreRank: row.core_rank,
    leftOn: row.left_on === undefined ? null : row.left_on,
    leftReason: row.left_reason === undefined ? null : row.left_reason,
    trialStart: row.trial_start === undefined ? null : row.trial_start,
    trialEnd: row.trial_end === undefined ? null : row.trial_end,
  };
}

const charactersOf = (person) => (person && Array.isArray(person.characters) ? person.characters : []);

export function isOnTeamRoster(person, teamId) {
  if (teamId === null || teamId === undefined) return false;
  return charactersOf(person).some((character) => character.teamId === teamId && isTeamRosterCharacter(character));
}

export function expectedOnTeam(person, teamId, ranks) {
  if (teamId === null || teamId === undefined) return false;
  return charactersOf(person).some((character) => character.teamId === teamId && isTeamRosterCharacter(character) && ranks.includes(character.coreRank));
}

// The person's main character (the lowest identity when data has two). null when there is none.
export function mainCharacter(person) {
  return [...charactersOf(person)].filter((character) => character.isMain).sort(byIdentity)[0] || null;
}

export function homeTeamId(person) {
  const main = mainCharacter(person);
  return main && main.teamId !== undefined ? main.teamId : null;
}

// The rank the ladder reads: the main's core_rank.
export function mainRank(person) {
  const main = mainCharacter(person);
  return main ? main.coreRank : null;
}

export function leftOn(person) {
  const characters = charactersOf(person);
  if (!characters.length || characters.some((character) => !character.leftOn)) return null;
  return characters.reduce((latest, character) => (character.leftOn > latest ? character.leftOn : latest), '');
}

const isHereOn = (character, day) => (character.leftOn ? day <= character.leftOn : TEAM_ROSTER_RANKS.includes(character.coreRank));

export function isGoneOn(person, day) {
  const characters = charactersOf(person);
  return characters.length > 0 && !characters.some((character) => isHereOn(character, day));
}

// A character of the person placed on the team that is still here on `day` (a raiding rank, or a left-on date not yet passed): the "No sign-up" row asks this,
// so a Social alt that was never taken off a team does not make its person show up there.
export function hasCharacterHereOn(person, teamId, day) {
  if (teamId === null || teamId === undefined) return false;
  return charactersOf(person).some((character) => character.teamId === teamId && isHereOn(character, day));
}

export function trialReviews(person) {
  return [...charactersOf(person)]
    .filter((character) => character.coreRank === 'trial' && isTeamRosterCharacter(character))
    .sort((a, b) => byText(text(a.teamId), text(b.teamId)) || byIdentity(a, b))
    .map((character) => ({ characterId: character.id, teamId: character.teamId, trialStart: character.trialStart, trialEnd: character.trialEnd }));
}

// The five fields a person still shows in the API (roster rows, the person record, the export, attendance metrics), from ALL the characters:
//   status       the main's core_rank, 'social' shown as 'inactive' (the rank ladder reads the main); the lowest identity when there is no main;
//                'inactive' when the person has no character
//   trialStart / trialEnd   the main's, only while the main is in Trial
//   leftOn       leftOn(person): every character has left, the latest date; leftReason is the reason on the character that holds that date
// A break or an "other" reason is not a leaving: no character carries it (migration 0030's mapping), so it shows as null.
export function personFields(person) {
  const characters = charactersOf(person);
  const main = mainCharacter(person) || [...characters].sort(byIdentity)[0] || null;
  const left = leftOn(person);
  const leftCharacter = left === null ? null : [...characters].filter((character) => character.leftOn === left).sort(byIdentity)[0];
  const trial = !!main && main.coreRank === 'trial';
  return {
    status: !main ? 'inactive' : (main.coreRank === 'social' ? 'inactive' : main.coreRank),
    trialStart: trial ? main.trialStart || null : null,
    trialEnd: trial ? main.trialEnd || null : null,
    leftOn: left,
    leftReason: leftCharacter ? leftCharacter.leftReason || null : null,
  };
}
