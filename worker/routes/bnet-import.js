// Guild-side Battle.net: the guild's Battle.net settings (in-game guild name, the realm of a ruleset guild, rank labels) and the roster import.
// A preview asks Battle.net for the guild's roster and stores nothing; a commit asks again (it trusts nothing the browser sends but
// WHICH members to add) and writes people and characters in one batch, like the Warcraft Logs import.
import { HttpError, jsonResponse } from '../http.js';
import { auditStatement } from '../audit.js';
import {
  BnetError, bnetSupport, fetchGuildRoster, guildSlug, isRealmSlug, realmSlugOf, rosterHttpError,
} from '../battlenet.js';
import { MAX_RANK_LABEL, RANK_COUNT, loadBnetSettings, rankLabelOf, realmDisplayName } from '../bnet-store.js';
import { newId } from '../ids.js';
import { isGranted, loadGuildContext, requireAction } from '../permissions.js';
import { SINGLE_LINE_STRIP, cleanCharacterName, nameKey } from '../roster-data.js';
import { bad, resolveRealm } from './roster.js';
import { checkNames, importRate, indexed, readDefaultStatus, requireTeamId, startImport, writeImport } from './roster-import.js';

const MAX_COMMIT_MEMBERS = 250;

export function requireBnetConfigured(env) {
  if (!env.BNET_CLIENT_ID || !env.BNET_CLIENT_SECRET) {
    throw new HttpError(503, 'bnet_not_configured', 'Battle.net isn\'t set up on this server.');
  }
}

// What a roster read needs: the version's support, the realm slug and the in-game guild name.
//   realm guilds use their own realm (the realms list's slug, else the realm name in slug form); ruleset guilds use the realm an officer saved.
export function rosterTarget(guild, settings) {
  const support = bnetSupport(guild.game_version, guild.region);
  if (!support.supported) throw new HttpError(409, 'bnet_unsupported', support.message);
  const realmSlug = guild.realm_kind === 'ruleset' ? settings.realmSlug : (guild.realm_slug || realmSlugOf(guild.realm));
  if (!realmSlug) {
    throw new HttpError(409, 'bnet_realm_missing', 'Battle.net needs the realm this guild lives on. Set it in Guild settings > Battle.net.');
  }
  const guildName = settings.guildName || guild.name;
  if (!guildSlug(guildName)) {
    throw new HttpError(409, 'bnet_guild_missing', 'Battle.net needs the in-game guild name. Set it in Guild settings > Battle.net.');
  }
  return { support, realmSlug, guildName };
}

// ---------------------------------------------------------------------------
// Settings

function settingsView(guildContext, settings, env) {
  const guild = guildContext.guild;
  const support = bnetSupport(guild.game_version, guild.region);
  const ruleset = guild.realm_kind === 'ruleset';
  return {
    configured: !!(env.BNET_CLIENT_ID && env.BNET_CLIENT_SECRET),
    supported: support.supported,
    supportLabel: support.label,
    message: support.message,
    realmKind: guild.realm_kind,
    guildName: settings.guildName,
    effectiveGuildName: settings.guildName || guild.name,
    // A realm guild reads its own realm; a ruleset guild reads the one an officer entered.
    realmSlug: ruleset ? settings.realmSlug : (guild.realm_slug || realmSlugOf(guild.realm) || null),
    realmNeeded: ruleset && !settings.realmSlug,
    rankLabels: settings.rankLabels,
    rankDefaults: Array.from({ length: RANK_COUNT }, (_, rank) => rankLabelOf([], rank)),
    canEdit: isGranted(guildContext.can['guild.teams']),
  };
}

export async function getBnetSettings(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid);
  if (!isGranted(guildContext.can['roster.edit']) && !isGranted(guildContext.can['guild.teams'])) {
    throw new HttpError(403, 'forbidden', 'You do not have permission to do that.');
  }
  return jsonResponse(settingsView(guildContext, await loadBnetSettings(ctx.db, guildContext.guild.id), ctx.env));
}

// Body: { guildName: text | null, realmSlug: slug | null (ruleset guilds only), rankLabels: [ten texts, '' for none] }.
export async function putBnetSettings(ctx) {
  const { db, body } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid);
  requireAction(guildContext, 'guild.teams');
  const guild = guildContext.guild;

  let guildName = null;
  if (body.guildName !== undefined && body.guildName !== null && body.guildName !== '') {
    if (typeof body.guildName !== 'string') throw bad('The guild name must be text.', 'guildName');
    guildName = body.guildName.replace(SINGLE_LINE_STRIP, '').replace(/\s+/g, ' ').trim();
    if (!guildName || Array.from(guildName).length > 32 || !guildSlug(guildName)) throw bad('The in-game guild name is 1 to 32 letters, digits and spaces.', 'guildName');
  }
  let realmSlug = null;
  if (body.realmSlug !== undefined && body.realmSlug !== null && body.realmSlug !== '') {
    if (guild.realm_kind !== 'ruleset') throw bad('A realm guild reads its own realm; only ruleset guilds set one here.', 'realmSlug');
    if (typeof body.realmSlug !== 'string') throw bad('The realm must be text.', 'realmSlug');
    // An officer may type the realm's name or its slug; both become the slug.
    realmSlug = isRealmSlug(body.realmSlug.trim()) ? body.realmSlug.trim() : realmSlugOf(body.realmSlug.trim());
    if (!realmSlug) throw bad('Enter the realm as its name or its URL slug, for example "old-blanchy".', 'realmSlug');
  }
  const rawLabels = body.rankLabels === undefined ? [] : body.rankLabels;
  if (!Array.isArray(rawLabels) || rawLabels.length > RANK_COUNT) throw bad(`Send at most ${RANK_COUNT} rank labels.`, 'rankLabels');
  const labels = Array.from({ length: RANK_COUNT }, (_, i) => {
    const value = rawLabels[i] === undefined || rawLabels[i] === null ? '' : rawLabels[i];
    if (typeof value !== 'string') throw bad('Each rank label must be text.', 'rankLabels', indexed(i));
    const text = value.replace(SINGLE_LINE_STRIP, '').trim();
    if (Array.from(text).length > MAX_RANK_LABEL) throw bad(`A rank label is at most ${MAX_RANK_LABEL} characters.`, 'rankLabels', indexed(i));
    return text;
  });

  const before = await loadBnetSettings(db, guild.id);
  await db.batch([
    db.prepare('UPDATE guilds SET bnet_guild_name = ?, bnet_realm_slug = ?, bnet_rank_labels = ? WHERE id = ?')
      .bind(guildName, realmSlug, JSON.stringify(labels), guild.id),
    auditStatement(ctx, {
      guildId: guild.id, actorUserId: ctx.session.user.id, action: 'bnet.settings', entityType: 'guild', entityId: guild.id,
      before: { guildName: !!before.guildName, realm: !!before.realmSlug, labels: before.rankLabels.filter(Boolean).length },
      after: { guildName: !!guildName, realm: !!realmSlug, labels: labels.filter(Boolean).length },
    }),
  ]);
  return jsonResponse(settingsView(guildContext, { guildName, realmSlug, rankLabels: labels }, ctx.env));
}

// ---------------------------------------------------------------------------
// Roster import

// One roster fetch for the guild's saved settings -> { roster, target, settings }.
async function readRoster(ctx, guildContext) {
  requireBnetConfigured(ctx.env);
  const guild = guildContext.guild;
  const settings = await loadBnetSettings(ctx.db, guild.id);
  const target = rosterTarget(guild, settings);
  try {
    const roster = await fetchGuildRoster(ctx, guild.region, target.support.namespace, target.realmSlug, target.guildName);
    return { roster, target, settings };
  } catch (error) {
    if (error instanceof BnetError) {
      ctx.log(`bnet roster: ${error.kind}: ${error.message}`);
      throw rosterHttpError(error);
    }
    throw error;
  }
}

// A member's realm in roster terms: { realm, key } or null when this guild's roster does not take that realm.
function memberRealm(guild, member) {
  return resolveRealm(guild, realmDisplayName(guild.game_version, guild.region, member.realmSlug, null));
}

const memberKey = (member) => `${nameKey(member.name)}|${member.realmSlug}`;

export async function previewBnetRoster(ctx) {
  const { body, db } = ctx;
  requireTeamId(body);
  requireBnetConfigured(ctx.env);
  const { guildContext, team } = await startImport(ctx);
  const guild = guildContext.guild;
  await importRate(ctx);
  const { roster, settings } = await readRoster(ctx, guildContext);

  const resolved = roster.members.map((member) => ({ member, realm: memberRealm(guild, member) }));
  const result = await db.prepare(
    `SELECT c.name_key, c.realm_key, c.player_id,
            (SELECT m.name FROM characters m WHERE m.player_id = c.player_id AND m.is_main = 1) AS main_name
       FROM characters c WHERE c.guild_id = ? AND c.name_key IN (SELECT value FROM json_each(?))`,
  ).bind(guild.id, JSON.stringify([...new Set(roster.members.map((member) => nameKey(member.name)))])).all();
  const owners = new Map(result.results.map((row) => [`${row.name_key}|${row.realm_key}`, { id: row.player_id, name: row.main_name }]));

  const counts = new Map();
  const rows = resolved.map(({ member, realm }) => {
    counts.set(member.rank, (counts.get(member.rank) || 0) + 1);
    const owner = realm ? owners.get(`${nameKey(member.name)}|${realm.key}`) : null;
    return {
      key: memberKey(member),
      name: member.name,
      realm: realm ? realm.realm : realmDisplayName(guild.game_version, guild.region, member.realmSlug, null),
      realmSlug: member.realmSlug,
      class: member.class,
      level: member.level,
      rank: member.rank,
      status: !realm ? 'other_realm' : (owner ? 'on_roster' : 'new'),
      person: owner || null,
    };
  }).sort((a, b) => a.rank - b.rank || (b.level || 0) - (a.level || 0) || a.name.localeCompare(b.name));
  return jsonResponse({
    guild: { name: roster.guildName, realm: guild.realm },
    team: { id: team.id, name: team.name },
    fetchedAt: ctx.now(),
    rankLabels: settings.rankLabels,
    ranks: [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([rank, count]) => ({ rank, label: rankLabelOf(settings.rankLabels, rank), count })),
    rows,
  });
}

// Body: { teamId, defaultStatus, members: [{ name, realmSlug }] }.
export async function commitBnetRoster(ctx) {
  const { body } = ctx;
  requireTeamId(body);
  const status = readDefaultStatus(body.defaultStatus, 'defaultStatus', 'trial');
  const wanted = body.members;
  if (!Array.isArray(wanted) || wanted.length > MAX_COMMIT_MEMBERS) throw bad(`Send at most ${MAX_COMMIT_MEMBERS} members.`, 'members');
  requireBnetConfigured(ctx.env);
  wanted.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string' || typeof entry.realmSlug !== 'string') {
      throw bad('Each member needs a name and a realm.', 'members', indexed(index));
    }
  });
  const { guildContext, team } = await startImport(ctx);
  const { db } = ctx;
  const guild = guildContext.guild;
  await importRate(ctx);
  const { roster } = await readRoster(ctx, guildContext);
  const byKey = new Map(roster.members.map((member) => [memberKey(member), member]));

  const plan = { people: [], characters: [], nicknameUpdates: [], source: 'bnet', ref: 'guild' };
  const entries = [];
  const seen = new Set();
  wanted.forEach((entry, index) => {
    const key = `${nameKey(entry.name)}|${entry.realmSlug}`;
    if (seen.has(key)) throw bad('A member is in the list twice.', 'members', indexed(index));
    seen.add(key);
    const member = byKey.get(key);
    if (!member) throw new HttpError(409, 'roster_changed', 'The guild roster changed since you loaded it. Load it again.', indexed(index));
    const realm = memberRealm(guild, member);
    if (!realm) throw bad('That character is on a different realm than this guild.', 'members', indexed(index));
    const name = cleanCharacterName(member.name);
    if (!name) throw bad('That character name cannot be added to a roster.', 'members', indexed(index));
    const playerId = newId('p', ctx.randomBytes);
    plan.people.push({ id: playerId, status, discord: null, nickname: null });
    plan.characters.push({
      id: newId('c', ctx.randomBytes), playerId, name, realm: realm.realm, realmKey: realm.key, class: member.class, mainSpec: null, offSpec: null, isMain: true,
    });
    entries.push({ name, realmKey: realm.key, index });
  });
  await checkNames(db, guild.id, entries);
  const written = await writeImport(ctx, guildContext, team, plan);
  return jsonResponse(written.body, written.status);
}
