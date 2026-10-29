const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCandles, mockNet, resetEnv } = require('./helpers');
const { backtestStrategy } = require('../src/services/strategyBacktest');
const { computeStats, wilson, formatTrackRecord, trackRecordFor, _clearCache } = require('../src/services/strategyStats');
const { WINDOWS, evaluateSignal } = require('../src/services/scanEngine');

const M15 = 900_000, H1 = 3_600_000, H4 = 14_400_000;
const T0 = Date.UTC(2026, 0, 10);

/** Flat history + scripted 15m bars. Signal fires at the close of bar index `sigAt`. */
function scenario(bars, { sigAt = 3, plan = { stop: 98, tp1: 103, tp2: 105, tp3: 108 } } = {}) {
  const flat = (n, ms, start) => Array.from({ length: n }, (_, i) => ({ time: start + i * ms, open: 100, high: 100.2, low: 99.8, close: 100, volume: 1 }));
  const c15m = [...flat(sigAt + 1, M15, T0), ...bars.map((b, i) => ({ time: T0 + (sigAt + 1 + i) * M15, volume: 1, ...b }))];
  const c1h = flat(40, H1, T0 - 30 * H1);
  const c4h = flat(20, H4, T0 - 15 * H4);
  let fired = false;
  const evaluate = (w4, w1, w15, { decisionTime }) => {
    const last = w15[w15.length - 1];
    if (fired || last.time !== c15m[sigAt].time) return { signal: 'WAIT' };
    fired = true;
    return {
      signal: 'BUY', score: 9, stopLoss: plan.stop,
      takeProfits: { tp1: { price: plan.tp1 }, tp2: { price: plan.tp2 }, tp3: { price: plan.tp3 } },
    };
  };
  return { data: { c4h, c1h, c15m }, evaluate };
}
const small = { windows: { h4: 2, h1: 2, m15: 2 }, feePct: 0, slippagePct: 0 };
const bar = (open, high, low, close) => ({ open, high, low, close });

test('full plan to TP3 = 0.4×1.5R + 0.35×2.5R + 0.25×4R = 2.475R (no costs)', () => {
  const { data, evaluate } = scenario([bar(100, 101, 99.5, 100.5), bar(100.5, 104, 100, 103.5), bar(103.5, 106, 103, 105.5), bar(105.5, 109, 105, 108.5)]);
  const r = backtestStrategy(data, { ...small, evaluate });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entry, 100, 'enters at the NEXT bar open');
  assert.equal(t.exitReason, 'TP3');
  assert.ok(Math.abs(t.r - 2.475) < 1e-6, `r=${t.r}`);
});

test('TP1 then back to entry → breakeven stop keeps +0.6R', () => {
  const { data, evaluate } = scenario([bar(100, 103.5, 99.5, 103), bar(103, 103.2, 99.9, 100.5)]);
  const t = backtestStrategy(data, { ...small, evaluate }).trades[0];
  assert.equal(t.exitReason, 'BREAKEVEN_STOP');
  assert.ok(Math.abs(t.r - 0.6) < 1e-6, `r=${t.r}`);
});

test('TP2 then pullback → stop at TP1 keeps 0.4×1.5 + 0.35×2.5 + 0.25×1.5 = 1.85R', () => {
  const { data, evaluate } = scenario([bar(100, 105.5, 99.5, 105), bar(105, 105.2, 102.5, 102.8)]);
  const t = backtestStrategy(data, { ...small, evaluate }).trades[0];
  assert.equal(t.exitReason, 'STOP_AT_TP1');
  assert.ok(Math.abs(t.r - 1.85) < 1e-6, `r=${t.r}`);
});

test('candle touching stop AND target counts as a loss (conservative)', () => {
  const { data, evaluate } = scenario([bar(100, 104, 97, 101)]);
  const t = backtestStrategy(data, { ...small, evaluate }).trades[0];
  assert.equal(t.exitReason, 'STOP_LOSS');
  assert.ok(Math.abs(t.r + 1) < 1e-6);
});

test('gap below the stop fills at the open, not the stop', () => {
  const { data, evaluate } = scenario([bar(100, 100.5, 99.5, 100), bar(95, 96, 94, 95.5)]);
  const t = backtestStrategy(data, { ...small, evaluate }).trades[0];
  assert.equal(t.exits[0].price, 95);
  assert.ok(Math.abs(t.r + 2.5) < 1e-6, `r=${t.r}`);
});

test('fees and slippage are charged (same path earns less)', () => {
  const path = [bar(100, 101, 99.5, 100.5), bar(100.5, 104, 100, 103.5), bar(103.5, 106, 103, 105.5), bar(105.5, 109, 105, 108.5)];
  const a = scenario(path), b = scenario(path);
  const free = backtestStrategy(a.data, { ...small, evaluate: a.evaluate }).trades[0];
  const costly = backtestStrategy(b.data, { ...small, feePct: 0.1, slippagePct: 0.05, evaluate: b.evaluate }).trades[0];
  assert.ok(costly.r < free.r);
  assert.ok(costly.entry > 100, 'entry slippage applied');
  // a full stop costs more than 1R once costs are included
  const c = scenario([bar(100, 100.5, 97.5, 98)]);
  const loss = backtestStrategy(c.data, { ...small, feePct: 0.1, slippagePct: 0.05, evaluate: c.evaluate }).trades[0];
  assert.ok(loss.r < -1);
});

test('exact fee maths: 0.1% charged on entry AND on every exit', () => {
  // 1% of $10,000 risked on a $2 stop → 50 units at $100 ($5,000 position)
  const { data, evaluate } = scenario([bar(100, 101, 99.5, 100.5), bar(100.5, 104, 100, 103.5), bar(103.5, 106, 103, 105.5), bar(105.5, 109, 105, 108.5)]);
  const t = backtestStrategy(data, { ...small, feePct: 0.1, evaluate }).trades[0];
  const proceeds = 20 * 103 + 17.5 * 105 + 12.5 * 108;            // 5247.5
  const expected = proceeds * 0.999 - 5000 * 1.001;                // 237.2525
  assert.ok(Math.abs(t.pnl - expected) < 0.01, `pnl=${t.pnl} expected=${expected}`);
});

test('entry is the next candle open, never the signal candle close', () => {
  const { data, evaluate } = scenario([bar(100.4, 101, 100.2, 100.8), bar(100.8, 101, 97, 97.5)]);
  const t = backtestStrategy(data, { ...small, evaluate }).trades[0];
  assert.equal(t.entry, 100.4);
  assert.equal(t.signalTime < t.entryTime, true);
});

test('no look-ahead: engine only sees candles closed at decision time, in live window sizes', () => {
  const seen = [];
  const evaluate = (w4, w1, w15, { decisionTime }) => {
    const last = (w, ms) => w[w.length - 1].time + ms;
    assert.ok(last(w4, H4) <= decisionTime, '4h candle not closed');
    assert.ok(last(w1, H1) <= decisionTime, '1h candle not closed');
    assert.equal(last(w15, M15), decisionTime);
    assert.equal(w4.length, WINDOWS.h4);
    assert.equal(w1.length, WINDOWS.h1);
    assert.equal(w15.length, WINDOWS.m15);
    seen.push(decisionTime);
    return { signal: 'WAIT' };
  };
  const c15m = makeCandles(600, { intervalMs: M15 }).map(c => ({ ...c, time: c.time + 300 * H4 }));
  const c1h = makeCandles(400);
  const c4h = makeCandles(400, { intervalMs: H4 });
  backtestStrategy({ c4h, c1h, c15m }, { evaluate });
  assert.ok(seen.length > 100);
});

test('real live engine runs through the backtester with valid trades', () => {
  const c15m = makeCandles(4000, { intervalMs: M15, seed: 11, drift: 0.0004, vol: 0.006 }).map(c => ({ ...c, time: c.time + 270 * H4 }));
  const c1h = makeCandles(1400, { seed: 12, drift: 0.001 });
  const c4h = makeCandles(600, { intervalMs: H4, seed: 13, drift: 0.003 });
  const r = backtestStrategy({ c4h, c1h, c15m }, {});
  for (const t of r.trades) {
    assert.ok(t.stop < t.entry && t.tp1 > t.entry);
    assert.ok(t.score >= 7, 'only BUY signals (score ≥ 7) are traded');
  }
  assert.equal(typeof evaluateSignal, 'function');
});

test('stats: Wilson range, profit factor, expectancy', () => {
  assert.deepEqual(wilson(12, 20), [38.7, 78.1]);
  const trades = [
    { r: 2, pnl: 200, pnlPct: 2, barsHeld: 8, exitReason: 'TP3', tp1Hit: true, tp3Hit: true },
    { r: -1, pnl: -100, pnlPct: -1, barsHeld: 4, exitReason: 'STOP_LOSS' },
    { r: -1, pnl: -100, pnlPct: -1, barsHeld: 4, exitReason: 'STOP_LOSS' },
  ];
  const s = computeStats(trades);
  assert.equal(s.winRatePct, 33.3);
  assert.equal(s.expectancyR, 0);
  assert.equal(s.profitFactor, 1);
  assert.equal(s.enoughData, false);
});

test('track record text is honest about losses and small samples', () => {
  const base = { basis: 'all signals', trades: 12, winRatePct: 41.7, winRateRange95: [19.3, 68], expectancyR: -0.12, enoughData: false, period: { from: '2026-04-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } };
  const txt = formatTrackRecord(base);
  assert.match(txt, /lost money in testing/);
  assert.match(txt, /small sample/);
  assert.match(formatTrackRecord(null), /No backtest results yet/);
});

test('without saved results, BUY alerts say so instead of inventing a confidence %', async () => {
  resetEnv();
  // Simulate "no backtest saved yet", whatever is in your data/ folder
  process.env.STRATEGY_STATS_FILE = require('path').join(__dirname, 'no-such-stats-file.json');
  _clearCache();
  assert.equal(trackRecordFor(9), null);
  const net = mockNet();
  const { sendBuyAlert } = require('../src/services/telegramService');
  await sendBuyAlert({
    symbol: 'SOLUSDT', signal: 'BUY', score: 9, confidence: 60, price: 100, stopLoss: 97,
    takeProfits: { tp1: { price: 104.5, ratio: '1.5R' }, tp2: { price: 107.5, ratio: '2.5R' }, tp3: { price: 112, ratio: '4R' } },
    riskReward: 1.5, factors: ['4H uptrend'],
  });
  assert.equal(net.sent.length, 1);
  assert.match(net.sent[0].text, /No backtest results yet/);
  assert.doesNotMatch(net.sent[0].text, /█/);
});

test('closed candles only: the still-forming candle is dropped', () => {
  const { dropUnclosed } = require('../src/lib/market');
  const now = Date.UTC(2026, 5, 1, 10, 7);
  const c = [{ time: Date.UTC(2026, 5, 1, 9, 45) }, { time: Date.UTC(2026, 5, 1, 10, 0) }];
  assert.equal(dropUnclosed(c, '15m', now).length, 1);
});
