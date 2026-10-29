const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const DAY = 86_400_000;
const ENC = '0123456789abcdef'.repeat(4);
const KEY = 'A'.repeat(64), SECRET = 'b'.repeat(64);

/** Steady uptrend: every day's close is a new 20-day high (a breakout signal today). */
function trendDaily(limit, growth = 0.003) {
  const end = Math.floor(Date.now() / DAY) * DAY; // today 00:00 UTC → last candle = yesterday (closed)
  const out = [];
  let prev = 100;
  for (let i = 0; i < limit; i++) {
    const close = 100 * (1 + growth) ** i;
    out.push({ time: end - (limit - i) * DAY, open: prev, high: close * 1.001, low: Math.min(prev, close) * 0.999, close, volume: 1 });
    prev = close;
  }
  return out;
}
const lastClose = (limit = 300) => trendDaily(limit).at(-1).close;

function setup({ strategyFile = null } = {}) {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: strategyFile || path.join(os.tmpdir(), 'no-such-strategy.json') });
  delete process.env.AUTOBUY_UNIVERSE;
  process.env.AUTOBUY_DAILY_CLOSE = 'false'; // these tests cover hold-until-the-trailing-stop; test/dailyclose.test.js covers the daily close
  const price = lastClose() * 1.002;
  const net = mockNet({
    price,
    klines: (sym, interval, limit) => (interval === '1d' ? trendDaily(limit) : interval === '1m'
      ? [{ time: Date.now() - 60_000, open: price, high: price, low: price, close: price, volume: 1 }]
      : trendDaily(limit).map((c, i) => ({ ...c, time: Date.now() - (limit - i) * 3_600_000 }))),
  });
  return { net, price, ab: require('../src/services/autoBuyer'), practice: require('../src/services/practiceService') };
}

test('strategies: donchian breakout fires on a new 20-day high; the trailing stop only rises', () => {
  const { STRATEGIES, prepare } = require('../src/strategies');
  const ind = prepare(trendDaily(120));
  const s = STRATEGIES.donchian, p = { entryN: 20, exitN: 10 };
  const i = ind.c.length - 1;
  assert.equal(s.entry(ind, i, p), true);
  const stop = s.initialStop(ind, i, p, ind.close[i]);
  assert.ok(stop < ind.close[i] && stop > ind.close[i] * 0.9);
  assert.ok(s.trail(ind, i, p) > s.trail(ind, i - 5, p), 'in an uptrend the trail moves up');
});

test('sizing: 1% of the account at risk, capped at 20% per coin, max 5 open, pause after a 3% drop', () => {
  const { size } = require('../src/services/autoBuyer');
  assert.equal(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 90, open: 0 }).usd, 1000, '$100 risk / 10% stop = $1,000');
  assert.equal(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 99, open: 0 }).usd, 2000, 'tight stop → capped at 20%');
  assert.match(size({ equity: 10_000, cash: 10_000, entry: 100, stop: 90, open: 5 }).skip, /max 5/);
  assert.match(size({ equity: 9_600, cash: 9_600, entry: 100, stop: 90, open: 0, lastEquity: 10_000 }).skip, /fell 4%/);
});

test('daily run: house forward test + opted-in users buy with play money; once per day; no double buys', async () => {
  const { net, ab, practice } = setup();
  await ab.setPractice('2000', true);
  const allowed = new Set(['1000', '2000', '3000']);
  const send = async (id, text) => net.sent.push({ chat_id: id, text });

  const r = await ab.runDaily({ allowed, send, now: new Date(Math.floor(Date.now() / DAY) * DAY + 10 * 60_000) });
  assert.equal(r.strategy, 'donchian:55-20:btc', 'without the lab file: the settings that passed the lab test, never an untested one');
  assert.ok(r.signals >= 5);
  assert.equal(r.practice, 2, 'house + the one user who opted in');

  const house = await practice.summary('house');
  assert.equal(house.positions.length, 5, 'max 5 positions');
  assert.ok(house.positions.every(p => p.auto && p.stopLossPrice > 0));
  assert.ok(house.positions.every(p => p.cost <= 2000.01), 'no position above 20%');
  assert.ok(net.sent.some(m => m.chat_id === '2000' && /PRACTICE · 🤖 \*Auto-bought/.test(m.text)));
  assert.ok(!net.sent.some(m => m.chat_id === '3000'), 'users who did not opt in get nothing');
  assert.ok(!net.sent.some(m => m.chat_id === 'house'), 'the house account sends no messages');

  assert.equal((await ab.runDaily({ allowed, send })).skipped, 'already ran today');
  await ab.runDaily({ allowed, send, force: true });
  assert.equal((await practice.summary('house')).positions.length, 5, 'forced re-run does not buy the same coins twice');
});

test('admin pause stops all auto-buying', async () => {
  const { ab } = setup();
  await ab.pause(true);
  assert.equal((await ab.runDaily({ force: true })).skipped, 'paused by admin');
});

test('live auto-buy: closed until the admin opens it; an early opening is recorded and shown; the full gate is tracked', async () => {
  const file = path.join(os.tmpdir(), `strategy-pass-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ verdict: 'PASS', period: {}, pick: { family: 'donchian', params: { entryN: 20, exitN: 10, regime: true }, id: 'donchian:20-10:btc', label: 'test', name: 'Breakout', why: 'ok', test: { trades: 40, expectancyR: 0.3 } } }));
  const { ab } = setup({ strategyFile: file });
  const store = require('../src/lib/redis');

  await assert.rejects(ab.setLive('2000', true), /hasn't been opened/);
  const early = await ab.unlock('1000');
  assert.equal(early.early, true, 'admin can open it before the forward test is done…');
  assert.ok(early.missing.some(m => /days of forward testing/.test(m)), '…and is told exactly what is still missing');
  assert.equal((await ab.gateStatus()).unlockedEarly, true);
  await ab.lock();

  // Simulate a profitable 60-day forward test with 20 closed trades
  await store.cmd('HSET', 'cryptobot:practice:house', 'cash', '11000', 'start', '10000', 'createdAt', new Date(Date.now() - 60 * DAY).toISOString(), 'resets', '0');
  for (let k = 0; k < 20; k++) await store.cmd('RPUSH', 'cryptobot:practicetrades:house', JSON.stringify({ pnlDollar: 50 }));
  const g = await ab.gateStatus();
  assert.deepEqual(g.checks, { research: true, days: true, trades: true, profit: true });
  assert.equal((await ab.unlock('1000')).early, false);
  assert.equal(await ab.isLiveUnlocked(), true);
  await assert.rejects(ab.setLive('2000', true), /Connect your Binance account/, 'each user still needs their own connected account');
});

test('live run (when unlocked): market buy on Binance, position saved with the strategy stop, stop order placed', async () => {
  const { ab, price } = setup();
  const store = require('../src/lib/redis');
  const orders = [];
  axios.request = async ({ method, url }) => {
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v3/account') return { data: { canTrade: true, balances: [{ asset: 'USDT', free: '5000' }, { asset: 'SOL', free: '9.99' }, { asset: 'BTC', free: '9.99' }, { asset: 'ETH', free: '9.99' }, { asset: 'BNB', free: '9.99' }, { asset: 'XRP', free: '9.99' }] } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      orders.push(p);
      if (p.side === 'BUY') { const q = Number(p.quoteOrderQty) / price; return { data: { orderId: orders.length, status: 'FILLED', executedQty: String(q), cummulativeQuoteQty: p.quoteOrderQty, fills: [{ commission: String(q * 0.001), commissionAsset: p.symbol.replace('USDT', '') }] } }; }
      return { data: { orderId: orders.length, status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0' } };
    }
    if (u.pathname === '/api/v3/order' && method === 'GET') return { data: { orderId: p.orderId, status: 'NEW', executedQty: '0' } };
    throw new Error('unmocked ' + u.pathname);
  };
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo')
    ? Promise.resolve({ data: { symbols: [{ symbol: cfg.params.symbol, status: 'TRADING', baseAsset: cfg.params.symbol.replace('USDT', ''), orderTypes: ['MARKET', 'STOP_LOSS_LIMIT'], filters: [{ filterType: 'LOT_SIZE', stepSize: '0.0001', minQty: '0.0001' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] } })
    : get(url, cfg));

  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('2000', true);
  await store.cmd('HSET', 'cryptobot:autobuy:flags', 'liveUnlocked', '1');
  await ab.setLive('2000', true);
  await ab.runDaily({ allowed: new Set(['2000']), force: true, send: async () => {} });

  const buys = orders.filter(o => o.side === 'BUY');
  const stops = orders.filter(o => o.type === 'STOP_LOSS_LIMIT');
  assert.equal(buys.length, 5);
  assert.ok(buys.every(b => Number(b.quoteOrderQty) <= 1000.01), '20% cap of a $5,000 account');
  assert.equal(stops.length, 5, 'every live buy gets a stop order on Binance straight away');
  const pos = Object.values(await require('../src/services/positionStore').getAllPositions('2000'));
  assert.ok(pos.every(p => p.strategy === 'donchian:55-20:btc' && p.stopStage === 'trail' && p.exchange === 'binance'));
});

test('monitor gives auto-bought positions no take-profits (trailing stop only)', () => {
  const { evaluatePosition } = require('../api/v2monitor');
  const c = trendDaily(260).map((x, i) => ({ ...x, time: Date.now() - (260 - i) * 3_600_000 }));
  const pos = { symbol: 'SOLUSDT', buyPrice: 100, stopLossPrice: 90, strategy: 'donchian:20-10:btc', positionId: 'x' };
  const r = evaluatePosition(pos, { candles1h: c, candles4h: c, currentPrice: 150 });
  assert.equal(r.updates.takeProfits, undefined);
  assert.ok(!/TP\d/.test(r.recommendation));
});

test('bot: autobuy status, on/off, live stays locked', async () => {
  const { net } = setup();
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('autobuy');
  assert.match(net.sent.at(-1).text, /NOT TESTED YET/);
  assert.match(net.sent.at(-1).text, /Live auto-buy:\* 🔒 not open yet/);
  await say('autobuy on');
  assert.match(net.sent.at(-1).text, /Practice auto-buy ON/);
  await say('autobuy live on');
  assert.match(net.sent.at(-1).text, /hasn't been opened/);
});

test('admin opens auto-buy early; golive "Turn on auto-trading" turns on buying AND selling, with an unproven warning', async () => {
  const { net } = setup();
  const axios = require('axios');
  axios.request = async ({ url }) => (url.includes('apiRestrictions') ? { data: { enableWithdrawals: false } } : { data: { canTrade: true, balances: [{ asset: 'USDT', free: '100', locked: '0' }] } });
  await require('../src/services/tradingAccounts').connect('1000', { apiKey: KEY, apiSecret: SECRET, live: true });
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('autobuy unlock');
  assert.match(net.sent.at(-1).text, /Opened \*early\*/);
  await say('golive on');
  assert.match(net.sent.at(-1).text, /Buys:\* once a day/);
  assert.match(net.sent.at(-1).text, /Not proven yet/);
  await say('golive on confirm');
  assert.match(net.sent.find(m => /Auto-trading is ON/.test(m.text)).text, /buys the coins that signal/);
  const st = await require('../src/services/autoBuyer').userStatus('1000');
  assert.equal(st.liveOn, true);
  assert.equal((await require('../src/services/tradingAccounts').getStatus('1000')).enabled, true);
  await say('golive off');
  assert.equal((await require('../src/services/autoBuyer').userStatus('1000')).liveOn, false);
});

test('a screen is deleted when one of its buttons is tapped', async () => {
  const { net } = setup();
  const axios = require('axios');
  const deleted = [];
  const post = axios.post;
  axios.post = async (url, body, cfg) => (url.endsWith('/deleteMessage') ? (deleted.push(body.message_id), { data: { ok: true, result: true } }) : post(url, body, cfg));
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q1', data: 'practice', from: {}, message: { message_id: 55, chat: { id: 1000 }, text: 'What would you like to do?\n\nTap a button below:' } } } }), fakeRes());
  assert.deepEqual(deleted, [55]);
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q2', data: 'practice', from: {}, message: { message_id: 56, chat: { id: 1000 }, text: 'Practice account …' } } } }), fakeRes());
  assert.deepEqual(deleted, [55, 56], 'every screen with buttons is removed when one of its buttons is tapped');
  assert.ok(net.sent.length > 0);
});

test('closed trades show today\'s running profit', () => {
  const { todayLine } = require('../src/services/profitTracker');
  const now = new Date().toISOString();
  const line = todayLine([{ closedAt: now, pnlDollar: 12.5 }, { closedAt: now, pnlDollar: -2.5 }, { closedAt: '2020-01-01T00:00:00Z', pnlDollar: 99 }]);
  assert.match(line, /2 closed trades · 1 won · \+\$10\.00/);
});

test('strategy lab: on random prices nothing passes', () => {
  const { research } = require('../src/services/strategyLab');
  const walk = (seed) => { let s = seed, px = 100; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647; return Array.from({ length: 1200 }, (_, i) => { const o = px; px *= Math.exp((rnd() - 0.5) * 0.08); return { time: Date.UTC(2022, 0, 1) + i * DAY, open: o, high: Math.max(o, px) * 1.01, low: Math.min(o, px) * 0.99, close: px, volume: 1 }; }); };
  const data = {}; ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT'].forEach((s, k) => { data[s] = walk(97 + k * 7919); });
  const out = research(data);
  assert.notEqual(out.verdict, 'PASS');
  assert.ok(out.families.length === 3 && out.variants.length === 22);
});

test('buynow (practice): tells you whether the strategy agrees, buys after you confirm, managed by the trailing stop', async () => {
  const { net, practice } = setup();
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('practice buynow SOL 500');
  const ask = net.sent.at(-1);
  assert.match(ask.text, /The strategy agrees/);
  assert.equal(ask.reply_markup.inline_keyboard[0][0].callback_data, 'practice buynow SOL 500 confirm');
  assert.equal((await practice.summary('1000')).positions.length, 0, 'nothing bought before confirming');
  await say('practice buynow SOL 500 confirm');
  assert.match(net.sent.at(-1).text, /Bought .* SOL/);
  const [p] = (await practice.summary('1000')).positions;
  assert.equal(p.auto, true);
  assert.ok(p.stopLossPrice > 0);
  await say('practice buynow SOL 5000 confirm');
  assert.match(net.sent.at(-1).text, /more than 20%/);
});

test('buynow (practice): a coin without a signal gets an honest warning', async () => {
  const { net } = setup();
  // Falling coin: no breakout
  const axios = require('axios');
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/klines') && cfg?.params?.symbol === 'ADAUSDT' && cfg.params.interval === '1d'
    ? Promise.resolve({ data: trendDaily(cfg.params.limit, -0.003).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) })
    : get(url, cfg));
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'practice buynow ADA 100' } } }), fakeRes());
  assert.match(net.sent.at(-1).text, /wouldn't buy ADA today/);
  assert.match(net.sent.at(-1).text, /isn't backed by the test results/);
});

test('end-of-day summary: profit → congratulations; loss → apology + encouragement; only once per day', async () => {
  const { ab } = setup();
  const loss = ab.dailyMessage('2026-10-25', { count: 3, wins: 1, pnlUsd: -12.4 }, { count: 0 });
  assert.match(loss, /I'm sorry — today ended at a loss/);
  assert.match(loss, /look for better chances tomorrow/);
  assert.match(loss, /golive off/);
  assert.match(loss, /-\$12\.40/);
  const win = ab.dailyMessage('2026-10-25', { count: 2, wins: 2, pnlUsd: 20 }, { count: 1, wins: 1, pnlUsd: 5 });
  assert.match(win, /profitable day/);
  assert.match(win, /PRACTICE \(play money\):\* 1 trade closed/);

  // Wired into the daily run, for users who closed trades during the day
  const store = require('../src/lib/redis');
  const dayStart = Math.floor(Date.now() / DAY) * DAY;
  const yesterday = new Date(dayStart - 3 * 3_600_000).toISOString();
  await store.cmd('RPUSH', 'cryptobot:tradelist:2000', JSON.stringify({ symbol: 'SOLUSDT', closedAt: yesterday, pnlDollar: -8, pnlPct: -2 }));
  const sent = [];
  const allowed = new Set(['1000', '2000']);
  const r = await ab.runDaily({ allowed, send: async (id, text) => sent.push({ id, text }), now: new Date(dayStart + 10 * 60_000) });
  assert.equal(r.summaries, 1);
  assert.ok(sent.some(m => m.id === '2000' && /sorry/.test(m.text)));
  const again = await ab.runDaily({ allowed, send: async (id, text) => sent.push({ id, text }), force: true });
  assert.equal(again.summaries, 0, 'a forced re-run never repeats the summary');
});

test('buynow (live): buys on Binance and places the stop order — even before auto-buy is opened', async () => {
  const { price } = setup();
  const axios = require('axios');
  const orders = [];
  axios.request = async ({ method, url }) => {
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v3/account') return { data: { canTrade: true, balances: [{ asset: 'USDT', free: '500', locked: '0' }, { asset: 'SOL', free: '0.5', locked: '0' }] } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      orders.push(p);
      if (p.side === 'BUY') { const q = Number(p.quoteOrderQty) / price; return { data: { orderId: 1, status: 'FILLED', executedQty: String(q), cummulativeQuoteQty: p.quoteOrderQty, fills: [] } }; }
      return { data: { orderId: 2, status: 'NEW', executedQty: '0', cummulativeQuoteQty: '0' } };
    }
    if (u.pathname === '/api/v3/order') return { data: { orderId: p.orderId, status: 'NEW', executedQty: '0' } };
    throw new Error('unmocked ' + u.pathname);
  };
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo')
    ? Promise.resolve({ data: { symbols: [{ symbol: 'SOLUSDT', status: 'TRADING', baseAsset: 'SOL', orderTypes: ['MARKET', 'STOP_LOSS_LIMIT'], filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] } })
    : get(url, cfg));
  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('2000', true);
  const ab = require('../src/services/autoBuyer');
  await assert.rejects(ab.buyNow('2000', { symbol: 'SOL', amount: 900, mode: 'live' }), /USDT in your Spot wallet/);
  const r = await ab.buyNow('2000', { symbol: 'SOL', amount: 100, mode: 'live' });
  assert.equal(r.analysis.signal, true);
  assert.equal(orders.filter(o => o.side === 'BUY').length, 1);
  assert.equal(orders.filter(o => o.type === 'STOP_LOSS_LIMIT').length, 1, 'stop order placed straight away');
  const [pos] = Object.values(await require('../src/services/positionStore').getAllPositions('2000'));
  assert.equal(pos.strategy, 'donchian:55-20:btc');
  assert.equal(pos.boughtWithSignal, true);
});

test('minimum order is Binance\'s $5: auto-buy needs ~$50 (1% risk, ~10% stop); Buy Now needs ~$25 (20% cap)', () => {
  const { size } = require('../src/services/autoBuyer');
  assert.equal(size({ equity: 50, cash: 50, entry: 100, stop: 90, open: 0 }).usd, 5, '1% risk of $50 with a 10% stop = a $5 buy');
  assert.match(size({ equity: 25, cash: 25, entry: 100, stop: 90, open: 0 }).skip, /minimum order/);
});

test('stops: today\'s stop and signal for every coin', async () => {
  const { net } = setup();
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'stops' } } }), fakeRes());
  const t = net.sent.at(-1).text;
  assert.match(t, /Today's stop for each coin/);
  for (const c of ['BTC', 'ETH', 'SOL', 'UNI']) assert.match(t, new RegExp(`\\*${c}\\* \\$[\\d.]+ → stop \\$[\\d.]+ \\(\\*−[\\d.]+%\\*\\)`));
});

// ─── v2.20: reasons, quiet-day notes, the admin report, retry after a failure ──
const dayStartPlus = (min) => new Date(Math.floor(Date.now() / DAY) * DAY + min * 60_000);

test('every auto-buy says why: the signal, the market filter, the test and the amount; house buys reach the admin', async () => {
  const { net, ab } = setup();
  await ab.setPractice('2000', true);
  const sent = [];
  await ab.runDaily({ allowed: new Set(['1000', '2000']), send: async (id, text) => sent.push({ id: String(id), text }), now: dayStartPlus(10) });

  const mine = sent.filter(m => m.id === '2000' && /Auto-bought/.test(m.text));
  assert.ok(mine.length >= 1);
  const m = mine[0].text;
  assert.match(m, /🎮 PRACTICE · 🤖 \*Auto-bought \w+\* \(play money\)/);
  assert.match(m, /Why the bot bought \w+:/);
  assert.match(m, /Breakout: closed at \$[\d,.]+, above its 55-day high of \$[\d,.]+ \(\+[\d.]+%\)/);
  assert.match(m, /Market filter: BTC \$[\d,.]+ is above its 100-day average/);
  assert.match(m, /Strategy test: not tested yet/, 'honest when the lab file is missing');
  assert.match(m, /Why this amount:\* if the stop is hit you lose about \$[\d,.]+ — 1% of your \$10,000\.00 account/);
  assert.match(m, /How it sells:\* the stop follows the lowest low of the last 20 days/);
  process.env.AUTOBUY_DAILY_CLOSE = 'true';
  const closing = ab.buyMessage({ mode: 'practice', b: { symbol: 'SOLUSDT', stop: 90, why: 'x' }, strategy: ab.currentStrategy(), sig: { regimeOn: false }, z: { usd: 100, riskUsd: 1 }, equity: 10000, price: 100, qty: 1 });
  assert.match(closing, /How it sells:\* the bot sells it at the next daily check \(just after midnight UTC\), or sooner if the price falls to the stop at \$90\.0000/);
  process.env.AUTOBUY_DAILY_CLOSE = 'false';

  const house = sent.filter(x => x.id === '1000' && /HOUSE forward test · 🤖 \*Auto-bought/.test(x.text));
  assert.ok(house.length >= 1, 'the admin sees what the house forward test bought, with reasons');
  const report = sent.find(x => x.id === '1000' && /Auto-buy daily check/.test(x.text));
  assert.ok(report, 'the admin gets the daily report');
  assert.match(report.text, /Buy signals \(\d+\)/);
  assert.match(report.text, /🏠 house: /);
  assert.match(report.text, /NOT TESTED: data\/auto-strategy\.json is missing/);
  assert.ok(net);
});

test('a day with nothing to buy: users with auto-buy on are told why (BTC below its 100-day average)', async () => {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json') });
  mockNet({ price: 50, klines: (sym, interval, limit) => trendDaily(limit, -0.003) }); // a falling market
  const ab = require('../src/services/autoBuyer');
  await ab.setPractice('2000', true);
  const sent = [];
  const r = await ab.runDaily({ allowed: new Set(['1000', '2000', '3000']), send: async (id, text) => sent.push({ id: String(id), text }), now: dayStartPlus(10) });
  assert.equal(r.signals, 0);
  const note = sent.find(m => m.id === '2000');
  assert.ok(note, 'the user who switched auto-buy on hears about the quiet day');
  assert.match(note.text, /No coin to buy today/);
  assert.match(note.text, /\*Why:\* BTC \$[\d,.]+ is below its 100-day average \$[\d,.]+/);
  assert.ok(!sent.some(m => m.id === '3000'), 'users who never switched auto-buy on are not messaged');
  assert.ok(sent.some(m => m.id === '1000' && /Auto-buy daily check/.test(m.text) && /Nothing bought today/.test(m.text)));
  // Once a day only
  await ab.runDaily({ allowed: new Set(['2000']), send: async (id, text) => sent.push({ id: String(id), text }), now: dayStartPlus(40) });
  assert.equal(sent.filter(m => m.id === '2000').length, 1);
});

test('no signal but BTC is up: the note names the coins closest to a breakout', () => {
  const ab = require('../src/services/autoBuyer');
  const text = ab.noBuyMessage('2026-10-27', ab.currentStrategy(), {
    regimeOn: true, regimeUp: true, regimeText: 'BTC $100,000 is above its 100-day average $90,000',
    analysis: { SOLUSDT: { gapPct: 2.1 }, ETHUSDT: { gapPct: 0.8 }, ADAUSDT: { gapPct: 9 }, XRPUSDT: { gapPct: 4 } },
  });
  assert.match(text, /none of the 4 coins gave a buy signal/);
  assert.match(text, /Closest:\* ETH needs \+0\.8% · SOL needs \+2\.1% · XRP needs \+4%/);
});

test('a failed daily check does not use up the day: the admin is told and the next run retries', async () => {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json') });
  let down = true;
  const price = lastClose() * 1.002;
  mockNet({ price, klines: (sym, interval, limit) => { if (down && interval === '1d') throw new Error('Binance is down'); return interval === '1d' ? trendDaily(limit) : [{ time: Date.now() - 60_000, open: price, high: price, low: price, close: price, volume: 1 }]; } });
  const ab = require('../src/services/autoBuyer');
  const practice = require('../src/services/practiceService');
  const sent = [];
  const send = async (id, text) => sent.push({ id: String(id), text });

  await assert.rejects(ab.runDaily({ allowed: new Set(['1000']), send, now: dayStartPlus(10) }), /no BTC daily data/);
  assert.ok(sent.some(m => m.id === '1000' && /Auto-buy check failed/.test(m.text) && /try again in about 30 minutes/.test(m.text)));

  down = false;
  const r = await ab.runDaily({ allowed: new Set(['1000']), send, now: dayStartPlus(40) });
  assert.ok(r.signals > 0, 'the retry ran the check');
  assert.ok((await practice.summary('house')).positions.length > 0, 'and the house account bought');
  assert.equal((await ab.runDaily({ allowed: new Set(['1000']), send, now: dayStartPlus(70) })).skipped, 'already ran today');
});

test('autobuy on: says whether today\'s check already ran, what it found, and when the first check is', async () => {
  setup();
  const ab = require('../src/services/autoBuyer');
  const before = await ab.todayCheck(dayStartPlus(2));
  assert.equal(before.ranToday, false);
  assert.match(before.text, /in a few minutes/);

  await ab.runDaily({ allowed: new Set(['1000']), send: async () => {}, now: dayStartPlus(10) });
  const after = await ab.todayCheck(dayStartPlus(60));
  assert.equal(after.ranToday, true);
  assert.ok(after.signals > 0);
  assert.match(after.text, /Today's check already ran/);
  assert.match(after.text, /practice buynow [A-Z]+ 500/);
  assert.match(after.text, /tomorrow just after 1am Lagos time/);
});

test('manual: describes what the bot does now (it can buy and sell), not the old read-only bot', async () => {
  const { net } = setup();
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'manual' } } }), fakeRes());
  const all = net.sent.map(m => m.text).join('\n');
  assert.doesNotMatch(all, /read-only|never touches your money|CryptoBot V2/);
  assert.match(all, /JijazyBot — User Manual/);
  assert.match(all, /Does the bot buy\/sell for me\?\*\nOnly if you ask it to/);
  assert.match(all, /Why hasn't it bought anything/);
  for (const m of net.sent) assert.ok(m.text.length < 4096, 'each section fits in one Telegram message');
});

test('prices: $1,000+ coins (BTC, ETH) format without crashing', () => {
  const { fmtUsd } = require('../src/strategies');
  assert.equal(fmtUsd(104250.37), '$104,250');
  assert.equal(fmtUsd(2500.5), '$2,501');
  assert.equal(fmtUsd(182.41), '$182.41');
  assert.equal(fmtUsd(1.23456), '$1.2346');
  assert.equal(fmtUsd(0.0000098), '$0.000009800');
  assert.equal(fmtUsd(NaN), '—');
});

test('daily check with real-world prices (BTC ~$100,000, ETH ~$3,000): runs and buys', async () => {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json') });
  delete process.env.AUTOBUY_UNIVERSE;
  const scale = { BTCUSDT: 400, ETHUSDT: 12, BNBUSDT: 3 };
  const k = (sym, limit) => trendDaily(limit).map(c => { const m = scale[sym] || 1; return { ...c, open: c.open * m, high: c.high * m, low: c.low * m, close: c.close * m }; });
  const base = lastClose() * 1.002;
  mockNet({ price: base * 400, klines: (sym, interval, limit) => (interval === '1d' ? k(sym, limit) : [{ time: Date.now() - 60_000, open: base, high: base, low: base, close: base, volume: 1 }]) });
  const ab = require('../src/services/autoBuyer');
  const sent = [];
  const r = await ab.runDaily({ allowed: new Set(['1000']), send: async (id, text) => sent.push({ id: String(id), text }), now: dayStartPlus(10) });
  assert.ok(r.signals > 0, 'the check finished');
  const report = sent.find(m => /Auto-buy daily check/.test(m.text));
  assert.match(report.text, /BTC \$\d{2,3},\d{3} is above its 100-day average \$\d{2,3},\d{3}/);
  assert.ok(!sent.some(m => /check failed/.test(m.text)));
});

test('a failed admin run says so plainly (not "try admin run of 6")', async () => {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json') });
  mockNet({ price: 100, klines: () => { throw new Error('Binance is down'); } });
  const ab = require('../src/services/autoBuyer');
  const sent = [];
  await assert.rejects(ab.runDaily({ allowed: new Set(['1000']), force: true, send: async (id, text) => sent.push(text) }));
  assert.match(sent[0], /your `autobuy run`/);
  assert.match(sent[0], /Send `autobuy run` to try again/);
  assert.doesNotMatch(sent[0], /admin run of|No more/);
});

test('strategy lab: comparisons (2% risk, breakout + strongest coins, BTC above its 200-day) never change the pick', () => {
  const { research, btcTrend } = require('../src/services/strategyLab');
  const walk = (seed, drift) => { let s = seed, px = 100; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647; return Array.from({ length: 1200 }, (_, i) => { const o = px; px *= Math.exp(drift + (rnd() - 0.5) * 0.06); return { time: Date.UTC(2022, 0, 1) + i * DAY, open: o, high: Math.max(o, px) * 1.01, low: Math.min(o, px) * 0.99, close: px, volume: 1 }; }); };
  const data = {}; ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT'].forEach((s, k) => { data[s] = walk(97 + k * 7919, 0.0015); });
  const out = research(data);
  const c = out.comparisons;
  assert.ok(c, 'comparisons are saved');
  for (const f of out.families.filter(x => x.chosen)) {
    assert.ok(c.risk2[f.family], `2% risk for ${f.family}`);
    if (f.portfolioTest.returnPct > 0) assert.ok(c.risk2[f.family].returnPct > f.portfolioTest.returnPct, '2% risk grows a winning strategy faster');
  }
  assert.ok(c.combo && c.combo.test.trades >= Math.max(...['donchian', 'momentum'].map(k => out.families.find(f => f.family === k).test.trades)));
  assert.ok(c.btcHold && c.btcTrend200 && c.btcTrend200.timeInMarketPct <= 100);
  assert.equal(c.btcHold.timeInMarketPct, 100);
  // The pick is still chosen on the training period only
  const ranked = out.families.filter(f => f.chosen).sort((a, b) => b.train.expectancyR - a.train.expectancyR);
  assert.equal(out.pick.family, ranked[0].family);

  // BTC trend on a steady rise then a fall: stays in during the rise, gets out in the fall
  const { prepare } = require('../src/strategies');
  const up = Array.from({ length: 400 }, (_, i) => 100 * 1.003 ** i);
  const closes = [...up, ...Array.from({ length: 200 }, (_, i) => up.at(-1) * 0.995 ** (i + 1))];
  const btc = prepare(closes.map((cl, i) => ({ time: i * DAY, open: i ? closes[i - 1] : cl, high: cl, low: cl, close: cl, volume: 1 })));
  const t = btcTrend(btc, 250 * DAY, 200), h = btcTrend(btc, 250 * DAY, 0);
  assert.ok(t.maxDrawdownPct < h.maxDrawdownPct, 'the 200-day rule cuts the fall');
});

test('manual: figures come from the latest lab result; it covers paying, free small accounts, savings, expect and ask', async () => {
  const fs = require('fs');
  const file = path.join(os.tmpdir(), `lab-manual-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ period: { split: '2023-12-11', to: '2026-10-26' }, btcBuyHoldTestPct: 94.3, pick: { family: 'donchian', params: { entryN: 55, exitN: 20, regime: true }, portfolioTest: { returnPct: 21.5, maxDrawdownPct: 4.2 }, test: { trades: 108 } } }));
  setup({ strategyFile: file });
  process.env.PAID_ACCESS_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'sk-test';
  const net = require('./helpers').mockNet({ price: 100 });
  try {
    await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'manual' } } }), fakeRes());
    const all = net.sent.map(m => m.text).join('\n');
    assert.match(all, /108 trades it was never tuned on\. Over 2\.9 years it grew an account about 22% \(about 7% a year, worst drop 4\.2%\), while simply holding BTC made 94%/);
    assert.doesNotMatch(all, /about 23%|made 85%/);
    assert.match(all, /DO I HAVE TO PAY/);
    assert.match(all, /Free for small accounts:\* if your Binance Spot balance is \$100\.00 or less/);
    assert.match(all, /save 10/);
    assert.match(all, /expect 20/);
    assert.match(all, /Ask the bot:\* tap 💬 Ask the Bot/);
    for (const m of net.sent) assert.ok(m.text.length < 4096);
  } finally { delete process.env.PAID_ACCESS_ENABLED; delete process.env.OPENAI_API_KEY; }
});
