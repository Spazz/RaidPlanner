// Applying the Discord role mapping: a member's Discord roles -> the Raidsmith roles the guild mapped them to.
// Runs at every Discord sign-in (and when Discord is linked), and when an officer presses Sync now / Sync everyone.
//   - It only ever writes role_assignments rows with source 'discord'. A role an officer set by hand is a 'manual' row: the sync does not touch it, and
//     a person who holds the same role both ways shows it once, as theirs (manual wins).
//   - A mapping can give Officer, Team Lead (for one team) or one of the guild's own roles. Never the Guild Master (the table's CHECK forbids it too).
//   - Failing closed means failing SAFE: when Discord cannot be read (bot not in the server, bad token, rate limit, outage) nothing changes. Only an
//     answer from Discord ("this person has these roles", or "this person is not in the server") changes anything.
//   - Blocked people and the Guild Master are skipped. A person who left the server loses what Discord gave them.
import { auditStatement } from './audit.js';
import { HttpError } from './http.js';
import { botConfigured, fetchMemberRoleIds } from './discord-bot.js';
import { hasDiscord, serverIdIsDiscordSql } from './discord-guard.js';
import { newId } from './ids.js';

const MAX_GUILDS_AT_SIGN_IN = 5;
export const SYNC_BATCH = 25;
const SYNC_CONCURRENCY = 5;

// The HttpError for a Discord read that failed (the reason codes of worker/discord-bot.js).
export function discordProblem(reason) {
  switch (reason) {
    case 'not_configured': return new HttpError(400, 'bot_not_configured', 'The Raidsmith Discord bot is not set up on this server (DISCORD_BOT_TOKEN).');
    case 'no_server': return new HttpError(409, 'no_discord_server', 'This guild does not use a Discord server, so there are no Discord roles to read.');
    case 'bot_missing': return new HttpError(409, 'bot_not_in_server', 'The Raidsmith bot is not in your Discord server yet. Add it with the invite link in Guild settings > Discord roles.');
    case 'bad_token': return new HttpError(502, 'discord_unavailable', 'Discord did not accept the bot\'s token. Check DISCORD_BOT_TOKEN.');
    case 'rate_limited': return new HttpError(429, 'rate_limited', 'Discord is busy right now. Wait a moment and try again.', { retryAfter: 5 });
    default: return new HttpError(502, 'discord_unavailable', 'Could not reach Discord. Try again in a moment.');
  }
}

const keyOf = (roleId, teamId) => `${roleId}|${teamId || ''}`;

// One person in one guild. guild: { id, discord_server_id }. -> { status: 'changed' | 'unchanged' | 'skipped' | 'failed', reason?, added?, removed? }
// reason (skipped): not_configured, no_mapping, blocked, guild_master, no_discord, no_discord_server (the guild has no Discord server: nothing is read or changed).
// reason (failed): bad_token, bot_missing, rate_limited, unavailable.
export async function syncMember(ctx, guild, userId, { actorId = userId } = {}) {
  const { db, env } = ctx;
  if (!hasDiscord(guild)) return { status: 'skipped', reason: 'no_discord_server' };
  const [mapResult, currentResult, standingResult] = await db.batch([
    db.prepare(
      `SELECT m.discord_role_id, m.role_id, m.team_id
         FROM discord_role_maps m
         JOIN roles r ON r.id = m.role_id AND (r.guild_id IS NULL OR r.guild_id = m.guild_id)
         LEFT JOIN teams t ON t.id = m.team_id AND t.guild_id = m.guild_id
        WHERE m.guild_id = ? AND (m.team_id IS NULL OR t.archived = 0)`,
    ).bind(guild.id),
    db.prepare(
      "SELECT role_id, team_id FROM effective_roles_stored WHERE guild_id = ? AND user_id = ? AND source = 'discord'",
    ).bind(guild.id, userId),
    db.prepare(
      `SELECT u.discord_id,
              EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = ?1 AND b.user_id = ?2) AS blocked,
              EXISTS (SELECT 1 FROM effective_roles x WHERE x.guild_id = ?1 AND x.user_id = ?2 AND x.role_id = 'guild_master') AS master,
              EXISTS (SELECT 1 FROM user_servers s WHERE s.user_id = ?2 AND s.server_id = ?3) AS in_server
         FROM users u WHERE u.id = ?2`,
    ).bind(guild.id, userId, guild.discord_server_id),
  ]);
  const standing = standingResult.results[0];
  if (!standing) return { status: 'skipped', reason: 'no_discord' };
  if (standing.blocked === 1) return { status: 'skipped', reason: 'blocked' };
  if (standing.master === 1) return { status: 'skipped', reason: 'guild_master' };
  const maps = mapResult.results;
  const current = currentResult.results;
  if (!maps.length && !current.length) return { status: 'skipped', reason: 'no_mapping' };

  // Somebody who is not in the Discord server has no Discord roles: that needs no call. Otherwise ask Discord, and change nothing if it cannot answer.
  // Somebody with no Discord connection (it was disconnected) has no Discord roles either, and what Discord gave them goes.
  let roleIds = [];
  if (maps.length && standing.in_server === 1 && standing.discord_id) {
    if (!botConfigured(env)) return { status: 'skipped', reason: 'not_configured' };
    const member = await fetchMemberRoleIds(env, ctx.fetch, guild.discord_server_id, standing.discord_id);
    if (!member.ok) return { status: 'failed', reason: member.reason };
    roleIds = member.roleIds;
  }

  const held = new Set(roleIds);
  const desired = new Map();
  for (const map of maps) if (held.has(map.discord_role_id)) desired.set(keyOf(map.role_id, map.team_id), { roleId: map.role_id, teamId: map.team_id || null });
  const have = new Map(current.map((row) => [keyOf(row.role_id, row.team_id), { roleId: row.role_id, teamId: row.team_id || null }]));
  const toAdd = [...desired].filter(([key]) => !have.has(key)).map(([, pair]) => pair);
  const toRemove = [...have].filter(([key]) => !desired.has(key)).map(([, pair]) => pair);
  if (!toAdd.length && !toRemove.length) return { status: 'unchanged' };

  const now = ctx.now();
  // Each INSERT re-checks, in the same statement, what it was built from: the person is not blocked and not the Guild Master, the mapping still exists
  // for a Discord role the person holds, and the team is still active.
  const guard = {
    sql: "NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?) AND NOT EXISTS (SELECT 1 FROM effective_roles WHERE guild_id = ? AND user_id = ? AND role_id = 'guild_master')",
    params: [guild.id, userId, guild.id, userId],
  };
  const addStatement = (pair) => {
    const teamCheck = pair.teamId ? ' AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND guild_id = ? AND archived = 0)' : '';
    return db.prepare(
      `INSERT OR IGNORE INTO role_assignments (id, guild_id, user_id, role_id, team_id, source, assigned_by, assigned_at)
       SELECT ?, ?, ?, ?, ?, 'discord', NULL, ?
        WHERE ${guard.sql}
          AND EXISTS (SELECT 1 FROM discord_role_maps m WHERE m.guild_id = ? AND m.role_id = ? AND COALESCE(m.team_id, '') = ?
                         AND m.discord_role_id IN (SELECT value FROM json_each(?)))${teamCheck}`,
    ).bind(
      newId('ra', ctx.randomBytes), guild.id, userId, pair.roleId, pair.teamId, now,
      ...guard.params,
      guild.id, pair.roleId, pair.teamId || '', JSON.stringify(roleIds),
      ...(pair.teamId ? [pair.teamId, guild.id] : []),
    );
  };
  const statements = [
    ...toRemove.map((pair) => db.prepare(
      "DELETE FROM role_assignments WHERE guild_id = ? AND user_id = ? AND source = 'discord' AND role_id = ? AND COALESCE(team_id, '') = ?",
    ).bind(guild.id, userId, pair.roleId, pair.teamId || '')),
    ...toAdd.map(addStatement),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: actorId, action: 'roles.discord_sync', entityType: 'user', entityId: userId,
      before: { roles: [...have.values()] }, after: { roles: [...desired.values()] },
    }),
  ];
  await db.batch(statements);
  return { status: 'changed', added: toAdd.length, removed: toRemove.length };
}

// A Discord sign-in (or link): every guild with a mapping where the person is in the Discord server or still holds something Discord gave them.
// Never throws and never delays the sign-in on a failure: the next sign-in tries again.
export async function syncSignIn(ctx, userId) {
  try {
    if (!botConfigured(ctx.env)) return;
    const guilds = await ctx.db.prepare(
      `SELECT g.id, g.discord_server_id FROM guilds g
        WHERE ${serverIdIsDiscordSql('g.discord_server_id')} AND EXISTS (SELECT 1 FROM discord_role_maps m WHERE m.guild_id = g.id)
          AND (EXISTS (SELECT 1 FROM user_servers us WHERE us.user_id = ?1 AND us.server_id = g.discord_server_id)
               OR EXISTS (SELECT 1 FROM effective_roles_stored ra WHERE ra.guild_id = g.id AND ra.user_id = ?1 AND ra.source = 'discord'))
        ORDER BY g.id LIMIT ?2`,
    ).bind(userId, MAX_GUILDS_AT_SIGN_IN).all();
    await Promise.all(guilds.results.map(async (guild) => {
      try {
        const result = await syncMember(ctx, guild, userId);
        if (result.status === 'failed') ctx.log(`discord role sync at sign-in: ${result.reason}`);
      } catch (error) {
        ctx.log(`discord role sync at sign-in failed: ${error && error.message}`);
      }
    }));
  } catch (error) {
    ctx.log(`discord role sync at sign-in failed: ${error && error.message}`);
  }
}

// Sync everyone who signed in: up to SYNC_BATCH people of the guild per call, from `after` (a user id; '' = the start). The caller repeats with `next` until it is null.
// -> { processed, changed, unchanged, skipped, failed, problem, next }. problem: a failure that will repeat for everyone (bad_token, bot_missing, rate_limited): the run stops there.
export async function syncGuildMembers(ctx, guild, { actorId, after = '' }) {
  if (!hasDiscord(guild)) return { processed: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0, problem: null, next: null };
  const rows = (await ctx.db.prepare(
    `SELECT u.id FROM users u
      WHERE u.id > ? AND u.discord_id IS NOT NULL
        AND (EXISTS (SELECT 1 FROM user_servers s WHERE s.user_id = u.id AND s.server_id = ?)
             OR EXISTS (SELECT 1 FROM effective_roles_stored x WHERE x.guild_id = ? AND x.user_id = u.id AND x.source = 'discord'))
      ORDER BY u.id LIMIT ?`,
  ).bind(after, guild.discord_server_id, guild.id, SYNC_BATCH + 1).all()).results;
  const slice = rows.slice(0, SYNC_BATCH);
  const summary = { processed: 0, changed: 0, unchanged: 0, skipped: 0, failed: 0, problem: null, next: null };
  for (let i = 0; i < slice.length && !summary.problem; i += SYNC_CONCURRENCY) {
    const results = await Promise.all(slice.slice(i, i + SYNC_CONCURRENCY).map(async (row) => {
      try {
        return await syncMember(ctx, guild, row.id, { actorId });
      } catch (error) {
        ctx.log(`discord role sync failed: ${error && error.message}`);
        return { status: 'failed', reason: 'unavailable' };
      }
    }));
    for (const result of results) {
      summary.processed++;
      summary[result.status]++;
      if (result.status === 'failed' && ['bad_token', 'bot_missing', 'rate_limited'].includes(result.reason)) summary.problem = summary.problem || result.reason;
    }
  }
  if (!summary.problem && rows.length > SYNC_BATCH) summary.next = slice[slice.length - 1].id;
  return summary;
}
