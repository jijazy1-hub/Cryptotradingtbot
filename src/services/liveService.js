/**
 * Local runner used by index.js (one-off) and scheduler.js (cron).
 * Uses the same scan engine as /api/v2scan, so local and deployed signals match.
 */
require('dotenv').config();
const { scanSymbols } = require('./scanEngine');
const { sendSignalAlert } = require('./telegramService');
const { saveSignals } = require('./storageService');
const { configuredSymbols } = require('../lib/market');

function getSymbols() {
  return configuredSymbols('SOLUSDT');
}

const fmt = (n, d = 2) => (typeof n === 'number' && isFinite(n) ? n.toFixed(d) : 'n/a');

async function runLiveCheck() {
  const results = await scanSymbols(getSymbols());

  for (const r of results) {
    console.log(`=== ${r.symbol} MTF SIGNAL ===`);
    if (r.signal === 'ERROR') {
      console.error(`Live check failed for ${r.symbol}: ${r.error}`);
      continue;
    }
    console.log(`Signal: ${r.signal}  Score: ${r.score}  Confidence: ${r.confidence}%  Trend: ${r.trend ?? 'n/a'}`);
    console.log(`Price: ${fmt(r.price, 4)}  RSI: ${fmt(r.rsi)}  EMA50: ${fmt(r.ema50, 4)}  EMA200(4h): ${fmt(r.ema200, 4)}  ADX: ${fmt(r.adxValue)}`);
    (r.factors || []).forEach(f => console.log(`  • ${f}`));

    if (r.signal === 'BUY' || r.signal === 'BEARISH_ALERT') {
      try {
        await sendSignalAlert(r);
        console.log('Telegram alert processed (dedup may skip repeats).');
      } catch (err) {
        console.error('Telegram alert failed:', err.message);
      }
    }
  }

  saveSignals(results, 'signals.json');
  return results;
}

module.exports = { runLiveCheck, getSymbols };
