// The Planner plan of a guild raid, stored whole (migration 0027, worker/plan-doc.js). Officers who may edit the raid's team read and write it;
// the autosaving Planner PUTs the whole plan with the revision it started from (a stale one loses with 409 and gets the current plan back) and
// polls with `?since=<rev>`. A write that changes who sits where also rewrites the old projection (raid_plan, plan_label, plan_synced) the raid
// page, the Raids list and attendance read. tasks/open/guild-plans-db-plan.md sections 2 and 3.
import { HttpError, jsonResponse } from '../http.js';
import { recomputeRaid } from '../attendance-store.js';
import { base64url } from '../ids.js';
import { loadSurnameIndex } from '../name-resolve.js';
import { allows, loadGuildContext } from '../permissions.js';
import {
  AUDIT_EDIT_WINDOW_MS, PLAN_DOC_MAX_CHARS, PLAN_DOC_SCHEMA, PLAN_SOURCES, lineupFp, planDocProblem, projectPlan,
} from '../plan-doc.js';
import { loadRaid, raidAudit } from './raids.js';
import { bad } from './roster.js';

const EVENT_ID = /^\d{6,25}$/; // a Raid-Helper event id (worker/sources.js)

const notFound = () => new HttpError(404, 'not_found', 'That raid does not exist.');
const userName = (row) => (row ? row.display_name || row.global_name || row.username || null : null);
const invalid = (field, message) => new HttpError(400, 'plan_invalid', message, { field });

// The fields of a stored document as the API words them (the plan itself is parsed from `data`).
function docFields(row) {
  return {
    rev: row.rev,
    plan: JSON.parse(row.data),
    schemaVersion: row.schema_ver,
    updatedAt: row.updated_at,
    updatedBy: userName(row) ? { name: userName(row) } : null,
  };
}

const DOC_SQL = `SELECT d.rev, d.data, d.schema_ver, d.updated_at, u.display_name, u.global_name, u.username
                   FROM raid_plan_doc d LEFT JOIN users u ON u.id = d.updated_by WHERE d.raid_id = ? AND d.guild_id = ?`;

// 409 plan_conflict: the plan as it stands now, so the writer can adopt it (a raid with no document yet answers rev 0 and plan null).
async function conflict(ctx, guildId, raidId) {
  const row = await ctx.db.prepare(DOC_SQL).bind(raidId, guildId).first();
  const stored = row ? docFields(row) : { rev: 0, plan: null, schemaVersion: PLAN_DOC_SCHEMA, updatedAt: null, updatedBy: null };
  return new HttpError(409, 'plan_conflict', 'Someone changed this plan since you opened it.', stored);
}

// GET /raids/:rid/plan-doc[?since=N]: the plan, or - with `since` equal to the current revision - just { rev, changed: false }, which is what the poll
// sends every few seconds. The poll is two statements: the guild context and one read that carries `data` only when the revision moved.
export async function getPlanDoc(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const sinceText = new URL(ctx.request.url).searchParams.get('since');
  const since = sinceText !== null && /^\d{1,12}$/.test(sinceText) ? Number(sinceText) : null;
  const row = await db.prepare(
    `SELECT r.team_id, r.plan_label, r.plan_synced, r.plan_live, d.rev, d.schema_ver, d.updated_at, u.display_name, u.global_name, u.username,
            CASE WHEN d.rev IS NULL OR d.rev = ? THEN NULL ELSE d.data END AS data
       FROM raids r LEFT JOIN raid_plan_doc d ON d.raid_id = r.id LEFT JOIN users u ON u.id = d.updated_by
      WHERE r.id = ? AND r.guild_id = ?`,
  ).bind(since === null ? -1 : since, ctx.params.rid, guildContext.guild.id).first();
  if (!row) throw notFound();
  if (!allows(guildContext.can, 'raids.edit', row.team_id)) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  const rev = row.rev === null ? 0 : row.rev;
  if (since !== null && since === rev) return jsonResponse({ rev, changed: false });
  if (row.rev !== null) {
    return jsonResponse({
      rev, changed: true, plan: JSON.parse(row.data), schemaVersion: row.schema_ver, updatedAt: row.updated_at,
      updatedBy: userName(row) ? { name: userName(row) } : null,
    });
  }
  // No document yet: what the raid page already knows (the legacy plan's names and groups, a pasted live link), so the Planner can seat them.
  let legacy = null;
  if (row.plan_synced !== null) {
    const names = await db.prepare('SELECT name, group_number FROM raid_plan WHERE raid_id = ? ORDER BY rowid').bind(ctx.params.rid).all();
    legacy = { label: row.plan_label, players: names.results.map((entry) => ({ name: entry.name, group: entry.group_number })) };
  }
  return jsonResponse({ rev: 0, changed: true, plan: null, legacy, live: row.plan_live });
}

// PUT /raids/:rid/plan-doc { baseRev, plan, schemaVersion?, source? }. Identical JSON is a no-op (no revision, no audit, no projection).
export async function putPlanDoc(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const guild = guildContext.guild;
  const body = ctx.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'Send { baseRev, plan }.');
  const { baseRev } = body;
  if (!Number.isInteger(baseRev) || baseRev < 0) throw invalid('baseRev', 'baseRev is the revision you started from (0 for a first save).');
  const schemaVersion = body.schemaVersion === undefined ? PLAN_DOC_SCHEMA : body.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > PLAN_DOC_SCHEMA) {
    throw invalid('schemaVersion', `This server reads plan schema ${PLAN_DOC_SCHEMA} or older. Reload the Planner.`);
  }
  const source = body.source === undefined ? 'planner' : body.source;
  if (!PLAN_SOURCES.includes(source)) throw invalid('source', `source is one of ${PLAN_SOURCES.join(', ')}.`);
  const found = planDocProblem(body.plan, { raidId: raid.id, gameVersion: guild.game_version });
  if (found) throw invalid(found.field, found.message);
  const plan = body.plan;
  const data = JSON.stringify(plan);
  if (data.length > PLAN_DOC_MAX_CHARS) throw new HttpError(413, 'too_large', 'The plan is too large to save to the raid.');

  const current = await db.prepare(
    'SELECT rev, data, lineup_fp, updated_at, audited_by, audited_at FROM raid_plan_doc WHERE raid_id = ? AND guild_id = ?',
  ).bind(raid.id, guild.id).first();
  if (current && current.data === data) return jsonResponse({ rev: current.rev, unchanged: true, updatedAt: current.updated_at });
  if (baseRev !== (current ? current.rev : 0)) throw await conflict(ctx, guild.id, raid.id);

  const now = ctx.now();
  const actor = ctx.session.user.id;
  const writeId = base64url(ctx.randomBytes(16));
  const fingerprint = lineupFp(plan);
  const first = !current;
  const projectionDue = first || current.lineup_fp !== fingerprint;
  const seatedCount = plan.groups.reduce((total, group) => total + group.length, 0);
  const auditFirst = first;
  const auditEdit = !first && !(current.audited_by === actor && current.audited_at !== null && now - current.audited_at < AUDIT_EDIT_WINDOW_MS);
  const audited = auditFirst || auditEdit;
  const wrote = { sql: 'EXISTS (SELECT 1 FROM raid_plan_doc WHERE raid_id = ? AND write_id = ?)', params: [raid.id, writeId] };

  const statements = [first
    ? db.prepare(
      `INSERT INTO raid_plan_doc (raid_id, guild_id, rev, write_id, schema_ver, game_version, data, lineup_fp, created_by, created_at, updated_by, updated_at, audited_by, audited_at)
       SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM raids WHERE id = ? AND guild_id = ?) AND NOT EXISTS (SELECT 1 FROM raid_plan_doc WHERE raid_id = ?)
       RETURNING rev`,
    ).bind(raid.id, guild.id, writeId, schemaVersion, guild.game_version, data, fingerprint, actor, now, actor, now, actor, now, raid.id, guild.id, raid.id)
    : db.prepare(
      `UPDATE raid_plan_doc SET rev = rev + 1, write_id = ?, schema_ver = ?, game_version = ?, data = ?, lineup_fp = ?, updated_by = ?, updated_at = ?,
              audited_by = ?, audited_at = ?
        WHERE raid_id = ? AND guild_id = ? AND rev = ? RETURNING rev`,
    ).bind(writeId, schemaVersion, guild.game_version, data, fingerprint, actor, now,
      audited ? actor : current.audited_by, audited ? now : current.audited_at, raid.id, guild.id, baseRev)];
  if (projectionDue) {
    const projected = projectPlan(plan, guild, await loadSurnameIndex(db, guild));
    statements.push(
      db.prepare(`DELETE FROM raid_plan WHERE raid_id = ? AND ${wrote.sql}`).bind(raid.id, ...wrote.params),
      db.prepare(
        `INSERT INTO raid_plan (raid_id, name, name_key, group_number)
         SELECT ?, json_extract(value, '$.name'), json_extract(value, '$.nameKey'), json_extract(value, '$.group') FROM json_each(?) WHERE ${wrote.sql}`,
      ).bind(raid.id, JSON.stringify(projected.rows.map((row) => ({ name: row.name, nameKey: row.nameKey, group: row.group }))), ...wrote.params),
      db.prepare(`UPDATE raids SET plan_label = ?, plan_synced = ?, updated_at = ?, version = version + 1, policy_fp = '' WHERE id = ? AND guild_id = ? AND ${wrote.sql}`)
        .bind(projected.label, projected.label === null ? null : now, now, raid.id, guild.id, ...wrote.params),
    );
  }
  if (auditFirst) {
    statements.push(raidAudit(ctx, guildContext, 'raid.plan', raid.id, { plan: raid.plan_synced !== null }, { players: seatedCount, source }, wrote));
  } else if (auditEdit) {
    statements.push(raidAudit(ctx, guildContext, 'raid.plan_edit', raid.id, null, { players: seatedCount }, wrote));
  }
  const results = await db.batch(statements);
  if (results[0].results.length !== 1) {
    const still = await db.prepare('SELECT 1 AS present FROM raids WHERE id = ? AND guild_id = ?').bind(raid.id, guild.id).first();
    throw still ? await conflict(ctx, guild.id, raid.id) : notFound();
  }
  const reply = { rev: results[0].results[0].rev, unchanged: false, updatedAt: now };
  // The attendance of a raid that has a log or hand-entered presence reads the plan; any other raid has nothing to recalculate yet.
  if (projectionDue && (raid.reports > 0 || raid.log_mode === 'manual')) {
    try { await recomputeRaid(ctx, guild, raid.id); } catch { reply.recomputeFailed = true; } // the plan is saved; the raid stays marked for recalculation
  }
  return jsonResponse(reply);
}

// GET /api/guild/:gid/raid-for-event?event=<Raid-Helper event id>: the guild's raid made from that event, when the viewer may edit its team
// (the Planner's Raid-Helper import attaches the plan to it); otherwise { raid: null }, so the answer never tells who may not edit what.
export async function getRaidForEvent(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const event = new URL(ctx.request.url).searchParams.get('event');
  if (!event || !EVENT_ID.test(event)) throw bad('event is a Raid-Helper event id (6 to 25 digits).', 'event');
  const row = await ctx.db.prepare('SELECT id, raid_on, title, event_title, team_id FROM raids WHERE guild_id = ? AND event_id = ?')
    .bind(guildContext.guild.id, event).first();
  if (!row || !allows(guildContext.can, 'raids.edit', row.team_id)) return jsonResponse({ raid: null });
  return jsonResponse({ raid: { id: row.id, raidOn: row.raid_on, title: row.title || row.event_title || null, teamId: row.team_id } });
}
