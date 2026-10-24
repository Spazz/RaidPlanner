import { nameKey, realmKey } from './roster-data.js';

// Existing explicit guild-wide guest decisions remain global. Sign-up guests belong only to their raid.
// Read identity from existing records so previously added guests work without re-entering them.
export function guestIdentityStatement(db, guildId) {
  return db.prepare(`SELECT NULL AS raid_id, name_key, realm_key FROM attendance_guests WHERE guild_id = ?1
    UNION ALL SELECT s.raid_id, s.nickname AS name_key,
      CASE WHEN g.realm_kind = 'ruleset' THEN '' ELSE g.realm END AS realm_key
    FROM raid_signups s JOIN guilds g ON g.id = s.guild_id
    WHERE s.guild_id = ?1 AND s.source = 'raidsmith' AND s.guest = 1`).bind(guildId);
}

export function guestKeysFor(rows, raidId) {
  return new Set(rows.filter(row => row.raid_id == null || row.raid_id === raidId)
    .map(row => `${nameKey(row.name_key)}|${realmKey(row.realm_key || '')}`));
}
