// Read-only API keys (PM wave 7), the officers' side: Guild settings > Data access. A key opens CSV and JSON links to a team's (or the guild's) roster,
// attendance, loot and raids, for a spreadsheet or a script. Needs guild.access (Guild Master and the Officer role).
//   GET    /api/guild/:gid/api-keys           the keys and what a new one may be
//   POST   /api/guild/:gid/api-keys           make a key: the token comes back ONCE, in `created`
//   DELETE /api/guild/:gid/api-keys/:kid      turn a key off (it cannot be turned back on)
// The token ("rsk_" + 32 random bytes) is shown once; D1 keeps its SHA-256 like a guest link, and neither the token nor its hash is ever audited.
// The data itself is worker/routes/api-v1.js.
import { HttpError, cleanText, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import {
  API_DATASETS, DATASET_IDS, KEY_EXPIRES_IN, KEY_PREFIX, KEY_RATE_LIMIT, MAX_ACTIVE_KEYS, MAX_KEY_NAME, availableDatasets, keyStatus, memberPermissionsStatement,
  parseDatasets,
} from '../api-keys.js';
import { base64url, newId } from '../ids.js';
import { canGrant, loadGuildContext, requireAction } from '../permissions.js';
import { toPerson } from '../person.js';
import { hashToken } from '../session.js';

async function keysPayload(db, guildContext, nowMs) {
  const guildId = guildContext.guild.id;
  const [keyResult, teamResult, memberResult] = await db.batch([
    db.prepare(
      `SELECT k.id, k.name, k.team_id, t.name AS team_name, k.datasets, k.expires_at, k.revoked_at, k.uses, k.last_used_at, k.created_at,
              u.id AS user_id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar
         FROM api_keys k
         LEFT JOIN teams t ON t.id = k.team_id AND t.guild_id = k.guild_id
         LEFT JOIN users u ON u.id = k.created_by
        WHERE k.guild_id = ? ORDER BY k.created_at DESC, k.id LIMIT 200`,
    ).bind(guildId),
    db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guildId),
    memberPermissionsStatement(db, guildId),
  ]);
  const available = availableDatasets(memberResult.results, null, teamResult.results.map((row) => row.id));
  return {
    keys: keyResult.results.map((row) => ({
      id: row.id,
      name: row.name,
      team: row.team_id ? { id: row.team_id, name: row.team_name } : null,
      datasets: parseDatasets(row.datasets),
      status: keyStatus(row, nowMs),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      uses: row.uses,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      createdBy: row.user_id ? toPerson({ id: row.user_id, discord_id: row.discord_id, username: row.username, global_name: row.global_name, display_name: row.display_name, avatar: row.avatar }) : null,
    })),
    // The datasets a key can read: `available` is false when the guild's Member role cannot see it (a key reads what a member of its scope reads).
    datasets: DATASET_IDS.map((id) => ({ id, label: API_DATASETS[id].label, available: available[id] })),
    expiries: Object.keys(KEY_EXPIRES_IN),
    limits: { perHour: KEY_RATE_LIMIT, maxActive: MAX_ACTIVE_KEYS },
  };
}

export async function listApiKeys(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  return jsonResponse(await keysPayload(ctx.db, guildContext, ctx.now()));
}

export async function createApiKey(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const guildId = guildContext.guild.id;
  const { body } = ctx;

  const name = cleanText(body.name, 'name', { min: 1, max: MAX_KEY_NAME });
  if (/[\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) throw new HttpError(400, 'bad_request', 'Use plain letters, numbers and spaces in the name.', { field: 'name' });
  const teamId = body.teamId === undefined || body.teamId === null ? null : body.teamId;
  const [teamResult, memberResult] = await ctx.db.batch([
    ctx.db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guildId),
    memberPermissionsStatement(ctx.db, guildId),
  ]);
  const activeTeams = teamResult.results.map((row) => row.id);
  if (teamId !== null && !(typeof teamId === 'string' && activeTeams.includes(teamId))) {
    throw new HttpError(400, 'bad_request', 'That team does not exist in this guild or is archived.', { field: 'teamId' });
  }
  if (!Array.isArray(body.datasets) || !body.datasets.length || body.datasets.some((id) => typeof id !== 'string' || !DATASET_IDS.includes(id))) {
    throw new HttpError(400, 'bad_request', `Pick what the key reads: ${DATASET_IDS.join(', ')}.`, { field: 'datasets' });
  }
  const datasets = DATASET_IDS.filter((id) => body.datasets.includes(id));
  const available = availableDatasets(memberResult.results, teamId, activeTeams);
  const closed = datasets.filter((id) => !available[id]);
  if (closed.length) {
    throw new HttpError(400, 'bad_request', `A key reads what a member can see, and members cannot see ${closed.join(' or ')} here. Change the Member role first.`, { field: 'datasets' });
  }
  if (typeof body.expiresIn !== 'string' || !Object.prototype.hasOwnProperty.call(KEY_EXPIRES_IN, body.expiresIn)) {
    throw new HttpError(400, 'bad_request', 'Pick how long the key works: 30 days, 90 days, 365 days or never.', { field: 'expiresIn' });
  }
  // Never publish more than you can see yourself: the maker must hold each read action for what the key reaches.
  if (!guildContext.isGuildMaster) {
    for (const id of datasets) {
      if (!canGrant(guildContext.can, API_DATASETS[id].action, teamId ? 'team' : 'guild', teamId)) {
        throw new HttpError(403, 'forbidden', 'You cannot share more than you can see yourself.', { field: 'datasets' });
      }
    }
  }

  const now = ctx.now();
  const expiresAt = KEY_EXPIRES_IN[body.expiresIn] === null ? null : now + KEY_EXPIRES_IN[body.expiresIn];
  const token = `${KEY_PREFIX}${base64url(ctx.randomBytes(32))}`;
  const id = newId('ak', ctx.randomBytes);
  const made = { sql: 'EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND guild_id = ?)', params: [id, guildId] };
  const results = await ctx.db.batch([
    // One guarded INSERT enforces the cap on keys that still work; the audit row follows only if the key exists.
    ctx.db.prepare(
      `INSERT INTO api_keys (id, guild_id, token_hash, name, team_id, datasets, expires_at, revoked_at, uses, last_used_at, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?
        WHERE (SELECT COUNT(*) FROM api_keys WHERE guild_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) < ?`,
    ).bind(id, guildId, await hashToken(token), name, teamId, JSON.stringify(datasets), expiresAt, guildContext.userId, now, guildId, now, MAX_ACTIVE_KEYS),
    // The token and its hash never go in the audit log.
    auditStatement(ctx, {
      guildId, actorUserId: guildContext.userId, action: 'apikey.create', entityType: 'api_key', entityId: id,
      after: { teamId, datasets, expiresAt },
    }, made),
  ]);
  if (results[0].meta.changes !== 1) {
    throw new HttpError(400, 'bad_request', `A guild can have at most ${MAX_ACTIVE_KEYS} keys that still work. Turn some off first.`, { field: 'name' });
  }
  return jsonResponse({ ...(await keysPayload(ctx.db, guildContext, now)), created: { id, token } }, 201);
}

export async function revokeApiKey(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const guildId = guildContext.guild.id;
  const now = ctx.now();
  const key = await ctx.db.prepare('SELECT id, revoked_at FROM api_keys WHERE id = ? AND guild_id = ?').bind(ctx.params.kid, guildId).first();
  if (!key) throw new HttpError(404, 'not_found', 'That key does not exist.');
  if (key.revoked_at === null) {
    const turnedOff = { sql: 'EXISTS (SELECT 1 FROM api_keys WHERE id = ? AND guild_id = ? AND revoked_at = ?)', params: [key.id, guildId, now] };
    await ctx.db.batch([
      ctx.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND guild_id = ? AND revoked_at IS NULL').bind(now, key.id, guildId),
      auditStatement(ctx, { guildId, actorUserId: guildContext.userId, action: 'apikey.revoke', entityType: 'api_key', entityId: key.id }, turnedOff),
    ]);
  }
  return jsonResponse(await keysPayload(ctx.db, guildContext, now));
}
