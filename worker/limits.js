// The limits that keep one guild (or one account) from taking more than its share of the database (Phase 8). One place, so the routes, the
// messages and the tests quote the same numbers.
//   teams             active (not archived) teams per guild: checked in worker/routes/teams.js and when a guild is created
//   people            people per guild: the players_cap trigger (migration 0002)
//   characters        characters per guild: the characters_guild_cap trigger (migration 0016); a person may also hold at most 20 (characters_cap)
//   guildsPerAccount  guilds one account may create (guilds.created_by); deleting a guild frees its place
export const LIMITS = Object.freeze({
  teams: 10,
  people: 1000,
  characters: 5000,
  charactersPerPerson: 20,
  guildsPerAccount: 5,
});

export const TEAM_LIMIT_MESSAGE = `A guild can have at most ${LIMITS.teams} active teams. Archive one first.`;
export const GUILD_LIMIT_MESSAGE = `One account can create at most ${LIMITS.guildsPerAccount} guilds. Delete one you no longer use first.`;
