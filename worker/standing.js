// Standing sign-ups: "I'm in for every <weekday> raid of team X". A member keeps one standing entry per weekday of the team's schedule (standing_signups); this
// module turns those entries into ordinary Raidsmith sign-ups (raid_signups.standing = 1) on the team's UPCOMING raids of that weekday, and takes them away
// again. planStanding is the pure rule; reconcileStanding reads, plans and writes in one pass and can be called from anywhere, any number of times: running it
// twice changes nothing the second time.
//
// The rules, per upcoming raid of a team and per standing entry of that team on the raid's weekday:
//   - the person has NO sign-up on the raid, of either source, and no Away notice covers its date -> a Raidsmith sign-up is created (standing = 1);
//   - a Raidsmith row with standing = 1 exists and the entry is gone, or an Away notice now covers the raid, or the person cannot be signed up any more
//     (inactive, or no character on the team) -> the row is deleted; if the entry's kind or character changed, the row follows it;
//   - a row with standing = 0 (the member edited it: every write of the sign-up routes resets the flag) and any Raid-Helper row are never touched.
// The lock and the deadline are for members' own writes: the system ignores them, but it never touches a raid that has started.
// Taking a standing row away through the sign-up routes (DELETE .../signup, DELETE .../signups/:pid) turns it into the person's explicit Absence
// (standing = 0), so nothing here brings it back. A row the member made by hand and deleted is gone for real: it can be made again by the next event that
// reconciles that raid while the standing entry exists (PUT standing, a schedule fill, a new raid, an Away notice change, a Raid-Helper link or unlink) - the
// create side only runs on those events and only for a person with no sign-up at all.
import { weekdayOf } from './attendance-calendar.js';
import { displayCharacter } from './attendance-view.js';
import { noticeCovers, noticeOfRow } from './away.js';
import { recomputeRaid } from './attendance-store.js';
import { isSpecOf } from './roster-data.js';
import { raidHelperClassName, raidHelperSpecKey } from './signups-data.js';

export const STANDING_KINDS = ['signed', 'late'];
const CHUNK = 100;           // rows per statement (the rows travel as one JSON text)
const RAID_SCAN_LIMIT = 2000;
const RECOMPUTE_LIMIT = 20;  // raids with a log or hand-entered attendance recalculated in the request; the rest keep the stale mark

// The character a standing entry signs up with on a team: the chosen one while it is still the person's and on that team, else the person's usual one there.
export function standingCharacter(entry, teamId, characters) {
  const onTeam = characters.filter((character) => character.team_id === teamId);
  const chosen = entry.characterId ? onTeam.find((character) => character.id === entry.characterId) : null;
  return chosen || displayCharacter(onTeam, teamId);
}

// The Raid-Helper-worded columns of a standing sign-up of `character`: class name and spec key (its main spec, when that is a spec of the class).
function wording(character) {
  const spec = character.main_spec && isSpecOf(character.class, character.main_spec) ? character.main_spec : null;
  return { className: raidHelperClassName(character.class), specName: spec ? raidHelperSpecKey(character.class, spec) : null };
}

// input: {
//   entries   [{ teamId, personId, weekday, kind, characterId }]                 the standing entries in scope
//   raids     [{ id, teamId, raidOn }]                                           the upcoming raids in scope
//   signups   [{ raidId, personId, source, standing, kind, characterId }]        the people's real sign-ups on those raids (both sources)
//   notices   [{ personId, from, to, weekday }]                                  the Away-kind notices of the people with entries
//   statuses  Map personId -> 'raider' | 'trial' | 'reserve' | 'inactive'
//   characters Map personId -> [character rows { id, team_id, name, class, main_spec, off_spec, is_main }]
// } -> { creates: [{ raidId, personId, kind, characterId, className, specName }], updates: [same], deletes: [{ raidId, personId }] }
export function planStanding({ entries, raids, signups, notices, statuses, characters }) {
  const entryAt = new Map(entries.map((entry) => [`${entry.teamId}|${entry.personId}|${entry.weekday}`, entry]));
  const byTeamDay = new Map();
  for (const entry of entries) {
    const key = `${entry.teamId}|${entry.weekday}`;
    if (!byTeamDay.has(key)) byTeamDay.set(key, []);
    byTeamDay.get(key).push(entry);
  }
  const have = new Map();
  for (const row of signups) {
    const key = `${row.raidId}|${row.personId}`;
    if (!have.has(key)) have.set(key, { raidsmith: null, raidHelper: false });
    if (row.source === 'raidsmith') have.get(key).raidsmith = row;
    else have.get(key).raidHelper = true;
  }
  const noticesOf = new Map();
  for (const notice of notices) {
    if (!noticesOf.has(notice.personId)) noticesOf.set(notice.personId, []);
    noticesOf.get(notice.personId).push(notice);
  }
  const creates = [];
  const updates = [];
  const deletes = [];
  const gone = new Set();
  const drop = (raidId, personId) => {
    if (gone.has(`${raidId}|${personId}`)) return;
    gone.add(`${raidId}|${personId}`);
    deletes.push({ raidId, personId });
  };

  for (const raid of raids) {
    const weekday = weekdayOf(raid.raidOn);
    for (const entry of byTeamDay.get(`${raid.teamId}|${weekday}`) || []) {
      const existing = have.get(`${raid.id}|${entry.personId}`) || { raidsmith: null, raidHelper: false };
      const covered = (noticesOf.get(entry.personId) || []).some((notice) => noticeCovers(notice, raid.raidOn));
      const character = (statuses.get(entry.personId) || 'inactive') === 'inactive' ? null : standingCharacter(entry, raid.teamId, characters.get(entry.personId) || []);
      const usable = !!character && !covered;
      const ours = existing.raidsmith && existing.raidsmith.standing === 1 ? existing.raidsmith : null;
      if (ours) {
        if (!usable) drop(raid.id, entry.personId);
        else if (ours.kind !== entry.kind || ours.characterId !== character.id) updates.push({ raidId: raid.id, personId: entry.personId, kind: entry.kind, characterId: character.id, ...wording(character) });
      } else if (!existing.raidsmith && !existing.raidHelper && usable) {
        creates.push({ raidId: raid.id, personId: entry.personId, kind: entry.kind, characterId: character.id, ...wording(character) });
      }
    }
  }
  // A standing row whose entry is gone (the member turned that weekday off, or the raid moved to another weekday).
  const teamOf = new Map(raids.map((raid) => [raid.id, raid]));
  for (const row of signups) {
    if (row.source !== 'raidsmith' || row.standing !== 1) continue;
    const raid = teamOf.get(row.raidId);
    if (raid && !entryAt.has(`${raid.teamId}|${row.personId}|${weekdayOf(raid.raidOn)}`)) drop(row.raidId, row.personId);
  }
  return { creates, updates, deletes };
}

// Reads, plans and writes. scope: { teamIds?, personId?, raidIds? } - each narrows what is looked at (left out = everything). -> { created, updated, deleted }
export async function reconcileStanding(ctx, guild, { teamIds = null, personId = null, raidIds = null } = {}) {
  const { db } = ctx;
  const now = ctx.now();
  const teamJson = teamIds ? JSON.stringify(teamIds) : null;
  const raidJson = raidIds ? JSON.stringify(raidIds) : null;
  // ?1 guild, ?2 now, ?3 teams (JSON or NULL), ?4 raids (JSON or NULL), ?5 person (or NULL)
  const args = [guild.id, now, teamJson, raidJson, personId];
  const RAIDS_IN_SCOPE = `SELECT id FROM raids WHERE guild_id = ?1 AND starts_at > ?2 AND (?3 IS NULL OR team_id IN (SELECT value FROM json_each(?3)))
                             AND (?4 IS NULL OR id IN (SELECT value FROM json_each(?4)))`;
  const ENTRIES_IN_SCOPE = 'SELECT player_id FROM standing_signups WHERE guild_id = ?1 AND (?3 IS NULL OR team_id IN (SELECT value FROM json_each(?3))) AND (?5 IS NULL OR player_id = ?5)';
  // A statement binds exactly as many values as its highest numbered placeholder.
  const scoped = (sql) => db.prepare(sql).bind(...args.slice(0, Math.max(...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])))));
  const [entryResult, raidResult, signupResult, noticeResult, characterResult] = await db.batch([
    scoped(
      `SELECT team_id, player_id, weekday, kind, character_id FROM standing_signups
        WHERE guild_id = ?1 AND (?3 IS NULL OR team_id IN (SELECT value FROM json_each(?3))) AND (?5 IS NULL OR player_id = ?5)
          AND (?4 IS NULL OR team_id IN (SELECT team_id FROM raids WHERE id IN (SELECT value FROM json_each(?4))))`,
    ),
    scoped(
      `SELECT r.id, r.team_id, r.raid_on, r.log_mode, (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports FROM raids r
        WHERE r.id IN (${RAIDS_IN_SCOPE}) ORDER BY r.starts_at, r.id LIMIT ${RAID_SCAN_LIMIT}`,
    ),
    scoped(
      `SELECT raid_id, player_id, source, standing, kind, character_id FROM raid_signups
        WHERE source IN ('raid_helper', 'raidsmith') AND player_id IS NOT NULL AND (?5 IS NULL OR player_id = ?5) AND raid_id IN (${RAIDS_IN_SCOPE})`,
    ),
    scoped(
      `SELECT id, player_id, kind, at_time, starts_on, ends_on, weekday, created_at FROM away_notices
        WHERE guild_id = ?1 AND kind = 'away' AND player_id IN (${ENTRIES_IN_SCOPE})`,
    ),
    scoped(
      `SELECT c.id, c.player_id, c.team_id, c.name, c.class, c.main_spec, c.off_spec, c.is_main, p.status FROM characters c JOIN players p ON p.id = c.player_id
        WHERE c.guild_id = ?1 AND c.player_id IN (${ENTRIES_IN_SCOPE})`,
    ),
  ]);
  const characters = new Map();
  const statuses = new Map();
  for (const row of characterResult.results) {
    if (!characters.has(row.player_id)) characters.set(row.player_id, []);
    characters.get(row.player_id).push(row);
    statuses.set(row.player_id, row.status);
  }
  const plan = planStanding({
    entries: entryResult.results.map((row) => ({ teamId: row.team_id, personId: row.player_id, weekday: row.weekday, kind: row.kind, characterId: row.character_id })),
    raids: raidResult.results.map((row) => ({ id: row.id, teamId: row.team_id, raidOn: row.raid_on })),
    signups: signupResult.results.map((row) => ({ raidId: row.raid_id, personId: row.player_id, source: row.source, standing: row.standing, kind: row.kind, characterId: row.character_id })),
    notices: noticeResult.results.map(noticeOfRow),
    statuses,
    characters,
  });
  const { creates, updates, deletes } = plan;
  if (!creates.length && !updates.length && !deletes.length) return { created: 0, updated: 0, deleted: 0 };

  const guard = { sql: 'EXISTS (SELECT 1 FROM raids WHERE raids.id = raid_signups.raid_id AND raids.starts_at > ?)' }; // never a raid that has started
  const statements = [];
  for (let i = 0; i < deletes.length; i += CHUNK) {
    statements.push(db.prepare(
      `DELETE FROM raid_signups WHERE source = 'raidsmith' AND standing = 1 AND ${guard.sql}
          AND EXISTS (SELECT 1 FROM json_each(?) j WHERE json_extract(j.value, '$.raidId') = raid_signups.raid_id AND json_extract(j.value, '$.personId') = raid_signups.player_id)`,
    ).bind(now, JSON.stringify(deletes.slice(i, i + CHUNK))));
  }
  for (let i = 0; i < updates.length; i += CHUNK) {
    statements.push(db.prepare(
      `UPDATE raid_signups SET kind = u.kind, character_id = u.character_id, class_name = u.class_name, spec_name = u.spec_name, updated_at = ?
         FROM (SELECT json_extract(value, '$.raidId') AS raid_id, json_extract(value, '$.personId') AS person_id, json_extract(value, '$.kind') AS kind,
                      json_extract(value, '$.characterId') AS character_id, json_extract(value, '$.className') AS class_name, json_extract(value, '$.specName') AS spec_name
                 FROM json_each(?)) u
        WHERE raid_signups.raid_id = u.raid_id AND raid_signups.player_id = u.person_id AND raid_signups.source = 'raidsmith' AND raid_signups.standing = 1 AND ${guard.sql}`,
    ).bind(now, JSON.stringify(updates.slice(i, i + CHUNK)), now));
  }
  for (let i = 0; i < creates.length; i += CHUNK) {
    // Never replaces a row: it only goes in for a person with no sign-up of either source (the partial unique index would refuse a second Raidsmith one anyway).
    // Sign-up ids continue the raid's own count; ROW_NUMBER keeps the rows of one raid apart inside the statement.
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, standby, class_name, spec_name, position, guild_id, player_id,
                                           character_id, note, updated_by, created_at, updated_at, standing)
       SELECT j.raid_id, 'raidsmith', base.top + j.n, NULL, NULL, j.kind, 0, j.class_name, j.spec_name, base.top + j.n, ?, j.person_id, j.character_id, NULL, NULL, ?, ?, 1
         FROM (SELECT json_extract(value, '$.raidId') AS raid_id, json_extract(value, '$.personId') AS person_id, json_extract(value, '$.kind') AS kind,
                      json_extract(value, '$.characterId') AS character_id, json_extract(value, '$.className') AS class_name, json_extract(value, '$.specName') AS spec_name,
                      ROW_NUMBER() OVER (PARTITION BY json_extract(value, '$.raidId') ORDER BY json_extract(value, '$.personId')) AS n
                 FROM json_each(?)) j
         JOIN (SELECT id AS raid_id, (SELECT COALESCE(MAX(signup_id), 0) FROM raid_signups x WHERE x.raid_id = raids.id AND x.source = 'raidsmith') AS top
                 FROM raids WHERE guild_id = ? AND starts_at > ?) base ON base.raid_id = j.raid_id
        WHERE NOT EXISTS (SELECT 1 FROM raid_signups y WHERE y.raid_id = j.raid_id AND y.player_id = j.person_id AND y.source IN ('raid_helper', 'raidsmith'))`,
    ).bind(guild.id, now, now, JSON.stringify(creates.slice(i, i + CHUNK)), guild.id, now));
  }
  // The results of the raids that changed are out of date, and no recompute that read the old sign-ups may write over that.
  const changed = [...new Set([...creates, ...updates, ...deletes].map((row) => row.raidId))];
  statements.push(db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE guild_id = ? AND id IN (SELECT value FROM json_each(?))").bind(guild.id, JSON.stringify(changed)));
  await db.batch(statements);

  // A raid with a log or hand-entered attendance has results that depend on its sign-ups; an ordinary upcoming one has none to update yet.
  const evidence = raidResult.results.filter((row) => changed.includes(row.id) && (row.reports > 0 || row.log_mode === 'manual')).slice(0, RECOMPUTE_LIMIT);
  for (const row of evidence) await recomputeRaid(ctx, guild, row.id);
  return { created: creates.length, updated: updates.length, deleted: deletes.length };
}

// A real Raid-Helper sign-up wins over a standing one: for the statement list of an event link, removes the standing Raidsmith rows of the people who now
// have a Raid-Helper row on the raid. guard: { sql, params } makes it conditional on the write that came before.
export function removeStandingOverRaidHelper(db, raidId, guard) {
  return db.prepare(
    `DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND standing = 1
        AND player_id IN (SELECT player_id FROM raid_signups WHERE raid_id = ? AND source = 'raid_helper' AND player_id IS NOT NULL) AND ${guard.sql}`,
  ).bind(raidId, raidId, ...guard.params);
}
