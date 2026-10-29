const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCandles, mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const market = (price) => ({
  candles1h: makeCandles(100),
  candles4h: makeCandles(250, { intervalMs: 14_400_000 }),
  currentPrice: price,
});
const TPS = { tp1: { price: 110, ratio: '1.5R' }, tp2: { price: 120, ratio: '2.5R' }, tp3: { price: 140, ratio: '4R' } };
const basePos = (over = {}) => ({
  positionId: 'SOLUSDT:1', symbol: 'SOLUSDT', chatId: '2000', buyPrice: 100,
  stopLossPrice: 93, takeProfits: TPS, milestoneHits: [], addedAt: new Date().toISOString(), ...over,
});

test('HOLD fires every 4h even though the monitor runs every 30 min', () => {
  const { evaluatePosition } = require('../api/v2monitor');
  const now = Date.now();
  const recent = new Date(now - 30 * 60_000).toISOString();

  // Old bug: lastChecked was refreshed every run, so this never fired.
  let r = evaluatePosition(basePos({ lastChecked: recent, lastHoldAlertAt: null }), market(101), now);
  assert.equal(r.recommendation, 'HOLD');
  assert.equal(r.alerted, true);
  assert.equal(r.messages[0].silent, true);

  r = evaluatePosition(basePos({ lastChecked: recent, lastHoldAlertAt: recent }), market(101), now);
  assert.equal(r.alerted, false);
});

test('locked stop is used (no drift) and fires the stop-loss alert', () => {
  const { evaluatePosition } = require('../api/v2monitor');
  const r = evaluatePosition(basePos(), market(92.5));
  assert.equal(r.recommendation, 'STOP_LOSS');
  assert.equal(r.updates.stopLossHit, true);
  assert.match(r.messages[0].text, /\$93\.0/);
});

test('jumping past several milestones alerts once and marks all of them', () => {
  const { evaluatePosition } = require('../api/v2monitor');
  const r = evaluatePosition(basePos({ takeProfits: { tp1: { price: 500 }, tp2: { price: 600 }, tp3: { price: 700 } } }), market(135));
  assert.deepEqual(r.updates.milestoneHits, [10, 20, 30]);
  assert.equal(r.messages.filter(m => /MILESTONE/.test(m.text)).length, 1);
});

test('jumping straight to TP3 marks TP1 and TP2 as hit', () => {
  const { evaluatePosition } = require('../api/v2monitor');
  const r = evaluatePosition(basePos({ milestoneHits: [10, 20, 30, 40] }), market(141));
  assert.equal(r.recommendation, 'TP3');
  assert.equal(r.updates.tp1Hit, true);
  assert.equal(r.updates.tp2Hit, true);
});

test('position alerts go only to the owner, never the shared info channel', async () => {
  resetEnv({ TELEGRAM_INFO_CHANNEL_ID: '-100999' });
  const net = mockNet({ price: 135 });
  const users = require('../src/services/userService');
  const store = require('../src/services/positionStore');

  await users.registerUser({ chatId: '2000', firstName: 'Ann' });
  await users.approveUser('2000');
  await store.addPosition({ chatId: '2000', symbol: 'SOLUSDT', buyPrice: 100 });

  const res = fakeRes();
  await require('../api/v2monitor')(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.ok(net.sent.length > 0);
  for (const m of net.sent) {
    assert.notEqual(String(m.chat_id), '-100999', 'nothing goes to the shared channel');
    // The admin also gets the daily auto-buy report (and the house account's buys)
    if (String(m.chat_id) === '1000') assert.match(m.text, /Auto-buy daily check|HOUSE forward test/);
    else assert.equal(String(m.chat_id), '2000');
  }
  assert.ok(net.sent.some(m => String(m.chat_id) === '2000'), 'the owner gets their alert');

  const [pos] = Object.values(await store.getAllPositions('2000'));
  assert.ok(pos.stopLossPrice > 0, 'plan locked on first monitor run');
  assert.ok(pos.lastChecked);
});

test('quickcheck "approaching target" fires once, not every run', () => {
  const { evaluateQuick } = require('../api/v2quickcheck');
  const pos = basePos({ targetPrice: 200, targetMultiple: 2 });
  const first = evaluateQuick(pos, 195);
  assert.equal(first.event, 'APPROACHING_TARGET');
  const second = evaluateQuick({ ...pos, ...first.updates }, 196);
  assert.equal(second, null);
  const hit = evaluateQuick({ ...pos, ...first.updates }, 201);
  assert.equal(hit.event, 'TARGET_HIT');
});

test('v2moonshot alerts on the real "probability" field', async () => {
  resetEnv();
  const net = mockNet();
  const listings = require('../src/services/listingsService');
  listings.getMoonshots = async () => [
    { base: 'ABC', price: 0.5, change24h: 25, volume: 4e6, probability: 78, band: 'HIGH', greenSignals: ['Volume accelerating'], redFlags: [], meta: { name: 'Abc_Coin' } },
    { base: 'LOW', price: 1, change24h: 10, volume: 2e6, probability: 60, band: 'MODERATE', greenSignals: [], redFlags: [] },
  ];
  const handler = require('../api/v2moonshot');
  let res = fakeRes();
  await handler(fakeReq(), res);
  assert.deepEqual(res.body.alerted, ['ABC']);
  assert.equal(net.sent.length, 1);
  assert.match(net.sent[0].text, /Volume accelerating/);

  res = fakeRes();
  await handler(fakeReq(), res); // dedup within 6h
  assert.deepEqual(res.body.alerted, []);
});
