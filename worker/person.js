import { avatarUrl } from './discord.js';

function initialsOf(name) {
  const words = Array.from(name.trim()).length ? name.trim().split(/[\s._-]+/).filter(Boolean) : [];
  if (!words.length) return '?';
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

// { id, username, displayName, avatarUrl | null, initials }. The Discord ID never leaves the server.
export function toPerson(row) {
  const displayName = row.global_name || row.username;
  return {
    id: row.id,
    username: row.username,
    displayName,
    avatarUrl: avatarUrl(row.discord_id, row.avatar),
    initials: initialsOf(displayName),
  };
}

export function personFromSession(user) {
  return toPerson({ id: user.id, discord_id: user.discordId, username: user.username, global_name: user.globalName, avatar: user.avatar });
}

const DEFAULT_PREFS = { sidebarCollapsed: false, lastGuildId: null };

export function parsePrefs(raw) {
  let stored = {};
  try { stored = JSON.parse(raw); } catch { stored = {}; }
  if (!stored || typeof stored !== 'object') stored = {};
  return {
    sidebarCollapsed: stored.sidebarCollapsed === true,
    lastGuildId: typeof stored.lastGuildId === 'string' ? stored.lastGuildId : DEFAULT_PREFS.lastGuildId,
  };
}
