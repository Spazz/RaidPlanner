// Guild settings > Notifications (needs guild.teams): per team, the Discord channel webhook and what is posted to it (worker/notify.js).
//   GET /api/guild/:gid/notifications          every active team's settings
//   PUT /api/guild/:gid/teams/:tid/notifications   one team's settings; a field left out keeps its value
// The webhook address is a secret: it is stored, used by the Worker and never sent back. The reply carries only `set`, a hint (".../<last 4>") and its state.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { loadGuildContext, requireAction } from '../permissions.js';
import {
  DEFAULT_NOREPLY_HOURS, NOREPLY_HOURS, parseRoleMention, parseWebhookUrl, webhookHint,
} from '../notify.js';
import { TEAM_NOTIFY_COLUMNS } from '../notify-store.js';
import { bad } from './roster.js';

const SWITCHES = [
  ['roster', 'post_roster'], ['loot', 'post_loot'], ['reminders', 'post_reminders'], ['noreply', 'post_noreply'], ['confirm', 'post_confirm'],
];

const NONE = {
  webhook_url: null, webhook_state: 'ok', disabled_at: null, disabled_status: null, role_mention: null,
  post_roster: 0, post_loot: 0, post_reminders: 0, post_noreply: 0, noreply_hours: DEFAULT_NOREPLY_HOURS, post_confirm: 0,
};

// A team and its settings row (the defaults when it has none) as the page reads it. Never the address itself.
export function teamView(team, row) {
  const s = row || NONE;
  return {
    id: team.id,
    name: team.name,
    webhook: {
      set: s.webhook_url !== null,
      hint: webhookHint(s.webhook_url),
      state: s.webhook_url !== null && s.webhook_state === 'disabled' ? 'disabled' : 'ok',
      disabledAt: s.webhook_url !== null && s.webhook_state === 'disabled' ? s.disabled_at : null,
      disabledStatus: s.webhook_url !== null && s.webhook_state === 'disabled' ? s.disabled_status : null,
    },
    roleMention: s.role_mention,
    post: Object.fromEntries(SWITCHES.map(([key, column]) => [key, s[column] === 1])),
    noreplyHours: s.noreply_hours,
  };
}

async function payload(db, guildId) {
  const [teamResult, rowResult] = await db.batch([
    db.prepare('SELECT id, name FROM teams WHERE guild_id = ? AND archived = 0 ORDER BY created_at, id').bind(guildId),
    db.prepare(`SELECT ${TEAM_NOTIFY_COLUMNS} FROM team_notifications WHERE guild_id = ?`).bind(guildId),
  ]);
  const rows = new Map(rowResult.results.map((row) => [row.team_id, row]));
  return { teams: teamResult.results.map((team) => teamView(team, rows.get(team.id))), options: { noreplyHours: NOREPLY_HOURS } };
}

export async function getNotifications(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.teams');
  return jsonResponse(await payload(ctx.db, guildContext.guild.id));
}

export async function putTeamNotifications(ctx) {
  const { db, body, env } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.teams');
  const guild = guildContext.guild;
  const team = await db.prepare('SELECT id, name FROM teams WHERE id = ? AND guild_id = ? AND archived = 0').bind(ctx.params.tid, guild.id).first();
  if (!team) throw new HttpError(404, 'not_found', 'That team does not exist.');
  const before = (await db.prepare(`SELECT ${TEAM_NOTIFY_COLUMNS} FROM team_notifications WHERE team_id = ?`).bind(team.id).first()) || null;
  const current = before || NONE;
  const next = { ...current };
  const changed = [];

  if (body.webhookUrl !== undefined) {
    if (body.webhookUrl === null || body.webhookUrl === '') {
      if (current.webhook_url !== null) changed.push('webhook');
      next.webhook_url = null; next.webhook_state = 'ok'; next.disabled_at = null; next.disabled_status = null;
    } else {
      const parsed = parseWebhookUrl(body.webhookUrl, env);
      if (!parsed.ok) throw bad(parsed.message, 'webhookUrl');
      // Saving an address is always a fresh start: a switched-off webhook is switched on again until Discord refuses it once more.
      if (parsed.url !== current.webhook_url || current.webhook_state === 'disabled') changed.push('webhook');
      next.webhook_url = parsed.url; next.webhook_state = 'ok'; next.disabled_at = null; next.disabled_status = null;
    }
  }
  if (body.roleMention !== undefined) {
    const parsed = parseRoleMention(body.roleMention);
    if (!parsed.ok) throw bad('Type a role mention like <@&123456789012345678>, or leave it empty. @everyone and @here are never used.', 'roleMention');
    if (parsed.value !== current.role_mention) changed.push('roleMention');
    next.role_mention = parsed.value;
  }
  for (const [key, column] of SWITCHES) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw bad(`${key} must be true or false.`, key);
    if ((body[key] ? 1 : 0) !== current[column]) changed.push(key);
    next[column] = body[key] ? 1 : 0;
  }
  if (body.noreplyHours !== undefined) {
    if (!NOREPLY_HOURS.includes(body.noreplyHours)) throw bad(`noreplyHours is ${NOREPLY_HOURS.join(', ')}.`, 'noreplyHours');
    if (body.noreplyHours !== current.noreply_hours) changed.push('noreplyHours');
    next.noreply_hours = body.noreplyHours;
  }

  if (changed.length) {
    const statements = [db.prepare(
      `INSERT INTO team_notifications (team_id, guild_id, webhook_url, webhook_state, disabled_at, disabled_status, role_mention, post_roster, post_loot,
              post_reminders, post_noreply, noreply_hours, post_confirm, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(team_id) DO UPDATE SET webhook_url = excluded.webhook_url, webhook_state = excluded.webhook_state, disabled_at = excluded.disabled_at,
              disabled_status = excluded.disabled_status, role_mention = excluded.role_mention, post_roster = excluded.post_roster, post_loot = excluded.post_loot,
              post_reminders = excluded.post_reminders, post_noreply = excluded.post_noreply, noreply_hours = excluded.noreply_hours,
              post_confirm = excluded.post_confirm, updated_at = excluded.updated_at`,
    ).bind(
      team.id, guild.id, next.webhook_url, next.webhook_state, next.disabled_at, next.disabled_status, next.role_mention, next.post_roster, next.post_loot,
      next.post_reminders, next.post_noreply, next.noreply_hours, next.post_confirm, ctx.now(),
    )];
    // The audit row names what changed, never the address.
    statements.push(auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'notify.update', entityType: 'team', entityId: team.id,
      before: { teamId: team.id }, after: { teamId: team.id, changed },
    }));
    await db.batch(statements);
  }
  const fresh = await db.prepare(`SELECT ${TEAM_NOTIFY_COLUMNS} FROM team_notifications WHERE team_id = ?`).bind(team.id).first();
  return jsonResponse({ team: teamView(team, fresh), options: { noreplyHours: NOREPLY_HOURS } });
}
