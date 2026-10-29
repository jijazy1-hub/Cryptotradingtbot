/**
 * ─── Portfolio actions ────────────────────────────────────────────────────────
 * Everything the personal dashboard can show or do for one user. Shared rules
 * with the Telegram bot: the same position store, the same locked trade plan,
 * the same validation for stops.
 */

const store = require('./positionStore');
const profit = require('./profitTracker');
const { fetchCurrentData, buildAdvice, planFromAdvice } = require('./adviceService');
const { fetchPrice, normaliseSymbol, resolveExchange } = require('../lib/market');
const { PROVIDERS, normaliseExchange } = require('../lib/exchanges');
const { mapLimit } = require('../lib/concurrency');
const autoTrader = require('./autoTrader');
const accounts = require('./tradingAccounts');

class UserError extends Error {}

const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

function describe(pos, price) {
  const buy = Number(pos.buyPrice);
  const qty = pos.quantity ? Number(pos.quantity) : null;
  const tps = pos.takeProfits || null;
  const stop = pos.stopLossPrice ? Number(pos.stopLossPrice) : null;
  const pnlPct = price ? ((price - buy) / buy) * 100 : null;

  let status = 'Open';
  if (pos.stopLossHit) status = 'Stop hit — exit';
  else if (pos.targetHit) status = 'Target hit — sell';
  else if (pos.tp3Hit) status = 'TP3 reached';
  else if (pos.tp2Hit) status = 'TP2 reached';
  else if (pos.tp1Hit) status = 'TP1 reached';

  // Where the price sits between the stop (0) and TP3 (1), for the progress bar
  let progress = null;
  if (price && stop && tps?.tp3?.price && tps.tp3.price > stop) {
    progress = Math.max(0, Math.min(1, (price - stop) / (tps.tp3.price - stop)));
  }

  return {
    positionId: pos.positionId,
    symbol: pos.symbol,
    coin: pos.symbol.replace(/USDT$/, ''),
    exchange: pos.exchange ? (PROVIDERS[pos.exchange]?.name || pos.exchange) : null,
    addedAt: pos.addedAt,
    buyPrice: buy,
    quantity: qty,
    currentPrice: price ?? null,
    pnlPct: round(pnlPct),
    pnlUsd: qty && price ? round((price - buy) * qty) : null,
    invested: qty ? round(buy * qty) : null,
    value: qty && price ? round(price * qty) : null,
    stopLossPrice: stop,
    stopStage: pos.stopStage || (stop ? 'initial' : null),
    stopSource: pos.stopSource || null,
    distToStopPct: price && stop ? round(((price - stop) / price) * 100) : null,
    takeProfits: tps,
    tp1Hit: !!pos.tp1Hit, tp2Hit: !!pos.tp2Hit, tp3Hit: !!pos.tp3Hit,
    targetMultiple: pos.targetMultiple || null,
    targetPrice: pos.targetPrice || null,
    targetHit: !!pos.targetHit,
    stopLossHit: !!pos.stopLossHit,
    progress: progress === null ? null : round(progress, 3),
    status,
    lastRecommendation: pos.lastRecommendation || null,
    lastChecked: pos.lastChecked || null,
    auto: autoTrader.describeAuto(pos),
  };
}

/** Open positions with live prices and totals. */
async function getPortfolio(chatId) {
  const positions = Object.values(await store.getAllPositions(chatId))
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  const keyOf = (p) => `${p.symbol}|${p.exchange || ''}`;
  const keys = [...new Set(positions.map(keyOf))];
  const prices = await mapLimit(keys, 6, (k) => {
    const [s, ex] = k.split('|');
    return fetchPrice(s, { exchange: ex || null }).catch(() => null);
  });
  const priceOf = Object.fromEntries(keys.map((k, i) => [k, prices[i]]));
  const symbols = keys;

  const rows = positions.map(p => describe(p, priceOf[keyOf(p)]));
  const withQty = rows.filter(r => r.invested !== null && r.value !== null);
  const invested = withQty.reduce((s, r) => s + r.invested, 0);
  const value = withQty.reduce((s, r) => s + r.value, 0);

  return {
    positions: rows,
    totals: {
      open: rows.length,
      invested: round(invested),
      value: round(value),
      unrealizedUsd: round(value - invested),
      unrealizedPct: invested > 0 ? round(((value - invested) / invested) * 100) : null,
      withoutQuantity: rows.length - withQty.length,
      needsAction: rows.filter(r => r.stopLossHit || r.targetHit).length,
      pricesMissing: symbols.filter(s => !priceOf[s]).map(k => k.split('|')[0]),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** Closed trades + monthly / all-time stats. */
async function getHistory(chatId) {
  const [trades, stats] = await Promise.all([profit.getAllTrades(chatId), profit.getMonthlyStats(chatId)]);
  return { trades: [...trades].reverse(), stats: { thisMonth: stats.thisMonth, lastMonth: stats.lastMonth, allTime: stats.allTime } };
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/** Add a position, then lock its trade plan (stop + TPs) like the bot's `buy`. */
async function createPosition(chatId, { symbol, buyPrice, quantity, target, stop, exchange, confirm = false }) {
  const sym = normaliseSymbol(symbol || '');
  const buy = num(buyPrice);
  if (!symbol || !/^[A-Z0-9]{2,20}USDT$/.test(sym)) throw new UserError('Enter a coin, e.g. SOL');
  if (!buy || buy <= 0) throw new UserError('Enter your buy price');
  const qty = num(quantity);
  if (quantity !== undefined && quantity !== '' && quantity !== null && !(qty > 0)) throw new UserError('Quantity must be a positive number');

  let targetMultiple = null;
  if (target !== undefined && target !== null && target !== '') {
    const t = String(target).trim().toLowerCase();
    if (t.endsWith('%')) targetMultiple = 1 + num(t) / 100;
    else targetMultiple = num(t.replace(/x$/, ''));
    if (!(targetMultiple > 1)) throw new UserError('Target must be above your buy price, e.g. 2x or 25%');
  }
  const userStop = stop === undefined || stop === null || stop === '' ? null : num(stop);
  if (userStop !== null && !(userStop > 0 && userStop < buy)) throw new UserError('Stop loss must be below your buy price');

  // Which exchange lists this coin? (the one you chose, or auto-detect)
  const wanted = exchange && exchange !== 'auto' ? normaliseExchange(exchange) : null;
  if (exchange && exchange !== 'auto' && !wanted) throw new UserError('Unknown exchange');
  const found = await resolveExchange(sym, wanted);
  if (!found) {
    throw new UserError(wanted
      ? `${sym.replace(/USDT$/, '')}/USDT isn't available on ${PROVIDERS[wanted].name}`
      : `Couldn't find ${sym.replace(/USDT$/, '')}/USDT on Binance, Bybit, OKX, Gate, MEXC, KuCoin or Kraken`);
  }

  if (found.price && !confirm) {
    const ratio = buy / found.price;
    if (ratio > 2 || ratio < 0.5) {
      const e = new UserError(`${sym.replace(/USDT$/, '')} trades at about $${found.price} now, but you entered $${buy} per coin. "Buy price" is what you paid for ONE coin — to spend $${buy} on it, use Buy Now in the bot.`);
      e.code = 'far_price';
      throw e;
    }
  }
  const pos = await store.addPosition({ chatId, symbol: sym, buyPrice: buy, quantity: qty, targetMultiple, stopLossPrice: userStop, exchange: found.exchange });

  try {
    const { candles1h, candles4h, currentPrice } = await fetchCurrentData(sym, { exchange: found.exchange });
    const advice = buildAdvice({
      symbol: sym, buyPrice: buy, currentPrice, candles1h, candles4h,
      lockedPlan: userStop ? { stopLoss: userStop, takeProfits: null } : null,
    });
    const plan = planFromAdvice(advice);
    if (plan) {
      await store.updatePosition(chatId, pos.positionId, {
        ...plan,
        initialStopPrice: plan.stopLossPrice,
        ...(userStop ? { stopSource: 'user', stopStage: 'user' } : { stopSource: 'atr', stopStage: 'initial' }),
      });
      await autoTrader.sync(chatId, pos.positionId).catch(() => null); // stop order on Binance if auto-exits are on
    }
  } catch (err) {
    // Saved anyway; the monitor will lock the plan on its next run
    console.warn('[Portfolio] plan not locked yet:', err.message);
  }
  return store.getPositionById(chatId, pos.positionId);
}

async function requirePosition(chatId, positionId) {
  const pos = positionId ? await store.getPositionById(chatId, positionId) : null;
  if (!pos) throw new UserError('Position not found');
  return pos;
}

async function setStop(chatId, { positionId, price }) {
  const pos = await requirePosition(chatId, positionId);
  const p = num(price);
  if (!(p > 0)) throw new UserError('Enter a stop price');
  const live = await fetchPrice(pos.symbol, { exchange: pos.exchange || null });
  if (live && p >= live) throw new UserError(`A stop must be below the current price ($${live})`);
  const updated = await store.updatePosition(chatId, pos.positionId, { stopLossPrice: p, stopSource: 'user', stopStage: 'user', stopLossHit: false });
  await autoTrader.sync(chatId, pos.positionId).catch(() => null); // moves the Binance stop order
  return (await store.getPositionById(chatId, pos.positionId)) || updated;
}

// ─── Automated exits (settings for the dashboard) ────────────────────────────
function tradingCall(fn) {
  return async (...args) => {
    try { return await fn(...args); } catch (err) {
      if (err instanceof accounts.TradingError) throw new UserError(err.message);
      throw err;
    }
  };
}

const tradingStatus = (chatId) => accounts.getStatus(chatId);
const tradingBalance = tradingCall(async (chatId) => accounts.getBalances(chatId));

const tradingConnect = tradingCall(async (chatId, { apiKey, apiSecret, live }) => accounts.connect(chatId, { apiKey, apiSecret, live: !!live }));

const tradingMode = tradingCall(async (chatId, { enabled, confirm }) => {
  const s = await accounts.setEnabled(chatId, !!enabled, { confirmLive: confirm || '' });
  if (enabled) await autoTrader.syncUser(chatId);
  else await autoTrader.cancelAll(chatId);
  return accounts.getStatus(chatId);
});

const tradingDisconnect = tradingCall(async (chatId) => {
  const cancelled = await autoTrader.cancelAll(chatId);
  await accounts.removeKeys(chatId);
  return { ...(await accounts.getStatus(chatId)), cancelled };
});

async function recordSale(chatId, { positionId, sellPrice, quantity }) {
  const pos = await requirePosition(chatId, positionId);
  const sell = num(sellPrice);
  if (!(sell > 0)) throw new UserError('Enter the price you sold at');
  const qty = num(quantity) || pos.quantity || null;
  const trade = await profit.recordTrade({
    chatId, symbol: pos.symbol, buyPrice: pos.buyPrice, sellPrice: sell, quantity: qty, targetMultiple: pos.targetMultiple,
  });
  await store.removePositionById(chatId, pos.positionId);
  return trade;
}

async function removePosition(chatId, { positionId }) {
  const pos = await requirePosition(chatId, positionId);
  await store.removePositionById(chatId, pos.positionId);
  return { removed: pos.positionId };
}

module.exports = {
  UserError, getPortfolio, getHistory, createPosition, setStop, recordSale, removePosition, describe,
  tradingStatus, tradingBalance, tradingConnect, tradingMode, tradingDisconnect,
};
