/**
 * ─── Practice mode (play money, real Binance prices) ─────────────────────────
 * Every user can practise with a virtual $10,000 — no exchange account, no keys.
 * It runs the SAME exit plan as live automated exits, priced as honestly as a
 * real Binance account would be:
 *
 *   Buy        live Binance price + 0.05% slippage, 0.1% Binance fee
 *   Stop       acts like a real stop order: triggers if ANY 1-minute candle since
 *              the last check traded at or below it. Fills at the stop, or at
 *              the candle's open if price gapped below it, minus slippage.
 *   TP1/2/3    checked every 10 minutes at the live price, like live auto-exits:
 *              40% / 35% / the rest, stop → breakeven after TP1, → TP1 after TP2
 *   Target     your own target (2x, 25%…) sells 60% of what's left
 *   Every sale live price − 0.05% slippage, 0.1% fee
 *
 * Storage (separate from real positions and real trade history):
 *   cryptobot:practice:{chatId}        HASH cash, start, createdAt, resets
 *   cryptobot:practicepos:{chatId}     HASH positionId → JSON
 *   cryptobot:practicetrades:{chatId}  LIST of closed practice trades (JSON)
 *   cryptobot:practice:users           SET of chatIds with a practice account
 */

const store = require('../lib/redis');
const { fetchPrice, fetchKlines, normaliseSymbol } = require('../lib/market');
const { fetchCurrentData, buildAdvice, planFromAdvice } = require('./adviceService');
const { stopAfterTakeProfit } = require('./stopPlan');
const profit = require('./profitTracker');

const START = 10_000;
const FEE = 0.001;      // Binance spot taker fee
const SLIP = 0.0005;    // price you lose on a market order
const MIN_ORDER = 5;    // same as Binance's Spot minimum, so practice matches real trading
const acctKey = (c) => `cryptobot:practice:${c}`;
const posKey = (c) => `cryptobot:practicepos:${c}`;
const tradesKey = (c) => `cryptobot:practicetrades:${c}`;
const USERS = 'cryptobot:practice:users';

class PracticeError extends Error {}

const r2 = (x) => Math.round(x * 100) / 100;
const r8 = (x) => Math.round(x * 1e8) / 1e8;
const coinOf = (s) => s.replace(/USDT$/, '');
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const px = (p) => (p >= 1 ? Number(p).toFixed(4) : Number(p).toPrecision(4));

// ─── Per-user lock (cron and the user can act at the same moment) ───────────
async function withLock(chatId, fn) {
  const key = `cryptobot:lock:practice:${chatId}`;
  for (let i = 0; i < 20; i++) {
    if (await store.lock(key, 30)) {
      try { return await fn(); } finally { await store.cmd('DEL', key).catch(() => {}); }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new PracticeError('Busy updating your practice account — try again in a few seconds.');
}

async function getAccount(chatId, { create = true } = {}) {
  let a = store.hashToObject(await store.cmd('HGETALL', acctKey(chatId)));
  if (!a.cash && create) {
    a = { cash: String(START), start: String(START), createdAt: new Date().toISOString(), resets: '0' };
    await store.pipeline([['HSET', acctKey(chatId), ...Object.entries(a).flat()], ['SADD', USERS, String(chatId)]]);
  }
  if (!a.cash) return null;
  return { cash: Number(a.cash), start: Number(a.start), createdAt: a.createdAt, resets: Number(a.resets || 0) };
}

async function getPositions(chatId) {
  const h = store.hashToObject(await store.cmd('HGETALL', posKey(chatId)));
  return Object.values(h).map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(Boolean).sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
}
const savePos = (chatId, p) => store.cmd('HSET', posKey(chatId), p.id, JSON.stringify(p));
const setCash = (chatId, cash) => store.cmd('HSET', acctKey(chatId), 'cash', String(r8(cash)));

async function getTrades(chatId) {
  const rows = (await store.cmd('LRANGE', tradesKey(chatId), 0, -1)) || [];
  return rows.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

function parseTarget(t) {
  if (t === undefined || t === null || t === '') return null;
  const s = String(t).trim().toLowerCase();
  const m = s.endsWith('%') ? 1 + parseFloat(s) / 100 : parseFloat(s.replace(/x$/, ''));
  if (!(m > 1)) throw new PracticeError('Target must be above the buy price, e.g. 2x or 25%');
  return m;
}

/** Buy `amount` dollars of a coin at the live Binance price. */
async function buy(chatId, { symbol, amount, stop = null, target = null, strategy = null, why = null, manual = false }) {
  const sym = normaliseSymbol(symbol || '');
  if (!/^[A-Z0-9]{2,20}USDT$/.test(sym)) throw new PracticeError('Which coin? e.g. `practice buy SOL 100`');
  const spend = Number(amount);
  if (!(spend >= MIN_ORDER)) throw new PracticeError(`Enter how many dollars to spend (at least $${MIN_ORDER}), e.g. \`practice buy SOL 100\``);
  const targetMultiple = parseTarget(target);

  const live = await fetchPrice(sym, { exchange: 'binance' });
  if (!live) throw new PracticeError(`${coinOf(sym)} isn't on Binance, and practice mode uses Binance prices. Try another coin.`);
  const userStop = stop === null || stop === undefined || stop === '' ? null : Number(stop);
  if (userStop !== null && !(userStop > 0 && userStop < live)) throw new PracticeError(`Your stop must be below the current price ($${px(live)})`);

  // Trade plan first (network), then the money moves inside the lock
  const fill = live * (1 + SLIP);
  let plan = null;
  if (strategy) { /* auto-buy: the strategy's own stop, trailing; no take-profits */ } else try {
    const { candles1h, candles4h } = await fetchCurrentData(sym, { exchange: 'binance' });
    plan = planFromAdvice(buildAdvice({ symbol: sym, buyPrice: fill, currentPrice: live, candles1h, candles4h, lockedPlan: userStop ? { stopLoss: userStop, takeProfits: null } : null }));
  } catch { /* no plan → only your own stop/target apply */ }

  return withLock(chatId, async () => {
    const acct = await getAccount(chatId);
    if (spend > acct.cash + 1e-9) throw new PracticeError(`Not enough practice cash: you have ${usd(acct.cash)}.`);
    const fee = spend * FEE;
    const qty = (spend - fee) / fill;
    const now = new Date().toISOString();
    const p = {
      id: `${sym}:${Date.now()}`, symbol: sym, buyPrice: fill, livePriceAtBuy: live,
      quantity: r8(qty), remainingQty: r8(qty), cost: spend, fees: fee,
      stopLossPrice: plan?.stopLossPrice ?? userStop, takeProfits: plan?.takeProfits || null,
      stopStage: strategy ? 'trail' : userStop ? 'user' : (plan ? 'initial' : null),
      strategy: strategy ? strategy.id : null, auto: !!strategy, highestClose: strategy ? live : null, initialStopPrice: userStop,
      targetMultiple, targetPrice: targetMultiple ? fill * targetMultiple : null,
      tp1Hit: false, tp2Hit: false, tp3Hit: false, targetHit: false,
      sold: [], openedAt: now, lastCheckAt: now,
      ...(why ? { buyReason: why } : {}),
      ...(manual ? { manual: true } : {}), // ⚡ Buy Now: the user's own pick, not closed by the daily close
    };
    await savePos(chatId, p);
    await setCash(chatId, acct.cash - spend);
    return { position: p, cash: acct.cash - spend };
  });
}

/** Sell part of a position at `price`; returns a sale line. Mutates p. */
function sellPart(p, qty, price, reason, { gapFill = false } = {}) {
  qty = Math.min(qty, p.remainingQty);
  if (qty <= 0) return null;
  const at = gapFill ? price : price * (1 - SLIP);
  const gross = qty * at;
  const fee = gross * FEE;
  p.remainingQty = r8(p.remainingQty - qty);
  p.fees += fee;
  p.sold.push({ qty: r8(qty), price: at, proceeds: gross - fee, fee, reason, at_: new Date().toISOString() });
  return { qty, at, net: gross - fee, fee, reason };
}

const LABEL = { stop: 'stop hit', tp1: 'TP1 (40%)', tp2: 'TP2 (35%)', tp3: 'TP3 (the rest)', target: 'your target (60%)', manual: 'you sold' };

/**
 * Decide and apply exits for one position. Pure apart from the inputs:
 * @param p        position (mutated)
 * @param price    live price now
 * @param candles  1-minute candles since the last check (for the stop)
 * @returns sales made
 */
function applyExits(p, price, candles = []) {
  const sales = [];
  // 1) Stop — like a real stop order, it can trigger between checks
  if (p.stopLossPrice) {
    const hit = candles.find(c => c.low <= p.stopLossPrice) || (price <= p.stopLossPrice ? { open: price, low: price } : null);
    if (hit) {
      const fillAt = Math.min(p.stopLossPrice, hit.open) * (1 - SLIP);
      const s = sellPart(p, p.remainingQty, fillAt, 'stop', { gapFill: true });
      if (s) sales.push(s);
      return sales;
    }
  }
  // 2) Your own target
  if (p.targetPrice && !p.targetHit && price >= p.targetPrice) {
    p.targetHit = true;
    const s = sellPart(p, p.remainingQty * 0.6, price, 'target');
    if (s) sales.push(s);
  }
  // 3) Take-profits (jumping straight to TP2/TP3 also does the lower ones)
  const t = p.takeProfits;
  if (t?.tp1?.price && !p.tp1Hit && price >= t.tp1.price) {
    p.tp1Hit = true;
    const s = sellPart(p, p.quantity * 0.40, price, 'tp1'); if (s) sales.push(s);
    Object.assign(p, stopAfterTakeProfit(p, 'TP1', t));
  }
  if (t?.tp2?.price && !p.tp2Hit && price >= t.tp2.price) {
    p.tp2Hit = true;
    const s = sellPart(p, p.quantity * 0.35, price, 'tp2'); if (s) sales.push(s);
    Object.assign(p, stopAfterTakeProfit(p, 'TP2', t));
  }
  if (t?.tp3?.price && !p.tp3Hit && price >= t.tp3.price) {
    p.tp3Hit = true;
    const s = sellPart(p, p.remainingQty, price, 'tp3'); if (s) sales.push(s);
  }
  return sales;
}

/** Close a fully sold position: save the trade and remove it. */
async function closeIfDone(chatId, p, price) {
  if (p.remainingQty * price >= 1) return null; // more than $1 left → still open
  const proceeds = p.sold.reduce((s, x) => s + x.proceeds, 0);
  const sold = p.sold.reduce((s, x) => s + x.qty, 0);
  const pnl = proceeds - p.cost;
  const trade = {
    id: p.id, symbol: p.symbol, buyPrice: p.buyPrice, sellPrice: sold ? p.sold.reduce((s, x) => s + x.qty * x.price, 0) / sold : price,
    quantity: p.quantity, cost: r2(p.cost), proceeds: r2(proceeds), fees: r2(p.fees),
    pnlDollar: r2(pnl), pnlPct: r2((pnl / p.cost) * 100), multiple: r2(proceeds / p.cost),
    outcome: pnl >= 0 ? 'WIN' : 'LOSS', exits: p.sold.map(s => s.reason),
    openedAt: p.openedAt, closedAt: new Date().toISOString(), month: new Date().toISOString().slice(0, 7),
  };
  await store.pipeline([
    ['RPUSH', tradesKey(chatId), JSON.stringify(trade)],
    ['HDEL', posKey(chatId), p.id],
  ]);
  return trade;
}

/**
 * Run exits for every practice position of one user (called every 10 min).
 * @param cache Map symbol → price, shared across users in one run
 * @returns messages to send
 */
async function syncUser(chatId, cache = new Map()) {
  return withLock(chatId, async () => {
    const msgs = [];
    const acct = await getAccount(chatId, { create: false });
    if (!acct) return msgs;
    let cash = acct.cash;
    for (const p of await getPositions(chatId)) {
      if (!cache.has(p.symbol)) cache.set(p.symbol, await fetchPrice(p.symbol, { exchange: 'binance' }).catch(() => null));
      const price = cache.get(p.symbol);
      if (!price) continue;
      // 1-minute candles since the last check, for an honest stop
      let candles = [];
      const since = new Date(p.lastCheckAt || p.openedAt).getTime();
      const mins = Math.min(1000, Math.ceil((Date.now() - since) / 60_000) + 1);
      try { candles = (await fetchKlines(p.symbol, '1m', mins, { startTime: since, exchange: 'binance' })).filter(c => c.time + 60_000 > since); } catch { candles = []; }

      const sales = applyExits(p, price, candles);
      p.lastCheckAt = new Date().toISOString();
      for (const s of sales) {
        cash += s.net;
        msgs.push(`🎮 PRACTICE · *${coinOf(p.symbol)} ${LABEL[s.reason]}:* sold ${r8(s.qty)} at $${px(s.at)} (fee ${usd(s.fee)}) → +${usd(s.net)}`);
      }
      const trade = sales.length ? await closeIfDone(chatId, p, price) : null;
      if (trade) {
        msgs.push(`🎮 PRACTICE · *trade closed — ${coinOf(p.symbol)}:* ${trade.pnlDollar >= 0 ? '+' : ''}${usd(trade.pnlDollar)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct}%) after ${usd(trade.fees)} fees.\n${profit.todayLine(await getTrades(chatId)).replace('Today so far', 'Practice today')}`);
      } else {
        await savePos(chatId, p);
      }
    }
    if (cash !== acct.cash) {
      await setCash(chatId, cash);
      msgs.push(`🎮 Practice cash (play money): ${usd(cash)}`);
    }
    return msgs;
  });
}

/** Trailing stop for an auto-bought practice position (only ever moves up). */
async function raiseStop(chatId, positionId, stop, highestClose) {
  return withLock(chatId, async () => {
    const raw = await store.cmd('HGET', posKey(chatId), positionId);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (highestClose) p.highestClose = Math.max(p.highestClose || 0, highestClose);
    if (Number.isFinite(stop) && stop > (p.stopLossPrice || 0)) p.stopLossPrice = stop;
    await savePos(chatId, p);
    return p;
  });
}

async function allUsers() {
  return (await store.cmd('SMEMBERS', USERS)) || [];
}

/** Sell what's left of a position (or every position of a coin) at the live price. */
async function sellNow(chatId, { positionId = null, symbol = null }) {
  return withLock(chatId, async () => {
    const acct = await getAccount(chatId);
    const sym = symbol ? normaliseSymbol(symbol) : null;
    const targets = (await getPositions(chatId)).filter(p => (positionId ? p.id === positionId : p.symbol === sym));
    if (!targets.length) throw new PracticeError('No matching practice position.');
    let cash = acct.cash;
    const trades = [];
    for (const p of targets) {
      const price = await fetchPrice(p.symbol, { exchange: 'binance' });
      if (!price) throw new PracticeError(`No Binance price for ${coinOf(p.symbol)} right now — try again.`);
      const s = sellPart(p, p.remainingQty, price, 'manual');
      if (s) cash += s.net;
      p.remainingQty = 0;
      trades.push(await closeIfDone(chatId, p, price));
    }
    await setCash(chatId, cash);
    return { trades, cash };
  });
}

async function reset(chatId) {
  return withLock(chatId, async () => {
    const a = await getAccount(chatId);
    await store.pipeline([
      ['DEL', posKey(chatId)], ['DEL', tradesKey(chatId)],
      ['HSET', acctKey(chatId), 'cash', String(START), 'start', String(START), 'createdAt', new Date().toISOString(), 'resets', String(a.resets + 1)],
    ]);
    return getAccount(chatId);
  });
}

/** Everything the bot and dashboard show. */
async function summary(chatId) {
  const acct = await getAccount(chatId);
  const positions = await getPositions(chatId);
  const prices = {};
  for (const s of [...new Set(positions.map(p => p.symbol))]) prices[s] = await fetchPrice(s, { exchange: 'binance' }).catch(() => null);
  const rows = positions.map(p => {
    const price = prices[p.symbol];
    const value = price ? p.remainingQty * price * (1 - SLIP) * (1 - FEE) : null; // what selling now would bring
    const realised = p.sold.reduce((s, x) => s + x.proceeds, 0);
    const pnl = value !== null ? value + realised - p.cost : null;
    return {
      id: p.id, symbol: p.symbol, coin: coinOf(p.symbol), buyPrice: p.buyPrice, currentPrice: price,
      quantity: p.quantity, remainingQty: p.remainingQty, cost: r2(p.cost), value: value === null ? null : r2(value),
      pnlUsd: pnl === null ? null : r2(pnl), pnlPct: pnl === null ? null : r2((pnl / p.cost) * 100),
      stopLossPrice: p.stopLossPrice, stopStage: p.stopStage, takeProfits: p.takeProfits,
      tp1Hit: p.tp1Hit, tp2Hit: p.tp2Hit, tp3Hit: p.tp3Hit, targetPrice: p.targetPrice, targetHit: p.targetHit,
      sold: p.sold.length, openedAt: p.openedAt, auto: !!p.auto, strategy: p.strategy || null,
    };
  });
  const trades = await getTrades(chatId);
  const open = rows.reduce((s, r) => s + (r.value || 0), 0);
  const equity = acct.cash + open;
  const st = profit.calcStats(trades.map(t => ({ ...t, pnlDollar: t.pnlDollar })));
  return {
    cash: r2(acct.cash), start: acct.start, equity: r2(equity),
    returnUsd: r2(equity - acct.start), returnPct: r2(((equity - acct.start) / acct.start) * 100),
    positions: rows, trades: [...trades].reverse().slice(0, 50),
    stats: st ? { trades: st.totalTrades, wins: st.wins, winRate: st.winRate, pnlUsd: r2(st.totalPnlDollar), fees: r2(trades.reduce((s, t) => s + (t.fees || 0), 0)) } : null,
    createdAt: acct.createdAt, rules: { feePct: FEE * 100, slippagePct: SLIP * 100, start: START },
  };
}

module.exports = { PracticeError, START, FEE, SLIP, getAccount, getPositions, getTrades, buy, raiseStop, applyExits, syncUser, allUsers, sellNow, reset, summary };
