/**
 * ─── Multi-Timeframe Scan Engine ─────────────────────────────────────────────
 * The live strategy (4H trend + 1H momentum + 15M entry). Moved out of
 * api/v2scan.js so the scanner, the local runner (index.js / scheduler.js)
 * and the backtest all use exactly the same logic.
 *
 * Logic is unchanged from v2scan (patch v2.1.1): ADX < 20 hard block, bearish
 * divergence blocks BUY, bearish 15M patterns subtract, OBV bearish flagged.
 */

const {
  ema, rsi, stochRsi, macd, bollingerBands, atr, adx,
  obv, vwap, volumeAvg, detectDivergence, detectPatterns, findSwingLevels,
} = require('./indicatorService');
const { calcATRStop, calcTakeProfits, calcRiskReward } = require('./riskService');
const { fetchKlines, INTERVAL_MS } = require('../lib/market');
const { trackRecordFor } = require('./strategyStats');
const { ACTIVE } = require('../config/strategy');
const { btcTrendLookup, regimeNeedsBtc, applyRegime } = require('./regime');

/**
 * Candle windows the live scanner evaluates. The backtester feeds evaluateSignal
 * exactly these window sizes so backtest signals are identical to live ones.
 */
const WINDOWS = { h4: 260, h1: 100, m15: 50 };

// ─── Core Signal Engine ───────────────────────────────────────────────────────

/**
 * @param {object} [params]
 * @param {number} [params.stopAtrMult=1.5] stop = entry − this × 1H ATR
 */
function evaluateSignal(c4h, c1h, c15m, params = {}) {
  const stopAtrMult = Number(params.stopAtrMult) > 0 ? Number(params.stopAtrMult) : 1.5;
  const n4 = c4h.length, n1 = c1h.length, n15 = c15m.length;

  if (n4 < 200 || n1 < 60 || n15 < 5) {
    return { signal: 'WAIT', score: 0, confidence: 0, reason: 'Insufficient data' };
  }

  // ── Layer 1: 4H Macro Trend ──────────────────────────────────────────────
  const closes4h  = c4h.map(c => c.close);
  const ema200_4h = ema(closes4h, 200)[n4 - 1];
  const ema50_4h  = ema(closes4h, 50)[n4 - 1];
  const last4h    = c4h[n4 - 1];
  const trend4h   = last4h.close > ema200_4h ? 'UP' : 'DOWN';

  // ADX on 4H
  const adx4h = adx(c4h, 14);

  // ── Layer 2: 1H Momentum ─────────────────────────────────────────────────
  const closes1h  = c1h.map(c => c.close);
  const ema50_1h  = ema(closes1h, 50)[n1 - 1];
  const ema20_1h  = ema(closes1h, 20)[n1 - 1];
  const rsi1h     = rsi(closes1h, 14);
  const rsiNow    = rsi1h[n1 - 1];
  const srsi      = stochRsi(closes1h);
  const macdData  = macd(closes1h);
  const bb1h      = bollingerBands(closes1h, 20)[n1 - 1];
  const atr1h     = atr(c1h, 14);
  const atrNow    = atr1h[n1 - 1];
  const vwapArr   = vwap(c1h);
  const vwapNow   = vwapArr[n1 - 1];
  const obvArr    = obv(c1h);
  const obvEmaArr = ema(obvArr, 20);
  const obvTrend  = obvArr[n1 - 1] > (obvEmaArr[n1 - 1] || 0) ? 'BULLISH' : 'BEARISH';
  const div       = detectDivergence(c1h, rsi1h);

  // ── Layer 3: 15M Entry ───────────────────────────────────────────────────
  const avgVol15   = volumeAvg(c15m, Math.min(20, n15 - 1));
  const volSurge   = avgVol15 > 0 && c15m[n15 - 1].volume > avgVol15 * 1.5;
  const patterns   = detectPatterns(c15m);
  const bullishPat = patterns.filter(p => p.bullish === true);
  const bearishPat = patterns.filter(p => p.bullish === false);

  const entryPrice = c15m[n15 - 1].close;

  // ── Shared base result fields ────────────────────────────────────────────
  const base = {
    patterns, price: entryPrice,
    ema20: ema20_1h, ema50: ema50_1h, ema200: ema200_4h,
    rsi: rsiNow, stochRsiK: srsi.k, stochRsiD: srsi.d,
    adxValue: adx4h.adx, adxBullish: adx4h.bullishDI,
    aboveVWAP: closes1h[n1 - 1] > vwapNow,
    bBandPctB: bb1h ? bb1h.percentB : undefined,
    obvTrend, atr: atrNow, divergence: div,
    // used by the optional 'coinTrend' regime filter
    coinTrendUp: ema50_4h !== undefined && ema200_4h !== undefined && ema50_4h > ema200_4h,
    stopAtrMult,
    scannedAt: new Date().toISOString(),
  };

  // ════════════════════════════════════════════════════════════════════════
  // UPTREND PATH
  // ════════════════════════════════════════════════════════════════════════
  if (trend4h === 'UP') {
    // ── HARD FILTER 1: ADX < 20 = ranging market — no trade ─────────────
    if (!adx4h.trending) {
      return {
        ...base, signal: 'WAIT', score: 0, confidence: 0, trend: 'UP',
        factors: [`ADX ${adx4h.adx !== undefined ? adx4h.adx.toFixed(1) : 'N/A'} — market is ranging (ADX < 20). No directional edge. Wait for trend.`],
        stopLoss: null, takeProfits: null, riskReward: null,
        nearestSupport: null, nearestResistance: null,
      };
    }

    // ── HARD FILTER 2: Bearish divergence = trend exhaustion — no trade ──
    if (div.bearish) {
      return {
        ...base, signal: 'WAIT', score: 2, confidence: 13, trend: 'UP',
        factors: [
          '4H uptrend confirmed, BUT:',
          '⚠️ Bearish RSI divergence: price making higher highs while RSI makes lower highs.',
          'Classic trend exhaustion. High reversal probability. DO NOT BUY here.',
          'Wait for RSI to reset (drop below 40) before re-evaluating.',
        ],
        stopLoss: null, takeProfits: null, riskReward: null,
        nearestSupport: null, nearestResistance: null,
      };
    }

    // ── SCORING ──────────────────────────────────────────────────────────
    let score = 0;
    const factors = [];

    // Trend Quality (0–4)
    score += 2; factors.push('4H uptrend (above EMA200)');
    if (adx4h.adx > 25) { score += 1; factors.push(`ADX ${adx4h.adx.toFixed(1)} — strong trend`); }
    if (last4h.close > ema50_4h) { score += 1; factors.push('4H price above EMA50 — trend intact'); }

    // Momentum Quality (0–4)
    const rsiInZone = rsiNow >= 38 && rsiNow <= 58;
    if (rsiInZone)       { score += 2; factors.push(`RSI ${rsiNow.toFixed(1)} — pullback buy zone (38–58)`); }
    else if (rsiNow > 65){ score -= 2; factors.push(`RSI ${rsiNow.toFixed(1)} — overbought, AVOID`); }
    else if (rsiNow < 32){ score += 1; factors.push(`RSI ${rsiNow.toFixed(1)} — oversold, watch for bounce`); }

    if (srsi.k !== undefined && srsi.k < 25) { score += 1; factors.push(`StochRSI %K ${srsi.k.toFixed(1)} — oversold (entry zone)`); }
    if (srsi.kCrossedAboveD)                  { score += 1; factors.push('StochRSI bullish cross (%K above %D)'); }

    if (macdData.histogramGrowing)            { score += 1; factors.push('MACD histogram expanding — momentum building'); }
    else if (macdData.bullishCross)           { score += 1; factors.push('MACD bullish crossover'); }

    // Volatility & Structure (0–3)
    if (bb1h && bb1h.percentB < 0.25)        { score += 2; factors.push(`BB %B ${(bb1h.percentB * 100).toFixed(0)}% — near lower band (buy zone)`); }
    else if (bb1h && bb1h.percentB > 0.85)   { score -= 1; factors.push('BB %B near upper band — extended'); }

    const nearEma50 = ema50_1h && Math.abs(closes1h[n1 - 1] - ema50_1h) / ema50_1h <= 0.04;
    if (nearEma50) { score += 1; factors.push('Price pulled back to 1H EMA50 — value area'); }

    // Volume & Institutional Flow (0–3)
    if (closes1h[n1 - 1] > vwapNow) { score += 1; factors.push('Price above VWAP — institutional buy pressure'); }
    if (obvTrend === 'BULLISH')      { score += 1; factors.push('OBV bullish — smart money accumulating'); }
    else                             { factors.push('⚠️ OBV bearish — volume not confirming price move, caution'); }
    if (volSurge)                    { score += 1; factors.push('Volume surge on 15M'); }

    // Candle Patterns — bullish adds, bearish subtracts (FIX)
    const bullishStr = bullishPat.reduce((s, p) => s + p.strength, 0);
    const bearishStr = bearishPat.reduce((s, p) => s + p.strength, 0);
    if (bullishStr > 0) {
      score += Math.min(bullishStr, 4);
      factors.push(`15M bullish patterns: ${bullishPat.map(p => p.name).join(', ')}`);
    }
    if (bearishStr > 0) {
      score -= bearishStr;
      factors.push(`⚠️ 15M bearish patterns: ${bearishPat.map(p => p.name).join(', ')} — entry timing is poor`);
    }

    // Bullish divergence bonus
    if (div.bullish) { score += 2; factors.push('⚡ Bullish RSI divergence — premium reversal setup'); }

    // ── Build result ──────────────────────────────────────────────────────
    const confidence = Math.min(100, Math.round((score / 15) * 100));
    const stopLoss   = calcATRStop({ entryPrice, atrValue: atrNow, multiplier: stopAtrMult });
    const tps        = stopLoss ? calcTakeProfits({ entryPrice, stopLoss }) : null;
    const rr         = tps && stopLoss ? calcRiskReward({ entryPrice, stopLoss, takeProfit: tps.tp1.price }) : null;

    if (score >= 7 && rr !== null && rr < 1.5) {
      factors.push(`⚠️ R:R ${rr}:1 below 1.5 minimum — WAIT for better entry price`);
    }

    const signal = score >= 7 && (rr === null || rr >= 1.5) ? 'BUY' : 'WAIT';
    const { support, resistance } = findSwingLevels(c1h, 3);

    return {
      ...base, signal, score, confidence, trend: 'UP', factors,
      stopLoss, takeProfits: tps, riskReward: rr,
      nearestSupport:    support[0]    || null,
      nearestResistance: resistance[resistance.length - 1] || null,
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // DOWNTREND PATH
  // ════════════════════════════════════════════════════════════════════════
  let bScore = 0;
  const bFactors = [];

  bScore += 2; bFactors.push('4H downtrend (below EMA200)');
  if (adx4h.adx > 25)   { bScore += 1; bFactors.push(`ADX ${adx4h.adx.toFixed(1)} — strong downtrend`); }
  if (!adx4h.bullishDI) { bScore += 1; bFactors.push('-DI dominant — sellers in control'); }
  if (rsiNow > 55)      { bScore += 1; bFactors.push(`RSI ${rsiNow.toFixed(1)} — overbought in downtrend (bounce likely to fail)`); }
  if (rsiNow < 30)      { bFactors.push(`RSI ${rsiNow.toFixed(1)} — oversold, possible short-term bounce`); }
  if (bearishPat.length > 0) { bScore += 2; bFactors.push(`Bearish patterns: ${bearishPat.map(p => p.name).join(', ')}`); }
  if (div.bearish)      { bScore += 2; bFactors.push('⚡ Bearish RSI divergence — momentum collapsing'); }

  return {
    ...base, signal: 'BEARISH_ALERT', trend: 'DOWN',
    score: bScore,
    confidence: Math.min(100, Math.round((bScore / 10) * 100)),
    factors: bFactors,
    stopLoss: null, takeProfits: null, riskReward: null,
    nearestSupport: null, nearestResistance: null,
  };
}

/**
 * Fetch the three timeframes and evaluate one symbol.
 * Closed candles only — the signal can't change before the next 15m close
 * (no repainting), and it matches what the backtest measured.
 */
/** For decideOn '1h': drop 15m candles after the last one that closed on the hour. */
function trimToHourClose(c15m) {
  let end = c15m.length;
  while (end > 0 && (c15m[end - 1].time + INTERVAL_MS['15m']) % INTERVAL_MS['1h'] !== 0) end--;
  return c15m.slice(0, end);
}

async function scanSymbol(symbol, strategy = ACTIVE, ctx = {}) {
  const opts = { closedOnly: true };
  const [c4h, c1h, raw15m] = await Promise.all([
    fetchKlines(symbol, '4h', WINDOWS.h4, opts),
    fetchKlines(symbol, '1h', WINDOWS.h1, opts),
    fetchKlines(symbol, '15m', WINDOWS.m15 + 4, opts),
  ]);
  const c15m = (strategy.decideOn === '1h' ? trimToHourClose(raw15m) : raw15m).slice(-WINDOWS.m15);
  let result = { symbol, ...evaluateSignal(c4h, c1h, c15m, { stopAtrMult: strategy.stopAtrMult }) };
  result = applyRegime(result, strategy.regime, ctx.btcUp);
  result.strategy = strategy.name;
  // Measured backtest results for signals like this one (null until a backtest is saved)
  if (result.signal === 'BUY') result.trackRecord = trackRecordFor(result.score);
  const last = c15m[c15m.length - 1];
  if (last) result.candleTime = new Date(last.time).toISOString();
  return result;
}

/** Scan many symbols; errors are captured per symbol. Sorted BUY → WAIT → BEARISH → ERROR. */
async function scanSymbols(symbols, strategy = ACTIVE) {
  const ctx = {};
  if (regimeNeedsBtc(strategy.regime)) {
    try {
      const daily = await fetchKlines('BTCUSDT', '1d', 120, { closedOnly: true });
      ctx.btcUp = btcTrendLookup(daily)(Date.now());
    } catch (err) {
      console.error('[scan] BTC daily trend unavailable — BUYs blocked this run:', err.message);
    }
  }
  const results = [];
  for (const symbol of symbols) {
    try {
      results.push(await scanSymbol(symbol, strategy, ctx));
    } catch (err) {
      results.push({ symbol, signal: 'ERROR', error: err.message, score: 0, confidence: 0 });
    }
  }
  const order = { BUY: 0, WAIT: 1, BEARISH_ALERT: 2, ERROR: 3 };
  results.sort((a, b) => ((order[a.signal] ?? 9) - (order[b.signal] ?? 9)) || ((b.score || 0) - (a.score || 0)));
  return results;
}

module.exports = { evaluateSignal, scanSymbol, scanSymbols, trimToHourClose, WINDOWS };
