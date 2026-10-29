const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const KEY = 'A'.repeat(64);
const SECRET = 'b'.repeat(64);
const ENC = '0123456789abcdef'.repeat(4);

/** A tiny in-memory Binance: balances, orders, exchangeInfo, key permissions. */
function fakeBinance({ sol = 10, price = 105, withdrawals = false } = {}) {
  const ex = { balance: { SOL: sol, USDT: 0 }, orders: new Map(), price, nextId: 1, calls: [] };
  const lockedSol = () => [...ex.orders.values()].filter(o => o.status === 'NEW').reduce((s, o) => s + Number(o.origQty), 0);
  const err = (code, msg, status = 400) => { const e = new Error(msg); e.response = { status, data: { code, msg } }; throw e; };

  axios.request = async ({ method, url, headers }) => {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    ex.calls.push({ method, path: u.pathname, p });
    assert.equal(headers['X-MBX-APIKEY'], KEY, 'API key header sent');
    assert.ok(p.signature && p.timestamp, 'request is signed');
    if (u.pathname === '/api/v3/account') {
      return { data: { canTrade: true, balances: [{ asset: 'SOL', free: String(ex.balance.SOL - lockedSol()) }, { asset: 'USDT', free: String(ex.balance.USDT) }] } };
    }
    if (u.pathname === '/sapi/v1/account/apiRestrictions') return { data: { enableWithdrawals: withdrawals, enableSpotAndMarginTrading: true } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      const qty = Number(p.quantity);
      if (qty > ex.balance.SOL - lockedSol() + 1e-9) err(-2010, 'Account has insufficient balance');
      const id = ex.nextId++;
      if (p.type === 'MARKET') {
        ex.balance.SOL -= qty; ex.balance.USDT += qty * ex.price;
        const o = { orderId: id, symbol: p.symbol, type: 'MARKET', status: 'FILLED', origQty: p.quantity, executedQty: p.quantity, cummulativeQuoteQty: String(qty * ex.price) };
        ex.orders.set(id, o); return { data: o };
      }
      const o = { orderId: id, symbol: p.symbol, type: p.type, status: 'NEW', origQty: p.quantity, executedQty: '0', cummulativeQuoteQty: '0', stopPrice: p.stopPrice, price: p.price };
      ex.orders.set(id, o); return { data: o };
    }
    if (u.pathname === '/api/v3/order' && method === 'DELETE') {
      const o = ex.orders.get(Number(p.orderId));
      if (!o || o.status !== 'NEW') err(-2011, 'Unknown order sent.');
      o.status = 'CANCELED'; return { data: o };
    }
    if (u.pathname === '/api/v3/order' && method === 'GET') {
      const o = ex.orders.get(Number(p.orderId));
      if (!o) err(-2013, 'Order does not exist.');
      return { data: o };
    }
    return err(-1, `unmocked ${method} ${u.pathname}`, 404);
  };
  /** Simulate the exchange filling a resting stop order. */
  ex.fillStop = (fillPrice) => {
    const o = [...ex.orders.values()].find(x => x.status === 'NEW');
    const q = Number(o.origQty);
    o.status = 'FILLED'; o.executedQty = o.origQty; o.cummulativeQuoteQty = String(q * fillPrice);
    ex.balance.SOL -= q; ex.balance.USDT += q * fillPrice;
  };
  ex.open = () => [...ex.orders.values()].filter(o => o.status === 'NEW');
  return ex;
}

function setup(opts = {}) {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC });
  delete process.env.AUTOTRADE_DRY_RUN;
  const net = mockNet({
    price: opts.price ?? 105,
    extra: (method, url) => {
      if (url.includes('/api/v3/exchangeInfo')) {
        return { data: { symbols: [{ symbol: 'SOLUSDT', status: 'TRADING', baseAsset: 'SOL', orderTypes: ['MARKET', 'STOP_LOSS_LIMIT'],
          filters: [{ filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] } };
      }
      return undefined;
    },
  });
  const ex = fakeBinance({ price: opts.price ?? 105, ...opts });
  return { net, ex };
}

async function plannedPosition(chatId = '1000') {
  const ps = require('../src/services/positionStore');
  const pos = await ps.addPosition({ chatId, symbol: 'SOLUSDT', buyPrice: 100, quantity: 10, stopLossPrice: 95, exchange: 'binance' });
  await ps.updatePosition(chatId, pos.positionId, { takeProfits: { tp1: { price: 110 }, tp2: { price: 120 }, tp3: { price: 130 } } });
  return pos.positionId;
}

test('secretBox: round trip, and a tampered value is rejected', () => {
  process.env.TRADING_ENCRYPTION_KEY = ENC;
  const box = require('../src/lib/secretBox');
  const sealed = box.encrypt('my-secret');
  assert.ok(!sealed.includes('my-secret'));
  assert.equal(box.decrypt(sealed), 'my-secret');
  const parts = sealed.split(':');
  parts[3] = Buffer.from('other').toString('base64');
  assert.throws(() => box.decrypt(parts.join(':')));
});

test('connect: keys stored encrypted, OFF by default, status never shows keys', async () => {
  setup();
  const accounts = require('../src/services/tradingAccounts');
  const s = await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  assert.equal(s.connected, true);
  assert.equal(s.testnet, true, 'test mode by default');
  assert.equal(s.enabled, false, 'auto-exits stay off until turned on');
  assert.ok(!JSON.stringify(s).includes(KEY) && !JSON.stringify(s).includes(SECRET));
  const raw = await require('../src/lib/redis').cmd('HGETALL', 'cryptobot:trading:1000');
  assert.ok(!JSON.stringify(raw).includes(KEY) && !JSON.stringify(raw).includes(SECRET), 'nothing stored in plain text');
});

test('live keys that can withdraw are refused; live ON needs the confirmation phrase', async () => {
  setup({ withdrawals: true });
  const accounts = require('../src/services/tradingAccounts');
  await assert.rejects(accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET, live: true }), /WITHDRAW/);

  setup({ withdrawals: false });
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET, live: true });
  await assert.rejects(accounts.setEnabled('1000', true), /confirmation phrase/);
  const s = await accounts.setEnabled('1000', true, { confirmLive: 'i understand real money' });
  assert.equal(s.enabled, true);
  assert.equal(s.testnet, false);
});

test('without TRADING_ENCRYPTION_KEY nothing can be connected', async () => {
  setup();
  delete process.env.TRADING_ENCRYPTION_KEY;
  const accounts = require('../src/services/tradingAccounts');
  await assert.rejects(accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET }), /not set up/);
});

test('full plan on Binance: stop placed → TP1 sells 40% + stop to breakeven → TP2 sells 35% → stop fills → closed and recorded', async () => {
  const { ex, net } = setup({ price: 105 });
  const accounts = require('../src/services/tradingAccounts');
  const auto = require('../src/services/autoTrader');
  const ps = require('../src/services/positionStore');
  const id = await plannedPosition();

  // Nothing happens while auto-exits are off
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  assert.equal(await auto.sync('1000', id), null);
  assert.equal(ex.open().length, 0);

  await accounts.setEnabled('1000', true);
  await auto.sync('1000', id);
  let [stop] = ex.open();
  assert.equal(stop.type, 'STOP_LOSS_LIMIT');
  assert.equal(stop.stopPrice, '95.00');
  assert.equal(stop.origQty, '10.00');
  assert.equal(stop.price, '94.05', 'limit 1% under the stop');
  assert.ok(net.sent.some(m => /Stop placed on Binance/.test(m.text)));

  // Running again changes nothing (idempotent)
  const before = ex.calls.filter(c => c.method !== 'GET').length;
  await auto.sync('1000', id);
  assert.equal(ex.calls.filter(c => c.method !== 'GET').length, before);

  // Monitor marks TP1 and moves the stop to breakeven
  ex.price = 111;
  await ps.updatePosition('1000', id, { tp1Hit: true, stopLossPrice: 100, stopStage: 'breakeven' });
  await auto.sync('1000', id, { price: 111 });
  assert.ok(Math.abs(ex.balance.SOL - 6) < 1e-9, 'sold 40% (4 SOL)');
  [stop] = ex.open();
  assert.equal(stop.stopPrice, '100.00');
  assert.equal(stop.origQty, '6.00');
  assert.ok(net.sent.some(m => /Auto-exit.*sold 4 SOL/.test(m.text)));

  // TP2: sell 35% of the original (3.5), stop to TP1
  ex.price = 121;
  await ps.updatePosition('1000', id, { tp2Hit: true, stopLossPrice: 110, stopStage: 'tp1' });
  await auto.sync('1000', id, { price: 121 });
  assert.ok(Math.abs(ex.balance.SOL - 2.5) < 1e-9);
  [stop] = ex.open();
  assert.equal(stop.stopPrice, '110.00');
  assert.equal(stop.origQty, '2.50');

  // Price falls back: Binance fills the stop by itself; next check closes the position
  ex.fillStop(110);
  await auto.sync('1000', id, { price: 109 });
  assert.equal(await ps.getPositionById('1000', id), null, 'position closed');
  const [trade] = await require('../src/services/profitTracker').getAllTrades('1000');
  assert.equal(trade.quantity, 10);
  assert.equal(trade.sellPrice, (4 * 111 + 3.5 * 121 + 2.5 * 110) / 10);
  assert.ok(net.sent.some(m => /closed automatically/.test(m.text)));
  assert.equal(await require('../src/lib/redis').cmd('HGET', 'cryptobot:autoorders:1000', id), null);
});

test('stop hit but the exchange stop did not fill (gap) → sell the rest at market', async () => {
  const { ex } = setup({ price: 105 });
  const accounts = require('../src/services/tradingAccounts');
  const auto = require('../src/services/autoTrader');
  const ps = require('../src/services/positionStore');
  const id = await plannedPosition();
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('1000', true);
  await auto.sync('1000', id);

  ex.price = 90; // gapped below the stop's limit price; order still NEW
  await ps.updatePosition('1000', id, { stopLossHit: true });
  await auto.sync('1000', id, { price: 90 });
  assert.equal(ex.balance.SOL, 0);
  assert.equal(ex.open().length, 0, 'stop order cancelled first');
  assert.equal(await ps.getPositionById('1000', id), null);
});

test('`sell SOL` in the bot cancels the Binance stop and sells nothing', async () => {
  const { ex, net } = setup();
  const accounts = require('../src/services/tradingAccounts');
  const auto = require('../src/services/autoTrader');
  const id = await plannedPosition();
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('1000', true);
  await auto.sync('1000', id);
  assert.equal(ex.open().length, 1);

  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'sell SOL' } } }), fakeRes());
  assert.equal(ex.open().length, 0);
  assert.equal(ex.balance.SOL, 10, 'nothing sold');
  assert.ok(net.sent.some(m => /Cancelled your Binance stop order for SOL/.test(m.text)));
});

test('positions on other exchanges or without a quantity are never traded', async () => {
  const { ex } = setup();
  const accounts = require('../src/services/tradingAccounts');
  const auto = require('../src/services/autoTrader');
  const ps = require('../src/services/positionStore');
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('1000', true);
  const mexc = await ps.addPosition({ chatId: '1000', symbol: 'SOLUSDT', buyPrice: 100, quantity: 5, stopLossPrice: 95, exchange: 'mexc' });
  const noQty = await ps.addPosition({ chatId: '1000', symbol: 'SOLUSDT', buyPrice: 100, stopLossPrice: 95, exchange: 'binance' });
  ex.calls.length = 0; // ignore the key check made while connecting
  assert.equal(await auto.sync('1000', mexc.positionId), null);
  assert.equal(await auto.sync('1000', noQty.positionId), null);
  assert.equal(ex.calls.length, 0);
});

test('autotrade off cancels the bot\'s stop orders; dry run places no real orders', async () => {
  const { ex } = setup();
  const accounts = require('../src/services/tradingAccounts');
  const auto = require('../src/services/autoTrader');
  const id = await plannedPosition();
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('1000', true);
  await auto.sync('1000', id);
  assert.equal(ex.open().length, 1);
  await accounts.setEnabled('1000', false);
  assert.equal(await auto.cancelAll('1000'), 1);
  assert.equal(ex.open().length, 0);

  process.env.AUTOTRADE_DRY_RUN = 'true';
  await accounts.setEnabled('1000', true);
  await auto.sync('1000', id);
  assert.equal(ex.calls.filter(c => c.method === 'POST' && c.path === '/api/v3/order').length, 1, 'only the first, pre-dry-run order');
  const pos = await require('../src/services/positionStore').getPositionById('1000', id);
  assert.match(pos.auto.stopOrderId, /^dry-/);
  delete process.env.AUTOTRADE_DRY_RUN;
});

test('bot: `autotrade connect` deletes the message with the keys and never logs them', async () => {
  setup();
  const deleted = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const post = axios.post;
  axios.post = async (url, body, cfg) => {
    if (url.endsWith('/deleteMessage')) { deleted.push(body); return { data: { ok: true, result: true } }; }
    return post(url, body, cfg);
  };
  try {
    await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { message_id: 77, chat: { id: 1000 }, from: {}, text: `autotrade connect ${KEY} ${SECRET}` } } }), fakeRes());
  } finally { console.log = origLog; }
  assert.deepEqual(deleted.map(d => d.message_id), [77]);
  assert.ok(!logs.join('\n').includes(SECRET) && !logs.join('\n').includes(KEY));
  const s = await require('../src/services/tradingAccounts').getStatus('1000');
  assert.equal(s.connected, true);
});

test('app API: trading status / connect / mode', async () => {
  setup();
  const auth = require('../src/lib/dashAuth');
  const token = await auth.issueToken('1000');
  const call = async (action, body) => {
    const res = fakeRes();
    await require('../api/app')(fakeReq({ method: body ? 'POST' : 'GET', query: { action }, body, headers: { authorization: `Bearer ${token}` } }), res);
    return res;
  };
  assert.equal((await call('trading')).body.data.connected, false);
  const bad = await call('trading-connect', { apiKey: 'short', apiSecret: 'x' });
  assert.equal(bad.statusCode, 400);
  assert.equal((await call('trading-connect', { apiKey: KEY, apiSecret: SECRET })).body.data.connected, true);
  const on = await call('trading-mode', { enabled: true });
  assert.equal(on.body.data.enabled, true);
  assert.equal((await call('trading-disconnect', {})).body.data.connected, false);
});

test('monitor: TP1 reached → alert says the bot handles it, 40% sold, Binance stop moved to breakeven', async () => {
  const { ex, net } = setup({ price: 111 });
  const accounts = require('../src/services/tradingAccounts');
  const id = await plannedPosition();
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('1000', true);

  const res = fakeRes();
  await require('../api/v2monitor')(fakeReq({ query: {} }), res);
  assert.equal(res.statusCode, 200);
  const tp1 = net.sent.find(m => /TP1 HIT/.test(m.text));
  assert.ok(tp1 && /Auto-exits are on/.test(tp1.text));
  assert.ok(Math.abs(ex.balance.SOL - 6) < 1e-9, 'sold 4 of 10');
  const [stop] = ex.open();
  assert.equal(stop.stopPrice, '100.00');
  assert.deepEqual(res.body.results[0].auto, ['sell:tp1', 'place-stop']);
  assert.ok(id);
});

test('fixed-IP proxy: signed Binance requests go through FIXIE_URL; the wizard shows TRADING_IPS', async () => {
  const { ex } = setup();
  process.env.FIXIE_URL = 'http://fixie:p%40ss@eu.usefixie.com:80';
  process.env.TRADING_IPS = '54.1.2.3, 54.4.5.6';
  let seen;
  const orig = axios.request;
  axios.request = (cfg) => { seen = cfg.proxy; return orig(cfg); };
  try {
    await require('../src/services/tradingAccounts').connect('1000', { apiKey: KEY, apiSecret: SECRET });
    assert.deepEqual(seen, { protocol: 'http', host: 'eu.usefixie.com', port: 80, auth: { username: 'fixie', password: 'p@ss' } });
    const { net } = { net: null };
    const sent = [];
    const post = axios.post;
    axios.post = async (url, body, cfg) => { if (url.includes('sendMessage')) sent.push(body); return { data: { ok: true, result: {} } }; };
    await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'golive 3' } } }), fakeRes());
    axios.post = post;
    assert.match(sent.at(-1).text, /54\.1\.2\.3/);
    assert.match(sent.at(-1).text, /54\.4\.5\.6/);
    assert.match(sent.at(-1).text, /Restrict access to trusted IPs/);
    assert.ok(ex.calls.length > 0);
  } finally {
    delete process.env.FIXIE_URL; delete process.env.TRADING_IPS;
  }
});

test('balance: Spot wallet valued in USD, coins held by stop orders shown, via bot and app', async () => {
  const { ex, net } = setup({ price: 105 });
  ex.balance.USDT = 250.5;
  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('1000', { apiKey: KEY, apiSecret: SECRET });
  const b = await accounts.getBalances('1000');
  assert.equal(b.totalUsd, 250.5 + 10 * 105);
  assert.deepEqual(b.assets.map(a => a.asset), ['SOL', 'USDT']);

  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'balance' } } }), fakeRes());
  assert.match(net.sent.at(-1).text, /Your Binance balance/);
  assert.match(net.sent.at(-1).text, /\$1,300\.50/);

  const token = await require('../src/lib/dashAuth').issueToken('1000');
  const res = fakeRes();
  await require('../api/app')(fakeReq({ query: { action: 'balance' }, headers: { authorization: `Bearer ${token}` } }), res);
  assert.equal(res.body.data.totalUsd, 1300.5);
});
