// The public page: a read-only view of a guild for anyone with the address, OFF until a Guild Master turns it on.
//   GET/PUT /api/guild/:gid/public   (guild.roles)  the switch and the sections (roster, raids, attendance, loot)
//   GET     /api/public/:gid         (nobody)       the view
// Two things decide what a visitor sees: the sections ticked on this page, and the built-in Public role, which is the ceiling (a section whose read
// action the Public role does not hold stays closed, whatever is ticked). The view itself is worker/viewer.js: names, classes, dates, percentages
// and loot awards; never officer notes, Discord data or account data.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import { isId } from '../ids.js';
import { SECTION_ACTIONS, loadGuildContext, requireAction, resolveViewerPermissions } from '../permissions.js';
import { buildView, loadGuildRow } from '../viewer.js';

const SECTIONS = Object.keys(SECTION_ACTIONS);

const parseSections = (text) => {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? SECTIONS.filter((section) => list.includes(section)) : [];
  } catch {
    return [];
  }
};

// What the Public role may show on a guild (its read actions at the whole-guild scope): the ceiling of the page.
async function publicCan(db, guildId, teamIds) {
  const result = await db.prepare("SELECT role_id, action, scope FROM effective_role_permissions WHERE guild_id = ? AND role_id = 'public'").bind(guildId).all();
  return resolveViewerPermissions(result.results, 'public', { activeTeamIds: teamIds });
}

async function settingsPayload(db, guildContext) {
  const guild = guildContext.guild;
  const row = await db.prepare('SELECT public_enabled, public_sections FROM guilds WHERE id = ?').bind(guild.id).first();
  const teams = (await db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guild.id).all()).results.map((team) => team.id);
  const ceiling = await publicCan(db, guild.id, teams);
  return {
    enabled: row.public_enabled === 1,
    sections: parseSections(row.public_sections),
    // allowed: which sections the Public role lets the page show (the others are shown as closed on the page).
    allowed: Object.fromEntries(SECTIONS.map((section) => [section, ceiling[SECTION_ACTIONS[section]] === 'guild'])),
    path: `/#/public/${guild.id}`,
  };
}

export async function getPublicSettings(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.roles');
  return jsonResponse(await settingsPayload(ctx.db, guildContext));
}

export async function putPublicSettings(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.roles');
  const { body } = ctx;
  if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'bad_request', 'enabled must be true or false.', { field: 'enabled' });
  if (!Array.isArray(body.sections) || body.sections.some((section) => typeof section !== 'string' || !SECTIONS.includes(section))) {
    throw new HttpError(400, 'bad_request', `sections must be a list of: ${SECTIONS.join(', ')}.`, { field: 'sections' });
  }
  const sections = SECTIONS.filter((section) => body.sections.includes(section));
  const before = await settingsPayload(ctx.db, guildContext);
  // Nothing changes: nothing to write (and nothing for the audit log).
  if (before.enabled === body.enabled && JSON.stringify(before.sections) === JSON.stringify(sections)) return jsonResponse(before);
  const closed = sections.filter((section) => !before.allowed[section]);
  if (closed.length) {
    throw new HttpError(400, 'bad_request', `The Public role does not allow ${closed.join(', ')}. Change it in Roles first.`, { field: 'sections' });
  }
  const guildId = guildContext.guild.id;
  await ctx.db.batch([
    ctx.db.prepare('UPDATE guilds SET public_enabled = ?, public_sections = ? WHERE id = ?').bind(body.enabled ? 1 : 0, JSON.stringify(sections), guildId),
    auditStatement(ctx, {
      guildId, actorUserId: guildContext.userId, action: 'public.update', entityType: 'guild', entityId: guildId,
      before: { enabled: before.enabled, sections: before.sections }, after: { enabled: body.enabled, sections },
    }),
  ]);
  return jsonResponse(await settingsPayload(ctx.db, guildContext));
}

// GET /api/public/:gid. A guild that does not exist and a guild whose page is off answer the same 404.
export async function getPublicView(ctx) {
  const notFound = () => new HttpError(404, 'not_found', 'There is no public page here.');
  if (!isId('g', ctx.params.gid)) throw notFound();
  const guild = await loadGuildRow(ctx.db, ctx.params.gid);
  if (!guild || guild.public_enabled !== 1) throw notFound();
  const teams = (await ctx.db.prepare('SELECT id FROM teams WHERE guild_id = ? AND archived = 0').bind(guild.id).all()).results.map((team) => team.id);
  const ceiling = await publicCan(ctx.db, guild.id, teams);
  // The chosen sections, each only if the Public role holds its read action.
  const chosen = parseSections(guild.public_sections);
  const can = Object.fromEntries(chosen.map((section) => [SECTION_ACTIONS[section], ceiling[SECTION_ACTIONS[section]]]).filter(([, scope]) => scope));
  return jsonResponse({ viewer: { kind: 'public' }, ...(await buildView(ctx.db, guild, can, ctx.now())) });
}
