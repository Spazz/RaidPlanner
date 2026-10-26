/**
 * Raidsmith guild tracker - lane B6b of the user-hierarchy build, part 1: CI greps for the effective-roles view
 * Run: node tests/guild/guild-b6b-grep-tests.js
 *
 * Plan "Model": no `FROM role_assignments` / `JOIN role_assignments` outside the stored-write paths and the view. Every reader of "which roles does this account hold" reads
 * effective_roles (or effective_roles_stored for the stored rows themselves, effective_roles_owner for the Owner); the table is touched only to WRITE a stored row or to guard
 * such a write. A file is listed with the number of SQL literals that read the table and the reason; a new one fails the test: read the view, or say what the new write is.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sqlLiterals, workerFiles } = require('../worker-sql');
const { runChecks } = require('../guild-b3-world');

const ROOT = path.join(__dirname, '..', '..');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// Files whose SQL literals say `FROM role_assignments` / `JOIN role_assignments`: all writes (DELETE ... FROM) or guards inside a write batch.
const STORED_PATHS = {
  'worker/discord-sync.js': { count: 1, reason: 'write: the Discord role sync removes the Discord-source rows it gave and no longer maps (it manages only its own rows; its reads go through effective_roles_stored)' },
  'worker/routes/accounts.js': { count: 1, reason: 'write: disconnecting Discord deletes the Discord-source rows of the account' },
  'worker/routes/auth.js': { count: 5, reason: 'writes of the Delete-my-data succession of the pre-flip stored Guild Master (lane B6b part 2 replaces it with the seat): delete the departing row, insert the successor\'s with the one-Guild-Master-row guard, drop that account\'s Officer row, and the two audit guards that ask whether the insert applied' },
  'worker/routes/claim-review.js': { count: 1, reason: 'read-only listing, no decision: the new Owner\'s claim review (lane B6b part 2b) shows who assigned each stored role and when; assigned_by is not in the effective-roles view, which exists for decisions' },
  'worker/routes/discord.js': { count: 1, reason: 'write: changing the Discord role mapping clears the Discord-source rows of the roles whose mapping changed' },
  'worker/routes/guild.js': { count: 1, reason: 'write guard: the guild claim marks its own inserted Guild Master row by id so the follow-up statements apply only if the insert did' },
  'worker/routes/people.js': { count: 5, reason: 'writes: Edit roles deletes the hand-set (source manual) rows it removes; the legacy hand-over swaps the stored Guild Master row and guards the follow-up statements with it (lane B6b part 2 replaces it)' },
  'worker/routes/roles.js': { count: 1, reason: 'write: deleting a custom role takes it from everyone who holds it' },
};

// Files that read the effective roles instead (a positive check: the readers did move).
const READERS = [
  'worker/permissions.js', 'worker/seniority.js', 'worker/audit.js', 'worker/onboarding.js', 'worker/owner.js', 'worker/block-tombstones.js', 'worker/discord-sync.js',
  'worker/routes/people.js', 'worker/routes/auth.js', 'worker/routes/roles.js', 'worker/routes/teams.js', 'worker/routes/person-blocks.js',
];

const STORED_READ = /\b(FROM|JOIN)\s+role_assignments\b/;

check('CI grep: no worker file reads role_assignments except to write or guard a write of a stored row (every touch is listed with its reason)', () => {
  const found = {};
  for (const file of workerFiles()) {
    const count = sqlLiterals(file).filter(({ sql }) => STORED_READ.test(sql)).length;
    if (count) found[file] = count;
  }
  for (const [file, count] of Object.entries(found)) {
    const entry = STORED_PATHS[file];
    assert(entry, `${file} reads role_assignments in ${count} statement(s) and is not listed: read effective_roles (worker/owner.js and migration 0035), or list the file with the write it serves`);
    assert.equal(count, entry.count, `${file}: ${count} statements read role_assignments, the list says ${entry.count}: say what the new one is for, then update the count`);
  }
  for (const [file, entry] of Object.entries(STORED_PATHS)) {
    assert(found[file], `${file} no longer reads role_assignments: remove it from the list`);
    assert(entry.reason && entry.reason.length > 40, `${file}: a reason is required`);
  }
});

check('CI grep: only the listed files write role_assignments (INSERT / UPDATE / DELETE)', () => {
  const writers = [];
  for (const file of workerFiles()) {
    if (sqlLiterals(file).some(({ sql }) => /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+role_assignments\b/.test(sql))) writers.push(file);
  }
  assert.deepEqual(writers, [
    'worker/discord-sync.js', 'worker/routes/accounts.js', 'worker/routes/auth.js', 'worker/routes/discord.js', 'worker/routes/guild.js', 'worker/routes/people.js', 'worker/routes/roles.js',
  ], 'a new writer of stored rows says so here (and whether the roles it creates belong in the view)');
});

check('CI grep: the readers read the view - each of the moved files names effective_roles (or its stored / owner view) in a SQL literal', () => {
  const missing = READERS.filter((file) => !sqlLiterals(file).some(({ sql }) => /\beffective_roles(_stored|_owner)?\b/.test(sql)));
  assert.deepEqual(missing, []);
  // The one Owner fragment: owner.js is where the Owner view is named, and the other files call its helpers.
  const owner = fs.readFileSync(path.join(ROOT, 'worker/owner.js'), 'utf8');
  assert(/effective_roles_owner/.test(owner) && !/FROM role_assignments/.test(owner), 'owner.js reads the owner view only');
});

check('the detector sees what it must: a literal that reads the table is counted, a write is not', () => {
  assert(STORED_READ.test('SELECT 1 FROM role_assignments WHERE a = ?'));
  assert(STORED_READ.test('SELECT 1 FROM x JOIN role_assignments ra ON ra.id = x.id'));
  assert(STORED_READ.test('DELETE FROM role_assignments WHERE a = ?'));
  assert(!STORED_READ.test('INSERT INTO role_assignments (id) VALUES (?)'));
  assert(!STORED_READ.test('SELECT 1 FROM effective_roles WHERE a = ?'));
  assert(!STORED_READ.test('SELECT 1 FROM effective_roles_stored WHERE a = ?'));
});

runChecks(checks);
