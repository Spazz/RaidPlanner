// The Activity log: GET /audit reads a guild's audit_log newest first, with filters (type group, person who did it, guild-local date range),
// 50 rows per page (keyset paging) and the same rows as a CSV (up to 5,000). Guild Master only (audit.view). The log holds internal ids and
// flags, never note text, so each row's sentence is built from names looked up here at read time (worker/audit-view.js).
import { SECURITY_HEADERS, jsonResponse } from '../http.js';
import { localTimeToMs } from '../attendance-calendar.js';
import {
  AUDIT_GROUPS, GROUP_IDS, auditCsv, collectRefs, dayLabel, describeRow, groupFilter, groupOf, rangeMs,
} from '../audit-view.js';
import { isId } from '../ids.js';
import { loadGuildContext, requireAction } from '../permissions.js';
import { isRealDate, todayIn } from '../roster-data.js';
import { bad } from './roster.js';

export const AUDIT_PAGE = 50;
export const AUDIT_CSV_MAX = 5000;
const CURSOR = /^(\d{10,15}):(al_[A-Za-z0-9_-]{22})$/;

const parseJson = (text) => {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
};
// The name an account shows: the one it chose (users.display_name, Phase 7a accounts), else its Discord or Battle.net name.
const userName = (row) => row.display_name || row.global_name || row.username;
const idsOf = (set) => JSON.stringify([...set]);

// -> { group, actor, from, to, cursor, csv } or a 400 naming the field.
function readFilters(params, timeZone) {
  const group = params.get('type') || null;
  if (group !== null && !GROUP_IDS.includes(group)) throw bad('Pick one of the activity types.', 'type');
  const actor = params.get('actor') || null;
  if (actor !== null && !isId('u', actor)) throw bad('Pick a person from the list.', 'actor');
  const from = params.get('from') || null;
  if (from !== null && !isRealDate(from)) throw bad('From needs a date.', 'from');
  const to = params.get('to') || null;
  if (to !== null && !isRealDate(to)) throw bad('To needs a date.', 'to');
  if (from && to && from > to) throw bad('From must be on or before To.', 'to');
  const before = params.get('before') || null;
  const match = before === null ? null : CURSOR.exec(before);
  if (before !== null && !match) throw bad('before is the value the last page sent.', 'before');
  const format = params.get('format');
  if (format !== null && format !== 'csv') throw bad('format can only be csv.', 'format');
  const [fromMs, toMs] = rangeMs(from, to, timeZone, localTimeToMs);
  return { group, actor, fromMs, toMs, cursor: match ? { at: Number(match[1]), id: match[2] } : null, csv: format === 'csv' };
}

// One fixed statement: every filter is a nullable parameter, so no SQL text is ever built from a value. ?3 says whether the type's action list
// is the ones to keep (1) or the ones to leave out (0, for the catch-all Settings group).
function rowsStatement(db, guildId, filters, limit) {
  const picked = filters.group ? groupFilter(filters.group) : null;
  const cursor = filters.cursor && !filters.csv ? filters.cursor : null;
  return db.prepare(
    `SELECT id, actor_user_id, action, entity_type, entity_id, before, after, created_at FROM audit_log
      WHERE guild_id = ?1
        AND (?2 IS NULL OR (action IN (SELECT value FROM json_each(?2))) = ?3)
        AND (?4 IS NULL OR actor_user_id = ?4)
        AND (?5 IS NULL OR created_at >= ?5)
        AND (?6 IS NULL OR created_at < ?6)
        AND (?7 IS NULL OR created_at < ?7 OR (created_at = ?7 AND id < ?8))
      ORDER BY created_at DESC, id DESC LIMIT ?9`,
  ).bind(
    guildId, picked ? JSON.stringify(picked.actions) : null, picked && picked.not ? 0 : 1, filters.actor, filters.fromMs, filters.toMs,
    cursor ? cursor.at : null, cursor ? cursor.id : null, limit,
  );
}

// The names the sentences of these rows need, in one batch. -> the `names` object describeRow reads.
async function loadNames(db, guildId, refs, teams) {
  const [personResult, characterResult, raidResult, userResult, awardResult, claimResult] = await db.batch([
    db.prepare(
      `SELECT player_id, name FROM characters WHERE guild_id = ?1 AND player_id IN (SELECT value FROM json_each(?2)) ORDER BY is_main DESC, name`,
    ).bind(guildId, idsOf(refs.persons)),
    db.prepare('SELECT id, name FROM characters WHERE guild_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(guildId, idsOf(refs.characters)),
    db.prepare('SELECT id, raid_on, team_id FROM raids WHERE guild_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(guildId, idsOf(refs.raids)),
    db.prepare('SELECT id, username, global_name, display_name FROM users WHERE id IN (SELECT value FROM json_each(?1))').bind(idsOf(refs.users)),
    db.prepare('SELECT id, item_name, item_id FROM loot_awards WHERE guild_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(guildId, idsOf(refs.awards)),
    db.prepare('SELECT id, name FROM character_claims WHERE guild_id = ?1 AND id IN (SELECT value FROM json_each(?2))').bind(guildId, idsOf(refs.claims)),
  ]);
  const persons = new Map();
  for (const row of personResult.results) if (!persons.has(row.player_id)) persons.set(row.player_id, row.name);
  const characters = new Map(characterResult.results.map((row) => [row.id, row.name]));
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));
  const several = teams.filter((team) => team.archived === 0).length > 1;
  const raids = new Map(raidResult.results.map((row) => [row.id, row]));
  const users = new Map(userResult.results.map((row) => [row.id, userName(row)]));
  const awards = new Map(awardResult.results.map((row) => [row.id, row.item_name || `item ${row.item_id}`]));
  const claims = new Map(claimResult.results.map((row) => [row.id, row.name]));
  return {
    person: (id) => persons.get(id) || null,
    character: (id) => characters.get(id) || null,
    team: (id) => teamNames.get(id) || null,
    raid: (id) => {
      const raid = raids.get(id);
      if (!raid) return null;
      return `${dayLabel(raid.raid_on)}${several && teamNames.has(raid.team_id) ? ` (${teamNames.get(raid.team_id)})` : ''}`;
    },
    user: (id) => users.get(id) || null,
    award: (id) => awards.get(id) || null,
    claim: (id) => claims.get(id) || null,
    users,
  };
}

const slugOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'guild';

export async function getAudit(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'audit.view');
  const guild = guildContext.guild;
  const filters = readFilters(new URL(ctx.request.url).searchParams, guild.time_zone);
  const limit = filters.csv ? AUDIT_CSV_MAX : AUDIT_PAGE + 1;
  const [rowResult, actorResult, teamResult] = await ctx.db.batch([
    rowsStatement(ctx.db, guild.id, filters, limit),
    ctx.db.prepare(
      `SELECT id, username, global_name, display_name FROM users
        WHERE id IN (SELECT actor_user_id FROM audit_log WHERE guild_id = ? AND actor_user_id IS NOT NULL GROUP BY actor_user_id)`,
    ).bind(guild.id),
    ctx.db.prepare('SELECT id, name, archived FROM teams WHERE guild_id = ?').bind(guild.id),
  ]);
  const hasMore = !filters.csv && rowResult.results.length > AUDIT_PAGE;
  const page = hasMore ? rowResult.results.slice(0, AUDIT_PAGE) : rowResult.results;
  const parsed = page.map((row) => ({
    id: row.id, at: row.created_at, actor: row.actor_user_id, action: row.action, entityType: row.entity_type, entityId: row.entity_id,
    before: parseJson(row.before), after: parseJson(row.after),
  }));
  const names = await loadNames(ctx.db, guild.id, collectRefs(parsed), teamResult.results);
  const rows = parsed.map((row) => ({
    id: row.id,
    at: row.at,
    actor: row.actor && names.users.has(row.actor) ? { id: row.actor, displayName: names.users.get(row.actor) } : null,
    action: row.action,
    group: groupOf(row.action),
    text: describeRow(row, names),
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before,
    after: row.after,
  }));

  if (filters.csv) {
    const headers = new Headers(SECURITY_HEADERS);
    headers.set('Content-Type', 'text/csv; charset=utf-8');
    headers.set('Content-Disposition', `attachment; filename="raidsmith-activity-${slugOf(guild.name)}-${todayIn(guild.time_zone, ctx.now())}.csv"`);
    return new Response(auditCsv(rows, guild.time_zone), { status: 200, headers });
  }
  const last = page[page.length - 1];
  return jsonResponse({
    timeZone: guild.time_zone,
    rows,
    next: hasMore && last ? `${last.created_at}:${last.id}` : null,
    types: AUDIT_GROUPS,
    actors: actorResult.results.map((row) => ({ id: row.id, displayName: userName(row) })).sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)),
  });
}
