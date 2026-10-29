/**
 * ─── Position Monitor ─────────────────────────────────────────────────────────
 * GET /api/v2monitor?key=CRON_SECRET      (run every 30 min via cron-job.org)
 *
 * Checks every open position for the admin + all approved users and alerts the
 * position OWNER in their own chat:
 *
 *  🔴 Stop loss · 🚨 Custom target · 🟢 TP1/TP2/TP3 · 🚀 50%/100%/150% milestones
 *      → normal notification
 *  📊 Other 10% milestones · ⚪ HOLD update every 4h
 *      → delivered silently (no sound)
 *
 * PRIVACY FIX: personal position alerts used to go to the shared
 * TELEGRAM_INFO_CHANNEL_ID, so every member saw everyone's trades. They now
 * only go to the owner. The info channel is for market-wide signals only.
 *
 * Other fixes:
 *  - Stop loss / TPs are locked on the position the first time they are
 *    calculated (previously recalculated from live ATR every run).
 *  - HOLD updates use their own timer (lastHoldAlertAt); before, lastChecked
 *    was reset every run so the 4-hour HOLD never fired.
 *  - A jump past several milestones sends one alert and marks all of them,
 *    instead of back-filling lower milestones on later runs.
 *  - Jumping straight to TP2/TP3 marks the lower TPs as hit too.
 *  - One storage write per position per run (field-level, so it can't wipe
 *    out flags quickcheck sets at the same moment).
 *  - Market data fetched once per coin, 4 coins in parallel; overlapping runs
 *    are skipped instead of double-alerting.
 */

const { getAllPositions, updatePosition } = require('../src/services/positionStore');
const subs = require('../src/services/subscriptionService');
const { fetchCurrentData, buildAdvice } = require('../src/services/adviceService');
const tg = require('../src/lib/telegram');
const store = require('../src/lib/redis');
const { mapLimit } = require('../src/lib/concurrency');
const { stopAfterTakeProfit, stopHitWording } = require('../src/services/stopPlan');
const { cors, requireCronKey } = require('../src/lib/auth');
const autoTrader = require('../src/services/autoTrader');
const autoBuyer = require('../src/services/autoBuyer');

const AUTO_NOTE = `🤖 _Auto-exits are on — the bot places this on Binance for you. Don't also sell by hand._`;
const SELL_EVENTS = /^(TP[123]|STOP_LOSS|TARGET_HIT)/;

const HOLD_INTERVAL_HOURS = 4;
const MILESTONE_STEP = 10;

// ─── Milestone helpers ────────────────────────────────────────────────────────
/** Highest 10%-step milestone reached and not yet alerted, or null. */
function getNextMilestone(pnlPct, milestoneHits = []) {
  if (pnlPct < MILESTONE_STEP) return null;
  const highest = Math.floor(pnlPct / MILESTONE_STEP) * MILESTONE_STEP;
  return milestoneHits.includes(highest) ? null : highest;
}

function milestonesUpTo(m, existing = []) {
  const all = new Set(existing);
  for (let x = MILESTONE_STEP; x <= m; x += MILESTONE_STEP) all.add(x);
  return [...all].sort((a, b) => a - b);
}

const isRoundMilestone = (m) => m % 50 === 0;

function milestoneEmoji(m) {
  if (m >= 100) return '🚀🚀🚀';
  if (m >= 70)  return '🚀🚀';
  if (m >= 40)  return '🚀';
  if (m >= 20)  return '🟢🟢';
  return '🟢';
}

const fmt = (n, d = 6) => Number(n).toFixed(d);
const now = () => new Date().toUTCString();

// ─── Core position checker ────────────────────────────────────────────────────
/**
 * Evaluates one position. Returns { recommendation, alerted, updates, messages }
 * without side effects, so it can be unit-tested; the handler sends/saves.
 */
function evaluatePosition(pos, market, nowMs = Date.now()) {
  const { candles1h, candles4h, currentPrice } = market;
  const updates  = {};
  const messages = []; // { text, silent }

  const lockedPlan = pos.stopLossPrice
    ? { stopLoss: pos.stopLossPrice, takeProfits: pos.takeProfits || null }
    : null;

  const advice = buildAdvice({
    symbol: pos.symbol, buyPrice: pos.buyPrice, currentPrice,
    candles1h, candles4h, accountSize: pos.accountSize, riskPct: pos.riskPct, lockedPlan,
  });

  const sl  = advice.tradePlan?.stopLoss;
  // Auto-bought positions follow their strategy's trailing stop only — no take-profits
  const tps = pos.strategy ? null : advice.tradePlan?.takeProfits;
  const tp1 = tps?.tp1, tp2 = tps?.tp2, tp3 = tps?.tp3;

  // Lock the plan the first time we have one
  if (sl && !pos.stopLossPrice) updates.stopLossPrice = sl;
  if (tps && !pos.takeProfits)  updates.takeProfits = tps;
  if (currentPrice > (pos.highestPrice || pos.buyPrice)) updates.highestPrice = currentPrice;

  const pnlPct          = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;
  const currentMultiple = currentPrice / pos.buyPrice;
  const profitDollar    = pos.quantity ? ((currentPrice - pos.buyPrice) * pos.quantity).toFixed(2) : null;

  // Stopped-out positions stay quiet until the user removes or records them
  if (pos.stopLossHit) {
    return { recommendation: 'STOPPED_OUT', alerted: false, updates, messages };
  }

  // ── MILESTONES ────────────────────────────────────────────────────────────
  const milestoneHits = pos.milestoneHits || [];
  const nextMilestone = getNextMilestone(pnlPct, milestoneHits);
  if (nextMilestone !== null) {
    const nextTarget = nextMilestone + MILESTONE_STEP;
    const nextPrice  = fmt(pos.buyPrice * (1 + nextTarget / 100));
    const isRound    = isRoundMilestone(nextMilestone);
    const ceilingPct   = pos.targetMultiple ? (pos.targetMultiple - 1) * 100 : null;
    const ceilingAhead = ceilingPct && ceilingPct > nextMilestone && !pos.targetHit && pos.targetPrice;

    messages.push({
      silent: !isRound,
      text: [
        `${milestoneEmoji(nextMilestone)} *+${nextMilestone}% MILESTONE — ${pos.symbol}*`,
        isRound ? `🎉 *Round number — consider taking some profit!*` : '',
        ``,
        `💰 *Bought at:*  \`$${pos.buyPrice}\``,
        `📊 *Now:*        \`$${fmt(currentPrice)}\``,
        `📈 *Gain:*       +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
        profitDollar ? `💵 *Profit:*      $${profitDollar}` : '',
        ``,
        `📌 *Next milestone:* +${nextTarget}% at \`$${nextPrice}\``,
        ceilingAhead ? `🎯 Your target (+${Number.isInteger(ceilingPct) ? ceilingPct : ceilingPct.toFixed(1)}% = \`$${fmt(pos.targetPrice)}\`) is still ahead — hold on.` : '',
        ``,
        sl ? `🛡 *Stop loss:* \`$${fmt(sl)}\`` : '',
        `💡 _Consider moving your stop loss up to lock in profit._`,
        `⏰ ${now()}`,
      ].filter(Boolean).join('\n'),
    });
    updates.milestoneHits = milestonesUpTo(nextMilestone, milestoneHits);
  }

  // ── CUSTOM TARGET HIT ─────────────────────────────────────────────────────
  if (pos.targetMultiple && pos.targetPrice && !pos.targetHit && currentPrice >= pos.targetPrice) {
    const ceilingPct  = (pos.targetMultiple - 1) * 100;
    const targetLabel = Number.isInteger(ceilingPct) ? `+${ceilingPct}% (${pos.targetMultiple}X)` : `${pos.targetMultiple}X`;
    messages.push({
      silent: false,
      text: [
        `🚨🎯🚨 *TARGET HIT — ${pos.symbol}* 🚨🎯🚨`,
        ``,
        `🌕 *${targetLabel} REACHED — SELL NOW*`,
        ``,
        `💰 *You bought at:*   \`$${pos.buyPrice}\``,
        `📊 *Current price:*   \`$${fmt(currentPrice, 8)}\``,
        `📈 *Your gain:*       +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
        profitDollar ? `💵 *Estimated profit:* $${profitDollar}` : '',
        ``,
        `🔴 *DO THIS RIGHT NOW:*`,
        `  1. Open your exchange immediately`,
        `  2. Sell 60% of your position at market price`,
        `  3. Move stop on remaining 40% to your buy price (\`$${pos.buyPrice}\`)`,
        `  4. If price drops back to buy price → sell the rest`,
        `  5. If price keeps rising → enjoy the ride 🚀`,
        ``,
        `📝 Record your sale: \`sold ${pos.symbol.replace('USDT', '')} ${pos.buyPrice} ${fmt(currentPrice)}\``,
        `⏰ ${now()}`,
      ].filter(Boolean).join('\n'),
    });
    updates.targetHit = true;
    return { recommendation: `TARGET_HIT_${targetLabel}`, alerted: true, updates, messages };
  }

  // ── STOP LOSS HIT ─────────────────────────────────────────────────────────
  if (sl && currentPrice <= sl) {
    const w = stopHitWording(pos, pnlPct);
    messages.push({
      silent: false,
      text: [
        w.title,
        ``,
        `💰 *Bought at:* \`$${pos.buyPrice}\``,
        `🛡 *Stop:*      \`$${fmt(sl)}\``,
        `📊 *Now:*       \`$${fmt(currentPrice, 8)}\``,
        w.result,
        ``,
        w.action,
        ``,
        `📝 Record your exit: \`sold ${pos.symbol.replace('USDT', '')} ${pos.buyPrice} ${fmt(currentPrice)}\``,
        `⏰ ${now()}`,
      ].join('\n'),
    });
    updates.stopLossHit = true;
    return { recommendation: 'STOP_LOSS', alerted: true, updates, messages };
  }

  const watching = pos.targetMultiple && !pos.targetHit && pos.targetPrice
    ? `🎯 Your target is \`$${fmt(pos.targetPrice)}\` — still watching.` : '';

  // ── TP3 ───────────────────────────────────────────────────────────────────
  if (tp3 && currentPrice >= tp3.price && !pos.tp3Hit) {
    Object.assign(updates, { tp1Hit: true, tp2Hit: true, tp3Hit: true, stopStage: 'done' });
    messages.push({ silent: false, text: [
      `🟢🟢🟢 *TP3 HIT — ${pos.symbol}*`, ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${fmt(currentPrice, 4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`, ``,
      `🟢 *Sell remaining 25% — TP3 reached. Outstanding trade.*`,
      watching, `⏰ ${now()}`,
    ].filter(Boolean).join('\n') });
    return { recommendation: 'TP3', alerted: true, updates, messages };
  }

  // ── TP2 ───────────────────────────────────────────────────────────────────
  if (tp2 && currentPrice >= tp2.price && !pos.tp2Hit) {
    Object.assign(updates, { tp1Hit: true, tp2Hit: true }, stopAfterTakeProfit(pos, 'TP2', tps));
    messages.push({ silent: false, text: [
      `🟢🟢 *TP2 HIT — ${pos.symbol}*`, ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${fmt(currentPrice, 4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`, ``,
      `🟢 *Sell 35% of position now.*`,
      `🛡 Move stop loss to \`$${tp1 ? fmt(tp1.price, 4) : pos.buyPrice}\` (lock in profit) — the bot now watches this new stop.`,
      watching || (tp3 ? `🎯 Next: TP3 at \`$${fmt(tp3.price, 4)}\`` : ''),
      `⏰ ${now()}`,
    ].filter(Boolean).join('\n') });
    return { recommendation: 'TP2', alerted: true, updates, messages };
  }

  // ── TP1 ───────────────────────────────────────────────────────────────────
  if (tp1 && currentPrice >= tp1.price && !pos.tp1Hit) {
    Object.assign(updates, { tp1Hit: true }, stopAfterTakeProfit(pos, 'TP1', tps));
    messages.push({ silent: false, text: [
      `🟢 *TP1 HIT — ${pos.symbol}*`, ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${fmt(currentPrice, 4)}\``,
      `📈 *Gain:*      +${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`, ``,
      `🟢 *Sell 40% of position now.*`,
      `🛡 Move stop loss to \`$${pos.buyPrice}\` (breakeven) — the bot now watches this new stop.`,
      watching || (tp2 ? `🎯 Next: TP2 at \`$${fmt(tp2.price, 4)}\`` : ''),
      `⏰ ${now()}`,
    ].filter(Boolean).join('\n') });
    return { recommendation: 'TP1', alerted: true, updates, messages };
  }

  // ── HOLD update (every 4h, silent) ────────────────────────────────────────
  const lastHold = pos.lastHoldAlertAt ? new Date(pos.lastHoldAlertAt).getTime() : 0;
  const hoursSinceHold = (nowMs - lastHold) / 3_600_000;

  if (hoursSinceHold >= HOLD_INTERVAL_HOURS && nextMilestone === null) {
    const distToTarget = pos.targetPrice
      ? `${(((pos.targetPrice - currentPrice) / currentPrice) * 100).toFixed(1)}% away` : null;
    const nextMs      = (Math.floor(Math.max(pnlPct, 0) / MILESTONE_STEP) + 1) * MILESTONE_STEP;
    const nextMsPrice = fmt(pos.buyPrice * (1 + nextMs / 100));

    messages.push({ silent: true, text: [
      `⚪ *HOLD — ${pos.symbol}*`, ``,
      `💰 *Bought at:* \`$${pos.buyPrice}\``,
      `📊 *Now:*       \`$${fmt(currentPrice)}\``,
      `📈 *P&L:*       ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% (${currentMultiple.toFixed(2)}X)`,
      pos.targetPrice && !pos.targetHit ? `🎯 *Target:* \`$${fmt(pos.targetPrice)}\` — ${distToTarget}` : '',
      `📌 *Next milestone:* +${nextMs}% at \`$${nextMsPrice}\``,
      ``,
      `✅ Stay in the trade. No action needed.`,
      sl  ? `🛡 Stop loss: \`$${fmt(sl)}\`` : '',
      tp1 && !pos.tp1Hit ? `🎯 Next TP: \`$${fmt(tp1.price, 4)}\`` : '',
      `⏰ ${now()}`,
    ].filter(Boolean).join('\n') });
    updates.lastHoldAlertAt = new Date(nowMs).toISOString();
    return { recommendation: 'HOLD', alerted: true, updates, messages };
  }

  if (nextMilestone !== null) {
    return { recommendation: `MILESTONE_${nextMilestone}PCT`, alerted: true, updates, messages };
  }
  return { recommendation: 'HOLD', alerted: false, updates, messages };
}

async function checkPosition(pos, ownerChatId, market, { auto = false } = {}) {
  const result = evaluatePosition(pos, market);
  const chatId = ownerChatId || pos.chatId;
  const autoNote = auto && autoTrader.eligible(pos) && SELL_EVENTS.test(result.recommendation);

  for (const m of result.messages) {
    await tg.send(chatId, autoNote ? `${m.text}\n\n${AUTO_NOTE}` : m.text, { silent: m.silent });
  }

  // Field-level write: can't overwrite flags set at the same time by quickcheck
  await updatePosition(chatId, pos.positionId, {
    ...result.updates,
    lastChecked:        new Date().toISOString(),
    lastRecommendation: result.recommendation,
  });

  // Automated exits: make Binance match the (possibly just updated) plan
  let autoResult = null;
  if (auto) autoResult = await autoTrader.sync(chatId, pos.positionId, { price: market.currentPrice });

  return { recommendation: result.recommendation, alerted: result.alerted, ...(autoResult ? { auto: autoResult.actions, autoError: autoResult.error } : {}) };
}

const SYMBOL_CONCURRENCY = 4;

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireCronKey(req, res)) return;

  // One run at a time: if the previous run is still going, skip this one
  if (!(await store.lock('cryptobot:lock:monitor', 240).catch(() => true))) {
    return res.status(200).json({ success: true, skipped: 'previous monitor run still in progress' });
  }

  try {
    // Paid access: renewal reminders, and only users with access are monitored
    const reminders = await subs.sendReminders((id, text) => tg.send(id, text)).catch(err => ({ error: err.message }));
    // Free for small accounts: re-check Binance balances once a day (before deciding who has access)
    const smallAccounts = await subs.refreshAllSmall({ send: (id, text) => tg.send(id, text) }).catch(err => ({ error: err.message }));
    const userIds = await subs.getChatIdsWithAccess();
    // Auto-buy: once a day after the daily close (practice, house forward test, live if unlocked)
    const autobuy = await autoBuyer.runDaily({ allowed: new Set(userIds.map(String)), send: (id, text) => tg.send(id, text) })
      .catch(err => ({ error: err.message }));
    // Weekly savings plans: day-before reminders and due buys
    const savings = await require('../src/services/savingsPlan').runDue({ allowed: new Set(userIds.map(String)), send: (id, text) => tg.send(id, text) })
      .catch(err => ({ error: err.message }));
    const jobs = [];
    const autoOn = new Map();
    for (const userId of userIds) {
      const positions = Object.values(await getAllPositions(userId));
      for (const pos of positions) jobs.push({ userId, pos });
      const on = await autoTrader.isOn(userId);
      autoOn.set(String(userId), on);
      // Stop orders whose position was removed → cancel them
      await autoTrader.sweepOrphans(userId, positions.map(p => p.positionId)).catch(() => 0);
    }
    if (jobs.length === 0) {
      return res.status(200).json({ success: true, message: 'No open positions across any users', reminders, autobuy, savings, smallAccounts });
    }

    // Fetch market data ONCE per coin+exchange (not once per position), a few in parallel
    const bySymbol = new Map();
    for (const j of jobs) {
      const key = `${j.pos.symbol}|${j.pos.exchange || ''}`;
      (bySymbol.get(key) || bySymbol.set(key, []).get(key)).push(j);
    }

    const results = [];
    await mapLimit([...bySymbol.entries()], SYMBOL_CONCURRENCY, async ([key, list]) => {
      const [symbol, exchange] = key.split('|');
      let market;
      try {
        market = await fetchCurrentData(symbol, { exchange: exchange || null });
      } catch (err) {
        for (const { userId } of list) results.push({ userId, symbol, error: `market data: ${err.message}` });
        return;
      }
      for (const { userId, pos } of list) {
        try {
          results.push({ userId, symbol, ...(await checkPosition(pos, userId, market, { auto: autoOn.get(String(userId)) })) });
        } catch (err) {
          console.error(`[Monitor] ${userId}/${symbol}:`, err.message);
          results.push({ userId, symbol, error: err.message });
        }
      }
    });

    return res.status(200).json({
      success:   true,
      checked:   results.length,
      symbols:   bySymbol.size,
      results,
      reminders,
      autobuy,
      savings,
      smallAccounts,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    await store.del('cryptobot:lock:monitor').catch(() => {});
  }
};

module.exports.evaluatePosition = evaluatePosition;
module.exports.getNextMilestone = getNextMilestone;
