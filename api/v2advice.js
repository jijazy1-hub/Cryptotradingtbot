/**
 * ─── V2 Position Advice API ───────────────────────────────────────────────────
 * GET  /api/v2advice?symbol=SOLUSDT&buyPrice=150&account=10000&risk=1&qty=2
 *      (accountSize= / riskPct= are accepted as aliases)
 * POST /api/v2advice — body: { symbol, buyPrice, accountSize, riskPct, quantity }
 *
 * Read-only: returns advice, sends nothing. Logic lives in
 * src/services/adviceService.js (ATR stop, 3 TPs, trailing stop, sizing).
 */

const { fetchCurrentData, buildAdvice } = require('../src/services/adviceService');
const { normaliseSymbol } = require('../src/lib/market');
const { cors } = require('../src/lib/auth');

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

module.exports = async (req, res) => {
  cors(res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const symbol      = src.symbol;
    const buyPrice    = num(src.buyPrice);
    const accountSize = num(src.accountSize ?? src.account);
    const riskPct     = num(src.riskPct ?? src.risk) || 1;
    const quantity    = num(src.quantity ?? src.qty);

    if (!symbol || !buyPrice || buyPrice <= 0) {
      return res.status(400).json({
        success: false,
        error: 'symbol and buyPrice required. Example: ?symbol=SOLUSDT&buyPrice=150&account=10000&risk=1',
      });
    }

    const sym = normaliseSymbol(symbol);
    const { candles1h, candles4h, currentPrice, exchange } = await fetchCurrentData(sym);
    const advice = buildAdvice({ symbol: sym, buyPrice, currentPrice, candles1h, candles4h, accountSize, riskPct });
    advice.exchange = exchange;
    if (quantity) advice.quantity = quantity;

    return res.status(200).json({ success: true, advice });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Named exports kept for anything that imported them from here
module.exports.fetchCurrentData = fetchCurrentData;
module.exports.buildAdvice      = buildAdvice;
