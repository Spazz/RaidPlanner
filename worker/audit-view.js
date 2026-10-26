// The Activity log, the pure half (no I/O): which group an audited action belongs to, the plain sentence for a row, the references a page of
// rows needs names for, and the CSV of the rows. worker/routes/audit.js reads the rows, resolves the names and calls these.
// The audit log holds internal ids and flags only (never note text), so every name in a sentence is looked up at read time; an entity that
// is gone since reads as "a person" / "a character" and the details toggle still shows the ids.
import { AUDIT_ACTIONS } from './audit.js';
import { addDays, weekdayOf } from './attendance-calendar.js';
import { OUTCOMES } from './attendance-policy.js';
import { isId } from './ids.js';
import { CLASSES } from './roster-data.js';

export const AUDIT_GROUPS = Object.freeze([
  { id: 'roster', label: 'Roster' },
  { id: 'raids', label: 'Raids' },
  { id: 'attendance', label: 'Attendance' },
  { id: 'loot', label: 'Loot' },
  { id: 'signups', label: 'Sign-ups' },
  { id: 'bnet', label: 'Battle.net' },
  { id: 'settings', label: 'Settings' },
]);
export const GROUP_IDS = AUDIT_GROUPS.map((group) => group.id);

// Every audited action and its group. An action nobody listed here reads as 'settings' (the catch-all), and the Worker suite fails when an
// action of audit.js has no entry, so a new action gets a conscious home.
export const ACTION_GROUP = Object.freeze({
  'person.create': 'roster', 'person.update': 'roster', 'person.delete': 'roster', 'person.notes': 'roster',
  'person.account_link': 'roster', 'person.account_unlink': 'roster', 'person.join': 'roster', 'character.match_roster': 'roster',
  // The Battle.net sign-in match (B6a): a person made or linked from the account's roster characters; a newer proof replacing another account's.
  'person.match_create': 'roster', 'person.match_link': 'roster', 'character.proof_supersede': 'bnet',
  // B6a part 2b: a character re-homed to the person whose Battle.net account proved it (or an officer's claim); a name given up to a roster character.
  'character.rehome': 'roster', 'character.name_retire': 'roster',
  'character.create': 'roster', 'character.update': 'roster', 'character.delete': 'roster', 'character.main': 'roster', 'character.place': 'roster', 'character.release': 'roster', 'character.move': 'roster', 'team_request.create': 'roster', 'team_request.withdraw': 'roster', 'team_request.approve': 'roster', 'team_request.reject': 'roster', 'roster.import': 'roster',
  'raid.create': 'raids', 'raid.delete': 'raids', 'raid.event': 'raids', 'raid.report': 'raids', 'raid.plan': 'raids', 'raid.plan_edit': 'raids', 'raid.manual': 'raids',
  'schedule.update': 'raids', 'schedule.fill': 'raids', 'raid.settings': 'raids', 'roster.publish': 'raids', 'roster.unpublish': 'raids', 'roster.decline': 'signups',
  'away.set': 'signups', 'away.remove': 'signups',
  'attendance.decide': 'attendance', 'attendance.undo': 'attendance', 'attendance.link': 'attendance', 'attendance.guest': 'attendance',
  'policy.update': 'attendance', 'wcl.settings': 'attendance',
  'loot.import': 'loot', 'loot.update': 'loot', 'loot.delete': 'loot', 'loot.policy': 'loot', 'loot.list': 'loot', 'loot.add': 'loot',
  'signup.set': 'signups', 'signup.remove': 'signups', 'signup.link': 'signups', 'signup.lock': 'signups',
  'bnet.link': 'bnet', 'bnet.unlink': 'bnet', 'bnet.settings': 'bnet', 'rank_map.update': 'bnet',
  'claim.create': 'bnet', 'claim.withdraw': 'bnet', 'claim.approve': 'bnet', 'claim.reject': 'bnet', 'character.claim': 'bnet',
  'guild.create': 'settings', 'guild.update': 'settings', 'guild.claim': 'settings', 'guild.delete': 'settings', 'guild.export': 'settings', 'team.create': 'settings', 'team.rename': 'settings',
  'team.archive': 'settings', 'team.restore': 'settings', 'roles.set': 'settings', 'guild_master.transfer': 'settings',
  'guild_master.auto_promote': 'settings', 'access.remove': 'settings', 'access.restore': 'settings', 'account.delete': 'settings', 'team.size': 'settings', 'team.trial_days': 'settings',
  // Written with no guild (the account's own sign-ins), so they never reach a guild's log; mapped so the action list stays complete.
  'discord.link': 'settings', 'discord.unlink': 'settings',
  // Phase 7: the role editor, the Discord role mapping and sync, guest links and the public page. Settings, like roles.set and access.*.
  'role.create': 'settings', 'role.update': 'settings', 'role.delete': 'settings', 'role.reset': 'settings',
  'discord.maps': 'settings', 'roles.discord_sync': 'settings', 'guest.create': 'settings', 'guest.revoke': 'settings', 'public.update': 'settings',
  // PM wave 3: the spec poll (intent) and recruitment needs and the applications inbox sit with the roster; the application switch and questions are settings.
  'intent.open': 'roster', 'intent.close': 'roster', 'intent.pick': 'roster', 'intent.unpick': 'roster', 'recruiting.targets': 'roster',
  'application.submit': 'roster', 'application.update': 'roster', 'application.accept': 'roster', 'application.delete': 'roster', 'apply.settings': 'settings',
  // PM wave 4: the Discord notification settings, and the Worker switching a dead webhook off (which has no actor).
  'notify.update': 'settings', 'notify.disabled': 'settings',
  // PM wave 6: a test post to a team's webhook.
  'notify.test': 'settings',
  // PM wave 7: read-only API keys are settings; a person's rank (set by hand, or by accepting the ladder's suggestion) and a dismissed suggestion sit with attendance.
  'apikey.create': 'settings', 'apikey.revoke': 'settings', 'person.rank': 'attendance', 'rank.dismiss': 'attendance',
  // PM wave 8: raid duties, the Launch funnel, and the guest sign-up link (a guest signing up has no actor: the log names Raidsmith).
  'duties.set': 'raids', 'launch.update': 'roster', 'launch.team': 'settings',
  // Home redesign: a to-do hidden for every officer (dismissed, snoozed, or a watch entry marked Reviewed), and brought back.
  'attention.dismiss': 'raids', 'attention.restore': 'raids',
  'join.create': 'signups', 'join.revoke': 'signups', 'signup.guest': 'signups', 'signup.guest_remove': 'signups', 'signup.guest_resolve': 'signups',
  'signup.guests_clear': 'signups', 'signup.open': 'signups', 'signup.open_withdraw': 'signups',
  // Lane B7a: blocks and tombstone matches sit with access.remove; the per-person detail of a sync run is roster history; failures are settings.
  'person.block': 'settings', 'person.unblock': 'settings', 'block.match': 'settings', 'block.match_held': 'settings', 'block.keep': 'settings',
  'person.core_rank': 'roster', 'person.ingame_rank': 'roster', 'person.former': 'roster',
  'fresh.failed': 'settings', 'guild.claim_failed': 'settings',
  // Lane B6b part 2a: a sign-in identity of an account was linked or disconnected (written in every guild the account is a member of).
  'identity.change': 'settings',
});

// Actions the Worker writes itself (no actor): the Activity log names "Raidsmith" for them instead of a former member.
export const SYSTEM_ACTIONS = Object.freeze(['notify.disabled', 'signup.guest']);

export const groupOf = (action) => (Object.prototype.hasOwnProperty.call(ACTION_GROUP, action) ? ACTION_GROUP[action] : 'settings');

// The actions a group filter selects. The catch-all group is "everything the other groups do not list", so a new unlisted action shows up
// under Settings instead of nowhere.
export function groupFilter(group) {
  const listed = (id) => Object.keys(ACTION_GROUP).filter((action) => ACTION_GROUP[action] === id);
  if (group !== 'settings') return { not: false, actions: listed(group) };
  return { not: true, actions: Object.keys(ACTION_GROUP).filter((action) => ACTION_GROUP[action] !== 'settings') };
}

export const unmappedActions = () => AUDIT_ACTIONS.filter((action) => !Object.prototype.hasOwnProperty.call(ACTION_GROUP, action));

// ---------------------------------------------------------------------------
// References: the ids a set of rows names, so the route can look their names up in one batch.

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// rows: [{ actor: id | null, entityType, entityId, before, after }] -> sets of ids by kind.
export function collectRefs(rows) {
  const refs = { persons: new Set(), characters: new Set(), teams: new Set(), raids: new Set(), users: new Set(), awards: new Set(), claims: new Set() };
  const take = (set, prefix, value) => { if (isId(prefix, value)) set.add(value); };
  for (const row of rows) {
    take(refs.users, 'u', row.actor);
    const byType = { person: refs.persons, character: refs.characters, team: refs.teams, raid: refs.raids, user: refs.users, loot: refs.awards, claim: refs.claims }[row.entityType];
    if (byType) take(byType, { person: 'p', character: 'c', team: 't', raid: 'r', user: 'u', loot: 'lo', claim: 'cl' }[row.entityType], row.entityId);
    for (const side of [asObject(row.before), asObject(row.after)]) {
      take(refs.persons, 'p', side.personId);
      take(refs.persons, 'p', side.playerId);
      take(refs.teams, 't', side.teamId);
      take(refs.teams, 't', side.scope);
      take(refs.raids, 'r', side.raidId);
      take(refs.characters, 'c', side.mainCharacterId);
      take(refs.characters, 'c', side.characterId);
      for (const id of Array.isArray(side.characterIds) ? side.characterIds : []) take(refs.characters, 'c', id);
      take(refs.users, 'u', side.guildMasterUserId);
      take(refs.users, 'u', side.userId);
      for (const id of Array.isArray(side.teamLeadTeamIds) ? side.teamLeadTeamIds : []) take(refs.teams, 't', id);
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Sentences

const STATUS_LABEL = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve', inactive: 'Inactive' };
const CORE_RANK_LABEL = { raider: 'Raider', trial: 'Trial', reserve: 'Reserve', social: 'Social' };
const LEFT_LABEL = { left: 'left the guild', kicked: 'kicked', break: 'on a break', other: 'other' };
const KIND_LABEL = { signed: 'Signed', late: 'Late', standby: 'Standby', tentative: 'Tentative', bench: 'Bench', absence: 'Can\'t come' };
const AWAY_LABEL = { away: 'Away', late: 'Late', leaving: 'Leaving early' };
const SOURCE_LABEL = { raid_helper: 'Raid-Helper', wcl: 'Warcraft Logs', bnet: 'Battle.net', csv: 'a CSV file' };
const CLASS_LABEL = Object.fromEntries(CLASSES.map((entry) => [entry.id, entry.name]));
const APPLICATION_STATUS_LABEL = { new: 'New', reviewing: 'Reviewing', accepted: 'Accepted', declined: 'Declined' };
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BUILTIN_ROLE_LABEL = { guild_master: 'Guild Master', officer: 'Officer', team_lead: 'Team Lead', member: 'Member', guest: 'Guest', public: 'Public' };
const NOTIFY_LABEL = {
  webhook: 'webhook', roleMention: 'mentioned role', roster: 'line-up posts', loot: 'loot posts', reminders: 'raid reminders', noreply: 'no-reply reminders',
  noreplyHours: 'no-reply lead time', confirm: 'line-up confirm reminders',
};
const CHANGED_LABEL = {
  status: 'status', joinedOn: 'join date', trialStart: 'trial start', trialEnd: 'trial end', leftOn: 'left date', leftReason: 'reason for leaving',
  link: 'Discord link', teamId: 'team', class: 'class', mainSpec: 'main spec', offSpec: 'off spec',
};

// 'Tue Oct 21' of a YYYY-MM-DD; the text itself when it is no date.
export function dayLabel(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return String(date || '');
  try {
    return `${WEEKDAY[weekdayOf(date)]} ${MONTH[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
  } catch {
    return date;
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
// Two payloads are the same when their keys and values are, whatever the key order (the role editor's permission maps).
const stableJson = (value) => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const humanChanged = (changed) => [...new Set((Array.isArray(changed) ? changed : []).map((key) => CHANGED_LABEL[key] || key))];

const ATTENTION_LABEL = {
  loot_unmatched: 'unmatched loot winners', signup_unmatched: 'unmatched Raid-Helper sign-ups', event_moved: 'moved Raid-Helper event', no_loot: 'no loot imported',
  log_missing: 'missing log', loot_dupe: 'possible duplicate loot award', trial: 'trial ending', webhook_off: 'Discord webhook switched off', watch: 'attendance watch',
};
// 'Dismissed the to-do "missing log" for the raid on Tue Oct 21', 'Snoozed ... for 3 days', 'Marked Mira as reviewed on the attendance watch list', 'Restored ...'.
function attentionSentence(side, restored, { person, team, onRaid }) {
  const label = ATTENTION_LABEL[side.kind] || 'item';
  let where = '';
  if (side.raidId) where = ` for ${onRaid(side.raidId)}`;
  else if (side.personId) where = ` for ${person(side.personId)}`;
  else if (side.teamId) where = ` for ${team(side.teamId)}`;
  if (side.mode === 'reviewed') return `${restored ? 'Took' : 'Marked'} ${person(side.personId)} ${restored ? 'off Reviewed' : 'as reviewed'} on the attendance watch list`;
  if (restored) return `Restored the to-do "${label}"${where}`;
  const days = side.mode === 'snooze' && typeof side.days === 'number' ? ` for ${plural(side.days, 'day', 'days')}` : '';
  return `${side.mode === 'snooze' ? 'Snoozed' : 'Dismissed'} the to-do "${label}"${where}${days}`;
}

// names: { person(id), character(id), team(id), raid(id), user(id), award(id), claim(id) } -> a display string or null. Each is optional.
export function describeRow(row, names = {}) {
  const get = (kind, id, fallback) => {
    const found = typeof names[kind] === 'function' ? names[kind](id) : null;
    return found || fallback;
  };
  const before = asObject(row.before);
  const after = asObject(row.after);
  const person = (id) => get('person', id, 'a person');
  const character = (id) => get('character', id, 'a character');
  const team = (id) => get('team', id, 'a team');
  const user = (id) => get('user', id, 'a member');
  const raidOn = (id) => get('raid', id, 'a raid');
  const onRaid = (id) => `the raid on ${raidOn(id)}`;
  const scopeText = (scope) => (scope === 'guild' ? 'the whole guild' : team(scope));
  const ent = row.entityId;

  switch (row.action) {
    case 'guild.create': return 'Created the guild';
    case 'guild.update': {
      const parts = [];
      if (after.name !== undefined) parts.push(`the name from ${before.name === undefined ? 'its old name' : `"${before.name}"`} to "${after.name}"`);
      if (after.realm !== undefined) parts.push(`the realm from ${before.realm === undefined ? 'its old realm' : before.realm} to ${after.realm}`);
      if (after.timeZone !== undefined) parts.push(`the time zone from ${before.timeZone === undefined ? 'its old zone' : before.timeZone} to ${after.timeZone}`);
      return parts.length ? `Changed ${list(parts)}` : 'Changed the guild settings';
    }
    case 'guild.claim': return 'Claimed the guild as Guild Master';
    case 'guild.delete': return 'Deleted the guild';
    case 'guild.export': return 'Downloaded the guild data';
    case 'account.delete': return 'Deleted an account';
    case 'team.create': return `Created the team ${team(ent)}`;
    case 'team.rename': return `Renamed a team to ${team(ent)}`;
    case 'team.archive': return `Archived the team ${team(ent)}`;
    case 'team.restore': return `Restored the team ${team(ent)}`;
    case 'team.trial_days': return `Set the trial length of ${team(ent)} to ${after.trialDays === undefined ? 'a new length' : after.trialDays + ' days'}`;
    case 'team.size': return `Set the raid size of ${team(ent)} to ${after.size === undefined ? 'a new size' : after.size}`;
    case 'roles.set': {
      const parts = [];
      if (before.officer !== undefined && before.officer !== after.officer) parts.push(after.officer ? `Made ${user(ent)} an Officer` : `Removed ${user(ent)} as Officer`);
      const was = Array.isArray(before.teamLeadTeamIds) ? before.teamLeadTeamIds : [];
      const now = Array.isArray(after.teamLeadTeamIds) ? after.teamLeadTeamIds : [];
      const added = now.filter((id) => !was.includes(id)).map(team);
      const removed = was.filter((id) => !now.includes(id)).map(team);
      if (added.length) parts.push(`${parts.length ? 'made them' : `Made ${user(ent)}`} Team Lead of ${list(added)}`);
      if (removed.length) parts.push(`${parts.length ? 'removed them' : `Removed ${user(ent)}`} as Team Lead of ${list(removed)}`);
      return parts.length ? parts.join(' and ') : `Changed the roles of ${user(ent)}`;
    }
    case 'guild_master.transfer': return `Handed Guild Master to ${user(ent)}`;
    case 'guild_master.auto_promote': return after.guildMasterUserId ? `Guild Master passed to ${user(after.guildMasterUserId)}` : 'The guild has no Guild Master';
    case 'access.remove': return `Removed the access of ${user(ent)}`;
    case 'access.restore': return `Restored the access of ${user(ent)}`;
    case 'person.block': return `Removed the access of ${person(ent)}, who has no account yet`;
    case 'person.unblock': return `Restored the access of ${person(ent)}`;
    case 'block.keep': return `Kept the removal of ${user(ent)}, which matched an earlier block`;
    case 'block.match': return `${user(ent)} matched an earlier block and was removed until an officer reviews it`;
    case 'block.match_held': return `${user(ent)} matched an earlier block but was not removed (${after.reason === 'senior' ? 'they rank the same as the officer who blocked, or above' : 'they hold the Owner seat or a Guild Master role'}); an officer needs to review it`;
    case 'person.core_rank': return `${person(ent)} went from ${CORE_RANK_LABEL[before.coreRank] || 'one rank'} to ${CORE_RANK_LABEL[after.coreRank] || 'another'}`;
    case 'person.ingame_rank': return `The in-game rank of ${person(ent)} went from ${before.rank === undefined ? 'one rank' : before.rank} to ${after.rank === undefined ? 'another' : after.rank}`;
    case 'person.former': return `${person(ent)} left the in-game guild and is now Former`;
    case 'fresh.failed': return `A sign-in check for a sensitive act failed${after.count > 1 ? ` ${after.count} times in an hour` : ''}`;
    case 'identity.change': return `${after.change === 'unlink' ? 'Disconnected' : 'Connected'} the ${after.provider === 'discord' ? 'Discord' : 'Battle.net'} sign-in of ${user(ent)}`;
    case 'guild.claim_failed': return `A claim of the Guild Master seat failed${after.count > 1 ? ` ${after.count} times in an hour` : ''}`;

    // Phase 7. A role's name comes from the row (a custom role can be renamed or deleted since); a built-in role has a fixed label.
    case 'role.create': return `Created the role ${after.name || 'a role'}`;
    case 'role.update': {
      const was = before.name || BUILTIN_ROLE_LABEL[ent] || 'a role';
      const now = after.name || was;
      const permissionsChanged = stableJson(before.permissions) !== stableJson(after.permissions);
      if (was !== now) return `Renamed the role ${was} to ${now}${permissionsChanged ? ' and changed its permissions' : ''}`;
      return permissionsChanged ? `Changed the permissions of the role ${now}` : `Updated the role ${now}`;
    }
    case 'role.reset': return BUILTIN_ROLE_LABEL[ent] ? `Reset the role ${BUILTIN_ROLE_LABEL[ent]} to its defaults` : 'Reset a role to its defaults';
    case 'role.delete': return `Deleted the role ${before.name || 'a role'}`;
    case 'discord.maps': {
      const was = Array.isArray(before.maps) ? before.maps.length : 0;
      const now = Array.isArray(after.maps) ? after.maps.length : 0;
      return `Changed the Discord role mapping: ${plural(now, 'Discord role', 'Discord roles')} mapped (was ${was})`;
    }
    case 'roles.discord_sync': {
      const key = (pair) => `${pair && pair.roleId}|${(pair && pair.teamId) || ''}`;
      const had = new Set((Array.isArray(before.roles) ? before.roles : []).map(key));
      const has = new Set((Array.isArray(after.roles) ? after.roles : []).map(key));
      const added = [...has].filter((k) => !had.has(k)).length;
      const removed = [...had].filter((k) => !has.has(k)).length;
      const parts = [];
      if (added) parts.push(`${added} added`);
      if (removed) parts.push(`${removed} removed`);
      return `Synced the Discord roles of ${user(ent)}${parts.length ? `: ${parts.join(', ')}` : ''}`;
    }
    case 'guest.create': return `Created a guest link for ${scopeText(after.teamId || 'guild')}${after.expiresAt ? '' : ' that does not expire'}`;
    case 'guest.revoke': return 'Turned off a guest link';
    case 'apikey.create': {
      const datasets = Array.isArray(after.datasets) ? after.datasets : [];
      return `Made a data key for ${scopeText(after.teamId || 'guild')}${datasets.length ? ` (${list(datasets)})` : ''}${after.expiresAt ? '' : ' that does not expire'}`;
    }
    case 'apikey.revoke': return 'Turned off a data key';
    case 'public.update': {
      const sections = Array.isArray(after.sections) ? after.sections : [];
      if (!after.enabled) return before.enabled ? 'Turned the public page off' : 'Changed the public page settings';
      const shown = sections.length ? ` (${list(sections)})` : '';
      return before.enabled ? `Changed what the public page shows${shown}` : `Turned the public page on${shown}`;
    }

    case 'person.create': return `Added ${person(ent)} to the roster${STATUS_LABEL[after.status] ? ` as ${STATUS_LABEL[after.status]}` : ''}`;
    case 'person.update': {
      const changed = Array.isArray(after.changed) ? after.changed : [];
      const rest = humanChanged(changed.filter((key) => key !== 'status' && key !== 'leftOn' && key !== 'leftReason'));
      const moved = changed.includes('status') ? STATUS_LABEL[after.status] : null;
      if (moved) {
        const why = after.status === 'inactive' && LEFT_LABEL[after.leftReason] ? ` (${LEFT_LABEL[after.leftReason]})` : '';
        return `Moved ${person(ent)} to ${moved}${why}${rest.length ? ` and updated ${list(rest)}` : ''}`;
      }
      const other = humanChanged(changed);
      return other.length ? `Updated ${person(ent)}: ${list(other)}` : `Updated ${person(ent)}`;
    }
    case 'person.delete': return `Removed ${person(ent)} from the roster`;
    case 'person.rank':
      if (after.rank === null || after.rank === undefined) return `Cleared the rank of ${person(ent)}`;
      return `Set the rank of ${person(ent)} to ${after.rankName || after.rank}${after.via === 'accept' ? ' (accepted the suggestion)' : ''}`;
    case 'rank.dismiss':
      return after.kind === 'review' ? `Dismissed the suggestion to review ${person(ent)} for 30 days` : `Dismissed the suggestion to promote ${person(ent)}${after.toName ? ` to ${after.toName}` : ''} for 30 days`;
    case 'person.notes': return `Edited the officer notes of ${person(ent)}`;
    // An officer's account link (Phase 7a): the account's name is looked up at read time; an account since deleted reads as "an account".
    case 'person.account_link': return `Linked ${person(ent)} to ${get('user', after.userId, null) ? `the account ${user(after.userId)}` : 'an account'}`;
    case 'person.account_unlink': return `Unlinked ${get('user', before.userId, null) ? `the account ${user(before.userId)}` : 'an account'} from ${person(ent)}`;
    case 'character.create': return `Added the character ${character(ent)} to ${person(after.personId)}`;
    case 'character.update': {
      const other = humanChanged(after.changed);
      return `Updated the character ${character(ent)}${other.length ? `: ${list(other)}` : ''}`;
    }
    case 'character.delete': return `Removed a character from ${person(before.personId)}`;
    case 'character.main': return `Made ${character(ent)} the Main character`;
    case 'team_request.create': return `Asked for ${character(after.characterId)} to be put on ${team(after.teamId)}`;
    case 'team_request.withdraw': return `Withdrew the request to put ${character(after.characterId)} on ${team(after.teamId)}`;
    case 'team_request.approve': return `Approved the request to put ${character(after.characterId)} on ${team(after.teamId)}`;
    case 'team_request.reject': return `Rejected the request to put ${character(after.characterId)} on ${team(after.teamId)}`;
    case 'character.place': return `Put the character ${character(ent)} on ${team(after.teamId)}`;
    case 'character.release': return `Took the character ${character(ent)} off ${team(before.teamId)}${after.removeSignups ? ' and removed it from the upcoming raids' : ''}`;
    case 'character.move': return `Moved the character ${character(ent)} from ${team(before.teamId)} to ${team(after.teamId)}${after.removeSignups ? ' and removed it from the upcoming raids of the old team' : ''}`;
    case 'roster.import': {
      const source = SOURCE_LABEL[after.source] || 'a list';
      return `Imported ${plural(Number(after.people) || 0, 'person', 'people')} and ${plural(Number(after.characters) || 0, 'character', 'characters')} from ${source} into ${team(ent)}`;
    }

    case 'raid.create': return `Created ${onRaid(ent)}`;
    case 'raid.delete': return `Deleted the raid on ${dayLabel(before.raidOn)}${before.teamId ? ` (${team(before.teamId)})` : ''}`;
    case 'raid.event': {
      if (after.event === false) return `Removed the Raid-Helper event from ${onRaid(ent)}`;
      const moved = after.raidOn ? ` and moved the raid to ${dayLabel(after.raidOn)}` : '';
      return `${before.event === true ? 'Refreshed' : 'Linked'} the Raid-Helper event of ${onRaid(ent)}${moved}`;
    }
    case 'raid.report':
      if (after.removed) return `Removed a Warcraft Logs report from ${onRaid(ent)}`;
      return before.refreshed ? `Refreshed a Warcraft Logs report on ${onRaid(ent)}` : `Added a Warcraft Logs report to ${onRaid(ent)}`;
    case 'raid.plan':
      if (after.plan === false) return `Removed the plan from ${onRaid(ent)}`;
      return `Attached a plan of ${plural(Number(after.players) || 0, 'player', 'players')} to ${onRaid(ent)}`;
    case 'raid.plan_edit': return `Edited the plan of ${onRaid(ent)}: ${plural(Number(after.players) || 0, 'player', 'players')} seated`;
    case 'raid.manual':
      if (after.manual === false) return `Went back from hand-entered attendance on ${onRaid(ent)}`;
      if (after.paste) return `Entered attendance from a pasted roster for ${onRaid(ent)}: ${Number(after.present) || 0} attended, ${plural(Number(after.unmatched) || 0, 'name', 'names')} to review`;
      return `Entered attendance by hand for ${onRaid(ent)}: ${Number(after.present) || 0} attended`;
    case 'duties.set': {
      const count = Array.isArray(after.duties) ? after.duties.length : 0;
      return count ? `Set ${plural(count, 'duty', 'duties')} for ${onRaid(ent)}` : `Cleared the duties of ${onRaid(ent)}`;
    }
    case 'join.create': return `Made a guest sign-up link for ${onRaid(ent)}`;
    case 'join.revoke': return `Turned off a guest sign-up link of ${onRaid(ent)}`;
    case 'signup.guest_resolve': return `Added ${after.name || 'a character'} as a Guest / Pug on ${onRaid(ent)}`;
    case 'signup.guest': return `A guest signed up for ${onRaid(ent)}${after.class ? ` (${CLASS_LABEL[after.class] || after.class})` : ''}`;
    case 'signup.guest_remove': return `Removed a guest sign-up from ${onRaid(ent)}`;
    case 'signup.guests_clear': return `Removed every guest sign-up from ${onRaid(ent)}`;
    case 'signup.open': return `Signed up as a guest for ${onRaid(ent)}${after.class ? ` (${CLASS_LABEL[after.class] || after.class})` : ''}`;
    case 'signup.open_withdraw': return `Withdrew their guest sign-up from ${onRaid(ent)}`;
    case 'launch.update': return `Updated the launch status of ${person(ent)}${after.teamId ? ` on ${team(after.teamId)}` : ''}`;
    case 'attention.dismiss': return attentionSentence(after, false, { person, team, onRaid });
    case 'attention.restore': return attentionSentence(before, true, { person, team, onRaid });
    case 'launch.team': return`${after.launchTeam ? 'Turned on' : 'Turned off'} the Launch funnel for ${team(ent)}`;
    case 'raid.settings': {
      const parts = [];
      if (after.size !== undefined && after.size !== before.size) parts.push(`raid size ${after.size === null ? 'automatic' : after.size}`);
      if (after.signupCloseHours !== undefined && after.signupCloseHours !== before.signupCloseHours) {
        parts.push(after.signupCloseHours === null ? 'sign-up deadline back to the team default' : `sign-ups close ${plural(after.signupCloseHours, 'hour', 'hours')} before the start`);
      }
      return `Changed the settings of ${onRaid(ent)}${parts.length ? `: ${list(parts)}` : ''}`;
    }
    case 'schedule.update': return `Changed the weekly raid schedule of ${team(ent)}`;
    case 'schedule.fill': {
      const dates = Array.isArray(after.dates) ? after.dates.length : 0;
      return `Created ${plural(dates, 'upcoming raid', 'upcoming raids')} for ${team(ent)} from its schedule`;
    }

    case 'attendance.decide': {
      const outcome = OUTCOMES[after.outcome] ? OUTCOMES[after.outcome].label : String(after.outcome || '');
      return `Decided the attendance of ${person(after.playerId)} on ${raidOn(ent)}: ${outcome}`;
    }
    case 'attendance.undo': return `Undid the decision for ${person(before.playerId)} on ${raidOn(ent)}`;
    case 'attendance.guest': return `Marked a log name as a guest on ${raidOn(ent)}`;
    case 'attendance.link': return `Linked a log name on ${raidOn(ent)} to ${person(after.personId)}`;
    case 'policy.update': {
      const keys = Array.isArray(after.changed) ? after.changed : [];
      return `Changed the attendance policy of ${scopeText(after.scope)}${keys.length ? `: ${list(keys)}` : ''}`;
    }
    case 'wcl.settings': return 'Changed the Warcraft Logs settings';

    case 'loot.import': {
      const total = (Number(after.inserted) || 0) + (Number(after.updated) || 0);
      return total ? `Imported ${plural(total, 'loot award', 'loot awards')} to ${raidOn(ent)}` : `Imported loot to ${raidOn(ent)}: nothing new`;
    }
    case 'loot.update': {
      const item = get('award', ent, 'a loot award');
      const changed = Array.isArray(after.changed) ? after.changed : [];
      const parts = [];
      if (changed.includes('winner')) parts.push(`Winner changed from ${before.winnerName || 'disenchanted'} to ${after.winnerName || 'disenchanted'}`);
      if (changed.includes('item')) {
        const itemText = (id, name) => name || (id ? `item ${id}` : 'an item');
        parts.push(`Item changed from ${itemText(before.itemId, before.itemName)} to ${itemText(after.itemId, after.itemName)}`);
      }
      if (changed.includes('raid')) parts.push(`Moved from ${onRaid(before.raidId)} to ${onRaid(after.raidId)}`);
      if (parts.length) {
        if (after.tag && after.tag !== before.tag) parts.push(`tag changed from ${before.tag} to ${after.tag}`);
        return `${parts.join('; ')} (${item})`;
      }
      if (after.tag && after.tag !== before.tag) return `Tagged ${item} as ${after.tag}`;
      return `Edited ${item}`;
    }
    case 'loot.delete': return `Deleted ${get('award', ent, before.itemId ? `a loot award (item ${before.itemId})` : 'a loot award')}`;
    case 'loot.list': {
      const what = after.source === 'softres' ? 'soft-reserves' : 'TMB loot prios';
      return Number(after.rows) > 0
        ? `Pasted the ${what} for ${onRaid(ent)} (${plural(Number(after.rows), 'row', 'rows')} for ${plural(Number(after.items) || 0, 'item', 'items')})`
        : `Cleared the ${what} of ${onRaid(ent)}`;
    }
    case 'loot.add': return `Added ${get('award', ent, after.itemId ? `a loot award (item ${after.itemId})` : 'a loot award')} by hand to ${onRaid(after.raidId)}`;
    case 'loot.policy': {
      const keys = Array.isArray(after.changed) ? after.changed : [];
      return `Changed the loot policy of ${scopeText(after.scope)}${keys.length ? `: ${list(keys)}` : ''}`;
    }

    case 'signup.set': return `Signed ${person(after.personId)} up as ${KIND_LABEL[after.kind] || after.kind} on ${raidOn(ent)}`;
    case 'signup.link': return `Linked the Raid-Helper sign-up "${after.nickname || 'unknown'}" to ${person(after.personId)} on ${raidOn(ent)}`;
    case 'signup.remove': return `Removed the sign-up of ${person(before.personId)} from ${raidOn(ent)}`;
    case 'away.set': return `${before.kind === undefined ? 'Added' : 'Changed'} a notice for ${person(after.personId)} (${AWAY_LABEL[after.kind] || after.kind})`;
    case 'away.remove': return `Removed a notice of ${person(before.personId)} (${AWAY_LABEL[before.kind] || before.kind})`;
    case 'roster.publish': return `Published the line-up of ${onRaid(ent)} (${plural(Number(after.players) || 0, 'player', 'players')})`;
    case 'roster.unpublish': return `Took back the published line-up of ${onRaid(ent)}`;
    case 'roster.decline': return `${person(after.personId)} can't come to ${onRaid(ent)}`;
    case 'signup.lock': return after.locked ? `Closed sign-ups for ${onRaid(ent)}` : `Reopened sign-ups for ${onRaid(ent)}`;

    case 'intent.open': return `Opened a spec poll for ${team(after.teamId)}`;
    case 'intent.close': return `Closed the spec poll of ${team(after.teamId)}`;
    case 'intent.pick': {
      const planned = [CLASS_LABEL[after.class], after.spec].filter(Boolean).join(' ');
      return `${person(after.personId)} picked ${after.kind === 'alt' ? 'an alt' : 'a main'} for the spec poll of ${team(after.teamId)}${planned ? `: ${planned}` : ''}`;
    }
    case 'intent.unpick': return `Removed the ${after.kind === 'alt' ? 'alt' : 'main'} pick of ${person(after.personId)} from the spec poll of ${team(after.teamId)}`;
    case 'recruiting.targets': return `${after.custom ? 'Set' : 'Reset'} the recruiting targets of ${team(ent)}`;
    case 'apply.settings': {
      if (!after.enabled) return before.enabled ? 'Turned applications off' : 'Changed the application questions';
      return before.enabled ? 'Changed the application questions' : 'Turned applications on';
    }
    case 'application.submit': return `Received an application for ${team(after.teamId)}`;
    case 'application.update': {
      const changed = Array.isArray(after.changed) ? after.changed : [];
      const status = APPLICATION_STATUS_LABEL[after.status];
      if (changed.includes('status') && status) return `Marked an application for ${team(after.teamId)} as ${status}`;
      return `Edited the notes of an application for ${team(after.teamId)}`;
    }
    case 'application.accept': return `Accepted an application: ${person(after.personId)} joined ${team(after.teamId)} on trial`;
    case 'application.delete': return `Deleted an application for ${team(before.teamId)}`;

    case 'notify.update': {
      const changed = [...new Set((Array.isArray(after.changed) ? after.changed : []).map((key) => NOTIFY_LABEL[key] || key))];
      return `Changed the Discord notifications of ${team(after.teamId || ent)}${changed.length ? `: ${list(changed)}` : ''}`;
    }
    case 'notify.test': return `Sent a test post to the Discord webhook of ${team(after.teamId || ent)}: ${after.result === 'sent' ? 'it arrived' : after.result === 'disabled' ? 'Discord refused it and the webhook was turned off' : 'it did not arrive'}`;
    case 'notify.disabled': return `Turned off the Discord webhook of ${team(after.teamId || ent)}: Discord answered ${Number(after.status) || 'with an error'}`;

    case 'bnet.link': return 'Linked a Battle.net account';
    case 'bnet.unlink': return 'Disconnected a Battle.net account';
    case 'discord.link': return 'Linked a Discord account';
    case 'discord.unlink': return 'Disconnected a Discord account';
    case 'bnet.settings': return 'Changed the Battle.net settings';
    case 'rank_map.update': {
      const moved = Number(after.charactersChanged) || 0;
      return `Changed the in-game rank map (${Number(after.mapChanges) || 0} ${Number(after.mapChanges) === 1 ? 'rank' : 'ranks'} edited, ${moved} ${moved === 1 ? 'character' : 'characters'} moved)`;
    }
    // A join keeps the loser's id in the log: its name is the survivor's (the loser's characters moved there), so the sentence names the loser by its characters.
    case 'person.join': {
      const moved = (Array.isArray(before.characterIds) ? before.characterIds : []).map((id) => get('character', id, null)).filter(Boolean);
      return `Joined ${moved.length ? `the person with ${list(moved)}` : 'a person'} into ${person(after.personId || ent)}${after.via === 'bnet' ? ' (proved by Battle.net)' : ''}`;
    }
    case 'character.match_roster':
      return `Matched ${character(ent)} to its place on the in-game roster${after.renamed ? ' and took its name' : ''}`;
    case 'person.match_create': return `Added ${person(ent)} to the roster from the characters of a Battle.net account that are on the in-game roster`;
    case 'person.match_link': return `Linked a Battle.net account to ${person(ent)} because its characters are on the in-game roster`;
    case 'character.proof_supersede':
      return `The Battle.net proof of ${character(ent)} passed to ${get('user', after.userId, null) ? `the account ${user(after.userId)}` : 'another account'}, which proved it more recently`;
    // The old person is named by what it still has; a person left with nothing is named by its retired placeholder (the name the moved character had).
    case 'character.rehome': {
      const why = after.reason === 'bnet_beats_link' ? ', because the Battle.net account that owns it proved it'
        : after.reason === 'collision' ? ', because the Battle.net account that owns it signed in with the same name' : after.reason === 'gm_claim' ? ', by the Guild Master\'s claim' : '';
      return `Moved ${character(ent)} from ${person(before.personId)} to ${person(after.personId)}${why}`;
    }
    case 'character.name_retire': return `${character(ent)} is now Former: its name belongs to the character on the in-game roster that signed in with it`;
    case 'character.claim': return after.outcome === 'link_person'
      ? `Linked their account to ${person(after.personId)} through ${character(ent)}`
      : `Added ${character(ent)} to their own record${after.source === 'hand' ? ' by hand' : ' from Battle.net'}`;
    case 'claim.create': return `Claimed ${get('claim', ent, 'a character')}`;
    case 'claim.withdraw': return 'Withdrew a character claim';
    case 'claim.approve': return `Approved the claim for ${get('claim', ent, 'a character')}`;
    case 'claim.reject': return after.superseded
      ? `Closed the typed claim for ${get('claim', ent, 'a character')}: the character's Battle.net owner claimed it`
      : `Rejected the claim for ${get('claim', ent, 'a character')}`;
    default: return String(row.action || 'Unknown action');
  }
}

// ---------------------------------------------------------------------------
// CSV

const CSV_COLUMNS = ['When', 'Who', 'What', 'Type', 'Action', 'Before', 'After'];
const FORMULA_START = /^[=+\-@\t\r]/;

// One CSV field: quoted when it holds a comma, quote or line break; a field a spreadsheet would run as a formula gets a leading apostrophe.
export function csvField(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// 'YYYY-MM-DD HH:MM' of an instant in a time zone.
export function whenLabel(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms));
    const pick = (type) => parts.find((part) => part.type === type).value;
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

// rows: the route's row objects ({ at, actor: { displayName } | null, text, group, action, before, after }). A BOM leads so Excel reads UTF-8.
export function auditCsv(rows, timeZone) {
  const lines = [CSV_COLUMNS.map(csvField).join(',')];
  for (const row of rows) {
    lines.push([
      whenLabel(row.at, timeZone), row.actor ? row.actor.displayName : 'Former member', row.text, GROUP_LABEL[row.group] || row.group, row.action,
      row.before ? JSON.stringify(row.before) : '', row.after ? JSON.stringify(row.after) : '',
    ].map(csvField).join(','));
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}
const GROUP_LABEL = Object.fromEntries(AUDIT_GROUPS.map((group) => [group.id, group.label]));

// The first and last instant of a guild-local date range, as [fromMs | null, toMsExclusive | null]; the caller supplies the converter
// (attendance-calendar.js localTimeToMs) so this module stays free of time-zone state.
export function rangeMs(from, to, timeZone, localTimeToMs) {
  const startOf = (date) => localTimeToMs(date, '00:00', timeZone) ?? localTimeToMs(date, '01:00', timeZone);
  return [from ? startOf(from) : null, to ? startOf(addDays(to, 1)) : null];
}
