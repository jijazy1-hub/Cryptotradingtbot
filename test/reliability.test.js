const test = require('node:test');
const assert = require('node:assert/strict');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const update = (id, text, chat = 1000) => ({ update_id: id, message: { chat: { id: chat }, from: { first_name: 'T' }, text } });

test('webhook: the same Telegram update is only processed once', async () => {
  resetEnv();
  const net = mockNet();
  const handler = require('../api/telegram-webhook');
  const r1 = fakeRes(); await handler(fakeReq({ method: 'POST', body: update(77, 'help') }), r1);
  const r2 = fakeRes(); await handler(fakeReq({ method: 'POST', body: update(77, 'help') }), r2);
  assert.equal(r2.body.duplicate, true);
  assert.equal(net.sent.length, 1);
});

test('webhook on Vercel: replies immediately, finishes the work in the background', async () => {
  resetEnv({ VERCEL: '1' });
  let release;
  const gate = new Promise(r => { release = r; });
  const net = mockNet({ telegram: async (method) => { if (method === 'sendMessage') await gate; return null; } });
  const handler = require('../api/telegram-webhook');
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: update(78, 'help') }), res);
  assert.equal(res.statusCode, 200, 'responded while the reply was still being sent');
  assert.equal(net.sent.length, 0);
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(net.sent.length, 1);
  delete process.env.VERCEL;
});

test('monitor: market data fetched once per coin, not once per position', async () => {
  resetEnv();
  const net = mockNet({ price: 101 });
  const users = require('../src/services/userService');
  const positions = require('../src/services/positionStore');
  await users.registerUser({ chatId: '2000' }); await users.approveUser('2000');
  await positions.addPosition({ chatId: '1000', symbol: 'SOLUSDT', buyPrice: 100 });
  await positions.addPosition({ chatId: '2000', symbol: 'SOLUSDT', buyPrice: 98 });
  await positions.addPosition({ chatId: '2000', symbol: 'SOLUSDT', buyPrice: 97 });
  const res = fakeRes();
  await require('../api/v2monitor')(fakeReq(), res);
  assert.equal(res.body.checked, 3);
  const h1Calls = net.calls.filter(c => c.url.includes('/klines') && c.a?.params?.interval === '1h');
  assert.equal(h1Calls.length, 1);
});

test('monitor: overlapping runs are skipped instead of double-alerting', async () => {
  resetEnv();
  mockNet();
  await require('../src/lib/redis').lock('cryptobot:lock:monitor', 60);
  const res = fakeRes();
  await require('../api/v2monitor')(fakeReq(), res);
  assert.match(res.body.skipped, /still in progress/);
});

test('moonshot scan: one batch CoinGecko call instead of two per coin', async () => {
  resetEnv();
  const coins = Array.from({ length: 30 }, (_, i) => `C${i}X`);
  const net = mockNet({
    extra: (method, url, cfg) => {
      if (url.includes('/market/allTickers')) {
        return { data: { data: { ticker: coins.map((b, i) => ({ symbol: `${b}-USDT`, volValue: String(5e6 - i * 1e5), changeRate: '0.25', last: '1.5', high: '1.6', low: '1.0', count: '120000' })) } } };
      }
      if (url.includes('/coins/markets')) {
        return { data: cfg.params.symbols.split(',').map(s => ({ id: `${s}-id`, symbol: s, name: s.toUpperCase(), current_price: 1.5, market_cap: 50e6, total_volume: 5e6 })) };
      }
      if (url.includes('/market/candles')) {
        return { data: { data: Array.from({ length: 24 }, (_, i) => [String(i), '1', String(1 + i * 0.01), '1.3', '0.9', String(1000 + i * 200), '0']) } };
      }
      if (url.includes('/search/trending')) return { data: { coins: [] } };
      if (/\/coins\/[^/]+-id$/.test(url)) return { data: { id: 'x', name: 'X', symbol: 'x', platforms: { ethereum: '0x1234567890' }, market_data: {} } };
      return undefined;
    },
  });
  const { getMoonshots } = require('../src/services/listingsService');
  const picks = await getMoonshots();
  const gecko = net.calls.filter(c => c.url.includes('coingecko'));
  const batch = gecko.filter(c => c.url.includes('/coins/markets')).length;
  const details = gecko.filter(c => /\/coins\/[^/]+-id$/.test(c.url)).length;
  assert.equal(batch, 1);
  assert.ok(details <= 5, `detail calls: ${details}`);
  assert.ok(gecko.length <= 7, `total CoinGecko calls: ${gecko.length} (was ~60)`);
  for (const p of picks) assert.ok(p.meta.contracts.length > 0, 'shown coins get contract addresses');
});

test('retries: a 429 is retried and then succeeds', async () => {
  const axios = require('axios');
  let n = 0;
  axios.get = async () => {
    n++;
    if (n === 1) { const e = new Error('rate limited'); e.response = { status: 429, headers: { 'retry-after': '0' } }; throw e; }
    return { data: 'ok' };
  };
  const { getWithRetry } = require('../src/lib/http');
  const r = await getWithRetry('https://x.test', {}, { baseDelayMs: 1 });
  assert.equal(r.data, 'ok');
  assert.equal(n, 2);
});

test('Binance blocked → the public data mirror is used', async () => {
  resetEnv();
  const axios = require('axios');
  const seen = [];
  axios.get = async (url) => {
    seen.push(url);
    if (url.startsWith('https://api.binance.com')) { const e = new Error('451'); e.response = { status: 451 }; throw e; }
    return { data: [] };
  };
  const { binanceGet } = require('../src/lib/market');
  await binanceGet('/ticker/24hr');
  assert.ok(seen.some(u => u.startsWith('https://data-api.binance.vision/api/v3/ticker/24hr')));
});

test('health: reports each service; storage missing → 503', async () => {
  resetEnv();
  mockNet({ extra: (m, url) => (/ping|Time|timestamp/.test(url) ? { data: {} } : undefined) });
  let res = fakeRes();
  await require('../api/health')(fakeReq(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.summary.storage, 'DOWN');
  assert.equal(res.body.summary.marketData, 'Binance');
  assert.equal(res.body.checks.telegram.ok, true);
  assert.ok(!JSON.stringify(res.body).includes('TEST_TOKEN'));
});

test('scan / moonshots: looks at Binance USDT coins (not KuCoin) and skips stablecoins, big coins and delisted pairs', async () => {
  resetEnv();
  const now = Date.now();
  const row = (symbol, extra = {}) => ({ symbol, lastPrice: '1.5', priceChangePercent: '25', quoteVolume: '5000000', highPrice: '1.6', lowPrice: '1.0', count: 120000, closeTime: now, ...extra });
  const net = mockNet({
    extra: (method, url, cfg) => {
      if (url.includes('/ticker/24hr')) {
        return { data: [
          row('ABCUSDT'), row('XYZUSDT', { quoteVolume: '9000000' }),
          row('FDUSDUSDT'), row('SOLUSDT'), row('ABCBTC'),
          row('OLDUSDT', { closeTime: now - 30 * 86_400_000 }), row('DOWNUSDT', { priceChangePercent: '-5' }),
        ] };
      }
      if (url.includes('/coins/markets')) return { data: cfg.params.symbols.split(',').map(s => ({ id: `${s}-id`, symbol: s, name: s.toUpperCase(), current_price: 1.5, market_cap: 50e6, total_volume: 5e6 })) };
      if (url.includes('/search/trending')) return { data: { coins: [] } };
      if (/\/coins\/[^/]+-id$/.test(url)) return { data: { id: 'x', name: 'X', symbol: 'x', platforms: {}, market_data: {} } };
      if (url.includes('kucoin')) throw new Error('KuCoin must not be used when Binance works');
      return undefined;
    },
  });
  const { getScanTickers, getMoonshots } = require('../src/services/listingsService');
  const { source, tickers } = await getScanTickers();
  assert.equal(source, 'Binance');
  assert.deepEqual(tickers.map(t => t.base), ['XYZ', 'ABC'], 'only live, rising, non-stable, non-major USDT pairs, biggest volume first');
  assert.equal(tickers[0].binanceSymbol, 'XYZUSDT');

  const picks = await getMoonshots();
  assert.equal(picks.source, 'Binance');
  assert.ok(net.calls.some(c => c.url.includes('/klines') && c.a?.params?.symbol === 'ABCUSDT' && c.a.params.interval === '1h'), 'momentum uses Binance hourly candles');
  assert.ok(!net.calls.some(c => c.url.includes('kucoin')));
});

test('scan: falls back to KuCoin only when Binance is unreachable, and says so', async () => {
  resetEnv();
  mockNet({
    extra: (method, url) => {
      if (url.includes('/ticker/24hr')) throw new Error('Binance down');
      if (url.includes('/market/allTickers')) return { data: { data: { ticker: [{ symbol: 'ABC-USDT', volValue: '5000000', changeRate: '0.25', last: '1.5', high: '1.6', low: '1.0', count: '1' }] } } };
      return undefined;
    },
  });
  const { getScanTickers } = require('../src/services/listingsService');
  const { source, tickers } = await getScanTickers();
  assert.equal(source, 'KuCoin');
  assert.equal(tickers[0].exchange, 'kucoin');
});

test('scan command: picks say Binance, and offer Buy Now and a Binance-tracked log', async () => {
  resetEnv();
  const now = Date.now();
  const net = mockNet({
    klines: () => Array.from({ length: 24 }, (_, i) => ({ time: now - (24 - i) * 3_600_000, open: 1 + i * 0.01, high: 1.3, low: 0.9, close: 1.01 + i * 0.012, volume: 1000 + i * 300 })),
    extra: (method, url, cfg) => {
      if (url.includes('/ticker/24hr')) return { data: [{ symbol: 'ABCUSDT', lastPrice: '1.5', priceChangePercent: '25', quoteVolume: '8000000', highPrice: '1.6', lowPrice: '1.0', count: 120000, closeTime: now }] };
      if (url.includes('/coins/markets')) return { data: [{ id: 'abc-id', symbol: 'abc', name: 'Abc Coin', current_price: 1.5, market_cap: 40e6, total_volume: 8e6 }] };
      if (url.includes('/search/trending')) return { data: { coins: [{ item: { symbol: 'ABC', id: 'abc-id', score: 1 } }] } };
      if (/\/coins\/abc-id$/.test(url)) return { data: { id: 'abc-id', name: 'Abc Coin', symbol: 'abc', platforms: {}, market_data: {} } };
      return undefined;
    },
  });
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'scan' } } }), fakeRes());
  const all = net.sent.map(m => m.text).join('\n');
  assert.match(all, /Scanning Binance coins/);
  assert.match(all, /Found 1 pick on Binance/);
  assert.match(all, /Exchange:\*  Binance \(ABC\/USDT\)/);
  assert.match(all, /buynow ABC 10/);
  assert.match(all, /buy ABC [\d.]+ 2x ex binance/);
});
