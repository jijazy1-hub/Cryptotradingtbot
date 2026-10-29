const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const crypto = require('crypto');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const SK = 'sk_test_' + 'x'.repeat(40);

/** Fake Paystack: initialize stores the transaction, verify returns its status. */
function fakePaystack({ amount = 500000, currency = 'NGN' } = {}) {
  const ps = { tx: new Map(), verifyCalls: 0, initBodies: [] };
  axios.request = async ({ method, url, data, headers }) => {
    assert.equal(headers.Authorization, `Bearer ${SK}`);
    if (url.endsWith('/transaction/initialize')) {
      ps.initBodies.push(data);
      ps.tx.set(data.reference, { status: 'abandoned', amount, currency, metadata: data.metadata, reference: data.reference });
      return { data: { status: true, data: { authorization_url: `https://checkout.paystack.com/${data.reference}`, reference: data.reference } } };
    }
    const m = url.match(/\/transaction\/verify\/(.+)$/);
    if (m) {
      ps.verifyCalls++;
      const t = ps.tx.get(decodeURIComponent(m[1]));
      if (!t) { const e = new Error('404'); e.response = { status: 404, data: { message: 'Transaction reference not found' } }; throw e; }
      return { data: { status: true, data: t } };
    }
    throw new Error(`unmocked ${method} ${url}`);
  };
  ps.pay = (ref) => { ps.tx.get(ref).status = 'success'; };
  return ps;
}

async function approvedUser(chatId = '2000') {
  const users = require('../src/services/userService');
  await users.registerUser({ chatId, firstName: 'Ada', username: 'ada' });
  await users.approveUser(chatId);
}

const say = (chatId, text, extra = {}) => require('../api/telegram-webhook')(
  fakeReq({ method: 'POST', body: { message: { chat: { id: Number(chatId) }, from: {}, text, ...extra } } }), fakeRes());

function setup(env = {}) {
  resetEnv({ PAID_ACCESS_ENABLED: 'true', PAYSTACK_SECRET_KEY: SK, SUBSCRIPTION_PRICE: '5000', ...env });
  for (const k of ['SUBSCRIPTION_CURRENCY', 'SUBSCRIPTION_DAYS']) if (!(k in env)) delete process.env[k];
  const net = mockNet({ price: 100 });
  const ps = fakePaystack();
  return { net, ps };
}

test('paid access OFF (default): nothing changes for approved users', async () => {
  resetEnv();
  delete process.env.PAID_ACCESS_ENABLED;
  const net = mockNet();
  await approvedUser();
  await say('2000', 'positions');
  assert.match(net.sent.at(-1).text, /No real positions open/);
  assert.equal(await require('../src/services/subscriptionService').hasAccess('2000'), true);
});

test('paid access ON: unpaid users are asked to subscribe; the admin never is', async () => {
  const { net } = setup();
  await approvedUser();
  await say('2000', 'positions');
  assert.match(net.sent.at(-1).text, /need a subscription/);
  await say('1000', 'positions');
  assert.match(net.sent.at(-1).text, /No real positions open/, 'admin is free');
  await say('2000', 'account');
  assert.match(net.sent.at(-1).text, /No subscription yet/);
});

test('subscribe → Paystack link → payment verified once → access for 30 days', async () => {
  const { net, ps } = setup();
  await approvedUser();
  const subs = require('../src/services/subscriptionService');

  await say('2000', 'subscribe');
  assert.match(net.sent.at(-1).text, /email/i, 'asks for an email first');

  await say('2000', 'subscribe ada@example.com');
  const msg = net.sent.at(-1);
  assert.match(msg.text, /NGN 5,000 \/ 30 days/);
  const url = msg.reply_markup.inline_keyboard[0][0].url;
  assert.match(url, /^https:\/\/checkout\.paystack\.com\//);
  const [init] = ps.initBodies;
  assert.equal(init.amount, 500000, 'amount in kobo');
  assert.equal(init.email, 'ada@example.com');
  assert.match(init.callback_url, /\/paid$/);

  // Not paid yet → nothing credited
  assert.equal((await subs.confirmPayment(init.reference)).credited, false);
  assert.equal(await subs.hasAccess('2000'), false);

  // Paid → Paystack sends the payer back to /paid
  ps.pay(init.reference);
  const res = fakeRes();
  await require('../api/app')(fakeReq({ query: { action: 'paystack-callback', reference: init.reference } }), res);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.Location, /t\.me\/.+\?start=paid/);
  assert.equal(await subs.hasAccess('2000'), true);
  assert.ok(net.sent.some(m => m.chat_id == '2000' && /Payment received/.test(m.text)));
  assert.ok(net.sent.some(m => m.chat_id == '1000' && /paid NGN 5,000/.test(m.text)), 'admin told');
  const until1 = (await subs.getSub('2000')).paidUntil;
  assert.ok(Math.abs(new Date(until1) - Date.now() - 30 * 86400000) < 60000);

  // The webhook for the same payment arrives too → not credited twice
  const body = JSON.stringify({ event: 'charge.success', data: { reference: init.reference } });
  const sig = crypto.createHmac('sha512', SK).update(body).digest('hex');
  const wres = fakeRes();
  await require('../api/app')(fakeReq({ method: 'POST', query: { action: 'paystack-webhook' }, body, headers: { 'x-paystack-signature': sig } }), wres);
  assert.equal(wres.statusCode, 200);
  assert.equal((await subs.getSub('2000')).paidUntil, until1, 'same payment never adds time twice');

  await say('2000', 'positions');
  assert.match(net.sent.at(-1).text, /No real positions open/, 'can use the bot now');
});

test('a wrong amount or currency is not credited, and a forged webhook does nothing', async () => {
  const { ps } = setup();
  await approvedUser();
  const subs = require('../src/services/subscriptionService');
  const { reference } = await subs.startCheckout('2000', { email: 'a@b.co', callbackUrl: 'x' });
  ps.tx.get(reference).amount = 100; // ₦1
  ps.pay(reference);
  const r = await subs.confirmPayment(reference);
  assert.equal(r.credited, false);
  assert.match(r.reason, /expected NGN 5000/);

  // Forged webhook (no signature, or a wrong one) → refused before anything else
  for (const headers of [{}, { 'x-paystack-signature': 'f'.repeat(128) }]) {
    const res = fakeRes();
    await require('../api/app')(fakeReq({ method: 'POST', query: { action: 'paystack-webhook' }, body: { event: 'charge.success', data: { reference } }, headers }), res);
    assert.equal(res.statusCode, 401, 'unsigned / badly signed webhooks are refused');
  }
  assert.equal(ps.verifyCalls, 1, 'a refused webhook never makes the bot call Paystack');

  // Correctly signed, but for a reference this bot never created → ignored without a lookup
  const body = { event: 'charge.success', data: { reference: 'cb_9999_fake_ref' } };
  const sig = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(JSON.stringify(body)).digest('hex');
  const res = fakeRes();
  await require('../api/app')(fakeReq({ method: 'POST', query: { action: 'paystack-webhook' }, body, headers: { 'x-paystack-signature': sig } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(await subs.hasAccess('2000'), false);
  assert.equal(ps.verifyCalls, 1, 'unknown references are not even looked up');
});

test('renewing early adds time on top; admin grant / revoke', async () => {
  setup();
  await approvedUser();
  const subs = require('../src/services/subscriptionService');
  const a = await subs.extend('2000', 30);
  const b = await subs.extend('2000', 30);
  assert.equal(new Date(b) - new Date(a), 30 * 86400000);

  await subs.revoke('2000');
  assert.equal(await subs.hasAccess('2000'), false);
  await say('1000', 'grant 2000 7');
  assert.equal(await subs.hasAccess('2000'), true);
  assert.equal((await subs.getSub('2000')).daysLeft, 7);
});

test('reminders: 3 days before the end and once when it ends; expired users get no position alerts', async () => {
  setup();
  await approvedUser();
  const subs = require('../src/services/subscriptionService');
  const store = require('../src/lib/redis');
  const sent = [];
  const send = async (id, text) => sent.push({ id, text });

  await store.cmd('HSET', 'cryptobot:sub:2000', 'paidUntil', new Date(Date.now() + 2 * 86400000).toISOString());
  assert.equal((await subs.sendReminders(send)).reminded, 1);
  assert.equal((await subs.sendReminders(send)).reminded, 0, 'only once');
  assert.match(sent[0].text, /ends in 2 days/);

  await store.cmd('HSET', 'cryptobot:sub:2000', 'paidUntil', new Date(Date.now() - 1000).toISOString());
  assert.equal((await subs.sendReminders(send)).expired, 1);
  assert.equal((await subs.sendReminders(send)).expired, 0);

  assert.deepEqual(await subs.getChatIdsWithAccess(), ['1000'], 'monitor only checks users with access');
});

test('app API: expired users get 402 except for account and payment actions', async () => {
  setup();
  await approvedUser();
  const token = await require('../src/lib/dashAuth').issueToken('2000');
  const call = async (action, body) => {
    const res = fakeRes();
    await require('../api/app')(fakeReq({ method: body ? 'POST' : 'GET', query: { action }, body, headers: { authorization: `Bearer ${token}` } }), res);
    return res;
  };
  assert.equal((await call('portfolio')).statusCode, 402);
  const st = await call('subscription');
  assert.equal(st.statusCode, 200);
  assert.equal(st.body.data.active, false);
  const pay = await call('subscribe', { email: 'ada@example.com' });
  assert.match(pay.body.data.url, /checkout\.paystack\.com/);
  assert.equal((await call('subscribe', { email: 'nope' })).statusCode, 400);
});

test('admin panel: turn paid access on with a button (warns + offers 7 free days), set the plan, give until a date', async () => {
  resetEnv({ PAYSTACK_SECRET_KEY: SK });
  delete process.env.PAID_ACCESS_ENABLED;
  const net = mockNet({ price: 100 });
  await approvedUser('2000');
  await approvedUser('3000');
  const subs = require('../src/services/subscriptionService');
  const tap = (data) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q', data, from: {}, message: { message_id: 1, chat: { id: 1000 }, text: 'x' } } } }), fakeRes());
  const type = (text) => say('1000', text);

  await type('subs');
  assert.match(net.sent.at(-1).text, /Paid access:\* ⚪ OFF/);
  await tap('subs toggle');
  assert.match(net.sent.at(-1).text, /2 users have no subscription/);
  assert.equal(subs.enabled(), false, 'not switched on until confirmed');
  await tap('subs giveall 7');
  assert.equal(subs.enabled(), true);
  assert.equal((await subs.getSub('2000')).daysLeft, 7);

  // Plan
  await tap('subs days 90');
  await type('subs price 12000');
  await tap('subs currency USD');
  assert.equal(subs.priceLabel(), 'USD 12,000 / 90 days');

  // Give until a typed date
  await tap('subs give 3000');
  assert.match(net.sent.at(-1).text, /How long\?/);
  await tap('subs give 3000 date');
  await type('31/12/2099');
  assert.equal((await subs.getSub('3000')).paidUntil, '2099-12-31T22:59:59.000Z');
  assert.ok(net.sent.some(m => m.chat_id == '3000' && /given access to the bot until 31 Dec 2099/.test(m.text)));

  // A bad date is refused and can be retried
  await tap('subs give 3000 date');
  await type('31/02/2099');
  assert.match(net.sent.at(-1).text, /date like 31\/12\/2026/);
  await type('01/01/2100');
  assert.equal((await subs.getSub('3000')).paidUntil, '2100-01-01T22:59:59.000Z');

  // grant with a date works too; end a subscription
  await type('grant 2000 15/06/2099');
  assert.equal((await subs.getSub('2000')).paidUntil, '2099-06-15T22:59:59.000Z');
  await tap('subs end 2000');
  assert.equal((await subs.getSub('2000')).active, false);

  // Off again with one tap
  await tap('subs toggle');
  assert.equal(subs.enabled(), false);
});

/** Fake Flutterwave v3: /payments returns a link; verify_by_reference returns the stored transaction. */
function fakeFlutterwave({ amount = 5000, currency = 'NGN' } = {}) {
  const fw = { tx: new Map(), created: [] };
  const prev = axios.request;
  axios.request = async (cfg) => {
    if (!cfg.url.startsWith('https://api.flutterwave.com/')) return prev(cfg);
    assert.equal(cfg.headers.Authorization, 'Bearer FLWSECK_TEST-x');
    if (cfg.url.endsWith('/v3/payments')) {
      fw.created.push(cfg.data);
      fw.tx.set(cfg.data.tx_ref, { status: 'pending', tx_ref: cfg.data.tx_ref, amount, currency, meta: cfg.data.meta });
      return { data: { status: 'success', data: { link: `https://checkout.flutterwave.com/v3/hosted/pay/${cfg.data.tx_ref}` } } };
    }
    const m = cfg.url.match(/verify_by_reference\?tx_ref=(.+)$/);
    if (m) { const t = fw.tx.get(decodeURIComponent(m[1])); if (!t) { const e = new Error('404'); e.response = { status: 404, data: { message: 'No transaction was found' } }; throw e; } return { data: { status: 'success', data: t } }; }
    throw new Error('unmocked flutterwave ' + cfg.url);
  };
  fw.pay = (ref) => { fw.tx.get(ref).status = 'successful'; };
  return fw;
}

test('Flutterwave: users choose a provider; payment verified with Flutterwave\'s API, credited once (return link + webhook)', async () => {
  resetEnv({ PAID_ACCESS_ENABLED: 'true', PAYSTACK_SECRET_KEY: SK, FLW_SECRET_KEY: 'FLWSECK_TEST-x', FLW_SECRET_HASH: 'myhash', SUBSCRIPTION_PRICE: '5000' });
  const net = mockNet({ price: 100 });
  fakePaystack();
  const fw = fakeFlutterwave();
  await approvedUser();
  const subs = require('../src/services/subscriptionService');
  const tap = (data) => require('../api/telegram-webhook')(fakeReq({ method: 'POST', body: { callback_query: { id: 'q', data, from: {}, message: { message_id: 1, chat: { id: 2000 }, text: 'x' } } } }), fakeRes());

  await say('2000', 'subscribe ada@example.com');
  const choice = net.sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.callback_data).filter(d => !d.startsWith('nav:'));
  assert.deepEqual(choice, ['subscribe via flutterwave', 'subscribe via paystack']);
  await tap('subscribe via flutterwave');
  assert.match(net.sent.at(-1).reply_markup.inline_keyboard[0][0].url, /checkout\.flutterwave\.com/);
  const [created] = fw.created;
  assert.equal(created.amount, 5000, 'Flutterwave takes naira, not kobo');
  assert.equal(created.customer.email, 'ada@example.com', 'saved email reused');
  const ref = created.tx_ref;
  assert.match(ref, /^cbf_2000_/);

  // A forged webhook (wrong hash) is ignored
  const bad = fakeRes();
  await require('../api/app')(fakeReq({ method: 'POST', query: { action: 'flutterwave-webhook' }, body: { event: 'charge.completed', data: { tx_ref: ref } }, headers: { 'verif-hash': 'nope' } }), bad);
  assert.equal(await subs.hasAccess('2000'), false);

  // Unpaid → not credited; paid → back via /paid with ?tx_ref=
  assert.equal((await subs.confirmPayment(ref)).credited, false);
  fw.pay(ref);
  const res = fakeRes();
  await require('../api/app')(fakeReq({ query: { action: 'paystack-callback', status: 'successful', tx_ref: ref, transaction_id: '123' } }), res);
  assert.equal(res.statusCode, 302);
  assert.equal(await subs.hasAccess('2000'), true);
  const until = (await subs.getSub('2000')).paidUntil;

  // Webhook for the same payment (correct hash) → no double credit
  const ok = fakeRes();
  await require('../api/app')(fakeReq({ method: 'POST', query: { action: 'flutterwave-webhook' }, body: { event: 'charge.completed', data: { tx_ref: ref } }, headers: { 'verif-hash': 'myhash' } }), ok);
  assert.equal(ok.statusCode, 200);
  assert.equal((await subs.getSub('2000')).paidUntil, until);

  // Wrong amount on a new payment → refused
  await tap('subscribe via flutterwave');
  const ref2 = fw.created.at(-1).tx_ref;
  fw.tx.get(ref2).amount = 50; fw.pay(ref2);
  assert.match((await subs.confirmPayment(ref2)).reason, /expected NGN 5000/);
});

test('only Flutterwave set up → no choice, straight to the Flutterwave link', async () => {
  resetEnv({ PAID_ACCESS_ENABLED: 'true', FLW_SECRET_KEY: 'FLWSECK_TEST-x' });
  delete process.env.PAYSTACK_SECRET_KEY;
  const net = mockNet({ price: 100 });
  fakePaystack();
  fakeFlutterwave();
  await approvedUser();
  await say('2000', 'subscribe ada@example.com');
  assert.match(net.sent.at(-1).reply_markup.inline_keyboard[0][0].url, /checkout\.flutterwave\.com/);
  assert.match(net.sent.at(-1).text, /Flutterwave/);
});
