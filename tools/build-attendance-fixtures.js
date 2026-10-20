#!/usr/bin/env node
/**
 * One-time builder: raw Phase 3 test data -> anonymized attendance fixtures.
 *   node tools/build-attendance-fixtures.js <absolute path to tasks/reference/phase3-testdata> [output dir]
 *
 * Reads <dir>/raidhelper/*.json (Raid-Helper events: Discord IDs and nicknames, personal data) and <dir>/wcl/*.derived.json
 * (derived presence per boss pull). The raw files are read-only input and are never copied. Writes, per event,
 * tests/fixtures/attendance/event-<guild-local date>.json plus roster.json:
 *   - Discord user IDs become fake 18-digit ids (99000000000000NNNN), the server id a fake one;
 *   - Discord nicknames are dropped: a sign-up carries the invented label SignupNN (the same person keeps one label);
 *   - report codes become FIXTUREnnnnnnnnn (16 characters); report titles, owners and zones are dropped;
 *   - WCL character names are kept (public log data);
 *   - a sign-up is linked to a roster person by a nickname token that equals a log name (case and accent insensitive);
 *     a sign-up with no match gets an invented character (SignupNN, in no log); log characters with no sign-up become
 *     persons without a Discord ID. Every person is a raider on one team, joined 2026-08-01.
 * It also prints an independent tally per event (default policy, signed-up mode): the numbers the golden tests pin.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const TIME_ZONE = 'America/Chicago';
const TEAM_ID = 'team1';
const JOINED_ON = '2026-08-01';
const FAKE_DISCORD_PREFIX = '99000000000000';
const FAKE_SERVER_ID = '990000000000009001';

const fold = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const pad = (n, width) => String(n).padStart(width, '0');

function localDate(ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function signupKind(className) {
  if (className === 'Absence') return 'absence';
  if (className === 'Bench') return 'bench';
  if (className === 'Tentative') return 'tentative';
  if (className === 'Late') return 'late';
  return 'signed';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const inputDir = process.argv[2];
  if (!inputDir || !path.isAbsolute(inputDir)) {
    console.error('usage: node tools/build-attendance-fixtures.js <absolute path to tasks/reference/phase3-testdata> [output dir]');
    process.exit(2);
  }
  const outDir = process.argv[3] || path.join(__dirname, '..', 'tests', 'fixtures', 'attendance');
  const { nicknameTokens, nameKey } = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'roster-data.js')).href);

  const events = fs.readdirSync(path.join(inputDir, 'raidhelper')).filter((name) => name.endsWith('.json')).sort()
    .map((name) => readJson(path.join(inputDir, 'raidhelper', name)));
  const reports = new Map(fs.readdirSync(path.join(inputDir, 'wcl')).filter((name) => name.endsWith('.derived.json'))
    .map((name) => readJson(path.join(inputDir, 'wcl', name))).map((report) => [report.code, report]));

  // Which reports back which event: the report whose start is within 18 h of the event start (INDEX.md lists them).
  const indexText = fs.readFileSync(path.join(inputDir, 'INDEX.md'), 'utf8');
  const reportsOf = (event) => {
    const row = indexText.split('\n').find((line) => line.startsWith(`| ${event.id} |`));
    if (!row) throw new Error(`event ${event.id} is not in INDEX.md`);
    return [...row.matchAll(/reports\/([A-Za-z0-9]{16})\)/g)].map((m) => m[1]).map((code) => {
      if (!reports.has(code)) throw new Error(`report ${code} missing`);
      return reports.get(code);
    });
  };

  // -- Persons: one per Discord user, one per log-only character -------------------------------------------------
  const logNames = new Map(); // folded name -> first WCL spelling
  for (const report of reports.values()) {
    for (const fight of report.bossFights) for (const name of fight.players) if (!logNames.has(fold(name))) logNames.set(fold(name), name);
  }
  const usersById = new Map(); // raw Discord id -> { nicknames:Set }
  for (const event of events) {
    for (const signUp of event.signUps) {
      if (!usersById.has(signUp.userId)) usersById.set(signUp.userId, new Set());
      usersById.get(signUp.userId).add(signUp.name);
    }
  }
  const userIds = [...usersById.keys()].sort();
  const claimed = new Set();
  const persons = [];
  const labelOf = new Map(); // raw id -> SignupNN
  const fakeIdOf = new Map();
  userIds.forEach((rawId, index) => {
    labelOf.set(rawId, `Signup${pad(index + 1, 2)}`);
    fakeIdOf.set(rawId, `${FAKE_DISCORD_PREFIX}${pad(index + 1, 4)}`);
  });
  for (const rawId of userIds) {
    let character = null;
    for (const nickname of usersById.get(rawId)) {
      for (const token of nicknameTokens(nickname)) {
        const logged = logNames.get(fold(token));
        if (logged && !claimed.has(fold(logged))) { character = logged; break; }
      }
      if (character) break;
    }
    if (character) claimed.add(fold(character));
    persons.push({ rawId, discordUserId: fakeIdOf.get(rawId), label: labelOf.get(rawId), character: character || labelOf.get(rawId), invented: !character });
  }
  for (const [folded, spelling] of [...logNames.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!claimed.has(folded)) persons.push({ rawId: null, discordUserId: null, label: null, character: spelling, invented: false });
  }
  persons.sort((a, b) => (a.character < b.character ? -1 : a.character > b.character ? 1 : 0));
  persons.forEach((person, index) => { person.id = `P${pad(index + 1, 3)}`; });
  const personOfUser = new Map(persons.filter((person) => person.rawId).map((person) => [person.rawId, person]));
  const personOfLogName = new Map(persons.map((person) => [fold(person.character), person]));

  const roster = {
    guildTimeZone: TIME_ZONE,
    teamId: TEAM_ID,
    persons: persons.map((person) => ({
      id: person.id,
      status: 'raider',
      joinedOn: JOINED_ON,
      discordUserId: person.discordUserId,
      label: person.label,
      characters: [{ name: person.character, key: `${nameKey(person.character)}|`, teamId: TEAM_ID, invented: person.invented }],
    })),
  };

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) if (name.endsWith('.json')) fs.unlinkSync(path.join(outDir, name));
  fs.writeFileSync(path.join(outDir, 'roster.json'), `${JSON.stringify(roster, null, 2)}\n`);

  // -- Events ---------------------------------------------------------------------------------------------------
  let reportNumber = 0;
  const tallies = [];
  for (const event of events) {
    const startMs = event.startTime * 1000;
    const date = localDate(startMs);
    const eventReports = reportsOf(event);
    const outReports = eventReports.map((report) => {
      reportNumber++;
      return {
        code: `FIXTURE${pad(reportNumber, 9)}`,
        startTime: report.startTime,
        endTime: report.endTime,
        pulls: report.bossFights.map((fight) => ({
          fightId: fight.id,
          encounterId: fight.encounterID,
          name: fight.name,
          kill: fight.kill === true,
          startedAt: report.startTime + fight.startTime,
          endedAt: report.startTime + fight.endTime,
          players: fight.players,
        })),
      };
    });
    const signups = event.signUps.map((signUp, index) => ({
      id: index + 1,
      userId: fakeIdOf.get(signUp.userId),
      name: labelOf.get(signUp.userId),
      className: signUp.className,
      specName: signUp.specName || '',
      status: signUp.status,
      position: signUp.position,
      personId: personOfUser.get(signUp.userId).id,
    }));
    const fixture = { guildTimeZone: TIME_ZONE, raidOn: date, event: { startTime: startMs, serverId: FAKE_SERVER_ID }, signups, reports: outReports };
    fs.writeFileSync(path.join(outDir, `event-${date}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    tallies.push(tally(date, event, eventReports, personOfUser, personOfLogName));
  }

  console.log(`wrote ${events.length} events and roster.json (${persons.length} persons) to ${outDir}`);
  for (const t of tallies) console.log(JSON.stringify(t));
}

// The independent calculation (default policy, signed-up mode): straight from the raw files, written without the
// consolidation module. People counted = everyone with a sign-up or in the log.
function tally(date, event, eventReports, personOfUser, personOfLogName) {
  const pulls = [];
  for (const report of eventReports) for (const fight of report.bossFights) pulls.push({ at: report.startTime + fight.startTime, kill: fight.kill === true, players: new Set(fight.players.map((n) => personOfLogName.get(fold(n)).id)) });
  pulls.sort((a, b) => a.at - b.at);
  const first = pulls[0];
  const last = pulls[pulls.length - 1];
  const kindOf = new Map();
  const kindCounts = {};
  for (const signUp of event.signUps) {
    const kind = signupKind(signUp.className);
    kindOf.set(personOfUser.get(signUp.userId).id, kind);
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;
  }
  const logged = new Set();
  for (const pull of pulls) for (const id of pull.players) logged.add(id);
  const everyone = new Set([...kindOf.keys(), ...logged]);
  const outcomes = {};
  const detail = [];
  const bump = (outcome) => { outcomes[outcome] = (outcomes[outcome] || 0) + 1; };
  for (const id of everyone) {
    const kind = kindOf.get(id) || null;
    if (logged.has(id)) {
      const present = pulls.filter((pull) => pull.players.has(id)).length;
      const missedFirst = !first.players.has(id);
      const missedLast = !last.players.has(id);
      const outcome = missedFirst && missedLast ? 'late_left' : missedFirst ? 'late' : missedLast ? 'left_early' : 'present';
      bump(outcome);
      if (outcome !== 'present') detail.push({ person: id, kind, outcome, pullsPresent: present, of: pulls.length });
    } else if (kind === 'bench') bump('bench');
    else if (kind === 'absence') bump('missed_notice');
    else if (kind === 'tentative') bump('tentative');
    else bump('missed');
  }
  const flagged = (outcomes.late || 0) + (outcomes.left_early || 0) + (outcomes.late_left || 0) + (outcomes.missed || 0);
  const kills = pulls.filter((pull) => pull.kill).length;
  return {
    raidOn: date, reports: eventReports.length, pulls: pulls.length, kills, wipes: pulls.length - kills,
    signups: event.signUps.length, signupKinds: kindCounts, loggedPlayers: logged.size,
    rows: everyone.size, outcomes, openFlags: flagged, flaggedDetail: detail,
  };
}

main().catch((error) => { console.error(error); process.exit(1); });
