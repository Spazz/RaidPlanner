// Dev-only "View as" routes (see worker/view-as.js for the three gates). All of them answer the SAME 404 as an unknown route unless DEV_VIEW_AS=1 on a
// local host, and only a Guild Master (by REAL rank) may use them. They are registered with auth:true (the dispatcher answers 401 to a signed-out caller
// first); a signed-in caller on a closed gate gets the 404.
//   PUT    /api/dev/view-as { gid, roleId, teamId? }   set the stand-in cookie
//   DELETE /api/dev/view-as                            clear it
//   GET    /api/dev/guild/:gid/viewer?role=guest|public  the guest view / public page exactly as the real ones would answer, plus preview: true
import { HttpError, jsonResponse, serializeCookie } from '../http.js';
import { isId } from '../ids.js';
import { ROLE_RANK, loadGuildContext } from '../permissions.js';
import { loadRolesData } from '../roles-store.js';
import { VIEW_AS_BUILTIN_ROLES, VIEW_AS_COOKIE, viewAsCookieValue, viewAsEnabled } from '../view-as.js';
import { loadGuildRow } from '../viewer.js';
import { guestViewFor } from './guests.js';
import { publicViewFor } from './public.js';

const COOKIE_MAX_AGE_S = 24 * 60 * 60;
const notFound = () => new HttpError(404, 'not_found', 'Not found.');

// The gate: throws the plain 404 when closed; returns the signed-in session.
function openGate(ctx) {
  if (!viewAsEnabled(ctx.env, ctx.request)) throw notFound();
  return ctx.session;
}

// The person's REAL context (never the stand-in), which must be the Guild Master's.
async function requireRealGuildMaster(ctx, session, guildId) {
  const real = await loadGuildContext(ctx.db, session.user.id, guildId);
  if (real.rank !== ROLE_RANK.guild_master) throw new HttpError(403, 'forbidden', 'Only the Guild Master can view the guild as another role.');
  return real;
}

const badField = (field, message) => new HttpError(400, 'bad_request', message, { field });

export async function putViewAs(ctx) {
  const session = openGate(ctx);
  const { body } = ctx;
  if (!isId('g', body.gid)) throw badField('gid', 'Pick a guild.');
  await requireRealGuildMaster(ctx, session, body.gid);
  const roleId = body.roleId;
  if (typeof roleId !== 'string') throw badField('roleId', 'Pick a role.');
  if (roleId === 'guild_master') throw badField('roleId', 'You already are the Guild Master: clear the view instead.');
  const rolesData = await loadRolesData(ctx.db, body.gid);
  const builtin = VIEW_AS_BUILTIN_ROLES.includes(roleId);
  if (!builtin && !rolesData.isCustom(roleId)) throw badField('roleId', 'Pick Officer, Team Lead, Member or one of this guild\'s own roles.');
  const teamGiven = body.teamId !== undefined && body.teamId !== null;
  if (teamGiven && typeof body.teamId !== 'string') throw badField('teamId', 'Pick a team.');
  if (teamGiven && builtin && roleId !== 'team_lead') throw badField('teamId', 'That role is held without a team.');
  if (roleId === 'team_lead' && !teamGiven) throw badField('teamId', 'A Team Lead is held for one team: pick it.');
  if (teamGiven) {
    const team = isId('t', body.teamId)
      ? await ctx.db.prepare('SELECT id FROM teams WHERE id = ? AND guild_id = ? AND archived = 0').bind(body.teamId, body.gid).first()
      : null;
    if (!team) throw badField('teamId', 'That team does not exist in this guild or is archived.');
  }
  const viewAs = { guildId: body.gid, roleId, teamId: teamGiven ? body.teamId : null };
  return jsonResponse({ ok: true, viewAs }, 200, {}, [
    serializeCookie(VIEW_AS_COOKIE, viewAsCookieValue(viewAs), { maxAge: COOKIE_MAX_AGE_S, path: '/' }),
  ]);
}

export async function deleteViewAs(ctx) {
  openGate(ctx);
  return jsonResponse({ ok: true, viewAs: null }, 200, {}, [serializeCookie(VIEW_AS_COOKIE, '', { maxAge: 0, path: '/' })]);
}

// GET /api/dev/guild/:gid/viewer?role=guest|public
export async function getViewerPreview(ctx) {
  const session = openGate(ctx);
  const guildId = ctx.params.gid;
  if (!isId('g', guildId)) throw notFound();
  await requireRealGuildMaster(ctx, session, guildId);
  const role = new URL(ctx.request.url).searchParams.get('role');
  if (role !== 'guest' && role !== 'public') throw badField('role', 'role must be guest or public.');
  const guild = await loadGuildRow(ctx.db, guildId);
  if (!guild) throw notFound();
  if (role === 'guest') {
    const view = await guestViewFor(ctx.db, guild, 'guest', null, ctx.now());
    return jsonResponse({ viewer: { kind: 'guest', preview: true, role: { id: 'guest', name: 'Guest' }, team: null, expiresAt: null }, ...view });
  }
  const view = await publicViewFor(ctx.db, guild, ctx.now());
  return jsonResponse({ viewer: { kind: 'public', preview: true }, publicEnabled: guild.public_enabled === 1, ...view });
}

// The dev block of GET /api/guild/:gid: from the REAL context (a viewed Member still gets the option lists), or null when the gates are closed.
export async function devPayload(ctx, guildContext) {
  if (!viewAsEnabled(ctx.env, ctx.request)) return null;
  const realRank = guildContext.realRank === undefined ? guildContext.rank : guildContext.realRank;
  if (realRank !== ROLE_RANK.guild_master) return null;
  const guildId = guildContext.guild.id;
  const [rolesData, teamResult] = await Promise.all([
    loadRolesData(ctx.db, guildId),
    ctx.db.prepare('SELECT id, name FROM teams WHERE guild_id = ? AND archived = 0 ORDER BY created_at, id').bind(guildId).all(),
  ]);
  return {
    viewAs: guildContext.viewAs || null,
    roles: [
      { id: 'officer', name: 'Officer', teamScoped: false },
      { id: 'team_lead', name: 'Team Lead', teamScoped: true },
      { id: 'member', name: 'Member', teamScoped: false },
      ...rolesData.custom.map((role) => ({ id: role.id, name: role.name, teamScoped: rolesData.needsTeam(role.id) })),
    ],
    teams: teamResult.results.map((team) => ({ id: team.id, name: team.name })),
  };
}
