// Attendance I/O: the only place that turns D1 rows into the pure modules' input and writes their results back.
// The pure modules (attendance-calendar / -policy / -consolidate / -metrics) never see the database.
import { consolidateRaid, resolveFillIns } from './attendance-consolidate.js';
import { REGION_RESET_DAY, consolidationFingerprint, resolvePolicy } from './attendance-policy.js';
import { allows } from './permissions.js';

export const SIGNUP_KINDS = ['signed', 'late', 'bench', 'tentative', 'absence'];

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

// One UPDATE: every raid with presence of any of these names keeps its results but is marked for recalculation.
// Returns a prepared statement for a db.batch (callers skip it when there are no keys).
export function markRaidsStale(db, guildId, nameKeys, exceptRaidId = null) {
  return db.prepare(
    `UPDATE raids SET policy_fp = ''
      WHERE guild_id = ? AND id != ? AND policy_fp != ''
        AND id IN (SELECT raid_id FROM raid_presence WHERE guild_id = ? AND name_key IN (SELECT value FROM json_each(?)))`,
  ).bind(guildId, exceptRaidId || '', guildId, JSON.stringify([...new Set(nameKeys)]));
}

// ---------------------------------------------------------------------------
// Nav badge

// { [teamId]: n } for the active teams the viewer can review; {} for everyone else.
export async function loadAttendanceFlags(db, guildContext) {
  const scope = guildContext.can['attendance.review'];
  if (!scope || (Array.isArray(scope) && !scope.length)) return {};
  const guildId = guildContext.guild.id;
  const [teamResult, countResult] = await db.batch([
    db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guildId),
    db.prepare('SELECT team_id, COUNT(*) AS n FROM raids WHERE guild_id = ? AND open_flags > 0 GROUP BY team_id').bind(guildId),
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
  const [raidResult, policyResult, signupResult, planResult, pullResult, presenceResult, manualResult, guestResult, attendanceResult, characterResult] = await db.batch([
    bind(`SELECT r.id, r.team_id, r.raid_on, r.log_mode, r.policy_fp,
                 (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = r.id) AS reports
            FROM raids r WHERE r.id IN (SELECT id FROM day) ORDER BY r.id`),
    policyRowsStatement(db, guildId),
    bind(`SELECT raid_id, source, signup_id, kind, player_id FROM raid_signups
           WHERE raid_id IN (SELECT id FROM day) AND source != 'plan' AND player_id IS NOT NULL`),
    bind(`SELECT raid_id, name, name_key, group_number FROM raid_plan WHERE raid_id IN (SELECT id FROM day) ORDER BY rowid`),
    bind('SELECT id, raid_id, started_at, kill FROM raid_pulls WHERE raid_id IN (SELECT id FROM day)'),
    bind('SELECT pull_id, raid_id, name, name_key, realm, realm_key, class FROM raid_presence WHERE raid_id IN (SELECT id FROM day)'),
    bind('SELECT raid_id, player_id FROM raid_manual WHERE raid_id IN (SELECT id FROM day)'),
    db.prepare('SELECT name_key, realm_key FROM attendance_guests WHERE guild_id = ?').bind(guildId),
    bind('SELECT * FROM attendance WHERE raid_id IN (SELECT id FROM day)'),
    // Every character of every person involved: on a team of the day, in a log, a sign-up, a manual tick, a stored row or the plan.
    bind(`, who AS (
            SELECT player_id FROM characters WHERE guild_id = ?1 AND team_id IN (SELECT team_id FROM raids WHERE id IN (SELECT id FROM day))
            UNION SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT name_key FROM raid_presence WHERE raid_id IN (SELECT id FROM day))
            UNION SELECT player_id FROM characters WHERE guild_id = ?1 AND name_key IN (SELECT name_key FROM raid_plan WHERE raid_id IN (SELECT id FROM day))
            UNION SELECT player_id FROM raid_signups WHERE raid_id IN (SELECT id FROM day) AND player_id IS NOT NULL
            UNION SELECT player_id FROM raid_manual WHERE raid_id IN (SELECT id FROM day)
            UNION SELECT player_id FROM attendance WHERE raid_id IN (SELECT id FROM day))
          SELECT c.player_id, c.name_key, c.realm_key, c.team_id, c.is_main, p.status, p.joined_on
            FROM characters c JOIN players p ON p.id = c.player_id
           WHERE c.guild_id = ?1 AND c.player_id IN (SELECT player_id FROM who)`),
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
    attendance: attendanceResult.results,
    characters: characterResult.results,
  };
}

const keyOf = (nameKeyValue, realmKeyValue) => `${nameKeyValue}|${realmKeyValue}`;

// Plan placements -> sign-up rows by character match (group 0 = bench, 1-8 = signed). An unmatched name has no person and no row.
function planSignups(raidId, plan, charactersByName, teamId) {
  const rows = [];
  plan.forEach((entry, index) => {
    const candidates = charactersByName.get(entry.name_key) || [];
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
    if (!people.has(row.player_id)) people.set(row.player_id, { playerId: row.player_id, status: row.status, joinedOn: row.joined_on, homeTeamId: null, characters: [] });
    if (row.is_main === 1) people.get(row.player_id).homeTeamId = row.team_id;
    people.get(row.player_id).characters.push({ key: keyOf(row.name_key, row.realm_key), teamId: row.team_id });
    if (!charactersByName.has(row.name_key)) charactersByName.set(row.name_key, []);
    charactersByName.get(row.name_key).push(row);
  }
  const guests = loaded.guests.map((row) => keyOf(row.name_key, row.realm_key));
  const group = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (!map.has(row.raid_id)) map.set(row.raid_id, []);
      map.get(row.raid_id).push(row);
    }
    return map;
  };
  const signupsBy = group(loaded.signups);
  const planBy = group(loaded.plan);
  const pullsBy = group(loaded.pulls);
  const manualBy = group(loaded.manual);
  const attendanceBy = group(loaded.attendance);
  const keysByPull = new Map();
  const logPlayersByRaid = new Map();
  for (const row of loaded.presence) {
    if (!keysByPull.has(row.pull_id)) keysByPull.set(row.pull_id, []);
    keysByPull.get(row.pull_id).push(keyOf(row.name_key, row.realm_key));
    if (!logPlayersByRaid.has(row.raid_id)) logPlayersByRaid.set(row.raid_id, {});
    logPlayersByRaid.get(row.raid_id)[keyOf(row.name_key, row.realm_key)] = { name: row.name, realm: row.realm, class: row.class };
  }

  const results = loaded.raids.map((raid) => {
    const plan = planSignups(raid.id, planBy.get(raid.id) || [], charactersByName, raid.team_id);
    const decisions = {};
    for (const row of attendanceBy.get(raid.id) || []) {
      if (row.decided_at === null || row.decided_at === undefined) continue;
      decisions[row.player_id] = {
        outcome: row.decided_outcome, credit: row.decided_credit, creditId: row.decided_credit_id, reason: row.decided_reason,
        flags: parseJson(row.decided_flags, []),
      };
    }
    const signups = [
      ...(signupsBy.get(raid.id) || []).map((row) => ({ playerId: row.player_id, kind: row.kind, source: row.source })),
      ...plan.map((row) => ({ playerId: row.playerId, kind: row.kind, source: 'plan' })),
    ];
    const evidence = {
      raid: { id: raid.id, teamId: raid.team_id, raidOn: raid.raid_on, hasLog: raid.reports > 0, manual: raid.log_mode === 'manual' },
      people: [...people.values()],
      signups,
      pulls: (pullsBy.get(raid.id) || []).map((pull) => ({ startedAt: pull.started_at, kill: pull.kill === 1, keys: keysByPull.get(pull.id) || [] })),
      manualPresent: (manualBy.get(raid.id) || []).map((row) => row.player_id),
      guests,
      decisions,
      logPlayers: logPlayersByRaid.get(raid.id) || {},
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

function attendanceJson(guild, entry, previous) {
  return entry.rows.map((row) => {
    const old = previous.get(`${entry.raid.id}|${row.playerId}`);
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
      decidedOutcome: old ? old.decided_outcome : null,
      decidedCredit: old ? old.decided_credit : null,
      decidedCreditId: old ? old.decided_credit_id : null,
      decidedReason: old ? old.decided_reason : null,
      decidedFlags: old ? old.decided_flags : null,
      decidedBy: old ? old.decided_by : null,
      decidedAt: old ? old.decided_at : null,
    };
  });
}

const ATTENDANCE_INSERT = `INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, credit, signup_kind, attended, presence_source, via_raid_id,
    pulls_present, pulls_total, missed_first, missed_last, flags, credit_team_id, needs_review,
    decided_outcome, decided_credit, decided_credit_id, decided_reason, decided_flags, decided_by, decided_at)
  SELECT json_extract(value, '$.raidId'), ?, json_extract(value, '$.teamId'), json_extract(value, '$.playerId'), json_extract(value, '$.outcome'),
         json_extract(value, '$.credit'), json_extract(value, '$.signupKind'), json_extract(value, '$.attended'), json_extract(value, '$.presenceSource'),
         json_extract(value, '$.viaRaidId'), json_extract(value, '$.pullsPresent'), json_extract(value, '$.pullsTotal'), json_extract(value, '$.missedFirst'),
         json_extract(value, '$.missedLast'), json_extract(value, '$.flags'), json_extract(value, '$.creditTeamId'), json_extract(value, '$.needsReview'),
         json_extract(value, '$.decidedOutcome'), json_extract(value, '$.decidedCredit'), json_extract(value, '$.decidedCreditId'),
         json_extract(value, '$.decidedReason'), json_extract(value, '$.decidedFlags'), json_extract(value, '$.decidedBy'), json_extract(value, '$.decidedAt')
    FROM json_each(?)`;

// Recalculates every raid of the guild-local date of `raidId` (the fill-in pass spans the date) and writes the results:
// two D1 calls (one read batch, one write batch). Decisions are kept. -> [{ id, openFlags, rows }] or null when the raid is gone.
export async function recomputeRaid(ctx, guild, raidId) {
  const { db } = ctx;
  const loaded = await loadDay(db, guild.id, raidId);
  if (!loaded.raids.some((raid) => raid.id === raidId)) return null;
  const day = consolidateDay(guild, loaded);
  const previous = new Map(loaded.attendance.map((row) => [`${row.raid_id}|${row.player_id}`, row]));
  const ids = day.results.map((entry) => entry.raid.id);
  const attendance = day.results.flatMap((entry) => attendanceJson(guild, entry, previous));
  const planRows = day.results.flatMap((entry) => entry.planSignups);
  const raidState = day.results.map((entry) => ({ id: entry.raid.id, openFlags: entry.openFlags, fingerprint: entry.fingerprint }));
  const now = ctx.now();
  const statements = [
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
  await db.batch(statements);
  return day.results.map((entry) => ({ id: entry.raid.id, openFlags: entry.openFlags, rows: entry.rows.length }));
}

// ---------------------------------------------------------------------------
// Unmatched characters (log names with no character in the guild and not marked guest)

// presence: [{ name, name_key, realm, realm_key, class, pulls }]; characterKeys / guestKeys: Set of "nameKey|realmKey".
export function findUnmatched(presence, characterKeys, guestKeys) {
  return presence
    .filter((row) => {
      const key = keyOf(row.name_key, row.realm_key);
      return !characterKeys.has(key) && !guestKeys.has(key);
    })
    .map((row) => ({ key: keyOf(row.name_key, row.realm_key), name: row.name, realm: row.realm, class: row.class, pullsPresent: row.pulls }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export const presenceKey = keyOf;
