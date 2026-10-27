// Open raids (user-hierarchy build, lane B3; U R8-Q3, sec A9-07): a raid with the "Open to guests" check lets a signed-in NON-member sign up as a guest without a
// join link. Two session routes beside the join routes, keyed by guild id + raid id (no token), and the member's way out:
//   GET    /api/open/:gid/raids/:rid   the join-link view: guild, raid, spotsLeft, rosterOptions, noteMax (nothing of the roster) + member, mine, signUp
//   POST   /api/open/:gid/raids/:rid   { name, class, spec, note?, website } (typed guild) or { character: { name, realmSlug }, spec, note?, website } (in-game guild)
//                                      sign up as a guest -> 201 { ok, spotsLeft }
//   DELETE /api/open/:gid/raids/:rid   withdraw your own sign-up
// A raid that is not open (the check is off, it has started, its team is archived, it does not exist, another guild's) answers 404 on all three: nothing says
// that it exists. The sign-up is the guest sign-up of a join link (raid_signups guest = 1, source 'raidsmith', no person, never in the attendance) attached to
// the account (guest_user_id) with join_link_id NULL. Rules:
//   - one sign-up per account per raid (unique index, 409 already_signed_up); a name that is on the guild's roster is 409 on_roster, as in the join view, and a
//     name already signed up there 409 already_joined; a member signs up from the raid page (409 member);
//   - the raid's optional guest limit (raids.guest_limit, set by an officer; none = no cap) counts link guests and open guests together inside the INSERT,
//     409 raid_full; spotsLeft is the places left under it and null when the raid has no limit; per account 5 an hour and 10 a day;
//   - a blocked account is refused on all three (403 access_removed, worker/block-check.js); Delete my data removes the account's open sign-ups;
//   - a filled hidden "website" field stores nothing and says it worked, as on the other public forms;
//   - HOW the guest names the character depends on the guild's rank source (user decision 2026-10-26, B3 minimal UI): in an IN-GAME guild (rank_source 'ingame') the guest
//     must have Battle.net linked and picks one of the characters on THEIR Battle.net list for the guild's game version ({ character: { name, realmSlug }, spec, note? });
//     a typed name and class is refused (409 battlenet_only) and a character that is not on the list is refused (400, field character). The view then carries
//     signUp = { mode: 'bnet', status, battletag, characters } for the page to draw; every other guild gets signUp = { mode: 'typed' } and the name + class fields of a join link.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { assertNotBlocked, isBlocked } from '../block-check.js';
import { bnetSupport } from '../battlenet.js';
import { DATA_TTL_MS, parseSnapshot } from '../bnet-store.js';
import { memberSql } from '../membership.js';
import { checkRateLimit } from '../ratelimit.js';
import { nameKey } from '../roster-data.js';
import { signUpClassId, signUpSpecLabel } from '../signups-data.js';
import { guestRoom, guestsAtLimit, joinViewOf, limitSpotsOf, readGuestFields } from './join.js';
import { bad } from './roster.js';
import { wrote } from '../d1-changes.js';

export const OPEN_SIGNUPS_PER_HOUR = 5;
export const OPEN_SIGNUPS_PER_DAY = 10;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const notOpen = () => new HttpError(404, 'not_found', 'That raid is not open to guests.');

// The raid, only while it is open to guests, has not started and its team takes people; the guild it belongs to (the id in the address must be its own).
async function loadOpenRaid(ctx) {
  const row = await ctx.db.prepare(
    `SELECT r.id, r.guild_id, r.raid_on, r.starts_at, r.time_known, r.zone, COALESCE(r.title, r.event_title) AS title, t.name AS team_name,
            g.name AS guild_name, g.game_version, g.realm_kind, g.time_zone, g.region, g.rank_source, r.guest_limit,
            (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND s.source = 'raidsmith' AND s.guest = 1) AS guests
       FROM raids r JOIN teams t ON t.id = r.team_id AND t.guild_id = r.guild_id JOIN guilds g ON g.id = r.guild_id
      WHERE r.id = ? AND r.guild_id = ? AND r.guests_open = 1 AND r.starts_at > ? AND t.archived = 0`,
  ).bind(ctx.params.rid, ctx.params.gid, ctx.now()).first();
  if (!row) throw notOpen();
  return row;
}


// Is the account a current member of the guild (in its Discord server or linked to one of its people, not blocked)?
async function isMember(db, guildId, userId) {
  const row = await db.prepare(
    `SELECT ${memberSql('u.id', 'g.id', 'g.discord_server_id')} AS member FROM users u, guilds g WHERE u.id = ? AND g.id = ?`,
  ).bind(userId, guildId).first();
  return !!row && row.member === 1;
}

async function ownSignup(db, raidId, userId) {
  return db.prepare("SELECT signup_id, nickname, class_name, spec_name, note FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND guest = 1 AND guest_user_id = ?")
    .bind(raidId, userId).first();
}

const isIngame = (row) => row.rank_source === 'ingame';
const byLevelThenName = (a, b) => (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name);

// The account's Battle.net characters for the guild's game version, from the link's stored snapshot (no Blizzard call; worker/routes/bnet.js writes it):
// { status, battletag, characters: [{ name, realm, realmSlug, class, level }] }, highest level first. status: ok | not_linked | expired (past Blizzard's 30 days) |
// needs_refresh (the snapshot has nothing for this game yet) | unavailable (Blizzard failed when it was loaded) | unsupported (no character data for this game).
async function bnetListOf(db, row, userId, now) {
  const support = bnetSupport(row.game_version, row.region);
  const link = await db.prepare('SELECT battletag, snapshot, snapshot_at FROM bnet_links WHERE user_id = ?').bind(userId).first();
  const answer = (status, characters = []) => ({ status, battletag: link ? link.battletag : null, characters });
  if (!support.supported) return answer('unsupported');
  if (!link) return answer('not_linked');
  if (link.snapshot_at + DATA_TTL_MS <= now) return answer('expired');
  const entry = parseSnapshot(link.snapshot)[support.namespace];
  if (!entry) return answer('needs_refresh');
  if (entry.error || !Array.isArray(entry.characters)) return answer('unavailable');
  return answer('ok', entry.characters
    .filter((character) => character && typeof character.name === 'string' && typeof character.realmSlug === 'string' && typeof character.class === 'string')
    .map((character) => ({ name: character.name, realm: character.realm || null, realmSlug: character.realmSlug, class: character.class, level: character.level || null }))
    .sort(byLevelThenName));
}

// How this guest signs up: typed name and class in every guild but an in-game one, where they pick from their own Battle.net list.
async function signUpOf(db, row, userId, now) {
  return isIngame(row) ? { mode: 'bnet', ...(await bnetListOf(db, row, userId, now)) } : { mode: 'typed' };
}

// An in-game guild's sign-up body: the character is one of the account's own Battle.net characters (never typed), and its name and class come from that list, not
// from the request. Returns the body with name and class set; refuses a typed character (409 battlenet_only), no link (409 bnet_not_linked), a list that is gone or
// stale (409 bnet_refresh) and a character that is not on the list (400, field character).
async function bnetBodyOf(db, row, userId, body, now) {
  const wanted = body.character;
  if (wanted === undefined || wanted === null) {
    throw new HttpError(409, 'battlenet_only', `${row.guild_name} takes guests through Battle.net: connect it and pick your character.`);
  }
  if (typeof wanted !== 'object' || Array.isArray(wanted) || typeof wanted.name !== 'string' || typeof wanted.realmSlug !== 'string') {
    throw bad('Pick a character from your list.', 'character');
  }
  const list = await bnetListOf(db, row, userId, now);
  if (list.status === 'not_linked') throw new HttpError(409, 'bnet_not_linked', 'Connect your Battle.net account first.');
  if (list.status !== 'ok') throw new HttpError(409, 'bnet_refresh', 'Connect Battle.net again to load your characters for this guild.');
  const found = list.characters.find((character) => nameKey(character.name) === nameKey(wanted.name) && character.realmSlug === wanted.realmSlug);
  if (!found) throw bad('That character is not on your Battle.net list for this guild.', 'character');
  return { ...body, name: found.name, class: found.class };
}

export async function viewOpenRaid(ctx) {
  const row = await loadOpenRaid(ctx);
  const userId = ctx.session.user.id;
  await assertNotBlocked(ctx.db, row.guild_id, userId);
  const [member, mine] = await Promise.all([isMember(ctx.db, row.guild_id, userId), ownSignup(ctx.db, row.id, userId)]);
  // A member signs up from the raid page and never reads their Battle.net list here: only the mode is said, nothing of the account's Battle.net data.
  const signUp = member ? { mode: isIngame(row) ? 'bnet' : 'typed' } : await signUpOf(ctx.db, row, userId, ctx.now());
  return jsonResponse({
    ...joinViewOf(row, limitSpotsOf(row)),
    // A member signs up from the raid page; the page sends them there. mine: the account's own sign-up here (to withdraw it), else null.
    member,
    mine: mine ? { name: mine.nickname, className: mine.class_name, specName: mine.spec_name, note: mine.note, classId: signUpClassId(mine), spec: signUpSpecLabel(mine) } : null,
    signUp,
  });
}

export async function signUpOpenRaid(ctx) {
  const { db, body } = ctx;
  const row = await loadOpenRaid(ctx);
  const userId = ctx.session.user.id;
  await assertNotBlocked(db, row.guild_id, userId);
  if (await isMember(db, row.guild_id, userId)) {
    throw new HttpError(409, 'member', 'You are in this guild: sign up from the raid page.');
  }
  // The hidden field only a script fills in: say it worked and store nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') return jsonResponse({ ok: true }, 201);
  const now = ctx.now();
  const { name, classId, className, specKey, note } = readGuestFields(isIngame(row) ? await bnetBodyOf(db, row, userId, body, now) : body, row.game_version);

  const limit = await checkRateLimit(db, null, now, { key: `open:${userId}`, limit: OPEN_SIGNUPS_PER_HOUR, windowMs: HOUR_MS, failClosed: true });
  if (limit.limited) {
    throw new HttpError(limit.unavailable ? 503 : 429, 'rate_limited', 'You have signed up for several raids already. Try again in a while.', { retryAfter: limit.retryAfter });
  }
  // A character on the guild's roster signs up with the guild's own sign-in, so it is never listed twice (the roster is public data: a typed name that is on it
  // says nothing new).
  const key = nameKey(name);
  const [onRoster, listed, own] = await db.batch([
    db.prepare('SELECT 1 AS x FROM characters WHERE guild_id = ? AND name_key = ? LIMIT 1').bind(row.guild_id, key),
    db.prepare("SELECT nickname FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND guest = 1").bind(row.id),
    db.prepare("SELECT 1 AS x FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND guest = 1 AND guest_user_id = ?").bind(row.id, userId),
  ]);
  if (own.results.length) throw new HttpError(409, 'already_signed_up', 'You have signed up for this raid already. Withdraw first to sign up again.');
  if (onRoster.results.length) {
    throw new HttpError(409, 'on_roster', isIngame(row) ? 'That character is on the guild\'s roster. Sign in with the account that has it.' : 'That character is on the guild\'s roster. Sign in with Discord to sign up.', { field: 'name' });
  }
  if (listed.results.some((entry) => nameKey(entry.nickname || '') === key)) throw new HttpError(409, 'already_joined', 'That character is already signed up for this raid.', { field: 'name' });
  if (guestsAtLimit(row)) throw new HttpError(409, 'raid_full', 'This raid has no guest places left.');

  // Everything the world can change between the reads above and the write is checked again inside the INSERT: the raid still open and upcoming, under its guest
  // limit if it has one (link guests count too; the limit is read from the raid at the write), the account not blocked meanwhile and under its daily cap.
  const guard = {
    sql: `EXISTS (SELECT 1 FROM raids WHERE id = ? AND guild_id = ? AND guests_open = 1 AND starts_at > ?)
          AND NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?)
          AND ${guestRoom.sql}
          AND (SELECT COUNT(*) FROM raid_signups WHERE guest_user_id = ? AND created_at > ?) < ?`,
    params: [row.id, row.guild_id, now, row.guild_id, userId, ...guestRoom.params(row.id), userId, now - DAY_MS, OPEN_SIGNUPS_PER_DAY],
  };
  const results = await db.batch([
    db.prepare(
      `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, standby, class_name, spec_name, position, guild_id, player_id,
                                 character_id, note, updated_by, created_at, updated_at, guest, join_link_id, guest_user_id)
       SELECT ?, 'raidsmith', n.next, NULL, ?, 'signed', 0, ?, ?, n.next, ?, NULL, NULL, ?, NULL, ?, ?, 1, NULL, ?
         FROM (SELECT COALESCE(MAX(signup_id), 0) + 1 AS next FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith') n
        WHERE ${guard.sql}`,
    ).bind(row.id, name, className, specKey, row.guild_id, note, now, now, userId, row.id, ...guard.params),
    auditStatement(ctx, { guildId: row.guild_id, actorUserId: userId, action: 'signup.open', entityType: 'raid', entityId: row.id, after: { class: classId } }, CHANGED_ONE),
  ]).catch((error) => {
    if (/UNIQUE constraint failed/i.test(String(error && error.message))) throw new HttpError(409, 'already_signed_up', 'You have signed up for this raid already. Withdraw first to sign up again.');
    throw error;
  });
  if (!wrote(results[0])) await explainRefusal(ctx, row, userId, now);
  const spots = limitSpotsOf(row);
  return jsonResponse({ ok: true, spotsLeft: spots === null ? null : Math.max(0, spots - 1) }, 201);
}

// The INSERT matched nothing: say why, from what is true now.
async function explainRefusal(ctx, row, userId, now) {
  const { db } = ctx;
  await loadOpenRaid(ctx); // closed, started or gone since: 404
  if (await isBlocked(db, row.guild_id, userId)) throw new HttpError(403, 'access_removed', 'An officer has removed your access to this guild.');
  const live = await db.prepare("SELECT guest_limit, (SELECT COUNT(*) FROM raid_signups WHERE raid_id = raids.id AND source = 'raidsmith' AND guest = 1) AS guests FROM raids WHERE id = ?").bind(row.id).first();
  if (live && guestsAtLimit(live)) throw new HttpError(409, 'raid_full', 'This raid has no guest places left.');
  const today = await db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first FROM raid_signups WHERE guest_user_id = ? AND created_at > ?').bind(userId, now - DAY_MS).first();
  if (today.n >= OPEN_SIGNUPS_PER_DAY) {
    throw new HttpError(429, 'rate_limited', 'You have signed up for the most open raids a day allows. Try again tomorrow.', { retryAfter: Math.max(1, Math.ceil((today.first + DAY_MS - now) / 1000)) });
  }
  throw new HttpError(409, 'conflict', 'The raid changed while you were signing up. Reload and try again.');
}

// Withdraw your own sign-up. Allowed while the raid has not started, whether or not it is still open (the check may have been turned off since). The
// raid is found through the account's OWN sign-up only: for anything else the answer is the same 404, so this route says nothing about raids that are not open.
export async function withdrawOpenSignup(ctx) {
  const { db } = ctx;
  const userId = ctx.session.user.id;
  const own = await db.prepare(
    `SELECT r.id, r.guild_id, r.starts_at FROM raid_signups s JOIN raids r ON r.id = s.raid_id AND r.guild_id = s.guild_id
      WHERE s.raid_id = ? AND s.guild_id = ? AND s.source = 'raidsmith' AND s.guest = 1 AND s.guest_user_id = ?`,
  ).bind(ctx.params.rid, ctx.params.gid, userId).first();
  if (!own) throw new HttpError(404, 'not_found', 'You have no sign-up for this raid.');
  await assertNotBlocked(db, own.guild_id, userId);
  if (own.starts_at <= ctx.now()) throw new HttpError(409, 'raid_started', 'This raid has started: a sign-up can no longer be withdrawn here.');
  const results = await db.batch([
    db.prepare("DELETE FROM raid_signups WHERE raid_id = ? AND guild_id = ? AND source = 'raidsmith' AND guest = 1 AND guest_user_id = ? RETURNING signup_id")
      .bind(own.id, own.guild_id, userId),
    auditStatement(ctx, { guildId: own.guild_id, actorUserId: userId, action: 'signup.open_withdraw', entityType: 'raid', entityId: own.id }, CHANGED_ONE),
  ]);
  if (!results[0].results.length) throw new HttpError(404, 'not_found', 'You have no sign-up for this raid.');
  return jsonResponse({ ok: true });
}
