const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCandles } = require('./helpers');
const { backtestStrategy } = require('../src/services/strategyBacktest');
const { evaluateSignal, trimToHourClose } = require('../src/services/scanEngine');
const { regimeAllows, applyRegime, btcTrendLookup } = require('../src/services/regime');
const { passes, signalFor, variants, GRID } = require('../research');
const { ORIGINAL, ACTIVE } = require('../src/config/strategy');

const M15 = 900_000, H1 = 3_600_000, H4 = 14_400_000, D1 = 86_400_000;
const T0 = Date.UTC(2026, 0, 10);
const small = { windows: { h4: 2, h1: 2, m15: 2 }, feePct: 0, slippagePct: 0 };
const flat = (n, ms, start) => Array.from({ length: n }, (_, i) => ({ time: start + i * ms, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1 }));

function capturedBuyWindows() {
  const c15m = makeCandles(4000, { intervalMs: M15, seed: 11, drift: 0.0004, vol: 0.006 }).map(c => ({ ...c, time: c.time + 270 * H4 }));
  const c1h = makeCandles(1400, { seed: 12, drift: 0.001 });
  const c4h = makeCandles(600, { intervalMs: H4, seed: 13, drift: 0.003 });
  let found = null;
  backtestStrategy({ c4h, c1h, c15m }, {
    strategy: { ...ORIGINAL, minHoursBetweenEntries: 0 },
    evaluate: (w4, w1, w15) => {
      if (!found) { const s = evaluateSignal(w4, w1, w15); if (s.signal === 'BUY') found = [w4, w1, w15]; }
      return { signal: 'WAIT' };
    },
  });
  return found;
}

test('the live default is still the original strategy until you change the config', () => {
  assert.deepEqual({ ...ACTIVE }, { ...ORIGINAL });
});

test('engine stop multiplier widens the stop and the targets proportionally', () => {
  const w = capturedBuyWindows();
  assert.ok(w, 'synthetic data should contain at least one BUY');
  const a = evaluateSignal(...w);
  const b = evaluateSignal(...w, { stopAtrMult: 3 });
  assert.equal(a.signal, 'BUY'); assert.equal(b.signal, 'BUY');
  const riskA = a.price - a.stopLoss, riskB = b.price - b.stopLoss;
  assert.ok(Math.abs(riskB / riskA - 2) < 1e-3);
  assert.ok(Math.abs((b.takeProfits.tp1.price - b.price) / riskB - 1.5) < 1e-3);
  assert.equal(b.stopAtrMult, 3);
});

test('market filters', () => {
  assert.equal(regimeAllows('none', {}), true);
  assert.equal(regimeAllows('coinTrend', { coinTrendUp: false }), false);
  assert.equal(regimeAllows('btcTrend', { btcUp: undefined }), false, 'unknown BTC trend blocks (safe side)');
  assert.equal(regimeAllows('both', { coinTrendUp: true, btcUp: true }), true);
  const blocked = applyRegime({ signal: 'BUY', coinTrendUp: true, factors: [] }, 'btcTrend', false);
  assert.equal(blocked.signal, 'WAIT');
  assert.match(blocked.factors.at(-1), /BTC is below its daily EMA50/);
});

test('BTC daily trend only uses days that have closed', () => {
  // 60 rising days, then the price crashes on the last day
  const days = Array.from({ length: 61 }, (_, i) => ({ time: T0 + i * D1, open: 100 + i, high: 101 + i, low: 99 + i, close: i === 60 ? 50 : 100 + i }));
  const upAt = btcTrendLookup(days);
  const lastDayOpen = days[60].time;
  assert.equal(upAt(lastDayOpen + 12 * H1), true, 'crash day has not closed yet → still uses previous day');
  assert.equal(upAt(lastDayOpen + D1), false, 'after the crash day closes → down');
});

test('decide on 1h: live scanner trims to the last hourly close', () => {
  const c = flat(10, M15, Date.UTC(2026, 0, 1, 10, 0)); // 10:00 … 12:15 opens
  const trimmed = trimToHourClose(c);
  const last = trimmed[trimmed.length - 1];
  assert.equal((last.time + M15) % H1, 0);
});

test('decide on 1h: backtest only acts on hourly closes', () => {
  const times = [];
  const c15m = flat(40, M15, T0);
  backtestStrategy({ c4h: flat(20, H4, T0 - 15 * H4), c1h: flat(40, H1, T0 - 30 * H1), c15m }, {
    ...small, strategy: { ...ORIGINAL, decideOn: '1h' },
    evaluate: (a, b, c, { decisionTime }) => { times.push(decisionTime); return { signal: 'WAIT' }; },
  });
  assert.ok(times.length > 5);
  for (const t of times) assert.equal(t % H1, 0);
});

test('minimum gap between entries is enforced (matches live alert dedup)', () => {
  // BUY signal on every bar; first trade stops out immediately
  const c15m = [...flat(4, M15, T0), { time: T0 + 4 * M15, open: 100, high: 100.1, low: 97, close: 97.5, volume: 1 }, ...flat(30, M15, T0 + 5 * M15)];
  const data = { c4h: flat(20, H4, T0 - 15 * H4), c1h: flat(40, H1, T0 - 30 * H1), c15m };
  const evaluate = () => ({ signal: 'BUY', score: 8, stopLoss: 98, takeProfits: { tp1: { price: 103 }, tp2: { price: 105 }, tp3: { price: 108 } } });
  const run = (gap) => backtestStrategy(data, { ...small, evaluate, strategy: { ...ORIGINAL, minHoursBetweenEntries: gap } }).trades;
  const noGap = run(0), gap4 = run(4);
  assert.ok(Date.parse(noGap[1].signalTime) - Date.parse(noGap[0].signalTime) < 4 * H1);
  assert.ok(Date.parse(gap4[1].signalTime) - Date.parse(gap4[0].signalTime) >= 4 * H1);
});

test('regime filter applied inside the backtest', () => {
  const data = { c4h: flat(20, H4, T0 - 15 * H4), c1h: flat(40, H1, T0 - 30 * H1), c15m: flat(30, M15, T0) };
  const evaluate = () => ({ signal: 'BUY', score: 8, coinTrendUp: false, stopLoss: 98, takeProfits: { tp1: { price: 103 }, tp2: { price: 105 }, tp3: { price: 108 } } });
  const none = backtestStrategy(data, { ...small, evaluate, strategy: { ...ORIGINAL, regime: 'none' } }).trades;
  const filtered = backtestStrategy(data, { ...small, evaluate, strategy: { ...ORIGINAL, regime: 'coinTrend' } }).trades;
  assert.ok(none.length > 0);
  assert.equal(filtered.length, 0);
});

test('research: 48 variants including the original; pass rule is strict', () => {
  const all = [...variants()];
  assert.equal(all.length, GRID.decideOn.length * GRID.stopAtrMult.length * GRID.regime.length * GRID.minHoursBetweenEntries.length);
  assert.ok(all.some(v => v.decideOn === ORIGINAL.decideOn && v.stopAtrMult === ORIGINAL.stopAtrMult && v.regime === ORIGINAL.regime && v.minHoursBetweenEntries === ORIGINAL.minHoursBetweenEntries));
  const good = { trades: 80, expectancyR: 0.12, profitFactor: 1.25, expectancyRange95: [0.01, 0.23] };
  assert.equal(passes(good), true);
  assert.equal(passes({ ...good, expectancyRange95: [-0.02, 0.26] }), false, 'range touching zero fails');
  assert.equal(passes({ ...good, trades: 30 }), false);
  assert.equal(passes({ ...good, expectancyR: 0.03 }), false);
});

test('research: precomputed signal rebuilds stop and targets for each multiplier', () => {
  const buys = new Map([[1000, { score: 8, price: 100, atr: 2, coinTrendUp: true }]]);
  const s = signalFor(buys, 2.5)(0, 1000);
  assert.equal(s.stopLoss, 95);
  assert.equal(s.takeProfits.tp1.price, 107.5);
  assert.equal(signalFor(buys, 2.5)(0, 999), null);
});
