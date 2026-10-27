// The account itself: the name it shows, disconnecting Discord, and the officers' side of linking an account to a roster person.
// (Signing in, linking Discord and the Battle.net link live in auth.js and bnet.js; which identities an account has, in identities.js.)
import { HttpError, cleanText, isUniqueViolation, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { allOf, beginIdentityChange, freshRequiredError, identityChangeStatements } from '../fresh.js';
import { bnetNameOf, hasBnetSql } from '../identities.js';
import { isId } from '../ids.js';
import { blockedSql, memberSql, ownPlayerSql } from '../membership.js';
import { PROVEN_LINK_MESSAGE, ownedGuildsSql, ownerGuard, ownerSql, requireOwner } from '../owner.js';
import { loadGuildContext, isGranted } from '../permissions.js';
import { personFromSession } from '../person.js';
import { VIEWERS, personFor } from '../redact.js';
import { enforceRateLimit } from '../ratelimit.js';
import { SINGLE_LINE_STRIP } from '../roster-data.js';
import { homeTeamOf, loadPersonData, personReply } from '../roster-view.js';
import { assertSenior, seniorityOk } from '../seniority.js';
import { bad, constraintOf, requireEdit } from './roster.js';
import { wrote } from '../d1-changes.js';

export const MAX_DISPLAY_NAME = 32;
const MIN_LOOKUP = 3;
const MAX_LOOKUP = 64;
const LOOKUP_LIMIT = 40;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const FOUND_MAX = 5;
const CLAIMANTS_MAX = 20;
// What players.discord_user_id accepts (a Discord snowflake: its CHECK constraint, migration 0002): an account with any other id has nothing recordable.
const DISCORD_ID_COLUMN = /^[0-9]{17,20}$/;
const conflict = () => new HttpError(409, 'conflict', 'That changed while you were working on it. Reload and try again.');
export { PROVEN_LINK_MESSAGE };

// ---------------------------------------------------------------------------
// PATCH /api/me { displayName: string | null }: the name the account shows everywhere. null (or "") goes back to the Discord or Battle.net name.

export async function patchMe(ctx) {
  const { db, session, body } = ctx;
  if (!Object.prototype.hasOwnProperty.call(body, 'displayName')) throw bad('Send displayName.', 'displayName');
  let name = null;
  if (body.displayName !== null && body.displayName !== '') {
    if (typeof body.displayName !== 'string') throw bad('displayName must be text.', 'displayName');
    // Invisible and direction-changing characters are dropped, so a name cannot hide or reorder text; what is left must still be a real name.
    name = cleanText(body.displayName.replace(SINGLE_LINE_STRIP, ''), 'displayName', { min: 1, max: MAX_DISPLAY_NAME });
  }
  await db.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, session.user.id).run();
  return jsonResponse({ user: personFromSession({ ...session.user, displayName: name }), customName: name });
}

// ---------------------------------------------------------------------------
// PUT /auth/reminders { optOut: boolean }: "Don't mention me in reminders". A reminder that names people in a guild's Discord channel (people who have not
// answered, rostered people who have not confirmed) lists an opted-out account by name only, without pinging its Discord ID. One row per account
// (reminder_optouts); it goes with the account.

export async function putReminderOptOut(ctx) {
  const { db, session, body } = ctx;
  if (typeof body.optOut !== 'boolean') throw bad('optOut must be true or false.', 'optOut');
  if (body.optOut) {
    await db.prepare('INSERT OR IGNORE INTO reminder_optouts (user_id, created_at) VALUES (?, ?)').bind(session.user.id, ctx.now()).run();
  } else {
    await db.prepare('DELETE FROM reminder_optouts WHERE user_id = ?').bind(session.user.id).run();
  }
  return jsonResponse({ optOut: body.optOut });
}

// ---------------------------------------------------------------------------
// DELETE /auth/discord: disconnect Discord from the account.

export async function unlinkDiscord(ctx) {
  const { db, session } = ctx;
  const userId = session.user.id;
  const discordId = session.user.discordId;
  if (!discordId) return jsonResponse({ ok: true, removed: false });

  const bnet = await db.prepare('SELECT battletag FROM bnet_links WHERE user_id = ?').bind(userId).first();
  if (!bnet) {
    throw new HttpError(409, 'last_identity', 'Discord is the only way you sign in to this account. Connect Battle.net first, or delete your data on the privacy page.');
  }
  // A blocked account does not shed its Discord: signing in with that Discord again would make a fresh account that no block names.
  // (A block row on the unsuspended Owner is ignored everywhere, so it does not count here either: worker/membership.js blockedSql.)
  const blockedAt = await db.prepare(`SELECT 1 AS found FROM guild_blocks gb WHERE gb.user_id = ? AND NOT ${ownerSql('gb.guild_id', 'gb.user_id')}`).bind(userId).first();
  if (blockedAt) {
    throw new HttpError(409, 'blocked_somewhere', 'An officer removed your access to a guild, so Discord cannot be disconnected right now.');
  }
  // An Owner (worker/owner.js: the seat holder, or the stored Guild Master of a guild before the flip) who would lose the guild must hand over or get linked first: a guild
  // nobody can open helps no one. "Would lose" = not a member of the guild once
  // the Discord server no longer counts (the membership rule of worker/membership.js with no server to be in: only a link, or the in-game rule's own terms, keeps
  // someone in a guild they are not in the server of).
  const leads = await db.prepare(
    `SELECT g.id, g.name FROM (SELECT ?1 AS uid) m
       JOIN (${ownedGuildsSql('?1')}) owned_by_me
       JOIN guilds g ON g.id = owned_by_me.guild_id
      WHERE NOT ${memberSql('m.uid', 'g.id', 'NULL')}
      ORDER BY g.name, g.id`,
  ).bind(userId).all();
  if (leads.results.length) {
    throw new HttpError(409, 'leads_guild',
      'You are the Guild Master of a guild you would lose access to without Discord. Hand it over first, or claim your roster entry there (Battle.net, or This is me on My characters).',
      { guilds: leads.results.map((row) => ({ id: row.id, name: row.name })) });
  }

  const now = ctx.now();
  // Identity-change protection (worker/fresh.js): on an account that holds the Owner seat or any staff role, disconnecting an identity is itself a fresh-auth act (403
  // fresh_required { purpose: 'identity_change', params: { change: 'unlink_discord' } } until the grant is there); every account's change nulls its grants and is audited in each
  // guild the account is a member of. The audit row is written BEFORE the change: it asks who is a member while the Discord server still counts.
  const act = await beginIdentityChange(ctx, { userId, change: 'unlink_discord' });
  // Every statement applies only while this account still holds this Discord ID and still has Battle.net (the last-identity rule), and while the act's guard holds.
  const guard = allOf({ sql: `EXISTS (SELECT 1 FROM users WHERE id = ? AND discord_id = ?) AND ${hasBnetSql('?')}`, params: [userId, discordId, userId] }, act.guard);
  const cleared = allOf({ sql: 'EXISTS (SELECT 1 FROM users WHERE id = ? AND discord_id IS NULL)', params: [userId] }, act.guard);
  const results = await db.batch([
    ...act.statements,
    ...identityChangeStatements(ctx, { userId, provider: 'discord', change: 'unlink', guard }),
    // An account without Discord is named after its BattleTag.
    db.prepare(
      `UPDATE users SET discord_id = NULL, discord_linked_at = NULL, username = ?, global_name = NULL, avatar = NULL WHERE id = ? AND ${guard.sql}`,
    ).bind(bnetNameOf(bnet.battletag), userId, ...guard.params),
    db.prepare(`DELETE FROM user_servers WHERE user_id = ? AND ${cleared.sql}`).bind(userId, ...cleared.params),
    // The roles Discord gave (Phase 7) go with the Discord connection: nothing could take them away later, and roles an officer set by hand stay.
    db.prepare(`DELETE FROM role_assignments WHERE user_id = ? AND source = 'discord' AND ${cleared.sql}`).bind(userId, ...cleared.params),
    // Disconnecting a sign-in deletes what Raidsmith holds from it, as Delete my data does: the Discord ID and nickname on roster people and on
    // Raid-Helper sign-ups (the people and the attendance stay). An officer's account link (players.user_id) is a different thing and stays.
    db.prepare(
      `UPDATE players SET discord_user_id = NULL, discord_nickname = NULL, version = version + 1, updated_at = ?
        WHERE discord_user_id = ? AND ${cleared.sql}`,
    ).bind(now, discordId, ...cleared.params),
    db.prepare(`UPDATE raid_signups SET discord_user_id = NULL, nickname = NULL WHERE discord_user_id = ? AND ${cleared.sql}`).bind(discordId, ...cleared.params),
    db.prepare(`UPDATE sessions SET manageable_servers = NULL, manageable_until = NULL WHERE user_id = ? AND ${cleared.sql}`).bind(userId, ...cleared.params),
    auditStatement(ctx, { guildId: null, actorUserId: userId, action: 'discord.unlink', entityType: 'user', entityId: userId }, cleared),
  ]);
  if (!act.consumed(results)) throw freshRequiredError('identity_change', { change: 'unlink_discord' });
  if (!wrote(results[act.offset + 2])) throw conflict();
  return jsonResponse({ ok: true, removed: true });
}

// ---------------------------------------------------------------------------
// The officers' side: which account is a roster person's.

// GET /api/guild/:gid/accounts?q=  (roster.edit). Never a directory of accounts:
//   no q    the accounts that sent a character claim in this guild and are not on any person of it yet;
//   q       the accounts whose BattleTag or display name IS q (the whole string, any case), 3 to 64 characters, at most 5, rate limited. Only
//           someone with roster.edit on the whole guild (an Officer) may ask: a Team Lead sees the claimants.
// Accounts blocked in the guild, or already a person's here, are left out. A BattleTag comes back only when it is what the officer typed, and
// never the Discord handle. A display name is free text, so several accounts can show the same one: those rows say `ambiguous` (the page
// offers no Link for them: ask for the BattleTag). Whatever the mode, rows that show the same name (any case) each carry a short `nameSuffix`
// (# and the last characters of the account id, nameSuffixes below) so they can be told apart in the list; a row with a name of its own has ''.
// "Not a person's yet" means: not the owner of one (players.user_id) and not recorded on one by its Discord ID (the Link below would only refuse it).
// Looking an account up by name, or linking one that is not in the guild yet, lets someone in: the Officer's call (roster.edit on the whole guild AND
// guild.access, so a custom role that edits the whole roster does not also open the guild's door).
const mayAdmitAccounts = (can) => can['roster.edit'] === 'guild' && can['guild.access'] === 'guild';

export async function lookupAccounts(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  if (!isGranted(guildContext.can['roster.edit'])) throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  const guildId = guildContext.guild.id;
  const raw = new URL(ctx.request.url).searchParams.get('q');
  const q = typeof raw === 'string' ? raw.replace(SINGLE_LINE_STRIP, '').trim() : '';
  if (q && !mayAdmitAccounts(guildContext.can)) {
    throw new HttpError(403, 'forbidden', 'Only an officer can look an account up by BattleTag or name. You can pick someone who sent a character claim.');
  }
  if (q && (Array.from(q).length < MIN_LOOKUP || Array.from(q).length > MAX_LOOKUP)) {
    throw bad(`Type the whole BattleTag or name: ${MIN_LOOKUP} to ${MAX_LOOKUP} characters.`, 'q');
  }
  const free = `NOT ${blockedSql('u.id', '?')} AND NOT EXISTS (SELECT 1 FROM players p WHERE p.guild_id = ?
                 AND (${ownPlayerSql('p', 'u.id')} OR (u.discord_id IS NOT NULL AND p.discord_user_id = u.discord_id)))`;
  let rows;
  if (!q) {
    rows = (await db.prepare(
      `SELECT DISTINCT u.id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar, NULL AS battletag, 'claim' AS matched_by
         FROM character_claims cl JOIN users u ON u.id = cl.user_id
        WHERE cl.guild_id = ? AND cl.status = 'pending' AND ${free}
        ORDER BY cl.created_at, u.id LIMIT ?`,
    ).bind(guildId, guildId, guildId, CLAIMANTS_MAX).all()).results;
  } else {
    await enforceRateLimit(db, ctx.session.user.id, ctx.now(), { key: `acct:${ctx.session.user.id}`, limit: LOOKUP_LIMIT, windowMs: LOOKUP_WINDOW_MS });
    rows = (await db.prepare(
      `SELECT u.id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar,
              CASE WHEN lower(b.battletag) = lower(?) THEN b.battletag ELSE NULL END AS battletag,
              CASE WHEN lower(b.battletag) = lower(?) THEN 'battletag' ELSE 'name' END AS matched_by
         FROM users u LEFT JOIN bnet_links b ON b.user_id = u.id
        WHERE (lower(b.battletag) = lower(?) OR lower(COALESCE(u.display_name, u.global_name, u.username)) = lower(?)) AND ${free}
        ORDER BY u.id LIMIT ?`,
    ).bind(q, q, q, q, guildId, guildId, FOUND_MAX).all()).results;
  }
  // Initials only: an avatar URL carries the account's Discord ID, which an officer has no business learning from a name they typed. The Discord
  // handle (username) stays out too; the name shown is the display name the account chose, else its Discord name or BattleTag name.
  const byName = rows.filter((row) => row.matched_by === 'name').length;
  const suffixes = nameSuffixes(rows);
  return jsonResponse({
    accounts: rows.map((row) => ({
      ...personFor(row, VIEWERS.lookup), battletag: row.battletag, matchedBy: row.matched_by,
      ambiguous: row.matched_by === 'name' && byName > 1, nameSuffix: suffixes.get(row.id) || '',
    })),
  });
}

// Accounts that show the same name (any case) get '#' + the last characters of their account id: the shortest tail (at least 4 characters) that tells every account of
// that name apart. -> Map(account id -> suffix) for the accounts of a clash only. The id is random, so the suffix says nothing about the person and never changes.
const MIN_SUFFIX = 4;
export function nameSuffixes(rows) {
  const groups = new Map();
  for (const row of rows) {
    const name = String(row.display_name || row.global_name || row.username || '').toLowerCase();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row.id);
  }
  const suffixes = new Map();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    let length = MIN_SUFFIX;
    while (length < 22 && new Set(ids.map((id) => id.slice(-length))).size < ids.length) length++;
    for (const id of ids) suffixes.set(id, `#${id.slice(-length)}`);
  }
  return suffixes;
}

// PUT /api/guild/:gid/roster/:pid/account { userId: string | null }  (roster.edit on the person's home team).
// A string RECORDS that account's Discord ID on the person (players.discord_user_id): bookkeeping that sign-ups, logs and loot follow. It does NOT make the account the
// owner of the person: players.user_id is written only by Battle.net proof, the account holder's own accepted application and an approved "This is me" claim (user
// decision 2026-10-26). An account without a Discord ID has nothing to record, so it is refused (409 no_discord_id): its player claims the record themselves.
// null unlinks the account that owns the person (clears players.user_id; an unlink is the one write of that column staff keep). Answers with the whole person record.
export async function setPersonAccount(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guildId = guildContext.guild.id;
  const data = await loadPersonData(db, guildId, ctx.params.pid);
  const home = data ? homeTeamOf(data) : null;
  if (!home) throw new HttpError(404, 'not_found', 'That person was not found.');
  requireEdit(guildContext, home.id);
  if (!Object.prototype.hasOwnProperty.call(body, 'userId') || (body.userId !== null && !isId('u', body.userId))) {
    throw bad('Pick an account, or null to unlink.', 'userId');
  }
  const { player } = data;
  const now = ctx.now();
  // The Seniority guard (worker/seniority.js): a person whose account ranks the same or above the actor is not relinked or unlinked by them.
  await assertSenior(db, guildContext, player.id);
  const senior = seniorityOk(guildId, ctx.session.user.id, player.id);
  // A person that holds a Battle.net-proven character is linked and unlinked by the Owner only: the account on the person is who the proof belongs to (a change of
  // players.user_id clears the proofs, lane B6a), and Battle.net beats an officer's link on the same identity key. Read for a clean 403, repeated inside the writes.
  const proven = await db.prepare("SELECT 1 AS found FROM characters WHERE guild_id = ? AND player_id = ? AND owner_proof = 'bnet' LIMIT 1").bind(guildId, player.id).first();
  if (proven) await requireOwner(db, guildContext, PROVEN_LINK_MESSAGE);
  const owner = ownerGuard(guildId, ctx.session.user.id);
  // `IS ?` matches a Main on no team (home.id null) too; `= ?` would match nothing and the write would silently do nothing.
  const onHomeTeam = {
    sql: `EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND is_main = 1 AND team_id IS ?) AND ${senior.sql}
          AND (NOT EXISTS (SELECT 1 FROM characters WHERE player_id = players.id AND owner_proof = 'bnet') OR ${owner.sql})`,
    params: [home.id, ...senior.params, ...owner.params],
  };

  if (body.userId === null) {
    if (!player.user_id) return jsonResponse(await personReply(ctx, guildContext, player.id));
    const results = await db.batch([
      db.prepare(
        `UPDATE players SET user_id = NULL, version = version + 1, updated_at = ?
          WHERE id = ? AND guild_id = ? AND user_id = ? AND ${onHomeTeam.sql}`,
      ).bind(now, player.id, guildId, player.user_id, ...onHomeTeam.params),
      auditStatement(ctx, {
        guildId, actorUserId: ctx.session.user.id, action: 'person.account_unlink', entityType: 'person', entityId: player.id,
        before: { userId: player.user_id }, after: { userId: null },
      }, { sql: 'changes() = 1', params: [] }),
    ]);
    if (!wrote(results[0])) throw conflict();
    return jsonResponse(await personReply(ctx, guildContext, player.id));
  }

  const target = await db.prepare('SELECT id, discord_id FROM users WHERE id = ?').bind(body.userId).first();
  if (!target) throw new HttpError(404, 'not_found', 'That account was not found.');
  const blocked = await db.prepare('SELECT 1 AS found FROM guild_blocks WHERE guild_id = ? AND user_id = ?').bind(guildId, target.id).first();
  if (blocked) throw new HttpError(409, 'account_blocked', 'An officer removed that account\'s access to this guild. Restore its access first.');
  if (!target.discord_id || !DISCORD_ID_COLUMN.test(target.discord_id)) {
    throw new HttpError(409, 'no_discord_id',
      'That account has no Discord ID to record on this person. The player claims this record themselves: they connect Battle.net or use This is me on their character.', { field: 'userId' });
  }
  if (player.discord_user_id === target.discord_id) return jsonResponse(await personReply(ctx, guildContext, player.id));
  if (player.user_id && player.user_id !== target.id) {
    throw new HttpError(409, 'already_linked', 'This person already belongs to another account. Unlink it first.', { field: 'userId' });
  }
  if (player.discord_user_id) {
    throw new HttpError(409, 'discord_linked',
      'This person already records a different Discord account. Change that on the Discord account field, or ask the member to connect Discord to their account.', { field: 'userId' });
  }
  // A Team Lead (roster.edit on their team only) records only the Discord ID of an account that already is a member or has a character claim waiting here;
  // looking up any other account is an Officer's call.
  if (!mayAdmitAccounts(guildContext.can)) {
    const known = await db.prepare(
      `SELECT ${memberSql('u.id', 'gc.gid', 'gc.sid')} AS member,
              EXISTS (SELECT 1 FROM character_claims cl WHERE cl.guild_id = gc.gid AND cl.user_id = u.id AND cl.status = 'pending') AS claimed
         FROM users u, (SELECT ? AS gid, ? AS sid) gc WHERE u.id = ?`,
    ).bind(guildId, guildContext.guild.discord_server_id, target.id).first();
    if (!known || (known.member !== 1 && known.claimed !== 1)) {
      throw new HttpError(403, 'forbidden', 'Only an officer can link an account that is not in this guild yet and has sent no character claim.');
    }
  }
  const taken = await db.prepare(
    'SELECT id FROM players WHERE guild_id = ? AND id != ? AND (user_id = ? OR (discord_user_id IS NOT NULL AND discord_user_id = ?))',
  ).bind(guildId, player.id, target.id, target.discord_id).first();
  if (taken) throw new HttpError(409, 'already_linked', 'That account already belongs to another person in this guild.', { field: 'userId' });

  let results;
  try {
    results = await db.batch([
      // players.user_id is not written here: the Discord ID is the whole write (a nickname taken from sign-ups goes, as when the Discord account field links).
      db.prepare(
        `UPDATE players SET discord_user_id = ?, discord_nickname = NULL, version = version + 1, updated_at = ?
          WHERE id = ? AND guild_id = ? AND discord_user_id IS NULL AND (user_id IS NULL OR user_id = ?)
            AND NOT EXISTS (SELECT 1 FROM guild_blocks WHERE guild_id = ? AND user_id = ?) AND ${onHomeTeam.sql}`,
      ).bind(target.discord_id, now, player.id, guildId, target.id, guildId, target.id, ...onHomeTeam.params),
      auditStatement(ctx, {
        guildId, actorUserId: ctx.session.user.id, action: 'person.account_link', entityType: 'person', entityId: player.id,
        before: { userId: null }, after: { userId: target.id, recordedDiscord: true },
      }, { sql: 'changes() = 1', params: [] }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error) || constraintOf(error) === 'account') {
      throw new HttpError(409, 'already_linked', 'That account already belongs to another person in this guild.', { field: 'userId' });
    }
    throw error;
  }
  if (!wrote(results[0])) throw conflict();
  return jsonResponse(await personReply(ctx, guildContext, player.id));
}
