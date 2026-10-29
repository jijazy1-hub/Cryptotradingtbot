/**
 * Test helpers: fake network (axios), synthetic candles, fake req/res.
 * Every module calls axios.get/axios.post at call time, so patching the shared
 * axios instance intercepts all exchange, Telegram and Upstash traffic.
 */
const axios = require('axios');

function makeCandles(n, { start = 100, drift = 0.002, intervalMs = 3_600_000, seed = 1, vol = 0.01 } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const t0 = Date.UTC(2026, 0, 1);
  const out = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const open = px;
    px = px * (1 + drift + (rnd() - 0.5) * vol);
    const high = Math.max(open, px) * (1 + rnd() * vol / 2);
    const low = Math.min(open, px) * (1 - rnd() * vol / 2);
    out.push({ time: t0 + i * intervalMs, open, high, low, close: px, volume: 1000 + rnd() * 500 });
  }
  return out;
}

const toBinanceRows = (candles) => candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]);

/**
 * Install a fake network.
 * opts.price      number   — ticker price returned for every symbol
 * opts.klines     fn(symbol, interval, limit) → candles (default synthetic uptrend)
 * opts.telegram   fn(method, payload) → { status, data } (default ok)
 * opts.extra      fn(method, url, a, b) → response | undefined
 * Returns { sent, calls } where `sent` are Telegram sendMessage payloads.
 */
function mockNet(opts = {}) {
  const sent = [];
  const calls = [];
  const price = opts.price ?? 110;
  const klines = opts.klines || ((sym, interval, limit) => {
    const ms = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 }[interval] || 3_600_000;
    return makeCandles(limit, { intervalMs: ms, start: 100 });
  });

  async function handle(method, url, a, b) {
    calls.push({ method, url, a, b });
    if (opts.extra) {
      const r = await opts.extra(method, url, a, b);
      if (r !== undefined) return r;
    }
    if (url.includes('api.telegram.org')) {
      const tgMethod = url.split('/').pop();
      if (opts.telegram) {
        const r = await opts.telegram(tgMethod, a);
        if (r && r.status >= 400) {
          const err = new Error(`Request failed with status code ${r.status}`);
          err.response = { status: r.status, data: r.data };
          throw err;
        }
        if (r) { if (tgMethod === 'sendMessage') sent.push(a); return { data: r.data }; }
      }
      if (tgMethod === 'sendMessage') sent.push(a);
      return { data: { ok: true, result: tgMethod === 'getMe' ? { username: 'TestBot' } : { message_id: sent.length } } };
    }
    if (url.includes('/klines')) {
      const p = (a && a.params) || {};
      return { data: toBinanceRows(klines(p.symbol, p.interval, p.limit)) };
    }
    if (url.includes('/ticker/price')) return { data: { price: String(price) } };
    const err = new Error(`Unmocked request: ${method} ${url}`);
    err.response = { status: 404, data: {} };
    throw err;
  }

  axios.get = (url, config) => handle('GET', url, config);
  axios.post = (url, data, config) => handle('POST', url, data, config);
  return { sent, calls };
}

function fakeReq({ method = 'GET', query = {}, body = undefined, headers = {}, url = '/test' } = {}) {
  return { method, query, body, headers, url };
}

function fakeRes() {
  const res = {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    end() { return this; },
  };
  return res;
}

function resetEnv(extra = {}) {
  for (const k of ['CRON_SECRET', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_INFO_CHANNEL_ID', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) delete process.env[k];
  process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_TOKEN_abcdef';
  process.env.TELEGRAM_CHAT_ID = '1000';
  Object.assign(process.env, extra);
  require('../src/lib/redis')._resetMemory();
  require('../src/services/positionStore')._resetMigrationCache();
  require('../src/services/profitTracker')._resetMigrationCache();
  require('../src/services/userService')._resetMigrationCache();
  require('../src/services/subscriptionService')._resetSettingsCache();
}

// Silence expected warnings in test output
console.warn = () => {};

module.exports = { makeCandles, mockNet, fakeReq, fakeRes, resetEnv };
