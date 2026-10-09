/**
 * PartyPlanner Web - test sharding
 *
 * A slow suite lists itself in SHARDS with a shard count. tests/run-all.js then runs it as
 * that many separate processes (`node <suite> --shard i/n`, i from 1), which can run side by
 * side, and the suite itself keeps only its slice of the work via partition(). Running the
 * suite with no --shard argument still does everything, so `node scenario-tests.js` works
 * exactly as before. shards-tests.js checks the slices are a true partition.
 */
const SHARDS = {
  'scenario-tests.js': 3,
};

/** "2/3" -> { index: 1, count: 3 } (index is 0-based), or null when no --shard was given. */
function parseShard(text) {
  if (!text) return null;
  const m = /^(\d+)\/(\d+)$/.exec(text);
  const index = m ? Number(m[1]) - 1 : -1;
  const count = m ? Number(m[2]) : 0;
  if (!m || count < 1 || index < 0 || index >= count) throw new Error(`bad --shard "${text}": expected i/n with 1 <= i <= n`);
  return { index, count };
}

/** The items of shard `shard` (round-robin, so neighbouring heavy items spread out). */
function partition(items, shard) {
  return shard ? items.filter((_, i) => i % shard.count === shard.index) : items;
}

module.exports = { SHARDS, parseShard, partition };
