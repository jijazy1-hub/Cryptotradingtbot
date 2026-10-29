const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { mockNet, makeCandles, fakeReq, fakeRes, resetEnv } = require('./helpers');

const ENC = '0123456789abcdef'.repeat(4);
const KEY = 'K'.repeat(64);
const SECRET = 's'.repeat(64);

/** Network with a settable price; 1m candles from `minute` (default: flat at the price). */
function net(state) {
  return mockNet({
    get price() { return state.price; },
    klines: (sym, interval, limit) => {
      if (interval === '1m') return state.minute ? state.minute() : [{ time: Date.now() - 60_000, open: state.price, high: state.price, low: state.price, close: state.price, volume: 1 }];
      const ms = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000 }[interval] || 3_600_000;
      return makeCandles(limit, { intervalMs: ms, start: 100 });
    },
  });
}

function setup(price = 100) {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC });
  const state = { price };
  const n = net(state);
  // mockNet reads opts.price once; make the ticker follow state.price
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/ticker/price') ? Promise.resolve({ data: { price: String(state.price) } }) : get(url, cfg));
  return { state, net: n, practice: require('../src/services/practiceService') };
}

test('practice buy: live price + slippage + 0.1% fee, cash goes down, plan locked', async () => {
  const { practice } = setup(100);
  const { position: p, cash } = await practice.buy('2000', { symbol: 'sol', amount: 1000 });
  assert.equal(cash, 9000);
  assert.equal(p.buyPrice, 100 * 1.0005);
  assert.ok(Math.abs(p.quantity - (1000 - 1) / 100.05) < 1e-6, 'fee comes off what you buy');
  assert.ok(p.stopLossPrice > 0 && p.takeProfits?.tp1?.price > p.buyPrice, 'same stop + TP plan as live');
  await assert.rejects(practice.buy('2000', { symbol: 'SOL', amount: 50000 }), /Not enough practice cash/);
  await assert.rejects(practice.buy('2000', { symbol: 'SOL', amount: 4 }), /at least \$5/);
  assert.ok((await practice.buy('2000', { symbol: 'SOL', amount: 5 })).position, '$5 works, like on Binance');
});

test('honest pricing: buying and selling straight back costs about 0.3%', async () => {
  const { practice } = setup(100);
  await practice.buy('2000', { symbol: 'SOL', amount: 1000 });
  const { trades, cash } = await practice.sellNow('2000', { symbol: 'SOL' });
  assert.ok(trades[0].pnlDollar < -2.9 && trades[0].pnlDollar > -3.1, `lost ${trades[0].pnlDollar}`);
  assert.ok(cash < 10_000);
});

test('exits: stop triggers on a 1-minute dip and fills lower if price gapped', () => {
  const { applyExits } = require('../src/services/practiceService');
  const base = () => ({ quantity: 10, remainingQty: 10, buyPrice: 100, stopLossPrice: 95, takeProfits: { tp1: { price: 110 }, tp2: { price: 120 }, tp3: { price: 130 } }, sold: [], fees: 0 });

  // A wick to 94 that recovered to 99 — a real stop order would have sold
  const p = base();
  const [s] = applyExits(p, 99, [{ open: 98, low: 94, high: 99 }]);
  assert.equal(s.reason, 'stop');
  assert.equal(s.at, 95 * (1 - 0.0005));
  assert.equal(p.remainingQty, 0);

  // Price opened at 90, below the stop: fills at 90, not 95
  const g = base();
  const [gs] = applyExits(g, 91, [{ open: 90, low: 89, high: 91 }]);
  assert.equal(gs.at, 90 * (1 - 0.0005));
});

test('exits: TP1 sells 40% and moves the stop to breakeven; a jump to TP2 does both', () => {
  const { applyExits } = require('../src/services/practiceService');
  const p = { quantity: 10, remainingQty: 10, buyPrice: 100, stopLossPrice: 95, takeProfits: { tp1: { price: 110 }, tp2: { price: 120 }, tp3: { price: 130 } }, sold: [], fees: 0 };
  applyExits(p, 111, []);
  assert.equal(p.remainingQty, 6);
  assert.equal(p.stopLossPrice, 100);

  const q = { quantity: 10, remainingQty: 10, buyPrice: 100, stopLossPrice: 95, takeProfits: { tp1: { price: 110 }, tp2: { price: 120 }, tp3: { price: 130 } }, sold: [], fees: 0 };
  const sales = applyExits(q, 121, []);
  assert.deepEqual(sales.map(s => s.reason), ['tp1', 'tp2']);
  assert.ok(Math.abs(q.remainingQty - 2.5) < 1e-9);
  assert.equal(q.stopLossPrice, 110);
});

test('10-minute check: TP1 then a dip to the breakeven stop → trade closed with fees, messages sent', async () => {
  const { state, practice } = setup(100);
  const { position } = await practice.buy('1000', { symbol: 'SOL', amount: 1000 }); // admin chat, always allowed
  const tp1 = position.takeProfits.tp1.price;

  state.price = tp1 * 1.01;
  let res = fakeRes();
  await require('../api/v2quickcheck')(fakeReq({ query: {} }), res);
  assert.equal(res.body.practice.users, 1);
  let s = await practice.summary('1000');
  assert.equal(s.positions[0].tp1Hit, true);
  assert.ok(s.cash > 9000);

  // Price dips to entry for a minute → breakeven stop sells the rest
  state.price = position.buyPrice * 1.02;
  state.minute = () => [{ time: Date.now() - 60_000, open: position.buyPrice * 1.01, low: position.buyPrice * 0.999, high: position.buyPrice * 1.02, close: position.buyPrice * 1.02, volume: 1 }];
  res = fakeRes();
  await require('../api/v2quickcheck')(fakeReq({ query: {} }), res);
  s = await practice.summary('1000');
  assert.equal(s.positions.length, 0);
  assert.equal(s.stats.trades, 1);
  assert.ok(s.trades[0].fees > 0);
  assert.deepEqual(s.trades[0].exits, ['tp1', 'stop']);
  const sent = res.body.practice.messages;
  assert.ok(sent >= 2);
});

test('practice is separate from real positions and real trade history', async () => {
  const { practice } = setup(100);
  await practice.buy('2000', { symbol: 'SOL', amount: 100 });
  await practice.sellNow('2000', { symbol: 'SOL' });
  assert.equal(Object.keys(await require('../src/services/positionStore').getAllPositions('2000')).length, 0);
  assert.equal((await require('../src/services/profitTracker').getAllTrades('2000')).length, 0);
  await practice.reset('2000');
  assert.equal((await practice.summary('2000')).cash, 10_000);
});

test('bot: practice commands', async () => {
  const { net: n } = setup(100);
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  await say('practice');
  assert.match(n.sent.at(-1).text, /PRACTICE — play money/);
  await say('practice buy SOL 250 2x');
  assert.match(n.sent.at(-1).text, /PRACTICE buy \(play money\) — SOL/);
  assert.match(n.sent.at(-1).text, /\$9,750\.00/);
  await say('practice sell SOL');
  assert.match(n.sent.at(-1).text, /sold/);
});

test('go-live wizard: key and secret pasted as messages are deleted, checked with Binance, and never logged', async () => {
  const { net: n } = setup(100);
  const deleted = [];
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const post = axios.post;
  axios.post = async (url, body, cfg) => (url.endsWith('/deleteMessage') ? (deleted.push(body.message_id), { data: { ok: true, result: true } }) : post(url, body, cfg));
  axios.request = async ({ url }) => {
    if (url.includes('/sapi/v1/account/apiRestrictions')) return { data: { enableWithdrawals: false, enableSpotAndMarginTrading: true } };
    if (url.includes('/api/v3/account')) return { data: { canTrade: true, balances: [{ asset: 'USDT', free: '250.5' }] } };
    throw new Error('unmocked ' + url);
  };
  let id = 10;
  const say = (text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { message_id: ++id, chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  try {
    await say('golive');
    assert.match(n.sent.at(-1).text, /Go live — 4 short steps/);
    await say('golive 4');
    await say(KEY);
    assert.match(n.sent.at(-1).text, /Secret Key/);
    await say(SECRET);
  } finally { console.log = origLog; }
  assert.deepEqual(deleted, [13, 14], 'both codes deleted from the chat');
  assert.ok(!logs.join('\n').includes(KEY) && !logs.join('\n').includes(SECRET));
  assert.ok(n.sent.some(m => /Binance connected/.test(m.text)));
  assert.match(n.sent.at(-1).text, /What to expect with \$/, "then what to expect for their balance");
  assert.match(n.sent.find(m => /Binance connected/.test(m.text)).text, /250\.50/);
  const st = await require('../src/services/tradingAccounts').getStatus('1000');
  assert.equal(st.connected, true);
  assert.equal(st.testnet, false, 'the wizard connects the real account');
  assert.equal(st.enabled, false, 'still off until the user taps Turn on');

  await say('golive on');
  assert.match(n.sent.at(-1).text, /Last check — real money/);
  await say('golive on confirm');
  assert.equal((await require('../src/services/tradingAccounts').getStatus('1000')).enabled, true);
});

test('a random long message is not treated as a key when the wizard is not running', async () => {
  const { net: n } = setup(100);
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'A'.repeat(64) } } }), fakeRes());
  assert.match(n.sent.at(-1).text, /Unknown command/);
});

test('app API: practice summary / buy / sell / reset', async () => {
  setup(100);
  const token = await require('../src/lib/dashAuth').issueToken('1000');
  const call = async (action, body) => {
    const res = fakeRes();
    await require('../api/app')(fakeReq({ method: body ? 'POST' : 'GET', query: { action }, body, headers: { authorization: `Bearer ${token}` } }), res);
    return res;
  };
  assert.equal((await call('practice')).body.data.cash, 10_000);
  const b = await call('practice-buy', { symbol: 'SOL', amount: '500' });
  assert.equal(b.statusCode, 200);
  assert.equal((await call('practice-buy', { symbol: 'SOL', amount: '1' })).statusCode, 400);
  const id = b.body.data.position.id;
  assert.equal((await call('practice-sell', { positionId: id })).statusCode, 200);
  assert.equal((await call('practice-reset', {})).body.data.cash, 10_000);
});

test('wizard step 3 lists each IP on its own line with "one at a time"; a key missing one IP is refused', async () => {
  const { net: n } = setup(100);
  process.env.TRADING_IPS = '54.1.2.3,54.4.5.6';
  process.env.FIXIE_URL = 'http://fixie:x@eu.usefixie.com:80';
  try {
    await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'golive 3' } } }), fakeRes());
    const t = n.sent.at(-1).text;
    assert.match(t, /Paste IP 1: `54\.1\.2\.3` → tap \*Confirm\*/);
    assert.match(t, /Paste IP 2: `54\.4\.5\.6`/);
    assert.match(t, /ONE AT A TIME — no commas/);

    // Every other request is rejected (key only allows one of the two IPs)
    let k = 0;
    axios.request = async ({ url }) => {
      if (url.includes('/api/v3/account')) { if (k++ % 2) { const e = new Error('x'); e.response = { status: 401, data: { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' } }; throw e; } return { data: { canTrade: true, balances: [] } }; }
      return { data: { enableWithdrawals: false, enableSpotAndMarginTrading: true } };
    };
    await assert.rejects(require('../src/services/tradingAccounts').connect('1000', { apiKey: KEY, apiSecret: SECRET, live: true }), /ALL the bot's IPs/);
  } finally { delete process.env.TRADING_IPS; delete process.env.FIXIE_URL; }
});

test('menu: every feature has a button; admin rows only for the admin; menu text matches the delete rule', async () => {
  const { net: n } = setup(100);
  const say = (id, text) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id }, from: {}, text } } }), fakeRes());
  await say(1000, 'menu');
  const admin = n.sent.at(-1);
  const data = admin.reply_markup.inline_keyboard.flat().map(x => x.callback_data);
  for (const d of ['positions', 'buynow_help', 'buy_help', 'sold_help', 'sell_help', 'setstop_help', 'check_help', 'profit', 'split_help', 'golive', 'autobuy', 'balance', 'practice', 'scan', 'moonshots', 'newlistings', 'dashboard', 'account', 'help', 'manual', 'pending', 'users', 'subs', 'invite']) {
    assert.ok(data.includes(d), `menu has ${d}`);
  }
  assert.match(admin.text, /^\*📋 Menu\*/);

  const users = require('../src/services/userService');
  await users.registerUser({ chatId: '2000', firstName: 'Ada' });
  await users.approveUser('2000');
  await say(2000, 'menu');
  const userData = n.sent.at(-1).reply_markup.inline_keyboard.flat().map(x => x.callback_data);
  assert.ok(!userData.includes('pending') && !userData.includes('subs'), 'no admin buttons for users');

  await require('../src/services/positionStore').addPosition({ chatId: '1000', symbol: 'SOLUSDT', buyPrice: 100, exchange: 'binance' });
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q', data: 'check_help', from: {}, message: { message_id: 9, chat: { id: 1000 }, text: '📋 Menu — tap any button' } } } }), fakeRes());
  assert.deepEqual(n.sent.at(-1).reply_markup.inline_keyboard.flat().map(x => x.callback_data), ['check SOL', 'nav:menu'], 'coins + ⬅️ Back to the menu');
});

test('positions: REAL only, split into bot-managed vs tracked; practice is never mixed in', async () => {
  const { net: n, practice } = setup(100);
  const ps = require('../src/services/positionStore');
  await ps.addPosition({ chatId: '1000', symbol: 'ETHUSDT', buyPrice: 100, quantity: 1, exchange: 'mexc' });
  const managed = await ps.addPosition({ chatId: '1000', symbol: 'SOLUSDT', buyPrice: 100, quantity: 2, stopLossPrice: 90, exchange: 'binance' });
  await ps.updatePosition('1000', managed.positionId, { strategy: 'donchian:55-20:btc' });
  await practice.buy('1000', { symbol: 'BNB', amount: 100 });
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: 'positions' } } }), fakeRes());
  const list = n.sent.at(-2).text;
  assert.match(list, /REAL MONEY — your positions \(2\)/);
  assert.match(list, /Managed by the bot[\s\S]*SOL[\s\S]*Tracked only[\s\S]*ETH/);
  assert.ok(!/BNB/.test(list), 'practice coin not in the real list');
  assert.match(n.sent.at(-1).reply_markup.inline_keyboard[0][0].text, /PRACTICE positions \(1\)/);
});
