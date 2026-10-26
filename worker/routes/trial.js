// The trial review card: GET /roster/:pid/trial gathers what an officer weighs when a trial ends - attendance since the trial began, the loot
// the person received, fill-ins and an excerpt of the officer notes - into one answer. The buttons on the card (Promote, Extend, End) are the
// existing person PATCH; nothing here writes. The card is about the team the person is on trial on: the Trial character on a team roster that the viewer
// may edit (worker/person-rank.js trialReviews: a Raider main on A with a Trial alt on B is reviewed on B), else the person's home team. For people who
// may edit that team (roster.edit); each block is left out (null) when the viewer lacks the right to that data.
import { HttpError, jsonResponse } from '../http.js';
import { summarizeCells, teamMetrics } from '../attendance-metrics.js';
import { makePolicyResolver, policyRowsStatement } from '../attendance-store.js';
import { lootAccess, lootPolicyRowsStatement, makeLootPolicyResolver } from '../loot-store.js';
import { winnerNameKeySql } from '../name-alias.js';
import { allows, loadGuildContext } from '../permissions.js';
import { characterOfRow, trialReviews } from '../person-rank.js';
import { trialFlag } from '../roster-data.js';
import { guildToday, homeTeamOf, loadPersonData, notesView } from '../roster-view.js';
import { metricsRaid, metricsRow } from './attendance.js';

export const NOTES_EXCERPT = 300;
export const LOOT_ITEMS = 10;
const LOOT_READ_CAP = 500;

const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do that.');

// The first NOTES_EXCERPT characters of the notes, cut at a word end when there is one near the cut; the plain text, never HTML.
export function excerptOf(text) {
  const chars = Array.from(String(text || '').trim());
  if (chars.length <= NOTES_EXCERPT) return { excerpt: chars.join(''), truncated: false };
  const cut = chars.slice(0, NOTES_EXCERPT).join('');
  const space = cut.lastIndexOf(' ');
  return { excerpt: (space > NOTES_EXCERPT - 40 ? cut.slice(0, space) : cut).trimEnd(), truncated: true };
}

export async function getTrialReview(ctx) {
  const { db } = ctx;
  const guildContext = await loadGuildContext(db, ctx.session.user.id, ctx.params.gid, ctx.session.viewAs);
  const guild = guildContext.guild;
  const data = await loadPersonData(db, guild.id, ctx.params.pid);
  if (!data) throw new HttpError(404, 'not_found', 'That person was not found.');
  const homeTeam = homeTeamOf(data);
  if (!homeTeam) throw forbidden();
  const { player } = data;
  const editable = (teamId) => allows(guildContext.can, 'roster.edit', teamId);
  const reviews = trialReviews({ characters: data.characters.map((entry) => characterOfRow(entry.row)) });
  const review = reviews.find((entry) => entry.teamId === homeTeam.id && editable(entry.teamId)) || reviews.find((entry) => editable(entry.teamId)) || null;
  const home = review ? data.characters.find((entry) => entry.row.id === review.characterId).view.team : homeTeam;
  if (!editable(home.id)) throw forbidden();
  const status = review ? 'trial' : player.status;
  const trialStart = review ? review.trialStart : player.trial_start;
  const trialEnd = review ? review.trialEnd : player.trial_end;
  const today = guildToday(guild, ctx.now());
  const since = trialStart || player.joined_on || null;
  const seeAttendance = home.id !== null && allows(guildContext.can, 'attendance.view', home.id);
  const [policyResult, raidResult, rowResult, borrowedResult, lootPolicyResult, lootResult] = await db.batch([
    policyRowsStatement(db, guild.id),
    db.prepare(
      `SELECT id, raid_on, zone, event_synced, plan_synced, open_flags, policy_fp, log_mode, team_id,
              (SELECT COUNT(*) FROM raid_reports x WHERE x.raid_id = raids.id) AS reports
         FROM raids WHERE guild_id = ? AND team_id = ? ORDER BY raid_on, id`,
    ).bind(guild.id, home.id),
    db.prepare('SELECT raid_id, player_id, outcome, credit, signup_kind, attended, needs_review, via_raid_id, flags FROM attendance WHERE guild_id = ? AND player_id = ? AND team_id = ?')
      .bind(guild.id, player.id, home.id),
    db.prepare(
      `SELECT a.raid_id, a.player_id, r.raid_on, r.team_id AS host_team_id FROM attendance a JOIN raids r ON r.id = a.raid_id
        WHERE a.guild_id = ? AND a.player_id = ? AND a.credit_team_id = ? AND a.credit = 1 AND a.outcome = 'fill_in'`,
    ).bind(guild.id, player.id, home.id),
    lootPolicyRowsStatement(db, guild.id),
    db.prepare(
      `SELECT a.item_id, a.item_name, a.tag, r.raid_on FROM loot_awards a JOIN raids r ON r.id = a.raid_id AND r.guild_id = a.guild_id
        WHERE a.guild_id = ?1 AND a.team_id = ?3 AND a.winner_name_key IS NOT NULL AND (?4 IS NULL OR r.raid_on >= ?4)
          AND EXISTS (SELECT 1 FROM characters c WHERE c.guild_id = ?1 AND c.player_id = ?2 AND c.name_key = ${winnerNameKeySql('a')} AND c.realm_key = a.winner_realm_key)
        ORDER BY r.raid_on DESC, a.awarded_at DESC, a.id LIMIT ?5`,
    ).bind(guild.id, player.id, home.id, since, LOOT_READ_CAP),
  ]);

  let attendance = null;
  if (seeAttendance) {
    const resolver = makePolicyResolver(guild, policyResult.results);
    const policy = resolver.resolved(home.id);
    const metrics = teamMetrics({
      people: [{ id: player.id, status, joinedOn: player.joined_on, leftOn: player.left_on }],
      raids: raidResult.results.map(metricsRaid),
      rows: rowResult.results.map((row) => metricsRow(row)),
      borrowed: borrowedResult.results.map((row) => ({ raidId: row.raid_id, raidOn: row.raid_on, playerId: row.player_id, teamId: row.host_team_id })),
      policy, today, resetDay: resolver.resetDay(), windowWeeks: 'all',
    });
    const mine = metrics.people[player.id];
    const counts = summarizeCells(mine ? mine.cells : [], { policy, from: since, to: today });
    attendance = {
      team: { id: home.id, name: home.name },
      raids: counts.raids, pct: counts.pct, present: counts.present, missed: counts.missed, missedNotice: counts.missedNotice,
      late: counts.late, leftEarly: counts.leftEarly, fillIns: counts.fillIns, pending: counts.pending,
    };
  }

  let loot = null;
  if (lootAccess(guildContext, makeLootPolicyResolver(lootPolicyResult.results), home.id).level === 'full') {
    const awards = lootResult.results;
    const count = (tag) => awards.filter((award) => award.tag === tag).length;
    loot = {
      total: awards.length, ms: count('MS'), os: count('OS'), de: count('DE'), bank: count('BANK'),
      items: awards.slice(0, LOOT_ITEMS).map((award) => ({ itemId: award.item_id, itemName: award.item_name, tag: award.tag, raidOn: award.raid_on })),
    };
  }

  // The officer notes belong to the person's home team (the Main's), as in GET /roster/:pid: a Team Lead of the team this Trial alt sits on reads the
  // attendance and loot of that team, not the notes of another one.
  const notes = notesView(data, guildContext, homeTeam);
  const main = data.characters.find((entry) => entry.row.is_main === 1);
  return jsonResponse({
    today,
    person: {
      id: player.id, name: main ? main.view.name : 'Unknown', status, joinedOn: player.joined_on, trialStart,
      trialEnd, trialFlag: trialFlag(status, trialEnd, today), version: player.version,
    },
    since,
    attendance,
    loot,
    notes: notes ? excerptOf(notes.text) : null,
  });
}
