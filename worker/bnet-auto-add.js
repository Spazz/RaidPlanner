// The max-level rule (user decision 2026-10-24, B8b "My characters"): a Battle.net character at the level cap of its game version (worker/realms.js maxLevelOf: 70 TBC
// Anniversary, 60 Classic Era) on the guild's OWN realm joins the member's profile in each of their guilds of that version when Battle.net connects and at every refresh, with
// the same plan, writes, proof and audit rows as the Add on My characters (worker/claim-apply.js applyPicks, source 'bnet'). Lower characters, and max-level characters on
// another realm of the version and region (R4 F3, 2026-10-28), stay on the list: the member picks them ("Add N characters"). A ruleset guild (WoW Forever) has no realm,
// so every max-level character counts there. Called by the Battle.net callback after the sign-in match, with the snapshot it just wrote; it never fails the callback.
//   - A character a manual add would refuse (already on the record, on someone else's linked person, a claim waiting) is left alone; a conflict becomes the usual claim that
//     waits for an officer ("Waiting for an officer"); one an officer turned down before is not asked again at every refresh.
//   - The callback's D1 statement budget (worker/bnet-match.js CALLBACK_STATEMENT_BUDGET) holds: what does not fit waits for the next refresh and stays offered under "Add".
//   - The picks are every character at the cap, not only the first few: the ones already on the profile drop out when the plan is made, so a person with more characters than
//     fit one callback gets the rest at the next refresh instead of seeing the same ones again.
import { NAMESPACES, bnetSupport } from './battlenet.js';
import { loadMemberGuilds } from './bnet-store.js';
import { CALLBACK_STATEMENT_BUDGET } from './bnet-match.js';
import { applyPicks, snapshotIdentity } from './claim-apply.js';
import { maxLevelOf } from './realms.js';
import { cleanCharacterName, realmKey } from './roster-data.js';
import { resolveRealm } from './routes/roster.js';

// The D1 statements the smallest useful run costs: for one guild the plan (3), the claim reads (3) and the writes of one character (3); the first guild also needs the
// member's guilds, their rows and the Discord ID read (3).
const GUILD_MIN_STATEMENTS = 9;
const START_MIN_STATEMENTS = GUILD_MIN_STATEMENTS + 3;

const byLevelThenName = (a, b) => (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name);

// The picks of ONE guild: the characters of its namespace at the level cap, on the guild's own realm (same realmKey as the roster; a ruleset guild has none and takes all),
// with a name a roster can hold, one per name and realm.
// -> [{ index, name, realm: { realm, key }, class, level, identity }] (applyPicks' shape), best first. identity: the Blizzard key the snapshot holds for the character in the
// guild's profile `namespace` (worker/claim-apply.js snapshotIdentity), or null.
export function maxLevelPicks(guild, entry, namespace = null) {
  const cap = maxLevelOf(guild.game_version);
  if (cap === null || !entry || entry.error || !Array.isArray(entry.characters)) return [];
  const ownRealmOnly = guild.realm_kind !== 'ruleset';
  const guildRealmKey = realmKey(guild.realm);
  const seen = new Set();
  const picks = [];
  for (const character of [...entry.characters].sort(byLevelThenName)) {
    if (!Number.isInteger(character.level) || character.level < cap) continue;
    const name = cleanCharacterName(character.name);
    const realm = resolveRealm(guild, character.realm);
    if (!name || !realm) continue;
    if (ownRealmOnly && realm.key !== guildRealmKey) continue;
    const key = `${name.toLowerCase()}|${realm.key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ index: picks.length, name, realm, class: character.class, level: character.level, identity: snapshotIdentity(character, namespace) });
  }
  return picks;
}

// Does the snapshot hold a character at the level cap of its version at all? Reading nothing from D1 first keeps a callback that has nothing to add as cheap as before.
export function hasMaxLevelCharacter(snapshot) {
  for (const [namespace, entry] of Object.entries(snapshot && typeof snapshot === 'object' ? snapshot : {})) {
    const version = Object.keys(NAMESPACES).find((key) => NAMESPACES[key].profile && namespace.startsWith(`${NAMESPACES[key].profile}-`));
    const cap = version ? maxLevelOf(version) : null;
    if (cap !== null && entry && Array.isArray(entry.characters) && entry.characters.some((character) => character && Number.isInteger(character.level) && character.level >= cap)) return true;
  }
  return false;
}

// ctx: { db, now, randomBytes, log }.   input: { userId, snapshot (what the callback stored), spent (the D1 statements the callback has used so far) }
// -> { statements: the total the callback has used, added: characters that joined the profile, waiting: conflicts filed for an officer, deferred: boolean }
export async function autoAddMaxLevel(ctx, { userId, snapshot, spent }) {
  const { db } = ctx;
  let used = spent;
  const outcome = (extra = {}) => ({ statements: used, added: 0, waiting: 0, deferred: false, ...extra });
  if (!hasMaxLevelCharacter(snapshot)) return outcome();
  if (used + START_MIN_STATEMENTS > CALLBACK_STATEMENT_BUDGET) {
    ctx.log('bnet auto-add deferred: budget');
    return outcome({ deferred: true });
  }
  const memberGuilds = await loadMemberGuilds(db, userId);
  used += 1;
  const wanted = [];
  for (const guild of memberGuilds) {
    const support = bnetSupport(guild.game_version, guild.region);
    if (!support.supported) continue;
    const picks = maxLevelPicks(guild, snapshot && snapshot[support.namespace], support.namespace);
    if (picks.length) wanted.push({ id: guild.id, picks });
  }
  if (!wanted.length) return outcome();

  const [guildRows, userRow] = await db.batch([
    db.prepare(
      `SELECT id, name, realm, realm_kind, realm_slug, region, discord_server_id, time_zone, game_version, wcl_guild_id, created_at
         FROM guilds WHERE id IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(wanted.map((row) => row.id))),
    db.prepare('SELECT discord_id FROM users WHERE id = ?').bind(userId),
  ]);
  used += 2;
  const guilds = new Map(guildRows.results.map((row) => [row.id, row]));
  const discordId = userRow.results[0] ? userRow.results[0].discord_id : null;
  const asMember = { ...ctx, session: { user: { id: userId, discordId } } };
  const result = outcome();
  for (const { id, picks } of wanted) {
    const guild = guilds.get(id);
    if (!guild) continue;
    if (used + GUILD_MIN_STATEMENTS > CALLBACK_STATEMENT_BUDGET) {
      result.deferred = true;
      break;
    }
    try {
      const done = await applyPicks(asMember, { guild }, picks, { source: 'bnet', auto: { statementsLeft: CALLBACK_STATEMENT_BUDGET - used } });
      used += done.statements;
      for (const claim of done.claims) {
        if (claim.status === 'applied') result.added++;
        else if (claim.status === 'pending') result.waiting++;
      }
      // What did not fit waits for the next refresh; until then the page offers it under Add.
      if (done.trimmed) result.deferred = true;
    } catch (error) {
      // A person or guild that is full refuses the batch (the cap triggers): nothing was written, and the next refresh tries again.
      if (error && /_limit$/.test(String(error.code))) {
        result.deferred = true;
        ctx.log('bnet auto-add deferred: cap');
      } else ctx.log(`bnet auto-add failed: ${error && error.code ? error.code : error && error.message}`);
    }
  }
  result.statements = used;
  if (result.deferred) ctx.log('bnet auto-add deferred: some characters wait for the next refresh');
  return result;
}
