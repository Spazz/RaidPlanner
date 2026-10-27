// What the setup pin (worker/guild-pin.js, worker/routes/bnet-pin.js) is asked for, and who may ask: pure functions, no database, no Blizzard.
//
// THE TARGET. The Owner names the in-game guild by its name and its realm. Both become slugs (the same normalisation as Guild settings > Battle.net: worker/battlenet.js guildSlug,
// realmSlugOf), and the SLUGS are what the fresh-auth grant is bound to (worker/fresh.js freshHash): the guild name typed with other capitals, spaces or an apostrophe is the same
// act. The start step (POST .../fresh/start { purpose: 'pin', params: { guildName, realmSlug } }) and the pin route (POST .../bnet/pin { guildName, realmSlug }) read the target through
// readPinTarget, so they cannot disagree about what the grant covers.
//
// THE ALLOWLIST. SETUP_PIN_GUILDS is an operator var of the Worker (plan, release R4): a comma-separated list of Raidsmith guild ids that may pin, '*' for every guild. Unset, empty or
// a list without the guild's id: nobody (403 pin_not_open). It is the one switch between "the user pins Vindicated first" and "every Owner may pin".
import { guildSlug, isRealmSlug, realmSlugOf } from './battlenet.js';
import { SINGLE_LINE_STRIP } from './roster-data.js';

export const MAX_GUILD_NAME = 32;
const TARGET_KEYS = ['guildName', 'realmSlug'];

// -> { target: { guildName, guildSlug, realmSlug } } | { problem, field }. `input` is the request body or the fresh params; extra keys are ignored here (the fresh params check
// for them separately: pinParamsProblem).
export function readPinTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { problem: 'Send the in-game guild name and its realm.', field: 'guildName' };
  if (typeof input.guildName !== 'string') return { problem: 'The in-game guild name must be text.', field: 'guildName' };
  const guildName = input.guildName.replace(SINGLE_LINE_STRIP, '').replace(/\s+/g, ' ').trim();
  const slug = guildSlug(guildName);
  if (!guildName || Array.from(guildName).length > MAX_GUILD_NAME || !slug) return { problem: 'The in-game guild name is 1 to 32 letters, digits and spaces.', field: 'guildName' };
  if (typeof input.realmSlug !== 'string') return { problem: 'The realm must be text.', field: 'realmSlug' };
  const typed = input.realmSlug.trim();
  const realmSlug = isRealmSlug(typed) ? typed : realmSlugOf(typed);
  if (!realmSlug) return { problem: 'Enter the realm as its name or its URL slug, for example "old-blanchy".', field: 'realmSlug' };
  return { target: { guildName, guildSlug: slug, realmSlug } };
}

// The sentence for fresh params that are not exactly { guildName, realmSlug } (a valid target), or null.
export function pinParamsProblem(params) {
  if (Object.keys(params).sort().join(',') !== TARGET_KEYS.join(',')) return 'A pin needs params { guildName, realmSlug }.';
  const read = readPinTarget(params);
  return read.problem || null;
}

// The params the grant's hash covers: the slugs, so the act and its start step agree whatever the typing.
export const canonicalPinParams = (target) => ({ guildSlug: target.guildSlug, realmSlug: target.realmSlug });

// Fresh params as the HASH sees them, per purpose: the pin's become slugs, every other purpose's are the params as sent.
export function canonicalFreshParams(purpose, params) {
  if (purpose !== 'pin') return params;
  const read = readPinTarget(params);
  return read.target ? canonicalPinParams(read.target) : params;
}

// Is the setup pin open for this guild? SETUP_PIN_GUILDS: '*' = every guild, else a comma-separated list of guild ids; unset or empty = nobody.
export function pinOpen(env, guildId) {
  const raw = env && typeof env.SETUP_PIN_GUILDS === 'string' ? env.SETUP_PIN_GUILDS : '';
  const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.includes('*') || (typeof guildId === 'string' && entries.includes(guildId));
}

export const PIN_NOT_OPEN_MESSAGE = 'Linking this guild to its in-game guild is not open yet.';

// ---------------------------------------------------------------------------
// The rank source of a switch (plan "Source/pin" rule (6)); the helpers that use them are in worker/guild-pin.js.
export const RANK_SOURCES = Object.freeze([null, 'manual', 'ingame']);

export const involvesIngame = (from, to) => from === 'ingame' || to === 'ingame';
export const leavesIngame = (from, to) => from === 'ingame' && to !== 'ingame';

// The sentence for a switch that cannot be (an unknown source, no change), or null.
export function sourceSwitchProblem(from, to) {
  if (!RANK_SOURCES.includes(from) || !RANK_SOURCES.includes(to)) return 'The rank source is the legacy rule (null), manual or ingame.';
  if (from === to) return 'The guild already runs on that rank source.';
  return null;
}

// The params the source_switch grant is bound to: { from, to } (null = the legacy rule).
export const sourceSwitchParams = (from, to) => ({ from, to });

// The sentence for fresh params that are not a possible switch { from, to }, or null.
export function sourceSwitchParamsProblem(params) {
  if (Object.keys(params).sort().join(',') !== 'from,to') return 'A source switch needs params { from, to }.';
  return sourceSwitchProblem(params.from === undefined ? 'x' : params.from, params.to === undefined ? 'x' : params.to);
}
