/**
 * Backtest the LIVE scanner strategy on real Binance history.
 *
 *   npm run backtest                         # BINANCE_SYMBOLS, last 180 days
 *   npm run backtest -- --days 365 --fee 0.1 --slippage 0.05 --risk 1
 *   npm run backtest -- --symbols SOLUSDT,ETHUSDT
 *
 * Writes:
 *   data/strategy-stats.json  summary used by live alerts, /api/backtest, dashboard
 *                             → commit this file so the deployed bot shows the results
 *   backtest-results.json     every trade, for your own analysis (not needed by the bot)
 *
 * Needs a connection that can reach Binance (api.binance.com or the
 * data-api.binance.vision mirror). Kraken only has ~720 candles — too short.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchKlinesWithSource, configuredSymbols } = require('./src/lib/market');
const { backtestStrategy, DEFAULTS } = require('./src/services/strategyBacktest');
const { buildSummary, computeStats, verdict, STATS_FILE } = require('./src/services/strategyStats');
const { WINDOWS } = require('./src/services/scanEngine');
const { ACTIVE } = require('./src/config/strategy');
const { btcTrendLookup, regimeNeedsBtc } = require('./src/services/regime');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const days = Number(arg('days', 180));
const symbols = arg('symbols', null)
  ? arg('symbols').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : configuredSymbols('SOLUSDT');
const options = {
  feePct: Number(arg('fee', DEFAULTS.feePct)),
  slippagePct: Number(arg('slippage', DEFAULTS.slippagePct)),
  riskPct: Number(arg('risk', DEFAULTS.riskPct)),
  initialCapital: Number(arg('capital', DEFAULTS.initialCapital)),
  maxHoldBars: arg('max-hold-hours', null) ? Number(arg('max-hold-hours')) * 4 : null,
  // Strategy = src/config/strategy.js ACTIVE, optionally overridden for experiments
  strategy: {
    ...ACTIVE,
    ...(arg('decide', null) ? { decideOn: arg('decide') } : {}),
    ...(arg('stop-mult', null) ? { stopAtrMult: Number(arg('stop-mult')) } : {}),
    ...(arg('regime', null) ? { regime: arg('regime') } : {}),
    ...(arg('gap-hours', null) ? { minHoursBetweenEntries: Number(arg('gap-hours')) } : {}),
  },
};

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${x}%`);
const fmtR = (x) => (x === null || x === undefined ? 'n/a' : `${x >= 0 ? '+' : ''}${x}R`);

async function load(symbol) {
  const opts = { closedOnly: true };
  const [h4, h1, m15] = await Promise.all([
    fetchKlinesWithSource(symbol, '4h', days * 6 + WINDOWS.h4 + 10, opts),
    fetchKlinesWithSource(symbol, '1h', days * 24 + WINDOWS.h1 + 10, opts),
    fetchKlinesWithSource(symbol, '15m', days * 96 + WINDOWS.m15, opts),
  ]);
  const sources = new Set([h4.exchange, h1.exchange, m15.exchange]);
  if (sources.has('Kraken')) {
    throw new Error('Only Kraken data was reachable (≈720 candles) — too short for an honest backtest. Run from a connection that can reach Binance.');
  }
  return { c4h: h4.candles, c1h: h1.candles, c15m: m15.candles };
}

async function main() {
  console.log(`Backtesting the live scanner strategy on ${symbols.length} coin(s), last ${days} days`);
  const st = options.strategy;
  console.log(`Fees ${options.feePct}% per fill · slippage ${options.slippagePct}% · risk ${options.riskPct}% per trade`);
  console.log(`Strategy: ${st.name} — decide on ${st.decideOn} · stop ${st.stopAtrMult}× 1H ATR · filter ${st.regime} · ≥${st.minHoursBetweenEntries}h between entries\n`);

  if (regimeNeedsBtc(st.regime)) {
    const { candles } = await fetchKlinesWithSource('BTCUSDT', '1d', days + 120, { closedOnly: true });
    options.btcUpAt = btcTrendLookup(candles);
  }

  const perSymbol = [];
  const errors = [];
  for (const symbol of symbols) {
    process.stdout.write(`${symbol.padEnd(10)} `);
    try {
      const data = await load(symbol);
      const t = Date.now();
      const result = backtestStrategy(data, options);
      const s = computeStats(result.trades, { equityCurve: result.equityCurve, initialCapital: options.initialCapital, finalEquity: result.finalEquity });
      perSymbol.push({ symbol, result });
      console.log(
        `${String(s.trades).padStart(4)} trades · win ${pct(s.winRatePct).padStart(6)} · avg ${fmtR(s.expectancyR).padStart(8)} · ` +
        `PF ${s.profitFactor ?? 'n/a'} · return ${pct(s.totalReturnPct)} (buy&hold ${pct(result.buyAndHoldPct)}) · maxDD ${pct(s.maxDrawdownPct)}` +
        `  [${((Date.now() - t) / 1000).toFixed(1)}s]`
      );
    } catch (err) {
      errors.push({ symbol, error: err.message });
      console.log(`ERROR: ${err.message}`);
    }
  }

  if (!perSymbol.length) {
    console.error('\nNo symbol could be backtested — nothing saved.');
    process.exitCode = 1;
    return;
  }

  const summary = buildSummary(perSymbol, { errors });
  const o = summary.overall;
  console.log('\n══ ALL SIGNALS ══════════════════════════════════════════════');
  if (!o.trades) {
    console.log('No BUY signals in this period.');
  } else {
    console.log(`Trades:          ${o.trades}${o.enoughData ? '' : '  ⚠️ fewer than 30 — treat with caution'}`);
    console.log(`Win rate:        ${o.winRatePct}%  (95% range ${o.winRateRange95[0]}–${o.winRateRange95[1]}%)`);
    console.log(`Avg per trade:   ${fmtR(o.expectancyR)}  (median ${fmtR(o.medianR)}, ${pct(o.avgTradePct)} of position)`);
    console.log(`Profit factor:   ${o.profitFactor ?? 'n/a'}`);
    console.log(`Full stop-outs:  ${o.fullStopRatePct}%   TP1 reached: ${o.tp1HitRatePct}%   TP3 reached: ${o.tp3HitRatePct}%`);
    console.log(`Avg hold:        ${o.avgHoldHours} h`);
    console.log('\nBy setup score:');
    for (const [k, v] of Object.entries(summary.byScore)) {
      console.log(`  ${k.padEnd(5)} ${String(v.trades).padStart(4)} trades · win ${pct(v.winRatePct)} · avg ${fmtR(v.expectancyR)}`);
    }
    console.log(`\nVerdict: ${verdict(o)}`);
  }

  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  fs.writeFileSync(STATS_FILE, JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.resolve('backtest-results.json'), JSON.stringify({
    generatedAt: summary.generatedAt,
    settings: summary.settings,
    symbols: perSymbol.map(s => ({ symbol: s.symbol, period: s.result.period, buyAndHoldPct: s.result.buyAndHoldPct, finalEquity: s.result.finalEquity, trades: s.result.trades })),
    errors,
  }, null, 2));

  console.log(`\nSaved ${path.relative(process.cwd(), STATS_FILE)} (commit + push it so the bot shows these numbers)`);
  console.log('Saved backtest-results.json (all trades)');
}

main().catch(err => {
  console.error('Backtest failed:', err.message || err);
  process.exitCode = 1;
});
