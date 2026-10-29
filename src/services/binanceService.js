/**
 * Thin wrapper kept for backwards compatibility (backtest.js / liveService).
 * All fetching now lives in src/lib/market.js (Binance → Kraken fallback).
 */
const market = require('../lib/market');

async function fetchHistoricalKlines(symbol, interval, limit = 500, startTime = null) {
  return market.fetchKlines(symbol, interval, limit, { startTime });
}

async function fetchLatestPrice(symbol) {
  const price = await market.fetchPrice(symbol);
  if (price === null) throw new Error(`Could not fetch price for ${symbol}`);
  return price;
}

module.exports = { fetchHistoricalKlines, fetchLatestPrice };
