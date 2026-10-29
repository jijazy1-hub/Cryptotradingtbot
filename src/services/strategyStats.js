/**
 * ─── Strategy statistics ──────────────────────────────────────────────────────
 * Turns backtest trades into numbers a trader can trust, and serves the saved
 * results (data/strategy-stats.json) to the live alerts and dashboard.
 *
 * Key numbers
 *  - Expectancy (avg R): average profit per trade in units of planned risk.
 *    +0.20R means "risking $10 per trade earned $2 per trade on average".
 *    This is the single most important number. Below 0 = losing strategy.
 *  - Win rate WITH a 95% range (Wilson interval). 12 wins of 20 trades is
 *    "60%", but the honest range is roughly 39–78%.
 *  - Profit factor: gross profit / gross loss (after fees). Above 1 = profitable.
 *  - Max drawdown: worst peak-to-trough fall of the account.
 *  - Buy-and-hold: what simply holding the coin did over the same period.
 */

const fs = require('fs');
const path = require('path');

const MIN_TRADES = 30; // below this, results are flagged as not statistically meaningful
const MIN_EDGE_R = 0.05; // smaller average gains are within noise / real-world cost differences

/** Plain-English verdict for a set of stats. */
function verdict(s) {
  if (!s || !s.trades) return 'No BUY signals in this period.';
  const thin = s.trades < MIN_TRADES ? ' Too few trades to trust either way.' : '';
  if (s.expectancyR <= 0) return `⚠️ Lost money per trade after fees in this period.${thin}`;
  if (s.expectancyR < MIN_EDGE_R) return `Roughly breakeven after fees — the edge is too small to rely on.${thin}`;
  return `Positive average per trade after fees in this period. Past results don't guarantee future ones.${thin}`;
}
const STATS_FILE = path.join(__dirname, '..', '..', 'data', 'strategy-stats.json');

const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Wilson score interval for a proportion (95%). */
function wilson(successes, n, z = 1.96) {
  if (!n) return [null, null];
  const p = successes / n;
  const denom = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z * z / (4 * n * n))) / denom;
  return [round(Math.max(0, centre - half) * 100, 1), round(Math.min(1, centre + half) * 100, 1)];
}

function maxDrawdownPct(curve) {
  let peak = -Infinity, mdd = 0;
  for (const p of curve || []) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  return round(mdd * 100, 2);
}

/** 95% range for the average R (mean ± 1.96 × standard error). */
function meanRange95(xs) {
  const n = xs.length;
  if (n < 2) return [null, null];
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = 1.96 * sd / Math.sqrt(n);
  return [round(mean - half, 3), round(mean + half, 3)];
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function scoreBucket(score) {
  if (score === undefined || score === null) return 'unknown';
  if (score >= 11) return '11+';
  if (score >= 9) return '9-10';
  return '7-8';
}

/** Core stats for a list of trades (R-based, so they combine across symbols). */
function computeStats(trades, { equityCurve = null, initialCapital = null, finalEquity = null } = {}) {
  const n = trades.length;
  const out = { trades: n };
  if (!n) return { ...out, note: 'No BUY signals in this period' };

  const rs = trades.map(t => t.r);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  Object.assign(out, {
    wins: wins.length,
    losses: losses.length,
    winRatePct: round((wins.length / n) * 100, 1),
    winRateRange95: wilson(wins.length, n),
    expectancyR: round(rs.reduce((a, b) => a + b, 0) / n, 3),
    expectancyRange95: meanRange95(rs),
    medianR: round(median(rs), 3),
    avgTradePct: round(trades.reduce((s, t) => s + t.pnlPct, 0) / n, 3),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? null : 0) : round(grossWin / grossLoss, 2),
    bestR: round(Math.max(...rs), 2),
    worstR: round(Math.min(...rs), 2),
    tp1HitRatePct: round((trades.filter(t => t.tp1Hit).length / n) * 100, 1),
    tp3HitRatePct: round((trades.filter(t => t.tp3Hit).length / n) * 100, 1),
    fullStopRatePct: round((trades.filter(t => t.exitReason === 'STOP_LOSS').length / n) * 100, 1),
    avgHoldHours: round(trades.reduce((s, t) => s + t.barsHeld, 0) / n / 4, 1),
    enoughData: n >= MIN_TRADES,
  });
  if (equityCurve) out.maxDrawdownPct = maxDrawdownPct(equityCurve);
  if (initialCapital && finalEquity) out.totalReturnPct = round((finalEquity / initialCapital - 1) * 100, 2);
  return out;
}

/** Group trades by score bucket. */
function byScore(trades) {
  const groups = {};
  for (const t of trades) (groups[scoreBucket(t.score)] = groups[scoreBucket(t.score)] || []).push(t);
  const out = {};
  for (const k of ['7-8', '9-10', '11+', 'unknown']) if (groups[k]) out[k] = computeStats(groups[k]);
  return out;
}

/**
 * Build the summary saved to data/strategy-stats.json.
 * @param {Array<{symbol, result}>} perSymbol  outputs of backtestStrategy
 */
function buildSummary(perSymbol, meta = {}) {
  const allTrades = perSymbol.flatMap(s => s.result.trades.map(t => ({ ...t, symbol: s.symbol })));
  const bySymbol = {};
  for (const s of perSymbol) {
    bySymbol[s.symbol] = {
      ...computeStats(s.result.trades, {
        equityCurve: s.result.equityCurve,
        initialCapital: s.result.settings.initialCapital,
        finalEquity: s.result.finalEquity,
      }),
      buyAndHoldPct: s.result.buyAndHoldPct,
      period: s.result.period,
    };
  }
  const settings = perSymbol[0]?.result.settings || {};
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    strategy: 'scanEngine (live v2scan logic) — 4H trend + 1H momentum + 15M entry',
    method: [
      'Same signal code and candle windows as the live scanner; closed candles only',
      settings.strategy ? `Strategy "${settings.strategy.name}": decide on ${settings.strategy.decideOn} closes, stop ${settings.strategy.stopAtrMult}× 1H ATR, market filter ${settings.strategy.regime}, ≥${settings.strategy.minHoursBetweenEntries}h between entries` : null,
      'Entry at next 15m open + slippage; stop/TPs exactly as in the BUY alert',
      'TP1 40% → stop to breakeven; TP2 35% → stop to TP1; TP3 remaining 25%',
      'Stop assumed to hit first when a candle touches both; gaps fill at the open',
      `Fees ${settings.feePct}% per fill, slippage ${settings.slippagePct}% on market fills`,
      `Risk ${settings.riskPct}% of equity per trade, no leverage, one position per coin`,
    ].filter(Boolean),
    settings: {
      feePct: settings.feePct, slippagePct: settings.slippagePct, riskPct: settings.riskPct,
      initialCapital: settings.initialCapital, maxHoldBars: settings.maxHoldBars,
      strategy: settings.strategy || null,
    },
    period: meta.period || perSymbol[0]?.result.period || null,
    symbols: perSymbol.map(s => s.symbol),
    errors: meta.errors || [],
    overall: computeStats(allTrades),
    verdict: verdict(computeStats(allTrades)),
    byScore: byScore(allTrades),
    bySymbol,
  };
}

// ─── Reading saved stats (live alerts, dashboard, API) ───────────────────────
let cache = null;
let cacheMtime = 0;

function loadSavedStats() {
  try {
    // STRATEGY_STATS_FILE lets tests point at a different file
    const file = process.env.STRATEGY_STATS_FILE || STATS_FILE;
    const st = fs.statSync(file);
    if (!cache || st.mtimeMs !== cacheMtime) {
      cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      cacheMtime = st.mtimeMs;
    }
    return cache && cache.available ? cache : null;
  } catch {
    return null;
  }
}

/**
 * The measured track record that applies to a live signal with this score:
 * its score bucket if that bucket has enough trades, otherwise the overall stats.
 */
function trackRecordFor(score) {
  const saved = loadSavedStats();
  if (!saved || !saved.overall || !saved.overall.trades) return null;
  const bucketName = scoreBucket(score);
  const bucket = saved.byScore?.[bucketName];
  const useBucket = bucket && bucket.trades >= MIN_TRADES;
  const s = useBucket ? bucket : saved.overall;
  return {
    basis: useBucket ? `score ${bucketName}` : 'all signals',
    trades: s.trades,
    winRatePct: s.winRatePct,
    winRateRange95: s.winRateRange95,
    expectancyR: s.expectancyR,
    profitFactor: s.profitFactor,
    enoughData: s.trades >= MIN_TRADES,
    period: saved.period,
    feePct: saved.settings?.feePct,
  };
}

function fmtMonth(iso) {
  return iso ? new Date(iso).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '?';
}

/** One-line human summary for Telegram / dashboard. */
function formatTrackRecord(tr) {
  if (!tr) return 'No backtest results yet (run `npm run backtest`).';
  const sign = tr.expectancyR >= 0 ? '+' : '';
  const range = tr.winRateRange95?.[0] != null ? ` (likely ${tr.winRateRange95[0]}–${tr.winRateRange95[1]}%)` : '';
  const verdict = tr.expectancyR <= 0 ? ' — ⚠️ lost money in testing' : tr.expectancyR < MIN_EDGE_R ? ' — roughly breakeven' : '';
  const thin = tr.enoughData ? '' : ' — ⚠️ small sample';
  return `Backtest ${fmtMonth(tr.period?.from)}–${fmtMonth(tr.period?.to)}, ${tr.basis}, fees incl.: ` +
    `${tr.trades} trades · ${tr.winRatePct}% win${range} · avg ${sign}${tr.expectancyR}R per trade${verdict}${thin}`;
}

module.exports = {
  MIN_TRADES, MIN_EDGE_R, STATS_FILE, verdict,
  wilson, meanRange95, maxDrawdownPct, scoreBucket, computeStats, byScore, buildSummary,
  loadSavedStats, trackRecordFor, formatTrackRecord,
  _clearCache: () => { cache = null; cacheMtime = 0; },
};
