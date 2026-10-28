// Bulk Block and bulk Unblock of the Users page (user-hierarchy build, lane B7b part 2; plan "Users API/UI" and H-Q45: Manage users, Block / Unblock in the bottom bar).
//   POST /api/guild/:gid/users/block     { keys: [ukey, ...], reason? }
//   POST /api/guild/:gid/users/unblock   { keys: [ukey, ...] }
//   -> { action, done: [{ key, kind, name }], skipped: [{ key, name, reason, message }], cap, tombstonesKept? }
// A key is a key of the Users list: an account (u_...), an account-less person (p_...) or a name (n_...: nothing to block, skipped). Each name gets EXACTLY the guards of the single
// routes (POST/DELETE /people/:uid/block for an account, POST/DELETE /roster/:pid/block for a person), read first for the reason it is skipped and repeated inside the write:
//   - the actor holds guild.access (the route's gate and the guard of every statement), never blocks themself, never the Guild Master, never the live Owner, and is strictly senior to
//     the account (an account-less person: to the rank its in-game rank would give it, or the actor is the Owner); an account that has a person is blocked as the account;
//   - a Former member, a non-member that touched the guild (an applicant, a Discord sign-in, an open-raid guest) and a member are all blockable: the Users list shows them;
//   - Unblock: the block must exist; a block on the live Owner (ignored) needs no rank, any other block needs the single route's rank test; the account's own tombstones go, and the
//     tombstones of the earlier blocks its keys hit go only as far as splitLiftableRefs lets this actor lift them.
// What a block does is worker/block-effects.js's (off every team, upcoming / standing sign-ups and pending team requests withdrawn, Raid-Helper rows stay), here for all the names in
// the SAME statements: every statement works on the set (json_each over the names, each row under its own guard), so a request costs the same number of D1 statements for 1 name as
// for BULK_MAX_NAMES (about 20; the free plan allows 45 per request, tests/guild/guild-b7b2-bulk-tests.js measures it).
// Names beyond BULK_MAX_NAMES are skipped as over_cap (the page sends them again); a request is not refused for being long. The person is told nothing beyond "access removed".
import { HttpError, cleanText, isUniqueViolation } from './http.js';
import { auditManyStatement } from './audit.js';
import { directRows, directRowsStatement } from './d1-changes.js';
import { markRaidsStale, weekFreeze } from './attendance-store.js';
import {
  MISSING_KEY_LINE, accountBlockRef, accountKeysStatements, keysOfMany, liftGuard, madeByGuard, matchedRefsOfMany, personBlockRef, personKeysStatements, planTombstones, splitLiftableRefs,
} from './block-tombstones.js';
import { isOwner, ownerSql } from './owner.js';
import { ROLE_RANK } from './permissions.js';
import { nameKey } from './roster-data.js';
import { actorHolds, outranksSql } from './routes/people.js';
import { accountLessSql, outranksPersonSql, prospectiveRankSql } from './routes/person-blocks.js';
import { accountSegmentSql, accountsCte, bestBuiltinSql, ignoredBlockSql, mergedIntoAccountSql, newScope, personNameSql, personSegmentSql, viewerOf } from './users-list.js';
import { parseUserKey } from './users-detail.js';

// The most names one request blocks or unblocks, and the most keys a request may carry (the rest of a long list is skipped, not refused).
export const BULK_MAX_NAMES = 25;
export const BULK_MAX_KEYS = 100;
const MAX_REASON = 200;
// Tombstone rows per statement: an account holds at most 100 keys (MAX_VALUES), 25 names could carry 2,500 rows; a statement stays well under D1's 100 KB.
const TOMBSTONE_ROWS_PER_STATEMENT = 300;

export const SKIP_MESSAGES = Object.freeze({
  not_found: 'That user was not found.',
  name_only: 'A name seen in a log has no account or roster person: nothing to block. Add it to a person or leave it.',
  has_account: 'That person has an account. Use the account\'s row.',
  self: 'You cannot change your own access.',
  owner: 'The Owner of the guild cannot be removed.',
  guild_master: 'The Guild Master cannot be removed or restored here.',
  outranks: 'That person ranks the same as you or above you, so only someone more senior can change their access.',
  already_blocked: 'Their access is already removed.',
  not_blocked: 'Their access is not removed.',
  over_cap: `Only ${BULK_MAX_NAMES} users are changed at a time. Send these again.`,
  conflict: 'That changed while you were working on it. Reload and try again.',
});

const bad = (message, field) => new HttpError(400, 'bad_request', message, { field });
const conflict = () => new HttpError(409, 'conflict', SKIP_MESSAGES.conflict);

// ---------------------------------------------------------------------------
// The request

// -> { keys: [distinct strings in request order] }. 400 for anything but a list of 1..BULK_MAX_KEYS strings.
export function readKeys(body, field = 'keys') {
  const list = body && typeof body === 'object' ? body[field] : null;
  if (!Array.isArray(list) || !list.length) throw bad('Pick at least one user.', field);
  if (list.length > BULK_MAX_KEYS) throw bad(`At most ${BULK_MAX_KEYS} users in one request.`, field);
  if (!list.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 600)) throw bad('Every user is a key from the Users list.', field);
  return [...new Set(list)];
}

// The single route's own reading of the reason (worker/routes/people.js parseReason): plain text of at most 200 characters, blank = none.
export function readReason(body) {
  if (body.reason === undefined || body.reason === null) return null;
  return cleanText(body.reason, 'reason', { min: 0, max: MAX_REASON }) || null;
}

// The keys sorted into what is processed (accounts, persons: the first BULK_MAX_NAMES) and what is skipped at once. -> { order: [key], accounts: [id], persons: [id], skip: Map<key, reason> }
function sortKeys(keys) {
  const accounts = [];
  const persons = [];
  const skip = new Map();
  for (const key of keys) {
    const parsed = parseUserKey(key);
    if (!parsed) skip.set(key, 'not_found');
    else if (parsed.kind === 'name') skip.set(key, 'name_only');
    else if (accounts.length + persons.length >= BULK_MAX_NAMES) skip.set(key, 'over_cap');
    else (parsed.kind === 'account' ? accounts : persons).push(parsed.id);
  }
  return { order: keys, accounts, persons, skip };
}

// ---------------------------------------------------------------------------
// Statement building: every statement numbers its own placeholders, a value used twice is bound once.

function paramScope() {
  const values = [];
  const memo = new Map();
  const add = (value) => {
    const memoKey = value === null || value === undefined ? 'null' : `${typeof value}:${value}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    values.push(value === undefined ? null : value);
    const placeholder = `?${values.length}`;
    memo.set(memoKey, placeholder);
    return placeholder;
  };
  return { values, add };
}
const prepared = (db, build) => {
  const scope = paramScope();
  const sql = build(scope.add, scope);
  return db.prepare(sql).bind(...scope.values);
};
// A guard of the single routes ({ sql, params } with bare ?) as numbered placeholders of the statement being built.
const numbered = (add, guard) => {
  let at = 0;
  return guard.sql.replace(/\?/g, () => add(guard.params[at++]));
};
const field = (path) => `json_extract(j.value, '$.${path}')`;

// ---------------------------------------------------------------------------
// The facts (one batch): who each key is, whether it may be blocked or restored, and what the write needs (the keys to tombstone, the characters that leave their teams)

function accountFactsStatement(db, ctx, guildContext, ids) {
  const scope = newScope(guildContext.guild, ctx.now(), { signIn: false, viewer: viewerOf(guildContext) });
  const g = scope.g();
  const sql = `WITH ${accountsCte(scope, ids)}
    SELECT a.id AS id, COALESCE(a.display_name, a.global_name, a.username) AS name, ${accountSegmentSql(scope, null)} AS seg, ${ownerSql(g, 'a.id')} AS is_owner,
           ${bestBuiltinSql(g, 'a.id')} AS best, ${ignoredBlockSql(scope, 'a')} AS ignored_block
      FROM a`;
  return db.prepare(sql).bind(...scope.values);
}

function personFactsStatement(db, ctx, guildContext, ids, actorId) {
  const scope = newScope(guildContext.guild, ctx.now(), { signIn: false, viewer: viewerOf(guildContext) });
  const g = scope.g();
  // Every person of the request that is in this guild; has_account says whether the list shows it merged into an account row instead (mergedIntoAccountSql, the list's own test).
  const sql = `WITH solo AS MATERIALIZED (
      SELECT p.id AS id, p.discord_nickname AS nick, ${mergedIntoAccountSql(scope, 'p')} AS has_account
        FROM players p WHERE p.guild_id = ${g} AND p.id IN (SELECT value FROM json_each(${scope.add(JSON.stringify(ids))})))
    SELECT solo.id AS id, ${personNameSql()} AS name, solo.has_account AS has_account, ${personSegmentSql(scope, null)} AS seg,
           ${prospectiveRankSql('solo.id', g)} AS prank, ${ownerSql(g, scope.add(actorId))} AS actor_owner
      FROM solo`;
  return db.prepare(sql).bind(...scope.values);
}

// The characters of the persons behind the request (an account's persons by its link or its Discord id; a person itself): target id, character name, team. What the write needs to
// mark the raids that read them out of date.
function placedStatement(db, guildId, accountIds, personIds) {
  return prepared(db, (add) => {
    const g = add(guildId);
    const parts = [];
    if (accountIds.length) {
      const list = add(JSON.stringify(accountIds));
      parts.push(`SELECT pl.user_id AS target, pl.id AS pid FROM players pl WHERE pl.guild_id = ${g} AND pl.user_id IN (SELECT value FROM json_each(${list}))`);
      parts.push(`SELECT du.id AS target, pd.id AS pid FROM players pd JOIN users du ON du.discord_id = pd.discord_user_id WHERE pd.guild_id = ${g} AND du.id IN (SELECT value FROM json_each(${list}))`);
    }
    if (personIds.length) parts.push(`SELECT pp.id AS target, pp.id AS pid FROM players pp WHERE pp.guild_id = ${g} AND pp.id IN (SELECT value FROM json_each(${add(JSON.stringify(personIds))}))`);
    return `SELECT t.target AS target, c.name AS name, c.team_id AS team_id FROM (${parts.join(' UNION ')}) t JOIN characters c ON c.player_id = t.pid AND c.guild_id = ${g}`;
  });
}

// -> { accountRows: Map<id, row>, personRows: Map<id, row>, keys: Map<id, keys>, placed: Map<target, [{ name, teamId }]> }
async function readFacts(ctx, guildContext, { accounts, persons }, { withPlaced }) {
  const { db } = ctx;
  const guildId = guildContext.guild.id;
  const statements = [];
  const at = {};
  if (accounts.length) { at.accounts = statements.length; statements.push(accountFactsStatement(db, ctx, guildContext, accounts)); }
  if (persons.length) { at.persons = statements.length; statements.push(personFactsStatement(db, ctx, guildContext, persons, guildContext.userId)); }
  if (accounts.length) { at.accountKeys = statements.length; statements.push(...accountKeysStatements(db, accounts, guildId)); }
  if (persons.length) { at.personKeys = statements.length; statements.push(...personKeysStatements(db, persons, guildId)); }
  // A request of nothing but names seen in a log has no account or person to look up: placedStatement would build FROM ().
  const placedWanted = withPlaced && (accounts.length > 0 || persons.length > 0);
  if (placedWanted) { at.placed = statements.length; statements.push(placedStatement(db, guildId, accounts, persons)); }
  const results = statements.length ? await ctx.db.batch(statements) : [];
  const rowsOf = (index) => new Map(results[index].results.map((row) => [row.id, row]));
  const keys = new Map();
  if (accounts.length) for (const [id, value] of keysOfMany([results[at.accountKeys], results[at.accountKeys + 1]])) keys.set(id, value);
  if (persons.length) for (const [id, value] of keysOfMany([results[at.personKeys], results[at.personKeys + 1]])) keys.set(id, value);
  const placed = new Map();
  if (placedWanted) {
    for (const row of results[at.placed].results) {
      if (!placed.has(row.target)) placed.set(row.target, []);
      placed.get(row.target).push({ name: row.name, teamId: row.team_id });
    }
  }
  return { accountRows: accounts.length ? rowsOf(at.accounts) : new Map(), personRows: persons.length ? rowsOf(at.persons) : new Map(), keys, placed };
}

// ---------------------------------------------------------------------------
// The judgement: why a name is skipped, in the order of the single routes' own checks (null = go ahead)

const rankOfRow = (row) => (row.best === null || row.best === undefined ? ROLE_RANK.member : row.best);

function judgeBlockAccount(row, guildContext) {
  if (!row) return 'not_found';
  if (row.is_owner === 1) return 'owner';
  if (row.id === guildContext.userId) return 'self';
  if (rankOfRow(row) === ROLE_RANK.guild_master) return 'guild_master';
  if (!(guildContext.rank < rankOfRow(row))) return 'outranks';
  if (row.seg === 'blocked') return 'already_blocked';
  return null;
}
function judgeBlockPerson(row, guildContext) {
  if (!row) return 'not_found';
  if (row.has_account === 1) return 'has_account';
  if (!(row.actor_owner === 1 || guildContext.rank < row.prank)) return 'outranks';
  if (row.seg === 'blocked') return 'already_blocked';
  return null;
}
// A block on the live Owner is ignored (it blocks nobody): whoever may restore access removes it, no rank to outrank.
const isIgnoredBlock = (row) => row.ignored_block === 1 && row.seg !== 'blocked';
function judgeUnblockAccount(row, guildContext) {
  if (!row) return 'not_found';
  const ignored = isIgnoredBlock(row);
  if (!ignored && row.seg !== 'blocked') return 'not_blocked';
  if (ignored) return null;
  if (row.id === guildContext.userId) return 'self';
  if (rankOfRow(row) === ROLE_RANK.guild_master) return 'guild_master';
  if (!(guildContext.rank < rankOfRow(row))) return 'outranks';
  return null;
}
function judgeUnblockPerson(row, guildContext) {
  if (!row) return 'not_found';
  if (row.seg !== 'blocked') return 'not_blocked';
  if (!(row.actor_owner === 1 || guildContext.rank < row.prank)) return 'outranks';
  return null;
}

// ---------------------------------------------------------------------------
// Block

// The block rows this call wrote: the rows of the batch carry (blocked_by = actor, created_at = now) and a name of the request.
const writtenAccountsSql = (add, cx, ids, as = 'user_id') => `SELECT w.user_id AS ${as} FROM guild_blocks w WHERE w.guild_id = ${add(cx.guildId)} AND w.blocked_by = ${add(cx.actorId)}
    AND w.created_at = ${add(cx.now)} AND w.user_id IN (SELECT value FROM json_each(${add(JSON.stringify(ids))}))`;
const writtenPersonsSql = (add, cx, ids, as = 'player_id') => `SELECT w.player_id AS ${as} FROM person_blocks w WHERE w.guild_id = ${add(cx.guildId)} AND w.blocked_by = ${add(cx.actorId)}
    AND w.created_at = ${add(cx.now)} AND w.player_id IN (SELECT value FROM json_each(${add(JSON.stringify(ids))}))`;

// The persons the blocks written by this call reach: an account's (linked, or carrying its Discord id: worker/membership.js ownPlayerSql) and the account-less ones blocked themselves.
function personsReachedSql(add, cx, accountIds, personIds) {
  const g = add(cx.guildId);
  const parts = [];
  if (accountIds.length) {
    const written = writtenAccountsSql(add, cx, accountIds);
    parts.push(`SELECT pl.id AS pid FROM players pl WHERE pl.guild_id = ${g} AND pl.user_id IN (${written})`);
    parts.push(`SELECT pd.id FROM players pd JOIN users du ON du.discord_id = pd.discord_user_id WHERE pd.guild_id = ${g} AND du.id IN (${written})`);
  }
  if (personIds.length) parts.push(writtenPersonsSql(add, cx, personIds));
  return parts.join(' UNION ');
}

// The same "something was written" test as a guard with bare placeholders (markRaidsStale numbers them itself).
function anyWrittenGuard(cx, accountIds, personIds) {
  const parts = [];
  const params = [];
  if (accountIds.length) {
    parts.push('EXISTS (SELECT 1 FROM guild_blocks w WHERE w.guild_id = ? AND w.blocked_by = ? AND w.created_at = ? AND w.user_id IN (SELECT value FROM json_each(?)))');
    params.push(cx.guildId, cx.actorId, cx.now, JSON.stringify(accountIds));
  }
  if (personIds.length) {
    parts.push('EXISTS (SELECT 1 FROM person_blocks w WHERE w.guild_id = ? AND w.blocked_by = ? AND w.created_at = ? AND w.player_id IN (SELECT value FROM json_each(?)))');
    params.push(cx.guildId, cx.actorId, cx.now, JSON.stringify(personIds));
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

// worker/block-effects.js for a set of names, in the same order: re-version the raids that read what goes, off every team, upcoming native sign-ups (and the open-raid guest sign-ups
// of the accounts), standing sign-ups, the raids that depend on the rosters, the accounts' pending team requests. Every statement reads the persons through the block rows this
// call wrote, so a name whose block was not written changes nothing.
function effectStatements(db, cx, { accountIds, personIds, nameKeys, teamIds }) {
  const guest = (add) => (accountIds.length ? ` OR (s.guest = 1 AND s.guest_user_id IN (${writtenAccountsSql(add, cx, accountIds)}))` : '');
  const statements = [
    prepared(db, (add) => {
      const g = add(cx.guildId);
      const reached = personsReachedSql(add, cx, accountIds, personIds);
      return `UPDATE raids SET policy_fp = '', version = version + 1
        WHERE guild_id = ${g} AND starts_at > ${add(cx.now)}
          AND (team_id IN (SELECT c.team_id FROM characters c WHERE c.guild_id = ${g} AND c.team_id IS NOT NULL AND c.player_id IN (${reached}))
               OR id IN (SELECT s.raid_id FROM raid_signups s WHERE s.guild_id = ${g} AND (s.player_id IN (${reached})${guest(add)})))`;
    }),
    prepared(db, (add) => `UPDATE characters SET team_id = NULL, updated_at = ${add(cx.now)}
        WHERE guild_id = ${add(cx.guildId)} AND team_id IS NOT NULL AND player_id IN (${personsReachedSql(add, cx, accountIds, personIds)})`),
    prepared(db, (add) => {
      const g = add(cx.guildId);
      return `DELETE FROM raid_signups AS s WHERE s.guild_id = ${g} AND s.source = 'raidsmith'
          AND ((s.guest = 0 AND s.player_id IN (${personsReachedSql(add, cx, accountIds, personIds)}))${guest(add)})
          AND s.raid_id IN (SELECT id FROM raids WHERE guild_id = ${g} AND starts_at > ${add(cx.now)})`;
    }),
    prepared(db, (add) => `DELETE FROM standing_signups WHERE guild_id = ${add(cx.guildId)} AND player_id IN (${personsReachedSql(add, cx, accountIds, personIds)})`),
    markRaidsStale(db, cx.guildId, nameKeys, null, teamIds, anyWrittenGuard(cx, accountIds, personIds), weekFreeze(cx.timeZone, cx.now)),
  ];
  if (accountIds.length) {
    statements.push(prepared(db, (add) => `DELETE FROM team_requests WHERE guild_id = ${add(cx.guildId)} AND status = 'pending' AND requested_by IN (${writtenAccountsSql(add, cx, accountIds)})`));
  }
  return statements;
}

// The tombstones of the names blocked, ONE statement per TOMBSTONE_ROWS_PER_STATEMENT rows. rows: [{ r: block_ref, h: hmac }]; a row is written only while its block row is.
function tombstoneStatements(db, cx, version, rows) {
  const out = [];
  for (let from = 0; from < rows.length; from += TOMBSTONE_ROWS_PER_STATEMENT) {
    const chunk = rows.slice(from, from + TOMBSTONE_ROWS_PER_STATEMENT);
    out.push(prepared(db, (add) => {
      const g = add(cx.guildId);
      const ref = "json_extract(j.value, '$.r')";
      const stillWritten = (table, column) => `EXISTS (SELECT 1 FROM ${table} w WHERE w.guild_id = ${g} AND w.${column} = substr(${ref}, 3) AND w.blocked_by = ${add(cx.actorId)} AND w.created_at = ${add(cx.now)})`;
      return `INSERT OR IGNORE INTO block_tombstones (guild_id, block_ref, key_version, hmac, created_at)
        SELECT ${g}, ${ref}, ${add(version)}, ${field('h')}, ${add(cx.now)} FROM json_each(${add(JSON.stringify(chunk))}) j
         WHERE CASE substr(${ref}, 1, 2) WHEN 'u:' THEN ${stillWritten('guild_blocks', 'user_id')} ELSE ${stillWritten('person_blocks', 'player_id')} END`;
    }));
  }
  return out;
}

export async function bulkBlock(ctx, guildContext, { keys, reason }) {
  const sorted = sortKeys(keys);
  const { db } = ctx;
  const guildId = guildContext.guild.id;
  const actorId = guildContext.userId;
  const facts = await readFacts(ctx, guildContext, sorted, { withPlaced: true });
  const outcome = new Map(); // key -> { done: true, kind, name } | { reason, name }
  for (const [key, why] of sorted.skip) outcome.set(key, { reason: why, name: null });
  const go = { accounts: [], persons: [] };
  for (const id of sorted.accounts) {
    const row = facts.accountRows.get(id);
    const why = judgeBlockAccount(row, guildContext);
    if (why) outcome.set(id, { reason: why, name: row ? row.name : null });
    else go.accounts.push(id);
  }
  for (const id of sorted.persons) {
    const row = facts.personRows.get(id);
    const why = judgeBlockPerson(row, guildContext);
    if (why) outcome.set(id, { reason: why, name: row ? row.name : null });
    else go.persons.push(id);
  }
  const chosen = new Set([...go.accounts, ...go.persons]);
  if (chosen.size) {
    const now = ctx.now();
    const cx = { guildId, actorId, now, reason, timeZone: guildContext.guild.time_zone };
    // The tombstones of the keys each name proved: they outlive the block row (worker/block-tombstones.js). No usable TOMBSTONE_KEY: the blocks still apply, flagged for the daily repair.
    const rowsOf = [];
    let version = null;
    let anyMissing = false;
    const flagged = new Map();
    for (const [ids, refOf] of [[go.accounts, accountBlockRef], [go.persons, personBlockRef]]) {
      for (const id of ids) {
        const plan = await planTombstones(ctx.env, guildId, facts.keys.get(id) || {});
        flagged.set(id, plan.missing ? 1 : 0);
        if (plan.missing) anyMissing = true;
        if (plan.hmacs.length) version = plan.version;
        for (const hmac of plan.hmacs) rowsOf.push({ r: refOf(id), h: hmac });
      }
    }
    if (anyMissing) ctx.log(MISSING_KEY_LINE);
    const names = [];
    const teams = new Set();
    for (const id of chosen) for (const character of facts.placed.get(id) || []) { names.push(nameKey(character.name)); if (character.teamId) teams.add(character.teamId); }

    const holds = (add) => numbered(add, actorHolds('guild.access', guildId, actorId));
    const statements = [];
    const at = {};
    if (go.accounts.length) {
      at.accounts = statements.length;
      statements.push(prepared(db, (add) => {
        const g = add(guildId);
        const a = add(actorId);
        const id = field('i');
        return `INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, tombstone_missing)
          SELECT ${g}, ${id}, ${a}, ${add(reason)}, ${add(now)}, ${field('m')} FROM json_each(${add(JSON.stringify(go.accounts.map((i) => ({ i, m: flagged.get(i) }))))}) j
           WHERE ${holds(add)} AND ${outranksSql(g, a, id)} AND NOT ${ownerSql(g, id)}
             AND NOT EXISTS (SELECT 1 FROM guild_blocks x WHERE x.guild_id = ${g} AND x.user_id = ${id})`;
      }), directRowsStatement(db));
    }
    if (go.persons.length) {
      at.persons = statements.length;
      statements.push(prepared(db, (add) => {
        const g = add(guildId);
        const a = add(actorId);
        const id = field('i');
        return `INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, tombstone_missing, created_at)
          SELECT ${g}, ${id}, ${a}, ${add(reason)}, ${field('m')}, ${add(now)} FROM json_each(${add(JSON.stringify(go.persons.map((i) => ({ i, m: flagged.get(i) }))))}) j
           WHERE EXISTS (SELECT 1 FROM players WHERE id = ${id} AND guild_id = ${g}) AND ${accountLessSql(id, g, viewerOf(guildContext))} AND ${holds(add)} AND ${outranksPersonSql(g, a, id)}
             AND NOT EXISTS (SELECT 1 FROM person_blocks x WHERE x.guild_id = ${g} AND x.player_id = ${id})`;
      }), directRowsStatement(db));
    }
    statements.push(...tombstoneStatements(db, cx, version, rowsOf));
    statements.push(...effectStatements(db, cx, { accountIds: go.accounts, personIds: go.persons, nameKeys: names, teamIds: [...teams] }));
    // The reason text stays out of the audit log, like the single routes.
    if (go.accounts.length) {
      statements.push(auditManyStatement(ctx, {
        guildId, actorUserId: actorId, action: 'access.remove', entityType: 'user', before: { blocked: false }, after: { blocked: true, reasonSet: reason !== null },
      }, (add) => writtenAccountsSql(add, cx, go.accounts, 'entity_id')));
    }
    if (go.persons.length) {
      statements.push(auditManyStatement(ctx, {
        guildId, actorUserId: actorId, action: 'person.block', entityType: 'person', before: { blocked: false }, after: { blocked: true, reasonSet: reason !== null },
      }, (add) => writtenPersonsSql(add, cx, go.persons, 'entity_id')));
    }
    let results;
    try {
      results = await db.batch(statements);
    } catch (error) {
      // A concurrent identical block won the primary key: nothing of this batch was written.
      if (isUniqueViolation(error)) throw conflict();
      throw error;
    }
    // The own-row counts (changes() right behind each INSERT): meta.changes would add cascade and trigger rows.
    const written = (at.accounts === undefined ? 0 : directRows(results[at.accounts + 1])) + (at.persons === undefined ? 0 : directRows(results[at.persons + 1]));
    let blocked = chosen;
    if (written !== chosen.size) blocked = await blocksOf(db, cx, go);
    for (const id of chosen) {
      const row = facts.accountRows.get(id) || facts.personRows.get(id);
      outcome.set(id, blocked.has(id) ? { done: true, kind: facts.accountRows.has(id) ? 'account' : 'person', name: row.name } : { reason: 'conflict', name: row.name });
    }
  }
  return reply('block', sorted, outcome);
}

// Which of the chosen names carry a block row written by this call (after a batch whose count differs from the request: a guard said no).
async function blocksOf(db, cx, go) {
  const found = await prepared(db, (add) => {
    const parts = [];
    if (go.accounts.length) parts.push(`SELECT user_id AS id FROM (${writtenAccountsSql(add, cx, go.accounts)})`);
    if (go.persons.length) parts.push(`SELECT player_id AS id FROM (${writtenPersonsSql(add, cx, go.persons)})`);
    return parts.join(' UNION ALL ');
  }).all();
  return new Set(found.results.map((row) => row.id));
}

// ---------------------------------------------------------------------------
// Unblock

// The guards of one name, as SQL over a row of JSON ({ i: id, g: 1 when the block is the live Owner's ignored row }) the statement walks with json_each. The same tests as the single
// routes' batches: the block is still there, the actor still holds guild.access, and the rank test (an ignored Owner row: the target is still the Owner).
function unblockGuards(add, cx) {
  const g = add(cx.guildId);
  const a = add(cx.actorId);
  const holds = numbered(add, actorHolds('guild.access', cx.guildId, cx.actorId));
  return {
    account: (id, ignored) => `(EXISTS (SELECT 1 FROM guild_blocks b WHERE b.guild_id = ${g} AND b.user_id = ${id}) AND ${holds}
        AND CASE WHEN ${ignored} = 1 THEN ${ownerSql(g, id)} ELSE ${outranksSql(g, a, id)} END)`,
    person: (id) => `(EXISTS (SELECT 1 FROM person_blocks b WHERE b.guild_id = ${g} AND b.player_id = ${id}) AND ${holds} AND ${outranksPersonSql(g, a, id)})`,
  };
}

export async function bulkUnblock(ctx, guildContext, { keys }) {
  const sorted = sortKeys(keys);
  const { db } = ctx;
  const guildId = guildContext.guild.id;
  const actorId = guildContext.userId;
  const facts = await readFacts(ctx, guildContext, sorted, { withPlaced: false });
  const outcome = new Map();
  for (const [key, why] of sorted.skip) outcome.set(key, { reason: why, name: null });
  const go = { accounts: [], persons: [] };
  for (const id of sorted.accounts) {
    const row = facts.accountRows.get(id);
    const why = judgeUnblockAccount(row, guildContext);
    if (why) outcome.set(id, { reason: why, name: row ? row.name : null });
    else go.accounts.push(id);
  }
  for (const id of sorted.persons) {
    const row = facts.personRows.get(id);
    const why = judgeUnblockPerson(row, guildContext);
    if (why) outcome.set(id, { reason: why, name: row ? row.name : null });
    else go.persons.push(id);
  }
  const chosen = new Set([...go.accounts, ...go.persons]);
  const keptRefs = new Set();
  if (chosen.size) {
    const cx = { guildId, actorId };
    const accountRows = go.accounts.map((i) => ({ i, g: isIgnoredBlock(facts.accountRows.get(i)) ? 1 : 0 }));
    const personRows = go.persons.map((i) => ({ i }));
    // The refs of the earlier blocks this name's keys hit: lifted with the unblock only as far as the actor may (the single routes' splitLiftableRefs, once for all names).
    const own = (id) => (facts.accountRows.has(id) ? accountBlockRef(id) : personBlockRef(id));
    const matched = await matchedRefsOfMany(db, ctx.env, guildId, new Map([...chosen].map((id) => [id, facts.keys.get(id) || {}])));
    const perTarget = new Map([...chosen].map((id) => [id, matched.refs.get(id).filter((ref) => ref !== own(id))]));
    const everyRef = [...new Set([...perTarget.values()].flat())];
    const split = await splitLiftableRefs(db, guildId, everyRef, { owner: everyRef.length ? await isOwner(db, guildId, actorId) : false, rank: guildContext.rank, actorId });
    const liftRows = [];
    const byBlockerRows = [];
    for (const id of chosen) {
      const base = { k: facts.accountRows.has(id) ? 'u' : 'p', i: id, g: facts.accountRows.has(id) && isIgnoredBlock(facts.accountRows.get(id)) ? 1 : 0 };
      for (const ref of perTarget.get(id)) {
        if (split.lift.includes(ref)) liftRows.push({ ...base, r: ref });
        else if (split.byBlocker.includes(ref)) byBlockerRows.push({ ...base, r: ref });
        else keptRefs.add(ref);
      }
    }

    const acct = JSON.stringify(accountRows);
    const pers = JSON.stringify(personRows);
    const statements = [];
    const source = (add, guards, which) => (which === 'account'
      ? `SELECT ${field('i')} AS entity_id FROM json_each(${add(acct)}) j WHERE ${guards.account(field('i'), field('g'))}`
      : `SELECT ${field('i')} AS entity_id FROM json_each(${add(pers)}) j WHERE ${guards.person(field('i'))}`);
    if (accountRows.length) {
      statements.push(auditManyStatement(ctx, {
        guildId, actorUserId: actorId, action: 'access.restore', entityType: 'user', before: { blocked: true }, after: { blocked: false },
      }, (add) => source(add, unblockGuards(add, cx), 'account')));
    }
    if (personRows.length) {
      statements.push(auditManyStatement(ctx, {
        guildId, actorUserId: actorId, action: 'person.unblock', entityType: 'person', before: { blocked: true }, after: { blocked: false },
      }, (add) => source(add, unblockGuards(add, cx), 'person')));
    }
    // The names' own tombstones.
    statements.push(prepared(db, (add) => {
      const guards = unblockGuards(add, cx);
      const parts = [];
      if (accountRows.length) parts.push(`SELECT 'u:' || ${field('i')} FROM json_each(${add(acct)}) j WHERE ${guards.account(field('i'), field('g'))}`);
      if (personRows.length) parts.push(`SELECT 'p:' || ${field('i')} FROM json_each(${add(pers)}) j WHERE ${guards.person(field('i'))}`);
      return `DELETE FROM block_tombstones WHERE guild_id = ${add(guildId)} AND block_ref IN (${parts.join(' UNION ALL ')})`;
    }));
    // The refs of earlier blocks: the ones this actor's rank allows, and the ones the actor made themselves. Each ref goes only while the name it was hit by is being unblocked.
    const liftStatement = (rows, extra) => prepared(db, (add) => {
      const guards = unblockGuards(add, cx);
      const row = (path) => `json_extract(m.value, '$.${path}')`;
      const target = `CASE ${row('k')} WHEN 'u' THEN ${guards.account(row('i'), row('g'))} ELSE ${guards.person(row('i'))} END`;
      return `DELETE FROM block_tombstones WHERE guild_id = ${add(guildId)} AND block_ref IN (
          SELECT ${row('r')} FROM json_each(${add(JSON.stringify(rows))}) m WHERE ${target} AND ${numbered(add, extra)})`;
    });
    if (liftRows.length) statements.push(liftStatement(liftRows, liftGuard(guildId, actorId, split.minBlockerRank)));
    if (byBlockerRows.length) statements.push(liftStatement(byBlockerRows, madeByGuard(guildId, actorId, [...new Set(byBlockerRows.map((row) => row.r))])));
    const at = {};
    if (accountRows.length) {
      at.accounts = statements.length;
      statements.push(prepared(db, (add) => `DELETE FROM guild_blocks WHERE guild_id = ${add(guildId)} AND user_id IN (${source(add, unblockGuards(add, cx), 'account')})`), directRowsStatement(db));
    }
    if (personRows.length) {
      at.persons = statements.length;
      statements.push(prepared(db, (add) => `DELETE FROM person_blocks WHERE guild_id = ${add(guildId)} AND player_id IN (${source(add, unblockGuards(add, cx), 'person')})`), directRowsStatement(db));
    }
    const results = await db.batch(statements);
    const removed = (at.accounts === undefined ? 0 : directRows(results[at.accounts + 1])) + (at.persons === undefined ? 0 : directRows(results[at.persons + 1]));
    // Somebody else restoring first is fine; a block that is still there means this actor lost the right between the read and the write.
    let remaining = new Set();
    if (removed !== chosen.size) {
      const left = await prepared(db, (add) => {
        const parts = [];
        if (accountRows.length) parts.push(`SELECT user_id AS id FROM guild_blocks WHERE guild_id = ${add(guildId)} AND user_id IN (SELECT value FROM json_each(${add(JSON.stringify(go.accounts))}))`);
        if (personRows.length) parts.push(`SELECT player_id AS id FROM person_blocks WHERE guild_id = ${add(guildId)} AND player_id IN (SELECT value FROM json_each(${add(JSON.stringify(go.persons))}))`);
        return parts.join(' UNION ALL ');
      }).all();
      remaining = new Set(left.results.map((row) => row.id));
    }
    for (const id of chosen) {
      const row = facts.accountRows.get(id) || facts.personRows.get(id);
      outcome.set(id, remaining.has(id) ? { reason: 'conflict', name: row.name } : { done: true, kind: facts.accountRows.has(id) ? 'account' : 'person', name: row.name });
    }
  }
  return reply('unblock', sorted, outcome, keptRefs.size ? { tombstonesKept: keptRefs.size } : {});
}

// ---------------------------------------------------------------------------
// The reply, in the order of the request

function reply(action, sorted, outcome, extra = {}) {
  const done = [];
  const skipped = [];
  for (const key of sorted.order) {
    const entry = outcome.get(key);
    if (entry.done) done.push({ key, kind: entry.kind, name: entry.name });
    else skipped.push({ key, name: entry.name, reason: entry.reason, message: SKIP_MESSAGES[entry.reason] });
  }
  return { action, done, skipped, cap: BULK_MAX_NAMES, ...extra };
}
