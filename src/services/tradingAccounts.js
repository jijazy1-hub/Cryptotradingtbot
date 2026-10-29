/**
 * ─── Exchange accounts for automated exits ───────────────────────────────────
 * cryptobot:trading:{chatId}  HASH
 *   apiKey, apiSecret  — AES-256-GCM encrypted (src/lib/secretBox.js)
 *   testnet            — '1' fake-money testnet, '0' real money
 *   enabled            — '1' auto-exits on, '0' off (always off after connecting)
 *   keyHint, connectedAt, lastError
 *
 * Safety checks when connecting (live keys):
 *  - the key must be able to trade spot
 *  - the key must NOT be able to withdraw — refused otherwise
 */

const store = require('../lib/redis');
const box = require('../lib/secretBox');
const { client, BinanceError } = require('../lib/binanceTrade');

const keyOf = (chatId) => `cryptobot:trading:${chatId}`;
const LIVE_CONFIRM = 'I UNDERSTAND REAL MONEY';

class TradingError extends Error {}

async function readRaw(chatId) {
  return store.hashToObject(await store.cmd('HGETALL', keyOf(chatId)));
}

async function getStatus(chatId) {
  const r = await readRaw(chatId);
  return {
    encryptionReady: box.isConfigured(),
    connected: !!r.apiKey,
    exchange: r.apiKey ? 'Binance' : null,
    testnet: r.testnet !== '0',
    enabled: r.enabled === '1',
    keyHint: r.keyHint || null,
    connectedAt: r.connectedAt || null,
    lastError: r.lastError || null,
    dryRun: String(process.env.AUTOTRADE_DRY_RUN || '').toLowerCase() === 'true',
  };
}

/**
 * Verify and save Binance API keys. Auto-exits stay OFF until enabled.
 * Real-money keys can be saved; turning them ON needs the confirmation phrase.
 * @param {{apiKey: string, apiSecret: string, live?: boolean}} input
 */
async function connect(chatId, { apiKey, apiSecret, live = false }) {
  if (!box.isConfigured()) throw new TradingError('Automated exits are not set up on this bot yet (admin: set TRADING_ENCRYPTION_KEY).');
  apiKey = String(apiKey || '').trim();
  apiSecret = String(apiSecret || '').trim();
  if (!/^[A-Za-z0-9]{32,128}$/.test(apiKey) || !/^[A-Za-z0-9]{32,128}$/.test(apiSecret)) {
    throw new TradingError('That doesn\'t look like a Binance API key and secret (letters and numbers, usually 64 characters each).');
  }
  const c = client({ apiKey, apiSecret, testnet: !live });
  let account;
  try {
    account = await c.account();
  } catch (err) {
    const why = err instanceof BinanceError && err.code === -2015
      ? `Binance rejected the key. ${live ? 'Use keys from binance.com' : 'Test mode needs keys from testnet.binance.vision'}, and check the key has "Enable Spot & Margin Trading".`
      : `Binance error: ${err.message}`;
    throw new TradingError(why);
  }
  if (account.canTrade === false) throw new TradingError('This key can\'t trade. Enable "Spot & Margin Trading" for it on Binance.');

  // Behind the fixed-IP proxy, requests leave from either of its IPs at random.
  // Repeat the check a few times so a key missing one IP is caught now, not mid-trade.
  if (live && require('../lib/binanceTrade').proxyConfig()) {
    for (let k = 0; k < 5; k++) {
      try { await c.account(); } catch (err) {
        if (err instanceof BinanceError && err.code === -2015) {
          throw new TradingError('Your key works from one of the bot\'s IP addresses but not the other. On Binance, edit the key and make sure ALL the bot\'s IPs are in the list (add them one at a time), then try again.');
        }
        throw new TradingError(`Binance error: ${err.message}`);
      }
    }
  }

  if (live) {
    const r = await c.apiRestrictions().catch(err => { throw new TradingError(`Couldn't read the key's permissions: ${err.message}`); });
    if (r?.enableWithdrawals) throw new TradingError('Refused: this key can WITHDRAW funds. Create a key with withdrawals disabled — the bot never needs them.');
    if (r && r.enableSpotAndMarginTrading === false) throw new TradingError('This key can\'t trade spot. Enable "Spot & Margin Trading".');
  }

  await store.cmd('HSET', keyOf(chatId),
    'apiKey', box.encrypt(apiKey),
    'apiSecret', box.encrypt(apiSecret),
    'testnet', live ? '0' : '1',
    'enabled', '0',
    'keyHint', `…${apiKey.slice(-4)}`,
    'connectedAt', new Date().toISOString(),
    'lastError', '');
  return getStatus(chatId);
}

async function setEnabled(chatId, enabled, { confirmLive = '' } = {}) {
  const s = await getStatus(chatId);
  if (!s.connected) throw new TradingError('Connect your Binance API key first.');
  if (enabled && !s.testnet && String(confirmLive).trim().toUpperCase() !== LIVE_CONFIRM) {
    throw new TradingError(`Turning on real-money auto-exits needs the confirmation phrase: ${LIVE_CONFIRM}`);
  }
  await store.cmd('HSET', keyOf(chatId), 'enabled', enabled ? '1' : '0');
  return getStatus(chatId);
}

async function recordError(chatId, message) {
  await store.cmd('HSET', keyOf(chatId), 'lastError', `${new Date().toISOString()} ${String(message).slice(0, 300)}`).catch(() => {});
}

/** Trading client for a user with auto-exits ON, else null. */
async function getActiveClient(chatId) {
  const r = await readRaw(chatId);
  if (!r.apiKey || r.enabled !== '1' || !box.isConfigured()) return null;
  return client({ apiKey: box.decrypt(r.apiKey), apiSecret: box.decrypt(r.apiSecret), testnet: r.testnet !== '0' });
}

/** Client even when auto-exits are off (used to cancel orders on disconnect). */
async function getAnyClient(chatId) {
  const r = await readRaw(chatId);
  if (!r.apiKey || !box.isConfigured()) return null;
  return client({ apiKey: box.decrypt(r.apiKey), apiSecret: box.decrypt(r.apiSecret), testnet: r.testnet !== '0' });
}

async function removeKeys(chatId) {
  await store.cmd('DEL', keyOf(chatId));
}

const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI']);

/**
 * The user's Spot wallet on Binance: every coin worth $1+, valued in USD.
 * `locked` = coins held by open orders (e.g. the bot's stop orders).
 */
async function getBalances(chatId) {
  const c = await getAnyClient(chatId);
  if (!c) throw new TradingError('Connect your Binance account first: `golive`.');
  let account;
  try { account = await c.account(); } catch (err) {
    throw new TradingError(err instanceof BinanceError && err.code === -2015
      ? 'Binance refused the request. Check your key still has all the bot\'s IPs, or reconnect with `golive`.'
      : `Binance error: ${err.message}`);
  }
  const { fetchPrice } = require('../lib/market');
  const rows = [];
  for (const b of account.balances || []) {
    const free = Number(b.free) || 0, locked = Number(b.locked) || 0;
    if (!(free + locked > 0)) continue;
    const px = STABLE.has(b.asset) ? 1 : await fetchPrice(`${b.asset}USDT`, { exchange: 'binance' }).catch(() => null);
    rows.push({ asset: b.asset, free, locked, price: px, usd: px ? Math.round((free + locked) * px * 100) / 100 : null });
  }
  const shown = rows.filter(r => r.usd === null || r.usd >= 1).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  return {
    testnet: c.testnet,
    assets: shown,
    totalUsd: Math.round(rows.reduce((t, r) => t + (r.usd || 0), 0) * 100) / 100,
    usdtFree: rows.find(r => r.asset === 'USDT')?.free || 0,
    hiddenDust: rows.length - shown.length,
    at: new Date().toISOString(),
  };
}

module.exports = { getBalances, TradingError, LIVE_CONFIRM, getStatus, connect, setEnabled, getActiveClient, getAnyClient, removeKeys, recordError };
