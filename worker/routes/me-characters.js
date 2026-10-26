// A member adds a character to their OWN record by hand (user-hierarchy build, lane B3; characters/teams decision D2: "any method, applied at once").
//   POST /api/guild/:gid/me/characters   { name, class, mainSpec?, offSpec?, realm? }   -> 201 { claims: [one result] }
// The result is the one of Battle.net claims (worker/claim-apply.js applyPicks): status applied (add_alt | new_person), or pending when it needs an officer
// (the name is on a person nobody linked: typing a name proves nothing, so this route never links an account to a person by itself). A name on someone else's
// linked person is 409 name_taken, one on your own record 409 already_yours.
// Only for guilds whose characters are not decided by Battle.net: in a guild whose rank source is the in-game roster ('ingame') characters are added to an
// account ONLY through Battle.net (U In-game guilds), so a typed one is refused with 409 battlenet_only.
import { HttpError, jsonResponse } from '../http.js';
import { applyPicks } from '../claim-apply.js';
import { loadGuildContext } from '../permissions.js';
import { enforceRateLimit } from '../ratelimit.js';
import { bad, readClass, readName, readSpecs, resolveRealm } from './roster.js';

export const HAND_ADDS_PER_HOUR = 20;
const HAND_WINDOW_MS = 60 * 60 * 1000;

export async function addMyCharacter(ctx) {
  const { db, body, session } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid, session.viewAs);
  const guild = guildContext.guild;
  const source = await db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guild.id).first();
  if (source && source.rank_source === 'ingame') {
    throw new HttpError(409, 'battlenet_only', 'In this guild characters are added to your record with Battle.net. Connect it on your profile and pick them from your list.');
  }
  const name = readName(body.name, 'name', {}, guild.game_version);
  const classId = readClass(body.class);
  const { mainSpec, offSpec } = readSpecs(body.mainSpec, body.offSpec, classId);
  const realm = resolveRealm(guild, body.realm);
  if (!realm) throw bad('That realm is not one this guild takes.', 'realm');
  await enforceRateLimit(db, session.user.id, ctx.now(), { key: `char:${session.user.id}`, limit: HAND_ADDS_PER_HOUR, windowMs: HAND_WINDOW_MS });
  const result = await applyPicks(ctx, guildContext, [{ index: 0, name, realm, class: classId, mainSpec, offSpec }], { source: 'hand', field: 'name' });
  return jsonResponse(result, 201);
}
