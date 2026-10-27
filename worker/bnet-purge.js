// The 30-day rule for Battle.net data (Blizzard's API terms): a daily Cron Trigger deletes what has not been refreshed in time.
//   - a member's character snapshot (the characters Battle.net listed for them);
//   - claims that were never decided (they carry Battle.net character data), and decided ones 30 days after the decision.
// The link itself stays: the Battle.net account number and BattleTag are the account's SIGN-IN identity, refreshed at every Battle.net sign-in or
// link and kept while it is linked (disconnecting, or Delete my data, removes it at once). Deleting the row would sign the person out of the
// only identity some accounts have.
// A roster person or character an approved claim created is the guild's own record (like a Warcraft Logs import) and stays.
// guild_roster (the guild's synced in-game roster, worker/roster-sync.js) is the guild's public roster data, not a member's Battle.net snapshot: it is kept
// while the guild lives and replaced by each changed good sync, so nothing here touches it (a test pins that).
import { DATA_TTL_MS } from './bnet-store.js';
import { directRows, directRowsStatement } from './d1-changes.js';

// -> { snapshots, pendingClaims, decidedClaims } (rows changed or deleted: the statement's own rows, read with changes(), not meta.changes, which also counts cascades and triggers)
export async function purgeExpiredBnetData(db, nowMs) {
  const cutoff = nowMs - DATA_TTL_MS;
  const results = await db.batch([
    // snapshot_at stays: it is when the characters were last loaded, which the Linked accounts page still says.
    db.prepare("UPDATE bnet_links SET snapshot = '{}' WHERE snapshot_at <= ? AND snapshot != '{}'").bind(cutoff),
    directRowsStatement(db),
    db.prepare("DELETE FROM character_claims WHERE status = 'pending' AND created_at <= ?").bind(cutoff),
    directRowsStatement(db),
    db.prepare("DELETE FROM character_claims WHERE status != 'pending' AND decided_at <= ?").bind(cutoff),
    directRowsStatement(db),
  ]);
  return { snapshots: directRows(results[1]), pendingClaims: directRows(results[3]), decidedClaims: directRows(results[5]) };
}

// The Worker's `scheduled` handler body. Never throws (a failed run is logged and the next day's run tries again).
export async function runScheduled({ db, now, log }) {
  try {
    const purged = await purgeExpiredBnetData(db, now());
    log(`bnet purge: ${purged.snapshots} snapshots, ${purged.pendingClaims + purged.decidedClaims} claims`);
    return purged;
  } catch (error) {
    try { log(`bnet purge failed: ${error && error.message}`); } catch { /* logging must not throw */ }
    return null;
  }
}
