/**
 * ─── Live-Strategy Backtester ─────────────────────────────────────────────────
 * Replays history through the SAME evaluateSignal() the live scanner uses,
 * with the SAME candle windows, and trades the SAME plan the BUY alert tells
 * users to follow. Nothing is tuned to make results look better.
 *
 * Honesty rules
 *  1. No look-ahead: at each 15m close, the engine only sees candles that had
 *     fully closed by then (incl. 1h / 4h).
 *  2. Entry at the NEXT 15m candle's open (you can't buy at the close that
 *     produced the signal), plus slippage.
 *  3. Stop / TPs are the absolute prices from the signal — what the alert shows.
 *  4. Trade plan = alert's plan:
 *       TP1 (1.5R) sell 40% → stop to breakeven
 *       TP2 (2.5R) sell 35% → stop to TP1
 *       TP3 (4R)   sell remaining 25%
 *  5. If a candle touches both the stop and a target, the STOP is assumed to
 *     hit first (conservative). A gap through the stop fills at the open.
 *  6. Fees on every fill (default 0.1% = Binance spot taker) + slippage on
 *     market fills (entry, stops).
 *  7. One position per symbol at a time; long only (the scanner only BUYs).
 */

const { evaluateSignal: liveEvaluate, WINDOWS } = require('./scanEngine');
const { INTERVAL_MS } = require('../lib/market');
const { ACTIVE } = require('../config/strategy');
const { regimeAllows } = require('./regime');

const DEFAULTS = {
  initialCapital: 10_000,
  riskPct: 1,           // % of equity risked per trade (stop distance)
  feePct: 0.1,          // per fill, % of notional
  slippagePct: 0.05,    // on market fills (entry, stop exits)
  maxHoldBars: null,    // optional time stop in 15m bars (null = hold until plan exits)
  windows: WINDOWS,
  strategy: ACTIVE,     // decideOn / stopAtrMult / regime / minHoursBetweenEntries
  btcUpAt: null,        // fn(time) → BTC daily-trend flag; required for btc regimes
  signalAt: null,       // research fast path: fn(i, decisionTime) → precomputed signal
};

/** Advance pointer to the last candle fully closed at `time`. */
function advanceClosed(candles, ptr, time, intervalMs) {
  while (ptr + 1 < candles.length && candles[ptr + 1].time + intervalMs <= time) ptr++;
  return ptr;
}

/**
 * @param {{c4h: Array, c1h: Array, c15m: Array}} data  candles, oldest first, closed only
 * @param {object} [options]  see DEFAULTS; `evaluate` can be injected for tests
 * @returns {{trades: Array, equityCurve: Array, settings: object, finalEquity: number, openAtEnd: number}}
 */
function backtestStrategy({ c4h, c1h, c15m }, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const evaluate = opts.evaluate || liveEvaluate;
  const W = opts.windows;
  const fee = opts.feePct / 100;
  const slip = opts.slippagePct / 100;
  const M15 = INTERVAL_MS['15m'], H1 = INTERVAL_MS['1h'], H4 = INTERVAL_MS['4h'];
  const strat = { ...ACTIVE, ...(opts.strategy || {}) };
  const gapMs = Math.max(0, Number(strat.minHoursBetweenEntries) || 0) * H1;
  let lastSignalTime = -Infinity;

  let equity = opts.initialCapital;
  const trades = [];
  const equityCurve = [];
  let pos = null;
  let p1h = -1, p4h = -1;

  const closeTrade = (bar, reason) => {
    pos.exitTime = bar.time;
    pos.exitReason = reason;
    const pnl = pos.cash; // net of fees: proceeds - cost
    equity += pnl;
    trades.push({
      entryTime:   new Date(pos.entryTime).toISOString(),
      exitTime:    new Date(pos.exitTime).toISOString(),
      signalTime:  new Date(pos.signalTime).toISOString(),
      score:       pos.score,
      entry:       round(pos.entry),
      stop:        round(pos.initialStop),
      tp1:         round(pos.tps.tp1.price),
      tp2:         round(pos.tps.tp2.price),
      tp3:         round(pos.tps.tp3.price),
      exits:       pos.exits,
      exitReason:  reason,
      barsHeld:    pos.bars,
      pnl:         round(pnl, 2),
      pnlPct:      round((pnl / pos.costBasis) * 100, 3),          // % return on the position
      r:           round(pnl / pos.riskDollars, 3),                // multiple of planned risk
      tp1Hit:      pos.tp1Hit, tp2Hit: pos.tp2Hit, tp3Hit: pos.tp3Hit,
    });
    pos = null;
  };

  const sell = (fraction, price, label, bar) => {
    const qty = pos.unitsInitial * fraction;
    const proceeds = qty * price;
    pos.cash += proceeds - proceeds * fee;
    pos.remaining -= fraction;
    pos.exits.push({ label, price: round(price), fraction, time: new Date(bar.time).toISOString() });
  };

  for (let i = 0; i < c15m.length; i++) {
    const bar = c15m[i];

    // ── 1. Manage open position on this bar ──────────────────────────────────
    if (pos && i >= pos.entryIndex) {
      pos.bars++;
      // Stop first (conservative). Gap below stop → fill at open.
      if (bar.low <= pos.stop) {
        const raw = Math.min(pos.stop, bar.open);
        const reason = pos.tp2Hit ? 'STOP_AT_TP1' : pos.tp1Hit ? 'BREAKEVEN_STOP' : 'STOP_LOSS';
        sell(pos.remaining, raw * (1 - slip), reason, bar);
        closeTrade(bar, reason);
      } else {
        // Targets are resting limit orders: filled at the target (no slippage)
        if (!pos.tp1Hit && bar.high >= pos.tps.tp1.price) {
          sell(0.40, pos.tps.tp1.price, 'TP1', bar);
          pos.tp1Hit = true;
          pos.stop = pos.entry;                 // alert: "move stop to breakeven"
        }
        if (pos.tp1Hit && !pos.tp2Hit && bar.high >= pos.tps.tp2.price) {
          sell(0.35, pos.tps.tp2.price, 'TP2', bar);
          pos.tp2Hit = true;
          pos.stop = pos.tps.tp1.price;         // alert: "move stop to TP1"
        }
        if (pos.tp2Hit && !pos.tp3Hit && bar.high >= pos.tps.tp3.price) {
          sell(pos.remaining, pos.tps.tp3.price, 'TP3', bar);
          pos.tp3Hit = true;
          closeTrade(bar, 'TP3');
        } else if (opts.maxHoldBars && pos.bars >= opts.maxHoldBars) {
          sell(pos.remaining, bar.close * (1 - slip), 'TIME_EXIT', bar);
          closeTrade(bar, 'TIME_EXIT');
        }
      }
    }

    // ── 2. Look for a new signal at this bar's close ────────────────────────
    const decisionTime = bar.time + M15;
    p1h = advanceClosed(c1h, p1h, decisionTime, H1);
    p4h = advanceClosed(c4h, p4h, decisionTime, H4);

    const onSchedule = strat.decideOn !== '1h' || decisionTime % H1 === 0;
    const spaced = decisionTime - lastSignalTime >= gapMs;
    if (!pos && onSchedule && spaced && i + 1 < c15m.length && i + 1 >= W.m15 && p1h + 1 >= W.h1 && p4h + 1 >= W.h4) {
      let sig;
      if (opts.signalAt) {
        sig = opts.signalAt(i, decisionTime);
      } else {
        const w4 = c4h.slice(p4h + 1 - W.h4, p4h + 1);
        const w1 = c1h.slice(p1h + 1 - W.h1, p1h + 1);
        const w15 = c15m.slice(i + 1 - W.m15, i + 1);
        sig = evaluate(w4, w1, w15, { decisionTime, stopAtrMult: strat.stopAtrMult });
      }
      if (sig && sig.signal === 'BUY' && strat.regime && strat.regime !== 'none') {
        const btcUp = opts.btcUpAt ? opts.btcUpAt(decisionTime) : undefined;
        if (!regimeAllows(strat.regime, { coinTrendUp: sig.coinTrendUp, btcUp })) sig = null;
      }

      if (sig && sig.signal === 'BUY' && sig.stopLoss && sig.takeProfits) {
        const next = c15m[i + 1];
        const entry = next.open * (1 + slip);
        const stop = sig.stopLoss;
        if (stop < entry && sig.takeProfits.tp1.price > entry) {
          const riskPerUnit = entry - stop;
          let units = (equity * opts.riskPct / 100) / riskPerUnit;
          // Spot account, no leverage: can't buy more than equity (incl. entry fee)
          units = Math.min(units, equity / (entry * (1 + fee)));
          const cost = units * entry;
          lastSignalTime = decisionTime;
          pos = {
            signalTime: bar.time, entryTime: next.time, entryIndex: i + 1,
            entry, stop, initialStop: stop, tps: sig.takeProfits, score: sig.score,
            unitsInitial: units, remaining: 1, costBasis: cost,
            cash: -(cost + cost * fee),             // running net cash of this trade
            riskDollars: units * riskPerUnit,
            exits: [], bars: 0, tp1Hit: false, tp2Hit: false, tp3Hit: false,
          };
        }
      }
    }

    if (i % 16 === 0 || i === c15m.length - 1) {
      // mark-to-market equity every 4h
      const mtm = pos ? equity + pos.cash + pos.unitsInitial * pos.remaining * bar.close : equity;
      equityCurve.push({ time: bar.time, equity: round(mtm, 2) });
    }
  }

  // Position still open at the end of data: mark it, report separately
  let openAtEnd = 0;
  if (pos) {
    const last = c15m[c15m.length - 1];
    sell(pos.remaining, last.close * (1 - slip), 'END_OF_DATA', last);
    closeTrade(last, 'END_OF_DATA');
    openAtEnd = 1;
  }

  return {
    trades,
    equityCurve,
    finalEquity: round(equity, 2),
    openAtEnd,
    settings: { ...opts, evaluate: undefined, signalAt: undefined, btcUpAt: undefined, windows: W, strategy: strat },
    period: c15m.length ? { from: new Date(c15m[0].time).toISOString(), to: new Date(c15m[c15m.length - 1].time + M15).toISOString() } : null,
    buyAndHoldPct: c15m.length ? round(((c15m[c15m.length - 1].close / c15m[0].open) - 1) * 100, 2) : null,
  };
}

function round(x, d = 8) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

module.exports = { backtestStrategy, DEFAULTS };
