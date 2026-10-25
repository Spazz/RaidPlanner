// Native Raidsmith sign-ups: a member signs themselves up for an upcoming raid of a team they have a character on; officers and team
// leads (raids.edit) add, change or remove anyone's, and close sign-ups early. A sign-up is a raid_signups row with source 'raidsmith'
// (one per person per raid) that REPLACES the person's Raid-Helper row everywhere it is shown or counted, so nothing counts twice.
// The attendance recompute reads it with the other sources and is otherwise unchanged. Spec: tasks/reference/guild-phase6-signups-spec.md.
import { HttpError, jsonResponse } from '../http.js';
import { raidAwayEffects, readNotices, teamCharactersStatement, teamNoticesStatement } from '../away-store.js';
import { linkSignupsStatement, markPersonRaidsStale, recomputeRaid } from '../attendance-store.js';
import { displayCharacter } from '../attendance-view.js';
import { isId } from '../ids.js';
import { ownPersonStatement, ownPlayerSql } from '../membership.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { legacyColumnsSql, notInactiveSql } from '../person-legacy.js';
import { raidSizeFields } from '../raid-zones.js';
import { SINGLE_LINE_STRIP, isSpecOf, nameKey } from '../roster-data.js';
import {
  NOTE_MAX, SELF_KINDS, SIGNUP_KINDS, closeHoursOf, closedReason, closesAtOf, countSignups, mergeSignups, raidHelperClassName, raidHelperSpecKey,
  signUpSpecLabel, specChoices, storedKind, windowFieldsOf,
} from '../signups-data.js';
import { SLOT_TIME_SQL } from '../signup-window.js';
import { loadRaid, raidAudit } from './raids.js';
import { bad, readName, readClass, readSpec } from './roster.js';

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
// number, else the team's). Binds (raidId, windowStart, now): windowStart is the raid's window_starts_at (a raid with only a date, see worker/signup-window.js),
// NULL for any other raid. Must agree with closedReason in worker/signup-window.js: closed when (window start, else starts_at) - hours * 3600000 <= now.
const WINDOW_OPEN_SQL = `EXISTS (SELECT 1 FROM raids WHERE id = ? AND raids.signups_locked = 0
    AND COALESCE(?, raids.starts_at) - COALESCE(raids.signup_close_hours, (SELECT t.signup_close_hours FROM teams t WHERE t.id = raids.team_id), 0) * 3600000 > ?)`;

// After a member's write found the window shut: the 409 to answer with, from the raid as it is now (null when it is open after all).
async function windowError(ctx, raidId, timeZone) {
  const found = await ctx.db.prepare(
    `SELECT r.raid_on, r.time_known, r.starts_at, r.signups_locked, r.signup_close_hours, (SELECT t.signup_close_hours FROM teams t WHERE t.id = r.team_id) AS team_close_hours,
            ${SLOT_TIME_SQL} AS slot_time
       FROM raids r WHERE r.id = ?`,
  ).bind(raidId).first();
  if (!found) return closedError('started', null);
  const fresh = { ...found, ...windowFieldsOf(found, timeZone) };
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
      `SELECT source, signup_id, kind, standby, standing, guest, rh_signup_id, class_name, spec_name, position, player_id, nickname, character_id, note, updated_at FROM raid_signups
        WHERE raid_id = ? AND source IN ('raid_helper', 'raidsmith') ORDER BY position, source, signup_id`,
    ).bind(raid.id),
    db.prepare(
      `SELECT ${CHARACTER_COLUMNS} FROM characters
        WHERE guild_id = ? AND (player_id IN (SELECT player_id FROM raid_signups WHERE raid_id = ? AND source IN ('raid_helper', 'raidsmith') AND player_id IS NOT NULL)
                                OR player_id IN (SELECT id FROM players WHERE guild_id = ? AND ${ownPlayerSql('players', '?')}))`,
    ).bind(guild.id, raid.id, guild.id, userId, userId),
  ];
  // An upcoming raid also reads the Away / Late / Leaving notices that cover its date (worker/away.js): a virtual Absence for the people who are away and have
  // no sign-up, a note on those who are late or leaving. They come last, so the positions of the other results do not move.
  const upcoming = raid.starts_at > ctx.now();
  const awayAt = statements.length + (edit ? 1 : 0);
  if (edit) {
    statements.push(db.prepare(
      `SELECT p.id AS person_id, ${legacyColumnsSql('p', 'status')}, c.id, c.player_id, c.name, c.class, c.main_spec, c.off_spec, c.is_main, c.team_id
         FROM players p JOIN characters c ON c.player_id = p.id
        WHERE p.guild_id = ? AND ${notInactiveSql('p')} AND p.id IN (SELECT player_id FROM characters WHERE guild_id = ? AND team_id = ?)`,
    ).bind(guild.id, guild.id, teamId));
  }
  if (upcoming) {
    statements.push(
      teamNoticesStatement(db, guild.id, teamId, userId, raid.raid_on, raid.raid_on),
      teamCharactersStatement(db, guild.id, teamId, raid.raid_on, raid.raid_on),
    );
  }
  const results = await db.batch(statements);
  const myPlayerId = results[0].results.length ? results[0].results[0].id : null;
  const charactersByPlayer = new Map();
  for (const row of results[2].results) {
    if (!charactersByPlayer.has(row.player_id)) charactersByPlayer.set(row.player_id, []);
    charactersByPlayer.get(row.player_id).push(row);
  }
  let effects = { away: [], notes: new Map() };
  if (upcoming) {
    const known = new Set(results[2].results.map((row) => row.id));
    for (const row of results[awayAt + 1].results) {
      if (known.has(row.id)) continue;
      if (!charactersByPlayer.has(row.player_id)) charactersByPlayer.set(row.player_id, []);
      charactersByPlayer.get(row.player_id).push(row);
    }
    effects = raidAwayEffects(readNotices(results[awayAt].results), raid.raid_on, new Set(results[1].results.map((row) => row.player_id).filter(Boolean)));
  }
  const entries = mergeSignups(results[1].results, charactersByPlayer, { teamId, seeNicknames, myPlayerId, away: effects.away, notes: effects.notes });
  // Late / Leaving notices of people who have no entry at all.
  const listed = new Set(entries.map((entry) => entry.personId).filter(Boolean));
  const notices = [...effects.notes].filter(([personId]) => !listed.has(personId)).map(([personId, note]) => {
    const shown = displayCharacter(charactersByPlayer.get(personId) || [], teamId);
    return { personId, name: shown ? shown.name : null, kind: note.kind, atTime: note.atTime };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.personId.localeCompare(b.personId));

  let me = null;
  if (self && myPlayerId) {
    const mine = (charactersByPlayer.get(myPlayerId) || []).filter((row) => row.team_id === teamId).sort(byMainThenName);
    const shown = displayCharacter(mine, teamId);
    me = {
      personId: myPlayerId,
      signup: entries.find((entry) => entry.isMe) || null,
      notice: effects.notes.has(myPlayerId) ? { kind: effects.notes.get(myPlayerId).kind, atTime: effects.notes.get(myPlayerId).atTime } : null,
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
      id: raid.id, teamId, startsAt: raid.starts_at, timeKnown: raid.time_known !== 0, upcoming: raid.starts_at > ctx.now(), locked: raid.signups_locked === 1, closed,
      closesAt: closesAtOf(raid, closeHours), ...(raid.window_source ? { closesSource: raid.window_source } : {}), closeHours, closeHoursOverride: raid.signup_close_hours, teamCloseHours: raid.team_close_hours,
      ...raidSizeFields(raid, raid.team_size, guild.game_version),
    },
    can: { edit, self: !!me, seeList, seeNicknames },
    me,
    counts: seeList ? countSignups(entries) : null,
    entries: seeList ? entries : null,
    notices: seeList ? notices : null,
    roster,
  };
}

const viewReply = async (ctx, guildContext, raid) => jsonResponse(await buildView(ctx, guildContext, raid));

// ---------------------------------------------------------------------------
// Reads

export async function getSignups(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'raids.view');
  const raid = await loadRaid(ctx, guildContext);
  return jsonResponse(await buildView(ctx, guildContext, raid));
}

// GET .../signup: the viewer's own part of the view (403 for someone with no character on the raid's team).
export async function getMySignup(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
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
    throw bad(officer ? 'Pick signed, late, standby, tentative, bench or absence.' : 'Pick signed, late, standby, tentative or absence.', 'kind');
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
// statement); otherwise an officer's (any time). options.roster: the person answering a published roster (worker/routes/roster-publish.js) - their own
// characters, but neither the lock nor the deadline binds them, only the start. -> nothing; throws 4xx.
export async function writeSignup(ctx, guildContext, raid, personId, input, self, options = {}) {
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
  let guard = self
    ? { sql: WINDOW_OPEN_SQL, params: [raid.id, raid.window_starts_at ?? null, now] }
    : { sql: 'EXISTS (SELECT 1 FROM raids WHERE id = ?)', params: [raid.id] };
  if (options.roster) guard = { sql: 'EXISTS (SELECT 1 FROM raids WHERE id = ? AND starts_at > ?)', params: [raid.id, now] };
  // Standby is stored as 'signed' + standby = 1; every other kind clears the flag (the table's CHECK keeps the pair honest). Any write is an edit, so a
  // sign-up a standing sign-up made is the member's own from here on (standing = 0) and is never removed by it.
  const stored = storedKind(input.kind);
  const statements = [
    db.prepare(
      `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, standby, class_name, spec_name, position, guild_id, player_id,
                                 character_id, note, updated_by, created_at, updated_at)
       SELECT ?, 'raidsmith', n.next, NULL, NULL, ?, ?, ?, ?, n.next, ?, ?, ?, ?, ?, ?, ?
         FROM (SELECT COALESCE(MAX(signup_id), 0) + 1 AS next FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith') n
        WHERE ${guard.sql}
       ON CONFLICT (raid_id, player_id) WHERE source = 'raidsmith' DO UPDATE SET
         kind = excluded.kind, standby = excluded.standby, standing = 0, class_name = excluded.class_name, spec_name = excluded.spec_name,
         character_id = excluded.character_id, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(raid.id, stored.kind, stored.standby, raidHelperClassName(character.class), spec ? raidHelperSpecKey(character.class, spec) : null, guild.id, personId,
      character.id, note, ctx.session.user.id, now, now, raid.id, ...guard.params),
    // The results of this raid are out of date, and no recompute that read the old sign-ups may write over that.
    db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ? AND changes() = 1").bind(raid.id, guild.id),
  ];
  if (!self) {
    statements.push(raidAudit(ctx, guildContext, 'signup.set', raid.id, existing ? { kind: 'set' } : null, { personId, kind: input.kind }, CHANGED_ONE));
  }
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1) {
    if (options.roster) throw new HttpError(409, 'raid_started', 'This raid has started: the roster can no longer be answered here. Ask an officer.');
    throw (await windowError(ctx, raid.id, guild.time_zone)) || closedError('locked', raid);
  }
  await recomputeIfEvidence(ctx, guild, raid);
}

// A raid with a log or hand-entered attendance has results that depend on its sign-ups; one without has none to update yet.
async function recomputeIfEvidence(ctx, guild, raid) {
  if (raid.reports > 0 || raid.log_mode === 'manual') await recomputeRaid(ctx, guild, raid.id);
}

// The viewer's own person on a raid they may sign up for: 403 when they have no character on the raid's team.
async function mySignupContext(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
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

// Taking away a sign-up that a standing sign-up made (standing = 1) is the member's "not this time", not "no answer": it becomes their explicit Absence
// (standing = 0, so the standing reconcile never makes it again). A hand-made sign-up (standing = 0) is deleted for real. The DELETE comes first and only
// takes standing = 0 rows; the UPDATE then converts the standing = 1 row (it would otherwise match the DELETE's filter after being cleared).
const TO_ABSENCE_SQL = `UPDATE raid_signups SET kind = 'absence', standby = 0, standing = 0, updated_by = ?, updated_at = ?
                          WHERE raid_id = ? AND source = 'raidsmith' AND player_id = ? AND standing = 1`;
const BUMP_SQL = "UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ? AND changes() = 1";

export async function deleteMySignup(ctx) {
  const { guildContext, raid, personId } = await mySignupContext(ctx);
  const now = ctx.now();
  const guildId = guildContext.guild.id;
  const results = await ctx.db.batch([
    ctx.db.prepare(
      `DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND player_id = ? AND standing = 0 AND ${WINDOW_OPEN_SQL} RETURNING signup_id`,
    ).bind(raid.id, personId, raid.id, raid.window_starts_at ?? null, now),
    ctx.db.prepare(BUMP_SQL).bind(raid.id, guildId),
    ctx.db.prepare(`${TO_ABSENCE_SQL} AND ${WINDOW_OPEN_SQL} RETURNING signup_id`).bind(ctx.session.user.id, now, raid.id, personId, raid.id, raid.window_starts_at ?? null, now),
    ctx.db.prepare(BUMP_SQL).bind(raid.id, guildId),
  ]);
  if (!results[0].results.length && !results[2].results.length) {
    // Nothing deleted or converted: either there was no sign-up, or the window shut between the read and the write.
    throw (await windowError(ctx, raid.id, guildContext.guild.time_zone)) || new HttpError(404, 'not_found', 'You have not signed up here.');
  }
  await recomputeIfEvidence(ctx, guildContext.guild, raid);
  return viewReply(ctx, guildContext, raid);
}

export async function putPersonSignup(ctx) {
  const input = readBody(ctx.body, true);
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  await writeSignup(ctx, guildContext, raid, ctx.params.pid, input, false);
  return viewReply(ctx, guildContext, raid);
}

export async function deletePersonSignup(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const guildId = guildContext.guild.id;
  // A standing sign-up becomes the person's Absence instead of going (see TO_ABSENCE_SQL); either way it is the same audited signup.remove.
  const results = await ctx.db.batch([
    ctx.db.prepare("DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND player_id = ? AND standing = 0 RETURNING kind").bind(raid.id, ctx.params.pid),
    ctx.db.prepare(BUMP_SQL).bind(raid.id, guildId),
    raidAudit(ctx, guildContext, 'signup.remove', raid.id, { personId: ctx.params.pid }, null, CHANGED_ONE),
    ctx.db.prepare(`${TO_ABSENCE_SQL} RETURNING kind`).bind(ctx.session.user.id, ctx.now(), raid.id, ctx.params.pid),
    ctx.db.prepare(BUMP_SQL).bind(raid.id, guildId),
    raidAudit(ctx, guildContext, 'signup.remove', raid.id, { personId: ctx.params.pid }, null, CHANGED_ONE),
  ]);
  if (!results[0].results.length && !results[3].results.length) throw new HttpError(404, 'not_found', 'That person has no Raidsmith sign-up on this raid.');
  await recomputeIfEvidence(ctx, guildContext.guild, raid);
  return viewReply(ctx, guildContext, raid);
}

// Close or reopen sign-ups for members. Officers can still edit while it is closed.
async function setLocked(ctx, locked) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  await ctx.db.batch([
    ctx.db.prepare('UPDATE raids SET signups_locked = ?, updated_at = ? WHERE id = ? AND guild_id = ?').bind(locked ? 1 : 0, ctx.now(), raid.id, guildContext.guild.id),
    raidAudit(ctx, guildContext, 'signup.lock', raid.id, { locked: raid.signups_locked === 1 }, { locked }),
  ]);
  return viewReply(ctx, guildContext, { ...raid, signups_locked: locked ? 1 : 0 });
}

export const lockSignups = (ctx) => setLocked(ctx, true);
export const unlockSignups = (ctx) => setLocked(ctx, false);

// ---------------------------------------------------------------------------
// Link a Raid-Helper sign-up to a person

// POST .../signups/guest: { signupId, name } resolves an import; { name, class, spec, kind, note? } adds a guest directly.
// The source stays intact; native rows survive refresh and deleting the guest restores the unmatched source.
export async function guestSignup(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const imported = body.signupId !== undefined;
  if (imported && !allows(guildContext.can, 'roster.edit', raid.team_id)) throw forbidden();
  const guild = guildContext.guild;
  if (imported && (!Number.isInteger(body.signupId) || body.signupId < 0)) throw bad('Pick a sign-up.', 'signupId');
  const name = readName(body.name, 'name', {}, guild.game_version);
  let manual;
  if (imported) {
    const row = await db.prepare("SELECT * FROM raid_signups WHERE raid_id = ? AND source = 'raid_helper' AND signup_id = ?")
      .bind(raid.id, body.signupId).first();
    if (!row) throw new HttpError(404, 'not_found', 'That sign-up was not found.');
    if (row.player_id) throw new HttpError(409, 'already_linked', 'That sign-up already belongs to a person.');
  } else {
    const classId = readClass(body.class);
    const spec = readSpec(body.spec, classId, 'spec');
    if (!spec) throw bad('Choose a spec so the guest has a role.', 'spec');
    manual = { ...readBody(body, true), classId, spec };
  }
  const [onRoster, guests] = await db.batch([
    db.prepare('SELECT 1 FROM characters WHERE guild_id = ? AND name_key = ? LIMIT 1').bind(guild.id, nameKey(name)),
    db.prepare("SELECT nickname, rh_signup_id FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND guest = 1").bind(raid.id),
  ]);
  if (onRoster.results.length) throw new HttpError(409, 'on_roster', 'That character is on the guild roster. Choose their person instead of adding a guest.', { field: 'name' });
  if (guests.results.some(g => (imported && g.rh_signup_id === body.signupId) || nameKey(g.nickname) === nameKey(name))) {
    throw new HttpError(409, 'already_joined', 'That guest or sign-up has already been added.', { field: 'name' });
  }
  const now = ctx.now();
  if (manual) {
    const stored = storedKind(manual.kind);
    await db.batch([
      db.prepare(`INSERT INTO raid_signups
        (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, guest, note, updated_by, created_at, updated_at)
        SELECT ?, 'raidsmith', n.next, ?, ?, ?, ?, ?, n.next, ?, 1, ?, ?, ?, ?
        FROM (SELECT COALESCE(MAX(signup_id), 0) + 1 AS next FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith') n`)
        .bind(raid.id, name, stored.kind, stored.standby, raidHelperClassName(manual.classId), raidHelperSpecKey(manual.classId, manual.spec), guild.id, manual.note, ctx.session.user.id, now, now, raid.id),
      raidAudit(ctx, guildContext, 'signup.guest', raid.id, null, { name, class: manual.classId }, CHANGED_ONE),
    ]);
    await recomputeIfEvidence(ctx, guild, raid);
    return jsonResponse(await buildView(ctx, guildContext, raid));
  }
  const results = await db.batch([
    db.prepare(`INSERT INTO raid_signups
      (raid_id, source, signup_id, nickname, kind, standby, class_name, spec_name, position, guild_id, guest, rh_signup_id, updated_by, created_at, updated_at)
      SELECT s.raid_id, 'raidsmith', (SELECT COALESCE(MAX(signup_id), 0) + 1 FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith'),
        ?, s.kind, s.standby, s.class_name, s.spec_name, s.position, s.guild_id, 1, s.signup_id, ?, ?, ?
      FROM raid_signups s WHERE s.raid_id = ? AND s.source = 'raid_helper' AND s.signup_id = ? AND s.player_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM raid_signups n WHERE n.raid_id = s.raid_id AND n.rh_signup_id = s.signup_id)`)
      .bind(raid.id, name, ctx.session.user.id, now, now, raid.id, body.signupId),
    raidAudit(ctx, guildContext, 'signup.guest_resolve', raid.id, null, { signupId: body.signupId, name }, CHANGED_ONE),
  ]);
  if (!results[0].meta.changes) throw new HttpError(409, 'already_linked', 'That sign-up has changed. Refresh and try again.');
  await recomputeIfEvidence(ctx, guild, raid);
  return jsonResponse(await buildView(ctx, guildContext, raid));
}

// POST .../signups/link { signupId, personId }: the person takes the row's Discord ID when they have none,
// and every unlinked row of the guild with that ID follows. A row without a Discord ID links only itself.
export async function linkSignup(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'roster.edit', raid.team_id)) throw forbidden();
  if (!Number.isInteger(body.signupId) || body.signupId < 0) throw bad('Send the sign-up to link.', 'signupId');
  if (!isId('p', body.personId)) throw bad('Pick the person this sign-up belongs to.', 'personId');
  const [rowResult, personResult] = await db.batch([
    db.prepare(`SELECT discord_user_id, nickname, player_id,
      EXISTS (SELECT 1 FROM raid_signups n WHERE n.raid_id = s.raid_id AND n.rh_signup_id = s.signup_id) AS resolved_guest
      FROM raid_signups s WHERE raid_id = ? AND source = 'raid_helper' AND signup_id = ?`).bind(raid.id, body.signupId),
    db.prepare('SELECT id, discord_user_id FROM players WHERE id = ? AND guild_id = ?').bind(body.personId, guild.id),
  ]);
  const row = rowResult.results[0];
  if (!row) throw new HttpError(404, 'not_found', 'That sign-up was not found.');
  const person = personResult.results[0];
  if (row.resolved_guest) throw new HttpError(409, 'already_linked', 'Remove the Guest / Pug resolution before linking this sign-up.');
  if (!person) throw bad('Pick a person on the roster.', 'personId');
  if (row.player_id) throw new HttpError(409, 'already_linked', 'That sign-up is already linked to a person.', { field: 'signupId' });
  const discordId = row.discord_user_id || null;
  if (discordId && person.discord_user_id && person.discord_user_id !== discordId) {
    throw new HttpError(409, 'discord_mismatch', 'That person is already linked to a different Discord account.', { field: 'personId' });
  }
  if (discordId && !person.discord_user_id) {
    const owner = await db.prepare('SELECT id FROM players WHERE guild_id = ? AND discord_user_id = ? AND id != ?').bind(guild.id, discordId, person.id).first();
    if (owner) throw new HttpError(409, 'already_linked', 'Another person already has this Discord account.', { field: 'personId' });
  }
  const now = ctx.now();
  const statements = [];
  if (discordId && !person.discord_user_id) {
    statements.push(db.prepare(
      'UPDATE players SET discord_user_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND guild_id = ? AND discord_user_id IS NULL',
    ).bind(discordId, now, person.id, guild.id));
  }
  statements.push(
    linkSignupsStatement(db, guild.id, person.id, discordId, raid.id, body.signupId),
    markPersonRaidsStale(db, guild.id, person.id),
    db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ?").bind(raid.id, guild.id),
  );
  const auditIndex = statements.length;
  statements.push(raidAudit(ctx, guildContext, 'signup.link', raid.id, null, { personId: person.id, nickname: row.nickname, linkedDiscord: !!discordId }));
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (/players_guild_discord|UNIQUE/i.test(String(error && error.message))) throw new HttpError(409, 'already_linked', 'Another person already has this Discord account.', { field: 'personId' });
    throw error;
  }
  const relinked = results[auditIndex - 3].meta.changes;
  await recomputeIfEvidence(ctx, guild, raid);
  return jsonResponse({ ...(await buildView(ctx, guildContext, await loadRaid(ctx, guildContext))), relinked });
}
