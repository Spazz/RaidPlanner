// The officer person join (user-hierarchy build, lane B6a): POST /api/guild/:gid/roster/:pid/join { otherPersonId, version, otherVersion }.
// Two roster persons become one (worker/person-join.js owns the rules, the table list and the journal). Rights: roster.edit for the whole guild (a join moves
// characters across teams, so a team-scoped editor cannot do it), and the Seniority guard on BOTH persons, checked before and again inside every statement of the batch.
// -> the survivor's person record (the roster person routes' shape) + { survivorId, loserId, counts }.
import { HttpError, jsonResponse } from '../http.js';
import { isId } from '../ids.js';
import { allows, loadGuildContext } from '../permissions.js';
import { joinPersonsStatements } from '../person-join.js';
import { personReply } from '../roster-view.js';
import { assertSenior, seniorityOk } from '../seniority.js';
import { bad, conflict, constraintOf } from './roster.js';

const readVersion = (value, field) => {
  if (!Number.isInteger(value) || value < 1) throw bad('Send the version you last saw.', field);
  return value;
};

export async function joinPerson(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!allows(guildContext.can, 'roster.edit', null)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  const guildId = guildContext.guild.id;
  const personId = ctx.params.pid;
  if (!isId('p', body.otherPersonId)) throw bad('Pick the person to join.', 'otherPersonId');
  if (body.otherPersonId === personId) throw bad('Pick two different people to join.', 'otherPersonId');
  const version = readVersion(body.version, 'version');
  const otherVersion = readVersion(body.otherVersion, 'otherVersion');

  // The Seniority guard (worker/seniority.js) on both persons: a clean 403 here, and the same SQL inside every statement of the batch.
  await assertSenior(db, guildContext, personId);
  await assertSenior(db, guildContext, body.otherPersonId);
  const actorId = ctx.session.user.id;

  let plan;
  try {
    plan = await joinPersonsStatements(db, {
      guildId,
      aId: personId,
      bId: body.otherPersonId,
      actorUserId: actorId,
      now: ctx.now(),
      reason: 'officer',
      randomBytes: ctx.randomBytes,
      guards: [seniorityOk(guildId, actorId, personId), seniorityOk(guildId, actorId, body.otherPersonId)],
      expectedVersions: { [personId]: version, [body.otherPersonId]: otherVersion },
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === 'conflict') return conflict(ctx, guildContext, personId, error.message);
    throw error;
  }
  let results;
  try {
    results = await db.batch(plan.statements);
  } catch (error) {
    // The unique indexes are the backstop of a race the guards cannot see (a character added to either person between the read and the write).
    if (['one_main', 'team_taken', 'identity_taken', 'character_name', 'foreign_key'].includes(constraintOf(error))) {
      return conflict(ctx, guildContext, personId, 'Someone changed one of these people. Reload and try again.');
    }
    throw error;
  }
  if (results[plan.appliedIndex].meta.changes !== 1) {
    return conflict(ctx, guildContext, personId, 'Someone changed one of these people. Reload and try again.');
  }
  const reply = await personReply(ctx, guildContext, plan.survivorId);
  return jsonResponse({ ...(reply || {}), survivorId: plan.survivorId, loserId: plan.loserId, counts: plan.counts });
}
