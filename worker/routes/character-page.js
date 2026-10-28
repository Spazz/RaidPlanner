// The Character page (user-hierarchy build, lane B8b "character"): an owner's own character, read and the two things its owner may do without roster.edit.
//   GET    /api/me/characters/:cid   -> the page (worker/character-page.js characterPageReply)
//   PATCH  /api/me/characters/:cid   { mainSpec?, offSpec? }   the owner changes the two specs; -> the page
//   DELETE /api/me/characters/:cid                             the owner removes their own ALT; -> { removed: true }
// A character id is unique across guilds, so the routes carry no guild id: the character names its guild. OWNER ONLY: anything that is not a character of the account's own
// person is 404 (worker/character-page.js loadOwnedCharacter). Officers keep their own routes (worker/routes/roster.js patchCharacter / removeCharacter, roster.edit and the Seniority guard).
// The owner's removal is refused for a Main (409 main_character) and for a Battle.net-proven character in a guild whose in-game roster decides (403 seniority, the wording of
// worker/seniority.js PROVEN_MESSAGE: the sync removes it when it leaves the guild); both rules are repeated inside the write, so a race changes nothing.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { nameKey } from '../roster-data.js';
import { PROVEN_MESSAGE } from '../seniority.js';
import { markRaidsStale, weekFreeze } from '../attendance-store.js';
import { visibleCharacterSql } from '../character-visibility.js';
import { DELETE_SQL, MAIN_MESSAGE, REMOVABLE_SQL, UPDATE_SPECS_SQL, characterPageReply, loadOwnedCharacter } from '../character-page.js';
import { wrote } from '../d1-changes.js';
import { bad, readSpecs } from './roster.js';

// An audit row guard for the statement right before it in the same batch: true only if that write changed one row.
const CHANGED_ONE = { sql: 'changes() = 1', params: [] };

const audit = (ctx, guildContext, action, entityId, before, after, guard) => auditStatement(ctx, {
  guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action, entityType: 'character', entityId, before, after,
}, guard);

export async function getMyCharacter(ctx) {
  const { guildContext, personId, characterId } = await loadOwnedCharacter(ctx);
  return jsonResponse(await characterPageReply(ctx, guildContext, personId, characterId));
}

export async function patchMyCharacter(ctx) {
  const { db, body } = ctx;
  const { guildContext, personId, characterId } = await loadOwnedCharacter(ctx);
  const guild = guildContext.guild;
  if (body.mainSpec === undefined && body.offSpec === undefined) throw bad('Send a spec to change.', 'mainSpec');
  const current = await db.prepare(`SELECT class, team_id, main_spec, off_spec FROM characters WHERE id = ? AND guild_id = ? AND player_id = ? AND ${visibleCharacterSql('characters')}`).bind(characterId, guild.id, personId).first();
  if (!current) throw new HttpError(404, 'not_found', 'That character was not found.');
  const specs = readSpecs(body.mainSpec === undefined ? current.main_spec : body.mainSpec, body.offSpec === undefined ? current.off_spec : body.offSpec, current.class);
  const changed = [];
  if (specs.mainSpec !== current.main_spec) changed.push('mainSpec');
  if (specs.offSpec !== current.off_spec) changed.push('offSpec');
  if (changed.length) {
    const results = await db.batch([
      db.prepare(UPDATE_SPECS_SQL).bind(specs.mainSpec, specs.offSpec, ctx.now(), characterId, personId, guild.id, current.main_spec, current.off_spec, personId, guild.id, ctx.session.user.id),
      audit(ctx, guildContext, 'character.update', characterId,
        { teamId: current.team_id, class: current.class, mainSpec: current.main_spec, offSpec: current.off_spec },
        { teamId: current.team_id, class: current.class, mainSpec: specs.mainSpec, offSpec: specs.offSpec, changed, self: true }, CHANGED_ONE),
    ]);
    if (!wrote(results[0])) {
      throw new HttpError(409, 'conflict', 'This character changed meanwhile. The page now shows its current state.', { current: await characterPageReply(ctx, guildContext, personId, characterId) });
    }
  }
  return jsonResponse(await characterPageReply(ctx, guildContext, personId, characterId));
}

export async function removeMyCharacter(ctx) {
  const { db } = ctx;
  const { guildContext, personId, characterId } = await loadOwnedCharacter(ctx);
  const guild = guildContext.guild;
  const target = await db.prepare(
    `SELECT c.id, c.name, c.team_id, c.class, c.main_spec, c.off_spec, c.is_main, c.owner_proof, (SELECT rank_source FROM guilds WHERE id = c.guild_id) AS rank_source
       FROM characters c WHERE c.id = ? AND c.guild_id = ? AND c.player_id = ? AND ${visibleCharacterSql('c')}`,
  ).bind(characterId, guild.id, personId).first();
  if (!target) throw new HttpError(404, 'not_found', 'That character was not found.');
  if (target.is_main === 1) throw new HttpError(409, 'main_character', MAIN_MESSAGE);
  if (target.owner_proof === 'bnet' && target.rank_source === 'ingame') throw new HttpError(403, 'seniority', PROVEN_MESSAGE);
  const owner = [personId, guild.id, ctx.session.user.id];
  const removable = { sql: REMOVABLE_SQL, params: [characterId, personId, guild.id, guild.id, ...owner] };
  const results = await db.batch([
    audit(ctx, guildContext, 'character.delete', characterId,
      { personId, teamId: target.team_id, class: target.class, mainSpec: target.main_spec, offSpec: target.off_spec, self: true }, null, removable),
    db.prepare(DELETE_SQL).bind(characterId, personId, guild.id, guild.id, ...owner),
    markRaidsStale(db, guild.id, [nameKey(target.name)], null, target.team_id ? [target.team_id] : [], null, weekFreeze(guild.time_zone, ctx.now())),
  ]);
  if (results[1].results.length !== 1) {
    // A lost race: the character is gone already (nothing left to remove), or became a Main, or Battle.net proved it meanwhile.
    const again = await db.prepare(`SELECT is_main FROM characters WHERE id = ? AND guild_id = ? AND ${visibleCharacterSql('characters')}`).bind(characterId, guild.id).first();
    if (!again) throw new HttpError(404, 'not_found', 'That character was not found.');
    if (again.is_main === 1) throw new HttpError(409, 'main_character', MAIN_MESSAGE);
    throw new HttpError(403, 'seniority', PROVEN_MESSAGE);
  }
  return jsonResponse({ removed: true, characterId });
}
