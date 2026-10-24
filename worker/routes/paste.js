import { guestIdentityStatement, guestKeysFor } from '../guest-identity.js';
// "Paste raid roster" on a raid without a log: an officer pastes the names of who was there (plain lists, the in-game /who, a raid frame copied from an
// addon), sees who matched, and saves them as the raid's hand-entered attendance.
//   POST /api/guild/:gid/raids/:rid/manual/paste/preview  { text }          (raids.edit)  who matched, who is a known guest, who matched nobody, the lines that were not names
//   POST /api/guild/:gid/raids/:rid/manual/paste          { text, reason? } (raids.edit)  sets the raid's attendance by hand: the matched people present, the names
//                                                          that matched nobody waiting in the review queue. -> the raid detail
// Names are matched like the Warcraft Logs import matches a log's: by name and realm against the guild's characters (a person once, however many characters
// were pasted), a Forever one-word name by the one character with that first word (worker/name-resolve.js). Both routes read the text again: the commit
// never trusts a preview. The parsing is worker/roster-paste.js.
import { HttpError, cleanText, jsonResponse } from '../http.js';
import { loadSurnameIndex, resolveName } from '../name-resolve.js';
import { loadGuildContext } from '../permissions.js';
import { MAX_PASTE_CHARS, matchPasted, parsePastedRoster } from '../roster-paste.js';
import { nameKey, realmKey } from '../roster-data.js';
import { loadRaid, recomputeAndReply, saveManual } from './raids.js';
import { bad, resolveRealm } from './roster.js';

const MAX_PEOPLE = 80;
const DEFAULT_REASON = 'Pasted raid roster';

function readText(body) {
  if (typeof body.text !== 'string' || !body.text.trim()) throw bad('Paste the names first.', 'text');
  if (body.text.length > MAX_PASTE_CHARS) throw bad(`Paste at most ${MAX_PASTE_CHARS} characters.`, 'text');
  return body.text;
}

// The pasted names against the guild: -> { parsed, matched, guests, unmatched }.
async function analyse(ctx, guild, text) {
  const { db } = ctx;
  const parsed = parsePastedRoster(text, { gameVersion: guild.game_version });
  if (!parsed.entries.length) return { parsed, matched: [], guests: [], unmatched: [] };
  const surnames = await loadSurnameIndex(db, guild);
  // Each candidate name, and (for a Forever one-word name) the full name it would resolve to on the guild's own realm.
  const ownRealmKey = resolveRealm(guild, undefined).key;
  const wanted = JSON.stringify([...new Set(parsed.entries.flatMap((entry) => entry.names.flatMap((name) => [nameKey(name), nameKey(resolveName(surnames, name, ownRealmKey))])))]);
  const [characterResult, guestResult] = await db.batch([
    db.prepare(
      `SELECT c.name, c.name_key, c.realm_key, c.class, c.player_id FROM characters c
        WHERE c.guild_id = ? AND c.name_key IN (SELECT value FROM json_each(?)) ORDER BY c.is_main DESC, c.id`,
    ).bind(guild.id, wanted),
    guestIdentityStatement(db, guild.id),
  ]);
  const characters = new Map();
  for (const row of characterResult.results) {
    const key = `${row.name_key}|${row.realm_key}`;
    if (!characters.has(key)) characters.set(key, { personId: row.player_id, name: row.name, class: row.class });
  }
  const guests = guestKeysFor(guestResult.results, ctx.params.rid);
  const realmOf = (text) => {
    if (text === null) return resolveRealm(guild, undefined);
    const found = resolveRealm(guild, text);
    return found || { realm: text.slice(0, 40), key: realmKey(text) || 'x' }; // another realm's name: it matches nobody here
  };
  const matched = matchPasted(parsed.entries, { characters, guests, surnames, realmOf });
  return { parsed, ...matched };
}

const view = (result) => ({
  matched: result.matched, guests: result.guests, unmatched: result.unmatched,
  ignored: result.parsed.ignored, ignoredCount: result.parsed.ignoredCount, tooLong: result.parsed.tooLong,
});

async function load(ctx) {
  const guildContext = await loadGuildContext(ctx.db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const raid = await loadRaid(ctx, guildContext, { edit: true });
  if (raid.starts_at > ctx.now()) throw new HttpError(409, 'raid_not_started', 'Enter attendance by hand once the raid has happened.');
  if (raid.reports > 0) throw new HttpError(409, 'raid_has_log', 'This raid has a report. Remove it before entering attendance by hand.');
  return { guildContext, raid };
}

export async function previewPaste(ctx) {
  const text = readText(ctx.body);
  const { guildContext, raid } = await load(ctx);
  const result = await analyse(ctx, guildContext.guild, text);
  return jsonResponse({
    ...view(result),
    // The raid already has hand-entered attendance: saving replaces who is ticked present.
    replacing: raid.log_mode === 'manual',
  });
}

export async function commitPaste(ctx) {
  const text = readText(ctx.body);
  const reason = ctx.body.reason === undefined || ctx.body.reason === null || ctx.body.reason === '' ? DEFAULT_REASON : cleanText(ctx.body.reason, 'reason', { min: 3, max: 200 });
  const { guildContext, raid } = await load(ctx);
  const result = await analyse(ctx, guildContext.guild, text);
  const ids = [...new Set(result.matched.map((entry) => entry.personId))];
  if (!ids.length && !result.unmatched.length) throw bad('None of the pasted lines is a name this guild can use.', 'text');
  if (ids.length > MAX_PEOPLE) throw bad(`Send at most ${MAX_PEOPLE} different people.`, 'text');
  await saveManual(ctx, guildContext, raid, { ids, reason, names: result.unmatched });
  return recomputeAndReply(ctx, guildContext, raid.id);
}
