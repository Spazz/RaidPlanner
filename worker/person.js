import { avatarUrl } from './discord.js';

function initialsOf(name) {
  const words = Array.from(name.trim()).length ? name.trim().split(/[\s._-]+/).filter(Boolean) : [];
  if (!words.length) return '?';
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

// { id, username, displayName, avatarUrl | null, initials }. The Discord ID appears only inside avatarUrl, and the Discord handle only as `username`: both are OPT-IN (lane B6b part 3b),
// so a caller that forgets to say who is reading shows the display name and initials and nothing else. Callers other than worker/redact.js and the sign-in's own account
// (personFromSession) go through worker/redact.js personFor, which opts in by the viewer's tier (a CI test pins that).
// { avatar: true } adds avatarUrl; { handle: true } adds the Discord username (else it is '').
// displayName: the name the account chose, else its Discord global name, else its username (a Battle.net account's username is its BattleTag without the number): that is the name the
// account shows, so a handle can be the displayName of an account with neither of the other two. A row from users must carry display_name; an account without Discord has discord_id NULL
// and so no avatar.
export function toPerson(row, { avatar = false, handle = false } = {}) {
  const displayName = row.display_name || row.global_name || row.username;
  return {
    id: row.id,
    username: handle ? row.username : '',
    displayName,
    avatarUrl: avatar ? avatarUrl(row.discord_id, row.avatar) : null,
    initials: initialsOf(displayName),
  };
}

// The signed-in account as its own owner sees it (GET /auth/me, the account menu): its own avatar and handle.
export function personFromSession(user) {
  return toPerson({
    id: user.id, discord_id: user.discordId, username: user.username, global_name: user.globalName, display_name: user.displayName, avatar: user.avatar,
  }, { avatar: true, handle: true });
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
