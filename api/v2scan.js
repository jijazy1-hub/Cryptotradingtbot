/**
 * ─── V2 Multi-Timeframe Scanner ──────────────────────────────────────────────
 * GET /api/v2scan
 *
 * Scans BINANCE_SYMBOLS with the shared scan engine (src/services/scanEngine.js).
 *
 * Alerts: when CRON_SECRET is set, Telegram alerts are only sent for calls that
 * carry the key (your cron job). The dashboard / public calls just get data,
 * so nobody can spam your channel by refreshing this URL.
 */

const { scanSymbols } = require('../src/services/scanEngine');
const { sendBuyAlert, sendBearishAlert } = require('../src/services/telegramService');
const { configuredSymbols } = require('../src/lib/market');
const { cors, mayAlert } = require('../src/lib/auth');

async function sendAlerts(results) {
  for (const r of results) {
    try {
      if (r.signal === 'BUY') await sendBuyAlert(r);
      else if (r.signal === 'BEARISH_ALERT') await sendBearishAlert(r);
    } catch (err) {
      console.error(`[v2scan] Alert for ${r.symbol} failed (non-fatal):`, err.message);
    }
  }
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const results = await scanSymbols(configuredSymbols());
    const alerting = mayAlert(req);

    // Alerts are awaited (not fire-and-forget) — on serverless, work left
    // running after the response is sent can be frozen and never complete.
    if (alerting) await sendAlerts(results);

    return res.status(200).json({
      success: true,
      count: results.length,
      buySignals: results.filter(r => r.signal === 'BUY').length,
      alertsSent: alerting,
      results,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Back-compat for anything that imported the engine from here
module.exports.evaluateSignal = require('../src/services/scanEngine').evaluateSignal;
