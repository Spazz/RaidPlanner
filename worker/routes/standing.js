// Standing sign-ups: a member says "I'm in for every <weekday> raid of team X" for the weekdays of the team's schedule, with the kind they start with
// (signed / late) and the character they bring. worker/standing.js turns the entries into sign-ups on the team's upcoming raids. A member's own set is theirs
// alone, so neither route is audited (like their own sign-ups).
import { HttpError, jsonResponse } from '../http.js';
import { displayCharacter } from '../attendance-view.js';
import { isId, newId } from '../ids.js';
import { ownPersonStatement, ownPlayerSql } from '../membership.js';
import { allows, loadGuildContext } from '../permissions.js';
import { specChoices } from '../signups-data.js';
import { STANDING_KINDS, reconcileStanding } from '../standing.js';
import { isTeamRosterRow } from '../team-roster.js';
import { visibleCharacterSql } from '../character-visibility.js';
import { bad } from './roster.js';

const MAX_SLOTS = 7; // one per weekday
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');
const byMainThenName = (a, b) => (b.is_main - a.is_main) || a.name.localeCompare(b.name);

// The set is the person's own: the person is the account's, re-checked inside every write.
const OWN_GUARD = `EXISTS (SELECT 1 FROM players ap WHERE ap.id = ? AND ap.guild_id = ? AND ${ownPlayerSql('ap', '?')})`;

const characterView = (row) => ({ id: row.id, name: row.name, class: row.class, mainSpec: row.main_spec, isMain: row.is_main === 1, specs: specChoices(row) });

// The viewer's standing entries as the API shows them, for the teams they can sign up for that have a weekly schedule: not archived teams only, where the
// viewer holds signups.self and a character of theirs is on the team's roster; the characters offered are ALL of theirs (U R4-Q1). onlyTeamId narrows it to
// one team (which is then listed even without a schedule). -> [{ teamId, teamName, slots, characters, mine }]
async function readTeams(ctx, guildContext, personId, onlyTeamId = null) {
  const guildId = guildContext.guild.id;
  const [teamResult, slotResult, characterResult, standingResult] = await ctx.db.batch([
    ctx.db.prepare(
      `SELECT t.id, t.name FROM teams t WHERE t.guild_id = ? AND t.archived = 0 AND (? IS NULL OR t.id = ?)
          AND (? IS NOT NULL OR EXISTS (SELECT 1 FROM team_schedules s WHERE s.team_id = t.id)) ORDER BY t.created_at, t.id`,
    ).bind(guildId, onlyTeamId, onlyTeamId, onlyTeamId),
    ctx.db.prepare('SELECT team_id, weekday, start_time, zone, title FROM team_schedules WHERE guild_id = ? ORDER BY team_id, weekday').bind(guildId),
    ctx.db.prepare(`SELECT id, name, class, main_spec, off_spec, is_main, team_id, core_rank, left_on FROM characters WHERE guild_id = ? AND player_id = ? AND ${visibleCharacterSql('characters')}`).bind(guildId, personId),
    ctx.db.prepare('SELECT team_id, weekday, kind, character_id FROM standing_signups WHERE guild_id = ? AND player_id = ? ORDER BY team_id, weekday').bind(guildId, personId),
  ]);
  const teams = [];
  for (const team of teamResult.results) {
    if (!allows(guildContext.can, 'signups.self', team.id)) continue;
    if (!characterResult.results.some((row) => row.team_id === team.id && isTeamRosterRow(row))) continue;
    const characters = [...characterResult.results].sort(byMainThenName);
    teams.push({
      teamId: team.id,
      teamName: team.name,
      slots: slotResult.results.filter((row) => row.team_id === team.id).map((row) => ({ weekday: row.weekday, startTime: row.start_time, zone: row.zone, title: row.title })),
      characters: characters.map(characterView),
      // characterId null = "my usual character on the team" (the Main first), worked out each time a sign-up is made
      mine: standingResult.results.filter((row) => row.team_id === team.id).map((row) => ({ weekday: row.weekday, kind: row.kind, characterId: row.character_id })),
    });
  }
  return teams;
}

const ownPersonId = async (ctx, guildContext) => {
  const own = await ownPersonStatement(ctx.db, guildContext.guild.id, ctx.session.user.id).first();
  return own ? own.id : null;
};

// GET /standing: the viewer's standing sign-ups on every team they can sign up for that has a weekly schedule.
export async function getStanding(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const personId = await ownPersonId(ctx, guildContext);
  if (!personId) return jsonResponse({ personId: null, teams: [] });
  return jsonResponse({ personId, teams: await readTeams(ctx, guildContext, personId) });
}

// PUT /teams/:tid/standing { slots: [{ weekday, kind, characterId? }] }: replaces the viewer's set for the team. A weekday must be one of the team's schedule
// days, used once; kind is signed or late; characterId any one of the viewer's characters (left out / null = their usual one). -> the team's entry.
export async function putStanding(ctx) {
  const { body, db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const team = await db.prepare('SELECT id, name, archived FROM teams WHERE id = ? AND guild_id = ?').bind(ctx.params.tid, guild.id).first();
  if (!team) throw new HttpError(404, 'not_found', 'That team does not exist.');
  if (!allows(guildContext.can, 'signups.self', team.id)) throw forbidden();
  const personId = await ownPersonId(ctx, guildContext);
  if (!personId) throw forbidden();
  if (team.archived === 1) throw new HttpError(409, 'team_archived', 'Restore the team before changing its standing sign-ups.');

  const [slotResult, characterResult] = await db.batch([
    db.prepare('SELECT weekday FROM team_schedules WHERE team_id = ?').bind(team.id),
    db.prepare(`SELECT id, name, class, main_spec, off_spec, is_main, team_id, core_rank, left_on FROM characters WHERE guild_id = ? AND player_id = ? AND ${visibleCharacterSql('characters')}`).bind(guild.id, personId),
  ]);
  if (!characterResult.results.some((row) => row.team_id === team.id && isTeamRosterRow(row))) throw forbidden();
  if (!Array.isArray(body.slots) || body.slots.length > MAX_SLOTS) throw bad(`Send a list of at most ${MAX_SLOTS} slots.`, 'slots');
  const days = new Set(slotResult.results.map((row) => row.weekday));
  const mine = new Set(characterResult.results.map((row) => row.id));
  const seen = new Set();
  const rows = body.slots.map((slot, index) => {
    const fail = (message, field) => new HttpError(400, 'bad_request', message, { field: 'slots', index, slotField: field });
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) throw fail('Each slot must be an object.', null);
    if (!Number.isInteger(slot.weekday) || !days.has(slot.weekday)) throw fail('Pick one of the team\'s raid days.', 'weekday');
    if (seen.has(slot.weekday)) throw fail('Use each weekday once.', 'weekday');
    seen.add(slot.weekday);
    if (typeof slot.kind !== 'string' || !STANDING_KINDS.includes(slot.kind)) throw fail('Pick signed or late.', 'kind');
    if (slot.characterId !== undefined && slot.characterId !== null && (!isId('c', slot.characterId) || !mine.has(slot.characterId))) {
      throw fail('Pick one of your characters.', 'characterId');
    }
    return { id: newId('sg', ctx.randomBytes), weekday: slot.weekday, kind: slot.kind, characterId: slot.characterId || null };
  });

  const now = ctx.now();
  const keep = JSON.stringify(rows.map((row) => row.weekday));
  const guard = { sql: OWN_GUARD, params: [personId, guild.id, ctx.session.user.id, ctx.session.user.id] };
  await db.batch([
    db.prepare(
      `DELETE FROM standing_signups WHERE guild_id = ? AND team_id = ? AND player_id = ? AND weekday NOT IN (SELECT value FROM json_each(?)) AND ${guard.sql}`,
    ).bind(guild.id, team.id, personId, keep, ...guard.params),
    // A weekday that is already set keeps its id and creation time; only its kind and character change.
    db.prepare(
      `INSERT INTO standing_signups (id, guild_id, team_id, player_id, weekday, kind, character_id, created_at, updated_at)
       SELECT json_extract(value, '$.id'), ?, ?, ?, json_extract(value, '$.weekday'), json_extract(value, '$.kind'), json_extract(value, '$.characterId'), ?, ?
         FROM json_each(?) WHERE ${guard.sql}
       ON CONFLICT (team_id, player_id, weekday) DO UPDATE SET kind = excluded.kind, character_id = excluded.character_id, updated_at = excluded.updated_at`,
    ).bind(guild.id, team.id, personId, now, now, JSON.stringify(rows), ...guard.params),
  ]);
  await reconcileStanding(ctx, guild, { teamIds: [team.id], personId });
  const [entry] = await readTeams(ctx, guildContext, personId, team.id);
  return jsonResponse(entry);
}
