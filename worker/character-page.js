// The Character page's read model (user-hierarchy build, lane B8b "character"): one character of the signed-in account's OWN person, its team and core rank, its
// in-game rank, level, waiting team request, the loot it won and the raids it was in. The route is worker/routes/character-page.js; the user decisions are in
// tasks/open/b8b-character-contract.md.
//
//   OWNER ONLY. The character must be on the person that is the account's (worker/membership.js ownPersonStatement: players.user_id), never a Discord-only lookup.
//   Anything else is 404 (a character of someone else, of another guild, a retired placeholder, an unknown id): the answer never says which. The guild's own checks
//   (a member, not blocked) come after that, so the 403s never tell a stranger a character exists.
//   LOOT is what GET /loot/person/:pid answers for the viewer's own person (isMe: the loot policy never hides your own loot), filtered to this character.
//   RAIDS are the raids the character is named in: the boss-pull log (raid_presence) and, on a raid entered by hand, the typed names (raid_manual_names), both
//   by name_key + realm_key, read through the rename aliases (worker/name-alias.js) exactly as attendance reads them. BOSSES = distinct encounter_id with kill = 1 in
//   pulls the character was in, out of the distinct kills of that night. A raid entered by hand has no pulls, so it has NO bosses value; the zone's full boss count
//   is not stored and is never made up.
import { HttpError } from './http.js';
import { isId } from './ids.js';
import { ownPersonStatement, ownPlayerSql } from './membership.js';
import { visibleCharacterSql } from './character-visibility.js';
import { loadGuildContext } from './permissions.js';
import { resolvedNameKeySql, winnerNameKeySql } from './name-alias.js';
import { ingameRankLabelSql, CORE_RANK_LABELS } from './rank-map.js';
import { LOOT_TAGS } from './loot-policy.js';
import { AWARD_SELECT, LOOT_LIST_CAP, awardView, makeMatcher } from './loot-store.js';
import { parseSnapshot } from './bnet-store.js';
import { nameKey, realmKey } from './roster-data.js';
import { guildToday } from './roster-view.js';

// A character has about two raids a week: this is years of them.
export const RAID_CAP = 500;

export const MAIN_MESSAGE = 'The Main cannot be removed. Ask an officer to make another character your Main first.';

const notFound = () => new HttpError(404, 'not_found', 'That character was not found.');

// -> { guildContext, personId }. 404 unless the character is on the account's own person; then the guild's membership checks (403 not_member / access_removed).
export async function loadOwnedCharacter(ctx) {
  const { db, session } = ctx;
  const characterId = ctx.params.cid;
  if (!isId('c', characterId)) throw notFound();
  const found = await db.prepare(`SELECT guild_id, player_id FROM characters WHERE id = ? AND ${visibleCharacterSql('characters')}`).bind(characterId).first();
  if (!found) throw notFound();
  const own = await ownPersonStatement(db, found.guild_id, session.user.id).first();
  if (!own || own.id !== found.player_id) throw notFound();
  const guildContext = await loadGuildContext(db, session.user.id, found.guild_id, session.viewAs);
  return { guildContext, personId: own.id, characterId };
}

// The Battle.net rule for removing an own character: an Alt, and not one Battle.net proved in a guild whose in-game roster decides (the sync removes those when
// they leave the guild). SQL on the characters row of the statement (alias given, guild id as an expression). Fixed text.
export const mayRemoveOwnSql = (c, guildExpr) => `${c}.is_main = 0 AND (COALESCE(${c}.owner_proof, '') <> 'bnet' OR NOT EXISTS (SELECT 1 FROM guilds rg WHERE rg.id = ${guildExpr} AND rg.rank_source = 'ingame'))`;

// The writes of worker/routes/character-page.js, fixed text built once. Each repeats the owner's checks INSIDE the statement, so a race (the person handed to another account, the
// character made a Main, Battle.net proving it) changes nothing. Binds: see the routes.
//   STILL_OWN_SQL   the character's person is still the account's (binds: person id, guild id, user id)
export const STILL_OWN_SQL = `EXISTS (SELECT 1 FROM players op WHERE op.id = ? AND op.guild_id = ? AND ${ownPlayerSql('op', '?')})`;
//   UPDATE_SPECS_SQL  binds: main spec, off spec, now, character id, person id, guild id, the main spec and off spec it read, then STILL_OWN_SQL's three
export const UPDATE_SPECS_SQL = `UPDATE characters SET main_spec = ?, off_spec = ?, updated_at = ?
  WHERE id = ? AND player_id = ? AND guild_id = ? AND main_spec IS ? AND off_spec IS ? AND ${STILL_OWN_SQL}`;
//   REMOVABLE_SQL (the audit row's guard, it runs BEFORE the delete) and DELETE_SQL  binds: character id, person id, guild id, guild id, then STILL_OWN_SQL's three
export const REMOVABLE_SQL = `EXISTS (SELECT 1 FROM characters rc WHERE rc.id = ? AND rc.player_id = ? AND rc.guild_id = ? AND ${visibleCharacterSql('rc')} AND ${mayRemoveOwnSql('rc', '?')}) AND ${STILL_OWN_SQL}`;
export const DELETE_SQL = `DELETE FROM characters WHERE id = ? AND player_id = ? AND guild_id = ? AND ${visibleCharacterSql('characters')} AND ${mayRemoveOwnSql('characters', '?')} AND ${STILL_OWN_SQL} RETURNING id`;

const CHARACTER_SQL = `SELECT c.id, c.player_id, c.team_id, c.name, c.name_key, c.realm, c.realm_key, c.class, c.main_spec, c.off_spec, c.is_main, c.created_at, c.core_rank,
       c.owner_proof, c.namespace, t.name AS team_name, ${ingameRankLabelSql('c')} AS ingame_rank,
       (SELECT g.level FROM guild_roster g WHERE g.guild_id = c.guild_id AND g.namespace = c.namespace AND g.blizzard_realm_id = c.blizzard_realm_id
           AND g.blizzard_char_id = c.blizzard_char_id) AS roster_level
  FROM characters c LEFT JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id WHERE c.id = ?1 AND c.guild_id = ?2 AND c.player_id = ?3 AND ${visibleCharacterSql('c')}`;

// The name the evidence of a raid carries, as the characters carry it today (dated at the raid), compared to the character's own key.
const EVIDENCE_KEY = resolvedNameKeySql({ guild: 'rp.guild_id', nameKey: 'rp.name_key', realmKey: 'rp.realm_key', at: 'pr.starts_at' });
const STORED_KEYS = `SELECT ?2 UNION SELECT nal.name_key FROM character_name_aliases nal WHERE nal.guild_id = ?1 AND nal.character_id = ?4`;
const RAIDS_SQL = `WITH logged AS (
    SELECT rp.raid_id AS raid_id, rp.pull_id AS pull_id FROM raid_presence rp JOIN raids pr ON pr.id = rp.raid_id
     WHERE rp.guild_id = ?1 AND rp.name_key IN (${STORED_KEYS}) AND rp.realm_key = ?3 AND ${EVIDENCE_KEY} = ?2),
  typed AS (
    SELECT rp.raid_id AS raid_id FROM raid_manual_names rp JOIN raids pr ON pr.id = rp.raid_id
     WHERE rp.guild_id = ?1 AND rp.name_key IN (${STORED_KEYS}) AND rp.realm_key = ?3 AND ${EVIDENCE_KEY} = ?2)
  SELECT r.id AS raid_id, r.raid_on, r.zone, r.title, r.event_title, r.team_id, t.name AS team_name, r.log_mode,
         (SELECT COUNT(DISTINCT k.encounter_id) FROM raid_pulls k WHERE k.raid_id = r.id AND k.kill = 1) AS kills,
         (SELECT COUNT(DISTINCT k.encounter_id) FROM raid_pulls k WHERE k.raid_id = r.id AND k.kill = 1
             AND k.id IN (SELECT l.pull_id FROM logged l WHERE l.raid_id = r.id)) AS present
    FROM raids r JOIN teams t ON t.id = r.team_id AND t.guild_id = r.guild_id
   WHERE r.guild_id = ?1 AND (r.id IN (SELECT raid_id FROM logged) OR r.id IN (SELECT raid_id FROM typed))
   ORDER BY r.raid_on DESC, r.id LIMIT ?5`;

// The level the account's Battle.net snapshot holds for this character (a character that is not on the in-game roster, or a guild that has none).
function snapshotLevel(snapshotText, row) {
  const snapshot = parseSnapshot(snapshotText);
  for (const entry of Object.values(snapshot)) {
    const list = entry && Array.isArray(entry.characters) ? entry.characters : [];
    const hit = list.find((one) => one && typeof one.name === 'string' && nameKey(one.name) === row.name_key && realmKey(one.realm) === row.realm_key);
    if (hit && Number.isInteger(hit.level)) return hit.level;
  }
  return null;
}

const siblingView = (row) => ({
  id: row.id, name: row.name, class: row.class, mainSpec: row.main_spec, offSpec: row.off_spec, isMain: row.is_main === 1,
  team: { id: row.team_id, name: row.team_name },
});

// The whole page for one character of the account's own person (the answer of the GET and of every write on this page).
export async function characterPageReply(ctx, guildContext, personId, characterId) {
  const { db } = ctx;
  const guild = guildContext.guild;
  const row = await db.prepare(CHARACTER_SQL).bind(characterId, guild.id, personId).first();
  if (!row) throw notFound();
  const [guildResult, siblingResult, requestResult, freeResult, awardResult, raidResult, snapshotResult] = await db.batch([
    db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guild.id),
    db.prepare(
      `SELECT c.id, c.player_id, c.team_id, c.name, c.name_key, c.realm_key, c.class, c.main_spec, c.off_spec, c.is_main, t.name AS team_name
         FROM characters c LEFT JOIN teams t ON t.id = c.team_id AND t.guild_id = c.guild_id
        WHERE c.guild_id = ? AND c.player_id = ? AND ${visibleCharacterSql('c')} ORDER BY c.is_main DESC, c.name_key, c.id`,
    ).bind(guild.id, personId),
    db.prepare(
      `SELECT q.id, q.team_id, q.created_at, t.name AS team_name FROM team_requests q JOIN teams t ON t.id = q.team_id AND t.guild_id = q.guild_id
        WHERE q.guild_id = ? AND q.character_id = ? AND q.status = 'pending'`,
    ).bind(guild.id, characterId),
    // The teams this person could still ask for: active, and none of their characters is on it (one character per person per team). A guild whose ranks set the team
    // (a rank map row that carries a team; the mode is reserved in this build, no writer yet) has no Request team at all (user decision H-Q17).
    db.prepare(
      `SELECT COUNT(*) AS n FROM teams t WHERE t.guild_id = ?1 AND t.archived = 0
          AND NOT EXISTS (SELECT 1 FROM characters x WHERE x.player_id = ?2 AND x.team_id = t.id AND ${visibleCharacterSql('x')})
          AND NOT EXISTS (SELECT 1 FROM source_rank_maps m WHERE m.guild_id = ?1 AND m.team_id IS NOT NULL)`,
    ).bind(guild.id, personId),
    db.prepare(
      `${AWARD_SELECT} WHERE a.guild_id = ?1 AND EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.id = ?2 AND ${visibleCharacterSql('c')}
            AND c.name_key = ${winnerNameKeySql('a')} AND c.realm_key = a.winner_realm_key) ORDER BY a.awarded_at DESC, a.id LIMIT ?3`,
    ).bind(guild.id, characterId, LOOT_LIST_CAP),
    db.prepare(RAIDS_SQL).bind(guild.id, row.name_key, row.realm_key, characterId, RAID_CAP),
    db.prepare('SELECT snapshot FROM bnet_links WHERE user_id = ?').bind(ctx.session.user.id),
  ]);
  const source = guildResult.results[0] ? guildResult.results[0].rank_source : null;
  const siblings = siblingResult.results;
  const matcher = makeMatcher(siblings, []);
  const awards = awardResult.results.map((award) => awardView(award, matcher(award)));
  const waiting = requestResult.results[0] || null;
  const onTeam = row.team_id !== null;
  const request = waiting && !onTeam ? { id: waiting.id, team: { id: waiting.team_id, name: waiting.team_name }, createdAt: waiting.created_at } : null;
  const roster = Number.isInteger(row.roster_level) ? row.roster_level : null;
  const snapshot = snapshotResult.results[0] ? snapshotLevel(snapshotResult.results[0].snapshot, row) : null;
  const removable = row.is_main === 0 && !(row.owner_proof === 'bnet' && source === 'ingame');
  return {
    guild: { id: guild.id, name: guild.name, realm: guild.realm, gameVersion: guild.game_version, timeZone: guild.time_zone, rankSource: source },
    character: {
      id: row.id, name: row.name, realm: row.realm, class: row.class, mainSpec: row.main_spec, offSpec: row.off_spec, isMain: row.is_main === 1,
      level: roster !== null ? roster : snapshot, inGameRank: row.ingame_rank || null, coreRank: row.core_rank, coreRankLabel: CORE_RANK_LABELS[row.core_rank] || row.core_rank,
      addedOn: guildToday(guild, row.created_at),
    },
    team: onTeam ? { id: row.team_id, name: row.team_name } : null,
    request,
    siblings: siblings.filter((one) => one.id !== row.id).map(siblingView),
    loot: { awards, totals: Object.fromEntries(LOOT_TAGS.map((tag) => [tag, awards.filter((award) => award.tag === tag).length])) },
    raids: raidResult.results.map((raid) => ({
      raidId: raid.raid_id, raidOn: raid.raid_on, zone: raid.zone, title: raid.title || raid.event_title || null, team: { id: raid.team_id, name: raid.team_name },
      bosses: raid.log_mode === 'manual' ? null : { killed: raid.present, kills: raid.kills },
    })),
    can: { remove: removable, requestTeam: !onTeam && !request && freeResult.results[0].n > 0, editSpecs: true },
  };
}
