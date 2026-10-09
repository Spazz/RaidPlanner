/**
 * PartyPlanner Web - test sharding tests
 * Run: node shards-tests.js
 *
 * tests/shards.js splits a slow suite across processes. The split must be a true partition
 * (every scenario in exactly one shard, so the shards together make the same checks as one
 * whole run), the shard argument must be parsed strictly, and every sharded suite must exist
 * and actually honour --shard.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SHARDS, parseShard, partition } = require('./tests/shards');
const Scenarios = require('./scenarios.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

check('parseShard reads i/n (1-based) and returns null without an argument', () => {
  assert.equal(parseShard(''), null);
  assert.equal(parseShard(undefined), null);
  assert.equal(JSON.stringify(parseShard('1/3')), JSON.stringify({ index: 0, count: 3 }));
  assert.equal(JSON.stringify(parseShard('3/3')), JSON.stringify({ index: 2, count: 3 }));
});

check('parseShard rejects anything that is not 1 <= i <= n', () => {
  for (const bad of ['0/3', '4/3', '1/0', 'a/b', '1', '1/3/5', '-1/3', '1.5/3']) assert.throws(() => parseShard(bad), /bad --shard/, bad);
});

check('shards are a partition: every item in exactly one shard, in order, balanced within one', () => {
  for (const count of [1, 2, 3, 4, 7]) {
    const items = Scenarios.scenarios.map(s => s.id);
    const slices = Array.from({ length: count }, (_, index) => partition(items, { index, count }));
    const all = slices.flat();
    assert.equal(all.length, items.length, `count ${count}: nothing lost or doubled`);
    assert.equal(new Set(all).size, items.length, `count ${count}: no overlap`);
    assert.equal(JSON.stringify([...all].sort()), JSON.stringify([...items].sort()));
    const sizes = slices.map(s => s.length);
    assert(Math.max(...sizes) - Math.min(...sizes) <= 1, `count ${count}: sizes ${sizes}`);
    for (const slice of slices) assert.equal(JSON.stringify(slice), JSON.stringify(items.filter(id => slice.includes(id))), 'order kept');
  }
});

check('no shard argument means the whole list', () => {
  const items = [1, 2, 3, 4, 5];
  assert.equal(partition(items, null), items);
});

check('every sharded suite exists, is a suite run-all discovers, and honours --shard', () => {
  assert(Object.keys(SHARDS).length > 0);
  for (const [name, count] of Object.entries(SHARDS)) {
    assert(/^(?:.+-tests|tests|.+-scenarios)\.js$/.test(name), name);
    assert(Number.isInteger(count) && count >= 2 && count <= 6, `${name}: ${count} shards`);
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert(source.includes("require('./tests/shards')") && /parseShard\(argVal\('--shard'/.test(source) && source.includes('partition('), `${name} handles --shard`);
  }
});

check('the scenario suite is split into 3 shards with at least 20 scenarios each', () => {
  assert.equal(SHARDS['scenario-tests.js'], 3);
  for (let index = 0; index < 3; index++) assert(partition(Scenarios.scenarios, { index, count: 3 }).length >= 20);
});

console.log(`\nShard tests: ${passed} passed, 0 failed, ${passed} total`);
