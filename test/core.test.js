const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCandles, mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

test('advice: 4H trend is computed (was always UNKNOWN)', async () => {
  resetEnv();
  mockNet({ price: 120 });
  const { fetchCurrentData, buildAdvice } = require('../src/services/adviceService');
  const data = await fetchCurrentData('SOLUSDT');
  assert.equal(data.candles4h.length, 250);
  const advice = buildAdvice({ symbol: 'SOLUSDT', buyPrice: 100, ...data });
  assert.notEqual(advice.indicators.macroTrend, 'UNKNOWN');
});

test('advice: locked plan is reused instead of recalculated', () => {
  const { buildAdvice } = require('../src/services/adviceService');
  const tps = { tp1: { price: 110, ratio: '1.5R' }, tp2: { price: 120, ratio: '2.5R' }, tp3: { price: 140, ratio: '4R' } };
  const advice = buildAdvice({
    symbol: 'X', buyPrice: 100, currentPrice: 101,
    candles1h: makeCandles(100), candles4h: makeCandles(250, { intervalMs: 14_400_000 }),
    lockedPlan: { stopLoss: 93.33, takeProfits: tps },
  });
  assert.equal(advice.tradePlan.stopLoss, 93.33);
  assert.equal(advice.tradePlan.takeProfits.tp2.price, 120);
  assert.equal(advice.tradePlan.locked, true);
});

test('telegram: Markdown parse error is retried as plain text', async () => {
  resetEnv();
  let attempts = 0;
  const net = mockNet({
    telegram: (method, payload) => {
      if (method !== 'sendMessage') return null;
      attempts++;
      if (payload.parse_mode) return { status: 400, data: { ok: false, description: "Bad Request: can't parse entities: Can't find end of the entity" } };
      return { status: 200, data: { ok: true, result: {} } };
    },
  });
  const tg = require('../src/lib/telegram');
  await tg.send('1000', 'Coin *with_bad markdown');
  assert.equal(attempts, 2);
  assert.equal(net.sent.length, 1);
  assert.equal(net.sent[0].parse_mode, undefined);
});

test('profit tracker: previous month is correct on the 31st', () => {
  const { previousMonth } = require('../src/services/profitTracker');
  assert.equal(previousMonth(new Date('2026-03-31T12:00:00Z')), '2026-02');
  assert.equal(previousMonth(new Date('2026-01-15T12:00:00Z')), '2025-12');
});

test('dedup survives (stored, not in-process only)', async () => {
  resetEnv();
  const risk = require('../src/services/riskService');
  assert.equal(await risk.isDuplicateSignal('SOLUSDT', 'BUY'), false);
  assert.equal(await risk.claimSignal('SOLUSDT', 'BUY'), true);
  assert.equal(await risk.isDuplicateSignal('SOLUSDT', 'BUY'), true);
  assert.equal(await risk.claimSignal('SOLUSDT', 'BUY'), false, 'second claim within cooldown is refused');
  await risk.releaseSignal('SOLUSDT', 'BUY');
  assert.equal(await risk.claimSignal('SOLUSDT', 'BUY'), true, 'released claim can be taken again');
});

test('v2advice endpoint accepts account/risk aliases', async () => {
  resetEnv();
  mockNet({ price: 105 });
  const handler = require('../api/v2advice');
  const res = fakeRes();
  await handler(fakeReq({ query: { symbol: 'sol', buyPrice: '100', account: '1000', risk: '2' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.advice.symbol, 'SOLUSDT');
  assert.equal(res.body.advice.positionSizing.riskPercent, 2);
});
