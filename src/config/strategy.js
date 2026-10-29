/**
 * ─── Active strategy settings ─────────────────────────────────────────────────
 * ONE place that controls how the live scanner trades AND how the backtest
 * replays it, so they can never drift apart.
 *
 * `npm run research` tests variants of these settings and prints the exact
 * block to paste here if a variant survives the unseen-data test.
 *
 *  decideOn               '15m' = act on every 15-minute close (original)
 *                         '1h'  = act only on hourly closes (fewer, slower signals)
 *  stopAtrMult            stop distance = this × 1H ATR. TP1/TP2/TP3 stay at
 *                         1.5R / 2.5R / 4R, so they widen with the stop.
 *  regime                 extra market filter before any BUY:
 *                           'none'      original behaviour
 *                           'coinTrend' coin's 4H EMA50 must be above its 4H EMA200
 *                           'btcTrend'  BTC's last daily close must be above its daily EMA50
 *                           'both'      both of the above
 *  minHoursBetweenEntries no new BUY on the same coin within this many hours of
 *                         the previous one (live alert dedup uses the same value)
 */

const ORIGINAL = Object.freeze({
  name: 'v2-original',
  decideOn: '15m',
  stopAtrMult: 1.5,
  regime: 'none',
  minHoursBetweenEntries: 4,
});

// ↓↓↓ The live bot uses this. Replace with the block printed by `npm run research`.
const ACTIVE = ORIGINAL;

module.exports = { ORIGINAL, ACTIVE };
