// The big world of the Users suite (lane B7b): a FLIPPED in-game guild (rank source 'ingame', tests/guild-ingame.js) with about 5,000 names of every kind the Users list reads,
// written straight into the tables (the writers are other lanes' business), among 2,000 other guilds. Nothing here is a test.
//   const s = await bigWorld({ scale })     scale 1 = the full 5,000 (default), a smaller number scales every group down (at least 2 of each)
//   s.expected                              what the list must say: { members, former, nonmembers, blocked } and how each group was made
//   s.today                                 '2027-01-15': the guild's date at the stand-in's fixed clock (the raids all lie before it)
//   s.raidOn(i)                             the date of fixture raid i (0-based, a day apart from 2026-10-01)
// The groups (full scale):  1,200 member accounts with a person on the roster (every third one proven by Battle.net, so about a hundred derive a role) + the Owner, a derived
// Officer, a derived Team Lead and a plain member;  600 account-less persons on the roster;  300 Former persons + 100 Former accounts;  150 blocked accounts (every fifth one waiting
// for review) + 150 blocked persons;  250 Discord sign-ins (user_servers), 150 applicants and 100 open-raid guests (accounts that are no member);  and the names: 800 loot-only,
// 600 log-only, 200 Raid-Helper sign-ups, 100 guest sign-ups, 200 applications, 50 pasted names, 50 officer-marked guests. (And 40 persons on the roster with no Main.)
const { scenario } = require('./guild-b3-world');
const { flip, makeProven } = require('./guild-ingame');
const { NAMESPACE, REALM_ID } = require('./guild-seat');

const OTHER_GUILDS = 2000;
const RAIDS = 60;
const pad = (n, width = 18) => String(n).padStart(width, '0');
// Ids that pass the Worker's route check (a prefix and 22 URL-safe characters).
const uid = (n) => `u_Bulk${pad(n)}`;
const pid = (kind, n) => `p_${kind}${pad(n, 21)}`;
const DAY = 86_400_000;

async function bigWorld({ scale = 1, other = OTHER_GUILDS } = {}) {
  const size = (full) => Math.max(2, Math.round(full * scale));
  const n = {
    members: size(1200), loose: size(600), formerPersons: size(300), formerAccounts: size(100), blockedAccounts: size(150), blockedPersons: size(150),
    discord: size(250), applicants: size(150), guests: size(100), loot: size(800), log: size(600), helper: size(200), guestNames: size(100), applications: size(200),
    manual: size(50), marked: size(50), mainless: size(40),
  };
  const s = await scenario({ teams: ['Alpha', 'Bravo'] });
  [s.alpha, s.bravo] = s.tids;
  s.people = {};
  for (const [key, name, rank] of [['own', 'Seatowner', 4], ['dof', 'Derivedoff', 1], ['dtl', 'Derivedlead', 2], ['mem', 'Plainmember', 5]]) {
    await s.member(key, name);
    s.people[key] = await s.person({ name });
    await s.link(s.people[key].pid, key);
    makeProven(s, key, s.people[key], { rank, proof: key === 'mem' ? 'officer' : 'bnet', link: key !== 'mem' });
  }
  flip(s, { owner: 'own' });
  const sqlite = s.w.db.sqlite;
  sqlite.exec('DROP TRIGGER players_cap'); // a guild holds 1,000 people; the fixture is bigger on purpose
  sqlite.exec('PRAGMA foreign_keys = OFF');
  sqlite.exec('BEGIN');
  const run = (sql) => { const statement = sqlite.prepare(sql); return (...values) => statement.run(...values); };
  const user = run('INSERT INTO users (id, account_key, discord_id, username, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?)');
  const person = run("INSERT INTO players (id, guild_id, status, user_id, created_at, updated_at) VALUES (?, ?, 'raider', ?, 1, 1)");
  const character = run(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, realm, realm_key, class, is_main, created_at, updated_at, core_rank, left_on,
      owner_proof, proof_user_id, proof_bnet_account_id, proof_at, namespace, blizzard_realm_id, blizzard_char_id)
    VALUES (?, ?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const link = run("INSERT INTO bnet_links (user_id, bnet_account_id, battletag, linked_at, snapshot, snapshot_at) VALUES (?, ?, ?, 1, '{}', 1)");
  const roster = run(`INSERT INTO guild_roster (guild_id, namespace, blizzard_realm_id, blizzard_char_id, name, name_key, realm_slug, class, level, rank)
    VALUES (?, ?, ?, ?, ?, ?, 'nightslayer', 'MAGE', 70, ?)`);
  const raid = run(`INSERT INTO raids (id, guild_id, team_id, raid_on, starts_at, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`);
  const report = run("INSERT INTO raid_reports (raid_id, guild_id, code, flavour, started_at, ended_at, owner, synced_at) VALUES (?, ?, ?, 'classic', 1, 2, 'Uploader', 3)");
  const pull = run("INSERT INTO raid_pulls (id, raid_id, report_code, fight_id, encounter_id, encounter_name, kill, started_at, ended_at) VALUES (?, ?, ?, 1, 100, 'Boss', 1, 1, 2)");
  const presence = run("INSERT INTO raid_presence (pull_id, raid_id, guild_id, name, name_key, realm, realm_key, class) VALUES (?, ?, ?, ?, ?, 'Nightslayer', 'nightslayer', 'ROGUE')");
  const attendance = run("INSERT INTO attendance (raid_id, guild_id, team_id, player_id, outcome, attended) VALUES (?, ?, ?, ?, 'present', ?)");
  const signup = run(`INSERT INTO raid_signups (raid_id, source, signup_id, discord_user_id, nickname, kind, position, guild_id, player_id, guest, guest_user_id, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'signed', 1, ?, ?, ?, ?, 1, 1)`);
  const loot = run(`INSERT INTO loot_awards (id, guild_id, raid_id, team_id, checksum, item_id, item_name, awarded_at, winner_name, winner_name_key, winner_realm, winner_realm_key,
      winner_class, tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 5, ?, ?, 'Nightslayer', 'nightslayer', 'WARRIOR', 'MS', 1, 1)`);
  const application = run(`INSERT INTO applications (id, guild_id, team_id, status, char_name, name_key, realm, realm_key, class, user_id, created_at, updated_at)
    VALUES (?, ?, ?, 'new', ?, ?, 'Nightslayer', 'nightslayer', 'MAGE', ?, ?, ?)`);
  const manual = run("INSERT INTO raid_manual_names (raid_id, guild_id, name, name_key, realm, realm_key) VALUES (?, ?, ?, ?, 'Nightslayer', 'nightslayer')");
  const marked = run("INSERT INTO attendance_guests (guild_id, name_key, realm_key, name, created_at) VALUES (?, ?, 'nightslayer', ?, 1)");
  const server = run('INSERT INTO user_servers (user_id, server_id, seen_at) VALUES (?, ?, 1)');
  const block = run('INSERT INTO guild_blocks (guild_id, user_id, blocked_by, reason, created_at, pending_review) VALUES (?, ?, NULL, ?, ?, ?)');
  const personBlock = run('INSERT INTO person_blocks (guild_id, player_id, blocked_by, reason, tombstone_missing, created_at) VALUES (?, ?, NULL, NULL, 0, ?)');

  const start = Date.UTC(2026, 9, 1);
  const raidOn = (i) => new Date(start + i * DAY).toISOString().slice(0, 10);
  const raidIds = [];
  const raidTeams = [];
  for (let i = 0; i < RAIDS; i++) {
    const id = `r_Raid${pad(i)}`;
    raidIds.push(id);
    raidTeams.push(i % 2 ? s.alpha : s.bravo);
    raid(id, s.gid, raidTeams[i], raidOn(i), start + i * DAY, `Raid ${i}`);
    report(id, s.gid, `Code${pad(i, 12)}`);
    pull(i + 1, id, `Code${pad(i, 12)}`);
  }
  const raidAt = (i) => raidIds[i % RAIDS];
  const teamAt = (i) => raidTeams[i % RAIDS];
  let charSeq = 100000;
  let signupSeq = 1;
  let awardSeq = 1;
  // A person with one Main; `left` makes it Former; `rank` puts it on the stored roster.
  const addPerson = (id, user, name, { rank = null, left = null, proof = null, proofUser = null, bnet = null, main = 1 } = {}) => {
    const cid = `c_${id.slice(2)}`;
    const key = ++charSeq;
    person(id, s.gid, user);
    character(cid, s.gid, id, rank !== null && rank < 5 ? s.alpha : null, name, name.toLowerCase(), main, left ? 'social' : 'raider', left, proof, proofUser, bnet, proof === 'bnet' ? 1 : null,
      NAMESPACE, REALM_ID, key);
    if (rank !== null) roster(s.gid, NAMESPACE, REALM_ID, key, name, name.toLowerCase(), rank);
    return cid;
  };

  // 1. member accounts with a person on the roster
  for (let i = 0; i < n.members; i++) {
    const id = uid(i);
    const proven = i % 3 === 0;
    user(id, id, null, `Member${i}`, 1_700_000_000_000 + i * 1000);
    addPerson(pid('m', i), id, `Mem${pad(i, 5)}`, { rank: i % 10, proof: proven ? 'bnet' : 'officer', proofUser: proven ? id : null, bnet: proven ? String(700000 + i) : null });
    if (proven) link(id, String(700000 + i), `Member${i}#1`);
    if (i % 2 === 0) attendance(raidAt(i), s.gid, teamAt(i), pid('m', i), 1);
    if (i % 5 === 0) signup(raidAt(i + 1), 'raidsmith', ++signupSeq, null, s.gid, pid('m', i), 0, null);
    if (i % 7 === 0) loot(`lo_Bulk${pad(awardSeq, 18)}`, s.gid, raidAt(i + 2), teamAt(i + 2), `sum${pad(awardSeq, 6)}`, 30000 + (awardSeq % 50), 'Trinket', `Mem${pad(i, 5)}`, `mem${pad(i, 5)}`);
    if (i % 7 === 0) awardSeq++;
  }
  // 2. account-less persons on the roster
  for (let i = 0; i < n.loose; i++) {
    addPerson(pid('l', i), null, `Loose${pad(i, 5)}`, { rank: 3 + (i % 7), proof: 'officer' });
    if (i % 3 === 0) attendance(raidAt(i + 3), s.gid, teamAt(i + 3), pid('l', i), 1);
  }
  // 2b. persons on the roster with no Main (one character, not the Main): a row with nothing to show in the Main column
  for (let i = 0; i < n.mainless; i++) addPerson(pid('n', i), null, `Nomain${pad(i, 5)}`, { rank: 6, proof: 'officer', main: 0 });
  // 3. Former persons (no account) and Former accounts
  for (let i = 0; i < n.formerPersons; i++) addPerson(pid('f', i), null, `Former${pad(i, 5)}`, { left: '2026-09-01', proof: 'officer' });
  for (let i = 0; i < n.formerAccounts; i++) {
    const id = uid(10000 + i);
    user(id, id, null, `Formeracct${i}`, 1_700_000_000_000);
    addPerson(pid('g', i), id, `Gone${pad(i, 5)}`, { left: '2026-09-02', proof: 'officer' });
  }
  // 4. blocked accounts (every fifth waits for review) and blocked persons
  for (let i = 0; i < n.blockedAccounts; i++) {
    const id = uid(20000 + i);
    user(id, id, null, `Blocked${i}`, 1_700_000_000_000);
    block(s.gid, id, 'Blocked by test', 1_790_000_000_000 + i * 1000, i % 5 === 0 ? 1 : 0);
  }
  for (let i = 0; i < n.blockedPersons; i++) {
    addPerson(pid('b', i), null, `Bperson${pad(i, 5)}`, { rank: 5, proof: 'officer' });
    personBlock(s.gid, pid('b', i), 1_790_000_000_000);
  }
  // 5. accounts that are no member: Discord sign-ins, applicants, open-raid guests
  const serverId = s.serverId;
  for (let i = 0; i < n.discord; i++) {
    const id = uid(30000 + i);
    user(id, id, `3${pad(i, 17)}`, `Discorder${i}`, 1_700_000_000_000);
    server(id, serverId);
  }
  for (let i = 0; i < n.applicants; i++) {
    const id = uid(40000 + i);
    user(id, id, null, `Applicant${i}`, 1_700_000_000_000);
    application(`am_Bulk${pad(i, 18)}`, s.gid, s.alpha, `Applicantchar${i}`, `applicantchar${i}`, id, 1_790_000_000_000 + i * DAY, 1);
  }
  for (let i = 0; i < n.guests; i++) {
    const id = uid(50000 + i);
    user(id, id, null, `Guestacct${i}`, 1_700_000_000_000);
    signup(raidAt(i), 'raidsmith', ++signupSeq, `Guestchar${i}`, s.gid, null, 1, id);
  }
  // 6. names that resolve to no character
  for (let i = 0; i < n.loot; i++) {
    const name = `Lootonly${pad(i, 5)}`;
    for (let k = 0; k < 1 + (i % 3); k++) {
      loot(`lo_Bulk${pad(awardSeq, 18)}`, s.gid, raidAt(i + k), teamAt(i + k), `sum${pad(awardSeq, 6)}`, 31000 + (awardSeq % 50), 'Trinket', name, name.toLowerCase());
      awardSeq++;
    }
  }
  let pullSeq = 0;
  for (let i = 0; i < n.log; i++) {
    const name = `Logonly${pad(i, 5)}`;
    for (let k = 0; k < 1 + (i % 3); k++) presence((i + k) % RAIDS + 1, raidAt(i + k), s.gid, name, name.toLowerCase());
    pullSeq++;
  }
  for (let i = 0; i < n.helper; i++) signup(raidAt(i), 'raid_helper', ++signupSeq, `Helper${pad(i, 5)}`, s.gid, null, 0, null);
  for (let i = 0; i < n.guestNames; i++) signup(raidAt(i), 'raidsmith', ++signupSeq, `Linkguest${pad(i, 5)}`, s.gid, null, 1, null);
  for (let i = 0; i < n.applications; i++) {
    const name = `Hopeful${pad(i, 5)}`;
    application(`am_Bulk${pad(1000 + i, 18)}`, s.gid, s.alpha, name, name.toLowerCase(), null, 1_790_000_000_000 + i * DAY, 1);
  }
  for (let i = 0; i < n.manual; i++) manual(raidAt(i), s.gid, `Pasted${pad(i, 5)}`, `pasted${pad(i, 5)}`);
  for (let i = 0; i < n.marked; i++) marked(s.gid, `marked${pad(i, 5)}`, `Marked${pad(i, 5)}`);

  // 7. other guilds, crowding the tables the lookups start from
  const guild = sqlite.prepare(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at, rank_source)
    VALUES (?, ?, 'Nightslayer', 'realm', 'US', ?, 'America/New_York', 'tbc', 1, ?)`);
  for (let i = 0; i < other; i++) guild.run(`g_B${pad(i, 21)}`, `Big ${pad(i, 4)}`, `8${pad(i, 17)}`, [null, 'manual', 'ingame'][i % 3]);
  sqlite.exec('COMMIT');
  sqlite.exec('PRAGMA foreign_keys = ON');

  s.today = '2027-01-15';
  s.raidOn = raidOn;
  s.n = n;
  s.expected = {
    // the Owner, the derived Officer and Team Lead and the plain member are members too; the Guild Master of the legacy scene (no role any more, in the server) is a Discord sign-in
    members: 4 + n.members + n.loose + n.mainless,
    former: n.formerPersons + n.formerAccounts,
    blocked: n.blockedAccounts + n.blockedPersons,
    nonmembers: 1 + n.discord + n.applicants + n.guests + n.loot + n.log + n.helper + n.guestNames + n.applications + n.manual + n.marked,
  };
  return s;
}

module.exports = { bigWorld, OTHER_GUILDS };
