const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { resetEnv, fakeReq, fakeRes } = require('./helpers');
const { PROVIDERS, normaliseExchange } = require('../src/lib/exchanges');

const H = 3_600_000;
const now = Date.now();
const t0 = Math.floor(now / H) * H - 3 * H; // three closed hours + the forming one
const fail = () => { const e = new Error('404'); e.response = { status: 404 }; throw e; };

/** Route GETs by hostname → handler(url, params). */
function route(map) {
  const calls = [];
  axios.get = async (url, cfg = {}) => {
    calls.push(url);
    for (const [frag, fn] of Object.entries(map)) if (url.includes(frag)) return { data: fn(url, cfg.params || {}) };
    return fail();
  };
  axios.post = async () => ({ data: { ok: true, result: {} } });
  return calls;
}

test('Bybit: newest-first strings parsed, forming candle dropped', async () => {
  route({ 'api.bybit.com/v5/market/kline': () => ({ retCode: 0, result: { list: [3, 2, 1, 0].map(i => [String(t0 + i * H), '1', '3', '0.5', String(10 + i), '7', '0']) } }) });
  const c = await PROVIDERS.bybit.klines('SOL', '1h', 10);
  assert.deepEqual(c.map(x => x.close), [10, 11, 12], 'oldest first, unclosed hour removed');
  assert.equal(c[0].time, t0);
});

test('OKX: unconfirmed candle (confirm=0) is dropped', async () => {
  route({ 'okx.com/api/v5/market/candles': () => ({ code: '0', data: [[String(t0 + 3 * H), '1', '2', '0', '9', '1', '', '', '0'], [String(t0), '1', '2', '0', '8', '1', '', '', '1']] }) });
  const c = await PROVIDERS.okx.klines('SOL', '1h', 10);
  assert.equal(c.length, 1);
  assert.equal(c[0].close, 8);
});

test('Gate: column order [t, quoteVol, close, high, low, open, baseVol, finished]', async () => {
  route({ 'api.gateio.ws/api/v4/spot/candlesticks': () => [[String(t0 / 1000), '999', '1.5', '1.8', '1.1', '1.2', '50', 'true']] });
  const [c] = await PROVIDERS.gate.klines('PEPE', '1h', 10);
  assert.deepEqual({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, { open: 1.2, high: 1.8, low: 1.1, close: 1.5, volume: 50 });
});

test('KuCoin: column order [t, open, close, high, low, volume]', async () => {
  route({ 'api.kucoin.com/api/v1/market/candles': () => ({ code: '200000', data: [[String(t0 / 1000), '1.2', '1.5', '1.8', '1.1', '50', '0']] }) });
  const [c] = await PROVIDERS.kucoin.klines('ABC', '1h', 10);
  assert.deepEqual([c.open, c.close, c.high, c.low], [1.2, 1.5, 1.8, 1.1]);
});

test('MEXC uses 60m for hourly candles; Kraken maps BTC → XBT', async () => {
  let iv, pair;
  route({
    'api.mexc.com/api/v3/klines': (u, p) => { iv = p.interval; return [[t0, '1', '2', '0.5', '1.5', '10']]; },
    'api.kraken.com/0/public/Ticker': (u, p) => { pair = p.pair; return { result: { XXBTZUSD: { c: ['65000.1'] } } }; },
  });
  await PROVIDERS.mexc.klines('XYZ', '1h', 5);
  assert.equal(iv, '60m');
  assert.equal(await PROVIDERS.kraken.price('BTC'), 65000.1);
  assert.equal(pair, 'XBTUSD');
  assert.equal(normaliseExchange('Gate.io'), 'gate');
  assert.equal(normaliseExchange('nope'), null);
});

test('auto-detect: not on Binance → found on Bybit, and remembered', async () => {
  resetEnv();
  const calls = route({ 'api.bybit.com/v5/market/tickers': () => ({ result: { list: [{ lastPrice: '0.42' }] } }) });
  const { resolveExchange } = require('../src/lib/market');
  const r = await resolveExchange('NEWUSDT');
  assert.deepEqual(r, { exchange: 'bybit', name: 'Bybit', price: 0.42 });
  const before = calls.length;
  await resolveExchange('NEWUSDT');
  assert.ok(calls.slice(before).every(u => u.includes('bybit')), 'second lookup goes straight to Bybit');
});

test('a position pinned to MEXC never falls back to another exchange\'s price', async () => {
  resetEnv();
  route({ 'api.binance.com/api/v3/ticker/price': () => ({ price: '999' }) }); // same ticker, maybe a different token
  const { fetchPrice } = require('../src/lib/market');
  assert.equal(await fetchPrice('ABCUSDT', { exchange: 'mexc' }), null);
  assert.equal(await fetchPrice('ABCUSDT'), 999, 'unpinned still uses the normal order');
});

test('bot: `buy XYZ 0.05 ex mexc` saves the exchange; unknown coins are refused', async () => {
  resetEnv();
  const sent = [];
  route({ 'api.mexc.com/api/v3/ticker/price': (u, p) => (p.symbol === 'XYZUSDT' ? { price: '0.051' } : fail()) });
  axios.post = async (url, body) => { if (url.includes('sendMessage')) sent.push(body); return { data: { ok: true, result: {} } }; };
  const say = async (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  const store = require('../src/services/positionStore');

  await say('buy XYZ 0.05 ex mexc');
  const [p] = await store.getPositionsBySymbol('1000', 'XYZUSDT');
  assert.equal(p.exchange, 'mexc');
  assert.ok(sent.some(m => /Prices from:\* MEXC/.test(m.text)));

  await say('buy NOTACOIN 1');
  assert.equal((await store.getPositionsBySymbol('1000', 'NOTACOINUSDT')).length, 0);
  assert.match(sent.at(-1).text, /Couldn't find NOTACOIN/);
});
