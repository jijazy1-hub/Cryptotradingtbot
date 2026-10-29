/**
 * ─── Market data (single shared copy) ────────────────────────────────────────
 * Candles:  Binance → Binance public data mirror → Kraken fallback.
 *           (api.binance.com blocks some regions, e.g. US servers; the
 *           data-api.binance.vision mirror serves the same public market data.)
 * Price:    Binance → Binance mirror → KuCoin → Kraken fallback.
 *
 * Candle shape everywhere: { time (ms, candle open), open, high, low, close, volume }
 *
 * closedOnly: Binance includes the still-forming candle as the last row. Signals
 * computed on it "repaint" (a BUY at 10:07 can vanish by 10:15) and can't be
 * backtested honestly, so the scanner asks for closed candles only.
 */

const axios = require('axios');
const store = require('./redis');
const { PROVIDERS, DEFAULT_ORDER, normaliseExchange, baseOf } = require('./exchanges');

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const BINANCE_DATA_BASE = 'https://data-api.binance.vision/api/v3';
const KRAKEN_BASE  = 'https://api.kraken.com/0/public';
const KUCOIN_BASE  = 'https://api.kucoin.com/api/v1';

const INTERVAL_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

const KRAKEN_INTERVAL_MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '4h': 240, '1d': 1440 };

// Binance symbol → Kraken pair (anything not listed: SOLUSDT → SOLUSD)
const KRAKEN_MAP = {
  BTCUSDT: 'XBTUSD', BTCUSD: 'XBTUSD', ETHUSDT: 'ETHUSD', SOLUSDT: 'SOLUSD', BNBUSDT: 'BNBUSD',
  XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD', DOGEUSDT: 'DOGEUSD', AVAXUSDT: 'AVAXUSD',
  DOTUSDT: 'DOTUSD', MATICUSDT: 'MATICUSD', LINKUSDT: 'LINKUSD', LTCUSDT: 'LTCUSD',
  UNIUSDT: 'UNIUSD', ATOMUSDT: 'ATOMUSD', NEARUSDT: 'NEARUSD', APTUSDT: 'APTUSD',
  SUIUSDT: 'SUIUSD', INJUSDT: 'INJUSD', ARBUSDT: 'ARBUSD', OPUSDT: 'OPUSD',
};

function toKrakenPair(symbol) {
  const u = String(symbol).toUpperCase();
  if (KRAKEN_MAP[u]) return KRAKEN_MAP[u];
  return u.endsWith('USDT') ? u.slice(0, -1) : u;
}

function toKuCoinSymbol(symbol) {
  const u = String(symbol).toUpperCase();
  return u.endsWith('USDT') ? `${u.slice(0, -4)}-USDT` : u;
}

function parseBinance(rows) {
  return rows.map(c => ({
    time: Number(c[0]), open: Number(c[1]), high: Number(c[2]),
    low: Number(c[3]), close: Number(c[4]), volume: Number(c[5]),
  }));
}

/** Binance klines with paging for limit > 1000. */
async function binanceKlines(symbol, interval, limit, startTime = null, base = BINANCE_BASE) {
  if (!INTERVAL_MS[interval]) throw new Error(`Unsupported interval: ${interval}`);
  const out = [];
  const batch = 1000;
  let remaining = limit;
  let nextStart = startTime;
  if (!nextStart && limit > batch) nextStart = Date.now() - INTERVAL_MS[interval] * limit;

  while (remaining > 0) {
    const reqLimit = Math.min(batch, remaining);
    const params = { symbol, interval, limit: reqLimit };
    if (nextStart) params.startTime = nextStart;
    const r = await axios.get(`${base}/klines`, { params, timeout: 15000 });
    const page = parseBinance(r.data);
    if (!page.length) break;
    out.push(...page);
    remaining -= page.length;
    if (page.length < reqLimit) break;
    nextStart = page[page.length - 1].time + INTERVAL_MS[interval];
  }
  return out.slice(-limit);
}

/** Kraken OHLC (max ~720 candles, in-progress candle dropped). */
async function krakenKlines(symbol, interval, limit) {
  const intervalMin = KRAKEN_INTERVAL_MIN[interval];
  if (!intervalMin) throw new Error(`Kraken does not support interval ${interval}`);
  const pair = toKrakenPair(symbol);
  const r = await axios.get(`${KRAKEN_BASE}/OHLC`, {
    params: { pair, interval: intervalMin },
    timeout: 12000,
    headers: { 'User-Agent': 'CryptoBotV2/2.2' },
  });
  if (r.data.error && r.data.error.length) throw new Error(`Kraken: ${r.data.error.join(', ')}`);
  const key = Object.keys(r.data.result || {}).find(k => k !== 'last');
  if (!key) throw new Error(`Kraken: no OHLC data for ${pair}`);
  return r.data.result[key].slice(0, -1).slice(-limit).map(c => ({
    time: Number(c[0]) * 1000, open: Number(c[1]), high: Number(c[2]),
    low: Number(c[3]), close: Number(c[4]), volume: Number(c[6]),
  }));
}

function dropUnclosed(candles, interval, now = Date.now()) {
  const ms = INTERVAL_MS[interval];
  return candles.filter(c => c.time + ms <= now);
}

/**
 * Candles with automatic fallback.
 * @param {object} [opts]
 * @param {number} [opts.startTime]   ms; for long history requests (Binance paging)
 * @param {boolean} [opts.closedOnly] drop the still-forming candle
 * @param {string} [opts.exchange]    use ONLY this exchange (a position's own exchange).
 *        No cross-exchange fallback then: the same ticker on another exchange
 *        can be a different token.
 * @returns {Promise<{candles: Array, exchange: string}>}
 */
async function fetchKlinesWithSource(symbol, interval, limit, { startTime = null, closedOnly = false, exchange = null } = {}) {
  const want = closedOnly ? limit + 1 : limit;
  const finish = (candles, ex) => ({
    candles: (closedOnly ? dropUnclosed(candles, interval) : candles).slice(-limit),
    exchange: ex,
  });
  const pinned = normaliseExchange(exchange);
  const base = baseOf(symbol);
  const errors = [];

  if (!pinned || pinned === 'binance') {
    try { return finish(await binanceKlines(symbol, interval, want, startTime), 'Binance'); }
    catch (e) { errors.push(`Binance: ${e.message}`); }
    try { return finish(await binanceKlines(symbol, interval, want, startTime, BINANCE_DATA_BASE), 'Binance'); }
    catch (e) { errors.push(`Binance mirror: ${e.message}`); }
    if (pinned) throw new Error(`No candle data for ${symbol} ${interval} on Binance (${errors.join('; ')})`);
  }

  const order = pinned ? [pinned] : DEFAULT_ORDER.filter(id => id !== 'binance');
  for (const id of order) {
    const p = PROVIDERS[id];
    if (id !== 'kraken' && limit > p.maxLimit && !pinned) continue; // not enough history there
    try {
      const candles = await p.klines(base, interval, want);
      if (candles.length) return finish(candles, p.name);
      errors.push(`${p.name}: no candles`);
    } catch (e) { errors.push(`${p.name}: ${e.message}`); }
  }
  throw new Error(`No candle data for ${symbol} ${interval} (${errors.join('; ')})`);
}

async function fetchKlines(symbol, interval, limit, opts) {
  return (await fetchKlinesWithSource(symbol, interval, limit, opts)).candles;
}

/** GET a Binance public endpoint, falling back to the data-api mirror. */
async function binanceGet(pathname, config = {}) {
  try {
    return await axios.get(`${BINANCE_BASE}${pathname}`, { timeout: 15000, ...config });
  } catch (err) {
    return axios.get(`${BINANCE_DATA_BASE}${pathname}`, { timeout: 15000, ...config });
  }
}

/**
 * Latest price. With `exchange`, only that exchange is asked (see note on
 * fetchKlinesWithSource). Without it: Binance, then the other exchanges.
 * Returns null if every source fails.
 */
async function fetchPrice(symbol, { exchange = null } = {}) {
  const pinned = normaliseExchange(exchange);
  const order = pinned ? [pinned] : DEFAULT_ORDER;
  for (const id of order) {
    try {
      const p = await PROVIDERS[id].price(baseOf(symbol));
      if (p) return p;
    } catch { /* try the next exchange */ }
  }
  return null;
}

/**
 * Which exchange lists this coin? Checks in DEFAULT_ORDER (or just `preferred`)
 * and remembers the answer for 7 days.
 * @returns {Promise<{exchange: string, name: string, price: number}|null>}
 */
async function resolveExchange(symbol, preferred = null) {
  const base = baseOf(symbol);
  const pinned = normaliseExchange(preferred);
  const cacheKey = `cryptobot:coinex:${base}`;
  if (!pinned) {
    try {
      const cached = await store.cmd('GET', cacheKey);
      if (cached && PROVIDERS[cached]) {
        const price = await PROVIDERS[cached].price(base).catch(() => null);
        if (price) return { exchange: cached, name: PROVIDERS[cached].name, price };
      }
    } catch { /* cache unavailable */ }
  }
  for (const id of pinned ? [pinned] : DEFAULT_ORDER) {
    try {
      const price = await PROVIDERS[id].price(base);
      if (price) {
        if (!pinned) await store.cmd('SET', cacheKey, id, 'EX', 7 * 86400).catch(() => {});
        return { exchange: id, name: PROVIDERS[id].name, price };
      }
    } catch { /* not listed / unreachable */ }
  }
  return null;
}

/** Comma-separated BINANCE_SYMBOLS → array. */
function configuredSymbols(fallback = 'SOLUSDT,BTCUSDT,ETHUSDT') {
  const raw = process.env.BINANCE_SYMBOLS || process.env.BINANCE_SYMBOL || fallback;
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/** "sol" / "SOL" / "solusdt" → "SOLUSDT" */
function normaliseSymbol(raw) {
  const u = String(raw || '').toUpperCase().trim().replace('/', '');
  return u.endsWith('USDT') ? u : `${u}USDT`;
}

module.exports = {
  INTERVAL_MS, toKrakenPair, toKuCoinSymbol, dropUnclosed, binanceGet,
  BINANCE_BASE, BINANCE_DATA_BASE, KRAKEN_BASE, KUCOIN_BASE,
  fetchKlines, fetchKlinesWithSource, fetchPrice, resolveExchange,
  configuredSymbols, normaliseSymbol,
};
