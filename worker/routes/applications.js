// The applications inbox. Three parts:
//   The public form (works signed out; a signed-in applicant's account is kept so Accept can link it):
//     GET  /api/apply/:gid                         the guild, its active teams and its questions; 404 when the guild is not taking applications
//     POST /api/apply/:gid                         send one application { teamId?, name, class, spec, realm?, contact?, answers: { <question id>: text }, website }
//   Guild settings (guild.teams):
//     GET/PUT /api/guild/:gid/applications/settings   { enabled, questions }
//   The inbox (roster.edit on the application's team):
//     GET    /api/guild/:gid/applications?status=&team=
//     PATCH  /api/guild/:gid/applications/:apid         { status?: new | reviewing | declined, notes? }
//     POST   /api/guild/:gid/applications/:apid/accept  { teamId?, trialDays? }  -> a Trial person with the character as Main
//     DELETE /api/guild/:gid/applications/:apid
// Spam: the public POST needs a cookie the form's GET handed out (a bot that does not keep cookies is refused), allows 3 applications an hour per
// cookie and 20 a day per guild, and drops a submission whose hidden "website" field is filled without storing it or telling the sender.
import { HttpError, jsonResponse, parseCookies, serializeCookie } from '../http.js';
import { auditStatement } from '../audit.js';
import { addDays } from '../attendance-calendar.js';
import { markRaidsStale } from '../attendance-store.js';
import { base64url, isId, newId } from '../ids.js';
import { ownPersonStatement } from '../membership.js';
import { allows, isGranted, loadGuildContext, requireAction } from '../permissions.js';
import { checkRateLimit } from '../ratelimit.js';
import {
  APPLY_STATUSES, CONTACT_MAX, MAX_QUESTIONS, NOTES_MAX, manyLines, oneLine, questionsOf, readAnswers, readQuestions,
} from '../apply-data.js';
import { isSpecOf, nameKey, rosterOptions } from '../roster-data.js';
import { guildToday } from '../roster-view.js';
import { loadSession, hashToken } from '../session.js';
import {
  LIMIT_KINDS, bad, constraintOf, findNameOwner, insertCharacter, limitError, nameTaken, readClass, readName, requireEdit, requireTarget, resolveRealm,
} from './roster.js';

export const APPLY_COOKIE = '__Host-rs_apply';
export const APPLY_COOKIE_TTL = 30 * 24 * 60 * 60;
export const APPLY_PER_COOKIE = 3;
export const APPLY_COOKIE_WINDOW_MS = 60 * 60 * 1000;
export const APPLY_PER_GUILD_DAY = 20;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const ACCEPT_TRIAL_DAYS = 14;
const COOKIE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

// ---------------------------------------------------------------------------
// The public form

const notOpen = () => new HttpError(404, 'not_found', 'This guild is not taking applications.');

async function loadApplyGuild(ctx) {
  if (!isId('g', ctx.params.gid)) throw notOpen();
  const guild = await ctx.db.prepare(
    `SELECT id, name, realm, realm_kind, realm_slug, region, game_version, apply_enabled, apply_questions FROM guilds WHERE id = ?`,
  ).bind(ctx.params.gid).first();
  if (!guild || guild.apply_enabled !== 1) throw notOpen();
  return guild;
}

const applyTokenOf = (request) => {
  const token = parseCookies(request.headers.get('Cookie'))[APPLY_COOKIE];
  return typeof token === 'string' && COOKIE_PATTERN.test(token) ? token : null;
};

const questionView = (q) => ({ id: q.id, label: q.label, type: q.type, options: q.options || [], required: q.required === true });

async function activeTeams(db, guildId) {
  return (await db.prepare('SELECT id, name FROM teams WHERE guild_id = ? AND archived = 0 ORDER BY created_at, id').bind(guildId).all()).results;
}

export async function getApplyForm(ctx) {
  const guild = await loadApplyGuild(ctx);
  const [teams, session] = await Promise.all([activeTeams(ctx.db, guild.id), loadSession(ctx)]);
  const minted = applyTokenOf(ctx.request) ? null : base64url(ctx.randomBytes(16));
  return jsonResponse({
    guild: { id: guild.id, name: guild.name, realm: guild.realm, realmKind: guild.realm_kind, region: guild.region, gameVersion: guild.game_version },
    teams,
    rosterOptions: rosterOptions(),
    questions: questionsOf(guild.apply_questions).map(questionView),
    signedInAs: session ? (session.user.displayName || session.user.globalName || session.user.username) : null,
  }, 200, {}, minted ? [serializeCookie(APPLY_COOKIE, minted, { maxAge: APPLY_COOKIE_TTL, path: '/' })] : []);
}

export async function submitApplication(ctx) {
  const guild = await loadApplyGuild(ctx);
  const token = applyTokenOf(ctx.request);
  if (!token) {
    throw new HttpError(400, 'cookies_required', 'Open the application form again, and allow cookies for this site, to send it.');
  }
  const { body, db } = ctx;
  // The hidden field only a script fills in: say it worked and store nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') return jsonResponse({ ok: true }, 201);

  const teams = await activeTeams(db, guild.id);
  let team = null;
  if (body.teamId === undefined || body.teamId === null || body.teamId === '') {
    if (teams.length === 1) [team] = teams;
    else throw bad('Pick a team.', 'teamId');
  } else {
    team = teams.find((entry) => entry.id === body.teamId) || null;
    if (!team) throw bad('Pick a team.', 'teamId');
  }
  const name = readName(body.name);
  const classId = readClass(body.class);
  if (typeof body.spec !== 'string' || !isSpecOf(classId, body.spec)) throw bad('Pick a spec of that class.', 'spec');
  const realm = resolveRealm(guild, body.realm === '' ? undefined : body.realm);
  if (!realm) throw bad('That realm is not valid.', 'realm');
  let contact = null;
  if (body.contact !== undefined && body.contact !== null) {
    contact = oneLine(body.contact);
    if (Array.from(contact).length > CONTACT_MAX) throw bad(`Contact details are at most ${CONTACT_MAX} characters.`, 'contact');
    if (!contact) contact = null;
  }
  const answers = readAnswers(questionsOf(guild.apply_questions), body.answers);
  if (!answers.ok) throw bad(answers.message, answers.field);

  const session = await loadSession(ctx);
  const userId = session ? session.user.id : null;
  const now = ctx.now();
  if (userId) {
    const blocked = await db.prepare('SELECT 1 AS x FROM guild_blocks WHERE guild_id = ? AND user_id = ?').bind(guild.id, userId).first();
    if (blocked) throw new HttpError(403, 'access_removed', 'An officer has removed your access to this guild.');
  }

  // Anti-spam, cheapest first: this browser's few an hour, then the guild's daily cap (counted from the stored applications).
  const limit = await checkRateLimit(db, null, now, {
    key: `apply:${(await hashToken(token)).slice(0, 24)}`, limit: APPLY_PER_COOKIE, windowMs: APPLY_COOKIE_WINDOW_MS, failClosed: true,
  });
  if (limit.limited) {
    throw new HttpError(limit.unavailable ? 503 : 429, 'rate_limited', 'You have sent several applications already. Try again in a while.', { retryAfter: limit.retryAfter });
  }
  const today = await db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first FROM applications WHERE guild_id = ? AND created_at > ?').bind(guild.id, now - DAY_MS).first();
  if (today.n >= APPLY_PER_GUILD_DAY) {
    throw new HttpError(429, 'apply_busy', 'This guild has reached its limit of applications for today. Try again tomorrow.', { retryAfter: Math.max(1, Math.ceil((today.first + DAY_MS - now) / 1000)) });
  }
  const key = nameKey(name);
  const open = await db.prepare(
    `SELECT 1 AS x FROM applications WHERE guild_id = ? AND status IN ('new', 'reviewing') AND ((name_key = ? AND realm_key = ?) OR (? IS NOT NULL AND user_id = ?)) LIMIT 1`,
  ).bind(guild.id, key, realm.key, userId, userId).first();
  if (open) throw new HttpError(409, 'already_applied', 'You already have an application waiting with this guild.');

  const id = newId('am', ctx.randomBytes);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, realm, realm_key, class, spec, contact, answers, user_id, created_at, updated_at)
         VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, guild.id, team.id, name, key, realm.realm, realm.key, classId, body.spec, contact, JSON.stringify(answers.value), userId, now, now),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: userId, action: 'application.submit', entityType: 'application', entityId: id, after: { teamId: team.id, signedIn: !!userId },
      }),
    ]);
  } catch (error) {
    if (/applications_cap/.test(`${error && error.message} ${error && error.cause && error.cause.message}`)) {
      throw new HttpError(409, 'inbox_full', 'This guild\'s application inbox is full right now. Contact an officer.');
    }
    throw error;
  }
  return jsonResponse({ ok: true }, 201);
}

// ---------------------------------------------------------------------------
// Settings

async function settingsPayload(db, guildContext) {
  const guild = guildContext.guild;
  const [row, counts] = await Promise.all([
    db.prepare('SELECT apply_enabled, apply_questions FROM guilds WHERE id = ?').bind(guild.id).first(),
    db.prepare('SELECT status, COUNT(*) AS n FROM applications WHERE guild_id = ? GROUP BY status').bind(guild.id).all(),
  ]);
  const byStatus = Object.fromEntries(APPLY_STATUSES.map((status) => [status, 0]));
  for (const entry of counts.results) byStatus[entry.status] = entry.n;
  return {
    enabled: row.apply_enabled === 1,
    questions: questionsOf(row.apply_questions).map(questionView),
    maxQuestions: MAX_QUESTIONS,
    path: `/#/apply/${guild.id}`,
    counts: byStatus,
  };
}

export async function getApplySettings(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.teams');
  return jsonResponse(await settingsPayload(ctx.db, guildContext));
}

export async function putApplySettings(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.teams');
  const { body, db } = ctx;
  if (typeof body.enabled !== 'boolean') throw bad('enabled must be true or false.', 'enabled');
  const read = readQuestions(body.questions, ctx.randomBytes);
  if (!read.ok) throw bad(read.message, 'questions', read.index === null ? {} : { index: read.index });
  const before = await settingsPayload(db, guildContext);
  const guildId = guildContext.guild.id;
  const stored = JSON.stringify(read.value);
  if (before.enabled !== body.enabled || JSON.stringify(before.questions.map((q) => ({ ...q }))) !== JSON.stringify(read.value.map(questionView))) {
    await db.batch([
      db.prepare('UPDATE guilds SET apply_enabled = ?, apply_questions = ? WHERE id = ?').bind(body.enabled ? 1 : 0, stored, guildId),
      auditStatement(ctx, {
        guildId, actorUserId: ctx.session.user.id, action: 'apply.settings', entityType: 'guild', entityId: guildId,
        before: { enabled: before.enabled, questions: before.questions.length }, after: { enabled: body.enabled, questions: read.value.length },
      }),
    ]);
  }
  return jsonResponse(await settingsPayload(db, guildContext));
}

// ---------------------------------------------------------------------------
// The inbox

// Where the viewer may work on applications: 'guild', a list of team ids, or null (nowhere).
function inboxScope(guildContext) {
  const scope = guildContext.can['roster.edit'];
  return isGranted(scope) ? scope : null;
}

const applicationView = (row) => ({
  id: row.id,
  teamId: row.team_id,
  teamName: row.team_name,
  status: row.status,
  name: row.char_name,
  realm: row.realm,
  class: row.class,
  spec: row.spec,
  contact: row.contact,
  answers: (() => { try { return JSON.parse(row.answers); } catch { return []; } })(),
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  applicant: row.user_id ? { displayName: row.display_name || row.global_name || row.username || 'An account' } : null,
  onRoster: row.roster_player ? { personId: row.roster_player, name: row.roster_main || row.char_name } : null,
  personId: row.player_id,
});

const SELECT_APPLICATION = `
  SELECT a.id, a.guild_id, a.team_id, t.name AS team_name, a.status, a.char_name, a.name_key, a.realm, a.realm_key, a.class, a.spec, a.contact, a.answers, a.notes, a.created_at, a.updated_at,
         a.user_id, a.player_id, u.display_name, u.global_name, u.username,
         (SELECT c.player_id FROM characters c WHERE c.guild_id = a.guild_id AND c.name_key = a.name_key AND c.realm_key = a.realm_key) AS roster_player,
         (SELECT m.name FROM characters c JOIN characters m ON m.player_id = c.player_id AND m.is_main = 1
           WHERE c.guild_id = a.guild_id AND c.name_key = a.name_key AND c.realm_key = a.realm_key) AS roster_main
    FROM applications a JOIN teams t ON t.id = a.team_id AND t.guild_id = a.guild_id LEFT JOIN users u ON u.id = a.user_id`;

async function loadApplication(db, guildId, id) {
  const row = await db.prepare(`${SELECT_APPLICATION} WHERE a.id = ? AND a.guild_id = ?`).bind(id, guildId).first();
  if (!row) throw new HttpError(404, 'not_found', 'That application was not found.');
  return row;
}

export async function listApplications(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const scope = inboxScope(guildContext);
  if (!scope) throw forbidden();
  const params = new URL(ctx.request.url).searchParams;
  const status = params.get('status');
  if (status !== null && status !== 'open' && !APPLY_STATUSES.includes(status)) throw bad('Pick new, reviewing, accepted, declined or open.', 'status');
  const teamId = params.get('team');
  if (teamId !== null && !isId('t', teamId)) throw bad('Pick a team.', 'team');
  const guildId = guildContext.guild.id;
  const teamIds = scope === 'guild' ? null : scope;
  const [list, counts] = await ctx.db.batch([
    ctx.db.prepare(
      `${SELECT_APPLICATION} WHERE a.guild_id = ?1 AND (?2 IS NULL OR a.team_id IN (SELECT value FROM json_each(?2))) AND (?3 IS NULL OR a.team_id = ?3)
         AND (?4 IS NULL OR a.status = ?4 OR (?4 = 'open' AND a.status IN ('new', 'reviewing'))) ORDER BY a.created_at DESC, a.id DESC LIMIT 200`,
    ).bind(guildId, teamIds ? JSON.stringify(teamIds) : null, teamId, status),
    ctx.db.prepare(
      `SELECT status, COUNT(*) AS n FROM applications WHERE guild_id = ?1 AND (?2 IS NULL OR team_id IN (SELECT value FROM json_each(?2))) AND (?3 IS NULL OR team_id = ?3) GROUP BY status`,
    ).bind(guildId, teamIds ? JSON.stringify(teamIds) : null, teamId),
  ]);
  const byStatus = Object.fromEntries(APPLY_STATUSES.map((entry) => [entry, 0]));
  for (const entry of counts.results) byStatus[entry.status] = entry.n;
  return jsonResponse({ applications: list.results.map(applicationView), counts: byStatus });
}

async function ownApplication(ctx, guildContext) {
  const row = await loadApplication(ctx.db, guildContext.guild.id, ctx.params.apid);
  requireEdit(guildContext, row.team_id);
  return row;
}

export async function patchApplication(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const row = await ownApplication(ctx, guildContext);
  const { body, db } = ctx;
  if (body.status === undefined && body.notes === undefined) throw bad('Send a status, notes, or both.', 'status');
  let status = row.status;
  if (body.status !== undefined) {
    if (!['new', 'reviewing', 'declined'].includes(body.status)) throw bad('Pick new, reviewing or declined. Use Accept to accept.', 'status');
    if (row.status === 'accepted') throw new HttpError(409, 'already_decided', 'That application was accepted already.');
    status = body.status;
  }
  let notes = row.notes;
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') throw bad('Notes must be text.', 'notes');
    notes = body.notes === null ? null : manyLines(body.notes);
    if (notes !== null && Array.from(notes).length > NOTES_MAX) throw bad(`Notes are at most ${NOTES_MAX} characters.`, 'notes');
    if (notes === '') notes = null;
  }
  const changed = [];
  if (status !== row.status) changed.push('status');
  if (notes !== row.notes) changed.push('notes');
  if (changed.length) {
    const now = ctx.now();
    await db.batch([
      db.prepare(
        `UPDATE applications SET status = ?, notes = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND status != 'accepted'`,
      ).bind(status, notes, ctx.session.user.id, now, now, row.id, guildContext.guild.id),
      auditStatement(ctx, {
        guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action: 'application.update', entityType: 'application', entityId: row.id,
        after: { teamId: row.team_id, status, changed },
      }, { sql: 'changes() = 1', params: [] }),
    ]);
  }
  return jsonResponse({ application: applicationView(await loadApplication(db, guildContext.guild.id, row.id)) });
}

export async function deleteApplication(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const row = await ownApplication(ctx, guildContext);
  await ctx.db.batch([
    ctx.db.prepare('DELETE FROM applications WHERE id = ? AND guild_id = ?').bind(row.id, guildContext.guild.id),
    auditStatement(ctx, {
      guildId: guildContext.guild.id, actorUserId: ctx.session.user.id, action: 'application.delete', entityType: 'application', entityId: row.id,
      before: { teamId: row.team_id, status: row.status },
    }, { sql: 'changes() = 1', params: [] }),
  ]);
  return jsonResponse({ ok: true });
}

// Accept: a Trial person (trial from today, 14 days unless the officer says otherwise) whose Main is the applicant's character on the chosen team.
// The applicant's account is linked to the new person when it has one and is not on the roster of this guild already.
export async function acceptApplication(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const row = await ownApplication(ctx, guildContext);
  const { body, db } = ctx;
  const guild = guildContext.guild;
  if (row.status !== 'new' && row.status !== 'reviewing') throw new HttpError(409, 'already_decided', 'That application was decided already.');
  const team = await requireTarget(db, guild.id, body.teamId === undefined || body.teamId === null ? row.team_id : body.teamId);
  requireEdit(guildContext, team.id);
  const days = body.trialDays === undefined || body.trialDays === null ? ACCEPT_TRIAL_DAYS : body.trialDays;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw bad('The trial is 1 to 90 days.', 'trialDays');
  const now = ctx.now();
  const today = guildToday(guild, now);
  const trialEnd = addDays(today, days);
  const realmKeyValue = row.realm_key;
  const key = row.name_key;
  const owner = await findNameOwner(db, guild.id, key, realmKeyValue);
  if (owner) throw nameTaken(row.char_name, owner);

  let linkUser = null;
  if (row.user_id) {
    const has = await ownPersonStatement(db, guild.id, row.user_id).first();
    linkUser = has ? null : row.user_id;
  }
  const playerId = newId('p', ctx.randomBytes);
  const characterId = newId('c', ctx.randomBytes);
  const mainSpec = row.spec && isSpecOf(row.class, row.spec) ? row.spec : null;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO players (id, guild_id, status, joined_on, trial_start, trial_end, user_id, version, notes_version, created_by, created_at, updated_at)
         VALUES (?, ?, 'trial', ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      ).bind(playerId, guild.id, today, today, trialEnd, linkUser, ctx.session.user.id, now, now),
      insertCharacter(db, guild.id, {
        id: characterId, playerId, teamId: team.id, name: row.char_name, realm: row.realm, realmKey: realmKeyValue, class: row.class, mainSpec, offSpec: null, isMain: true,
      }, now),
      db.prepare(
        `UPDATE applications SET status = 'accepted', player_id = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND status IN ('new', 'reviewing')`,
      ).bind(playerId, ctx.session.user.id, now, now, row.id, guild.id),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'application.accept', entityType: 'application', entityId: row.id,
        after: { personId: playerId, teamId: team.id, linked: !!linkUser, trialEnd },
      }, { sql: 'changes() = 1', params: [] }),
      markRaidsStale(db, guild.id, [key], null, [team.id]),
    ]);
  } catch (error) {
    const kind = constraintOf(error);
    if (LIMIT_KINDS.includes(kind)) throw limitError(kind);
    if (kind === 'character_name') throw nameTaken(row.char_name, await findNameOwner(db, guild.id, key, realmKeyValue));
    if (kind === 'account') throw new HttpError(409, 'already_linked', 'That account belongs to another person of this guild.');
    throw error;
  }
  return jsonResponse({
    application: applicationView(await loadApplication(db, guild.id, row.id)),
    person: { id: playerId, name: row.char_name, teamId: team.id, trialEnd },
    accountLinked: !!linkUser,
    accountSkipped: !!row.user_id && !linkUser,
  }, 201);
}
