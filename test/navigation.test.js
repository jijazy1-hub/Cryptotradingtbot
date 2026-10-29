const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const nav = require('../src/lib/navigation');

function setup() {
  resetEnv({ TELEGRAM_WEBHOOK_SECRET: '', AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json') });
  const net = mockNet({ price: 100 });
  const deleted = [];
  const post = axios.post;
  axios.post = async (url, body, cfg) => (url.endsWith('/deleteMessage') ? (deleted.push(body.message_id), { data: { ok: true, result: true } }) : post(url, body, cfg));
  // The mock gives message ids 1, 2, 3… in send order (= net.sent index + 1)
  const hook = require('../api/telegram-webhook');
  const tap = (data, messageId) => hook(fakeReq({ method: 'POST', body: { callback_query: { id: 'q', data, from: {}, message: { message_id: messageId, chat: { id: 1000 }, text: 'x' } } } }), fakeRes());
  const say = (text) => hook(fakeReq({ method: 'POST', body: { message: { message_id: 900, chat: { id: 1000 }, from: {}, text } } }), fakeRes());
  const last = () => ({ msg: net.sent.at(-1), id: net.sent.length });
  const buttons = (m) => (m.reply_markup?.inline_keyboard || []).flat().map(x => x.callback_data).filter(Boolean);
  return { net, deleted, tap, say, last, buttons };
}

test('screens vs actions: only read-only screens can be returned to with Back', () => {
  for (const v of ['menu', 'positions', 'practice', 'autobuy', 'golive', 'golive 2', 'subs', 'subs plan', 'subs give', 'subs give 2000', 'check SOL', 'buy_help', 'practice help', 'stops', 'balance'])
    assert.equal(nav.isView(v), true, `${v} is a screen`);
  for (const a of ['practice reset', 'practice reset confirm', 'buynow SOL 50', 'buynow SOL 50 confirm', 'autobuy on', 'autobuy live on confirm', 'golive on confirm', 'golive 4', 'subs give 2000 30', 'subs end 2000', 'subs toggle confirm', 'dashboard', 'invite', 'approve:2000', 'something unknown'])
    assert.equal(nav.isView(a), false, `${a} is an action (never repeated by Back)`);
  // A key pasted as text can never become a stored screen name
  assert.equal(nav.isView('A'.repeat(64)), false);
});

test('Back row is added once, and not when a button already goes back there', () => {
  const kb = { inline_keyboard: [[{ text: 'x', callback_data: 'autobuy on' }]] };
  assert.deepEqual(nav.withBack(kb, 'practice').inline_keyboard.at(-1), [{ text: '⬅️ Back', callback_data: 'nav:practice' }]);
  const hasCancel = { inline_keyboard: [[{ text: 'Cancel', callback_data: 'subs' }]] };
  assert.equal(nav.withBack(hasCancel, 'subs').inline_keyboard.length, 1, 'Cancel → subs already does the job');
  const sameTarget = { inline_keyboard: [[{ text: '🛒 Auto-buy', callback_data: 'autobuy' }]] };
  assert.equal(nav.withBack(sameTarget, 'autobuy').inline_keyboard.length, 2, 'a normal button to the same screen still gets an explicit ⬅️ Back');
  assert.equal(nav.withBack(kb, null).inline_keyboard.length, 1, 'no Back on the menu itself');
});

test('menu → practice → auto-buy → Back → practice → Back → menu; each tapped screen is deleted', async () => {
  const { net, deleted, tap, say, last, buttons } = setup();

  await say('menu');
  const menu = last();
  assert.ok(!buttons(menu.msg).some(d => d.startsWith('nav:')), 'the menu has no Back');

  await tap('practice', menu.id);
  const prac = last();
  assert.match(prac.msg.text, /PRACTICE/);
  assert.equal(buttons(prac.msg).at(-1), 'nav:menu', 'practice → Back to the menu');
  assert.ok(deleted.includes(menu.id), 'the menu was removed');

  await tap('autobuy', prac.id);
  const ab = last();
  assert.match(ab.msg.text, /Auto-buy/);
  assert.ok(deleted.includes(prac.id), 'the practice screen was removed');
  assert.equal(buttons(ab.msg).at(-1), 'nav:practice', 'auto-buy → Back to practice');

  await tap('stops', ab.id);
  const st = last();
  assert.match(st.msg.text, /Today's stop for each coin|Couldn't work out/);
  assert.equal(buttons(st.msg).at(-1), 'nav:autobuy', 'Back returns to the screen it was opened from');

  await tap('nav:autobuy', st.id);
  const ab2 = last();
  assert.match(ab2.msg.text, /Auto-buy/);
  assert.ok(deleted.includes(st.id));

  assert.equal(buttons(ab2.msg).at(-1), 'nav:practice', 'auto-buy still goes Back to practice');
  await tap('nav:practice', ab2.id);
  assert.match(last().msg.text, /PRACTICE/);
  assert.equal(buttons(last().msg).at(-1), 'nav:menu', 'practice remembers it was opened from the menu');
  await tap('nav:menu', last().id);
  assert.match(last().msg.text, /📋 Menu/);
  assert.ok(net.sent.length > 6);
});

test('Back from an action\'s result goes to the screen it started on and never repeats the action; receipts are kept', async () => {
  const { deleted, tap, say, last, buttons } = setup();
  const practice = require('../src/services/practiceService');
  await practice.buy('1000', { symbol: 'SOL', amount: 100 });

  await say('practice');
  const prac = last();
  await tap('practice reset', prac.id);
  const prompt = last();
  assert.match(prompt.msg.text, /Start again with \$10,000/);
  assert.deepEqual(buttons(prompt.msg), ['practice reset confirm', 'nav:practice'], 'confirm, or Back to practice');

  await tap('practice reset confirm', prompt.id);
  const receipt = last();
  assert.match(receipt.msg.text, /Practice account reset/);
  assert.deepEqual(buttons(receipt.msg), ['nav:practice'], 'the receipt gets a Back button');
  assert.ok(deleted.includes(prompt.id), 'the question was removed');

  const before = deleted.length;
  await tap('nav:practice', receipt.id);
  assert.ok(!deleted.includes(receipt.id), 'a receipt is kept when its Back is tapped');
  assert.equal(deleted.length, before);
  assert.match(last().msg.text, /PRACTICE/, 'Back shows the practice screen again…');
  assert.equal((await practice.summary('1000')).cash, 10_000, '…and did not reset anything twice');
});

test('a screen of plain messages: only the last message carries Back, and all of it is removed together', async () => {
  const { net, deleted, tap, say, last, buttons } = setup();
  await say('menu');
  const menu = last();
  const start = net.sent.length;
  await tap('buy_help', menu.id);
  const sent = net.sent.slice(start);
  assert.ok(sent.length >= 1);
  assert.deepEqual(buttons(sent.at(-1)), ['nav:menu']);
  for (const m of sent.slice(0, -1)) assert.ok(!buttons(m).some(d => d.startsWith('nav:')));
  await tap('nav:menu', last().id);
  for (let id = start + 1; id <= start + sent.length; id++) assert.ok(deleted.includes(id), `message ${id} of the screen removed`);
});
