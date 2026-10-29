/**
 * ─── Binance spot trading client (signed REST) ───────────────────────────────
 * Only what automated exits need: account, API-key restrictions, symbol rules,
 * place / cancel / query orders. Live: api.binance.com. Test mode:
 * testnet.binance.vision (fake money; keys from https://testnet.binance.vision).
 *
 * AUTOTRADE_DRY_RUN=true makes every order call a no-op that returns a fake
 * order — useful to watch what the bot WOULD do.
 */

const axios = require('axios');
const crypto = require('crypto');

const LIVE = 'https://api.binance.com';
const TESTNET = 'https://testnet.binance.vision';
const infoCache = new Map(); // `${base}|${symbol}` → { rules, at }

class BinanceError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

const isDryRun = () => String(process.env.AUTOTRADE_DRY_RUN || '').toLowerCase() === 'true';

/**
 * Binance only accepts trading keys locked to fixed IP addresses. Vercel has
 * none, so signed (account / order) requests go through a fixed-IP proxy when
 * FIXIE_URL (or TRADING_PROXY_URL) is set, e.g. http://fixie:PASS@host.usefixie.com:80.
 * Prices and charts don't need it and go direct.
 */
function proxyConfig() {
  const raw = process.env.TRADING_PROXY_URL || process.env.FIXIE_URL;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return { protocol: u.protocol.replace(':', ''), host: u.hostname, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      ...(u.username ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } : {}) };
  } catch { return undefined; }
}

/** The fixed IPs users must allow on their Binance key (Vercel setting TRADING_IPS="1.2.3.4,5.6.7.8"). */
const tradingIps = () => (process.env.TRADING_IPS || '').split(/[,\s]+/).filter(x => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));

function client({ apiKey, apiSecret, testnet }) {
  const base = testnet ? TESTNET : LIVE;

  async function signed(method, path, params = {}) {
    const q = new URLSearchParams({ ...stringify(params), recvWindow: '10000', timestamp: String(Date.now()) });
    q.append('signature', crypto.createHmac('sha256', apiSecret).update(q.toString()).digest('hex'));
    try {
      const proxy = proxyConfig();
      const r = await axios.request({ method, url: `${base}${path}?${q.toString()}`, headers: { 'X-MBX-APIKEY': apiKey }, timeout: 15000, ...(proxy ? { proxy } : {}) });
      return r.data;
    } catch (err) {
      const d = err?.response?.data;
      throw new BinanceError(d?.msg || err.message, d?.code, err?.response?.status);
    }
  }

  async function symbolRules(symbol) {
    const k = `${base}|${symbol}`;
    const hit = infoCache.get(k);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.rules;
    const r = await axios.get(`${base}/api/v3/exchangeInfo`, { params: { symbol }, timeout: 10000 });
    const s = r.data?.symbols?.[0];
    if (!s) throw new BinanceError(`${symbol} not found on Binance${testnet ? ' testnet' : ''}`);
    const f = Object.fromEntries((s.filters || []).map(x => [x.filterType, x]));
    const rules = {
      status: s.status,
      baseAsset: s.baseAsset,
      stepSize: Number(f.LOT_SIZE?.stepSize || '0.00000001'),
      minQty: Number(f.LOT_SIZE?.minQty || 0),
      tickSize: Number(f.PRICE_FILTER?.tickSize || '0.00000001'),
      minNotional: Number(f.NOTIONAL?.minNotional || f.MIN_NOTIONAL?.minNotional || 0),
      stopLossLimitAllowed: (s.orderTypes || []).includes('STOP_LOSS_LIMIT'),
    };
    infoCache.set(k, { rules, at: Date.now() });
    return rules;
  }

  let fakeId = 1;
  const fake = (params) => ({ orderId: `dry-${Date.now()}-${fakeId++}`, status: params.type === 'MARKET' ? 'FILLED' : 'NEW', executedQty: params.type === 'MARKET' ? params.quantity : '0', cummulativeQuoteQty: '0', dryRun: true, ...params });

  return {
    testnet: !!testnet,
    account: () => signed('GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    /** Live only (not on testnet): which permissions the key has. */
    apiRestrictions: () => (testnet ? Promise.resolve(null) : signed('GET', '/sapi/v1/account/apiRestrictions')),
    symbolRules,
    async freeBalance(asset) {
      const a = await signed('GET', '/api/v3/account', { omitZeroBalances: 'true' });
      return Number((a.balances || []).find(b => b.asset === asset)?.free || 0);
    },
    marketSell(symbol, quantity, clientId) {
      const p = { symbol, side: 'SELL', type: 'MARKET', quantity, newClientOrderId: clientId, newOrderRespType: 'FULL' };
      return isDryRun() ? Promise.resolve(fake(p)) : signed('POST', '/api/v3/order', p);
    },
    /** Market BUY spending `quoteQty` USDT. Used only by live auto-buy (locked until proven). */
    marketBuy(symbol, quoteQty, clientId) {
      const p = { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty, newClientOrderId: clientId, newOrderRespType: 'FULL' };
      return isDryRun() ? Promise.resolve(fake({ ...p, quantity: '0' })) : signed('POST', '/api/v3/order', p);
    },
    stopLossSell(symbol, quantity, stopPrice, limitPrice, clientId) {
      const p = { symbol, side: 'SELL', type: 'STOP_LOSS_LIMIT', timeInForce: 'GTC', quantity, stopPrice, price: limitPrice, newClientOrderId: clientId };
      return isDryRun() ? Promise.resolve(fake(p)) : signed('POST', '/api/v3/order', p);
    },
    cancel(symbol, orderId) {
      if (isDryRun() || String(orderId).startsWith('dry-')) return Promise.resolve({ orderId, status: 'CANCELED', dryRun: true });
      return signed('DELETE', '/api/v3/order', { symbol, orderId });
    },
    getOrder(symbol, orderId) {
      if (String(orderId).startsWith('dry-')) return Promise.resolve({ orderId, status: 'NEW', dryRun: true });
      return signed('GET', '/api/v3/order', { symbol, orderId });
    },
  };
}

function stringify(params) {
  const out = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

/** Round DOWN to the exchange's step (never sell more than you have). */
function floorToStep(value, step) {
  if (!(step > 0)) return value;
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  const n = Math.floor(value / step + 1e-9) * step;
  return Number(n.toFixed(decimals));
}

function toFixedStep(value, step) {
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return Number(value).toFixed(decimals);
}

module.exports = { client, floorToStep, toFixedStep, BinanceError, isDryRun, proxyConfig, tradingIps, LIVE, TESTNET };
