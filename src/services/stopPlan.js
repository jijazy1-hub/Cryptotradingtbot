/**
 * ─── Saved stop management ────────────────────────────────────────────────────
 * The TP alerts tell users "after TP1 move your stop to breakeven, after TP2
 * move it to TP1". Previously the bot itself kept watching the ORIGINAL stop,
 * so if price came back to entry after TP1 there was no alert at all.
 * Now the saved stop moves with the plan, and both monitors watch it.
 *
 * stopStage: 'initial' (plan stop) · 'user' (set with buy … sl / setstop)
 *            'breakeven' (after TP1) · 'tp1' (after TP2)
 */

/** New stop after a take-profit — only ever moves UP, never loosens a stop. */
function stopAfterTakeProfit(pos, level, tps) {
  const current = Number(pos.stopLossPrice) || 0;
  if (level === 'TP1') {
    const next = Number(pos.buyPrice);
    return next > current ? { stopLossPrice: next, stopStage: 'breakeven' } : {};
  }
  if (level === 'TP2' && tps?.tp1?.price) {
    const next = Number(tps.tp1.price);
    return next > current ? { stopLossPrice: next, stopStage: 'tp1' } : {};
  }
  return {};
}

/** Headline + instruction for a stop hit, depending on which stop it was. */
function stopHitWording(pos, pnlPct) {
  switch (pos.stopStage) {
    case 'breakeven':
      return {
        title: `🟡 *BREAKEVEN STOP — EXIT THE REST — ${pos.symbol}*`,
        action: `🟡 *Sell your remaining position now.* You already banked TP1, so this part closes around your entry.`,
        result: `📊 *Remaining part:* ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% from entry`,
      };
    case 'tp1':
      return {
        title: `🟢 *PROFIT STOP — EXIT THE REST — ${pos.symbol}*`,
        action: `🟢 *Sell your remaining position now.* Profit is locked at the TP1 level.`,
        result: `📈 *Remaining part:* +${pnlPct.toFixed(2)}% from entry`,
      };
    default:
      if (pnlPct >= 0) {
        return {
          title: `🟢 *STOP HIT — EXIT — ${pos.symbol}*`,
          action: `🟢 *Sell now.* Your stop was above your entry, so this exit keeps a profit.`,
          result: `📈 *Result:*    +${pnlPct.toFixed(2)}%`,
        };
      }
      return {
        title: `🔴 *STOP LOSS — EXIT NOW — ${pos.symbol}*`,
        action: `🔴 *Sell 100% immediately. No hesitation.*\nA small loss now prevents a wipeout later.`,
        result: `📉 *Loss:*      ${pnlPct.toFixed(2)}%`,
      };
  }
}

module.exports = { stopAfterTakeProfit, stopHitWording };
