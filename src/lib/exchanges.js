/**
 * ─── Exchange price & candle providers ───────────────────────────────────────
 * One small adapter per exchange, all public endpoints (no API keys).
 * Every adapter returns candles in the app's shape, oldest first, CLOSED only:
 *   { time (ms, candle open), open, high, low, close, volume }
 *
 * Supported: Binance (+ its public data mirror), Bybit, OKX, Gate, MEXC,
 * KuCoin, Kraken. Symbols are given as the base coin, e.g. 'SOL', always
 * quoted in USDT (Kraken: USD).
 */

const axios = require('axios');

const INTERVAL_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const T = { timeout: 8000 };

const num = (x) => Number(x);
const closed = (candles, interval, now = Date.now()) =>
  candles.filter(c => c.time + INTERVAL_MS[interval] <= now).sort((a, b) => a.time - b.time);
const positive = (p) => (Number.isFinite(p) && p > 0 ? p : null);

const KRAKEN_ALIASES = { BTC: 'XBT', DOGE: 'XDG' };

const PROVIDERS = {
  binance: {
    name: 'Binance',
    maxLimit: 1000,
    async price(base) {
      for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
        try {
          const r = await axios.get(`${host}/api/v3/ticker/price`, { ...T, params: { symbol: `${base}USDT` } });
          const p = positive(num(r.data.price));
          if (p) return p;
        } catch { /* try next host */ }
      }
      return null;
    },
    async klines(base, interval, limit) {
      let lastErr;
      for (const host of ['https://api.binance.com', 'https://data-api.binance.vision']) {
        try {
          const r = await axios.get(`${host}/api/v3/klines`, { ...T, params: { symbol: `${base}USDT`, interval, limit: Math.min(1000, limit + 1) } });
          return closed(r.data.map(c => ({ time: num(c[0]), open: num(c[1]), high: num(c[2]), low: num(c[3]), close: num(c[4]), volume: num(c[5]) })), interval);
        } catch (e) { lastErr = e; }
      }
      throw lastErr;
    },
  },

  bybit: {
    name: 'Bybit',
    maxLimit: 1000,
    async price(base) {
      const r = await axios.get('https://api.bybit.com/v5/market/tickers', { ...T, params: { category: 'spot', symbol: `${base}USDT` } });
      return positive(num(r.data?.result?.list?.[0]?.lastPrice));
    },
    async klines(base, interval, limit) {
      const iv = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' }[interval];
      const r = await axios.get('https://api.bybit.com/v5/market/kline', { ...T, params: { category: 'spot', symbol: `${base}USDT`, interval: iv, limit: Math.min(1000, limit + 1) } });
      if (r.data?.retCode !== 0) throw new Error(`Bybit: ${r.data?.retMsg || 'error'}`);
      return closed((r.data.result.list || []).map(c => ({ time: num(c[0]), open: num(c[1]), high: num(c[2]), low: num(c[3]), close: num(c[4]), volume: num(c[5]) })), interval);
    },
  },

  okx: {
    name: 'OKX',
    maxLimit: 300,
    async price(base) {
      const r = await axios.get('https://www.okx.com/api/v5/market/ticker', { ...T, params: { instId: `${base}-USDT` } });
      return positive(num(r.data?.data?.[0]?.last));
    },
    async klines(base, interval, limit) {
      const bar = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' }[interval];
      const r = await axios.get('https://www.okx.com/api/v5/market/candles', { ...T, params: { instId: `${base}-USDT`, bar, limit: Math.min(300, limit + 1) } });
      if (r.data?.code !== '0') throw new Error(`OKX: ${r.data?.msg || 'error'}`);
      return closed((r.data.data || []).filter(c => c[8] !== '0').map(c => ({ time: num(c[0]), open: num(c[1]), high: num(c[2]), low: num(c[3]), close: num(c[4]), volume: num(c[5]) })), interval);
    },
  },

  gate: {
    name: 'Gate',
    maxLimit: 1000,
    async price(base) {
      const r = await axios.get('https://api.gateio.ws/api/v4/spot/tickers', { ...T, params: { currency_pair: `${base}_USDT` } });
      return positive(num(r.data?.[0]?.last));
    },
    async klines(base, interval, limit) {
      // rows: [time(s), quote volume, close, high, low, open, base volume, finished]
      const r = await axios.get('https://api.gateio.ws/api/v4/spot/candlesticks', { ...T, params: { currency_pair: `${base}_USDT`, interval, limit: Math.min(1000, limit + 1) } });
      return closed((r.data || []).filter(c => c[7] === undefined || String(c[7]) === 'true').map(c => ({ time: num(c[0]) * 1000, open: num(c[5]), high: num(c[3]), low: num(c[4]), close: num(c[2]), volume: num(c[6]) })), interval);
    },
  },

  mexc: {
    name: 'MEXC',
    maxLimit: 1000,
    async price(base) {
      const r = await axios.get('https://api.mexc.com/api/v3/ticker/price', { ...T, params: { symbol: `${base}USDT` } });
      return positive(num(r.data?.price));
    },
    async klines(base, interval, limit) {
      const iv = { '15m': '15m', '1h': '60m', '4h': '4h', '1d': '1d' }[interval];
      const r = await axios.get('https://api.mexc.com/api/v3/klines', { ...T, params: { symbol: `${base}USDT`, interval: iv, limit: Math.min(1000, limit + 1) } });
      return closed(r.data.map(c => ({ time: num(c[0]), open: num(c[1]), high: num(c[2]), low: num(c[3]), close: num(c[4]), volume: num(c[5]) })), interval);
    },
  },

  kucoin: {
    name: 'KuCoin',
    maxLimit: 1500,
    async price(base) {
      const r = await axios.get('https://api.kucoin.com/api/v1/market/orderbook/level1', { ...T, params: { symbol: `${base}-USDT` } });
      return positive(num(r.data?.data?.price));
    },
    async klines(base, interval, limit) {
      const type = { '15m': '15min', '1h': '1hour', '4h': '4hour', '1d': '1day' }[interval];
      const endAt = Math.floor(Date.now() / 1000);
      const startAt = endAt - Math.ceil((INTERVAL_MS[interval] / 1000) * (limit + 2));
      // rows: [time(s), open, close, high, low, volume, turnover], newest first
      const r = await axios.get('https://api.kucoin.com/api/v1/market/candles', { ...T, params: { symbol: `${base}-USDT`, type, startAt, endAt } });
      if (r.data?.code !== '200000') throw new Error(`KuCoin: ${r.data?.msg || 'error'}`);
      return closed((r.data.data || []).map(c => ({ time: num(c[0]) * 1000, open: num(c[1]), high: num(c[3]), low: num(c[4]), close: num(c[2]), volume: num(c[5]) })), interval);
    },
  },

  kraken: {
    name: 'Kraken',
    maxLimit: 720,
    async price(base) {
      const pair = `${KRAKEN_ALIASES[base] || base}USD`;
      const r = await axios.get('https://api.kraken.com/0/public/Ticker', { ...T, params: { pair } });
      const key = Object.keys(r.data?.result || {})[0];
      return key ? positive(num(r.data.result[key].c[0])) : null;
    },
    async klines(base, interval, limit) {
      const iv = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 }[interval];
      const pair = `${KRAKEN_ALIASES[base] || base}USD`;
      const r = await axios.get('https://api.kraken.com/0/public/OHLC', { ...T, params: { pair, interval: iv } });
      if (r.data.error?.length) throw new Error(`Kraken: ${r.data.error.join(', ')}`);
      const key = Object.keys(r.data.result || {}).find(k => k !== 'last');
      return closed(r.data.result[key].map(c => ({ time: num(c[0]) * 1000, open: num(c[1]), high: num(c[2]), low: num(c[3]), close: num(c[4]), volume: num(c[6]) })), interval);
    },
  },
};

/** Order tried when a coin's exchange isn't known yet. */
const DEFAULT_ORDER = ['binance', 'bybit', 'okx', 'gate', 'mexc', 'kucoin', 'kraken'];

const ALIASES = { gateio: 'gate', 'gate.io': 'gate', okex: 'okx', kc: 'kucoin' };
function normaliseExchange(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().trim();
  const id = ALIASES[k] || k;
  return PROVIDERS[id] ? id : null;
}

const baseOf = (symbol) => String(symbol).toUpperCase().replace(/USDT$/, '');

module.exports = { PROVIDERS, DEFAULT_ORDER, normaliseExchange, baseOf, INTERVAL_MS };
