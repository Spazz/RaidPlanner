// What the previous Owner left live (user-hierarchy build, lane B6b part 2b; U R6-Q1, U R7-Q1). After the in-game Guild Master claims the Owner seat (worker/gm-claim.js) nothing
// the previous Owner set up is undone: stored role assignments, the permission each in-game rank gives, and hand-links (an officer's link of an account to a person, a character an
// officer or a hand typed in rather than Battle.net proved) all stay live. The NEW Owner reviews them here, and the bearer artifacts (API keys, guest links, raid join links, team
// webhooks) belong to the guild, are never rotated by a claim and are revoked by the new Owner in Settings.
//   GET /api/guild/:gid/claim-review      Owner only (403 otherwise; a dev View-as never passes)
// -> {
//   claim:   { id, at, by: { id, name } | null, previousOwner: { id, name } | null, previousWasSuspended, publicUnpublished } | null   the latest Guild Master claim, null when there is none
//   roles:   [{ id, userId, name, roleId, roleName, teamId, teamName, source, assignedBy: { id, name } | null, assignedAt }]   every stored role assignment (Officer, Team Lead, custom roles),
//            oldest first; assignedBy is null when the account that made it is gone
//   rankMap: { rows: [{ rank, label, coreRank, roleId, roleName }], setBy: null, setAt: null }   the permission each in-game rank gives; the table records who set it and when NOWHERE
//            (the Activity log has rank_map.update rows), so setBy / setAt are null
//   handLinks: { persons: [{ personId, userId, accountName, mainName }], characters: [{ id, name, class, personId, proof }], truncated, setBy: null, setAt: null }
//            persons linked to an account that holds no character of theirs proved by Battle.net, and characters whose proof is an officer's or a hand (owner_proof 'officer' | 'hand');
//            the schema records who linked or typed them nowhere (Activity has person.account_link / character.* rows); at most 300 of each, truncated says there are more
//   bearer:  { name: 'settings', tab: 'links', apiKeys, guestLinks, joinLinks, webhooks }   how many of each is live now; the tab is the Links and keys page, which lists API keys, guest
//            links and raid join links (webhooks are on 'notifications')
// }
import { jsonResponse } from '../http.js';
import { visibleCharacterSql } from '../character-visibility.js';
import { requireOwner } from '../owner.js';
import { loadGuildContext } from '../permissions.js';

// The lists hold at most LIST_CAP rows; the statements read one more (LIMIT 301) to tell whether there are more.
const LIST_CAP = 300;

const nameOf = (row, prefix = '') => row[`${prefix}display_name`] || row[`${prefix}global_name`] || row[`${prefix}username`] || null;
const userRef = (id, row, prefix = '') => (id ? { id, name: nameOf(row, prefix) } : null);
const parse = (text) => { try { return JSON.parse(text) || {}; } catch { return {}; } };

export async function getClaimReview(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  await requireOwner(db, guildContext, 'Only the Owner of the guild can review a claim.');
  const guildId = guildContext.guild.id;
  const [claimResult, roleResult, mapResult, personResult, characterResult, bearerResult] = await db.batch([
    // The latest claim: the literal action is what the partial index of migration 0037 serves. A pre-flip claim (the Discord server administrator's) is not a Guild Master claim.
    db.prepare(
      `SELECT c.id, c.actor_user_id, c.created_at, c.before, c.after, a.username AS a_username, a.global_name AS a_global_name, a.display_name AS a_display_name,
              p.username AS p_username, p.global_name AS p_global_name, p.display_name AS p_display_name
         FROM audit_log c LEFT JOIN users a ON a.id = c.actor_user_id LEFT JOIN users p ON p.id = json_extract(c.before, '$.guildMasterUserId')
        WHERE c.guild_id = ? AND c.action = 'guild.claim' AND json_extract(c.after, '$.via') = 'gm_claim' ORDER BY c.created_at DESC, c.id DESC LIMIT 1`,
    ).bind(guildId),
    // Read-only listing of the stored rows with who assigned them (assigned_by is not in the effective-roles view, which is for decisions).
    db.prepare(
      `SELECT ra.id, ra.user_id, ra.role_id, r.name AS role_name, ra.team_id, t.name AS team_name, ra.source, ra.assigned_by, ra.assigned_at,
              u.username, u.global_name, u.display_name, b.username AS b_username, b.global_name AS b_global_name, b.display_name AS b_display_name
         FROM role_assignments ra JOIN roles r ON r.id = ra.role_id JOIN users u ON u.id = ra.user_id
         LEFT JOIN teams t ON t.id = ra.team_id AND t.guild_id = ra.guild_id LEFT JOIN users b ON b.id = ra.assigned_by
        WHERE ra.guild_id = ? AND ra.role_id <> 'guild_master' ORDER BY ra.assigned_at, ra.id LIMIT 301`,
    ).bind(guildId),
    db.prepare(
      `SELECT m.source_key, m.label, m.core_rank, m.role_id, r.name AS role_name FROM source_rank_maps m LEFT JOIN roles r ON r.id = m.role_id
        WHERE m.guild_id = ? AND m.source = 'ingame' ORDER BY CAST(m.source_key AS INTEGER)`,
    ).bind(guildId),
    db.prepare(
      `SELECT p.id, p.user_id, u.username, u.global_name, u.display_name, m.name AS main_name
         FROM players p JOIN users u ON u.id = p.user_id LEFT JOIN characters m ON m.player_id = p.id AND m.is_main = 1 AND ${visibleCharacterSql('m')}
        WHERE p.guild_id = ? AND p.user_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM characters b WHERE b.player_id = p.id AND b.owner_proof = 'bnet' AND b.proof_user_id = p.user_id)
        ORDER BY p.created_at, p.id LIMIT 301`,
    ).bind(guildId),
    db.prepare(
      `SELECT c.id, c.name, c.class, c.player_id, c.owner_proof FROM characters c
        WHERE c.guild_id = ? AND c.owner_proof IN ('officer', 'hand') AND ${visibleCharacterSql('c')} ORDER BY c.name_key, c.id LIMIT 301`,
    ).bind(guildId),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM api_keys WHERE guild_id = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)) AS api_keys,
              (SELECT COUNT(*) FROM guest_links WHERE guild_id = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)) AS guest_links,
              (SELECT COUNT(*) FROM raid_join_links WHERE guild_id = ?1 AND revoked_at IS NULL AND uses < max_uses) AS join_links,
              (SELECT COUNT(*) FROM team_notifications WHERE guild_id = ?1 AND webhook_url IS NOT NULL AND webhook_state = 'ok') AS webhooks`,
    ).bind(guildId, ctx.now()),
  ]);

  const claimRow = claimResult.results[0];
  const claim = claimRow ? (() => {
    const before = parse(claimRow.before);
    const after = parse(claimRow.after);
    return {
      id: claimRow.id,
      at: claimRow.created_at,
      by: userRef(claimRow.actor_user_id, claimRow, 'a_'),
      previousOwner: userRef(before.guildMasterUserId || null, claimRow, 'p_'),
      previousWasSuspended: before.suspended === true,
      publicUnpublished: after.unpublished === true,
    };
  })() : null;
  const roles = roleResult.results.slice(0, LIST_CAP).map((row) => ({
    id: row.id, userId: row.user_id, name: nameOf(row), roleId: row.role_id, roleName: row.role_name, teamId: row.team_id, teamName: row.team_name, source: row.source,
    assignedBy: userRef(row.assigned_by, row, 'b_'), assignedAt: row.assigned_at,
  }));
  const persons = personResult.results.slice(0, LIST_CAP).map((row) => ({ personId: row.id, userId: row.user_id, accountName: nameOf(row), mainName: row.main_name }));
  const characters = characterResult.results.slice(0, LIST_CAP).map((row) => ({ id: row.id, name: row.name, class: row.class, personId: row.player_id, proof: row.owner_proof }));
  const bearer = bearerResult.results[0];
  return jsonResponse({
    claim,
    roles,
    rankMap: {
      rows: mapResult.results.map((row) => ({ rank: Number(row.source_key), label: row.label, coreRank: row.core_rank, roleId: row.role_id, roleName: row.role_name })),
      setBy: null,
      setAt: null,
    },
    handLinks: {
      persons,
      characters,
      truncated: personResult.results.length > LIST_CAP || characterResult.results.length > LIST_CAP,
      setBy: null,
      setAt: null,
    },
    rolesTruncated: roleResult.results.length > LIST_CAP,
    bearer: { name: 'settings', tab: 'links', apiKeys: bearer.api_keys, guestLinks: bearer.guest_links, joinLinks: bearer.join_links, webhooks: bearer.webhooks },
  });
}
