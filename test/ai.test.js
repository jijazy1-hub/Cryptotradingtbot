const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { mockNet, fakeReq, fakeRes, resetEnv } = require('./helpers');

const say = (chatId, text) => require('../api/telegram-webhook')(
  fakeReq({ method: 'POST', body: { message: { chat: { id: Number(chatId) }, from: {}, text } } }), fakeRes());

/** Fake AI service: records what was sent, answers with `reply`. */
function fakeAi(reply = 'A stop-loss sells automatically if the price falls to a level you chose.') {
  const calls = [];
  const post = axios.post;
  axios.post = async (url, body, cfg) => {
    if (url.includes('api.openai.com')) { calls.push({ url, body, cfg }); return { data: { choices: [{ message: { content: reply } }] } }; }
    if (url.includes('api.anthropic.com')) { calls.push({ url, body, cfg }); return { data: { content: [{ type: 'text', text: reply }] } }; }
    return post(url, body, cfg);
  };
  return calls;
}

function setup(env = {}) {
  resetEnv({ AUTO_STRATEGY_FILE: path.join(os.tmpdir(), 'no-such-strategy.json'), ...env });
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_PROVIDER', 'AI_MODEL', 'AI_DAILY_LIMIT']) if (!(k in env)) delete process.env[k];
  return mockNet({ price: 100 });
}

test('ask: answers with the user\'s own data and the bot\'s rules; never trades', async () => {
  const net = setup({ OPENAI_API_KEY: 'sk-test' });
  const calls = fakeAi();
  await require('../src/services/savingsPlan').setPlan('1000', { amount: 10 });
  await say(1000, 'ask what is a stop-loss?');
  assert.equal(calls.length, 1);
  const { body, cfg } = calls[0];
  assert.equal(cfg.headers.Authorization, 'Bearer sk-test');
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(body.max_completion_tokens, 400);
  const system = body.messages[0].content;
  assert.match(system, /NEVER tell the user to buy, sell or hold a specific coin/);
  assert.match(system, /NEVER predict prices/);
  assert.match(system, /"savingsPlan":\{"mode":"practice","weeklyUsd":10/, 'the user\'s own data is included');
  assert.equal(body.messages[1].content, 'what is a stop-loss?');
  const msg = net.sent.at(-1);
  assert.match(msg.text, /^💬 A stop-loss sells/);
  assert.match(msg.text, /not financial advice/);
  assert.equal(msg.parse_mode, undefined, 'sent as plain text so AI formatting never breaks');
  // No orders, no positions
  assert.equal(Object.keys(await require('../src/services/positionStore').getAllPositions('1000')).length, 0);
});

test('ask: a question typed without "ask" is answered; a pasted key never goes to the AI', async () => {
  setup({ ANTHROPIC_API_KEY: 'ak-test' });
  const calls = fakeAi('Auto-buy waits for a breakout.');
  await say(1000, 'why has auto-buy not bought anything?');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /anthropic/);
  assert.equal(calls[0].cfg.headers['x-api-key'], 'ak-test');
  assert.match(calls[0].body.system, /USER DATA/);
  await say(1000, 'A'.repeat(64));
  assert.equal(calls.length, 1, 'something that looks like an API key is never sent to the AI');
});

test('ask: daily limit for users; the admin has none', async () => {
  const net = setup({ OPENAI_API_KEY: 'sk-test', AI_DAILY_LIMIT: '2' });
  const calls = fakeAi();
  const users = require('../src/services/userService');
  await users.registerUser({ chatId: '2000', firstName: 'Ada' });
  await users.approveUser('2000');
  await say(2000, 'ask one?');
  await say(2000, 'ask two?');
  await say(2000, 'ask three?');
  assert.equal(calls.length, 2);
  assert.match(net.sent.at(-1).text, /daily limit/);
  for (let i = 0; i < 3; i++) await say(1000, `ask admin ${i}?`);
  assert.equal(calls.length, 5);
});

test('ask: without an AI key, users are told it is off and the admin how to switch it on', async () => {
  const net = setup();
  await say(1000, 'ask');
  assert.match(net.sent.at(-1).text, /OPENAI_API_KEY/);
  await say(1000, 'what is going on with my trades');
  assert.match(net.sent.at(-1).text, /Unknown command/);
});

test('ask: AI errors are explained, not crashed on', async () => {
  const net = setup({ OPENAI_API_KEY: 'sk-bad' });
  const post = axios.post;
  axios.post = async (url, body, cfg) => { if (url.includes('openai')) { const e = new Error('401'); e.response = { status: 401 }; throw e; } return post(url, body, cfg); };
  await say(1000, 'ask hello there?');
  assert.match(net.sent.at(-1).text, /AI key was rejected/);
});

test('ask: GPT-5 models get no temperature and room to think', async () => {
  setup({ OPENAI_API_KEY: 'sk-test', AI_MODEL: 'gpt-5-mini' });
  const calls = fakeAi();
  await say(1000, 'ask what is a stop?');
  assert.equal(calls[0].body.model, 'gpt-5-mini');
  assert.equal(calls[0].body.temperature, undefined);
  assert.equal(calls[0].body.max_completion_tokens, 2000);
});
