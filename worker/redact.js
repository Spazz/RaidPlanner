// Redaction by viewer tier (lane B6b part 3b; plan "Redaction"). ONE place decides which identity a reply may carry for WHO is reading it. Every emitter of an account (a person card
// with its avatar URL, which embeds the Discord ID, and its Discord handle) builds it here; worker/person.js `toPerson` shows nothing but the display name unless it is told to.
//
//   tierOf(guildContext)           'guild_master' | 'officer' | 'team_lead' | 'member'   (rank 0 / 1 / 2 / anything else; a custom role ranks as Member and holds no staff action;
//                                  a View-as stand-in has the stand-in's rank, so a preview shows what that role sees)
//   viewerFor(guildContext)        { tier, reveals }   reveals = the fields (REVEAL keys) this viewer may see: the tier reaches the field's `from` AND the viewer holds one of its `needs`
//   viewerAtTier(tier)             the same for code that knows the tier but has no context (the leaving Guild Master's own dialog): the tier's fields, no capability check
//   VIEWERS                        the viewers that are no member: guest, public, key, calendar (reveal nothing), self (the caller's own account), lookup (the exact-lookup of accounts)
//   personFor(row, viewer, { ceiling })   toPerson with the opt-ins the viewer has. `ceiling` = the fields THIS emitter is willing to show at all (default: every field of REVEAL);
//                                  an emitter that never showed one (join links: no avatar) keeps it out by naming the rest.
//   mayReveal(viewer, field)       boolean; a field that is not in REVEAL throws (fail fast: a typo must not read as "hidden")
//   NEVER                          the classes no reply carries for anybody (the sentinel CI pins each): Battle.net account id, Blizzard character / realm id, token hash, raw token (but once, to
//                                  its maker), webhook address (the notifications reply shows its last four characters), tombstone HMAC. A BattleTag is typed-only (`lookup`) or the caller's own.
//
// Who may see what is DATA (REVEAL). Today an avatar URL (and with it the Discord ID) and a Discord handle go to whoever can open People (guild.access or guild.roles: the Officer role and
// the Guild Master), as before part 3b; changing `from` to 'guild_master' narrows both to the Guild Master tier in one line (open point of the contract).
import { allows } from './permissions.js';
import { toPerson } from './person.js';

// Most to least trusted. 'member' is everybody below a Team Lead (custom-role holders included); guest, public, key and calendar are no members and rank below.
export const TIERS = ['guild_master', 'officer', 'team_lead', 'member', 'guest', 'public', 'key', 'calendar'];
const PERSON_TIERS = TIERS.slice(0, 4);
const RANK_TIER = { 0: 'guild_master', 1: 'officer', 2: 'team_lead' };

// field -> { from: the lowest tier that may see it, needs: the viewer must hold ONE of these actions }
export const REVEAL = Object.freeze({
  avatar: Object.freeze({ from: 'officer', needs: Object.freeze(['guild.access', 'guild.roles']) }),   // the URL carries the account's Discord ID
  handle: Object.freeze({ from: 'officer', needs: Object.freeze(['guild.access', 'guild.roles']) }),   // the Discord username (never the name the account shows)
});
export const FIELDS = Object.freeze(Object.keys(REVEAL));
export const NEVER = Object.freeze(['bnet_account_id', 'blizzard_id', 'token_hash', 'token', 'webhook', 'tombstone']);

export const tierOf = (guildContext) => RANK_TIER[guildContext.rank] || 'member';

const reaches = (tier, from) => PERSON_TIERS.includes(tier) && PERSON_TIERS.indexOf(tier) <= PERSON_TIERS.indexOf(from);
const viewer = (tier, reveals) => Object.freeze({ tier, reveals: Object.freeze(new Set(reveals)) });

export function viewerFor(guildContext) {
  const tier = tierOf(guildContext);
  return viewer(tier, FIELDS.filter((field) => reaches(tier, REVEAL[field].from) && REVEAL[field].needs.some((action) => allows(guildContext.can, action))));
}

export const viewerAtTier = (tier) => viewer(tier, FIELDS.filter((field) => reaches(tier, REVEAL[field].from)));

export const VIEWERS = Object.freeze({
  guest: viewer('guest', []),
  public: viewer('public', []),
  key: viewer('key', []),
  calendar: viewer('calendar', []),
  // The caller's own account (the sign-in's `user`, the account menu): their own avatar and handle, nobody else's.
  self: viewer('member', FIELDS),
  // The exact-lookup of accounts (GET .../accounts): an officer typed a name, so nothing but the name comes back (the matched BattleTag is the route's own field, typed-only).
  lookup: viewer('officer', []),
});

export function mayReveal(who, field) {
  if (!Object.prototype.hasOwnProperty.call(REVEAL, field)) throw new Error(`redact: ${field} is not a field`);
  return who.reveals.has(field);
}

export function personFor(row, who, { ceiling = FIELDS } = {}) {
  return toPerson(row, { avatar: ceiling.includes('avatar') && mayReveal(who, 'avatar'), handle: ceiling.includes('handle') && mayReveal(who, 'handle') });
}
