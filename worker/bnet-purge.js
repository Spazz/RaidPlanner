// The 30-day rule for Battle.net data (Blizzard's API terms): a daily Cron Trigger deletes what has not been refreshed in time.
//   - a member's link (account id, BattleTag and the character snapshot are one fetch, so they expire together);
//   - claims that were never decided (they carry Battle.net character data), and decided ones 30 days after the decision.
// A roster person or character an approved claim created is the guild's own record (like a Warcraft Logs import) and stays.
import { DATA_TTL_MS } from './bnet-store.js';

// -> { links, pendingClaims, decidedClaims } (rows deleted)
export async function purgeExpiredBnetData(db, nowMs) {
  const cutoff = nowMs - DATA_TTL_MS;
  const results = await db.batch([
    db.prepare('DELETE FROM bnet_links WHERE snapshot_at <= ?').bind(cutoff),
    db.prepare("DELETE FROM character_claims WHERE status = 'pending' AND created_at <= ?").bind(cutoff),
    db.prepare("DELETE FROM character_claims WHERE status != 'pending' AND decided_at <= ?").bind(cutoff),
  ]);
  return { links: results[0].meta.changes, pendingClaims: results[1].meta.changes, decidedClaims: results[2].meta.changes };
}

// The Worker's `scheduled` handler body. Never throws (a failed run is logged and the next day's run tries again).
export async function runScheduled({ db, now, log }) {
  try {
    const purged = await purgeExpiredBnetData(db, now());
    log(`bnet purge: ${purged.links} links, ${purged.pendingClaims + purged.decidedClaims} claims`);
    return purged;
  } catch (error) {
    try { log(`bnet purge failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return null;
  }
}
