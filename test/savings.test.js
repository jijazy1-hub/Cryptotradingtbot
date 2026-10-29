const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const DAY = 86_400_000;
const ENC = '0123456789abcdef'.repeat(4);
const KEY = 'A'.repeat(64), SECRET = 'b'.repeat(64);
const NO_LAB = path.join(os.tmpdir(), 'no-such-strategy.json');

const say = (chatId, text) => require('../api/telegram-webhook')(
  fakeReq({ method: 'POST', body: { message: { chat: { id: Number(chatId) }, from: {}, text } } }), fakeRes());

/** Fake Binance account: USDT balance you can change, market buys filled at `price`. */
function fakeBinance({ usdt = 100, price = 50000, coins = [] } = {}) {
  const b = { usdt, orders: [] };
  axios.request = async ({ method, url }) => {
    const u = new URL(url); const p = Object.fromEntries(u.searchParams);
    if (u.pathname.includes('apiRestrictions')) return { data: { enableWithdrawals: false, enableSpotAndMarginTrading: true } };
    if (u.pathname === '/api/v3/account') return { data: { canTrade: true, balances: [{ asset: 'USDT', free: String(b.usdt), locked: '0' }, ...coins] } };
    if (u.pathname === '/api/v3/order' && method === 'POST') {
      b.orders.push(p);
      const q = Number(p.quoteOrderQty) / price;
      b.usdt -= Number(p.quoteOrderQty);
      return { data: { orderId: b.orders.length, status: 'FILLED', executedQty: String(q), cummulativeQuoteQty: p.quoteOrderQty, fills: [{ commission: String(q * 0.001), commissionAsset: p.symbol.replace('USDT', '') }] } };
    }
    throw new Error('unmocked ' + u.pathname);
  };
  const get = axios.get;
  axios.get = (url, cfg) => (url.includes('/exchangeInfo')
    ? Promise.resolve({ data: { symbols: [{ symbol: cfg.params.symbol, status: 'TRADING', baseAsset: cfg.params.symbol.replace('USDT', ''), orderTypes: ['MARKET'], filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00000001', minQty: '0.00000001' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] } })
    : get(url, cfg));
  return b;
}

function setup(env = {}) {
  resetEnv({ TRADING_ENCRYPTION_KEY: ENC, AUTO_STRATEGY_FILE: NO_LAB, ...env });
  for (const k of ['PAID_ACCESS_ENABLED', 'FREE_ACCOUNT_LIMIT_USD', 'PAYSTACK_SECRET_KEY']) if (!(k in env)) delete process.env[k];
  const net = mockNet({ price: 50000 });
  return { net, sv: require('../src/services/savingsPlan'), store: require('../src/lib/redis') };
}

async function approvedUser(chatId = '2000') {
  const users = require('../src/services/userService');
  await users.registerUser({ chatId, firstName: 'Ada' });
  await users.approveUser(chatId);
}

// ─── What to expect ───────────────────────────────────────────────────────────
test('expect: honest dollar figures from the lab result; small amounts are told auto-buy can\'t trade', () => {
  setup();
  const ex = require('../src/services/expectations');
  const e = ex.estimate(20);
  assert.ok(e.perMonthUsd > 0.05 && e.perMonthUsd < 0.2, `about $0.11 a month on $20, got ${e.perMonthUsd}`);
  assert.ok(Math.abs(e.stats.yearlyPct - 7.0) < 0.3, 'about 7% a year from +21.5% over 2.9 years');
  assert.equal(e.autoBuyWorks, false);
  assert.equal(ex.minAutoBuyAccount(), 50);
  const m = ex.message(20);
  assert.match(m, /What to expect with \$20\*/);
  assert.match(m, /auto-buy can't place trades yet/);
  assert.match(m, /save 10/);
  assert.match(m, /holding BTC made \+94%/);
  assert.doesNotMatch(ex.message(1000), /can't place trades/);
  assert.match(ex.table(), /\$1,000 → about \+\$5\.\d\d\/month/);
});

test('expect: uses the saved lab result when there is one', () => {
  const fs = require('fs');
  const file = path.join(os.tmpdir(), `lab-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ period: { split: '2024-01-01', to: '2026-01-01' }, btcBuyHoldTestPct: 50, pick: { family: 'donchian', params: { entryN: 55, exitN: 20, regime: true }, portfolioTest: { returnPct: 21, maxDrawdownPct: 5 }, test: { trades: 48 } } }));
  setup({ AUTO_STRATEGY_FILE: file });
  const s = require('../src/services/expectations').stats();
  assert.equal(s.fromLab, true);
  assert.ok(Math.abs(s.yearlyPct - 10) < 0.2, '21% over 2 years ≈ 10% a year');
  assert.equal(Math.round(s.buysPerMonth), 2);
});

test('bot: `expect 20` and the go-live intro show what to expect', async () => {
  const { net } = setup();
  await say(1000, 'expect 20');
  assert.match(net.sent.at(-1).text, /What to expect with \$20/);
  await say(1000, 'golive');
  const intro = net.sent.at(-1);
  assert.match(intro.text, /What to expect\* \(average/);
  assert.match(intro.text, /\$20 → about/);
  assert.ok(intro.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'expect'));
  assert.ok(intro.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'save'));
});

// ─── Savings plan ─────────────────────────────────────────────────────────────
test('savings: $10 splits into $5 BTC + $5 ETH; $5 is BTC only; too small per coin is refused', async () => {
  const { sv } = setup();
  const p = await sv.setPlan('2000', { amount: 10 });
  assert.deepEqual(p.parts, [{ coin: 'BTC', usd: 5 }, { coin: 'ETH', usd: 5 }]);
  assert.equal(p.active, true);
  assert.equal(p.mode, 'practice');
  assert.deepEqual((await sv.setPlan('3000', { amount: 5 })).coins, ['BTC']);
  await assert.rejects(sv.setPlan('4000', { amount: 8, coins: ['BTC', 'ETH'] }), /less than \$5 each/);
  await assert.rejects(sv.setPlan('4000', { amount: 10, coins: ['PEPE'] }), /not PEPE/);
  await assert.rejects(sv.setPlan('4000', { amount: 2 }), /from \$5/);
  // Lowering the amount below what two coins need falls back to BTC only
  assert.deepEqual((await sv.setPlan('2000', { amount: 6 })).coins, ['BTC']);
});

test('savings: the next buy is the chosen weekday at 9am Lagos time', () => {
  const { sv } = setup();
  const mon = sv.parseDay('monday');
  assert.equal(mon, 1);
  assert.equal(sv.parseDay('Fri'), 5);
  const t = sv.nextOccurrence(mon, new Date('2026-10-27T12:00:00Z')); // a Tuesday
  assert.equal(t.toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(sv.nextOccurrence(2, new Date('2026-10-27T07:00:00Z')).toISOString(), '2026-10-27T08:00:00.000Z', 'same day if before 9am');
});

test('savings (practice): buys on the due day at live prices, once, then moves to next week', async () => {
  const { sv } = setup();
  await approvedUser();
  const now = new Date('2026-10-27T12:00:00Z');
  const p = await sv.setPlan('2000', { amount: 10, day: 1 }, now);
  const due = new Date(p.nextDue);
  const sent = [];
  const send = async (id, text) => sent.push({ id, text });

  let r = await sv.runDue({ allowed: new Set(['2000']), send, now: new Date(due.getTime() - 60_000) });
  assert.equal(r.bought, 0, 'not before the day');
  r = await sv.runDue({ allowed: new Set(['2000']), send, now: new Date(due.getTime() + 60_000) });
  assert.equal(r.bought, 1);
  assert.match(sent.at(-1).text, /PRACTICE · \*Weekly savings\*/);
  assert.match(sent.at(-1).text, /Bought \$5\.00 of \*BTC\*/);
  assert.match(sent.at(-1).text, /Bought \$5\.00 of \*ETH\*/);
  assert.match(sent.at(-1).text, /never sells your savings/);
  r = await sv.runDue({ allowed: new Set(['2000']), send, now: new Date(due.getTime() + 30 * 60_000) });
  assert.equal(r.bought, 0, 'never twice in a week');
  const after = await sv.getPlan('2000');
  assert.equal(new Date(after.nextDue).getTime(), due.getTime() + 7 * DAY);
  const s = await sv.summary('2000', { prices: { BTC: 50000, ETH: 50000 } });
  assert.equal(s.buys, 2);
  assert.equal(s.invested, 10);
  assert.ok(s.value < 10 && s.value > 9.9, 'fees and slippage included');
  // Users without access are skipped
  assert.equal((await sv.runDue({ allowed: new Set(), send, now: new Date(due.getTime() + 8 * DAY) })).checked, 0);
});

test('savings (real): waits for USDT (says so once), reminds the day before, then buys on Binance', async () => {
  const { sv } = setup();
  await approvedUser();
  const bn = fakeBinance({ usdt: 3 });
  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('2000', true);
  const now = new Date('2026-10-27T12:00:00Z');
  const p = await sv.setPlan('2000', { amount: 10, day: 1, mode: 'live' }, now);
  const due = new Date(p.nextDue).getTime();
  const sent = [];
  const send = async (id, text) => sent.push({ id, text });
  const run = (t) => sv.runDue({ allowed: new Set(['2000']), send, now: new Date(t) });

  await run(due - 20 * 3_600_000);
  assert.match(sent.at(-1).text, /Savings reminder/);
  assert.match(sent.at(-1).text, /add at least \$7\.00/);
  await run(due - 19 * 3_600_000);
  assert.equal(sent.length, 1, 'one reminder only');

  await run(due + 60_000);
  assert.match(sent.at(-1).text, /waiting/);
  assert.match(sent.at(-1).text, /needs \*\$10\.00 USDT\*/);
  await run(due + 31 * 60_000);
  assert.equal(sent.length, 2, 'waiting is said once, then retried quietly');
  assert.equal(bn.orders.length, 0);

  bn.usdt = 25;
  await run(due + 62 * 60_000);
  assert.equal(bn.orders.length, 2);
  assert.deepEqual(bn.orders.map(o => [o.symbol, o.side, o.type, o.quoteOrderQty]), [['BTCUSDT', 'BUY', 'MARKET', '5.00'], ['ETHUSDT', 'BUY', 'MARKET', '5.00']]);
  assert.match(sent.at(-1).text, /💰 REAL · \*Weekly savings\*/);
  const s = await sv.summary('2000', { mode: 'live', prices: { BTC: 50000, ETH: 50000 } });
  assert.equal(s.buys, 2);
  assert.ok(s.holdings[0].qty < 0.0001 && s.holdings[0].qty > 0.000099, 'fee taken in the coin');
  // No stop orders, no positions: savings are never sold
  assert.ok(!bn.orders.some(o => o.side === 'SELL'));
  assert.equal(Object.keys(await require('../src/services/positionStore').getAllPositions('2000')).length, 0);
});

test('savings (real): a week whose USDT never arrives is skipped after 6 days', async () => {
  const { sv } = setup();
  fakeBinance({ usdt: 0 });
  const accounts = require('../src/services/tradingAccounts');
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET });
  await accounts.setEnabled('2000', true);
  const p = await sv.setPlan('2000', { amount: 10, day: 1, mode: 'live' }, new Date('2026-10-27T12:00:00Z'));
  const due = new Date(p.nextDue).getTime();
  const sent = [];
  await sv.runDue({ allowed: new Set(['2000']), send: async (id, t) => sent.push(t), now: new Date(due + 6.5 * DAY) });
  assert.match(sent.at(-1), /skipped this week/);
  assert.equal(new Date((await sv.getPlan('2000')).nextDue).getTime(), due + 7 * DAY);
});

test('savings: a buy made by hand is extra and keeps the schedule; auto-buy leaves the savings USDT alone', async () => {
  const { sv } = setup();
  const now = new Date('2026-10-27T12:00:00Z');
  const p = await sv.setPlan('2000', { amount: 10, day: 1 }, now);
  const r = await sv.runOne('2000', { now, scheduled: false });
  assert.equal(r.status, 'bought');
  assert.equal((await sv.getPlan('2000')).nextDue, p.nextDue);

  await sv.setPlan('2000', { mode: 'live' });
  const due = new Date(p.nextDue);
  assert.equal(await sv.reservedUsd('2000', new Date(due.getTime() - 2 * DAY)), 0);
  assert.equal(await sv.reservedUsd('2000', new Date(due.getTime() - 12 * 3_600_000)), 10);
});

test('bot: `save 10` starts a practice plan; `save` shows it; `save stop` asks first', async () => {
  const { net, sv } = setup();
  await say(1000, 'save 10');
  assert.match(net.sent.at(-1).text, /Weekly savings started\* — 🎮 PRACTICE/);
  assert.match(net.sent.at(-1).text, /\$5\.00 of BTC \+ \$5\.00 of ETH/);
  assert.match(net.sent.at(-1).text, /In a year that's \$520\.00 put in/);
  await say(1000, 'save now');
  assert.match(net.sent.at(-1).text, /Bought \$5\.00 of \*BTC\*/);
  await say(1000, 'save');
  assert.match(net.sent.at(-1).text, /So far:\* 2 buys · put in \$10\.00/);
  await say(1000, 'save day friday');
  assert.match(net.sent.at(-1).text, /Savings day: \*Friday\*/);
  await say(1000, 'save real');
  assert.match(net.sent.at(-1).text, /connect your Binance account first/);
  await say(1000, 'save stop');
  assert.match(net.sent.at(-1).text, /Stop your savings plan\?/);
  assert.ok(await sv.getPlan('1000'));
  await say(1000, 'save stop confirm');
  assert.equal(await sv.getPlan('1000'), null);
  await say(1000, 'save 3');
  assert.match(net.sent.at(-1).text, /from \$5/);
});

// ─── Free for small accounts ──────────────────────────────────────────────────
test('free for small accounts: a $40 Binance account gets in free; $500 needs a subscription', async () => {
  setup({ PAID_ACCESS_ENABLED: 'true' });
  const { net } = { net: mockNet({ price: 50000 }) };
  await approvedUser('2000');
  await approvedUser('3000');
  const subs = require('../src/services/subscriptionService');
  const accounts = require('../src/services/tradingAccounts');

  const bn = fakeBinance({ usdt: 40 });
  await accounts.connect('2000', { apiKey: KEY, apiSecret: SECRET, live: true });
  assert.equal(await subs.hasAccess('2000'), false, 'not checked yet');
  await say('2000', 'positions');
  assert.match(net.sent.at(-1).text, /No real positions open|positions/i, 'the balance is checked on the spot and access opens');
  assert.equal(await subs.hasAccess('2000'), true);
  await say('2000', 'account');
  assert.match(net.sent.at(-1).text, /Free — small account/);
  assert.match(net.sent.at(-1).text, /\$40\.00/);

  bn.usdt = 500;
  await accounts.connect('3000', { apiKey: KEY, apiSecret: SECRET, live: true });
  await say('3000', 'positions');
  assert.match(net.sent.at(-1).text, /need a subscription/);
  assert.match(net.sent.at(-1).text, /Free for small accounts/);
  assert.equal(await subs.hasAccess('3000'), false);

  // Users without Binance can still connect and check their balance
  await approvedUser('4000');
  await say('4000', 'golive');
  assert.match(net.sent.at(-1).text, /Go live/);
});

test('free for small accounts: savings-plan coins don\'t count; a user who grows past the limit is told once', async () => {
  setup({ PAID_ACCESS_ENABLED: 'true' });
  await approvedUser('2000');
  const subs = require('../src/services/subscriptionService');
  const store = require('../src/lib/redis');
  await subs.loadSettings({ force: true });

  // $60 of savings coins bought by the plan → a $130 balance counts as $70
  await store.cmd('RPUSH', 'cryptobot:save:log:2000', JSON.stringify({ mode: 'live', coin: 'BTC', usd: 60, qty: 0.0012, price: 50000 }));
  const r = await subs.recordBalance('2000', 130);
  assert.equal(r.usd, 70);
  assert.equal(r.free, true);

  const bn = fakeBinance({ usdt: 50 });
  await require('../src/services/tradingAccounts').connect('2000', { apiKey: KEY, apiSecret: SECRET, live: true });
  bn.usdt = 400;
  const sent = [];
  const send = async (id, text) => sent.push({ id, text });
  await subs.refreshAllSmall({ send, now: new Date('2026-10-27T10:00:00Z') });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /above the free limit of \$100\.00/);
  assert.equal(await subs.hasAccess('2000'), false);
  await subs.refreshAllSmall({ send, now: new Date('2026-10-28T10:00:00Z') });
  assert.equal(sent.length, 1, 'told once only');
});

test('admin: set the free limit from the Subscriptions panel', async () => {
  const net = setup({ PAID_ACCESS_ENABLED: 'true' }).net;
  const subs = require('../src/services/subscriptionService');
  await say(1000, 'subs');
  assert.match(net.sent.at(-1).text, /Free for small accounts:\* 🆓 Binance balance up to \$100\.00/);
  await say(1000, 'subs free');
  assert.ok(net.sent.at(-1).reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'subs free 50'));
  await say(1000, 'subs free 50');
  assert.equal(subs.freeLimit(), 50);
  await say(1000, 'subs free off');
  assert.equal(subs.freeLimit(), 0);
  assert.equal(await subs.isFreeSmall('2000'), false);
});

test('savings: a double tap on "buy now" buys only once', async () => {
  const { sv } = setup();
  const now = new Date('2026-10-27T12:00:00Z');
  await sv.setPlan('2000', { amount: 10, day: 1 }, now);
  assert.equal((await sv.runOne('2000', { now, scheduled: false })).status, 'bought');
  const again = await sv.runOne('2000', { now: new Date(now.getTime() + 5000), scheduled: false });
  assert.equal(again.status, 'busy');
  assert.match(again.message, /nothing more was bought/);
  assert.equal((await sv.summary('2000', { prices: { BTC: 1, ETH: 1 } })).buys, 2, 'one buy of two coins');
});
