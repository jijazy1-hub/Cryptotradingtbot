const test = require('node:test');
const assert = require('node:assert/strict');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');
const auth = require('../src/lib/dashAuth');

async function call(action, { token, body, method } = {}) {
  const res = fakeRes();
  await require('../api/app')(fakeReq({
    method: method || (body ? 'POST' : 'GET'),
    query: { action },
    body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }), res);
  return res;
}

test('login tokens: valid, tamper-proof, expire, and can be revoked', async () => {
  resetEnv();
  const t = await auth.issueToken('2000');
  assert.equal(await auth.verifyToken(t), '2000');
  const [payload, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ c: '1000', e: Date.now() + 1e9, v: 0 })).toString('base64url');
  assert.equal(await auth.verifyToken(`${forged}.${sig}`), null, 'changing the chat id breaks the signature');
  assert.equal(await auth.verifyToken(await auth.issueToken('2000', -1)), null, 'expired');
  await auth.revokeAll('2000');
  assert.equal(await auth.verifyToken(t), null, 'revoked');
  assert.equal(await auth.verifyToken(payload), null);
});

test('app API: no token → 401, unapproved user → 403', async () => {
  resetEnv();
  mockNet();
  assert.equal((await call('portfolio')).statusCode, 401);
  const t = await auth.issueToken('3000'); // never approved
  assert.equal((await call('portfolio', { token: t })).statusCode, 403);
  assert.equal((await call('nope', { token: t })).statusCode, 404);
  assert.equal((await call('add', { token: t, method: 'GET' })).statusCode, 405);
});

test('portfolio shows the user\'s real positions with live P&L and totals', async () => {
  resetEnv();
  mockNet({ price: 110 });
  const positions = require('../src/services/positionStore');
  await positions.addPosition({ chatId: '1000', symbol: 'SOLUSDT', buyPrice: 100, quantity: 2 });
  await positions.addPosition({ chatId: '1000', symbol: 'ETHUSDT', buyPrice: 100 });
  await positions.addPosition({ chatId: '2000', symbol: 'BTCUSDT', buyPrice: 50 }); // someone else's
  const token = await auth.issueToken('1000'); // admin
  const res = await call('portfolio', { token });
  assert.equal(res.statusCode, 200);
  const { positions: rows, totals } = res.body.data;
  assert.equal(rows.length, 2, 'only my own positions');
  const sol = rows.find(r => r.coin === 'SOL');
  assert.equal(sol.pnlPct, 10);
  assert.equal(sol.pnlUsd, 20);
  assert.equal(totals.invested, 200);
  assert.equal(totals.value, 220);
  assert.equal(totals.withoutQuantity, 1);
});

test('dashboard actions: add (plan locked), change stop, record sale, remove', async () => {
  resetEnv();
  mockNet({ price: 105 });
  const token = await auth.issueToken('1000');

  let res = await call('add', { token, body: { symbol: 'sol', buyPrice: '100', quantity: '3', target: '2x', stop: '95' } });
  assert.equal(res.statusCode, 200);
  const pos = res.body.data;
  assert.equal(pos.symbol, 'SOLUSDT');
  assert.equal(pos.stopLossPrice, 95);
  assert.equal(pos.takeProfits.tp1.price, 107.5);
  assert.equal(pos.targetMultiple, 2);

  res = await call('add', { token, body: { symbol: 'sol', buyPrice: '100', stop: '120' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /below your buy price/);

  res = await call('setstop', { token, body: { positionId: pos.positionId, price: '110' } });
  assert.equal(res.statusCode, 400, 'stop above live price refused');
  res = await call('setstop', { token, body: { positionId: pos.positionId, price: '101' } });
  assert.equal(res.body.data.stopLossPrice, 101);

  res = await call('sold', { token, body: { positionId: pos.positionId, sellPrice: '112' } });
  assert.equal(res.body.data.pnlPct, 12);
  assert.equal(res.body.data.pnlDollar, 36, 'uses the saved quantity');

  res = await call('history', { token });
  assert.equal(res.body.data.trades.length, 1);
  assert.equal(res.body.data.stats.allTime.totalTrades, 1);
  assert.equal((await call('portfolio', { token })).body.data.positions.length, 0);

  const other = await require('../src/services/positionStore').addPosition({ chatId: '2000', symbol: 'BTCUSDT', buyPrice: 1 });
  res = await call('remove', { token, body: { positionId: other.positionId } });
  assert.equal(res.statusCode, 400, "can't touch another user's position");
});

test('bot: /dashboard sends a personal link that logs in as that user', async () => {
  resetEnv();
  const net = mockNet();
  const res = fakeRes();
  await require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { message: { chat: { id: 1000 }, from: {}, text: '/dashboard' } } }), res);
  const btn = net.sent[0].reply_markup.inline_keyboard[0][0];
  assert.match(btn.url, /\/dashboard#t=/);
  const token = decodeURIComponent(btn.url.split('#t=')[1]);
  assert.equal(await auth.verifyToken(token), '1000');
});

test('dashboard add: a buy price far from the market returns code far_price; confirm saves it', async () => {
  resetEnv();
  mockNet({ price: 0.0000098 });
  const token = await auth.issueToken('1000');
  const r1 = await call('add', { token, body: { symbol: 'PEPE', buyPrice: '50' } });
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.body.code, 'far_price');
  const r2 = await call('add', { token, body: { symbol: 'PEPE', buyPrice: '50', confirm: true } });
  assert.equal(r2.statusCode, 200);
});
