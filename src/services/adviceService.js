/**
 * ─── Position Advice Service ──────────────────────────────────────────────────
 * Exit / hold advice for a position. Shared by /api/v2advice, the Telegram
 * `buy` and `check` commands and /api/v2monitor.
 *
 * BUGFIX: 4H candles were fetched with limit 50, but EMA200 needs 200+, so the
 * macro trend was always "UNKNOWN" and every rule that used it never fired.
 */

const {
  ema, rsi, stochRsi, macd, atr,
  bollingerBands, findSwingLevels,
} = require('./indicatorService');
const {
  calcATRStop, calcTakeProfits, calcRiskReward, calcPositionSize,
} = require('./riskService');
const { fetchKlinesWithSource, fetchPrice } = require('../lib/market');

/** @param {object} [opts] opts.exchange — the position's exchange (no cross-exchange fallback) */
async function fetchCurrentData(symbol, { exchange = null } = {}) {
  const sym = symbol.toUpperCase();
  const [h1, h4, livePrice] = await Promise.all([
    fetchKlinesWithSource(sym, '1h', 100, { exchange }),
    fetchKlinesWithSource(sym, '4h', 250, { exchange }),
    fetchPrice(sym, { exchange }),
  ]);
  const candles1h = h1.candles;
  if (!candles1h.length) throw new Error(`No price data for ${sym}`);
  return {
    candles1h,
    candles4h:    h4.candles,
    currentPrice: livePrice ?? candles1h[candles1h.length - 1].close,
    exchange:     h1.exchange,
  };
}

/** Plan to save on a position the first time it is checked. */
function planFromAdvice(advice) {
  const sl = advice?.tradePlan?.stopLoss;
  if (!sl) return null;
  return { stopLossPrice: sl, takeProfits: advice.tradePlan.takeProfits || null };
}

function buildAdvice({ symbol, buyPrice, currentPrice, candles1h, candles4h, accountSize, riskPct, lockedPlan = null }) {
  buyPrice = Number(buyPrice);
  currentPrice = Number(currentPrice);
  const closes1h = candles1h.map(c => c.close);
  const closes4h = candles4h.map(c => c.close);
  const n1 = closes1h.length;

  // Indicators
  const rsiArr     = rsi(closes1h, 14);
  const rsiNow     = rsiArr[n1 - 1];
  const srsi       = stochRsi(closes1h);
  const macdData   = macd(closes1h);
  const ema20      = ema(closes1h, 20)[n1 - 1];
  const ema50      = ema(closes1h, 50)[n1 - 1];
  const ema200_4h  = ema(closes4h, 200)[closes4h.length - 1];
  const atrArr     = atr(candles1h, 14);
  const atrNow     = atrArr[n1 - 1];
  const bb         = bollingerBands(closes1h, 20)[n1 - 1];

  // ATR-based stop (1.5x ATR below buy price — same logic as scanner).
  // BUGFIX: once a position's plan is saved (lockedPlan), reuse it instead of
  // recalculating from today's ATR — otherwise the stop/TPs drift every check
  // and the 10-min quickcheck and 30-min monitor disagree.
  const lockedStop = lockedPlan && Number(lockedPlan.stopLoss) > 0 ? Number(lockedPlan.stopLoss) : null;
  const atrStop    = lockedStop ?? calcATRStop({ entryPrice: buyPrice, atrValue: atrNow, multiplier: 1.5 });
  const tps        = (lockedStop && lockedPlan.takeProfits)
    ? lockedPlan.takeProfits
    : (atrStop && atrStop < buyPrice ? calcTakeProfits({ entryPrice: buyPrice, stopLoss: atrStop }) : null);

  // Trailing stop = current price - 1x ATR (tightens as price moves up)
  const trailingStop = atrNow ? parseFloat((currentPrice - atrNow).toFixed(6)) : null;

  // P&L
  const pnlPct  = ((currentPrice - buyPrice) / buyPrice) * 100;
  const pnlSign = pnlPct >= 0 ? '+' : '';

  // Swing levels for resistance/support context
  const { resistance, support } = findSwingLevels(candles1h, 3);
  const resistanceAbove = resistance.filter(r => r > currentPrice).slice(0, 3);
  const supportBelow    = support.filter(s => s < currentPrice).slice(0, 2);

  // R:R on TP1
  const rrTp1 = tps && atrStop ? calcRiskReward({ entryPrice: buyPrice, stopLoss: atrStop, takeProfit: tps.tp1.price }) : null;

  // Position sizing (optional — if accountSize provided)
  const sizing = accountSize && atrStop ? calcPositionSize({
    accountBalance: accountSize,
    riskPercent:    riskPct || 1,
    entryPrice:     buyPrice,
    stopLoss:       atrStop,
  }) : null;

  // Macro trend check (4H)
  const macroTrend = ema200_4h ? (currentPrice > ema200_4h ? 'BULLISH' : 'BEARISH') : 'UNKNOWN';

  // ── Decision Logic ────────────────────────────────────────────────────────

  let recommendation = 'HOLD';
  let urgency        = 'LOW';
  const reasons      = [];
  const actions      = [];

  // ── Check if stop loss hit ──
  if (atrStop && currentPrice <= atrStop) {
    recommendation = 'STOP_LOSS';
    urgency        = 'CRITICAL';
    reasons.push(`Price $${currentPrice} has broken below ATR stop at $${atrStop.toFixed(4)}`);
    reasons.push(`You are down ${Math.abs(pnlPct).toFixed(2)}% from entry of $${buyPrice}`);
    if (macroTrend === 'BEARISH') reasons.push('Macro trend (4H) is also bearish — no case to hold');
    actions.push('🔴 EXIT THE TRADE NOW — stop loss breached');
    actions.push('Do not average down. Take the loss and wait for the next setup.');

  // ── TP3 hit (moon bag territory) ──
  } else if (tps && currentPrice >= tps.tp3.price) {
    recommendation = 'TAKE_PROFIT';
    urgency        = 'HIGH';
    reasons.push(`You are up ${pnlPct.toFixed(2)}% — TP3 (${tps.tp3.ratio}) reached 🎉`);
    reasons.push('This is exceptional. Take the remaining position off.');
    actions.push(`🟢 Close remaining 25% at $${currentPrice.toFixed(4)}`);
    if (trailingStop) actions.push(`If holding: set hard floor at $${trailingStop.toFixed(4)} (1x ATR trail)`);

  // ── TP2 hit ──
  } else if (tps && currentPrice >= tps.tp2.price) {
    recommendation = 'TAKE_PROFIT';
    urgency        = 'HIGH';
    reasons.push(`Up ${pnlPct.toFixed(2)}% — TP2 (${tps.tp2.ratio}) reached`);
    actions.push('🟢 Sell 35% of position here');
    actions.push(`Move stop to $${tps.tp1.price.toFixed(4)} (TP1 — protecting earlier profit)`);
    if (resistanceAbove.length > 0) actions.push(`TP3 target: $${tps.tp3.price.toFixed(4)} — next resistance at $${resistanceAbove[0].toFixed(4)}`);

  // ── TP1 hit ──
  } else if (tps && currentPrice >= tps.tp1.price) {
    recommendation = 'TAKE_PROFIT';
    urgency        = 'MEDIUM';
    reasons.push(`Up ${pnlPct.toFixed(2)}% — TP1 (${tps.tp1.ratio}) reached`);
    actions.push('🟢 Sell 40% of position — lock in your first profit');
    actions.push(`Move stop loss to BREAKEVEN ($${buyPrice.toFixed(4)}) — free trade now`);
    if (tps.tp2) actions.push(`Target TP2 at $${tps.tp2.price.toFixed(4)} with remaining 60%`);

  // ── Warning: overbought but no TP hit yet ──
  } else if (rsiNow > 72 && srsi.k > 80 && pnlPct > 2) {
    recommendation = 'TRAIL_STOP';
    urgency        = 'MEDIUM';
    reasons.push(`RSI ${rsiNow.toFixed(1)} + StochRSI ${srsi.k.toFixed(1)} — both overbought`);
    reasons.push('Combination of both at extremes has high reversal probability');
    reasons.push(`You are up ${pnlPct.toFixed(2)}% — protect gains now`);
    actions.push(trailingStop ? `Set trailing stop at $${trailingStop.toFixed(4)} (1x ATR below current)` : 'Set trailing stop 3–4% below current price');
    actions.push('If MACD crosses bearish → exit immediately');

  // ── MACD bearish cross + price below EMA20 ──
  } else if (!macdData.histogramGrowing && ema20 && currentPrice < ema20 && pnlPct > 0) {
    recommendation = 'CLOSE_PARTIAL';
    urgency        = 'MEDIUM';
    reasons.push('MACD momentum fading AND price below EMA20 — trend weakening');
    reasons.push(`Still in profit at ${pnlPct.toFixed(2)}% — reduce risk before it evaporates`);
    actions.push('Sell 30–50% of position now');
    actions.push(`Keep remaining position only if 4H trend stays ${macroTrend}`);
    if (atrStop) actions.push(`Tighten stop to $${atrStop.toFixed(4)}`);

  // ── Macro trend broken ──
  } else if (macroTrend === 'BEARISH' && pnlPct < 0) {
    recommendation = 'CLOSE_PARTIAL';
    urgency        = 'MEDIUM';
    reasons.push('4H price is below EMA200 — macro trend has turned bearish');
    reasons.push(`Currently at ${pnlPct.toFixed(2)}% — managing risk is priority`);
    actions.push('Consider cutting 50% of position to reduce exposure');
    actions.push(`If price recovers above $${ema200_4h ? ema200_4h.toFixed(4) : 'EMA200'}, re-evaluate`);

  // ── In loss, above stop ──
  } else if (pnlPct < 0 && (!atrStop || currentPrice > atrStop)) {
    recommendation = 'HOLD';
    urgency        = 'LOW';
    reasons.push(`Down ${Math.abs(pnlPct).toFixed(2)}% — within stop range, no action needed`);
    if (atrStop) reasons.push(`ATR stop at $${atrStop.toFixed(4)} — price hasn't breached it`);
    actions.push('Hold — let the trade play out');
    actions.push(atrStop ? `Watch: if price closes below $${atrStop.toFixed(4)}, exit immediately` : 'Monitor closely');

  // ── Healthy profit, ride it ──
  } else {
    recommendation = 'HOLD';
    urgency        = 'LOW';
    reasons.push(`Up ${pnlPct.toFixed(2)}% — trade progressing normally`);
    if (tps) reasons.push(`Next target: TP1 at $${tps.tp1.price.toFixed(4)} (${tps.tp1.ratio})`);
    if (rsiNow < 65) reasons.push(`RSI ${rsiNow.toFixed(1)} — room to run`);
    if (atrStop) actions.push(`Keep ATR stop at $${atrStop.toFixed(4)}`);
    if (resistanceAbove.length > 0) actions.push(`Watch resistance at $${resistanceAbove[0].toFixed(4)}`);
  }

  return {
    symbol,
    buyPrice,
    currentPrice,
    pnlPct:      parseFloat(pnlPct.toFixed(2)),
    pnlDisplay:  `${pnlSign}${pnlPct.toFixed(2)}%`,
    recommendation,
    urgency,
    reasons,
    actions,

    // Trade Plan
    tradePlan: {
      stopLoss:      atrStop,
      trailingStop,
      takeProfits:   tps,
      riskReward:    rrTp1,
      breakeven:     buyPrice,
      locked:        !!lockedStop,
    },

    // Position Sizing (only if accountSize was provided)
    positionSizing: sizing ? {
      ...sizing,
      riskPercent:   riskPct || 1,
      accountSize,
      note: sizing.capped ? sizing.capReason : `Risk $${sizing.dollarRisk} to make $${(sizing.dollarRisk * (rrTp1 || 1.5)).toFixed(2)} at TP1`,
    } : null,

    // Market Context
    levels: {
      ema20, ema50, ema200_4h,
      atr:       atrNow ? parseFloat(atrNow.toFixed(6)) : null,
      resistanceAbove,
      supportBelow,
      bbUpper:   bb ? parseFloat(bb.upper.toFixed(6)) : null,
      bbLower:   bb ? parseFloat(bb.lower.toFixed(6)) : null,
    },

    indicators: {
      rsi:         rsiNow ? parseFloat(rsiNow.toFixed(2)) : null,
      stochRsiK:   srsi.k ? parseFloat(srsi.k.toFixed(2)) : null,
      stochRsiD:   srsi.d ? parseFloat(srsi.d.toFixed(2)) : null,
      macdGrowing: macdData.histogramGrowing,
      macroTrend,
    },

    analyzedAt: new Date().toISOString(),
  };
}

module.exports = { fetchCurrentData, buildAdvice, planFromAdvice };
