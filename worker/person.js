import { avatarUrl } from './discord.js';

function initialsOf(name) {
  const words = Array.from(name.trim()).length ? name.trim().split(/[\s._-]+/).filter(Boolean) : [];
  if (!words.length) return '?';
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

// { id, username, displayName, avatarUrl | null, initials }. The Discord ID appears only inside avatarUrl (members of one Discord server already see each other's IDs).
// { avatar: false } returns avatarUrl null (initials only) for viewers who must not learn the Discord ID the URL carries.
export function toPerson(row, { avatar = true } = {}) {
  const displayName = row.global_name || row.username;
  return {
    id: row.id,
    username: row.username,
    displayName,
    avatarUrl: avatar === false ? null : avatarUrl(row.discord_id, row.avatar),
    initials: initialsOf(displayName),
  };
}

export function personFromSession(user) {
  return toPerson({ id: user.id, discord_id: user.discordId, username: user.username, global_name: user.globalName, avatar: user.avatar });
}

// planSidebarCollapsed: the sidebar while a plan is open in the planner (collapsed unless the person chose otherwise).
const DEFAULT_PREFS = { sidebarCollapsed: false, planSidebarCollapsed: true, lastGuildId: null };

export function parsePrefs(raw) {
  let stored = {};
  try { stored = JSON.parse(raw); } catch { stored = {}; }
  if (!stored || typeof stored !== 'object') stored = {};
  return {
    sidebarCollapsed: stored.sidebarCollapsed === true,
    planSidebarCollapsed: stored.planSidebarCollapsed !== false,
    lastGuildId: typeof stored.lastGuildId === 'string' ? stored.lastGuildId : DEFAULT_PREFS.lastGuildId,
  };
}
