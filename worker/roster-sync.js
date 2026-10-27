// The in-game roster sync (hierarchy build, lane B4a-code): fetch a PINNED guild's roster from Battle.net, decide GOOD, and atomically REPLACE the stored
// roster (guild_roster). It ships dormant: the scheduler and the on-demand route only ever touch a guild with a complete pin (worker/roster-pin.js),
// and no guild has one until the setup pin / creation lanes (B6b, B10) write it. Plan: tasks/todo.md, PLAN v9, "Model" > Sync / Source/pin / Identity key
// / Former vs Social, and "Fix as we go" > B4a-code.
//
// ONE ATTEMPT (syncGuild), after the caller won the lease (claimSyncLease):
//   fetch (pin target only) -> assessRoster (GOOD?) -> hash
//     not GOOD / Blizzard error ..... one roster_syncs row (good 0, reason, http status), nothing else changes
//     GOOD, hash = guilds.roster_hash  one batch: the roster_syncs row (good 1, counts.unchanged) + guilds.last_good_fetched_at moved to this fetch (only
//                                      if newer). guild_roster, roster_hash and last_good_sync_id stay, so the dry-run token survives an unchanged sync.
//     GOOD, hash differs ............. ONE db.batch (below); a failed batch rolls back whole and leaves one roster_syncs row (good 0, 'batch_failed')
//
// THE BATCH (rosterReplaceStatements), in this order. EVERY statement carries the monotonic guard, so a fetch that is older than the roster already
// stored (or for a guild whose pin changed) changes nothing at all; the guilds update is LAST because it moves the value the guard reads.
//   1  stale marking   raids whose logs name a renamed / leaving / returning bound character, and those characters' teams' raids with evidence whose week is still running
//                      (the freeze, worker/attendance-store.js)
//   2  aliases         the old name_key of every renamed bound character -> character_name_aliases (renamed_at = fetch time)
//   3  renames         characters.name / name_key follow the roster (skipped while the new name is taken by another character)
//   4  Former          a bound character whose identity key was in the stored roster and is absent from the new one gets left_on = today
//   5  returning       a Former whose key is back on the roster gets left_on cleared
//   6  DELETE the guild's guild_roster rows
//   7  INSERT ... SELECT FROM json_each(?) chunks of ROSTER_INSERT_CHUNK members (a bound JSON string is one parameter: D1 allows 100 per statement)
//   8  applyRankMapStatements(...)   applyRankMap (worker/rank-map.js): stale marking, core_rank from the rank map (Social when unmapped or off the roster), the Trial clock
//   9  the good roster_syncs row
//  10  guilds: roster_hash + last_good_sync_id + last_good_fetched_at   (the id the dry-run token binds to, and the guard value)
// Steps 1-5 read the OLD guild_roster and so must run before step 6; they are the "character-side apply" and each one also requires
// guilds.rank_source = 'ingame' INSIDE the batch (not in JS), so a sync that read the guild just before the flip can neither skip them after the flip
// nor run them before it. Before the flip the batch therefore writes only guild_roster + roster_syncs + the guild's sync columns.
// HAS_EVIDENCE: a raid that holds any evidence a roster change can move; the sync suite pins that the sync marks the same raids stale as roster.js's
// rename path (markRaidsStale).
import { HAS_EVIDENCE, weekFreeze, weekRunningSql } from './attendance-store.js';
import { BnetError, assessRoster, bnetSupport, fetchGuildRosterBySlug } from './battlenet.js';
import { newId } from './ids.js';
import { INGAME_SQL, rankMapApplyStatements } from './rank-map.js';
import { COMPLETE_PIN_SQL, PIN_SQL, pinOf } from './roster-pin.js';
import { todayIn } from './roster-data.js';
import { wrote } from './d1-changes.js';

export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
// The on-demand claim is allowed once next_sync_at <= now + (interval - gap): at least one hour since the last claim, whoever made it.
export const ON_DEMAND_MIN_GAP_MS = 60 * 60 * 1000;
// One guild per */15 tick: the account runs on Workers Free (50 D1 queries per invocation; one sync is ~13 and the tick also runs
// notifications and the Raid-Helper refresh). 96 ticks a day cover 24 guilds at the 6 h cadence; raise this on Workers Paid.
export const SYNC_GUILDS_PER_RUN = 1;
export const SYNC_TIME_BUDGET_MS = 20 * 1000;
export const ROSTER_INSERT_CHUNK = 300;

// SQL text with interpolated fixed fragments lives in consts (the Worker SQL lint allows interpolation only there, never inside prepare()).
const LEASE_SQL = `UPDATE guilds SET next_sync_at = ? WHERE id = ? AND next_sync_at <= ? AND ${COMPLETE_PIN_SQL}`;
const DUE_SQL = `SELECT id FROM guilds WHERE next_sync_at <= ? AND ${COMPLETE_PIN_SQL} ORDER BY next_sync_at, id LIMIT ?`;
const RELEASE_SQL = `UPDATE guilds SET next_sync_at = ? WHERE id = ? AND next_sync_at = ? AND ${COMPLETE_PIN_SQL}`;

// ---------------------------------------------------------------------------
// Lease

// The cron and the on-demand route claim the same column. -> true when THIS caller won the claim (changes() = 1). Only a guild with a complete pin
// can be claimed. Cron: due now. On-demand: due within the next 5 h, i.e. the last claim is at least an hour old.
export async function claimSyncLease(db, guildId, nowMs, { onDemand = false } = {}) {
  const dueBefore = onDemand ? nowMs + SYNC_INTERVAL_MS - ON_DEMAND_MIN_GAP_MS : nowMs;
  const result = await db.prepare(LEASE_SQL).bind(nowMs + SYNC_INTERVAL_MS, guildId, dueBefore).run();
  return wrote(result);
}

// Hands a lease back so the guild is due NOW: for the sync that ran inside the setup pin (worker/routes/bnet-pin.js), which leaves the lease one interval ahead because its sync
// is the guild's first, and which FAILED. Without this the Owner would wait an hour for "Sync now" (and six for the cron) after a hiccup that was nobody's fault. `leasedUntil` is
// the value the caller's own lease wrote: a claim made since (a Sync now, a cron tick) moved the column and is left alone. -> true when the lease was released.
export async function releaseSyncLease(db, guildId, { leasedUntil, nowMs }) {
  const result = await db.prepare(RELEASE_SQL).bind(nowMs, guildId, leasedUntil).run();
  return wrote(result);
}

// Seconds until an on-demand claim could succeed (for Retry-After), from the guild's current next_sync_at.
export async function onDemandRetryAfter(db, guildId, nowMs) {
  const row = await db.prepare('SELECT next_sync_at FROM guilds WHERE id = ?').bind(guildId).first();
  if (!row) return 60;
  return Math.max(1, Math.ceil((row.next_sync_at - (nowMs + SYNC_INTERVAL_MS - ON_DEMAND_MIN_GAP_MS)) / 1000));
}

// ---------------------------------------------------------------------------
// Roster hash

const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

// SHA-256 over everything guild_roster stores, in identity-key order: equal rosters hash equal whatever order Blizzard listed them in.
export async function rosterHash(roster) {
  const rows = roster.members.slice()
    .sort((a, b) => a.realmId - b.realmId || a.characterId - b.characterId)
    .map((m) => [m.realmId, m.characterId, m.name, m.realmSlug, m.class, m.level, m.rank].join('|'));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${roster.namespace}\n${rows.join('\n')}`));
  return hex(digest);
}

// ---------------------------------------------------------------------------
// The replace batch

// The monotonic guard: this fetch is newer than the stored roster, for the same Blizzard guild and realm the pin names.
const MONOTONIC_GUARD = `EXISTS (SELECT 1 FROM guilds WHERE id = ? AND blizzard_guild_id = ? AND blizzard_realm_id = ? AND pinned_namespace = ?
    AND (last_good_fetched_at IS NULL OR last_good_fetched_at < ?))`;
const INGAME_GUARD = INGAME_SQL;

// The guards as { sql, params } for any statement of the batch (B4b's hook appends the same two to every statement it adds).
export function replaceGuards(run) {
  return {
    monotonic: { sql: MONOTONIC_GUARD, params: [run.guildId, run.blizzardGuildId, run.blizzardRealmId, run.namespace, run.fetchedAt] },
    ingame: { sql: INGAME_GUARD, params: [run.guildId] },
  };
}


const NEW_ROSTER_FULL = `new_roster AS (SELECT json_extract(value, '$[0]') AS rid, json_extract(value, '$[1]') AS cid,
    json_extract(value, '$[2]') AS name, json_extract(value, '$[3]') AS nk FROM json_each(?))`;
const NEW_ROSTER_IDS = `new_roster AS (SELECT json_extract(value, '$[0]') AS rid, json_extract(value, '$[1]') AS cid FROM json_each(?))`;
const ON_NEW = (alias) => `n.rid = ${alias}.blizzard_realm_id AND n.cid = ${alias}.blizzard_char_id`;
const BOTH_GUARDS = `${INGAME_GUARD} AND ${MONOTONIC_GUARD}`;

const STALE_SQL = `WITH ${NEW_ROSTER_FULL},
     hit AS (
       SELECT c.name_key AS old_key, n.nk AS new_key, c.team_id AS team_id
         FROM characters c JOIN new_roster n ON ${ON_NEW('c')}
        WHERE c.guild_id = ? AND c.namespace = ? AND (c.name_key != n.nk OR c.left_on IS NOT NULL)
       UNION ALL
       SELECT c.name_key, c.name_key, c.team_id
         FROM characters c JOIN guild_roster g ON g.guild_id = c.guild_id AND g.namespace = c.namespace
                                              AND g.blizzard_realm_id = c.blizzard_realm_id AND g.blizzard_char_id = c.blizzard_char_id
        WHERE c.guild_id = ? AND c.left_on IS NULL
          AND NOT EXISTS (SELECT 1 FROM new_roster x WHERE x.rid = g.blizzard_realm_id AND x.cid = g.blizzard_char_id)
     )
     UPDATE raids SET policy_fp = '', version = version + 1
      WHERE guild_id = ?
        AND (id IN (SELECT raid_id FROM raid_presence WHERE guild_id = ? AND (name_key IN (SELECT old_key FROM hit) OR name_key IN (SELECT new_key FROM hit)))
             OR (team_id IN (SELECT team_id FROM hit WHERE team_id IS NOT NULL) AND ${HAS_EVIDENCE} AND ${weekRunningSql('?', '?')}))
        AND ${BOTH_GUARDS}`;

const ALIAS_SQL = `WITH ${NEW_ROSTER_FULL}
     INSERT INTO character_name_aliases (id, guild_id, character_id, name_key, realm_key, renamed_at)
     SELECT 'na_' || lower(hex(randomblob(16))), c.guild_id, c.id, c.name_key, c.realm_key, ?
       FROM characters c JOIN new_roster n ON ${ON_NEW('c')}
      WHERE c.guild_id = ? AND c.namespace = ? AND c.name_key != n.nk
        AND NOT EXISTS (SELECT 1 FROM characters o WHERE o.guild_id = c.guild_id AND o.name_key = n.nk AND o.realm_key = c.realm_key AND o.id != c.id)
        AND ${BOTH_GUARDS}`;

const RENAME_SQL = `WITH ${NEW_ROSTER_FULL}
     UPDATE characters
        SET name = (SELECT n.name FROM new_roster n WHERE ${ON_NEW('characters')}),
            name_key = (SELECT n.nk FROM new_roster n WHERE ${ON_NEW('characters')}),
            updated_at = ?
      WHERE guild_id = ? AND namespace = ? AND blizzard_char_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM new_roster n WHERE ${ON_NEW('characters')} AND n.nk != characters.name_key
                      AND NOT EXISTS (SELECT 1 FROM characters o WHERE o.guild_id = characters.guild_id AND o.name_key = n.nk
                                        AND o.realm_key = characters.realm_key AND o.id != characters.id))
        AND ${BOTH_GUARDS}`;

const FORMER_SQL = `WITH ${NEW_ROSTER_IDS}
     UPDATE characters SET left_on = ?, updated_at = ?
      WHERE guild_id = ? AND namespace = ? AND blizzard_char_id IS NOT NULL AND left_on IS NULL
        AND EXISTS (SELECT 1 FROM guild_roster g WHERE g.guild_id = characters.guild_id AND g.namespace = characters.namespace
                      AND g.blizzard_realm_id = characters.blizzard_realm_id AND g.blizzard_char_id = characters.blizzard_char_id)
        AND NOT EXISTS (SELECT 1 FROM new_roster n WHERE ${ON_NEW('characters')})
        AND ${BOTH_GUARDS}`;

const RETURNING_SQL = `WITH ${NEW_ROSTER_IDS}
     UPDATE characters SET left_on = NULL, left_reason = NULL, updated_at = ?
      WHERE guild_id = ? AND namespace = ? AND blizzard_char_id IS NOT NULL AND left_on IS NOT NULL
        AND EXISTS (SELECT 1 FROM new_roster n WHERE ${ON_NEW('characters')})
        AND ${BOTH_GUARDS}`;

const DELETE_ROSTER_SQL = `DELETE FROM guild_roster WHERE guild_id = ? AND ${MONOTONIC_GUARD}`;

const INSERT_ROSTER_SQL = `INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
       SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
              json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]')
         FROM json_each(?) WHERE ${MONOTONIC_GUARD}`;

const SYNC_ROW_SQL = `INSERT INTO roster_syncs (id, guild_id, started_at, finished_at, good, http_status, reason, counts)
     SELECT ?, ?, ?, ?, 1, 200, NULL, ? WHERE ${MONOTONIC_GUARD}`;

// Placement of applyRankMap (lane B4b): after the roster rows are replaced (it reads guild_roster.rank), before the sync row and the guild update. Every statement
// carries guards.monotonic AND guards.ingame, so before the flip (rank_source not 'ingame') it changes nothing.
export function applyRankMapStatements(db, run, guards) {
  return rankMapApplyStatements(db, { guildId: run.guildId, now: run.now, timeZone: run.timeZone }, [guards.ingame, guards.monotonic]);
}

// -> { statements, syncIndex }. run: { guildId, blizzardGuildId, blizzardRealmId, namespace, fetchedAt, startedAt, finishedAt, now, today, timeZone, syncId, hash,
//   roster }. syncIndex = the position of the roster_syncs statement: wrote() is true when the batch applied, false when the guard refused it.
export function rosterReplaceStatements(db, run) {
  const guards = replaceGuards(run);
  const G = guards.monotonic.params;
  const I = guards.ingame.params;
  const members = run.roster.members;
  const fullJson = JSON.stringify(members.map((m) => [m.realmId, m.characterId, m.name, m.nameKey]));
  const idsJson = JSON.stringify(members.map((m) => [m.realmId, m.characterId]));
  const statements = [];

  statements.push(db.prepare(STALE_SQL).bind(fullJson, run.guildId, run.namespace, run.guildId, run.guildId, run.guildId, weekFreeze(run.timeZone, run.now).starts, run.guildId, ...I, ...G));

  statements.push(db.prepare(ALIAS_SQL).bind(fullJson, run.fetchedAt, run.guildId, run.namespace, ...I, ...G));

  statements.push(db.prepare(RENAME_SQL).bind(fullJson, run.now, run.guildId, run.namespace, ...I, ...G));

  statements.push(db.prepare(FORMER_SQL).bind(idsJson, run.today, run.now, run.guildId, run.namespace, ...I, ...G));

  statements.push(db.prepare(RETURNING_SQL).bind(idsJson, run.now, run.guildId, run.namespace, ...I, ...G));

  statements.push(db.prepare(DELETE_ROSTER_SQL).bind(run.guildId, ...G));

  let chunks = 0;
  for (let i = 0; i < members.length; i += ROSTER_INSERT_CHUNK) {
    const rows = members.slice(i, i + ROSTER_INSERT_CHUNK).map((m) => [m.realmId, m.characterId, m.name, m.nameKey, m.realmSlug, m.class, m.level, m.rank]);
    statements.push(db.prepare(INSERT_ROSTER_SQL).bind(run.guildId, run.namespace, JSON.stringify(rows), ...G));
    chunks += 1;
  }

  statements.push(...applyRankMapStatements(db, run, guards));

  const syncIndex = statements.length;
  statements.push(db.prepare(SYNC_ROW_SQL).bind(run.syncId, run.guildId, run.startedAt, run.finishedAt, JSON.stringify({ members: members.length, nonTbc: run.roster.nonTbc, chunks }), ...G));

  statements.push(db.prepare(
    `UPDATE guilds SET roster_hash = ?, last_good_sync_id = ?, last_good_fetched_at = ?
      WHERE id = ? AND blizzard_guild_id = ? AND blizzard_realm_id = ? AND pinned_namespace = ?
        AND (last_good_fetched_at IS NULL OR last_good_fetched_at < ?)`,
  ).bind(run.hash, run.syncId, run.fetchedAt, run.guildId, run.blizzardGuildId, run.blizzardRealmId, run.namespace, run.fetchedAt));

  return { statements, syncIndex };
}

// ---------------------------------------------------------------------------
// One sync attempt

const attemptStatement = (deps, row) => deps.db.prepare(
  `INSERT INTO roster_syncs (id, guild_id, started_at, finished_at, good, http_status, reason, counts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(row.id, row.guildId, row.startedAt, deps.now(), row.good ? 1 : 0, row.httpStatus ?? null, row.reason ?? null, JSON.stringify(row.counts || {}));

// An unchanged sync still proves the stored roster is current as of this fetch: it moves ONLY the monotonic guard's value, so an older fetch that
// lands afterwards cannot put an earlier roster back. roster_hash and last_good_sync_id stay (the dry-run token binds to the sync id).
const ADVANCE_FETCHED_SQL = 'UPDATE guilds SET last_good_fetched_at = ? WHERE id = ? AND (last_good_fetched_at IS NULL OR last_good_fetched_at < ?)';

async function recordAttempt(deps, row) {
  try {
    await attemptStatement(deps, row).run();
  } catch (error) {
    // The guild may have been deleted while the fetch ran (FK): there is nothing to record against.
    try { deps.log(`roster sync: could not record the attempt: ${error && error.message}`); } catch { /* logging must not throw */ }
  }
}

// Applies a GOOD roster whose hash differs from the stored one: ONE batch (rosterReplaceStatements), a failed batch rolls back whole. The one place that does it: the sync below and
// the GM claim (worker/gm-claim.js, which trusts the one good response it fetched with the claimant's own request, U R5-Q6) both call it.
// guild: the PIN_SQL row (time_zone), pin: pinOf(guild). fits(count) -> boolean: a caller with a statement budget says whether the batch of `count` statements may run.
// -> { status: 'applied' | 'superseded' (a newer roster is stored already, or the pin changed: nothing was written) | 'failed' (logged) | 'skipped' (fits said no), statements: count }.
export async function replaceStoredRoster(deps, { guildId, guild, pin, roster, hash, startedAt, syncId, fits = null }) {
  const { db } = deps;
  const { statements, syncIndex } = rosterReplaceStatements(db, {
    guildId, blizzardGuildId: pin.blizzardGuildId, blizzardRealmId: pin.blizzardRealmId, namespace: pin.namespace,
    fetchedAt: startedAt, startedAt, finishedAt: deps.now(), now: deps.now(), today: todayIn(guild.time_zone, deps.now()), timeZone: guild.time_zone, syncId, hash, roster,
  });
  const count = statements.length;
  if (fits && !fits(count)) return { status: 'skipped', statements: 0 };
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    deps.log(`roster sync: ${guildId}: the replace batch failed and rolled back: ${error && error.message}`);
    return { status: 'failed', statements: count };
  }
  // A refused guard leaves every statement a no-op.
  return { status: wrote(results[syncIndex]) ? 'applied' : 'superseded', statements: count };
}

const rosterCounts = (roster) => ({ entries: roster.entries, members: roster.members.length, nonTbc: roster.nonTbc, truncated: roster.truncated, problems: roster.problems });

// The recorder of ONE attempt: a roster_syncs row for a refusal, the answer shape for every outcome. deps: { db, now, log, randomBytes }.
const attemptRecorder = (deps, guildId, startedAt, syncId) => async (good, fields) => {
  await recordAttempt(deps, { id: syncId, guildId, startedAt, good, ...fields });
  const status = good ? fields.status : (fields.reason === 'superseded' ? 'superseded' : 'failed');
  return { status, syncId, reason: fields.reason || null, members: fields.members ?? null };
};

// What a roster that was just FETCHED for a pinned guild does: assessRoster decides GOOD against the pin, an unchanged hash only advances the monotonic guard, a changed one replaces
// the stored roster in ONE batch. The part of a sync after the fetch, shared by syncGuild and the setup pin (worker/routes/bnet-pin.js, which fetched the roster itself to decide
// the pin and must not fetch and parse it twice in one invocation). guild: the PIN_SQL row (roster_hash, time_zone), pin: pinOf(guild) and complete, startedAt: when the fetch began.
// Never throws. -> the same answer as syncGuild.
export async function settleFetchedRoster(deps, { guildId, guild, pin, roster, startedAt, syncId }) {
  const { db } = deps;
  const attempt = attemptRecorder(deps, guildId, startedAt, syncId);
  try {
    const verdict = assessRoster(roster, { guildId: pin.blizzardGuildId, realmId: pin.blizzardRealmId });
    if (!verdict.good) {
      deps.log(`roster sync: ${guildId}: not good: ${verdict.reason}`);
      return await attempt(false, { reason: verdict.reason, httpStatus: 200, counts: rosterCounts(roster) });
    }

    const hash = await rosterHash(roster);
    if (hash === guild.roster_hash) {
      const row = { id: syncId, guildId, startedAt, good: true, httpStatus: 200, counts: { members: roster.members.length, nonTbc: roster.nonTbc, unchanged: true } };
      try {
        await db.batch([attemptStatement(deps, row), db.prepare(ADVANCE_FETCHED_SQL).bind(startedAt, guildId, startedAt)]);
      } catch (error) {
        deps.log(`roster sync: ${guildId}: the unchanged-roster batch failed and rolled back: ${error && error.message}`);
        return await attempt(false, { reason: 'batch_failed', httpStatus: 200, counts: rosterCounts(roster) });
      }
      return { status: 'unchanged', syncId, reason: null, members: roster.members.length };
    }

    const { status: outcome } = await replaceStoredRoster(deps, { guildId, guild, pin, roster, hash, startedAt, syncId });
    // 'superseded': the guard refused every statement, a newer roster is already stored (or the pin changed). Nothing was written.
    if (outcome !== 'applied') return await attempt(false, { reason: outcome === 'failed' ? 'batch_failed' : 'superseded', httpStatus: 200, counts: rosterCounts(roster) });
    return { status: 'applied', syncId, reason: null, members: roster.members.length };
  } catch (error) {
    try { deps.log(`roster sync: ${guildId}: failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return await attempt(false, { reason: 'sync_error' });
  }
}

// deps: { db, env, fetch, now, randomBytes, log }. Syncs one pinned guild whose lease the caller holds. Never throws.
// -> { status: 'applied' | 'unchanged' | 'failed' | 'superseded' | 'skipped', syncId | null, reason | null, members | null }
export async function syncGuild(deps, guildId) {
  const { db } = deps;
  const startedAt = deps.now();
  const syncId = newId('rs', deps.randomBytes);
  const attempt = attemptRecorder(deps, guildId, startedAt, syncId);
  try {
    const guild = await db.prepare(PIN_SQL).bind(guildId).first();
    const pin = pinOf(guild);
    if (!pin || !pin.complete) return { status: 'skipped', syncId: null, reason: 'not_pinned', members: null };
    const support = bnetSupport(guild.game_version, guild.region);
    if (!support.supported || support.namespace !== pin.namespace) return await attempt(false, { reason: 'pin_namespace_mismatch' });
    if (!deps.env || !deps.env.BNET_CLIENT_ID || !deps.env.BNET_CLIENT_SECRET) return await attempt(false, { reason: 'not_configured' });

    let roster;
    try {
      roster = await fetchGuildRosterBySlug(deps, guild.region, pin.namespace, pin.realmSlug, pin.guildSlug);
    } catch (error) {
      if (!(error instanceof BnetError)) throw error;
      deps.log(`roster sync: ${guildId}: ${error.kind}: ${error.message}`);
      return await attempt(false, { reason: `bnet_${error.kind}`, httpStatus: error.status });
    }
    return await settleFetchedRoster(deps, { guildId, guild, pin, roster, startedAt, syncId });
  } catch (error) {
    try { deps.log(`roster sync: ${guildId}: failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return await attempt(false, { reason: 'sync_error' });
  }
}

// ---------------------------------------------------------------------------
// The */15 tick

// Due guilds in next_sync_at order, within a guild budget and a time budget. Each is leased (changes() = 1) before it is fetched, so a second run, a
// retried invocation or an on-demand click never syncs the same guild twice. deps: { db, env, fetch, now, randomBytes, log }. Throws only on a D1 error
// of the due-list query (scheduler.js catches it).
export async function runRosterSyncs(deps, { guilds = SYNC_GUILDS_PER_RUN, budgetMs = SYNC_TIME_BUDGET_MS } = {}) {
  const summary = { attempted: 0, applied: 0, unchanged: 0, failed: 0, superseded: 0 };
  const started = deps.now();
  const due = await deps.db.prepare(DUE_SQL).bind(started, guilds).all();
  for (const row of due.results) {
    if (deps.now() - started >= budgetMs) break;
    if (!(await claimSyncLease(deps.db, row.id, deps.now()))) continue;
    const result = await syncGuild(deps, row.id);
    if (result.status === 'skipped') continue;
    summary.attempted += 1;
    if (result.status === 'applied') summary.applied += 1;
    else if (result.status === 'unchanged') summary.unchanged += 1;
    else if (result.status === 'superseded') summary.superseded += 1;
    else summary.failed += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Status (for the later setup page)

const parseCounts = (text) => { try { return JSON.parse(text); } catch { return {}; } };

const attemptView = (row) => (row ? {
  id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, good: row.good === 1, httpStatus: row.http_status, reason: row.reason, counts: parseCounts(row.counts),
} : null);

// -> what the guild's sync did last: { pinned, rankSource, nextSyncAt, rosterMembers, lastGood: { syncId, fetchedAt, members } | null, lastAttempt | null }.
// No member names, no hash, no Blizzard ids.
export async function loadSyncStatus(db, guildId) {
  const [guildResult, lastResult, goodResult, countResult] = await db.batch([
    db.prepare(PIN_SQL).bind(guildId),
    db.prepare('SELECT id, started_at, finished_at, good, http_status, reason, counts FROM roster_syncs WHERE guild_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').bind(guildId),
    db.prepare('SELECT r.id, r.started_at, r.finished_at, r.good, r.http_status, r.reason, r.counts FROM roster_syncs r JOIN guilds g ON g.last_good_sync_id = r.id WHERE g.id = ?').bind(guildId),
    db.prepare('SELECT COUNT(*) AS n FROM guild_roster WHERE guild_id = ?').bind(guildId),
  ]);
  const guild = guildResult.results[0];
  const pin = pinOf(guild);
  const good = goodResult.results[0];
  return {
    pinned: !!pin && pin.complete,
    rankSource: pin ? pin.rankSource : null,
    nextSyncAt: guild ? guild.next_sync_at : null,
    rosterMembers: countResult.results[0].n,
    lastGood: guild && guild.last_good_sync_id ? {
      syncId: guild.last_good_sync_id,
      fetchedAt: guild.last_good_fetched_at,
      members: good ? (parseCounts(good.counts).members ?? null) : null,
    } : null,
    lastAttempt: attemptView(lastResult.results[0]),
  };
}
