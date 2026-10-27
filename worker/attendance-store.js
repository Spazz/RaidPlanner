import { guestIdentityStatement, guestKeysFor } from './guest-identity.js';
// Attendance I/O: the only place that turns D1 rows into the pure modules' input and writes their results back.
// The pure modules (attendance-calendar / -policy / -consolidate / -metrics) never see the database.
import { consolidateRaid, resolveFillIns } from './attendance-consolidate.js';
import { attendanceAwaySignups, noticeOfRow } from './away.js';
import { localDate, weekStartsByResetDay } from './attendance-calendar.js';
import { REGION_RESET_DAY, consolidationFingerprint, regionResetDay, resolvePolicy } from './attendance-policy.js';
import { resolvedNameKeySql } from './name-alias.js';
import { allows } from './permissions.js';
import { characterOfRow } from './person-rank.js';
import { trialClockStatement, zoneOffsetMinutes } from './trial-clock.js';

export const SIGNUP_KINDS = ['signed', 'late', 'standby', 'bench', 'tentative', 'absence'];

// ---------------------------------------------------------------------------
// Policy rows -> resolved policies

function parseJson(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

export function policyRowsStatement(db, guildId) {
  return db.prepare('SELECT id, team_id, policy, version FROM attendance_policies WHERE guild_id = ?').bind(guildId);
}

// rows: attendance_policies rows of one guild -> { guild, teams, versions, resolved(teamId), fingerprint(teamId), resetDay }
export function makePolicyResolver(guild, rows) {
  const overrides = { guild: {}, teams: {} };
  const versions = { guild: 0, teams: {} };
  const ids = { guild: null, teams: {} };
  for (const row of rows) {
    const value = parseJson(row.policy, {});
    const override = isPlainObject(value) ? value : {};
    if (row.team_id) {
      overrides.teams[row.team_id] = override;
      versions.teams[row.team_id] = row.version;
      ids.teams[row.team_id] = row.id;
    } else {
      overrides.guild = override;
      versions.guild = row.version;
      ids.guild = row.id;
    }
  }
  const cache = new Map();
  const resolved = (teamId) => {
    if (!cache.has(teamId)) cache.set(teamId, resolvePolicy(overrides.guild, overrides.teams[teamId] || {}, guild.region));
    return cache.get(teamId);
  };
  const guildResolved = () => resolved(null);
  return {
    ...overrides,
    overrides,
    versions,
    ids,
    resolved,
    fingerprint: (teamId) => consolidationFingerprint(resolved(teamId)),
    // The reset day is a guild setting: null means "from the region".
    resetDay() {
      const value = guildResolved().resetDay;
      return Number.isInteger(value) ? value : (REGION_RESET_DAY[guild.region] ?? 2);
    },
  };
}

export async function loadPolicyResolver(db, guild) {
  const result = await policyRowsStatement(db, guild.id).all();
  return makePolicyResolver(guild, result.results);
}

// ---------------------------------------------------------------------------
// Stale marking (rules or roster changed under stored results)

// A raid that holds any evidence a roster change can move: results, sign-ups, a plan, manual ticks or a log.
export const HAS_EVIDENCE = `(raids.log_mode = 'manual'
    OR EXISTS (SELECT 1 FROM attendance x WHERE x.raid_id = raids.id)
    OR EXISTS (SELECT 1 FROM raid_signups x WHERE x.raid_id = raids.id)
    OR EXISTS (SELECT 1 FROM raid_plan x WHERE x.raid_id = raids.id)
    OR EXISTS (SELECT 1 FROM raid_manual x WHERE x.raid_id = raids.id)
    OR EXISTS (SELECT 1 FROM raid_reports x WHERE x.raid_id = raids.id))`;

// A name stored on a raid (a log line, a pasted roster, a plan seat) counts for the character that carried it when the raid was held (worker/name-alias.js): the
// stored key turned into the key the characters carry today. A logged or pasted name is queried as `rp` (raid_presence or raid_manual_names) and a plan seat as
// `pl` (raid_plan), each with its raid joined as `pr`; a plan seat has a name only (no realm, no guild_id), so its guild is the raid's.
const PRESENCE_KEY = resolvedNameKeySql({ guild: 'rp.guild_id', nameKey: 'rp.name_key', realmKey: 'rp.realm_key', at: 'pr.starts_at' });
const MANUAL_KEY = PRESENCE_KEY;
const PLAN_KEY = resolvedNameKeySql({ guild: 'pr.guild_id', nameKey: 'pl.name_key', at: 'pr.starts_at' });
// The same two for the other readers of a raid's stored names (attendance-view.js, routes/attendance.js).
export const EVIDENCE_NAME_KEY = PRESENCE_KEY;
export const PLAN_NAME_KEY = PLAN_KEY;

// The marking statements below never scan a guild's whole log (raid_presence is the biggest table): they start from the stored names that could be meant
// (the raid_presence_name index) and only then apply the date-aware rule. The names that could be meant by some live keys are the keys themselves and the old
// names (aliases) of the characters that carry them now.
const MARKED_KEY = resolvedNameKeySql({
  guild: 'rp.guild_id', nameKey: 'rp.name_key', realmKey: 'rp.realm_key', at: '(SELECT sr.starts_at FROM raids sr WHERE sr.id = rp.raid_id)',
});
const storedNamesOf = (liveKeysSql) => `${liveKeysSql} UNION SELECT nal.name_key FROM character_name_aliases nal
          JOIN characters nlc ON nlc.guild_id = nal.guild_id AND nlc.id = nal.character_id WHERE nal.guild_id = ?1 AND nlc.name_key IN (${liveKeysSql})`;
// The raids whose log names these characters, by the key they are given under or by the name they carried when the raid was logged (a rename marks the raids
// logged under the old name and under the new one).
const loggedUnder = (keysSql) => `SELECT rp.raid_id FROM raid_presence rp
          WHERE rp.guild_id = ?1 AND rp.name_key IN (${storedNamesOf(keysSql)}) AND (rp.name_key IN (${keysSql}) OR ${MARKED_KEY} IN (${keysSql}))`;

// THE FREEZE (user decision 2026-10-26): a raid whose attendance week is over keeps its result when the roster changes. A roster edit marks a raid stale when its week is
// still running (this week's and later raids) or when its log names one of the changed characters (the first clause of both statements below, whatever the age). The
// team-wide clause, "every raid of the team that holds evidence", is the one the freeze limits. The rules are different: a policy edit stales every raid by fingerprint
// (worker/attendance-view.js), and the "Recalculate" action (POST .../recompute) works on any raid, frozen or not.
// The week is the guild's reset week (worker/attendance-calendar.js weekStart): its first day depends on the reset day, which lives in the guild's policy row (else the
// region's day), so the JS side hands over the first day of the current week for each of the seven reset days and the statement picks the guild's own.
export const NO_FREEZE = Object.freeze({ starts: JSON.stringify(new Array(7).fill('0000-00-00')) }); // every raid is "still running": the unfrozen marking

// { starts } for a guild-local clock: the freeze line of a statement. timeZone: the guild's IANA zone, nowMs: the request's clock (ctx.now()).
export function weekFreeze(timeZone, nowMs) {
  return { starts: JSON.stringify(weekStartsByResetDay(localDate(nowMs, timeZone))) };
}

// SQL: the guild's reset day, from rows only (mirrors makePolicyResolver().resetDay()): its guild policy row's resetDay, else the region's day. `guildSql` is the guild id
// (a placeholder). A value that is not a whole number from 0 to 6 reads as "from the region" (a policy row is always valid JSON: the table checks it).
const REGION_DAY_CASE = `CASE g.region ${Object.entries(REGION_RESET_DAY).map(([region, day]) => `WHEN '${region}' THEN ${day}`).join(' ')} ELSE ${regionResetDay('')} END`;
export const resetDaySql = (guildSql) => `(SELECT COALESCE(
      (SELECT CASE WHEN json_type(p.policy, '$.resetDay') = 'integer' AND json_extract(p.policy, '$.resetDay') BETWEEN 0 AND 6 THEN json_extract(p.policy, '$.resetDay') END
         FROM attendance_policies p WHERE p.guild_id = g.id AND p.team_id IS NULL),
      ${REGION_DAY_CASE})
    FROM guilds g WHERE g.id = ${guildSql})`;

// SQL: the raid's attendance week is still running. `startsSql` is the placeholder of weekFreeze().starts, `guildSql` the placeholder of the guild id.
export const weekRunningSql = (startsSql, guildSql) => `raids.raid_on >= json_extract(${startsSql}, '$[' || ${resetDaySql(guildSql)} || ']')`;

// One UPDATE for a db.batch: every raid whose log names one of these characters, and every raid of these teams that holds evidence and whose week is still running
// (a roster change moves "expected" and the team's rows without any presence), keeps its results but is marked for recalculation.
// The version bump makes a recompute that read the old roster discard its write. Callers skip it when there is nothing to mark.
const MARK_STALE_SQL = `UPDATE raids SET policy_fp = '', version = version + 1
      WHERE guild_id = ?1 AND id != ?2
        AND (id IN (${loggedUnder('SELECT value FROM json_each(?3)')})
             OR (team_id IN (SELECT value FROM json_each(?4)) AND ${HAS_EVIDENCE} AND ${weekRunningSql('?5', '?1')}))`;
// (The person's characters are read through characters_player: given only "guild_id = ? AND player_id = ?" the planner walks the whole guild by characters_guild_id.)
const MARK_PERSON_STALE_SQL = `UPDATE raids SET policy_fp = '', version = version + 1
      WHERE guild_id = ?1
        AND (id IN (${loggedUnder('SELECT name_key FROM characters INDEXED BY characters_player WHERE guild_id = ?1 AND player_id = ?2')})
             OR (team_id IN (SELECT team_id FROM characters INDEXED BY characters_player WHERE guild_id = ?1 AND player_id = ?2) AND ${HAS_EVIDENCE} AND ${weekRunningSql('?3', '?1')}))`;

// `guard` ({ sql, params }, optional) is another condition of the write: a batch whose statements all carry one marks nothing when it fails. The two statements number
// their placeholders (?1-?5 and ?1-?3), so the guard's anonymous ones are numbered on after them (D1 does not mix the two forms).
// `freeze` (weekFreeze(guild.time_zone, ctx.now())) limits the team-wide clause to the raids whose week is still running; left out, nothing is frozen.
const guardedAfter = (guard, last) => {
  let next = last;
  return { sql: guard.sql.replace(/[?]/g, () => `?${++next}`), params: guard.params };
};

export function markRaidsStale(db, guildId, nameKeys, exceptRaidId = null, teamIds = [], guard = null, freeze = NO_FREEZE) {
  const values = [guildId, exceptRaidId || '', JSON.stringify([...new Set(nameKeys)]), JSON.stringify([...new Set(teamIds)]), freeze.starts];
  if (!guard) return db.prepare(MARK_STALE_SQL).bind(...values);
  const numbered = guardedAfter(guard, 5);
  return db.prepare(MARK_STALE_SQL + ' AND ' + numbered.sql).bind(...values, ...numbered.params);
}

// A person's status, join date or Discord link changed: every raid of every team they have a character on whose week is still running (the freeze), plus the raids naming them.
export function markPersonRaidsStale(db, guildId, playerId, guard = null, freeze = NO_FREEZE) {
  if (!guard) return db.prepare(MARK_PERSON_STALE_SQL).bind(guildId, playerId, freeze.starts);
  const numbered = guardedAfter(guard, 3);
  return db.prepare(MARK_PERSON_STALE_SQL + ' AND ' + numbered.sql).bind(guildId, playerId, freeze.starts, ...numbered.params);
}

// Raid-Helper sign-ups nobody is linked to take this person: every row of the guild with the Discord ID, or (a sign-up without one) just that one row.
// `extra` ({ sql, params }, optional) is another condition of the write (the Seniority guard of a relink): the sign-ups follow the person only while it holds.
export function linkSignupsStatement(db, guildId, playerId, discordId, raidId, signupId, extra = null) {
  // The statement numbers its placeholders (?1-?5), so the extra condition's anonymous ones are numbered on from ?6 (D1 does not mix the two forms).
  let next = 5;
  const guard = extra ? { sql: extra.sql.replace(/[?]/g, () => `?${++next}`), params: extra.params } : { sql: '1 = 1', params: [] };
  return db.prepare(
    `UPDATE raid_signups SET player_id = ?1
      WHERE guild_id = ?2 AND source = 'raid_helper' AND player_id IS NULL
        AND (CASE WHEN ?3 IS NOT NULL THEN discord_user_id = ?3 ELSE (raid_id = ?4 AND signup_id = ?5) END) AND ${guard.sql}`,
  ).bind(playerId, guildId, discordId, raidId, signupId, ...guard.params);
}

// Input writes put this in their own batch: the raid's results are out of date and no in-flight recompute may write over that.
export function bumpRaidStatement(db, guildId, raidId) {
  return db.prepare("UPDATE raids SET policy_fp = '', version = version + 1 WHERE id = ? AND guild_id = ?").bind(raidId, guildId);
}

// The other raids of this raid's date lose or gain a neighbour: stale and re-versioned. `guard` ({ sql, params }) makes it conditional.
export function bumpDayStatement(db, guildId, raidOn, exceptRaidId, guard = null) {
  const sql = "UPDATE raids SET policy_fp = '', version = version + 1 WHERE guild_id = ? AND raid_on = ? AND id != ?";
  if (!guard) return db.prepare(sql).bind(guildId, raidOn, exceptRaidId);
  return db.prepare(sql + ' AND ' + guard.sql).bind(guildId, raidOn, exceptRaidId, ...guard.params);
}

// ---------------------------------------------------------------------------
// Nav badge

// { [teamId]: n } for the active teams the viewer can review; {} for everyone else. n counts open FLAGS (the unit the Review queue's header and the
// Home list use), not the raids that carry them.
export async function loadAttendanceFlags(db, guildContext) {
  const scope = guildContext.can['attendance.review'];
  if (!scope || (Array.isArray(scope) && !scope.length)) return {};
  const guildId = guildContext.guild.id;
  const [teamResult, countResult] = await db.batch([
    db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guildId),
    db.prepare('SELECT team_id, SUM(open_flags) AS n FROM raids WHERE guild_id = ? AND open_flags > 0 GROUP BY team_id').bind(guildId),
  ]);
  const flags = {};
  for (const team of teamResult.results) {
    if (allows(guildContext.can, 'attendance.review', team.id)) flags[team.id] = 0;
  }
  for (const row of countResult.results) {
    if (flags[row.team_id] !== undefined) flags[row.team_id] = row.n;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Evidence: everything the pure modules need for the guild-local date of one raid (all teams of the guild)

// The raids of the guild on the date of raid ?2. Bound with (guildId, raidId).
const DAY_CTE = `WITH day AS (
  SELECT id FROM raids WHERE guild_id = ?1 AND raid_on = (SELECT raid_on FROM raids WHERE id = ?2 AND guild_id = ?1))`;

export async function loadDay(db, guildId, raidId) {
  const bind = (sql) => db.prepare(DAY_CTE + ' ' + sql).bind(guildId, raidId);
  const [, raidResult, policyResult, signupResult, planResult, pullResult, presenceResult, manualResult, guestResult, decisionResult, characterResult, noticeResult, manualNameResult] = await db.batch([
    // Sign-ups whose Discord ID had no person at ingest are linked now if one has appeared since.
    bind(`UPDATE raid_signups SET player_id = (SELECT p.id FROM players p WHERE p.guild_id = raid_signups.guild_id AND p.discord_user_id = raid_signups.discord_user_id)
           WHERE guild_id = ?1 AND raid_id IN (SELECT id FROM day) AND source = 'raid_helper' AND player_id IS NULL AND discord_user_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM players p WHERE p.guild_id = raid_signups.guild_id AND p.discord_user_id = raid_signups.discord_user_id)`),
    bind(`SELECT r.id, r.team_id, r.raid_on, r.starts_at, r.log_mode, r.policy_fp, r.version,
                 (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports
            FROM raids r WHERE r.id IN (SELECT id FROM day) ORDER BY r.id`),
    policyRowsStatement(db, guildId),
    // The kind is the effective one: a Raidsmith 'signed' with standby = 1 is a volunteer standby.
    bind(`SELECT raid_id, source, signup_id, CASE WHEN kind = 'signed' AND standby = 1 THEN 'standby' ELSE kind END AS kind, player_id FROM raid_signups
           WHERE raid_id IN (SELECT id FROM day) AND source != 'plan' AND player_id IS NOT NULL
             AND NOT (source = 'raid_helper' AND EXISTS (SELECT 1 FROM raid_signups n
               WHERE n.raid_id = raid_signups.raid_id AND n.rh_signup_id = raid_signups.signup_id))`),
    // Each stored name also carries match_name_key: the key the characters carry today (worker/name-alias.js), dated at the raid.
    bind(`SELECT pl.raid_id, pl.name, pl.name_key, pl.group_number, ${PLAN_KEY} AS match_name_key
            FROM raid_plan pl JOIN raids pr ON pr.id = pl.raid_id WHERE pl.raid_id IN (SELECT id FROM day) ORDER BY pl.rowid`),
    bind('SELECT id, raid_id, started_at, kill FROM raid_pulls WHERE raid_id IN (SELECT id FROM day)'),
    bind(`SELECT rp.pull_id, rp.raid_id, rp.name, rp.name_key, rp.realm, rp.realm_key, rp.class, ${PRESENCE_KEY} AS match_name_key
            FROM raid_presence rp JOIN raids pr ON pr.id = rp.raid_id WHERE rp.raid_id IN (SELECT id FROM day)`),
    bind('SELECT raid_id, player_id FROM raid_manual WHERE raid_id IN (SELECT id FROM day)'),
    guestIdentityStatement(db, guildId),
    bind('SELECT raid_id, player_id, outcome, credit, credit_id, reason, flags FROM attendance_decisions WHERE raid_id IN (SELECT id FROM day)'),
    // Every character of every person involved: on a team of the day, in a log, a sign-up, a manual tick, a stored row or the plan.
    // D1 allows at most 5 terms in one compound SELECT, so the people are gathered in two CTEs of at most 4 terms each.
    // The rank columns are the CHARACTER's (core_rank, left_on, trial dates): worker/person-rank.js turns them into the person's answers.
    bind(`, who_by_character AS (
            SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id IN (SELECT team_id FROM raids WHERE id IN (SELECT id FROM day))
            UNION SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN
              (SELECT ${PRESENCE_KEY} FROM raid_presence rp JOIN raids pr ON pr.id = rp.raid_id WHERE rp.raid_id IN (SELECT id FROM day))
            UNION SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN
              (SELECT ${MANUAL_KEY} FROM raid_manual_names rp JOIN raids pr ON pr.id = rp.raid_id WHERE rp.raid_id IN (SELECT id FROM day))
            UNION SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN
              (SELECT ${PLAN_KEY} FROM raid_plan pl JOIN raids pr ON pr.id = pl.raid_id WHERE pl.raid_id IN (SELECT id FROM day))),
          who_by_row AS (
            SELECT player_id FROM raid_signups WHERE raid_id IN (SELECT id FROM day) AND player_id IS NOT NULL
            UNION SELECT player_id FROM raid_manual WHERE raid_id IN (SELECT id FROM day)
            UNION SELECT player_id FROM attendance WHERE raid_id IN (SELECT id FROM day)
            UNION SELECT player_id FROM attendance_decisions WHERE raid_id IN (SELECT id FROM day))
          SELECT c.id, c.player_id, c.name_key, c.realm_key, c.team_id, c.is_main, c.core_rank, c.left_on, c.trial_start, c.trial_end, p.joined_on
            FROM characters c JOIN players p ON p.id = c.player_id
           WHERE c.guild_id = ?1 AND (c.player_id IN (SELECT player_id FROM who_by_character) OR c.player_id IN (SELECT player_id FROM who_by_row))`),
    // The Away notices that cover the day (worker/away.js): each one is one more, weakest, sign-up of its person for the raids of the day (consolidateDay).
    bind(`SELECT id, player_id, kind, at_time, starts_on, ends_on, weekday, created_at FROM away_notices
           WHERE guild_id = ?1 AND kind = 'away' AND starts_on <= (SELECT raid_on FROM raids WHERE id = ?2 AND guild_id = ?1)
             AND (ends_on IS NULL OR ends_on >= (SELECT raid_on FROM raids WHERE id = ?2 AND guild_id = ?1))`),
    // The names of a pasted roster that matched nobody when it was pasted (wave 8).
    bind(`SELECT rp.raid_id, rp.name, rp.name_key, rp.realm, rp.realm_key, ${MANUAL_KEY} AS match_name_key
            FROM raid_manual_names rp JOIN raids pr ON pr.id = rp.raid_id WHERE rp.raid_id IN (SELECT id FROM day)`),
  ]);
  return {
    raids: raidResult.results,
    policyRows: policyResult.results,
    signups: signupResult.results,
    plan: planResult.results,
    pulls: pullResult.results,
    presence: presenceResult.results,
    manual: manualResult.results,
    guests: guestResult.results,
    decisions: decisionResult.results,
    characters: characterResult.results,
    notices: noticeResult.results.map(noticeOfRow),
    manualNames: manualNameResult.results,
  };
}

const keyOf = (nameKeyValue, realmKeyValue) => `${nameKeyValue}|${realmKeyValue}`;

// Plan placements -> sign-up rows by character match (group 0 = bench, 1-8 = signed). An unmatched name has no person and no row.
function planSignups(raidId, plan, charactersByName, teamId) {
  const rows = [];
  plan.forEach((entry, index) => {
    // The seat's name as the characters carry it today (match_name_key, worker/name-alias.js); candidates in a fixed order, so the pick never depends on row order.
    const candidates = [...(charactersByName.get(entry.match_name_key || entry.name_key) || [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const pick = candidates.find((character) => character.team_id === teamId) || candidates[0];
    if (!pick) return;
    rows.push({ raidId, signupId: index + 1, position: index + 1, kind: entry.group_number === 0 ? 'bench' : 'signed', playerId: pick.player_id });
  });
  return rows;
}

// Builds the pure-module input per raid of the day and runs consolidation + the fill-in pass.
// -> { date, results: [{ raid, rows, unmatched, openFlags, planSignups, fingerprint }] }
export function consolidateDay(guild, loaded) {
  const resolver = makePolicyResolver(guild, loaded.policyRows);
  const people = new Map();
  const charactersByName = new Map();
  for (const row of loaded.characters) {
    // A person is their characters (worker/person-rank.js): no rank scalar is taken from whichever row came first.
    if (!people.has(row.player_id)) people.set(row.player_id, { playerId: row.player_id, joinedOn: row.joined_on, characters: [] });
    people.get(row.player_id).characters.push({ ...characterOfRow(row), key: keyOf(row.name_key, row.realm_key) });
    if (!charactersByName.has(row.name_key)) charactersByName.set(row.name_key, []);
    charactersByName.get(row.name_key).push(row);
  }

  const group = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.raid_id)) map.set(row.raid_id, []);
      map.get(row.raid_id).push(row);
    }
    return map;
  };
  const signupsBy = group(loaded.signups);
  // A person's Raidsmith sign-up replaces their Raid-Helper one (the merged list shows them once, and so does the attendance); the plan
  // is a third source that still ranks by the strongest kind.
  const signupsOf = (raidId) => {
    const rows = signupsBy.get(raidId) || [];
    const native = new Set(rows.filter((row) => row.source === 'raidsmith').map((row) => row.player_id));
    return native.size ? rows.filter((row) => !(row.source === 'raid_helper' && native.has(row.player_id))) : rows;
  };
  const planBy = group(loaded.plan);
  const pullsBy = group(loaded.pulls);
  const manualBy = group(loaded.manual);
  const manualNamesBy = group(loaded.manualNames || []);
  const decisionsBy = group(loaded.decisions);
  const keysByPull = new Map();
  const logPlayersByRaid = new Map();
  // Every log or pasted name is keyed by the name the characters carry today (match_name_key), so a renamed character keeps its old raids.
  const evidenceKey = (row) => keyOf(row.match_name_key || row.name_key, row.realm_key);
  for (const row of loaded.presence) {
    if (!keysByPull.has(row.pull_id)) keysByPull.set(row.pull_id, []);
    keysByPull.get(row.pull_id).push(evidenceKey(row));
    if (!logPlayersByRaid.has(row.raid_id)) logPlayersByRaid.set(row.raid_id, {});
    logPlayersByRaid.get(row.raid_id)[evidenceKey(row)] = { name: row.name, realm: row.realm, class: row.class };
  }

  const results = loaded.raids.map((raid) => {
    const plan = planSignups(raid.id, planBy.get(raid.id) || [], charactersByName, raid.team_id);
    const decisions = {};
    for (const row of decisionsBy.get(raid.id) || []) {
      decisions[row.player_id] = { outcome: row.outcome, credit: row.credit, creditId: row.credit_id, reason: row.reason, flags: parseJson(row.flags, []) };
    }
    // An Away notice filed before the raid began is the weakest sign-up of the person it covers (only for a person on the raid's team who was in the guild
    // that day): it matters only when they have no other kind and are not in the log, and then the raid they missed is "missed with notice".
    const signups = [
      ...signupsOf(raid.id).map((row) => ({ playerId: row.player_id, kind: row.kind, source: row.source })),
      ...plan.map((row) => ({ playerId: row.playerId, kind: row.kind, source: 'plan' })),
      ...attendanceAwaySignups(loaded.notices || [], { raidOn: raid.raid_on, teamId: raid.team_id, startsAt: raid.starts_at }, [...people.values()]),
    ];
    const pasted = raid.log_mode === 'manual' ? (manualNamesBy.get(raid.id) || []) : [];
    const logPlayers = { ...(logPlayersByRaid.get(raid.id) || {}) };
    for (const row of pasted) logPlayers[evidenceKey(row)] = { name: row.name, realm: row.realm, class: null };
    const evidence = {
      raid: { id: raid.id, teamId: raid.team_id, raidOn: raid.raid_on, hasLog: raid.reports > 0, manual: raid.log_mode === 'manual' },
      people: [...people.values()],
      signups,
      pulls: (pullsBy.get(raid.id) || []).map((pull) => ({ startedAt: pull.started_at, kill: pull.kill === 1, keys: keysByPull.get(pull.id) || [] })),
      manualPresent: (manualBy.get(raid.id) || []).map((row) => row.player_id),
      guests: [...guestKeysFor(loaded.guests, raid.id)],
      decisions,
      logPlayers,
      manualKeys: pasted.map(evidenceKey),
    };
    const result = consolidateRaid(evidence, resolver.resolved(raid.team_id));
    return { raid, rows: result.rows, unmatched: result.unmatched, planSignups: plan, fingerprint: resolver.fingerprint(raid.team_id) };
  });

  const date = loaded.raids.length ? loaded.raids[0].raid_on : null;
  const adjusted = resolveFillIns(
    { raidOn: date, raids: results.map((entry) => ({ raidId: entry.raid.id, teamId: entry.raid.team_id, rows: entry.rows, unmatchedCount: entry.unmatched.length })) },
    (teamId) => resolver.resolved(teamId),
  );
  const adjustedBy = new Map(adjusted.raids.map((entry) => [entry.raidId, entry]));
  for (const entry of results) {
    const done = adjustedBy.get(entry.raid.id);
    entry.rows = done.rows;
    entry.openFlags = done.openFlags;
  }
  return { date, results };
}

const bit = (value) => (value ? 1 : 0);

function attendanceJson(entry) {
  return entry.rows.map((row) => {
    return {
      raidId: entry.raid.id,
      teamId: entry.raid.team_id,
      playerId: row.playerId,
      outcome: row.outcome,
      credit: row.credit === undefined ? null : row.credit,
      signupKind: row.signupKind || null,
      attended: bit(row.attended),
      presenceSource: row.presenceSource === 'officer' ? 'officer' : 'log',
      viaRaidId: row.viaRaidId || null,
      pullsPresent: row.pullsPresent || 0,
      pullsTotal: row.pullsTotal || 0,
      missedFirst: bit(row.missedFirst),
      missedLast: bit(row.missedLast),
      flags: JSON.stringify([...(row.flags || [])].sort()),
      creditTeamId: row.creditTeamId || null,
      needsReview: bit(row.needsReview),
    };
  });
}

const ATTENDANCE_INSERT = `INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, signup_kind, attended, presence_source, via_raid_id,
    pulls_present, pulls_total, missed_first, missed_last, flags, credit_team_id, needs_review)
  SELECT json_extract(value, '$.raidId'), ?, json_extract(value, '$.teamId'), json_extract(value, '$.playerId'), json_extract(value, '$.outcome'),
         json_extract(value, '$.credit'), json_extract(value, '$.signupKind'), json_extract(value, '$.attended'), json_extract(value, '$.presenceSource'),
         json_extract(value, '$.viaRaidId'), json_extract(value, '$.pullsPresent'), json_extract(value, '$.pullsTotal'), json_extract(value, '$.missedFirst'),
         json_extract(value, '$.missedLast'), json_extract(value, '$.flags'), json_extract(value, '$.creditTeamId'), json_extract(value, '$.needsReview')
    FROM json_each(?)`;

// The first statement of a recompute's write batch: fails the whole batch (CHECK attendance_stale on attendance_write_guard)
// when the raids of the date are not exactly the ones, at the versions, the recompute read.
function versionGuardStatement(db, guildId, raidOn, raids) {
  const versions = raids.map((raid) => ({ id: raid.id, version: raid.version }));
  return db.prepare(
    `INSERT INTO attendance_write_guard (ok) SELECT 1
      WHERE (SELECT COUNT(*) FROM raids WHERE guild_id = ? AND raid_on = ?) != ?
         OR EXISTS (SELECT 1 FROM json_each(?) j WHERE NOT EXISTS (
              SELECT 1 FROM raids r WHERE r.id = json_extract(j.value, '$.id') AND r.version = json_extract(j.value, '$.version') AND r.raid_on = ?))`,
  ).bind(guildId, raidOn, versions.length, JSON.stringify(versions), raidOn);
}

const isStaleWrite = (error) => /attendance_stale/.test(`${error && error.message} ${error && error.cause && error.cause.message}`);

// Recalculates every raid of the guild-local date of `raidId` (the fill-in pass spans the date) and writes the results:
// two D1 calls (one read batch, one write batch). Officer decisions are only read, never written. Every input write bumps
// raids.version, so a write batch that finds any version of the date changed aborts whole; the recompute then reads again once
// and, if it loses again, leaves the raids stale (their input writes already set policy_fp = '').
// -> [{ id, openFlags, rows }], null when the raid is gone, or [] when it lost the race twice (the raid stays stale).
export async function recomputeRaid(ctx, guild, raidId) {
  const { db } = ctx;
  for (let attempt = 0; attempt < 2; attempt++) {
    const loaded = await loadDay(db, guild.id, raidId);
    if (!loaded.raids.some((raid) => raid.id === raidId)) return null;
    const day = consolidateDay(guild, loaded);
    const ids = day.results.map((entry) => entry.raid.id);
    const attendance = day.results.flatMap((entry) => attendanceJson(entry));
    const planRows = day.results.flatMap((entry) => entry.planSignups);
    const raidState = day.results.map((entry) => ({ id: entry.raid.id, openFlags: entry.openFlags, fingerprint: entry.fingerprint }));
    const now = ctx.now();
    const statements = [
      versionGuardStatement(db, guild.id, day.date, loaded.raids),
      db.prepare("DELETE FROM raid_signups WHERE source = 'plan' AND raid_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)),
    ];
    if (planRows.length) {
      statements.push(db.prepare(
        `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, class_name, spec_name, position, guild_id, player_id)
         SELECT json_extract(value, '$.raidId'), 'plan', json_extract(value, '$.signupId'), NULL, NULL, json_extract(value, '$.kind'), NULL, NULL,
                json_extract(value, '$.position'), ?, json_extract(value, '$.playerId')
           FROM json_each(?)`,
      ).bind(guild.id, JSON.stringify(planRows)));
    }
    statements.push(db.prepare('DELETE FROM attendance WHERE raid_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)));
    if (attendance.length) statements.push(db.prepare(ATTENDANCE_INSERT).bind(guild.id, JSON.stringify(attendance)));
    statements.push(db.prepare(
      `UPDATE raids SET open_flags = (SELECT json_extract(value, '$.openFlags') FROM json_each(?) WHERE json_extract(value, '$.id') = raids.id),
              policy_fp = (SELECT json_extract(value, '$.fingerprint') FROM json_each(?) WHERE json_extract(value, '$.id') = raids.id),
              computed_at = ?
        WHERE guild_id = ? AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
    ).bind(JSON.stringify(raidState), JSON.stringify(raidState), now, guild.id, JSON.stringify(raidState)));
    // The Trial clock (worker/trial-clock.js): a Trial character's dates start with the first raid of its team that logged it. The version guard above aborts this
    // batch whole when the raids changed under it, so the clock never runs on a read that was thrown away.
    statements.push(trialClockStatement(db, guild.id, { offsetMinutes: zoneOffsetMinutes(guild.time_zone, now) }));
    try {
      await db.batch(statements);
    } catch (error) {
      if (isStaleWrite(error)) continue;
      throw error;
    }
    return day.results.map((entry) => ({ id: entry.raid.id, openFlags: entry.openFlags, rows: entry.rows.length }));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Unmatched characters (log names with no character in the guild and not marked guest)

// presence: [{ name, name_key, realm, realm_key, class, pulls }]; characterKeys / guestKeys: Set of "nameKey|realmKey".
export function findUnmatched(presence, characterKeys, guestKeys) {
  return presence
    .filter((row) => {
      // A character is found by the logged name as the characters carry it today (match_name_key, worker/name-alias.js); a guest mark by the name as logged.
      const key = keyOf(row.name_key, row.realm_key);
      return !characterKeys.has(keyOf(row.match_name_key || row.name_key, row.realm_key)) && !guestKeys.has(key);
    })
    .map((row) => ({ key: keyOf(row.name_key, row.realm_key), name: row.name, realm: row.realm, class: row.class, pullsPresent: row.pulls }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export const presenceKey = keyOf;
