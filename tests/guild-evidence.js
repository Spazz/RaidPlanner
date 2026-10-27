// Rows written straight into the tables of a guild fixture (the writers are other lanes' business): raids, loot, log presence, sign-ups, applications, blocks. Shared by the Users
// suite (tests/guild/guild-b7b-users-tests.js) and the sentinel world (tests/guild-sentinels.js). `s` is a scenario (tests/guild-b3-world.js) with s.alpha = its first team.
const sql = (s) => s.w.db.sqlite;
const exec = (s, text, ...values) => sql(s).prepare(text).run(...values);
const rowsOf = (s, text, ...values) => sql(s).prepare(text).all(...values).map((row) => ({ ...row }));
let seq = 0;
const pad = (n, width = 18) => String(n).padStart(width, '0');

function addRaid(s, on, team = s.alpha) {
  const id = `r_Fix${pad(++seq)}`;
  exec(s, 'INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)', id, s.gid, team, on, Date.parse(`${on}T20:00:00Z`), `Raid ${on}`);
  return id;
}
function addLoot(s, raidId, name, team = s.alpha) {
  const n = ++seq;
  exec(s, `INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key, winner_class, tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 30001, 'Fixture Blade', 5, ?, ?, 'Nightslayer', 'nightslayer', 'WARRIOR', 'MS', 1, 1)`, `lo_Fix${pad(n)}`, s.gid, raidId, team, `fix${pad(n, 8)}`, name, name.toLowerCase());
}
function addPresence(s, raidId, name) {
  const n = ++seq;
  const code = `Rpt${pad(n, 13)}`;
  exec(s, "INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES (?, ?, ?, 'classic', 1, 2, 'Uploader', 3)", raidId, s.gid, code);
  exec(s, "INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, 1, 100, 'Boss', 1, 1, 2)", 5000 + n, raidId, code);
  exec(s, "INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'ROGUE')", 5000 + n, raidId, s.gid, name, name.toLowerCase());
}
function addSignup(s, raidId, { source = 'raidsmith', nickname = null, playerId = null, guest = 0, guestUserId = null, discordId = null, kind = 'signed' }) {
  exec(s, `INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, position, guild_id, player_id, guest, guest_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, 1)`, raidId, source, ++seq, discordId, nickname, kind, s.gid, playerId, guest, guestUserId);
}
function addApplication(s, { name, userId = null, at = 1_790_000_000_000, team = s.alpha }) {
  exec(s, `INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, realm, realm_key, class, user_id, created_at, updated_at)
    VALUES (?, ?, ?, 'new', ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', ?, ?, 1)`, `am_Fix${pad(++seq)}`, s.gid, team, name, name.toLowerCase(), userId, at);
}
const addManual = (s, raidId, name) => exec(s, "INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key) VALUES (?, ?, ?, ?, 'Nightslayer', 'nightslayer')", raidId, s.gid, name, name.toLowerCase());
const markGuest = (s, name) => exec(s, "INSERT INTO attendance_guests (guild_id, name_key, realm_key, name, created_at) VALUES (?, ?, 'nightslayer', ?, 1)", s.gid, name.toLowerCase(), name);
const attend = (s, raidId, team, playerId) => exec(s, "INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, attended) VALUES (?, ?, ?, ?, 'present', 1)", raidId, s.gid, team, playerId);
const leave = (s, characterId, on = '2026-12-01') => exec(s, "UPDATE characters SET left_on = ?, left_reason = 'left', core_rank = 'social' WHERE id = ?", on, characterId);
const pendingBlock = (s, key, at = 1_790_000_000_000) => exec(s, "INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, pending_review) VALUES (?, ?, NULL, 'Matched an earlier block of the same person', ?, 1)", s.gid, s.uids[key], at);

module.exports = { sql, exec, rowsOf, pad, addRaid, addLoot, addPresence, addSignup, addApplication, addManual, markGuest, attend, leave, pendingBlock };
