/**
 * ─── Profit Tracker ───────────────────────────────────────────────────────────
 * Every closed trade, per user.
 *
 * STORAGE (v2.5): cryptobot:tradelist:{chatId} — a Redis LIST, one JSON trade
 * per item. Recording a trade is a single atomic append (RPUSH), so two trades
 * recorded at the same moment can't overwrite each other (the old format
 * rewrote one big JSON array).
 * The old cryptobot:trades:{chatId} value is migrated on first use and kept as
 * cryptobot:trades-legacy-backup:{chatId}.
 */

const store = require('../lib/redis');

const listKey = (chatId) => `cryptobot:tradelist:${chatId}`;
const legacyKey = (chatId) => `cryptobot:trades:${chatId}`;
const backupKey = (chatId) => `cryptobot:trades-legacy-backup:${chatId}`;
const checked = new Set();

async function migrateLegacy(chatId) {
  if (checked.has(String(chatId))) return;
  if ((await store.cmd('TYPE', legacyKey(chatId))) !== 'string') { checked.add(String(chatId)); return; }
  if (!(await store.lock(`cryptobot:migrate-lock:trades:${chatId}`, 30))) return;
  try {
    let trades = [];
    try { trades = JSON.parse(await store.cmd('GET', legacyKey(chatId))) || []; } catch { trades = []; }
    if (Array.isArray(trades) && trades.length) {
      // LPUSH in reverse keeps old trades BEFORE any recorded since the upgrade
      await store.cmd('LPUSH', listKey(chatId), ...[...trades].reverse().map(t => JSON.stringify(t)));
    }
    await store.cmd('RENAME', legacyKey(chatId), backupKey(chatId));
    checked.add(String(chatId));
  } finally {
    await store.cmd('DEL', `cryptobot:migrate-lock:trades:${chatId}`);
  }
}

async function getAllTrades(chatId) {
  try {
    await migrateLegacy(chatId);
    const rows = (await store.cmd('LRANGE', listKey(chatId), 0, -1)) || [];
    return rows.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch (err) {
    console.error('[ProfitTracker] read failed:', err.message);
    return [];
  }
}

// ─── Record a closed trade ────────────────────────────────────────────────────
async function recordTrade({ chatId, symbol, buyPrice, sellPrice, quantity, targetMultiple }) {
  const buy  = parseFloat(buyPrice);
  const sell = parseFloat(sellPrice);
  const qty  = quantity ? parseFloat(quantity) : null;

  const pnlPct    = ((sell - buy) / buy) * 100;
  const multiple  = sell / buy;
  const pnlDollar = qty ? (sell - buy) * qty : null;
  const now       = new Date();

  const trade = {
    id:             `${symbol}:${now.getTime()}`,
    symbol,
    buyPrice:       buy,
    sellPrice:      sell,
    quantity:       qty,
    pnlPct:         parseFloat(pnlPct.toFixed(2)),
    multiple:       parseFloat(multiple.toFixed(2)),
    pnlDollar:      pnlDollar !== null ? parseFloat(pnlDollar.toFixed(4)) : null,
    targetMultiple: targetMultiple || null,
    targetHit:      targetMultiple ? multiple >= parseFloat(targetMultiple) : false,
    outcome:        pnlPct >= 0 ? 'WIN' : 'LOSS',
    closedAt:       now.toISOString(),
    month:          now.toISOString().slice(0, 7),
  };

  await migrateLegacy(chatId);
  await store.cmd('RPUSH', listKey(chatId), JSON.stringify(trade));
  return trade;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function calcStats(trades) {
  if (trades.length === 0) return null;

  const wins   = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');

  const totalPnlDollar = trades.reduce((s, t) => s + (t.pnlDollar || 0), 0);
  const avgMultiple    = trades.reduce((s, t) => s + t.multiple, 0) / trades.length;
  const bestTrade      = trades.reduce((best, t) => (!best || t.pnlPct > best.pnlPct ? t : best), null);
  const worstTrade     = trades.reduce((worst, t) => (!worst || t.pnlPct < worst.pnlPct ? t : worst), null);

  return {
    totalTrades:    trades.length,
    wins:           wins.length,
    losses:         losses.length,
    winRate:        parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    totalPnlPct:    parseFloat(trades.reduce((s, t) => s + t.pnlPct, 0).toFixed(2)),
    totalPnlDollar: parseFloat(totalPnlDollar.toFixed(4)),
    avgMultiple:    parseFloat(avgMultiple.toFixed(2)),
    bestTrade,
    worstTrade,
  };
}

function previousMonth(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

async function getMonthlyStats(chatId) {
  const trades    = await getAllTrades(chatId);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const lastMonth = previousMonth();

  return {
    thisMonth:    calcStats(trades.filter(t => t.month === thisMonth)),
    lastMonth:    calcStats(trades.filter(t => t.month === lastMonth)),
    allTime:      calcStats(trades),
    recentTrades: trades.slice(-5).reverse(),
  };
}

/** Closed trades and P&L for today (UTC). Works for real and practice trade lists. */
function todaySummary(trades, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const t = trades.filter(x => String(x.closedAt || '').slice(0, 10) === day);
  const pnl = t.reduce((s, x) => s + (x.pnlDollar || 0), 0);
  return { count: t.length, wins: t.filter(x => (x.pnlDollar ?? x.pnlPct) > 0).length, pnlUsd: Math.round(pnl * 100) / 100, withoutQty: t.filter(x => x.pnlDollar === null || x.pnlDollar === undefined).length };
}

function todayLine(trades) {
  const d = todaySummary(trades);
  if (!d.count) return '';
  const money = `${d.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(d.pnlUsd).toFixed(2)}`;
  return `📅 *Today so far:* ${d.count} closed trade${d.count === 1 ? '' : 's'} · ${d.wins} won · ${money}${d.withoutQty ? ` _(${d.withoutQty} without a quantity not counted in $)_` : ''}`;
}

module.exports = { todaySummary, todayLine, recordTrade, getAllTrades, getMonthlyStats, calcStats, previousMonth, _resetMigrationCache: () => checked.clear() };
