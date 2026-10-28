// The read-only data API (PM wave 7): GET /api/v1/<dataset>.csv and GET /api/v1/<dataset>.json, opened by a key an officer made (Guild settings > Links and keys).
// There is no session: the key is the credential, and it names ONE guild (and one team or all of its teams) and the datasets it may read.
//   .csv   ?key=rsk_...  (for Google Sheets IMPORTDATA, which cannot send a header) or  Authorization: Bearer rsk_...
//   .json  Authorization: Bearer rsk_...   (a key in the address would end up in logs and history; JSON clients can send a header)
// Only the SHA-256 of the key is stored. Anything wrong with the key (not made, turned off, expired) is a 401; a key that may not read this dataset is a 403.
// Rate limit: 60 requests an hour per key. The data is worker/api-data.js: what a member of the key's scope sees, minus notes and Discord / account data.
import { HttpError, SECURITY_HEADERS, jsonResponse } from '../http.js';
import { READERS } from '../api-data.js';
import {
  API_DATASETS, KEY_PATTERN, KEY_RATE_LIMIT, KEY_RATE_WINDOW_MS, keyCan, keyStatus, memberPermissionsStatement, parseDatasets,
} from '../api-keys.js';
import { toCsv } from '../csv.js';
import { isGranted } from '../permissions.js';
import { checkRateLimit, rateLimitMessage } from '../ratelimit.js';
import { hashToken } from '../session.js';
import { loadGuildRow } from '../viewer.js';

const FILE = /^([a-z]{3,12})\.(csv|json)$/;
const invalid = () => new HttpError(401, 'invalid_key', 'That key is not valid. Make a new one in Guild settings > Links and keys.');

// The key the request carries: a Bearer header, or (CSV only) ?key=. -> the token text or null.
function presentedKey(request, format) {
  const header = request.headers.get('Authorization');
  const bearer = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (bearer) return bearer[1];
  if (format === 'csv') {
    const value = new URL(request.url).searchParams.get('key');
    return value === null ? null : value;
  }
  return null;
}

export async function getApiData(ctx) {
  const file = FILE.exec(ctx.params.dataset || '');
  if (!file || !Object.prototype.hasOwnProperty.call(API_DATASETS, file[1])) throw new HttpError(404, 'not_found', 'There is no such dataset. Try roster, attendance, loot or raids.');
  const [, dataset, format] = file;

  const token = presentedKey(ctx.request, format);
  if (token === null) {
    throw new HttpError(401, 'key_required', format === 'csv'
      ? 'Add your key to the address: ?key=rsk_... (or send it as an Authorization: Bearer header).'
      : 'Send your key as an Authorization: Bearer header.');
  }
  if (!KEY_PATTERN.test(token)) throw invalid();
  const { db } = ctx;
  const now = ctx.now();
  const key = await db.prepare(
    'SELECT id, guild_id, team_id, datasets, expires_at, revoked_at, last_used_at FROM api_keys WHERE token_hash = ?',
  ).bind(await hashToken(token)).first();
  if (!key) throw invalid();
  const status = keyStatus(key, now);
  if (status === 'revoked') throw new HttpError(401, 'key_revoked', 'An officer turned this key off.');
  if (status === 'expired') throw new HttpError(401, 'key_expired', 'This key has expired. Ask an officer for a new one.');
  if (!parseDatasets(key.datasets).includes(dataset)) {
    throw new HttpError(403, 'dataset_not_allowed', `This key cannot read ${dataset}. Ask an officer for a key that can.`);
  }

  const limit = await checkRateLimit(db, null, now, { key: `api:${key.id}`, limit: KEY_RATE_LIMIT, windowMs: KEY_RATE_WINDOW_MS });
  if (limit.limited) throw new HttpError(429, 'rate_limited', rateLimitMessage(`api:${key.id}`), { retryAfter: limit.retryAfter });

  const guild = await loadGuildRow(db, key.guild_id);
  if (!guild) throw invalid();
  const [teamResult, memberResult] = await db.batch([
    db.prepare('SELECT id, name FROM teams WHERE guild_id = ? AND archived = 0 ORDER BY created_at, id').bind(guild.id),
    memberPermissionsStatement(db, guild.id),
  ]);
  const activeTeams = teamResult.results;
  const teams = key.team_id ? activeTeams.filter((team) => team.id === key.team_id) : activeTeams;
  if (key.team_id && !teams.length) throw new HttpError(403, 'team_archived', 'The team of this key is archived.');
  const can = keyCan(memberResult.results, key.team_id, activeTeams.map((team) => team.id));
  // What a member could read, right now: the guild's Member role may have been narrowed since the key was made.
  if (!isGranted(can[API_DATASETS[dataset].action])) {
    throw new HttpError(403, 'dataset_not_allowed', `Members of this guild cannot see ${dataset} any more, so this key cannot read it.`);
  }

  const params = new URL(ctx.request.url).searchParams;
  const result = await READERS[dataset](db, { guild, teams, can, params, now });

  try {
    await db.prepare('UPDATE api_keys SET uses = uses + 1, last_used_at = ? WHERE id = ?').bind(now, key.id).run();
  } catch {
    // The use count is a convenience; never fail a read over it.
  }

  const headers = new Headers(SECURITY_HEADERS);
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  if (format === 'json') {
    const team = key.team_id ? teams[0] : null;
    return jsonResponse({
      dataset, generatedAt: new Date(now).toISOString(), guild: guild.name, team: team ? team.name : null, columns: result.columns, rows: result.rows,
      ...(result.truncated ? { truncated: true } : {}),
    });
  }
  headers.set('Content-Type', 'text/csv; charset=utf-8');
  headers.set('Content-Disposition', `inline; filename="raidsmith-${dataset}.csv"`);
  return new Response(toCsv(result.columns.map((name) => ({ key: name, header: name })), result.rows), { status: 200, headers });
}
