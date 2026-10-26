/**
 * Raidsmith guild tracker - lane B4b of the user-hierarchy build: the Owner seat test and the Owner-only gates (worker/owner.js)
 * Run: node tests/guild/guild-b4b-owner-tests.js
 *
 * ONE isOwner(guild, user) (lane B6b: it reads the owner row of the effective-roles view, so suspension is part of it): guilds.owner_user_id while not suspended; while
 * owner_user_id IS NULL and rank_source IS NULL (every guild before the flip) the holder of the stored guild_master row. Checked here:
 *   - the matrix of that test over a legacy guild (the stored Guild Master is the Owner) and a guild whose seat is set (the stored Guild Master row stops counting; a
 *     Guild Master by role who does not hold the seat is a DERIVED Guild Master, which only an in-game guild has: tests/guild/guild-b6b-*-tests.js);
 *   - worker/seniority.js uses the same fragment (no second copy anywhere in worker/), and the two agree on every account;
 *   - the Owner-only acts that exist today, one test per gate with a derived-GM non-Owner principal (refused, nothing changes) and the Owner (allowed): the hand-over
 *     of the Guild Master and the guild delete. An Officer who holds guild.roles is refused too. (The three rank-map routes have their gate test in guild-b4b-rankmap-tests.js;
 *     every gate with a suspended Owner is in guild-b6b-gates-tests.js.)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, runChecks, scenario } = require('../guild-b3-world');
const { ingameize } = require('../guild-ingame');

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
  // The stored Guild Master row stops counting once the seat is set (review finding B4b/B5 F1): the former Guild Master is a plain member until a derived rank says otherwise.
  assert.equal((await s.ok('gm', 'GET', '')).me.roles.some((role) => role.role === 'guild_master'), false);
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
// The gates. "Derived Guild Master" = an account on in-game rank 0 (Guild Master in the rank map) who does not hold the seat; the Owner is live (a Battle.net-proven character).

// An in-game guild: 'own' holds the seat (live), 'dgm' is a derived Guild Master, 'off' a stored Officer, 'mem' a plain member; everyone is bound to the roster.
async function ingameWorld() {
  const s = await world();
  await s.member('dgm', 'Derivedgm');
  const people = {};
  for (const key of ['gm', 'own', 'dgm', 'off', 'mem']) {
    people[key] = await s.person({ name: `Person${key}` });
    await s.link(people[key].pid, key);
  }
  ingameize(s, { owner: 'own', derivedGm: 'dgm', people });
  s.people = people;
  return s;
}

check('gate: handing over the Guild Master is an Owner act - a derived Guild Master and an Officer are refused and nothing changes; the Owner gets past the gate', async () => {
  const s = await ingameWorld();
  const refused = await s.fail('dgm', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  assert(/Owner/.test(refused.message), refused.message);
  await s.fail('off', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'guild_master.transfer'")).length, 0);
  assert.equal((await s.one('SELECT owner_user_id FROM guilds WHERE id = ?', s.gid)).owner_user_id, s.uids.own, 'the seat is where it was');
  // The Owner passes the gate. (The swap itself still moves the stored Guild Master row, which an in-game guild no longer has: lane B6b part 2 replaces it, so the Owner
  // meets the conflict answer of the swap here, not a refusal.)
  const res = await s.call('own', 'POST', `/people/${s.uids.mem}/guild-master`, {});
  assert.notEqual(res.status, 403, res.text);
});

check('gate: handing over in a legacy guild (no seat yet) is the stored Guild Master act, as it always was', async () => {
  const s = await world();
  await s.fail('off', 'POST', `/people/${s.uids.mem}/guild-master`, {}, 403, 'forbidden');
  await s.ok('gm', 'POST', `/people/${s.uids.own}/guild-master`, {}, 200);
});

check('gate: deleting the guild is an Owner act - a derived Guild Master with the right name typed is refused and the guild stays; the Owner deletes it', async () => {
  const s = await ingameWorld();
  const name = (await s.one('SELECT name FROM guilds WHERE id = ?', s.gid)).name;
  const refused = await s.fail('dgm', 'DELETE', '', { confirmName: name }, 403, 'forbidden');
  assert(/Owner/.test(refused.message), refused.message);
  await s.fail('off', 'DELETE', '', { confirmName: name }, 403, 'forbidden');
  assert.equal((await s.rows('SELECT id FROM guilds WHERE id = ?', s.gid)).length, 1);
  assert.equal((await s.rows("SELECT id FROM audit_log WHERE action = 'guild.delete'")).length, 0);
  await s.ok('own', 'DELETE', '', { confirmName: name }, 200);
  assert.equal((await s.rows('SELECT id FROM guilds WHERE id = ?', s.gid)).length, 0);
});

runChecks(checks);
