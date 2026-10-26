/**
 * Raidsmith guild tracker - lane B4b of the user-hierarchy build: the Owner seat test and the Owner-only gates (worker/owner.js)
 * Run: node tests/guild/guild-b4b-owner-tests.js
 *
 * ONE isOwner(guild, user), seat test only (the suspension term is lane B6b's): guilds.owner_user_id = the account; while owner_user_id IS NULL (every guild before
 * the flip) the holder of the stored guild_master row. Checked here:
 *   - the matrix of that test over a legacy guild (the stored Guild Master is the Owner) and a guild whose seat is set (a Guild Master by role who does not hold the
 *     seat is a DERIVED Guild Master: not the Owner);
 *   - worker/seniority.js uses the same fragment (no second copy anywhere in worker/), and the two agree on every account;
 *   - the Owner-only acts that exist today, one test per gate with a derived-GM non-Owner principal (refused, nothing changes) and the Owner (allowed): the hand-over
 *     of the Guild Master and the guild delete. An Officer who holds guild.roles is refused too. (The three rank-map routes have their gate test in guild-b4b-rankmap-tests.js.)
 * The "suspended Owner" assertions of these gates belong to lane B6b's acceptance (suspension exists only for an in-game guild's Owner, and B6b adds the term).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, runChecks, scenario } = require('../guild-b3-world');

const ROOT = path.join(__dirname, '..', '..');
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// A guild with a Guild Master (the creator), an Officer, a plain member 'own' (the account that will hold the Owner seat) and one more member.
async function world() {
  const s = await scenario();
  await s.member('own', 'Ownerseat');
  await s.officer('off', 'Officerone');
  await s.member('mem', 'Plainmember');
  return s;
}

async function ownerOf(s, key) {
  const { isOwner, ownerGuard } = await load('worker/owner.js');
  const viaHelper = await isOwner(s.w.db, s.gid, s.uids[key]);
  const guard = ownerGuard(s.gid, s.uids[key]);
  const viaSql = (await s.w.db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first()).ok === 1;
  assert.equal(viaHelper, viaSql, `${key}: the helper and the guard agree`);
  return viaHelper;
}

check('isOwner, a legacy guild (owner_user_id NULL): only the holder of the stored Guild Master row is the Owner', async () => {
  const s = await world();
  assert.equal((await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id, null);
  assert.deepEqual(await Promise.all(['gm', 'own', 'off', 'mem'].map((key) => ownerOf(s, key))), [true, false, false, false]);
});

check('isOwner, a guild with its seat set: the seat holder is the Owner, a Guild Master by role who does not hold it is a derived Guild Master and is not', async () => {
  const s = await world();
  await s.setOwner('own');
  assert.deepEqual(await Promise.all(['gm', 'own', 'off', 'mem'].map((key) => ownerOf(s, key))), [false, true, false, false]);
  // The stored Guild Master row still gives the rank (Guild Master permission) - it just is not the Owner.
  assert.equal((await s.ok('gm', 'GET', '')).me.roles.some((role) => role.role === 'guild_master'), true);
  // The seat can sit with the Guild Master too, and moves with the column alone.
  await s.setOwner('gm');
  assert.deepEqual(await Promise.all(['gm', 'own'].map((key) => ownerOf(s, key))), [true, false]);
  await s.setOwner(null);
  assert.deepEqual(await Promise.all(['gm', 'own'].map((key) => ownerOf(s, key))), [true, false], 'back to NULL: the stored Guild Master again');
  // A guild with no seat and no stored Guild Master has no Owner at all.
  s.exec(`DELETE FROM role_assignments WHERE guild_id = '${s.gid}' AND role_id = 'guild_master'`);
  assert.deepEqual(await Promise.all(['gm', 'own', 'off'].map((key) => ownerOf(s, key))), [false, false, false]);
});

check('ONE copy of the seat test: worker/seniority.js builds its Owner term from worker/owner.js, and no other file of worker/ spells the test out', async () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!entry.name.endsWith('.js') || rel === 'worker/owner.js') continue;
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join('\n');
      if (/\bowner_user_id\b/.test(text)) offenders.push(rel);
    }
  };
  walk('worker');
  assert.deepEqual(offenders, [], 'only worker/owner.js reads guilds.owner_user_id (the sync, flip and claim lanes that WRITE the seat add their own entries here on purpose)');
  const seniority = fs.readFileSync(path.join(ROOT, 'worker/seniority.js'), 'utf8').split(/\r?\n/).join('\n');
  assert(/import \{ ownerSql \} from '\.\/owner\.js';/.test(seniority) && /ownerSql\('s\.gid', user\)/.test(seniority));
});

check('the Seniority guard and isOwner agree about the Owner on every account, in a legacy guild and with the seat set', async () => {
  const { seniorityOk } = await load('worker/seniority.js');
  const s = await world();
  const people = {};
  for (const key of ['gm', 'own', 'off', 'mem']) {
    people[key] = await s.person({ name: `Person${key}` });
    await s.link(people[key].pid, key);
  }
  // The guard's rule for a target that IS the Owner's person: only the Owner passes it (an equal or senior rank is refused, a derived Guild Master included), so it reads
  // the Owner term through the guard.
  const mayTouch = async (actor, target) => {
    const guard = seniorityOk(s.gid, s.uids[actor], people[target].pid);
    return (await s.w.db.prepare(`SELECT ${guard.sql} AS ok`).bind(...guard.params).first()).ok === 1;
  };
  for (const seat of [null, 'own', 'gm']) {
    await s.setOwner(seat);
    const owner = seat || 'gm';
    for (const actor of ['gm', 'own', 'off', 'mem']) {
      assert.equal(await mayTouch(actor, owner), await ownerOf(s, actor), `${actor} on the Owner's person (seat ${seat})`);
    }
  }
});

// ---------------------------------------------------------------------------
// The gates. "Derived Guild Master" = the stored Guild Master row, with the seat on another account.

check('gate: handing over the Guild Master is the Owner\'s - a Guild Master by role who does not hold the seat is refused and nothing changes; the Owner may', async () => {
  const s = await world();
  await s.setOwner('own');
  const refused = await s.fail('gm', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  assert(/Owner/.test(refused.message), refused.message);
  assert.equal((await s.one("SELECT user_id FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.gid)).user_id, s.uids.gm, 'the Guild Master row is where it was');
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'guild_master.transfer'")).length, 0);
  await s.fail('off', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  // The Owner (the seat sits with the Guild Master): allowed.
  await s.setOwner('gm');
  await s.ok('gm', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 200);
  assert.equal((await s.one("SELECT user_id FROM role_assignments WHERE guild_id = ? AND role_id = 'guild_master'", s.gid)).user_id, s.uids.mem);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'guild_master.transfer'")).length, 1);
});

check('gate: handing over in a legacy guild (no seat yet) is the stored Guild Master\'s, as it always was', async () => {
  const s = await world();
  await s.fail('off', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  await s.ok('gm', 'POST', `/people/${s.uids.own}/guild-master`, {}, 200);
});

check('gate: deleting the guild is the Owner\'s - a derived Guild Master with the right name typed is refused and the guild stays; the Owner deletes it', async () => {
  const s = await world();
  await s.setOwner('own');
  const name = (await s.one('SELECT name FROM guilds WHERE id = ?', s.gid)).name;
  const refused = await s.fail('gm', 'DELETE', '', { confirmName: name }, 403, 'forbidden');
  assert(/Owner/.test(refused.message), refused.message);
  await s.fail('off', 'DELETE', '', { confirmName: name }, 403, 'forbidden');
  assert.equal((await s.rows('SELECT id FROM guilds WHERE id = ?', s.gid)).length, 1);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'guild.delete'")).length, 0);
  // The seat holder can delete it even without a stored Guild Master row of their own... here they are a plain member, so they also need to be allowed in.
  await s.setOwner('gm');
  await s.ok('gm', 'DELETE', '', { confirmName: name }, 200);
  assert.equal((await s.rows('SELECT id FROM guilds WHERE id = ?', s.gid)).length, 0);
});

runChecks(checks);
