/**
 * GET /api/health?key=CRON_SECRET
 *
 * Checks, from wherever this function runs (Vercel region fra1 by default),
 * that every outside service the bot depends on is reachable:
 * Binance + its mirror, Kraken, KuCoin, CoinGecko, Upstash Redis, Telegram.
 * Use it after deploying, or point an uptime monitor at it.
 * Status 200 if everything critical works, 503 otherwise.
 */

const axios = require('axios');
const store = require('../src/lib/redis');
const tg = require('../src/lib/telegram');
const { BINANCE_BASE, BINANCE_DATA_BASE, KRAKEN_BASE, KUCOIN_BASE } = require('../src/lib/market');
const { cors, requireCronKey } = require('../src/lib/auth');
const { ACTIVE } = require('../src/config/strategy');
const { loadSavedStats } = require('../src/services/strategyStats');
const { PROVIDERS, DEFAULT_ORDER } = require('../src/lib/exchanges');

async function timed(fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - t, ...(detail || {}) };
  } catch (err) {
    return { ok: false, ms: Date.now() - t, status: err?.response?.status || null, error: (err.message || String(err)).replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<token>') };
  }
}

const ping = (url) => () => axios.get(url, { timeout: 6000 }).then(() => undefined);

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronKey(req, res)) return;

  const [binance, binanceMirror, kraken, kucoin, coingecko, redis, telegram] = await Promise.all([
    timed(ping(`${BINANCE_BASE}/ping`)),
    timed(ping(`${BINANCE_DATA_BASE}/ping`)),
    timed(ping(`${KRAKEN_BASE}/Time`)),
    timed(ping(`${KUCOIN_BASE}/timestamp`)),
    timed(ping('https://api.coingecko.com/api/v3/ping')),
    timed(async () => {
      if (!store.isEnabled()) throw new Error('UPSTASH_REDIS_REST_URL / _TOKEN not set — data is not saved');
      const key = `cryptobot:health:${Date.now()}`;
      await store.cmd('SET', key, '1', 'EX', 30);
      const v = await store.cmd('GET', key);
      await store.cmd('DEL', key);
      if (v !== '1') throw new Error('write/read mismatch');
    }),
    timed(async () => {
      const me = await tg.call('getMe', {}, 6000);
      const wh = await tg.call('getWebhookInfo', {}, 6000);
      return { bot: me.username, pendingUpdates: wh.pending_update_count, lastWebhookError: wh.last_error_message || null };
    }),
  ]);

  // Real end-to-end check of every exchange adapter: a BTC price + 5 closed hourly candles
  const exchangeChecks = Object.fromEntries(await Promise.all(DEFAULT_ORDER.map(async (id) => [id, await timed(async () => {
    const [price, candles] = await Promise.all([PROVIDERS[id].price('BTC'), PROVIDERS[id].klines('BTC', '1h', 5)]);
    if (!price) throw new Error('no BTC price');
    if (!candles.length || !(candles[candles.length - 1].close > 0)) throw new Error('no usable candles');
    const lastClose = candles[candles.length - 1].close;
    // Sanity: last hourly close within 10% of the live price → columns parsed correctly
    if (Math.abs(lastClose - price) / price > 0.1) throw new Error(`candle close ${lastClose} doesn't match price ${price}`);
    return { btc: price, candles: candles.length };
  })])));

  const checks = { binance, binanceMirror, kraken, kucoin, coingecko, redis, telegram };
  // Candles work if ANY of Binance / mirror / Kraken works
  const marketData = binance.ok || binanceMirror.ok || kraken.ok;
  const critical = marketData && redis.ok && telegram.ok;

  return res.status(critical ? 200 : 503).json({
    ok: critical,
    region: process.env.VERCEL_REGION || 'local',
    summary: {
      marketData: marketData ? (binance.ok ? 'Binance' : binanceMirror.ok ? 'Binance mirror' : 'Kraken only (limited history)') : 'DOWN',
      storage: redis.ok ? 'Upstash OK' : 'DOWN',
      telegram: telegram.ok ? 'OK' : 'DOWN',
      moonshotData: (binance.ok || binanceMirror.ok || kucoin.ok) && coingecko.ok ? 'OK' : 'degraded (Binance/KuCoin or CoinGecko unreachable)',
    },
    checks,
    exchanges: exchangeChecks,
    exchangesWorking: Object.entries(exchangeChecks).filter(([, c]) => c.ok).map(([id]) => PROVIDERS[id].name),
    strategy: ACTIVE,
    backtestStatsSaved: !!loadSavedStats(),
    autoBuyStrategy: (() => {
      const s = require('../src/services/autoBuyer').currentStrategy();
      return { id: s.id, verdict: s.verdict, labResultSaved: !s.missingFile, ...(s.missingFile ? { warning: 'data/auto-strategy.json is missing: using the last passing settings, but live auto-buy cannot be unlocked. Run `npm run lab -- --days 3000` and commit the file.' } : {}) };
    })(),
    aiHelper: (() => { const a = require('../src/services/aiHelper'); return a.isConfigured() ? { on: true, provider: a.provider(), model: a.model(), dailyLimitPerUser: a.dailyLimit() } : { on: false, howTo: 'add OPENAI_API_KEY or ANTHROPIC_API_KEY in Vercel' }; })(),
    autoExits: {
      available: require('../src/lib/secretBox').isConfigured(),
      dryRun: String(process.env.AUTOTRADE_DRY_RUN || '').toLowerCase() === 'true',
      fixedIpProxy: !!(process.env.FIXIE_URL || process.env.TRADING_PROXY_URL),
      tradingIps: require('../src/lib/binanceTrade').tradingIps(),
    },
    checkedAt: new Date().toISOString(),
  });
};
