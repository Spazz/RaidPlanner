// The gate of an Owner-only route that the Owner must be able to reach whatever the guild's membership rule says about them (lane B6b part 3a; closes B5 open point (c)).
//
// loadGuildContext asks "is this account a MEMBER?" before anybody asks "is it the Owner?". Under the legacy rule (the Discord server, or a linked person) an Owner who is in
// neither, a stored Guild Master who only ever signed in with Battle.net, is no member, so the flip dry run and the setup pin would answer them 403 not_member although they are
// the Owner. This gate asks the OWNER question first (worker/owner.js isOwner: the one definition, suspension included) and only falls back to the ordinary refusals for anybody
// else, so a non-member, a removed person, an Officer or a derived Guild Master still get exactly the answers they got before.
import { isOwner, requireOwner } from './owner.js';
import { loadGuildContext } from './permissions.js';

// -> { userId, guildId } for the Owner; throws 404 / 403 for anybody else (the answers of loadGuildContext + requireOwner). A dev "View as" stand-in never exercises an Owner act.
export async function requireOwnerFirst(db, { userId, guildId, viewAs = null }, message) {
  const standIn = !!viewAs && viewAs.guildId === guildId;
  if (!standIn && (await isOwner(db, guildId, userId))) return { userId, guildId };
  const guildContext = await loadGuildContext(db, userId, guildId, viewAs);
  await requireOwner(db, guildContext, message);
  return { userId, guildId };
}
