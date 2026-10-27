// "This is me" (user-hierarchy build, lane B3 UI): a member types the start of a character name and sees the roster records nobody has linked yet, so they can say
// "this one is mine" (POST /me/characters with that name: an unlinked person makes it a pending claim an officer decides; worker/claim-apply.js).
//   GET /api/guild/:gid/roster/unlinked?q=   -> { matches: [{ name, class, mainSpec, realm, team: { id, name } | null }], more, waiting: [{ id, name, class, mainSpec, realm, team }] }
//     matches  characters of people that nobody owns (players.user_id NULL) and that record no Discord ID but the viewer's (personStanding 'open'), by name prefix,
//              only for people the Roster read lists (a character on a team roster: worker/team-roster.js) and not yet claimed by the viewer; the team is the character's,
//              else the person's Main's. At most 8; `more` says there are others (type more of the name).
//     waiting  the viewer's own pending typed claims (a Battle.net claim shows in the Battle.net list), so the page can offer Withdraw. Always sent, also without q.
// Rights: roster.view, like the Roster read. Refused in a guild whose characters come from Battle.net only ('ingame': 409 battlenet_only, like POST /me/characters).
// A search of two characters or more counts against FIND_LIMIT (worker/ratelimit.js); an empty or one-letter q reads only `waiting` and counts nothing.
import { HttpError, jsonResponse } from '../http.js';
import { visibleCharacterSql } from '../character-visibility.js';
import { openPersonSql } from '../membership.js';
import { loadGuildContext, requireAction } from '../permissions.js';
import { FIND_LIMIT, FIND_WINDOW_MS, enforceRateLimit } from '../ratelimit.js';
import { nameKey } from '../roster-data.js';
import { viewerOf } from '../roster-view.js';
import { teamRosterSql } from '../team-roster.js';

export const FIND_MIN_CHARS = 2;
export const FIND_MAX_CHARS = 40;
export const FIND_SHOWN = 8;

const MATCHES_SQL = `SELECT c.name, c.class, c.main_spec, c.realm, t.id AS team_id, t.name AS team_name
  FROM characters c
  JOIN players p ON p.id = c.player_id AND p.guild_id = c.guild_id
  LEFT JOIN characters m ON m.player_id = p.id AND m.guild_id = p.guild_id AND m.is_main = 1
  LEFT JOIN teams t ON t.guild_id = c.guild_id AND t.id = COALESCE(c.team_id, m.team_id)
 WHERE c.guild_id = ? AND c.name_key LIKE ? ESCAPE '!' AND ${visibleCharacterSql('c')}
   AND ${openPersonSql('p', '?')}
   AND EXISTS (SELECT 1 FROM characters rc WHERE rc.player_id = p.id AND rc.guild_id = p.guild_id AND ${teamRosterSql('rc')})
   AND NOT EXISTS (SELECT 1 FROM character_claims cl WHERE cl.guild_id = c.guild_id AND cl.user_id = ? AND cl.status = 'pending'
                     AND cl.name_key = c.name_key AND cl.realm_key = c.realm_key)
 ORDER BY c.name_key, c.id LIMIT ?`;

const WAITING_SQL = `SELECT cl.id, cl.name, cl.class, cl.realm, c.main_spec, t.id AS team_id, t.name AS team_name
  FROM character_claims cl
  LEFT JOIN characters c ON c.guild_id = cl.guild_id AND c.name_key = cl.name_key AND c.realm_key = cl.realm_key AND ${visibleCharacterSql('c')}
  LEFT JOIN characters m ON m.player_id = c.player_id AND m.guild_id = c.guild_id AND m.is_main = 1
  LEFT JOIN teams t ON t.guild_id = cl.guild_id AND t.id = COALESCE(c.team_id, m.team_id)
 WHERE cl.guild_id = ? AND cl.user_id = ? AND cl.status = 'pending' AND cl.level IS NULL
 ORDER BY cl.created_at, cl.id LIMIT 50`;

const teamOf = (row) => (row.team_id ? { id: row.team_id, name: row.team_name } : null);

export async function findUnlinked(ctx) {
  const { db, session } = ctx;
  const guildContext = await loadGuildContext(db, session.user.id, ctx.params.gid, session.viewAs);
  requireAction(guildContext, 'roster.view');
  const guildId = guildContext.guild.id;
  const source = await db.prepare('SELECT rank_source FROM guilds WHERE id = ?').bind(guildId).first();
  if (source && source.rank_source === 'ingame') {
    throw new HttpError(409, 'battlenet_only', 'In this guild characters are added to your record with Battle.net. Connect it on your profile and pick them from your list.');
  }
  const raw = new URL(ctx.request.url).searchParams.get('q');
  const typed = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : '';
  if (Array.from(typed).length > FIND_MAX_CHARS) throw new HttpError(400, 'bad_request', `Type at most ${FIND_MAX_CHARS} characters of the name.`, { field: 'q' });

  const waiting = (await db.prepare(WAITING_SQL).bind(guildId, session.user.id).all()).results.map((row) => ({
    id: row.id, name: row.name, class: row.class, mainSpec: row.main_spec || null, realm: row.realm || null, team: teamOf(row),
  }));
  let matches = [];
  let more = false;
  if (Array.from(typed).length >= FIND_MIN_CHARS) {
    await enforceRateLimit(db, session.user.id, ctx.now(), { key: `find:${session.user.id}`, limit: FIND_LIMIT, windowMs: FIND_WINDOW_MS });
    const prefix = nameKey(typed).replace(/[!%_]/g, (char) => `!${char}`);
    const viewer = viewerOf(ctx);
    const rows = (await db.prepare(MATCHES_SQL).bind(guildId, `${prefix}%`, viewer.discordId || null, session.user.id, FIND_SHOWN + 1).all()).results;
    more = rows.length > FIND_SHOWN;
    matches = rows.slice(0, FIND_SHOWN).map((row) => ({
      name: row.name, class: row.class, mainSpec: row.main_spec || null, realm: row.realm || null, team: teamOf(row),
    }));
  }
  return jsonResponse({ matches, more, waiting });
}
