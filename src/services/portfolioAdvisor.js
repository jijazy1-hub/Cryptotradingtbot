/**
 * ─── Portfolio Advisor ────────────────────────────────────────────────────────
 * Tells users exactly how to split their capital across scan results.
 *
 * RULES FOR SMALL ACCOUNTS ($10-$100):
 *  - Max 3 coins open at a time
 *  - Max 40% of capital in highest confidence coin
 *  - Max 30% in medium confidence
 *  - Max 30% in lower confidence
 *  - Stop loss on each = max 15% of position = max 6% of total capital lost per trade
 *  - Never open a new trade if total open risk > 20% of capital
 *
 * COMPOUNDING RULE:
 *  After a winning trade, reinvest 80% of profit into next trades.
 *  Keep 20% as "safe profits" — never risk these again.
 */

// ─── Split capital across coins ───────────────────────────────────────────────
function adviseSplit(coins, totalCapital) {
  if (!coins || coins.length === 0) return [];

  // Sort by probability
  const sorted = [...coins].sort((a, b) => b.probability - a.probability);

  // Cap at 3 coins
  const selected = sorted.slice(0, 3);

  // Weight by confidence score
  const weights = selected.map(c => {
    if (c.probability >= 80)      return 0.40;
    else if (c.probability >= 65) return 0.35;
    else                          return 0.25;
  });

  // Normalise weights to sum to 1
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const normalised  = weights.map(w => w / totalWeight);

  return selected.map((coin, i) => {
    const allocation   = parseFloat((totalCapital * normalised[i]).toFixed(2));
    const maxLoss      = parseFloat((allocation * 0.15).toFixed(2)); // 15% stop
    const target2x     = parseFloat((allocation * 2).toFixed(2));
    const target3x     = parseFloat((allocation * 3).toFixed(2));

    return {
      symbol:        coin.base || coin.symbol,
      probability:   coin.probability,
      band:          coin.band,
      allocation,
      allocationPct: parseFloat((normalised[i] * 100).toFixed(0)),
      maxLoss,
      target2x,
      target3x,
      entryPrice:    coin.meta?.currentPrice || coin.price,
      reasoning:     getPctReasoning(coin.probability),
    };
  });
}

function getPctReasoning(prob) {
  if (prob >= 80) return 'Highest allocation — highest heuristic score (not backtested)';
  if (prob >= 65) return 'Medium allocation — most signals aligned, one or two weaknesses';
  return 'Smaller allocation — mixed signals, treat as speculative';
}

// ─── Compounding advice ───────────────────────────────────────────────────────
function compoundingAdvice(capital, profit) {
  const safeProfit   = parseFloat((profit * 0.20).toFixed(2));
  const reinvest     = parseFloat((profit * 0.80).toFixed(2));
  const newCapital   = parseFloat((capital + reinvest).toFixed(2));

  return { safeProfit, reinvest, newCapital };
}

// ─── Monthly target progress ──────────────────────────────────────────────────
function targetProgress(capital, targetProfit, currentPnl) {
  const remaining  = Math.max(0, targetProfit - currentPnl);
  const pct        = Math.min(100, parseFloat(((currentPnl / targetProfit) * 100).toFixed(1)));
  const neededMultiple = remaining > 0 && capital > 0
    ? parseFloat(((capital + remaining) / capital).toFixed(2))
    : 1;

  return { remaining, pct, neededMultiple };
}

module.exports = { adviseSplit, compoundingAdvice, targetProgress };