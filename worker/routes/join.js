// Guest sign-up links: an officer makes a link for ONE upcoming raid, and someone without a guild account (or a member of another guild) opens it and signs up
// as a Guest - a character name, class, spec and a note. The sign-up is a native row (source 'raidsmith') with the guest flag and no person, so the list,
// the Planner seed and the counts show it and the attendance, which reads only rows with a person, never gives a guest a percentage.
//   Officers (raids.edit on the raid's team):
//     GET    /api/guild/:gid/raids/:rid/join-links              the raid's links (no token: it is shown once, when the link is made)
//     POST   /api/guild/:gid/raids/:rid/join-links              { maxUses? }  make one -> { links, created: { id, token, path } }
//     DELETE /api/guild/:gid/raids/:rid/join-links/:jid          turn a link off
//     DELETE /api/guild/:gid/raids/:rid/guests/:sid              remove one guest sign-up -> the sign-ups view
//   Visitors (no account, no session):
//     POST /api/join/view  { token }                              the raid the link is for and the form's choices; hands out the browser's cookie
//     POST /api/join       { token, name, class, spec, note?, website }   sign up as a guest
// The token is 32 random bytes in base64url; D1 keeps its SHA-256. A link works until the raid starts (read from the raid, so it follows the raid if it moves),
// until an officer turns it off, and for max_uses guest sign-ups. Spam, as on the apply page: the POST needs the cookie the view handed out, allows 3 sign-ups
// an hour per cookie, 15 guests per raid, and drops a submission whose hidden "website" field is filled without storing it or telling the sender.
import { HttpError, jsonResponse, parseCookies, serializeCookie } from '../http.js';
import { auditStatement } from '../audit.js';
import { oneLine } from '../apply-data.js';
import { base64url, isId, newId } from '../ids.js';
import { allows, loadGuildContext } from '../permissions.js';
import { checkRateLimit } from '../ratelimit.js';
import { isSpecOf, nameKey, rosterOptions } from '../roster-data.js';
import { hashToken } from '../session.js';
import { NOTE_MAX, raidHelperClassName, raidHelperSpecKey } from '../signups-data.js';
import { loadRaid, raidAudit } from './raids.js';
import { bad, readClass, readName } from './roster.js';
import { buildView } from './signups.js';

export const JOIN_COOKIE = '__Host-rs_join';
export const JOIN_COOKIE_TTL = 30 * 24 * 60 * 60;
export const JOIN_PER_COOKIE = 3;
export const JOIN_COOKIE_WINDOW_MS = 60 * 60 * 1000;
export const GUESTS_PER_RAID = 15;
export const LINKS_PER_RAID = 5;
export const DEFAULT_MAX_USES = 10;
export const MAX_USES_LIMIT = 50;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const CHANGED_ONE = { sql: 'changes() = 1', params: [] };
const invalidLink = () => new HttpError(404, 'link_invalid', 'This sign-up link is not valid. Ask the officer who sent it for a new one.');

// 'revoked' | 'full' | 'started' | 'active' (a link of an upcoming raid that still has room).
function statusOf(row, nowMs) {
  if (row.revoked_at !== null) return 'revoked';
  if (row.starts_at <= nowMs) return 'started';
  return row.uses >= row.max_uses ? 'full' : 'active';
}

// ---------------------------------------------------------------------------
// Officers

async function linksPayload(ctx, raid) {
  const result = await ctx.db.prepare(
    `SELECT l.id, l.max_uses, l.uses, l.revoked_at, l.created_at, l.created_by, ? AS starts_at FROM raid_join_links l WHERE l.guild_id = ? AND l.raid_id = ? ORDER BY l.created_at DESC, l.id LIMIT 20`,
  ).bind(raid.starts_at, raid.guild_id, raid.id).all();
  const now = ctx.now();
  return {
    links: result.results.map((row) => ({ id: row.id, maxUses: row.max_uses, uses: row.uses, status: statusOf(row, now), createdAt: row.created_at })),
    limits: { defaultUses: DEFAULT_MAX_USES, maxUses: MAX_USES_LIMIT, perRaid: LINKS_PER_RAID },
  };
}

export async function listJoinLinks(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  return jsonResponse(await linksPayload(ctx, raid));
}

export async function createJoinLink(ctx) {
  const { db, body } = ctx;
  let maxUses = DEFAULT_MAX_USES;
  if (body.maxUses !== undefined && body.maxUses !== null) {
    if (!Number.isInteger(body.maxUses) || body.maxUses < 1 || body.maxUses > MAX_USES_LIMIT) throw bad(`Allow 1 to ${MAX_USES_LIMIT} guest sign-ups.`, 'maxUses');
    maxUses = body.maxUses;
  }
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const guild = guildContext.guild;
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const now = ctx.now();
  if (raid.starts_at <= now) throw new HttpError(409, 'raid_started', 'This raid has started: a guest sign-up link only works before the start.');
  const token = base64url(ctx.randomBytes(32));
  const id = newId('jl', ctx.randomBytes);
  const made = { sql: 'EXISTS (SELECT 1 FROM raid_join_links WHERE id = ? AND guild_id = ?)', params: [id, guild.id] };
  const results = await db.batch([
    // One guarded INSERT enforces the cap of links that still work on this raid; the audit row follows only if the link exists.
    db.prepare(
      `INSERT INTO raid_join_links (id, guild_id, raid_id, token_hash, max_uses, uses, revoked_at, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, 0, NULL, ?, ?
        WHERE (SELECT COUNT(*) FROM raid_join_links WHERE raid_id = ? AND revoked_at IS NULL AND uses < max_uses) < ?`,
    ).bind(id, guild.id, raid.id, await hashToken(token), maxUses, ctx.session.user.id, now, raid.id, LINKS_PER_RAID),
    // The token and its hash never go in the audit log.
    raidAudit(ctx, guildContext, 'join.create', raid.id, null, { maxUses }, made),
  ]);
  if (results[0].meta.changes !== 1) throw bad(`A raid can have ${LINKS_PER_RAID} sign-up links that still work. Turn one off first.`, 'maxUses');
  return jsonResponse({ ...(await linksPayload(ctx, raid)), created: { id, token, path: `/#/join/${token}` } }, 201);
}

export async function revokeJoinLink(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const now = ctx.now();
  const link = await db.prepare('SELECT id, revoked_at FROM raid_join_links WHERE id = ? AND guild_id = ? AND raid_id = ?').bind(ctx.params.jid, guildContext.guild.id, raid.id).first();
  if (!link) throw new HttpError(404, 'not_found', 'That sign-up link does not exist.');
  if (link.revoked_at === null) {
    await db.batch([
      db.prepare('UPDATE raid_join_links SET revoked_at = ? WHERE id = ? AND raid_id = ? AND revoked_at IS NULL').bind(now, link.id, raid.id),
      raidAudit(ctx, guildContext, 'join.revoke', raid.id, null, null, CHANGED_ONE),
    ]);
  }
  return jsonResponse(await linksPayload(ctx, raid));
}

export async function deleteGuestSignup(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  const results = await db.batch([
    db.prepare("DELETE FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND guest = 1 AND signup_id = ? RETURNING signup_id").bind(raid.id, Number(ctx.params.sid)),
    raidAudit(ctx, guildContext, 'signup.guest_remove', raid.id, { guest: true }, null, CHANGED_ONE),
  ]);
  if (!results[0].results.length) throw new HttpError(404, 'not_found', 'That guest sign-up does not exist.');
  return jsonResponse(await buildView(ctx, guildContext, raid));
}

// ---------------------------------------------------------------------------
// Visitors

const cookieOf = (request) => {
  const value = parseCookies(request.headers.get('Cookie'))[JOIN_COOKIE];
  return typeof value === 'string' && COOKIE_PATTERN.test(value) ? value : null;
};

// The link for a token with its raid, guild and team, or the HttpError the visitor sees: 404 for a token nobody made, 410 for one that no longer works.
async function findWorkingLink(ctx, token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalidLink();
  const row = await ctx.db.prepare(
    `SELECT l.id, l.guild_id, l.raid_id, l.max_uses, l.uses, l.revoked_at, r.team_id, r.raid_on, r.starts_at, r.time_known, r.zone, COALESCE(r.title, r.event_title) AS title,
            t.name AS team_name, g.name AS guild_name, g.game_version, g.realm_kind,
            (SELECT COUNT(*) FROM raid_signups s WHERE s.raid_id = r.id AND s.source = 'raidsmith' AND s.guest = 1) AS guests
       FROM raid_join_links l JOIN raids r ON r.id = l.raid_id AND r.guild_id = l.guild_id JOIN teams t ON t.id = r.team_id JOIN guilds g ON g.id = l.guild_id
      WHERE l.token_hash = ?`,
  ).bind(await hashToken(token)).first();
  if (!row) throw invalidLink();
  const status = statusOf(row, ctx.now());
  if (status === 'revoked') throw new HttpError(410, 'link_revoked', 'An officer turned this sign-up link off. Ask them for a new one.');
  if (status === 'started') throw new HttpError(410, 'link_expired', 'This sign-up link stopped working when the raid started.');
  if (status === 'full' || row.guests >= GUESTS_PER_RAID) throw new HttpError(410, 'link_full', 'This sign-up link has reached its limit of guests. Ask an officer to make room.');
  return row;
}

const spotsOf = (row) => Math.max(0, Math.min(row.max_uses - row.uses, GUESTS_PER_RAID - row.guests));

// POST /api/join/view { token }: what the form needs, and the cookie the POST requires. Nothing of the roster.
export async function viewJoin(ctx) {
  const row = await findWorkingLink(ctx, ctx.body.token);
  const minted = cookieOf(ctx.request) ? null : base64url(ctx.randomBytes(16));
  return jsonResponse({
    guild: { name: row.guild_name, gameVersion: row.game_version, realmKind: row.realm_kind },
    raid: { raidOn: row.raid_on, startsAt: row.starts_at, timeKnown: row.time_known !== 0, zone: row.zone, title: row.title, teamName: row.team_name },
    spotsLeft: spotsOf(row),
    rosterOptions: rosterOptions(),
    noteMax: NOTE_MAX,
  }, 200, {}, minted ? [serializeCookie(JOIN_COOKIE, minted, { maxAge: JOIN_COOKIE_TTL, path: '/' })] : []);
}

export async function submitJoin(ctx) {
  const { body, db } = ctx;
  const cookie = cookieOf(ctx.request);
  if (!cookie) throw new HttpError(400, 'cookies_required', 'Open the sign-up link again, and allow cookies for this site, to sign up.');
  // The hidden field only a script fills in: say it worked and store nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') return jsonResponse({ ok: true }, 201);
  const row = await findWorkingLink(ctx, body.token);
  const name = readName(body.name, 'name', {}, row.game_version);
  const classId = readClass(body.class);
  if (typeof body.spec !== 'string' || !isSpecOf(classId, body.spec)) throw bad('Pick a spec of that class.', 'spec');
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    note = oneLine(body.note);
    if (Array.from(note).length > NOTE_MAX) throw bad(`A note is at most ${NOTE_MAX} characters.`, 'note');
    if (!note) note = null;
  }
  const className = raidHelperClassName(classId);
  const specKey = raidHelperSpecKey(classId, body.spec);
  const now = ctx.now();

  const limit = await checkRateLimit(db, null, now, {
    key: `join:${(await hashToken(cookie)).slice(0, 24)}`, limit: JOIN_PER_COOKIE, windowMs: JOIN_COOKIE_WINDOW_MS, failClosed: true,
  });
  if (limit.limited) {
    throw new HttpError(limit.unavailable ? 503 : 429, 'rate_limited', 'You have signed up a few times already. Try again in a while.', { retryAfter: limit.retryAfter });
  }
  // A character on the guild's roster signs up with the guild's own sign-in, so it is never listed twice.
  const key = nameKey(name);
  const [onRoster, listed] = await db.batch([
    db.prepare('SELECT 1 AS x FROM characters WHERE guild_id = ? AND name_key = ? LIMIT 1').bind(row.guild_id, key),
    db.prepare("SELECT nickname FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND guest = 1").bind(row.raid_id),
  ]);
  if (onRoster.results.length) throw new HttpError(409, 'on_roster', 'That character is on the guild\'s roster. Sign in with Discord to sign up.', { field: 'name' });
  if (listed.results.some((entry) => nameKey(entry.nickname || '') === key)) throw new HttpError(409, 'already_joined', 'That character is already signed up for this raid.', { field: 'name' });

  const alive = `EXISTS (SELECT 1 FROM raid_join_links l JOIN raids r ON r.id = l.raid_id WHERE l.id = ? AND l.revoked_at IS NULL AND l.uses < l.max_uses AND r.starts_at > ?)`;
  const results = await db.batch([
    db.prepare(
      `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, standby, class_name, spec_name, position, guild_id, player_id,
                                 character_id, note, updated_by, created_at, updated_at, guest, join_link_id)
       SELECT ?, 'raidsmith', n.next, NULL, ?, 'signed', 0, ?, ?, n.next, ?, NULL, NULL, ?, NULL, ?, ?, 1, ?
         FROM (SELECT COALESCE(MAX(signup_id), 0) + 1 AS next FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith') n
        WHERE ${alive} AND (SELECT COUNT(*) FROM raid_signups WHERE raid_id = ? AND source = 'raidsmith' AND guest = 1) < ?`,
    ).bind(row.raid_id, name, className, specKey, row.guild_id, note, now, now, row.id, row.raid_id, row.id, now, row.raid_id, GUESTS_PER_RAID),
    db.prepare('UPDATE raid_join_links SET uses = uses + 1 WHERE id = ? AND changes() = 1').bind(row.id),
    auditStatement(ctx, { guildId: row.guild_id, actorUserId: null, action: 'signup.guest', entityType: 'raid', entityId: row.raid_id, after: { class: classId, linkId: row.id } }, CHANGED_ONE),
  ]);
  if (results[0].meta.changes !== 1) throw new HttpError(410, 'link_full', 'This sign-up link stopped taking guests. Ask an officer for a new one.');
  return jsonResponse({ ok: true, spotsLeft: Math.max(0, spotsOf(row) - 1) }, 201);
}
