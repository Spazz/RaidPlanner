// Discord channel posts and reminders, the pure half (no I/O, no clock): the webhook address rules, which messages are due for a raid, the refresh
// cadence of a Raid-Helper event, and the message bodies. worker/notify-store.js sends and records them; worker/scheduler.js decides when to run.
// A message is plain embeds (a title, a short description or fields, a link back to the raid page). It never mentions @everyone or @here: the body
// carries `allowed_mentions`, so only the role an officer typed and the people a reminder names (by their Discord ID) can be pinged at all.
import { apiBase } from './discord.js';
import { HOUR_MS, closesAtOf } from './signup-window.js';

export const NOTIFY_KINDS = ['roster', 'loot', 'remind_24h', 'remind_2h', 'no_reply', 'confirm'];
export const NOREPLY_HOURS = [6, 12, 24, 48];
export const DEFAULT_NOREPLY_HOURS = 24;
export const CONFIRM_HOURS = 6;            // the unconfirmed-roster reminder and its Needs attention count open this long before the raid
export const REMIND_FAR_HOURS = 24;        // "Post upcoming raid reminders": 24 h and 2 h before the start
export const REMIND_NEAR_HOURS = 2;
export const REFRESH_WINDOW_HOURS = 48;    // inside it the event is refreshed every 2 h, before it every 12 h
export const REFRESH_NEAR_MS = 2 * HOUR_MS;
export const REFRESH_FAR_MS = 12 * HOUR_MS;
export const MAX_GUILDS_PER_RUN = 50;
export const MAX_MESSAGES_PER_RUN = 200;
export const MAX_REFRESHES_PER_RUN = 25;
export const RETRY_LIMIT = 3;              // a transient failure is tried again by the next runs until this many attempts
export const LOG_KEEP_DAYS = 90;

// ---------------------------------------------------------------------------
// The webhook address

const WEBHOOK_TAIL = '/api/webhooks/(\\d{17,20})/([A-Za-z0-9_-]{20,100})$';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Discord's own address, or (when DISCORD_API_BASE names a local fake) the fake's: nothing else is ever posted to.
function webhookPattern(env) {
  return new RegExp(`^${escapeRegExp(apiBase(env || {}))}${WEBHOOK_TAIL}`);
}

// -> { ok: true, url } | { ok: false, message }
export function parseWebhookUrl(value, env) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { ok: false, message: 'Paste the webhook address of the Discord channel.' };
  if (!webhookPattern(env).test(text)) {
    return { ok: false, message: 'That is not a Discord webhook address. It looks like https://discord.com/api/webhooks/<number>/<token>.' };
  }
  return { ok: true, url: text };
}

export const isWebhookUrl = (value, env) => typeof value === 'string' && webhookPattern(env).test(value);

// What may be shown of a stored address: only the end of its token.
export function webhookHint(url) {
  const token = typeof url === 'string' ? url.slice(url.lastIndexOf('/') + 1) : '';
  return token ? `.../${token.slice(-4)}` : null;
}

// "<@&123456789012345678>" or the number alone -> { ok: true, value: id | null }; empty clears it. Anything else (@everyone, a user mention) is refused.
export function parseRoleMention(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const text = value.trim();
  if (!text) return { ok: true, value: null };
  const match = /^(?:<@&(\d{17,20})>|(\d{17,20}))$/.exec(text);
  return match ? { ok: true, value: match[1] || match[2] } : { ok: false };
}

// How Discord's answer to a post is treated: 'sent' | 'disable' (404/401/403: the webhook is gone or its token was changed) | 'retry' (a network failure,
// 429 or 5xx: the next run may try again) | 'failed' (anything else: a body Discord refused; never resent).
export function classifyReply(status) {
  if (typeof status !== 'number') return 'retry';
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 401 || status === 403) return 'disable';
  if (status === 429 || status >= 500) return 'retry';
  return 'failed';
}

// ---------------------------------------------------------------------------
// What is due

// raid: { starts_at, time_known, signups_locked, signup_close_hours, team_close_hours, roster_published_at }
// settings: a team_notifications row (post_reminders, post_noreply, noreply_hours, post_confirm) -> kinds in the order they are sent.
// A raid whose time is not set has a placeholder start, so nothing is timed from it. The 24 h reminder is for the window between 24 h and 2 h before; inside
// the last two hours only the 2 h one fires, so a raid made late never gets a stale "tomorrow".
export function dueKinds(raid, settings, now) {
  const kinds = [];
  if (raid.time_known === 0 || raid.starts_at <= now) return kinds;
  const left = raid.starts_at - now;
  if (settings.post_reminders === 1) {
    if (left <= REMIND_NEAR_HOURS * HOUR_MS) kinds.push('remind_2h');
    else if (left <= REMIND_FAR_HOURS * HOUR_MS) kinds.push('remind_24h');
  }
  if (settings.post_noreply === 1 && raid.signups_locked !== 1) {
    const closes = closesAtOf(raid, raid.signup_close_hours ?? raid.team_close_hours ?? 0);
    if (closes > now && now >= closes - settings.noreply_hours * HOUR_MS) kinds.push('no_reply');
  }
  if (settings.post_confirm === 1 && raid.roster_published_at !== null && raid.roster_published_at !== undefined && left <= CONFIRM_HOURS * HOUR_MS) kinds.push('confirm');
  return kinds;
}

// The dedupe key of a scheduled message: one per raid and kind.
export const dedupeKeyOf = (kind, raidId) => `${kind}:${raidId}`;

// Whether a raid's Raid-Helper event is due to be asked about again: every 2 h inside the last 48 h before the start, every 12 h before that. The clock
// of the next ask starts at the later of the last refresh and the last attempt (a failed ask is not repeated every 15 minutes).
// raid: { starts_at, event_synced, event_checked_at }
export function refreshDue(raid, now) {
  if (raid.starts_at <= now) return false;
  const last = Math.max(raid.event_synced ?? 0, raid.event_checked_at ?? 0);
  const every = raid.starts_at - now <= REFRESH_WINDOW_HOURS * HOUR_MS ? REFRESH_NEAR_MS : REFRESH_FAR_MS;
  return now - last >= every;
}

// ---------------------------------------------------------------------------
// Message bodies

const COLOR = 0xd97706;
const EMBED_TITLE_MAX = 256;
const EMBED_DESCRIPTION_MAX = 4000;
const FIELD_VALUE_MAX = 1000;
const FIELD_LIMIT = 24;
const LIST_ROWS_MAX = 60;

const clip = (text, max) => {
  const chars = Array.from(String(text));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 3).join('')}...`;
};

// A name from the roster or a loot import, safe to put in a message: letters, digits, spaces, apostrophes and hyphens.
export const safeName = (value) => clip(String(value === null || value === undefined ? '' : value).replace(/[^\p{L}\p{N} '-]/gu, '').trim(), 40) || 'Unknown';

// Free text an officer typed (a raid title, a team name) in a heading: no mention syntax or markdown can bite, and it is bounded.
const safeText = (value, max) => clip(String(value === null || value === undefined ? '' : value).replace(/[<>@`*_~|\\]/g, '').replace(/\s+/g, ' ').trim(), max);

const epoch = (ms) => Math.floor(ms / 1000);
const stamp = (ms) => `<t:${epoch(ms)}:F> (<t:${epoch(ms)}:R>)`;

// "Gruul's Lair - Alpha": what a raid is called in a heading.
export function raidLabel(raid, teamName) {
  const what = safeText(raid.title || raid.zone || 'Raid', 80) || 'Raid';
  const team = safeText(teamName, 40);
  return team ? `${what} - ${team}` : what;
}

const embedOf = (embed) => ({ color: COLOR, footer: { text: 'Raidsmith' }, ...embed, title: clip(embed.title, EMBED_TITLE_MAX) });

// The body of a webhook POST. users: Discord IDs to ping (each also in the content); roleId: the officer's chosen role or null.
function bodyOf({ content = '', embed, users = [], roleId = null }) {
  const lead = roleId ? [`<@&${roleId}>`] : [];
  const text = [...lead, ...users.map((id) => `<@${id}>`), ...(content ? [content] : [])].join(' ').trim();
  return {
    content: clip(text, 1900),
    embeds: [embedOf(embed)],
    allowed_mentions: { parse: [], users, roles: roleId ? [roleId] : [] },
  };
}

// people: [{ name, discordId | null, optedOut }] -> { users: [ids to ping], names: [shown names] }. A person who opted out (or has no Discord ID) is listed by
// name only.
export function splitPeople(people) {
  const users = [];
  for (const person of people) {
    if (person.discordId && !person.optedOut && /^\d{17,20}$/.test(person.discordId) && !users.includes(person.discordId)) users.push(person.discordId);
  }
  return { users, names: people.map((person) => safeName(person.name)) };
}

const bulletList = (names) => {
  const shown = names.slice(0, LIST_ROWS_MAX).map((name) => `- ${name}`);
  if (names.length > LIST_ROWS_MAX) shown.push(`- and ${names.length - LIST_ROWS_MAX} more`);
  return shown.join('\n');
};

// The "Send a test post" message of Guild settings > Notifications: it names the team, pings nobody (no role, no people) and links nowhere.
export function testBody(teamName) {
  const team = safeText(teamName, 40);
  return bodyOf({
    embed: {
      title: `Test post${team ? `: ${team}` : ''}`,
      description: 'An officer sent this from Raidsmith to check that the webhook works. Nothing else was posted, and nobody was pinged.',
    },
  });
}

// raid: { starts_at, zone, title }; ctx: { teamName, link, roleId, size, counts: { signed, late, tentative, absence } }
export function reminderBody(kind, raid, info) {
  const hours = kind === 'remind_2h' ? REMIND_NEAR_HOURS : REMIND_FAR_HOURS;
  const counts = info.counts || {};
  const fields = [
    { name: 'Starts', value: stamp(raid.starts_at), inline: false },
    { name: 'Signed up', value: `${counts.signed || 0} of ${info.size}${counts.late ? `, ${counts.late} late` : ''}`, inline: true },
  ];
  if (counts.tentative) fields.push({ name: 'Tentative', value: String(counts.tentative), inline: true });
  if (counts.absence) fields.push({ name: "Can't come", value: String(counts.absence), inline: true });
  return bodyOf({
    roleId: info.roleId,
    embed: { title: `Raid in about ${hours} hours: ${raidLabel(raid, info.teamName)}`, url: info.link || undefined, fields },
  });
}

// closesAt: when members can no longer sign up (the start when the team has no deadline)
export function noReplyBody(raid, info) {
  const { users, names } = splitPeople(info.people);
  const deadline = info.closesAt < raid.starts_at ? `Sign-ups close ${stamp(info.closesAt)}.` : `The raid starts ${stamp(raid.starts_at)}.`;
  return bodyOf({
    roleId: info.roleId,
    users,
    embed: {
      title: `Sign up or send word: ${raidLabel(raid, info.teamName)}`,
      url: info.link || undefined,
      description: clip(`${deadline} Please sign up, or add an away notice if you cannot come.\n\nNo answer yet:\n${bulletList(names)}`, EMBED_DESCRIPTION_MAX),
    },
  });
}

export function confirmBody(raid, info) {
  const { users, names } = splitPeople(info.people);
  return bodyOf({
    roleId: info.roleId,
    users,
    embed: {
      title: `Confirm your spot: ${raidLabel(raid, info.teamName)}`,
      url: info.link || undefined,
      description: clip(`The roster is published and the raid starts ${stamp(raid.starts_at)}. Please confirm your seat, or say you cannot make it.\n\nNot confirmed yet:\n${bulletList(names)}`, EMBED_DESCRIPTION_MAX),
    },
  });
}

// seats: [{ name, group (0 = bench), className, spec }] in roster order.
export function rosterBody(raid, info) {
  const groups = new Map();
  for (const seat of info.seats) {
    if (!groups.has(seat.group)) groups.set(seat.group, []);
    groups.get(seat.group).push(seat);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 0) - (b === 0) || a - b);
  const fields = order.slice(0, FIELD_LIMIT).map((group) => ({
    name: group === 0 ? 'Bench' : `Group ${group}`,
    value: clip(groups.get(group).map((seat) => safeName(seat.name)).join(', '), FIELD_VALUE_MAX),
    inline: false,
  }));
  return bodyOf({
    roleId: info.roleId,
    embed: {
      title: `Roster published: ${raidLabel(raid, info.teamName)}`,
      url: info.link || undefined,
      description: `${info.seats.length} ${info.seats.length === 1 ? 'player' : 'players'}. The raid starts ${stamp(raid.starts_at)}. Open the raid page to confirm your seat.`,
      fields,
    },
  });
}

// awards: [{ itemName, winnerName | null, tag | null }] (a disenchanted item has no winner)
export function lootBody(raid, info) {
  const lines = info.awards.slice(0, LIST_ROWS_MAX).map((award) => {
    const who = award.winnerName ? safeName(award.winnerName) : 'Disenchanted';
    return `- ${safeText(award.itemName, 80) || 'An item'}: ${who}${award.tag ? ` (${safeText(award.tag, 8)})` : ''}`;
  });
  if (info.awards.length > LIST_ROWS_MAX) lines.push(`- and ${info.awards.length - LIST_ROWS_MAX} more`);
  return bodyOf({
    roleId: info.roleId,
    embed: {
      title: `Loot imported: ${raidLabel(raid, info.teamName)}`,
      url: info.link || undefined,
      description: clip(lines.join('\n'), EMBED_DESCRIPTION_MAX),
    },
  });
}

// The page a message links to: the raid's page in the app. origin is the site's own (the Discord redirect address's), or null when unknown.
export function raidLink(origin, guildId, raidId) {
  return typeof origin === 'string' && origin ? `${origin}/#/g/${guildId}/raids/r/${raidId}` : null;
}
