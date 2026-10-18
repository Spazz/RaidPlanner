// Sending a Discord channel post and recording it, the I/O half of worker/notify.js. Every message has a dedupe key, claimed in notification_log BEFORE the
// post goes out, so two overlapping runs (or a run and a route) can never send the same message twice; a message that was claimed but never finished stays
// 'pending' and is not sent again (at most once). A transient failure is marked 'retry' and tried again by the next runs, up to RETRY_LIMIT attempts.
// A webhook Discord answers 404/401/403 is switched off (team_notifications.webhook_state) and the audit log says so; the message it could not deliver stays
// 'retry', so a new address delivers it on the next run if the raid has not started (dueKinds stops asking once it has).
// ctx: { db, env, fetch, now, randomBytes, log } (the Worker's request base, or the scheduler's).
import { auditStatement } from './audit.js';
import { newId } from './ids.js';
import { LOG_KEEP_DAYS, RETRY_LIMIT, classifyReply, isWebhookUrl, testBody } from './notify.js';

const POST_TIMEOUT_MS = 5000;
const DAY_MS = 86400000;

export const TEAM_NOTIFY_COLUMNS = `team_id, guild_id, webhook_url, webhook_state, disabled_at, disabled_status, role_mention, post_roster, post_loot,
  post_reminders, post_noreply, noreply_hours, post_confirm, updated_at`;

// The team's row, or null when nothing was ever set for it.
export async function loadTeamNotify(db, teamId) {
  return db.prepare(`SELECT ${TEAM_NOTIFY_COLUMNS} FROM team_notifications WHERE team_id = ?`).bind(teamId).first();
}

// The same read as a statement, for a route that has a db.batch of its own going (the team's settings come back with its results).
export const teamNotifyStatement = (db, teamId) => db.prepare(`SELECT ${TEAM_NOTIFY_COLUMNS} FROM team_notifications WHERE team_id = ?`).bind(teamId);

// A webhook that can be posted to right now.
export const usable = (settings, env) => !!settings && settings.webhook_state === 'ok' && isWebhookUrl(settings.webhook_url, env);

async function alreadyHandled(db, guildId, key) {
  const row = await db.prepare('SELECT status FROM notification_log WHERE guild_id = ? AND dedupe_key = ?').bind(guildId, key).first();
  return !!row && row.status !== 'retry';
}

// True when this caller owns the message: a new row, or a 'retry' row taken back to 'pending'.
async function claim(ctx, spec) {
  const { db } = ctx;
  const now = ctx.now();
  try {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO notification_log (id, guild_id, team_id, raid_id, kind, dedupe_key, status, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    ).bind(newId('nl', ctx.randomBytes), spec.guildId, spec.teamId, spec.raidId ?? null, spec.kind, spec.dedupeKey, now).run();
    if (inserted.meta.changes === 1) return true;
    const again = await db.prepare(
      "UPDATE notification_log SET status = 'pending' WHERE guild_id = ? AND dedupe_key = ? AND status = 'retry'",
    ).bind(spec.guildId, spec.dedupeKey).run();
    return again.meta.changes === 1;
  } catch {
    return false; // the team or raid is gone: nothing to send
  }
}

async function postJson(ctx, url, body) {
  try {
    const response = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    return response && typeof response.status === 'number' ? response.status : null;
  } catch {
    return null;
  }
}

function finishStatement(ctx, spec, outcome, httpStatus, people) {
  const sent = outcome === 'sent';
  return ctx.db.prepare(
    `UPDATE notification_log
        SET status = CASE WHEN ?1 = 'retry' AND attempts + 1 >= ?2 THEN 'failed' ELSE ?1 END,
            attempts = attempts + 1, http_status = ?3, people = ?4, sent_at = CASE WHEN ?1 = 'sent' THEN ?5 ELSE sent_at END
      WHERE guild_id = ?6 AND dedupe_key = ?7`,
  ).bind(outcome, RETRY_LIMIT, httpStatus, people, sent ? ctx.now() : null, spec.guildId, spec.dedupeKey);
}

// The statements that switch a team's webhook off after Discord refused it (404 / 401 / 403) and say so in the audit log: the same for a real post and a
// test post. Only the address that was refused goes off; a new one saved in the meantime stays on. actorUserId: the officer who sent a test post, null for a scheduled post.
const disableStatements = (ctx, spec, status, actorUserId) => [
  ctx.db.prepare(
    "UPDATE team_notifications SET webhook_state = 'disabled', disabled_at = ?, disabled_status = ? WHERE team_id = ? AND guild_id = ? AND webhook_url = ? AND webhook_state = 'ok'",
  ).bind(ctx.now(), status, spec.teamId, spec.guildId, spec.webhookUrl),
  auditStatement(ctx, {
    guildId: spec.guildId, actorUserId, action: 'notify.disabled', entityType: 'team', entityId: spec.teamId, after: { teamId: spec.teamId, status },
  }, { sql: 'changes() = 1', params: [] }),
];

// "Send a test post": one message to the team's webhook, outside the dedupe log (the route rate-limits it). spec: { guildId, teamId, teamName, webhookUrl,
// actorUserId } -> { result: 'sent' | 'disabled' | 'failed', status }. A reply that would switch a real post's webhook off (404 / 401 / 403) switches this one off
// too; any other failure (a network error, 429, 5xx, a body Discord refused) is only reported. Never throws on a failed post.
export async function sendTestPost(ctx, spec) {
  if (!isWebhookUrl(spec.webhookUrl, ctx.env)) return { result: 'failed', status: null };
  const status = await postJson(ctx, spec.webhookUrl, testBody(spec.teamName));
  const outcome = classifyReply(status);
  if (outcome === 'disable') {
    await ctx.db.batch(disableStatements(ctx, spec, status, spec.actorUserId ?? null));
    return { result: 'disabled', status };
  }
  return { result: outcome === 'sent' ? 'sent' : 'failed', status };
}

// spec: { guildId, teamId, raidId | null, kind, dedupeKey, webhookUrl, build: async () => { body, people } | null }
// -> { result: 'sent' | 'retry' | 'failed' | 'disabled' | 'duplicate' | 'nothing' | 'skipped', status? }. Never throws.
export async function notifyOnce(ctx, spec) {
  try {
    if (!isWebhookUrl(spec.webhookUrl, ctx.env)) return { result: 'skipped' };
    if (await alreadyHandled(ctx.db, spec.guildId, spec.dedupeKey)) return { result: 'duplicate' };
    const built = await spec.build();
    if (!built) return { result: 'nothing' };
    if (!(await claim(ctx, spec))) return { result: 'duplicate' };
    const status = await postJson(ctx, spec.webhookUrl, built.body);
    const outcome = classifyReply(status);
    if (outcome === 'disable') {
      await ctx.db.batch([
        finishStatement(ctx, spec, 'retry', status, built.people || 0), // never delivered: a new webhook may still deliver it
        ...disableStatements(ctx, spec, status, null),
      ]);
      return { result: 'disabled', status };
    }
    await finishStatement(ctx, spec, outcome, status, built.people || 0).run();
    return { result: outcome === 'sent' ? 'sent' : outcome, status };
  } catch (error) {
    try { ctx.log(`notification failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return { result: 'failed' };
  }
}

// The daily run: rows older than LOG_KEEP_DAYS go.
export async function pruneNotificationLog(db, nowMs) {
  const result = await db.prepare('DELETE FROM notification_log WHERE created_at < ?').bind(nowMs - LOG_KEEP_DAYS * DAY_MS).run();
  return result.meta.changes;
}
