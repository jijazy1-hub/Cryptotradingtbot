/**
 * v2.23: the bot looks at EVERY liquid Binance USDT coin with the same strategy,
 * and (by default) sells every auto-bought position at the daily run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { mockNet, resetEnv } = require('./helpers');

const DAY = 86_400_000;
const ENC = '0123456789abcdef'.repeat(4);
const KEY = 'A'.repeat(64), SECRET = 'b'.repeat(64);

/** Steady uptrend: every day's close is a new high (a breakout signal today). */
function trendDaily(limit, growth = 0.003) {
  const end = Math.floor(Date.now() / DAY) * DAY;
  const out = [];
  let prev = 100;
  for (let i = 0; i < limit; i++) {
    const close = 100 * (1 + growth) ** i;
    out.push({ time: end - (limit - i) * DAY, open: prev, high: close * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1 });
    prev = close;
  }
  return out;
}
const price0 = trendDaily(300).at(-1).close * 1.002;
const at = (dayOffset, min = 10) => new Date(Math.floor(Date.now() / DAY) * DAY + dayOffset * DAY + min * 60_000);

/** n fake coins, most-traded first, plus a stablecoin, a thin coin and a halted coin. */
function binanceLists(n = 40) {
  const coins = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', ...Array.from({ length: n - 5 }, (_, i) => `COIN${i}`)];
  const tickers = coins.map((c, i) => ({ symbol: `${c}USDT`, quoteVolume: String(900_000_000 - i * 10_000_000) }));
  tickers.push({ symbol: 'USDCUSDT', quoteVolume: '999999999' }, { symbol: 'THINUSDT', quoteVolume: '50000' }, { symbol: 'HALTUSDT', quoteVolume: '5000000' }, { symbol: 'ETHBTC', quoteVolume: '700000000' });
  const symbols = [...coins.map(c => ({ symbol: `${c}USDT`, status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true })),
    { symbol: 'USDCUSDT', status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true },
    { symbol: 'THINUSDT', status: 'TRADING', quoteAsset: 'USDT', isSpotTradingAllowed: true }];
  return { coins, tickers, symbols };
}

function setup({ dailyClose = true, coins = 40, env = {} } = {}) {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json'), ...env });
  delete process.env.AUTOBUY_UNIVERSE; delete process.env.AUTOBUY_MIN_VOLUME_USD; delete process.env.AUTOBUY_MAX_COINS;
  process.env.AUTOBUY_DAILY_CLOSE = dailyClose ? 'true' : 'false';
  require('../src/services/universe')._reset();
  const lists = binanceLists(coins);
  const net = mockNet({
    price: price0,
    klines: (sym, interval, limit) => (interval === '1d' ? trendDaily(limit) : interval === '1m'
      ? [{ time: Date.now() - 60_000, open: price0, high: price0, low: price0, close: price0, volume: 1 }]
      : trendDaily(limit)),
    extra: (method, url) => {
      if (url.includes('/ticker/24hr')) return { data: lists.tickers };
      if (url.includes('/exchangeInfo') && !url.includes('symbol=')) {
        // the full list (called without a symbol). Per-symbol rule lookups are answered by the tests that need them.
        return undefined;
      }
      return undefined;
    },
  });
  return { net, lists, ab: require('../src/services/autoBuyer'), practice: require('../src/services/practiceService') };
}

// ─── Which coins ─────────────────────────────────────────────────────────────
test('universe: liquid USDT spot coins, most-traded first; no stablecoins, thin or non-USDT pairs', () => {
  const { pickFromTickers } = require('../src/services/universe');
  const { tickers } = binanceLists(12);
  const list = pickFromTickers(tickers, null, { minVolume: 1_000_000, max: 400 });
  assert.equal(list[0], 'BTCUSDT');
  assert.ok(!list.includes('USDCUSDT'), 'stablecoin left out even though it has the most volume');
  assert.ok(!list.includes('THINUSDT'), 'below the $1M/day floor');
  assert.ok(!list.includes('ETHBTC'), 'only USDT pairs');
  assert.ok(list.includes('HALTUSDT'), 'without Binance\'s status list it can\'t be told apart');
  assert.deepEqual(pickFromTickers(tickers, new Set(['BTCUSDT', 'ETHUSDT']), { minVolume: 0, max: 400 }), ['BTCUSDT', 'ETHUSDT'].filter(Boolean), 'only coins Binance says are TRADING');
  assert.equal(pickFromTickers(tickers, null, { minVolume: 1_000_000, max: 3 }).length, 3, 'AUTOBUY_MAX_COINS caps the list');
});

test('universe: resolved from Binance (status-checked), cached, your own list wins, 15 core coins if Binance is down', async () => {
  const { net, lists } = setup();
  const { resolveUniverse } = require('../src/services/universe');
  // The status list marks HALTUSDT as not trading → it is dropped
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo') ? Promise.resolve({ data: { symbols: lists.symbols } }) : get(url, cfg));
  const u = await resolveUniverse();
  assert.equal(u.source, 'all');
  assert.equal(u.symbols.length, 40);
  assert.ok(!u.symbols.includes('HALTUSDT') && !u.symbols.includes('USDCUSDT') && !u.symbols.includes('THINUSDT'));
  const calls = net.calls.length;
  await resolveUniverse();
  assert.equal(net.calls.length, calls, 'second call is served from the cache');

  process.env.AUTOBUY_UNIVERSE = 'BTC,ETH';
  assert.deepEqual((await resolveUniverse()).symbols, ['BTCUSDT', 'ETHUSDT'], 'an explicit list overrides "all coins"');
  delete process.env.AUTOBUY_UNIVERSE;

  require('../src/services/universe')._reset();
  await require('../src/lib/redis').cmd('DEL', 'cryptobot:autobuy:universe');
  axios.get = () => Promise.reject(new Error('Binance down'));
  const fb = await resolveUniverse({ force: true });
  assert.equal(fb.source, 'core-fallback');
  assert.equal(fb.symbols.length, 15);
});

test('daily run scans every coin with the same strategy; the most-traded signals are bought first; the admin sees the coverage', async () => {
  const { net, ab, practice, lists } = setup({ dailyClose: false });
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo') ? Promise.resolve({ data: { symbols: lists.symbols } }) : get(url, cfg));
  const sent = [];
  const r = await ab.runDaily({ allowed: new Set(['1000']), send: async (id, text) => sent.push({ id: String(id), text }), now: at(0) });
  assert.equal(r.signals, 40, 'all 40 liquid coins were checked and all of them signal in this synthetic uptrend');
  const house = await practice.summary('house');
  assert.deepEqual(house.positions.map(p => p.symbol).sort(), ['BNBUSDT', 'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'], 'max 5 positions: the 5 most-traded coins');
  const report = sent.find(m => /Auto-buy daily check/.test(m.text));
  assert.match(report.text, /Checked 40 of 40 coins/);
  assert.match(report.text, /and 28 more/, 'a long signal list is cut short for Telegram');

  const t = await ab.coinTable();
  assert.equal(t.total, 40);
  assert.equal(t.rows.length, 25, 'the stops table is capped for Telegram');
  assert.ok(t.rows.every(x => x.signal));
});

// ─── The daily close ─────────────────────────────────────────────────────────
test('daily close is ON unless AUTOBUY_DAILY_CLOSE says otherwise', () => {
  const cfg = require('../src/config/autobuy');
  delete process.env.AUTOBUY_DAILY_CLOSE;
  assert.equal(cfg.dailyClose(), true);
  for (const off of ['false', 'FALSE', '0', 'off', 'no']) { process.env.AUTOBUY_DAILY_CLOSE = off; assert.equal(cfg.dailyClose(), false, off); }
  process.env.AUTOBUY_DAILY_CLOSE = 'true';
  assert.equal(cfg.dailyClose(), true);
});

test('practice: every auto-bought position is sold at the next daily run, then new signals are bought; Buy Now picks are left alone', async () => {
  const { ab, practice } = setup({ coins: 8 });
  await ab.setPractice('2000', true);
  const sent = [];
  const send = async (id, text) => sent.push({ id: String(id), text });
  const allowed = new Set(['1000', '2000']);

  await ab.runDaily({ allowed, send, now: at(0) });
  const mine = async () => (await practice.summary('2000')).positions;
  assert.equal((await mine()).length, 5);
  assert.equal((await practice.getTrades('house')).length, 0, 'nothing closed on day 1');
  await ab.buyNow('2000', { symbol: 'LINK', amount: 200, mode: 'practice' }); // the user's own pick
  const before = (await mine()).map(p => p.id);

  sent.length = 0;
  await ab.runDaily({ allowed, send, now: at(1) });
  const trades = await practice.getTrades('2000');
  assert.equal(trades.length, 5, 'the 5 auto-bought positions were closed');
  assert.ok(trades.every(t => t.exits.includes('manual')), 'sold at the daily close');
  const after = await mine();
  assert.ok(after.some(p => p.symbol === 'LINKUSDT' && before.includes(p.id)), 'Buy Now position still open, same position');
  assert.equal(after.filter(p => p.auto && !p.manual).length, 5, 'today\'s signals were bought again');
  assert.ok(!after.some(p => before.includes(p.id) && p.symbol !== 'LINKUSDT'), 'yesterday\'s auto positions are gone');

  const close = sent.filter(m => m.id === '2000' && /PRACTICE · 🔔 \*Daily close — \w+\*/.test(m.text));
  assert.equal(close.length, 5);
  assert.match(close[0].text, /Sold at ~\$[\d.]+ · (?:✅|🔻) [+-]\$[\d.]+ \([+-][\d.]+%\) after fees/);
  assert.ok(sent.some(m => m.id === '1000' && /HOUSE forward test · 🔔 \*Daily close/.test(m.text)), 'the admin sees the house account\'s closes');
  assert.equal((await practice.getTrades('house')).length, 5);
});

test('daily close OFF: positions are held and only the trailing stop moves (the original behaviour)', async () => {
  const { ab, practice } = setup({ dailyClose: false, coins: 8 });
  await ab.runDaily({ allowed: new Set(['1000']), send: async () => {}, now: at(0) });
  const ids = (await practice.summary('house')).positions.map(p => p.id).sort();
  await ab.runDaily({ allowed: new Set(['1000']), send: async () => {}, now: at(1) });
  assert.deepEqual((await practice.summary('house')).positions.map(p => p.id).sort(), ids);
  assert.equal((await practice.getTrades('house')).length, 0);
});

test('live: the daily run cancels the Binance stop, sells at market, records the trade and buys today\'s signals', async () => {
  const { ab } = setup({ coins: 8 });
  const store = require('../src/lib/redis');
  const orders = [];
  const events = [];
  axios.request = async ({ method, url }) => {
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v3/account') return { data: { canTrade: true, balances: [{ asset: 'USDT', free: '5000' }, ...['SOL', 'BTC', 'ETH', 'BNB', 'XRP'].map(asset => ({ asset, free: '50' }))] } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      const id = orders.length + 1;
      if (p.side === 'BUY') {
        orders.push({ ...p, id }); events.push(`buy:${p.symbol}`);
        const q = Number(p.quoteOrderQty) / price0;
        return { data: { orderId: id, status: 'FILLED', executedQty: String(q), cummulativeQuoteQty: p.quoteOrderQty, fills: [{ commission: String(q * 0.001), commissionAsset: p.symbol.replace('USDT', '') }] } };
      }
      orders.push({ ...p, id, status: p.type === 'MARKET' ? 'FILLED' : 'NEW' }); events.push(`${p.type === 'MARKET' ? 'sell' : 'stop'}:${p.symbol}`);
      return { data: { orderId: id, status: p.type === 'MARKET' ? 'FILLED' : 'NEW', executedQty: p.type === 'MARKET' ? p.quantity : '0', cummulativeQuoteQty: p.type === 'MARKET' ? String(Number(p.quantity) * price0) : '0' } };
    }
    if (u.pathname === '/api/v3/order' && method === 'DELETE') { const o = orders.find(x => String(x.id) === p.orderId); if (o) o.status = 'CANCELED'; events.push(`cancel:${p.symbol}`); return { data: { orderId: p.orderId, status: 'CANCELED', executedQty: '0' } }; }
    if (u.pathname === '/api/v3/order' && method === 'GET') { const o = orders.find(x => String(x.id) === p.orderId); return { data: { orderId: p.orderId, status: o?.status || 'NEW', executedQty: '0' } }; }
    throw new Error('unmocked ' + u.pathname);
  };
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo') && cfg?.params?.symbol
    ? Promise.resolve({ data: { symbols: [{ symbol: cfg.params.symbol, status: 'TRADING', baseAsset: cfg.params.symbol.replace('USDT', ''), orderTypes: ['MARKET', 'STOP_LOSS_LIMIT'], filters: [{ filterType: 'LOT_SIZE', stepSize: '0.0001', minQty: '0.0001' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] } })
    : get(url, cfg));

  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('2000', true);
  await store.cmd('HSET', 'cryptobot:autobuy:flags', 'liveUnlocked', '1');
  await ab.setLive('2000', true);
  const sent = [];
  const send = async (id, text) => sent.push({ id: String(id), text });
  const ps = require('../src/services/positionStore');

  await ab.runDaily({ allowed: new Set(['2000']), send, now: at(0) });
  assert.equal(orders.filter(o => o.side === 'BUY').length, 5);
  assert.equal(orders.filter(o => o.type === 'STOP_LOSS_LIMIT').length, 5);
  const day1 = Object.values(await ps.getAllPositions('2000')).map(p => p.positionId);
  assert.equal(day1.length, 5);

  events.length = 0; sent.length = 0;
  await ab.runDaily({ allowed: new Set(['2000']), send, now: at(1) });
  const closed = events.filter(e => e.startsWith('sell:'));
  assert.equal(closed.length, 5, 'one market sell per open auto position');
  assert.equal(events.filter(e => e.startsWith('cancel:')).length, 5 + 0, 'the 5 old stop orders were cancelled');
  for (const e of closed) {
    const coin = e.split(':')[1];
    assert.ok(events.indexOf(`cancel:${coin}`) < events.indexOf(e), `${coin}: the stop is cancelled BEFORE selling (it holds the coins)`);
  }
  const trades = await require('../src/services/profitTracker').getAllTrades('2000');
  assert.equal(trades.length, 5, 'each close is saved to the user\'s trade history');
  const day2 = Object.values(await ps.getAllPositions('2000')).map(p => p.positionId);
  assert.equal(day2.length, 5, 'today\'s signals were bought');
  assert.ok(day2.every(id => !day1.includes(id)), 'all-new positions');
  assert.equal(sent.filter(m => /REAL · 🔔 \*Daily close — \w+\*/.test(m.text)).length, 5);
});
