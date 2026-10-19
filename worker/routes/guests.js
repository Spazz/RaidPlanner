// Guest links: a person without an account opens a link an officer made and sees, read-only, what ONE role allows.
//   Officers (guild.access):  GET/POST /api/guild/:gid/guest-links, DELETE /api/guild/:gid/guest-links/:lid (turn a link off)
//   Visitors (no account):    POST /auth/guest { token } -> the guest cookie;  GET /api/guest -> the view;  DELETE /auth/guest -> leave
// The token is 32 random bytes, shown once when the link is made; D1 keeps its SHA-256. The link is the whole session: the guest cookie holds the token, and
// EVERY request looks the link up again (turned off or expired means the very next request fails). A guest is never an account: no users row, no
// session, nothing it can write. Its permissions come from the same resolver as everyone's (permissions.js resolveViewerPermissions) and only the
// read-only viewer (worker/viewer.js) ever answers it.
import { HttpError, cleanText, jsonResponse, parseCookies, serializeCookie } from '../http.js';
import { auditStatement } from '../audit.js';
import { base64url, newId } from '../ids.js';
import { SECTION_ACTIONS, canGrant, loadGuildContext, requireAction, resolveViewerPermissions } from '../permissions.js';
import { toPerson } from '../person.js';
import { loadRolesData } from '../roles-store.js';
import { hashToken } from '../session.js';
import { buildView, loadGuildRow } from '../viewer.js';

export const GUEST_COOKIE = '__Host-rs_guest';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DAY = 24 * 60 * 60 * 1000;
const EXPIRES_IN = { '1d': DAY, '7d': 7 * DAY, '30d': 30 * DAY, never: null };
const MAX_ACTIVE_LINKS = 50;
const MAX_LABEL = 40;
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

const statusOf = (row, nowMs) => {
  if (row.revoked_at !== null) return 'revoked';
  return row.expires_at !== null && row.expires_at <= nowMs ? 'expired' : 'active';
};

// ---------------------------------------------------------------------------
// Officers

// Which of the four sections a role shows (it carries the section's read action), for the "Shows: ..." line next to a role.
function sectionsOfRole(rolesData, roleId) {
  const actions = new Set((rolesData.permissions.get(roleId) || []).map((permission) => permission.action));
  return Object.entries(SECTION_ACTIONS).filter(([, action]) => actions.has(action)).map(([section]) => section);
}

async function linksPayload(db, guildContext, nowMs) {
  const guildId = guildContext.guild.id;
  const [linkResult, rolesData] = await Promise.all([
    db.prepare(
      `SELECT l.id, l.label, l.role_id, r.name AS role_name, l.team_id, t.name AS team_name, l.expires_at, l.revoked_at, l.uses, l.last_used_at, l.created_at,
              u.id AS user_id, u.discord_id, u.username, u.global_name, u.display_name, u.avatar
         FROM guest_links l
         JOIN roles r ON r.id = l.role_id
         LEFT JOIN teams t ON t.id = l.team_id AND t.guild_id = l.guild_id
         LEFT JOIN users u ON u.id = l.created_by
        WHERE l.guild_id = ? ORDER BY l.created_at DESC, l.id LIMIT 200`,
    ).bind(guildId).all(),
    loadRolesData(db, guildId),
  ]);
  return {
    links: linkResult.results.map((row) => ({
      id: row.id,
      label: row.label,
      role: { id: row.role_id, name: row.role_name },
      sections: sectionsOfRole(rolesData, row.role_id),
      team: row.team_id ? { id: row.team_id, name: row.team_name } : null,
      status: statusOf(row, nowMs),
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      uses: row.uses,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      createdBy: row.user_id ? toPerson({ id: row.user_id, discord_id: row.discord_id, username: row.username, global_name: row.global_name, display_name: row.display_name, avatar: row.avatar }) : null,
    })),
    // The roles a link can grant: Guest, or one of the guild's own. Only the read actions of a role ever reach a guest.
    roles: [{ id: 'guest', name: 'Guest', sections: sectionsOfRole(rolesData, 'guest') }, ...rolesData.custom.map((role) => ({ id: role.id, name: role.name, sections: sectionsOfRole(rolesData, role.id) }))],
    expiries: Object.keys(EXPIRES_IN),
  };
}

export async function listGuestLinks(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  return jsonResponse(await linksPayload(ctx.db, guildContext, ctx.now()));
}

export async function createGuestLink(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const guildId = guildContext.guild.id;
  const { body } = ctx;
  const rolesData = await loadRolesData(ctx.db, guildId);
  const roleId = body.roleId === undefined || body.roleId === null ? 'guest' : body.roleId;
  if (typeof roleId !== 'string' || !(roleId === 'guest' || rolesData.isCustom(roleId))) {
    throw new HttpError(400, 'bad_request', 'Pick Guest or one of this guild\'s own roles.', { field: 'roleId' });
  }
  if (!sectionsOfRole(rolesData, roleId).length) {
    throw new HttpError(400, 'bad_request', 'That role can see nothing a guest link shows (roster, raids, attendance or loot). Give it a "See ..." permission first.', { field: 'roleId' });
  }
  const teamId = body.teamId === undefined || body.teamId === null ? null : body.teamId;
  if (teamId !== null) {
    const team = typeof teamId === 'string'
      ? await ctx.db.prepare('SELECT id FROM teams WHERE id = ? AND guild_id = ? AND archived = 0').bind(teamId, guildId).first()
      : null;
    if (!team) throw new HttpError(400, 'bad_request', 'That team does not exist in this guild or is archived.', { field: 'teamId' });
  }
  if (typeof body.expiresIn !== 'string' || !Object.prototype.hasOwnProperty.call(EXPIRES_IN, body.expiresIn)) {
    throw new HttpError(400, 'bad_request', 'Pick how long the link works: 1 day, 7 days, 30 days or never.', { field: 'expiresIn' });
  }
  const label = body.label === undefined || body.label === null ? null : (cleanText(body.label, 'label', { min: 0, max: MAX_LABEL }) || null);
  if (label !== null && /[\p{Cf}\p{Zl}\p{Zp}]/u.test(label)) throw new HttpError(400, 'bad_request', 'Use plain letters, numbers and spaces in the label.', { field: 'label' });
  // Never publish more than you can see yourself: the link shows the role's read actions, so the maker must hold each one for what the link reaches.
  if (!guildContext.isGuildMaster) {
    for (const permission of rolesData.permissions.get(roleId) || []) {
      if (!Object.values(SECTION_ACTIONS).includes(permission.action) || permission.scope === 'own_teams') continue;
      if (!canGrant(guildContext.can, permission.action, teamId ? 'team' : 'guild', teamId)) {
        throw new HttpError(403, 'forbidden', 'You cannot share more than you can see yourself.', { field: 'roleId' });
      }
    }
  }

  const now = ctx.now();
  const expiresAt = EXPIRES_IN[body.expiresIn] === null ? null : now + EXPIRES_IN[body.expiresIn];
  const token = base64url(ctx.randomBytes(32));
  const id = newId('gl', ctx.randomBytes);
  const made = { sql: 'EXISTS (SELECT 1 FROM guest_links WHERE id = ? AND guild_id = ?)', params: [id, guildId] };
  const results = await ctx.db.batch([
    // One guarded INSERT enforces the cap on links that still work; the audit row follows only if the link exists.
    ctx.db.prepare(
      `INSERT INTO guest_links (id, guild_id, token_hash, role_id, team_id, label, expires_at, revoked_at, uses, last_used_at, created_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?
        WHERE (SELECT COUNT(*) FROM guest_links WHERE guild_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) < ?`,
    ).bind(id, guildId, await hashToken(token), roleId, teamId, label, expiresAt, guildContext.userId, now, guildId, now, MAX_ACTIVE_LINKS),
    // The token and its hash never go in the audit log.
    auditStatement(ctx, {
      guildId, actorUserId: guildContext.userId, action: 'guest.create', entityType: 'guest_link', entityId: id,
      after: { roleId, teamId, expiresAt, labelSet: label !== null },
    }, made),
  ]);
  if (results[0].meta.changes !== 1) {
    throw new HttpError(400, 'bad_request', `A guild can have at most ${MAX_ACTIVE_LINKS} guest links that still work. Turn some off first.`, { field: 'roleId' });
  }
  return jsonResponse({ ...(await linksPayload(ctx.db, guildContext, now)), created: { id, token, path: `/#/guest/${token}` } }, 201);
}

export async function revokeGuestLink(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  requireAction(guildContext, 'guild.access');
  const guildId = guildContext.guild.id;
  const now = ctx.now();
  const link = await ctx.db.prepare('SELECT id, revoked_at FROM guest_links WHERE id = ? AND guild_id = ?').bind(ctx.params.lid, guildId).first();
  if (!link) throw new HttpError(404, 'not_found', 'That guest link does not exist.');
  if (link.revoked_at === null) {
    const turnedOff = { sql: 'EXISTS (SELECT 1 FROM guest_links WHERE id = ? AND guild_id = ? AND revoked_at = ?)', params: [link.id, guildId, now] };
    await ctx.db.batch([
      ctx.db.prepare('UPDATE guest_links SET revoked_at = ? WHERE id = ? AND guild_id = ? AND revoked_at IS NULL').bind(now, link.id, guildId),
      auditStatement(ctx, { guildId, actorUserId: guildContext.userId, action: 'guest.revoke', entityType: 'guest_link', entityId: link.id }, turnedOff),
    ]);
  }
  return jsonResponse(await linksPayload(ctx.db, guildContext, now));
}

// ---------------------------------------------------------------------------
// Visitors (no account)

function presentedGuestToken(request) {
  const token = parseCookies(request.headers.get('Cookie'))[GUEST_COOKIE];
  return typeof token === 'string' && TOKEN_PATTERN.test(token) ? token : null;
}

// The link for a token, if it still works. Anything else is the HttpError the visitor sees (a token nobody made is 404; a link an officer turned off or that ran out is 410).
async function findWorkingLink(ctx, token) {
  const row = token
    ? await ctx.db.prepare(
      `SELECT l.id, l.guild_id, l.role_id, l.team_id, l.expires_at, l.revoked_at, r.name AS role_name, t.name AS team_name
         FROM guest_links l JOIN roles r ON r.id = l.role_id LEFT JOIN teams t ON t.id = l.team_id AND t.guild_id = l.guild_id
        WHERE l.token_hash = ?`,
    ).bind(await hashToken(token)).first()
    : null;
  if (!row) throw new HttpError(404, 'link_invalid', 'This guest link is not valid. Ask the officer who sent it for a new one.');
  const status = statusOf(row, ctx.now());
  if (status === 'revoked') throw new HttpError(410, 'link_revoked', 'An officer turned this guest link off. Ask them for a new one.');
  if (status === 'expired') throw new HttpError(410, 'link_expired', 'This guest link has expired. Ask the officer who sent it for a new one.');
  return row;
}

// POST /auth/guest { token }: counts a use and starts the guest session (the cookie). Not an account, not a sign-in.
export async function redeemGuestLink(ctx) {
  const token = ctx.body.token;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new HttpError(404, 'link_invalid', 'This guest link is not valid. Ask the officer who sent it for a new one.');
  const link = await findWorkingLink(ctx, token);
  const now = ctx.now();
  const result = await ctx.db.prepare(
    'UPDATE guest_links SET uses = uses + 1, last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
  ).bind(now, link.id, now).run();
  // Turned off between the lookup and the write: the same answer as a turned-off link.
  if (result.meta.changes !== 1) throw new HttpError(410, 'link_revoked', 'An officer turned this guest link off. Ask them for a new one.');
  const maxAge = link.expires_at === null ? COOKIE_MAX_AGE_S : Math.max(1, Math.min(COOKIE_MAX_AGE_S, Math.floor((link.expires_at - now) / 1000)));
  return jsonResponse({ ok: true }, 200, {}, [serializeCookie(GUEST_COOKIE, token, { maxAge, path: '/' })]);
}

export async function leaveGuest() {
  return jsonResponse({ ok: true }, 200, {}, [serializeCookie(GUEST_COOKIE, '', { maxAge: 0, path: '/' })]);
}

// What a guest holding `roleId` (for one team, or the whole guild) sees: the read-only view. Shared by the real guest view and the dev "View as" preview.
export async function guestViewFor(db, guild, roleId, teamId, nowMs) {
  const [permissionResult, teamResult] = await db.batch([
    db.prepare('SELECT role_id, action, scope FROM effective_role_permissions WHERE guild_id = ? AND role_id = ?').bind(guild.id, roleId),
    db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guild.id),
  ]);
  const can = resolveViewerPermissions(permissionResult.results, roleId, { teamId, activeTeamIds: teamResult.results.map((row) => row.id) });
  return buildView(db, guild, can, nowMs);
}

// GET /api/guest: the guest cookie's link, looked up now, and what its role may see.
export async function getGuestView(ctx) {
  const link = await findWorkingLink(ctx, presentedGuestToken(ctx.request));
  const guild = await loadGuildRow(ctx.db, link.guild_id);
  if (!guild) throw new HttpError(404, 'link_invalid', 'This guest link is not valid. Ask the officer who sent it for a new one.');
  const view = await guestViewFor(ctx.db, guild, link.role_id, link.team_id, ctx.now());
  return jsonResponse({
    viewer: { kind: 'guest', role: { id: link.role_id, name: link.role_name }, team: link.team_id ? { id: link.team_id, name: link.team_name } : null, expiresAt: link.expires_at },
    ...view,
  });
}
