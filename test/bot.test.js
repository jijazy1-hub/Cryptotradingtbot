const test = require('node:test');
const assert = require('node:assert/strict');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const ADMIN = '1000';

async function say(text, chatId = ADMIN) {
  const handler = require('../api/telegram-webhook');
  const res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: { message: { chat: { id: Number(chatId) }, from: { first_name: 'T' }, text } } }), res);
  assert.equal(res.statusCode, 200);
}

test('buy numbering is correct and the trade plan is locked at buy time', async () => {
  resetEnv();
  const net = mockNet({ price: 101 });
  const store = require('../src/services/positionStore');

  await say('buy SOL 100 2x');
  assert.match(net.sent[0].text, /Buy #1 Registered/);
  await say('buy SOL 95');
  const second = net.sent.find((m, i) => i > 0 && /Buy #/.test(m.text));
  assert.match(second.text, /Buy #2 Registered/);

  const positions = await store.getPositionsBySymbol(ADMIN, 'SOLUSDT');
  assert.equal(positions.length, 2);
  for (const p of positions) {
    assert.ok(p.stopLossPrice > 0 && p.stopLossPrice < p.buyPrice, 'stop locked below entry');
    assert.ok(p.takeProfits && p.takeProfits.tp1.price > p.buyPrice);
  }
});

test('"sold SOL 100 120 2" records the trade and removes the matching entry', async () => {
  resetEnv();
  const net = mockNet({ price: 101 });
  const store = require('../src/services/positionStore');
  const profit = require('../src/services/profitTracker');

  await say('buy SOL 100 2x');
  await say('sold SOL 100 120 2');

  const trades = await profit.getAllTrades(ADMIN);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnlPct, 20);
  assert.equal(trades[0].pnlDollar, 40);
  assert.equal((await store.getPositionsBySymbol(ADMIN, 'SOLUSDT')).length, 0);
  assert.ok(net.sent.some(m => /Trade Recorded/.test(m.text)));
});

test('plain "sold SOL" still works as an alias for sell', async () => {
  resetEnv();
  mockNet({ price: 101 });
  const store = require('../src/services/positionStore');
  await say('buy SOL 100');
  await say('sold SOL');
  assert.equal((await store.getPositionsBySymbol(ADMIN, 'SOLUSDT')).length, 0);
});

test('admin "remove SOL" removes the position, "remove <id>" removes a user', async () => {
  resetEnv();
  mockNet({ price: 101 });
  const store = require('../src/services/positionStore');
  const users = require('../src/services/userService');

  await users.registerUser({ chatId: '2000', firstName: 'Ann' });
  await say('buy SOL 100');
  await say('remove SOL');
  assert.equal((await store.getPositionsBySymbol(ADMIN, 'SOLUSDT')).length, 0);
  assert.ok(await users.getUser('2000'), 'user must not be touched by "remove SOL"');

  await say('remove 2000');
  assert.equal(await users.getUser('2000'), null);
});

test('/command@BotName works in groups', async () => {
  resetEnv();
  const net = mockNet({ price: 101 });
  await say('/help@TestBot');
  assert.match(net.sent[0].text, /All commands/);
});

test('unapproved users are blocked from commands', async () => {
  resetEnv();
  const net = mockNet({ price: 101 });
  await say('positions', '3000');
  assert.match(net.sent[0].text, /\/start/);
});

test('buy: a price far from the market is questioned (buy PEPE 50 ≠ $50 of PEPE); confirm saves it', async () => {
  resetEnv();
  const net = mockNet({ price: 0.0000098 });
  const store = require('../src/services/positionStore');
  await say('buy PEPE 50');
  assert.match(net.sent.at(-1).text, /Check the price — PEPE/);
  const kb = net.sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.callback_data).filter(d => !d.startsWith('nav:'));
  assert.deepEqual(kb, ['buy PEPE 50 confirm', 'buynow PEPE 50', 'practice buynow PEPE 50']);
  assert.equal((await store.getPositionsBySymbol('1000', 'PEPEUSDT')).length, 0, 'nothing saved yet');
  await say('buy PEPE 50 confirm');
  assert.equal((await store.getPositionsBySymbol('1000', 'PEPEUSDT')).length, 1);
  await say('buy PEPE 0.0000097');
  assert.equal((await store.getPositionsBySymbol('1000', 'PEPEUSDT')).length, 2, 'a normal price goes straight through');
});
