// The class and spec intent board: a team's "Intent" round. An officer opens a round (a title and an optional close date), the people of the team say
// what they plan to play (one main pick, one optional alt pick, a short note), the board adds the picks up by role and class against the team's raid
// size, and an officer closes the round; a closed round stays readable. What the picks cover in buffs and debuffs is worked out in the browser, with
// the Planner's own rules for the guild's game version (js/analysis.js rosterBuffCoverage).
//   GET    /api/guild/:gid/intent?team=&round=                (roster.view)  the board of the team's open round, else its latest, else of ?round=
//   POST   /api/guild/:gid/teams/:tid/intent                  (roster.edit on the team)  open a round { title, closesOn? }
//   PATCH  /api/guild/:gid/intent/:iid                        (roster.edit on the team)  close it { status: 'closed' }
//   PUT    /api/guild/:gid/intent/:iid/picks/:pid             (the person, or roster.edit on the team)  { kind, class, spec, note? }
//   DELETE /api/guild/:gid/intent/:iid/picks/:pid             (the person, or roster.edit on the team)  { kind }  (a main takes its alt with it)
// Every write answers with the board it changed, in the shape of the GET.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isId, newId } from '../ids.js';
import { ownPersonStatement } from '../membership.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { personStatusSql } from '../person-rank-sql.js';
import { visibleCharacterSql } from '../character-visibility.js';
import { pickTotals, raidRoleOf, targetsOf } from '../recruit-data.js';
import { MULTI_LINE_STRIP, SPECS, isRealDate, isSpecOf } from '../roster-data.js';
import { guildToday } from '../roster-view.js';
import { personOnTeamRosterSql, rosterRankOnTeamSql } from '../team-roster.js';
import { bad, readClass } from './roster.js';

export const INTENT_TITLE_MAX = 80;
export const INTENT_NOTE_MAX = 120;
const ROUNDS_PER_TEAM_MAX = 50;

// Class -> spec -> raid role, for the pick form (it shows what a spec counts as before anyone saves it).
const ROLES_BY_SPEC = Object.fromEntries(Object.entries(SPECS).map(([classId, specs]) => [classId, Object.fromEntries(specs.map((spec) => [spec, raidRoleOf(classId, spec)]))]));

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const notFound = (message) => new HttpError(404, 'not_found', message);

function readTitle(raw) {
  const text = typeof raw === 'string' ? raw.replace(MULTI_LINE_STRIP, ' ').replace(/\s+/g, ' ').trim() : '';
  const length = Array.from(text).length;
  if (length < 1 || length > INTENT_TITLE_MAX) throw bad(`Give the round a title of 1 to ${INTENT_TITLE_MAX} characters.`, 'title');
  return text;
}

function readNote(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw bad('The note must be text.', 'note');
  const text = raw.replace(MULTI_LINE_STRIP, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (Array.from(text).length > INTENT_NOTE_MAX) throw bad(`A note is at most ${INTENT_NOTE_MAX} characters.`, 'note');
  return text;
}

const readKind = (raw) => {
  if (raw !== 'main' && raw !== 'alt') throw bad('Pick main or alt.', 'kind');
  return raw;
};

async function loadTeam(db, guildId, teamId) {
  const team = await db.prepare('SELECT id, name, size, archived, recruit_targets FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guildId).first();
  if (!team) throw notFound('That team does not exist in this guild.');
  return team;
}

async function loadRound(db, guildId, roundId) {
  const round = await db.prepare(
    'SELECT id, team_id, title, closes_on, status, created_at, closed_at FROM intent_rounds WHERE id = ? AND guild_id = ?',
  ).bind(roundId, guildId).first();
  if (!round) throw notFound('That intent round was not found.');
  return round;
}

const roundView = (row) => ({
  id: row.id, title: row.title, closesOn: row.closes_on, status: row.status, createdAt: row.created_at, closedAt: row.closed_at,
});

// The board of one round (null: the team has none yet): the picks with the people's main character names, the people with no main pick yet
// (open round only), and the totals of the main picks.
async function boardPayload(ctx, guildContext, team, roundRow, viewerPersonId) {
  const { db } = ctx;
  const guildId = guildContext.guild.id;
  const roundsResult = await db.prepare(
    `SELECT r.id, r.title, r.closes_on, r.status, r.created_at, r.closed_at, (SELECT COUNT(*) FROM intent_picks k WHERE k.round_id = r.id AND k.kind = 'main') AS mains
       FROM intent_rounds r WHERE r.guild_id = ? AND r.team_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 20`,
  ).bind(guildId, team.id).all();
  const base = {
    team: { id: team.id, name: team.name, size: team.size, archived: team.archived === 1 },
    targets: targetsOf(team.recruit_targets, team.size).targets,
    roles: ROLES_BY_SPEC,
    gameVersion: guildContext.guild.game_version,
    canEdit: allows(guildContext.can, 'roster.edit', team.id),
    myPersonId: viewerPersonId,
    rounds: roundsResult.results.map((row) => ({ ...roundView(row), mains: row.mains })),
  };
  if (!roundRow) {
    return { ...base, round: null, canPick: false, picks: [], undecided: [], totals: pickTotals([]) };
  }
  const [pickResult, peopleResult] = await db.batch([
    db.prepare(
      `SELECT k.player_id, k.kind, k.class, k.spec, k.role, k.note, COALESCE(${rosterRankOnTeamSql('p.id', '?3')}, ${personStatusSql('p.id')}) AS status,
              m.name AS main_name, m.class AS main_class
         FROM intent_picks k JOIN players p ON p.id = k.player_id AND p.guild_id = k.guild_id
         LEFT JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE k.round_id = ?1 AND k.guild_id = ?2 ORDER BY k.kind, m.name_key, k.player_id`,
    ).bind(roundRow.id, guildId, team.id),
    // The people of the team who may still pick: on the team's roster (a character placed on it, still here, in a raiding rank).
    db.prepare(
      `SELECT p.id, ${rosterRankOnTeamSql('p.id', '?2')} AS status, m.name, m.class FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1
        WHERE p.guild_id = ?1 AND ${personOnTeamRosterSql('p.id', '?2')} AND ${visibleCharacterSql('m')}
        ORDER BY m.name_key, p.id`,
    ).bind(guildId, team.id),
  ]);
  const picks = pickResult.results.map((row) => ({
    personId: row.player_id, name: row.main_name || 'Unknown', status: row.status, kind: row.kind, class: row.class, spec: row.spec, role: row.role,
    note: row.note, mine: row.player_id === viewerPersonId,
  }));
  const picked = new Set(picks.filter((pick) => pick.kind === 'main').map((pick) => pick.personId));
  const open = roundRow.status === 'open';
  const eligible = peopleResult.results;
  return {
    ...base,
    round: roundView(roundRow),
    canPick: open && !!viewerPersonId && eligible.some((row) => row.id === viewerPersonId),
    picks,
    undecided: open ? eligible.filter((row) => !picked.has(row.id)).map((row) => ({ personId: row.id, name: row.name, class: row.class, status: row.status })) : [],
    totals: pickTotals(picks),
  };
}

async function viewerPerson(ctx, guildContext) {
  const row = await ownPersonStatement(ctx.db, guildContext.guild.id, ctx.session.user.id).first();
  return row ? row.id : null;
}

// The round a GET shows: ?round= when given, else the team's open round, else its latest.
async function pickRound(db, guildId, teamId, roundId) {
  if (roundId) {
    const round = await db.prepare(
      'SELECT id, team_id, title, closes_on, status, created_at, closed_at FROM intent_rounds WHERE id = ? AND guild_id = ? AND team_id = ?',
    ).bind(roundId, guildId, teamId).first();
    if (!round) throw notFound('That intent round was not found.');
    return round;
  }
  return db.prepare(
    `SELECT id, team_id, title, closes_on, status, created_at, closed_at FROM intent_rounds WHERE guild_id = ? AND team_id = ?
      ORDER BY (status = 'open') DESC, created_at DESC, id DESC LIMIT 1`,
  ).bind(guildId, teamId).first();
}

export async function getIntent(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'roster.view');
  const params = new URL(ctx.request.url).searchParams;
  const teamId = params.get('team');
  if (!isId('t', teamId)) throw bad('Pick a team.', 'team');
  const team = await loadTeam(ctx.db, guildContext.guild.id, teamId);
  const roundId = params.get('round');
  if (roundId && !isId('ir', roundId)) throw bad('That is not an intent round.', 'round');
  const round = await pickRound(ctx.db, guildContext.guild.id, team.id, roundId);
  return jsonResponse(await boardPayload(ctx, guildContext, team, round, await viewerPerson(ctx, guildContext)));
}

export async function openIntent(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const team = await loadTeam(ctx.db, guild.id, ctx.params.tid);
  if (!allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
  if (team.archived === 1) throw new HttpError(409, 'team_archived', 'That team is archived.');
  const title = readTitle(ctx.body.title);
  let closesOn = null;
  if (ctx.body.closesOn !== undefined && ctx.body.closesOn !== null && ctx.body.closesOn !== '') {
    if (!isRealDate(ctx.body.closesOn)) throw bad('The close date needs a date.', 'closesOn');
    if (ctx.body.closesOn < guildToday(guild, ctx.now())) throw bad('The close date cannot be in the past.', 'closesOn');
    closesOn = ctx.body.closesOn;
  }
  const count = await ctx.db.prepare('SELECT COUNT(*) AS n FROM intent_rounds WHERE guild_id = ? AND team_id = ?').bind(guild.id, team.id).first('n');
  if (count >= ROUNDS_PER_TEAM_MAX) throw new HttpError(409, 'intent_limit', `A team can have at most ${ROUNDS_PER_TEAM_MAX} intent rounds.`);
  const id = newId('ir', ctx.randomBytes);
  const now = ctx.now();
  try {
    await ctx.db.batch([
      // One guarded INSERT: a team has one open round (the unique index makes a race a 409 as well).
      ctx.db.prepare(
        `INSERT INTO intent_rounds (id, guild_id, team_id, title, closes_on, status, created_by, created_at)
         SELECT ?, ?, ?, ?, ?, 'open', ?, ? WHERE NOT EXISTS (SELECT 1 FROM intent_rounds WHERE team_id = ? AND status = 'open')`,
      ).bind(id, guild.id, team.id, title, closesOn, ctx.session.user.id, now, team.id),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'intent.open', entityType: 'intent', entityId: id, after: { teamId: team.id },
      }, { sql: 'EXISTS (SELECT 1 FROM intent_rounds WHERE id = ?)', params: [id] }),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(`${error && error.message} ${error && error.cause && error.cause.message}`)) {
      throw new HttpError(409, 'intent_open', 'This team already has an open intent round. Close it first.');
    }
    throw error;
  }
  const row = await ctx.db.prepare('SELECT id, team_id, title, closes_on, status, created_at, closed_at FROM intent_rounds WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(409, 'intent_open', 'This team already has an open intent round. Close it first.');
  return jsonResponse(await boardPayload(ctx, guildContext, team, row, await viewerPerson(ctx, guildContext)), 201);
}

export async function closeIntent(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const round = await loadRound(ctx.db, guild.id, ctx.params.iid);
  const team = await loadTeam(ctx.db, guild.id, round.team_id);
  if (!allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
  if (ctx.body.status !== 'closed') throw bad('Send status "closed".', 'status');
  if (round.status === 'closed') throw new HttpError(409, 'intent_closed', 'That round is already closed.');
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db.prepare("UPDATE intent_rounds SET status = 'closed', closed_at = ? WHERE id = ? AND guild_id = ? AND status = 'open'").bind(now, round.id, guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'intent.close', entityType: 'intent', entityId: round.id, after: { teamId: team.id },
    }, { sql: 'changes() = 1', params: [] }),
  ]);
  const row = await loadRound(ctx.db, guild.id, round.id);
  return jsonResponse(await boardPayload(ctx, guildContext, team, row, await viewerPerson(ctx, guildContext)));
}

// The person a pick is for: in this guild, on the round's team roster. The caller must be that person or edit the team.
async function loadPickPerson(ctx, guildContext, round, team) {
  const guildId = guildContext.guild.id;
  const person = await ctx.db.prepare('SELECT id FROM players WHERE id = ? AND guild_id = ?').bind(ctx.params.pid, guildId).first();
  if (!person) throw notFound('That person was not found.');
  const own = await viewerPerson(ctx, guildContext);
  if (own !== person.id && !allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
  if (round.status !== 'open') throw new HttpError(409, 'intent_closed', 'This round is closed.');
  const onTeam = await ctx.db.prepare(`SELECT ${personOnTeamRosterSql('?1', '?2')} AS on_team`).bind(person.id, team.id).first();
  if (!onTeam.on_team) throw new HttpError(409, 'not_on_team', 'Only people on this team can pick.');
  return { person, own };
}

export async function putIntentPick(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const round = await loadRound(ctx.db, guild.id, ctx.params.iid);
  const team = await loadTeam(ctx.db, guild.id, round.team_id);
  const { person, own } = await loadPickPerson(ctx, guildContext, round, team);
  const kind = readKind(ctx.body.kind);
  const classId = readClass(ctx.body.class);
  if (typeof ctx.body.spec !== 'string' || !isSpecOf(classId, ctx.body.spec)) throw bad('That spec does not belong to the class.', 'spec');
  const spec = ctx.body.spec;
  const role = raidRoleOf(classId, spec);
  const note = readNote(ctx.body.note);
  if (kind === 'alt') {
    const main = await ctx.db.prepare("SELECT 1 AS x FROM intent_picks WHERE round_id = ? AND player_id = ? AND kind = 'main'").bind(round.id, person.id).first();
    if (!main) throw new HttpError(409, 'main_first', 'Pick a main before an alt.', { field: 'kind' });
  }
  const now = ctx.now();
  const results = await ctx.db.batch([
    // Guarded by the round being open still, so a pick racing a Close writes nothing.
    ctx.db.prepare(
      `INSERT INTO intent_picks (round_id, guild_id, player_id, kind, class, spec, role, note, updated_by, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM intent_rounds WHERE id = ? AND status = 'open')
       ON CONFLICT(round_id, player_id, kind) DO UPDATE SET class = excluded.class, spec = excluded.spec, role = excluded.role, note = excluded.note,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(round.id, guild.id, person.id, kind, classId, spec, role, note, ctx.session.user.id, now, round.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'intent.pick', entityType: 'intent', entityId: round.id,
      after: { personId: person.id, teamId: team.id, kind, class: classId, spec, role },
    }, { sql: 'changes() = 1', params: [] }),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'intent_closed', 'This round is closed.');
  return jsonResponse(await boardPayload(ctx, guildContext, team, await loadRound(ctx.db, guild.id, round.id), own));
}

export async function deleteIntentPick(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const round = await loadRound(ctx.db, guild.id, ctx.params.iid);
  const team = await loadTeam(ctx.db, guild.id, round.team_id);
  const person = await ctx.db.prepare('SELECT id FROM players WHERE id = ? AND guild_id = ?').bind(ctx.params.pid, guild.id).first();
  if (!person) throw notFound('That person was not found.');
  const own = await viewerPerson(ctx, guildContext);
  if (own !== person.id && !allows(guildContext.can, 'roster.edit', team.id)) throw forbidden();
  if (round.status !== 'open') throw new HttpError(409, 'intent_closed', 'This round is closed.');
  const kind = readKind(ctx.body.kind);
  const results = await ctx.db.batch([
    // A main takes its alt with it (an alt needs a main).
    ctx.db.prepare(
      `DELETE FROM intent_picks WHERE round_id = ? AND player_id = ? AND (kind = ? OR (? = 'main' AND kind = 'alt'))
         AND EXISTS (SELECT 1 FROM intent_rounds WHERE id = ? AND status = 'open')`,
    ).bind(round.id, person.id, kind, kind, round.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'intent.unpick', entityType: 'intent', entityId: round.id,
      after: { personId: person.id, teamId: team.id, kind },
    }, { sql: 'changes() >= 1', params: [] }),
  ]);
  if (results[0].meta.changes < 1) throw notFound('There is no such pick.');
  return jsonResponse(await boardPayload(ctx, guildContext, team, await loadRound(ctx.db, guild.id, round.id), own));
}
