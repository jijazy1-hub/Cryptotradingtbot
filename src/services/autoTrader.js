/**
 * ─── Automated exits (opt-in, Binance spot) ───────────────────────────────────
 * Carries out the SELL side of each position's locked plan on the user's own
 * Binance account. This module itself never buys or opens a position; buying
 * is done by autoBuyer.js (⚡ Buy Now and daily auto-buy), which then hands the
 * position to this module to manage the exits.
 *
 *   Protect   a real STOP_LOSS_LIMIT order sits on Binance at the saved stop,
 *             so the stop works even between bot checks
 *   TP1       sell 40% of the original quantity, stop → breakeven
 *   TP2       sell 35%, stop → TP1
 *   TP3       sell the rest
 *   Target    (your own 2x / 25% target) sell 60% of what's left, stop → entry
 *   Stop hit  if the exchange stop didn't fill (price gapped below its limit),
 *             sell the rest at market
 *   Removed   (`sell SOL`, dashboard Remove, `sold …`) cancel the stop order,
 *             sell nothing — you said you already sold
 *
 * The monitors decide WHEN (they set tp1Hit, stopLossHit, … and move the stop);
 * this module only makes Binance match the position. Each call is idempotent:
 * it reads the position, works out what is still missing, and does that.
 *
 * Eligible positions: exchange = Binance (or auto), quantity set, and the
 * owner has auto-exits ON (`autotrade on`). State lives on the position in the
 * `auto` field; open stop orders are also indexed in cryptobot:autoorders:{chatId}
 * so an order whose position disappeared is always cancelled.
 */

const store = require('../lib/redis');
const ps = require('./positionStore');
const profit = require('./profitTracker');
const accounts = require('./tradingAccounts');
const tg = require('../lib/telegram');
const { fetchPrice } = require('../lib/market');
const { floorToStep, toFixedStep, isDryRun } = require('../lib/binanceTrade');

const ordersKey = (chatId) => `cryptobot:autoorders:${chatId}`;
const lockKey = (chatId, id) => `cryptobot:lock:auto:${chatId}:${id}`;
const DEAD = ['CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'];
const SPLITS = { tp1: 0.40, tp2: 0.35 };
const TARGET_SELL = 0.60;

const limitGap = () => {
  const g = Number(process.env.AUTOTRADE_STOP_LIMIT_GAP_PCT);
  return Number.isFinite(g) && g > 0 && g < 20 ? g / 100 : 0.01;
};
const coinOf = (sym) => sym.replace(/USDT$/, '');
const r8 = (x) => Math.round(x * 1e8) / 1e8;
const money = (p) => (p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const clientId = (key) => `cb-${key}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function eligible(pos) {
  return !!pos && Number(pos.quantity) > 0 && (!pos.exchange || pos.exchange === 'binance');
}

/** Is auto-exit on for this user? (cheap: one Redis read) */
async function isOn(chatId) {
  return !!(await accounts.getActiveClient(chatId).catch(() => null));
}

function avgFill(order, fallback) {
  const q = Number(order.executedQty);
  const quote = Number(order.cummulativeQuoteQty);
  return q > 0 && quote > 0 ? quote / q : fallback;
}

/**
 * Make Binance match the position's plan. Sends its own Telegram messages.
 * @returns {Promise<null|{actions: string[], closed?: boolean, error?: string}>}
 *          null when auto-exits don't apply to this position
 */
async function sync(chatId, positionId, { price = null } = {}) {
  const c = await accounts.getActiveClient(chatId).catch(() => null);
  if (!c) return null;
  const first = await ps.getPositionById(chatId, positionId);
  if (!eligible(first)) return null;
  if (!(await store.lock(lockKey(chatId, positionId), 60).catch(() => true))) return { actions: [], skipped: 'busy' };

  const msgs = [];
  const actions = [];
  let pos = first;
  let a;
  try {
    pos = (await ps.getPositionById(chatId, positionId)) || pos; // fresh, inside the lock
    a = { remainingQty: Number(pos.quantity), done: {}, sold: [], ...(pos.auto || {}) };
    a.done = { ...(a.done || {}) };
    a.sold = [...(a.sold || [])];
    const sym = pos.symbol;
    const coin = coinOf(sym);
    const tag = c.testnet ? ' (testnet)' : '';
    const dry = isDryRun() ? ' [dry run]' : '';

    const rules = await c.symbolRules(sym);
    if (rules.status && rules.status !== 'TRADING') throw new Error(`${sym} isn't trading on Binance${tag} right now`);
    const px = price || (await fetchPrice(sym, { exchange: 'binance' }));
    if (!px) throw new Error('no Binance price right now');
    const tooSmall = (q, p = px) => q < rules.minQty || q * p < rules.minNotional;

    const noteFill = (order, reason, fallbackPrice) => {
      const qty = Number(order.executedQty) || 0;
      if (qty <= 0) return 0;
      const at = avgFill(order, fallbackPrice);
      a.sold.push({ qty: r8(qty), price: at, reason, orderId: String(order.orderId), at_: new Date().toISOString() });
      a.remainingQty = r8(Math.max(0, a.remainingQty - qty));
      return qty;
    };

    const cancelStop = async () => {
      if (!a.stopOrderId) return;
      let res;
      try {
        res = await c.cancel(sym, a.stopOrderId);
      } catch (err) {
        // Already gone (filled/cancelled) → check what happened to it
        res = await c.getOrder(sym, a.stopOrderId);
        if (!DEAD.includes(res.status) && res.status !== 'FILLED') throw err;
      }
      const q = noteFill(res, 'stop', a.stopPrice);
      if (q) msgs.push(`🤖 Your Binance stop had sold ${r8(q)} ${coin} before it was replaced.`);
      a.stopOrderId = null;
      await store.cmd('HDEL', ordersKey(chatId), positionId);
      actions.push('cancel-stop');
    };

    // 1) What happened to the stop order on Binance since last time?
    if (a.stopOrderId) {
      const o = await c.getOrder(sym, a.stopOrderId);
      if (o.status === 'FILLED') {
        const q = noteFill(o, 'stop', a.stopPrice);
        msgs.push(`💰 REAL · 🤖 *Auto-exit${dry}:* your Binance stop filled — sold ${r8(q)} ${coin} at ~$${money(avgFill(o, a.stopPrice))}${tag}`);
        a.stopOrderId = null;
        await store.cmd('HDEL', ordersKey(chatId), positionId);
        actions.push('stop-filled');
      } else if (DEAD.includes(o.status)) {
        noteFill(o, 'stop', a.stopPrice);
        a.stopOrderId = null;
        await store.cmd('HDEL', ordersKey(chatId), positionId);
        a.stopRestarts = (a.stopRestarts || 0) + 1;
        if (a.stopRestarts > 1) {
          a.paused = true;
          msgs.push(`⚠️ Your ${coin} stop order was ${o.status.toLowerCase()} on Binance again (not by the bot). Auto-exits for this position are *paused* — you're managing it yourself now. Send \`autotrade resume ${coin}\` to hand it back.`);
        } else {
          msgs.push(`⚠️ Your ${coin} stop order was ${o.status.toLowerCase()} on Binance (not by the bot) — placing it again.`);
        }
        actions.push('stop-dead');
      }
    }

    // 2) Sales the plan calls for
    const original = Number(pos.quantity);
    const wants = [];
    if (!pos.stopLossHit) a.done.stop = false; // stop was reset (setstop) → can fire again
    if (!a.paused && a.remainingQty > 0) {
      if (pos.stopLossHit) {
        if (!a.done.stop) wants.push({ key: 'stop', qty: a.remainingQty, label: 'stop hit — sold the rest' });
      } else {
        if (pos.targetHit && !a.done.target) wants.push({ key: 'target', qty: a.remainingQty * TARGET_SELL, label: 'your target — sold 60%' });
        if (pos.tp1Hit && !a.done.tp1) wants.push({ key: 'tp1', qty: original * SPLITS.tp1, label: 'TP1 — 40%' });
        if (pos.tp2Hit && !a.done.tp2) wants.push({ key: 'tp2', qty: original * SPLITS.tp2, label: 'TP2 — 35%' });
        if (pos.tp3Hit && !a.done.tp3) wants.push({ key: 'tp3', qty: a.remainingQty, label: 'TP3 — the rest' });
      }
    }
    if (wants.length) {
      const want = Math.min(a.remainingQty, wants.reduce((s, w) => s + w.qty, 0));
      await cancelStop(); // frees the coins the stop order was holding
      const free = await c.freeBalance(rules.baseAsset);
      if (free < a.remainingQty) a.remainingQty = r8(free); // you moved or sold some yourself
      let qty = floorToStep(Math.min(want, a.remainingQty), rules.stepSize);
      const left = a.remainingQty - qty;
      if (left > 0 && tooSmall(left)) qty = floorToStep(a.remainingQty, rules.stepSize); // don't leave unsellable dust
      const label = wants.map(w => w.label).join(' + ');
      if (qty <= 0 || tooSmall(qty)) {
        msgs.push(free <= 0
          ? `⚠️ Auto-exit: no free ${coin} on your Binance${tag} account, so nothing was sold (${label}).`
          : `⚠️ Auto-exit: ${r8(qty)} ${coin} is below Binance's minimum order size, so nothing was sold (${label}).`);
        if (free <= 0) a.remainingQty = 0;
      } else {
        const o = await c.marketSell(sym, toFixedStep(qty, rules.stepSize), clientId(wants[0].key));
        const q = noteFill(o, wants[0].key, px) || 0;
        msgs.push(`💰 REAL · 🤖 *Auto-exit${dry}:* sold ${r8(q)} ${coin} at ~$${money(avgFill(o, px))}${tag} (${label}).`);
        actions.push(`sell:${wants.map(w => w.key).join('+')}`);
      }
      for (const w of wants) a.done[w.key] = true;
    }

    // 3) Everything sold? Record the trade and close the position.
    const anySold = a.sold.length > 0;
    if (anySold && (a.remainingQty <= 0 || tooSmall(a.remainingQty))) {
      await cancelStop();
      const total = a.sold.reduce((s, x) => s + x.qty, 0);
      const avg = a.sold.reduce((s, x) => s + x.qty * x.price, 0) / total;
      const trade = await profit.recordTrade({ chatId, symbol: sym, buyPrice: pos.buyPrice, sellPrice: avg, quantity: total, targetMultiple: pos.targetMultiple });
      await store.cmd('HDEL', ordersKey(chatId), positionId);
      await ps.removePositionById(chatId, positionId);
      msgs.push([
        `💰 REAL · ✅ *${sym} closed automatically${dry}*`,
        `Sold ${r8(total)} ${coin} at an average of $${money(avg)}${tag}`,
        `Result: ${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct}%${trade.pnlDollar !== null ? ` ($${trade.pnlDollar.toFixed(2)})` : ''} — saved to your history.`,
        a.remainingQty > 0 ? `_${r8(a.remainingQty)} ${coin} left over is below Binance's minimum order and stays in your wallet._` : '',
        profit.todayLine(await profit.getAllTrades(chatId)),
      ].filter(Boolean).join('\n'));
      actions.push('closed');
      await sendAll(chatId, msgs);
      return { actions, closed: true };
    }

    // 4) Keep a real stop order on Binance at the saved stop
    if (!a.paused && a.remainingQty > 0 && pos.stopLossPrice && !pos.stopLossHit) {
      const stop = floorToStep(Number(pos.stopLossPrice), rules.tickSize);
      const moved = a.stopOrderId && Math.abs(Number(a.stopPrice) - stop) >= rules.tickSize / 2;
      if (moved) await cancelStop();
      if (!a.stopOrderId && stop < px) {
        const free = await c.freeBalance(rules.baseAsset);
        const qty = floorToStep(Math.min(a.remainingQty, free), rules.stepSize);
        if (qty <= 0) {
          if (a.lastError !== 'no-balance') msgs.push(`⚠️ Auto-exit: you have no free ${coin} on your Binance${tag} account, so no stop order was placed. Buy it there first, or turn auto-exits off.`);
          a.lastError = 'no-balance';
        } else if (tooSmall(qty, stop)) {
          if (a.lastError !== 'too-small') msgs.push(`⚠️ Auto-exit: ${r8(qty)} ${coin} is below Binance's minimum order, so no stop order was placed.`);
          a.lastError = 'too-small';
        } else {
          const limit = floorToStep(stop * (1 - limitGap()), rules.tickSize);
          const o = await c.stopLossSell(sym, toFixedStep(qty, rules.stepSize), toFixedStep(stop, rules.tickSize), toFixedStep(limit, rules.tickSize), clientId('sl'));
          a.stopOrderId = String(o.orderId);
          a.stopPrice = stop;
          a.stopQty = qty;
          a.lastError = null;
          await store.cmd('HSET', ordersKey(chatId), positionId, JSON.stringify({ symbol: sym, orderId: a.stopOrderId }));
          msgs.push(`💰 REAL · 🤖 *${moved ? 'Stop moved' : 'Stop placed'} on Binance${dry}:* sell ${qty} ${coin} if price falls to $${money(stop)}${tag}.`);
          actions.push(moved ? 'move-stop' : 'place-stop');
        }
      }
    }

    a.lastSync = new Date().toISOString();
    if (a.lastError && !['no-balance', 'too-small'].includes(a.lastError)) a.lastError = null;
    await ps.updatePosition(chatId, positionId, { auto: a });
    await sendAll(chatId, msgs);
    return { actions };
  } catch (err) {
    const why = String(err.message || err);
    console.error(`[AutoTrader] ${chatId}/${positionId}:`, why);
    await accounts.recordError(chatId, `${pos.symbol}: ${why}`);
    if (a) {
      const repeat = a.lastError === why;
      a.lastError = why;
      await ps.updatePosition(chatId, positionId, { auto: a }).catch(() => {});
      if (!repeat) msgs.push(`⚠️ *Auto-exit problem — ${pos.symbol}:* ${why}\nThe bot will retry on its next check. Your alerts still work as normal.`);
    }
    await sendAll(chatId, msgs);
    return { actions, error: why };
  } finally {
    await store.cmd('DEL', lockKey(chatId, positionId)).catch(() => {});
  }
}

/**
 * Sell a whole position right now at market and close it (used by the daily close).
 * Cancels the stop order first (it holds the coins), sells what is free, records
 * the trade, removes the position. If anything fails after the stop was cancelled,
 * the stop order is put back so the position is never left unprotected.
 * @returns {Promise<{closed: true, trade, avg: number, qty: number}|{closed: false, error: string}>}
 */
async function closeNow(chatId, positionId) {
  const c = await accounts.getActiveClient(chatId).catch(() => null);
  if (!c) return { closed: false, error: 'auto-trading is off' };
  const first = await ps.getPositionById(chatId, positionId);
  if (!eligible(first)) return { closed: false, error: 'position not found' };
  if (!(await store.lock(lockKey(chatId, positionId), 60).catch(() => true))) return { closed: false, error: 'busy right now' };

  let cancelled = false;
  try {
    const pos = (await ps.getPositionById(chatId, positionId)) || first;
    const sym = pos.symbol;
    const a = { remainingQty: Number(pos.quantity), done: {}, sold: [], ...(pos.auto || {}) };
    a.sold = [...(a.sold || [])];
    const rules = await c.symbolRules(sym);
    const px = await fetchPrice(sym, { exchange: 'binance' });
    if (!px) throw new Error('no Binance price right now');
    const note = (order, reason, fallback) => {
      const q = Number(order.executedQty) || 0;
      if (q <= 0) return 0;
      a.sold.push({ qty: r8(q), price: avgFill(order, fallback), reason, orderId: String(order.orderId), at_: new Date().toISOString() });
      a.remainingQty = r8(Math.max(0, a.remainingQty - q));
      return q;
    };

    // 1) Free the coins held by the stop order (it may already have filled)
    if (a.stopOrderId) {
      let res;
      try { res = await c.cancel(sym, a.stopOrderId); } catch (err) {
        res = await c.getOrder(sym, a.stopOrderId);
        if (!DEAD.includes(res.status) && res.status !== 'FILLED') throw err;
      }
      note(res, 'stop', a.stopPrice);
      a.stopOrderId = null;
      cancelled = true;
      await store.cmd('HDEL', ordersKey(chatId), positionId);
      await ps.updatePosition(chatId, positionId, { auto: a });
    }

    // 2) Sell what is left
    if (a.remainingQty > 0) {
      const free = await c.freeBalance(rules.baseAsset);
      if (free < a.remainingQty) a.remainingQty = r8(free); // you moved or sold some yourself
      const qty = floorToStep(a.remainingQty, rules.stepSize);
      if (qty > 0 && qty >= rules.minQty && qty * px >= rules.minNotional) {
        const o = await c.marketSell(sym, toFixedStep(qty, rules.stepSize), clientId('dc'));
        if (!note(o, 'daily', px)) throw new Error('the sell order did not fill');
      }
    }

    // 3) Record and remove
    if (!a.sold.length) {
      if (a.remainingQty > 0) throw new Error(`${r8(a.remainingQty)} ${coinOf(sym)} is below Binance's minimum order size`);
      await ps.removePositionById(chatId, positionId); // nothing left in the wallet (sold or moved by the user)
      return { closed: false, error: `no ${coinOf(sym)} left on your Binance account — position removed` };
    }
    const total = a.sold.reduce((t, x) => t + x.qty, 0);
    const avg = a.sold.reduce((t, x) => t + x.qty * x.price, 0) / total;
    const trade = await profit.recordTrade({ chatId, symbol: sym, buyPrice: pos.buyPrice, sellPrice: avg, quantity: total, targetMultiple: pos.targetMultiple });
    await store.cmd('HDEL', ordersKey(chatId), positionId);
    await ps.removePositionById(chatId, positionId);
    return { closed: true, trade, avg, qty: total };
  } catch (err) {
    const why = String(err.message || err);
    console.error(`[AutoTrader] closeNow ${chatId}/${positionId}:`, why);
    await accounts.recordError(chatId, `${first.symbol}: daily close — ${why}`).catch(() => {});
    if (cancelled) await sync(chatId, positionId).catch(() => {}); // put the protective stop back
    return { closed: false, error: why };
  } finally {
    await store.cmd('DEL', lockKey(chatId, positionId)).catch(() => {});
  }
}

async function sendAll(chatId, msgs) {
  for (const m of msgs) await tg.send(chatId, m).catch(() => {});
}

/**
 * The position is gone (you sold yourself / removed it): cancel its stop order.
 * Called automatically by positionStore on every removal.
 */
async function release(chatId, positionId, { quiet = false } = {}) {
  const raw = await store.cmd('HGET', ordersKey(chatId), positionId).catch(() => null);
  if (!raw) return false;
  let info;
  try { info = JSON.parse(raw); } catch { info = null; }
  if (info?.orderId) {
    const c = await accounts.getAnyClient(chatId).catch(() => null);
    if (c) {
      try {
        await c.cancel(info.symbol, info.orderId);
      } catch (err) {
        const o = await c.getOrder(info.symbol, info.orderId).catch(() => null);
        if (!o || (!DEAD.includes(o.status) && o.status !== 'FILLED')) throw err; // keep it indexed; the monitor retries
      }
      if (!quiet) await tg.send(chatId, `🤖 Cancelled your Binance stop order for ${coinOf(info.symbol)} (position removed). Nothing was sold.`).catch(() => {});
    }
  }
  await store.cmd('HDEL', ordersKey(chatId), positionId);
  return true;
}

/** Cancel stop orders whose position no longer exists (backup for failed releases). */
async function sweepOrphans(chatId, openIds) {
  const idx = store.hashToObject(await store.cmd('HGETALL', ordersKey(chatId)).catch(() => []));
  const open = new Set(openIds);
  let n = 0;
  for (const id of Object.keys(idx)) {
    if (open.has(id)) continue;
    try { if (await release(chatId, id)) n++; } catch (err) { console.error('[AutoTrader] sweep:', err.message); }
  }
  return n;
}

/** Cancel every stop order the bot placed for this user (on `autotrade off` / disconnect). */
async function cancelAll(chatId) {
  const idx = store.hashToObject(await store.cmd('HGETALL', ordersKey(chatId)).catch(() => []));
  let n = 0;
  for (const id of Object.keys(idx)) {
    try {
      if (await release(chatId, id, { quiet: true })) n++;
      const pos = await ps.getPositionById(chatId, id);
      if (pos?.auto) await ps.updatePosition(chatId, id, { auto: { ...pos.auto, stopOrderId: null } });
    } catch (err) { console.error('[AutoTrader] cancelAll:', err.message); }
  }
  return n;
}

/** Re-enable a position paused after its stop was cancelled outside the bot. */
async function resume(chatId, positionId) {
  const pos = await ps.getPositionById(chatId, positionId);
  if (!pos) return null;
  await ps.updatePosition(chatId, positionId, { auto: { ...(pos.auto || {}), paused: false, stopRestarts: 0 } });
  return sync(chatId, positionId);
}

/** Sync every eligible position of one user (after turning auto-exits on). */
async function syncUser(chatId) {
  const out = [];
  for (const pos of Object.values(await ps.getAllPositions(chatId))) {
    if (eligible(pos)) out.push({ positionId: pos.positionId, ...((await sync(chatId, pos.positionId)) || {}) });
  }
  return out;
}

/** Short status for the dashboard / `positions`. */
function describeAuto(pos) {
  const a = pos.auto;
  if (!a) return null;
  return {
    remainingQty: a.remainingQty ?? null,
    stopOrder: a.stopOrderId ? { price: a.stopPrice, qty: a.stopQty } : null,
    sold: (a.sold || []).map(s => ({ qty: s.qty, price: s.price, reason: s.reason })),
    paused: !!a.paused,
    lastError: a.lastError || null,
    lastSync: a.lastSync || null,
  };
}

// Every removal (bot, dashboard, monitor) cancels the matching stop order
ps.onRemove((chatId, positionId) => release(chatId, positionId).catch(err => console.error('[AutoTrader] release:', err.message)));

module.exports = { sync, closeNow, release, sweepOrphans, cancelAll, resume, syncUser, isOn, eligible, describeAuto };
