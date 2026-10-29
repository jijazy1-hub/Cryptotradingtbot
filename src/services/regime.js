/**
 * ─── Market regime filters ────────────────────────────────────────────────────
 * Optional extra conditions before a BUY is allowed (see src/config/strategy.js).
 * Shared by the live scanner and the backtest/research tools.
 */

const { ema } = require('./indicatorService');
const { INTERVAL_MS } = require('../lib/market');

const DAY = INTERVAL_MS['1d'];

/**
 * Precompute, for BTC daily candles, whether each closed day finished above
 * its EMA50. Returns a lookup: time → boolean|undefined (latest closed day).
 */
function btcTrendLookup(dailyCandles, emaPeriod = 50) {
  const closes = dailyCandles.map(c => c.close);
  const e = ema(closes, emaPeriod);
  const points = dailyCandles.map((c, i) => ({ closeTime: c.time + DAY, up: e[i] === undefined ? undefined : c.close > e[i] }));
  let ptr = -1;
  let lastTime = -Infinity;
  return function btcUpAt(time) {
    if (time < lastTime) ptr = -1;           // allow non-monotonic queries (rare)
    lastTime = time;
    while (ptr + 1 < points.length && points[ptr + 1].closeTime <= time) ptr++;
    return ptr >= 0 ? points[ptr].up : undefined;
  };
}

/** True if a BUY may be taken under `regime`. Unknown data blocks the trade (safe side). */
function regimeAllows(regime, { coinTrendUp, btcUp }) {
  switch (regime) {
    case 'coinTrend': return coinTrendUp === true;
    case 'btcTrend':  return btcUp === true;
    case 'both':      return coinTrendUp === true && btcUp === true;
    default:          return true;
  }
}

function regimeNeedsBtc(regime) {
  return regime === 'btcTrend' || regime === 'both';
}

/** Apply the filter to a live scan result (turns a blocked BUY into WAIT, with a reason). */
function applyRegime(result, regime, btcUp) {
  if (!result || result.signal !== 'BUY' || !regime || regime === 'none') return result;
  if (regimeAllows(regime, { coinTrendUp: result.coinTrendUp, btcUp })) return result;
  const why = [];
  if ((regime === 'coinTrend' || regime === 'both') && result.coinTrendUp !== true) why.push('4H EMA50 is not above EMA200');
  if (regimeNeedsBtc(regime) && btcUp !== true) why.push('BTC is below its daily EMA50');
  return {
    ...result,
    signal: 'WAIT',
    blockedBuy: true,
    factors: [...(result.factors || []), `⛔ BUY blocked by market filter (${regime}): ${why.join('; ')}`],
  };
}

module.exports = { btcTrendLookup, regimeAllows, regimeNeedsBtc, applyRegime };
