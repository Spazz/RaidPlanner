// The Users list of a guild (user-hierarchy build, lane B7b part 1; plan "Users API/UI", H-Q26..H-Q36, U R4-Q8): everyone who interacted with THIS guild, in four segments, paged
// and sorted. READ ONLY. The routes are in worker/routes/users.js; tasks/open/b7b-api-contract.md (outside git) is the written contract.
//
//   members ....... current members by the guild's rank source (worker/membership.js): accounts AND account-less roster persons
//   former ........ the person's characters are ALL Former (left_on): an account with such a person, or an account-less person
//   nonmembers .... everyone else: accounts that are no member (applicants, Discord server members the source does not let in, Discord sign-ins, open-raid guests), persons
//                   not on the in-game roster, and NAMES (kind 'name'): sightings that resolve to no character (guest sign-ups, Raid-Helper sign-ups, applications, raid log, loot)
//   blocked ....... guild_blocks (accounts; a block on the unsuspended Owner is ignored, as everywhere) and person_blocks (account-less persons)
// A person who HAS an account (players.user_id, or the Discord id they carry) is listed once, as the account. Precedence: blocked > member (the rank source's rule, which already lets the
// live Owner of an 'ingame' guild in; the Owner is never Former) > former > non-member.
//
// A row is an `account` (key = users.id), a `person` (key = players.id) or a `name` (key = 'n_' + the hex of the lower-cased name: a typed or logged name). A key never carries a
// Discord id, a Battle.net account id or a BattleTag.
//
// HOW IT IS READ (D1: at most 45 statements, 5 compound terms, 100 bound parameters; nothing walks a table):
//   core ......... accounts (candidates from indexed lookups) and persons are classified in SQL, the requested segment is sorted in SQL (ORDER BY ... LIMIT offset + limit + 1)
//   names ........ ONE grouped statement over every sighting source (a name seen in two sources is one row with both tags); loot and the raid log are enumerated by a loose
//                  index scan (one index seek per DISTINCT name, not one read per award or pull), the sign-ups through the partial index of migration 0038
//   merge ........ the two lists are merged in JS under the same comparator (sort value, name, kind, key) and cut to the page; the display columns of the page rows come from
//                  a second round of statements that read ONLY those rows
// The sort key is computed for every row of the segment; the display columns are not, so Last seen costs a pass over the guild's evidence rows only when it is the sort.
import { HttpError } from './http.js';
import { visibleCharacterSql } from './character-visibility.js';
import { serverIdIsDiscordSql } from './discord-guard.js';
import { blockedSql, personOnRosterSql, rankSourceSql, reachesGuildSql } from './membership.js';
import { ownerCandidatesSql, ownerSql, seatHeldBySql } from './owner.js';
import { CORE_RANK_IDS } from './rank-map.js';
import { todayIn } from './roster-data.js';
import { offsetModifier, zoneOffsetMinutes } from './trial-clock.js';

export const USERS_SEGMENTS = Object.freeze(['members', 'former', 'nonmembers', 'blocked']);
export const USERS_SORTS = Object.freeze(['user', 'main', 'permission', 'lastSeen']);
// The where-from tags of a non-member (the mockup's filter). An account carries any of the first four (discord_signin: it sits in the guild's Discord server; raid_helper: its Discord id
// is on a Raid-Helper sign-up that names no person); a name carries any of application, guest_signup, raid_helper, raid_log and loot (several at once when it was seen in several places).
export const USERS_TAGS = Object.freeze(['discord_signin', 'application', 'guest_signup', 'raid_helper', 'raid_log', 'loot']);
export const ACCOUNT_TAGS = Object.freeze(USERS_TAGS.slice(0, 4));
export const USERS_DEFAULT_LIMIT = 50;
export const USERS_MAX_LIMIT = 100;
// offset + limit rows come back from each of the two lists, so the window is capped.
export const USERS_MAX_OFFSET = 5000;
export const USERS_MAX_QUERY = 40;

// Last seen: plan v9 (tasks/todo.md, "Users API/UI") counts the latest raid-level guild fact (attendance, sign-up, loot, application), never the account-wide sign-in; the
// user's H-Q36 (2026-10-25) says newest activity anywhere INCLUDING sign-in. The sign-in is ONE isolated term, off until the user decides. A test pins both settings.
export const LAST_SEEN_INCLUDES_SIGN_IN = false;

export const ROLE_LABELS = Object.freeze({ guild_master: 'Guild Master', officer: 'Officer', team_lead: 'Team Lead' });

const bad = (message, field) => new HttpError(400, 'bad_request', message, { field });

// ---------------------------------------------------------------------------
// The query string

// -> { segment, sort, dir, offset, limit, q, rank, from } (q: { core, name } LIKE patterns or null). Throws 400 with the field name.
export function parseUsersQuery(searchParams) {
  const one = (name) => (searchParams.has(name) ? searchParams.get(name) : null);
  const choose = (name, allowed, fallback) => {
    const value = one(name);
    if (value === null || value === '') return fallback;
    if (!allowed.includes(value)) throw bad(`${name} must be one of: ${allowed.join(', ')}.`, name);
    return value;
  };
  const whole = (name, fallback, max, min = 0) => {
    const value = one(name);
    if (value === null || value === '') return fallback;
    if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`, name);
    return Number(value);
  };
  const text = (one('q') || '').trim();
  if (text.length > USERS_MAX_QUERY) throw bad(`q is at most ${USERS_MAX_QUERY} characters.`, 'q');
  // LIKE patterns of a prefix search: the core rows compare lower(), which only folds ASCII, the names compare their stored lower-case key (full folding).
  const escape = (value) => `${value.replace(/[\\%_]/g, '\\$&')}%`;
  const ascii = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return {
    segment: choose('segment', USERS_SEGMENTS, 'members'),
    sort: choose('sort', USERS_SORTS, 'user'),
    dir: choose('dir', ['asc', 'desc'], 'asc'),
    offset: whole('offset', 0, USERS_MAX_OFFSET),
    limit: whole('limit', USERS_DEFAULT_LIMIT, USERS_MAX_LIMIT, 1),
    q: text ? { core: escape(ascii), name: escape(text.normalize('NFC').toLowerCase()) } : null,
    rank: choose('rank', CORE_RANK_IDS, null),
    from: choose('from', USERS_TAGS, null),
  };
}

// ---------------------------------------------------------------------------
// SQL fragments. Every statement numbers its own placeholders (?1, ?2, ... in the order the text first needs a value); a scope hands them out once each.

export function newScope(guild, now, { signIn }) {
  const values = [];
  const place = (value) => { values.push(value); return `?${values.length}`; };
  const once = (value) => {
    let placeholder = null;
    return () => placeholder || (placeholder = place(value));
  };
  return {
    values,
    add: place,
    g: once(guild.id),
    s: once(guild.discord_server_id === undefined ? null : guild.discord_server_id),
    today: once(todayIn(guild.time_zone, now)),
    mod: once(offsetModifier(zoneOffsetMinutes(guild.time_zone, now))),
    signIn,
  };
}

// The accounts that can be in the list: a SUPERSET of the accounts of this guild (the segment tests decide), every lookup index-backed. Two FROM-subqueries of at most five
// terms each (D1's compound limit), their union at the top.
function candidateAccountsSql(sc) {
  const g = sc.g();
  return `SELECT user_id FROM (
      SELECT us.user_id AS user_id FROM user_servers us WHERE us.server_id = ${sc.s()} AND ${serverIdIsDiscordSql('us.server_id')}
      UNION SELECT lp.user_id FROM players lp WHERE lp.guild_id = ${g} AND lp.user_id IS NOT NULL
      UNION SELECT du.id FROM players dp JOIN users du ON du.discord_id = dp.discord_user_id WHERE dp.guild_id = ${g} AND dp.discord_user_id IS NOT NULL
      UNION SELECT er.user_id FROM effective_roles_stored er WHERE er.guild_id = ${g}
      UNION SELECT oc.user_id FROM (${ownerCandidatesSql(g)}) oc)
    UNION SELECT user_id FROM (
      SELECT gb.user_id AS user_id FROM guild_blocks gb WHERE gb.guild_id = ${g}
      UNION SELECT pa.user_id FROM applications pa WHERE pa.guild_id = ${g} AND pa.user_id IS NOT NULL
      UNION SELECT gs.guest_user_id FROM raids gr JOIN raid_signups gs ON gs.raid_id = gr.id WHERE gr.guild_id = ${g} AND gs.guest_user_id IS NOT NULL
      UNION SELECT ru.id FROM raid_signups rs JOIN users ru ON ru.discord_id = rs.discord_user_id WHERE ${unresolvedHelperSql(sc, 'rs')})`;
}

// The person of an account in this guild: the one it is linked to (players.user_id), else the one carrying its Discord id (an account has at most one of each).
export const personOfAccountSql = (g, userExpr, discordExpr) => `COALESCE((SELECT pl.id FROM players pl WHERE pl.guild_id = ${g} AND pl.user_id = ${userExpr}),
    (SELECT pd.id FROM players pd WHERE pd.guild_id = ${g} AND pd.discord_user_id = ${discordExpr}))`;

// CTE `a`: the candidate accounts with the columns the tests and the name need, and their person (computed once per account). `only`: one account's id (a user's page).
export const accountsCte = (sc, only = null) => `a AS MATERIALIZED (
  SELECT u.id AS id, u.discord_id AS discord_id, u.username AS username, u.global_name AS global_name, u.display_name AS display_name, u.last_seen_at AS last_seen_at,
         ${personOfAccountSql(sc.g(), 'u.id', 'u.discord_id')} AS pid
    FROM users u WHERE u.id IN (${candidateAccountsSql(sc)})${only ? ` AND u.id = ${sc.add(only)}` : ''})`;

// CTE `solo`: the account-less persons (no players.user_id and no account holding the Discord id they carry). `only`: one person's id.
export const personsCte = (sc, only = null) => `solo AS MATERIALIZED (
  SELECT p.id AS id, p.discord_nickname AS nick FROM players p
   WHERE p.guild_id = ${sc.g()} AND p.user_id IS NULL AND NOT EXISTS (SELECT 1 FROM users du WHERE du.discord_id = p.discord_user_id)${only ? ` AND p.id = ${sc.add(only)}` : ''})`;

// The person has characters and every one of them is Former (worker/person-rank.js leftOn): read through characters_player only.
const formerSql = (pid) => `(EXISTS (SELECT 1 FROM characters fv WHERE fv.player_id = ${pid} AND ${visibleCharacterSql('fv')})
    AND NOT EXISTS (SELECT 1 FROM characters fh WHERE fh.player_id = ${pid} AND ${visibleCharacterSql('fh')} AND fh.left_on IS NULL))`;

const mainNameSql = (pid) => `(SELECT mc.name FROM characters mc WHERE mc.player_id = ${pid} AND mc.is_main = 1 AND ${visibleCharacterSql('mc')})`;
const mainRankSql = (pid, rankPlaceholder) => `EXISTS (SELECT 1 FROM characters rc WHERE rc.player_id = ${pid} AND rc.is_main = 1 AND ${visibleCharacterSql('rc')} AND rc.core_rank = ${rankPlaceholder})`;

const ACCOUNT_NAME = 'COALESCE(a.display_name, a.global_name, a.username)';
export const personNameSql = () => `COALESCE(${mainNameSql('solo.id')},
    (SELECT fc.name FROM characters fc WHERE fc.player_id = solo.id AND ${visibleCharacterSql('fc')} ORDER BY fc.name LIMIT 1), solo.nick, 'Unnamed')`;

// The segment of an account as ONE SQL test (segment given) or as the CASE the counts group by (segment null). The account rule: a block wins (the live Owner is never
// blocked), then the rank source's membership rule (worker/membership.js reachesGuildSql: for an 'ingame' guild it already lets the live Owner in); an account that reaches the
// guild is a member unless its person's characters have all left (Former), and the Owner is never Former; an account that does not reach it is Former when its person has all
// left, else a non-member. Built on demand: a placeholder is only registered by text that is used.
export function accountSegmentSql(sc, segment) {
  const blocked = () => blockedSql('a.id', sc.g());
  const owner = () => ownerSql(sc.g(), 'a.id');
  const former = () => formerSql('a.pid');
  const reaches = () => reachesGuildSql('a.id', sc.g(), sc.s());
  switch (segment) {
    case 'members': return `NOT ${blocked()} AND ${reaches()} AND (${owner()} OR NOT ${former()})`;
    case 'former': return `NOT ${blocked()} AND ${former()} AND NOT (${reaches()} AND ${owner()})`;
    case 'nonmembers': return `NOT ${blocked()} AND NOT ${former()} AND NOT ${reaches()}`;
    case 'blocked': return blocked();
    default: return `CASE WHEN ${blocked()} THEN 'blocked' WHEN ${reaches()} AND (${owner()} OR NOT ${former()}) THEN 'members' WHEN ${former()} THEN 'former' ELSE 'nonmembers' END`;
  }
}

// The same for an account-less person: a member while it is on the in-game roster (an 'ingame' guild) or, in every other guild, as long as it is not Former.
export function personSegmentSql(sc, segment) {
  const blocked = () => `EXISTS (SELECT 1 FROM person_blocks pb WHERE pb.guild_id = ${sc.g()} AND pb.player_id = solo.id)`;
  const former = () => formerSql('solo.id');
  const member = () => `CASE ${rankSourceSql(sc.g())} WHEN 'ingame' THEN ${personOnRosterSql('solo.id', sc.g())} ELSE 1 END`;
  switch (segment) {
    case 'members': return `NOT ${blocked()} AND NOT ${former()} AND ${member()}`;
    case 'former': return `NOT ${blocked()} AND ${former()}`;
    case 'nonmembers': return `NOT ${blocked()} AND NOT ${former()} AND NOT ${member()}`;
    case 'blocked': return blocked();
    default: return `CASE WHEN ${blocked()} THEN 'blocked' WHEN ${former()} THEN 'former' WHEN ${member()} THEN 'members' ELSE 'nonmembers' END`;
  }
}

// Last seen as a scalar subquery: the latest DATE (guild time zone) of the raid-level facts of a person (pid) and, for an account, of its own (uid): attendance in a raid, a
// sign-up on a raid that has been held (a person's, an open-raid guest's), a loot award on one of the person's characters, an application. Raids are dated by raids.raid_on
// (a guild-local date already); an application by its time stamp in the guild's zone at the offset of NOW (a time near a DST change can be an hour off). The sign-in
// (signInExpr: a users.last_seen_at expression) is the one isolated term, only when the scope says so.
export function lastSeenSql(sc, { pid, uid = null, signInExpr = null }) {
  const terms = [
    `SELECT MAX(sr.raid_on) AS d FROM attendance sa JOIN raids sr ON sr.id = sa.raid_id WHERE sa.player_id = ${pid} AND sa.attended = 1`,
    `SELECT MAX(gr.raid_on) FROM raid_signups sg JOIN raids gr ON gr.id = sg.raid_id WHERE (sg.player_id = ${pid}${uid ? ` OR sg.guest_user_id = ${uid}` : ''}) AND gr.raid_on <= ${sc.today()}`,
    // CROSS JOIN fixes the order (SQLite never reorders it): the person's few characters first, then their awards by loot_awards_winner. Left to itself the planner may start from
    // the awards of the whole guild (loot_awards_item) and probe the characters for each.
    `SELECT MAX(lr.raid_on) FROM characters lc CROSS JOIN loot_awards la ON la.guild_id = ${sc.g()} AND la.winner_name_key = lc.name_key AND la.winner_realm_key = lc.realm_key
       JOIN raids lr ON lr.id = la.raid_id WHERE lc.player_id = ${pid}`,
  ];
  if (uid) terms.push(`SELECT date(MAX(ap.created_at) / 1000, 'unixepoch', ${sc.mod()}) FROM applications ap WHERE ap.user_id = ${uid} AND ap.guild_id = ${sc.g()}`);
  if (uid && signInExpr && sc.signIn) terms.push(`SELECT date(${signInExpr} / 1000, 'unixepoch', ${sc.mod()})`);
  return `(SELECT MAX(d) FROM (${terms.join(' UNION ALL ')}))`;
}

// The permission of an account: the best built-in role (0 Guild Master, 1 Officer, 2 Team Lead) and the first custom role by name, both from effective_roles.
export const bestBuiltinSql = (g, userExpr) => `(SELECT MIN(CASE er.role_id WHEN 'guild_master' THEN 0 WHEN 'officer' THEN 1 WHEN 'team_lead' THEN 2 END)
    FROM effective_roles er WHERE er.guild_id = ${g} AND er.user_id = ${userExpr})`;
export const customNameSql = (g, userExpr) => `(SELECT MIN(cr.name) FROM effective_roles ec JOIN roles cr ON cr.id = ec.role_id WHERE ec.guild_id = ${g} AND ec.user_id = ${userExpr} AND cr.guild_id = ${g})`;

// The Raid-Helper sign-ups of the guild that name nobody on the roster (no person, no account link) but carry a Discord id: the sign-up is a sighting of that Discord id, so when an
// account holds the id the sign-up belongs to the ACCOUNT (a Discord ID match is proof, H-Q30) and is no name row. Read through raid_signups_unresolved (migration 0038).
const unresolvedHelperSql = (sc, alias) => `${alias}.guild_id = ${sc.g()} AND ${alias}.player_id IS NULL AND ${alias}.guest_user_id IS NULL AND ${alias}.nickname IS NOT NULL
    AND ${alias}.source = 'raid_helper' AND ${alias}.discord_user_id IS NOT NULL`;

// The where-from tags of an ACCOUNT (alias: the users / CTE alias of the account) as one test each (also the `from` filter). Each is index-backed: the account's own user_servers /
// applications / guest sign-up rows, or one pass over the guild's few unresolved Raid-Helper sign-ups.
export function accountTagSql(sc, tag, alias) {
  if (tag === 'discord_signin') return `EXISTS (SELECT 1 FROM user_servers ts WHERE ts.user_id = ${alias}.id AND ts.server_id = ${sc.s()} AND ${serverIdIsDiscordSql('ts.server_id')})`;
  if (tag === 'application') return `EXISTS (SELECT 1 FROM applications ta WHERE ta.user_id = ${alias}.id AND ta.guild_id = ${sc.g()})`;
  if (tag === 'guest_signup') return `EXISTS (SELECT 1 FROM raid_signups tg WHERE tg.guest_user_id = ${alias}.id AND tg.guild_id = ${sc.g()})`;
  if (tag === 'raid_helper') return `${alias}.discord_id IN (SELECT th.discord_user_id FROM raid_signups th WHERE ${unresolvedHelperSql(sc, 'th')})`;
  return null;
}

// ---------------------------------------------------------------------------
// The names: sightings that resolve to no character, one row per name key

// A name key no character of the guild carries now or carried before (a dated alias): the sighting names nobody on the roster.
export const unresolvedSql = (sc, keyExpr) => `(NOT EXISTS (SELECT 1 FROM characters ch WHERE ch.guild_id = ${sc.g()} AND ch.name_key = ${keyExpr})
    AND NOT EXISTS (SELECT 1 FROM character_name_aliases al WHERE al.guild_id = ${sc.g()} AND al.name_key = ${keyExpr}))`;

// The distinct values of an indexed column of one guild, by a loose index scan: one index seek per distinct value (not one read per row).
const looseScan = (name, table, column, sc) => `${name}(k) AS (
  SELECT MIN(${column}) FROM ${table} WHERE guild_id = ${sc.g()}
  UNION ALL SELECT (SELECT MIN(${column}) FROM ${table} WHERE guild_id = ${sc.g()} AND ${column} > ${name}.k) FROM ${name} WHERE ${name}.k IS NOT NULL)`;

// The CTEs the names need and the CTE `nm` itself: (nk, nm, rlm, cls, seen, tags). Six sources; D1 allows five terms in one compound, so five sit in a FROM-subquery.
function namesCtes(sc) {
  const g = sc.g();
  const loot = `SELECT ln.k AS nk,
      (SELECT la.winner_name FROM loot_awards la WHERE la.guild_id = ${g} AND la.winner_name_key = ln.k LIMIT 1) AS nm,
      (SELECT la.winner_realm FROM loot_awards la WHERE la.guild_id = ${g} AND la.winner_name_key = ln.k LIMIT 1) AS rlm,
      (SELECT la.winner_class FROM loot_awards la WHERE la.guild_id = ${g} AND la.winner_name_key = ln.k LIMIT 1) AS cls,
      (SELECT MAX(lr.raid_on) FROM loot_awards la JOIN raids lr ON lr.id = la.raid_id WHERE la.guild_id = ${g} AND la.winner_name_key = ln.k) AS seen,
      'loot' AS tag
    FROM ln WHERE ln.k IS NOT NULL AND ${unresolvedSql(sc, 'ln.k')}`;
  const log = `SELECT lg.k,
      (SELECT rp.name FROM raid_presence rp WHERE rp.guild_id = ${g} AND rp.name_key = lg.k LIMIT 1),
      (SELECT rp.realm FROM raid_presence rp WHERE rp.guild_id = ${g} AND rp.name_key = lg.k LIMIT 1),
      (SELECT rp.class FROM raid_presence rp WHERE rp.guild_id = ${g} AND rp.name_key = lg.k LIMIT 1),
      (SELECT MAX(lr.raid_on) FROM raid_presence rp JOIN raids lr ON lr.id = rp.raid_id WHERE rp.guild_id = ${g} AND rp.name_key = lg.k),
      'raid_log'
    FROM lg WHERE lg.k IS NOT NULL AND ${unresolvedSql(sc, 'lg.k')}`;
  const manual = `SELECT mn.name_key, MIN(mn.name), MIN(mn.realm), NULL, MAX(mr.raid_on), 'raid_log'
    FROM raids mr JOIN raid_manual_names mn ON mn.raid_id = mr.id WHERE mr.guild_id = ${g} AND ${unresolvedSql(sc, 'mn.name_key')} GROUP BY mn.name_key`;
  const guests = `SELECT ag.name_key, MIN(ag.name), NULL, NULL, NULL, 'raid_log' FROM attendance_guests ag WHERE ag.guild_id = ${g} AND ${unresolvedSql(sc, 'ag.name_key')} GROUP BY ag.name_key`;
  const applications = `SELECT ap.name_key, MIN(ap.char_name), MIN(ap.realm), MIN(ap.class), date(MAX(ap.created_at) / 1000, 'unixepoch', ${sc.mod()}), 'application'
    FROM applications ap WHERE ap.guild_id = ${g} AND ap.user_id IS NULL AND ${unresolvedSql(sc, 'ap.name_key')} GROUP BY ap.name_key`;
  // Sign-ups that name nobody (no person, no account): a guest of a guest link ('raidsmith' source) or a Raid-Helper sign-up. A plan seat is a plan, not a sighting. The date is
  // the latest raid already held.
  const signups = `SELECT lower(sn.nickname), MIN(sn.nickname), NULL, NULL, MAX(CASE WHEN sr.raid_on <= ${sc.today()} THEN sr.raid_on END),
      CASE sn.source WHEN 'raid_helper' THEN 'raid_helper' ELSE 'guest_signup' END
    FROM raid_signups sn JOIN raids sr ON sr.id = sn.raid_id
   WHERE sn.guild_id = ${g} AND sn.player_id IS NULL AND sn.guest_user_id IS NULL AND sn.nickname IS NOT NULL AND sn.source IN ('raid_helper', 'raidsmith')
     AND ${unresolvedSql(sc, 'lower(sn.nickname)')}
     AND NOT (sn.source = 'raid_helper' AND EXISTS (SELECT 1 FROM users sd WHERE sd.discord_id = sn.discord_user_id))
   GROUP BY lower(sn.nickname), sn.source`;
  return `${looseScan('ln', 'loot_awards', 'winner_name_key', sc)},
  ${looseScan('lg', 'raid_presence', 'name_key', sc)},
  nm AS (
    SELECT x.nk AS nk, COALESCE(MIN(x.nm), x.nk) AS nm, MIN(x.rlm) AS rlm, MIN(x.cls) AS cls, MAX(x.seen) AS seen, group_concat(DISTINCT x.tag) AS tags
      FROM (SELECT * FROM (${loot} UNION ALL ${log} UNION ALL ${manual} UNION ALL ${guests} UNION ALL ${applications}) UNION ALL ${signups}) x
     GROUP BY x.nk)`;
}

// ---------------------------------------------------------------------------
// The statements of one request

// Sort keys of an account row (alias a), a person row (alias solo) and a name row (columns of nm). s1 is the sort value (NULL sorts last in both directions), s2 breaks a tie of
// s1 (permission only: the custom role's name).
function accountSortKeys(sc, sort) {
  const g = sc.g();
  if (sort === 'user') return { s1: `lower(${ACCOUNT_NAME})`, s2: 'NULL' };
  if (sort === 'main') return { s1: `lower(${mainNameSql('a.pid')})`, s2: 'NULL' };
  if (sort === 'permission') {
    return { s1: `COALESCE(${bestBuiltinSql(g, 'a.id')}, CASE WHEN ${customNameSql(g, 'a.id')} IS NOT NULL THEN 3 END, 4)`, s2: `lower(COALESCE(${customNameSql(g, 'a.id')}, ''))` };
  }
  return { s1: lastSeenSql(sc, { pid: 'a.pid', uid: 'a.id', signInExpr: 'a.last_seen_at' }), s2: 'NULL' };
}
function personSortKeys(sc, sort) {
  if (sort === 'user') return { s1: `lower(${personNameSql()})`, s2: 'NULL' };
  if (sort === 'main') return { s1: `lower(${mainNameSql('solo.id')})`, s2: 'NULL' };
  if (sort === 'permission') return { s1: '4', s2: "''" };
  return { s1: lastSeenSql(sc, { pid: 'solo.id' }), s2: 'NULL' };
}
function nameSortKeys(sort) {
  if (sort === 'user') return { s1: 'nk', s2: 'NULL' };
  if (sort === 'main') return { s1: 'NULL', s2: 'NULL' };
  if (sort === 'permission') return { s1: '4', s2: "''" };
  return { s1: 'seen', s2: 'NULL' };
}

// ORDER BY of the outer select: the sort value (NULL last), the second value, then the name, the kind and the key, so a page boundary is stable. The tie-break columns always
// ascend; the direction is the sort value's (and the second value's).
const orderBy = (dir) => `ORDER BY (s1 IS NULL), s1 ${dir === 'desc' ? 'DESC' : 'ASC'}, s2 ${dir === 'desc' ? 'DESC' : 'ASC'}, sn, ko, tie`;

// The page of the core (accounts and persons) of one segment, at most `window` rows: columns kind, id, name, sn, s1, s2, ko, tie.
function corePageStatement(db, sc, query, window) {
  const { segment, sort, dir, q, rank, from } = query;
  const accountsOn = !(from && !ACCOUNT_TAGS.includes(from));
  const personsOn = !from;
  const ctes = [accountsCte(sc)];
  if (personsOn) ctes.push(personsCte(sc));
  const terms = [];
  if (accountsOn) {
    const where = [accountSegmentSql(sc, segment)];
    if (q) { const p = sc.add(q.core); where.push(`(lower(${ACCOUNT_NAME}) LIKE ${p} ESCAPE '\\' OR lower(${mainNameSql('a.pid')}) LIKE ${p} ESCAPE '\\')`); }
    if (rank) where.push(mainRankSql('a.pid', sc.add(rank)));
    if (from) where.push(accountTagSql(sc, from, 'a'));
    const keys = accountSortKeys(sc, sort);
    terms.push(`SELECT 'account' AS kind, a.id AS id, ${ACCOUNT_NAME} AS name, lower(${ACCOUNT_NAME}) AS sn, ${keys.s1} AS s1, ${keys.s2} AS s2, 0 AS ko, a.id AS tie
      FROM a WHERE ${where.map((part) => `(${part})`).join(' AND ')}`);
  }
  if (personsOn) {
    const where = [personSegmentSql(sc, segment)];
    if (q) { const p = sc.add(q.core); where.push(`(lower(${personNameSql()}) LIKE ${p} ESCAPE '\\' OR lower(${mainNameSql('solo.id')}) LIKE ${p} ESCAPE '\\')`); }
    if (rank) where.push(mainRankSql('solo.id', sc.add(rank)));
    const keys = personSortKeys(sc, sort);
    terms.push(`SELECT 'person' AS kind, solo.id AS id, ${personNameSql()} AS name, lower(${personNameSql()}) AS sn, ${keys.s1} AS s1, ${keys.s2} AS s2, 1 AS ko, solo.id AS tie
      FROM solo WHERE ${where.map((part) => `(${part})`).join(' AND ')}`);
  }
  if (!terms.length) return null;
  const sql = `WITH ${ctes.join(',\n')}
    SELECT kind, id, name, sn, s1, s2, ko, tie FROM (${terms.join(' UNION ALL ')}) ${orderBy(dir)} LIMIT ${sc.add(window)}`;
  return db.prepare(sql).bind(...sc.values);
}

// The page of the names (nonmembers only), at most `window` rows: the core columns plus rlm, cls, seen, tags.
function namesPageStatement(db, sc, query, window) {
  const { sort, dir, q, from } = query;
  const keys = nameSortKeys(sort);
  const where = ['1 = 1'];
  if (q) where.push(`nk LIKE ${sc.add(q.name)} ESCAPE '\\'`);
  if (from) where.push(`instr(',' || tags || ',', ',' || ${sc.add(from)} || ',') > 0`);
  const ctes = namesCtes(sc);
  const sql = `WITH RECURSIVE ${ctes}
    SELECT kind, id, name, sn, s1, s2, ko, tie, rlm, cls, seen, tags FROM (
      SELECT 'name' AS kind, 'n_' || lower(hex(nk)) AS id, nm AS name, nk AS sn, ${keys.s1} AS s1, ${keys.s2} AS s2, 2 AS ko, nk AS tie, rlm, cls, seen, tags
        FROM nm WHERE ${where.join(' AND ')}) ${orderBy(dir)} LIMIT ${sc.add(window)}`;
  return db.prepare(sql).bind(...sc.values);
}

// The four counts in one statement: accounts and persons by segment, and every name is a non-member. -> rows { seg, n }.
function countsStatement(db, sc) {
  const sql = `WITH RECURSIVE ${accountsCte(sc)},\n${personsCte(sc)},\n${namesCtes(sc)}
    SELECT seg, COUNT(*) AS n FROM (
      SELECT ${accountSegmentSql(sc, null)} AS seg FROM a
      UNION ALL SELECT ${personSegmentSql(sc, null)} FROM solo
      UNION ALL SELECT 'nonmembers' FROM nm) GROUP BY seg`;
  return db.prepare(sql).bind(...sc.values);
}

// The display columns of the account rows of a page (ids: a JSON list bound as ONE parameter): who they are, their person's Main, permission, last seen, flags, tags.
function accountDetailsStatement(db, sc, ids, withTags) {
  const g = sc.g();
  const list = sc.add(JSON.stringify(ids));
  const pid = personOfAccountSql(g, 'u.id', 'u.discord_id');
  const tags = ACCOUNT_TAGS.map((tag) => (withTags ? `${accountTagSql(sc, tag, 'u')} AS t_${tag}` : `0 AS t_${tag}`)).join(', ');
  const sql = `SELECT u.id AS id, ${pid} AS pid,
      (SELECT mc.name FROM characters mc WHERE mc.player_id = ${pid} AND mc.is_main = 1 AND ${visibleCharacterSql('mc')}) AS main_name,
      (SELECT mc.class FROM characters mc WHERE mc.player_id = ${pid} AND mc.is_main = 1 AND ${visibleCharacterSql('mc')}) AS main_class,
      (SELECT mc.realm FROM characters mc WHERE mc.player_id = ${pid} AND mc.is_main = 1 AND ${visibleCharacterSql('mc')}) AS main_realm,
      ${bestBuiltinSql(g, 'u.id')} AS best, ${customNameSql(g, 'u.id')} AS custom,
      ${lastSeenSql(sc, { pid, uid: 'u.id', signInExpr: 'u.last_seen_at' })} AS seen,
      ${ownerSql(g, 'u.id')} AS is_owner, (${seatHeldBySql(g, 'u.id')} AND NOT ${ownerSql(g, 'u.id')}) AS is_suspended,
      (SELECT gb.pending_review FROM guild_blocks gb WHERE gb.guild_id = ${g} AND gb.user_id = u.id AND NOT ${ownerSql(g, 'u.id')}) AS pending,
      ${tags}
    FROM users u WHERE u.id IN (SELECT value FROM json_each(${list}))`;
  return db.prepare(sql).bind(...sc.values);
}

// The same for the account-less persons of a page.
function personDetailsStatement(db, sc, ids) {
  const g = sc.g();
  const list = sc.add(JSON.stringify(ids));
  const sql = `SELECT p.id AS id,
      (SELECT mc.name FROM characters mc WHERE mc.player_id = p.id AND mc.is_main = 1 AND ${visibleCharacterSql('mc')}) AS main_name,
      (SELECT mc.class FROM characters mc WHERE mc.player_id = p.id AND mc.is_main = 1 AND ${visibleCharacterSql('mc')}) AS main_class,
      (SELECT mc.realm FROM characters mc WHERE mc.player_id = p.id AND mc.is_main = 1 AND ${visibleCharacterSql('mc')}) AS main_realm,
      ${lastSeenSql(sc, { pid: 'p.id' })} AS seen
    FROM players p WHERE p.guild_id = ${g} AND p.id IN (SELECT value FROM json_each(${list}))`;
  return db.prepare(sql).bind(...sc.values);
}

// ---------------------------------------------------------------------------
// The merge

// The comparator of the SQL ORDER BY, in JS (rows of both lists carry s1, s2, sn, ko, tie): NULL s1 last in both directions, the rest as SQLite's BINARY collation.
function comparatorOf(dir) {
  const sign = dir === 'desc' ? -1 : 1;
  const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return (a, b) => {
    if ((a.s1 === null) !== (b.s1 === null)) return a.s1 === null ? 1 : -1;
    if (a.s1 !== null) {
      const byValue = text(a.s1, b.s1) * sign;
      if (byValue) return byValue;
    }
    if (a.s2 !== null && b.s2 !== null) {
      const bySecond = text(a.s2, b.s2) * sign;
      if (bySecond) return bySecond;
    }
    return text(a.sn, b.sn) || (a.ko - b.ko) || text(a.tie, b.tie);
  };
}

export const permissionOf = (best, custom) => (best !== null && best !== undefined ? ROLE_LABELS[['guild_master', 'officer', 'team_lead'][best]] : custom || null);
const mainOf = (row) => (row.main_name ? { name: row.main_name, class: row.main_class, realm: row.main_realm || null } : null);
export const sortedTags = (tags) => USERS_TAGS.filter((tag) => tags.includes(tag));

// -> { segment, rows, more, counts, sort, dir }
export async function listUsers(ctx, guildContext, requested, { signIn = LAST_SEEN_INCLUDES_SIGN_IN } = {}) {
  const { db } = ctx;
  // The rank filter belongs to members and former, the where-from filter to non-members; anywhere else they are ignored.
  const query = {
    ...requested,
    rank: requested.segment === 'members' || requested.segment === 'former' ? requested.rank : null,
    from: requested.segment === 'nonmembers' ? requested.from : null,
  };
  const now = ctx.now();
  const guild = guildContext.guild;
  const window = query.offset + query.limit + 1;
  const scope = () => newScope(guild, now, { signIn });

  const first = [countsStatement(db, scope())];
  const core = corePageStatement(db, scope(), query, window);
  if (core) first.push(core);
  const names = query.segment === 'nonmembers' ? namesPageStatement(db, scope(), query, window) : null;
  if (names) first.push(names);
  const results = await db.batch(first);
  const counts = { members: 0, former: 0, nonmembers: 0, blocked: 0 };
  for (const row of results[0].results) counts[row.seg] = row.n;
  const coreRows = core ? results[1].results : [];
  const nameRows = names ? results[first.length - 1].results : [];

  const merged = [...coreRows, ...nameRows].sort(comparatorOf(query.dir));
  const page = merged.slice(query.offset, query.offset + query.limit);
  const more = merged.length > query.offset + query.limit;

  // The display columns of the page rows.
  const accountIds = page.filter((row) => row.kind === 'account').map((row) => row.id);
  const personIds = page.filter((row) => row.kind === 'person').map((row) => row.id);
  const second = [];
  if (accountIds.length) second.push(accountDetailsStatement(db, scope(), accountIds, query.segment === 'nonmembers'));
  if (personIds.length) second.push(personDetailsStatement(db, scope(), personIds));
  const detail = second.length ? await db.batch(second) : [];
  let at = 0;
  const accountRows = new Map(accountIds.length ? detail[at++].results.map((row) => [row.id, row]) : []);
  const personRows = new Map(personIds.length ? detail[at++].results.map((row) => [row.id, row]) : []);

  const rows = page.map((row) => {
    if (row.kind === 'name') {
      return {
        key: row.id, kind: 'name', name: row.name, main: null, permission: null, lastSeen: row.seen || null, tags: sortedTags(String(row.tags || '').split(',')), flags: {},
      };
    }
    if (row.kind === 'person') {
      const extra = personRows.get(row.id) || {};
      return { key: row.id, kind: 'person', name: row.name, main: mainOf(extra), permission: null, lastSeen: extra.seen || null, tags: [], flags: {} };
    }
    const extra = accountRows.get(row.id) || {};
    const flags = {};
    if (extra.pending === 1) flags.pendingReview = true;
    if (extra.is_owner === 1) flags.owner = true;
    if (extra.is_suspended === 1) flags.suspended = true;
    return {
      key: row.id, kind: 'account', name: row.name, main: mainOf(extra), permission: permissionOf(extra.best, extra.custom), lastSeen: extra.seen || null,
      tags: sortedTags(ACCOUNT_TAGS.filter((tag) => extra[`t_${tag}`] === 1)), flags,
    };
  });
  return { segment: query.segment, rows, more, counts, sort: query.sort, dir: query.dir };
}
