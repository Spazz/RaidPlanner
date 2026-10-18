// The team progress board (PM wave 7), the pure half: per zone, each boss with its first kill, the wipes before it, the kills since, and the nights it
// took, built ONLY from the pulls already stored (raid_pulls: encounter, kill flag, start and end). Nothing of a report is read or kept, the same rule
// as attendance: a pull is derived data. The reads are worker/progress-store.js.
import { zonesFor } from './raid-zones.js';

export const NIGHTS_SHOWN = 8;            // nights listed per zone (newest first); nightCount says how many there are
export const UNKNOWN_ZONE = 'Zone not set';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A boss logged by two uploaders appears twice in one raid (one pull row per report): a pull that starts before the previous kept pull of the same
// boss in the same raid ended is the same fight. -> the pulls without the duplicates, oldest first.
export function dedupePulls(pulls) {
  const sorted = [...pulls].sort((a, b) => byText(a.raid_id, b.raid_id) || a.encounter_id - b.encounter_id || a.started_at - b.started_at || a.ended_at - b.ended_at);
  const kept = [];
  let last = null;
  for (const pull of sorted) {
    if (last && last.raid_id === pull.raid_id && last.encounter_id === pull.encounter_id && pull.started_at < last.ended_at) {
      // The same fight: a kill wins over a wipe if the two reports disagree (one logger saw the boss die).
      if (pull.kill === 1 && last.kill !== 1) last.kill = 1;
      last.ended_at = Math.max(last.ended_at, pull.ended_at);
      continue;
    }
    last = { ...pull };
    kept.push(last);
  }
  return kept.sort((a, b) => a.started_at - b.started_at || a.encounter_id - b.encounter_id);
}

// The order zones are listed in: the game version's raids in their own order, then any other zone by name, "Zone not set" last.
function zoneRank(zone, order) {
  if (zone === UNKNOWN_ZONE) return [2, 0, ''];
  const index = order.indexOf(zone);
  return index >= 0 ? [0, index, ''] : [1, 0, zone];
}

// pulls: [{ raid_id, raid_on, zone, encounter_id, encounter_name, kill (0 | 1), started_at, ended_at }] (any order).
// -> { zones: [{ zone, bossesKilled, bosses: [{ encounterId, name, killed, firstKillOn, firstKillRaidId, wipesBeforeKill, wipes, kills, killsSince, pulls }],
//      nightCount, nights: [{ raidId, raidOn, bosses, kills, wipes, durationMs }], bestClear: { raidId, raidOn, bosses, durationMs } | null }] }
// A boss is listed once it has been pulled; a boss never pulled is not known to this module (the board shows what the logs hold). Bosses are in
// encounter-id order (Warcraft Logs numbers a zone's encounters in progression order). A night is one raid with at least one kill: its time runs from the
// raid's first pull to its last kill. The best clear is the quickest of the nights that killed the most different bosses.
export function buildProgress(pulls, gameVersion) {
  const order = zonesFor(gameVersion);
  const zones = new Map();
  for (const pull of dedupePulls(pulls || [])) {
    const zone = pull.zone || UNKNOWN_ZONE;
    if (!zones.has(zone)) zones.set(zone, []);
    zones.get(zone).push(pull);
  }

  const out = [];
  for (const [zone, list] of zones) {
    const bosses = new Map();
    for (const pull of list) { // oldest first
      if (!bosses.has(pull.encounter_id)) {
        bosses.set(pull.encounter_id, { encounterId: pull.encounter_id, name: pull.encounter_name, killed: false, firstKillOn: null, firstKillRaidId: null, wipesBeforeKill: 0, wipes: 0, kills: 0, killsSince: 0, pulls: 0 });
      }
      const boss = bosses.get(pull.encounter_id);
      boss.name = pull.encounter_name;
      boss.pulls++;
      if (pull.kill === 1) {
        boss.kills++;
        if (!boss.killed) {
          boss.killed = true;
          boss.firstKillOn = pull.raid_on;
          boss.firstKillRaidId = pull.raid_id;
          boss.wipesBeforeKill = boss.wipes;
        } else {
          boss.killsSince++;
        }
      } else {
        boss.wipes++;
      }
    }

    const nights = new Map();
    for (const pull of list) {
      if (!nights.has(pull.raid_id)) nights.set(pull.raid_id, { raidId: pull.raid_id, raidOn: pull.raid_on, killed: new Set(), kills: 0, wipes: 0, start: pull.started_at, end: null });
      const night = nights.get(pull.raid_id);
      night.start = Math.min(night.start, pull.started_at);
      if (pull.kill === 1) {
        night.killed.add(pull.encounter_id);
        night.kills++;
        night.end = night.end === null ? pull.ended_at : Math.max(night.end, pull.ended_at);
      } else {
        night.wipes++;
      }
    }
    const cleared = [...nights.values()].filter((night) => night.end !== null)
      .map((night) => ({ raidId: night.raidId, raidOn: night.raidOn, bosses: night.killed.size, kills: night.kills, wipes: night.wipes, durationMs: Math.max(0, night.end - night.start) }));
    const most = cleared.reduce((top, night) => Math.max(top, night.bosses), 0);
    const best = cleared.filter((night) => night.bosses === most)
      .sort((a, b) => a.durationMs - b.durationMs || byText(a.raidOn, b.raidOn) || byText(a.raidId, b.raidId))[0] || null;
    const newest = [...cleared].sort((a, b) => byText(b.raidOn, a.raidOn) || byText(b.raidId, a.raidId));

    const bossList = [...bosses.values()].sort((a, b) => a.encounterId - b.encounterId);
    out.push({
      zone,
      bossesKilled: bossList.filter((boss) => boss.killed).length,
      bosses: bossList,
      nightCount: cleared.length,
      nights: newest.slice(0, NIGHTS_SHOWN),
      bestClear: best,
    });
  }
  out.sort((a, b) => {
    const [ga, ia, na] = zoneRank(a.zone, order);
    const [gb, ib, nb] = zoneRank(b.zone, order);
    return ga - gb || ia - ib || byText(na, nb);
  });
  return { zones: out };
}

// The public / guest version: no raid ids.
export function publicProgress(progress) {
  return {
    zones: progress.zones.map((zone) => ({
      zone: zone.zone,
      bossesKilled: zone.bossesKilled,
      bosses: zone.bosses.map(({ firstKillRaidId, ...boss }) => boss),
      nightCount: zone.nightCount,
      nights: zone.nights.map(({ raidId, ...night }) => night),
      bestClear: zone.bestClear ? (({ raidId, ...best }) => best)(zone.bestClear) : null,
    })),
  };
}
