/**
 * Raidsmith guild tracker - the R1/R2 re-derive tool (tools/hierarchy/rederive.sql and mismatch.sql), lane B1a-1
 * Run: node tests/guild/guild-hierarchy-rederive-tests.js
 *
 * Seeds a fake D1 (every migration, 0030 included) with a person for every status / left reason / trial-date combination, each with a main and two
 * alts, characters left at the migration's defaults (= drift), then:
 *   - mismatch.sql answers one row of five counts (core_rank, left_on, left_reason, trial_start, trial_end), nonzero for the drifted data;
 *   - rederive.sql brings all five to 0, changes nothing else, and is idempotent;
 *   - what it writes equals an independent JS statement of the 0030 mapping, the migration 0030 backfill itself, and the Worker's own mapping
 *     (characterRankColumns + setCharacterRanksStatement, the writers of lane B2);
 *   - after a seeded drift (one character per field) the counts are exactly one per field, and rederive heals them.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createD1Fake } = require('../d1-fake');

const ROOT = path.join(__dirname, '..', '..');
const REDERIVE = fs.readFileSync(path.join(ROOT, 'tools/hierarchy/rederive.sql'), 'utf8');
const MISMATCH = fs.readFileSync(path.join(ROOT, 'tools/hierarchy/mismatch.sql'), 'utf8');
const MIGRATIONS = path.join(ROOT, 'migrations');
const FIELDS = ['core_rank', 'left_on', 'left_reason', 'trial_start', 'trial_end'];

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// id, status, left_reason, left_on, trial_start, trial_end
const PEOPLE = [
  ['p_raider', 'raider', null, null, null, null],
  ['p_raider_dirty', 'raider', 'left', '2026-09-01', '2026-08-01', '2026-08-15'], // stale legacy values on a non-inactive person map to NULL
  ['p_trial', 'trial', null, null, '2026-10-01', '2026-10-15'],
  ['p_trial_open', 'trial', null, null, '2026-10-02', null],
  ['p_trial_bare', 'trial', null, null, null, null],
  ['p_reserve', 'reserve', null, null, null, null],
  ['p_reserve_dirty', 'reserve', null, null, '2026-07-01', '2026-07-14'],
  ['p_left', 'inactive', 'left', '2026-09-20', null, null],
  ['p_left_nodate', 'inactive', 'left', null, null, null],
  ['p_kicked', 'inactive', 'kicked', '2026-09-21', '2026-08-01', '2026-08-15'],
  ['p_break', 'inactive', 'break', '2026-09-22', null, null],
  ['p_other', 'inactive', 'other', '2026-09-23', null, null],
  ['p_noreason', 'inactive', null, '2026-09-24', null, null],
];

const q = (value) => (value === null ? 'NULL' : `'${value}'`);

// Players and characters (a main and two alts each) with the columns 0030 added left at their defaults.
function seed(db) {
  db.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                  VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1)`);
  db.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1)");
  for (const [id, status, reason, leftOn, trialStart, trialEnd] of PEOPLE) {
    db.sqlite.exec(`INSERT INTO players (id, guild_id, status, left_reason, left_on, trial_start, trial_end, created_at, updated_at)
                    VALUES ('${id}', 'g1', '${status}', ${q(reason)}, ${q(leftOn)}, ${q(trialStart)}, ${q(trialEnd)}, 1, 1)`);
    db.sqlite.exec(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at)
                    VALUES ('${id}_main', 'g1', '${id}', 't1', 'M${id}', 'm${id}', 'MAGE', 1, 5, 6),
                           ('${id}_alt1', 'g1', '${id}', 't1', 'A${id}', 'a${id}', 'ROGUE', 0, 5, 6),
                           ('${id}_alt2', 'g1', '${id}', NULL, 'B${id}', 'b${id}', 'ROGUE', 0, 5, 6)`);
  }
}

// The 0030 mapping, written independently of the SQL: [core_rank, left_on, left_reason, trial_start, trial_end] of one character.
function expected([, status, reason, leftOn, trialStart, trialEnd], isMain) {
  const inactive = status === 'inactive';
  const left = inactive && (reason === 'left' || reason === 'kicked');
  const trial = status === 'trial' && isMain === 1;
  return {
    core_rank: inactive ? 'social' : status,
    left_on: left ? leftOn : null,
    left_reason: left ? reason : null,
    trial_start: trial ? trialStart : null,
    trial_end: trial ? trialEnd : null,
  };
}

const allColumns = (db) => db.sqlite.prepare('SELECT * FROM characters ORDER BY id').all().map((row) => ({ ...row }));
const fiveFields = (db) => db.sqlite.prepare(`SELECT id, ${FIELDS.join(', ')} FROM characters ORDER BY id`).all().map((row) => ({ ...row }));
const mismatch = async (db) => (await db.prepare(MISMATCH).first());
const rederive = (db) => db.prepare(REDERIVE).run();
const reset = (db) => db.sqlite.exec("UPDATE characters SET core_rank = 'raider', left_on = NULL, left_reason = NULL, trial_start = NULL, trial_end = NULL");
const ZERO = { core_rank: 0, left_on: 0, left_reason: 0, trial_start: 0, trial_end: 0 };

function freshDb() {
  const db = createD1Fake();
  seed(db);
  return db;
}

check('mismatch.sql answers one row of five counts and nothing else; the drifted seed is nonzero in every field', async () => {
  const db = freshDb();
  const result = await db.prepare(MISMATCH).all();
  assert.equal(result.results.length, 1, 'one row');
  assert.deepEqual(Object.keys(result.results[0]), FIELDS, 'five columns, in this order');
  for (const value of Object.values(result.results[0])) assert(Number.isInteger(value), 'counts only');
  // The seed leaves every character at the migration's defaults (raider, no dates): a field drifts wherever the mapping wants something else.
  const want = { core_rank: 0, left_on: 0, left_reason: 0, trial_start: 0, trial_end: 0 };
  for (const person of PEOPLE) {
    for (const isMain of [1, 0, 0]) {
      const mapped = expected(person, isMain);
      for (const field of FIELDS) if (mapped[field] !== (field === 'core_rank' ? 'raider' : null)) want[field]++;
    }
  }
  assert.deepEqual(result.results[0], want);
  for (const field of FIELDS) assert(want[field] > 0, `the seed drifts ${field}`);
});

check('rederive.sql: all five counts reach 0, only the five columns change, and a second run changes nothing', async () => {
  const db = freshDb();
  const before = allColumns(db);
  await rederive(db);
  assert.deepEqual(await mismatch(db), ZERO);
  const after = allColumns(db);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    const { core_rank: _a, left_on: _b, left_reason: _c, trial_start: _d, trial_end: _e, ...rest } = before[i];
    const { core_rank: _f, left_on: _g, left_reason: _h, trial_start: _i, trial_end: _j, ...restAfter } = after[i];
    assert.deepEqual(restAfter, rest, `only the five columns change (${before[i].id})`);
  }
  const once = fiveFields(db);
  await rederive(db);
  assert.deepEqual(fiveFields(db), once, 'idempotent');
  assert.deepEqual(await mismatch(db), ZERO);
});

check('rederive.sql writes the 0030 mapping: every status, reason and trial-date combination, main and alts', async () => {
  const db = freshDb();
  await rederive(db);
  const byPerson = new Map(PEOPLE.map((person) => [person[0], person]));
  const rows = db.sqlite.prepare(`SELECT id, player_id, is_main, ${FIELDS.join(', ')} FROM characters ORDER BY id`).all();
  assert.equal(rows.length, PEOPLE.length * 3);
  for (const row of rows) {
    const want = expected(byPerson.get(row.player_id), row.is_main);
    assert.deepEqual(FIELDS.map((f) => row[f]), FIELDS.map((f) => want[f]), row.id);
  }
  // A few by name, so the table above cannot drift along with the mapping.
  const get = (id) => ({ ...db.sqlite.prepare(`SELECT ${FIELDS.join(', ')} FROM characters WHERE id = ?`).get(id) });
  assert.deepEqual(get('p_trial_main'), { core_rank: 'trial', left_on: null, left_reason: null, trial_start: '2026-10-01', trial_end: '2026-10-15' });
  assert.deepEqual(get('p_trial_alt1'), { core_rank: 'trial', left_on: null, left_reason: null, trial_start: null, trial_end: null });
  assert.deepEqual(get('p_left_alt2'), { core_rank: 'social', left_on: '2026-09-20', left_reason: 'left', trial_start: null, trial_end: null });
  assert.deepEqual(get('p_break_main'), { core_rank: 'social', left_on: null, left_reason: null, trial_start: null, trial_end: null });
  assert.deepEqual(get('p_raider_dirty_main'), { core_rank: 'raider', left_on: null, left_reason: null, trial_start: null, trial_end: null });
  assert.deepEqual(get('p_kicked_main'), { core_rank: 'social', left_on: '2026-09-21', left_reason: 'kicked', trial_start: null, trial_end: null });
});

check('the Worker\'s mapping (characterRankColumns + setCharacterRanksStatement) and rederive.sql give the same rows', async () => {
  const { characterRankColumns, setCharacterRanksStatement } = await import(pathToFileURL(path.join(ROOT, 'worker/person-legacy.js')).href);
  const columnsOf = ([, status, reason, leftOn, trialStart, trialEnd]) => characterRankColumns({ status, leftReason: reason, leftOn, trialStart, trialEnd });
  const viaSql = freshDb();
  await rederive(viaSql);
  const viaWorker = freshDb();
  await viaWorker.batch(PEOPLE.map((person) => setCharacterRanksStatement(viaWorker, 'g1', person[0], columnsOf(person))));
  assert.deepEqual(fiveFields(viaWorker), fiveFields(viaSql));
  assert.deepEqual(await mismatch(viaWorker), ZERO);
  // The pure mapping on its own, against the independent statement of it above.
  for (const person of PEOPLE) {
    const main = columnsOf(person);
    const want = expected(person, 1);
    assert.deepEqual([main.coreRank, main.leftOn, main.leftReason, main.trialStart, main.trialEnd], [want.core_rank, want.left_on, want.left_reason, want.trial_start, want.trial_end], person[0]);
  }
  // One person at a time, a person that does not exist and a person of another guild change only what they should; a failed guard changes nothing.
  const one = freshDb();
  const trialPerson = PEOPLE.find((person) => person[0] === 'p_trial');
  await one.batch([
    setCharacterRanksStatement(one, 'g1', 'p_trial', columnsOf(trialPerson)),
    setCharacterRanksStatement(one, 'g1', 'p_nobody', columnsOf(trialPerson)),
    setCharacterRanksStatement(one, 'other-guild', 'p_left', columnsOf(trialPerson)),
    setCharacterRanksStatement(one, 'g1', 'p_reserve', columnsOf(PEOPLE.find((person) => person[0] === 'p_reserve')), { sql: '0 = 1', params: [] }),
  ]);
  const touched = fiveFields(one).filter((row) => row.core_rank !== 'raider' || row.trial_start);
  assert.deepEqual(touched.map((row) => row.id), ['p_trial_alt1', 'p_trial_alt2', 'p_trial_main']);
  assert.deepEqual((await mismatch(one)).core_rank, 3 * (PEOPLE.filter((p) => p[1] !== 'raider').length - 1));
});

check('the migration 0030 backfill and rederive.sql give the same rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidsmith-rederive-'));
  for (const name of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && n < '0030')) fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
  const old = createD1Fake({ migrationsDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  old.sqlite.exec(`INSERT INTO guilds (id, name, realm, realm_kind, region, discord_server_id, time_zone, game_version, created_at)
                   VALUES ('g1', 'G', 'R', 'realm', 'US', 'd1', 'America/Chicago', 'tbc', 1)`);
  old.sqlite.exec("INSERT INTO teams (id, guild_id, name, size, archived, created_at) VALUES ('t1', 'g1', 'T1', 25, 0, 1)");
  for (const [id, status, reason, leftOn, trialStart, trialEnd] of PEOPLE) {
    old.sqlite.exec(`INSERT INTO players (id, guild_id, status, left_reason, left_on, trial_start, trial_end, created_at, updated_at)
                     VALUES ('${id}', 'g1', '${status}', ${q(reason)}, ${q(leftOn)}, ${q(trialStart)}, ${q(trialEnd)}, 1, 1)`);
    old.sqlite.exec(`INSERT INTO characters (id, guild_id, player_id, team_id, name, name_key, class, is_main, created_at, updated_at)
                     VALUES ('${id}_main', 'g1', '${id}', 't1', 'M${id}', 'm${id}', 'MAGE', 1, 5, 6),
                            ('${id}_alt1', 'g1', '${id}', 't1', 'A${id}', 'a${id}', 'ROGUE', 0, 5, 6),
                            ('${id}_alt2', 'g1', '${id}', 't1', 'B${id}', 'b${id}', 'ROGUE', 0, 5, 6)`);
  }
  old.sqlite.exec(fs.readFileSync(path.join(MIGRATIONS, '0030_core_ranks.sql'), 'utf8'));
  assert.deepEqual(await mismatch(old), ZERO, 'the backfill is what mismatch.sql calls in sync');
  const backfilled = fiveFields(old);
  reset(old);
  assert.notDeepEqual(fiveFields(old), backfilled);
  await rederive(old);
  assert.deepEqual(fiveFields(old), backfilled, 'rederive.sql restores exactly the backfill');
});

check('a seeded drift (one character per field) counts exactly one per field, and rederive.sql heals it', async () => {
  const db = freshDb();
  await rederive(db);
  assert.deepEqual(await mismatch(db), ZERO);
  db.sqlite.exec("UPDATE characters SET core_rank = 'reserve' WHERE id = 'p_raider_main'");
  db.sqlite.exec("UPDATE characters SET left_on = '2026-01-01' WHERE id = 'p_trial_alt1'");
  db.sqlite.exec("UPDATE characters SET left_reason = 'left' WHERE id = 'p_reserve_alt1'");
  db.sqlite.exec("UPDATE characters SET trial_start = NULL WHERE id = 'p_trial_main'");
  db.sqlite.exec("UPDATE characters SET trial_end = '2030-01-01' WHERE id = 'p_trial_alt2'");
  assert.deepEqual(await mismatch(db), { core_rank: 1, left_on: 1, left_reason: 1, trial_start: 1, trial_end: 1 });
  // Drift in the other direction (a rank that should be Social) counts in the same field.
  db.sqlite.exec("UPDATE characters SET core_rank = 'raider' WHERE id = 'p_left_main'");
  assert.deepEqual(await mismatch(db), { core_rank: 2, left_on: 1, left_reason: 1, trial_start: 1, trial_end: 1 });
  await rederive(db);
  assert.deepEqual(await mismatch(db), ZERO);
});

check('an empty database answers five zeros', async () => {
  const db = createD1Fake();
  assert.deepEqual(await mismatch(db), ZERO);
  await rederive(db);
  assert.deepEqual(await mismatch(db), ZERO);
});

check('the SQL files are one statement each and say when not to run them', () => {
  const statements = (text) => text.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements(REDERIVE).length, 1);
  assert.equal(statements(MISMATCH).length, 1);
  assert.match(REDERIVE, /^UPDATE characters SET/m);
  assert(!/\b(DELETE|DROP|INSERT|ALTER)\b/i.test(REDERIVE.replace(/--[^\n]*/g, '')), 'rederive only updates');
  assert(/NEVER run it once the readers use the character columns/.test(REDERIVE));
  assert(!/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i.test(MISMATCH.replace(/--[^\n]*/g, '')), 'mismatch only reads');
  assert(!/\b(name|id)\b\s*,/i.test(MISMATCH.replace(/--[^\n]*/g, '')), 'counts only: no names or ids in the answer');
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${error && error.stack ? error.stack.split('\n').slice(0, 7).join('\n      ') : error}`);
    }
  }
  console.log(`\n${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
