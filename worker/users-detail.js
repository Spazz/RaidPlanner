// The page of one user (user-hierarchy build, lane B7b part 1): GET /api/guild/:gid/users/:ukey. READ ONLY; the key comes from the Users list (worker/users-list.js).
//
//   { key, kind, segment, name,
//     identity: { account: { displayName } | null, battlenet, signInMethods: ['discord', 'battlenet'] },     never a Discord id, a Battle.net account id or a BattleTag
//     main, characters: [{ name, class, realm, ingameRank: { rank, label } | null, coreRank, team: { id, name } | null, isMain, former, leftOn }],
//     permission, permissions: [{ role, label, teamId?, teamName?, sources }], lastSeen,
//     block: { blocked, pendingReview, blockedOn, reason?, blockedBy? }, flags, tags, sightings: [{ source, date, detail }] }
// 404 for an unknown key, the key of another guild, a person who has an account (the page is the account's), and a name that is on the roster or was never seen.
import { HttpError } from './http.js';
import { visibleCharacterSql } from './character-visibility.js';
import { ownerSql, seatHeldBySql } from './owner.js';
import { todayIn } from './roster-data.js';
import {
  ACCOUNT_TAGS, LAST_SEEN_INCLUDES_SIGN_IN, ROLE_LABELS, USERS_TAGS, accountSegmentSql, accountTagSql, accountsCte, bestBuiltinSql, customNameSql, lastSeenSql, newScope,
  permissionOf, personNameSql, personOfAccountSql, personSegmentSql, personsCte, sortedTags, unresolvedSql,
} from './users-list.js';

// How many sightings a page lists per source.
export const SIGHTINGS_PER_SOURCE = 10;

const notFound = () => new HttpError(404, 'not_found', 'That user was not found.');
const displayNameOf = (row) => row.display_name || row.global_name || row.username;

// 'u_...' / 'p_...' / 'n_<hex of the lower-cased name key>' -> { kind, id } | { kind: 'name', nameKey } | null (a key this module never hands out).
export function parseUserKey(key) {
  if (typeof key !== 'string') return null;
  if (/^u_[A-Za-z0-9_-]{22}$/.test(key)) return { kind: 'account', id: key };
  if (/^p_[A-Za-z0-9_-]{22}$/.test(key)) return { kind: 'person', id: key };
  const named = /^n_((?:[0-9a-f]{2}){1,256})$/.exec(key);
  if (!named) return null;
  try {
    const bytes = Uint8Array.from(named[1].match(/../g).map((pair) => parseInt(pair, 16)));
    const nameKey = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return nameKey ? { kind: 'name', nameKey } : null;
  } catch {
    return null;
  }
}

const bound = (db, sc, text) => db.prepare(text).bind(...sc.values);
const nameKeyOf = (nameKey) => `n_${[...new TextEncoder().encode(nameKey)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;

// The characters of a person (a retired placeholder is hidden), the Main first. Rank facts only: no Blizzard id leaves the Worker.
function charactersStatement(db, sc, personExpr) {
  const sql = `SELECT c.name AS name, c.class AS class, c.realm AS realm, c.is_main AS is_main, c.core_rank AS core_rank, c.left_on AS left_on, c.team_id AS team_id, t.name AS team_name,
            gr.rank AS roster_rank, m.label AS rank_label
       FROM characters c
       LEFT JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id
       LEFT JOIN guild_roster gr ON gr.guild_id = c.guild_id AND gr.namespace = c.namespace AND gr.blizzard_realm_id = c.blizzard_realm_id AND gr.blizzard_char_id = c.blizzard_char_id
       LEFT JOIN source_rank_maps m ON m.guild_id = gr.guild_id AND m.source = 'ingame' AND m.team_id IS NULL AND m.source_key = CAST(gr.rank AS TEXT)
      WHERE c.player_id = ${personExpr} AND ${visibleCharacterSql('c')}
      ORDER BY c.is_main DESC, c.name`;
  return db.prepare(sql).bind(...sc.values);
}

const characterView = (row) => ({
  name: row.name,
  class: row.class,
  realm: row.realm || null,
  ingameRank: row.roster_rank === null || row.roster_rank === undefined ? null : { rank: row.roster_rank, label: row.rank_label || null },
  coreRank: row.core_rank,
  team: row.team_id ? { id: row.team_id, name: row.team_name } : null,
  isMain: row.is_main === 1,
  former: row.left_on !== null,
  leftOn: row.left_on || null,
});

const mainOf = (characters) => {
  const main = characters.find((character) => character.isMain);
  return main ? { name: main.name, class: main.class, realm: main.realm } : null;
};

// A block row as the page shows it. blockedOn: the date in the guild's zone. blockedBy (a display name) and the reason only for a viewer who holds guild.access: the list is open
// to guild.roles alone too, and who removed somebody, and why, is an access decision. A tombstone match has no blocker.
function blockView(row, timeZone, mayDecide) {
  if (!row) return { blocked: false, pendingReview: false, blockedOn: null };
  const blocker = row.display_name || row.global_name || row.username;
  return {
    blocked: true,
    pendingReview: row.pending_review === 1,
    blockedOn: todayIn(timeZone, row.created_at),
    ...(mayDecide && row.reason ? { reason: row.reason } : {}),
    ...(mayDecide && blocker ? { blockedBy: blocker } : {}),
  };
}

const sightingRows = (source, rows) => rows.map((row) => ({ source, date: row.date || null, detail: row.detail || null }));
// Newest first, a sighting with no date last; the same day in the order of the tags (the mockup's order), so the page is the same on every read.
const byNewest = (a, b) => (a.date === b.date ? USERS_TAGS.indexOf(a.source) - USERS_TAGS.indexOf(b.source) : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? 1 : -1);

// The sightings of a NAME as statements (loot, the raid log, pasted names, officer-marked guests, applications, sign-ups): rows { date, detail }, newest first, capped.
function nameSightingStatements(db, scope, nameKey) {
  const raidTitle = 'COALESCE(rr.title, rr.event_title, rr.zone)';
  const cap = SIGHTINGS_PER_SOURCE;
  const sources = [
    ['loot', (sc, g, key) => `SELECT rr.raid_on AS date, la.item_name AS detail FROM loot_awards la JOIN raids rr ON rr.id = la.raid_id
       WHERE la.guild_id = ${g} AND la.winner_name_key = ${key} ORDER BY rr.raid_on DESC LIMIT ${cap}`],
    ['raid_log', (sc, g, key) => `SELECT rr.raid_on AS date, ${raidTitle} AS detail FROM raids rr
       WHERE rr.id IN (SELECT DISTINCT rp.raid_id FROM raid_presence rp WHERE rp.guild_id = ${g} AND rp.name_key = ${key}) ORDER BY rr.raid_on DESC LIMIT ${cap}`],
    ['raid_log', (sc, g, key) => `SELECT rr.raid_on AS date, ${raidTitle} AS detail FROM raids rr JOIN raid_manual_names mn ON mn.raid_id = rr.id
       WHERE rr.guild_id = ${g} AND mn.name_key = ${key} ORDER BY rr.raid_on DESC LIMIT ${cap}`],
    ['raid_log', (sc, g, key) => `SELECT NULL AS date, 'Marked as a guest by an officer' AS detail FROM attendance_guests ag WHERE ag.guild_id = ${g} AND ag.name_key = ${key} LIMIT 1`],
    ['application', (sc, g, key) => `SELECT date(ap.created_at / 1000, 'unixepoch', ${sc.mod()}) AS date, NULL AS detail FROM applications ap
       WHERE ap.guild_id = ${g} AND ap.user_id IS NULL AND ap.name_key = ${key} ORDER BY ap.created_at DESC LIMIT ${cap}`],
    ['signup', (sc, g, key) => `SELECT rr.raid_on AS date, ${raidTitle} AS detail, sn.source AS source FROM raid_signups sn JOIN raids rr ON rr.id = sn.raid_id
       WHERE sn.guild_id = ${g} AND sn.player_id IS NULL AND sn.guest_user_id IS NULL AND sn.nickname IS NOT NULL AND sn.source IN ('raid_helper', 'raidsmith')
         AND lower(sn.nickname) = ${key} ORDER BY rr.raid_on DESC LIMIT ${cap}`],
  ];
  return sources.map(([source, build]) => {
    const sc = scope();
    const sql = build(sc, sc.g(), sc.add(nameKey));
    return { source, statement: db.prepare(sql).bind(...sc.values) };
  });
}

export async function loadUserDetail(ctx, guildContext, key, { signIn = LAST_SEEN_INCLUDES_SIGN_IN } = {}) {
  const parsed = parseUserKey(key);
  if (!parsed) throw notFound();
  const scope = () => newScope(guildContext.guild, ctx.now(), { signIn });
  const mayDecide = guildContext.can['guild.access'] === 'guild';
  if (parsed.kind === 'account') return accountPage(ctx, scope, guildContext, parsed.id, mayDecide);
  if (parsed.kind === 'person') return personPage(ctx, scope, guildContext, parsed.id, mayDecide);
  return namePage(ctx, scope, parsed.nameKey);
}

async function accountPage(ctx, scope, guildContext, userId, mayDecide) {
  const { db } = ctx;
  const timeZone = guildContext.guild.time_zone;
  const head = scope();
  const g = head.g();
  const tags = ACCOUNT_TAGS.map((tag) => `${accountTagSql(head, tag, 'a')} AS t_${tag}`).join(', ');
  const headStatement = bound(db, head, `WITH ${accountsCte(head, userId)}
     SELECT a.id AS id, a.username AS username, a.global_name AS global_name, a.display_name AS display_name, (a.discord_id IS NOT NULL) AS has_discord,
            EXISTS (SELECT 1 FROM bnet_links bl WHERE bl.user_id = a.id) AS has_bnet, ${accountSegmentSql(head, null)} AS seg,
            ${lastSeenSql(head, { pid: 'a.pid', uid: 'a.id', signInExpr: 'a.last_seen_at' })} AS seen,
            ${bestBuiltinSql(g, 'a.id')} AS best, ${customNameSql(g, 'a.id')} AS custom,
            ${ownerSql(g, 'a.id')} AS is_owner, (${seatHeldBySql(g, 'a.id')} AND NOT ${ownerSql(g, 'a.id')}) AS is_suspended, ${tags}
       FROM a`);

  const chars = scope();
  const person = personOfAccountSql(chars.g(), chars.add(userId), `(SELECT du.discord_id FROM users du WHERE du.id = ${chars.add(userId)})`);
  const characters = charactersStatement(db, chars, person);

  const roles = scope();
  const rolesStatement = bound(db, roles, `SELECT er.role_id AS role_id, er.team_id AS team_id, er.source AS source, r.name AS role_name, t.name AS team_name
       FROM effective_roles er JOIN roles r ON r.id = er.role_id LEFT JOIN teams t ON t.id = er.team_id AND t.guild_id = er.guild_id
      WHERE er.guild_id = ${roles.g()} AND er.user_id = ${roles.add(userId)}`);

  const blocks = scope();
  const blockStatement = bound(db, blocks, `SELECT gb.reason AS reason, gb.created_at AS created_at, gb.pending_review AS pending_review, bu.display_name AS display_name, bu.global_name AS global_name, bu.username AS username
       FROM guild_blocks gb LEFT JOIN users bu ON bu.id = gb.blocked_by
      WHERE gb.guild_id = ${blocks.g()} AND gb.user_id = ${blocks.add(userId)} AND NOT ${ownerSql(blocks.g(), blocks.add(userId))}`);

  const applied = scope();
  const applicationStatement = bound(db, applied, `SELECT date(ap.created_at / 1000, 'unixepoch', ${applied.mod()}) AS date, NULL AS detail FROM applications ap
      WHERE ap.guild_id = ${applied.g()} AND ap.user_id = ${applied.add(userId)} ORDER BY ap.created_at DESC LIMIT ${SIGHTINGS_PER_SOURCE}`);

  const guest = scope();
  const guestStatement = bound(db, guest, `SELECT rr.raid_on AS date, COALESCE(rr.title, rr.event_title, rr.zone) AS detail FROM raid_signups sn JOIN raids rr ON rr.id = sn.raid_id
      WHERE sn.guest_user_id = ${guest.add(userId)} AND sn.guild_id = ${guest.g()} ORDER BY rr.raid_on DESC LIMIT ${SIGHTINGS_PER_SOURCE}`);

  const results = await db.batch([headStatement, characters, rolesStatement, blockStatement, applicationStatement, guestStatement]);
  const row = results[0].results[0];
  if (!row) throw notFound();
  const blockRow = results[3].results[0] || null;
  const list = results[1].results.map(characterView);
  const held = new Map();
  for (const role of results[2].results) {
    const at = `${role.role_id}|${role.team_id || ''}`;
    const entry = held.get(at) || {
      role: role.role_id, label: ROLE_LABELS[role.role_id] || role.role_name, ...(role.team_id ? { teamId: role.team_id, teamName: role.team_name } : {}), sources: [],
    };
    if (!entry.sources.includes(role.source)) entry.sources.push(role.source);
    held.set(at, entry);
  }
  const flags = {};
  if (blockRow && blockRow.pending_review === 1) flags.pendingReview = true;
  if (row.is_owner === 1) flags.owner = true;
  if (row.is_suspended === 1) flags.suspended = true;
  return {
    key: userId,
    kind: 'account',
    segment: row.seg,
    name: displayNameOf(row),
    identity: {
      account: { displayName: displayNameOf(row) },
      battlenet: row.has_bnet === 1,
      signInMethods: [...(row.has_discord === 1 ? ['discord'] : []), ...(row.has_bnet === 1 ? ['battlenet'] : [])],
    },
    main: mainOf(list),
    characters: list,
    permission: permissionOf(row.best, row.custom),
    permissions: [...held.values()],
    lastSeen: row.seen || null,
    block: blockView(blockRow, timeZone, mayDecide),
    flags,
    tags: row.seg === 'nonmembers' ? sortedTags(ACCOUNT_TAGS.filter((tag) => row[`t_${tag}`] === 1)) : [],
    sightings: [...sightingRows('application', results[4].results), ...sightingRows('guest_signup', results[5].results)].sort(byNewest),
  };
}

async function personPage(ctx, scope, guildContext, personId, mayDecide) {
  const { db } = ctx;
  const head = scope();
  const headStatement = bound(db, head, `WITH ${personsCte(head, personId)}
     SELECT solo.id AS id, ${personNameSql()} AS name, ${personSegmentSql(head, null)} AS seg, ${lastSeenSql(head, { pid: 'solo.id' })} AS seen FROM solo`);
  const chars = scope();
  const characters = charactersStatement(db, chars, chars.add(personId));
  const blocks = scope();
  const blockStatement = bound(db, blocks, `SELECT pb.reason AS reason, pb.created_at AS created_at, 0 AS pending_review, bu.display_name AS display_name, bu.global_name AS global_name, bu.username AS username
       FROM person_blocks pb LEFT JOIN users bu ON bu.id = pb.blocked_by WHERE pb.guild_id = ${blocks.g()} AND pb.player_id = ${blocks.add(personId)}`);
  const results = await db.batch([headStatement, characters, blockStatement]);
  const row = results[0].results[0];
  if (!row) throw notFound();
  const list = results[1].results.map(characterView);
  return {
    key: personId,
    kind: 'person',
    segment: row.seg,
    name: row.name,
    identity: { account: null, battlenet: false, signInMethods: [] },
    main: mainOf(list),
    characters: list,
    permission: null,
    permissions: [],
    lastSeen: row.seen || null,
    block: blockView(results[2].results[0] || null, guildContext.guild.time_zone, mayDecide),
    flags: {},
    tags: [],
    sightings: [],
  };
}

async function namePage(ctx, scope, nameKey) {
  const { db } = ctx;
  const check = scope();
  const g = check.g();
  const key = check.add(nameKey);
  // The name as it was written (the first source that has it), and whether it is a name nobody on the roster carries.
  const resolved = bound(db, check, `SELECT ${unresolvedSql(check, key)} AS unresolved,
            COALESCE((SELECT la.winner_name FROM loot_awards la WHERE la.guild_id = ${g} AND la.winner_name_key = ${key} LIMIT 1),
                     (SELECT rp.name FROM raid_presence rp WHERE rp.guild_id = ${g} AND rp.name_key = ${key} LIMIT 1),
                     (SELECT mn.name FROM raids mr JOIN raid_manual_names mn ON mn.raid_id = mr.id WHERE mr.guild_id = ${g} AND mn.name_key = ${key} LIMIT 1),
                     (SELECT ag.name FROM attendance_guests ag WHERE ag.guild_id = ${g} AND ag.name_key = ${key} LIMIT 1),
                     (SELECT ap.char_name FROM applications ap WHERE ap.guild_id = ${g} AND ap.user_id IS NULL AND ap.name_key = ${key} LIMIT 1),
                     (SELECT sn.nickname FROM raid_signups sn WHERE sn.guild_id = ${g} AND sn.player_id IS NULL AND sn.guest_user_id IS NULL AND sn.nickname IS NOT NULL
                         AND sn.source IN ('raid_helper', 'raidsmith') AND lower(sn.nickname) = ${key} LIMIT 1)) AS shown`);
  const lists = nameSightingStatements(db, scope, nameKey);
  const results = await db.batch([resolved, ...lists.map((entry) => entry.statement)]);
  if (results[0].results[0].unresolved !== 1) throw notFound();
  const sightings = [];
  lists.forEach((entry, index) => {
    const rows = results[index + 1].results;
    if (entry.source === 'signup') {
      sightings.push(...sightingRows('raid_helper', rows.filter((row) => row.source === 'raid_helper')), ...sightingRows('guest_signup', rows.filter((row) => row.source !== 'raid_helper')));
    } else {
      sightings.push(...sightingRows(entry.source, rows));
    }
  });
  if (!sightings.length) throw notFound();
  sightings.sort(byNewest);
  return {
    key: nameKeyOf(nameKey),
    kind: 'name',
    segment: 'nonmembers',
    name: results[0].results[0].shown || nameKey,
    identity: { account: null, battlenet: false, signInMethods: [] },
    main: null,
    characters: [],
    permission: null,
    permissions: [],
    lastSeen: (sightings.find((sighting) => sighting.date) || {}).date || null,
    block: { blocked: false, pendingReview: false, blockedOn: null },
    flags: {},
    tags: sortedTags([...new Set(sightings.map((sighting) => sighting.source))]),
    sightings,
  };
}
