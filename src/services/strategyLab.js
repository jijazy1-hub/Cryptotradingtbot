/**
 * ─── Strategy lab: honest tests for the auto-buy strategies ──────────────────
 * Rules of the test (the same rules the auto-buyer follows):
 *  - Signals use CLOSED daily candles only; the buy happens at the NEXT day's open.
 *  - Every buy and sell pays the 0.1% Binance fee plus 0.05% slippage.
 *  - A stop triggers if the day's low touches it, and fills at the stop — or at
 *    the open, if the price opened below it (gaps are not forgiven).
 *  - The trailing stop is updated at each daily close and never moves down.
 *  - Train / test: each family's settings are CHOSEN on the older part of the
 *    history and JUDGED only on the newer part they never saw.
 *
 * Verdict (on the unseen part, after costs):
 *   PASS       ≥ 30 trades, average > +0.05R, profit factor > 1.2, AND the 95%
 *              range of the average is above zero (unlikely to be luck)
 *   PROMISING  average > +0.05R and profit factor > 1.1, but could still be luck
 *   FAIL       otherwise
 */

const { STRATEGIES, variants, prepare, makeContext, sma } = require('../strategies');
const { meanRange95 } = require('./strategyStats');

const FEE = 0.001;
const SLIP = 0.0005;
const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/**
 * Backtest one variant on one coin. Entries only when the signal day's close
 * time is in [from, to). Positions still open at the end are closed at the last close.
 */
function backtestCoin(ind, variant, ctx, { from = -Infinity, to = Infinity } = {}) {
  const s = STRATEGIES[variant.family];
  const p = variant.params;
  const c = ind.c;
  const trades = [];
  let pos = null;

  const close = (i, price, reason) => {
    const exitNet = price * (1 - FEE);
    const entryCost = pos.entry * (1 + FEE);
    const risk = pos.entry - pos.initialStop;
    trades.push({
      symbol: ind.symbol, entryTime: pos.entryTime, exitTime: c[i].time, entry: pos.entry, exit: price,
      riskPct: risk / pos.entry, r: (exitNet - entryCost) / risk, pnlPct: (exitNet / entryCost - 1) * 100, reason, bars: i - pos.entryIndex,
    });
    pos = null;
  };

  for (let i = s.warmup; i < c.length; i++) {
    // 1) Manage an open position during bar i
    if (pos && i >= pos.entryIndex) {
      if (c[i].low <= pos.stop) {
        close(i, Math.min(pos.stop, c[i].open) * (1 - SLIP), 'stop');
      } else {
        pos.highestClose = Math.max(pos.highestClose, c[i].close);
        const t = s.trail(ind, i, p, pos);
        if (Number.isFinite(t) && t > pos.stop && t < c[i].close) pos.stop = t;
      }
    }
    // 2) New entry signal at the close of bar i → buy at bar i+1's open
    if (!pos && i + 1 < c.length && c[i].time >= from && c[i].time < to) {
      if ((!p.regime || ctx.btcUp(c[i].time)) && s.entry(ind, i, p, ctx)) {
        const entry = c[i + 1].open * (1 + SLIP);
        const stop = s.initialStop(ind, i, p, entry);
        if (Number.isFinite(stop) && stop > 0 && stop < entry) {
          pos = { entry, entryIndex: i + 1, entryTime: c[i + 1].time, initialStop: stop, stop, highestClose: c[i + 1].open };
        }
      }
    }
  }
  if (pos) close(c.length - 1, c[c.length - 1].close * (1 - SLIP), 'end');
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const rs = trades.map(t => t.r);
  const wins = trades.filter(t => t.r > 0);
  const gw = wins.reduce((a, t) => a + t.r, 0);
  const gl = Math.abs(trades.filter(t => t.r <= 0).reduce((a, t) => a + t.r, 0));
  return {
    trades: n,
    winRatePct: round((wins.length / n) * 100, 1),
    expectancyR: round(rs.reduce((a, b) => a + b, 0) / n),
    expectancyRange95: meanRange95(rs),
    profitFactor: gl === 0 ? null : round(gw / gl, 2),
    avgTradePct: round(trades.reduce((a, t) => a + t.pnlPct, 0) / n, 2),
    avgDays: round(trades.reduce((a, t) => a + t.bars, 0) / n, 1),
    bestR: round(Math.max(...rs), 2),
    worstR: round(Math.min(...rs), 2),
  };
}

function verdictOf(st) {
  if (!st || st.trades < 30) return { verdict: 'FAIL', why: `only ${st?.trades || 0} trades — too few to judge (need 30+)` };
  const lo = st.expectancyRange95?.[0];
  if (st.expectancyR > 0.05 && (st.profitFactor ?? 0) > 1.2 && lo !== null && lo > 0) return { verdict: 'PASS', why: 'made money after costs on data it never saw, and the result is unlikely to be luck' };
  if (st.expectancyR > 0.05 && (st.profitFactor ?? 0) > 1.1) return { verdict: 'PROMISING', why: 'made money after costs on unseen data, but the result could still be luck' };
  return { verdict: 'FAIL', why: st.expectancyR > 0
    ? `made only ${st.expectancyR}R per trade after costs on data it never saw (profit factor ${st.profitFactor}) — too little to rely on`
    : 'lost money after costs on data it never saw' };
}

/**
 * Portfolio view of a trade list: 1% of equity at risk per trade, at most
 * `maxOpen` positions, no position larger than `maxPosPct` of equity.
 */
function portfolio(trades, { riskPct = 0.01, maxOpen = 5, maxPosPct = 0.2 } = {}) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let equity = 1;
  let peak = 1, maxDD = 0, taken = 0;
  const open = []; // { exitTime, pnlFrac(of equity at entry), eqAtEntry }
  const settle = (until) => {
    open.sort((a, b) => a.exitTime - b.exitTime);
    while (open.length && open[0].exitTime <= until) {
      const o = open.shift();
      equity += o.eqAtEntry * o.frac;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, (peak - equity) / peak);
    }
  };
  for (const t of sorted) {
    settle(t.entryTime);
    if (open.length >= maxOpen) continue;
    const effRisk = Math.min(riskPct, maxPosPct * t.riskPct); // position-size cap
    open.push({ exitTime: t.exitTime, frac: effRisk * t.r, eqAtEntry: equity });
    taken++;
  }
  settle(Infinity);
  return { taken, returnPct: round((equity - 1) * 100, 1), maxDrawdownPct: round(maxDD * 100, 1) };
}

/**
 * Full research run.
 * @param candlesBySymbol { SOLUSDT: [daily candles], … } must include BTCUSDT
 * @param opts.trainFrac share of the timeline used to choose settings (default 0.65)
 */
function research(candlesBySymbol, { trainFrac = 0.65 } = {}) {
  const prepared = {};
  for (const [sym, c] of Object.entries(candlesBySymbol)) {
    if (!c || c.length < 120) continue;
    prepared[sym] = Object.assign(prepare(c), { symbol: sym });
  }
  const btc = prepared.BTCUSDT;
  if (!btc) throw new Error('BTCUSDT daily candles are required');
  const ctx = makeContext(prepared, btc);
  const t0 = btc.c[0].time, t1 = btc.c[btc.c.length - 1].time;
  const split = t0 + (t1 - t0) * trainFrac;

  const all = variants().map(v => {
    const train = [], test = [];
    for (const ind of Object.values(prepared)) {
      train.push(...backtestCoin(ind, v, ctx, { to: split }));
      test.push(...backtestCoin(ind, v, ctx, { from: split }));
    }
    return { ...v, trainTrades: train, testTrades: test, train: stats(train), test: stats(test) };
  });

  // Choose each family's settings on TRAIN only (min 30 trades), then judge on TEST
  const chosenTrades = {};
  const families = Object.keys(STRATEGIES).map(family => {
    const cands = all.filter(v => v.family === family && v.train.trades >= 30);
    const best = cands.sort((a, b) => b.train.expectancyR - a.train.expectancyR)[0];
    if (!best) return { family, name: STRATEGIES[family].name, chosen: null, verdict: 'FAIL', why: 'too few trades in the training period' };
    const v = verdictOf(best.test);
    chosenTrades[family] = best.testTrades;
    return {
      family, name: STRATEGIES[family].name, chosen: { id: best.id, params: best.params, label: best.label },
      train: best.train, test: best.test, portfolioTest: portfolio(best.testTrades), ...v,
    };
  });

  // Overall pick: the family whose chosen settings did best on TRAIN (no peeking at test)
  const ranked = families.filter(f => f.chosen).sort((a, b) => b.train.expectancyR - a.train.expectancyR);
  const pick = ranked[0] || null;
  const iSplit = btc.c.findIndex(x => x.time >= split);
  const btcHold = iSplit >= 0 ? round((btc.close[btc.close.length - 1] / btc.c[iSplit].open - 1) * 100, 1) : null;

  return {
    generatedAt: new Date().toISOString(),
    rules: { feePct: FEE * 100, slippagePct: SLIP * 100, entry: 'next daily open', stops: 'daily low touch, gap fills at open', trainFrac },
    universe: Object.keys(prepared),
    period: {
      from: new Date(t0).toISOString().slice(0, 10), split: new Date(split).toISOString().slice(0, 10), to: new Date(t1).toISOString().slice(0, 10),
    },
    btcBuyHoldTestPct: btcHold,
    families,
    pick: pick ? { family: pick.family, name: pick.name, ...pick.chosen, verdict: pick.verdict, why: pick.why, test: pick.test, train: pick.train, portfolioTest: pick.portfolioTest } : null,
    verdict: pick ? pick.verdict : 'FAIL',
    comparisons: comparisons({ families, chosenTrades, btc, split }),
    variants: all.map(v => ({ id: v.id, family: v.family, train: v.train, test: v.test })),
  };
}

/**
 * Extra comparisons on the unseen period — FOR INFORMATION ONLY. They never
 * change the pick (which is chosen on the training period alone), so auto-buy
 * keeps running exactly the strategy the pick names. They answer:
 *  - what if each strategy risked 2% per trade instead of 1%?
 *  - what if breakout and "strongest coins" ran together (one shared account)?
 *  - what if you simply held BTC, but only while it's above its 200-day average?
 * Because these are judged on the same unseen period they're compared on, a
 * better number here is a reason to test further — not proof.
 */
function comparisons({ families, chosenTrades, btc, split }) {
  const risk2 = {};
  for (const f of families) if (chosenTrades[f.family]) risk2[f.family] = portfolio(chosenTrades[f.family], { riskPct: 0.02 });

  let combo = null;
  if (chosenTrades.donchian && chosenTrades.momentum) {
    const seen = new Set();
    const merged = [...chosenTrades.donchian, ...chosenTrades.momentum].filter(t => {
      const k = `${t.symbol}|${t.entryTime}`; // the same coin bought the same day by both → one trade
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    const st = stats(merged);
    combo = { families: ['donchian', 'momentum'], test: st, verdict: verdictOf(st).verdict, portfolio1: portfolio(merged, { riskPct: 0.01 }), portfolio2: portfolio(merged, { riskPct: 0.02 }) };
  }

  return { risk2, combo, btcTrend200: btcTrend(btc, split, 200), btcHold: btcTrend(btc, split, 0) };
}

/** Hold BTC from `split` on — always (n = 0), or only while yesterday's close was above its n-day average. Costs charged on every switch. */
function btcTrend(btc, split, n) {
  const avg = n ? sma(btc.close, n) : null;
  const start = Math.max(1, btc.c.findIndex(x => x.time >= split));
  if (start < 1) return null;
  const cost = FEE + SLIP;
  let cash = 1, units = 0, peak = 1, maxDD = 0, switches = 0, daysIn = 0;
  for (let i = start; i < btc.c.length; i++) {
    const want = n ? (avg[i - 1] !== null && btc.close[i - 1] > avg[i - 1]) : true;
    const open = btc.c[i].open;
    if (want && !units) { units = cash * (1 - cost) / open; cash = 0; switches++; }
    else if (!want && units) { cash = units * open * (1 - cost); units = 0; switches++; }
    if (units) daysIn++;
    const value = units ? units * btc.c[i].close : cash;
    peak = Math.max(peak, value);
    maxDD = Math.max(maxDD, (peak - value) / peak);
  }
  const end = units ? units * btc.close[btc.close.length - 1] : cash;
  return { returnPct: round((end - 1) * 100, 1), maxDrawdownPct: round(maxDD * 100, 1), switches, timeInMarketPct: round(daysIn / (btc.c.length - start) * 100, 0) };
}

module.exports = { backtestCoin, stats, verdictOf, portfolio, research, comparisons, btcTrend, FEE, SLIP };
