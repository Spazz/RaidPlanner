// Team requests (user-hierarchy build, lane B3; D6): a person asks for one of their characters (on no team) to be placed on a team; the team's Team Leads and
// officers (roster.edit on THAT team) approve or reject; the person withdraws. Approving places the character through the same guarded statement as the
// team routes (worker/team-place.js), so the same rules hold: one character per person per team, the team and the character in the caller's guild.
//   GET    /api/guild/:gid/team-requests                   { mine: [...], pending: [...], can: { decide } }   mine = the viewer's own, pending = those the viewer decides
//   POST   /api/guild/:gid/team-requests                   { characterId, teamId, note? }                      the character's owner asks -> 201 { request }
//   DELETE /api/guild/:gid/team-requests/:trid             withdraw (the requester)                            -> { request }
//   POST   /api/guild/:gid/team-requests/:trid/approve     (roster.edit on the request's team)                 -> { request, personId, teamRequestFlags }
//   POST   /api/guild/:gid/team-requests/:trid/reject      (roster.edit on the request's team)                 -> { request, teamRequestFlags }
// The pending count reaches the Home to-do list (attention kind team_requests) and the nav badge (teamRequestFlags in GET /api/guild/:gid), and nothing else does.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { newId } from '../ids.js';
import { ownPersonStatement } from '../membership.js';
import { allows, isGranted, loadGuildContext } from '../permissions.js';
import { toPerson } from '../person.js';
import { SINGLE_LINE_STRIP, nameKey } from '../roster-data.js';
import { canSeeAvatars, loadTeamRequestFlags } from '../roster-view.js';
import { placeStatement, staleStatement } from '../team-place.js';
import { bad, constraintOf, requireTarget, teamTaken } from './roster.js';

const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const NOTE_MAX = 200;
const MINE_LIMIT = 50;
const PENDING_LIMIT = 200;
// Open requests one account may have in one guild (the list a Team Lead reads stays readable).
export const OPEN_REQUESTS_PER_ACCOUNT = 20;
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const notFound = () => new HttpError(404, 'not_found', 'That request was not found.');

// The audit row of a decision, guarded by the write right before it (changes() = 1).
const AUDIT = (ctx, guildContext, action, id, after) => auditStatement(ctx, {
  guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action, entityType: 'team_request', entityId: id, after,
}, CHANGED_ONE);

const PENDING = (id) => ({ sql: "EXISTS (SELECT 1 FROM team_requests WHERE id = ? AND status = 'pending')", params: [id] });

const REQUEST_COLUMNS = `q.id, q.status, q.note, q.created_at, q.decided_at, q.team_id, t.name AS team_name, t.archived AS team_archived,
       q.character_id, c.name AS character_name, c.class AS character_class, c.player_id, c.team_id AS character_team_id, q.requested_by`;
const REQUEST_FROM = `team_requests q JOIN teams t ON t.id = q.team_id AND t.guild_id = q.guild_id
       JOIN characters c ON c.id = q.character_id AND c.guild_id = q.guild_id`;
const MINE_SQL = `SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE q.guild_id = ? AND q.requested_by = ? ORDER BY q.created_at DESC, q.id LIMIT ${MINE_LIMIT}`;
const PENDING_SQL = `SELECT ${REQUEST_COLUMNS}, m.name AS main_name, u.discord_id, u.username, u.global_name, u.display_name, u.avatar
       FROM ${REQUEST_FROM} LEFT JOIN characters m ON m.player_id = c.player_id AND m.guild_id = c.guild_id AND m.is_main = 1
       LEFT JOIN users u ON u.id = q.requested_by
      WHERE q.guild_id = ? AND q.status = 'pending' ORDER BY q.created_at, q.id LIMIT ${PENDING_LIMIT}`;
const ONE_SQL = `SELECT ${REQUEST_COLUMNS} FROM ${REQUEST_FROM} WHERE q.id = ? AND q.guild_id = ?`;

const view = (row) => ({
  id: row.id, status: row.status, note: row.note, createdAt: row.created_at, decidedAt: row.decided_at,
  team: { id: row.team_id, name: row.team_name, archived: row.team_archived === 1 },
  character: { id: row.character_id, name: row.character_name, class: row.character_class },
});

async function loadRequest(db, guildId, requestId) {
  const row = await db.prepare(ONE_SQL).bind(requestId, guildId).first();
  if (!row) throw notFound();
  return row;
}

function readNote(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad('A note is text.', 'note');
  const text = raw.replace(SINGLE_LINE_STRIP, '').replace(/\s+/g, ' ').trim();
  if (Array.from(text).length > NOTE_MAX) throw bad(`A note is at most ${NOTE_MAX} characters.`, 'note');
  return text || null;
}

export async function listTeamRequests(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guildId = guildContext.guild.id;
  const decide = isGranted(guildContext.can['roster.edit']);
  const mine = await ctx.db.prepare(MINE_SQL).bind(guildId, ctx.session.user.id).all();
  const pending = decide ? await ctx.db.prepare(PENDING_SQL).bind(guildId).all() : { results: [] };
  const showAvatar = canSeeAvatars(guildContext.can);
  return jsonResponse({
    mine: mine.results.map(view),
    pending: pending.results.filter((row) => allows(guildContext.can, 'roster.edit', row.team_id)).map((row) => ({
      ...view(row),
      person: { id: row.player_id, name: row.main_name },
      requestedBy: row.requested_by ? toPerson(row, { avatar: showAvatar }) : null,
    })),
    can: { decide },
  });
}

export async function createTeamRequest(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  if (typeof body.characterId !== 'string') throw bad('Pick a character.', 'characterId');
  const team = await requireTarget(db, guild.id, body.teamId);
  const note = readNote(body.note);
  // The character must be the requester's own: on the person that is theirs (linked to the account, or carrying its Discord ID).
  const own = await ownPersonStatement(db, guild.id, ctx.session.user.id).first();
  const character = own
    ? await db.prepare('SELECT id, name, team_id FROM characters WHERE id = ? AND guild_id = ? AND player_id = ?').bind(body.characterId, guild.id, own.id).first()
    : null;
  if (!character) throw new HttpError(404, 'not_found', 'That character is not on your record in this guild.');
  if (character.team_id !== null) {
    throw new HttpError(409, 'on_team', `${character.name} is already on a team. A Team Lead of that team takes it off first.`, { field: 'characterId' });
  }
  const held = await db.prepare('SELECT 1 AS found FROM characters WHERE player_id = ? AND team_id = ?').bind(own.id, team.id).first();
  if (held) throw teamTaken();
  const open = await db.prepare("SELECT COUNT(*) AS n FROM team_requests WHERE guild_id = ? AND requested_by = ? AND status = 'pending'").bind(guild.id, ctx.session.user.id).first();
  if (open.n >= OPEN_REQUESTS_PER_ACCOUNT) {
    throw new HttpError(409, 'request_limit', `You can have at most ${OPEN_REQUESTS_PER_ACCOUNT} requests waiting in one guild.`);
  }

  const id = newId('tq', ctx.randomBytes);
  const now = ctx.now();
  try {
    await db.batch([
      // The character is still on no team and still the requester's when the row lands.
      db.prepare(
        `INSERT INTO team_requests (id, guild_id, team_id, character_id, requested_by, status, note, created_at)
         SELECT ?, ?, ?, c.id, ?, 'pending', ?, ? FROM characters c WHERE c.id = ? AND c.guild_id = ? AND c.player_id = ? AND c.team_id IS NULL
            AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND guild_id = ? AND archived = 0)`,
      ).bind(id, guild.id, team.id, ctx.session.user.id, note, now, character.id, guild.id, own.id, team.id, guild.id),
      AUDIT(ctx, guildContext, 'team_request.create', id, { teamId: team.id, characterId: character.id, personId: own.id }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error && error.message)) || constraintOf(error) === 'team_taken') {
      throw new HttpError(409, 'request_pending', `${character.name} already has a request waiting.`, { field: 'characterId' });
    }
    throw error;
  }
  const row = await db.prepare(ONE_SQL).bind(id, guild.id).first();
  if (!row) throw new HttpError(409, 'conflict', 'The character changed while you were asking. Reload and try again.');
  return jsonResponse({ request: view(row) }, 201);
}

export async function withdrawTeamRequest(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const row = await loadRequest(db, guild.id, ctx.params.trid);
  if (row.requested_by !== ctx.session.user.id) throw notFound();
  if (row.status !== 'pending') throw new HttpError(409, 'request_decided', 'That request was decided already.');
  const now = ctx.now();
  const results = await db.batch([
    db.prepare("UPDATE team_requests SET status = 'withdrawn', decided_by = ?, decided_at = ? WHERE id = ? AND guild_id = ? AND requested_by = ? AND status = 'pending'")
      .bind(ctx.session.user.id, now, row.id, guild.id, ctx.session.user.id),
    AUDIT(ctx, guildContext, 'team_request.withdraw', row.id, { teamId: row.team_id, characterId: row.character_id }),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'request_decided', 'That request was decided already.');
  return jsonResponse({ request: { id: row.id, status: 'withdrawn' } });
}

async function loadDecidable(ctx, guildContext) {
  const row = await loadRequest(ctx.db, guildContext.guild.id, ctx.params.trid);
  // A viewer who cannot decide it learns nothing about it: a 404, like a request of another guild.
  if (!allows(guildContext.can, 'roster.edit', row.team_id)) throw notFound();
  if (row.status !== 'pending') throw new HttpError(409, 'request_decided', 'That request was decided already.');
  return row;
}

export async function approveTeamRequest(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const row = await loadDecidable(ctx, guildContext);
  if (row.team_archived === 1) throw new HttpError(409, 'team_archived', 'That team is archived, so nobody can be placed on it. Reject the request.');
  if (row.character_team_id !== null) {
    throw new HttpError(409, 'on_team', `${row.character_name} was put on a team in the meantime. Reject this request.`);
  }
  const held = await db.prepare('SELECT 1 AS found FROM characters WHERE player_id = ? AND team_id = ?').bind(row.player_id, row.team_id).first();
  if (held) throw teamTaken();
  const now = ctx.now();
  const pending = PENDING(row.id);
  let results;
  try {
    results = await db.batch([
      // The same guarded statement as the team routes, and only while the request is still pending.
      placeStatement(db, { guildId: guild.id, personId: row.player_id, characterId: row.character_id, teamId: row.team_id, from: null, now, extra: pending }),
      db.prepare("UPDATE team_requests SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND guild_id = ? AND status = 'pending' AND changes() = 1")
        .bind(ctx.session.user.id, now, row.id, guild.id),
      AUDIT(ctx, guildContext, 'team_request.approve', row.id, { teamId: row.team_id, characterId: row.character_id, personId: row.player_id }),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'character.place', entityType: 'character', entityId: row.character_id,
        before: { teamId: null, personId: row.player_id }, after: { teamId: row.team_id, personId: row.player_id, via: 'request' },
      }, CHANGED_ONE),
      staleStatement(db, guild.id, [nameKey(row.character_name)], [row.team_id]),
    ]);
  } catch (error) {
    if (constraintOf(error) === 'team_taken') throw teamTaken();
    throw error;
  }
  if (results[0].meta.changes !== 1) {
    throw new HttpError(409, 'request_changed', 'The request or the character changed while you were deciding. Reload to see where it stands.');
  }
  return jsonResponse({
    request: { id: row.id, status: 'approved' }, personId: row.player_id, teamRequestFlags: await loadTeamRequestFlags(db, guildContext),
  });
}

export async function rejectTeamRequest(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const row = await loadDecidable(ctx, guildContext);
  const results = await db.batch([
    db.prepare("UPDATE team_requests SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND guild_id = ? AND status = 'pending'")
      .bind(ctx.session.user.id, ctx.now(), row.id, guild.id),
    AUDIT(ctx, guildContext, 'team_request.reject', row.id, { teamId: row.team_id, characterId: row.character_id, personId: row.player_id }),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'request_decided', 'That request was decided already.');
  return jsonResponse({ request: { id: row.id, status: 'rejected' }, teamRequestFlags: await loadTeamRequestFlags(db, guildContext) });
}
