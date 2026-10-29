const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCandles, mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');
const { evaluatePosition } = require('../api/v2monitor');
const { evaluateQuick } = require('../api/v2quickcheck');

const market = (price) => ({ candles1h: makeCandles(100), candles4h: makeCandles(250, { intervalMs: 14_400_000 }), currentPrice: price });
const TPS = { tp1: { price: 110, ratio: '1.5R' }, tp2: { price: 120, ratio: '2.5R' }, tp3: { price: 140, ratio: '4R' } };
const pos = (over = {}) => ({
  positionId: 'SOLUSDT:1', symbol: 'SOLUSDT', chatId: '2000', buyPrice: 100, stopLossPrice: 93,
  stopStage: 'initial', takeProfits: TPS, milestoneHits: [10, 20, 30, 40, 50], lastHoldAlertAt: new Date().toISOString(), ...over,
});

test('after TP1 the saved stop moves to breakeven, and a return to entry alerts', () => {
  const r = evaluatePosition(pos(), market(111));
  assert.equal(r.recommendation, 'TP1');
  assert.equal(r.updates.stopLossPrice, 100);
  assert.equal(r.updates.stopStage, 'breakeven');

  const after = pos({ ...r.updates, tp1Hit: true });
  const hit = evaluatePosition(after, market(99.8));
  assert.equal(hit.recommendation, 'STOP_LOSS');
  assert.match(hit.messages[0].text, /BREAKEVEN STOP/);
  // The old behaviour (stop still at 93) would have said nothing here.
});

test('after TP2 the stop moves to TP1; quickcheck watches the moved stop', () => {
  const r = evaluatePosition(pos({ tp1Hit: true, stopLossPrice: 100, stopStage: 'breakeven' }), market(121));
  assert.equal(r.recommendation, 'TP2');
  assert.equal(r.updates.stopLossPrice, 110);
  const q = evaluateQuick(pos({ tp1Hit: true, tp2Hit: true, stopLossPrice: 110, stopStage: 'tp1' }), 109.5);
  assert.equal(q.event, 'STOP_LOSS');
  assert.match(q.text, /PROFIT STOP/);
});

test('stops only move up — a higher user stop is never loosened', () => {
  const r = evaluatePosition(pos({ stopLossPrice: 104, stopStage: 'user' }), market(111));
  assert.equal(r.recommendation, 'TP1');
  assert.equal(r.updates.stopLossPrice, undefined);
});

async function say(text, chatId = '1000') {
  const res = fakeRes();
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: Number(chatId) }, from: { first_name: 'T' }, text } } }), res);
}

test('buy with your own stop: saved as-is, targets built from it', async () => {
  resetEnv();
  mockNet({ price: 101 });
  const store = require('../src/services/positionStore');
  await say('buy SOL 100 2x sl 95');
  const [p] = await store.getPositionsBySymbol('1000', 'SOLUSDT');
  assert.equal(p.stopLossPrice, 95);
  assert.equal(p.stopSource, 'user');
  assert.equal(p.targetMultiple, 2, 'target still parsed');
  assert.equal(p.takeProfits.tp1.price, 107.5); // 100 + 1.5 × (100 − 95)
});

test('buy with a stop above the buy price is rejected', async () => {
  resetEnv();
  const net = mockNet({ price: 101 });
  const store = require('../src/services/positionStore');
  await say('buy SOL 100 sl 105');
  assert.equal((await store.getPositionsBySymbol('1000', 'SOLUSDT')).length, 0);
  assert.match(net.sent[0].text, /must be below your buy price/);
});

test('setstop: updates one entry, asks which when there are several, refuses a stop above price', async () => {
  resetEnv();
  const net = mockNet({ price: 110 });
  const store = require('../src/services/positionStore');
  await say('buy SOL 100');
  await say('setstop SOL 104');
  let [p] = await store.getPositionsBySymbol('1000', 'SOLUSDT');
  assert.equal(p.stopLossPrice, 104);
  assert.equal(p.stopStage, 'user');

  await say('setstop SOL 115');
  [p] = await store.getPositionsBySymbol('1000', 'SOLUSDT');
  assert.equal(p.stopLossPrice, 104, 'stop above live price refused');
  assert.match(net.sent.at(-1).text, /must be below the current price/);

  await say('buy SOL 95');
  await say('setstop SOL 99');
  assert.match(net.sent.at(-1).text, /which one/);
  const second = (await store.getPositionsBySymbol('1000', 'SOLUSDT'))[1];
  await say(`setstopid ${second.positionId} 99`);
  assert.equal((await store.getPositionById('1000', second.positionId)).stopLossPrice, 99);
});
