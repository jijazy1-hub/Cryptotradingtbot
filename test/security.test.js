const test = require('node:test');
const assert = require('node:assert/strict');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

test('cron endpoints reject calls without the key when CRON_SECRET is set', async () => {
  resetEnv({ CRON_SECRET: 's3cret' });
  const net = mockNet();
  for (const path of ['../api/v2monitor', '../api/v2quickcheck', '../api/v2moonshot', '../api/v2listings-alert']) {
    const res = fakeRes();
    await require(path)(fakeReq(), res);
    assert.equal(res.statusCode, 401, path);
  }
  assert.equal(net.sent.length, 0);
});

test('cron key accepted via ?key= and Authorization header', async () => {
  resetEnv({ CRON_SECRET: 's3cret' });
  mockNet();
  const monitor = require('../api/v2monitor');
  let res = fakeRes();
  await monitor(fakeReq({ query: { key: 's3cret' } }), res);
  assert.equal(res.statusCode, 200);
  res = fakeRes();
  await monitor(fakeReq({ headers: { authorization: 'Bearer s3cret' } }), res);
  assert.equal(res.statusCode, 200);
  res = fakeRes();
  await monitor(fakeReq({ query: { key: 'wrong' } }), res);
  assert.equal(res.statusCode, 401);
});

test('v2scan: public calls get data but send no alerts when CRON_SECRET is set', async () => {
  resetEnv({ CRON_SECRET: 's3cret', BINANCE_SYMBOLS: 'SOLUSDT' });
  const net = mockNet();
  const res = fakeRes();
  await require('../api/v2scan')(fakeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.alertsSent, false);
  assert.equal(res.body.results.length, 1);
  assert.equal(net.sent.length, 0);
});

test('health check requires the key when CRON_SECRET is set', async () => {
  resetEnv({ CRON_SECRET: 'k' });
  mockNet();
  const res = fakeRes();
  await require('../api/health')(fakeReq(), res);
  assert.equal(res.statusCode, 401);
});

test('deployment stays within the Vercel Hobby limit of 12 functions', () => {
  const fs = require('fs');
  const count = fs.readdirSync(require('path').join(__dirname, '..', 'api')).filter(f => f.endsWith('.js')).length;
  assert.ok(count <= 12, `${count} files in api/ — Hobby allows 12`);
});

test('webhook rejects forged updates when TELEGRAM_WEBHOOK_SECRET is set', async () => {
  resetEnv({ TELEGRAM_WEBHOOK_SECRET: 'whsec' });
  const net = mockNet();
  const handler = require('../api/telegram-webhook');
  const update = { message: { chat: { id: 1000 }, from: { first_name: 'Evil' }, text: 'users' } };

  let res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: update }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(net.sent.length, 0);

  res = fakeRes();
  await handler(fakeReq({ method: 'POST', body: update, headers: { 'x-telegram-bot-api-secret-token': 'whsec' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(net.sent.length, 1);
});

test('set-commands registers the webhook with the secret token', async () => {
  resetEnv({ CRON_SECRET: 'k', TELEGRAM_WEBHOOK_SECRET: 'whsec' });
  const calls = [];
  mockNet({ telegram: (method, payload) => { calls.push({ method, payload }); return { status: 200, data: { ok: true, result: true } }; } });
  const res = fakeRes();
  await require('../api/set-commands')(fakeReq({ query: { key: 'k' }, headers: { host: 'bot.example.com' } }), res);
  assert.equal(res.statusCode, 200);
  const wh = calls.find(c => c.method === 'setWebhook');
  assert.equal(wh.payload.url, 'https://bot.example.com/api/telegram-webhook');
  assert.equal(wh.payload.secret_token, 'whsec');
});
