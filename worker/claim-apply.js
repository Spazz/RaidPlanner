// Putting a claimed character on a person's record (user-hierarchy build, lane B3; characters/teams decisions D2, D2b, D2c, D2e).
//
// D2   anybody adds characters to their OWN record by any method (Battle.net, or typed by hand), applied at once; only a conflict goes to the officers.
// D2b  a character on a person nobody has linked, claimed by an account with no person: the account is linked to that person at once.
// D2c  a conflict (the character is on a person nobody linked while the claimant has their own person) is a pending claim; the officer rejects it and fixes the
//      roster by hand. A character on someone else's LINKED person is refused outright (409 name_taken).
// D2e  claims that were already waiting when this shipped are applied by POST /claims/apply (applyPendingClaims in routes/bnet-claims.js).
//
// ONE function writes a claim's outcome, applyClaimPlan, whoever decides: the claimant (createClaims for Battle.net, POST /me/characters by hand) or an officer
// (approveClaim, applyPendingClaims). It returns the guarded statements of one outcome; the caller adds its own audit row and, for a pending claim, closes it.
//   add_alt       the claimant has a person: the character joins it as an Alt on NO team (U R3-Q1/R4-Q1)
//   new_person    the claimant has no person and the character is on no roster: a new person (status trial) with the character as Main, on the team asked for or none
//   link_person   the character is on a person nobody linked and the claimant has none: the claimant's account links to that person (no character is added)
// A hand-typed character is not proven by anything: `source: 'hand'` marks it (owner_proof 'hand'), and a hand-typed name that is on an unlinked person is
// NOT linked at once (anyone could type anybody's name): it waits for an officer like any conflict. Typing a name never blocks the one whom Battle.net proves
// owns it: a Battle.net claim on a name closes a pending TYPED claim on it (level NULL), and a Battle.net claim on a character somebody else typed in
// (owner_proof 'hand' on another person) waits for an officer instead of being refused. Re-homing such a character is lane B6a ("Battle.net wins").
import { auditStatement } from './audit.js';
import { markPersonRaidsStale, markRaidsStale } from './attendance-store.js';
import { planClaims } from './bnet-store.js';
import { HttpError } from './http.js';
import { newId } from './ids.js';
import { ownPlayerSql } from './membership.js';
import { RANK_COLUMNS_SQL, characterRankColumns, rankBinds } from './person-legacy.js';
import { nameKey } from './roster-data.js';
import { guildToday } from './roster-view.js';
import { constraintOf, limitError } from './routes/roster.js';

export const ALWAYS = { sql: '1 = 1', params: [] };
export const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
export const MAX_PENDING_PER_GUILD = 20;
const and = (...guards) => ({ sql: guards.map((guard) => `(${guard.sql})`).join(' AND '), params: guards.flatMap((guard) => guard.params) });

// The claimant still owns this person / still has no person: guards of the writes below (ownPlayerSql repeats its user, so it is bound twice).
const ownsPerson = (guildId, personId, userId) => ({
  sql: `EXISTS (SELECT 1 FROM players op WHERE op.id = ? AND op.guild_id = ? AND ${ownPlayerSql('op', '?')})`, params: [personId, guildId, userId, userId],
});
const hasNoPerson = (guildId, userId) => ({
  sql: `NOT EXISTS (SELECT 1 FROM players np WHERE np.guild_id = ? AND ${ownPlayerSql('np', '?')})`, params: [guildId, userId, userId],
});
const personIsTheirs = (personId, userId) => ({ sql: 'EXISTS (SELECT 1 FROM players WHERE id = ? AND user_id = ?)', params: [personId, userId] });

// The rank columns come from `rank` for the first character of a new person and from the person's main for every later one (worker/person-legacy.js).
const INSERT_CHARACTER_SQL = `INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, main_spec, off_spec, is_main, created_at, updated_at,
                             core_rank, left_on, left_reason, trial_start, trial_end, owner_proof)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${RANK_COLUMNS_SQL}, ? WHERE `;
// The players row of a new person. The rank is the Main's (the INSERT INTO characters above); players.status is the inert placeholder (worker/person-legacy.js).
const INSERT_PLAYER_SQL = `INSERT INTO players (id, guild_id, status, joined_on, discord_user_id, discord_nickname, user_id, version, notes_version, created_by, created_at, updated_at)
       SELECT ?, ?, 'raider', ?, ?, NULL, ?, 1, 0, ?, ?, ? WHERE `;
const LINK_PERSON_SQL = `UPDATE players SET discord_user_id = ?, user_id = ?, discord_nickname = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND guild_id = ? AND discord_user_id IS NULL AND user_id IS NULL
          AND EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?) AND `;
const INSERT_CLAIM_SQL = `INSERT INTO character_claims (id, guild_id, user_id, name, name_key, realm, realm_key, class, level, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`;

// -> { writes, stale, personId, characterId } : `writes` are guarded statements for a db.batch, the LAST one is the key write (changes() = 1 when the outcome
// happened); `stale` marks the raids that depend on it (put them after the audit row).
//   plan       a plan of worker/bnet-store.js planClaims ({ kind: add_alt | new_person | link_person, person, homeTeamId, characterId })
//   claimant   { userId, discordId }          character { name, realm, realmKey, class, mainSpec?, offSpec? }
//   personId   the person new_person creates (the caller needs the id for later picks of the same request)
//   actorId    who writes (the claimant, or the officer deciding)                guard   another guard every write carries (a claim still pending)
export function applyClaimPlan(ctx, { guild, plan, claimant, character, source, now, actorId, personId = null, guard = ALWAYS, team = null, status = 'trial' }) {
  const { db } = ctx;
  const proof = source === 'hand' ? 'hand' : 'officer';
  const key = nameKey(character.name);
  const characterId = newId('c', ctx.randomBytes);
  const insert = (playerId, isMain, rank, teamId, extra) => {
    const g = and(guard, extra);
    return db.prepare(INSERT_CHARACTER_SQL + g.sql).bind(
      characterId, guild.id, playerId, teamId, character.name, key, character.realm, character.realmKey, character.class, character.mainSpec || null, character.offSpec || null,
      isMain ? 1 : 0, now, now, ...rankBinds(rank, playerId), proof, ...g.params,
    );
  };
  if (plan.kind === 'add_alt') {
    return {
      writes: [insert(plan.person.id, false, null, null, ownsPerson(guild.id, plan.person.id, claimant.userId))],
      stale: [markRaidsStale(db, guild.id, [key], null, [])], personId: plan.person.id, characterId,
    };
  }
  if (plan.kind === 'new_person') {
    const created = personId || newId('p', ctx.randomBytes);
    const today = guildToday(guild, now);
    const trialStart = status === 'trial' ? today : null;
    const g = and(guard, hasNoPerson(guild.id, claimant.userId));
    return {
      writes: [
        db.prepare(INSERT_PLAYER_SQL + g.sql).bind(created, guild.id, today, claimant.discordId || null, claimant.userId, actorId, now, now, ...g.params),
        insert(created, true, characterRankColumns({ status, trialStart }), team ? team.id : null, personIsTheirs(created, claimant.userId)),
      ],
      stale: [markRaidsStale(db, guild.id, [key], null, team ? [team.id] : [])], personId: created, characterId,
    };
  }
  if (plan.kind === 'link_person') {
    const g = and(guard, hasNoPerson(guild.id, claimant.userId));
    return {
      writes: [db.prepare(LINK_PERSON_SQL + g.sql).bind(claimant.discordId || null, claimant.userId, now, plan.person.id, guild.id, plan.homeTeamId, ...g.params)],
      stale: [markPersonRaidsStale(db, guild.id, plan.person.id)], personId: plan.person.id, characterId: plan.characterId,
    };
  }
  throw new Error(`applyClaimPlan: no outcome for ${plan.kind}`);
}

// ---------------------------------------------------------------------------
// One request: several characters of one account

// Decides, in order and against the roster as it is now, what each pick does, remembering what the earlier picks of the SAME request make true: the first
// character of a claimant with no person creates (or links) their person, the next ones then join it. -> [{ pick, kind, plan, personId?, reason? }]
//   add_alt | new_person | link_person   applied at once
//   conflict                             a pending claim for the officers (reason other_person; link_person for a hand-typed name, which proves nothing;
//                                        hand_added for a Battle.net claim on a character someone else typed in)
//   already | taken                      refused (409)
// planClaims reads the roster ONCE for all picks, so a claimant with no person sees new_person (or link_person) for every pick: the loop below turns the
// later ones into joins of the person the first one made.
export async function planPicks(ctx, guild, claimant, picks, { source }) {
  const pseudo = picks.map((pick, i) => ({ id: String(i), user_id: claimant.userId, name_key: nameKey(pick.name), realm_key: pick.realm.key }));
  const plans = await planClaims(ctx.db, guild, pseudo);
  let mine = null; // the claimant's person once an earlier pick of this request made it
  return picks.map((pick, i) => {
    const plan = plans.get(String(i));
    if (plan.kind === 'already') return { pick, kind: 'already', plan };
    if (plan.kind === 'blocked') {
      // Someone typed this character in on their own record, which proves nothing: the owner Battle.net proves goes to an officer, not to a refusal.
      if (source === 'bnet' && plan.reason === 'taken' && plan.proof === 'hand') return { pick, kind: 'conflict', reason: 'hand_added', plan };
      return { pick, kind: plan.reason === 'taken' ? 'taken' : 'conflict', reason: plan.reason, plan };
    }
    if (plan.kind === 'add_alt') return { pick, kind: 'add_alt', plan };
    if (plan.kind === 'new_person') {
      if (mine) return { pick, kind: 'add_alt', plan: { ...plan, kind: 'add_alt', person: { id: mine } } };
      mine = newId('p', ctx.randomBytes);
      return { pick, kind: 'new_person', plan, personId: mine };
    }
    // link_person: the character is on a person nobody linked, and the claimant had no person when the roster was read.
    if (mine) return { pick, kind: 'conflict', reason: 'other_person', plan };
    if (source === 'hand') return { pick, kind: 'conflict', reason: 'link_person', plan };
    mine = plan.person.id;
    return { pick, kind: 'link_person', plan };
  });
}

// The audit row of an outcome applied by the claimant themself: written only when the key write happened (the statement right before it).
export function claimAudit(ctx, guildId, actorId, applied, source) {
  return auditStatement(ctx, {
    guildId, actorUserId: actorId, action: 'character.claim', entityType: 'character', entityId: applied.characterId,
    after: { personId: applied.personId, outcome: applied.kind, source },
  }, CHANGED_ONE);
}

// A member adds characters to their own record, at once (D2). picks: [{ index, name, realm: { realm, key }, class, level?, mainSpec?, offSpec? }], already
// validated. source 'bnet' (the Battle.net list proves them) | 'hand' (typed). field: the request field an error names ('characters' | 'name').
// -> { claims: [{ name, realm, class, level, status, outcome, ... }] } where status is
//   applied   done: outcome add_alt | new_person | link_person, with personId and characterId
//   pending   a conflict waiting for an officer: id (the claim), outcome needs_officer, reason other_person | link_person
//   failed    the roster changed under the request: nothing was written for this character (reason changed)
export async function applyPicks(ctx, guildContext, picks, { source, field = 'characters' }) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const claimant = { userId: ctx.session.user.id, discordId: ctx.session.user.discordId };
  const planned = await planPicks(ctx, guild, claimant, picks, { source });
  const at = (entry) => ({ field, index: entry.pick.index });
  for (const entry of planned) {
    if (entry.kind === 'already') throw new HttpError(409, 'already_yours', `${entry.pick.name} is already on your record in this guild.`, at(entry));
    if (entry.kind === 'taken') throw new HttpError(409, 'name_taken', `${entry.pick.name} is already on someone else's record in this guild.`, at(entry));
  }
  const [pendingResult, openResult] = await db.batch([
    db.prepare("SELECT id, name_key, realm_key, level FROM character_claims WHERE guild_id = ? AND status = 'pending'").bind(guild.id),
    db.prepare("SELECT COUNT(*) AS n FROM character_claims WHERE guild_id = ? AND user_id = ? AND status = 'pending'").bind(guild.id, claimant.userId),
  ]);
  const waitingBy = new Map(pendingResult.results.map((row) => [`${row.name_key}|${row.realm_key}`, row]));
  // A claim waiting on a name blocks a second one, except that a Battle.net claim closes a TYPED one (no level): typing a name proves nothing, the Battle.net list does.
  const superseded = [];
  for (const entry of planned) {
    const waiting = waitingBy.get(`${nameKey(entry.pick.name)}|${entry.pick.realm.key}`);
    if (!waiting) continue;
    if (source === 'bnet' && waiting.level === null) {
      superseded.push(waiting.id);
      continue;
    }
    throw new HttpError(409, 'claim_pending', `${entry.pick.name} already has a claim waiting for officers.`, at(entry));
  }
  const conflicts = planned.filter((entry) => entry.kind === 'conflict').length;
  if (conflicts && openResult.results[0].n + conflicts > MAX_PENDING_PER_GUILD) {
    throw new HttpError(409, 'claim_limit', `You can have at most ${MAX_PENDING_PER_GUILD} claims waiting for officers in one guild.`);
  }

  const now = ctx.now();
  const statements = [];
  // Closed first, in the same batch: the pending claim of the Battle.net owner (if any) takes the one open slot of the name.
  for (const id of superseded) {
    statements.push(
      db.prepare("UPDATE character_claims SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND guild_id = ? AND status = 'pending' AND level IS NULL")
        .bind(claimant.userId, now, id, guild.id),
      auditStatement(ctx, { guildId: guild.id, actorUserId: claimant.userId, action: 'claim.reject', entityType: 'claim', entityId: id, after: { superseded: true } }, CHANGED_ONE),
    );
  }
  const slots = planned.map((entry) => {
    const pick = entry.pick;
    if (entry.kind === 'conflict') {
      const id = newId('cl', ctx.randomBytes);
      statements.push(
        db.prepare(INSERT_CLAIM_SQL).bind(id, guild.id, claimant.userId, pick.name, nameKey(pick.name), pick.realm.realm, pick.realm.key, pick.class, pick.level ?? null, now),
        auditStatement(ctx, { guildId: guild.id, actorUserId: claimant.userId, action: 'claim.create', entityType: 'claim', entityId: id }),
      );
      return { entry, claimId: id };
    }
    const applied = applyClaimPlan(ctx, {
      guild, plan: entry.plan, claimant, character: { ...pick, realm: pick.realm.realm, realmKey: pick.realm.key }, source, now, actorId: claimant.userId, personId: entry.personId,
    });
    statements.push(...applied.writes);
    const keyAt = statements.length - 1;
    statements.push(claimAudit(ctx, guild.id, claimant.userId, { ...applied, kind: entry.kind }, source), ...applied.stale);
    return { entry, keyAt, applied };
  });
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const kind = constraintOf(error);
    if (kind === 'character_name') throw new HttpError(409, 'name_taken', 'One of those characters was added to the roster while you were adding it. Reload and try again.');
    if (kind === 'discord' || kind === 'account') throw new HttpError(409, 'claim_changed', 'Your account was linked to a person while you were adding. Reload and try again.');
    if (kind === 'person_limit' || kind === 'character_limit' || kind === 'guild_characters_cap') throw limitError(kind);
    if (/UNIQUE constraint failed/i.test(String(error && error.message))) throw new HttpError(409, 'claim_pending', 'One of those characters already has a claim waiting for officers.');
    throw error;
  }
  return {
    claims: slots.map(({ entry, claimId, keyAt, applied }) => {
      const pick = entry.pick;
      const base = { name: pick.name, realm: pick.realm.realm, class: pick.class, level: pick.level ?? null };
      if (entry.kind === 'conflict') return { ...base, id: claimId, status: 'pending', outcome: 'needs_officer', reason: entry.reason };
      if (results[keyAt].meta.changes !== 1) return { ...base, status: 'failed', reason: 'changed' };
      return { ...base, status: 'applied', outcome: entry.kind, personId: applied.personId, characterId: applied.characterId };
    }),
  };
}
