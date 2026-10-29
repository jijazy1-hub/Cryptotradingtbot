/**
 * ─── Strategy research: can any variant beat fees on data it has never seen? ──
 *
 *   npm run research                    # 12 coins, last 365 days
 *   npm run research -- --days 540      # more history
 *   npm run research -- --refresh       # re-download data (otherwise cached 24h)
 *
 * How it stays honest
 *  1. Signals come from the live engine (same code, same windows, closed
 *     candles), computed ONCE per coin. Variants only change how BUYs are
 *     filtered and traded — never the history.
 *  2. The period is split in time: the first 2/3 ("train") is used to pick the
 *     best variant; the last 1/3 ("test") is never looked at while choosing.
 *  3. Exactly ONE variant — the best on train — is then judged on test, next
 *     to the original strategy. Picking whatever looks best on test would just
 *     find luck (with 48 variants, a few always look good by chance).
 *  4. PASS needs, on the unseen test months, after fees: avg ≥ +0.05R per
 *     trade, profit factor ≥ 1.1, at least 50 trades, and the 95% range of the
 *     average above zero. Anything less = no reliable edge.
 *
 * Writes research-results.json (all numbers). Downloads are cached in
 * data/cache/ (git-ignored).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchKlinesWithSource, INTERVAL_MS } = require('./src/lib/market');
const { backtestStrategy, DEFAULTS } = require('./src/services/strategyBacktest');
const { computeStats } = require('./src/services/strategyStats');
const { WINDOWS, evaluateSignal } = require('./src/services/scanEngine');
const { btcTrendLookup } = require('./src/services/regime');
const { calcATRStop, calcTakeProfits } = require('./src/services/riskService');
const { ORIGINAL } = require('./src/config/strategy');

const DEFAULT_SYMBOLS = 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,NEARUSDT,INJUSDT,SUIUSDT,ARBUSDT';
const CACHE_DIR = path.join(__dirname, 'data', 'cache');
const CACHE_MAX_AGE_MS = 24 * 3_600_000;

const GRID = {
  decideOn: ['15m', '1h'],
  stopAtrMult: [1.5, 2.5, 3.5],
  regime: ['none', 'coinTrend', 'btcTrend', 'both'],
  minHoursBetweenEntries: [4, 24],
};
const TRAIN_FRACTION = 2 / 3;
const MIN_TRAIN_TRADES = 100;
const PASS = { expectancyR: 0.05, profitFactor: 1.1, trades: 50 };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// ─── Data (cached) ────────────────────────────────────────────────────────────
async function cached(symbol, interval, limit, refresh) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${symbol}-${interval}.json`);
  if (!refresh && fs.existsSync(file)) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - c.fetchedAt < CACHE_MAX_AGE_MS && c.candles.length >= limit) return c.candles.slice(-limit);
    } catch { /* re-download */ }
  }
  const { candles, exchange } = await fetchKlinesWithSource(symbol, interval, limit, { closedOnly: true });
  if (exchange === 'Kraken') throw new Error('only Kraken reachable (~720 candles) — needs Binance access');
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), candles }));
  return candles;
}

// ─── Signals: computed once per coin with the live engine ─────────────────────
function recordBuySignals(data) {
  const buys = new Map(); // decisionTime → { score, price, atr, coinTrendUp }
  backtestStrategy(data, {
    strategy: { ...ORIGINAL, decideOn: '15m', regime: 'none', minHoursBetweenEntries: 0 },
    evaluate: (w4, w1, w15, params) => {
      const sig = evaluateSignal(w4, w1, w15, params);
      if (sig.signal === 'BUY' && sig.atr > 0) {
        buys.set(params.decisionTime, { score: sig.score, price: sig.price, atr: sig.atr, coinTrendUp: sig.coinTrendUp });
      }
      return { signal: 'WAIT' }; // never enter: we want a signal at every bar
    },
  });
  return buys;
}

function signalFor(buys, stopAtrMult) {
  return (i, decisionTime) => {
    const b = buys.get(decisionTime);
    if (!b) return null;
    const stopLoss = calcATRStop({ entryPrice: b.price, atrValue: b.atr, multiplier: stopAtrMult });
    if (!stopLoss || stopLoss >= b.price) return null;
    return { signal: 'BUY', score: b.score, coinTrendUp: b.coinTrendUp, stopLoss, takeProfits: calcTakeProfits({ entryPrice: b.price, stopLoss }) };
  };
}

function* variants() {
  for (const decideOn of GRID.decideOn)
    for (const stopAtrMult of GRID.stopAtrMult)
      for (const regime of GRID.regime)
        for (const minHoursBetweenEntries of GRID.minHoursBetweenEntries)
          yield { decideOn, stopAtrMult, regime, minHoursBetweenEntries };
}

const label = (v) => `${v.decideOn.padEnd(3)} stop×${v.stopAtrMult} ${v.regime.padEnd(9)} gap${String(v.minHoursBetweenEntries).padStart(2)}h`;
const isOriginal = (v) => v.decideOn === ORIGINAL.decideOn && v.stopAtrMult === ORIGINAL.stopAtrMult && v.regime === ORIGINAL.regime && v.minHoursBetweenEntries === ORIGINAL.minHoursBetweenEntries;
const fmtR = (x) => (x == null ? '   n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(3)}`);

function passes(s) {
  return !!s && s.trades >= PASS.trades && s.expectancyR >= PASS.expectancyR &&
    (s.profitFactor ?? 0) >= PASS.profitFactor && s.expectancyRange95?.[0] > 0;
}

async function main() {
  const days = Number(arg('days', 365));
  const symbols = arg('symbols', DEFAULT_SYMBOLS).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const refresh = flag('refresh');
  const costs = {
    feePct: Number(arg('fee', DEFAULTS.feePct)),
    slippagePct: Number(arg('slippage', DEFAULTS.slippagePct)),
    riskPct: DEFAULTS.riskPct,
  };

  console.log(`Strategy research — ${symbols.length} coins, ${days} days, fees ${costs.feePct}% + slippage ${costs.slippagePct}%`);
  console.log('Downloading candles (cached for 24h in data/cache)…');

  const btcDaily = await cached('BTCUSDT', '1d', days + 120, refresh);
  const btcUpAt = btcTrendLookup(btcDaily);

  const coins = [];
  for (const symbol of symbols) {
    process.stdout.write(`  ${symbol.padEnd(9)} `);
    try {
      const c4h = await cached(symbol, '4h', days * 6 + WINDOWS.h4 + 10, refresh);
      const c1h = await cached(symbol, '1h', days * 24 + WINDOWS.h1 + 10, refresh);
      const c15m = await cached(symbol, '15m', days * 96 + WINDOWS.m15, refresh);
      const t = Date.now();
      const buys = recordBuySignals({ c4h, c1h, c15m });
      coins.push({ symbol, data: { c4h, c1h, c15m }, buys });
      console.log(`${c15m.length} candles · ${buys.size} raw BUY signals  [${((Date.now() - t) / 1000).toFixed(1)}s]`);
    } catch (err) {
      console.log(`skipped: ${err.message}`);
    }
  }
  if (!coins.length) { console.error('No data — nothing to test.'); process.exitCode = 1; return; }

  // Common time split (by signal time)
  const start = Math.max(...coins.map(c => c.data.c15m[0].time));
  const end = Math.min(...coins.map(c => c.data.c15m[c.data.c15m.length - 1].time));
  const splitTime = start + (end - start) * TRAIN_FRACTION;
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  console.log(`\nTrain (choose): ${iso(start)} → ${iso(splitTime)}   Test (unseen): ${iso(splitTime)} → ${iso(end)}\n`);

  const rows = [];
  for (const v of variants()) {
    const train = [], test = [];
    for (const c of coins) {
      const r = backtestStrategy(c.data, { ...costs, strategy: { name: 'research', ...v }, btcUpAt, signalAt: signalFor(c.buys, v.stopAtrMult) });
      for (const t of r.trades) {
        const st = Date.parse(t.signalTime);
        if (st < start) continue;
        (st < splitTime ? train : test).push({ ...t, symbol: c.symbol });
      }
    }
    rows.push({ variant: v, original: isOriginal(v), train: computeStats(train), test: computeStats(test) });
  }

  // ── Choose on TRAIN only ─────────────────────────────────────────────────────
  const eligible = rows.filter(r => r.train.trades >= MIN_TRAIN_TRADES);
  eligible.sort((a, b) => (b.train.expectancyR ?? -9) - (a.train.expectancyR ?? -9));
  const chosen = eligible[0] || null;
  const original = rows.find(r => r.original);

  console.log('All variants on TRAIN data (sorted by avg R per trade, fees incl.)');
  console.log('variant                              trades   win%    avg R   PF');
  for (const r of [...rows].sort((a, b) => (b.train.expectancyR ?? -9) - (a.train.expectancyR ?? -9))) {
    const s = r.train;
    const mark = r === chosen ? ' ← chosen' : r.original ? ' ← original' : s.trades < MIN_TRAIN_TRADES ? ' (too few trades)' : '';
    console.log(`${label(r.variant)}   ${String(s.trades).padStart(5)}  ${String(s.winRatePct ?? '-').padStart(5)}  ${fmtR(s.expectancyR)}  ${String(s.profitFactor ?? '-').padStart(4)}${mark}`);
  }

  console.log('\n══ THE REAL TEST: unseen months, judged once ════════════════════════');
  const show = (name, r) => {
    if (!r) return;
    const s = r.test;
    if (!s.trades) { console.log(`${name.padEnd(9)} ${label(r.variant)}  no trades in test period`); return; }
    console.log(`${name.padEnd(9)} ${label(r.variant)}  ${s.trades} trades · win ${s.winRatePct}% · avg ${fmtR(s.expectancyR)}R ` +
      `(95% range ${fmtR(s.expectancyRange95[0])} to ${fmtR(s.expectancyRange95[1])}) · PF ${s.profitFactor ?? 'n/a'}`);
  };
  show('Original', original);
  show('Chosen', chosen);

  const passed = chosen && passes(chosen.test);
  console.log('');
  if (!chosen) {
    console.log('VERDICT: no variant produced enough trades to judge.');
  } else if (passed) {
    console.log('VERDICT: ✅ PASS — the chosen variant stayed profitable after fees on months it never saw.');
    console.log('This is evidence, not proof. Run it live with small size and re-check monthly.\n');
    console.log('To switch the live bot, set ACTIVE in src/config/strategy.js to:\n');
    console.log(`const ACTIVE = Object.freeze({
  name: 'v2-research-${iso(Date.now())}',
  decideOn: '${chosen.variant.decideOn}',
  stopAtrMult: ${chosen.variant.stopAtrMult},
  regime: '${chosen.variant.regime}',
  minHoursBetweenEntries: ${chosen.variant.minHoursBetweenEntries},
});`);
    console.log('\nThen run `npm run backtest -- --days 365` and commit data/strategy-stats.json.');
  } else {
    const s = chosen.test;
    const why = [];
    if (s.trades < PASS.trades) why.push(`only ${s.trades} test trades`);
    if ((s.expectancyR ?? -1) < PASS.expectancyR) why.push(`avg ${fmtR(s.expectancyR)}R < +${PASS.expectancyR}R`);
    if ((s.profitFactor ?? 0) < PASS.profitFactor) why.push(`PF ${s.profitFactor ?? 'n/a'} < ${PASS.profitFactor}`);
    if (!(s.expectancyRange95?.[0] > 0)) why.push('95% range includes zero or below');
    console.log(`VERDICT: ❌ FAIL — the best variant on train did not hold up on unseen data (${why.join('; ')}).`);
    console.log('Conclusion: no reliable edge found for this indicator strategy. Keep BUY alerts off.');
  }

  fs.writeFileSync(path.join(__dirname, 'research-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), days, symbols: coins.map(c => c.symbol), costs,
    split: { start: iso(start), splitAt: iso(splitTime), end: iso(end) },
    passRule: PASS, minTrainTrades: MIN_TRAIN_TRADES,
    chosen: chosen ? { variant: chosen.variant, train: chosen.train, test: chosen.test, passed } : null,
    original: original ? { variant: original.variant, train: original.train, test: original.test } : null,
    allVariantsTrain: rows.map(r => ({ variant: r.variant, train: r.train })),
  }, null, 2));
  console.log('\nSaved research-results.json');
}

if (require.main === module) {
  main().catch(err => { console.error('Research failed:', err.message || err); process.exitCode = 1; });
}

module.exports = { recordBuySignals, signalFor, variants, passes, GRID, PASS };
