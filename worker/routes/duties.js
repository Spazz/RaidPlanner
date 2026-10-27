// Raid duties: the officer-set jobs of one raid (Raid leader, Loot master, Logger, Plan maker and one free-text extra).
//   GET /api/guild/:gid/raids/:rid/duties   (raids.edit on the raid's team)  { duties, previous }: this raid's duties and those of the team's latest earlier raid that had any
//   PUT /api/guild/:gid/raids/:rid/duties   (raids.edit)  { duties: [{ duty, personId, label? }] }: replaces them all; [] clears. -> the raid detail (its `duties`)
// The raid detail carries the duties for everyone who can see the raid (worker/attendance-view.js).
import { HttpError, jsonResponse } from '../http.js';
import { wrote } from '../d1-changes.js';
import { loadDuties, readDuties } from '../duties.js';
import { loadGuildContext } from '../permissions.js';
import { loadRaid, raidAudit, raidReply } from './raids.js';
import { bad } from './roster.js';

export async function getDuties(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const guildId = guildContext.guild.id;
  const [duties, earlier] = await Promise.all([
    loadDuties(ctx.db, guildId, raid.id),
    ctx.db.prepare(
      `SELECT r.id FROM raids r WHERE r.guild_id = ? AND r.team_id = ? AND r.id != ? AND r.starts_at < ? AND EXISTS (SELECT 1 FROM raid_duties d WHERE d.raid_id = r.id)
        ORDER BY r.starts_at DESC, r.id DESC LIMIT 1`,
    ).bind(guildId, raid.team_id, raid.id, raid.starts_at).first(),
  ]);
  return jsonResponse({ duties, previous: earlier ? await loadDuties(ctx.db, guildId, earlier.id) : [] });
}

export async function putDuties(ctx) {
  const { db } = ctx;
  const rows = readDuties(ctx.body.duties);
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const ids = [...new Set(rows.map((row) => row.personId))];
  if (ids.length) {
    const found = await db.prepare('SELECT COUNT(*) AS n FROM players WHERE guild_id = ? AND id IN (SELECT value FROM json_each(?))').bind(guild.id, JSON.stringify(ids)).first('n');
    if (found !== ids.length) throw bad('Someone in that list is not on this guild\'s roster.', 'duties');
  }
  const before = await db.prepare('SELECT COUNT(*) AS n FROM raid_duties WHERE raid_id = ?').bind(raid.id).first('n');
  const guard = { sql: 'EXISTS (SELECT 1 FROM raids WHERE id = ? AND guild_id = ?)', params: [raid.id, guild.id] };
  const results = await db.batch([
    db.prepare('DELETE FROM raid_duties WHERE raid_id = ? AND guild_id = ?').bind(raid.id, guild.id),
    db.prepare(
      `INSERT INTO raid_duties (raid_id, guild_id, duty, player_id, label)
       SELECT ?, ?, json_extract(value, '$.duty'), json_extract(value, '$.personId'), json_extract(value, '$.label') FROM json_each(?) WHERE ${guard.sql}`,
    ).bind(raid.id, guild.id, JSON.stringify(rows), ...guard.params),
    raidAudit(ctx, guildContext, 'duties.set', raid.id, { duties: before }, { duties: rows.map((row) => row.duty) }, guard),
  ]);
  // One INSERT ... SELECT under one guard: every row or none, so "nothing written" is the whole question (a list of no rows writes nothing and has nothing to refuse).
  if (rows.length && !wrote(results[1])) throw new HttpError(409, 'conflict', 'The raid changed. Reload and try again.');
  return raidReply(ctx, guildContext, raid.id);
}
