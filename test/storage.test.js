const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { resetEnv } = require('./helpers');
const store = require('../src/lib/redis');
const positions = require('../src/services/positionStore');
const trades = require('../src/services/profitTracker');
const users = require('../src/services/userService');

test('old single-blob positions are migrated once, IDs kept, original backed up', async () => {
  resetEnv();
  await store.setJSON('cryptobot:positions:2000', {
    'SOLUSDT:111': { positionId: 'SOLUSDT:111', symbol: 'SOLUSDT', chatId: '2000', buyPrice: 100, stopLossPrice: 93, tp1Hit: true, addedAt: '2026-01-01T00:00:00Z' },
    'ETHUSDT:222': { positionId: 'ETHUSDT:222', symbol: 'ETHUSDT', chatId: '2000', buyPrice: 3000, addedAt: '2026-01-02T00:00:00Z' },
  });
  const all = await positions.getAllPositions('2000');
  assert.deepEqual(Object.keys(all).sort(), ['ETHUSDT:222', 'SOLUSDT:111']);
  assert.equal(all['SOLUSDT:111'].stopLossPrice, 93);
  assert.equal(all['SOLUSDT:111'].tp1Hit, true);
  assert.equal(await store.cmd('EXISTS', 'cryptobot:positions:2000'), 0, 'old key renamed');
  assert.ok(await store.getJSON('cryptobot:positions-legacy-backup:2000'), 'backup kept');
  // second read: no duplicate, same data
  assert.equal(Object.keys(await positions.getAllPositions('2000')).length, 2);
  // the quickcheck/monitor listing still finds legacy users
  resetEnv();
  await store.setJSON('cryptobot:positions:3000', { 'BTCUSDT:1': { positionId: 'BTCUSDT:1', symbol: 'BTCUSDT', chatId: '3000', buyPrice: 1 } });
  assert.equal((await positions.getAllUsersPositions()).length, 1);
});

test('simultaneous updates to different fields are all kept (no lost writes)', async () => {
  resetEnv();
  const p = await positions.addPosition({ chatId: '2000', symbol: 'SOLUSDT', buyPrice: 100 });
  // monitor + quickcheck + user command at the same moment
  await Promise.all([
    positions.updatePosition('2000', p.positionId, { tp1Hit: true }),
    positions.updatePosition('2000', p.positionId, { stopLossHit: true }),
    positions.updatePosition('2000', p.positionId, { milestoneHits: [10, 20] }),
    positions.updatePosition('2000', p.positionId, { lastChecked: 'now' }),
  ]);
  const got = await positions.getPositionById('2000', p.positionId);
  assert.equal(got.tp1Hit, true);
  assert.equal(got.stopLossHit, true);
  assert.deepEqual(got.milestoneHits, [10, 20]);
  assert.equal(got.lastChecked, 'now');
});

test('simultaneous buys are all saved', async () => {
  resetEnv();
  await Promise.all(Array.from({ length: 10 }, (_, i) => positions.addPosition({ chatId: '2000', symbol: `C${i}`, buyPrice: 1 + i })));
  assert.equal(Object.keys(await positions.getAllPositions('2000')).length, 10);
});

test('an update never brings back a position the user just removed', async () => {
  resetEnv();
  const p = await positions.addPosition({ chatId: '2000', symbol: 'SOLUSDT', buyPrice: 100 });
  await positions.removePositionById('2000', p.positionId);
  assert.equal(await positions.updatePosition('2000', p.positionId, { lastChecked: 'x' }), null);
  assert.equal(Object.keys(await positions.getAllPositions('2000')).length, 0);
  assert.equal(await store.cmd('EXISTS', `cryptobot:pos:2000:${p.positionId}`), 0);
});

test('trades: legacy list migrated in order, simultaneous records all kept', async () => {
  resetEnv();
  await store.setJSON('cryptobot:trades:2000', [{ symbol: 'OLD1', pnlPct: 1, multiple: 1, outcome: 'WIN', month: '2026-01' }, { symbol: 'OLD2', pnlPct: -1, multiple: 1, outcome: 'LOSS', month: '2026-01' }]);
  await Promise.all(Array.from({ length: 5 }, (_, i) => trades.recordTrade({ chatId: '2000', symbol: `NEW${i}`, buyPrice: 100, sellPrice: 101 })));
  const all = await trades.getAllTrades('2000');
  assert.equal(all.length, 7);
  assert.deepEqual(all.slice(0, 2).map(t => t.symbol), ['OLD1', 'OLD2'], 'old trades stay first');
  assert.ok(await store.getJSON('cryptobot:trades-legacy-backup:2000'));
});

test('users: legacy object migrated; approval and a new /start at once both survive', async () => {
  resetEnv();
  await store.setJSON('cryptobot:users', { 2000: { chatId: '2000', firstName: 'Ann', status: 'pending', requestedAt: '2026-01-01' } });
  await Promise.all([
    users.approveUser('2000'),
    users.registerUser({ chatId: '3000', firstName: 'Bob' }),
  ]);
  assert.equal((await users.getUser('2000')).status, 'approved');
  assert.equal((await users.getUser('3000')).status, 'pending');
  assert.ok(await store.getJSON('cryptobot:users-legacy-backup'));
  // re-registering an approved user does not downgrade them
  await users.registerUser({ chatId: '2000', firstName: 'Ann' });
  assert.equal((await users.getUser('2000')).status, 'approved');
});

test('Upstash REST wire format: single command and pipeline', async () => {
  resetEnv({ UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'tok' });
  const calls = [];
  axios.post = async (url, body, cfg) => {
    calls.push({ url, body, auth: cfg.headers.Authorization });
    if (url.endsWith('/pipeline')) return { data: body.map(() => ({ result: 1 })) };
    return { data: { result: 'OK' } };
  };
  assert.equal(await store.cmd('SET', 'k', 5, 'NX'), 'OK');
  assert.deepEqual(await store.pipeline([['SADD', 's', 'a'], ['HSET', 'h', 'f', 'v']]), [1, 1]);
  assert.deepEqual(calls[0], { url: 'https://example.upstash.io', body: ['SET', 'k', '5', 'NX'], auth: 'Bearer tok' });
  assert.equal(calls[1].url, 'https://example.upstash.io/pipeline');
  assert.deepEqual(calls[1].body, [['SADD', 's', 'a'], ['HSET', 'h', 'f', 'v']]);
});
