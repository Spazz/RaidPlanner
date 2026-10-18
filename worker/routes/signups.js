// Native Raidsmith sign-ups: a member signs themselves up for an upcoming raid of a team they have a character on; officers and team
// leads (raids.edit) add, change or remove anyone's, and close sign-ups early. A sign-up is a raid_signups row with source 'raidsmith'
// (one per person per raid) that REPLACES the person's Raid-Helper row everywhere it is shown or counted, so nothing counts twice.
// The attendance recompute reads it with the other sources and is otherwise unchanged. Spec: tasks/guild-phase6-signups-spec.md.
import { HttpError, jsonResponse } from '../http.js';
import { recomputeRaid } from '../attendance-store.js';
import { displayCharacter } from '../attendance-view.js';
import { isId } from '../ids.js';
import { ownPersonStatement, ownPlayerSql } from '../membership.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { raidSizeFields } from '../raid-zones.js';
import { SINGLE_LINE_STRIP, isSpecOf } from '../roster-data.js';
import {
  NOTE_MAX, SELF_KINDS, SIGNUP_KINDS, closeHoursOf, closedReason, closesAtOf, countSignups, mergeSignups, raidHelperClassName, raidHelperSpecKey,
  signUpSpecLabel, specChoices,
} from '../signups-data.js';
import { loadRaid, raidAudit } from './raids.js';
import { bad } from './roster.js';

const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

// 409 signups_closed: reason 'started' | 'locked' | 'deadline'; a deadline also says when the window closed (closesAt, epoch ms). raid: the row the reason came from.
function closedError(reason, raid) {
  if (reason === 'started') return new HttpError(409, 'signups_closed', 'This raid has started: sign-ups can no longer be changed here. Ask an officer.', { reason });
  if (reason === 'deadline') {
    const hours = closeHoursOf(raid);
    return new HttpError(409, 'signups_closed', `Sign-ups closed ${hours} ${hours === 1 ? 'hour' : 'hours'} before the start of this raid. Ask an officer.`, { reason, closesAt: closesAtOf(raid) });
  }
  return new HttpError(409, 'signups_closed', 'An officer has closed sign-ups for this raid. Ask an officer.', { reason });
}

// A member's window in SQL, re-checked inside every member write: the raid is not locked and its start is more than the deadline hours away (the raid's own
// number, else the team's). Binds (raidId, now). Must agree with closedReason in worker/signup-window.js: closed when starts_at - hours * 3600000 <= now.
const WINDOW_OPEN_SQL = `EXISTS (SELECT 1 FROM raids WHERE id = ? AND raids.signups_locked = 0
    AND raids.starts_at - COALESCE(raids.signup_close_hours, (SELECT t.signup_close_hours FROM teams t WHERE t.id = raids.team_id), 0) * 3600000 > ?)`;

// After a member's write found the window shut: the 409 to answer with, from the raid as it is now (null when it is open after all).
async function windowError(ctx, raidId) {
  const fresh = await ctx.db.prepare(
    `SELECT starts_at, signups_locked, signup_close_hours, (SELECT t.signup_close_hours FROM teams t WHERE t.id = raids.team_id) AS team_close_hours
       FROM raids WHERE id = ?`,
  ).bind(raidId).first();
  if (!fresh) return closedError('started', null);
  const reason = closedReason(fresh, ctx.now());
  return reason ? closedError(reason, fresh) : null;
}

const CHARACTER_COLUMNS = 'id, player_id, name, class, main_spec, off_spec, is_main, team_id';

// ---------------------------------------------------------------------------
// The merged view

const byMainThenName = (a, b) => (b.is_main - a.is_main) || a.name.localeCompare(b.name);

function characterView(row) {
  return { id: row.id, name: row.name, class: row.class, mainSpec: row.main_spec, offSpec: row.off_spec, isMain: row.is_main === 1, teamId: row.team_id, specs: specChoices(row) };
}

// What the Sign-ups panel of a raid reads. raid: the raids row (loadRaid). Members see the list of the teams they have a character on
// (attendance.view); `me` is the viewer's own part (their characters on this team, their sign-up) and `roster` the officers' picker.
export async function buildView(ctx, guildContext, raid) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const can = guildContext.can;
  const teamId = raid.team_id;
  const edit = allows(can, 'raids.edit', teamId);
  const self = allows(can, 'signups.self', teamId);
  const seeList = allows(can, 'attendance.view', teamId);
  const seeNicknames = allows(can, 'roster.edit', teamId);
  const closeHours = closeHoursOf(raid);
  const closed = closedReason(raid, ctx.now(), closeHours);
  const userId = ctx.session.user.id;
  // The viewer's own person is the one linked to their account or carrying their Discord ID (worker/membership.js), so an account that signs in with Battle.net only has one too.
  const statements = [
    ownPersonStatement(db, guild.id, userId),
    db.prepare(
      `SELECT source, signup_id, kind, class_name, spec_name, position, player_id, nickname, character_id, note, updated_at FROM raid_signups
        WHERE raid_id = ? AND source IN ('raid_helper', 'raidsmith') ORDER BY position, source, signup_id`,
    ).bind(raid.id),
    db.prepare(
      `SELECT ${CHARACTER_COLUMNS} FROM characters
        WHERE guild_id = ? AND (player_id IN (SELECT player_id FROM raid_signups WHERE raid_id = ? AND source IN ('raid_helper', 'raidsmith') AND player_id IS NOT NULL)
                                OR player_id IN (SELECT id FROM players WHERE guild_id = ? AND ${ownPlayerSql('players', '?')}))`,
    ).bind(guild.id, raid.id, guild.id, userId, userId),
  ];
  if (edit) {
    statements.push(db.prepare(
      `SELECT p.id AS person_id, p.status, c.id, c.player_id, c.name, c.class, c.main_spec, c.off_spec, c.is_main, c.team_id
         FROM players p JOIN characters c ON c.player_id = p.id
        WHERE p.guild_id = ? AND p.status != 'inactive' AND p.id IN (SELECT player_id FROM characters WHERE guild_id = ? AND team_id = ?)`,
    ).bind(guild.id, guild.id, teamId));
  }
  const results = await db.batch(statements);
  const myPlayerId = results[0].results.length ? results[0].results[0].id : null;
  const charactersByPlayer = new Map();
  for (const row of results[2].results) {
    if (!charactersByPlayer.has(row.player_id)) charactersByPlayer.set(row.player_id, []);
    charactersByPlayer.get(row.player_id).push(row);
  }
  const entries = mergeSignups(results[1].results, charactersByPlayer, { teamId, seeNicknames, myPlayerId });

  let me = null;
  if (self && myPlayerId) {
    const mine = (charactersByPlayer.get(myPlayerId) || []).filter((row) => row.team_id === teamId).sort(byMainThenName);
    const shown = displayCharacter(mine, teamId);
    me = {
      personId: myPlayerId,
      signup: entries.find((entry) => entry.isMe) || null,
      characters: mine.map(characterView),
      defaultCharacterId: shown ? shown.id : null,
      canChange: closed === null,
      closed,
    };
  }

  let roster = null;
  if (edit) {
    const people = new Map();
    for (const row of results[3].results) {
      if (!people.has(row.person_id)) people.set(row.person_id, { personId: row.person_id, status: row.status, rows: [] });
      people.get(row.person_id).rows.push(row);
    }
    roster = [...people.values()].map((person) => {
      const rows = person.rows.sort(byMainThenName);
      const shown = displayCharacter(rows, teamId);
      return { personId: person.personId, name: shown ? shown.name : '', status: person.status, characters: rows.map(characterView) };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId));
  }

  return {
    raid: {
      id: raid.id, teamId, startsAt: raid.starts_at, upcoming: raid.starts_at > ctx.now(), locked: raid.signups_locked === 1, closed,
      closesAt: closesAtOf(raid, closeHours), closeHours, closeHoursOverride: raid.signup_close_hours,
      ...raidSizeFields(raid, raid.team_size, guild.game_version),
    },
    can: { edit, self: !!me, seeList, seeNicknames },
    me,
    counts: seeList ? countSignups(entries) : null,
    entries: seeList ? entries : null,
    roster,
  };
}

const viewReply = async (ctx, guildContext, raid) => jsonResponse(await buildView(ctx, guildContext, raid));

// ---------------------------------------------------------------------------
// Reads

export async function getSignups(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'raids.view');
  const raid = await loadRaid(ctx, guildContext);
  return jsonResponse(await buildView(ctx, guildContext, raid));
}

// GET .../signup: the viewer's own part of the view (403 for someone with no character on the raid's team).
export async function getMySignup(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'signups.self', raid.team_id)) throw forbidden();
  const view = await buildView(ctx, guildContext, raid);
  if (!view.me) throw forbidden();
  return jsonResponse({ me: view.me });
}

// ---------------------------------------------------------------------------
// Writes

// The body of a PUT: kind, and optionally characterId, spec ("left out" keeps the current choice, null clears it) and note.
function readBody(body, officer) {
  const kinds = officer ? SIGNUP_KINDS : SELF_KINDS;
  if (typeof body.kind !== 'string' || !kinds.includes(body.kind)) {
    throw bad(officer ? 'Pick signed, late, tentative, bench or absence.' : 'Pick signed, late, tentative or absence.', 'kind');
  }
  if (body.characterId !== undefined && body.characterId !== null && !isId('c', body.characterId)) throw bad('characterId must be a character id.', 'characterId');
  if (body.spec !== undefined && body.spec !== null && typeof body.spec !== 'string') throw bad('spec must be text.', 'spec');
  let note;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') throw bad('note must be text.', 'note');
    note = body.note.replace(SINGLE_LINE_STRIP, '').trim();
    if (Array.from(note).length > NOTE_MAX) throw bad(`A note is at most ${NOTE_MAX} characters.`, 'note');
  }
  return {
    kind: body.kind,
    hasCharacter: body.characterId !== undefined,
    characterId: body.characterId || null,
    hasSpec: body.spec !== undefined,
    spec: body.spec ? body.spec : null,
    hasNote: body.note !== undefined,
    note: note || null,
  };
}

// Writes (or replaces) one person's Raidsmith sign-up on the raid. self: the viewer's own (the window must be open, re-checked in the
// statement); otherwise an officer's (any time). -> nothing; throws 4xx.
async function writeSignup(ctx, guildContext, raid, personId, input, self) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const teamId = raid.team_id;
  const [characterResult, existingResult] = await db.batch([
    db.prepare(`SELECT ${CHARACTER_COLUMNS} FROM characters WHERE guild_id = ? AND player_id = ?`).bind(guild.id, personId),
    db.prepare("SELECT character_id, spec_name, class_name, note FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND player_id = ?").bind(raid.id, personId),
  ]);
  const all = characterResult.results;
  if (!all.length) throw new HttpError(404, 'not_found', 'That person is not on this guild\'s roster.');
  // A member signs up with a character on the raid's team; an officer may pick any character of the person.
  const allowed = self ? all.filter((row) => row.team_id === teamId) : all;
  const existing = existingResult.results[0] || null;
  let character;
  if (input.hasCharacter && input.characterId) {
    character = allowed.find((row) => row.id === input.characterId);
    if (!character) throw bad(self ? 'Pick one of your characters on this team.' : 'Pick one of this person\'s characters.', 'characterId');
  } else {
    character = (!input.hasCharacter && existing && existing.character_id ? allowed.find((row) => row.id === existing.character_id) : null)
      || displayCharacter(allowed, teamId);
  }
  if (!character) throw bad('You have no character on this team.', 'characterId');

  let spec;
  if (input.hasSpec) {
    spec = input.spec;
    if (spec !== null && !isSpecOf(character.class, spec)) throw bad(`${spec} is not a spec of that class.`, 'spec');
  } else if (existing && existing.character_id === character.id) {
    spec = signUpSpecLabel(existing);
  } else {
    spec = character.main_spec && isSpecOf(character.class, character.main_spec) ? character.main_spec : null;
  }
  const note = input.hasNote ? input.note : (existing ? existing.note : null);

  const now = ctx.now();
  const guard = self
    ? { sql: WINDOW_OPEN_SQL, params: [raid.id, now] }
    : { sql: 'EXISTS (SELECT 1 FROM raids WHERE id = ?)', params: [raid.id] };
  const statements = [
    db.prepare(
      `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id, player_id,
                                 character_id, note, updated_by, created_at, updated_at)
       SELECT ?, 'raidsmith', n.next, NULL, NULL, ?, ?, ?, n.next, ?, ?, ?, ?, ?, ?, ?
         FROM (SELECT COALESCE(MAX(signup_id), 0) + 1 AS next FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith') n
        WHERE ${guard.sql}
       ON CONFLICT (raid_id, player_id) WHERE source = 'raidsmith' DO UPDATE SET
         kind = excluded.kind, class_name = excluded.class_name, spec_name = excluded.spec_name, character_id = excluded.character_id,
         note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(raid.id, input.kind, raidHelperClassName(character.class), spec ? raidHelperSpecKey(character.class, spec) : null, guild.id, personId,
      character.id, note, ctx.session.user.id, now, now, raid.id, ...guard.params),
    // The results of this raid are out of date, and no recompute that read the old sign-ups may write over that.
    db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ? AND changes() = 1").bind(raid.id, guild.id),
  ];
  if (!self) {
    statements.push(raidAudit(ctx, guildContext, 'signup.set', raid.id, existing ? { kind: 'set' } : null, { personId, kind: input.kind }, CHANGED_ONE));
  }
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1) throw (await windowError(ctx, raid.id)) || closedError('locked', raid);
  await recomputeIfEvidence(ctx, guild, raid);
}

// A raid with a log or hand-entered attendance has results that depend on its sign-ups; one without has none to update yet.
async function recomputeIfEvidence(ctx, guild, raid) {
  if (raid.reports > 0 || raid.log_mode === 'manual') await recomputeRaid(ctx, guild, raid.id);
}

// The viewer's own person on a raid they may sign up for: 403 when they have no character on the raid's team.
async function mySignupContext(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'signups.self', raid.team_id)) throw forbidden();
  const person = await ownPersonStatement(ctx.db, guildContext.guild.id, ctx.session.user.id).first();
  if (!person) throw forbidden();
  const reason = closedReason(raid, ctx.now());
  if (reason) throw closedError(reason, raid);
  return { guildContext, raid, personId: person.id };
}

export async function putMySignup(ctx) {
  const input = readBody(ctx.body, false);
  const { guildContext, raid, personId } = await mySignupContext(ctx);
  await writeSignup(ctx, guildContext, raid, personId, input, true);
  return viewReply(ctx, guildContext, raid);
}

export async function deleteMySignup(ctx) {
  const { guildContext, raid, personId } = await mySignupContext(ctx);
  const results = await ctx.db.batch([
    ctx.db.prepare(
      `DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND player_id = ? AND ${WINDOW_OPEN_SQL} RETURNING signup_id`,
    ).bind(raid.id, personId, raid.id, ctx.now()),
    ctx.db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ? AND changes() = 1").bind(raid.id, guildContext.guild.id),
  ]);
  if (!results[0].results.length) {
    // Nothing deleted: either there was no sign-up, or the window shut between the read and the write.
    throw (await windowError(ctx, raid.id)) || new HttpError(404, 'not_found', 'You have not signed up here.');
  }
  await recomputeIfEvidence(ctx, guildContext.guild, raid);
  return viewReply(ctx, guildContext, raid);
}

export async function putPersonSignup(ctx) {
  const input = readBody(ctx.body, true);
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  await writeSignup(ctx, guildContext, raid, ctx.params.pid, input, false);
  return viewReply(ctx, guildContext, raid);
}

export async function deletePersonSignup(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const results = await ctx.db.batch([
    ctx.db.prepare("DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND player_id = ? RETURNING kind").bind(raid.id, ctx.params.pid),
    ctx.db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ? AND changes() = 1").bind(raid.id, guildContext.guild.id),
    raidAudit(ctx, guildContext, 'signup.remove', raid.id, { personId: ctx.params.pid }, null, CHANGED_ONE),
  ]);
  if (!results[0].results.length) throw new HttpError(404, 'not_found', 'That person has no Raidsmith sign-up on this raid.');
  await recomputeIfEvidence(ctx, guildContext.guild, raid);
  return viewReply(ctx, guildContext, raid);
}

// Close or reopen sign-ups for members. Officers can still edit while it is closed.
async function setLocked(ctx, locked) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  await ctx.db.batch([
    ctx.db.prepare('UPDATE raids SET signups_locked = ?, updated_at = ? WHERE id = ? AND guild_id = ?').bind(locked ? 1 : 0, ctx.now(), raid.id, guildContext.guild.id),
    raidAudit(ctx, guildContext, 'signup.lock', raid.id, { locked: raid.signups_locked === 1 }, { locked }),
  ]);
  return viewReply(ctx, guildContext, { ...raid, signups_locked: locked ? 1 : 0 });
}

export const lockSignups = (ctx) => setLocked(ctx, true);
export const unlockSignups = (ctx) => setLocked(ctx, false);
