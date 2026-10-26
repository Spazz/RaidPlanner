import { guestIdentityStatement, guestKeysFor } from '../guest-identity.js';
// Attendance: the policy and Warcraft Logs settings, the review queue and decisions, unmatched characters, the team page,
// person history and the backfill list. Raids themselves are in raids.js.
import { HttpError, cleanText, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { addDays, localDate, weekStart } from '../attendance-calendar.js';
import { DEFAULT_POLICY, REGION_RESET_DAY, resolvePolicy, validateOverride } from '../attendance-policy.js';
import { watchStaysReviewed } from '../attention.js';
import { teamMetrics, watchList, WATCH_MIN_PREVIOUS } from '../attendance-metrics.js';
import { ladderOf, rankReview } from '../rank-ladder.js';
import {
  EVIDENCE_NAME_KEY, bumpRaidStatement, findUnmatched, isPlainObject, makePolicyResolver, markRaidsStale, policyRowsStatement, presenceKey, recomputeRaid,
} from '../attendance-store.js';
import { displayCharacter, groupBy, isStale, loadRaidDetail, raidState } from '../attendance-view.js';
import { isId, newId } from '../ids.js';
import { isOwnPlayer } from '../membership.js';
import { winnerNameKeySql } from '../name-alias.js';
import { allows, loadGuildContext, requireAction } from '../permissions.js';
import { characterRankColumns, trialDatesFollowMainStatements } from '../person-legacy.js';
import { characterOfRow, homeTeamId } from '../person-rank.js';
import { assertSenior, seniorityOk } from '../seniority.js';
import { CLASS_IDS, CREATE_STATUSES, cleanCharacterName, DEFAULT_WCL_FLAVOUR, isRealDate, nameKey } from '../roster-data.js';
import { guildToday, personColumnsOf, viewerOf } from '../roster-view.js';
import { listWclReports, requireWclConfigured } from '../sources.js';
import { isTeamRosterRow } from '../team-roster.js';
import {
  bad, constraintOf, errorText, findNameOwner, insertCharacter, LIMIT_KINDS, limitError, nameTaken, newMainStatements, requireTarget, resolveRealm,
} from './roster.js';
import { loadRaid, raidFetchRate, recomputeAndReply } from './raids.js';

const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const MAX_UPLOADERS = 10;
const REVIEW_RAIDS = 100;
const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message);
const parseFlags = (text) => { try { const value = JSON.parse(text); return Array.isArray(value) ? value : []; } catch { return []; } };

async function requireTeam(db, guildId, teamId, field = 'team') {
  if (!isId('t', teamId)) throw bad('Pick a team.', field);
  const team = await db.prepare('SELECT id, name, archived, wcl_uploaders FROM teams WHERE id = ? AND guild_id = ?').bind(teamId, guildId).first();
  if (!team) throw bad('That team does not exist in this guild.', field);
  return team;
}

// ---------------------------------------------------------------------------
// Policy and Warcraft Logs settings

async function policyView(ctx, guildContext) {
  const guild = guildContext.guild;
  const [policyResult, teamResult] = await ctx.db.batch([
    policyRowsStatement(ctx.db, guild.id),
    ctx.db.prepare('SELECT id, archived, wcl_uploaders FROM teams WHERE guild_id = ? ORDER BY created_at, id').bind(guild.id),
  ]);
  return buildPolicyView(guild, policyResult.results, teamResult.results);
}

function buildPolicyView(guild, policyRows, teams) {
  const resolver = makePolicyResolver(guild, policyRows);
  const resolved = {};
  const uploaders = {};
  for (const team of teams) {
    resolved[team.id] = resolver.resolved(team.id);
    try { uploaders[team.id] = JSON.parse(team.wcl_uploaders); } catch { uploaders[team.id] = []; }
  }
  return {
    defaults: DEFAULT_POLICY,
    guild: resolver.overrides.guild,
    teams: resolver.overrides.teams,
    resolved,
    versions: resolver.versions,
    resetDayDerived: REGION_RESET_DAY[guild.region] ?? null,
    wcl: { guildId: guild.wcl_guild_id ?? null, uploaders },
    _resolver: resolver,
  };
}

const publicPolicyView = (view) => { const { _resolver, ...rest } = view; return rest; };

export async function getPolicy(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'raids.view');
  return jsonResponse(publicPolicyView(await policyView(ctx, guildContext)));
}

// validateOverride may answer with a list of { path, message }, or an object holding one; an empty list is valid.
function policyErrors(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.errors)) return result.errors;
  return [];
}

// Credit labels are stored the way cleanText returns them (trimmed).
function withTrimmedLabels(policy) {
  if (!isPlainObject(policy.credit) || !Array.isArray(policy.credit.values)) return policy;
  return { ...policy, credit: { ...policy.credit, values: policy.credit.values.map((entry) => ({ ...entry, label: entry.label.trim() })) } };
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

export async function putPolicy(ctx) {
  const { body, db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'attendance.policy');
  const guild = guildContext.guild;
  const teamId = body.teamId === undefined ? null : body.teamId;
  if (teamId !== null && !isId('t', teamId)) throw bad('Pick a team.', 'teamId');
  if (!isPlainObject(body.policy)) throw new HttpError(400, 'policy_invalid', 'The policy must be an object.', { field: 'policy', errors: [{ path: 'policy', message: 'The policy must be an object.' }] });
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) throw bad('Send the version you last saw.', 'expectedVersion');
  const view = await policyView(ctx, guildContext);
  if (teamId !== null && !(teamId in view.resolved)) throw bad('That team does not exist in this guild.', 'teamId');
  const resolver = view._resolver;
  // A team override is checked against the guild-level policy it sits on (the switch must include the default window).
  const errors = policyErrors(validateOverride(body.policy, teamId === null ? 'guild' : 'team', teamId === null ? DEFAULT_POLICY : resolver.resolved(null)));
  if (errors.length) throw new HttpError(400, 'policy_invalid', errors[0].message, { field: errors[0].path, errors });
  const policyToSave = withTrimmedLabels(body.policy);
  if (teamId === null) {
    // Every team override sits on top of the new guild policy: none may be left invalid by this save.
    const nextGuild = resolvePolicy(policyToSave, {}, guild.region);
    for (const [overriddenTeamId, override] of Object.entries(resolver.overrides.teams)) {
      const teamErrors = policyErrors(validateOverride(override, 'team', nextGuild));
      if (!teamErrors.length) continue;
      const teamRow = (await db.prepare('SELECT name FROM teams WHERE id = ? AND guild_id = ?').bind(overriddenTeamId, guild.id).first()) || { name: overriddenTeamId };
      throw new HttpError(400, 'policy_invalid', `The ${teamRow.name} override would become invalid: ${teamErrors[0].message}`, {
        field: teamErrors[0].path, teamId: overriddenTeamId, teamName: teamRow.name, errors: teamErrors.map((error) => ({ ...error, teamId: overriddenTeamId })),
      });
    }
  }
  const existingId = teamId === null ? resolver.ids.guild : resolver.ids.teams[teamId] || null;
  const version = teamId === null ? resolver.versions.guild : (resolver.versions.teams[teamId] || 0);
  const conflict = () => new HttpError(409, 'conflict', 'Someone else changed the policy. The page now shows their version.', { current: publicPolicyView(view) });
  if (body.expectedVersion !== version) throw conflict();

  const before = teamId === null ? resolver.overrides.guild : (resolver.overrides.teams[teamId] || {});
  const changed = changedKeys(before, policyToSave);
  const now = ctx.now();
  const policyJson = JSON.stringify(policyToSave);
  const entryId = existingId || newId('ap', ctx.randomBytes);
  const audit = (guard) => auditStatement(ctx, {
    guildId: guild.id, actorUserId: ctx.session.user.id, action: 'policy.update', entityType: 'policy', entityId: entryId,
    before: { scope: teamId || 'guild', version, changed },
    after: { scope: teamId || 'guild', version: version + 1, changed, values: Object.fromEntries(changed.filter((key) => key in policyToSave).map((key) => [key, policyToSave[key]])) },
  }, guard);
  let results;
  try {
    results = await db.batch(existingId ? [
      db.prepare('UPDATE attendance_policies SET policy = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND version = ?')
        .bind(policyJson, ctx.session.user.id, now, existingId, guild.id, version),
      audit(CHANGED_ONE),
    ] : [
      db.prepare('INSERT INTO attendance_policies (id, guild_id, team_id, policy, version, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .bind(entryId, guild.id, teamId, policyJson, ctx.session.user.id, now),
      audit(CHANGED_ONE),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(errorText(error))) {
      throw new HttpError(409, 'conflict', 'Someone else changed the policy. Reload and try again.', { current: publicPolicyView(await policyView(ctx, guildContext)) });
    }
    throw error;
  }
  if (results[0].meta.changes !== 1) throw conflict();
  return jsonResponse(publicPolicyView(await policyView(ctx, guildContext)));
}

export async function putWclSettings(ctx) {
  const { body, db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'attendance.policy');
  const guild = guildContext.guild;
  if (body.wclGuildId !== undefined && body.wclGuildId !== null && !(Number.isInteger(body.wclGuildId) && body.wclGuildId > 0 && body.wclGuildId < 2147483648)) {
    throw bad('The Warcraft Logs guild ID is a whole number.', 'wclGuildId');
  }
  if (body.uploaders !== undefined && !isPlainObject(body.uploaders)) throw bad('uploaders must be an object.', 'uploaders');
  const lists = [];
  for (const [teamId, names] of Object.entries(body.uploaders || {})) {
    if (!isId('t', teamId)) throw bad('Pick a team.', 'uploaders');
    if (!Array.isArray(names) || names.length > MAX_UPLOADERS) throw bad(`Give at most ${MAX_UPLOADERS} uploader names per team.`, 'uploaders');
    const seen = new Set();
    const clean = names.map((name) => cleanText(name, 'uploaders', { min: 2, max: 24 })).filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    lists.push({ teamId, names: clean });
  }
  if (body.wclGuildId === undefined && !lists.length) throw bad('Send a Warcraft Logs guild ID, uploaders, or both.', 'wclGuildId');
  const teams = await db.prepare('SELECT id FROM teams WHERE guild_id = ?').bind(guild.id).all();
  const known = new Set(teams.results.map((row) => row.id));
  for (const list of lists) if (!known.has(list.teamId)) throw bad('That team does not exist in this guild.', 'uploaders');

  const statements = [];
  if (body.wclGuildId !== undefined) statements.push(db.prepare('UPDATE guilds SET wcl_guild_id = ? WHERE id = ?').bind(body.wclGuildId, guild.id));
  for (const list of lists) {
    statements.push(db.prepare('UPDATE teams SET wcl_uploaders = ? WHERE id = ? AND guild_id = ?').bind(JSON.stringify(list.names), list.teamId, guild.id));
  }
  statements.push(auditStatement(ctx, {
    guildId: guild.id, actorUserId: ctx.session.user.id, action: 'wcl.settings', entityType: 'guild', entityId: guild.id,
    before: { wclGuildId: guild.wcl_guild_id ?? null },
    after: { wclGuildId: body.wclGuildId === undefined ? (guild.wcl_guild_id ?? null) : body.wclGuildId, teamIds: lists.map((list) => list.teamId), uploaders: lists.map((list) => list.names.length) },
  }));
  await db.batch(statements);
  const fresh = { ...guildContext, guild: { ...guild, wcl_guild_id: body.wclGuildId === undefined ? (guild.wcl_guild_id ?? null) : body.wclGuildId } };
  return jsonResponse(publicPolicyView(await policyView(ctx, fresh)));
}

// ---------------------------------------------------------------------------
// Review queue

export async function getReview(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const team = await requireTeam(ctx.db, guild.id, new URL(ctx.request.url).searchParams.get('team'));
  if (!allows(guildContext.can, 'attendance.review', team.id)) throw forbidden();
  const bind = (sql) => ctx.db.prepare(sql).bind(guild.id, team.id);
  const [raidResult, rowResult, characterResult, presenceResult, knownResult, guestResult, allRaidResult, policyResult, lootResult] = await ctx.db.batch([
    bind(`SELECT id, raid_on, zone, open_flags FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND open_flags > 0 ORDER BY raid_on DESC LIMIT ${REVIEW_RAIDS}`),
    bind(`SELECT * FROM attendance WHERE guild_id = ?1 AND team_id = ?2 AND needs_review = 1
            AND raid_id IN (SELECT id FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND open_flags > 0)`),
    bind(`SELECT player_id, name, class, team_id, is_main FROM characters
           WHERE guild_id = ?1 AND player_id IN (SELECT player_id FROM attendance WHERE guild_id = ?1 AND team_id = ?2 AND needs_review = 1)`),
    // The log's names, then the names of a pasted roster that matched nobody (wave 8; pulls 0 tells them apart).
    // match_name_key: the logged name as the characters carry it today (worker/name-alias.js), dated at the raid.
    bind(`SELECT rp.raid_id, rp.name, rp.name_key, rp.realm, rp.realm_key, rp.class, COUNT(*) AS pulls, ${EVIDENCE_NAME_KEY} AS match_name_key
            FROM raid_presence rp JOIN raids pr ON pr.id = rp.raid_id
           WHERE rp.guild_id = ?1 AND rp.raid_id IN (SELECT id FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND open_flags > 0)
           GROUP BY rp.raid_id, rp.name_key, rp.realm_key
          UNION ALL SELECT rp.raid_id, rp.name, rp.name_key, rp.realm, rp.realm_key, NULL, 0, ${EVIDENCE_NAME_KEY} FROM raid_manual_names rp JOIN raids pr ON pr.id = rp.raid_id
           WHERE rp.guild_id = ?1 AND rp.raid_id IN (SELECT id FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND open_flags > 0)`),
    bind(`SELECT name_key, realm_key FROM characters WHERE guild_id = ?1 AND name_key IN
            (SELECT ${EVIDENCE_NAME_KEY} FROM raid_presence rp JOIN raids pr ON pr.id = rp.raid_id
              WHERE rp.guild_id = ?1 AND rp.raid_id IN (SELECT id FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND open_flags > 0)
             UNION SELECT ${EVIDENCE_NAME_KEY} FROM raid_manual_names rp JOIN raids pr ON pr.id = rp.raid_id
              WHERE rp.guild_id = ?1 AND rp.raid_id IN (SELECT id FROM raids WHERE guild_id = ?1 AND team_id = ?2 AND open_flags > 0))`),
    guestIdentityStatement(ctx.db, guild.id),
    bind(`SELECT id, team_id, policy_fp, log_mode, open_flags, (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = raids.id) AS reports
            FROM raids WHERE guild_id = ?1 AND team_id = ?2`),
    policyRowsStatement(ctx.db, guild.id),
    // Loot winners nobody matches (no character, not a guest), per raid. Only shown to those who may edit the team's loot. A disenchanted
    // item has no winner (winner_name_key NULL) and is never listed.
    bind(`SELECT a.raid_id, r.raid_on, r.zone, MAX(a.winner_name) AS name, a.winner_name_key AS name_key, MAX(a.winner_realm) AS realm,
                 a.winner_realm_key AS realm_key, MAX(a.winner_class) AS class, COUNT(*) AS awards
            FROM loot_awards a JOIN raids r ON r.id = a.raid_id AND r.guild_id = a.guild_id
           WHERE a.guild_id = ?1 AND a.team_id = ?2 AND a.winner_name_key IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.name_key = ${winnerNameKeySql('a')} AND c.realm_key = a.winner_realm_key)
             AND NOT EXISTS (SELECT 1 FROM attendance_guests g WHERE g.guild_id = ?1 AND g.name_key = a.winner_name_key AND g.realm_key = a.winner_realm_key)
           GROUP BY a.raid_id, a.winner_name_key, a.winner_realm_key`),
  ]);
  const resolver = makePolicyResolver(guild, policyResult.results);
  const charactersByPlayer = groupBy(characterResult.results, 'player_id');
  const rowsByRaid = groupBy(rowResult.results, 'raid_id');
  const presenceByRaid = groupBy(presenceResult.results, 'raid_id');
  const characterKeys = new Set(knownResult.results.map((row) => presenceKey(row.name_key, row.realm_key)));
  const guests = guestResult.results;
  const stale = allRaidResult.results
    .filter((raid) => isStale(raidState(raid, raid.reports, resolver)))
    .map((raid) => raid.id);
  const staleIds = new Set(stale);
  const raids = raidResult.results.map((raid) => {
    const people = (rowsByRaid.get(raid.id) || []).map((row) => {
      const character = displayCharacter(charactersByPlayer.get(row.player_id) || [], team.id);
      return {
        kind: 'person',
        playerId: row.player_id,
        name: character ? character.name : 'Unknown',
        class: character ? character.class : null,
        outcome: row.outcome,
        credit: row.credit,
        flags: parseFlags(row.flags),
        signup: row.signup_kind,
        pulls: { present: row.pulls_present, total: row.pulls_total, missedFirst: row.missed_first === 1, missedLast: row.missed_last === 1 },
      };
    }).sort((a, b) => a.name.localeCompare(b.name) || a.playerId.localeCompare(b.playerId));
    const unmatched = findUnmatched(presenceByRaid.get(raid.id) || [], characterKeys, guestKeysFor(guests, raid.id)).map((entry) => ({ kind: 'unmatched', ...entry }));
    return { raid: { id: raid.id, raidOn: raid.raid_on, zone: raid.zone, openFlags: raid.open_flags, stale: staleIds.has(raid.id) }, items: [...people, ...unmatched] };
  });
  return jsonResponse({ team: { id: team.id, name: team.name }, raids, stale, lootUnmatched: lootUnmatchedGroups(guildContext, team.id, lootResult.results.filter(row => !guestKeysFor(guests, row.raid_id).has(presenceKey(row.name_key, row.realm_key)))) });
}

// The loot winners nobody matches, newest raid first: [{ raid: { id, raidOn, zone }, items: [{ kind: 'unmatched', key, name, realm, class, awards }] }].
// The same item shape as a raid's unmatched log names, so the same Link / Add as new person / Mark as guest dialogs act on them.
function lootUnmatchedGroups(guildContext, teamId, rows) {
  if (!allows(guildContext.can, 'loot.edit', teamId)) return [];
  return [...groupBy(rows, 'raid_id').values()]
    .map((group) => ({
      raid: { id: group[0].raid_id, raidOn: group[0].raid_on, zone: group[0].zone },
      items: group
        .map((row) => ({ kind: 'unmatched', key: presenceKey(row.name_key, row.realm_key), name: row.name, realm: row.realm, class: row.class, awards: row.awards }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => (a.raid.raidOn < b.raid.raidOn ? 1 : a.raid.raidOn > b.raid.raidOn ? -1 : a.raid.id.localeCompare(b.raid.id)))
    .slice(0, REVIEW_RAIDS);
}

// ---------------------------------------------------------------------------
// Decisions

const FIXED_CREDIT = { present: 1, bench: 1, missed: 0, missed_notice: 0 };
const OVERRIDE_OUTCOMES = ['present', 'bench', 'missed', 'missed_notice'];
const decisionInvalid = (message, field) => new HttpError(400, 'decision_invalid', message, { field });

// The outcomes the row's flags allow as a decision.
function allowedOutcomes(flags) {
  if (flags.includes('no_show')) return ['missed', 'missed_notice', 'bench', 'present'];
  const late = flags.includes('late');
  const left = flags.includes('left_early');
  if (late || left) return ['present', late && left ? 'late_left' : (late ? 'late' : 'left_early')];
  return OVERRIDE_OUTCOMES;
}

export async function postDecision(ctx) {
  const { body, db } = ctx;
  if (!isId('p', body.playerId)) throw bad('Pick a person.', 'playerId');
  const reason = cleanText(body.reason, 'reason', { min: 3, max: 200 });
  if (typeof body.outcome !== 'string') throw decisionInvalid('Pick an outcome.', 'outcome');
  if (!Array.isArray(body.expectedFlags) || body.expectedFlags.some((flag) => typeof flag !== 'string')) throw bad('Send the flags you last saw.', 'expectedFlags');
  if (body.creditId !== undefined && body.creditId !== null && typeof body.creditId !== 'string') throw decisionInvalid('Pick a credit.', 'creditId');
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'attendance.review', raid.team_id)) throw forbidden();
  const [rowResult, policyResult] = await db.batch([
    db.prepare('SELECT * FROM attendance WHERE raid_id = ? AND player_id = ? AND guild_id = ?').bind(raid.id, body.playerId, guild.id),
    policyRowsStatement(db, guild.id),
  ]);
  const row = rowResult.results[0];
  if (!row) throw new HttpError(404, 'not_found', 'That person has no attendance on this raid.');
  const flags = parseFlags(row.flags);
  if (JSON.stringify([...body.expectedFlags].sort()) !== JSON.stringify([...flags].sort())) {
    throw new HttpError(409, 'flags_changed', 'The flags on this row changed. Reload and decide again.', { flags });
  }
  const allowedForRow = allowedOutcomes(flags);
  if (!allowedForRow.includes(body.outcome)) throw decisionInvalid('That outcome is not allowed for this row.', 'outcome');
  let credit;
  let creditId = null;
  if (Object.prototype.hasOwnProperty.call(FIXED_CREDIT, body.outcome)) {
    if (body.creditId !== undefined && body.creditId !== null) throw decisionInvalid('That outcome has a fixed credit.', 'creditId');
    credit = FIXED_CREDIT[body.outcome];
  } else {
    const values = makePolicyResolver(guild, policyResult.results).resolved(raid.team_id).credit.values;
    const entry = values.find((candidate) => candidate.id === body.creditId);
    if (!entry) throw decisionInvalid('Pick one of the credit values.', 'creditId');
    credit = entry.value;
    creditId = entry.id;
  }
  const now = ctx.now();
  const results = await db.batch([
    // The decision is input: its own row, answering the flags the row had; a recompute never touches it.
    db.prepare(
      `INSERT INTO attendance_decisions (raid_id, player_id, guild_id, outcome, credit, credit_id, reason, flags, decided_by, decided_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM attendance WHERE raid_id = ? AND player_id = ? AND guild_id = ? AND flags = ?)
       ON CONFLICT (raid_id, player_id) DO UPDATE SET outcome = excluded.outcome, credit = excluded.credit, credit_id = excluded.credit_id,
              reason = excluded.reason, flags = excluded.flags, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
    ).bind(raid.id, row.player_id, guild.id, body.outcome, credit, creditId, reason, row.flags, ctx.session.user.id, now,
      raid.id, row.player_id, guild.id, row.flags),
    db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ? AND changes() = 1").bind(raid.id, guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'attendance.decide', entityType: 'raid', entityId: raid.id,
      before: { playerId: row.player_id, outcome: row.outcome, flags },
      after: { playerId: row.player_id, outcome: body.outcome, creditId, credit, reason },
    }, CHANGED_ONE),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(409, 'flags_changed', 'The flags on this row changed. Reload and decide again.', { flags });
  return recomputeAndReply(ctx, guildContext, raid.id);
}

export async function deleteDecision(ctx) {
  const { body, db } = ctx;
  const reason = cleanText(body.reason, 'reason', { min: 3, max: 200 });
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'attendance.review', raid.team_id)) throw forbidden();
  const results = await db.batch([
    db.prepare('DELETE FROM attendance_decisions WHERE raid_id = ? AND player_id = ? AND guild_id = ?').bind(raid.id, ctx.params.pid, guild.id),
    db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ? AND changes() = 1").bind(raid.id, guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'attendance.undo', entityType: 'raid', entityId: raid.id,
      before: { playerId: ctx.params.pid }, after: { playerId: ctx.params.pid, reason },
    }, CHANGED_ONE),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(404, 'not_found', 'That person has no decision on this raid.');
  return recomputeAndReply(ctx, guildContext, raid.id);
}

// ---------------------------------------------------------------------------
// Unmatched characters

export async function postUnmatched(ctx) {
  const { body, db } = ctx;
  if (typeof body.key !== 'string' || !/^[^|]{1,64}\|[^|]{0,64}$/.test(body.key)) throw bad('Pick a name from the log.', 'key');
  if (!['alt', 'person', 'guest'].includes(body.action)) throw bad('Pick alt, person or guest.', 'action');
  if (body.action === 'alt' && !isId('p', body.personId)) throw bad('Pick the person this character belongs to.', 'personId');
  if (body.action === 'alt' && body.makeMain !== undefined && typeof body.makeMain !== 'boolean') throw bad('makeMain must be true or false.', 'makeMain');
  if (body.action === 'person' && body.status !== undefined && !CREATE_STATUSES.includes(body.status)) throw bad('Pick raider, trial or reserve.', 'status');
  // A class sent with the decision stands in for a name whose log row and loot row both lack one (a loot-only winner). A class the log or
  // the loot knows wins over it.
  if (body.class !== undefined && body.class !== null && !(typeof body.class === 'string' && CLASS_IDS.includes(body.class))) throw bad('Pick one of the nine classes.', 'class');
  if (body.action === 'person' && body.joinedOn !== undefined && body.joinedOn !== null && !isRealDate(body.joinedOn)) throw bad('Joined needs a date.', 'joinedOn');
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext);
  if (!allows(guildContext.can, 'attendance.review', raid.team_id)) throw forbidden();
  const [keyName, keyRealm] = body.key.split('|');
  // The name is in the raid's log (presence) or among its loot winners; a row that knows the class wins.
  const presence = await db.prepare(
    `SELECT name, realm, class FROM (
       SELECT name, realm, class, 0 AS source FROM raid_presence WHERE raid_id = ?1 AND guild_id = ?2 AND name_key = ?3 AND realm_key = ?4
       UNION ALL
       SELECT winner_name, winner_realm, winner_class, 1 FROM loot_awards WHERE raid_id = ?1 AND guild_id = ?2 AND winner_name_key = ?3 AND winner_realm_key = ?4
       UNION ALL
       SELECT name, realm, NULL, 2 FROM raid_manual_names WHERE raid_id = ?1 AND guild_id = ?2 AND name_key = ?3 AND realm_key = ?4)
     ORDER BY (class IS NULL), source LIMIT 1`,
  ).bind(raid.id, guild.id, keyName, keyRealm).first();
  if (!presence) throw new HttpError(404, 'not_found', 'That name is not in this raid\'s log or loot.');
  const characterClass = presence.class || body.class || null;
  const now = ctx.now();
  const statements = [];
  let mainIndex = -1;
  const stale = markRaidsStale(db, guild.id, [keyName], raid.id, body.action === 'guest' ? [] : [raid.team_id]);

  if (body.action === 'guest') {
    statements.push(
      db.prepare('INSERT INTO attendance_guests (guild_id, name_key, realm_key, name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(guild.id, keyName, keyRealm, presence.name, ctx.session.user.id, now),
      stale,
      auditStatement(ctx, { guildId: guild.id, actorUserId: ctx.session.user.id, action: 'attendance.guest', entityType: 'raid', entityId: raid.id, after: { guest: true, nameKey: keyName } }),
      bumpRaidStatement(db, guild.id, raid.id),
    );
  } else if (body.action === 'person') {
    if (!allows(guildContext.can, 'roster.edit', raid.team_id)) throw forbidden();
    const team = await requireTarget(db, guild.id, raid.team_id, 'team');
    const name = cleanCharacterName(presence.name, guild.game_version);
    const realm = resolveRealm(guild, presence.realm);
    if (!name) throw bad('That name cannot be added as a character.', 'key');
    if (!characterClass) throw bad('Pick this character\'s class.', 'class');
    if (!realm) throw bad('That realm is not valid for this guild.', 'key');
    const status = body.status === undefined ? 'raider' : body.status;
    const joinedOn = body.joinedOn === undefined || body.joinedOn === null ? raid.raid_on : body.joinedOn;
    const owner = await findNameOwner(db, guild.id, nameKey(name), realm.key);
    if (owner) throw nameTaken(name, owner);
    const trialStart = status === 'trial' ? joinedOn : null;
    const playerId = newId('p', ctx.randomBytes);
    const characterId = newId('c', ctx.randomBytes);
    statements.push(
      db.prepare(
        `INSERT INTO players (id, guild_id, status, joined_on, trial_start, trial_end, discord_user_id, version, notes_version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, 0, ?, ?, ?)`,
      ).bind(playerId, guild.id, status, joinedOn, trialStart, ctx.session.user.id, now, now),
      stale,
      insertCharacter(db, guild.id, {
        id: characterId, playerId, teamId: team.id, name, realm: realm.realm, realmKey: realm.key, class: characterClass,
        mainSpec: null, offSpec: null, isMain: true, rank: characterRankColumns({ status, trialStart }),
      }, now),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'person.create', entityType: 'person', entityId: playerId,
        after: {
          status, joinedOn, trialStart, trialEnd: null, version: 1, linked: false, characterId, teamId: team.id, class: characterClass,
          mainSpec: null, offSpec: null, via: 'attendance',
        },
      }),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'attendance.link', entityType: 'raid', entityId: raid.id,
        after: { personId: playerId, characterId, teamId: team.id },
      }),
      bumpRaidStatement(db, guild.id, raid.id),
    );
  } else {
    if (!allows(guildContext.can, 'roster.edit', raid.team_id)) throw forbidden();
    const team = await requireTarget(db, guild.id, raid.team_id, 'team');
    const home = await db.prepare(
      `SELECT m.team_id, m.id AS main_id FROM players p JOIN characters m ON m.player_id = p.id AND m.is_main = 1 WHERE p.id = ? AND p.guild_id = ?`,
    ).bind(body.personId, guild.id).first();
    if (!home) throw new HttpError(404, 'not_found', 'That person was not found.');
    if (!allows(guildContext.can, 'roster.edit', home.team_id)) throw forbidden();
    // A new alt starts on no team (U R3-Q1/R4-Q1); only a new Main takes the raid's team, and another character on it refuses the request.
    if (body.makeMain === true) {
      // A new Main swaps the person's Main: the Seniority guard (worker/seniority.js) applies, here and inside the swap.
      await assertSenior(db, guildContext, body.personId);
      const taken = await db.prepare('SELECT 1 AS x FROM characters WHERE guild_id = ? AND player_id = ? AND team_id = ? AND id != ? LIMIT 1').bind(guild.id, body.personId, team.id, home.main_id).first();
      if (taken) throw new HttpError(409, 'team_taken', 'That person already has a character on the raid team.', { field: 'personId' });
    }
    const name = cleanCharacterName(presence.name, guild.game_version);
    const realm = resolveRealm(guild, presence.realm);
    if (!name) throw bad('That name cannot be added as a character.', 'key');
    if (!characterClass) throw bad('Pick this character\'s class.', 'class');
    if (!realm) throw bad('That realm is not valid for this guild.', 'key');
    const characterId = newId('c', ctx.randomBytes);
    statements.push(
      insertCharacter(db, guild.id, {
        id: characterId, playerId: body.personId, teamId: null, name, realm: realm.realm, realmKey: realm.key, class: characterClass,
        mainSpec: null, offSpec: null, isMain: false,
      }, now),
      stale,
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'character.create', entityType: 'character', entityId: characterId,
        after: { personId: body.personId, teamId: team.id, class: characterClass, makeMain: false, via: 'attendance' },
      }),
      auditStatement(ctx, {
        guildId: guild.id, actorUserId: ctx.session.user.id, action: 'attendance.link', entityType: 'raid', entityId: raid.id,
        after: { personId: body.personId, characterId, teamId: team.id },
      }),
      bumpRaidStatement(db, guild.id, raid.id),
    );
    if (body.makeMain === true) {
      const main = newMainStatements(db, {
        playerId: body.personId, characterId, previousMain: { id: home.main_id, team_id: home.team_id }, teamId: team.id, now,
        senior: seniorityOk(guild.id, ctx.session.user.id, body.personId),
      });
      mainIndex = statements.length + main.swapAt;
      statements.push(
        ...main.statements,
        auditStatement(ctx, {
          guildId: guild.id, actorUserId: ctx.session.user.id, action: 'character.main', entityType: 'character', entityId: characterId,
          before: { mainCharacterId: home.main_id }, after: { mainCharacterId: characterId },
        }),
        // The trial dates sit on the Main character: they move with it.
        ...trialDatesFollowMainStatements(db, home.main_id, characterId),
      );
    }
  }
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    const kind = constraintOf(error);
    if (LIMIT_KINDS.includes(kind)) throw limitError(kind);
    if (kind === 'character_name') throw nameTaken(cleanCharacterName(presence.name, guild.game_version) || presence.name, null);
    if (kind === 'foreign_key') throw new HttpError(404, 'not_found', 'That person no longer exists.');
    if (kind === 'team_taken') throw new HttpError(409, 'team_taken', 'That person already has a character on the raid team.', { field: 'personId' });
    throw error;
  }
  if (mainIndex >= 0 && results[mainIndex].meta.changes !== 1) throw new HttpError(409, 'conflict', 'The Main could not be changed. Reload and try again.');
  const staleRaids = results[1].meta.changes;
  await recomputeRaid(ctx, guild, raid.id);
  const detail = await loadRaidDetail(ctx, guildContext, raid.id);
  return jsonResponse({ raid: detail, staleRaids, attendanceFlags: detail.attendanceFlags });
}

// ---------------------------------------------------------------------------
// Team page and person history

const metricsOf = (result, personId) => (result && result.people && result.people[personId]) || null;

// The window to show for one team's policy. `lenient` (the person view, which spans teams with different switch lists): a whole
// number that this team does not offer falls back to the team's default window instead of a 400; anything else is still a 400.
function readWindow(params, policy, { lenient = false } = {}) {
  const raw = params.get('window');
  if (raw === null || raw === '') return policy.window.defaultWeeks;
  if (raw === 'all') return 'all';
  const number = Number(raw);
  if (!Number.isInteger(number) || number < 1) throw bad('Pick one of the offered windows.', 'window');
  if (policy.window.switchWeeks.includes(number)) return number;
  if (lenient) return policy.window.defaultWeeks;
  throw bad('Pick one of the offered windows.', 'window');
}

export const windowStartFor = (today, resetDay, weeks) => (weeks === 'all' ? null : addDays(weekStart(today, resetDay), -7 * (weeks - 1)));

// A raid counts toward the sign-up rate only when it has a sign-up source and results (an "awaiting log" raid has no rows to count).
export const metricsRaid = (row) => ({
  id: row.id,
  raidOn: row.raid_on,
  zone: row.zone,
  hasSignups: (row.event_synced !== null || row.plan_synced !== null) && raidState(row, row.reports) !== 'awaiting_log',
});
export const metricsRow = (row, hostTeamOf = new Map()) => ({
  raidId: row.raid_id, playerId: row.player_id, outcome: row.outcome, credit: row.credit, signupKind: row.signup_kind, attended: row.attended,
  viaRaidId: row.via_raid_id, viaTeamId: row.via_raid_id ? hostTeamOf.get(row.via_raid_id) || null : null,
});

export async function getTeamAttendance(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const params = new URL(ctx.request.url).searchParams;
  const team = await requireTeam(ctx.db, guild.id, params.get('team'));
  // User decision 2026-10-21: the team page is for the roles that review attendance; everyone else reads their own record (getPersonAttendance).
  if (!allows(guildContext.can, 'attendance.review', team.id)) throw forbidden('The team attendance page is for the officers and team leads of this team.');
  const includeWatch = true;
  return jsonResponse(await teamAttendanceData(ctx.db, guild, team, params, ctx.now(), viewerOf(ctx), { includeWatch }));
}

// The team page's data: one team's weeks, people and metrics over the window in `params` (?window=). viewer: { userId, discordId } marks the viewer's own row
// (isMe); null for someone with no account (a guest link, the public page). Callers check attendance.view for the team first.
// options.includeWatch: add the Watch list (the caller has checked attendance.review on the team); off by default.
// options.rosterOnly: list only the people on the team's roster, each with rosterRank (the public page, guest links and API keys); off by default.
export async function teamAttendanceData(db, guild, team, params, nowMs, viewer, options = {}) {
  const bind = (sql) => db.prepare(sql).bind(guild.id, team.id);
  const [policyResult, raidResult, rowResult, borrowedResult, peopleResult, characterResult, teamResult, hostResult, dismissalResult, reviewedResult] = await db.batch([
    policyRowsStatement(db, guild.id),
    bind(`SELECT id, raid_on, zone, event_synced, plan_synced, open_flags, policy_fp, log_mode, team_id,
                 (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = raids.id) AS reports
            FROM raids WHERE guild_id = ?1 AND team_id = ?2 ORDER BY raid_on, id`),
    bind(`SELECT raid_id, player_id, outcome, credit, signup_kind, attended, needs_review, via_raid_id, flags FROM attendance WHERE guild_id = ?1 AND team_id = ?2`),
    bind(`SELECT a.raid_id, a.player_id, r.raid_on, r.team_id AS host_team_id FROM attendance a JOIN raids r ON r.id = a.raid_id
           WHERE a.guild_id = ?1 AND a.credit_team_id = ?2 AND a.credit = 1 AND a.outcome = 'fill_in'`),
    bind(`SELECT p.id, p.joined_on, p.discord_user_id, p.user_id, p.rank, p.rank_on FROM players p WHERE p.guild_id = ?1
             AND (p.id IN (SELECT player_id FROM characters WHERE team_id = ?2) OR p.id IN (SELECT player_id FROM attendance WHERE team_id = ?2))`),
    bind(`SELECT id, player_id, name, class, team_id, is_main, core_rank, left_on FROM characters WHERE guild_id = ?1
             AND (player_id IN (SELECT player_id FROM characters WHERE team_id = ?2) OR player_id IN (SELECT player_id FROM attendance WHERE team_id = ?2))`),
    db.prepare('SELECT id, name FROM teams WHERE guild_id = ?').bind(guild.id),
    bind(`SELECT id, team_id FROM raids WHERE guild_id = ?1 AND id IN (SELECT via_raid_id FROM attendance WHERE guild_id = ?1 AND team_id = ?2 AND via_raid_id IS NOT NULL)`),
    // PM wave 7: the rank suggestions an officer dismissed for 30 days (only the ones still hidden).
    db.prepare('SELECT player_id, kind, to_rank, until FROM rank_dismissals WHERE guild_id = ? AND until > ?').bind(guild.id, nowMs),
    // Home redesign: the watch entries an officer marked Reviewed (shared; only read for viewers who get the watch list).
    ...(options.includeWatch ? [db.prepare(
      `SELECT d.item_id, d.kind, d.mode, d.until, d.fingerprint, d.created_at, COALESCE(u.display_name, u.global_name, u.username) AS by_name
         FROM attention_dismissals d LEFT JOIN users u ON u.id = d.dismissed_by WHERE d.guild_id = ?1 AND d.team_id = ?2 AND d.kind = 'watch'`,
    ).bind(guild.id, team.id)] : []),
  ]);
  const teamNames = new Map(teamResult.results.map((row) => [row.id, row.name]));
  const hostTeamOf = new Map(hostResult.results.map((row) => [row.id, row.team_id]));
  const viaOf = (value) => (typeof value === 'string' && teamNames.has(value) ? { id: value, name: teamNames.get(value) } : null);
  const resolver = makePolicyResolver(guild, policyResult.results);
  const policy = resolver.resolved(team.id);
  const resetDay = resolver.resetDay();
  const today = guildToday(guild, nowMs);
  const weeks = readWindow(params, policy);
  const windowStart = windowStartFor(today, resetDay, weeks);
  const inWindow = (date) => (windowStart === null || date >= windowStart) && date <= today;

  const raids = raidResult.results;
  const charactersByPlayer = groupBy(characterResult.results, 'player_id');
  // The person's status and left date come from their characters (the main's rank), not from the players row (lane B2).
  for (const row of peopleResult.results) Object.assign(row, personColumnsOf((charactersByPlayer.get(row.id) || []).map(characterOfRow)));
  const metrics = teamMetrics({
    people: peopleResult.results.map((row) => ({ id: row.id, status: row.status, joinedOn: row.joined_on, leftOn: row.left_on })),
    raids: raids.map(metricsRaid),
    rows: rowResult.results.map((row) => metricsRow(row, hostTeamOf)),
    borrowed: borrowedResult.results.map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id })),
    policy, today, resetDay, windowWeeks: weeks,
  });
  // The rank ladder (PM wave 7): each person's rank, and for viewers who review attendance the suggestions (promote / review) not dismissed.
  const ladder = ladderOf(policy);
  // The home team of a person is their Main's (worker/person-rank.js), the one rule attendance uses for the ladder and the Other-team credit.
  const mainTeamOf = (playerId) => homeTeamId({ characters: (charactersByPlayer.get(playerId) || []).map(characterOfRow) });
  const review = ladder.length ? rankReview({
    ladder, policy, today, resetDay, nowMs, teamId: team.id, homeTeamOf: mainTeamOf, metrics,
    people: peopleResult.results.map((row) => ({ id: row.id, status: row.status, joinedOn: row.joined_on, leftOn: row.left_on, rank: row.rank, rankOn: row.rank_on })),
    raids: raids.map(metricsRaid),
    rows: rowResult.results.map((row) => metricsRow(row, hostTeamOf)),
    borrowed: borrowedResult.results.map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id })),
    dismissals: new Map(dismissalResult.results.map((row) => [row.player_id, row])),
  }) : null;
  // The previous window of the same length (what the watch list compares against), for the People view's change column; reviewers only, never for 'all'.
  const previousMetrics = options.includeWatch && weeks !== 'all' && metrics.windowStart ? teamMetrics({
    people: peopleResult.results.map((row) => ({ id: row.id, status: row.status, joinedOn: row.joined_on, leftOn: row.left_on })),
    raids: raids.map(metricsRaid),
    rows: rowResult.results.map((row) => metricsRow(row, hostTeamOf)),
    borrowed: borrowedResult.results.map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id })),
    policy, today: addDays(metrics.windowStart, -1), resetDay, windowWeeks: weeks,
  }) : null;
  // options.rosterOnly (the public page, guest links and API keys): only the people on this team's roster (worker/team-roster.js), each with the core rank of
  // their roster character as rosterRank. A Social or Former character, or a person who only has attendance rows here, is left out.
  const rosterRankOf = new Map();
  if (options.rosterOnly) {
    for (const row of [...characterResult.results].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (row.team_id === team.id && isTeamRosterRow(row) && !rosterRankOf.has(row.player_id)) rosterRankOf.set(row.player_id, row.core_rank);
    }
  }
  const everyone = peopleResult.results.map((row) => {
    const character = displayCharacter(charactersByPlayer.get(row.id) || [], team.id);
    const mine = metricsOf(metrics, row.id) || {};
    const ranked = review ? review.get(row.id) : null;
    const cells = Array.isArray(mine.cells) ? mine.cells.filter((cell) => inWindow(cell.date)).map((cell) => ({ ...cell, via: viaOf(cell.via) })) : [];
    const before = previousMetrics && previousMetrics.people[row.id];
    return {
      ...mine,
      ...(previousMetrics ? { previousPct: before && before.counted >= WATCH_MIN_PREVIOUS ? before.pct : null } : {}),
      cells,
      id: row.id,
      name: character ? character.name : 'Unknown',
      class: character ? character.class : null,
      status: row.status,
      isMe: viewer ? isOwnPlayer(row, viewer) : false,
      ...(ranked ? { rank: { id: ranked.rank.id, name: ranked.rank.name, set: ranked.rank.set }, ...(options.includeWatch && ranked.suggestion ? { rankSuggestion: ranked.suggestion } : {}) } : {}),
      ...(options.rosterOnly ? { rosterRank: rosterRankOf.get(row.id) || null } : {}),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const people = options.rosterOnly ? everyone.filter((person) => person.rosterRank !== null) : everyone;

  const weekMap = new Map();
  for (const raid of raids) {
    if (!inWindow(raid.raid_on)) continue;
    const start = weekStart(raid.raid_on, resetDay);
    if (!weekMap.has(start)) weekMap.set(start, []);
    weekMap.get(start).push({ id: raid.id, raidOn: raid.raid_on, zone: raid.zone });
  }
  // The Watch list (PM wave 1) is for viewers with attendance.review on this team: the caller decides (options.includeWatch). The guest link and the
  // public page never ask for it, so the fail-closed default keeps it out of their view.
  const watch = options.includeWatch
    ? watchView(watchList({
      people: peopleResult.results.map((row) => ({ id: row.id, status: row.status, joinedOn: row.joined_on, leftOn: row.left_on })),
      raids: raids.map(metricsRaid),
      rows: rowResult.results.map((row) => metricsRow(row, hostTeamOf)),
      borrowed: borrowedResult.results.map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id })),
      policy, today, resetDay, windowWeeks: weeks,
    }), people, team.id, reviewedResult ? reviewedResult.results : [], nowMs)
    : null;
  return {
    team: { id: team.id, name: team.name },
    today,
    window: weeks,
    policy: { switchWeeks: policy.window.switchWeeks, defaultWeeks: policy.window.defaultWeeks, streakFlagAt: policy.streakFlagAt, creditValues: policy.credit.values },
    weeks: [...weekMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([start, list]) => ({ weekStart: start, raids: list })),
    people,
    awaitingReview: raids.filter((raid) => raid.open_flags > 0).length,
    staleRaids: raids.filter((raid) => isStale(raidState(raid, raid.reports, resolver))).length,
    watch,
    ladder: ladder.map((rank) => ({ id: rank.id, name: rank.name })),
  };
}

// The watch list as the team page draws it: the entries get their name, class and status. null while the policy has both thresholds off
// (the page shows no card); an empty list when it is on and nobody qualifies.
// Each entry also carries latestMissedRaidId, itemId (the Needs attention id, for the Reviewed route) and reviewed: { by: { name }, at } | null (a
// Reviewed mark that still holds: the % is above the reviewed % - 5 points and no newer raid was missed; otherwise the entry is open again).
function watchView(list, people, teamId, reviewedRows, nowMs) {
  if (list.below === null && list.dropBy === null) return null;
  const byId = new Map(people.map((person) => [person.id, person]));
  const reviewedBy = new Map(reviewedRows.map((row) => [row.item_id, row]));
  return {
    below: list.below,
    dropBy: list.dropBy,
    window: list.windowWeeks,
    previousFrom: list.previousFrom,
    entries: list.entries.map((entry) => {
      const person = byId.get(entry.playerId) || {};
      const itemId = `watch:${teamId}:${entry.playerId}`;
      const row = reviewedBy.get(itemId);
      const holds = !!row && (row.until === null || row.until > nowMs) && watchStaysReviewed(row.fingerprint, entry.pct, entry.latestMissedRaidId);
      return {
        ...entry, name: person.name || 'Unknown', class: person.class || null, status: person.status || null, itemId,
        reviewed: holds ? { by: { name: row.by_name || 'Former member' }, at: row.created_at } : null,
      };
    }),
  };
}


// A stored decision answers a row only while the row still has the flags it was made against.
const decisionApplies = (decision, row) => !!decision && !!row
  && JSON.stringify([...parseFlags(decision.flags)].sort()) === JSON.stringify([...parseFlags(row.flags)].sort());

export async function getPersonAttendance(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const params = new URL(ctx.request.url).searchParams;
  const personId = ctx.params.pid;
  const bind = (sql) => ctx.db.prepare(sql).bind(guild.id, personId);
  const [policyResult, playerResult, characterResult, rowResult, raidResult, borrowedResult, teamResult, hostResult, decisionResult, dismissalResult] = await ctx.db.batch([
    policyRowsStatement(ctx.db, guild.id),
    bind('SELECT id, joined_on, discord_user_id, user_id, rank, rank_on FROM players WHERE guild_id = ?1 AND id = ?2'),
    bind('SELECT id, player_id, name, class, team_id, is_main, core_rank, left_on FROM characters WHERE guild_id = ?1 AND player_id = ?2'),
    bind('SELECT * FROM attendance WHERE guild_id = ?1 AND player_id = ?2'),
    bind(`SELECT id, raid_on, zone, event_synced, plan_synced, open_flags, policy_fp, log_mode, team_id,
                 (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = raids.id) AS reports
            FROM raids WHERE guild_id = ?1 AND team_id IN
              (SELECT team_id FROM characters WHERE player_id = ?2 UNION SELECT team_id FROM attendance WHERE player_id = ?2)
           ORDER BY raid_on, id`),
    bind(`SELECT a.raid_id, a.player_id, r.raid_on, r.team_id AS host_team_id, a.credit_team_id FROM attendance a JOIN raids r ON r.id = a.raid_id
           WHERE a.guild_id = ?1 AND a.player_id = ?2 AND a.credit_team_id IS NOT NULL AND a.credit = 1 AND a.outcome = 'fill_in'`),
    ctx.db.prepare('SELECT id, name FROM teams WHERE guild_id = ?').bind(guild.id),
    bind(`SELECT id, team_id FROM raids WHERE guild_id = ?1 AND id IN (SELECT via_raid_id FROM attendance WHERE player_id = ?2 AND via_raid_id IS NOT NULL)`),
    bind('SELECT raid_id, reason, flags FROM attendance_decisions WHERE guild_id = ?1 AND player_id = ?2'),
    // PM wave 7: a rank suggestion dismissed for 30 days.
    ctx.db.prepare('SELECT player_id, kind, to_rank, until FROM rank_dismissals WHERE guild_id = ? AND player_id = ? AND until > ?').bind(guild.id, personId, ctx.now()),
  ]);
  const decisionByRaid = new Map(decisionResult.results.map((row) => [row.raid_id, row]));
  const player = playerResult.results[0];
  if (!player) throw new HttpError(404, 'not_found', 'That person was not found.');
  Object.assign(player, personColumnsOf(characterResult.results.map(characterOfRow)));
  const resolver = makePolicyResolver(guild, policyResult.results);
  const resetDay = resolver.resetDay();
  const today = guildToday(guild, ctx.now());
  const teamNames = new Map(teamResult.results.map((team) => [team.id, team.name]));
  const hostTeamOf = new Map(hostResult.results.map((row) => [row.id, row.team_id]));
  // A teamless character (team_id NULL) is on no team: it adds no team page.
  const teamIds = new Set([...characterResult.results.map((row) => row.team_id), ...raidResult.results.map((row) => row.team_id)].filter(Boolean));
  const visible = [...teamIds].filter((teamId) => allows(guildContext.can, 'attendance.view', teamId)).sort((a, b) => (teamNames.get(a) || '').localeCompare(teamNames.get(b) || ''));
  if (!visible.length) throw forbidden();
  const home = displayCharacter(characterResult.results, null);

  const teams = visible.map((teamId) => {
    const policy = resolver.resolved(teamId);
    const weeks = readWindow(params, policy, { lenient: true });
    const windowStart = windowStartFor(today, resetDay, weeks);
    const raids = raidResult.results.filter((raid) => raid.team_id === teamId);
    const raidById = new Map(raids.map((raid) => [raid.id, raid]));
    const rows = rowResult.results.filter((row) => row.team_id === teamId);
    const rowByRaid = new Map(rows.map((row) => [row.raid_id, row]));
    const borrowed = borrowedResult.results.filter((row) => row.credit_team_id === teamId)
      .map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id }));
    const metrics = metricsOf(teamMetrics({
      people: [{ id: player.id, status: player.status, joinedOn: player.joined_on, leftOn: player.left_on }],
      raids: raids.map(metricsRaid),
      rows: rows.map((row) => metricsRow(row, hostTeamOf)),
      borrowed, policy, today, resetDay, windowWeeks: weeks,
    }), player.id) || {};
    const canReview = allows(guildContext.can, 'attendance.review', teamId);
    // The rank ladder (PM wave 7): judged on the team of the person's Main, shown to whoever may review this team.
    const ladder = ladderOf(policy);
    const mainTeamId = (characterResult.results.find((row) => row.is_main === 1) || {}).team_id || null;
    const ranked = ladder.length ? rankReview({
      ladder, policy, today, resetDay, nowMs: ctx.now(), teamId, homeTeamOf: () => mainTeamId,
      people: [{ id: player.id, status: player.status, joinedOn: player.joined_on, leftOn: player.left_on, rank: player.rank, rankOn: player.rank_on }],
      raids: raids.map(metricsRaid), rows: rows.map((row) => metricsRow(row, hostTeamOf)), borrowed,
      dismissals: new Map(dismissalResult.results.map((row) => [row.player_id, row])),
    }).get(player.id) : null;
    const cells = (Array.isArray(metrics.cells) ? metrics.cells : [])
      .filter((cell) => (windowStart === null || cell.date >= windowStart) && cell.date <= today)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((cell) => {
        const raid = raidById.get(cell.raidId);
        const row = rowByRaid.get(cell.raidId);
        const viaTeam = row && row.via_raid_id ? hostTeamOf.get(row.via_raid_id) : (typeof cell.via === 'string' ? cell.via : null);
        return {
          raid: { id: cell.raidId, raidOn: cell.date, zone: raid ? raid.zone : null },
          outcome: cell.outcome,
          letter: cell.letter,
          weekStart: cell.weekStart,
          credit: cell.credit,
          pending: !!cell.pending,
          preStart: !!cell.preStart,
          via: viaTeam ? { id: viaTeam, name: teamNames.get(viaTeam) || null } : null,
          reason: canReview && decisionApplies(decisionByRaid.get(cell.raidId), row) ? decisionByRaid.get(cell.raidId).reason : null,
        };
      });
    const { cells: _unused, ...summary } = metrics;
    return {
      team: { id: teamId, name: teamNames.get(teamId) || null }, window: weeks, metrics: summary, cells,
      ...(ranked && canReview && ranked.suggestion ? { rankSuggestion: ranked.suggestion } : {}),
    };
  });
  // The person's rank (null while the guild has no ladder), and the team an officer sets it from (a team they review, the Main's team first).
  const ladderRanks = ladderOf(resolver.resolved(null));
  const currentRank = ladderRanks.length ? (ladderRanks.find((rank) => rank.id === player.rank) || ladderRanks[0]) : null;
  const mainTeam = (characterResult.results.find((row) => row.is_main === 1) || {}).team_id || null;
  const rankTeams = [mainTeam, ...visible].filter((teamId, i, all) => teamId && all.indexOf(teamId) === i && allows(guildContext.can, 'attendance.review', teamId));
  return jsonResponse({
    person: {
      id: player.id, name: home ? home.name : 'Unknown', class: home ? home.class : null, status: player.status, joinedOn: player.joined_on,
      isMe: isOwnPlayer(player, viewerOf(ctx)),
      ...(currentRank ? {
        rank: { id: currentRank.id, name: currentRank.name, set: ladderRanks.some((rank) => rank.id === player.rank), on: player.rank_on || null },
        rankChoices: ladderRanks.map((rank) => ({ id: rank.id, name: rank.name })),
        rankTeamId: rankTeams[0] || null,
      } : {}),
    },
    teams,
  });
}

// ---------------------------------------------------------------------------
// Backfill list

export async function getBackfillReports(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const params = new URL(ctx.request.url).searchParams;
  const team = await requireTeam(db, guild.id, params.get('team'));
  if (!allows(guildContext.can, 'raids.edit', team.id)) throw forbidden();
  const page = params.get('page') === null ? 1 : Number(params.get('page'));
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw bad('page is a number from 1.', 'page');
  const flavour = DEFAULT_WCL_FLAVOUR[guild.game_version];
  const unknown = (message) => new HttpError(409, 'wcl_guild_unknown', message);
  if (!flavour) throw unknown('Backfill needs a Warcraft Logs site; this ruleset has none.');
  let guildRef;
  if (guild.wcl_guild_id) guildRef = { id: guild.wcl_guild_id };
  else if (guild.realm_kind === 'realm' && guild.realm_slug) guildRef = { name: guild.name, serverSlug: guild.realm_slug, serverRegion: guild.region };
  else throw unknown('Enter the Warcraft Logs guild ID in the attendance settings first.');
  requireWclConfigured(ctx.env);
  await raidFetchRate(ctx, { wcl: true });
  const listing = await listWclReports(ctx, flavour, guildRef, page);
  const codes = listing.reports.map((report) => report.code);
  const added = await db.prepare('SELECT code, raid_id FROM raid_reports WHERE guild_id = ? AND code IN (SELECT value FROM json_each(?))').bind(guild.id, JSON.stringify(codes)).all();
  const addedBy = new Map(added.results.map((row) => [row.code, row.raid_id]));
  let uploaders = [];
  try { uploaders = JSON.parse(team.wcl_uploaders).map((name) => String(name).toLowerCase()); } catch { uploaders = []; }
  return jsonResponse({
    reports: listing.reports.map((report) => ({
      code: report.code,
      flavour,
      title: report.title,
      zone: report.zone,
      owner: report.owner,
      startTime: report.startTime,
      raidOn: localDate(report.startTime, guild.time_zone),
      alreadyAdded: addedBy.get(report.code) || null,
      matchesUploader: uploaders.length === 0 || (!!report.owner && uploaders.includes(report.owner.toLowerCase())),
    })),
    hasMore: listing.hasMore,
  });
}
